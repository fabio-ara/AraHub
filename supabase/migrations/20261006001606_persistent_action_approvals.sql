-- Durable prepare/approve/execute boundary for external side effects.
-- The snapshot stores the exact canonical JSON that src/production.ts hashed; the CHECK
-- recomputes the digest in the database, so a rewritten snapshot cannot keep a stale hash.
-- Approval is single-use, pinned to one content hash/revision and to the deciding session.
create table public.hub_actions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  connection_id uuid not null,
  operation text not null check (length(operation) between 1 and 120),
  target text not null check (length(target) between 1 and 2000),
  revision text check (revision is null or length(revision) <= 200),
  snapshot text not null,
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  state text not null default 'prepared'
    check (state in ('prepared','approved','denied','uncertain','succeeded')),
  external_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(owner_id, id),
  foreign key(owner_id, connection_id) references public.hub_connections(owner_id, id) on delete cascade,
  constraint hub_actions_snapshot_hash
    check (content_hash = encode(extensions.digest(snapshot, 'sha256'), 'hex'))
);

create table public.hub_action_approvals (
  action_id uuid primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  approver_session_id uuid not null,
  decided_hash text not null check (decided_hash ~ '^[0-9a-f]{64}$'),
  decided_revision text,
  decision text not null check (decision in ('approved','denied')),
  -- A trust decision is either approved with a fixed expiry or denied without one.
  expires_at timestamptz,
  consumed_at timestamptz,
  decided_at timestamptz not null default now(),
  unique(owner_id, action_id),
  foreign key(owner_id, action_id) references public.hub_actions(owner_id, id) on delete cascade,
  constraint hub_action_approvals_decision check ((decision = 'approved') = (expires_at is not null))
);

do $$ declare t text; begin
  foreach t in array array['hub_actions','hub_action_approvals'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('alter table public.%I force row level security',t);
    -- A verified MCP client carries client_id; it must never read or write the approval boundary
    -- through the Data API even though it is role authenticated for its own rows.
    execute format('create policy owner_select on public.%I for select to authenticated using ((select auth.uid())=owner_id and (select auth.jwt()->>''client_id'') is null)',t);
    execute format('revoke all on public.%I from public, anon, authenticated',t);
  end loop;
end $$;

-- No write grant to authenticated at all: a browser or OAuth token could otherwise forge an
-- approval or a "succeeded" outcome without the trusted surface. Every mutation runs in the
-- privileged path as the schema owner after checking owner, connection, row locks and the
-- approved snapshot/hash. Authenticated only reads its own rows (RLS above).
grant select on public.hub_actions, public.hub_action_approvals to authenticated;

create index hub_actions_owner_state_idx on public.hub_actions(owner_id, state, created_at desc);
create index hub_actions_connection_idx on public.hub_actions(owner_id, connection_id);
create index hub_action_approvals_owner_idx on public.hub_action_approvals(owner_id);
