-- OAuth tokens must pass the AraHub MCP verifier; do not expose all memory
-- through the Data API merely because a client obtained OIDC email scopes.
do $$ declare t text; begin
  foreach t in array array['hub_connections','hub_contexts','hub_entities','hub_observations','hub_deltas','hub_relations','hub_files','hub_jobs'] loop
    execute format('alter policy owner_select on public.%I using ((select auth.uid())=owner_id and (select auth.jwt()->>''client_id'') is null)',t);
    execute format('alter policy owner_insert on public.%I with check ((select auth.uid())=owner_id and (select auth.jwt()->>''client_id'') is null)',t);
    execute format('alter policy owner_update on public.%I using ((select auth.uid())=owner_id and (select auth.jwt()->>''client_id'') is null) with check ((select auth.uid())=owner_id and (select auth.jwt()->>''client_id'') is null)',t);
  end loop;
end $$;
