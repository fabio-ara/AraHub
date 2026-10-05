-- SYNTHETIC local-only Supabase identity fixture. Never deploy this file to Supabase.
create schema if not exists auth;
create schema if not exists extensions;
do $$ begin
  if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists(select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
end $$;
create table if not exists auth.users(id uuid primary key);
create or replace function auth.uid() returns uuid language sql stable as $$
 select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
$$;
grant usage on schema auth to authenticated;
grant execute on function auth.uid() to authenticated;
create extension if not exists pgcrypto with schema extensions;
create table if not exists public.arahub_migrations(name text primary key);
