# Clientes e primeiro uso

A interface auxiliar serve para entrada inicial, conexão de fontes, renovação e
revisão de alterações externas. O trabalho acadêmico cotidiano acontece no
assistente conectado ao MCP; não é preciso abrir o painel a cada consulta.
O AraHub é o caminho para Moodle e memória contextual. Para escrever e formatar
Docs, Sheets ou Slides e trabalhar no Gmail, prefira os plugins oficiais Google
no mesmo assistente. As ferramentas Google próprias do AraHub têm cobertura
menor; suas provas sintéticas não demonstram paridade editorial. A articulação
entre plugins ocorre pelo assistente: o servidor AraHub não invoca internamente
os outros plugins. Uma conexão do painel Supabase não equivale à entrada no
AraHub; o consentimento Google é separado de ambos.

Exemplo depois da conexão Moodle: “AraHub, mostre as discussões e postagens
novas do meu curso, compare-as com o contexto histórico e indique quais PDFs
embasam sua análise.” O plugin identifica a conexão no contexto do proprietário,
consulta a fonte sob demanda, percorre páginas e recupera versões/materiais
pertinentes. Novidade significa diferença entre observações com cobertura;
sem uma consulta recente não há promessa de atualização imediata. Registros
duráveis produzidos na conversa são gravados explicitamente, não por captura
passiva de todo o chat.

1. Entre na interface HTTPS da sua instalação. Abra o link de acesso no mesmo
   navegador que iniciou o pedido; não envie esse link ou código ao assistente.
2. Em Conexões, escolha a conta e apenas as capacidades necessárias. O ícone de
   lupa verifica Gmail, Calendar e Drive com uma página de até três itens por
   serviço, sem mostrar conteúdo nem alterar as fontes. Parcial indica continuação,
   não erro; sem permissão exige conferir o consentimento daquela conexão.
3. No plugin pessoal AraHub, escolha a conta conectada. Em uma conversa nova, peça
   a retomada de um contexto com fontes e lacunas. A memória histórica não prova
   que a fonte continua atualizada; atualização de uma fonte é uma ação dirigida.
4. Acrescente a Skill genérica ao pacote pessoal para orientar recuperação e
   persistência. Preparar o pacote, atualizar o plugin e invocar a Skill em conversa
   nova são provas separadas. O MCP não captura automaticamente o chat.

Para Moodle, em Conexões → Moodle, informe a origem e o token de Web Service
somente no formulário HTTPS. O assistente pode então consultar cursos e iniciar
uma atualização dirigida; a cobertura informa funções indisponíveis, erros e
trechos ainda não percorridos. Atualmente não há monitoramento automático nem
garantia de publicação em tempo real. Se o token não oferecer determinada
função, a ausência de registros não prova ausência de atividade no Moodle.
O mesmo plugin oferece consulta dirigida de páginas de discussões e postagens.
`hub_observations` lista todas as versões preservadas de uma entidade e
`hub_observation` lê cada versão por trechos; `hub_entity_context` mostra apenas
as cinco observações mais recentes como prévia. Após mudança de seção, o pacote
de estudo usa a seção atual do módulo, e as relações antigas seguem consultáveis
como histórico, não como materiais atuais.

O pacote pessoal pode ligar-se ao aplicativo MCP já registrado por `.app.json`,
conforme o [formato oficial](https://developers.openai.com/plugins/build/plugins).
`deno task plugin:prepare` gera somente manifest, ligação, Skill e licença em
`.private/deploy/`, com recibo de hashes fora dos arquivos distribuídos. IDs de
contas/instalação ficam na cópia privada; o repositório distribui o template.
O vínculo usa o ID do aplicativo registrado, confirmado no conector:
`asdk_app_`, `connector_` ou `templated_apps_`. O ID `plugin_...` da página não
é aceito nesse campo. O gerador recusa esse erro antes de preparar arquivos.
Uma atualização também preserva o nome técnico cadastrado e o apelido do
aplicativo; o título exibido não determina esses campos. Confira o cadastro
existente antes de gerar o pacote e use uma versão diferente da instalada.
Não alterar configuração global de clientes, reiniciar o aplicativo ou publicar
o plugin em catálogo/workspace por inferência. Não remover a conexão existente
para tentar instalar a Skill. Depois de acrescentar ferramentas no backend, use
“Atualizar ferramentas” no aplicativo AraHub existente e abra uma conversa nova
se o cliente ainda listar o conjunto anterior. Isso atualiza descoberta; não
concede novos escopos nem substitui consentimento de conta. Esse caminho foi
operado no cliente pessoal antes de preservar Docs/Slides reais.

Na integração inicial, uma conversa ChatGPT nova comprovou leituras Google reais
e renovação automática. A interface na sessão titular também comprovou os estados
de leitura. Naquele momento não havia planilha nativa na conta; depois, o lote
Google aprovado criou uma planilha sintética privada, leu os tipos de células e
confirmou a fórmula A4=5. Isso não prova planilhas acadêmicas existentes. A revisão dos dez cenários da memória
identificou omissão de um marco na cronologia; recuperação dirigida com orientação
genérica corrigida preservou o marco, os valores e as granularidades temporais.
O instrumento de upload recusou o caminho do workspace. O primeiro envio manual também foi recusado por
usar o ID do plugin no campo de aplicativo. A versão 1.0.2 corrigiu esse campo,
mas foi recusada por nome técnico diferente do cadastro. A versão 1.0.3 preserva
nome, apelido e vínculo obrigatório conferidos no cadastro real; quatro testes
e quatro entradas/hashes ZIP aprovados. O envio manual 1.0.3 foi aceito: a página
mostra essa versão, uma Skill e o aplicativo com a conta previamente conectada.
O aceite do pacote e seu uso efetivo em conversa nova têm provas separadas em
STATUS. Uma conversa nova com a Skill instalada recuperou os dois cenários
afetados sem repetir sua orientação no prompt; manteve os marcos, a precisão
das datas e as distinções do trabalho coletivo. Evidências e pacote permanecem privados.

O titular dispensou em 2026-10-06 o teste no celular físico desta entrega.
Não houve conversa nova, delta ou recuperação entre celular e web; a QA em
viewport móvel prova somente layout e interação no navegador de teste. O uso
futuro no celular pode ser validado à parte, sem declarar este gate aprovado.

Busca e contexto têm continuação explícita: hub_search encontra títulos e
registros; hub_context pagina contextos por offset/next_offset e deltas
por delta_offset/deltas_next_offset. Para um contexto escolhido, hub_history
permite aprofundar a cronologia sem colar o chat anterior.

Pacotes de estudo usam offset/next_offset e preservam versões/direitos;
consulte [o contrato do pacote](PACOTE-ESTUDO.md) antes de criar um curso.

Datas de atividades/eventos preservados: [hub_time_context](DATAS.md) converte
instantes para Lisboa/São Paulo por padrão e mantém dia inteiro, DST incerto e
fuso desconhecido explícitos. Não modifica calendários nem confirma envio.
