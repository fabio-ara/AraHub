-- Pending Google OAuth handshakes. Private schema, never exposed to the Data API.
-- One-use, bound to owner + session + state hash, short-lived, secrets sealed by the vault.
create table if not exists arahub_private.oauth_pending (
  state_hash text primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  session_id text not null,
  connection_id uuid not null,
  label text not null,
  provider text not null default 'google' check (provider = 'google'),
  desired_scopes text[] not null default '{}',
  -- { nonce, verifier, metadata }: each a SealedSecret envelope (v/alg/kid/iv/ct).
  sealed jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  foreign key (owner_id, connection_id) references public.hub_connections(owner_id, id) on delete cascade
);

alter table arahub_private.oauth_pending enable row level security;
alter table arahub_private.oauth_pending force row level security;
-- No grant to anon/authenticated: pending handshakes are reachable only by the privileged path.
revoke all on arahub_private.oauth_pending from public, anon, authenticated;

create index if not exists oauth_pending_owner_idx on arahub_private.oauth_pending(owner_id);
create index if not exists oauth_pending_expiry_idx on arahub_private.oauth_pending(expires_at);
