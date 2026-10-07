import { Hub } from "./domain.ts";
import { asOwner, withJobLease } from "./db.ts";
import { HubError, type Principal } from "./contracts.ts";
import { Jobs } from "./jobs.ts";
import { sha256Hex } from "./migration.ts";
import { documentExtractionToText, type DocumentTextExtraction } from "./document_text.ts";

/** Runs CPU work in a terminable worker. The Edge host must use a separate executor. */
export async function extractDocumentIsolated(
  bytes: Uint8Array,
  format: "docx" | "html",
  timeoutMs = 20_000,
): Promise<DocumentTextExtraction> {
  if (typeof Worker === "undefined") {
    throw new HubError(
      "processor_unavailable",
      "Este runtime requer um executor de documentos separado.",
      503,
    );
  }
  const worker = new Worker(new URL("./document_worker.ts", import.meta.url).href, {
    type: "module",
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise((resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new HubError(
              "processor_timeout",
              "O processamento excedeu o limite de CPU/tempo.",
              408,
            ),
          ),
        timeoutMs,
      );
      worker.onerror = (event) => {
        event.preventDefault();
        reject(new HubError("processor_failed", "O executor não concluiu o documento.", 422));
      };
      worker.onmessage = (event) => {
        if (!event.data?.result) {
          reject(new HubError("processor_failed", "O executor recusou o documento.", 422));
        } else resolve(event.data.result);
      };
      const copy = bytes.slice();
      worker.postMessage({ bytes: copy.buffer, format }, [copy.buffer]);
    });
  } finally {
    clearTimeout(timer);
    worker.terminate();
  }
}

export class DocumentMaterials {
  constructor(private hub: Hub, private extract = extractDocumentIsolated) {}
  async enqueue(p: Principal, fileId: string, hash: string) {
    return await asOwner(this.hub.db, p, async (tx) => {
      const file =
        (await tx`select f.sha256,f.mime_type,e.connection_id from public.hub_files f join public.hub_entities e on e.owner_id=f.owner_id and e.id=f.entity_id where f.owner_id=${p.ownerId} and f.id=${fileId} for update of f`)[
          0
        ];
      if (!file) throw new HubError("not_found", "Arquivo não encontrado.", 404);
      if (file.sha256 !== hash) {
        throw new HubError("version_changed", "O hash do material mudou.", 409);
      }
      if (
        ![
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          "text/html",
          "application/xhtml+xml",
        ].includes(file.mime_type)
      ) throw new HubError("unsupported_type", "Este processador aceita DOCX e HTML.", 422);
      const kind = `document:${fileId}:${hash}`;
      const prior =
        (await tx`select id,state,attempts from public.hub_jobs where owner_id=${p.ownerId} and connection_id=${file.connection_id} and kind=${kind} order by updated_at desc limit 1`)[
          0
        ];
      if (prior) {
        return {
          id: String(prior.id),
          state: String(prior.state),
          attempts: Number(prior.attempts),
          reused: true,
          processor_required: true,
        };
      }
      const job =
        (await tx`insert into public.hub_jobs(owner_id,connection_id,kind) values(${p.ownerId},${file.connection_id},${kind}) returning id,state,attempts`)[
          0
        ];
      return {
        id: String(job.id),
        state: String(job.state),
        attempts: Number(job.attempts),
        reused: false,
        processor_required: true,
      };
    });
  }
  async run(p: Principal, jobId: string) {
    // Validate kind before acquiring a lease: never consume another subsystem's job.
    const descriptor = await asOwner(
      this.hub.db,
      p,
      async (tx) =>
        (await tx`select kind from public.hub_jobs where owner_id=${p.ownerId} and id=${jobId}`)[0],
    );
    const parsed = /^document:([a-f0-9-]{36}):([a-f0-9]{64})$/.exec(descriptor?.kind ?? "");
    if (!parsed) throw new HubError("not_found", "Job de documento não encontrado.", 404);
    const jobs = new Jobs(this.hub.db), job = await jobs.claim(p, jobId);
    if (!job) return { state: "not_claimed" };
    const actor = withJobLease(p, job.id, job.attempts), fileId = parsed[1], hash = parsed[2];
    try {
      const file = await asOwner(
        this.hub.db,
        actor,
        async (tx) =>
          (await tx`select sha256,mime_type,binary_content from public.hub_files where owner_id=${p.ownerId} and id=${fileId}`)[
            0
          ],
      );
      if (
        !file || file.sha256 !== hash ||
        await sha256Hex(new Uint8Array(file.binary_content)) !== hash
      ) {
        throw new HubError(
          "version_changed",
          "Os bytes do documento não correspondem ao hash.",
          409,
        );
      }
      const result = await this.extract(
        new Uint8Array(file.binary_content),
        file.mime_type.includes("wordprocessingml") ? "docx" : "html",
      );
      const extraction = {
        ...result,
        processor: { name: "arahub-document-worker", version: 1, sha256: hash },
        execution: "isolated_worker",
        hard_timeout: true,
      };
      const retained = await asOwner(this.hub.db, actor, async (tx) => {
        const current =
          (await tx`select extraction from public.hub_files where owner_id=${p.ownerId} and id=${fileId} and sha256=${hash} for update`)[
            0
          ];
        if (!current) throw new HubError("version_changed", "A versão do documento mudou.", 409);
        const prior = current.extraction;
        const rank = (coverage: unknown) =>
          coverage === "complete" ? 2 : coverage === "partial" ? 1 : 0;
        // A retry may use a degraded processor. Keep the stronger representation
        // of these same source bytes rather than silently erasing useful content.
        if (
          prior.kind === "document_text_extraction" &&
          (rank(prior.coverage) > rank(result.coverage) ||
            (rank(prior.coverage) === rank(result.coverage) &&
              Number(prior.block_count) > result.block_count))
        ) {
          return {
            coverage: prior.coverage,
            blocks: Number(prior.block_count),
            preserved_prior: true,
          };
        }
        await tx`update public.hub_files set extraction=${
          tx.json(JSON.parse(JSON.stringify(extraction)))
        },extracted_text=${
          documentExtractionToText(result)
        } where owner_id=${p.ownerId} and id=${fileId} and sha256=${hash}`;
        return { coverage: result.coverage, blocks: result.block_count, preserved_prior: false };
      });
      return await jobs.finish(actor, job.id, job.attempts, retained.coverage, null, {
        file_id: fileId,
        sha256: hash,
        blocks: retained.blocks,
        preserved_prior: retained.preserved_prior,
        source_available_offline: true,
      });
    } catch (e) {
      const code = e instanceof HubError ? e.code : "processor_failed";
      return await jobs.finish(actor, job.id, job.attempts, "unavailable", null, {
        file_id: fileId,
        error_code: code,
        processor_required: true,
      });
    }
  }
  async read(p: Principal, fileId: string, hash: string, offset = 0, limit = 5) {
    if (
      !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 ||
      limit > 10
    ) throw new HubError("invalid_offset", "Janela de blocos inválida.");
    return await asOwner(this.hub.db, p, async (tx) => {
      const file =
        (await tx`select id,name,sha256,extraction-'blocks'-'sanitized_html' as summary,jsonb_array_length(extraction->'blocks') as total from public.hub_files where owner_id=${p.ownerId} and id=${fileId}`)[
          0
        ];
      if (!file) throw new HubError("not_found", "Arquivo não encontrado.", 404);
      if (file.sha256 !== hash) {
        throw new HubError("version_changed", "Selecione o hash preservado.", 409);
      }
      if (file.summary.kind !== "document_text_extraction") {
        return {
          file_id: fileId,
          sha256: hash,
          coverage: "unavailable",
          reason: "not_extracted",
          blocks: [],
          next_offset: null,
        };
      }
      const blocks =
        await tx`select item as block from public.hub_files f cross join lateral jsonb_array_elements(f.extraction->'blocks') with ordinality as b(item,ordinal) where f.owner_id=${p.ownerId} and f.id=${fileId} and ordinal>${offset} order by ordinal limit ${limit}`;
      // A large table must be read through its textual paginated representation until selected cells are requested.
      const bounded = blocks.map(({ block }) =>
        JSON.stringify(block).length <= 32000 ? block : {
          type: block.type,
          locator: block.locator,
          representation: "use_hub_file_text",
          reason: "block_exceeds_response_budget",
        }
      );
      return {
        file_id: fileId,
        sha256: hash,
        name: file.name,
        summary: file.summary,
        offset,
        total: Number(file.total),
        blocks: bounded,
        next_offset: offset + blocks.length < Number(file.total) ? offset + blocks.length : null,
        content_is_untrusted_data: true,
      };
    });
  }
}
