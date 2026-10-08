/**
 * Descrição legível de uma ação acadêmica preparada, para revisão humana.
 *
 * Toda a matéria relevante da fonte aparece em português legível: conta, destino,
 * texto, arquivos, declaração e as condições que afetam a decisão. Hashes e
 * detalhes técnicos não entram no fluxo. Operação não reconhecida não é aprovada:
 * ganha apresentação informativa sem controles de execução.
 */

export interface ActionFileView {
  name: string;
  mime: string;
  size: string;
}

export interface ActionStatementView {
  text: string;
  required: boolean;
}

export interface ActionDescription {
  title: string;
  /** true quando a operação acadêmica é reconhecida e vira seções legíveis. */
  known: boolean;
  /** true quando a operação foi retirada (por exemplo, escrita Google própria). */
  retired: boolean;
  /** Identificador da operação, mantido para o registro histórico. */
  operation: string;
  connection: string[];
  target: string[];
  subject: string | null;
  body: string | null;
  files: ActionFileView[];
  statement: ActionStatementView | null;
  /** Condições materiais da fonte que afetam a decisão (prazos, limites, estado). */
  conditions: string[];
}

/** UI availability only; the server still revalidates every approval and execution. */
export function actionReview(view: {
  state: string;
  action: { content: unknown };
  approval?: { expiresAt: string | null; consumedAt: string | null } | null;
}, now = Date.now()) {
  const expires = asRecord(view.action.content).expires_at;
  const preparedUntil = typeof expires === "string" ? Date.parse(expires) : NaN;
  const approvedUntil = Date.parse(view.approval?.expiresAt ?? "");
  const expired = view.state === "approved" && Number.isFinite(approvedUntil) &&
    approvedUntil <= now && !view.approval?.consumedAt;
  const stale = Number.isFinite(preparedUntil) && preparedUntil <= now;
  const renewable = !stale && !view.approval?.consumedAt &&
    (view.state === "prepared" || expired);
  const nextChange = [preparedUntil, approvedUntil].filter((at) => at > now);
  return { expired, stale, renewable, nextChange: Math.min(...nextChange) };
}

const OPERATION_TITLES: Record<string, string> = {
  "moodle.forum.discussion": "Publicar novo tópico no fórum",
  "moodle.forum.reply": "Responder no fórum",
  "moodle.assignment.submit": "Entregar trabalho no Moodle",
};

const FORUM_TYPES: Record<string, string> = {
  "1": "Discussão única",
  "2": "Um tópico por pessoa",
  "3": "Perguntas e respostas",
  "4": "Formato de blog",
  "5": "Fórum geral",
  single: "Discussão única",
  eachuser: "Um tópico por pessoa",
  qanda: "Perguntas e respostas",
  blog: "Formato de blog",
  general: "Fórum geral",
};

const SUBMISSION_STATUS: Record<string, string> = {
  new: "Nenhum envio iniciado",
  draft: "Rascunho salvo",
  submitted: "Enviado para avaliação",
  reopened: "Reaberto para edição",
};

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asText(value: unknown): string | null {
  if (typeof value === "string") return value.trim() ? value : null;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return null;
}

function pickText(
  source: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const value = asText(source[key]);
    if (value !== null) return value;
  }
  return null;
}

function asNumber(value: unknown): number | null {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
    ? Number(value)
    : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function asFlag(value: unknown): boolean | null {
  if (value === true || value === 1 || value === "1") return true;
  if (value === false || value === 0 || value === "0") return false;
  return null;
}

function labeled(label: string, value: string | null): string | null {
  return value === null ? null : `${label}: ${value}`;
}

function present(...values: (string | null)[]): string[] {
  return values.filter((value): value is string => value !== null);
}

/** Tamanho em unidade legível; vazio quando a fonte não informou bytes. */
export function formatBytes(value: unknown): string {
  const bytes = asNumber(value);
  if (bytes === null || bytes < 0) return "";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/** Instante em segundos Unix da fonte, em data e hora locais legíveis. */
function asInstant(value: unknown): string | null {
  const seconds = asNumber(value);
  if (seconds === null || seconds <= 0) return null;
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(seconds * 1000));
}

/** Texto da fonte sem marcação, preservando quebras de linha. */
function plainText(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function fileViews(value: unknown): ActionFileView[] {
  if (!Array.isArray(value)) return [];
  const files: ActionFileView[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const file = entry as Record<string, unknown>;
    files.push({
      name: asText(file.name) ?? asText(file.file_name) ?? "Arquivo sem nome",
      mime: asText(file.mime) ?? asText(file.mime_type) ?? "tipo desconhecido",
      size: formatBytes(file.bytes ?? file.size),
    });
  }
  return files;
}

function readStatement(value: unknown): ActionStatementView | null {
  const candidate = asRecord(value);
  const text = asText(candidate.text);
  return text === null ? null : { text, required: candidate.required === true };
}

function pushInstant(lines: string[], label: string, value: unknown) {
  const formatted = asInstant(value);
  if (formatted) lines.push(`${label}: ${formatted}`);
}

function pushFlag(lines: string[], label: string, value: unknown) {
  const flag = asFlag(value);
  if (flag !== null) lines.push(`${label}: ${flag ? "Sim" : "Não"}`);
}

function pushCount(lines: string[], label: string, value: unknown) {
  const count = asNumber(value);
  if (count !== null) lines.push(`${label}: ${count}`);
}

/** Limites do plugin de envio de arquivos, quando a fonte os declarou. */
function fileLimitLines(lines: string[], configs: unknown) {
  if (!Array.isArray(configs)) return;
  const fileConfig: Record<string, string> = {};
  for (const entry of configs) {
    const config = asRecord(entry);
    if (config.plugin === "file" && config.subtype === "assignsubmission") {
      fileConfig[String(config.name)] = String(config.value);
    }
  }
  if (fileConfig.maxfilesubmissions !== undefined) {
    lines.push(`Arquivos por entrega: até ${fileConfig.maxfilesubmissions}`);
  }
  const maxBytes = asNumber(fileConfig.maxsubmissionsizebytes);
  if (maxBytes !== null && maxBytes > 0) {
    lines.push(`Tamanho máximo por arquivo: ${formatBytes(maxBytes)}`);
  }
  const types = (fileConfig.filetypeslist ?? "").trim();
  if (types) lines.push(`Tipos aceitos: ${types}`);
}

function assignmentConditions(
  expected: Record<string, unknown>,
  rules: Record<string, unknown>,
): string[] {
  const lines: string[] = [];
  const assignment = asRecord(rules.assignment);
  const submission = asRecord(rules.submission);
  pushInstant(lines, "Aberto a partir de", assignment.allowsubmissionsfromdate);
  pushInstant(lines, "Prazo", assignment.duedate);
  pushInstant(lines, "Prazo de corte", assignment.cutoffdate);
  pushInstant(lines, "Prorrogação", submission.extensionduedate);
  pushFlag(lines, "Salvar mantém rascunho", assignment.submissiondrafts);
  pushFlag(
    lines,
    "Exige declaração de autoria",
    assignment.requiresubmissionstatement,
  );
  const attempts = asNumber(assignment.maxattempts);
  if (attempts !== null) {
    lines.push(`Tentativas permitidas: ${attempts === 0 ? "ilimitadas" : attempts}`);
  }
  const grade = asNumber(assignment.grade);
  if (grade !== null && grade > 0) lines.push(`Nota máxima: ${grade}`);
  fileLimitLines(lines, assignment.configs);
  const status = pickText(submission, ["status"]) ?? pickText(expected, ["status"]);
  if (status) lines.push(`Estado atual: ${SUBMISSION_STATUS[status] ?? status}`);
  const attempt = asNumber(submission.attempt) ?? asNumber(expected.attempt);
  if (attempt !== null) lines.push(`Tentativa: ${attempt}`);
  pushFlag(lines, "Bloqueado", submission.locked);
  pushFlag(lines, "Pode finalizar no estado atual", submission.cansubmit);
  pushFlag(lines, "Pode editar", submission.canedit);
  return lines;
}

function forumConditions(
  operation: string,
  expected: Record<string, unknown>,
  rules: Record<string, unknown>,
): string[] {
  const lines: string[] = [];
  const forum = asRecord(rules.forum);
  const access = asRecord(rules.access);
  const discussion = asRecord(rules.discussion);
  const parent = asRecord(rules.parent);
  const type = pickText(forum, ["type"]);
  if (type) lines.push(`Tipo do fórum: ${FORUM_TYPES[type.toLowerCase()] ?? type}`);
  pushInstant(lines, "Prazo", forum.duedate);
  pushInstant(lines, "Prazo de corte", forum.cutoffdate);
  pushCount(lines, "Anexos permitidos", forum.maxattachments);
  const maxBytes = asNumber(forum.maxbytes);
  if (maxBytes !== null && maxBytes > 0) {
    lines.push(`Tamanho máximo de anexo: ${formatBytes(maxBytes)}`);
  }
  pushFlag(lines, "Pode criar tópico", access.canstartdiscussion);
  pushFlag(lines, "Pode responder", access.canreplypost);
  pushFlag(lines, "Discussão trancada", discussion.locked);
  pushFlag(lines, "Discussão aceita resposta", discussion.canreply);
  const groupId = asNumber(discussion.groupid);
  if (groupId !== null && groupId > 0) lines.push(`Grupo: ${groupId}`);
  if (operation === "moodle.forum.reply" && Object.keys(parent).length) {
    const author = asRecord(parent.author);
    const name = pickText(author, ["fullname", "name"]);
    const subject = pickText(parent, ["subject"]);
    lines.push(
      `Respondendo a: ${present(name, subject).join(" — ") || "post da discussão"}`,
    );
    const message = pickText(parent, ["message"]);
    if (message) lines.push(`Post original: ${plainText(message)}`);
  }
  const status = pickText(expected, ["status"]);
  if (status) lines.push(`Estado atual: ${status}`);
  return lines;
}

function materialConditions(
  operation: string,
  expected: Record<string, unknown>,
  rules: Record<string, unknown>,
): string[] {
  return operation === "moodle.assignment.submit"
    ? assignmentConditions(expected, rules)
    : forumConditions(operation, expected, rules);
}

/** Traduz a operação e o conteúdo preparado em seções legíveis para a revisão. */
export function describeAction(
  operation: string,
  content: unknown,
): ActionDescription {
  const root = asRecord(content);
  const known = Object.hasOwn(OPERATION_TITLES, operation);
  const retired = !known && !operation.startsWith("moodle.");
  const connectionSource = asRecord(root.connection);
  const targetSource = asRecord(root.target);
  const textSource = asRecord(root.text);
  const courseId = pickText(targetSource, ["course_id", "courseId"]);
  const cmid = pickText(targetSource, ["cmid", "cm_id"]);
  return {
    title: known
      ? OPERATION_TITLES[operation]
      : retired
      ? "Operação aposentada"
      : "Operação não reconhecida",
    known,
    retired,
    operation,
    connection: known
      ? present(
        labeled("Conta", pickText(connectionSource, ["label", "name"])),
        labeled("Usuário", pickText(connectionSource, ["username", "user"])),
        labeled("Origem", pickText(connectionSource, ["origin", "host"])),
      )
      : [],
    target: known
      ? present(
        labeled(
          "Curso",
          pickText(targetSource, ["course_name", "course"]) ??
            (courseId ? `#${courseId}` : null),
        ),
        labeled(
          "Atividade",
          pickText(targetSource, ["activity_name", "activity"]) ??
            (cmid ? `cmid ${cmid}` : null),
        ),
        labeled("Discussão", pickText(targetSource, ["discussion_id"])),
        labeled("Resposta ao post", pickText(targetSource, ["parent_id"])),
      )
      : [],
    subject: known ? pickText(textSource, ["subject", "title"]) : null,
    body: known ? pickText(textSource, ["body", "html", "text"]) : null,
    files: known ? fileViews(root.files) : [],
    statement: known ? readStatement(root.statement) : null,
    conditions: known
      ? materialConditions(operation, asRecord(root.expected), asRecord(root.rules))
      : [],
  };
}
