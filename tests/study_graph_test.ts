import assert from "node:assert/strict";
import { asOwner, createDb } from "../src/db.ts";
import { Hub } from "../src/domain.ts";
import {
  SECTION_AMBIGUITY_GAP,
  SECTION_MISSING_GAP,
  SECTION_RELATED_KIND,
  studyGraphPage,
} from "../src/study_graph.ts";

const LOCAL_DB = "postgres://arahub:synthetic-local-only@127.0.0.1:55432/arahub";
const OBSERVED_AT = "2026-10-06T00:00:00.000Z";

type Owner = { ownerId: string };
type Db = ReturnType<typeof createDb>;

Deno.test("A24 integrado: IDs Moodle número/texto se vinculam; IDs desconhecidos não criam relação", async () => {
  const db = createDb(LOCAL_DB), hub = new Hub(db), owner = { ownerId: crypto.randomUUID() };
  try {
    await seedOwner(db, owner);
    const connection = await hub.connect(owner, "moodle", "Moodle sintético", null, "fixture-ids");
    const section = await hub.entity(owner, connection.id, "section", "s1", "Seção");
    const module = await hub.entity(owner, connection.id, "module", "m7", "Módulo", {
      course_id: 42,
      module_id: 7,
    });
    const unknown = await hub.entity(owner, connection.id, "module", "unknown", "Sem IDs", {
      course_id: null,
      module_id: null,
    });
    const activity = await hub.entity(owner, connection.id, "assignment", "a1", "Atividade", {
      instruction: "Estudar os materiais relacionados.",
    });
    const resource = await hub.entity(owner, connection.id, "resource", "r7", "Material correto", {
      course_id: "42",
      module_id: "7",
    });
    const missing = await hub.entity(
      owner,
      connection.id,
      "resource",
      "missing",
      "Não identificado",
      {
        course_id: null,
        module_id: null,
      },
    );
    await relate(
      db,
      owner,
      section.id,
      module.id,
      "has_module",
      arc(connection.id, "s1/m7", "structure"),
    );
    await relate(
      db,
      owner,
      section.id,
      unknown.id,
      "has_module",
      arc(connection.id, "s1/unknown", "structure"),
    );
    await relate(
      db,
      owner,
      module.id,
      activity.id,
      "has_content",
      arc(connection.id, "m7/a1", "module_instance"),
    );
    await relate(db, owner, activity.id, resource.id, "required", { rights: "estudo privado" });
    const page = await graph(db, owner, activity.id);
    assert.deepEqual(page.entities.map((e) => e.id), [resource.id]);
    assert.ok(!page.entities.some((e) => e.id === missing.id));
    const pack = await hub.activityPackage(owner, activity.id, "Estudar");
    assert.equal(pack.section_coverage.mode, "section");
    assert.equal(pack.materials.length, 1);
    assert.equal(pack.materials[0].role, "required");
    assert.deepEqual(pack.materials[0].relation_kinds, ["required", "section_related"]);
    assert.equal(pack.materials[0].rights, "estudo privado");
    const derived = pack.materials[0].relation_evidence!.find((r) => r.kind === "section_related")!;
    assert.equal(derived.evidence.reason, "same_section");
    assert.equal(derived.evidence.connection_id, connection.id);
    assert.equal(derived.evidence.module_id, module.id);
    assert.ok(!Object.hasOwn(derived.evidence, "rights"));
    assert.equal(pack.read_status[0].status, "available_not_confirmed_read");
    assert.equal(pack.aralearn.creation_authorized, false);
  } finally {
    await db.end();
  }
});

async function seedOwner(db: Db, owner: Owner) {
  await db`insert into auth.users(id) values(${owner.ownerId})`;
}

function arc(connectionId: string, locator: string, source: string): Record<string, string> {
  return {
    system: "moodle",
    connection_id: connectionId,
    locator,
    source,
    observed_at: OBSERVED_AT,
  };
}

function relate(
  db: Db,
  owner: Owner,
  fromId: string,
  toId: string,
  kind: string,
  evidence: Record<string, string>,
) {
  return asOwner(db, owner, async (tx) => {
    await tx`insert into public.hub_relations(owner_id,from_id,to_id,kind,evidence)
      values(${owner.ownerId},${fromId},${toId},${kind},${tx.json(evidence)})`;
  });
}

function graph(db: Db, owner: Owner, activityId: string, offset = 0) {
  return asOwner(db, owner, (tx) => studyGraphPage(tx, owner.ownerId, activityId, offset));
}

Deno.test("A24 grafo de secao: irmaos da mesma secao e material preservado viram section_related; fora da secao/conexao/dono ficam excluidos", async () => {
  const db = createDb(LOCAL_DB), hub = new Hub(db);
  const a = { ownerId: crypto.randomUUID() }, b = { ownerId: crypto.randomUUID() };
  try {
    await seedOwner(db, a);
    await seedOwner(db, b);
    const conn = await hub.connect(a, "moodle", "Moodle A", null, "moodle-a");
    const otherConn = await hub.connect(a, "moodle", "Moodle A2", null, "moodle-a2");
    const connB = await hub.connect(b, "moodle", "Moodle B", null, "moodle-b");

    const section = await hub.entity(
      a,
      conn.id,
      "section",
      "moodle:course/1/section/5",
      "Secao 5",
      {
        course_id: 1,
        section_id: 5,
      },
    );
    const otherSection = await hub.entity(
      a,
      conn.id,
      "section",
      "moodle:course/1/section/6",
      "Secao 6",
      { course_id: 1, section_id: 6 },
    );
    const module = await hub.entity(a, conn.id, "module", "moodle:course/1/module/50", "Tarefa", {
      course_id: 1,
      section_id: 5,
      module_id: 50,
    });
    const otherModule = await hub.entity(
      a,
      conn.id,
      "module",
      "moodle:course/1/module/60",
      "Outra tarefa",
      { course_id: 1, section_id: 6, module_id: 60 },
    );
    const assignment = await hub.entity(
      a,
      conn.id,
      "assignment",
      "moodle:course/1/assignment/9",
      "Tarefa 9",
      { course_id: 1, coursemodule: 50 },
    );
    const page = await hub.entity(a, conn.id, "page", "moodle:course/1/page/1", "Pagina irma");
    const book = await hub.entity(a, conn.id, "book", "moodle:course/1/book/2", "Livro irmao");
    const otherPage = await hub.entity(
      a,
      conn.id,
      "page",
      "moodle:course/1/page/3",
      "Pagina de outra secao",
    );
    const preserved = await hub.entity(a, conn.id, "resource", "file-1", "Arquivo preservado", {
      course_id: 1,
      module_id: 50,
      source_locator: "https://fixture.invalid/f1",
      source_coverage: "complete",
    });
    const wrongModule = await hub.entity(
      a,
      conn.id,
      "resource",
      "file-2",
      "Arquivo de outro modulo",
      {
        course_id: 1,
        module_id: 999,
      },
    );
    const stringIds = await hub.entity(a, conn.id, "resource", "file-3", "Arquivo com id textual", {
      course_id: "1",
      module_id: "50",
    });
    const foreignSection = await hub.entity(
      a,
      otherConn.id,
      "section",
      "moodle:course/1/section/5",
      "Secao 5 (outra conexao)",
    );
    const foreignModule = await hub.entity(
      a,
      otherConn.id,
      "module",
      "moodle:course/1/module/50",
      "Tarefa (outra conexao)",
    );
    const foreignPage = await hub.entity(
      a,
      otherConn.id,
      "page",
      "moodle:course/1/page/1",
      "Pagina de outra conexao",
    );
    const bSection = await hub.entity(
      b,
      connB.id,
      "section",
      "moodle:course/1/section/5",
      "Secao 5 do dono B",
    );
    const bModule = await hub.entity(
      b,
      connB.id,
      "module",
      "moodle:course/1/module/50",
      "Tarefa do dono B",
    );
    const bPage = await hub.entity(
      b,
      connB.id,
      "page",
      "moodle:course/1/page/1",
      "Pagina do dono B",
    );

    const sectionArc = arc(conn.id, "moodle:course/1/section/5", "structure");
    const pageArc = arc(conn.id, "moodle:course/1/page/1", "module_instance");
    const bookArc = arc(conn.id, "moodle:course/1/book/2", "module_instance");
    await relate(db, a, section.id, module.id, "has_module", sectionArc);
    await relate(
      db,
      a,
      otherSection.id,
      otherModule.id,
      "has_module",
      arc(conn.id, "moodle:course/1/section/6", "structure"),
    );
    await relate(
      db,
      a,
      module.id,
      assignment.id,
      "has_content",
      arc(conn.id, "moodle:course/1/assignment/9", "module_instance"),
    );
    await relate(db, a, module.id, page.id, "has_content", pageArc);
    await relate(db, a, module.id, book.id, "has_content", bookArc);
    await relate(
      db,
      a,
      otherModule.id,
      otherPage.id,
      "has_content",
      arc(conn.id, "moodle:course/1/page/3", "module_instance"),
    );
    await relate(
      db,
      a,
      foreignSection.id,
      foreignModule.id,
      "has_module",
      arc(otherConn.id, "moodle:course/1/section/5", "structure"),
    );
    await relate(
      db,
      a,
      foreignModule.id,
      foreignPage.id,
      "has_content",
      arc(otherConn.id, "moodle:course/1/page/1", "module_instance"),
    );
    await relate(db, b, bSection.id, bModule.id, "has_module", {});
    await relate(db, b, bModule.id, bPage.id, "has_content", {});

    const result = await graph(db, a, assignment.id);
    const ids = new Set(result.entities.map((entity) => entity.id));
    assert.equal(result.section_coverage.mode, "section");
    assert.equal(result.section_coverage.provider, "moodle");
    assert.equal(result.section_coverage.focal_kind, "assignment");
    assert.equal(result.section_coverage.section_id, section.id);
    assert.equal(result.section_coverage.section_external_id, "moodle:course/1/section/5");
    assert.equal(result.section_coverage.section_candidates, 1);
    assert.equal(result.section_coverage.modules_scanned, 1);
    assert.equal(result.section_coverage.ambiguous, false);
    assert.deepEqual(result.gaps, []);
    assert.equal(result.next_offset, null);
    assert.equal(ids.has(page.id), true);
    assert.equal(ids.has(book.id), true);
    assert.equal(ids.has(preserved.id), true);
    assert.equal(ids.has(assignment.id), false); // o proprio focal nao vira material
    assert.equal(ids.has(otherPage.id), false); // outra secao
    assert.equal(ids.has(wrongModule.id), false); // course_id igual, module_id diferente
    assert.equal(ids.has(stringIds.id), true); // mesmo ID decimal vindo como número ou texto
    assert.equal(ids.has(foreignPage.id), false); // outra conexao do mesmo dono
    assert.equal(ids.has(bPage.id), false); // outro dono

    const pageRelation = result.relations.find((relation) => relation.entity_id === page.id)!;
    assert.equal(pageRelation.kind, SECTION_RELATED_KIND);
    assert.equal(pageRelation.evidence.reason, "same_section");
    assert.equal(pageRelation.evidence.connection_id, conn.id);
    assert.equal(pageRelation.evidence.section_id, section.id);
    assert.equal(pageRelation.evidence.module_id, module.id);
    assert.equal(pageRelation.evidence.qualification, "module_has_content");
    assert.deepEqual(pageRelation.evidence.provenance, {
      section_has_module: sectionArc,
      module_has_content: pageArc,
    });
    assert.equal("rights" in pageRelation.evidence, false);

    const preservedRelation = result.relations.find((relation) =>
      relation.entity_id === preserved.id
    )!;
    assert.equal(preservedRelation.evidence.qualification, "preserved_material");
    assert.equal(preservedRelation.evidence.module_id, module.id);
    assert.equal(preservedRelation.evidence.reason, "same_section");
    const preservedProvenance = preservedRelation.evidence.provenance as Record<string, unknown>;
    assert.equal(preservedProvenance.module_has_content, null);
    assert.deepEqual(preservedProvenance.section_has_module, sectionArc);
    assert.equal("rights" in preservedRelation.evidence, false);
  } finally {
    await db.end();
  }
});

Deno.test("A24 grafo de secao: mais de uma secao candidata vira ambiguidade explicita e so vinculos diretos", async () => {
  const db = createDb(LOCAL_DB), hub = new Hub(db);
  const a = { ownerId: crypto.randomUUID() };
  try {
    await seedOwner(db, a);
    const conn = await hub.connect(a, "moodle", "Moodle ambiguo", null, "moodle-amb");
    const content = await hub.entity(
      a,
      conn.id,
      "page",
      "moodle:course/1/page/77",
      "Pagina compartilhada",
    );
    const direct = await hub.entity(
      a,
      conn.id,
      "resource",
      "moodle:course/1/resource/5",
      "Recurso direto",
    );
    for (const index of [5, 6, 7]) {
      const section = await hub.entity(
        a,
        conn.id,
        "section",
        `moodle:course/1/section/${index}`,
        `Secao ${index}`,
        { course_id: 1, section_id: index },
      );
      const mod = await hub.entity(
        a,
        conn.id,
        "module",
        `moodle:course/1/module/${index}0`,
        `Modulo ${index}`,
        { course_id: 1, section_id: index, module_id: index * 10 },
      );
      await relate(
        db,
        a,
        section.id,
        mod.id,
        "has_module",
        arc(conn.id, `s/${index}`, "structure"),
      );
      await relate(
        db,
        a,
        mod.id,
        content.id,
        "has_content",
        arc(conn.id, `m/${index}`, "module_instance"),
      );
    }
    await relate(db, a, content.id, direct.id, "required", { rights: "estudo" });

    const result = await graph(db, a, content.id);
    assert.equal(result.section_coverage.ambiguous, true);
    assert.equal(result.section_coverage.section_candidates, 2); // LIMIT 2: nao enumera nem elege
    assert.equal(result.section_coverage.mode, "direct");
    assert.equal(result.section_coverage.section_id, null);
    assert.equal(result.section_coverage.modules_scanned, 0);
    assert.deepEqual(result.gaps, [SECTION_AMBIGUITY_GAP]);
    assert.deepEqual(result.entities.map((entity) => entity.id), [direct.id]);
    assert.equal(
      result.relations.some((relation) => relation.kind === SECTION_RELATED_KIND),
      false,
    );
    assert.deepEqual(result.relations.map((relation) => relation.kind), ["required"]);
    assert.deepEqual(result.relations[0].evidence, { rights: "estudo" });
  } finally {
    await db.end();
  }
});

Deno.test("A24 grafo de secao: mais de vinte materiais continuam entre paginas e o required direto nao se perde", async () => {
  const db = createDb(LOCAL_DB), hub = new Hub(db);
  const a = { ownerId: crypto.randomUUID() };
  try {
    await seedOwner(db, a);
    const conn = await hub.connect(a, "moodle", "Moodle paginado", null, "moodle-page");
    const section = await hub.entity(
      a,
      conn.id,
      "section",
      "moodle:course/2/section/1",
      "Secao unica",
      { course_id: 2, section_id: 1 },
    );
    const module = await hub.entity(
      a,
      conn.id,
      "module",
      "moodle:course/2/module/10",
      "Modulo da secao",
      { course_id: 2, section_id: 1, module_id: 10 },
    );
    const assignment = await hub.entity(
      a,
      conn.id,
      "assignment",
      "moodle:course/2/assignment/1",
      "Tarefa da secao",
    );
    const required = await hub.entity(
      a,
      conn.id,
      "resource",
      "moodle:course/2/resource/1",
      "Obrigatorio direto",
    );
    await relate(db, a, section.id, module.id, "has_module", arc(conn.id, "s/1", "structure"));
    await relate(
      db,
      a,
      module.id,
      assignment.id,
      "has_content",
      arc(conn.id, "a/1", "module_instance"),
    );
    await relate(db, a, assignment.id, required.id, "required", { rights: "estudo" });
    const total = 34;
    for (let i = 1; i <= 33; i++) {
      const material = await hub.entity(
        a,
        conn.id,
        "page",
        `moodle:course/2/page/${i}`,
        `Material ${String(i).padStart(2, "0")}`,
      );
      await relate(
        db,
        a,
        module.id,
        material.id,
        "has_content",
        arc(conn.id, `p/${i}`, "module_instance"),
      );
    }

    const first = await graph(db, a, assignment.id, 0);
    assert.equal(first.entities.length, 21); // sentinela 20
    assert.equal(first.next_offset, 20);
    assert.equal(first.entities[20].title, "Material 21");
    // So a pagina tem evidencias: 20 secoes-relacionadas, nao as 33 descobertas.
    assert.equal(
      first.relations.filter((relation) => relation.kind === SECTION_RELATED_KIND).length,
      20,
    );
    assert.equal(first.relations.length, 20);
    assert.equal(first.section_coverage.derived_entities, 33); // cobertura agrega o total

    const second = await graph(db, a, assignment.id, 20);
    assert.equal(second.entities.length, 14);
    assert.equal(second.next_offset, null);
    assert.equal(
      second.relations.filter((relation) => relation.kind === SECTION_RELATED_KIND).length,
      13,
    );
    assert.equal(second.relations.length, 14);
    const seen = new Set(
      [...first.entities, ...second.entities].map((entity) => entity.id),
    );
    assert.equal(seen.size, total); // nada cortado nem duplicado entre paginas
    assert.equal(seen.has(required.id), true);

    const empty = await graph(db, a, assignment.id, 40);
    assert.deepEqual(empty.entities, []);
    assert.deepEqual(empty.relations, []);
    assert.equal(empty.next_offset, null);

    const requiredRelation = second.relations.find((relation) =>
      relation.entity_id === required.id
    )!;
    assert.equal(requiredRelation.kind, "required");
    assert.deepEqual(requiredRelation.evidence, { rights: "estudo" });
    assert.equal(
      second.relations
        .filter((relation) => relation.kind === SECTION_RELATED_KIND)
        .every((relation) => "rights" in relation.evidence === false),
      true,
    );
  } finally {
    await db.end();
  }
});

Deno.test("A24 grafo de secao: fonte nao Moodle mantem o comportamento direto", async () => {
  const db = createDb(LOCAL_DB), hub = new Hub(db);
  const a = { ownerId: crypto.randomUUID() };
  try {
    await seedOwner(db, a);
    const conn = await hub.connect(a, "migration", "Fonte migrada", null, "fixture-mig");
    const activity = await hub.entity(a, conn.id, "activity", "act-1", "Atividade migrada");
    const target = await hub.entity(a, conn.id, "resource", "res-1", "Material direto");
    const section = await hub.entity(a, conn.id, "section", "res:s1", "Secao migrada");
    const module = await hub.entity(a, conn.id, "module", "res:m1", "Modulo migrado");
    const sibling = await hub.entity(a, conn.id, "page", "res:p1", "Pagina da secao migrada");
    await relate(db, a, activity.id, target.id, "required", { rights: "estudo" });
    await relate(db, a, section.id, module.id, "has_module", { system: "migration" });
    await relate(db, a, module.id, sibling.id, "has_content", { system: "migration" });
    await relate(db, a, module.id, activity.id, "has_content", { system: "migration" });

    const result = await graph(db, a, activity.id);
    assert.equal(result.section_coverage.mode, "direct");
    assert.equal(result.section_coverage.provider, "migration");
    assert.equal(result.section_coverage.section_id, null);
    assert.deepEqual(result.entities.map((entity) => entity.id), [target.id]);
    assert.deepEqual(result.relations.map((relation) => relation.kind), ["required"]);
    assert.deepEqual(result.gaps, []);
    assert.equal(
      result.relations.some((relation) => relation.kind === SECTION_RELATED_KIND),
      false,
    );
  } finally {
    await db.end();
  }
});

Deno.test("A24 grafo de secao: secao focal usa a propria secao", async () => {
  const db = createDb(LOCAL_DB), hub = new Hub(db);
  const a = { ownerId: crypto.randomUUID() };
  try {
    await seedOwner(db, a);
    const conn = await hub.connect(a, "moodle", "Moodle secao focal", null, "moodle-sec");
    const section = await hub.entity(
      a,
      conn.id,
      "section",
      "moodle:course/3/section/2",
      "Secao focal",
      { course_id: 3, section_id: 2 },
    );
    const module = await hub.entity(
      a,
      conn.id,
      "module",
      "moodle:course/3/module/20",
      "Modulo da secao",
      { course_id: 3, section_id: 2, module_id: 20 },
    );
    const page = await hub.entity(a, conn.id, "page", "moodle:course/3/page/1", "Pagina da secao");
    await relate(db, a, section.id, module.id, "has_module", arc(conn.id, "s/2", "structure"));
    await relate(db, a, module.id, page.id, "has_content", arc(conn.id, "p/1", "module_instance"));

    const result = await graph(db, a, section.id);
    assert.equal(result.section_coverage.mode, "section");
    assert.equal(result.section_coverage.focal_kind, "section");
    assert.equal(result.section_coverage.section_id, section.id);
    assert.equal(result.section_coverage.section_candidates, 1);
    assert.equal(result.section_coverage.modules_scanned, 1);
    assert.deepEqual(result.gaps, []);
    assert.deepEqual(result.entities.map((entity) => entity.id), [page.id]);
    const relation = result.relations[0];
    assert.equal(relation.kind, SECTION_RELATED_KIND);
    assert.equal(relation.evidence.section_id, section.id);
    assert.equal(relation.evidence.module_id, module.id);
    assert.equal(relation.evidence.qualification, "module_has_content");
  } finally {
    await db.end();
  }
});

Deno.test("A24 grafo de secao: modulo sem secao preservada vira lacuna; curso nao", async () => {
  const db = createDb(LOCAL_DB), hub = new Hub(db);
  const a = { ownerId: crypto.randomUUID() };
  try {
    await seedOwner(db, a);
    const conn = await hub.connect(a, "moodle", "Moodle sem secao", null, "moodle-gap");
    const module = await hub.entity(
      a,
      conn.id,
      "module",
      "moodle:course/4/module/30",
      "Modulo isolado",
      { course_id: 4, section_id: null, module_id: 30 },
    );
    const content = await hub.entity(
      a,
      conn.id,
      "page",
      "moodle:course/4/page/1",
      "Pagina do modulo",
    );
    await relate(
      db,
      a,
      module.id,
      content.id,
      "has_content",
      arc(conn.id, "p/1", "module_instance"),
    );
    const course = await hub.entity(a, conn.id, "course", "moodle:course/4", "Curso 4");

    const moduleResult = await graph(db, a, module.id);
    assert.equal(moduleResult.section_coverage.mode, "direct");
    assert.equal(moduleResult.section_coverage.section_id, null);
    assert.deepEqual(moduleResult.gaps, [SECTION_MISSING_GAP]);
    assert.deepEqual(moduleResult.entities.map((entity) => entity.id), [content.id]);

    const contentResult = await graph(db, a, content.id);
    assert.equal(contentResult.section_coverage.mode, "direct");
    assert.equal(contentResult.section_coverage.section_candidates, 0);
    assert.deepEqual(contentResult.gaps, [SECTION_MISSING_GAP]);

    const courseResult = await graph(db, a, course.id);
    assert.equal(courseResult.section_coverage.mode, "direct");
    assert.deepEqual(courseResult.gaps, []);
    assert.deepEqual(courseResult.entities, []);
  } finally {
    await db.end();
  }
});

Deno.test("A24 grafo de secao: offset invalido e atividade de outro dono sao recusados", async () => {
  const db = createDb(LOCAL_DB), hub = new Hub(db);
  const a = { ownerId: crypto.randomUUID() }, b = { ownerId: crypto.randomUUID() };
  try {
    await seedOwner(db, a);
    await seedOwner(db, b);
    const conn = await hub.connect(a, "moodle", "Moodle recusa", null, "moodle-refuse");
    const activity = await hub.entity(a, conn.id, "module", "moodle:course/5/module/1", "Modulo");

    for (const offset of [-1, 1.5, Number.NaN]) {
      await assert.rejects(graph(db, a, activity.id, offset), /Página inválida/);
    }
    await assert.rejects(graph(db, a, crypto.randomUUID()), /não encontrada/);
    await assert.rejects(graph(db, b, activity.id), /não encontrada/);
  } finally {
    await db.end();
  }
});

Deno.test("A24 Moodle reorganizado: modulo conserva ID e historico, grafo usa somente secao atual", async () => {
  const db = createDb(LOCAL_DB), hub = new Hub(db);
  const owner = { ownerId: crypto.randomUUID() };
  try {
    await seedOwner(db, owner);
    const conn = await hub.connect(owner, "moodle", "Moodle móvel", null, "moodle-move");
    const before = await hub.entity(
      owner,
      conn.id,
      "section",
      "moodle:course/7/section/11",
      "Antes",
      {
        course_id: 7,
        section_id: 11,
      },
    );
    const after = await hub.entity(
      owner,
      conn.id,
      "section",
      "moodle:course/7/section/12",
      "Depois",
      {
        course_id: 7,
        section_id: 12,
      },
    );
    const module = await hub.entity(
      owner,
      conn.id,
      "module",
      "moodle:course/7/module/90",
      "Tarefa",
      {
        course_id: 7,
        section_id: 11,
        module_id: 90,
      },
    );
    const activity = await hub.entity(
      owner,
      conn.id,
      "assignment",
      "moodle:course/7/assignment/90",
      "Atividade",
    );
    const oldMaterial = await hub.entity(
      owner,
      conn.id,
      "page",
      "moodle:course/7/page/1",
      "Material antigo",
    );
    const newMaterial = await hub.entity(
      owner,
      conn.id,
      "page",
      "moodle:course/7/page/2",
      "Material novo",
    );
    const oldSibling = await hub.entity(
      owner,
      conn.id,
      "module",
      "moodle:course/7/module/91",
      "Irmão antigo",
      {
        course_id: 7,
        section_id: 11,
        module_id: 91,
      },
    );
    const newSibling = await hub.entity(
      owner,
      conn.id,
      "module",
      "moodle:course/7/module/92",
      "Irmão novo",
      {
        course_id: 7,
        section_id: 12,
        module_id: 92,
      },
    );
    await relate(db, owner, before.id, module.id, "has_module", arc(conn.id, "s/11", "structure"));
    await relate(
      db,
      owner,
      before.id,
      oldSibling.id,
      "has_module",
      arc(conn.id, "s/11", "structure"),
    );
    await relate(
      db,
      owner,
      after.id,
      newSibling.id,
      "has_module",
      arc(conn.id, "s/12", "structure"),
    );
    await relate(
      db,
      owner,
      module.id,
      activity.id,
      "has_content",
      arc(conn.id, "m/90", "module_instance"),
    );
    await relate(
      db,
      owner,
      oldSibling.id,
      oldMaterial.id,
      "has_content",
      arc(conn.id, "m/91", "module_instance"),
    );
    await relate(
      db,
      owner,
      newSibling.id,
      newMaterial.id,
      "has_content",
      arc(conn.id, "m/92", "module_instance"),
    );
    const initial = await graph(db, owner, activity.id);
    assert.equal(initial.section_coverage.section_id, before.id);
    assert.deepEqual(initial.entities.map((e) => e.id), [oldMaterial.id]);

    const moved = await hub.entity(
      owner,
      conn.id,
      "module",
      "moodle:course/7/module/90",
      "Tarefa",
      {
        course_id: 7,
        section_id: 12,
        module_id: 90,
      },
    );
    assert.equal(moved.id, module.id);
    await relate(db, owner, after.id, module.id, "has_module", arc(conn.id, "s/12", "structure"));
    const current = await graph(db, owner, activity.id);
    assert.equal(current.section_coverage.ambiguous, false);
    assert.equal(current.section_coverage.section_id, after.id);
    assert.deepEqual(current.entities.map((e) => e.id), [newMaterial.id]);
    const historical = await hub.entityContext(owner, module.id);
    assert.equal(historical.relations.filter((r) => r.kind === "has_module").length, 2);
  } finally {
    await db.end();
  }
});
