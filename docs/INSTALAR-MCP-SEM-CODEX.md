# Conectar o AraHub ao ChatGPT sem Codex

Este roteiro serve a **uma pessoa que já tem conta autorizada na instalação**.
Na instância inicial do titular, inscrições públicas ainda estão fechadas.
O administrador precisa fornecer o endereço HTTPS do MCP dessa instalação;
um link do GitHub não substitui o servidor.

1. Abra a interface AraHub da instalação e entre com sua própria conta.
   Conecte o Moodle em Conexões → Moodle pelo fluxo oficial descrito no
   [README](../README.md). Não envie a chave móvel, senha ou link de login no
   chat. A chave fica no formulário HTTPS protegido da sua instalação.
2. No **ChatGPT web**, abra **Plugins → + → Add custom MCP server**. Informe
   um nome como “AraHub” e o URL HTTPS do MCP dado pelo administrador.
   Escolha a autenticação OAuth oferecida pelo servidor, leia o aviso de
   risco e crie o plugin pessoal. O [procedimento oficial](https://developers.openai.com/api/docs/guides/custom-mcp-server)
   pode estar indisponível se o workspace restringir MCPs personalizados.
3. Instale o plugin criado, conecte **sua** conta AraHub no consentimento e,
   numa conversa nova, chame `@AraHub` para consultar seus cursos ou retomar
   um contexto. O consentimento do ChatGPT não substitui o login no Moodle.
4. Para preservar PDFs ou renovar uma conexão, volte à interface. A leitura
   cotidiana e a recuperação da memória são feitas no chat; atualizações
   Moodle ocorrem quando solicitadas, sem monitoramento automático hoje.

O usuário pode revogar o acesso do plugin e desconectar a fonte no painel.
Se a instituição não disponibilizar o serviço móvel ou uma função de leitura,
o AraHub deve informar a limitação; não obtenha nem compartilhe credenciais por
outros meios. Este roteiro não comprova disponibilidade para todos os tipos de
conta ChatGPT, nem equivale a publicação no diretório de plugins.

Para atualizar uma instalação pessoal existente, atualize primeiro a lista de
ferramentas e depois envie a nova versão do pacote pelo menu do próprio plugin.
Na implantação validada, a atualização das ferramentas preservou a conexão e a
Skill, mas regenerou os metadados como versão 1.0.0. Reenviar o pacote corrigiu
a versão exibida. Confira a versão, a Skill e a conta após o upload e faça uma
leitura em conversa nova. Preserve o ID do aplicativo e a conta existente;
`scripts/prepare_plugin.ts` prepara esse pacote em uma pasta privada.

## Se o AraHub não aparecer no ChatGPT

O servidor e o plugin são partes separadas. O backend pode estar saudável e o
cadastro pessoal do ChatGPT estar ausente, desconectado ou instalado em outra
conta/workspace. A publicação do código não instala o plugin automaticamente.

1. Confira a conta e o workspace do ChatGPT. Em **Plugins → Pessoais**, procure
   o AraHub; confira também **Gerenciar**, que mostra os plugins instalados.
2. Se o cadastro existe, instale-o ou use **Conectar** para refazer o login.
   Preserve o cadastro existente. Uma sessão expirada não exige excluir o plugin.
3. Se o endereço antigo mostra **Plugin not found**, confirme a ausência nas
   listas da mesma conta. Esse resultado comprova que aquele cadastro não está
   disponível ali; sozinho, não explica quando ou por que desapareceu.
4. Somente com a ausência confirmada, recrie o MCP personalizado com o endpoint
   autorizado. Mantenha OAuth. Nas opções avançadas, se o servidor não oferece
   registro dinâmico, use o **Client ID público** fornecido pelo administrador.
   O callback mostrado pelo ChatGPT precisa coincidir exatamente com um callback
   cadastrado nesse cliente. Cliente público não usa segredo de cliente; não
   coloque a chave `service_role`, PAT ou token de sessão nesse formulário.
5. Entre na sua própria conta AraHub durante a conexão. Se usar link por e-mail,
   abra-o no mesmo perfil de navegador que iniciou o pedido: a prova de login
   fica nesse perfil. Abrir em outro Chrome pode impedir a conclusão. Não envie
   o link ao assistente. Se a autorização expirar durante a espera, volte ao
   plugin e inicie **Conectar** novamente, aproveitando a sessão já aberta.
6. Confira a descoberta de ferramentas e faça uma chamada de leitura numa
   conversa nova, por exemplo: “Use o AraHub para consultar `hub_usage`, sem
   gravar ou alterar dados”. Plugin visível e login concluído são verificações
   necessárias, mas não substituem uma chamada real bem-sucedida.

Uma recriação recebe um novo ID de aplicativo. Para restaurar também a Skill
`academic-memory`, prepare o pacote com o **novo cadastro observado**, mantendo
seu nome técnico e apelido. Não envie o ZIP antigo apontando para um aplicativo
que deixou de existir. Primeiro conclua a conexão e a atualização das ferramentas;
depois envie o pacote e confirme Skill, versão e conexão na página do plugin.

Ao investigar o servidor, `/health` com sucesso comprova disponibilidade básica;
`/mcp` sem credencial retornar 401 é o comportamento esperado. Nenhum desses
resultados comprova login do usuário ou chamada autenticada pelo ChatGPT.
Se o backend está disponível, um erro WSL/Docker local não explica, por si só,
o desaparecimento do cadastro pessoal hospedado.
