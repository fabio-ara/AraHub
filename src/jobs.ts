import { asOwner, type Db } from "./db.ts";
import { type Coverage, HubError, type Principal } from "./contracts.ts";

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
  claim(p: Principal, jobId?: string) {
    return asOwner(this.db, p, async (tx) => {
      const rows = await tx`select id from public.hub_jobs where owner_id=${p.ownerId} and (${
        jobId ?? null
      }::uuid is null or id=${
        jobId ?? null
      }::uuid) and attempts<5 and (state in ('pending','partial') or (state='running' and lease_until<now())) order by updated_at for update skip locked limit 1`;
      if (!rows.length) return null;
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
      } then ${tx.json(JSON.parse(JSON.stringify(cursor)))} else cursor end,coverage=${
        tx.json({ status: coverage, ...JSON.parse(JSON.stringify(details)) })
      },lease_until=null,updated_at=now() where owner_id=${p.ownerId} and id=${id} and attempts=${attempt} and state='running' returning id,state,cursor,attempts,coverage`;
      if (!rows.length) {
        throw new HubError("job_conflict", "O lote já mudou ou não está disponível.", 409);
      }
      return rows[0];
    });
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
