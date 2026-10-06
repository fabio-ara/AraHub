# Clientes e primeiro uso

A interface auxiliar serve para entrar, conectar fontes, conferir leituras e
revisar alterações. O trabalho acadêmico acontece no assistente conectado ao MCP.
Uma conexão do painel Supabase não equivale à entrada no AraHub; o consentimento
Google é separado de ambos.

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

O pacote pessoal pode ligar-se ao aplicativo MCP já registrado por `.app.json`,
conforme o [formato oficial](https://developers.openai.com/plugins/build/plugins).
`deno task plugin:prepare` gera somente manifest, ligação, Skill e licença em
`.private/deploy/`, com recibo de hashes fora dos arquivos distribuídos. IDs de
contas/instalação ficam na cópia privada; o repositório distribui o template.
Não alterar configuração global de clientes, reiniciar o aplicativo ou publicar
o plugin em catálogo/workspace por inferência. Não remover a conexão existente
para tentar instalar a Skill.

Na integração inicial, uma conversa ChatGPT nova comprovou leituras Google reais
e renovação automática. A interface na sessão titular também comprovou os estados
de leitura. Nenhuma planilha nativa existe na conta usada: Sheets tem implementação
e testes sintéticos, sem prova real inventada. A revisão dos dez cenários da memória
identificou omissão de um marco na cronologia; recuperação dirigida com orientação
genérica corrigida preservou o marco, os valores e as granularidades temporais.
Isso não comprova que o novo pacote esteja instalado: o instrumento de upload
recusou o caminho do workspace, e a atualização pessoal aguarda envio autorizado
pela interface. Evidências e pacote permanecem privados.

No celular, é necessário testar o cliente real: conversa nova usando AraHub,
registro de um delta interno de teste em contexto separado e recuperação posterior
pela web. Viewport móvel em Chrome prova layout e interação, não esse fluxo.
Consulte `docs/ACEITE.md` antes de declarar o gate móvel encerrado.
