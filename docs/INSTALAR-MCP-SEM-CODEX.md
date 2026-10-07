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
