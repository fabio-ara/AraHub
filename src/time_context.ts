import { z } from "zod";
import { asOwner } from "./db.ts";
import type { Hub } from "./domain.ts";
import { HubError, type Principal } from "./contracts.ts";

export const timeContextSchema = z.object({
  entity_ids: z.array(z.string().uuid()).min(1).max(20),
  display_zones: z.array(z.string().min(1).max(100)).min(1).max(4)
    .default(["Europe/Lisbon", "America/Sao_Paulo"]),
}).strict();

type RecordValue = Record<string, unknown>;
export interface NormalizedTime {
  original: unknown;
  kind: "instant" | "date_only" | "unresolved";
  instant: string | null;
  source_time_zone: string | null;
  reason?: string;
  date?: string;
  source_zone_matches?: boolean | null;
  conversion_precision?: string;
  displays?: Array<{ time_zone: string; local: string }>;
}
function object(value: unknown): RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as RecordValue
    : {};
}
function formatter(zone: string) {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    throw new HubError("invalid_time_zone", "Informe um fuso IANA válido.");
  }
}
function wallTime(ms: number, fmt: Intl.DateTimeFormat) {
  const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((v) => [v.type, v.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}
function validDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value + "T00:00:00Z")) &&
    new Date(value + "T00:00:00Z").toISOString().slice(0, 10) === value;
}

/** Local clocks can have zero or two instants at DST transitions. Never choose one by recency. */
export function normalizeTime(raw: unknown, zones: string[]): NormalizedTime {
  const value = object(raw);
  const date = value.date, dateTime = value.dateTime;
  const sourceZone = typeof value.timeZone === "string" ? value.timeZone : null;
  const unresolved = (reason: string): NormalizedTime => ({
    original: raw,
    kind: "unresolved",
    reason,
    instant: null,
    source_time_zone: sourceZone,
  });
  if (typeof date === "string" && dateTime === undefined) {
    return validDate(date)
      ? {
        original: raw,
        kind: "date_only",
        date,
        instant: null,
        source_time_zone: sourceZone,
        reason: "Dia inteiro; não convertido em meia-noite ou horário de envio.",
      }
      : unresolved("invalid_date");
  }
  if (typeof dateTime !== "string" || date !== undefined) return unresolved("invalid_datetime");
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})?$/
    .exec(dateTime);
  if (
    !match || !validDate(match[1]) || Number(match[2]) > 23 || Number(match[3]) > 59 ||
    Number(match[4]) > 59
  ) return unresolved("invalid_datetime");
  const wall = `${match[1]}T${match[2]}:${match[3]}:${match[4]}`;
  const naive = Date.parse(wall + "Z");
  const fractionalMs = match[5] ? Number((match[5].slice(1) + "000").slice(0, 3)) : 0;
  let sourceFormatter: Intl.DateTimeFormat | null = null;
  if (sourceZone) {
    try {
      sourceFormatter = formatter(sourceZone);
    } catch {
      return unresolved("invalid_source_time_zone");
    }
  }
  let ms: number;
  if (match[6]) {
    if (
      match[6] !== "Z" && (Number(match[6].slice(1, 3)) > 23 ||
        Number(match[6].slice(4, 6)) > 59)
    ) return unresolved("invalid_offset");
    ms = Date.parse(dateTime);
    if (!Number.isFinite(ms)) return unresolved("invalid_datetime");
  } else {
    if (!sourceFormatter) return unresolved("time_zone_unconfirmed");
    const offsets = new Set<number>();
    for (let h = -36; h <= 36; h += 6) {
      const sample = naive + h * 3600000;
      const local = wallTime(sample, sourceFormatter);
      offsets.add(Date.parse(local + "Z") - sample);
    }
    const candidates = [...offsets].map((offset) => naive - offset)
      .filter((candidate) => wallTime(candidate, sourceFormatter!) === wall);
    if (candidates.length !== 1) {
      return unresolved(candidates.length ? "ambiguous_local_time" : "nonexistent_local_time");
    }
    ms = candidates[0] + fractionalMs;
  }
  return {
    original: raw,
    kind: "instant",
    instant: new Date(ms).toISOString(),
    source_time_zone: sourceZone,
    source_zone_matches: sourceFormatter ? wallTime(ms, sourceFormatter) === wall : null,
    conversion_precision: "milliseconds; original precision retained in original",
    displays: zones.map((zone) => ({ time_zone: zone, local: wallTime(ms, formatter(zone)) })),
  };
}

/** Read preserved source dates only. This neither queries providers nor schedules/changes events. */
export class TimeContext {
  constructor(private hub: Hub) {}
  async read(p: Principal, input: z.input<typeof timeContextSchema>) {
    const a = timeContextSchema.parse(input), ids = [...new Set(a.entity_ids)];
    const zones = [...new Set(a.display_zones)];
    zones.forEach(formatter);
    return await asOwner(this.hub.db, p, async (tx) => {
      const rows = await tx`select e.id,e.title,e.kind,e.connection_id,e.state,
        c.provider,c.state as connection_state,o.id as observation_id,o.content,o.provenance,
        o.observed_at,o.coverage
        from public.hub_entities e join public.hub_connections c on c.owner_id=e.owner_id and c.id=e.connection_id
        left join lateral (select id,content,provenance,observed_at,coverage from public.hub_observation_timeline
          where owner_id=e.owner_id and entity_id=e.id order by observed_at desc,id desc limit 1) o on true
        where e.owner_id=${p.ownerId} and e.id in ${tx(ids)} order by e.id`;
      if (rows.length !== ids.length) {
        throw new HubError("not_found", "Recurso não encontrado.", 404);
      }
      const entities = rows.map((row) => {
        // Latest observation is authoritative for this projection; never mix dates from separate versions.
        const record = object(row.observation_id ? row.content : object(row.state).provider_record);
        const dates: Array<
          { field: string; time: ReturnType<typeof normalizeTime>; end_exclusive?: boolean }
        > = [];
        const add = (field: string, raw: unknown, endExclusive?: boolean) => {
          if (raw !== undefined && raw !== null) {
            dates.push({
              field,
              time: normalizeTime(raw, zones),
              ...(endExclusive === undefined ? {} : { end_exclusive: endExclusive }),
            });
          }
        };
        if (row.provider === "google" && row.kind === "calendar_event") {
          add("start", record.start);
          if (record.endTimeUnspecified === true && record.end !== undefined) {
            dates.push({
              field: "end",
              time: {
                original: record.end,
                kind: "unresolved",
                reason: "end_time_unspecified",
                instant: null,
                source_time_zone: null,
              },
            });
          } else {
            add("end", record.end, true); // Google Calendar end is exclusive, including date-only events.
          }
          add("originalStartTime", record.originalStartTime);
        } else if (
          row.provider === "moodle" && ["assignment", "assign", "module"].includes(row.kind)
        ) {
          for (
            const field of ["duedate", "cutoffdate", "allowsubmissionsfromdate", "gradingduedate"]
          ) {
            const epoch = record[field];
            if (epoch === 0 || epoch === "0" || epoch === undefined || epoch === null) continue;
            const seconds = typeof epoch === "number"
              ? epoch
              : typeof epoch === "string" && /^\d+$/.test(epoch)
              ? Number(epoch)
              : NaN;
            add(
              field,
              Number.isSafeInteger(seconds) && seconds > 0 && seconds <= 253402300799
                ? { dateTime: new Date(seconds * 1000).toISOString(), source_epoch_seconds: epoch }
                : { invalid_epoch_seconds: epoch },
            );
          }
          // Structure dates keep their source labels as data, never as instructions.
          if (Array.isArray(record.dates)) {
            for (const [index, item] of record.dates.slice(0, 20).entries()) {
              const d = object(item), seconds = d.timestamp;
              add(
                `dates/${index}`,
                typeof seconds === "number" && Number.isSafeInteger(seconds) &&
                  seconds > 0 && seconds <= 253402300799
                  ? {
                    dateTime: new Date(seconds * 1000).toISOString(),
                    source_label: d.label ?? null,
                    source_epoch_seconds: seconds,
                  }
                  : { invalid_epoch_seconds: seconds },
              );
            }
          }
        }
        return {
          id: row.id,
          title: row.title,
          kind: row.kind,
          connection_id: row.connection_id,
          provider: row.provider,
          connection_state: row.connection_state,
          calendar_status: row.kind === "calendar_event" ? record.status ?? null : null,
          calendar_transparency: row.kind === "calendar_event" ? record.transparency ?? null : null,
          dates,
          observation: row.observation_id
            ? {
              id: row.observation_id,
              provenance: row.provenance,
              observed_at: row.observed_at,
              coverage: row.coverage,
            }
            : null,
          basis: row.observation_id ? "preserved_observation" : "unverified_state_projection",
          gaps: [
            ...(!dates.length ? ["Nenhuma data suportada preservada nesse recurso."] : []),
            ...(Array.isArray(record.dates) && record.dates.length > 20
              ? ["Mais de vinte datas na estrutura; consultar observação original."]
              : []),
            ...dates.filter((d) => d.time.kind === "unresolved").map((d) =>
              `${d.field}: ${d.time.reason}`
            ),
            ...dates.filter((d) =>
              d.time.kind === "instant" && d.time.source_zone_matches === false
            )
              .map((d) =>
                `${d.field}: offset e fuso da fonte discordam; instante conserva o offset explícito.`
              ),
          ],
        };
      });
      return {
        entities,
        display_zones: zones,
        source_contents_are_data: true,
        external_changes: false,
        limitations: [
          "Datas observadas não confirmam envio, presença ou disponibilidade atual.",
          "Dia inteiro e horário local ambíguo/sem fuso não viram instantes presumidos; fonte não é atualizada por esta leitura.",
        ],
      };
    });
  }
}
