# Memória, materiais e atenção

Este documento descreve a projeção de atenção/obrigações, a persistência de
ocorrências de observação (caso A→B→A) e o contrato MCP que a raiz integra. Nada
aqui altera o Moodle: não há marca de leitura, conclusão ou escrita acadêmica.

## Obrigações e atenção

`Attention.overview` (`src/attention.ts`) reutiliza as tabelas existentes —
`hub_entities`, `hub_observation_timeline`, `hub_relations`, `hub_context_targets`,
`hub_deltas` e `hub_actions` — sem esquema novo. Escopo por `connection_id` e por
`context_id` (alvos ativos do contexto), paginado por `offset`/20 itens.

Cada obrigação separa dimensões que não podem ser fundidas:

- **fonte**: a última ocorrência preservada (`observation_id`, `content_id`,
  `content_hash`, `coverage`, `observed_at`, proveniência). Quando o conteúdo
  vigente do provedor (`hub_entities.state.provider_record`) difere do snapshot da
  ocorrência mais recente, a base vira
  `current_state_with_unrecorded_reobservation` e a lacuna é explícita — não se
  afirma a data da mudança.
- **prazos múltiplos**: `deadlines` traz os campos de prazo da fonte (epoch Unix
  `duedate`, `cutoffdate`, `allowsubmissionsfromdate`, `gradingduedate`)
  normalizados por `normalizeTime`, cada um com seu nome de campo. Uma coluna
  `due_date` não representa duas obrigações distintas.
- **afirmações interpretadas**: `requirements` e `requirement_deadlines` trazem as
  obrigações do enunciado registradas por `recordRequirement`, com trecho e hora
  ausente permanecendo ausente.
- **colegas**: `colleagues.distinct_colleagues` conta autores distintos nas
  postagens preservadas, excluindo a conta vinculada (`provider_subject`);
  `colleagues.colleagues_answered_by_owner` conta apenas respostas da conta a post
  de outro autor. `colleague_requirements` compara numericamente o exigido com o
  observado (`observed_meets_at_least`) e não declara qualidade acadêmica.
- **relato, rascunho e apresentado/lido**: `state.user_report`, `state.drafts`
  (deltas `artifact` ligados por escopo ou alvo de contexto), `state.presented` e
  `state.read`. `state.native_platform` expõe a conclusão nativa do Moodle como
  sinal separado.
- **evidência de entrega**: `user_report` ou recibo confirmado de ação acadêmica.
  Conclusão nativa **não** substitui relato nem recibo.

`attention` lista mudanças: `not_presented`, `changed_since_presented`,
`changed_since_read`, `access_lost`, `incomplete_coverage`, `deadline_near`,
`requirement_not_interpreted`, `submission_evidence_missing` e
`unrecorded_reobservation`.

## Recibo de ação acadêmica

MoodleActions grava `hub_actions.target` como `course/cmid/instance`, não um
localizador de URL. A correspondência é qualificada pelo envelope canônico do
snapshot (`{connectionId, operation, target, revision, content}`, com
`content.target = {course_id, cmid, instance_id, discussion_id?, parent_id?}`):
exige a mesma conexão e os mesmos `course_id`/`cmid`/`instance_id` da entidade, e
só restringe discussão/post quando os dois lados declaram os IDs. Só
`state = 'succeeded'` conta; um recibo de outra atividade não é atribuído.

## Obrigações estruturadas (não regex)

`recordRequirement` registra uma obrigação explícita interpretada do enunciado com
`observation_id` (ocorrência) + `content_hash` (fixa a versão interpretada),
`excerpt` literal, `action`, `quantity` opcional (`colleagues_distinct` +
`at_least`) e `deadline` opcional (`original_text` e, quando resolvível, `date`;
não há campo de hora). Não há quantidade fixa de obrigações nem regex sobre prosa.

A persistência reusa o que existe: cria/atualiza uma entidade de tipo
`academic_requirement` com `external_id` `hub:requirement:<fonte>/<chave>`, grava o
`state` estruturado e **versiona** como observação dessa entidade (hash do payload),
e relaciona a fonte por `states_requirement` com evidência de interpretação
(`system: interpretation`, `interpretation: model_reported`, `source_content_id`).
Repetir o mesmo payload é idempotente (`replayed: true`); hash de origem divergente
recusa com 409.

## Apresentado e lido

`markPresented` exige `{entity_id, content_hash}` por item, trava a entidade
(`for update`) e recusa com 409 quando a fonte mudou desde o conteúdo apresentado —
evita registrar como apresentada uma versão que nunca foi mostrada. `acknowledgeRead`
exige o hash da versão efetivamente lida e só registra confirmação humana. Ambos
gravam apenas em `hub_entities.state` (`attention_presented`, `attention_read`) e
devolvem `moodle_mark: false` / `source_writes: false`.

## A→B→A: ocorrências preservadas

A migration `20261007041000_observation_occurrences.sql` resolve o caso.
`hub_observations` continua deduplicando bytes por
`unique(owner_id, entity_id, content_hash)`, e cada evento de observação vira uma
linha em `hub_observation_occurrences`, com `unique(owner_id, entity_id,
content_hash, observed_at)`, FK diferível para o snapshot e trigger `BEFORE INSERT`
com `on conflict do nothing` — o trigger roda antes da resolução de conflito do
snapshot, então a revisita é registrada mesmo quando o `on conflict` descarta a
inserção. O backfill preserva IDs e datas originais; a view
`hub_observation_timeline` (`security_invoker`) expõe `id` da ocorrência,
`content_id` do snapshot deduplicado e os campos originais.

Com isso A (t1) → B (t2) → A (t3) produz **três ocorrências temporais**, o conteúdo
vigente volta a ser A e nenhuma data se perde. As leituras de histórico
(`entityContext`, `observations`, `observationText`, `activityPackage` e a projeção
de atenção) usam a timeline; as escritas continuam em `hub_observations`.
`entityContext` deixou a heurística: `matches_latest_occurrence` compara o estado
vigente com o snapshot da ocorrência mais recente e `last_observed_at.precision` é
`recorded`. Uma igualdade falsa passou a significar apenas alteração de estado
**sem** ocorrência correspondente, sinalizada por `unrecorded_change_detected`.

## Acesso e exportação

A Data API exige `client_id` nulo nas policies por dono (migração do limite OAuth):
um token OAuth com `client_id` não alcança memória, ocorrências nem o limite de
aprovação, nem pela view `hub_observation_timeline` (`security_invoker`). O teste
direto monta a sessão com e sem `client_id` e confirma leitura zero e escrita
recusada — `asOwner` grava claims vazios e não prova esse gate.

`hub_export` inclui `hub_observation_occurrences` (série temporal completa) e o
histórico de `hub_actions`/`hub_action_approvals`, para acompanhar a restauração.

## Resumos de extração

`hub_files`, `hub_file_text` e `hub_search_documents` não anexam a extração
integral: além de `pages` (PDF), `extraction` agora omite `blocks` e
`sanitized_html` (documento DOCX/HTML). O leitor paginado detalhado por bloco
(`hub_document_blocks`) não anexa a extração inteira a cada trecho.

## Contrato MCP

Leitura:

- `hub_attention` → `Attention.overview(principal, {connection_id?, context_id?, offset?}, {now?})`.
  Devolve `obligations` (entity, requirement, deadlines, requirement_deadlines,
  deadline_summary, requirements, colleagues, colleague_requirements, provenance com
  `content_id`, state com `academic_actions` e `submission_evidence`, basis, gaps),
  `attention`, `next_offset`, `content_is_untrusted_data` e `limitations`.

Escrita local (nunca no Moodle):

- `hub_attention_presented` → `markPresented(principal, {entities: [{entity_id, content_hash}]})`.
- `hub_attention_read` → `acknowledgeRead(principal, {entity_id, content_hash})`.
- `hub_record_requirement` → `recordRequirement(principal, {source_entity_id,
  requirement_key, observation_id, content_hash, excerpt, action, quantity?,
  deadline?})`.

## Limitações

- A correspondência do recibo depende de o snapshot canônico carregar
  `content.target` com `course_id`/`cmid`/`instance_id`; forma diferente de alvo não
  é adivinhada.
- Nada nesta projeção agenda execução, envia notificação ou marca leitura/conclusão
  no Moodle.
