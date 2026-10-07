-- Equality owner/entity and descending keyset cursor match hub_observations.
create index hub_observations_owner_entity_page_idx
  on public.hub_observations(owner_id,entity_id,observed_at desc,id desc);
