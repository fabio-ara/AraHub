import { createClient } from "@supabase/supabase-js";
const el = (id: string) => document.getElementById(id)!;
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
el("synthetic-login").hidden = !cfg.synthetic;
if (!supabase) {
  el("login-form").hidden = true;
  el("setup-note").hidden = false;
}
const api = async (path: string) => {
  const r = await fetch(path, { headers: { Authorization: `Bearer ${token}` } });
  const result = await r.json();
  if (!r.ok) throw new Error(result.message ?? "Não foi possível atualizar.");
  return result;
};
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
      connections.append(card(cn.label, `${cn.provider} · ${cn.state}`));
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
    el("export-content").textContent = JSON.stringify(await api("/api/export"), null, 2);
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
  el("consent").hidden = false;
  el("consent-details").textContent = JSON.stringify(data);
  for (const action of ["approve", "deny"]) {
    el(action).addEventListener("click", async () => {
      const { data: result, error: failure } = action === "approve"
        ? await supabase.auth.oauth.approveAuthorization(id, { skipBrowserRedirect: true })
        : await supabase.auth.oauth.denyAuthorization(id, { skipBrowserRedirect: true });
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
  });
}
await render();
await consent();
