-- Keep account deletion consistent with the other owner-bound tables.
alter table public.hub_entities
  drop constraint hub_entities_owner_id_fkey;

alter table public.hub_entities
  add constraint hub_entities_owner_id_fkey
  foreign key (owner_id) references auth.users(id) on delete cascade;
