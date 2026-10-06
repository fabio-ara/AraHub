# Adaptador Google — OAuth proprio, leitura e escrita preparada

Escopo desta etapa: biblioteca independente para conectar contas Google ao AraHub, ler Gmail,
Calendar, Drive, Docs, Sheets e Slides, e preparar escritas que so executam com aprovacao confiavel.
Implementacao nova sob MIT; nao reutiliza codigo do repositorio irmao (nao ha LICENSE auditada
nele).

Arquivos:

- src/adapters/token_vault.ts — cofre AES-256-GCM e contrato de persistencia com CAS.
- src/adapters/google.ts — OAuth/OIDC, cliente de leitura e portao de escrita.
- src/google_connections.ts — servico persistente de conexoes (start/callback/client/tokens).
- tests/google_test.ts — 46 testes com dados sinteticos e fetch injetado.
- tests/google_connections_test.ts — 20 testes contra o Postgres local (sem OAuth real).
- supabase/migrations/20261005223942_google_oauth_pending.sql — pendencia OAuth privada (CLI).
- supabase/migrations/20261005224459_google_oauth_epoch.sql — epoch fence (oauth_epoch).

Os testes desta etapa foram locais, sem OAuth real ou escrita externa. Depois,
o app Google próprio foi configurado, a conta institucional conectada e leituras
nativas realizadas; o OAuth incremental Docs/Sheets/Slides de escrita também
concluiu. O lote sintético de cinco operações foi autorizado, mas as três
criações apenas foram preparadas para revisão por versão na interface. Nenhuma
escrita Google foi executada neste checkpoint. Ver STATUS.md e
docs/LOTE-GOOGLE-ESCRITA.md para o estado de produção.

## OAuth 2.0 / OpenID Connect

Fluxo implementado (web server):

1. createAuthorizationRequest gera state, nonce e PKCE S256, e monta a URL de autorizacao com
   response_type=code, access_type=offline e include_granted_scopes=true.
2. O chamador guarda a sessao pendente (InMemoryPendingAuthorizations) e envia o usuario ao
   consentimento. O consentimento e ato humano, fora deste codigo.
3. handleAuthorizationCallback valida, nesta ordem: erro do provedor; presenca de code e state;
   sessao pendente pelo state com uso unico; redirect_uri exato; validade temporal da sessao; troca
   do code com o code_verifier (PKCE); e o id_token.
4. A identidade estavel e o claim sub, nunca o texto do e-mail.

Validacao do id_token com a biblioteca jose (jwtVerify), exigindo iss, aud, exp, iat e sub:

- iss exatamente https://accounts.google.com.
- aud igual ao client_id; quando aud e um array, azp precisa ser o client_id.
- nonce igual ao nonce guardado na sessao.
- assinatura conferida contra as chaves JWKS atuais, com cache curto; se o kid do token nao estiver
  no cache, o JWKS e atualizado uma vez (rotacao de chaves).

Conta adicional: handleAuthorizationCallback aceita additionalAccount e devolve apenas identity e o
sessionId corrente. Ela nao substitui a sessao AraHub; o chamador vincula identity.subject ao
usuario atual. A escolha explicita da conta e o consentimento continuam humanos.

Escopos incrementais: include_granted_scopes=true faz o novo token incluir os escopos ja concedidos
ao mesmo usuario/cliente, sem exigir reconceder tudo. Use prompt=consent quando for preciso forcar
nova tela de consentimento.

Refresh token: peca access_type=offline. O Google costuma devolver o refresh token apenas na
primeira autorizacao; a resposta de refresh pode omiti-lo. Por isso o cofre preserva o refresh token
anterior quando a resposta nao traz um novo.

Fatos conferidos na documentacao primaria do Google:

- Verificacao de id_token e nonce:
  https://developers.google.com/identity/openid-connect/openid-connect
- Referencia OIDC (iss, aud, azp, jwks_uri, tokeninfo apenas para depuracao):
  https://developers.google.com/identity/openid-connect/reference
- Web server flow (access_type=offline, include_granted_scopes, prompt):
  https://developers.google.com/identity/protocols/oauth2/web-server
- Docs documents.get (includeTabsContent; sem ele, apenas a primeira aba):
  https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/get
- Sheets spreadsheets.get (includeGridData quando a mascara nao e fixa):
  https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/get
- Slides presentations.get (slides.googleapis.com/v1/presentations/{id}):
  https://developers.google.com/workspace/slides/api/reference/rest/v1/presentations/get

## Escopos: selecionados vs amplos

GOOGLE_NARROW_SCOPES (uso restrito, inclusive arquivos selecionados):

| Capacidade        | Escopo                 |
| ----------------- | ---------------------- |
| identidade        | openid, email, profile |
| Gmail leitura     | gmail.readonly         |
| Calendar leitura  | calendar.readonly      |
| Drive por arquivo | drive.file             |
| Docs leitura      | documents.readonly     |
| Sheets leitura    | spreadsheets.readonly  |
| Slides leitura    | presentations.readonly |

GOOGLE_BROAD_SCOPES (exigem revisao de politica Workspace e verificacao do app):

| Capacidade        | Escopo          |
| ----------------- | --------------- |
| Gmail modificacao | gmail.modify    |
| Calendar escrita  | calendar.events |
| Drive amplo       | drive           |
| Docs escrita      | documents       |
| Sheets escrita    | spreadsheets    |
| Slides escrita    | presentations   |

drive.file cobre apenas arquivos escolhidos ou criados pela aplicacao; nao promete descobrir todo o
Drive. Escopos amplos nao devem ser presumidos como isentos apenas porque o software e MIT e usado
por uma pessoa.

## Leitura

Cliente: GoogleReadClient, com accessToken e fetch injetaveis. Em producao o cliente recusa
endpoints fora dos dominios oficiais do Google antes de enviar Authorization; allowCustomEndpoints
existe apenas para fixtures.

| Servico  | Metodos                                                                      | Endpoint base                  |
| -------- | ---------------------------------------------------------------------------- | ------------------------------ |
| Gmail    | listGmailMessages, listGmailThreads, getGmailMessage, listGmailHistory       | gmail.googleapis.com/gmail/v1  |
| Calendar | listCalendars, listCalendarEvents                                            | www.googleapis.com/calendar/v3 |
| Drive    | getDriveStartPageToken, listDriveChanges, listDriveFiles, listDriveRevisions | www.googleapis.com/drive/v3    |
| Docs     | getDocument                                                                  | docs.googleapis.com/v1         |
| Sheets   | getSpreadsheet, getSpreadsheetValues                                         | sheets.googleapis.com/v4       |
| Slides   | getPresentation                                                              | slides.googleapis.com/v1       |

Docs, Sheets e Slides devolvem o JSON nativo integro, sem achatamento: o corpo da resposta e
retornado como veio (paragrafos, tabelas, formulas/valores e slides preservados). Eventos de
Calendar tambem sao devolvidos integros: recorrencia (recurrence) e dia inteiro (start.date sem
dateTime) permanecem no JSON.

Leitura nativa confirmada na documentacao primaria: documents.get aceita includeTabsContent=true
para ler abas (sem ele, so a primeira aba); spreadsheets.get aceita includeGridData=true quando a
mascara nao e fixa, preservando formulas/valores; presentations.get responde em
slides.googleapis.com/v1/presentations/{id}.

getDocument envia includeTabsContent=true por padrao (para desligar, includeTabsContent: false);
getSpreadsheet recebe includeGridData explicitamente (o MCP passa true).

## Paginacao e cursores

Toda leitura de lista e limitada por maxPages e maxItems e devolve BoundedPage com:

- coverage: complete, partial, denied, unavailable, expired, timeout ou parsing_error.
- nextCursor: gravavel apenas quando a leitura termina completa.
- resumeCursor: onde retomar uma leitura parcial; nunca substitui o cursor gravado.
- cursorAdvanced: verdadeiro apenas quando nextCursor pode avancar.

Regra central: o cursor so avanca em leitura completa. Sem isso, uma leitura parcial nao deve fazer
o sistema acreditar que leu tudo.

- Gmail history: startHistoryId expirado responde 404 e vira coverage=expired com
  reason=history_expired; o cursor nao avanca. Em leitura completa, o novo cursor e o historyId
  retornado.
- Calendar events: em leitura completa o cursor e nextSyncToken. syncToken invalido responde 410
  (fullSyncRequired) e vira coverage=expired; exige sincronizacao completa. Com syncToken,
  showDeleted=true e obrigatorio e timeMin/timeMax sao ignorados.
- Drive changes: em leitura completa o cursor e newStartPageToken. pageToken expirado responde 410 e
  vira coverage=expired.

## Erros

classifyGoogleHttpError mapeia:

| HTTP      | kind            | Uso                                                   |
| --------- | --------------- | ----------------------------------------------------- |
| 401       | expired         | token expirado/revogado; reautorizar                  |
| 403       | denied          | escopo insuficiente ou politica; nao repetir as cegas |
| 404       | unavailable     | recurso ausente (Gmail history trata como expired)    |
| 410       | expired         | sync token/pageToken invalido; reconstruir            |
| 429 e 5xx | unavailable     | retryable=true                                        |
| 400       | invalid_request | pedido malformado                                     |

Timeout do fetch vira kind=timeout. Falha de rede sem resposta vira kind=unavailable com
retryable=true.

Endurecimento de rede e erro:

- redirect manual; qualquer 3xx e recusado (reason=unexpected_redirect) e nunca seguido.
- o timeout cobre a leitura completa do corpo, nao apenas os cabecalhos.
- o corpo e limitado por Content-Length e por stream (reason=response_too_large).
- erros publicos sao estaveis: apenas kind, status e um reason de allowlist. message,
  error_description e cause do provedor nunca sao repassados, porque podem conter tokens.

## Cofre de tokens

Chave do ambiente: ARAHUB_TOKEN_VAULT_KEY (32 bytes em hex de 64 digitos ou base64/base64url).
Opcional: ARAHUB_TOKEN_VAULT_KEY_ID (padrao primary) e ARAHUB_TOKEN_VAULT_OLD_KEYS (array JSON de
objetos kid/material) para rotacao, em que a chave ativa cifra e as antigas ainda decifram.

AES-256-GCM com IV aleatorio por operacao e AAD amarrando o segredo a (ownerId, connectionId,
campo). O envelope selado carrega apenas v, alg, kid, iv e ct. toJSON e toString do cofre nao expoem
texto claro nem material de chave.

Persistencia concorrente (TokenStore):

- compareAndSwap troca apenas quando a versao lida ainda e a corrente (expectedVersion=0 cria se nao
  existir).
- persistRefreshedTokens rele a versao em conflito e tenta de novo, limitado por maxAttempts.
- Um refresh sem refresh_token na resposta preserva o valor selado anterior.

## Escrita: preparacao e aprovacao

prepareWrite monta PreparedWrite com preparedId, alvo (provider + resourceId), baseRevision e
payloadHash. O hash e o SHA-256 do JSON canonico (chaves ordenadas) que amarra alvo + payload; e
estavel independente da ordem das chaves e muda quando o alvo muda.

executePreparedWrite exige uma WriteApprovalAuthority confiavel, independente dos argumentos do
modelo. Um campo approved=true nos argumentos nunca e aceito como aprovacao. Antes de qualquer
consumo, o binding alvo+payload e recalculado: se o payload foi mutado depois da preparacao, a
execucao e recusada (reason=payload_mutated) mesmo com um recibo valido.

A autoridade consome o recibo atomicamente (um recibo autoriza uma unica execucao) e registra o
desfecho incerto antes de cruzar a fronteira externa. Se ja houver resultado anterior, ele e
devolvido sem reenvio; uma falha do executor vira estado incerto e nunca dispara repeticao as cegas.
O recibo precisa ter a marca trusted_ui e casar com preparedId, payloadHash, alvo, ownerId e
connectionId, alem de nao estar expirado.

O caminho integrado usa `PersistentActionStore` (`src/approval_store.ts`) como autoridade durável e `GoogleWrites` (`src/google_writes.ts`) como executor de operações nativas fixas. O MCP prepara; somente uma sessão humana na interface pode revisar e autorizar a versão. A Data API concede apenas SELECT nas tabelas de ações: nem navegador nem cliente OAuth podem fabricar uma aprovação ou um resultado. Hash/revisão são conferidos após o lock; aprovação expira, é consumida uma única vez e o estado incerto é persistido antes do envio. Sem store configurado, as ferramentas de produção não são registradas.

Operações implementadas: criar Docs, Sheets e Slides; criar uma planilha com células tipadas; inserir texto em posição/aba explícitas de Docs; acrescentar slide vazio com caixa de texto; substituir texto exato em slides selecionados. Docs/Slides conferem o ID da fonte, fixam `revisionId` e enviam `requiredRevisionId` no batchUpdate. Nenhuma ferramenta aceita requests arbitrários, envio de e-mail ou compartilhamento. Edição de células Sheets existentes continua pendente: a [API REST estável](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/batchUpdate) não oferece precondição atômica de revisão. Essa lacuna não encerra A21. [Docs writeControl](https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/batchUpdate) e [Slides writeControl](https://developers.google.com/workspace/slides/api/reference/rest/v1/presentations/batchUpdate).

`sheets_create` aceita `sheet_title` e `rows` opcionais. Cada célula é texto literal,
número finito, booleano, `null` (vazia) ou `{formula: "=SUM(A2:A3)"}`. Uma string
começando por `=` continua sendo texto, sem execução implícita. Fórmulas explícitas
aceitam aritmética e SUM/AVERAGE/MIN/MAX/COUNT/COUNTA/IF/ROUND, sem importação,
links ou referências externas. Limites por criação: 200 linhas, 50 colunas,
5.000 células, 48 KiB de conteúdo e 2.000 caracteres por célula. A criação envia
uma instância nativa de Spreadsheet com GridData no único POST; não há segundo
envio para preencher células. [Criação nativa](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/create),
[células tipadas](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/cells).

`slides_add_text` recebe apresentação, IDs novos do slide/caixa, texto e geometria
em pontos. Os padrões são x/y=40, largura=600 e altura=300; o executor confere que
a caixa cabe no tamanho nativo PT/EMU e recusa IDs existentes. Criação do slide,
caixa e inserção de texto integram um batchUpdate atômico na revisão fixada.
Texto de até 32.000 caracteres; IDs obedecem ao formato nativo de 5–50 caracteres.
A revisão humana mostra todas as células com endereço/tipo ou todo o texto e
geometria do slide, além de conta/destino; fontes hostis são renderizadas como texto.
Essa implementação não comprova a execução pelo Google real.

Prova local: 16 testes de autoridade/executores com Postgres real e fetch sintético,
incluindo células tipadas, limites, destino/revisão divergentes, geometria,
aprovação, corrida e resultado incerto sem reenvio. Dois testes de prévia e
interação Chrome em 390×844/1280×900, com capturas nativas inspecionadas.
A prova em conta/área reais permanece pendente; o lote revisável está em
[LOTE-GOOGLE-ESCRITA.md](LOTE-GOOGLE-ESCRITA.md).

## Conexoes persistentes (GoogleConnections)

Servico: src/google_connections.ts — GoogleConnections(hub, vault, config, deps).

- start(p, { label, scopes, connection_id? }): exige navegador (p.clientId ausente) e sessionId
  verificado; resolve escopos por allowlist explícita; grava a pendencia privada e devolve a URL de
  autorizacao e o state.
- callback(p, { code?, state, error? }): consome a pendencia atomicamente e valida code/id_token
  pelo adaptador. Owner, conexao e alvo vem da pendencia, nunca dos argumentos do callback.
- client(p, connection_id) e tokens(p, connection_id): leitura escopada pelo token selado, com
  refresh sob CAS e estado de expiracao persistido.
- list(p) e disconnect(p, connection_id) completam o ciclo.

Pendencia em arahub_private.oauth_pending: one-use, amarrada a owner + session + hash do state,
expira em 10 minutos; nonce, code_verifier e metadados ficam cifrados pelo cofre. O state bruto nao
e gravado, apenas o hash. A tabela nao recebe grant de Data API.

Escopos: capacidades de leitura identity, gmail_read, calendar_read, selected_files, drive_read, docs_read, sheets_read, slides_read. Capacidades incrementais de produção docs_write, sheets_write e slides_write são escolhas separadas na interface; precisam estar desejadas e concedidas. gmail.modify, calendar.events, drive amplo e escopos arbitrários continuam recusados. Conceder uma capacidade não aprova nenhum conteúdo.

selected_files mapeia drive.file. O Google concede a esse escopo escrita implicita sobre arquivos
escolhidos/criados pelo app; o AraHub NAO usa essa escrita
(capabilities.selected_files_implicit_write = false; writes_enabled depende das capacidades de produção explícitas). Isso nao
significa acesso ao Drive inteiro (drive_wide_discovery = false) nem Picker implementado
(picker_implemented = false).

Vinculo de conta: o subject verificado e estavel e fica em provider_subject. Uma conta Google (sub)
por dono (indice parcial unico owner_id + provider_subject para provider='google'); reconectar so
vale para a mesma conta e o mesmo alvo, e conta institucional (origin = dominio) fica separada da
pessoal (origin = personal). Desejados e concedidos sao gravados separadamente; o que nao foi
concedido aparece em denied_scopes e nunca e apresentado como sucesso.

Reconexao preserva o refresh token anterior quando a resposta o omite e usa CAS por versao. Estados
persistidos: pending, connected, expired, denied, revoked.

Autorizacao e concorrencia:

- start/callback/disconnect exigem navegador (sem clientId) e sessionId verificado. tokens/client/
  list usam apenas a identidade (aceitam clientId), porque o verificador HTTP/MCP externo ja
  allowlistou o cliente; isso nao autoriza login nem novo escopo.
- start escolhe a conta (prompt=select_account) em vinculo novo e forca prompt=consent quando a
  conexao existe sem refresh token; reconexao com refresh segue silenciosa. label e desired_scopes
  sao persistidos na conexao e na pendencia ja no start.
- Epoch fence: start incrementa hub_connections.oauth_epoch e liga a pendencia a esse epoch;
  disconnect incrementa de novo. O callback consome a pendencia e so confirma se o epoch ainda
  corresponde; caso contrario responde authorization_stale.
- Vinculo de identidade, credenciais e estado final acontecem numa unica transacao privilegiada com
  SELECT ... FOR UPDATE e checagem de epoch/owner: a identidade (provider_subject/origin) e
  reservada antes das credenciais, nunca troca para outro subject, e um subject unico concorrente
  vira account_already_connected sem deixar token orfao. A conexao fica pending ate as credenciais
  prontas e so entao vira connected.
- Negacao/erro de autorizacao marca denied apenas em conexao nova (pending); uma reauth negada
  preserva a conexao conectada e suas credenciais antigas.
- disconnect e atomico: incrementa o epoch, invalida pendencias do alvo, apaga credenciais e revoga.
  Um callback tardio ou em voo nao reativa a conexao nem guarda token.

## Testes

Comando: deno test --allow-env tests/google_test.ts

Resultado atual: 47 testes, 47 aprovados, 0 falhas. Cobrem PKCE/state/nonce, callback e suas
rejeicoes, conta adicional, atualizacao de JWKS por kid novo, escopos, cofre (roundtrip, AAD errado,
ausencia de plaintext nos exports, chave por ambiente), CAS e conflito de versao, preservacao do
refresh token, paginacao parcial/completa, 404 do Gmail, 410 do Calendar e do Drive, JSON nativo de
Docs/Sheets/Slides, classificacao de erros, recusa de 3xx, timeout na leitura do corpo, limites de
bytes por Content-Length e por stream, ausencia de vazamento de token em erros, recusa de endpoint
fora do Google, e o fluxo de escrita (payload mutado, recibo divergente, trusted_ui, ja consumido,
incerto anterior, falha do executor).

Servico persistente: deno test --allow-net=127.0.0.1:55432 --allow-env
tests/google_connections_test.ts — 22 testes, 22 aprovados, 0 falhas, contra o Postgres local.
Cobrem guarda de navegador/sessao, allowlist de escopos, pendencia one-use amarrada a owner+sessao,
callback feliz sem vazamento de segredos, uso unico, erro do provedor consumindo a pendencia,
vinculo de conta e separacao institucional/pessoal, preservacao de refresh na reconexao, leitura
escopada com refresh sob CAS, expiracao para estado expired, selected_files, leituras MCP com
clientId, prompt de escolha/consentimento, desired_scopes/epoch no start, denied sem destruir a
conectada, callback superado (authorization_stale) e disconnect concorrente sem reativacao.

## Limites e pendencias

- Aplicativo próprio Externo/Testing e OAuth humano institucional foram configurados no lote autorizado. Leituras reais e refresh CAS 1→2 comprovados; ensaios com id_token local/fetch injetado permanecem classificados como sintéticos. Segunda conta e operação permanente não comprovadas.
- As referências primárias de [Docs](https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/get), [Sheets](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/get) e [Slides](https://developers.google.com/workspace/slides/api/reference/rest/v1/presentations/get) foram conferidas. O MCP pede conteúdo de todas as abas do Docs e grid data no Sheets; as respostas permanecem nativas. Docs/Slides reais lidos; titular confirmou que não há planilha nativa, portanto Sheets tem somente prova sintética.
- Autoridade e executor integrados foram testados localmente com provedores sintéticos; a prova real de A22 continua pendente. Nenhuma autorização de capacidade foi exercida em conta real.
- Calendar nao expande semanticamente recorrencia nem converte prazos; apenas preserva o JSON. A
  interpretacao de dia inteiro e fusos e responsabilidade da camada de dominio.
- Testar escrita real exige area de teste explicitamente autorizada e o store de aprovacao; sem isso
  a prova real fica pendente, nao aprovada.
- Migrations criadas pelo CLI (npx --yes supabase@2.119.0): 20261005223942_google_oauth_pending.sql
  e 20261005224459_google_oauth_epoch.sql; aplicar localmente com deno task db:setup.
- Rotas HTTP de start/callback estão integradas ao backend hospedado; a UI separa a escolha da conta da sessão AraHub e remove os parâmetros do callback antes de inicializar Supabase Auth. `tests/google_http_test.ts` comprova o ciclo HTTP/MCP sintético, recusa de callback com outro dono e consulta sem capacidade consentida. Consentimento humano e verificação limitada por ícone comprovados na sessão titular.
- getDocument envia includeTabsContent=true por padrão; leitura nativa de documento real comprovada, sem afirmar cobertura de todos os documentos da conta.
- Gmail/Drive: duas páginas reais de até três itens sem repetição, ambas parciais. Calendar: lote inicial em janela de cinco minutos e repetição incremental concluídos, cursor durável conferido pelo MCP. A janela não trouxe eventos; não comprova atualização de conteúdo, recuperação de erro ou operação contínua.
- selected_files nao implementa Picker nem concede acesso ao Drive inteiro.

O refresh persistente também é ligado ao epoch da conexão: um retorno antigo não substitui o consentimento novo mesmo quando a versão da credencial reinicia após desconexão. `tests/token_epoch_test.ts` comprova esse caso. Este cofre armazena credenciais cifradas; a chave tem recuperação separada e não está em fixtures ou exportações de memória.
