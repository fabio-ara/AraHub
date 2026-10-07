# Acompanhamento local finito

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
política mantêm o contrato anterior. O transporte opt-in atual recusa destinos externos e rotas de
upload.

## Evidência e limites

Os testes dirigidos usam SQL real e transporte sintético para disputar claims, simular resposta
incerta, fluxo sem `Content-Length`, prazo, abandono, isolamento, expiração e janela. O harness usa
**Moodle Lab real, SQL real e processos Deno distintos**, com pausa, retomada do mesmo
job/checkpoint e encerramento real por prazo. Um resultado parcial continua parcial; política
executada não significa conteúdo integralmente atualizado. Os recibos ficam privados, com números,
IDs, lacunas e estado, sem corpos da fonte. Os bloqueios de ações host previamente provados não
foram reabertos por esta mudança.

Não implementado: despachante hospedado, cron, push, teto de **64 MiB de escrita lógica**, orçamento
financeiro ou controle de egress físico. Não foi exercitado transporte externo nem
credencial/autenticação de produção. Publicar esse código não exige redeploy do backend ou
reempacotamento do plugin e não ativa recorrência.

As transações seguem as garantias de
[locks explícitos do PostgreSQL](https://www.postgresql.org/docs/current/explicit-locking.html). O
encerramento usa [processos filhos do Deno](https://docs.deno.com/api/deno/~/Deno.ChildProcess).
