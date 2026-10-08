# Processamento de materiais: DOCX, HTML de Book/Page e vídeo

Este documento descreve a frente de materiais do AraHub (critérios MAT-01,
MAT-02, MAT-04, MAT-05, MAT-06 e READ-03): extração **segura e estruturada** de
DOCX, saneamento e estruturação de **HTML** de Book/Page e o **pipeline local
de vídeo** que verifica legendas, transcreve a fala em CPU quando não há legenda
e declara o que ficou de fora. É
genérico: não contém dados de usuários, nomes, trechos de fonte acadêmica nem
contas.

## Escopo implementado

Três arquivos novos, sem alterar a integração raiz (`src/materials.ts`,
`mcp.ts`, `domain.ts`, `sync.ts`, migrations, `deno.json`, `web/`):

| Arquivo | Papel |
|---|---|
| `src/document_text.ts` | leitor de ZIP/OOXML, tokenizador de XML, extração DOCX, tokenizador/saneador de HTML, blocos com localizadores e `inspectOfficeArchive` |
| `src/material_processor.ts` | ffprobe/ffmpeg locais: sondagem, legendas embutidas com timestamps, ASR local (filtro whisper + modelo ggml pinado), áudio para ASR e quadro isolado |
| `scripts/process_materials.ts` | worker separado (processo local, sem navegador) que processa uma pasta privada e grava extrações idempotentes |

Nenhum dos três depende de DOM, de `node:`, de rede ou de credencial. O módulo
de documentos roda igualmente no processo local, num Worker dedicado ou no Edge;
o de mídia exige um executor local com `ffmpeg`/`ffprobe`.

O que fica **fora** do escopo, e é declarado no resultado:

- **sem OCR** e sem interpretação de imagens: imagens são contadas e
  registradas como lacuna, nunca descritas;
- **sem execução** de scripts, macros, campos, objetos ou ações embutidas;
- **sem resolução de entidades externas** (DOCTYPE é recusado);
- **sem transcrição de fala** por padrão: legenda embutida não é transcrição e
  não é verificada contra o áudio;
- **sem análise visual**: quadros não são interpretados, apenas materializáveis
  sob pedido explícito.

## DOCX: ZIP seguro e estrutura OOXML

### Leitura do pacote

`src/document_text.ts` lê o ZIP pelo **diretório central** (e pelo registro
ZIP64 quando presente), nunca por varredura otimista de cabeçalhos:

- entradas cifradas (bit 0 do `flags`) → `document_encrypted` / cobertura
  `denied`; o conteúdo não é extraído;
- nomes vazios, longos, absolutos, com `\\`, `..` ou duplicados →
  `unsafe_archive` / `unavailable`;
- métodos exóticos (bzip2, LZMA, zstd, deflate64) → `unsupported_compression`
  na **entrada lida**, sem tentativa de interpretar bytes alheios;
- razão de descompressão atípica e total declarado acima do teto →
  `zip_limits_exceeded` (defesa contra bomba de descompressão);
- tamanho descomprimido divergente do declarado ou **CRC-32** divergente →
  `zip_integrity`; nada é aproveitado de um pacote inconsistente;
- `stored` (0) e `deflate` (8) são os únicos métodos aceitos, com
  `DecompressionStream("deflate-raw")` e **teto de bytes durante a
  descompressão** (não confia no tamanho declarado).

Limites: 32 MiB de arquivo, 2 048 entradas, 24 MiB por parte, 96 MiB
descomprimidos no total, razão 400× com folga de 1 MiB.

### XML

O XML passa por um tokenizador com estado — não regex — que:

- recusa `DOCTYPE`/declaração de entidade (`invalid_xml`), o que elimina
  expansão de entidades internas e externas;
- decodifica apenas entidades numéricas e as cinco predefinidas;
- limita profundidade (512) e número de eventos (5 000 000);
- reconsome marcação malformada em vez de "consertar" silenciosamente, e
  recusa fechamento que não casa com a abertura.

### Estrutura extraída

Blocos, cada um com localizador estável:

| Estrutura | Localizador | Conteúdo |
|---|---|---|
| parágrafo | `docx:p:N` | texto, estilo (`style_id`/`style_name`), `heading_level`, listas (`num_id`/`num_fmt`/`level`), citação, código, trechos formatados por deslocamento (`spans`), campos e imagens |
| tabela | `docx:table:T` | linhas, colunas, células |
| célula | `docx:table:T:rR:cC` | texto, `grid_span`, `v_merge` (`restart`/`continue`), número de parágrafos |
| hiperlink | `docx:link:L` | texto, `target` resolvido em `document.xml.rels`, `relationship_id`, âncora interna, tipo (`external`/`internal`/`unknown`) |
| imagem | contagem | nunca interpretada |

Regras de honestidade aplicadas:

- `heading_level` vem de `w:outlineLvl` (direto ou herdado por `basedOn`) ou
  do nome/ID de estilo (`Heading`/`Título`), sem inventar nível;
- listas usam `numFmt` real de `numbering.xml` quando disponível; sem essa
  parte, `num_fmt` é `null` em vez de suposto;
- tabela **não é achatada sem aviso**: `grid_span` e `v_merge` ficam na
  célula e a fusão entra em `gaps`;
- texto excluído por revisão (`w:delText`) não entra e é declarado em `gaps`;
  `w:ins` é incluído;
- campos (`w:instrText`, `w:fldSimple`) têm a instrução registrada; caixas de
  texto, notas de rodapé/fim, comentários, subdocumento e `altChunk` **não**
  são varridos e aparecem como lacuna nomeada;
- metadados vêm de `docProps/core.xml` (título, autor, revisão, datas), sem
  tratá-los como conteúdo.

### Códigos de erro do DOCX

`empty_input`, `oversized`, `not_a_docx`, `invalid_zip`, `missing_document_part`,
`document_encrypted` (`denied`), `unsupported_compression`, `unsafe_archive`,
`zip_limits_exceeded` (`unavailable`), `zip_integrity`, `invalid_xml`,
`html_empty`, `unreadable`. Só opções fora do intervalo lançam
`HubError("invalid_document_options")`; conteúdo do documento nunca lança.

## HTML de Book/Page: saneamento sem executar

Pipeline: tokenizar → construir árvore → filtrar por lista de permissão →
serializar → extrair blocos.

- **Lista de permissão** de tags; `script`, `style`, `iframe`, `object`,
  `embed`, `form`, `input`, `button`, `svg`, `math`, `video`, `audio`,
  `source`, `link`, `meta`, `base`, `template`, `textarea` e afins são
  descartados **com contagem** em `sanitizer_removals`;
- **atributos**: só `href`/`cite` (com esquema verificado), `title`, `alt`,
`colspan`/`rowspan`/`scope`/`headers`, `start`/`type`/`value`, `datetime`.
  Atributos de evento (`on*`) são descartados e contados; `style`, `class`,
  `id` e `src` não sobrevivem;
- **URLs**: `javascript:`, `vbscript:`, `data:`, esquema desconhecido e URL
  com credenciais embutidas são recusados (contados como `url_perigosa`); a
  verificação remove controles e espaços antes de comparar o esquema, o que
  fecha o disfarce `&#106;avascript:` e `java\tscript:`; só `http`,
  `https`, `mailto` e `tel` passam, e URLs relativas/âncoras permanecem
  relativas e registradas (`url_relativa_mantida_sem_resolucao`) — nunca são
  resolvidas contra uma origem;
- **marcação malformada**: `<<script>alert(1)</script>` é recomeçado no
  segundo `<` e o script cai; âncora que perdeu o destino vira texto simples
  (`ancora_sem_destino`);
- **imagens** entram como `[imagem: alt]` (ou `[imagem]`), sem `src`; mídia
  descartada vira `[mídia não interpretada]` e alimenta `gaps`;
- **elementos textuais** viram blocos: títulos (`h1..h6`), parágrafos, itens de
  lista (`bullet`/`decimal`/`term`/`definition` com nível), citação,
  `pre`, tabela/célula e legenda de tabela (marcada como não vinculada);
- texto inline do pai não é duplicado em blocos filhos, e conteúdo de célula
  inclui o que estiver dentro dela (a célula é bloco folha);
- localizadores: `html:block:N`, `html:table:T`, `html:table:T:rR:cC`,
  `html:link:L`.

Limites: 8 MiB de HTML, 2 000 000 caracteres de HTML saneado, 20 000 blocos,
200 000 nós, profundidade 256. Codificação é detectada por `<meta charset>`
(UTF-8 por padrão; `windows-1252`/`iso-8859-1` são suportados) e registrada.

## Vídeo e áudio: legendas verificadas e ASR local

Pipeline local em CPU, com `ffprobe` e `ffmpeg` (sem shell, sem rede, sem
upload):

1. `probeMediaFile` — contêiner, duração e faixas; distingue legenda **de
   texto** (subrip, ass, mov_text, webvtt, text, eia_608…) de legenda **de
   imagem** (PGS, DVB, DVD, XSUB), que exigiria OCR;
2. `extractEmbeddedSubtitles` — extrai cada faixa de texto para SRT em memória
   e interpreta os cues (`video:sub:FAIXA:INDICE`, `start_ms`, `end_ms`,
   texto), preservando acentuação e removendo marcação ASS/HTML;
3. `processVideo` — reúne tudo, define `transcript_source` (`embedded_captions`
   ou `none`), o estado `asr` e o texto de `asr_gap_note`;
4. `extractAudioForAsr` (opcional) — grava PCM 16 kHz mono, o insumo concreto
   de um motor de ASR local;
5. `extractFrameAt` (opcional) — grava **um** quadro em PNG/JPEG para inspeção
   futura, com os bytes produzidos por processo local, fora de qualquer
   interface;
6. `transcribeLocal` (opcional, quando não há legenda no arquivo) — transcreve
   a fala com o **filtro `whisper` (whisper.cpp) do ffmpeg local** e um modelo
   ggml informado, devolvendo segmentos com timestamps e localizador
   (`asr:pt:N`).

Estados e honestidade:

- `captions_present:false` **não** é "sem conteúdo": é ausência de legenda;
- sem modelo configurado, `asr` é `not_attempted` e `asr_engine` é `none`:
  **nenhuma transcrição é afirmada**; com modelo, `asr` é `completed_local` e
  `asr_engine` é `ffmpeg_whisper_cpp`;
- `transcript_reviewed`/`asr_reviewed` é sempre `false`: a saída do motor é
  dado de máquina, sem revisão humana de pontuação, nomes ou precisão;
- **cobertura de transcrição é cobertura de execução/linha do tempo, nunca
  acurácia**: o resultado carrega `coverage_scope:"temporal_execution"`,
  `accuracy_verified:false` e `source_unreviewed:true`, e a nota fixa diz isso
  em texto. O titular observou erros ortográficos visíveis na saída real; os
  exemplos relatados não são reproduzidos aqui por serem conteúdo privado;
- `visual_analysis` é sempre `not_performed`: legenda e transcrição não
  descrevem quadros, slides, gestos ou demonstrações em tela;
- `tool_unavailable` (binário ausente), `run_permission_denied` (sem
  `--allow-run`) e `timeout` são estados distintos, não "sem legendas";
- `model_missing`, `model_integrity` (sha256 divergente do pin) e
  `asr_failed` (modelo inválido, filtro falhou) são recusas explícitas: um
  modelo inválido **nunca** vira transcrição, e um resultado falho nunca é
  reutilizado;
- nenhuma legenda é atribuída à fala: ela é a legenda **da fonte**, com faixa e
  idioma registrados.

### Escaping de caminho no grafo de filtros (medido)

O filtro recebe o modelo dentro de um grafo de filtros, e esse parser tem regras
próprias. Medido neste ffmpeg (9.0.1), com o erro real do binário:

| Forma | Resultado |
|---|---|
| `C\:/dir/m.bin` (uma barra antes do dois-pontos) | **falha de parse** ("No option name near") |
| `C\\:/dir/m.bin` (barra dupla) | lido como `C:/dir/m.bin` — **correto** |
| `C\\:\\\\dir\\\\m.bin` | lido como `C:\dir\m.bin` — correto, com barra invertida |
| `C:/dir/m.bin` (sem escape) | **falha de parse** |
| vírgula, ponto e vírgula, colchetes | **falha de parse** |
| apóstrofo | parse aceita e **descarta o caractere** (`dir'asp` → `dirasp`) |

O parser desescapa duas vezes, por isso a barra dupla. `filterOptionValue`
normaliza a barra invertida para barra e aplica a barra dupla no dois-pontos;
`isGraphSafePath` **recusa** caminho com vírgula, ponto e vírgula, colchetes,
apóstrofo ou caractere de controle. Recusar é deliberado: o apóstrofo descartado
apontaria silenciosamente para **outro arquivo**. Como o processo roda com
`cwd` no diretório de saída, o módulo também fixa os caminhos **absolutos** de
entrada e de modelo antes de executar — um caminho relativo seria resolvido no
lugar errado (defeito real encontrado na primeira execução pelo CLI).

Limites: 20 000 cues por faixa, 8 MiB de saída de legenda, 120 s por processo
(20 s para sondagem), diagnóstico de erro com caminhos redigidos.

## API

```ts
import {
  documentExtractionToText, extractDocxText, extractDocumentText, extractHtmlText,
  inspectOfficeArchive, sanitizeHtmlDocument,
} from "./document_text.ts";

extractDocxText(bytes, { maxBytes?, maxBlocks?, maxTextChars?, maxTableCells? })
  : Promise<DocumentTextExtraction>          // kind:"document_text_extraction", format:"docx"
extractHtmlText(stringOuBytes, { maxBytes?, maxBlocks?, maxTextChars?, maxSanitizedChars? })
  : Promise<DocumentTextExtraction>          // format:"html", com sanitized_html
extractDocumentText(bytes, { format?: "auto" | "docx" | "html" })
  : Promise<DocumentTextExtraction>          // assinatura PK\x03\x04 → DOCX
documentExtractionToText(result): string     // texto com marcadores de localizador
sanitizeHtmlDocument(html, maxChars?): { html, text, root, removals, images, truncated }
inspectOfficeArchive(bytes, { maxBytes? }): Promise<OfficeArchiveInspection>
```

```ts
import {
  extractAudioForAsr, extractEmbeddedSubtitles, extractFrameAt, mediaTools,
  parseSubtitleCues, probeLocalAsr, probeMediaFile, processVideo,
} from "./material_processor.ts";

mediaTools({ ffmpegPath?, ffprobePath? })          // versão, disponibilidade, permissão de execução
probeMediaFile(path, { byteLength?, timeoutMs? })  // contêiner, duração, faixas
extractEmbeddedSubtitles(path, { probe?, ... })     // faixas de texto com cues
processVideo(path, { audioOutputPath?, checkAsr?, modelPath?, ... }) // pipeline completo
probeLocalAsr({ modelPath? })                       // capacidade real da máquina, sem baixar modelo
extractAudioForAsr(path, outPath)                   // PCM 16 kHz mono
extractFrameAt(path, atMs, outPath)                 // um quadro PNG/JPEG
parseSubtitleCues(text, streamIndex, { maxCues? })  // SRT/WebVTT sem DOM
transcribeLocal(path, { modelPath, language?, expectedModelSha256?, destinationPath?,
                        queue?, timeoutMs?, mediaDurationMs? }) : Promise<LocalTranscriptionResult>
filterOptionValue(value): string                      // escaping medido para o grafo de filtros
isGraphSafePath(value): boolean                       // recusa vírgula, ;, [ ], apóstrofo, controle
shouldReuseTranscription(previous, expected): boolean // retomada: motor + idioma + sha do modelo
```

### `inspectOfficeArchive`

Pensado para o resolvedor de upload/artifacts identificar DOCX/PPTX/XLSX e
variantes com macro a partir de **bytes já persistidos**, sem duplicar a
leitura de ZIP e sem descomprimir o corpo:

```jsonc
{
  "container": "zip",
  "ok": true,
  "encrypted": false,
  "entry_count": 8,
  "has_content_types": true,
  "content_type_defaults": { "rels": "application/vnd.openxmlformats-package.relationships+xml" },
  "content_type_overrides": { "/word/document.xml": "…document.main+xml" },
  "main_parts": ["word/document.xml"],
  "detected": "docx",              // "pptx" | "xlsx" | null
  "macro_enabled": false,
  "media_type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "content_is_untrusted_data": true
}
```

A detecção usa o `[Content_Types].xml` (defaults/overrides) combinado com a
presença da parte principal; quando há mais de uma principal, o override
desempata. Um corpo com método de compressão exótico ou CRC inválido **não**
impede a inspeção — prova de que o corpo não é lido. Estados: `not_zip`,
`empty_input`, `oversized`, `document_encrypted`, `unsafe_archive`,
`zip_limits_exceeded`, `unreadable`.

## Integração mínima sugerida com a raiz (não aplicada)

`src/materials.ts` é da integração raiz e **não foi alterado**. A integração
compatível reaproveita o caminho do PDF:

1. `hub_files.extraction` já é `jsonb` livre: a extração de documento grava o
   mesmo envelope com `kind:"document_text_extraction"` e `format`
   (`docx`/`html`), sem migration nova;
2. `extracted_text` recebe `documentExtractionToText(result)`, que preserva os
   localizadores (`docx:p:N`, `docx:table:T:rR:cC`, `html:block:N`);
3. o merge sob lock deve seguir a mesma regra do PDF, trocando "página" por
   **localizador**: um bloco novo só substitui o guardado se tiver mais
   caracteres ou se o guardado estiver ausente; execução mais fraca (limite,
   erro, sem blocos) **nunca** apaga texto já extraído do mesmo `sha256`;
4. cobertura derivada no servidor: `complete` só com todas as partes lidas, sem
   truncamento e sem lacuna que plausivelmente esconda texto; imagens, campos
   não resolvidos e fusões **não** promovem cobertura;
5. leitura por localizador para o cliente (análoga a `hub_pdf_page`), com
   `content_is_untrusted_data:true` e a mesma checagem de dono/hash;
6. a aquisição de bytes continua **uma só**: o resolvedor entrega bytes
   persistidos; este módulo só os interpreta.

Enquanto isso não é decidido pela raiz, o caminho executável é o CLI local
abaixo, que não depende de rota hospedada.

## CLI / worker local

```powershell
deno run --allow-read --allow-write=.private --allow-run=ffmpeg,ffprobe \
  scripts/process_materials.ts --in .private/entrega-1/materials/source \
  --out .private/entrega-1/materials/extracted \
  [--transcribe --model CAMINHO --model-sha SHA256] [--language pt] [--frames N] \
  [--reprocess-media] [--audio] [--asr] [--force] [--limit N]

deno run --allow-read --allow-write=.private --allow-run=ffmpeg,ffprobe \
  scripts/process_materials.ts --check
```

Comportamento: lê a pasta privada, identifica o tipo por extensão (`docx`,
`html`, `pdf`, `video`, `audio`), calcula `sha256` dos bytes e grava
`<out>/<sha256>/extraction.json` mais `text.txt` (texto com localizadores).
É **idempotente por conteúdo e por versão de extrator**: o que já está no
manifesto com a mesma versão é reaproveitado (`reused:true`); `--force`
reprocessa. O manifesto (`<out>/manifest.json`) guarda por arquivo o
`sha256`, caminho de origem, tipo, cobertura, resumo de contagens e a versão
do extrator — é o estado durável mínimo que permite retomar sem reprocessar.

Para mídia, o CLI acrescenta a transcrição e os quadros:

- `--transcribe` liga o ASR local **só quando o arquivo não tem legenda** (a
  legenda da fonte tem precedência);
- `--transcribe` exige `--model` e `--model-sha` explícitos; não escolhe `base`
  nem reaproveita implicitamente o pin histórico. Modelos leves não satisfazem
  o critério de qualidade PT-PT; uma execução ASR permanece não revisada até
  conferência do áudio. Modelo e hash são conferidos antes de executar;
- `--frames N` grava quadros PNG privados nos meios dos segmentos de fala (ou
  distribuídos pela duração quando não há transcrição), com `frames/frames.json`
  descrevendo instante, tamanho e sha256;
- `--reprocess-media` refaz a análise de mídia reaproveitando a transcrição
  guardada quando motor, idioma e sha do modelo coincidem.

### Artefatos de transcrição (para o leitor da raiz)

Em `<out>/<sha256>/`:

| Arquivo | Conteúdo |
|---|---|
| `transcript.srt` | saída do motor no formato SRT |
| `transcription.json` | `segments[]` com `locator` (`asr:pt:N`), `start_ms`, `end_ms`, `text`; `model` (caminho, bytes, sha256, integridade); `timeline_coverage_ratio`; `coverage_scope:"temporal_execution"`; `accuracy_verified:false`; `source_unreviewed:true`; `transcript_reviewed:false`; `visual_analysis:"not_performed"`; `cache` (motor/idioma/sha do modelo) para retomada |
| `text.txt` | transcrição legível com marcador de localizador por segmento |
| `frames/frame-N.png` e `frames.json` | quadros privados, com instante, bytes e sha256 |
| `extraction.json` | resultado composto (`transcript_source:"local_asr"`, `asr:"completed_local"`, `asr_reviewed:false`) |

Uma transcrição falha grava `transcription.json` com `ok:false` e `error_code`
e **não** é reutilizada: o cache só vale para execução `ok:true`.

O CLI usa o caminho local do arquivo para ffmpeg/ffprobe (mídia) e bytes em
memória para DOCX/HTML/PDF; não copia, não envia e não baixa nada. A saída
padrão traz apenas contagem/cobertura/hash — nunca texto, nome de pessoa ou
caminho.

## Ingestão local no banco exclusivo

`scripts/import_processed_materials.ts` leva o material já processado para o
banco **local** do AraHub (127.0.0.1:55432; qualquer outro host é recusado
antes de conectar). Ele lê o manifesto de origem (ocorrência/hash) e a extração
preservada em `extracted/<sha256>/` e grava ocorrência, origem, bytes, texto,
representação e proveniência em `hub_files`, `hub_entities`,
`hub_observations` e `hub_relations`.

Regras de projeto:

- **fonte isolada**: conexão `provider='migration'` com origem própria do
  snapshot (`local-materials-snapshot`). Nenhuma permissão Moodle é exigida,
  porque isto é ingestão de snapshot e não acesso ao provedor; a observação
  registra `provider_read:false`;
- **idempotência qualificada por origem/hash**: entidade por `external_id`
  (fileid de origem), arquivo por (dono, entidade, sha256), observação por hash
  de conteúdo, relação por (de, para, tipo);
- **sha256 conferido antes e depois**: os bytes são relidos do disco e
  comparados com o manifesto; divergência **recusa** a ocorrência. Depois de
  gravar, o digest do `binary_content` é reconferido no banco;
- **nunca rebaixa extração**: a mesma regra do merge de PDF, aqui por
  (cobertura, caracteres) — execução mais fraca do mesmo hash mantém o que está
  gravado, e a importação não promove cobertura;
- **binário de até 64 MiB em um INSERT único local** é válido: o fatiamento
  existia para o limite do Edge, não para este banco;
- **relação derivada exige evidência**: o vínculo material→módulo só é criado
  quando o nome de arquivo casa com o conteúdo de **exatamente um** módulo do
  snapshot; com mais de um candidato, o vínculo **não** é afirmado e a
  ambiguidade fica registrada com os módulos candidatos. Todo material recebe o
  vínculo com o snapshot (origem, caminho, observação, cobertura, sha).

Uso:

```powershell
deno run --allow-net=127.0.0.1:55432 --allow-read --allow-write=.private --allow-env \
  scripts/import_processed_materials.ts [--dry-run] [--limit N]
```

`--dry-run` valida bytes e sha e **não** escreve nada (nem conexão/entidade).
O resumo privado fica em `.private/entrega-1/materials/import-<carimbo>.json`.

Resultado na base real já autorizada: **19 ocorrências importadas** (18 arquivos
distintos — duas ocorrências compartilham os mesmos bytes), 19 arquivos, 19
observações, 24 relações (19 de proveniência com o snapshot + 5 de módulo), 14
ambiguidades registradas sem vínculo (o mesmo nome de capítulo aparece em dois
`book` e duas `page`, sem tamanho para desempatar) e **19/19 binários
reconferidos por digest**. Reexecução é idempotente: 0 inserções novas, 0
observações novas, tudo `kept_prior`.

## Cobertura: o que promove e o que rebaixa

| Estado | Quando |
|---|---|
| `complete` | todas as partes necessárias lidas, sem truncamento, sem lacuna que possa esconder texto |
| `partial` | limite de blocos/texto atingido, legenda ausente, imagem não interpretada, fusão de célula, âncora/mídia removida com conteúdo |
| `denied` | pacote cifrado, permissão de execução negada |
| `unavailable` | acima de limite, ferramenta ausente, método de compressão não suportado |
| `timeout` | limite de tempo do processo excedido |
| `parsing_error` | ZIP/XML/HTML inválido, CRC divergente, parte ausente |

`partial` não é falha: é a declaração de que alguma superfície ficou fora. Uma
imagem contada, uma legenda ausente ou uma fusão de célula **não** tornam a
leitura "completa".

## Provas executadas

- `tests/document_text_test.ts` — 21 provas. As fixtures são sintéticas e
  geradas no próprio teste: pacotes OOXML montados com ZIP real (entradas
  `stored` e `deflate`, CRC correto) e HTML escrito à mão; o MP4 é gerado
  por `ffmpeg` local com faixa `mov_text`.
  - DOCX: parágrafos com estilo/herança (`basedOn`), lista com `numFmt`,
    tabela com `gridSpan`/`vMerge`, hiperlink externo resolvido por
    relacionamento e âncora interna, campos, revisão (`w:del`/`w:ins`),
    imagem contada, metadados, `parts_read`, localizadores;
  - DOCX hostil/limites: vazio, não-ZIP, excesso, ZIP truncado, cifrado,
    método exótico, nome inseguro, nome duplicado, bomba de descompressão,
    total declarado acima do teto, CRC e tamanho divergentes, parte principal
    ausente, `DOCTYPE` com `ENTITY` (nenhuma expansão), fechamento que não
    casa, profundidade excessiva, caixa de texto como lacuna;
  - `inspectOfficeArchive`: DOCX, PPTX, XLSX, variante com macro, ambiguidade
    desempatada por Content Types, não-ZIP, vazio, excesso, cifrado, e a prova
    de que corpo com método exótico ou CRC inválido **não** é lido;
  - HTML: saneamento sem execução (nenhum `script`/`on*`/`javascript:`/
    `src=`/`data:` sobrevive), disfarces (`<<script>`, entidade, tab,
    credenciais), remoções contadas, tabelas com fusão, listas aninhadas sem
    duplicação, âncoras sem destino, `pre`, citação, `windows-1252`,
    truncamento, despacho por assinatura;
  - mídia: cues SRT/WebVTT sem DOM (sempre executado) e, quando há permissão de
    execução e escrita, o pipeline real com `ffmpeg`: legendas embutidas com
    timestamps, ausência de legenda com lacuna de ASR explícita, áudio PCM e
    quadro PNG;
  - ASR: escaping do grafo (barra dupla no dois-pontos, normalização da barra
    invertida) e recusa de caminho inseguro; cache que só reutiliza com motor,
    idioma e sha do modelo iguais; modelo ausente e idioma inválido falhando sem
    executar; e, com permissões, caminho inseguro recusado e **modelo inválido
    falhando com `asr_failed` sem fingir transcrição** — nenhuma prova exige
    modelo global.
- Comando real do pipeline de vídeo:
  `deno test --allow-read --allow-write --allow-run=ffmpeg,ffprobe --allow-env tests/document_text_test.ts`
  — **21 aprovados, 0 falhas**. No gate `deno task test` (sem `--allow-run`),
  as provas que exigem processo aparecem como `ignored`, não como aprovadas,
  sem esconder a lacuna.
- Material real já preservado pelo titular: 18 arquivos locais (14 HTML,
  3 DOCX, 1 MP4) e ~48,8 MB, processados pelo CLI. Os 18 `sha256` locais
  coincidem com os declarados no manifesto privado da raiz. Resultado: 18/18
  `ok`, 12 `complete` e 6 `partial`; lacunas registradas foram imagens não
  interpretadas (2), fusões de célula (2), mídia/âncora/URL removidas (6) e
  caixa de texto em DOCX (3). Nenhum texto, nome de pessoa ou caminho foi
  impresso; as extrações e o manifesto ficam em `.private/entrega-1/materials/`.
- Conferência de fidelidade do texto (para não superdeclarar cobertura): o texto
  dos blocos foi comparado com o texto da árvore saneada de cada HTML. A maior
  diferença ficou em 52 caracteres de 16 272 (0,3%), explicada por colapso de
  espaços e separadores de tabela; nenhuma página perdeu texto materialmente.
  Esse ajuste corrigiu dois defeitos reais encontrados nessa conferência:
  conteúdo dentro de célula (`<td><p><span>…</span></p></td>`) era descartado e
  texto inline era duplicado em blocos filhos.
- `tests/import_processed_materials_test.ts` — 2 provas contra o Postgres local
  com fixture sintética e **dois donos**: ingestão de 3 materiais válidos com
  recusa explícita de sha divergente e de nome ambíguo (2 módulos), idempotência
  (segunda execução: 0 inserções, 0 observações novas, `kept_prior`), preservação
  do texto forte contra execução fraca posterior, e recuperação por **MCP SDK**
  com autenticação sintética: listagem, trecho profundo por offset com hash
  fixado, hash divergente recusado, busca textual, proveniência da ocorrência,
  transcrição com `accuracy_verified:false` preservado e **outro dono isolado**
  (0 arquivos e leitura alheia recusada).
- Prova privada real por MCP SDK sobre o material importado do titular (evidência
  em `.private/entrega-1/materials/mcp-recovery-proof.json`): 20 arquivos
  listados (19 importados + 1 anterior do dono), trecho de documento por offset
  com hash fixado (200 caracteres, `next_offset` 320 na segunda leitura),
  transcrição recuperável com localizador `[asr:pt:N]`,
  `transcript_source:"local_asr"`, `accuracy_verified:false` e
  `coverage_scope:"temporal_execution"`, hash divergente recusado, proveniência
  `local-materials-snapshot` na observação e isolamento de outro dono (0
  arquivos, leitura recusada). Nenhum conteúdo foi impresso: só contagem, id,
  hash e tamanho.

## Disponibilidade de ASR

### Operação local (implementada e executada)

| Verificação | Resultado |
|---|---|
| `ffprobe`/`ffmpeg` locais | disponíveis (9.0.1, build `full_build-www.gyan.dev`) |
| filtro `whisper` (whisper.cpp) | **anunciado** por `ffmpeg -filters` |
| opções do filtro | `model`, `language`, `translate`, `queue` (duração), `use_gpu`, `destination`, `format=text|srt|json`, `max_len`, VAD — conforme `ffmpeg -h filter=whisper` |
| modelo | `ggml-base.bin` oficial (multilíngue base), 147.951.465 bytes, sha256 `60ed5bc3…2efe` conferido após o download; licença MIT |
| pin | `.private/entrega-1/models/MODEL.json` e `MODEL.md` (fora do Git) |
| execução | **concluída** no MP4 privado do titular: 14 segmentos, 0–61.967 ms de 64.431 ms, `timeline_coverage_ratio` 0,96, cobertura `complete`, ~38 s de CPU para 64 s de áudio |
| revisão | `transcript_reviewed:false`; visual `not_performed` |
| acurácia | **não verificada** (`accuracy_verified:false`, `source_unreviewed:true`): a cobertura é de execução/linha do tempo, não de acerto do texto |

A verificação de integridade é feita **antes** de executar: um sha256 divergente
do pin é recusado (`model_integrity`) e um modelo inválido falha com
`asr_failed`, nunca virando transcrição. Nenhum áudio, vídeo ou transcrição sai
da máquina: o filtro roda em CPU (`use_gpu=false`) sobre o arquivo preservado.

### Recurso remoto (pendente de decisão)

O que **não** está resolvido é o processamento autônomo, sem a máquina do
titular ligada. O runtime hospedado (Supabase Edge: 2 s de CPU, 256 MB, sem Web
Worker API) não sustenta decodificação/transcrição pesada, como já registrado
para PDF; e o modelo de ~148 MB e a transcrição em CPU não cabem nesse
orçamento. A decisão de infraestrutura continua sendo uma só: **executor local
dedicado** (a máquina que já roda o CLI, com o modelo pinado) ou **serviço de
transcrição explicitamente autorizado** (custo/escopo próprios). Nenhum dos dois
foi contratado ou presumido; a operação local é o caminho comprovado até aqui, e
uma rotina prometida como recorrente só é chamada ativa com executor e
agendamento autorizados.

## Limitações e pendências

- Sem OCR e sem interpretação de imagem/fórmula; sem execução de macro, campo ou
  objeto — por projeto.
- DOCX: caixas de texto, notas, comentários, subdocumento e `altChunk` são
  lacunas nomeadas, não conteúdo; layouts em colunas não são reconstruídos como
  semântica; `numFmt` depende de `numbering.xml` presente.
- HTML: entidades nomeadas fora da tabela suportada ficam literais; CSS é
  descartado (não há estilo no resultado); a legenda de tabela é um bloco
  próprio, não vinculada à tabela.
- Vídeo: legenda é da fonte e não verificada contra o áudio; idiomas não são
  detectados (o idioma é declarado por quem chama); legendas de imagem exigem
  OCR; quadro isolado é material para inspeção, não análise visual.
- ASR local: exige `ffmpeg` com o filtro `whisper`, o modelo ggml presente
  (~148 MB, fora do Git) e uma máquina ligada; a saída não foi revisada por
  humano e pode errar nomes, números, ortografia e pontuação — a acurácia **não**
  é verificada por este pipeline (`accuracy_verified:false`); `queue` é uma **duração** no
  ffmpeg 9.0.1 (não uma contagem) e o valor usado foi conferido pela cobertura
  de linha do tempo (0,96 do áudio). Caminho com vírgula, ponto e vírgula,
  colchetes, apóstrofo ou caractere de controle é recusado, não escapado.
- Mídia exige `--allow-run`; no gate padrão a prova correspondente fica
  `ignored` em vez de aprovada.
- Integração com `hub_files`/`hub_jobs` (gravação pela rota autenticada, fila
  durável com consumidor) foi **sugerida** e não aplicada: `src/materials.ts`,
`mcp.ts` e migrations são da raiz.
