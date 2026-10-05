-- Run only in the newly approved AraHub project, after all migrations.
-- Hosted SQL/RLS proof with synthetic claims; NOT real Auth/MCP/client evidence.
-- All synthetic users, contexts, files and relationships are rolled back.
begin;
set local lock_timeout='4s';
set local statement_timeout='60s';
select set_config('arahub.qa_a',gen_random_uuid()::text,true),
       set_config('arahub.qa_b',gen_random_uuid()::text,true),
       set_config('arahub.qa_context',gen_random_uuid()::text,true),
       set_config('arahub.qa_connection',gen_random_uuid()::text,true),
       set_config('arahub.qa_entity',gen_random_uuid()::text,true),
       set_config('arahub.qa_key',gen_random_uuid()::text,true);
insert into auth.users(id) values(current_setting('arahub.qa_a')::uuid),(current_setting('arahub.qa_b')::uuid);

set local role authenticated;
select set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('arahub.qa_a'),'role','authenticated')::text,true),
       set_config('request.jwt.claim.sub',current_setting('arahub.qa_a'),true);
insert into public.hub_contexts(id,owner_id,title) values(current_setting('arahub.qa_context')::uuid,current_setting('arahub.qa_a')::uuid,'SYNTHETIC isolation context');
insert into public.hub_connections(id,owner_id,provider,label,origin,provider_subject)
values(current_setting('arahub.qa_connection')::uuid,current_setting('arahub.qa_a')::uuid,'moodle','SYNTHETIC connection','https://synthetic.invalid','42');
insert into public.hub_entities(id,owner_id,connection_id,kind,external_id,title)
values(current_setting('arahub.qa_entity')::uuid,current_setting('arahub.qa_a')::uuid,current_setting('arahub.qa_connection')::uuid,'course','123','SYNTHETIC course');
insert into public.hub_observations(owner_id,entity_id,content,content_hash,provenance,coverage)
values(current_setting('arahub.qa_a')::uuid,current_setting('arahub.qa_entity')::uuid,'{"synthetic":true}','synthetic-hash','{}','complete');
insert into public.hub_files(owner_id,entity_id,name,mime_type,sha256,bytes,binary_content,extracted_text)
values(current_setting('arahub.qa_a')::uuid,current_setting('arahub.qa_entity')::uuid,'SYNTHETIC.txt','text/plain',encode(extensions.digest('SYNTHETIC','sha256'),'hex'),9,convert_to('SYNTHETIC','UTF8'),'SYNTHETIC');
insert into public.hub_jobs(owner_id,connection_id,kind) values(current_setting('arahub.qa_a')::uuid,current_setting('arahub.qa_connection')::uuid,'SYNTHETIC');
insert into public.hub_relations(owner_id,from_id,to_id,kind,evidence)
values(current_setting('arahub.qa_a')::uuid,current_setting('arahub.qa_entity')::uuid,current_setting('arahub.qa_entity')::uuid,'synthetic','{}');
select set_config('arahub.qa_delta',jsonb_build_object('context_id',current_setting('arahub.qa_context'),'idempotency_key',current_setting('arahub.qa_key'),'kind','preference','content','SYNTHETIC preference','evidence_kind','user_report','expected_version',0,'provenance','[]'::jsonb,'scope','{}'::jsonb,'preference',jsonb_build_object('key','style','state','active','supersedes','[]'::jsonb))::text,true);
do $test$ declare first jsonb; replay jsonb; begin
  if auth.uid() is distinct from current_setting('arahub.qa_a')::uuid then raise exception 'qa_auth_uid_failed'; end if;
  first := public.hub_record_delta(current_setting('arahub.qa_delta')::jsonb);
  replay := public.hub_record_delta(current_setting('arahub.qa_delta')::jsonb);
  if first->>'id' is null or first->>'id' is distinct from replay->>'id' or replay->>'replayed' is distinct from 'true' then raise exception 'qa_idempotency_failed'; end if;
  if (select count(*) from public.hub_files)<>1 then raise exception 'qa_owner_read_failed'; end if;
end $test$;

-- An OAuth client token with OIDC scopes alone must not get direct Data API memory.
select set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('arahub.qa_a'),'client_id','synthetic-unrelated-client','scope','email')::text,true);
do $test$ begin
  if exists(select from public.hub_deltas) then raise exception 'qa_oauth_data_boundary_failed'; end if;
end $test$;

select set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('arahub.qa_b'),'role','authenticated')::text,true),
       set_config('request.jwt.claim.sub',current_setting('arahub.qa_b'),true);
do $test$ declare t text; visible bigint; begin
  foreach t in array array['hub_connections','hub_contexts','hub_entities','hub_observations','hub_deltas','hub_relations','hub_files','hub_jobs'] loop
    execute format('select count(*) from public.%I where owner_id=$1',t) into visible using current_setting('arahub.qa_a')::uuid;
    if visible <> 0 then raise exception 'qa_rls_failed'; end if;
  end loop;
  begin
    perform public.hub_record_delta(current_setting('arahub.qa_delta')::jsonb);
    raise exception 'qa_foreign_delta_allowed';
  exception when no_data_found then null;
  end;
  begin
    insert into public.hub_files(owner_id,entity_id,name,mime_type,sha256,bytes)
    values(current_setting('arahub.qa_b')::uuid,current_setting('arahub.qa_entity')::uuid,'SYNTHETIC foreign','text/plain','synthetic',0);
    raise exception 'qa_cross_owner_fk_allowed';
  exception when foreign_key_violation then null;
  end;
  begin
    perform 1 from arahub_private.credentials;
    raise exception 'qa_vault_exposed';
  exception when insufficient_privilege then null;
  end;
end $test$;
set local role anon;
do $test$ begin
  begin
    perform 1 from public.hub_contexts;
    raise exception 'qa_anon_exposed';
  exception when insufficient_privilege then null;
  end;
end $test$;
reset role;
rollback;
select 'synthetic_sql_isolation_passed' as result,
  (select count(*) from auth.users) as application_users_after_rollback,
  (select count(*) from public.hub_contexts) as contexts_after_rollback,
  (select count(*) from supabase_migrations.schema_migrations) as migrations,
  (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where c.relkind='r' and ((n.nspname='public' and c.relname like 'hub_%') or n.nspname in ('arahub_private','supabase_migrations'))
      and (not c.relrowsecurity or not c.relforcerowsecurity)) as unprotected_tables;
