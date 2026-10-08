import { ownStatusControl } from "./own_status.ts";
import { createClient } from "@supabase/supabase-js";
import { apiEndpoint, sitePath } from "./endpoint.ts";
import { renderUiIcon } from "./icons.ts";
import { actionReview, describeAction } from "./action_preview.ts";
import { type LibraryFile, previewMime, readLibraryFile, safeFileName } from "./library.ts";
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
function labeledButton(label: string, variant: string) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = variant.includes("primary") ? "icon-ghost primary" : "icon-ghost";
  setAction(button, variant.includes("primary") ? "ready-state" : "remove-state", label);
  return button;
}
for (
  const [id, icon, label] of [
    ["pdf-tab", "book-open", "Materiais"],
    ["actions-tab", "ready-state", "Ações acadêmicas"],
    ["moodle-add", "account-add", "Adicionar Moodle"],
    ["moodle-back", "arrow-left", "Voltar às conexões"],
    ["moodle-help-toggle", "info", "Ajuda para conectar"],
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
    ["privacy", "info", "Privacidade"],
  ]
) setAction(el(id), icon, label);
setAction(el("connections-tab"), "account", "Conexões");
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
let fileJob: AbortController | null = null;
let libraryLoaded = false;
let libraryFailed = false;
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
el("pdf-tab").hidden = !cfg.canBrowseMaterials;
el("moodle-add").hidden = !cfg.canConnectMoodle;
let currentView = "connections";
let initialView = true;
const views: Record<string, string> = {
  connections: "connections-view",
  pdf: "pdf-view",
  moodle: "moodle-view",
  actions: "actions-panel",
  export: "export-view",
};
function showView(which: string) {
  currentView = which;
  for (const [name, id] of Object.entries(views)) {
    el(id).hidden = name !== which;
    const tab = document.getElementById(name + "-tab");
    tab?.classList.toggle("active", name === which);
    tab?.setAttribute("aria-pressed", String(name === which));
  }
  document.querySelector(".screen-content")?.scrollTo(0, 0);
  if (which === "pdf" && !libraryLoaded) void loadLibrary();
  msg("");
}

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
async function openMaterial(file: LibraryFile, download: boolean, button: HTMLButtonElement) {
  if (!token || fileJob) return;
  const mime = previewMime(file.mime_type);
  if (!download && !mime) return;
  // A normal tab is opened only by the user's explicit click, before async work.
  const preview = download ? null : window.open("about:blank", "_blank");
  if (!download && !preview) {
    msg("Permita abrir o material em uma nova aba.");
    return;
  }
  if (preview) {
    preview.opener = null;
    preview.document.title = safeFileName(file.name);
    preview.document.body.textContent = "Abrindo material…";
  }
  const job = new AbortController();
  fileJob = job;
  const sessionToken = token;
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  const timer = setTimeout(() => job.abort(), 180_000);
  try {
    const bytes = await readLibraryFile(file, (offset) =>
      fetch(endpoint("/api/library/part"), {
        method: "POST",
        signal: job.signal,
        redirect: "error",
        headers: { Authorization: `Bearer ${sessionToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ file_id: file.id, sha256: file.sha256, offset }),
      }), job.signal);
    job.signal.throwIfAborted();
    if (token !== sessionToken) throw new Error("Sessão encerrada.");
    const url = URL.createObjectURL(
      new Blob([bytes], { type: download ? "application/octet-stream" : mime! }),
    );
    // User-facing controls only. Automated QA must exercise the API, never these transfers.
    if (download) {
      const link = document.createElement("a");
      link.href = url;
      link.download = safeFileName(file.name);
      link.click();
    } else if (preview && !preview.closed) preview.location.replace(url);
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    msg("");
  } catch (e) {
    preview?.close();
    if (token === sessionToken) {
      msg(
        job.signal.aborted
          ? "A abertura demorou demais. Tente novamente."
          : e instanceof Error
          ? e.message
          : "Material indisponível.",
      );
    }
  } finally {
    clearTimeout(timer);
    button.disabled = false;
    button.removeAttribute("aria-busy");
    if (fileJob === job) fileJob = null;
  }
}
async function loadLibrary(append = false) {
  if (!token || pdfLoading || !cfg.canBrowseMaterials || (append && !pdfCursor)) return;
  pdfLoading = true;
  libraryFailed = false;
  const sessionToken = token;
  const status = el("library-status");
  status.textContent = "Carregando…";
  try {
    const page = await post("/api/library/list", append ? { after: pdfCursor } : {});
    if (token !== sessionToken) return;
    const list = el("pdf-list");
    if (!append) list.replaceChildren();
    if (append && page.next_id === pdfCursor) {
      throw new Error("Atualize a biblioteca para continuar.");
    }
    pdfCursor = page.next_id;
    libraryLoaded = true;
    for (const file of page.files as LibraryFile[]) {
      const size = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 }).format(
        file.bytes / 1024 / 1024,
      ) + " MB";
      const detail = [file.source, size].filter(Boolean).join(" · ");
      const entry = card(safeFileName(file.name), detail);
      entry.classList.add("material-row");
      const actions = document.createElement("div");
      actions.className = "actions";
      if (file.available) {
        if (previewMime(file.mime_type)) {
          const open = document.createElement("button");
          setAction(open, "preview", "Abrir " + safeFileName(file.name));
          open.addEventListener("click", () => void openMaterial(file, false, open));
          actions.append(open);
        }
        const download = document.createElement("button");
        setAction(download, "download", "Baixar " + safeFileName(file.name));
        download.addEventListener("click", () => void openMaterial(file, true, download));
        actions.append(download);
      } else entry.append(note("Arquivo indisponível para abrir ou baixar."));
      entry.append(actions);
      list.append(entry);
    }
    status.textContent = list.childElementCount ? "" : "Nenhum material.";
  } catch (e) {
    libraryFailed = true;
    status.textContent = e instanceof Error ? e.message : "Materiais indisponíveis.";
  } finally {
    pdfLoading = false;
    if (!libraryFailed) requestAnimationFrame(moreMaterials);
  }
}
function moreMaterials() {
  if (currentView !== "pdf" || !libraryLoaded || libraryFailed || pdfLoading || !pdfCursor) return;
  const end = el("library-status").getBoundingClientRect();
  const area = document.querySelector(".screen-content")!.getBoundingClientRect();
  if (end.top < area.bottom + 160) void loadLibrary(true);
}
document.querySelector(".screen-content")!.addEventListener("scroll", moreMaterials, {
  passive: true,
});
window.addEventListener("resize", moreMaterials);
function card(title: string, detail: string) {
  const card = document.createElement("article");
  card.className = "item-row";
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

async function render() {
  if (!token) return;
  const sessionToken = token;
  try {
    const c = await api("/api/context");
    if (token !== sessionToken) return;
    el("login").hidden = true;
    el("workspace").hidden = false;
    el("logout").hidden = false;
    el("mode-label").textContent = cfg.synthetic
      ? "Ambiente sintético local. Esta visão não comprova conexão real ou implantação."
      : "";
    const connections = el("connection-list");
    connections.replaceChildren();
    for (const cn of c.connections) {
      if (cn.provider !== "moodle") continue;
      const entry = card(
        cn.label,
        cn.state === "connected" ? "" : connectionState[cn.state] ?? "Verificar acesso",
      );
      const heading = entry.querySelector("h3")!;
      const state = document.createElement("span");
      state.className = "connection-state";
      state.setAttribute("role", "img");
      state.setAttribute("aria-label", connectionState[cn.state] ?? "Verificar acesso");
      state.title = connectionState[cn.state] ?? "Verificar acesso";
      state.innerHTML = renderUiIcon(cn.state === "connected" ? "ready-state" : "offline");
      const row = document.createElement("div");
      row.className = "item-heading";
      row.append(heading, state);
      entry.prepend(row);
      if (!cfg.synthetic) {
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
            showView("moodle");
            el("moodle-cancel-renewal").hidden = false;
            el("moodle-connect-form").scrollIntoView({ block: "nearest" });
            el("moodle-token").focus();
            msg(
              "Cole o novo acesso desta conta.",
            );
          });
          entry.append(renew);
        }
        if (cn.provider === "moodle" && cn.state === "connected") {
          if (cfg.canAuthorizeOwnStatus) {
            entry.append(ownStatusControl(cn.id, post, msg));
          }
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
let actionExpiryTimer: number | undefined;
async function renderActions() {
  clearTimeout(actionExpiryTimer);
  const list = el("action-list");
  el("actions-panel").hidden = currentView !== "actions" || !cfg.canApproveActions || !token;
  el("actions-tab").hidden = !cfg.canApproveActions || !token;
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
  let activeCount = 0;
  let nextChange = Infinity;
  for (const view of actions) {
    const action = view.action;
    const review = actionReview(view);
    if (["prepared", "approved"].includes(view.state)) {
      nextChange = Math.min(nextChange, review.nextChange);
    }
    const description = describeAction(action.operation, action.content);
    if (description.retired || ["succeeded", "failed", "denied", "expired"].includes(view.state)) {
      continue;
    }
    const entry = document.createElement("article");
    entry.className = "item-row action-card";
    activeCount++;
    const heading = document.createElement("h3");
    heading.textContent = description.title;
    entry.append(heading);
    if (!description.known) {
      entry.append(note(
        "Operação acadêmica ainda sem revisão nesta interface. Atualize a interface antes de decidir.",
      ));
      entry.append(note(actionStateLabels[view.state] ?? "Verificar estado"));
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
        const formats: Record<string, string> = {
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
            "Documento Word",
          "application/vnd.openxmlformats-officedocument.presentationml.presentation":
            "Apresentação PowerPoint",
          "application/pdf": "PDF",
          "text/plain": "Texto",
        };
        const format = formats[file.mime] ?? file.mime;
        item.textContent = file.size
          ? `${file.name} · ${format} · ${file.size}`
          : `${file.name} · ${format}`;
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
      if (description.statement.required && review.renewable) {
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
    entry.append(note(
      review.stale && ["prepared", "approved"].includes(view.state)
        ? "Esta revisão expirou. Peça ao assistente para preparar uma nova versão com as condições atuais."
        : review.expired
        ? "A autorização expirou sem execução. Revise esta versão para autorizar novamente."
        : actionStateLabels[view.state] ?? "Verificar estado",
    ));
    if (view.state === "approved" && !review.expired && view.approval?.expiresAt) {
      entry.append(
        note(
          `Autorização válida até ${new Date(view.approval.expiresAt).toLocaleString("pt-BR")}.`,
        ),
      );
    }
    if (review.renewable) {
      const required = description.statement?.required === true;
      const approve = labeledButton(
        review.expired ? "Renovar autorização" : "Autorizar esta ação",
        "button primary",
      );
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
              e instanceof Error ? e.message : "Não foi possível registrar sua decisão.",
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
  el("actions-tab").hidden = !activeCount;
  if (initialView) {
    initialView = false;
    if (activeCount) showView("actions");
  }
  if (!activeCount && currentView === "actions") showView("connections");
  if (Number.isFinite(nextChange)) {
    actionExpiryTimer = setTimeout(() =>
      void renderActions().catch(() => {
        msg("Atualize a visão para conferir a validade das autorizações.");
      }), Math.max(1, Math.min(nextChange - Date.now() + 50, 2_147_483_647)));
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
el("refresh").addEventListener("click", () => {
  if (currentView === "pdf") void loadLibrary();
  else void render();
});
el("logout").addEventListener("click", async () => {
  fileJob?.abort();
  token = null;
  sessionStorage.removeItem("arahub-synthetic-token");
  await supabase?.auth.signOut();
  location.href = route("/");
});
for (const which of ["connections", "pdf", "actions"]) {
  el(which + "-tab").addEventListener("click", () => showView(which));
}
el("moodle-add").addEventListener("click", () => {
  resetMoodleForm();
  showView("moodle");
});
el("moodle-back").addEventListener("click", () => showView("connections"));
el("moodle-help-toggle").addEventListener("click", () => {
  el("moodle-help").hidden = !el("moodle-help").hidden;
  el("moodle-help-toggle").setAttribute("aria-expanded", String(!el("moodle-help").hidden));
});
el("export").addEventListener("click", async () => {
  const sessionToken = token;
  try {
    const exported = await api("/api/export");
    if (!sessionToken || token !== sessionToken) return;
    el("export-content").textContent = JSON.stringify(exported, null, 2);
    showView("export");
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
  el("workspace").hidden = true;
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
      fileJob?.abort();
      el("pdf-list").replaceChildren();
      pdfCursor = null;
      libraryLoaded = false;
      resetMoodleForm();
      el("connection-list").replaceChildren();
      el("export-content").textContent = "";
      el("export-view").hidden = true;
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
    showView("connections");
    msg(
      result.renewed ? "Acesso renovado." : "Moodle conectado.",
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
    showView("connections");
  }
});
