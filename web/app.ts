import { createClient } from "@supabase/supabase-js";
import { apiEndpoint, sitePath } from "./endpoint.ts";
import { renderUiIcon } from "./icons.ts";
import { extractClientPdf, PDF_CLIENT_MAX_BYTES } from "./pdf_client.ts";
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
for (
  const [id, icon, label] of [
    ["logout", "sign-out", "Sair"],
    ["signin", "sign-in", "Entrar"],
    ["synthetic-login", "experiment", "Explorar ambiente sintético local"],
    ["memory-tab", "folder", "Contextos"],
    ["connections-tab", "account", "Conexões"],
    ["refresh", "rotate", "Atualizar visão"],
    ["export", "download", "Preparar exportação privada"],
    ["moodle-submit", "key", "Conectar Moodle"],
    ["moodle-cancel-renewal", "remove-state", "Cancelar renovação"],
    ["google-connect", "account-add", "Conectar outra conta Google"],
    ["approve", "ready-state", "Permitir"],
    ["deny", "remove-state", "Recusar"],
    ["pdf-more", "book-open", "Mais PDFs"],
  ]
) setAction(el(id), icon, label);
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
const callbackUrl = new URL(location.href);
const pendingGoogle = callbackUrl.pathname.replace(/\/+$/, "") === route("/oauth/google/callback")
  ? {
    state: callbackUrl.searchParams.get("state"),
    code: callbackUrl.searchParams.get("code") ?? undefined,
    error: callbackUrl.searchParams.get("error") ?? undefined,
  }
  : null;
if (pendingGoogle) {
  history.replaceState({}, "", route("/oauth/google/callback"));
}
let googleCallbackHandled = false;
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
  (el("moodle-origin") as HTMLInputElement).readOnly = false;
  el("moodle-cancel-renewal").hidden = true;
  setAction(el("moodle-submit"), "key", "Conectar Moodle");
}
el("synthetic-login").hidden = !cfg.synthetic;
el("moodle-connect-form").hidden = !cfg.canConnectMoodle ||
  !moodleCredentialEntry;
el("moodle-protected-note").hidden = moodleCredentialEntry ||
  !cfg.canConnectMoodle;
el("google-connect-form").hidden = !cfg.canConnectGoogle;
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
async function googleCallback() {
  if (!pendingGoogle || googleCallbackHandled || !token) return;
  googleCallbackHandled = true;
  try {
    await post("/api/connections/google/callback", pendingGoogle);
    await render();
    msg(
      "Conta Google vinculada à sua memória. Confira as permissões concedidas.",
    );
  } catch (e) {
    msg(
      e instanceof Error
        ? e.message
        : "Não foi possível vincular. Reinicie a conexão pela interface.",
    );
  }
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
          await loadPdfs(); // Reload the durable next page before a continuation.
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
el("google-drive-mode").addEventListener("change", () => {
  el("google-selection-note").hidden =
    (el("google-drive-mode") as HTMLSelectElement).value !== "selected_files";
});
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
    const list = el("context-list");
    list.replaceChildren();
    el("empty-state").hidden = c.contexts.length > 0;
    for (const ctx of c.contexts) {
      const deltas = c.deltas.filter((d: { context_id: string }) => d.context_id === ctx.id);
      list.append(
        card(
          ctx.title,
          deltas[0]?.content ?? "Sem registros.",
        ),
      );
    }
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
        if (cn.provider === "google" && cfg.canConnectGoogle) {
          const renew = document.createElement("button");
          renew.className = "secondary";
          setAction(renew, "key", "Renovar acesso");
          renew.addEventListener("click", async () => {
            renew.disabled = true;
            try {
              const result = await post("/api/connections/google/start", {
                connection_id: cn.id,
                label: cn.label,
                scopes: cn.desired_scopes?.length ? cn.desired_scopes : ["identity"],
              });
              location.assign(result.authorization_url);
            } catch (e) {
              renew.disabled = false;
              msg(e instanceof Error ? e.message : "Não foi possível renovar.");
            }
          });
          entry.append(renew);
          const scopes = document.createElement("p");
          scopes.className = "note";
          scopes.textContent = `${cn.granted_scopes?.length ?? 0} permissões concedidas de ${
            cn.desired_scopes?.length ?? 0
          } solicitadas.`;
          entry.append(scopes);
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
    await renderActions(c.connections);
    msg("");
  } catch (e) {
    msg(e instanceof Error ? e.message : "Erro de acesso.");
  }
}
async function renderActions(connections: { id: string; label: string }[]) {
  const list = el("action-list");
  list.replaceChildren();
  el("actions-panel").hidden = !cfg.canApproveActions || !token;
  if (!cfg.canApproveActions || !token) return;
  const sessionToken = token;
  const actions = await api("/api/actions");
  if (token !== sessionToken) return;
  if (!actions.length) {
    const note = document.createElement("p");
    note.textContent = "Nenhuma alteração preparada para revisar.";
    list.append(note);
  }
  for (const view of actions) {
    const action = view.action;
    const account = connections.find((c) => c.id === action.connectionId)?.label ??
      "Conta vinculada";
    const operation = ({
      docs_create: "Criar documento",
      sheets_create: "Criar planilha",
      slides_create: "Criar apresentação",
      docs_insert_text: "Inserir texto no documento",
      slides_replace_text: "Substituir texto na apresentação",
    } as Record<string, string>)[action.operation] ?? "Revisar alteração";
    const entry = card(account, operation);
    if (action.target !== "new") {
      const destination = document.createElement("p");
      destination.className = "note";
      destination.textContent = `Destino: ${action.target}`;
      entry.append(destination);
    }
    const content = document.createElement("pre");
    const proposed = action.content;
    if (
      ["docs_create", "sheets_create", "slides_create"].includes(
        action.operation,
      )
    ) {
      content.textContent = `Nome: ${proposed.title}`;
    } else if (action.operation === "docs_insert_text") {
      content.textContent = proposed.text;
      if (typeof proposed.index === "number") {
        const position = document.createElement("p");
        position.className = "note";
        position.textContent = `Posição: ${proposed.index}${
          proposed.tab_id ? ` · Aba: ${proposed.tab_id}` : ""
        }`;
        entry.append(position);
      }
    } else if (action.operation === "slides_replace_text") {
      content.textContent = `Encontrar:\n${proposed.find}\n\nSubstituir por:\n${proposed.replace}`;
      const pages = document.createElement("p");
      pages.className = "note";
      pages.textContent = `Slides: ${proposed.page_ids.join(", ")}`;
      entry.append(pages);
    } else content.textContent = JSON.stringify(proposed, null, 2);
    if (action.revision) {
      const version = document.createElement("details");
      const label = document.createElement("summary");
      label.textContent = "Versão fixada";
      const value = document.createElement("p");
      value.className = "note";
      value.textContent = action.revision;
      version.append(label, value);
      entry.append(version);
    }
    const status = document.createElement("p");
    status.className = "note";
    status.textContent = ({
      prepared: "Aguardando sua revisão",
      approved: "Versão autorizada; execução pendente",
      denied: "Alteração recusada",
      uncertain: "Resultado incerto: confira a fonte; o AraHub não reenviará",
      succeeded: "Alteração confirmada pelo provedor",
    } as Record<string, string>)[view.state] ?? "Verificar estado";
    entry.append(content, status);
    if (view.state === "prepared") {
      const check = document.createElement("input");
      check.type = "checkbox";
      const label = document.createElement("label");
      label.className = "check-label";
      label.append(
        check,
        document.createTextNode("Revisei a conta, o destino e o conteúdo."),
      );
      const approve = document.createElement("button"),
        deny = document.createElement("button");
      setAction(approve, "ready-state", "Autorizar esta versão");
      approve.disabled = true;
      check.addEventListener("change", () => approve.disabled = !check.checked);
      setAction(deny, "remove-state", "Recusar alteração");
      deny.classList.add("quiet");
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
            });
            await render();
            msg(
              decision === "approve"
                ? "Esta versão foi autorizada. Consulte o resultado após a execução."
                : "Alteração recusada.",
            );
          } catch (e) {
            approve.disabled = !check.checked;
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
      entry.append(label, controls);
    }
    list.append(entry);
  }
}
el("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!supabase) return;
  el("signin").setAttribute("disabled", "");
  if (!localCredentialEntry) {
    const { error } = await supabase.auth.signInWithOtp({
      email: (el("email") as HTMLInputElement).value,
      options: {
        emailRedirectTo: new URL(route("/oauth/callback"), location.origin).href,
        shouldCreateUser: false,
      },
    });
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
  await googleCallback();
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
for (const which of ["memory", "connections"]) {
  el(which + "-tab").addEventListener("click", () => {
    for (const id of ["memory", "connections"]) {
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
          await googleCallback();
        })();
      }, 0);
    }
    if (!token) {
      pdfJob?.abort();
      el("pdf-list").replaceChildren();
      pdfCursor = null;
      resetMoodleForm();
      el("context-list").replaceChildren();
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
await googleCallback();

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
  const payload = {
    label: (el("moodle-label") as HTMLInputElement).value,
    origin: (el("moodle-origin") as HTMLInputElement).value,
    token: secret.value,
    ...(renewingMoodle ? { connection_id: renewingMoodle } : {}),
  };
  secret.value = "";
  try {
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

el("google-connect-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const button = el("google-connect") as HTMLButtonElement;
  button.disabled = true;
  try {
    const scopes = [(el("google-drive-mode") as HTMLSelectElement).value];
    if ((el("google-gmail") as HTMLInputElement).checked) {
      scopes.push("gmail_read");
    }
    if ((el("google-calendar") as HTMLInputElement).checked) {
      scopes.push("calendar_read");
    }
    for (const provider of ["docs", "sheets", "slides"]) {
      if ((el(`google-${provider}-write`) as HTMLInputElement).checked) {
        scopes.push(`${provider}_write`);
      }
    }
    const result = await post("/api/connections/google/start", {
      label: (el("google-label") as HTMLInputElement).value,
      scopes,
    });
    location.assign(result.authorization_url);
  } catch (e) {
    button.disabled = false;
    msg(e instanceof Error ? e.message : "Não foi possível iniciar a conexão.");
  }
});
