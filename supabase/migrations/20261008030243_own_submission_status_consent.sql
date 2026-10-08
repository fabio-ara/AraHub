-- Append-only decisions, read only through the verified backend. No Data API grants.
create table arahub_private.own_submission_status_consents (
  id uuid primary key default gen_random_uuid(),
  sequence bigint generated always as identity unique,
  owner_id uuid not null,
  connection_id uuid not null,
  credential_epoch integer not null,
  provider_subject text not null,
  origin text not null,
  policy_version text not null,
  allowed boolean not null,
  session_id uuid not null,
  decided_at timestamptz not null default clock_timestamp(),
  foreign key(owner_id,connection_id) references public.hub_connections(owner_id,id) on delete cascade
);
create index own_submission_status_consents_connection on arahub_private.own_submission_status_consents(owner_id,connection_id,sequence desc);
alter table arahub_private.own_submission_status_consents enable row level security;
alter table arahub_private.own_submission_status_consents force row level security;
revoke all on arahub_private.own_submission_status_consents from public,anon,authenticated;
revoke all on sequence arahub_private.own_submission_status_consents_sequence_seq from public,anon,authenticated;
