import { createClient } from "@supabase/supabase-js";
import { apiEndpoint, sitePath } from "./endpoint.ts";
import { renderUiIcon } from "./icons.ts";
import { describeAction } from "./action_preview.ts";
import { extractClientPdf, PDF_CLIENT_MAX_BYTES } from "./pdf_client.ts";
import { moodleMobileLaunchUrl, parseMoodleMobileLink } from "./moodle_mobile.ts";
const siteBase = new URL("../", import.meta.url).href;
const route = (path: string) => sitePath(siteBase, path);
const localCredentialEntry = ["localhost", "127.0.0.1", "[::1]"].includes(
  location.hostname,
);
const moodleCredentialEntry = localCredentialEntry ||
  location.protocol === "https:";
if (window.top !== window.self) {
  document.documentElement.hidden = true;
  throw new Error(
    "Abra o AraHub em sua própria janela para autorizar alterações.",
  );
}
const endpoint = (path: string) =>
  apiEndpoint(
    document.querySelector<HTMLMetaElement>('meta[name="arahub-api-base"]')
      ?.content ?? "",
    path,
  );
const el = (id: string) => document.getElementById(id)!;
function setAction(button: HTMLElement, icon: string, label: string) {
  button.setAttribute("aria-label", label);
  button.setAttribute("title", label);
  button.classList.add("icon-ghost");
  button.innerHTML = renderUiIcon(icon); // fixed icon names/markup only, never source content
}
function setTab(button: HTMLElement, icon: string, label: string) {
  button.setAttribute("aria-label", label);
  button.setAttribute("title", label);
  button.innerHTML = renderUiIcon(icon); // fixed icon names/markup only, never source content
  const text = document.createElement("span");
  text.textContent = label;
  button.append(text);
}
function labeledButton(label: string, variant: string) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = variant;
  button.textContent = label;
  return button;
}
for (
  const [id, icon, label] of [
    ["logout", "sign-out", "Sair"],
    ["signin", "sign-in", "Entrar"],
    ["synthetic-login", "experiment", "Explorar ambiente sintético local"],
    ["refresh", "rotate", "Atualizar visão"],
    ["export", "download", "Preparar exportação privada"],
    ["moodle-submit", "key", "Conectar Moodle"],
    ["moodle-mobile-open", "sign-in", "Abrir entrada oficial do Moodle"],
    ["moodle-cancel-renewal", "remove-state", "Cancelar renovação"],
    ["approve", "ready-state", "Permitir"],
    ["deny", "remove-state", "Recusar"],
    ["pdf-more", "book-open", "Mais PDFs"],
    ["privacy", "info", "Privacidade"],
  ]
) setAction(el(id), icon, label);
setTab(el("connections-tab"), "account", "Conexões");
setTab(el("preferences-tab"), "tags", "Preferências");
const mediaTheme = matchMedia("(prefers-color-scheme: dark)");
let themePreference = "system";
try {
  const savedTheme = localStorage.getItem("arahub.ui.theme");
  if (savedTheme && ["system", "light", "dark"].includes(savedTheme)) {
    themePreference = savedTheme;
  }
} catch { /* A blocked storage must not prevent configuration. */ }
function applyTheme() {
  const dark = themePreference === "dark" ||
    themePreference === "system" && mediaTheme.matches;
  document.documentElement.dataset.colorMode = dark ? "dark" : "light";
  document.querySelector('meta[name="theme-color"]')?.setAttribute(
    "content",
    dark ? "#111418" : "#f7f8fa",
  );
  setAction(
    el("theme"),
    `theme-${themePreference}`,
    `Mudar tema: ${
      themePreference === "system" ? "sistema" : themePreference === "dark" ? "escuro" : "claro"
    }`,
  );
}
applyTheme();
mediaTheme.addEventListener("change", applyTheme);
el("theme").addEventListener("click", () => {
  themePreference = themePreference === "system"
    ? "light"
    : themePreference === "light"
    ? "dark"
    : "system";
  try {
    localStorage.setItem("arahub.ui.theme", themePreference);
  } catch { /* Session-only theme. */ }
  applyTheme();
});
const msg = (s: string) => {
  el("message").textContent = s;
};
const cfg = await fetch(endpoint("/api/config")).then((r) => {
  if (!r.ok) throw new Error("Configuração de acesso indisponível.");
  return r.json();
}).catch(() => ({ unavailable: true }));
const supabase = cfg.supabaseUrl && cfg.publishableKey
  ? createClient(cfg.supabaseUrl, cfg.publishableKey, {
    auth: { flowType: "pkce", detectSessionInUrl: true, persistSession: true },
  })
  : null;
let token: string | null = cfg.synthetic ? sessionStorage.getItem("arahub-synthetic-token") : null;
let renewingMoodle: string | null = null;
let moodleSubmitting = false;
let pdfCursor: string | null = null;
let pdfLoading = false;
let pdfJob: AbortController | null = null;
function resetMoodleForm() {
  renewingMoodle = null;
  (el("moodle-connect-form") as HTMLFormElement).reset();
  (el("moodle-origin") as HTMLInputElement).readOnly = true;
  el("moodle-cancel-renewal").hidden = true;
  setAction(el("moodle-submit"), "key", "Conectar Moodle");
}
el("synthetic-login").hidden = !cfg.synthetic;
el("moodle-connect-form").hidden = !cfg.canConnectMoodle ||
  !moodleCredentialEntry;
el("moodle-protected-note").hidden = moodleCredentialEntry ||
  !cfg.canConnectMoodle;
el("pdf-setup").hidden = !cfg.canExtractPdf;
if (!supabase) {
  el("login-form").hidden = true;
  el("setup-note").hidden = false;
  if (cfg.unavailable) {
    el("setup-note").textContent = "Acesso indisponível no momento. Tente novamente mais tarde.";
  }
}
if (!localCredentialEntry) {
  el("password-label").hidden = true;
  (el("password") as HTMLInputElement).required = false;
  setAction(el("signin"), "mail", "Receber link de acesso");
} else el("password-label").hidden = false;
const api = async (path: string) => {
  const r = await fetch(endpoint(path), {
    headers: { Authorization: `Bearer ${token}` },
  });
  const result = await r.json();
  if (!r.ok) throw new Error(result.message ?? "Não foi possível atualizar.");
  return result;
};
async function apiPreferences() {
  const response = await fetch(
    endpoint("/api/preferences") + "?scope=" + encodeURIComponent("{}"),
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const result = await response.json();
  if (!response.ok) {
    throw new Error(result.message ?? "Preferências indisponíveis.");
  }
  return result;
}
async function post(path: string, payload: unknown) {
  const response = await fetch(endpoint(path), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const result = await response.json();
  if (!response.ok) {
    throw new Error(result.message ?? "Não foi possível concluir.");
  }
  return result;
}
async function loadPdfs(append = false) {
  if (!token || pdfLoading || !cfg.canExtractPdf) return;
  pdfLoading = true;
  const sessionToken = token;
  try {
    const page = await post(
      "/api/pdf/list",
      append && pdfCursor ? { after: pdfCursor } : {},
    );
    if (token !== sessionToken) return;
    const list = el("pdf-list");
    if (!append) list.replaceChildren();
    pdfCursor = page.next_id;
    el("pdf-more").hidden = !pdfCursor;
    for (const file of page.files) {
      const entry = card(
        file.name,
        file.coverage === "complete" ? "Texto preservado" : "Texto incompleto",
      );
      const actions = document.createElement("div");
      actions.className = "actions";
      const extract = document.createElement("button");
      setAction(extract, "book-text", "Extrair texto");
      extract.disabled = file.coverage === "complete";
      const cancel = document.createElement("button");
      setAction(cancel, "remove-state", "Cancelar extração");
      cancel.hidden = true;
      cancel.addEventListener("click", () => pdfJob?.abort());
      extract.addEventListener("click", async () => {
        if (pdfJob) return;
        const job = new AbortController();
        pdfJob = job;
        extract.disabled = true;
        cancel.hidden = false;
        msg("Extraindo texto neste dispositivo…");
        try {
          const response = await fetch(endpoint("/api/pdf/bytes"), {
            method: "POST",
            signal: job.signal,
            headers: {
              Authorization: `Bearer ${sessionToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ file_id: file.id, sha256: file.sha256 }),
          });
          if (!response.ok) {
            throw new Error("O arquivo está indisponível. Atualize a lista.");
          }
          if (
            response.headers.get("Content-Type")?.split(";")[0] !==
              "application/pdf"
          ) {
            throw new Error("O arquivo não é um PDF.");
          }
          // Streaming limit applies even when Content-Length is absent or incorrect.
          const reader = response.body!.getReader();
          const chunks: Uint8Array[] = [];
          let size = 0;
          try {
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              size += value.length;
              if (size > PDF_CLIENT_MAX_BYTES) {
                throw new Error("PDF acima do limite.");
              }
              chunks.push(value);
            }
          } finally {
            await reader.cancel();
          }
          const bytes = new Uint8Array(size);
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.length;
          }
          const extraction = await extractClientPdf(
            bytes,
            file.sha256,
            500,
            job.signal,
            file.next_page ?? 1,
          );
          if (job.signal.aborted || token !== sessionToken) {
            throw new Error("Extração cancelada.");
          }
          const result = await post("/api/pdf/commit", {
            file_id: file.id,
            sha256: file.sha256,
            extraction,
          });
          msg(
            result.memory.complete
              ? "Texto preservado por página, sem OCR."
              : result.memory.pages > 0
              ? "Texto parcial preservado; algumas páginas não puderam ser extraídas."
              : "Nenhuma página pôde ser extraída. O PDF preservado continua disponível.",
          );
          if (result.memory.complete) extract.disabled = true;
          else extract.disabled = false;
          entry.querySelector("p")!.textContent = result.memory.complete
            ? "Texto preservado"
            : "Texto incompleto";
          // A complete item needs no cursor refresh; keep later list pages visible.
          if (!result.memory.complete) await loadPdfs();
        } catch (e) {
          extract.disabled = false;
          msg(
            e instanceof Error ? e.message : "Não foi possível extrair o PDF.",
          );
        } finally {
          cancel.hidden = true;
          if (pdfJob === job) pdfJob = null;
        }
      });
      actions.append(extract, cancel);
      entry.append(actions);
      list.append(entry);
    }
    if (!list.childElementCount) list.textContent = "Nenhum PDF preservado.";
  } catch (e) {
    msg(e instanceof Error ? e.message : "PDFs indisponíveis.");
  } finally {
    pdfLoading = false;
  }
}
el("pdf-setup").addEventListener("toggle", () => {
  if ((el("pdf-setup") as HTMLDetailsElement).open) void loadPdfs();
});
el("pdf-more").addEventListener("click", () => void loadPdfs(true));
function card(title: string, detail: string) {
  const card = document.createElement("article");
  card.className = "panel";
  const h = document.createElement("h3");
  h.textContent = title;
  const p = document.createElement("p");
  p.textContent = detail;
  card.append(h, p);
  return card;
}
const connectionState: Record<string, string> = {
  connected: "Conectada",
  pending: "Aguardando autorização",
  revoked: "Desconectada",
  expired: "Acesso expirado",
  denied: "Acesso recusado",
  error: "Atualização indisponível",
};

interface PreferenceEntry {
  id: string;
  content?: unknown;
  scope?: Record<string, string>;
  preference?: {
    key?: string;
    state?: string;
    valid_from?: string;
    valid_until?: string;
  } | null;
  status?: string;
}

interface PreferencesView {
  at?: string;
  applicable?: PreferenceEntry[];
  history?: PreferenceEntry[];
  contextual_overrides?: string[];
  conflicts?: { key: string; ids: string[] }[];
  review_required?: PreferenceEntry[];
  coverage?: string;
}

const preferenceStatusLabels: Record<string, string> = {
  current: "vigente",
  future: "ainda não vigente",
  superseded: "substituída",
  withdrawal: "retirada",
  expired: "expirada",
  requires_review: "requer revisão",
  legacy_requires_review: "registro antigo sem chave, requer revisão",
};

function readableInstant(value: string) {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed)
    ? value
    : new Intl.DateTimeFormat("pt-BR", { dateStyle: "short" }).format(parsed);
}

function preferenceScope(scope: Record<string, string> | undefined) {
  const entries = Object.entries(scope ?? {}).filter(([, value]) =>
    typeof value === "string" && value
  );
  return entries.length
    ? "Escopo: " + entries.map(([key, value]) => `${key}=${value}`).join(", ") +
      "."
    : "Escopo: global.";
}

function preferenceValidity(preference: PreferenceEntry["preference"]) {
  if (!preference) return "";
  if (preference.state === "withdrawn") return "Retirada permanentemente.";
  const until = preference.valid_until
    ? `Vigente até ${readableInstant(preference.valid_until)}.`
    : "Vigente.";
  const from = preference.valid_from
    ? ` Válida desde ${readableInstant(preference.valid_from)}.`
    : "";
  return until + from;
}

function preferenceDetail(entry: PreferenceEntry) {
  const parts: string[] = [];
  if (typeof entry.content === "string" && entry.content.trim()) {
    parts.push(entry.content.trim());
  }
  parts.push(preferenceScope(entry.scope));
  const validity = preferenceValidity(entry.preference);
  if (validity) parts.push(validity);
  const status = entry.status ? preferenceStatusLabels[entry.status] : undefined;
  if (status) parts.push(`Situação: ${status}.`);
  return parts.join(" ");
}

function preferenceCard(entry: PreferenceEntry) {
  const key = entry.preference?.key;
  return card(
    typeof key === "string" && key.trim() ? key.trim() : "Registro sem chave",
    preferenceDetail(entry),
  );
}

/** Preferências por escopo: vigentes, conflitos e o que exige revisão humana. */
function renderPreferences(view: PreferencesView | null) {
  const list = el("preference-list");
  const summary = el("preference-summary");
  list.replaceChildren();
  if (!view) {
    summary.textContent = "Preferências indisponíveis no momento.";
    return;
  }
  const applicable = view.applicable ?? [];
  const conflicts = view.conflicts ?? [];
  const history = view.history ?? [];
  const conflicted = new Set(conflicts.flatMap((conflict) => conflict.ids));
  const review = (view.review_required ?? []).filter((entry) =>
    !conflicted.has(entry.id)
  );
  const overridden = view.contextual_overrides?.length ?? 0;
  summary.textContent =
    (view.coverage === "partial"
      ? "Cobertura parcial: parte do histórico não foi lida. "
      : "") +
    `${applicable.length} vigente(s), ${conflicts.length} conflito(s), ` +
    `${review.length} para revisar` +
    (overridden ? `, ${overridden} sobreposto(s) por escopo mais específico` : "") +
    ".";
  if (!applicable.length && !conflicts.length && !review.length) {
    summary.textContent += " Nenhuma preferência registrada.";
  }
  if (applicable.length) {
    list.append(fieldLabel("Vigentes"));
    for (const entry of applicable) list.append(preferenceCard(entry));
  }
  if (conflicts.length) {
    list.append(fieldLabel("Conflitos"));
    for (const conflict of conflicts) {
      const ids = new Set(conflict.ids);
      const entries = history.filter((entry) => ids.has(entry.id));
      const conflictCard = card(`Conflito: ${conflict.key}`, "");
      const items = document.createElement("ul");
      items.className = "file-list";
      if (entries.length) {
        for (const entry of entries) {
          const item = document.createElement("li");
          item.textContent = preferenceDetail(entry);
          items.append(item);
        }
      } else {
        const item = document.createElement("li");
        item.textContent = "Registros conflitantes não recuperados na página.";
        items.append(item);
      }
      conflictCard.append(items);
      list.append(conflictCard);
    }
  }
  if (review.length) {
    list.append(fieldLabel("Requer revisão"));
    for (const entry of review) list.append(preferenceCard(entry));
  }
}

/** Saúde do acesso: estado observado de cada conexão, sem prometer frescor da fonte. */
function renderConnectionHealth(connections: { state: string }[]) {
  const target = el("connection-health");
  if (!connections.length) {
    target.textContent =
      "Nenhuma conexão registrada. Conecte o Moodle para começar.";
    return;
  }
  const counts = new Map<string, number>();
  for (const connection of connections) {
    const label = connectionState[connection.state] ?? "Verificar acesso";
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  target.textContent = "Acesso: " +
    [...counts].map(([label, count]) => `${count} ${label}`).join(" · ") + ".";
}

async function render() {
  if (!token) return;
  const sessionToken = token;
  try {
    const [c, preferences] = await Promise.all([
      api("/api/context"),
      apiPreferences().catch(() => null),
    ]);
    if (token !== sessionToken) return;
    el("login").hidden = true;
    el("workspace").hidden = false;
    el("logout").hidden = false;
    el("mode-label").textContent = cfg.synthetic
      ? "Ambiente sintético local. Esta visão não comprova conexão real ou implantação."
      : "";
    renderPreferences(preferences);
    renderConnectionHealth(c.connections);
    const connections = el("connection-list");
    connections.replaceChildren();
    for (const cn of c.connections) {
      const entry = card(
        cn.label,
        `${
          cn.provider === "moodle"
            ? "Moodle"
            : cn.provider === "google"
            ? "Google"
            : "Memória importada"
        } · ${connectionState[cn.state] ?? "Verificar acesso"}`,
      );
      if (!cfg.synthetic && cn.provider !== "migration") {
        const disconnect = document.createElement("button");
        disconnect.className = "quiet";
        setAction(disconnect, "offline", "Desconectar");
        disconnect.addEventListener("click", async () => {
          disconnect.disabled = true;
          try {
            await post("/api/connections/disconnect", { connection_id: cn.id });
            await render();
            msg(
              "Conexão desativada. A memória preservada continua disponível.",
            );
          } catch (e) {
            disconnect.disabled = false;
            msg(
              e instanceof Error ? e.message : "Não foi possível desconectar.",
            );
          }
        });
        entry.append(disconnect);
        if (
          cn.provider === "moodle" && cfg.canConnectMoodle &&
          moodleCredentialEntry
        ) {
          const renew = document.createElement("button");
          renew.className = "secondary";
          setAction(renew, "key", "Renovar acesso");
          renew.addEventListener("click", () => {
            if (moodleSubmitting) return;
            renewingMoodle = cn.id;
            (el("moodle-label") as HTMLInputElement).value = cn.label;
            const origin = el("moodle-origin") as HTMLInputElement;
            origin.value = cn.origin;
            origin.readOnly = true;
            (el("moodle-token") as HTMLInputElement).value = "";
            setAction(el("moodle-submit"), "key", "Renovar Moodle");
            (el("moodle-setup") as HTMLDetailsElement).open = true;
            el("moodle-cancel-renewal").hidden = false;
            el("moodle-connect-form").scrollIntoView({ block: "nearest" });
            el("moodle-token").focus();
            msg(
              "Informe um novo token da mesma conta Moodle. O histórico será preservado.",
            );
          });
          entry.append(renew);
        }
        if (cn.provider === "moodle" && cn.state === "connected") {
          const sync = document.createElement("button");
          sync.className = "secondary";
          setAction(sync, "rotate", "Atualizar cursos");
          sync.addEventListener("click", async () => {
            sync.disabled = true;
            try {
              const result = await post("/api/sync/moodle-courses", {
                connection_id: cn.id,
              });
              msg(
                result.job?.state === "complete"
                  ? "Cursos atualizados e preservados."
                  : "Atualização incompleta. A memória preservada continua disponível.",
              );
            } catch (e) {
              msg(
                e instanceof Error ? e.message : "A fonte não foi atualizada.",
              );
            } finally {
              sync.disabled = false;
            }
          });
          entry.append(sync);
        }
      }
      const controls = document.createElement("div");
      controls.className = "actions";
      for (const button of Array.from(entry.querySelectorAll("button"))) {
        controls.append(button);
      }
      if (controls.childElementCount) entry.append(controls);
      connections.append(entry);
    }
    await renderActions();
    msg("");
  } catch (e) {
    msg(e instanceof Error ? e.message : "Erro de acesso.");
  }
}
const actionStateLabels: Record<string, string> = {
  prepared: "Aguardando sua revisão",
  approved: "Versão autorizada; execução pendente",
  denied: "Ação recusada",
  uncertain: "Resultado incerto: confira a fonte; o AraHub não reenviará",
  succeeded: "Ação confirmada pelo provedor",
};

function note(text: string) {
  const p = document.createElement("p");
  p.className = "note";
  p.textContent = text;
  return p;
}

function fieldLabel(text: string) {
  const p = document.createElement("p");
  p.className = "field-label";
  p.textContent = text;
  return p;
}

function lineGroup(lines: string[]) {
  const group = document.createElement("div");
  group.className = "grid";
  for (const line of lines) group.append(note(line));
  return group;
}

/** Tela focada de aprovação: a ação acadêmica completa, sem hashes dominantes. */
async function renderActions() {
  const list = el("action-list");
  el("actions-panel").hidden = !cfg.canApproveActions || !token;
  if (!cfg.canApproveActions || !token) {
    list.replaceChildren();
    return;
  }
  const sessionToken = token;
  const actions = await api("/api/actions");
  if (token !== sessionToken) return;
  // Initial session recovery and SIGNED_IN can render concurrently. Replace the
  // list only when the response is ready so both do not append the same content.
  list.replaceChildren();
  if (!actions.length) {
    list.append(note("Nenhuma ação acadêmica aguardando sua autorização."));
  }
  for (const view of actions) {
    const action = view.action;
    const description = describeAction(action.operation, action.content);
    const entry = document.createElement("article");
    entry.className = "panel action-card";
    const heading = document.createElement("h3");
    heading.textContent = description.title;
    entry.append(heading);
    if (!description.known) {
      // Operações retiradas (por exemplo, escrita Google própria) ficam como
      // registro histórico: nenhum botão pode autorizar este legado.
      entry.append(note(
        description.retired
          ? "Operação retirada do AraHub. O material já preservado continua na memória; esta interface não autoriza nem executa esta operação."
          : "Operação acadêmica ainda sem revisão nesta interface. Atualize a interface antes de decidir.",
      ));
      entry.append(note(`Operação registrada: ${description.operation}.`));
      entry.append(note(actionStateLabels[view.state] ?? "Verificar estado"));
      const approve = labeledButton("Autorizar esta ação", "button primary");
      approve.disabled = true;
      const deny = labeledButton("Recusar ação", "button quiet");
      deny.disabled = true;
      const controls = document.createElement("div");
      controls.className = "actions";
      controls.append(approve, deny);
      entry.append(controls);
      list.append(entry);
      continue;
    }
    if (description.connection.length) {
      entry.append(
        fieldLabel("Conta e origem"),
        lineGroup(description.connection),
      );
    }
    if (description.target.length) {
      entry.append(fieldLabel("Destino"), lineGroup(description.target));
    }
    if (description.subject !== null) {
      const subject = document.createElement("p");
      subject.className = "action-subject";
      subject.textContent = description.subject;
      entry.append(fieldLabel("Título"), subject);
    }
    if (description.body !== null) {
      const body = document.createElement("pre");
      body.textContent = description.body;
      entry.append(body);
    }
    if (description.files.length) {
      entry.append(fieldLabel("Arquivos"));
      const files = document.createElement("ul");
      files.className = "file-list";
      for (const file of description.files) {
        const item = document.createElement("li");
        item.textContent = file.size
          ? `${file.name} · ${file.mime} · ${file.size}`
          : `${file.name} · ${file.mime}`;
        files.append(item);
      }
      entry.append(files);
    }
    if (description.conditions.length) {
      entry.append(
        fieldLabel("Condições da fonte"),
        lineGroup(description.conditions),
      );
    }
    let assent: HTMLInputElement | null = null;
    if (description.statement) {
      const statement = document.createElement("blockquote");
      statement.className = "statement";
      statement.textContent = description.statement.text;
      entry.append(statement);
      if (description.statement.required) {
        assent = document.createElement("input");
        assent.type = "checkbox";
        const label = document.createElement("label");
        label.className = "check-label";
        label.append(
          assent,
          document.createTextNode(
            "Concordo com esta declaração e assumo a autoria.",
          ),
        );
        entry.append(label);
      }
    }
    entry.append(note(actionStateLabels[view.state] ?? "Verificar estado"));
    if (view.state === "prepared") {
      const required = description.statement?.required === true;
      const approve = labeledButton("Autorizar esta ação", "button primary");
      approve.disabled = required;
      const deny = labeledButton("Recusar ação", "button quiet");
      assent?.addEventListener("change", () => {
        approve.disabled = !(assent?.checked ?? false);
      });
      for (
        const [button, decision] of [[approve, "approve"], [
          deny,
          "deny",
        ]] as const
      ) {
        button.addEventListener("click", async () => {
          approve.disabled = true;
          deny.disabled = true;
          try {
            await post(`/api/actions/${decision}`, {
              action_id: action.id,
              content_hash: action.hash,
              statement_accepted: decision === "approve" &&
                (assent?.checked ?? false),
            });
            await render();
            msg(
              decision === "approve"
                ? "Ação autorizada. O resultado aparecerá após a execução."
                : "Ação recusada.",
            );
          } catch (e) {
            approve.disabled = required && !(assent?.checked ?? false);
            deny.disabled = false;
            msg(
              e instanceof Error
                ? e.message
                : "Não foi possível registrar sua decisão.",
            );
          }
        });
      }
      const controls = document.createElement("div");
      controls.className = "actions";
      controls.append(approve, deny);
      entry.append(controls);
    }
    list.append(entry);
  }
}
el("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!supabase) return;
  el("signin").setAttribute("disabled", "");
  if (!localCredentialEntry) {
    const email = (el("email") as HTMLInputElement).value;
    const emailRedirectTo = new URL(route("/oauth/callback"), location.origin).href;
    let { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo,
        shouldCreateUser: false,
      },
    });
    // An administrator-provisioned account still needs email confirmation.
    // Resend verifies that account through native PKCE; it never enables signups.
    if (error?.code === "signup_disabled") {
      ({ error } = await supabase.auth.resend({
        type: "signup",
        email,
        options: { emailRedirectTo },
      }));
    }
    el("signin").removeAttribute("disabled");
    msg(
      error
        ? "Não foi possível solicitar o acesso. Confira o cadastro da sua conta e tente novamente."
        : "Confira seu e-mail e abra o link neste navegador para entrar.",
    );
    return;
  }
  const { data, error } = await supabase.auth.signInWithPassword({
    email: (el("email") as HTMLInputElement).value,
    password: (el("password") as HTMLInputElement).value,
  });
  (el("password") as HTMLInputElement).value = "";
  el("signin").removeAttribute("disabled");
  if (error) {
    msg("Não foi possível entrar. Verifique sua conta e tente novamente.");
    return;
  }
  token = data.session?.access_token ?? null;
  await render();
  await consent();
});
el("synthetic-login").addEventListener("click", async () => {
  const r = await fetch(endpoint("/api/synthetic-login"), { method: "POST" });
  token = (await r.json()).access_token;
  sessionStorage.setItem("arahub-synthetic-token", token!);
  await render();
});
if (supabase) (el("signin") as HTMLButtonElement).disabled = false;
el("refresh").addEventListener("click", () => void render());
el("logout").addEventListener("click", async () => {
  pdfJob?.abort();
  token = null;
  sessionStorage.removeItem("arahub-synthetic-token");
  await supabase?.auth.signOut();
  location.href = route("/");
});
for (const which of ["connections", "preferences"]) {
  el(which + "-tab").addEventListener("click", () => {
    for (const id of ["connections", "preferences"]) {
      el(id + "-view").hidden = id !== which;
      el(id + "-tab").classList.toggle("active", id === which);
      el(id + "-tab").setAttribute("aria-pressed", String(id === which));
    }
  });
}
el("export").addEventListener("click", async () => {
  const sessionToken = token;
  try {
    const exported = await api("/api/export");
    if (!sessionToken || token !== sessionToken) return;
    el("export-content").textContent = JSON.stringify(exported, null, 2);
    el("export-content").hidden = false;
    msg("Exportação privada preparada. Credenciais têm recuperação separada.");
  } catch {
    msg("Não foi possível preparar a exportação.");
  }
});
let consentRequest: string | null = null;
async function consent() {
  const id = new URL(location.href).searchParams.get("authorization_id");
  if (!id || !supabase || !token || consentRequest === id) return;
  consentRequest = id;
  const { data, error } = await supabase.auth.oauth.getAuthorizationDetails(id);
  if (error || !data) {
    msg("A solicitação de acesso expirou. Inicie novamente no assistente.");
    return;
  }
  if ("redirect_url" in data) {
    location.assign(data.redirect_url);
    return;
  }
  el("consent").hidden = false;
  const scopeLabels: Record<string, string> = {
    openid: "identidade",
    email: "e-mail",
    profile: "perfil",
  };
  const requested = data.scope.split(" ").map((scope: string) => scopeLabels[scope] ?? scope).join(
    ", ",
  );
  el("consent-details").textContent =
    `${data.client.name} solicita acesso em nome da sua conta: ${requested}.`;
  let deciding = false;
  for (const action of ["approve", "deny"]) {
    el(action).addEventListener("click", async () => {
      if (deciding) return;
      deciding = true;
      (el("approve") as HTMLButtonElement).disabled = true;
      (el("deny") as HTMLButtonElement).disabled = true;
      const { data: result, error: failure } = action === "approve"
        ? await supabase.auth.oauth.approveAuthorization(id, {
          skipBrowserRedirect: true,
        })
        : await supabase.auth.oauth.denyAuthorization(id, {
          skipBrowserRedirect: true,
        });
      if (failure || !result?.redirect_url) {
        deciding = false;
        (el("approve") as HTMLButtonElement).disabled = false;
        (el("deny") as HTMLButtonElement).disabled = false;
        msg("Não foi possível concluir a autorização.");
        return;
      }
      location.assign(result.redirect_url);
    });
  }
}
if (supabase) {
  const { data } = await supabase.auth.getSession();
  token = data.session?.access_token ?? null;
  supabase.auth.onAuthStateChange((event, session) => {
    token = session?.access_token ?? null;
    if (token && event === "SIGNED_IN") {
      // Leave the Auth callback before calling APIs that can reacquire its lock.
      setTimeout(() => {
        void (async () => {
          await render();
          await consent();
        })();
      }, 0);
    }
    if (!token) {
      pdfJob?.abort();
      el("pdf-list").replaceChildren();
      pdfCursor = null;
      resetMoodleForm();
      el("preference-list").replaceChildren();
      el("preference-summary").textContent = "";
      el("connection-list").replaceChildren();
      el("export-content").textContent = "";
      el("export-content").hidden = true;
      el("workspace").hidden = true;
      el("login").hidden = false;
      el("logout").hidden = true;
      el("consent").hidden = true;
      el("actions-panel").hidden = true;
      el("action-list").replaceChildren();
    }
  });
}
await render();
await consent();

const moodleOrigin = el("moodle-origin") as HTMLInputElement;
const clearMoodleOriginAutofill = () => {
  if (!renewingMoodle && moodleOrigin.value.includes("@")) moodleOrigin.value = "";
};
for (const event of ["pointerdown", "focus"]) {
  moodleOrigin.addEventListener(event, () => {
    if (renewingMoodle) return;
    moodleOrigin.readOnly = false;
    clearMoodleOriginAutofill();
  });
}
moodleOrigin.addEventListener("input", clearMoodleOriginAutofill);
(el("moodle-setup") as HTMLDetailsElement).addEventListener("toggle", () => {
  if ((el("moodle-setup") as HTMLDetailsElement).open) {
    requestAnimationFrame(clearMoodleOriginAutofill);
  }
});

el("moodle-mobile-open").addEventListener("click", () => {
  try {
    const origin = (el("moodle-origin") as HTMLInputElement).value;
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    const passport = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    globalThis.open(moodleMobileLaunchUrl(origin, passport), "_blank", "noopener,noreferrer");
    msg("Na página Moodle, copie o endereço do link para abrir o aplicativo e cole-o aqui.");
  } catch {
    msg("Confira o endereço HTTPS do Moodle.");
  }
});

el("moodle-connect-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (
    moodleSubmitting || !token || !cfg.canConnectMoodle ||
    !moodleCredentialEntry
  ) return;
  moodleSubmitting = true;
  const button = el("moodle-submit") as HTMLButtonElement;
  button.disabled = true;
  const secret = el("moodle-token") as HTMLInputElement;
  const supplied = secret.value.trim();
  secret.value = "";
  try {
    const credential = /^[a-z][a-z0-9+.-]*:\/\/token=/i.test(supplied)
      ? parseMoodleMobileLink(supplied)
      : supplied;
    const payload = {
      label: (el("moodle-label") as HTMLInputElement).value,
      origin: (el("moodle-origin") as HTMLInputElement).value,
      token: credential,
      ...(renewingMoodle ? { connection_id: renewingMoodle } : {}),
    };
    const response = await fetch(endpoint("/api/connections/moodle"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    secret.value = "";
    const result = await response.json();
    if (!response.ok) {
      throw new Error(
        result.message ??
          "Não foi possível conectar. Verifique a origem e a validade do acesso.",
      );
    }
    await render();
    resetMoodleForm();
    msg(
      result.renewed
        ? "Acesso Moodle renovado. A identidade e o histórico foram preservados."
        : "Moodle conectado. As consultas preservam a cobertura e não alteram atividades acadêmicas.",
    );
  } catch (e) {
    secret.value = "";
    msg(e instanceof Error ? e.message : "Não foi possível conectar.");
  } finally {
    moodleSubmitting = false;
    button.disabled = false;
  }
});
el("moodle-cancel-renewal").addEventListener("click", () => {
  if (!moodleSubmitting) {
    resetMoodleForm();
    msg("Renovação cancelada. A conexão não foi alterada.");
  }
});
