import { createClient } from "@supabase/supabase-js";
const el = (id: string) => document.getElementById(id)!;
const callbackUrl = new URL(location.href);
const pendingGoogle = callbackUrl.pathname === "/oauth/google/callback"
  ? {
    state: callbackUrl.searchParams.get("state"),
    code: callbackUrl.searchParams.get("code") ?? undefined,
    error: callbackUrl.searchParams.get("error") ?? undefined,
  }
  : null;
if (pendingGoogle) history.replaceState({}, "", "/oauth/google/callback");
let googleCallbackHandled = false;
const msg = (s: string) => {
  el("message").textContent = s;
};
const cfg = await fetch("/api/config").then((r) => r.json());
const supabase = cfg.supabaseUrl && cfg.publishableKey
  ? createClient(cfg.supabaseUrl, cfg.publishableKey, {
    auth: { flowType: "pkce", detectSessionInUrl: true, persistSession: true },
  })
  : null;
let token: string | null = cfg.synthetic ? sessionStorage.getItem("arahub-synthetic-token") : null;
let renewingMoodle: string | null = null;
let moodleSubmitting = false;
function resetMoodleForm() {
  renewingMoodle = null;
  (el("moodle-connect-form") as HTMLFormElement).reset();
  (el("moodle-origin") as HTMLInputElement).readOnly = false;
  el("moodle-cancel-renewal").hidden = true;
  el("moodle-submit").textContent = "Conectar Moodle";
}
el("synthetic-login").hidden = !cfg.synthetic;
el("moodle-connect-form").hidden = !cfg.canConnectMoodle;
el("google-connect-form").hidden = !cfg.canConnectGoogle;
if (!supabase) {
  el("login-form").hidden = true;
  el("setup-note").hidden = false;
}
const api = async (path: string) => {
  const r = await fetch(path, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const result = await r.json();
  if (!r.ok) throw new Error(result.message ?? "Não foi possível atualizar.");
  return result;
};
async function post(path: string, payload: unknown) {
  const response = await fetch(path, {
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
async function render() {
  if (!token) return;
  try {
    const c = await api("/api/context");
    el("login").hidden = true;
    el("workspace").hidden = false;
    el("logout").hidden = false;
    el("mode-label").textContent = cfg.synthetic
      ? "Ambiente sintético local. Esta visão não comprova conexão real ou implantação."
      : "Memória privada da sua conta. Consulte a cobertura de cada conexão.";
    const list = el("context-list");
    list.replaceChildren();
    el("empty-state").hidden = c.contexts.length > 0;
    for (const ctx of c.contexts) {
      const deltas = c.deltas.filter((d: { context_id: string }) => d.context_id === ctx.id);
      list.append(
        card(
          ctx.title,
          `${deltas.length} registros recuperados · versão ${ctx.version}${
            deltas[0] ? " · " + deltas[0].content : ""
          }`,
        ),
      );
    }
    const connections = el("connection-list");
    connections.replaceChildren();
    for (const cn of c.connections) {
      const entry = card(cn.label, `${cn.provider} · ${cn.state}`);
      if (!cfg.synthetic && cn.provider !== "migration") {
        const disconnect = document.createElement("button");
        disconnect.className = "quiet";
        disconnect.textContent = "Desconectar";
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
        if (cn.provider === "moodle" && cfg.canConnectMoodle) {
          const renew = document.createElement("button");
          renew.className = "secondary";
          renew.textContent = "Renovar acesso";
          renew.addEventListener("click", () => {
            if (moodleSubmitting) return;
            renewingMoodle = cn.id;
            (el("moodle-label") as HTMLInputElement).value = cn.label;
            const origin = el("moodle-origin") as HTMLInputElement;
            origin.value = cn.origin;
            origin.readOnly = true;
            (el("moodle-token") as HTMLInputElement).value = "";
            el("moodle-submit").textContent = "Renovar Moodle";
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
          sync.textContent = "Atualizar cursos";
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
          renew.textContent = "Renovar acesso";
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
      connections.append(entry);
    }
    msg("");
  } catch (e) {
    msg(e instanceof Error ? e.message : "Erro de acesso.");
  }
}
el("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!supabase) return;
  el("signin").setAttribute("disabled", "");
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
  const r = await fetch("/api/synthetic-login", { method: "POST" });
  token = (await r.json()).access_token;
  sessionStorage.setItem("arahub-synthetic-token", token!);
  await render();
});
el("refresh").addEventListener("click", () => void render());
el("logout").addEventListener("click", async () => {
  token = null;
  sessionStorage.removeItem("arahub-synthetic-token");
  await supabase?.auth.signOut();
  location.href = "/";
});
for (const which of ["memory", "connections"]) {
  el(which + "-tab").addEventListener("click", () => {
    for (const id of ["memory", "connections"]) {
      el(id + "-view").hidden = id !== which;
      el(id + "-tab").classList.toggle("active", id === which);
      el(id + "-tab").setAttribute("aria-selected", String(id === which));
    }
  });
}
el("export").addEventListener("click", async () => {
  try {
    el("export-content").textContent = JSON.stringify(
      await api("/api/export"),
      null,
      2,
    );
    el("export-content").hidden = false;
    msg("Exportação privada preparada. Credenciais têm recuperação separada.");
  } catch {
    msg("Não foi possível preparar a exportação.");
  }
});
async function consent() {
  const id = new URL(location.href).searchParams.get("authorization_id");
  if (!id || !supabase || !token) return;
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
  el("consent-details").textContent =
    `${data.client.name} solicita acesso em nome da sua conta. Permissões de identidade: ${data.scope}.`;
  for (const action of ["approve", "deny"]) {
    el(action).addEventListener("click", async () => {
      const { data: result, error: failure } = action === "approve"
        ? await supabase.auth.oauth.approveAuthorization(id, {
          skipBrowserRedirect: true,
        })
        : await supabase.auth.oauth.denyAuthorization(id, {
          skipBrowserRedirect: true,
        });
      if (failure || !result?.redirect_url) {
        msg("Não foi possível concluir a autorização.");
        return;
      }
      location.assign(result.redirect_url);
    }, { once: true });
  }
}
if (supabase) {
  const { data } = await supabase.auth.getSession();
  token = data.session?.access_token ?? null;
  supabase.auth.onAuthStateChange((_event, session) => {
    token = session?.access_token ?? null;
    if (!token) {
      resetMoodleForm();
      el("context-list").replaceChildren();
      el("connection-list").replaceChildren();
      el("export-content").textContent = "";
      el("export-content").hidden = true;
      el("workspace").hidden = true;
      el("login").hidden = false;
      el("logout").hidden = true;
      el("consent").hidden = true;
    }
  });
}
await render();
await consent();
await googleCallback();

el("moodle-connect-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (moodleSubmitting) return;
  moodleSubmitting = true;
  const button = el("moodle-submit") as HTMLButtonElement;
  button.disabled = true;
  const secret = el("moodle-token") as HTMLInputElement;
  try {
    const response = await fetch("/api/connections/moodle", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        label: (el("moodle-label") as HTMLInputElement).value,
        origin: (el("moodle-origin") as HTMLInputElement).value,
        token: secret.value,
        ...(renewingMoodle ? { connection_id: renewingMoodle } : {}),
      }),
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
