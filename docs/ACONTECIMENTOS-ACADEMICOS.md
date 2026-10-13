# Acontecimentos acadêmicos e continuidade

Correção 0.2.9 publicada e validada na instância pessoal em 2026-10-13, incluindo
catálogo MCP e skill no pacote pessoal 1.1.5. Não há migration, nova dependência,
segunda memória canônica, cron ou notificação nesta correção.

A publicação foi integrada pelo PR #1 (`010d598`, merge `3a400a2`) e implantada
na função principal existente. Duas conversas novas do ChatGPT comprovaram
registro imediato, replay idempotente, recuperação e divergência preservada em
contexto sintético. A skill servida ao cliente coincide por SHA-256 com a fonte.
O teste de divergência usou observação controlada no banco hospedado, sem acesso
à universidade. Estado final e limites: [STATUS](../STATUS.md).

## Causa operacional

A skill distribuída priorizava `hub_context`/`hub_search` e orientava a escrita
genérica por `hub_record_delta`. O caminho especializado `hub_report_submission`
já existia, mas exigia vínculo prévio, versão e chave fornecidos pelo cliente. A
descrição/ordem da skill não o tornava o próximo passo obrigatório diante do
relato. Um delta genérico também não atualizava `state.user_report`, que era a
única projeção de relato lida pelo acompanhamento.

Além disso, consultas diretas de conteúdo, discussões, posts e status próprio
devolviam a fonte sem preservar as observações. `Sync` persistia o grafo, mas a
atenção não usava os posts observados como comprovante de publicação. Assim, uma
conversa podia confirmar a publicação sem deixar continuidade equivalente na
memória. O código não permite determinar por que um modelo específico fez uma
pergunta, mas esses caminhos incompletos reproduzem o problema operacional.

## Registro em uma chamada

`hub_record_event` recebe `content` e `event_type`, mais `context_id` ou
`target_entity_id`. O cliente interpreta a linguagem natural e encaminha o
acontecimento; o servidor não recebe nem classifica mensagens fora das chamadas
MCP. A skill prioriza essa chamada antes de investigação externa e dispensa a
pergunta redundante sobre salvar.

| Tipo | Relato preservado |
| --- | --- |
| `submission` | O titular informou que entregou. |
| `forum_topic` | Informou que publicou um tópico. |
| `forum_reply` | Informou que respondeu; quantidade de colegas somente quando comunicada. |
| `completion` | Informou que terminou; não equivale a envio. |
| `deadline_change` | Informou alteração de prazo. |
| `requirements_change` | Informou alteração de orientação/requisito. |
| `feedback_received` | Informou recebimento de feedback. |

O registro sempre tem `evidence_kind=user_report`. Para observação, interpretação
e hipótese continua existindo o contrato explícito de `hub_record_delta`. Uma
fala hipotética, negativa ou futura não deve ser encaminhada como conclusão.

O serviço reutiliza `hub_contexts`, `hub_context_targets`, `hub_deltas` e a função
SQL `hub_record_delta`. Resolve o alvo único, qualifica o alias módulo → atividade
pelas relações existentes e reutiliza o contexto vinculado. Quando só há o ID da
atividade e nenhum vínculo, cria contexto/vínculo na mesma transação. Múltiplos
contextos ou atividades plausíveis geram ambiguidade; títulos/recência não são
critérios de escolha. O ID explícito do contexto atual elimina essa ambiguidade.

Um lock por titular serializa criação de contexto e deduplicação. O lock da linha
de contexto e o controle de versão SQL também protegem contra `record_delta` e
alterações concorrentes de vínculo. Um append pode usar a versão corrente dentro
da transação; não sobrescreve a evidência anterior. Uma correção exige
`supersedes` e `expected_version`; duas correções da mesma revisão não vencem
juntas. `retract=true` retira a afirmação da projeção, conservando seu histórico.

Entrega, tópico e conclusão no mesmo alvo/obrigação/ocorrência são marcos
idempotentes mesmo se recontados com palavras diferentes. A evidência original é
preservada. Outra tentativa deve usar `occurrence_key` estável ou data explicitamente
comunicada. Os demais eventos incluem o texto normalizado na identidade, pois
feedbacks, respostas e mudanças podem ocorrer mais de uma vez. Quando fornecida,
a chave de idempotência explícita não pode ser reutilizada com conteúdo diferente.
Datas vagas permanecem em `original_date`; `occurred_at` exige um instante conhecido.

`memory_commit` é o recibo durável. A leitura de acompanhamento ocorre depois;
se ela falhar, a ferramenta mantém o recibo e indica `followup.status=unavailable`.
Nenhuma dessas etapas consulta o Moodle, envia trabalho ou modifica Calendar.

## Reconciliação de consultas

`MoodleMemory.remember` preserva os resultados das consultas autorizadas de
conteúdo, discussões, posts e status próprio nas mesmas entidades e localizadores
`moodle:course/...` usados por `Sync`. Preserva relações, conteúdo, hash,
proveniência, data e cobertura; reutiliza o histórico de ocorrências A→B→A. Uma
resposta atrasada permanece no histórico sem substituir a projeção mais recente.

O resultado MCP mantém os dados da fonte e acrescenta `memory_reconciliation`:

- `persisted`: o espelho foi atualizado na transação.
- `not_observed`: fonte indisponível/negada ou sem conteúdo utilizável; memória
  anterior permanece intacta.
- `target_unresolved`: falta o fórum/discussão pai conhecido; consultar os fóruns
  do curso ou as discussões resolve os IDs, sem inventar relação por título.
- `failed`: a fonte retornou, mas a persistência falhou. Não anunciar atualização.

As ferramentas de consulta agora declaram escrita de memória privada nas
anotações MCP. Isso não as autoriza a escrever na instituição. O cliente continua
controlando permissões efetivas de ferramentas.

Status individual continua exigindo o consentimento da política existente. O
adaptador conserva `new`, `draft`, `submitted` e a tentativa da própria conta,
sem disparar novo envio. Do feedback já retornado nessa consulta guarda somente
disponibilidade/data; notas, identidade do avaliador e corpos dos plugins ficam
fora. Não há nova consulta automática de status ao registrar um relato, nem
inclusão desse acesso na allowlist recorrente.

## Acompanhamento

O MCP usa `hub_attention(view="summary")` por padrão. `view="audit"` conserva
fontes, comprovantes, histórico acessível por IDs e detalhes técnicos. Recursos
como Page/Book/URL e módulos já representados pela atividade filha não viram
pendências duplicadas. A visão resumida também omite discussões filhas de fórum.

Relatos são lidos diretamente dos deltas vigentes, incluindo relatos legados com
alvo explícito ou contexto inequivocamente vinculado. Eventos recentes de outras
atividades não expulsam uma entrega antiga da projeção. O estado legado continua
auditável; uma retratação do delta correspondente impede sua reativação acidental.

`hub_record_requirement` aceita `fulfillment` para declarar qual evidência pode
cumprir a obrigação. Uma quantidade de `colleagues_distinct` indica respostas a
colegas; uma regra de fórum sem esse dado ou classificação explícita permanece
manual. Não se classifica qualquer obrigação de fórum como publicação.

Tópico próprio observado encerra a publicação, conservando comprovante. Respostas
exigem autoria própria, parent de outro autor e mesma discussão/conexão; contam
autores distintos, não número bruto de posts. Um relato de uma resposta não
cumpre dois colegas. `reported_distinct_colleagues` só pode ser fornecido se o
titular comunicou o número; relatos não são somados para inventar autoria.
Qualidade acadêmica não é inferida desses contadores.

Relato de entrega mais status `new`/`draft` produz incerteza explícita, preservando
ambas as evidências. Sem confirmação nativa, o relato continua válido como
relato. Conclusão nativa não é convertida em entrega. Mudanças de prazo/conteúdo
e fonte de requisito desatualizada exigem revisão; hash diferente não demonstra
sozinho mudança semântica da obrigação.

## Fora da conversa

1. **Consulta/reconciliação:** implementada e testável no MCP, sem relógio.
2. **Sincronização periódica:** o repositório já contém políticas, executor
   hospedado separado, preparação de cron inativo, limites, pausa e expiração.
   Esta correção aproveita os snapshots dessa trilha; não ativa nem provisiona
   infraestrutura. A instalação pessoal registrada tem recorrência inativa.
3. **Notificação:** não há integração de entrega de notificações ao usuário.
   Atualizar o banco não envia uma mensagem nem inicia conversa no ChatGPT.

Uma ativação futura precisa de autorização para conexão, cursos, vigência e
frequência; implantação/configuração da função separada, autorização privada,
chave dedicada, Vault, cron e prova de disparo real. A validade é finita e não se
renova por esta skill. Reutilizar o plano existente evita contratar serviço novo,
mas custo zero depende das cotas e uso efetivos; não é promessa de capacidade
ilimitada. Ver [acompanhamento](ACOMPANHAMENTO.md),
[agendamento oficial](https://supabase.com/docs/guides/functions/schedule-functions)
e [limites oficiais](https://supabase.com/docs/guides/functions/limits).

## Disponibilização pessoal

Procedimento executado: publicar o backend 0.2.9 na função principal, atualizar
a descoberta de ferramentas do app existente e atualizar a skill pelo pacote
pessoal 1.1.5. Nenhum outro app ou memória foi criado. Não houve migration nem
alteração de UI. Conversas novas confirmaram `hub_record_event`, recibo como
relato, replay e retomada; catálogo, skill e conta foram conferidos no cliente.

Em próximas atualizações, repetir essas verificações após implantar e atualizar
o catálogo: um pacote local sozinho não prova instalação ou comportamento.
O host ainda precisa carregar a skill e efetivamente invocar o MCP; nenhuma
prova de servidor ou conversa isolada garante obediência universal do modelo.

## Regressão controlada

Os arquivos `academic_events_test.ts`, `academic_mcp_test.ts` e
`academic_attention_test.ts` cobrem os cenários A–F com banco PostgreSQL real,
contas sintéticas e fontes controladas. O segundo usa o cliente MCP SDK e HTTP
reais, inclusive outra sessão de cliente. Os testes existentes de status próprio
exercitam OAuth/consentimento/adaptador, autorização ausente e revogação. Os
resultados finais e comandos executados ficam em `STATUS.md`. A regressão local
não é prova de Moodle institucional, implantação ou execução pelo ChatGPT. As
provas hospedadas e do cliente, executadas depois, estão separadas no STATUS.
