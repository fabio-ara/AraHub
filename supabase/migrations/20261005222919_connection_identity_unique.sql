-- NULL origins must not let the same verified Google subject split into duplicate accounts.
create unique index hub_connections_google_subject_unique
  on public.hub_connections(owner_id,provider_subject)
  where provider='google' and provider_subject is not null;
