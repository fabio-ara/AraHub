type AuthFailure = {
  code?: string;
  status?: number;
  name?: string;
  details?: { code?: string };
};

// Only fixed, actionable messages reach the UI. Redirect descriptions are untrusted.
export function authErrorMessage(error: AuthFailure, fallback: string): string {
  const code = error.code ?? error.details?.code;
  if (code === "over_email_send_rate_limit") {
    return "O serviço atingiu o limite de envio de e-mails. Aguarde antes de solicitar outro link; repetir agora não enviará uma nova mensagem.";
  }
  if (error.status === 429 || code === "over_request_rate_limit") {
    return "Há muitas tentativas de acesso em pouco tempo. Aguarde alguns minutos antes de tentar novamente.";
  }
  if (code === "otp_expired") {
    return "Este link de acesso é inválido, expirou ou já foi usado. Solicite um novo link e abra somente a mensagem mais recente neste navegador.";
  }
  if (
    ["bad_code_verifier", "flow_state_not_found", "flow_state_expired"].includes(code ?? "") ||
    error.name === "AuthPKCECodeVerifierMissingError"
  ) {
    return incompleteAuthMessage;
  }
  if (code === "email_address_not_authorized") {
    return "O serviço de e-mail desta instalação não permite enviar para este endereço. Procure o administrador para configurar o envio.";
  }
  return fallback;
}

export const incompleteAuthMessage =
  "Não foi possível concluir este acesso. Abra o link mais recente no mesmo navegador e perfil em que o solicitou. Se o link já foi usado, solicite outro.";

export function authReturnState(href: string) {
  const url = new URL(href);
  const hash = new URLSearchParams(url.hash.slice(1));
  const hasError = ["error", "error_code", "error_description"].some((key) =>
    url.searchParams.has(key) || hash.has(key)
  );
  const errorCode = url.searchParams.get("error_code") ?? hash.get("error_code") ?? undefined;
  const hasCode = url.searchParams.has("code");
  const hasAuthHash = ["error", "error_code", "error_description", "access_token"].some((key) =>
    hash.has(key)
  );
  const hasReturn = hasError || hasCode || hasAuthHash;
  if (hasReturn) {
    for (
      const key of [
        "error",
        "error_code",
        "error_description",
        "code",
        "access_token",
        "refresh_token",
        "expires_at",
        "expires_in",
        "token_type",
        "type",
        "provider_token",
        "provider_refresh_token",
        "sb",
        "sb_flow_id",
      ]
    ) {
      url.searchParams.delete(key);
      hash.delete(key);
    }
    // An ordinary section anchor is not an OAuth fragment.
    if (hasAuthHash) url.hash = hash.toString();
  }
  return { hasError, errorCode, hasCode, hasReturn, cleanUrl: url.href };
}
