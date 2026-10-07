# Pacote pessoal AraHub

Estrutura portátil conferida na
[documentação oficial](https://developers.openai.com/plugins/build/plugins). `skills/` contém
orientação genérica, sem perfil ou dados particulares.

`mcp.json` é um template de configuração: gere uma cópia privada com o endpoint HTTPS autorizado
antes de instalar. O placeholder não é um servidor implantado. Não publicar nem alterar
configurações pessoais globais automaticamente. Na instância inicial, instalação pessoal,
autenticação e consulta em nova conversa ChatGPT foram concluídas no lote aprovado; isso não instala
automaticamente a Skill neste template nem comprova o aplicativo móvel.

Disponibilidade em viewport móvel não comprova uma nova invocação no app. A29 requer chamada nova,
delta e verificação pela web. Código MIT, GitHub Pages e backend foram publicados no lote
autorizado, com custo adicional máximo zero. Consentimento humano e consulta em conversa nova
comprovados; não há publicação no catálogo público nem serviço pago.

Para acrescentar a Skill ao aplicativo pessoal já conectado, use
`deno task plugin:prepare <app_ID> <nome-técnico-existente> <versão-existente> <apelido-app-existente> <nova-versão> <site-HTTPS> <privacidade-HTTPS>`.
Use o ID do aplicativo registrado (`asdk_app_`, `connector_` ou `templated_apps_`), confirmado no
conector. O ID `plugin_...` da URL da página identifica o pacote e é recusado em `.app.json`,
conforme o
[validador oficial](https://developers.openai.com/plugins/deploy/submission-errors#mcp-server-reference-errors).
Para atualizar, leia o cadastro atual: preserve exatamente `name`, o apelido em `apps` e o vínculo
obrigatório do aplicativo. `displayName` é o nome exibido e pode ser diferente do nome técnico
gerado pelo cadastro. Não deduza `name` do título da página. A nova versão precisa diferir da
cadastrada, conforme os
[erros de atualização](https://developers.openai.com/plugins/deploy/submission-errors#zip-upload-errors-and-warnings).
O comando prepara quatro arquivos em diretório privado novo: manifest, ligação `.app.json` ao
aplicativo registrado, Skill e licença. A ligação reutiliza a conta OAuth existente; não cria outro
servidor MCP nem copia perfil, dados ou tokens. Compacte somente esses quatro arquivos/diretórios,
deixando o recibo de hashes fora do ZIP. Atualizar o pacote pessoal e testar a Skill em conversa
nova são gates distintos de preparar arquivos. A integração inicial encontrou recusa do instrumento
de upload ao caminho do workspace; o pacote está pronto, mas a atualização não foi declarada
concluída naquele ensaio. Depois de corrigir ID e nome técnico contra o cadastro real, o envio
humano da versão 1.0.3 foi aceito; Skill visível, conexão preservada e recuperação em conversa nova
comprovadas separadamente. Consulte [clientes](../docs/CLIENTES.md).

Nas atualizações, primeiro atualize as ferramentas e depois envie o ZIP da Skill. O host observado
regenerou os metadados do pacote como 1.0.0 ao atualizar as ferramentas; isso não informa a versão
do backend. Confira novamente o pacote, a Skill e a conexão após o upload. Uma recusa do instrumento
ao caminho local não autoriza mover o ZIP para um projeto irmão nem contornar sua lista de pastas
permitidas. A versão ativa e os bloqueios atuais estão em [STATUS](../STATUS.md).
