# Operação e medição de sincronizações

Complementa `docs/SINCRONIZACAO.md` (Moodle) e `docs/GOOGLE_SYNC.md` (Google) com o que é medido por
execução de lote (A30) e como inspecionar sem expor conteúdo, credenciais ou infraestrutura.

## O que cada tentativa mede

Cada execução de lote (uma tentativa ativa de um job) cria um medidor próprio (`src/job_metrics.ts`)
e fecha um relatório com:

- `duration_ms`: duração da execução por relógio monotônico (`performance.now`), não pelo relógio de
  parede.
  Começa após o claim e termina ao preparar o fechamento; não inclui claim,
  transporte do cliente ou a transação final que persiste o relatório.
- `calls`: chamadas efetivamente despachadas ao provedor. Não é inferida por item nem por página: o
  adaptador de transporte incrementa no ponto em que a requisição sai do processo, então tentativas
  que falham depois do envio (erro de HTTP, falha de rede/TLS) também entram quando a resposta volta
  com erro ou a conexão cai.
- `memory`: duas amostras (`start` e `end`) de `rss_bytes`/`heap_used_bytes`/ `heap_total_bytes` do
  processo/isolate **compartilhado**. Não é memória exclusiva do lote nem pico garantido; em runtime
  sem `Deno.memoryUsage` a amostra é `null`.
- `started_at`/`finished_at`: marcas de parede para correlação.

O relatório carrega apenas números, tempos e o escopo da amostra de memória (`process_shared`). URL,
query, cabeçalhos, token e conteúdo nunca entram.

## Como a contagem chega ao adaptador

O medidor é composto **por execução**, sem estado global e sem monkey patch de singleton:

- **Moodle**: `ConnectionService.moodle(p, id, deps)` encaminha as deps por lote; `Sync` passa
  `onRequest` e o `MoodleAdapter` dispara o observador no ponto de despacho
  (`sendViaFetch`/`sendViaNode`), cobrindo consultas REST e downloads.
- **Google**: `GoogleConnections.client(p, id, { wrapFetch })` compõe o transporte observado sobre o
  fetch configurado e o repassa ao `GoogleReadClient`; `GoogleSync` conta cada requisição do cliente
  de leitura.

Como cada instância pertence a uma tentativa, execuções simultâneas (donos, conexões ou chaves
diferentes) não somam contagens entre si. Lease, fencing e isolamento por dono/conexão permanecem
inalterados.

## Onde o resultado aparece

- `Jobs.finish` grava o relatório dentro do `coverage` do job, junto do estado.
- `Jobs.list` (ferramenta MCP `hub_jobs`) devolve esse `coverage`, então a medição persistida
  aparece sem consulta nova.
- O resultado do lote também devolve a medição no `summary.metrics` e no topo do retorno
  (`metrics`), em `Sync` (Moodle) e `GoogleSync`.

Não há migração nova: o `coverage` já existente em `hub_jobs` acomoda a medição.

## Limites

- A memória é uma amostra do processo compartilhado; não representa consumo isolado do lote nem
  memória de pico.
- A contagem cobre as chamadas do lote ao provedor de conteúdo. Chamadas de gestão da conexão
  (renovação de token, descoberta de capacidades durante o cadastro da conexão) não pertencem a uma
  tentativa de sincronização e ficam fora do relatório.
- Nada aqui agenda execuções: a retomada continua dependendo de uma nova chamada ao lote ou do retry
  do job.

## Tamanho do próprio acervo (leitura)

Para o volume do próprio usuário, use a ferramenta MCP `hub_usage` (leitura). Ela devolve contagens
por dono (contextos, conexões, entidades, deltas, jobs, arquivos) e o `storage` lógico em bytes como
strings decimais (`declared_file_bytes`, `preserved_binary_bytes`, `extracted_text_utf8_bytes`), com
`measurement: owner_logical_bytes`. Não é tamanho físico/faturável do banco nem saldo de cota, e não
inclui índices, WAL, Auth, TOAST ou outros usuários. A implementação é `Hub.usage`; aqui apenas se
indica o consumo.

## Testes dirigidos

```powershell
deno check src/job_metrics.ts src/sync.ts src/google_sync.ts
deno test --allow-net=127.0.0.1:55432 --allow-env tests/job_metrics_test.ts
```

Cobrem: contagem real de chamadas Moodle (uma por requisição enviada), duração/forma da memória,
erro de transporte contado e retomada do mesmo lote medindo a tentativa seguinte, isolamento entre
duas execuções simultâneas de donos/conexões diferentes, e o mesmo conjunto no Google (paginação
retomada por `pageToken` e falha de transporte contada). SQL real no Postgres exclusivo e fixture
sintética; nenhuma conta real.
