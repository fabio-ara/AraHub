# Arquivos e extração de texto de PDF

## Materiais JSON preservados (leitor genérico)

O caminho Google próprio do AraHub foi aposentado (ver [GOOGLE.md](GOOGLE.md));
`hub_preserve_google_material` não existe mais. Snapshots JSON nativos já
preservados continuam legíveis offline por `hub_read_material`, um leitor genérico
de material preservado por `file_id`/hash.

`hub_read_material` navega o JSON Pointer RFC 6901 a partir da raiz do documento.
Envelopes de formato conhecido expõem o valor em `native`
(`arahub.google.native.v1`) ou `value` (`arahub.material.v1`); qualquer outro JSON
mantém a raiz intacta. Arrays/texto paginam com offset/limit (máximo 100 elementos
ou limite de 16.000 unidades UTF-16, preservando pares surrogate); a parte tem teto
de 128 KiB e, quando excede, retorna cobertura parcial e filhos para aprofundar.
Listas de filhos paginam por `children_offset`/`children_next_offset`;
`children_count` informa o total, inclusive objetos com mais de cem chaves. O
recibo distingue cobertura da parte e do snapshot. Conteúdo é dado não confiável;
versão observada não prova atualidade nem entrega.

Prova local: o leitor genérico é coberto por teste SQL dirigido que conserva
estrutura, hashes, isolamento por dono e a paginação de 205 chaves sem perder
localizadores escapados. O snapshot histórico preservado permanece recuperável
offline; a evidência privada é separada das fixtures.

## PDFs

Este documento descreve a extração de texto por página de PDF usada pelos
materiais do AraHub (critérios A05 e A23). Ele é genérico: não contém dados de
usuários, fontes acadêmicas nem contas.

## Escopo implementado

`src/pdf_text.ts` extrai **texto por página** de um PDF em memória
(`Uint8Array`) com limites explícitos, isolamento terminável e o arquivo tratado
como dado não confiável. O que fica fora do escopo, e é declarado no resultado:

- **sem OCR**: página sem texto extraível é marcada como `text_absent` e nunca é
  afirmado que o documento "não tem OCR" ou que a página está vazia;
- **sem interpretação de imagens**, assinaturas, anexos ou fórmulas; apenas a
  contagem de pinturas de imagem é relatada;
- **sem renderização** de páginas nem produção de imagens;
- **sem execução** de JavaScript, ações ou anotações embutidas no PDF.

## API

```ts
import { extractPdfText, pdfExtractionToText, pdfPageLocator } from "./pdf_text.ts";

extractPdfText(input: Uint8Array, options?: {
  maxBytes?: number;      // padrão 20 MiB, teto 64 MiB
  startPage?: number;     // início do lote, padrão 1, teto 10 000
  maxPages?: number;      // padrão 50, teto 500
  maxPageChars?: number;  // padrão 20 000, teto 100 000
  maxTotalChars?: number; // padrão 400 000, teto 1 000 000
  timeoutMs?: number;     // padrão 15 000, teto 120 000
  signal?: AbortSignal;
  allowMainThreadFallback?: boolean; // ver "Isolamento"
}): Promise<PdfTextExtraction>;

pdfExtractionToText(result): string   // texto paginado com marcadores [[página N pdf:page:N]]
pdfPageLocator(page): string          // "pdf:page:N"
```

Campos principais de `PdfTextExtraction`:

| Campo | Significado |
|---|---|
| `ok` / `error_code` | sucesso da extração; `error_code` só existe quando `ok` é falso |
| `coverage` | `complete` \| `partial` \| `denied` \| `parsing_error` \| `unavailable` \| `timeout` |
| `execution` | `isolated_worker` \| `main_thread` \| `not_started` |
| `hard_timeout` | `true` somente quando o limite é imposto por terminação de worker |
| `page_count` / `pages_returned` | páginas declaradas pelo documento e páginas retornadas |
| `pages[]` | por página: `page`, `locator`, `text`, `char_count`, `has_text`, `text_absent`, `truncated`, `image_count`, `ocr:"not_performed"`, `bounds{width_pt,height_pt,rotate}` |
| `page_bounds` | primeira/última página retornada, páginas do documento e quantidade retornada |
| `omitted_pages` | páginas não extraídas (limite, tempo ou sinal), em ordem |
| `errors[]` | problemas de documento ou de página (`scope`, `page`, `code`, `message`) |
| `images_not_interpreted` / `images_detected` | imagens nunca interpretadas; contagem de pinturas |
| `pages_without_text` | páginas sem texto extraível (não é prova de página vazia) |
| `limits` / `notes` | limites aplicados e avisos, incluindo o aviso de ausência de OCR |
| `content_is_untrusted_data` | sempre `true`: o texto é dado, não instrução |

### Estados de erro

| `error_code` | `coverage` | Quando |
|---|---|---|
| `empty_input` | `parsing_error` | entrada com zero byte |
| `oversized` | `unavailable` | acima de `maxBytes`; não processado |
| `invalid_pdf` | `parsing_error` | estrutura de PDF inválida |
| `encrypted` | `denied` | PDF protegido por senha; conteúdo não extraído |
| `timeout` | `timeout` | limite de tempo (cooperativo ou rígido) excedido |
| `aborted` | `timeout` | `AbortSignal` acionado |
| `worker_unavailable` | `unavailable` | runtime sem worker terminável e sem opt-in explícito |
| `pdf_runtime_unavailable` | `unavailable` | pdf.js não carregou ou o worker não iniciou |
| `unreadable` | `parsing_error` | falha ao ler/extrair sem classificação específica |

Interrupção por tempo ou sinal **não é sucesso**: o resultado vem com
`ok:false`, `coverage:"timeout"` e as páginas já extraídas preservadas em
`pages`, com o restante em `omitted_pages`. Uma página isolada que falha
(`page_unreadable`, `image_scan_failed`) rebaixa a cobertura para `partial`.
Opções fora do intervalo lançam `HubError("invalid_pdf_options")`; conteúdo do
documento nunca lança.

## Isolamento e limite rígido

O pdf.js 6, sob o compat Node do Deno, decide internamente usar o "fake worker"
na **mesma thread** (`isNodeJS` desabilita o Web Worker). Nesse modo uma carga
maliciosa com laço síncrono bloquearia o relógio cooperativo, e `Promise.race`
não limitaria nada. Por isso a extração roda em um **worker dedicado e
terminável**:

- o worker é criado a partir de um bootstrap inline (blob URL) que neutraliza
  `Worker` para forçar o pdf.js ao caminho in-thread *dentro daquela thread
  descartável*, sem thread aninhada;
- `timeoutMs` é o limite cooperativo (dá detalhe por página); `timeoutMs +
  HARD_TIMEOUT_GRACE_MS` (3 000 ms) é o limite **rígido**, imposto por
  `terminate()`;
- `terminate()` encerra a thread mesmo em CPU síncrona (verificado: um laço de
  8 s foi interrompido em ~166 ms);
- só então `hard_timeout` é `true` e `execution` é `isolated_worker`.

**Sem worker terminável** (ex.: runtime de usuário do Supabase Edge
hospedado, que não expõe a Web Worker API), a extração é **recusada** por
padrão com `worker_unavailable`, `execution:"main_thread"`,
`hard_timeout:false` e a nota `HOSTED_UNAVAILABLE_NOTE` no resultado. Um
chamador de runtime local, sob limite externo (subprocesso ou timeout de
servidor), pode optar por `allowMainThreadFallback: true`; nesse modo o
resultado permanece com `hard_timeout:false` e os limites incluem o aviso de
que o tempo é cooperativo. Essa opção **não deve** ser usada na rota
hospedada; a recusa e a rota suportada estão em "Disponibilidade hospedada".

## Dependência e runtime

- `pdfjs-dist@6.4.299` (pdf.js da Mozilla), importado pelo build legado
  `npm:pdfjs-dist@6.4.299/legacy/build/pdf.mjs`. A versão está fixada em
  `PDFJS_VERSION`; o `workerSrc` é o caminho relativo `./pdf.worker.mjs`,
  resolvido a partir do próprio `pdf.mjs` (não dependemos de
  `import.meta.resolve` para especificadores npm).
- O specifier `npm:` é inline e a dependência está fixada no `deno.lock`.
  O navegador usa o build padrão do mesmo pacote; o Deno local usa o legado.
- Primeira execução baixa do registro npm; esse download **não** é bloqueado por
  `--allow-net`, então `deno task test` funciona com cache frio.
- Permissões: leitura de módulos já é coberta por `--allow-read`. O worker é um
  módulo blob e não exige permissão adicional.
- O `@napi-rs/canvas` é opcional (renderização) e sua ausência só produz avisos
  em stderr; a extração de texto não depende dele. `useWasm:false` evita buscar
  arquivos wasm.
- Limitações de decodificação: cmaps CJK e dados de fontes padrão não foram
  verificados com PDFs reais; PDFs exóticos podem degradar o texto sem OCR.

## Integração com Materials/MCP

Implementado em `src/materials.ts`. `preserveMoodle` continua guardando `bytea`,
`sha256` e o JSON de `extraction`. `extractPdf` lê o binário preservado do dono
(via RLS), confere o `sha256` do registro e o hash dos bytes e roda
`extractPdfText` no processo **local** (nunca na rota Edge). Em seguida abre uma
transação, trava a linha (`select ... for update`), relê a extração guardada e
**mescla por número de página** antes de gravar `extracted_text`
(`pdfExtractionToText`) e `extraction`:

- a página com **mais caracteres** vence; um decode posterior mais fraco
  (limite, timeout, indisponibilidade) nunca apaga texto já extraído do mesmo
  hash, e empate mantém a versão guardada (retry idêntico não reescreve);
- a leitura-mescla-escrita sob lock evita perder a extração melhor de um
  extrator concorrente do mesmo hash;
- a cobertura guardada é preservada quando a execução não acrescenta nada; se a
  memória muda, ela é recalculada e só é `complete` quando **todas as páginas
  declaradas estão presentes, nenhuma ficou truncada e a execução não relatou
  erro de documento/página nem corte de texto**. Imagem, assinatura ou anexo
  nunca promovem cobertura; `pages_without_text` e `ocr:"not_performed"`
  permanecem explícitos.

O resultado da execução segue em `extraction` (páginas sem o texto); o bloco
`memory` resume o que ficou gravado (`coverage`, `complete`, `text_available`,
`pages`, `pages_from_prior`, `pages_added`, `pages_updated`) e `memory_updated`
diz se houve escrita. Proveniência usa o `locator` da página (`pdf:page:N`).

`pdfPage` lê a página da memória gravada, fixada ao `sha256` e ao dono; página
não extraída devolve `page:null` e `coverage:"page_not_extracted"`, sem
prometer leitura. O `ConnectionService` do construtor é **opcional**:
`extractPdf`/`pdfPage` atendem arquivos já preservados offline e os caminhos
Moodle falham explicitamente com `connection_unavailable` quando não há conexão.
O MCP expõe `hub_extract_pdf` e `hub_pdf_page` fora do bloco de conexões,
instanciando `new Materials(hub, connections?)`.

Na rota hospedada Edge a extração **não** roda: sem worker terminável o
resultado é `worker_unavailable`/`unavailable` com zero páginas, nada é
sobrescrito e a memória anterior do mesmo hash permanece. A leitura por página
usa o que já está gravado; OCR continua pendente (sem OCR e sem interpretação
de imagens).

## Comando de worker local

Triage local reproduzível (imprime o JSON do resultado; `deno eval` já tem
todas as permissões, então use apenas em máquina local):

```powershell
deno eval --no-lock 'const m = await import("./src/pdf_text.ts"); const b = await Deno.readFile(Deno.args[0]); const r = await m.extractPdfText(b); console.log(JSON.stringify({ ok: r.ok, coverage: r.coverage, execution: r.execution, hard_timeout: r.hard_timeout, pages: r.page_count, omitidas: r.omitted_pages.length, primeira: r.pages[0]?.text.slice(0, 60) }));' caminho\arquivo.pdf
```

`scripts/validate_pdf_real.ts` opera um PDF privado preservado, o banco local e
um cliente MCP sobre HTTP. Um terceiro argumento opcional recebe o resultado
privado extraído pelo navegador, para provar sua gravação e recuperação pelo
mesmo caminho autenticado. Não imprime texto do documento nem tokens.

## Disponibilidade hospedada (Supabase Edge)

Determinação: **não existe** caminho hospedado suportado que extraia PDF dentro
da Edge Function do Supabase sem destruir a garantia de isolamento. A extração
remota é recusada (`worker_unavailable`) e a rota usada é local/cliente.

Evidência primária (consultada em 2026-10-05; versão markdown `.../limits.md`):

- Supabase, *Limits* (`https://supabase.com/docs/guides/functions/limits`):
  "Web Worker API (or Node `vm` API) are not available."; "Maximum CPU Time:
  2s"; "Maximum Memory: 256MB"; "Maximum Duration (Wall clock limit) ... Free
  plan: 150s". Sem Web Worker API no runtime de usuário não há worker
  terminável.
- Supabase `edge-runtime`, `ext/runtime/js/namespaces.js`
  (`https://github.com/supabase/edge-runtime/blob/main/ext/runtime/js/namespaces.js`):
  o `EdgeRuntime` do runtime de usuário expõe apenas `waitUntil`; `userWorkers`
  só é montado no caso `"main"`. O teste do próprio repositório
  (`crates/base/src/runtime/mod.rs`, `test_user_runtime_creation`) fixa
  `allowed_apis = ["waitUntil"]`.
- `types/global.d.ts` do mesmo repositório: `EdgeRuntime.userWorkers` é o
  `UserWorker.create(...)` do runtime principal, com `memoryLimitMb`,
  `workerTimeoutMs` e `cpuTimeHardLimitMs` — é a API do *embarcador/ingress*
  que cria o sandbox da função, não algo chamável pelo código da função.
- README do `edge-runtime`: separa *main runtime* (sem limites, acesso a
  variáveis) e *user runtime* (limites obrigatórios de memória e tempo); a
  função do AraHub roda no segundo.

Consequência: nem `EdgeRuntime.userWorkers` (inacessível à função) nem os
limites do provedor servem como isolamento terminável. Os limites do provedor
(CPU/memória/relógio) encerram o **isolate inteiro** pelo supervisor, sem
devolver resultado controlado; não podem ser promovidos a `hard_timeout:true`
nem usados para "limitar" um parse hostil na thread principal. Habilitar a
extração na thread principal por variável de ambiente (alegando limite externo)
é o que `HOSTED_UNAVAILABLE_NOTE` proíbe e a prova de regressão barra.

Rota suportada para PDF remoto:

1. **Local (padrão hoje).** `extractPdf` roda no processo local com worker
   terminável, sobre os bytes preservados (RLS por dono), e grava a memória
   (ver "Integração com Materials/MCP"). É o caminho usado pelos testes de
   `materials`/MCP.
2. **Cliente.** Na tela PDFs, o botão de extração recebe os bytes
   preservados do dono e confere o SHA-256 antes de iniciar um módulo Worker
   da mesma origem. `web/pdf_worker.ts` inclui o parser Mozilla fixado, sem
   CDN nem credenciais na thread. O parser interno roda dentro desse worker
   descartável; cancelamento, sucesso, falha e o limite de 18 segundos sempre
   encerram a thread. Nenhum PDF é aberto ou renderizado pela interface.

   O lote tem até 500 páginas e 400.000 caracteres, começando na página
   indicada pelo checkpoint. `startPage` permite continuar após o orçamento;
   páginas anteriores permanecem na memória. A lista usa cursor de arquivo.
   Texto em imagem continua com lacuna explícita, sem OCR.

   As rotas pessoais `/api/pdf/list`, `/api/pdf/bytes` e `/api/pdf/commit`
   exigem sessão ativa, dono e hash; uma sessão MCP não pode se passar pelo
   navegador. O servidor limita e normaliza o relato, deriva a cobertura e
   mescla sob lock. A origem fica `browser_client`, não corroborada pelo
   servidor: o texto é dado não confiável, vinculado ao arquivo preservado.
   Receber texto de uma sessão pessoal não autoriza operações externas.

   O pacote Pages inclui `ui/pdf-parser.worker.js`, com `worker-src 'self'`
   e licença Apache-2.0 do pdf.js nas atribuições. O código próprio continua
   MIT. O backend Edge recebe a extração, sem executar o parser na sua thread.

Evidência honesta: os testes locais provam `execution:"isolated_worker"` e
`hard_timeout:true`; a simulação do runtime hospedado (sem `Worker` e com
`EdgeRuntime` só com `waitUntil`) prova a recusa sem executar o PDF. O backend está implantado; o parser continua recusado na thread da Edge.
A rota cliente hospedada foi operada com PDF sintético, dois viewports e Auth
nativo, gravação privada/recuperação MCP. Isso não comprova PDF acadêmico real
na conta titular nem OCR; a prova acadêmica real disponível é local.

## Provas executadas

- `tests/pdf_client_test.ts`: dez provas SQL/HTTP de dono, sessão pessoal,
  hash/tamanho, formato hostil, contagem de páginas forjada, normalização,
  idempotência, retomada e preservação de extração anterior melhor. O digest
  dos bytes é conferido sob o mesmo lock da gravação. A listagem projeta
  somente números/estados de página, sem carregar texto de todos os PDFs.
- `scripts/qa_pages.mjs`: Chrome em 390×844 e 1280×900 extraiu o PDF
  acadêmico público real em worker da mesma origem, sem violações CSP. Hash
  adulterado não chegou à gravação. Cancelamento e timeout encerraram um
  worker com CPU síncrona infinita; a UI continuou utilizável. HTTP/Auth foram
  simulados nessa prova. Nenhuma imagem foi salva pela interface.
- O resultado privado desse worker, fixado ao SHA-256 do PDF, passou depois
  pelas rotas pessoais HTTP reais no banco local. Um cliente MCP novo
  recuperou as páginas; dono distinto e hash alterado foram recusados. A
  identidade foi sintética, sem implantação, conta real ou OCR.

- `deno check src/pdf_text.ts tests/pdf_text_test.ts` — sem erros.
- `deno test --allow-env --allow-read tests/pdf_text_test.ts` — 9 aprovados,
  0 falhas. Fixture sintética
  de 3 páginas reais (texto Latin-1 com acentos, texto não latino por nomes de
  glifos e página só com imagem), gerada no próprio teste e **parseada pelo
  pdf.js**: `coverage:complete`, unicode `αβΩАéñ` extraído, página 3 com
  `text_absent` e `image_count:1`. Cobre ainda: paginação/truncamento,
  inválido/vazio/grande/criptografado, PDF hostil com `/OpenAction`, `/AA` e
  `/Names /JavaScript` (nada executado), timeout e abort, e a recusa
  `worker_unavailable` com o opt-in `allowMainThreadFallback`. As duas provas
  de rota hospedada cobrem: recusa sem `Worker` sem executar PDF hostil,
  variáveis de ambiente (incl. `SUPABASE_URL`/`DENO_DEPLOYMENT_ID`) não ligam a
  thread principal, `Worker` que lança no construtor é tratado como
  indisponível e `Worker` que erra ao iniciar devolve
  `pdf_runtime_unavailable`/`execution:"not_started"` sem `hard_timeout` falso.
- PDF real de consumidor: página gerada pelo Chromium headless isolado
  (Playwright privado, sem perfil de usuário, sem download de imagem) produziu um
  PDF de 27 920 bytes, 2 páginas, com fontes embutidas; `extractPdfText` retornou
  `ok:true`, `coverage:complete`, `execution:isolated_worker`,
  `hard_timeout:true`, `page_count:2` e o texto completo com acentos, grego e
  cirílico. O PDF de prova ficou fora do repositório (diretório temporário).
- Limite rígido: `terminate()` encerrou um laço síncrono de 8 s em ~166 ms.
- `tests/material_pdf_test.ts` (novo) — 10 aprovados, 0 falhas, contra o
  Postgres local exclusivo, com PDF sintético de três páginas gerado no próprio
  processo (sem dados reais, sem rede externa, sem navegador): propriedade/RLS
  por dono, hash divergente e bytes adulterados sem tocar a memória, `mime`
  não-PDF, limite de páginas com lacuna declarada e preenchimento posterior,
  leitura por página (`pdf:page:N`, página só de imagem com `text_absent`),
  preservação da extração anterior melhor (retry limitado/idêntico não
  reescreve, decode mais fraco não apaga texto, execução sem páginas não apaga
  nada), página truncada retida não declara cobertura completa, extratores
  concorrentes do mesmo hash mantêm a versão de três páginas, guarda
  `connection_unavailable` sem `ConnectionService` e um cliente MCP SDK real
  (StreamableHTTP sobre `createEdgeHandler` in-process, JWKS/dono/sessão
  sintéticos) chamando `hub_extract_pdf`/`hub_pdf_page`, com cliente novo
  retomando páginas e hash errado devolvendo `file_changed`.

## Limitações e pendências

- Sem OCR e sem interpretação de imagens; texto em imagem não é recuperado.
- Ordem de leitura vem do pdf.js; estrutura marcada (tags), colunas e tabelas não
  são preservadas como semântica.
- cmaps CJK e fontes padrão exóticas não foram validados com PDFs reais.
- Rota hospedada **Supabase Edge** não suporta a extração (ver
  "Disponibilidade hospedada"); depende de runtime local ou do cliente.
- PDF acadêmico público real, obtido diretamente por HTTP fora da interface:
  [Attention Is All You Need, arXiv v7](https://arxiv.org/abs/1706.03762v7),
  2.215.244 bytes e 15 páginas. `scripts/validate_pdf_real.ts` preservou os bytes
  no Postgres local e operou ferramentas pelo SDK sobre um socket HTTP real:
  extração inicial de duas páginas, retomada por cliente novo, preenchimento
  completo, dono distinto negado e hash alterado recusado. Identidade sintética;
  não é prova de conta Google/Moodle real nem runtime hospedado. O PDF e a
  evidência permanecem privados e não recebem a licença MIT do código.
