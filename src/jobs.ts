import { asOwner, type Db, logicalWriteBytes } from "./db.ts";
import { type Coverage, HubError, type Principal } from "./contracts.ts";
import type postgres from "postgres";

/** Runtime-only opt-in; no HTTP/MCP caller accepts this capability. */
export interface JobClaimGate {
  readonly policyId: string;
  reserve(tx: postgres.TransactionSql, job: {
    id: string;
    connection_id: string;
    kind: string;
    attempts: number;
  }): Promise<boolean>;
}

export class Jobs {
  constructor(private db: Db) {}
  enqueue(p: Principal, connectionId: string, kind: string) {
    return asOwner(this.db, p, async (tx) => {
      const parent =
        await tx`select id from public.hub_connections where owner_id=${p.ownerId} and id=${connectionId}`;
      if (!parent.length) throw new HubError("not_found", "Registro não encontrado.", 404);
      return (await tx`insert into public.hub_jobs(owner_id,connection_id,kind) values(${p.ownerId},${connectionId},${kind}) returning id,state,attempts`)[
        0
      ];
    });
  }
  claim(p: Principal, jobId?: string, gate?: JobClaimGate) {
    return asOwner(this.db, p, async (tx) => {
      const rows =
        await tx`select id,connection_id,kind,attempts from public.hub_jobs where owner_id=${p.ownerId}
        and (coverage->>'followup_policy_id') is not distinct from ${
          gate?.policyId ?? null
        }::text and (${jobId ?? null}::uuid is null or id=${
          jobId ?? null
        }::uuid) and attempts<5 and (state in ('pending','partial') or (state='running' and lease_until<now())) order by updated_at for update skip locked limit 1`;
      if (!rows.length) return null;
      // Transaction locks work with transaction pooling; session advisory locks do not.
      // Serialize claims and descriptor edits by connection, then reject an active
      // sibling job for this exact sync key. Different keys remain independently leased.
      const scope = "arahub:sync:" + p.ownerId + ":" + rows[0].connection_id;
      const [lock] =
        await tx`select pg_try_advisory_xact_lock(hashtextextended(${scope},0)) as acquired`;
      if (!lock.acquired) return null;
      const busy =
        await tx`select id,lease_until>clock_timestamp() as active from public.hub_jobs where owner_id=${p.ownerId}
        and connection_id=${rows[0].connection_id} and
        (kind=${rows[0].kind} or ${!!gate} or coverage ? 'followup_policy_id') and id<>${rows[0].id}
        and state='running' order by id for update`;
      if (busy.some((row) => row.active)) return null;
      if (
        gate && !await gate.reserve(
          tx,
          rows[0] as {
            id: string;
            connection_id: string;
            kind: string;
            attempts: number;
          },
        )
      ) return null;
      // Expired siblings are fenced by state as well as time before a new claim.
      await tx`update public.hub_jobs set state=case when attempts>=5 then 'failed' else 'partial' end,
        lease_until=null where owner_id=${p.ownerId} and connection_id=${rows[0].connection_id}
        and kind=${rows[0].kind} and id<>${
        rows[0].id
      } and state='running' and lease_until<=clock_timestamp()`;
      return (await tx`update public.hub_jobs set state='running',attempts=attempts+1,lease_until=now()+interval '2 minutes',updated_at=now() where owner_id=${p.ownerId} and id=${
        rows[0].id
      } returning id,connection_id,kind,cursor,attempts`)[0];
    });
  }
  finish(
    p: Principal,
    id: string,
    attempt: number,
    coverage: Coverage,
    cursor: Record<string, unknown> | null,
    details: Record<string, unknown> = {},
  ) {
    return asOwner(this.db, p, async (tx) => {
      const state = coverage === "complete"
        ? "complete"
        : coverage === "expired"
        ? "expired"
        : attempt >= 5
        ? "failed"
        : "partial";
      const rows = await tx`update public.hub_jobs set state=${state},cursor=case when ${
        coverage === "complete"
      } then ${tx.json(JSON.parse(JSON.stringify(cursor)))} else cursor end,coverage=
      (case when coverage ? 'followup_policy_id' then jsonb_build_object('followup_policy_id',coverage->'followup_policy_id') else '{}'::jsonb end) || (${
        tx.json({ status: coverage, ...JSON.parse(JSON.stringify(details)) })
      }::jsonb - 'followup_policy_id'),lease_until=null,updated_at=now() where owner_id=${p.ownerId} and id=${id} and attempts=${attempt} and state='running' and lease_until>clock_timestamp() returning id,state,cursor,attempts,coverage`;
      if (!rows.length) {
        throw new HubError("job_conflict", "O lote já mudou ou não está disponível.", 409);
      }
      return rows[0];
    }, { logicalBytes: () => logicalWriteBytes({ coverage, cursor, details }) });
  }
  list(p: Principal) {
    return asOwner(
      this.db,
      p,
      (tx) =>
        tx`select id,connection_id,kind,state,attempts,coverage,updated_at from public.hub_jobs where owner_id=${p.ownerId} order by updated_at desc limit 30`,
    );
  }
}
