-- New MIT schema. Supabase supplies auth.users/auth.uid(); local identity fixture is separate.
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create schema if not exists arahub_private;
revoke all on schema arahub_private from public, anon, authenticated;

create table public.hub_connections (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('moodle','google','migration')),
  label text not null,
  origin text,
  provider_subject text,
  desired_scopes text[] not null default '{}',
  granted_scopes text[] not null default '{}',
  state text not null default 'pending' check (state in ('pending','connected','expired','revoked','denied')),
  capabilities jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique(owner_id,id), unique(owner_id,provider,origin,provider_subject)
);

create table public.hub_contexts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  title text not null, scope jsonb not null default '{}',
  version integer not null default 0 check (version >= 0),
  updated_at timestamptz not null default now(),
  unique(owner_id,id)
);
create table public.hub_entities (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id),
  connection_id uuid not null, kind text not null, external_id text not null,
  title text not null, state jsonb not null default '{}',
  unique(owner_id,id), unique(owner_id,connection_id,kind,external_id),
  foreign key(owner_id,connection_id) references public.hub_connections(owner_id,id) on delete cascade
);
create table public.hub_observations (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null,
  entity_id uuid not null, content jsonb not null, content_hash text not null,
  provenance jsonb not null, coverage text not null check (coverage in ('complete','partial','denied','unavailable','expired','timeout','parsing_error')),
  occurred_at timestamptz, source_modified_at timestamptz,
  observed_at timestamptz not null default now(), recorded_at timestamptz not null default now(),
  unique(owner_id,id), unique(owner_id,entity_id,content_hash),
  foreign key(owner_id,entity_id) references public.hub_entities(owner_id,id) on delete cascade
);
create table public.hub_deltas (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null,
  context_id uuid not null, idempotency_key text not null,
  kind text not null check (kind in ('decision','correction','preference','submission_report','artifact','experience')),
  content text not null, evidence_kind text not null check (evidence_kind in ('user_report','observed','interpretation','hypothesis')),
  scope jsonb not null default '{}', provenance jsonb not null default '[]',
  payload_hash text not null, version integer not null,
  recorded_at timestamptz not null default now(),
  unique(owner_id,id), unique(owner_id,idempotency_key), unique(owner_id,context_id,version),
  foreign key(owner_id,context_id) references public.hub_contexts(owner_id,id) on delete cascade
);
create table public.hub_relations (
  owner_id uuid not null, from_id uuid not null, to_id uuid not null, kind text not null,
  evidence jsonb not null, primary key(owner_id,from_id,to_id,kind),
  foreign key(owner_id,from_id) references public.hub_entities(owner_id,id) on delete cascade,
  foreign key(owner_id,to_id) references public.hub_entities(owner_id,id) on delete cascade
);
create table public.hub_files (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null,
  entity_id uuid not null, name text not null, mime_type text not null,
  sha256 text not null, bytes bigint not null check(bytes >= 0),
  -- Binary and extracted text are separate; external links do not claim extraction.
  binary_content bytea, extracted_text text, extraction jsonb not null default '{}',
  unique(owner_id,id), unique(owner_id,entity_id,sha256),
  foreign key(owner_id,entity_id) references public.hub_entities(owner_id,id) on delete cascade
);
create table public.hub_jobs (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null,
  connection_id uuid not null, kind text not null, cursor jsonb,
  state text not null default 'pending' check(state in ('pending','running','complete','partial','failed','expired')),
  attempts integer not null default 0 check(attempts between 0 and 5),
  lease_until timestamptz, coverage jsonb not null default '{}',
  updated_at timestamptz not null default now(), unique(owner_id,id),
  foreign key(owner_id,connection_id) references public.hub_connections(owner_id,id) on delete cascade
);
-- Not exposed to Data API and never readable by authenticated MCP callers.
create table arahub_private.credentials (
  owner_id uuid not null, connection_id uuid primary key,
  encrypted_payload jsonb not null, key_version text not null, version integer not null default 1,
  foreign key(owner_id,connection_id) references public.hub_connections(owner_id,id) on delete cascade
);
alter table arahub_private.credentials enable row level security;
alter table arahub_private.credentials force row level security;

do $$ declare t text; begin
  foreach t in array array['hub_connections','hub_contexts','hub_entities','hub_observations','hub_deltas','hub_relations','hub_files','hub_jobs'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('alter table public.%I force row level security',t);
    execute format('create policy owner_select on public.%I for select to authenticated using ((select auth.uid())=owner_id)',t);
    execute format('create policy owner_insert on public.%I for insert to authenticated with check ((select auth.uid())=owner_id)',t);
    execute format('create policy owner_update on public.%I for update to authenticated using ((select auth.uid())=owner_id) with check ((select auth.uid())=owner_id)',t);
    execute format('revoke all on public.%I from public, anon, authenticated',t);
    execute format('grant select, insert, update on public.%I to authenticated',t);
    execute format('create index %I on public.%I(owner_id)', t || '_owner_idx',t);
  end loop;
end $$;
-- Events/observations are appended; revision history is not rewritten through the public role.
revoke update on public.hub_deltas, public.hub_observations from authenticated;
create index hub_deltas_context_idx on public.hub_deltas(owner_id,context_id);
create index hub_entities_connection_idx on public.hub_entities(owner_id,connection_id);
create index hub_observations_entity_idx on public.hub_observations(owner_id,entity_id);
create index hub_files_entity_idx on public.hub_files(owner_id,entity_id);
create index hub_jobs_connection_idx on public.hub_jobs(owner_id,connection_id);
create index hub_relations_target_idx on public.hub_relations(owner_id,to_id);
create index hub_deltas_text_idx on public.hub_deltas using gin(to_tsvector('simple',content));

create function public.hub_record_delta(p jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare actor uuid := auth.uid(); ctx public.hub_contexts; prior public.hub_deltas;
  receipt public.hub_deltas; fingerprint text := encode(extensions.digest(p::text,'sha256'),'hex');
begin
  if actor is null then raise exception using errcode='42501', message='not_authorized'; end if;
  select * into ctx from public.hub_contexts where owner_id=actor and id=(p->>'context_id')::uuid for update;
  if not found then raise exception using errcode='P0002',message='not_found'; end if;
  select * into prior from public.hub_deltas where owner_id=actor and idempotency_key=p->>'idempotency_key';
  if found then
    if prior.payload_hash <> fingerprint then raise exception using errcode='P0001',message='idempotency_conflict'; end if;
    return jsonb_build_object('id',prior.id,'version',prior.version,'replayed',true);
  end if;
  if ctx.version <> (p->>'expected_version')::integer then
    raise exception using errcode='P0001',message='version_conflict';
  end if;
  insert into public.hub_deltas(owner_id,context_id,idempotency_key,kind,content,evidence_kind,scope,provenance,payload_hash,version)
  values(actor,ctx.id,p->>'idempotency_key',p->>'kind',p->>'content',p->>'evidence_kind',coalesce(p->'scope','{}'),coalesce(p->'provenance','[]'),fingerprint,ctx.version+1)
  returning * into receipt;
  update public.hub_contexts set version=receipt.version,updated_at=now() where owner_id=actor and id=ctx.id;
  return jsonb_build_object('id',receipt.id,'version',receipt.version,'replayed',false);
end $$;
revoke all on function public.hub_record_delta(jsonb) from public,anon;
grant execute on function public.hub_record_delta(jsonb) to authenticated;
