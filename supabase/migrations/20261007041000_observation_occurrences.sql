-- Content is deduplicated; observing A again after B is a new fact.
create table public.hub_observation_occurrences (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  entity_id uuid not null,
  content_hash text not null,
  provenance jsonb not null,
  coverage text not null check (coverage in ('complete','partial','denied','unavailable','expired','timeout','parsing_error')),
  occurred_at timestamptz,
  source_modified_at timestamptz,
  observed_at timestamptz not null,
  recorded_at timestamptz not null,
  unique(owner_id,id),
  unique(owner_id,entity_id,content_hash,observed_at),
  foreign key(owner_id,entity_id,content_hash)
    references public.hub_observations(owner_id,entity_id,content_hash)
    on delete cascade deferrable initially deferred
);
alter table public.hub_observation_occurrences enable row level security;
alter table public.hub_observation_occurrences force row level security;
create policy owner_select on public.hub_observation_occurrences for select to authenticated
  using ((select auth.uid())=owner_id and (select auth.jwt()->>'client_id') is null);
create policy owner_insert on public.hub_observation_occurrences for insert to authenticated
  with check ((select auth.uid())=owner_id and (select auth.jwt()->>'client_id') is null);
revoke all on public.hub_observation_occurrences from public,anon,authenticated;
grant select,insert on public.hub_observation_occurrences to authenticated;
create index hub_occurrences_owner_entity_page_idx
  on public.hub_observation_occurrences(owner_id,entity_id,observed_at desc,id desc);

-- Preserve original IDs and dates for all observations that predate this change.
-- Lost historical occurrences cannot be reconstructed and are not invented.
insert into public.hub_observation_occurrences
  (id,owner_id,entity_id,content_hash,provenance,coverage,occurred_at,source_modified_at,observed_at,recorded_at)
select id,owner_id,entity_id,content_hash,provenance,coverage,occurred_at,source_modified_at,observed_at,recorded_at
from public.hub_observations;

create function public.hub_capture_observation_occurrence() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
  -- BEFORE INSERT runs even when the content's ON CONFLICT skips the snapshot.
  -- The deferred FK uses the content key, so concurrent identical inserts are safe.
  insert into public.hub_observation_occurrences
    (id,owner_id,entity_id,content_hash,provenance,coverage,occurred_at,source_modified_at,observed_at,recorded_at)
  values(new.id,new.owner_id,new.entity_id,new.content_hash,new.provenance,new.coverage,
    new.occurred_at,new.source_modified_at,new.observed_at,new.recorded_at)
  on conflict do nothing;
  return new;
end;
$$;
revoke all on function public.hub_capture_observation_occurrence() from public,anon,authenticated;
create trigger hub_observation_occurrence_before_insert
  before insert on public.hub_observations for each row
  execute function public.hub_capture_observation_occurrence();

create view public.hub_observation_timeline with (security_invoker=true) as
select v.id,v.owner_id,v.entity_id,o.id as content_id,o.content,v.content_hash,v.provenance,
  v.coverage,v.occurred_at,v.source_modified_at,v.observed_at,v.recorded_at
from public.hub_observation_occurrences v
join public.hub_observations o on o.owner_id=v.owner_id and o.entity_id=v.entity_id and o.content_hash=v.content_hash;
revoke all on public.hub_observation_timeline from public,anon,authenticated;
grant select on public.hub_observation_timeline to authenticated;
