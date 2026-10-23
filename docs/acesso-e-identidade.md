# Acesso, cadastro e identidade

Uma pessoa pode ter uma conta AraHub e várias conexões institucionais. A primeira
determina quem possui a memória; cada conexão determina a fonte que pode ser
consultada. Entrar no Google para ler o e-mail não significa que o AraHub tenha
login Google habilitado. O método efetivo é aquele apresentado na tela de entrada.

## Escolher a política da instalação

O administrador escolhe entre contas previamente admitidas (`invite`) e cadastro
aberto (`open`). Essa decisão tem duas partes: a configuração do **Supabase Auth**,
que permite ou recusa novos usuários, e a configuração pública do AraHub, que
apresenta os controles correspondentes.

As variáveis abaixo são lidas pelo backend. O navegador recebe apenas os valores
públicos em `/api/config`; ele não recebe a credencial de SMTP ou do provedor.

| Variável | Valores e efeito |
| --- | --- |
| `ARAHUB_REGISTRATION` | `invite` por padrão; `open` permite solicitar criação por link de e-mail na interface. |
| `ARAHUB_LOGIN_EMAIL_LINK` | `true` por padrão; apresenta entrada por link. |
| `ARAHUB_LOGIN_PASSWORD` | `false` por padrão; se `true`, apresenta senha para contas existentes e recuperação. |
| `ARAHUB_LOGIN_PROVIDERS` | Lista separada por vírgulas: `google`, `github`, `azure`; vazia por padrão. |

Uma configuração inválida ou sem nenhum método é recusada ao iniciar o backend.
Uma flag de interface **não é um controle de autorização**. Desabilitar um botão
não fecha a API Auth, e ativá-lo não configura o provedor. Mantenha a política real
do Auth coerente com a experiência apresentada.

## Entrar por e-mail

No método de link, a pessoa informa seu endereço. Em modo aberto, o pedido pode
criar uma conta e exigir confirmação. Em modo convite, uma conta precisa existir
previamente. O fluxo usa PKCE: o link deve ser aberto no navegador que iniciou a
solicitação. Links vencidos, já usados ou abertos em outro navegador podem exigir
uma nova tentativa.

Senha é uma opção para contas que já possuem uma. Não há um formulário separado
de cadastro por senha: no percurso aberto, a conta nasce pelo link. A recuperação
envia um link que abre o formulário de nova senha. O AraHub exige pelo menos 12
caracteres nessa tela, e o Supabase pode impor exigências adicionais. A nova senha
é enviada ao Auth, nunca ao banco de memória ou ao assistente.

Ao entrar durante a autorização de um cliente MCP, o identificador da solicitação
é preservado para retomar a tela de consentimento. A entrada não aprova o cliente
automaticamente: a revisão correspondente continua necessária.

## Por que um endereço funciona e outro não

O SMTP padrão da Supabase serve à exploração do projeto e restringe destinatários
a endereços da equipe. A documentação consultada em 22/10/2026 informa limite de
duas mensagens por hora. Assim, o titular conseguir entrar não comprova que
visitantes poderão se cadastrar. Para receber outras pessoas por e-mail, configure
um serviço próprio de envio. [Fonte: SMTP da Supabase](https://supabase.com/docs/guides/auth/auth-smtp).

O endereço remetente é a identidade usada para enviar as mensagens de acesso.
Ele não é a senha da conta AraHub, a chave do Moodle nem necessariamente a conta
usada para administrar a Supabase. O administrador precisa controlar esse
remetente e cumprir as exigências do serviço de envio.

## Preparar SMTP próprio

1. Escolha um serviço de envio transacional e uma conta sob seu controle.
2. Confirme o remetente e, quando aplicável, autentique um domínio que você possa
   administrar. Ter uma caixa de e-mail institucional não dá autoridade para
   alterar o DNS da instituição ou usar seu domínio como remetente de um serviço.
3. No painel protegido do Supabase Auth, configure servidor, porta, usuário, senha
   SMTP, endereço remetente e nome “AraHub”. Use a conexão segura recomendada pelo
   provedor. Não grave a senha no Git, em variáveis públicas ou em tickets.
4. Configure a URL da interface e o callback exato, incluindo o subdiretório
   quando usar GitHub Pages. Faça um teste de entrega para uma conta controlada.
5. Confira limites de Auth e do SMTP, validade do link, recuperação e isolamento
   entre duas contas. Desative rastreamento de cliques que reescreva links de Auth,
   se essa função do provedor interferir na validação.
6. Só depois de a entrega funcionar, alinhe cadastro aberto no Auth e
   `ARAHUB_REGISTRATION=open`. Reimplante o backend e confira `/api/config`.

**Caminho sem assinatura adicional:** o plano gratuito da Brevo é uma opção a
avaliar para pequeno volume; na consulta de 22/10/2026 ele inclui 300 envios por dia.
O limite e a aprovação da conta continuam sendo condições do provedor. O remetente
precisa ser validado. A documentação orienta autenticar domínio próprio e descreve
substituição do domínio de remetentes não autenticados por `brevosend.com`; essa
alternativa não equivale a possuir um domínio autenticado nem garante entrega.
Confira [limites Free](https://help.brevo.com/hc/en-us/articles/208580669-FAQs-What-are-the-limits-of-the-Free-plan)
e [configuração do domínio](https://help.brevo.com/hc/en-us/articles/35852083084178-Domain-setup-for-better-email-deliverability).

Criar a conta no provedor, aceitar seus termos e confirmar o remetente são etapas
da pessoa responsável. Uma senha SMTP é configurada em superfície protegida. O
AraHub não promete enviar e-mails para novos usuários antes dessa configuração e
de um teste efetivo de entrega.

## Provedores sociais opcionais

Cada instalação pode configurar Google, GitHub ou Microsoft/Azure no Supabase
Auth e habilitar o botão correspondente. Crie o aplicativo de identidade no
provedor, registre as URLs de retorno corretas e guarde seu segredo apenas no
Supabase. O retorno do provedor ao Supabase e o retorno do Supabase à interface
são duas etapas distintas.

O AraHub solicita o fluxo nativo de OAuth com PKCE. No Azure, solicita o escopo de
e-mail necessário à identidade. Isso não autoriza ler Drive, Gmail, Calendar ou
dados institucionais. As integrações próprias Google de conteúdo foram
[aposentadas](GOOGLE.md); login social não as reativa.

### Entrar com Google sem esperar um e-mail

Quando o administrador habilita o provedor, o botão **Continuar com Google**
aparece antes do formulário de e-mail. Clique nele, selecione a conta Google e
conclua a confirmação solicitada pelo provedor. O retorno abre o AraHub; se a
entrada começou pelo ChatGPT, o próximo passo é o consentimento do cliente MCP.
Não é preciso preencher o campo de e-mail do AraHub antes de clicar no botão.

Escolha uma conta Google com **o mesmo endereço de e-mail da conta AraHub que já
possui seus materiais**. Um endereço institucional pode ser uma conta Google;
não precisa terminar em `gmail.com`. Contas pessoal e institucional com endereços
diferentes não são intercambiáveis. O Supabase associa automaticamente identidades
compatíveis com o mesmo e-mail verificado; isso preserva o usuário existente. Uma
conta de outro endereço não recebe sua memória. Consulte a documentação de
[associação de identidades](https://supabase.com/docs/guides/auth/auth-identity-linking).

O login Google não usa o envio de links do SMTP. A senha e eventual segundo fator
são informados somente na tela do Google. Se a organização exigir uma confirmação
adicional, ela precisa ser concluída pelo titular.

### Configurar o Google: roteiro do administrador

1. Abra o projeto da aplicação no Google Cloud com a conta que o administra.
   Confira nome, público permitido e dados de contato no Google Auth Platform.
2. Crie um cliente OAuth do tipo **Aplicativo da Web**, dedicado ao login.
   Cadastre a origem da interface e o retorno
   `https://<project-ref>.supabase.co/auth/v1/callback`. Esse retorno pertence ao
   Supabase; não substitua pelo endereço da interface.
3. Use somente os escopos de identidade: `openid`, `userinfo.email` e
   `userinfo.profile`. Confira se o público configurado permite as contas desejadas;
   uma aplicação interna pode restringir usuários de fora da organização.
4. No provedor Google do Supabase Auth, guarde o ID e o segredo do cliente e ative
   o provedor. Não coloque o segredo em código, variáveis do navegador ou chat.

Os detalhes atuais estão no [guia Google do Supabase](https://supabase.com/docs/guides/auth/social-login/auth-google).
A administração do Google Cloud pode exigir nova autenticação do responsável.
Isso é uma etapa da configuração; não exige descobrir ou redefinir a senha AraHub.

No AraHub, configure `ARAHUB_LOGIN_PROVIDERS=google` após preparar o provedor.
Preserve as demais opções de entrada que ainda forem necessárias. Confira em
`/api/config` se a lista pública contém `google` e recarregue a interface. O
retorno final à interface continua cadastrado na lista de URLs permitidas do Auth,
por exemplo `https://<host>/<base>/oauth/callback`.

Faça a primeira entrada com uma conta existente. Compare o identificador do
usuário antes/depois e abra seus materiais; encontrar um botão ou receber um
redirecionamento não comprova acesso ao acervo. Depois, complete o consentimento
do ChatGPT e uma chamada MCP de leitura. Registre separadamente essas provas.

Habilitar Google não abre o cadastro do AraHub. Para receber outras pessoas,
defina também a política de admissão no Supabase e na instalação. Um eventual
cadastro aberto exige validar isolamento entre contas. O SMTP próprio continua
necessário para os fluxos de e-mail que a instalação quiser oferecer.

## Diagnóstico

| Situação | Como distinguir |
| --- | --- |
| Cadastro recusado | Confira `disable_signup` no Auth e a política apresentada pelo AraHub. |
| Link não entregue | Confira SMTP/remetente, limites e destinatário autorizado; não abra cadastro apenas para esconder o erro. |
| Link abriu sem sessão | Confira callback, navegador inicial, expiração e uso anterior. |
| Mensagem de link inválido/expirado | Use somente o link da mensagem mais recente, no perfil que o solicitou; links anteriores podem ter sido substituídos ou consumidos. |
| Limite de envio atingido | Aguarde a liberação da janela de envio; repetir a solicitação não resolve o bloqueio. A recuperação de senha usa o mesmo serviço de e-mail. |
| Senha não funciona | Use recuperação da conta correta; a senha Moodle não autentica no AraHub. |
| Botão social falha | Confira provedor ativo, aplicativo, segredo e URLs de retorno. |
| Google informa `redirect_uri_mismatch` | Confira o retorno do Supabase no cliente Web do Google, incluindo domínio e caminho exatos. |
| Entrou com Google, mas não encontrou os materiais | Confira o endereço escolhido e o identificador da conta; não copie dados entre donos para contornar uma identidade errada. |
| Sessão não acessa MCP | Confira cliente OAuth autorizado, emissor, sessão ativa e endpoint correto. |

Registre o sintoma e o horário sem copiar tokens. Veja [operação](operacao-e-recuperacao.md)
e [privacidade](privacidade.md).

O provedor padrão da Supabase limita o projeto a **dois e-mails por hora**,
segundo os [limites oficiais de Auth](https://supabase.com/docs/guides/auth/rate-limits).
A resposta `over_email_send_rate_limit` informa que o envio foi recusado; ela não
confirma que uma nova mensagem chegou. A interface distingue esse caso de
`otp_expired` e de um retorno sem a prova PKCE do navegador. Ela remove os
parâmetros de retorno após processá-los, sem exibir descrições arbitrárias do URL.

Uma verificação automática do provedor de e-mail também pode consumir o link
antes do clique humano. Isso é uma possibilidade documentada, não uma conclusão
automática para todo link recusado. Se o problema persistir mesmo com a mensagem
mais recente, consulte as [orientações sobre leitura antecipada de links](https://supabase.com/docs/guides/auth/auth-email-templates#email-prefetching).
As alternativas com código de uso único ou confirmação intermediária exigem
configuração do template/envio; não são ativadas pelo simples reenvio do link.
