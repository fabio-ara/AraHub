# Lote aprovado de hospedagem

Lote aprovado pelo usuário em 2026-10-05 com a resposta “Aprovo”. A autorização cobre os alvos e limites abaixo; execução e provas ficam registradas no STATUS.

Execução em 2026-10-06: repositório MIT público criado/enviado, GitHub Pages publicado,
backend implantado e onze migrations reconciliadas. Planos Free e cotas reais conferidos
antes das escritas; nenhum upgrade, domínio ou serviço pago. HTTPS/Auth/OAuth nativos e
MCP SDK passaram por 32 verificações com duas contas sintéticas. PDF sintético foi
extraído e gravado na interface hospedada em dois viewports. Confirmação de e-mail do
titular e conexão pessoal ChatGPT concluídas; provas posteriores em STATUS.md.

Alvos concretos conferidos: projeto Supabase AraHub existente em São Paulo na nova conta; repositório público MIT `fabio-ara/AraHub` e interface `https://fabio-ara.github.io/AraHub/`. Código privado, memória, evidências, ZIP e bootstrap continuam excluídos. A matriz exige autorização para criar/enviar o remoto e iniciar hosting; este lote cobre esses dois passos junto do backend, sem importação privada, cron, app Google ou escritas acadêmicas.

Alvo backend: somente o projeto AraHub Free criado na nova conta e na organização Universidade de Lisboa. Função `arahub`, rotas MCP/discovery e APIs autenticadas, sessão verificada, RLS/cofre existentes. Configurar OAuth Server/consentimento e o cliente pessoal no mesmo alvo; conferir claims reais antes de aceitar o cliente. Aplicar migrations novas somente após provas locais e reconciliação do histórico remoto.

Alvo interface: pacote estático público MIT em GitHub Pages, na conta do titular, plano Free, sem domínio pago, cartão, upgrade ou serviços adicionais. Servido no subpath de projeto (`https://<conta>.github.io/AraHub/`). A URL final será conferida e fixada exatamente em UI_ORIGIN, callback, Auth e CORS. A interface contém somente HTML/CSS/JavaScript genéricos MIT e configuração pública; nenhum arquivo privado, código servidor, dump, token ou memória do usuário.

O pacote estático é preparado por `deno task ui:prepare <base-api> <origem-supabase> <URL-da-UI>` em diretório novo de `.private/deploy/`, sem sobrescrever chamadas anteriores e com manifesto/hashes fora dos assets e sem credenciais. A chamada não contata provedor. Arquivos de saída: `index.html`, `privacy.html`, `ui/app.js`, `ui/pdf-parser.worker.js`, `ui/style.css`, `.nojekyll`, `LICENSE.txt` e cópias físicas para as rotas `oauth/consent/index.html`, `oauth/google/callback/index.html` e `oauth/callback/index.html`. Os assets são referenciados por caminhos absolutos com o prefixo do subpath, e o app deriva a base do site de `import.meta.url` (`<base>/ui/app.js`). GitHub Pages não aceita cabeçalhos HTTP customizados: CSP e `referrer` seguem em `<meta>`, sem `frame-ancestors` (o navegador ignora esse diretivo em meta) e a defesa de enquadramento é o frameguard do app (`window.top !== window.self`). Não há `_headers`/`_redirects` de Cloudflare.

Orçamento: custo adicional autorizado zero, com plano/cotas reais conferidos antes da criação. Não contratar domínio pago. O Supabase exige domínio personalizado para servir HTML sem reescrever `Content-Type`, razão para separar a interface estática. Fontes: [limites Supabase](https://supabase.com/docs/guides/functions/limits), [GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages), [Jekyll/.nojekyll](https://docs.github.com/en/pages/setting-up-a-github-pages-site-with-jekyll/about-github-pages-and-jekyll) e [CSP nível 3, `frame-ancestors` ignorado via meta](https://www.w3.org/TR/CSP3/#meta-element).

Gates antes de enviar: TypeScript/bundle, testes locais pertinentes, instalação limpa, isolamento, revisão do pacote e credenciais, conferência dos destinos e plano. Gates depois: discovery HTTPS, Auth/consentimento real, cliente MCP novo, sessão revogada e dois donos; provas de provedor e smartphone têm evidência própria.

Automação preparada: `.github/workflows/pages.yml`, somente `workflow_dispatch`, actions fixadas por SHA, Deno 2.9.3 e permissões Pages/OIDC apenas no job de publicação. As variáveis públicas `ARAHUB_API_BASE`, `ARAHUB_IDENTITY_ORIGIN` e `ARAHUB_UI_URL` alimentam o empacotador; nunca inserir credenciais nessas variáveis. O artifact contém somente o diretório novo de dez assets, sem manifestos/evidências/dumps. O workflow foi executado com sucesso no GitHub; ver STATUS para o checkpoint corrente.

Atualização SQL: `scripts/prepare_cloud_update.ts` confere que o registro remoto é prefixo exato das migrations locais e gera diretório novo com somente as pendentes. A transação trava o registro e reconfere hashes antes de alterar; replay/drift recusados. Oito hashes iniciais reconferidos pelo CLI, duas migrations funcionais e a correção de EXECUTE aplicadas com guarda; onze hashes finais reconciliados. Instalação local nova com onze migrations aprovada. Não usar o bundle inicial para atualização.

O lote aprovado inclui criar/enviar o repositório público indicado e hospedar a interface; tem autorização específica registrada. Inclui o worker PDF na interface e as rotas pessoais de gravação; o parser não executa na Edge. Não inclui importar memória privada, ativar recorrência, configurar app Google ou escrever em contas acadêmicas. Login/MFA e entrada de credenciais usam superfícies protegidas e participação humana quando necessária, sem segredos no chat.

Distribuição: `LICENSE.txt` acompanha os assets com a licença MIT do AraHub e as atribuições/licenças do AraLearn das nove dependências fixadas do app e do pdf.js Apache-2.0 no worker. O pacote tem dez arquivos; nenhum manifesto privado é distribuído. Código-fonte completo MIT publicado no repositório AraHub do titular após revisão do índice/histórico. Licenças e dados acadêmicos permanecem separados.
