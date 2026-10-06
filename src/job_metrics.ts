/**
 * Medicao do custo por tentativa de job (A30).
 *
 * Cada instancia de JobMetrics pertence a UMA execucao (uma tentativa ativa de
 * um lote). O contador, o tempo monotono e as amostras de memoria ficam presos a
 * essa instancia, sem estado global, para nao misturar donos nem execucoes
 * concorrentes.
 *
 * - `calls` conta chamadas efetivamente enviadas ao provedor: o adaptador de
 *   transporte incrementa no ponto de despacho, logo a contagem nao e inferida
 *   por item/pagina e inclui tentativas que falharam depois de sair daqui.
 * - `duration_ms` usa relogio monotono (performance.now), nao relogio de parede.
 * - `memory` e uma amostra do processo/isolate COMPARTILHADO: nao e memoria
 *   exclusiva do job nem pico garantido, e pode estar indisponivel.
 *
 * Nenhum dado sensivel (URL, query, cabecalho, token, conteudo) entra no
 * relatorio: apenas numeros, nomes de escopo e tempos.
 */

export interface JobMemorySample {
  readonly rss_bytes: number | null;
  readonly heap_used_bytes: number | null;
  readonly heap_total_bytes: number | null;
  readonly sampled_at: string;
}

export interface JobMetricsMemory {
  /** Amostra do processo/isolate compartilhado, nao da execucao isolada. */
  readonly scope: "process_shared";
  readonly start: JobMemorySample | null;
  readonly end: JobMemorySample | null;
}

export interface JobMetricsReport {
  readonly duration_ms: number;
  readonly calls: number;
  readonly memory: JobMetricsMemory;
  readonly started_at: string;
  readonly finished_at: string;
}

interface DenoMemoryUsage {
  readonly rss: number;
  readonly heapTotal: number;
  readonly heapUsed: number;
}

/** Le a memoria do processo Deno quando o runtime a oferece; senao devolve null. */
function denoMemoryUsage(): DenoMemoryUsage | null {
  const deno = (globalThis as { Deno?: { memoryUsage?: () => DenoMemoryUsage } }).Deno;
  if (!deno || typeof deno.memoryUsage !== "function") return null;
  try {
    const usage = deno.memoryUsage();
    if (!usage || typeof usage.rss !== "number" || typeof usage.heapUsed !== "number") {
      return null;
    }
    return usage;
  } catch {
    return null;
  }
}

function sampleMemory(): JobMemorySample | null {
  const usage = denoMemoryUsage();
  if (!usage) return null;
  // Hosted isolates may expose zero for unsupported RSS. A running JS heap
  // cannot establish physical zero-byte usage: report that field unavailable.
  const available = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
  return {
    rss_bytes: available(usage.rss),
    heap_used_bytes: available(usage.heapUsed),
    heap_total_bytes: available(usage.heapTotal),
    sampled_at: new Date().toISOString(),
  };
}

export interface JobMetricsOptions {
  /** Relogio monotono em milissegundos. Injetavel para teste. */
  readonly monotonicMs?: () => number;
  /** Relogio de parede ISO. Injetavel para teste. */
  readonly wallIso?: () => string;
  /** Amostrador de memoria. Injetavel para teste. */
  readonly memorySample?: () => JobMemorySample | null;
}

export class JobMetrics {
  readonly #monotonicMs: () => number;
  readonly #wallIso: () => string;
  readonly #memorySample: () => JobMemorySample | null;
  readonly #startedAt: string;
  readonly #startedMono: number;
  readonly #startMemory: JobMemorySample | null;
  #calls = 0;

  constructor(options: JobMetricsOptions = {}) {
    this.#monotonicMs = options.monotonicMs ?? (() => performance.now());
    this.#wallIso = options.wallIso ?? (() => new Date().toISOString());
    this.#memorySample = options.memorySample ?? sampleMemory;
    this.#startedAt = this.#wallIso();
    this.#startedMono = this.#monotonicMs();
    this.#startMemory = this.#memorySample();
  }

  /** Registra uma chamada que esta sendo efetivamente despachada ao provedor. */
  recordCall(): void {
    this.#calls++;
  }

  get calls(): number {
    return this.#calls;
  }

  /** Duracao monotona decorrida desde o inicio da tentativa, em ms inteiros. */
  get elapsedMs(): number {
    return Math.max(0, Math.round(this.#monotonicMs() - this.#startedMono));
  }

  /** Relatorio seguro para o coverage do job: sem URL, token, cabecalho ou conteudo. */
  report(): JobMetricsReport {
    return {
      duration_ms: this.elapsedMs,
      calls: this.#calls,
      memory: {
        scope: "process_shared",
        start: this.#startMemory,
        end: this.#memorySample(),
      },
      started_at: this.#startedAt,
      finished_at: this.#wallIso(),
    };
  }
}
