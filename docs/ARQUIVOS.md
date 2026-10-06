# Arquivos e extração de texto de PDF

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

**Sem worker terminável** (ex.: runtime Edge), a extração é **recusada** por
padrão com `worker_unavailable`, `execution:"main_thread"` e
`hard_timeout:false`. Um chamador de runtime local, sob limite externo
(subprocesso ou timeout de servidor), pode optar por
`allowMainThreadFallback: true`; nesse modo o resultado permanece com
`hard_timeout:false` e os limites incluem o aviso de que o tempo é
cooperativo. Essa opção **não deve** ser usada na rota hospedada.

## Dependência e runtime

- `pdfjs-dist@6.4.299` (pdf.js da Mozilla), importado pelo build legado
  `npm:pdfjs-dist@6.4.299/legacy/build/pdf.mjs`. A versão está fixada em
  `PDFJS_VERSION`; o `workerSrc` é o caminho relativo `./pdf.worker.mjs`,
  resolvido a partir do próprio `pdf.mjs` (não dependemos de
  `import.meta.resolve` para especificadores npm).
- O specifier `npm:` é inline, então não é preciso editar `deno.json` para
  compilar. O root ainda deve **integrar a configuração**: registrar a
  dependência no `deno.lock` (basta um `deno check`/`deno test` sem
  `--no-lock`, ou um `deno cache` antes do gate) e, se desejar, mapear
  `"pdfjs-dist": "npm:pdfjs-dist@6.4.299"` em `imports`.
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

Recomendação para o root: expor `deno task pdf:extract` apontando para um CLI
fino (`deno run --allow-read --allow-env scripts/pdf_extract.ts`) que apenas
chama `extractPdfText` e imprime o JSON. O isolamento já está dentro da função,
então o CLI não precisa criar worker próprio; para um limite externo adicional,
execute o CLI sob um subprocesso com timeout e kill.

## Provas executadas

- `deno check src/pdf_text.ts tests/pdf_text_test.ts` — sem erros.
- `deno test tests/pdf_text_test.ts` — 7 aprovados, 0 falhas. Fixture sintética
  de 3 páginas reais (texto Latin-1 com acentos, texto não latino por nomes de
  glifos e página só com imagem), gerada no próprio teste e **parseada pelo
  pdf.js**: `coverage:complete`, unicode `αβΩАéñ` extraído, página 3 com
  `text_absent` e `image_count:1`. Cobre ainda: paginação/truncamento,
  inválido/vazio/grande/criptografado, PDF hostil com `/OpenAction`, `/AA` e
  `/Names /JavaScript` (nada executado), timeout e abort, e a recusa
  `worker_unavailable` com o opt-in `allowMainThreadFallback`.
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
- Rota hospedada Edge não suporta a extração; depende do processo local.
- `deno check` do repositório inteiro falha hoje em `tests/connections_test.ts`
  (trabalho de sincronização em andamento, fora deste escopo); os arquivos desta
  entrega passam isoladamente.
