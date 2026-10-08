# Acompanhamento finito

A engenharia inclui o consumidor local e um executor para hospedagem, com autorização privada,
janelas de horário, orçamento de escrita, saúde e pausa. **Código disponível não significa
agendamento instalado ou ativo.** A ativação remota exige o lote específico do titular; nenhuma
migration instala cron ou consulta a universidade.

## Consumidor local

O CLI `scripts/run_followup.ts` executa **uma tentativa por invocação**, no PostgreSQL exclusivo
`127.0.0.1:55432/arahub` e em uma instância Moodle Lab de loopback cujo manifesto corresponda ao
marcador local. Não instala cron, serviço, notificação, endpoint HTTP/MCP ou autenticação de
produção. Não há horário ativo. A execução hospedada depende de lote próprio e autorização
específica.

## Reproduzir

Com o PostgreSQL e o Moodle Lab existentes em execução, na raiz do checkout:

```powershell
deno run --cached-only --allow-read --allow-env --allow-write=.private --allow-run=deno --allow-net=127.0.0.1:55432,localhost:8480 scripts/lab/followup_prove.ts
```

O harness confere os marcadores, usa a conta sintética de estudante, cria somente estado no banco
local e consulta o Moodle real. Não modifica o Moodle. A saída informa o caminho privado de
`proof.json`; a mesma pasta contém `config.json`, com owner, conexão, política e chave do cofre
local. Esse arquivo é segredo local, nunca exemplo para Git. O harness termina com suas políticas
pausadas. Manifesto e marcador podem ser indicados por `--manifest=CAMINHO --instance=CAMINHO`;
ajuste também a permissão de rede para a porta daquela instância.

Para operar a política criada, substitua `<run>` pelo identificador do recibo:

```powershell
$cfg = '.private/entrega-1/followup/<run>/config.json'
deno run --cached-only --allow-read --allow-env --allow-net=127.0.0.1:55432 scripts/run_followup.ts --config=$cfg --action=status
deno run --cached-only --allow-read --allow-env --allow-net=127.0.0.1:55432 scripts/run_followup.ts --config=$cfg --action=resume
deno run --cached-only --allow-read --allow-env --allow-run=deno --allow-net=127.0.0.1:55432,localhost:8480 scripts/run_followup.ts --config=$cfg --action=run
deno run --cached-only --allow-read --allow-env --allow-net=127.0.0.1:55432 scripts/run_followup.ts --config=$cfg --action=pause
```

Uma invocação antes de `next_at`, durante pausa ou sem saldo suficiente fica ociosa. Não dorme até o
próximo horário nem compensa janelas perdidas. `status` devolve contagens e estados, sem tokens ou
conteúdo acadêmico. A configuração tem schema `arahub.local-followup/1`; para uma nova conexão local
já existente, prepare os campos validados em `localFollowupConfig` e use `--action=create` também
com `--allow-write=.private`. Isso grava `policy_id` no arquivo privado. `create` repetido para o
mesmo owner/conexão/curso é recusado; não zera saldo.

## Contrato implementado

`FollowupPolicies` usa `hub_entities.state`, kind interno `followup_policy`,
owner/conexão/origem/curso fixos, versão de schema, revisão administrativa e expiração de até sete
dias. Não há migration. As consultas de contexto e preferências leem contextos/deltas; a atenção
seleciona tipos acadêmicos. A política não entra nessas três respostas. A consulta explícita de
entidades do mesmo owner continua podendo encontrar o registro interno.

| Controle              | Implementação                                                                                                                                                                                                                                                                                                                                                          |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reserva               | Claim do job e débito integral de chamadas/bytes/parede na mesma transação SQL, antes de despachar. Sem restituição, mesmo após erro, timeout, pausa ou queda. `reserved` mede teto comprometido, não consumo observado.                                                                                                                                               |
| Limites por tentativa | Configuração obrigatória: 1–1.000 chamadas; 1 byte–64 MiB de respostas agregadas; 100–120.000 ms de parede. O limite individual continua em até 16 MiB. A prova usa 18 chamadas, 32 MiB e 45 s.                                                                                                                                                                        |
| Saldos                | Tetos separados por janela fixa e por toda a validade. A janela pode ter de 1 s a sete dias; renovar a janela não restitui o total. Pausa e reinício preservam ambos. A prova usa janela de 24 h.                                                                                                                                                                      |
| Transporte            | Antes de cada envio, confere a reserva ativa e debita a tentativa de chamada no SQL. Contabiliza bytes de corpo decodificado admitidos, inclusive respostas de erro. Cancela corpo que ultrapasse o saldo e bloqueia novos envios. Não é teto de bytes na rede/IP: um chunk recebido e recusado não entra no conteúdo admitido.                                        |
| Parede                | O pai termina o processo filho no prazo, inclusive se o event loop do filho travar. Startup entra no prazo; cancelamento do transporte usa também a deadline persistida. Fencing e limpeza SQL acontecem após o encerramento, com latência do sistema operacional; não é orçamento de CPU/faturamento ou garantia de cancelamento de um statement já enviado ao banco. |
| Retomada              | Reutiliza o job parcial, suas tentativas e o checkpoint existente de fórum. Não elimina releitura de metadados. Até cinco tentativas; job terminal não é recriado automaticamente.                                                                                                                                                                                     |
| Pausa                 | Pausa manual com revisão, expiração ou limite configurado de falhas. Cerca a tentativa ativa para recusar escritas tardias. Retomada preserva tentativas, saldo e backoff; não revalida credenciais de produção.                                                                                                                                                       |
| Concorrência          | Um job de acompanhamento ativo por conexão; claim comum não toma job vinculado à política. Conexões independentes podem progredir. Leases abandonadas são cercadas após deadline, com reserva ainda debitada.                                                                                                                                                          |

O prazo da política, limites e curso ficam no banco após criação; editar o JSON não altera
silenciosamente esses valores. `resume` não renova expiração nem reabre um job terminal. A política
usa `Sync`/`Jobs` por opção interna de runtime; os callers HTTP/MCP, defaults Moodle/Sync e jobs sem
política mantêm o contrato anterior. O transporte injetado do CLI de laboratório recusa destinos
externos e rotas de upload. O transporte hospedado restrito está descrito abaixo.

## Evidência e limites

Os testes dirigidos usam SQL real e transporte sintético para disputar claims, simular resposta
incerta, fluxo sem `Content-Length`, prazo, abandono, isolamento, expiração e janela. O harness usa
**Moodle Lab real, SQL real e processos Deno distintos**, com pausa, retomada do mesmo
job/checkpoint e encerramento real por prazo. Um resultado parcial continua parcial; política
executada não significa conteúdo integralmente atualizado. Os recibos ficam privados, com números,
IDs, lacunas e estado, sem corpos da fonte. Os bloqueios de ações host previamente provados não
foram reabertos por esta mudança.

Essa prova histórica valida o consumidor local. O executor abaixo acrescenta engenharia para
hospedagem; a prova local não demonstra CPU do Edge, relógio remoto ou transporte institucional.

As transações seguem as garantias de
[locks explícitos do PostgreSQL](https://www.postgresql.org/docs/current/explicit-locking.html). O
encerramento usa [processos filhos do Deno](https://docs.deno.com/api/deno/~/Deno.ChildProcess).

## Executor preparado para hospedagem

`HostedFollowup` executa uma tentativa de curso por invocação. O registro de autorização fica em
`arahub_private.followup_grants` (migration 16), sem privilégios de Data API, com RLS forçada.
Conta, conexão, época da credencial, origem, cursos e cópia das políticas são vinculados pelo
operador após aprovação. Não existe rota HTTP/MCP para criar ou ampliar essa autorização.

O endpoint separado `arahub-acompanhamento` recebe somente `POST {}` e uma chave aleatória
dedicada, ligada ao ID da autorização no ambiente protegido. Não usa cookie/JWT humano e não
aceita proprietário, curso ou credencial na requisição. Renovar/revogar a conexão invalida o
vínculo. O MCP acrescenta `hub_followup_status` e `hub_followup_pause`: consultam/pausam somente
registros do titular, preservam a memória e não permitem ativação ou retomada.

| Limite | Comportamento implementado |
| --- | --- |
| Vigência | Até sete dias, sem renovação automática nem compensação de horários perdidos. |
| Janelas | 08:00 e 20:00 Europe/Lisbon, até 90 minutos; mudança sazonal de fuso considerada. |
| Tentativas | Até dois cursos, duas tentativas/curso/janela e 28/curso/vigência. Serialização e alternância por conexão. Reserva incerta não é devolvida. |
| Fonte | Até 18 chamadas e 32 MiB de resposta por tentativa; até 16 MiB por resposta e 45 segundos. Fórum limitado a duas chamadas. |
| Persistência | Até 64 MiB compartilhados de admissão de payloads lógicos. Débito e escrita na mesma transação; prazo rechecado antes do commit. |
| Retomada | Mesmo job/checkpoint parcial, respeitando o teto existente de cinco claims. Cobertura parcial por paginação/capacidade ausente permanece explícita e não conta como falha de transporte. |
| Falhas | Parcial com progresso: ao menos 15 minutos. Falha: 30 minutos, duas e seis horas; três falhas pausam. Credencial inválida ou orçamento de escrita esgotado pausa o grupo. |
| Pausa | Bloqueia novas chamadas e gravações da tentativa. Uma chamada já despachada pode terminar; sua resposta não autoriza escrita após a pausa. |

O transporte hospedado usa o adaptador HTTPS normal, mantendo resolução validada, IP fixado e TLS.
O gate de orçamento não injeta `fetch`. Upload, postagem, submissão, consulta de status individual
e downloads de binários não entram na allowlist recorrente. O processamento pesado de novos
vídeos continua sendo uma operação durante conversa no cliente capaz; este cron não executa ASR.

O limite lógico é conservador: cada operação de conteúdo reserva `4096 + 4 × bytes UTF-8 do JSON`
para projeção, observação, relações/checkpoint e recibo do job. Repetições e upserts também
consomem essa admissão; transação recusada reverte o débito. Contadores de controle têm tamanho e
quantidade limitados separadamente. Isso não mede disco, WAL, tráfego físico ou faturamento e não
promete custo/recursos ilimitados. Sem guard, a sincronização interativa não calcula esse custo.

## Preparação do relógio e critérios remotos

`scripts/prepare_followup_cron.ts <grant UUID> <project HTTPS URL>` gera SQL revisável, sem conectar
ao banco e sem incluir segredos. O SQL instala o job **inativo** numa transação. O comando roda a
cada cinco minutos, mas só chama a função dentro das duas janelas e durante a vigência. Consulta
a chave dedicada pelo nome no Vault, sem gravá-la no texto do job. Pausa ou expiração cancela o
próprio job no próximo tick. Rollback pausa a autorização e cancela o job, preservando dados.

A instalação usa [pg_cron, pg_net e Vault](https://supabase.com/docs/guides/functions/schedule-functions).
Não há instalação automática das extensões, geração de segredo remoto, deploy ou ativação pelo
script. Uma consulta de saúde que encontre `configured` comprova configuração, não cron ativo.
Para declarar recorrência ativa, registrar instalação autorizada, chamada pelo relógio, recibo
persistido e leitura independente. Conferir também CPU/memória reais: o Edge documenta 256 MB e
dois segundos de CPU por requisição; o tempo de I/O do Lab não substitui essa medição.
[Limites do runtime](https://supabase.com/docs/guides/functions/limits).

## Validação reproduzível do novo executor

```powershell
deno test --allow-net=127.0.0.1:55432,127.0.0.1:8789 --allow-env --allow-read tests/hosted_followup_test.ts tests/followup_policy_test.ts tests/followup_schedule_test.ts tests/mcp_test.ts
deno run --allow-net=127.0.0.1:55432,localhost:8480 --allow-env --allow-read --allow-write=.private scripts/lab/hosted_followup_prove.ts
```

O primeiro grupo usa SQL real, fonte sintética e cliente MCP SDK por HTTP local: autorização,
isolamento, concorrência, mudança de época/política, prazo, rollback do orçamento, quotas,
reconciliação de conclusão após crash e DST. O segundo consulta o Moodle Lab real como estudante,
via transporte explicitamente remapeado para loopback. Usa relógio acelerado, registra duas
tentativas/retomada, impede a terceira e termina pausado. Não prova DNS/TLS externo, CPU hospedada,
espera real de 15 minutos ou agendamento remoto. Os recibos e IDs ficam fora do Git.
