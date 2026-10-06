-- One context can have multiple explicit candidates: ambiguity is preserved, never guessed by recency.
create table public.hub_context_targets (
  owner_id uuid not null references auth.users(id) on delete cascade,
  context_id uuid not null,
  entity_id uuid not null,
  active boolean not null default true,
  bound_at timestamptz not null default now(),
  primary key(owner_id,context_id,entity_id),
  foreign key(owner_id,context_id) references public.hub_contexts(owner_id,id) on delete cascade,
  foreign key(owner_id,entity_id) references public.hub_entities(owner_id,id) on delete cascade
);
alter table public.hub_context_targets enable row level security;
alter table public.hub_context_targets force row level security;
create policy owner_targets on public.hub_context_targets to authenticated
  using (owner_id=(select auth.uid()) and (select auth.jwt()->>'client_id') is null)
  with check (owner_id=(select auth.uid()) and (select auth.jwt()->>'client_id') is null);
grant select,insert,update,delete on public.hub_context_targets to authenticated;
revoke all on public.hub_context_targets from anon;
create index hub_context_targets_entity on public.hub_context_targets(owner_id,entity_id);
