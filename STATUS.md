# Estado do AraHub

## Versão 0.3.0 publicada — 22/10/2026

**Código, documentação, backend e interface publicados e verificados.** A mudança
está no commit `29ea12c`. Backend principal na **Edge38**, 17 migrations e estado
`ACTIVE_HEALTHY`; interface em [AraHub](https://fabio-ara.github.io/AraHub/).
O índice oficial é [docs/README.md](docs/README.md). O histórico anterior permanece
no Git; este arquivo registra o estado corrente.

## O que foi entregue

- Guias didáticos de uso, instalação, identidade, arquitetura, privacidade,
  armazenamento, operação, recuperação e desenvolvimento; inventário do acervo.
- Entrada por link, senha e recuperação; Google/GitHub/Microsoft opcionais por
  configuração. Política de cadastro apresentada pela UI e aplicada pelo Auth.
- Conteúdo binário reutilizado por dono e SHA-256, conferindo igualdade dos bytes,
  integridade, referências e RLS. Exportação mantém os bytes resolvidos.
- Métricas de conteúdo armazenado e economia por conta; manutenção local explícita,
  verificador de links da documentação e CI com PostgreSQL real.

## Publicação e validação

A [CI do código publicado](https://github.com/fabio-ara/AraHub/actions/runs/39810143472)
passou com **283 testes, zero falhas e dois casos opcionais ignorados**, além de
tipos gerais/Edge/interface, build, 196 links locais em 53 arquivos de documentação
e gate Git de 263 arquivos sem achados. A regressão local e os testes dirigidos
de armazenamento, exportação e importação também passaram. Os casos ignorados
não são declarados executados.

A instalação limpa comprovou as 17 migrations e cliente MCP SDK/HTTP com duas
identidades locais. O backup anterior à mudança foi restaurado em banco separado:
117 arquivos, hashes e 12 tabelas; cofre verificado separadamente, sem gravar texto
aberto. Essa restauração não inclui o Supabase Auth gerenciado.

A [publicação Pages](https://github.com/fabio-ara/AraHub/actions/runs/39810602576)
concluiu. O conteúdo servido foi comparado com o pacote: oito assets idênticos em
bytes, licença idêntica após normalizar quebras de linha Windows/Linux. O marcador
vazio `.nojekyll` pertence ao pacote e não é servido por HTTP nessa instalação.

Na instância real, **32 verificações de Auth/MCP passaram, sem falhas ou skips**:
duas identidades descartáveis, OAuth nativo com PKCE, consentimento, SDK sobre
HTTPS, descoberta de 47 ferramentas, isolamento e recusa de sessões revogadas.
Uma prova adicional usou RPC autenticada para compactação, Data API com RLS,
`hub_usage` pelo MCP e leitura binária pela API; cada conta conservou seu próprio
objeto e o acesso cruzado foi recusado. Registros eram fixtures sintéticas,
sem consultas ou escritas em fontes institucionais.

A interface publicada foi exercitada e inspecionada no Chrome dedicado, em
390 e 1280 pixels: login real, dois materiais próprios e saída. O formulário
publicado também foi inspecionado em temas claro e escuro. Cadastro/link,
recuperação, consentimento pendente, início social PKCE e retentativa foram
comprovados com respostas Auth controladas. **Não houve teste de entrega de
SMTP nem autenticação real nos provedores sociais.** Capturas usaram retorno
nativo, sem downloads pela interface. O DevTools recusou gravação em caminho
local fora de suas raízes; sua captura foi inspecionada pelo retorno nativo.

## Dados e economia comprovados

As **117 referências continuam disponíveis em 104 objetos**. O conteúdo binário
armazenado passou de **89.900.839 para 80.118.099 bytes**, economizando
**9.782.740 bytes (aproximadamente 10,9%)**. A comparação preservou os hashes dos
bytes, metadados das 12 tabelas de memória e as quatro tabelas privadas.
Os bytes ficam no PostgreSQL; esses números não são uma cota de Supabase Storage
nem a redução imediata do tamanho físico do banco.

A resposta da operação de compactação excedeu a espera do cliente. Antes de
qualquer repetição, a consulta de estado comprovou sua conclusão; a comparação
integral subsequente passou. Não houve repetição da conversão nem rollback.
A recuperação está preparada com reidratação dos bytes antes de usar backend
antigo. As contas descartáveis foram removidas; restam a conta original,
117 arquivos e 104 objetos. Conexões e memória pessoais preservadas.

## Acesso, operação e limitações atuais

**Por decisão expressa do titular, a ativação SMTP ficou para depois.** A instância
mantém cadastro fechado e SMTP padrão. O login existente por link foi preservado;
a interface também oferece senha/recuperação para contas existentes. **Google
habilitado e testado com a conta existente**, conforme a prova abaixo.
O roteiro de SMTP próprio, remetente verificado e teste de
entrega está em [acesso e identidade](docs/acesso-e-identidade.md). A documentação
apresenta a opção gratuita sem contratar serviços ou prometer sua aprovação.

O plano continua Free. Deduplicação não elimina a pausa por inatividade; veja
[operação e recuperação](docs/operacao-e-recuperacao.md). Não há cota automática
por usuário, retenção destrutiva, cron de atividade artificial ou abertura ampla
do serviço. O catálogo e o contrato MCP continuam compatíveis. A verificação
posterior do cliente identificou uma pendência separada, descrita abaixo.

O diagnóstico Supabase antes/depois conserva 29 avisos preexistentes de
[desempenho das políticas RLS](https://supabase.com/docs/guides/database/database-linter?lint=0003_auth_rls_initplan)
e um de [proteção contra senhas vazadas](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection)
desativada. Não surgiram novos avisos; a tabela nova aplica RLS com dono e a view
usa `security_invoker`. Nenhum projeto irmão foi alterado.

Workers com o modelo herdado foram tentados, mas retornaram 429 repetidamente e
não produziram alterações. A sessão principal concluiu o trabalho sem recorrer a
outro provedor pago. Evidências, backup, hashes, roteiro de recuperação e recibos
ficam em `.private/universal/` e na cópia protegida indicada ali, fora do Git.

## Reconexão do ChatGPT — 22/10/2026

O cadastro pessoal anterior estava ausente das listas de plugins criados e
instalados da conta inspecionada; sua página retornou `Plugin not found` e a API,
404. Isso não permite determinar quando ou por que o cadastro desapareceu.
O backend permaneceu acessível: saúde 200, recurso protegido 200 e MCP anônimo
401. A disponibilidade do servidor não comprovava a instalação no ChatGPT.

O cadastro pessoal foi recriado no Chrome dedicado com o mesmo backend e cliente
OAuth público. O callback observado coincide com o já cadastrado. **O AraHub está
instalado e conectado; uma conversa nova chamou `hub_usage` com sucesso.** O
registro da conversa contém a chamada e a resposta da ferramenta concluídas,
confirmando 117 arquivos, 104 objetos e 80.118.099 bytes binários após deduplicação.
Não foi usada credencial administrativa para entrar na conta do titular.
O pacote com a Skill foi preparado para o novo ID; seu envio permanece pendente.
Essa pendência não impediu a chamada MCP real. IDs, recibos e detalhes ficam privados.
O upload pelo DevTools recusou o caminho do workspace; não foram alteradas suas
raízes nem usado o Chrome pessoal. O checkpoint privado conserva o pacote pronto.

O [roteiro de recuperação do cliente](docs/INSTALAR-MCP-SEM-CODEX.md#se-o-arahub-não-aparecer-no-chatgpt)
separa cadastro, sessão e chamada real. Não é necessário republicar o backend ou
restaurar dados para corrigir a ausência do cadastro pessoal.
Documentação conferida com `deno task docs:check` (199 links locais em 53 arquivos),
`git diff --check` e revisão do diff. Nenhum código, migration ou dado foi alterado.

## Correção do retorno de login — 22/10/2026

A tentativa posterior de login retornou `otp_expired`; solicitações de outro
link retornaram 429, `over_email_send_rate_limit`. A instância usa o provedor de
e-mail padrão, com limite de dois envios por hora. Não é possível concluir a
conexão apenas repetindo a solicitação enquanto esse limite estiver ativo.

A correção da interface distingue expiração, retorno sem prova do navegador e
limite de envio (também na recuperação de senha). O retorno Auth é limpo após o
SDK processá-lo; uma sessão válida permanece utilizável ao abrir um link antigo.
Tipos/build, seis testes dirigidos e UI/SDK em 390 e 1280 pixels passaram. Os
testes de UI usam respostas Auth controladas e não enviam e-mails. A correção
está no commit `958dd3d`: [CI aprovada](https://github.com/fabio-ara/AraHub/actions/runs/39878247060)
e [Pages publicado](https://github.com/fabio-ara/AraHub/actions/runs/39878488653).
O bundle servido é idêntico ao validado por SHA-256; a página real que retornou
`otp_expired` passou a mostrar a orientação. A inspeção visual ocorreu nos dois
viewports da prova controlada; a captura hospedada não concluiu no instrumento.
Não foram alterados limites, SMTP, credenciais, backend ou dados do titular.

## Login Google verificado — 22/10/2026

Por solicitação do titular, foi criado um cliente Web dedicado ao login no projeto
Google existente e configurado o provedor nativo do Supabase. O botão **Continuar
com Google** está publicado via configuração do backend. A entrada real usou a
conta Google com o mesmo e-mail confirmado do proprietário; `/auth/v1/user`
comprovou **o mesmo identificador de usuário** e as identidades `email` e `google`.
A biblioteca autenticada respondeu 200. O consentimento OAuth do ChatGPT concluiu
e a leitura MCP descrita acima passou. Houve interação e inspeção visual nativa
da tela publicada no Chrome dedicado, sem download pela interface.

Cadastro fechado, opções de e-mail/senha, SMTP, URLs de retorno da interface e
dados foram preservados. A solicitação Google observada incluiu somente `email`
e `profile`; não pediu acesso a conteúdo Google. O aplicativo Google continua
externo em teste, com a conta existente admitida. A entrada de outras pessoas
depende da política de público Google e da admissão no AraHub; não foi declarada
abertura pública. Nenhuma cobrança ou teste pago foi ativado.

A configuração foi aplicada no Auth e nas variáveis Edge; não exigiu alterar o
bundle da interface. O procedimento e a escolha da identidade estão em
[acesso e identidade](docs/acesso-e-identidade.md#entrar-com-google-sem-esperar-um-e-mail).
Evidências protegidas em `.private/mcp-reconnect-2026-10-22/`: configuração,
comparação de identidade, biblioteca e chamada real do ChatGPT. A credencial
Google permanece fora do Git e do navegador da aplicação.

Documentação conferida com `deno task docs:check` (202 links locais em 53 arquivos),
`git diff --check` e revisão do diff. `deno task secrets` conferiu 264 arquivos no
índice e o histórico, sem achados. A validação funcional desta configuração é a
entrada Google e a chamada MCP hospedadas descritas acima.

## Pendências e próximo passo

**O titular já pode usar o MCP e entrar com Google.** Resta enviar o pacote da
Skill `academic-memory` quando houver um caminho de upload autorizado disponível,
preservando o cadastro conectado. Não recriar o plugin nem repetir o login para
resolver apenas essa pendência de pacote. Quando o titular decidir ativar SMTP, seguir o
roteiro documentado, configurar a credencial em superfície protegida, testar
entrega/recuperação e só então alinhar a política de cadastro. Não há engenharia
ou publicação pendente da versão 0.3.0; a ativação SMTP foi explicitamente adiada.
