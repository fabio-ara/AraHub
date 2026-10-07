# Preparação de um serviço AraHub para outras pessoas

Estado em 2026-10-06: **proposta para aprovação; inscrições e distribuição pública
continuam desativadas**. O titular pediu preparar esta instância para uso público,
sem autorizar ainda convidar terceiros, abrir o cadastro, criar provedores,
contratar serviços ou submeter o plugin ao diretório. O alvo seria somente o
projeto Supabase **AraHub** do titular e sua interface GitHub Pages; projetos
irmãos e dados de outras contas não entram neste lote.

## Experiência pretendida

1. A pessoa abre a interface, cria sua própria conta por um método de entrada
   aprovado e aceita a política de dados. A entrada no AraHub é separada do
   login institucional Moodle.
2. Em Conexões → Moodle, informa a origem HTTPS, abre o `launch.php` oficial,
   faz SSO na instituição e cola no campo mascarado o endereço do link “Abrir o
   aplicativo”. O AraHub extrai a chave Web Service, descarta a chave privada
   de autologin, valida a identidade e guarda a chave cifrada. O Moodle pode
   emitir uma chave nessa etapa; login prévio no aplicativo móvel não é
   requisito. Se o serviço móvel for indisponível, o fluxo para sem contorno.
3. No ChatGPT web, a pessoa adiciona o URL HTTPS do MCP como plugin pessoal,
   conclui OAuth e usa o AraHub na conversa. Esse caminho [oficial para MCP
   personalizado](https://developers.openai.com/api/docs/guides/custom-mcp-server)
   não exige terminal nem Codex, mas depende das permissões do workspace. O
   painel permanece para conexões, renovações, extração de PDFs e autorizações;
   a consulta cotidiana é pelo MCP. O serviço não observa automaticamente
   postagens em tempo real: atualização é solicitada pelo usuário. O
   [roteiro de instalação](INSTALAR-MCP-SEM-CODEX.md) já está pronto para contas
   autorizadas.

Uma publicação no diretório universal seria **outro lote**. Ela requer pacote,
verificação do publicador/domínio, casos positivos e negativos, conta de
revisão com dados sintéticos e sem magic link/MFA, vídeo, revisão e publicação
separada, conforme o [fluxo oficial](https://developers.openai.com/plugins/deploy/submission).
Há um risco material de reprovação: as [diretrizes do diretório](https://developers.openai.com/plugins/plugin-guidelines)
restringem conectores não oficiais a serviços de terceiros e coleta de
credenciais. A chave móvel Moodle é uma credencial e a integração não é uma
autorização OAuth institucional delegada. Não afirmar elegibilidade para o
diretório nem tentar disfarçar o fluxo. A instalação pessoal via URL continua
um caminho diferente, sujeito às regras do ChatGPT e do Moodle.

## O que está provado e o que falta

O MCP pessoal hospedado, OAuth da conta titular, RLS e dois proprietários
sintéticos em banco local foram testados. A conexão Moodle real e o primeiro
lote privado de dois cursos/22 PDFs estão completos; a segunda pessoa real
**não** foi convidada nem testada. O formulário hospedado usa
`shouldCreateUser: false`. Leitura administrativa da configuração hospedada
em 2026-10-06 confirmou `disable_signup: true`, confirmação de e-mail ativa,
SMTP próprio não configurado, CAPTCHA e login social desativados. Uma troca
de botão ou de parâmetro no navegador não libera usuários com segurança.

O e-mail padrão do Supabase [só entrega à equipe do
projeto](https://supabase.com/docs/guides/auth/auth-smtp) e tem [limite atual
de duas mensagens por hora](https://supabase.com/docs/guides/auth/rate-limits).
Para entrada por e-mail de qualquer endereço, é preciso escolher e configurar
SMTP próprio, remetente/domínio verificável, cotas e custo. Login social é
uma [alternativa suportada](https://supabase.com/docs/guides/auth/social-login),
mas só atende quem tem conta no provedor escolhido; requer um aplicativo OAuth
de **identidade**, distinto da conexão Google acadêmica já existente, e prova
de login por outra pessoa. Nenhum dos dois caminhos foi contratado ou ativado.

O [Free impõe 500 MB de tamanho de banco antes de modo somente leitura](https://supabase.com/docs/guides/platform/database-size).
O banco desta instância, com a conta titular e o conteúdo já preservado, mediu
118.314.675 bytes após guardar 39.493.053 bytes em PDFs e 1.434 páginas de
texto. Isso é medição do banco inteiro, não consumo atribuído à conta nem
previsão por novo usuário; mostra que abrir ingestão sem teto
por conta e monitoramento não cabe no plano atual. O projeto não tem cobrança
habilitada, e esta preparação não muda esse limite.

## Lote de ativação a aprovar separadamente

Antes de qualquer convite ou cadastro público, fixar em uma versão deste
documento: método de identidade e conta responsável; provedor de e-mail ou
OAuth, domínio/remetente, preço máximo e cotas; público admitido; limite de
armazenamento/extração/chamadas por conta e comportamento ao atingir o teto;
política de retenção/exclusão inclusive backups e contato de suporte; regras
institucionais aplicáveis ao token móvel; e caminho de instalação do MCP.
Nenhum dado Moodle ou METD do titular servirá de conta de demonstração.
A auditoria encontrou uma FK que bloqueava excluir uma conta. A migration
`20261007025000_entity_owner_cascade.sql` corrigiu essa relação; um teste
local apagou um usuário sintético, consultou todas as tabelas por dono e
preservou os registros do segundo. No projeto hospedado, o registro contém as
13 migrations, a FK está em cascata e os 22 PDFs permanecem; **nenhuma conta
real foi excluída nem o fluxo completo de exclusão foi provado ali**. Backups
continuam fora dessa cascata. O arquivo `supabase/config.toml` representa o
ambiente local; a configuração hospedada acima foi lida separadamente.

Depois da aprovação **específica** desse lote, executar nesta ordem:

1. Implementar travas de quota por proprietário e recusa previsível antes de
   ingestão, fluxo de exclusão com recibo e limpeza de backups, política de
   privacidade específica da instância e proteção contra abuso no cadastro.
2. Configurar o provedor escolhido no Auth do projeto AraHub e só então
   habilitar o formulário. Não empurrar configuração global do Supabase nem
   reutilizar as permissões Google de Gmail/Drive para autenticação.
3. Testar com uma segunda conta real e consentida: cadastro/entrega de login,
   OAuth do ChatGPT, conexão Moodle sem Codex, recusas cruzadas por API/MCP/SQL,
   recuperação dos próprios arquivos, revogação/exclusão e consumo de cota.
   Usar conteúdo sintético; não coletar chave ou senha no chat.
4. Só após esses gates, convidar ou abrir a instância no público definido. A
   submissão ao diretório do ChatGPT, eventual agendamento, troca de plano,
   SMTP pago e importação de dados de terceiros permanecem aprovações próprias.

Critério de parada da preparação: não existe hoje provedor de entrada aprovado,
segunda conta consentida, quota por pessoa nem prova de elegibilidade do
diretório. O serviço pessoal permanece operacional; este documento não é
uma declaração de lançamento público.
