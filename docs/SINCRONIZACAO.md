# Sincronização de conteúdo Moodle

Estado, limites e contrato do lote durável dirigido por curso em `src/sync.ts`.
Complementa `docs/MOODLE.md` (adaptador) e a matriz A16/A18/A30.

## Superfície

- `Sync.courses(p, connectionId)`: lote de cursos da conta. Comportamento
  preservado; devolve `{ job, directed }`.
- `Sync.courseContent(p, connectionId, courseId)`: lote dirigido de um curso.
  Devolve `{ job, directed, summary }`.
- `Sync.course(p, connectionId, courseId)`: alias de `courseContent`.
- `Sync.run(p, expectedId?)`: reivindica e executa um lote pendente; devolve
  `{ state: "idle" }` quando não há lote.
- `new Sync(hub, connections, options?)`: `options.forumCallBudget` ajusta o
  orçamento de chamadas da fase de fóruns por execução (padrão
  `MAX_SYNC_FORUM_CALLS_PER_RUN = 40`; mínimo útil 2).

`courseContent` exige `courseId` inteiro positivo; caso contrário
`HubError invalid_id`.

Todo lote é reivindicado por `Jobs.claim` com `attempts < 5`; o claim serializa o
escopo exato (owner + conexão + kind) com lock de transação por chave e recusa
um lote irmão ativo, devolvendo `null` — então `Sync.run` responde
`{ state: "idle" }` quando o escopo está ocupado. Logo depois do claim,
`Sync.run` chama `withJobLease(p, job.id, job.attempts)` **antes** da primeira
escrita: o `asOwner` renova/cerca cada escrita pelo attempt ativo (chave de
runtime, fora do request) e recusa com `job_conflict` uma posse já perdida.
`Jobs.finish` grava `state` (`complete`/`partial`/`failed`/`expired`) e só
persiste o cursor do job quando a cobertura é `complete`.

## Kind do job e retomada

O lote dirigido usa kind `moodle_course:<courseId>`. O id do curso fica no
próprio `hub_jobs.kind`, então um lote reivindicado depois por outro processo
sabe qual curso ler, sem depender da memória do processo que enfileirou. O lote
de cursos continua `moodle_courses`. `src/jobs.ts` não foi alterado.

## Checkpoint durável da travessia de fóruns

O provedor pagina discussões (parâmetro `page`/`perpage`) e o adaptador fatia
posts por `offset`/`limit` **localmente** sobre a lista completa retornada por
`mod_forum_get_discussion_posts`. Para não repetir para sempre a janela
`page: 0` / `offset: 0`, a posição da travessia é durável:

- Privado por owner + conexão + curso, gravado em `hub_entities(state)` com
  `kind = "sync_checkpoint"` e `external_id = "course/<courseId>"`. A unicidade
  `(owner_id, connection_id, kind, external_id)` fecha exatamente essa chave.
- Estado: `{ version, course_id, forum_index, discussion_page,
  discussion_index, discussion_id, post_offset, updated_at }` mais
  `forum_id` (guarda de reordenação).
- Ausência ou estado malformado equivale a travessia nova; um estado com
  `completed: true` é inerte e também reinicia.
- **Reset só após a travessia completa.** Como o papel `authenticated` tem
  `select/insert/update` em `hub_entities` mas não `delete`, o reset grava um
  marcador `{ completed: true, ... }` em vez de apagar a linha. A linha vira
  inerte (uma por curso), nunca é removida.
- **Falha mantém o ponteiro.** O estado só é gravado ao fim de cada execução
  quando a travessia ficou incompleta; uma exceção no meio da execução deixa o
  ponteiro anterior intacto (a retomada refaz, não pula).
- **Nunca pula pós-truncamento.** Ao esgotar uma janela de posts
  (`truncated`), a próxima grava `post_offset + 100` e continua a mesma
  discussão; ao esgotar uma página de discussões (`has_more`), avança
  `discussion_page`; a discussão corrente é localizada por `discussion_id` na
  página antes de retomar (se o provedor reordenar, o offset volta a 0 em vez de
  pular).
- **Guarda de reordenação de fóruns.** O ponteiro guarda `forum_id` junto de
  `forum_index`. Ao retomar, o `forum_id` é localizado na lista atual: se a
  posição não coincide com a salva (lista reordenada ou fórum removido), a
  posição não prova que os fóruns anteriores já foram percorridos, então a
  travessia recomeça do início (upsert/observação são idempotentes) em vez de
  pular um fórum ainda pendente.

## Execução bounded e janelas

Cada chamada a `courseContent`/`run` executa no máximo `forumCallBudget`
chamadas da fase de fóruns/discussões/posts. Ao esgotar, a execução termina
`partial` (lacuna `discussions`/`posts`), grava a próxima janela no checkpoint
e retorna. A janela seguinte é retomada na próxima chamada.

Não há corte permanente de fóruns nem teto de páginas por fórum. A lista
completa do provedor entra na travessia; cada execução persiste e percorre
apenas os fóruns que o orçamento alcança, então listas com mais de 50 fóruns são
percorridas por completo ao longo de várias retomadas. Janela de discussões:
`perpage` de até `MAX_SYNC_DISCUSSIONS_PER_FORUM = 20`; janela de posts:
`MAX_SYNC_POSTS_PER_DISCUSSION = 100` por chamada. Um provedor que sempre
reporte `has_more` fica limitado pelo orçamento **por execução** (a página
seguinte vai para o checkpoint), sem laço infinito e sem `complete` falso.
`forumCallBudget` mínimo é 2: com 1 a execução gastaria tudo na página de
discussões e nunca avançaria uma discussão, então valores menores são elevados
ao padrão.

`summary.checkpoint` expõe `{ resumed, pending, forum_id, forum_index,
discussion_page, discussion_index, post_offset }`. `summary.bounded` lista as
janelas e o orçamento por execução (`forum_calls_per_run`).

## Cobertura, lacunas e cursor

- Cada etapa registra cobertura. A cobertura do lote é a pior entre as etapas:
  `complete < partial < timeout < parsing_error < unavailable < denied <
  expired`.
- `summary.gaps` lista cada etapa não completa uma vez:
  `{ stage, coverage, error_code, moodle_code }`.
- Funções ausentes ou recusadas do token viram lacunas (`function_unavailable`),
  nunca exclusão de conteúdo já observado; conclusão do curso sem critério
  (`nocriteriaset`) continua lacuna.
- Um corte local (orçamento esgotado) força `partial`; um resultado truncado
  nunca é `complete`.
- O cursor do job só é persistido quando a cobertura é `complete`
  (`{ course_id, observed_at }`). Em `partial` o cursor anterior é mantido
  (`Jobs.finish`). O checkpoint durável é independente do cursor do job.

## Idempotência, proveniência e estado

- Observações são inseridas de forma independente e deduplicadas por
  `(owner_id, entity_id, content_hash)`: repetir a sincronização não duplica
  conteúdo, inclusive quando uma execução é refeita após falha.
- Relações qualificadas em `hub_relations`: `has_section`, `has_module`,
  `has_content`, `has_discussion`, `has_post`, `has_item`,
  `tracks_completion`, `has_completion`.
- IDs de módulo são estáveis dentro do curso ao mudar de seção. O estado e a
  observação novos registram a seção atual; a relação antiga não é apagada.
  O grafo do pacote compara `section_id`/`course_id` atuais antes de derivar
  materiais da mesma seção, evitando tratar a relação antiga como atual.
  Observações históricas têm paginação e leitura por trechos no MCP.
- O upsert de entidade mescla o estado (`state = hub_entities.state ||
  excluded.state`) para não sobrescrever dimensões do usuário (`user_report`,
  memória, edição). Posts guardam `author_userid`. O checkpoint, ao contrário,
  substitui o estado (`state = excluded.state`).

## Custo de uma travessia

O custo de uma travessia completa cresce com fóruns e discussões: ao menos 1
chamada de página de discussões por fórum (mais paginação quando `has_more`) e
ao menos 1 chamada de posts por discussão. Cada retomada bounded entrega até
`forumCallBudget` (padrão 40) dessas chamadas e também refaz a estrutura fixa do
curso (listagem, seções/módulos, páginas, livros, recursos, urls, fóruns,
feedback, assignments, conclusão: ~13 chamadas) e a página de discussões
corrente. Não há agendamento (cron): a retomada depende de uma nova chamada a
`courseContent`/`run` ou do retry do lote.

## Riscos e limitações

- **Lista grande de fóruns**: sem corte permanente, mas a travessia completa de
  uma lista enorme exige várias retomadas (o fórum seguinte fica no checkpoint);
  até concluir, o curso permanece `partial`, sem perder o que já foi observado.
- **Provedor com `has_more` patológico**: a heurística do adaptador é
  `has_more = (retornados == perpage)`; um provedor que sempre reporte
  `has_more` é limitado pelo orçamento por execução e permanece `partial` entre
  execuções, em vez de laço infinito em uma execução.
- **Órfão inerte**: como não há `delete`, cada curso que precisou de mais de uma
  execução deixa uma linha `sync_checkpoint` concluída, visível em listagens de
  `hub_entities`.
- **Concorrência**: não há lock próprio no checkpoint, mas o escopo é serializado
  pelo `Jobs.claim` (owner + conexão + kind, lock de transação por chave e recusa
  de irmão ativo) e cada escrita é cercada pelo lease via `withJobLease` aplicado
  no `Sync.run` após o claim. Duas execuções do mesmo curso não sobrescrevem o
  ponteiro uma da outra: a que perder o lease tem a escrita seguinte recusada
  (`job_conflict`) e não deve finalizar com recibo obsoleto.
- **Orçamento mínimo**: `forumCallBudget` deve caber ao menos uma busca de
  página mais uma chamada de posts (na prática ≥ 2); valores abaixo de 2 são
  elevados ao padrão no construtor.
- **Sem cron**: nada agenda reexecuções; janelas pendentes permanecem até nova
  chamada.

## Fora do escopo (permanecem lacunas)

- Notas próprias (`gradereport_user_get_grade_items`) e status de submissão
  (`mod_assign_get_submission_status`) continuam bloqueados.
- Nenhuma API de view, escrita, tentativa ou mensagem é usada.
- Conclusão do curso indisponível (ex.: `nocriteriaset`) aparece como lacuna,
  não como exclusão.

## Testes

```powershell
deno check src/sync.ts tests/sync_content_test.ts
deno test --allow-net=127.0.0.1:55432 --allow-env --allow-read --allow-write=.private tests/sync_content_test.ts
deno fmt src/sync.ts tests/sync_content_test.ts
```

O arquivo tem **8 testes dirigidos** (todos aprovados na última execução local).
Cobrem: hierarquia, dedup idempotente e isolamento por principal; capacidade
ausente com lacuna explícita (`no criteriaset`); travessia em 2 páginas de
discussões com uma discussão de 150 posts retomada por checkpoint entre
reinícios de processo; e um lote novo após 5 tentativas esgotadas retomando o
estado durável. Ainda cobrem: lista com 55 fóruns percorrida por completo em
várias execuções bounded (o 55º, além do antigo corte, é alcançado); retomada de
uma página de discussões além do antigo teto de 50 a partir de um checkpoint
semeado em `discussion_page = 50`; reordenação da lista de fóruns, em que a
guarda por `forum_id` recomeça a travessia em vez de pular o fórum pendente; e a
integração do lease no `Sync` (escopo ocupado devolve `idle`; a posse perdida é
cercada e não finaliza o lote). Docker/Postgres exclusivo local com SQL real;
fixture de provedor injetada, sem rede externa nem credenciais reais.
