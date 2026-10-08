/** Generates reviewable, INACTIVE SQL. Does not connect to or modify a server. */
import { z } from "zod";
export function prepareFollowupCron(grantId: string, projectUrl: string) {
  z.string().uuid().parse(grantId);
  const url = new URL(projectUrl);
  if (
    url.protocol !== "https:" || !/^[a-z0-9]{20}\.supabase\.co$/.test(url.hostname) ||
    url.port || url.username || url.password || url.search || url.hash || url.pathname !== "/"
  ) throw new Error("FOLLOWUP_PROJECT_URL");
  const job = "arahub-followup-" + grantId;
  const secret = "arahub_followup_key/" + grantId;
  const command = `do $tick$
declare grant_config jsonb; grant_state jsonb; instant timestamptz := clock_timestamp(); local_time time;
begin
  select config,state into grant_config,grant_state from arahub_private.followup_grants where id='${grantId}'::uuid;
  if grant_config is null or (grant_config->>'expires_at')::bigint <= extract(epoch from instant)*1000
     or (grant_state->>'paused')::boolean then
    perform cron.unschedule('${job}');
    return;
  end if;
  local_time := (instant at time zone 'Europe/Lisbon')::time;
  if (grant_config->>'starts_at')::bigint > extract(epoch from instant)*1000
     or not ((local_time >= time '08:00' and local_time < time '09:30')
          or (local_time >= time '20:00' and local_time < time '21:30')) then return; end if;
  perform net.http_post(
    url := '${url.origin}/functions/v1/arahub-acompanhamento',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' ||
      (select decrypted_secret from vault.decrypted_secrets where name='${secret}')),
    body := '{}'::jsonb, timeout_milliseconds := 60000);
end $tick$;`;
  return {
    job_name: job,
    vault_name: secret,
    install_disabled_sql:
      `-- Requires reviewed authorization, extensions pg_cron/pg_net, private grant,
-- deployed authenticated function and a dedicated key already stored in Vault.
-- No key is included here. This transaction installs an INACTIVE job.
begin;
select cron.schedule('${job}','*/5 * * * *',$command$${command}$command$);
update cron.job set active=false where jobname='${job}';
commit;
`,
    activate_sql: `-- Only after hosted runtime proof and explicit activation approval.
update cron.job set active=true where jobname='${job}';
`,
    pause_sql: `begin;
update arahub_private.followup_grants set state=jsonb_set(jsonb_set(state,'{paused}','true'),'{reason}','"manual"') where id='${grantId}'::uuid;
select cron.unschedule('${job}');
commit;
`,
  };
}
if (import.meta.main) {
  const [grant, project] = Deno.args;
  if (!grant || !project) {
    throw new Error("Usage: prepare_followup_cron.ts <grant UUID> <project HTTPS URL>");
  }
  // SQL contains identifiers, never credential values. Redirect outside Git for a real deployment.
  console.log(JSON.stringify(prepareFollowupCron(grant, project), null, 2));
}
