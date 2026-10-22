# Instalar e configurar uma instância

Uma instalação própria precisa de interface, backend, identidade e banco. Este
guia explica a ordem e as decisões; as referências de comandos e contratos estão
em [implantação](IMPLANTACAO.md) e [cliente MCP](CLIENTES.md). Não reutilize
credenciais ou referências de projeto de outra instalação.

## 1. Conhecer os ambientes

| Ambiente | Finalidade |
| --- | --- |
| Local sintético | Aprender, desenvolver e testar com identidade controlada. |
| Homologação | Exercitar serviços reais com contas e conteúdo autorizados para testes. |
| Produção | Guardar a memória útil das pessoas e atender seus clientes. |

Os scripts locais usam `127.0.0.1:55432/arahub`. A identidade sintética de
`scripts/local_identity.sql` existe para esse ambiente; não deve ser aplicada ao
Supabase Auth hospedado. O código de produção depende de sessões e assinaturas
reais, não de aceitar um UUID informado pelo navegador.

## 2. Preparar o desenvolvimento

Instale Git, Deno 2.9.3 e Docker compatível com seu sistema. O banco do projeto usa
uma imagem fixada em `compose.yaml`; as bibliotecas estão no `deno.lock`. Node/npm
é necessário para o CLI Supabase e para os roteiros de navegador, quando usados.

```powershell
git clone https://github.com/fabio-ara/AraHub.git
cd AraHub
docker compose -p arahub up -d --wait
deno task db:setup
deno task web:build
$env:APP_MODE='synthetic'
deno task dev
```

Abra `http://127.0.0.1:8787`. Se o Docker falhar, confirme primeiro se esse banco
está ouvindo e respondendo antes de repetir inicializações. Não aponte a fixture
para um projeto remoto como alternativa a um problema local.

## 3. Configurar a hospedagem

O caminho de referência usa uma instalação Supabase para PostgreSQL, Auth e Edge
Function, e GitHub Pages para a interface estática. Hospedar o código não requer
usar o projeto do autor. Escolha seu projeto, região, URLs e política de acesso.
Confira os limites e os custos na conta antes de provisionar serviços.

As migrations em `supabase/migrations/` definem a estrutura da aplicação. Use o
CLI na versão conferida, descubra os comandos por `--help` e aplique as migrations
no alvo escolhido. A atualização de uma instalação existente deve reconciliar o
registro remoto e preservar os dados; não reaplique o pacote inicial sobre um
banco já usado. Consulte [implantação](IMPLANTACAO.md).

## 4. Definir as variáveis

[.env.example](../.env.example) é a referência versionada. Arquivos `.env` não são
carregados implicitamente por todos os comandos: forneça as variáveis ao processo
ou use o mecanismo `--env-file` do Deno quando apropriado. Na Edge, configure
segredos no ambiente protegido do projeto.

| Grupo | Variáveis principais |
| --- | --- |
| Endereços | `PUBLIC_URL` é a base da função; `UI_ORIGIN` é a origem HTTPS exata; `UI_URL` inclui o caminho do site e `/` final. |
| Banco | `DATABASE_URL`, ou `SUPABASE_DB_URL` injetada pela hospedagem. |
| Identidade | `AUTH_ISSUER`, `AUTH_AUDIENCE`, `MCP_CLIENT_IDS`, `SUPABASE_URL`. |
| Chave pública | `ARAHUB_PUBLISHABLE_KEY` na Edge; `SUPABASE_PUBLISHABLE_KEY` no servidor local configurado. |
| Cofre | `ARAHUB_TOKEN_VAULT_KEY` e `ARAHUB_TOKEN_VAULT_KEY_ID`. |
| Transferência | `ARAHUB_MATERIAL_TRANSFER_KEY`, independente da chave do cofre. |
| Entrada | `ARAHUB_REGISTRATION` e `ARAHUB_LOGIN_*`, detalhadas no [guia de identidade](acesso-e-identidade.md). |

Uma chave pública permite inicializar o cliente e não substitui login. Chaves de
serviço, senha do banco e segredo do cofre nunca vão para HTML, JavaScript público
ou variáveis `vars` do workflow Pages.

## 5. Preparar identidade e cliente MCP

Configure a URL do site e callbacks exatos no Supabase Auth, incluindo o subpath
do GitHub Pages. Escolha convite ou cadastro aberto e os métodos de entrada. Para
e-mail público, configure SMTP próprio antes de liberar inscrições. Mantenha
confirmação de e-mail; uma falha de entrega não é resolvida tornando qualquer
endereço uma identidade já confirmada.

Configure o servidor OAuth e o cliente MCP da instalação. O backend precisa
reconhecer o identificador do cliente em `MCP_CLIENT_IDS`. Esse vínculo é distinto
da identidade da pessoa e da conexão Moodle. Verifique descoberta, callback,
consentimento e revogação pelo cliente real.

## 6. Publicar interface e backend

O backend de referência é `supabase/functions/arahub`. Seu gateway deixa a
validação dos tokens OAuth ao verificador da aplicação; siga o contrato de
[implantação](IMPLANTACAO.md), sem eliminar essa validação.

Prepare a interface com as bases da sua instalação:

```powershell
deno task web:check
deno task web:build
deno task ui:prepare https://projeto.supabase.co/functions/v1/arahub https://projeto.supabase.co https://exemplo.github.io/AraHub/
```

Os endereços acima são exemplos, não um projeto utilizável. O pacote é criado em
diretório novo e contém apenas assets públicos. O manifesto de hashes fica fora
dos assets. Configure `ARAHUB_API_BASE`, `ARAHUB_IDENTITY_ORIGIN` e `ARAHUB_UI_URL`
nas variáveis do repositório e execute o workflow manual da interface. Verifique
o site servido, não apenas o sucesso do build.

## 7. Admitir uma segunda pessoa

Em convite, prepare a conta pela administração Auth e envie o convite somente ao
destinatário autorizado. Em cadastro aberto, a própria pessoa inicia o fluxo na
interface. Ela confirma seu e-mail, entra e conecta suas próprias fontes.
O administrador não deve receber a senha institucional pelo chat.

Antes de anunciar a instalação, teste com duas identidades consentidas: cada uma
deve ver somente seus contextos, conexões e arquivos; UUIDs da outra conta devem
ser recusados. Teste saída, sessão revogada, recuperação e limite de envio. Uma
prova com identidades sintéticas tem valor técnico, mas não demonstra recebimento
de e-mail por uma pessoa real.

## 8. Planejar a operação

Registre responsável, limites de uso, backup, retenção, suporte e recuperação. Não
há cota automática de bytes por conta nesta versão. Uma instalação aberta precisa
acompanhar consumo e abuso; a deduplicação não substitui essa responsabilidade.

Consulte [armazenamento](armazenamento.md), [operação e recuperação](operacao-e-recuperacao.md)
e [capacidades e limites](capacidades-e-limites.md). Uma implantação Free continua
sujeita à política de pausa por inatividade.
