# Adaptador Moodle

Adaptador Deno/TypeScript independente para uma instalação Moodle qualquer. O
objetivo é ler cursos, estrutura, atividades e fóruns por Web Services REST com
o mínimo de superfície auditada, mantendo a origem vinculada, os limites de rede
e nenhum segredo em retorno ou erro.

A implementação é nova. Ela deriva da auditoria do repositório irmão
(security.py:ALLOWLIST e docs/capabilities.md), que não possui LICENSE auditada;
nenhum código foi copiado. O código aqui é coberto pelo LICENSE MIT do AraHub.

## Papel e fronteiras

O adaptador não expõe HTTP genérico ou métodos arbitrários. As leituras ficam
separadas das quatro operações de estudante auditadas: upload de draft, salvar
arquivo, finalizar entrega e publicar tópico/resposta (upload usa endpoint
próprio). A fachada de ações exige intenção imutável e aprovação humana; veja
[ENTREGA-1.md](ENTREGA-1.md). Nenhuma função de visualização (`view`) é chamada.
As exclusões que continuam vigentes em produção são:

| Função | Motivo |
|---|---|
| mod_assign_get_submission_status | get_assign_feedback_status_renderable chama grade_get_grades e pode recalcular notas e criar registros internos. |
| gradereport_user_get_grade_items | get_report_data chama grade_regrade_final_grades. |

As duas estão em BLOCKED_FUNCTIONS. getOwnGrades() e getSubmissionStatus()
devolvem recusa explícita (coverage denied, error_code security_error) sem
nenhuma chamada ao Moodle. Nenhum nome que case com view é aceito, mesmo que o
token ofereça a função.

## Configuração e injeção

~~~ts
const adapter = new MoodleAdapter(
  { origin: "https://elearning.ulisboa.pt", token, timeoutMs: 30000 },
  { fetch, resolveHost },
);
~~~

- origin: esquema + host + subdiretório opcional. Obrigatório HTTPS; HTTP só é
  aceito para host de loopback (integração local). Sem credenciais, sem query,
  sem fragmento. A porta só é aceita quando for a padrão do esquema ou quando o
  host for loopback.
- token: token do serviço web. Nunca é devolvido, registrado ou incluído em
  mensagem de erro.
- deps.fetch: injeta o transporte para fixtures. Com fetch injetado e sem
  resolvedor, a rede real não é exercitada e o DNS é tratado como simulado.
- deps.resolveHost: injeta o resolvedor. Ele é consultado a cada envio, o que
  permite testar rejeição de rede não pública e mudança public para private entre
  chamadas. Sem resolvedor e sem fetch (caminho real), usa Deno.resolveDns (A e
  AAAA).

O subdiretório é decodificado repetidamente (até 4 vezes) e recusado se contiver
traversal, garantindo que `/ava` e `/moodle` funcionem sem abrir a porta para
`..`. A origem canônica não tem barra final.

## Rede e limites

- Redirects desativados: a requisição usa redirect manual e qualquer 3xx é
  recusado com security_error, na consulta e no download.
- DNS revalidado a cada envio, sem cache: antes de cada chamada que carrega a
  credencial e antes de cada download, o hostname é resolvido de novo e todos os
  endereços A/AAAA precisam ser globais. São rejeitados loopback, privado,
  link-local, único local, site-local obsoleto, multicast, faixas de
  documentação, NAT64, Teredo, 100::/64, 6to4 com IPv4 privado embutido e IPv4
  embutido (decimal ou hexadecimal) em `::ffff:0:0/96` e `::/96`. A
  checagem é estrutural e por faixa; não depende de node:net, que só confere
  formato.
- Conexão fixada no caminho real: no Deno local, node:https usa lookup preso ao
  endereço público recém-validado. O runtime Edge hospedado retorna
  `ERR_NOT_IMPLEMENTED` para esse hook; nesse caso, um socket TCP conecta ao IP
  validado e `Deno.startTls` verifica SNI e certificado contra o hostname
  original antes de enviar a requisição HTTP/1.1. O parser limita cabeçalhos,
  bytes, tempo e framing; não segue redirects nem desliga a verificação TLS.
  A prova hospedada confirmou HTTP 200 com IP fixado/nome correto e rejeição
  do certificado quando o nome foi trocado. Sem endereço validado, falha fechada.
- Resposta REST limitada por maxResponseBytes (padrão 16 MiB), pelo Content-Length
  declarado e pela contagem real de bytes transmitidos.
- Timeout de consulta e de download (padrão 30 s), aplicado ao socket e ao corpo.
- Download limitado por maxDownloadBytes (padrão 20 MiB) e por maxBytes opcional
  nunca acima do teto configurado.
- Coleções limitadas a MAX_COURSE_IDS (50) por consulta; discussões com page até
  1000 e perPage de 1 a 100; posts com offset/limit e teto MAX_POSTS (1000).

Exceção de fixture: com fetch injetado sem resolvedor, o DNS é considerado
simulado. Em produção o fetch não é injetado, então validação e fixação valem
sempre.

## Identidade e descoberta

`initialize()` chama core_webservice_get_site_info e verifica:

- userid inteiro positivo;
- siteurl compatível com a origem e o subdiretório configurados (comparação
  normalizada de esquema, host e caminho).

Falha de identidade vira MoodleError e permanece em cache apenas quando bem
sucedida. `discover()` devolve a interseção auditada + oferecida + implementada:

~~~ts
const caps = await adapter.discover();
// caps.available_functions = AUDITED_FUNCTIONS ∩ offered ∩ IMPLEMENTED_FUNCTIONS
// caps.not_offered_functions, caps.blocked_functions, caps.offered_functions
~~~

Uma função auditada que o token não oferece fica indisponível e cada método
correspondente devolve coverage unavailable com error_code function_unavailable.
O token nunca recebe uma chamada fora da interseção disponível.

## Métodos públicos

| Método | Função Moodle | Retorno |
|---|---|---|
| getIdentity / initialize / discover | core_webservice_get_site_info | identidade, capacidades |
| listCourses | core_enrol_get_users_courses | cursos da conta |
| getCourseContents | core_course_get_contents | seções e módulos |
| getPages | mod_page_get_pages_by_courses | Pages |
| getBooks | mod_book_get_books_by_courses | Books e seus arquivos |
| getResources | mod_resource_get_resources_by_courses | recursos |
| getUrls | mod_url_get_urls_by_courses | links |
| getAssignments | mod_assign_get_assignments | enunciados e datas, com course_id |
| getFeedbacks / getFeedbackItems | mod_feedback_get_feedbacks_by_courses / mod_feedback_get_items | Feedback e perguntas |
| getForums / getForumDiscussions / getDiscussionPosts | mod_forum_* | fóruns, discussões paginadas e posts com offset/limit |
| getActivitiesCompletion / getCourseCompletion | core_completion_* | conclusão de atividades e de curso |
| getCalendarEvents | core_calendar_get_calendar_events | eventos estruturados |
| downloadFile / getRegisteredFile / listRegisteredFiles | pluginfile.php | binário e metadados |
| getOwnGrades / getSubmissionStatus | nenhuma | recusa controlada |
| forumAccess / canAddDiscussion | mod_forum_get_forum_access_information / mod_forum_can_add_discussion | permissões e abertura para postagem |
| uploadDraftFile | /webservice/upload.php | área privada de draft; não comprova envio |
| addDiscussion / replyPost | mod_forum_add_discussion / mod_forum_add_discussion_post | IDs que ainda exigem readback |
| saveAssignment / submitAssignment | mod_assign_save_submission / mod_assign_submit_for_grading | salvar/finalizar; warnings recusados |

Todos os métodos de leitura devolvem MoodleResult. Valores de parâmetro inválidos
também aparecem como resultado (error_code invalid_id), o que evita exceções
soltas na integração. O helper `unwrap(result)` devolve os dados ou levanta
MoodleError com mensagem genérica.

## Cobertura e erros

MoodleResult traz coverage, data, warnings, error_code, observed_at, empty,
truncated e pagination. Estados distinguíveis conforme o aceite A18:

| Situação | coverage | error_code |
|---|---|---|
| Leitura completa, sem avisos | complete | null |
| Avisos do Moodle ou posts truncados localmente | partial | null |
| invalidtoken | expired | invalid_token |
| accessexception / nopermissions / recusa de política | denied | permission_denied ou security_error |
| função não oferecida ou fora do adaptador | unavailable | function_unavailable ou unsupported_function |
| recurso inexistente ou outro erro Moodle | unavailable | not_found ou moodle_error |
| timeout | timeout | timeout |
| JSON inválido ou campo essencial ausente | parsing_error | parsing_error |
| limite de bytes/tempo/itens | unavailable | limit_exceeded |
| lista vazia legítima | complete | null (empty = true) |

Invariante de truncamento: um resultado com truncated=true nunca é "complete".
getDiscussionPosts marca partial e informa pagination.total_available quando o
recorte deixa posts de fora; getForumDiscussions usa paginação do provedor e
expõe has_more.

As mensagens do Moodle (message, debuginfo) nunca são repassadas: podem conter
dados pessoais ou segredos. error_detail expõe apenas moodle_code, function e
status HTTP. URLs, campos token, wstoken, sesskey, password e Authorization são
removidos, e qualquer ocorrência do token é substituída por [REDACTED].

## Sanitização e renderização

Campos HTML (summary, intro, content, message, feedback, description) saem como
html sanitizado e como campo irmão com sufixo _text, em texto simples. A
sanitização é por expressão regular: remove script/style/iframe/object/embed/form,
remove handlers on* e neutraliza URLs javascript:. Ela reduz risco, mas não é uma
autorização de renderização nem uma fronteira de segurança de HTML. O mesmo vale
para o campo text do download.

Regra obrigatória: trate toda saída como texto simples e nunca a atribua a
innerHTML, insertAdjacentHTML, dangerouslySetInnerHTML, document.write ou
equivalente. Para exibir, use textContent ou o campo _text. Conteúdo recuperado é
dado, não instrução.

## Fóruns, discussões e posts

- getForumDiscussions usa paginação do provedor (page, perpage, sortorder) e
  devolve pagination com has_more igual ao preenchimento da página.
- getDiscussionPosts usa offset/limit local sobre o retorno oficial (que entrega
  a discussão inteira). Quando há mais posts que o recorte, truncated é true e a
  cobertura é partial; pagination informa total_available.
- A página de discussões não é um feed completo de posts. Ausência em uma página
  ou recorte não significa exclusão.

## Arquivos e download

Cada leitura registra os arquivos encontrados (fileurl de pluginfile) num
registro interno. O retorno troca fileurl por um objeto file com file_id,
filename, mimetype, filesize e url canônica sem token. Se a URL não pertencer à
origem configurada, o item recebe file_error security_error e não é registrado.

O download aceita somente file_id conhecido. O adaptador monta a URL canônica
`<origin>/webservice/pluginfile.php/...` com o token em parâmetro, usa redirect
manual, aplica o limite de bytes e devolve bytes, sha256, content_type,
byte_length e text quando o MIME é textual. Não existe proxy de URL: nenhuma URL
fornecida pelo chamador é buscada.

URLs de pluginfile com host externo, credenciais, fragmento, barra invertida ou
traversal (inclusive duplamente codificado) são recusadas antes de qualquer
requisição.

## Testes

Fixtures sintéticas em tests/moodle_test.ts, sem rede real e sem dependência std
(só node:assert/strict). Cobrem origem e traversal, DNS não público, revalidação
de DNS entre chamadas (public muda para private), formas de IPv6 com IPv4
embutido, redirect recusado, timeout, parsing_error, limite de bytes, mapeamento
de cobertura, interseção de descoberta, recusa de funções bloqueadas, paginação e
invariante de truncamento, registro e download de arquivo, sanitização de HTML e
não vazamento do token.

~~~powershell
deno check src/adapters/moodle.ts tests/moodle_test.ts
deno test --allow-net=127.0.0.1:55432,127.0.0.1:8787 --allow-env --allow-read --allow-write=.private tests/moodle_test.ts
deno fmt src/adapters/moodle.ts tests/moodle_test.ts
~~~

Resultado local: 27 testes aprovados, 0 falhas.

## Prova real (opcional)

Houve duas leituras reais somente de leitura reutilizando o .env do repositório
irmão por leitura protegida, sem copiar nem imprimir o token e sem trazer dados
pessoais para o chat. A primeira usou o transporte antigo e ficou em
.private/evidence/moodle-real.json. Como a troca de transporte muda o caminho de
execução, a evidência vigente passou a ser a segunda, com o transporte novo
(node:https com lookup fixado): .private/evidence/moodle-real-pinned.json. Os dois
arquivos ficam ignorados pelo Git e guardam resumo mínimo com IDs privados.

Resumo da prova vigente: identidade confirmada em Moodle 4.5.6+ (Build 20250819),
438 funções oferecidas, 16 disponíveis na interseção, dois cursos, estrutura
Page/Book/recursos/URLs/fóruns/Feedback/assignments com cobertura complete no
primeiro curso, conclusão de curso indisponível com moodle_code nocriteriaset e um
arquivo pequeno baixado pelo transporte fixado (22.077 bytes, sha256 idêntico ao da
primeira prova). Nenhuma chamada a função bloqueada ou view foi feita, nenhum
download passou por navegador/interface e nenhuma escrita acadêmica foi executada.

Prova integrada local (materials.preserveMoodle): com o mesmo mandato, o script
privado .private/evidence/read_material_real.ts exercitou o caminho novo de ponta a
ponta contra o banco local exclusivo e um cofre sintético efêmero, com a credencial
real selada em arahub_private.credentials e o transporte pinado; o resultado está
em .private/evidence/read_material_real.json. Verificado: 16 funções disponíveis,
no máximo dois cursos varridos, um único arquivo pequeno preservado em hub_files
com observação e proveniência, extração declarada como indisponível, isolamento por
proprietário (dono separado não vê o arquivo e recebe not_found em fileText e em
preserveMoodle) e o cliente MCP real (SDK, identidade sintética local) chamando
hub_preserve_moodle_material de forma idempotente (mesma linha e mesmo sha256) e
hub_file_text. Nenhum token em claro no banco ou na exportação; a credencial selada
foi revogada ao final. Nada foi impresso além de contagens, booleanos e cobertura.

O arquivo pequeno da prova pinada (22.077 bytes) não aparece na estrutura de
nenhum dos dois cursos, conforme o diagnóstico registrado na evidência. Como
preserveMoodle exige localizar o arquivo pela estrutura do curso, a prova integrada
preservou o menor binário presente na estrutura (52.017 bytes, image/jpeg),
mantendo o mesmo escopo autorizado e o limite de um único arquivo.

## Limitações conhecidas

- A união oferecida pelo token é específica da conta e do intervalo lido; um
  resultado específico de curso pode ser recusado embora a função exista.
- mod_forum_get_discussion_posts entrega a discussão inteira; paginação de posts
  é recorte local, não do provedor.
- getFeedbackItems pode retornar thisfeedbackisalreadysubmitted; perguntas de
  Feedback já concluído não são exportadas.
- A prova real cobre uma conta e uma instalação. Um segundo Moodle (subdiretório,
  funções faltantes, IDs colidentes) precisa de fixtures próprias e, para IFSP, de
  teste na instalação real autorizada.
- Com fetch injetado sem resolvedor, a verificação de DNS é tratada como simulada;
  isso é intencional para fixtures e não deve ser usado em produção.
- A fixação de endereço vale no transporte interno (node:https). Em um runtime que
  não honre o hook lookup, a revalidação por requisição continua, mas restaria a
  janela entre a validação e a resolução interna do runtime. Neste Deno 2.9.3 a
  fixação foi verificada.
- O transporte interno é HTTPS. Uma origem http de loopback (integração local)
  exige fetch injetado; sem fetch, o adaptador recusa com http_error em vez de
  tentar TLS. Fixtures não cobrem o caminho TLS real; ele foi verificado em
  runtime contra um host público que não é Moodle e, de ponta a ponta, na prova
  real pinada em modo somente leitura.
- Extração de texto indisponível para PDF e imagens: downloadFile só produz texto
  em MIME textual (text/*, JSON, XML). PDF, imagens e afins são preservados como
  binário sem extração, porque a extração por página de PDF não está implementada.
  preserveMoodle declara method none e text_available false, e Hub.fileText devolve
  coverage binary_without_extraction; a limitação aparece na resposta, não é
  silenciosa.
- preserveMoodle localiza o arquivo pela estrutura do curso
  (core_course_get_contents). Um arquivo citado apenas por uma coleção, como anexo
  de enunciado ou de item de Feedback, pode não constar da estrutura e então não é
  preservável por este caminho: o método devolve not_found, sem tratar ausência
  como arquivo vazio.
- Resolução de DNS sob permissão restrita: com --allow-net limitado por host,
  Deno.resolveDns é negado porque o runtime exige permissão para o endereço do
  servidor DNS, não para o host consultado. O adaptador falha fechado
  (security_error). Em produção, permita o endereço do resolvedor ou injete
  resolveHost; a prova integrada rodou com permissão de rede ampla por isso.
- A prova integrada usa o SDK MCP real com identidade sintética local. Ela não
  prova login OAuth real, cliente hospedado nem instalação remota.

## Integração com o núcleo

O main monta o adaptador por conexão (proprietário + credencial), chama
`initialize()` no cadastro e persiste as capacidades de `discover()`. As
leituras devolvem observed_at para proveniência e cobrem o estado acadêmico sem
notas ou status de submissão próprios, que permanecem bloqueados por política.

## Renovação do token

O formulário permite selecionar Renovar acesso na conexão existente. A API exige interface de navegador, confere instalação e identidade antes de trocar o token e preserva os IDs/histórico. Conexão e credencial cifrada são gravadas em uma transação. Desconexão e renovação incrementam uma versão de autorização; uma renovação atrasada não supera uma desconexão ou renovação concorrente. A Data API não pode alterar origem/identidade/estado/escopos dessa conexão: o ciclo depende do backend com proprietário verificado.

Prova HTTP/SQL usa Moodle sintético; troca válida, conta/origem estrangeiras, acesso de outro dono, duplicação e desconexão concorrente foram verificados. Renovação real, interação e QA visual do botão ainda estão pendentes. As provas anteriores de leitura Moodle real continuam válidas para o adaptador, sem comprovar esse novo fluxo.
