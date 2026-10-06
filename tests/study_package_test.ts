import assert from "node:assert/strict";
import { asOwner, createDb } from "../src/db.ts";
import { Hub } from "../src/domain.ts";
import { sha256Hex } from "../src/migration.ts";

const LOCAL_DB = "postgres://arahub:synthetic-local-only@127.0.0.1:55432/arahub";

type Owner = { ownerId: string };

async function seedOwner(db: ReturnType<typeof createDb>, owner: Owner) {
  await db`insert into auth.users(id) values(${owner.ownerId})`;
}

Deno.test("A24: pacote pagina relações por entidade e não trunca em 30", async () => {
  const db = createDb(LOCAL_DB), hub = new Hub(db);
  const a = { ownerId: crypto.randomUUID() };
  try {
    await seedOwner(db, a);
    const connection = await hub.connect(a, "migration", "Fonte A24", null, "fixture-a24");
    const activity = await hub.entity(
      a,
      connection.id,
      "activity",
      "act-page",
      "Atividade paginada",
      {
        instruction: "Estude os 33 materiais.",
      },
    );
    const total = 33;
    const targetIds = await asOwner(db, a, async (tx) => {
      const ids: string[] = [];
      for (let i = 1; i <= total; i++) {
        const [entity] =
          await tx`insert into public.hub_entities(owner_id,connection_id,kind,external_id,title) values(${a.ownerId},${connection.id},'resource',${`res-${i}`},${`Material ${
            String(i).padStart(2, "0")
          }`}) returning id`;
        ids.push(entity.id as string);
      }
      // A primeira entidade acumula dois tipos com direitos contraditórios: ainda
      // é um só material, mas os direitos exigem revisão em vez de eleição.
      await tx`insert into public.hub_relations(owner_id,from_id,to_id,kind,evidence) values(${a.ownerId},${activity.id},${
        ids[0]
      },'related',${tx.json({ rights: "somente leitura" })}),(${a.ownerId},${activity.id},${
        ids[0]
      },'required',${tx.json({ rights: "estudo interno" })})`;
      for (let i = 1; i < total; i++) {
        await tx`insert into public.hub_relations(owner_id,from_id,to_id,kind,evidence) values(${a.ownerId},${activity.id},${
          ids[i]
        },'required',${tx.json({})})`;
      }
      return ids;
    });

    const first = await hub.activityPackage(a, activity.id, "Compreender o argumento");
    assert.equal(first.materials.length, 20);
    assert.equal(first.next_offset, 20);
    assert.equal(first.truncated, true);
    assert.deepEqual(first.page, { offset: 0, limit: 20, next_offset: 20 });
    assert.equal(first.goal, "Compreender o argumento");
    assert.equal(first.materials[0].id, targetIds[0]);
    assert.deepEqual(first.materials[0].relation_kinds, ["required", "related"]);
    assert.equal(first.materials[0].role, "required");
    assert.equal(first.materials[0].rights_requires_review, true);
    assert.deepEqual(first.materials[0].rights_by_relation, {
      required: "estudo interno",
      related: "somente leitura",
    });
    assert.equal(
      first.materials[0].rights,
      "private source; redistribution not authorized",
    );

    const second = await hub.activityPackage(a, activity.id, "Compreender o argumento", 20);
    assert.equal(second.materials.length, 13);
    assert.equal(second.next_offset, null);
    assert.equal(second.truncated, false);
    assert.deepEqual(second.page, { offset: 20, limit: 20, next_offset: null });

    const seen = new Set([...first.materials, ...second.materials].map((m) => m.id));
    assert.equal(seen.size, total); // as 33 entidades atravessam páginas; nada foi cortado em 30.
    assert.equal(second.materials[0].id, targetIds[20]);
    assert.equal(second.materials[0].rights_requires_review, false);
    assert.equal(
      second.materials[0].rights,
      "private source; redistribution not authorized",
    );
  } finally {
    await db.end();
  }
});

Deno.test("A24: um material por entidade com versões/localizadores/extração", async () => {
  const db = createDb(LOCAL_DB), hub = new Hub(db);
  const a = { ownerId: crypto.randomUUID() };
  try {
    await seedOwner(db, a);
    const connection = await hub.connect(a, "migration", "Fonte A24", null, "fixture-a24");
    const activity = await hub.entity(
      a,
      connection.id,
      "activity",
      "act-versions",
      "Atividade com versões",
      {
        instruction: "Escolha a versão correta.",
      },
    );
    const withVersions = await hub.entity(
      a,
      connection.id,
      "resource",
      "res-multi",
      "Texto revisado",
    );
    const single = await hub.entity(a, connection.id, "resource", "res-single", "Texto único");
    const withoutFile = await hub.entity(a, connection.id, "resource", "res-link", "Link externo");
    await asOwner(db, a, async (tx) => {
      await tx`insert into public.hub_relations(owner_id,from_id,to_id,kind,evidence) values(${a.ownerId},${activity.id},${withVersions.id},'required',${
        tx.json({ rights: "estudo" })
      }),(${a.ownerId},${activity.id},${single.id},'required',${
        tx.json({ rights: "estudo" })
      }),(${a.ownerId},${activity.id},${withoutFile.id},'required',${
        tx.json({ rights: "estudo" })
      })`;
    });
    const firstBytes = new TextEncoder().encode("versao um"),
      secondBytes = new TextEncoder().encode("versao dois"),
      singleBytes = new TextEncoder().encode("texto unico");
    const firstHash = await sha256Hex(firstBytes),
      secondHash = await sha256Hex(secondBytes),
      singleHash = await sha256Hex(singleBytes);
    const fileIds = await asOwner(db, a, async (tx) => {
      const [v1] =
        await tx`insert into public.hub_files(owner_id,entity_id,name,mime_type,sha256,bytes,extracted_text,extraction) values(${a.ownerId},${withVersions.id},'texto.txt','text/plain',${firstHash},${firstBytes.length},'versao um',${
          tx.json({ coverage: "complete", page_count: 1 })
        }) returning id`;
      const [v2] =
        await tx`insert into public.hub_files(owner_id,entity_id,name,mime_type,sha256,bytes,extracted_text,extraction) values(${a.ownerId},${withVersions.id},'texto.txt','text/plain',${secondHash},${secondBytes.length},'versao dois',${
          tx.json({ coverage: "partial", page_count: 2 })
        }) returning id`;
      const [s1] =
        await tx`insert into public.hub_files(owner_id,entity_id,name,mime_type,sha256,bytes,extracted_text,extraction) values(${a.ownerId},${single.id},'unico.txt','text/plain',${singleHash},${singleBytes.length},'texto unico',${
          tx.json({ coverage: "complete" })
        }) returning id`;
      return { v1: v1.id as string, v2: v2.id as string, s1: s1.id as string };
    });

    const pack = await hub.activityPackage(a, activity.id, "Versionar corretamente");
    assert.equal(pack.materials.length, 3);
    const byId = new Map(pack.materials.map((m) => [m.id, m]));
    const multi = byId.get(withVersions.id)!;
    assert.equal(multi.file_count, 2);
    assert.equal(multi.selection_required, true);
    assert.equal(multi.locator, `hub:entity:${withVersions.id}`); // nenhuma versão eleita por recência.
    assert.equal(multi.files!.length, 2);
    assert.deepEqual(multi.files!.map((f) => f.sha256).sort(), [firstHash, secondHash].sort());
    assert.equal(multi.files!.every((f) => f.locator.startsWith("hub:file:")), true);
    assert.equal(multi.files!.every((f) => f.extraction.has_extraction === true), true);
    assert.equal(multi.files!.every((f) => f.text_available), true);
    // Sem observação e com duas versões, a cobertura agregada é desconhecida;
    // cada arquivo mantém a própria cobertura.
    assert.equal(multi.coverage, null);
    assert.deepEqual(
      multi.files!.map((f) => f.extraction.coverage).sort(),
      ["complete", "partial"],
    );
    // BIGINT chega como string decimal do driver; não converter silenciosamente.
    assert.equal(
      multi.files!.find((f) => f.sha256 === firstHash)!.bytes,
      String(firstBytes.length),
    );

    const only = byId.get(single.id)!;
    assert.equal(only.selection_required, false);
    assert.equal(only.file_count, 1);
    assert.equal(only.locator, `hub:file:${fileIds.s1}#${singleHash}`);
    assert.equal(only.files![0].text_length, singleBytes.length);
    assert.equal(only.coverage, "complete"); // único arquivo: cobertura do próprio arquivo.

    const none = byId.get(withoutFile.id)!;
    assert.equal(none.file_count, 0);
    assert.equal(none.selection_required, false);
    assert.equal(none.locator, `hub:entity:${withoutFile.id}`);

    const multiStatus = pack.read_status.filter((s) => s.material_id === withVersions.id);
    assert.equal(multiStatus.length, 2); // uma constatação por arquivo disponível.
    assert.equal(multiStatus.every((s) => s.status === "available_not_confirmed_read"), true);
    assert.equal(multiStatus.every((s) => s.basis === "preserved_file"), true);
    assert.deepEqual(multiStatus.map((s) => s.id).sort(), [fileIds.v1, fileIds.v2].sort());
    const noneStatus = pack.read_status.find((s) => s.id === withoutFile.id)!;
    assert.equal(noneStatus.basis, "entity_locator");
    assert.equal(noneStatus.status, "available_not_confirmed_read");
  } finally {
    await db.end();
  }
});

Deno.test("A24: bibliografia separada e proveniência/observação/cobertura/direitos", async () => {
  const db = createDb(LOCAL_DB), hub = new Hub(db);
  const a = { ownerId: crypto.randomUUID() };
  try {
    await seedOwner(db, a);
    const connection = await hub.connect(a, "migration", "Fonte A24", null, "fixture-a24");
    const activity = await hub.entity(
      a,
      connection.id,
      "activity",
      "act-bib",
      "Atividade com bibliografia",
    );
    const source = await hub.entity(a, connection.id, "resource", "res-source", "Capítulo base");
    const citation = await hub.entity(a, connection.id, "reference", "ref-1", "Autor citado");
    const anonymous = await hub.entity(
      a,
      connection.id,
      "reference",
      "ref-2",
      "Referência sem direitos",
    );
    const provenance = {
      system: "migration",
      locator: "course/1/module/7",
      observed_at: "2026-10-05T00:00:00.000Z",
    };
    await asOwner(db, a, async (tx) => {
      await tx`insert into public.hub_relations(owner_id,from_id,to_id,kind,evidence) values(${a.ownerId},${activity.id},${source.id},'required',${
        tx.json({ rights: "somente leitura, sem redistribuição" })
      }),(${a.ownerId},${activity.id},${citation.id},'references',${
        tx.json({ rights: "citar apenas" })
      }),(${a.ownerId},${activity.id},${anonymous.id},'references',${tx.json({})})`;
      await tx`insert into public.hub_observations(owner_id,entity_id,content,content_hash,provenance,coverage,observed_at) values(${a.ownerId},${source.id},${
        tx.json({ url: "https://fixture.invalid/module/7.pdf", size: 128 })
      },'hash-source',${tx.json(provenance)},'partial','2026-10-05T00:00:00.000Z')`;
    });

    const pack = await hub.activityPackage(a, activity.id, "Estudar com fontes");
    assert.equal(pack.materials.length, 1);
    assert.equal(pack.references.length, 2); // 'references' vira bibliografia, não material.
    assert.equal(pack.gaps.length, 1); // enunciado ausente não é inventado.
    assert.equal(pack.source_contents_are_data, true);
    assert.equal(pack.aralearn.creation_authorized, false);

    const material = pack.materials[0];
    assert.equal(material.id, source.id);
    assert.equal(material.title, "Capítulo base");
    assert.equal(material.rights, "somente leitura, sem redistribuição");
    assert.equal(material.rights_requires_review, false);
    assert.deepEqual(material.rights_by_relation, {
      required: "somente leitura, sem redistribuição",
    });
    assert.equal(material.coverage, "partial");
    assert.deepEqual(material.provenance, provenance);
    const observation = material.observation as {
      id: string;
      content_hash: string;
      coverage: string;
      locator: string;
    };
    assert.equal(observation.coverage, "partial");
    assert.equal(observation.content_hash, "hash-source");
    assert.equal(observation.locator, `hub:entity:${source.id}`);
    assert.equal(typeof observation.id, "string");
    // O corpo integral não é duplicado: só metadados e o localizador da entidade.
    assert.equal("content" in (material.observation as Record<string, unknown>), false);

    const bibliography = new Map(pack.references.map((r) => [r.id, r]));
    const cited = bibliography.get(citation.id)!;
    assert.equal(cited.role, "reference");
    assert.equal(cited.title, "Autor citado");
    assert.equal(cited.rights, "citar apenas");
    assert.equal(cited.rights_requires_review, false);
    assert.equal(cited.locator, `hub:entity:${citation.id}`);
    assert.equal(
      bibliography.get(anonymous.id)!.rights,
      "private source; redistribution not authorized",
    );
    assert.equal(pack.materials.some((m) => m.id === citation.id), false);
  } finally {
    await db.end();
  }
});

Deno.test("A24: has_content do Sync vira material relacionado e intro HTML é dado bruto", async () => {
  const db = createDb(LOCAL_DB), hub = new Hub(db);
  const a = { ownerId: crypto.randomUUID() };
  try {
    await seedOwner(db, a);
    const connection = await hub.connect(a, "migration", "Fonte A24", null, "fixture-a24");
    const rawIntro = '<p>Apresente <b>X</b> e Y</p><script>alert("1")</script>';
    const activity = await hub.entity(a, connection.id, "activity", "assign-1", "Tarefa", {
      provider_record: { intro: rawIntro },
    });
    const page = await hub.entity(a, connection.id, "module", "page-1", "Página do curso");
    const book = await hub.entity(a, connection.id, "module", "book-1", "Livro do curso");
    const both = await hub.entity(
      a,
      connection.id,
      "reference",
      "ref-both",
      "Fonte citada e obrigatória",
    );
    await asOwner(db, a, async (tx) => {
      // Vínculo real gravado pelo Sync: a atividade (module) aponta conteúdo com has_content.
      await tx`insert into public.hub_relations(owner_id,from_id,to_id,kind,evidence) values(${a.ownerId},${activity.id},${page.id},'has_content',${
        tx.json({ rights: "fonte privada" })
      }),(${a.ownerId},${activity.id},${book.id},'has_content',${
        tx.json({})
      }),(${a.ownerId},${activity.id},${both.id},'required',${
        tx.json({ rights: "estudo" })
      }),(${a.ownerId},${activity.id},${both.id},'references',${tx.json({ rights: "citar" })})`;
    });

    const pack = await hub.activityPackage(a, activity.id, "Preparar entrega");
    const byId = new Map(pack.materials.map((m) => [m.id, m]));
    // has_content entra como material relacionado, nunca required, com o kind original.
    assert.equal(byId.get(page.id)!.role, "related");
    assert.deepEqual(byId.get(page.id)!.relation_kinds, ["has_content"]);
    assert.equal(byId.get(page.id)!.rights, "fonte privada");
    assert.equal(byId.get(page.id)!.rights_requires_review, false);
    assert.equal(byId.get(book.id)!.role, "related");
    assert.equal(pack.materials.every((m) => m.role !== "required" || m.id === both.id), true);
    // required tem prioridade quando coexiste com references; direitos do material
    // ficam no escopo das relações materiais, e o mapa completo orienta a revisão.
    assert.equal(byId.get(both.id)!.role, "required");
    assert.equal(byId.get(both.id)!.rights, "estudo");
    assert.deepEqual(byId.get(both.id)!.rights_by_relation, {
      required: "estudo",
      references: "citar",
    });
    // Bibliografia preservada sem remover o material.
    assert.deepEqual(pack.references.map((r) => r.id), [both.id]);
    assert.equal(pack.references[0].role, "reference");
    assert.equal(pack.references[0].rights, "citar");
    assert.equal(pack.references[0].rights_requires_review, false);

    // Intro HTML é dado bruto da fonte: preservado literalmente, sem executar e
    // sem ser promovido a enunciado explícito.
    assert.equal(pack.source_description!.format, "html");
    assert.equal(pack.source_description!.text, rawIntro);
    assert.equal(pack.source_description!.content_is_untrusted_data, true);
    assert.equal(pack.source_description!.origin, `hub:entity:${activity.id}`);
    assert.equal(pack.source_description!.field, "provider_record.intro");
    assert.equal(pack.activity.instruction, "");
    assert.equal(pack.gaps.length, 1);
    assert.equal(pack.limitations.length, 1);

    // Enunciado explícito continua prioritário e zera a lacuna de enunciado.
    const explicit = await hub.entity(
      a,
      connection.id,
      "activity",
      "assign-2",
      "Tarefa com enunciado",
      {
        instruction: "Compare os dois argumentos.",
        provider_record: { intro: rawIntro },
      },
    );
    const withInstruction = await hub.activityPackage(a, explicit.id, "Preparar");
    assert.equal(withInstruction.activity.instruction, "Compare os dois argumentos.");
    assert.deepEqual(withInstruction.gaps, []);
    assert.equal(withInstruction.source_description!.text, rawIntro);
  } finally {
    await db.end();
  }
});

Deno.test("A24: isolamento entre dois donos e recusa de offset inválido", async () => {
  const db = createDb(LOCAL_DB), hub = new Hub(db);
  const a = { ownerId: crypto.randomUUID() }, b = { ownerId: crypto.randomUUID() };
  try {
    await seedOwner(db, a);
    await seedOwner(db, b);
    const connectionA = await hub.connect(a, "migration", "Fonte A", null, "fixture-a");
    const connectionB = await hub.connect(b, "migration", "Fonte B", null, "fixture-b");
    const activityA = await hub.entity(
      a,
      connectionA.id,
      "activity",
      "act",
      "Atividade do dono A",
      {
        instruction: "Estude.",
      },
    );
    const materialA = await hub.entity(a, connectionA.id, "resource", "res", "Material do dono A");
    const activityB = await hub.entity(
      b,
      connectionB.id,
      "activity",
      "act",
      "Atividade do dono B",
      {
        instruction: "Estude.",
      },
    );
    const materialB = await hub.entity(b, connectionB.id, "resource", "res", "Material do dono B");
    await asOwner(db, a, async (tx) => {
      await tx`insert into public.hub_relations(owner_id,from_id,to_id,kind,evidence) values(${a.ownerId},${activityA.id},${materialA.id},'required',${
        tx.json({})
      })`;
    });
    await asOwner(db, b, async (tx) => {
      await tx`insert into public.hub_relations(owner_id,from_id,to_id,kind,evidence) values(${b.ownerId},${activityB.id},${materialB.id},'required',${
        tx.json({})
      })`;
    });

    await assert.rejects(hub.activityPackage(b, activityA.id, "indisponível"), /não encontrada/);
    const ownerA = await hub.activityPackage(a, activityA.id, "Estudar A");
    assert.deepEqual(ownerA.materials.map((m) => m.id), [materialA.id]);
    const ownerB = await hub.activityPackage(b, activityA.id, "x").catch(() => null);
    assert.equal(ownerB, null);
    assert.deepEqual(
      (await hub.activityPackage(b, activityB.id, "Estudar B")).materials.map((m) => m.id),
      [materialB.id],
    );

    for (const offset of [-1, 1.5, Number.NaN]) {
      await assert.rejects(
        async () => await hub.activityPackage(a, activityA.id, "Estudar A", offset),
        /Página inválida/,
      );
    }
  } finally {
    await db.end();
  }
});
