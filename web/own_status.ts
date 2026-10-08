import { renderUiIcon } from "./icons.ts";
type Post = (path: string, body: object) => Promise<any>;
function labeledButton(label: string, variant: string) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `icon-ghost ${variant}`;
  button.setAttribute("aria-label", label);
  button.title = label;
  const icon = label === "Status das minhas entregas"
    ? "progress"
    : label === "Permitir consulta"
    ? "ready-state"
    : label === "Cancelar"
    ? "arrow-left"
    : "offline";
  button.innerHTML = renderUiIcon(icon);
  return button;
}
export function ownStatusControl(connectionId: string, post: Post, msg: (message: string) => void) {
  const statusPolicy = labeledButton("Status das minhas entregas", "secondary");
  statusPolicy.addEventListener("click", async () => {
    statusPolicy.disabled = true;
    try {
      const review = await post("/api/connections/own-status/review", {
        connection_id: connectionId,
      });
      const dialog = document.createElement("dialog");
      dialog.className = "own-status-dialog";
      dialog.setAttribute("aria-labelledby", "own-status-title");
      const title = document.createElement("h1");
      title.className = "topbar-title";
      title.id = "own-status-title";
      title.textContent = "Minhas entregas";
      const target = document.createElement("p");
      target.textContent = `${review.label} · ${review.origin} · Conta Moodle ${review.account}`;
      const explanation = document.createElement("p");
      explanation.textContent = review.explanation;
      const state = document.createElement("p");
      state.textContent = review.allowed
        ? "Consulta permitida nesta conexão."
        : "Consulta bloqueada nesta conexão.";
      const label = document.createElement("label"),
        accepted = document.createElement("input");
      accepted.type = "checkbox";
      label.className = "check-label";
      label.append(
        accepted,
        " Li e aceito os efeitos técnicos descritos para esta conta.",
      );
      const allow = labeledButton("Permitir consulta", "primary");
      allow.disabled = true;
      accepted.addEventListener("change", () => {
        allow.disabled = !accepted.checked;
      });
      const revoke = labeledButton("Revogar permissão", "secondary");
      revoke.disabled = !review.allowed;
      const cancel = labeledButton("Cancelar", "quiet");
      cancel.addEventListener("click", () => dialog.close());
      const error = document.createElement("p");
      error.setAttribute("role", "alert");
      const decide = async (allowValue: boolean) => {
        allow.disabled = revoke.disabled = cancel.disabled = true;
        try {
          await post("/api/connections/own-status/decide", {
            connection_id: connectionId,
            credential_epoch: review.credential_epoch,
            last_receipt_id: review.last_receipt_id,
            policy_version: review.policy_version,
            allow: allowValue,
            effects_accepted: accepted.checked,
          });
          dialog.close();
          msg(
            allowValue
              ? "Consulta de status próprio permitida. Cada entrega continua exigindo sua aprovação."
              : "Permissão revogada. Leituras já em andamento podem terminar; as próximas ficam bloqueadas.",
          );
        } catch (e) {
          error.textContent = e instanceof Error
            ? e.message
            : "Não foi possível registrar a decisão. Reabra a revisão.";
          // A stale view cannot retry a grant; re-opening obtains the current version.
          cancel.disabled = false;
        }
      };
      allow.addEventListener("click", () => decide(true));
      revoke.addEventListener("click", () => decide(false));
      const buttons = document.createElement("div");
      buttons.className = "actions";
      buttons.append(allow, revoke);
      const screen = document.createElement("div");
      screen.className = "screen";
      const header = document.createElement("header");
      header.className = "topbar";
      header.append(cancel, title, document.createElement("span"));
      const content = document.createElement("div");
      content.className = "screen-content";
      content.append(target, explanation, state, label, error, buttons);
      const footer = document.createElement("footer");
      footer.className = "screen-footer";
      screen.append(header, content, footer);
      dialog.append(screen);
      dialog.addEventListener("close", () => dialog.remove(), { once: true });
      document.body.append(dialog);
      dialog.showModal();
    } catch (e) {
      msg(e instanceof Error ? e.message : "Permissão indisponível.");
    } finally {
      statusPolicy.disabled = false;
    }
  });
  return statusPolicy;
}
