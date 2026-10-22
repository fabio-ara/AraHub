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
a interface também oferece senha/recuperação para contas existentes. Não há login
Google configurado. O roteiro de SMTP próprio, remetente verificado e teste de
entrega está em [acesso e identidade](docs/acesso-e-identidade.md). A documentação
apresenta a opção gratuita sem contratar serviços ou prometer sua aprovação.

O plano continua Free. Deduplicação não elimina a pausa por inatividade; veja
[operação e recuperação](docs/operacao-e-recuperacao.md). Não há cota automática
por usuário, retenção destrutiva, cron de atividade artificial ou abertura ampla
do serviço. O pacote pessoal previamente instalado não precisou ser substituído:
o catálogo e o contrato MCP continuam compatíveis.

O diagnóstico Supabase antes/depois conserva 29 avisos preexistentes de
[desempenho das políticas RLS](https://supabase.com/docs/guides/database/database-linter?lint=0003_auth_rls_initplan)
e um de [proteção contra senhas vazadas](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection)
desativada. Não surgiram novos avisos; a tabela nova aplica RLS com dono e a view
usa `security_invoker`. Nenhum projeto irmão foi alterado.

Workers com o modelo herdado foram tentados, mas retornaram 429 repetidamente e
não produziram alterações. A sessão principal concluiu o trabalho sem recorrer a
outro provedor pago. Evidências, backup, hashes, roteiro de recuperação e recibos
ficam em `.private/universal/` e na cópia protegida indicada ali, fora do Git.

## Próximo passo

Uso cotidiano da versão publicada. Quando o titular decidir ativar SMTP, seguir o
roteiro documentado, configurar a credencial em superfície protegida, testar
entrega/recuperação e só então alinhar a política de cadastro. Não há engenharia
ou publicação pendente desta entrega; a ativação foi explicitamente adiada.
