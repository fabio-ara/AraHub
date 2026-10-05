-- Append-only preference revisions. Legacy events remain intact and require contextual review.
alter table public.hub_deltas add column preference jsonb;
alter table public.hub_deltas add constraint hub_preference_kind
  check (preference is null or (kind='preference' and jsonb_typeof(preference)='object'));

create function arahub_private.validate_preference() returns trigger
language plpgsql security invoker set search_path='' as $$
declare p jsonb := new.preference; target public.hub_deltas; target_id text;
  starts timestamptz; ends timestamptz;
begin
  if p is null then return new; end if;
  if (p - array['key','state','valid_from','valid_until','supersedes']) <> '{}'::jsonb
     or jsonb_typeof(p->'key') is distinct from 'string'
     or length(p->>'key') not between 1 and 120
     or coalesce(p->>'state','') not in ('active','withdrawn')
     or jsonb_typeof(p->'supersedes') is distinct from 'array'
     or jsonb_array_length(p->'supersedes') > 30 then
    raise exception using errcode='22023',message='invalid_preference';
  end if;
  foreach target_id in array array['valid_from','valid_until'] loop
    if p ? target_id and (jsonb_typeof(p->target_id) is distinct from 'string'
       or (p->>target_id) !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$') then
      raise exception using errcode='22023',message='invalid_preference';
    end if;
  end loop;
  starts := coalesce((p->>'valid_from')::timestamptz,new.recorded_at);
  ends := (p->>'valid_until')::timestamptz;
  if ends is not null and ends <= starts then
    raise exception using errcode='22023',message='invalid_preference';
  end if;
  if p->>'state'='withdrawn' and (jsonb_array_length(p->'supersedes')=0 or ends is not null) then
    raise exception using errcode='22023',message='invalid_preference';
  end if;
  if jsonb_array_length(p->'supersedes') > 0 and new.evidence_kind <> 'user_report' then
    raise exception using errcode='22023',message='invalid_preference';
  end if;
  if (select count(distinct value) from jsonb_array_elements(p->'supersedes')) < jsonb_array_length(p->'supersedes') then
    raise exception using errcode='22023',message='invalid_preference';
  end if;
  for target_id in select jsonb_array_elements_text(p->'supersedes') loop
    select * into target from public.hub_deltas
      where owner_id=new.owner_id and id=target_id::uuid and context_id=new.context_id
        and kind='preference' and version<new.version and scope=new.scope
        and (preference is null or preference->>'key'=p->>'key');
    if not found then raise exception using errcode='P0002',message='not_found'; end if;
  end loop;
  return new;
end $$;
revoke all on function arahub_private.validate_preference() from public,anon,authenticated;
create trigger validate_preference before insert on public.hub_deltas
  for each row execute function arahub_private.validate_preference();

create or replace function public.hub_record_delta(p jsonb) returns jsonb
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
  insert into public.hub_deltas(owner_id,context_id,idempotency_key,kind,content,evidence_kind,scope,provenance,payload_hash,version,preference)
  values(actor,ctx.id,p->>'idempotency_key',p->>'kind',p->>'content',p->>'evidence_kind',coalesce(p->'scope','{}'),coalesce(p->'provenance','[]'),fingerprint,ctx.version+1,p->'preference')
  returning * into receipt;
  update public.hub_contexts set version=receipt.version,updated_at=now() where owner_id=actor and id=ctx.id;
  return jsonb_build_object('id',receipt.id,'version',receipt.version,'replayed',false);
end $$;
revoke all on function public.hub_record_delta(jsonb) from public,anon;
grant execute on function public.hub_record_delta(jsonb) to authenticated;
