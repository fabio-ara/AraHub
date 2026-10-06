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

Todo lote é reivindicado por `Jobs.claim` com `attempts < 5`; `Jobs.finish`
grava `state` (`complete`/`partial`/`failed`/`expired`) e só persiste o cursor
do job quando a cobertura é `complete`.

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
  discussion_index, discussion_id, post_offset, updated_at }`.
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

## Execução bounded e janelas

Cada chamada a `courseContent`/`run` executa no máximo `forumCallBudget`
chamadas da fase de fóruns/discussões/posts. Ao esgotar, a execução termina
`partial` (lacuna `discussions`/`posts`), grava a próxima janela no checkpoint
e retorna. A janela seguinte é retomada na próxima chamada. Fóruns por execução:
até `MAX_SYNC_FORUMS = 50`; janela de discussões: `perpage` de até
`MAX_SYNC_DISCUSSIONS_PER_FORUM = 20`; janela de posts:
`MAX_SYNC_POSTS_PER_DISCUSSION = 100` por chamada. Um teto
`MAX_SYNC_DISCUSSION_PAGES_PER_FORUM = 50` protege contra um provedor que
sempre reporte `has_more`.

`summary.checkpoint` expõe `{ resumed, pending, forum_index, discussion_page,
discussion_index, post_offset }`. `summary.bounded` lista os tetos e o
orçamento por execução (`forum_calls_per_run`).

## Cobertura, lacunas e cursor

- Cada etapa registra cobertura. A cobertura do lote é a pior entre as etapas:
  `complete < partial < timeout < parsing_error < unavailable < denied <
  expired`.
- `summary.gaps` lista cada etapa não completa uma vez:
  `{ stage, coverage, error_code, moodle_code }`.
- Funções ausentes ou recusadas do token viram lacunas (`function_unavailable`),
  nunca exclusão de conteúdo já observado; conclusão do curso sem critério
  (`nocriteriaset`) continua lacuna.
- Um corte local (orçamento esgotado, `forums` > 50, teto de páginas) força
  `partial`; um resultado truncado nunca é `complete`.
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
- O upsert de entidade mescla o estado (`state = hub_entities.state ||
  excluded.state`) para não sobrescrever dimensões do usuário (`user_report`,
  memória, edição). Posts guardam `author_userid`. O checkpoint, ao contrário,
  substitui o estado (`state = excluded.state`).

## Custo e o caso "50 fóruns × 20 discussões"

O custo de uma travessia completa cresce com fóruns e discussões: até 50
chamadas de página de discussões (1 por fórum quando todas cabem na janela) mais
ao menos 1 chamada de posts por discussão (até 50 × 20 = 1000), antes de
qualquer paginação extra de posts. **Isso segue grande**: ~1050+ chamadas, ou
~27 execuções bounded no orçamento padrão de 40. Cada retomada também refaz a
estrutura fixa do curso (listagem, seções/módulos, páginas, livros, recursos,
urls, fóruns, feedback, assignments, conclusão: ~13 chamadas) e refaz a página
de discussões corrente. Não há agendamento (cron): a retomada depende de uma
nova chamada a `courseContent`/`run` ou do retry do lote.

## Riscos e limitações

- **`forums` > 50**: corte duro em `MAX_SYNC_FORUMS`, sem paginação de fóruns;
  o curso fica `partial` permanente com lacuna `forums`, sem perder o que já
  foi observado.
- **Provedor com `has_more` patológico**: a heurística do adaptador é
  `has_more = (retornados == perpage)`; um provedor que sempre reporte
  `has_more` fica limitado pelo teto de páginas e permanece `partial` (lacuna
  `discussions_pages`), em vez de laço infinito.
- **Órfão inerte**: como não há `delete`, cada curso que precisou de mais de uma
  execução deixa uma linha `sync_checkpoint` concluída, visível em listagens de
  `hub_entities`.
- **Concorrência**: o checkpoint não tem lock próprio. Duas execuções
  simultâneas do mesmo curso (owner + conexão) podem sobrescrever o ponteiro uma
  da outra; recomenda-se single-flight por curso. `Jobs.claim` serializa apenas
  o mesmo job.
- **Orçamento mínimo**: `forumCallBudget` deve caber ao menos uma busca de
  página mais uma chamada de posts (na prática ≥ 2); orçamento 1 gasta tudo na
  página e não progride.
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

Cobrem: hierarquia, dedup idempotente e isolamento por principal; capacidade
ausente com lacuna explícita (`no criteriaset`); travessia em 2 páginas de
discussões com uma discussão de 150 posts retomada por checkpoint entre
reinícios de processo; e um lote novo após 5 tentativas esgotadas retomando o
estado durável. Docker/Postgres exclusivo local com SQL real; fixture de
provedor injetada, sem rede externa nem credenciais reais.
