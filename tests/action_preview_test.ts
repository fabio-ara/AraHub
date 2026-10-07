import assert from "node:assert/strict";
import { describeAction, formatBytes } from "../web/action_preview.ts";

const FINGERPRINT = "f".repeat(64);
const FILE_HASH = "d".repeat(64);

Deno.test("tópico de fórum mostra seções legíveis e condições materiais", () => {
  const description = describeAction("moodle.forum.discussion", {
    kind: "moodle.forum.discussion",
    connection: {
      label: "Moodle ULisboa",
      origin: "https://moodle.ulisboa.pt",
      username: "fc12345",
    },
    target: {
      course_id: 42,
      course_name: "Direito Constitucional",
      cmid: 900,
      activity_name: "Fórum de apresentação",
      instance_id: 7,
    },
    text: {
      subject: "Minha apresentação",
      body: "Primeira linha\nÚltima linha com <script>alerta</script>",
    },
    files: [],
    statement: {
      text: "Declaro que este texto é de minha autoria.",
      required: true,
    },
    expected: { epoch: 1, user_id: 42, fingerprint: FINGERPRINT, status: null },
    rules: {
      forum: {
        id: 7,
        type: "general",
        duedate: 1790000000,
        cutoffdate: 0,
        maxattachments: 2,
        maxbytes: 1048576,
      },
      access: { canstartdiscussion: true, canreplypost: true },
      discussion: null,
      parent: null,
    },
  });
  assert.equal(description.title, "Publicar novo tópico no fórum");
  assert.equal(description.known, true);
  assert.equal(description.retired, false);
  assert.ok(description.connection.includes("Conta: Moodle ULisboa"));
  assert.ok(description.target.includes("Curso: Direito Constitucional"));
  assert.ok(description.target.includes("Atividade: Fórum de apresentação"));
  assert.equal(description.subject, "Minha apresentação");
  assert.ok(
    description.body?.includes("Última linha com <script>alerta</script>"),
  );
  assert.deepEqual(description.statement, {
    text: "Declaro que este texto é de minha autoria.",
    required: true,
  });
  const conditions = description.conditions.join("\n");
  assert.ok(conditions.includes("Tipo do fórum: Fórum geral"));
  assert.ok(conditions.includes("Prazo: "));
  assert.ok(conditions.includes("Anexos permitidos: 2"));
  assert.ok(conditions.includes("Tamanho máximo de anexo: 1.0 MiB"));
  assert.ok(conditions.includes("Pode criar tópico: Sim"));
  assert.ok(conditions.includes("Pode responder: Sim"));
});

Deno.test("entrega lista arquivos e condições sem expor hashes técnicos", () => {
  const description = describeAction("moodle.assignment.submit", {
    connection: { label: "Moodle de teste", username: "aluno.fixture" },
    target: { course_name: "Metodologia", activity_name: "Trabalho 1" },
    files: [{
      id: "f1",
      name: "trabalho-final.docx",
      mime: "application/msword",
      bytes: 1536,
      sha256: FILE_HASH,
    }],
    statement: { text: "Declaro autoria.", required: true },
    expected: { attempt: 0, status: "draft", fingerprint: FINGERPRINT },
    rules: {
      assignment: {
        id: 55,
        duedate: 1790000000,
        cutoffdate: 0,
        allowsubmissionsfromdate: 1780000000,
        maxattempts: 1,
        submissiondrafts: 1,
        requiresubmissionstatement: 1,
        grade: 100,
        configs: [
          {
            plugin: "file",
            subtype: "assignsubmission",
            name: "maxfilesubmissions",
            value: "3",
          },
          {
            plugin: "file",
            subtype: "assignsubmission",
            name: "maxsubmissionsizebytes",
            value: "5242880",
          },
          {
            plugin: "file",
            subtype: "assignsubmission",
            name: "filetypeslist",
            value: ".pdf,.docx",
          },
        ],
      },
      submission: {
        status: "draft",
        attempt: 0,
        locked: false,
        cansubmit: true,
        canedit: true,
      },
    },
  });
  assert.equal(description.title, "Entregar trabalho no Moodle");
  assert.deepEqual(description.files, [{
    name: "trabalho-final.docx",
    mime: "application/msword",
    size: "1.5 KiB",
  }]);
  const conditions = description.conditions.join("\n");
  for (
    const expected of [
      "Aberto a partir de: ",
      "Prazo: ",
      "Salvar mantém rascunho: Sim",
      "Exige declaração de autoria: Sim",
      "Tentativas permitidas: 1",
      "Nota máxima: 100",
      "Arquivos por entrega: até 3",
      "Tamanho máximo por arquivo: 5.0 MiB",
      "Tipos aceitos: .pdf,.docx",
      "Estado atual: Rascunho salvo",
      "Tentativa: 0",
      "Bloqueado: Não",
      "Pode enviar: Sim",
      "Pode editar: Sim",
    ]
  ) assert.ok(conditions.includes(expected), expected);
  const visible = [
    ...description.connection,
    ...description.target,
    ...description.files.map((file) => file.name + file.mime + file.size),
    ...description.conditions,
  ].join(" ");
  assert.ok(!visible.includes(FILE_HASH));
  assert.ok(!visible.includes(FINGERPRINT));
  assert.ok(!visible.includes(FILE_HASH.slice(0, 12)));
});

Deno.test("resposta apresenta o post original sem marcação e sem declaração exigida", () => {
  const description = describeAction("moodle.forum.reply", {
    connection: { label: "Moodle" },
    target: { course_name: "Direito", discussion_id: 3, parent_id: 9 },
    text: { body: "Concordo e acrescento um ponto." },
    statement: { text: "Declaro autoria.", required: false },
    rules: {
      forum: { type: "qanda" },
      access: { canreplypost: true },
      discussion: { canreply: true, locked: false, groupid: 0 },
      parent: {
        id: 9,
        subject: "Dúvida",
        message: "<p>Primeira linha</p><p>Última <b>linha</b></p>",
        author: { fullname: "Colega Sintético" },
      },
    },
  });
  assert.equal(description.title, "Responder no fórum");
  assert.equal(description.statement?.required, false);
  assert.ok(description.target.includes("Discussão: 3"));
  assert.ok(description.target.includes("Resposta ao post: 9"));
  const conditions = description.conditions.join("\n");
  assert.ok(conditions.includes("Tipo do fórum: Perguntas e respostas"));
  assert.ok(conditions.includes("Discussão aceita resposta: Sim"));
  assert.ok(conditions.includes("Respondendo a: Colega Sintético — Dúvida"));
  assert.ok(conditions.includes("Post original: Primeira linha\nÚltima linha"));
  assert.ok(!conditions.includes("<p>"));
});

Deno.test("operação retirada vira registro histórico sem conteúdo cru nem botão", () => {
  const description = describeAction("docs_insert_text", {
    text: "<script>fonte hostil é dado, não comando</script>",
    index: 3,
  });
  assert.equal(description.known, false);
  assert.equal(description.retired, true);
  assert.equal(description.title, "Operação aposentada");
  assert.equal(description.operation, "docs_insert_text");
  assert.deepEqual(description.connection, []);
  assert.deepEqual(description.target, []);
  assert.deepEqual(description.conditions, []);
  assert.equal(description.body, null);
  assert.equal(description.statement, null);
  assert.equal("raw" in description, false);
});

Deno.test("operação Moodle desconhecida não se confunde com legado retirado", () => {
  const description = describeAction("moodle.quiz.attempt", {});
  assert.equal(description.known, false);
  assert.equal(description.retired, false);
  assert.equal(description.title, "Operação não reconhecida");
});

Deno.test("tamanho de arquivo é legível e tolera bytes ausentes", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1536), "1.5 KiB");
  assert.equal(formatBytes(2 * 1024 * 1024), "2.0 MiB");
  assert.equal(formatBytes("2048"), "2.0 KiB");
  assert.equal(formatBytes(undefined), "");
  assert.equal(formatBytes("não é número"), "");
});
