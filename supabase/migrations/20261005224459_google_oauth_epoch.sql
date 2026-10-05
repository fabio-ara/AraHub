-- Epoch fence for Google OAuth. A start increments the connection epoch and binds the pending
-- handshake to it; disconnect increments the epoch too. A callback only commits credentials and
-- state while holding the connection row lock and matching the pending epoch, so a late or
-- superseded callback can never reactivate a disconnected or reauthorizing connection.
alter table public.hub_connections
  add column if not exists oauth_epoch integer not null default 0;
alter table arahub_private.oauth_pending
  add column if not exists oauth_epoch integer not null default 0;
