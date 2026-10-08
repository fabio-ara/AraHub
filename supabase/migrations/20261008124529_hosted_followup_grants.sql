-- Backend-only finite scheduling authority. Neither OAuth nor the Data API can
-- create approvals, reset balances, extend validity or forge worker leases.
create table arahub_private.followup_grants (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  connection_id uuid not null,
  credential_epoch integer not null,
  config jsonb not null,
  state jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  foreign key(owner_id,connection_id) references public.hub_connections(owner_id,id) on delete cascade
);
alter table arahub_private.followup_grants enable row level security;
alter table arahub_private.followup_grants force row level security;
revoke all on arahub_private.followup_grants from public,anon,authenticated;
create index followup_grants_connection on arahub_private.followup_grants(owner_id,connection_id);
