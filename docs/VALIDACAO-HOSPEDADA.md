# Validação hospedada (HTTPS real)

Data: 2026-10-05. Script genérico `scripts/validate_hosted.ts`. Comprova o alvo
hospedado com **sessões reais do Supabase Auth** e o **cliente MCP SDK** existente.
Não substitui a matriz de aceite: registra o que foi executado, com quais limites.

Executado em 2026-10-06: **32 pass, 0 fail, 0 skip**, sessões e OAuth reais
de dois usuários temporários com dados sintéticos. Discovery HTTPS, MCP SDK,
idempotência, leitura cruzada/busca/exportação e revogação aprovados.
Evidência privada em `.private/evidence/hosted-3d29dd39-053f-4add-b561-56c8fe1931b9.json`.
UI/PDF hospedados: dois viewports, rede real, texto gravado e capturas inspecionadas;
`.private/evidence/hosted-ui-pdf-result.json`. Não comprova conta acadêmica,
consentimento humano, conversa ChatGPT nem smartphone físico.

## Princípios

- Não cria nem apaga usuários, não gera JWT sintético e não executa escrita
  acadêmica. Os usuários e os tokens temporários são produzidos por quem opera o
  alvo, antes de rodar o script.
- Segredos (chave publicável, senhas, tokens) ficam em um JSON fora do Git ou em
  `.private/`. O script recusa um arquivo de configuração dentro do repositório
  que não esteja em `.private/`, e nunca imprime segredos.
- Evidência somente em `.private/evidence/hosted-<uuid>.json`, com contagens,
  identificadores de dono/contexto e vereditos; sem tokens nem senhas.
- Limites de execução: HTTPS obrigatório, loopback recusado, redirecionamentos
  não seguidos, tempo limite padrão de 20 s, resposta limitada a 256 KiB
  (exportação até 1 MiB) e no máximo um contexto e um delta por dono por execução.

## Arquivo de configuração

Estrutura em `.private/hosted-validation.json` (placeholders; nunca versionar o
arquivo real):

```json
{
  "api_base": "https://<host-do-projeto>/functions/v1/arahub",
  "supabase_url": "https://<projeto>.supabase.co",
  "publishable_key": "<chave-publicavel-do-projeto>",
  "mcp_client_id": "<client-id-oauth-registrado>",
  "users": [
    { "email": "<usuario-temporario-1>", "password": "<senha-1>" },
    { "email": "<usuario-temporario-2>", "password": "<senha-2>" }
  ],
  "mcp_tokens": [
    { "email": "<usuario-temporario-1>", "access_token": "<token-oauth-1>" },
    { "email": "<usuario-temporario-2>", "access_token": "<token-oauth-2>" }
  ],
  "revoke": true
}
```

`api_base` é a base exata da função (sem barra final). `supabase_url` é apenas a
origem do Auth. `mcp_client_id` é opcional, mas quando presente o `client_id` do
token OAuth tem de coincidir. `mcp_tokens` é opcional: sem ele, a fase MCP e o
isolamento por dois donos ficam `skip`, e o restante continua válido.
`timeout_ms` e `max_body_bytes` podem ajustar os limites.

## Comandos

```
deno run --allow-read scripts/validate_hosted.ts --check-config .private/hosted-validation.json
deno run --allow-net --allow-read --allow-write=.private/evidence \
  scripts/validate_hosted.ts .private/hosted-validation.json
```

`--check-config` valida o formato e os guardas sem tocar a rede. O caminho também
pode vir de `ARAHUB_HOSTED_CONFIG` (exige `--allow-env=ARAHUB_HOSTED_CONFIG`).
O tipo do script entra no gate normal por `deno task check`.

## Fases e o que cada veredito significa

1. **Disco/health e discovery**: `/health` responde 200; o discovery anuncia o
   recurso MCP e o issuer da sessão real.
2. **Duas sessões pessoais reais**: login por senha no Auth do projeto; os dois
   `sub` têm de ser distintos e a `aud` `authenticated`.
3. **Negativas de autenticação**: `/mcp` sem token retorna 401 com
   `WWW-Authenticate`; a **sessão pessoal é recusada em `/mcp`** por não trazer
   `client_id`; a API pessoal recusa token inválido.
4. **MCP autorizado (requer `mcp_tokens`)**: o cliente SDK lista ferramentas, cria
   contexto e grava delta idempotente por dono; o token OAuth precisa trazer
   `client_id` (e coincidir com `mcp_client_id`), e o mesmo token é aceito na API
   pessoal — confirmando identidade única entre as duas superfícies.
5. **Isolamento entre dois donos**: o segundo dono não lê o contexto do primeiro
   (`not_found`) nem encontra o marcador dele na busca; `/api/context` e
   `/api/export` de cada dono contêm somente o próprio marcador.
6. **Revogação de sessão** (`revoke: true`): nova sessão pessoal funciona (200),
   é encerrada por `POST {supabase_url}/auth/v1/logout` e a mesma credencial
   passa a retornar 401 — prova que a checagem de sessão ativa independe da
   validade da assinatura do token.

`skip` não é aprovação: indica ausência de insumo (por exemplo, sem
`mcp_tokens`). `fail` é achado material e o script sai com código 1.

## Passos manuais de revogação (fallback)

Se o encerramento automático não estiver disponível no alvo:

1. Autentique um dos usuários temporários e confirme `GET /api/context` = 200.
2. Revogue a sessão: `POST {supabase_url}/auth/v1/logout` com o token do próprio
   usuário (o que o script faz) ou, se o projeto for puramente JWT sem linha em
   `auth.sessions`, revogue pelo painel/Admin API (chave de serviço fica com quem
   opera, jamais no arquivo de configuração).
3. Repita `GET /api/context` com o mesmo token: espera-se 401 `unauthorized`
   antes do vencimento, pois o backend confere a sessão ativa.
4. Registre os status HTTP como evidência privada.

## Limites conhecidos

Em 2026-10-06, o consentimento foi operado na interface hospedada com identidade
sintética, autorização nativa e troca PKCE/callback vinculados, sem rede simulada.
Captura de 390×844 inspecionada. A conta titular confirmou seu e-mail e concedeu
consentimento no cliente pessoal ChatGPT; a conexão foi reconhecida pelo ChatGPT.
Cliente temporário, duas contas sintéticas e seus dados/sessões foram removidos
por limpeza dirigida com guardas; nenhuma memória privada foi importada.

- A prova cobre o alvo HTTPS real, Auth real, MCP real e isolamento por dois
  donos. Não cobre escrita acadêmica, provedores Moodle/Google, cron nem
  smartphone.
- Reexecuções acumulam contextos temporários nos usuários de teste; apague os
  usuários temporários após a validação no alvo.
- O token OAuth precisa ter sido emitido pelo servidor OAuth do projeto com o
  cliente registrado em `MCP_CLIENT_IDS`. Um token pessoal nunca autoriza MCP.
