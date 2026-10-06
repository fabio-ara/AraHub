# Sincronização de leitura do Google (Gmail, Calendar, Drive)

Estado, contrato e limites de `src/google_sync.ts`. Complementa `docs/GOOGLE.md` (adaptador
OAuth/leitura) e a matriz A16/A18/A30. Esta etapa é somente leitura: nenhum envio, marcação de lida,
rascunho, escrita remota, novo consentimento ou alteração em repositórios irmãos.

## Superfície

Classe `GoogleSync(hub, connections)`. Cada método enfileira um lote retomável via `Jobs` e o
executa até o limite local, devolvendo `{ job, directed, summary }`:

- `gmail(p, connectionId, input?)` — consulta dirigida + `history` incremental, com reconstrução
  limitada quando o histórico expira.
- `calendar(p, connectionId, input?)` — sincronização por calendário com `syncToken` e reconstrução
  limitada.
- `drive(p, connectionId, input?)` — `changes` com `startPageToken` e reconstrução limitada por
  seleção.
- `run(p, jobId)` — reivindica e executa um lote específico (retomada dirigida).
- `pending(p)` — lista lotes de sincronização Google do dono (insumo para o root retomar/estender um
  lote).
- `state(p, connectionId, externalId?)` — cursor e checkpoint duráveis por chave. O `updated_at`
  devolvido é projetado de `state->>'updated_at'` (o `hub_entities` não tem coluna de tempo).

Entradas (todas opcionais; os defaults são limitados):

- Gmail: `query`, `label_ids`, `message_limit`, `limits`, `rebuild`, `rebuild_window_days`.
- Calendar: `calendar_id`, `time_min`, `time_max`, `limits`, `rebuild`.
- Drive: `drive_id`, `selection_query`, `limits`, `rebuild`.

`limits` é `{ maxPages?, maxItems? }` (mesmo tipo de `BoundedPage`). Sem `limits`, valem
`maxPages=25`, `maxItems=1000`.

## Chave durável e kind do job

A consulta/calendário/drive define a identidade da sincronização: `google_sync:<kind>:<hash16>`
(hash SHA-256 do descritor canônico). Esse mesmo valor é o `kind` do job e o `external_id` da
entidade de estado, então um lote reivindicado depois por outro processo sabe o que ler e onde
retomar, sem depender da memória do processo que enfileirou.

O estado fica numa entidade própria (`kind = google_sync_state`, `external_id =
kind do job`) com
`descriptor`, `limits`, `cursor`, `cursor_kind`, `resume`, `coverage`, `mode`, `rebuilt` e
`truncated`. Chamar o mesmo método de novo (mesma chave) continua do checkpoint; o estado é mesclado
(`jsonb ||`), nunca apagado.

## Cursor, retomada e cobertura

Regra central: **o cursor só avança quando todas as páginas da janela pedida terminam completas**.
Em leitura parcial o cursor anterior é mantido e um checkpoint de retomada é gravado em `resume` (no
estado durável e em `coverage.next_checkpoint` do job); nada é descartado em silêncio.

A retomada usa o `pageToken` real das APIs oficiais. `listGmailHistory` e `listCalendarEvents`
aceitam `pageToken` opcional, então a chamada seguinte continua da página seguinte sob a mesma
consulta/`startHistoryId`/`syncToken`, sem relistar páginas já concluídas nem pular itens. Quando o
truncamento acontece dentro de uma página (por `message_limit`), os ids restantes ficam em
`resume.pending_ids` e a listagem é marcada como concluída (`resume.history_complete`): a retomada
esvazia os pendentes e finaliza o cursor sem repetir a página já lida.

O `historyId` do Gmail é um decimal que pode exceder 2^53. Ele é normalizado, comparado e
serializado como string (por comprimento e depois lexicograficamente), sem passar por `Number` nem
`Math.max`, para não perder precisão no cursor.

- `coverage` do lote é a pior entre as etapas efetivamente concluídas; a expiração recuperada por
  reconstrução entra em `gaps` (informativo) e não rebaixa a cobertura final.
- `summary.resume` mostra o ponto de retomada; `summary.counts` e `summary.gaps` (com `stage`,
  `coverage`, `error_code`) tornam o truncamento explícito.
- `Jobs.finish` continua decidindo o estado do job (partial/complete/expired); como o checkpoint
  vive no estado durável, uma nova chamada ao método (job novo, `attempts=0`) retoma de onde parou
  mesmo depois do teto de tentativas.

### Gmail

- Sem cursor: consulta dirigida (`messages.list` + `messages.get` format `full`), limitada por
  `maxPages`/`maxItems` e por `message_limit` (default 25).
- Cursor presente: `history.list` desde o `historyId` comprometido, retomável por `pageToken`
  (`resume.page_token`) sob o mesmo `startHistoryId`; o novo cursor é o `historyId` terminal da
  leitura completa, gravado só quando todas as páginas e as mensagens pendentes terminam.
- `history.list` expirado (404 → `coverage=expired`, `reason=history_expired`): reconstrução por
  consulta limitada, com janela opcional `newer_than:<N>d` (`rebuild_window_days`, default 30),
  refazendo o cursor a partir do maior `historyId` observado.
- Mensagens que não couberam em `message_limit` ficam em `resume.pending_ids` e são buscadas antes
  de continuar a listagem. Se a listagem já terminou, `resume.listing_complete`/`next_history_id`
  permitem drenar os pendentes e fechar o cursor sem relistar a última página.

### Calendar

- Sem cursor: leitura completa limitada por janela (`time_min`/`time_max`; default −30d a +90d) e
  por `limits`; o cursor é o `nextSyncToken`.
- Cursor presente: `events.list` com `syncToken` (com `showDeleted=true`), retomável por `pageToken`
  reusando o mesmo `syncToken` até a última página trazer o `nextSyncToken` — único ponto em que o
  cursor avança.
- `syncToken` inválido (410 `fullSyncRequired` → `coverage=expired`): reconstrução delimitada pela
  mesma janela. A janela (`time_min`/`time_max`) é persistida em `resume` na primeira truncagem e
  reusada nas retomadas, para que o `pageToken` continue válido; a reconstrução também retoma por
  `pageToken` até completar.
- Recorrência (`recurrence`) e dia inteiro (`start.date` sem `dateTime`) são preservados no JSON
  nativo; não há expansão nem conversão. Eventos `cancelled` são observados (não apagados).

### Drive

- `drive.readonly`: cursor é o `newStartPageToken`; incremental por `changes.list`. Cursor expirado
  (410) → reconstrução por seleção limitada (`files.list` com `limits` e `selection_query`
  opcional) + novo `startPageToken`.
- `drive.file` (capacidade `selected_files`) apenas: sem `changes.list` (indisponível nesse escopo),
  apenas seleção limitada; sem cursor de changes.
- Remoções (`removed=true`) são observadas como mudança; a entidade do arquivo não é apagada.

## Persistência, proveniência e deduplicação

- Entidades qualificadas por `(owner, conexão, kind, external_id)`: `gmail_message`,
  `gmail_history`, `calendar_event`, `drive_change`, `drive_file`.
- Observações imutáveis deduplicadas por `(owner, entity, content_hash)`; o conteúdo é o JSON nativo
  do provedor.
- `provenance = { system: "google", connection_id, locator, observed_at, ... }` com localizador
  qualificado (`google:gmail/message/<id>`, `google:calendar/<id>/event/<id>`,
  `google:drive/change/<id>`).
- O estado da entidade é mesclado com `jsonb ||`: a projeção do provedor não sobrescreve dimensões
  do usuário. Ausência ou leitura parcial não apaga nada.

## Escopos e capacidades

Mesma allowlist de `GoogleReads`: a capacidade precisa estar **desejada e concedida** na conexão.

- Gmail → `gmail_read` (`gmail.readonly`).
- Calendar → `calendar_read` (`calendar.readonly`).
- Drive → `drive_read` (`drive.readonly`) ou `selected_files` (`drive.file`).

Capacidade ausente vira lacuna explícita (`coverage=denied`, `error_code=scope_required`) sem tocar
conteúdo. O dono vem sempre do principal derivado (`p.ownerId`), nunca de argumentos; conexão de
outro dono responde `not_found`.

## Superfície MCP

Os métodos estão ligados ao MCP em `src/mcp.ts`; nenhuma ferramenta concede novo escopo nem altera o provedor. `hub_google_sync_state` consulta os checkpoints por conexão e chave. O teste HTTP/SDK consulta Drive, retoma o estado e verifica ausência de credenciais nas respostas.

| Ferramenta                 | Argumentos                                                                                               |
| -------------------------- | -------------------------------------------------------------------------------------------------------- |
| `hub_google_sync_gmail`    | `connection_id`, `query?`, `label_ids?`, `message_limit?`, `limits?`, `rebuild?`, `rebuild_window_days?` |
| `hub_google_sync_calendar` | `connection_id`, `calendar_id?`, `time_min?`, `time_max?`, `limits?`, `rebuild?`                         |
| `hub_google_sync_drive`    | `connection_id`, `drive_id?`, `selection_query?`, `limits?`, `rebuild?`                                  |
| `hub_google_run_sync`      | `job_id`                                                                                                 |

Anotações: escrita apenas no espelho privado; `openWorldHint: true`; não marca leitura nem altera a
plataforma.

## Testes

```powershell
deno check src/google_sync.ts tests/google_sync_test.ts
deno test --allow-net=127.0.0.1:55432 --allow-env tests/google_sync_test.ts
deno fmt src/google_sync.ts tests/google_sync_test.ts
```

15 testes, 15 aprovados, 0 falhas (SQL real no Postgres exclusivo; fixture do provedor com `fetch`
injetado nos endpoints oficiais). Cobrem: consulta dirigida, history incremental, reconstrução após
expiração do histórico, paginação limitada sem avançar cursor com retomada, `syncToken` inválido
preservando recorrência/dia inteiro, `startPageToken` + `changes` + reconstrução por cursor
expirado, remoção observada sem apagar, `drive.file` sem `changes`, capacidade ausente e isolamento
por principal. A retomada real por `pageToken` é verificada com três páginas de `history.list` e de
`events.list` (incremental e janela), uma página por chamada (`maxPages=1`): cada página é pedida uma
única vez sob a mesma consulta/`startHistoryId`/`syncToken`, o cursor anterior é preservado até a
janela completar e o truncamento por `message_limit` não relista a página nem pula itens. Um teste
próprio cobre `state()` projetando `updated_at` do `jsonb` sem usar coluna inexistente; outro cobre a
precisão do `historyId` acima de 2^53 e a retomada da leitura inicial por `pending_ids` sem relistar a
página.

## Limites e pendências

- Fixture de provedor; nenhuma conta Google real conectada. Não é prova de aceitação do tenant real.
- `history.list` do Gmail e `events.list` do Calendar aceitam `pageToken` opcional no adaptador; a
  retomada continua da página seguinte com o checkpoint durável, sem depender de ampliar `limits`.
- `changes.list` exige `drive.readonly`; `drive.file` cobre apenas seleção.
- Recomendação ao root: `Jobs.claim` devolve `id, connection_id, kind, cursor,
  attempts` (sem
  `coverage`). A retomada aqui não depende disso (o checkpoint é durável na entidade de estado). Se
  o root quiser retomada a partir do próprio job, uma extensão aditiva de `Jobs.claim` para também
  devolver `coverage` é segura e não exige mudança neste módulo.
- Escritas Google (`docs_write`/`sheets_write`/`slides_write` e afins) não são usadas aqui; leitura
  estrita.
