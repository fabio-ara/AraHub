# Pacote pessoal AraHub

Estrutura portátil conferida na [documentação oficial](https://developers.openai.com/plugins/build/plugins). `skills/` contém orientação genérica, sem perfil ou dados particulares.

`mcp.json` é um template de configuração: gere uma cópia privada com o endpoint HTTPS autorizado antes de instalar. O placeholder não é um servidor implantado. Não publicar nem alterar configurações pessoais globais automaticamente. Na instância inicial, instalação pessoal, autenticação e consulta em nova conversa ChatGPT foram concluídas no lote aprovado; isso não instala automaticamente a Skill neste template nem comprova o aplicativo móvel.

Disponibilidade em viewport móvel não comprova uma nova invocação no app. A29 requer chamada nova, delta e verificação pela web. Código MIT, GitHub Pages e backend foram publicados no lote autorizado, com custo adicional máximo zero. Consentimento humano e consulta em conversa nova comprovados; não há publicação no catálogo público nem serviço pago.

Para acrescentar a Skill ao aplicativo pessoal já conectado, use
`deno task plugin:prepare <plugin_asdk_app_ID> <versão> <site-HTTPS> <privacidade-HTTPS>`.
O comando prepara quatro arquivos em diretório privado novo: manifest, ligação
`.app.json` ao aplicativo registrado, Skill e licença. A ligação reutiliza a conta
OAuth existente; não cria outro servidor MCP nem copia perfil, dados ou tokens.
Compacte somente esses quatro arquivos/diretórios, deixando o recibo de hashes
fora do ZIP. Atualizar o pacote pessoal e testar a Skill em conversa nova são gates
distintos de preparar arquivos. A integração inicial encontrou recusa do instrumento
de upload ao caminho do workspace; o pacote está pronto, mas a atualização não foi
declarada concluída. Consulte [clientes](../docs/CLIENTES.md).
