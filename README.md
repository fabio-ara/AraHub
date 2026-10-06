# AraHub

Memória acadêmica longitudinal e integrações próprias por MCP. Código novo MIT; materiais acadêmicos e dados de usuários conservam seus direitos.

Implementação em desenvolvimento: Postgres com RLS, referências por usuário/conexão, deltas idempotentes e versões concorrentes, MCP Streamable HTTP, adaptadores Moodle/Google e migração privada. A interface auxiliar mínima serve ao acesso, conexões e autorizações; reproduz o design MIT do AraLearn, em largura de celular e com botões por ícones. O estado comprovado e os gates pendentes estão em [STATUS.md](STATUS.md).

O código é distribuível sob MIT para qualquer pessoa usar, modificar e hospedar sua própria instância. A hospedagem escolhida é GitHub Pages para a interface e Supabase para autenticação, banco e APIs. Licença do código não torna públicos os dados nem concede direitos sobre materiais acadêmicos. [Atribuições](THIRD_PARTY_NOTICES.md).

Instância inicial: [interface](https://fabio-ara.github.io/AraHub/) e
[código MIT](https://github.com/fabio-ara/AraHub). A interface exige conta provisionada
pelo administrador e confirmação por e-mail; inscrições públicas estão fechadas.
O código público permite hospedar outras instâncias, sem acesso aos dados desta.

## Prova local

Requer Docker, Deno 2.9 e Node/npm para o CLI Supabase quando criar migrations. A imagem de Postgres e bibliotecas estão fixadas; `deno.lock` é versionado.

```powershell
docker compose -p arahub up -d --wait
deno task db:setup
deno task web:build
deno task check
deno task test
$env:APP_MODE='synthetic'
deno task dev
```

Abra `http://127.0.0.1:8787`. O modo sintético tem identidade local de demonstração, somente loopback; não comprova OAuth ou contas reais. A fixture `scripts/local_identity.sql` nunca é enviada ao Supabase. Banco/volumes são exclusivos do AraHub, sem acessar infraestrutura de projetos irmãos.

Para reproduzir a instalação com dependências baixadas em cache vazio e banco novo,
execute `deno task validation:fresh`. O gate usa lock congelado, SDK MCP por HTTP,
dois donos e retry idempotente; preserva seu manifesto privado. [Instalação e limites](docs/INSTALACAO.md).

Para modo configurado, copie apenas os nomes de `.env.example` para um arquivo ignorado, preencha por superfície protegida e execute `deno run --env-file=.env --allow-net --allow-env --allow-read src/main.ts`. Nunca cole segredos no chat. O verificador exige assinatura, emissor, audience, sessão ativa e client ID permitido para MCP. A tela de consentimento utiliza o OAuth Server do Supabase; autorização-code/PKCE e consentimento na interface hospedada foram comprovados com contas sintéticas. A conta titular também concluiu entrada e consentimento no cliente pessoal ChatGPT.

## Documentação por etapa

PDFs preservados podem ser extraídos em Conexões → PDFs, no worker terminável
do navegador, sem OCR. Texto e páginas ficam vinculados ao hash e podem ser
recuperados pelo MCP. O backend Supabase recebe os resultados e conserva sua
proveniência; o parser não executa na thread da Edge Function.

- [Plano](docs/PLANO.md), [aceite A01–A30](docs/ACEITE.md), [decisão de arquitetura](docs/ADR-001.md).
- [Moodle](docs/MOODLE.md), [Google](docs/GOOGLE.md), [preferências](docs/PREFERENCIAS.md), [migração](docs/MIGRACAO.md).
- [Sincronização Moodle](docs/SINCRONIZACAO.md), [sincronização Google](docs/GOOGLE_SYNC.md), [arquivos e páginas](docs/ARQUIVOS.md), [pacote de estudo](docs/PACOTE-ESTUDO.md).
- [Gate de implantação](docs/IMPLANTACAO.md), [clientes e primeiro uso](docs/CLIENTES.md), [plugin e Skill](plugin/README.md).
- O bootstrap e todas as evidências pessoais ficam fora do Git. Consulte o bootstrap apenas na etapa pertinente.

O AraHub não possui SQL/HTTP genérico exposto ao modelo, não captura passivamente o chat inteiro e não interpreta conteúdo recuperado como autorização. Um relato de entrega permanece distinto de submissão observada. Escritas externas e cron real precisam de autorização específica. Nenhuma implantação, publicação ou virada da memória deve ser inferida desta prova local.

Verificações adicionais: `deno task edge:check`, `deno task validation:clean`, `deno task migration:validate` e `deno task backup:local`. Os dois últimos usam dados e artefatos privados disponíveis somente no workspace autorizado. validation:clean comprova o banco SQL local novo; validation:fresh acrescenta cache de dependências vazio e lock congelado. Nenhum dos dois instala um ambiente hospedado.

Para QA visual isolado, instale a ferramenta apenas na pasta ignorada: `npm install --prefix .private/qa --save-exact playwright@1.63.0`. Após o build, execute `node scripts/qa_ui.mjs`. Após o build, `node scripts/qa_pages.mjs` opera o pacote Pages com subpath, callbacks físicos, acesso por link PKCE e consentimento. Ambos usam o Chrome instalado em perfil temporário, fixtures de HTTP/Auth e capturas nativas gravadas fora da interface; não operam contas reais nem comprovam hospedagem ou celular físico.
