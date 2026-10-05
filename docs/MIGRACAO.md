# Migração reprodutível de fontes

Fundamento da etapa 5 do plano: fixar a origem, inventariar com rastreabilidade,
preservar os bytes brutos, curar com ponte para o trecho original e exportar um
lote privado que possa ser restaurado e verificado. Nada aqui depende de banco
remoto nem de escrita em serviços externos.

## Invariantes

- A origem é somente leitura. O staging grava apenas no destino local indicado.
- O inventário é determinístico: mesmo commit e mesma árvore produzem o mesmo
  `batchId` e as mesmas chaves, então reexecutar não duplica.
- Os bytes brutos ficam num CAS local endereçado por conteúdo, com hash
  `sha256` e identificador de blob do Git.
- A curadoria aponta para `path` + `commit` + linhas + trecho literal; um trecho
  que não exista no arquivo não é aceito.
- Rascunho nunca é tratado como publicado e o commit não é usado como data do
  acontecimento.
- Export não carrega segredos: arquivos com nome sensível são excluídos e
  valores com forma de token são redigidos.
- Manifestos, inventários e exports são entradas não confiáveis: `batchId`,
  `commit`, chaves CAS e caminhos são validados antes de qualquer leitura ou
  escrita, e um manifesto inválido é recusado sem tocar o CAS.

## Módulos

- `src/migration.ts` — inventário, CAS, curadoria, verificação, export e restore.
- `scripts/stage_metd.ts` — interface de linha de comando (saída só com
  contagens, hashes curtos e estados).
- `tests/migration_test.ts` — testes sintéticos públicos (A25 e A27).

API principal:

```ts
loadInventory(source, { git?, sourceLabel?, now? }): Promise<Inventory>
stageRepository(source, destination, options?): Promise<StageResult>
verifyStaging(destination): Promise<VerifyResult>
verifyOrigin(destination, source, { git? }): Promise<OriginCheck>
writeCuration(destination, payload): Promise<string>
loadCuration(destination): Promise<CurationPayload[]>
exportStaging(destination, exportDir): Promise<ExportResult>
restoreStaging(exportDir, destination): Promise<RestoreResult>
```

A leitura do Git passa pela porta `GitPort`. O padrão executa o binário `git`
(`--allow-run=git`); os testes injetam uma porta sintética, o que mantém a
suíte sem privilégio de execução.

## Inventário

Cada arquivo registra: `path`, `kind` (`text`/`binary`/`symlink`/`gitlink`),
`status`, `encoding`, `eol`, `bytes`, `lines`, `gitMode`, `gitBlobSha`,
`sha256`, `casKey` e as URLs externas encontradas. Os totais agregam arquivos,
texto, binário, links, bytes e linhas. O lote guarda `branch`, `commit`,
`commitShort`, se a árvore estava limpa (`clean`) e `batchId`.

O conteúdo lido vem do objeto do Git (`git cat-file blob`), não do diretório de
trabalho, para que o lote seja reproduzível a partir do commit.

## Layout do destino

```
<destino>/
  inventory.json
  manifest.json            # arquivos + relações + curationIds + manifestHash
  cas/<aa>/<sha256>        # bytes brutos
  state/<batchId>.progress.json
  curation/<batchId>.json  # payloads de curadoria
```

Reexecutar o staging reutiliza objetos existentes. Um lote interrompido é
retomado pelo arquivo de progresso; objetos ausentes são reescritos.

## Curadoria

Cada registro tem `id`, `domain`, `kind`
(`fact`/`reported`/`inferred`/`unknown`/`preference`/`argument`/`state`/`version`/`source_note`),
`epistemic` (`observed`/`reported`/`inferred`/`unknown`), `assertion`, `date`
com precisão explícita (inclusive `vague`), `versions` com estado, `scope` e
`refs`. As relações `derived_from` ligam cada registro ao arquivo de origem e
entram no manifesto. Datas vagas permanecem vagas; versões de rascunho ou
proposta exigem, no teste privado, uma marca textual de não publicação.

## Verificação

`verifyStaging` valida a estrutura do manifesto e recomputa o `sha256` de cada
objeto, o identificador de blob, as relações e o `manifestHash`. Uma divergência
de blob invalida o lote (`ok=false`); objetos de outros lotes no mesmo CAS são
contados como `extra` e não são tratados como corrupção. `verifyOrigin` compara o
commit registrado com o commit atual da origem e avisa quando ela avançou.

## Export e restauração

`exportStaging` grava manifesto, inventário, curadoria e o CAS do export.
Arquivos com nome sensível são excluídos; texto com forma de segredo é redigido
e registrado em `exportedSha256`. O CAS é criado de forma atômica (`createNew`),
objetos idênticos são reutilizados e uma escrita interrompida é reparada.

`restoreStaging(exportDir, destination, options?)` valida manifesto e inventário,
confere o `manifestHash` e o `sha256` de todos os objetos do export antes de
escrever (duas passagens). Se `options.source` for informado, reconfere o commit
da origem e recusa o restore quando ela avançou, salvo
`allowOriginChange: true`; `expectedBatchId` fixa o lote. Um destino que já
contenha outro lote é recusado (`destination_batch_mismatch`), sem sobrescrever
o lote existente. Ao final, a verificação roda automaticamente.

```ts
restoreStaging(exportDir, destination, {
  source,            // opcional: origem Git para conferir o commit
  git,               // porta Git injetável (testes)
  allowOriginChange, // default false
  expectedBatchId,   // opcional
}): Promise<RestoreResult>
```

## Linha de comando

```
deno task migration:stage
deno task migration:stage -- verify
deno task migration:stage -- origin
deno task migration:stage -- export --out .private/migration/export
deno task migration:stage -- restore --in .private/migration/export --to .private/migration/restored
```

Flags: `--source`, `--to`/`--dest`, `--in`, `--out`, `--label`.

## Estado dos critérios

- **A25 — importação reproduzível.** Implementado e testado sinteticamente:
  inventário completo, `batchId` estável, reexecução sem duplicatas, retomada de
  lote interrompido, binários e não normalizados preservados no CAS. Executado
  sobre a origem privada autorizada, com verificação integral do lote.
- **A26 — regressão académica.** Curadoria autorada com trechos literais e
  contrato privado `expected` ancorado nas fontes; o teste privado confere
  cobertura, incertezas preservadas e disciplina rascunho/publicado. A execução
  real usa dados privados e não é publicada.
- **A27 — backup e virada.** Implementado e testado sinteticamente: export com
  manifesto, hashes e relações; restauração em destino limpo verificada; tokens
  excluídos. A virada de cliente e a reconciliação final permanecem pendentes de
  autorização e de alvo remoto.

## Limitações

- Sem banco remoto: o staging é local. Importação hospedada e a virada exigem
  alvo autorizado.
- A reconciliação de um delta de origem é detectada por `verifyOrigin`, mas a
  fusão de um commit novo ainda é manual.
- A curadoria foi feita pelo assistente durante esta sessão; não substitui validação amostral
  do titular sobre afirmações sensíveis.

## Importação e recuperação locais

`deno task migration:import` preservou 57 arquivos completos e 109 registros curados no Postgres local. A repetição acrescentou zero registros e reutilizou os 109; também repara vínculos após interrupção entre o delta e suas relações. `deno task migration:validate` usou um cliente MCP novo e conferiu os 109 conteúdos com referências literais, além da leitura de documento bruto. A identidade e o transporte são sintéticos locais; os dados de origem são reais e privados. Isso não comprova qualidade de todas as respostas acadêmicas, OAuth remoto ou A29.

`deno task backup:local` restaura o dump em banco exclusivo novo e compara todas as tabelas do domínio/cofre, binários, políticas RLS e grants. A prova atual compara 11 tabelas e 855.797 bytes de dump; o destino e o manifesto ficam em `.private/backups/`. Executar com escritas locais pausadas; o restore não sobrescreve outro banco. A virada e o backup hospedado continuam pendentes.
