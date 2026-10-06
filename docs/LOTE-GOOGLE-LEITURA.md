# Lote autorizado de conexão Google

Preparado e autorizado em 2026-10-06 para aplicativo próprio e leitura.
Código OAuth/leitura implementado e testado com provedores sintéticos. Login,
consentimento OAuth e aceite pessoal dos Termos de Serviço Google Cloud
concluídos pelo titular. Projeto exclusivo AraHub criado: 12 projetos disponíveis
na cota antes da criação, sem projetos existentes visíveis. Painel de faturamento
confirma que o projeto não possui conta vinculada. Seis APIs ativadas; cliente Web
AraHub criado como cliente de agente, callback/origem exatos, escopos somente de
identidade/leitura cadastrados e titular incluído como usuário de teste. Segredo
preservado apenas na configuração privada do backend, já implantada. A conta real
está conectada: identidade verificada, seis permissões solicitadas/concedidas,
nenhuma negada e escritas desativadas. A conexão e a presença de refresh token no
cofre foram comprovadas; isso não prova uma leitura nem uma renovação efetiva.

Autorização: aplicativo OAuth **AraHub** em projeto Google Cloud exclusivo, na conta
institucional titular; conferir projetos existentes antes de criar e não usar
projetos irmãos. Sem cartão, conta de faturamento, trial pago, pedido de cota maior,
serviço de computação ou domínio. Conferir termos/cotas reais antes de ativar APIs;
custo adicional máximo zero. O Google Cloud apenas cadastra a permissão de acesso
ao Google; hospedagem permanece em Supabase/GitHub Pages.

Configuração: cliente Web com callback exato
`https://fabio-ara.github.io/AraHub/oauth/google/callback`, origem
`https://fabio-ara.github.io`; nome AraHub e links para o código/interface. Segredo
do cliente apenas no cofre/configuração protegida do backend, nunca no browser,
Git, chat ou logs. Ativar somente Gmail, Calendar, Drive, Docs, Sheets e Slides
necessários à leitura. Nenhuma delegação administrativa de domínio.

Escopos da primeira conta: identidade/e-mail/perfil e leitura de Gmail, Calendar,
Drive e documentos nativos. Escopos OAuth `gmail.readonly`, `calendar.readonly`,
`drive.readonly`, `documents.readonly`, `spreadsheets.readonly` e
`presentations.readonly`, sob `https://www.googleapis.com/auth/`. Login/MFA e
consentimento são humanos; negar uma permissão produz cobertura parcial explícita.
Conta pessoal adicional exige sua identificação e consentimento próprios.

O consentimento da primeira conta usou identidade, Gmail, Calendar e Drive somente
de leitura. `drive.readonly` também permite os métodos de leitura de Docs, Sheets
e Slides; os três escopos nativos adicionais estão cadastrados, mas não foram
pedidos redundantemente. Os nomes equivalentes `userinfo.email`/`userinfo.profile`
devolvidos pelo Google são normalizados para `email`/`profile`; a resposta original
é preservada para auditoria. A interface conta somente permissões solicitadas que
foram efetivamente concedidas.

`hub_google_read` aceita `max_pages` de 1 a 3 e `max_items` de 1 a 100, mantém a
continuação quando parcial e ajusta o tamanho da página ao orçamento restante.
O primeiro ensaio usa uma página de até três itens por serviço. Não confundir
limites enviados com cobertura efetivamente devolvida pelo provedor.

Prova proposta após consentimento: confirmar identidade, ler uma página limitada
de mensagens/eventos/arquivos, documento nativo escolhido por ID, refresh e cliente
MCP novo; preservar somente espelho privado/proveniência dentro da conta AraHub.
Sem coleta irrestrita, agendamento ou publicação. Alterações em Gmail, Calendar,
Drive ou documentos e escopos de escrita não pertencem a este lote.

Conferir políticas Workspace sem contorná-las. Um app em Testing pode exigir
reconsentimento após sete dias; não declarar operação permanente comprovada por um
ensaio. Quotas Drive mudaram para projetos novos em maio de 2026; conferir o estado
real e não presumir custo ilimitadamente zero.
Fontes: [OAuth e expiração](https://developers.google.com/identity/protocols/oauth2),
[fluxo Web](https://developers.google.com/identity/protocols/oauth2/web-server),
[limites Drive](https://developers.google.com/workspace/drive/api/guides/limits) e
[limites Gmail](https://developers.google.com/workspace/gmail/api/reference/quota).

## Conferência no projeto antes das leituras

Painel nativo Google Cloud: uso zero; sem faturamento, trial ou pedido de aumento.
Valores por minuto / por usuário por minuto: Gmail 1.200.000 / 6.000 unidades;
Calendar 10.000 / 600 consultas; Drive 1.000.000 / 325.000 unidades; Docs 3.000 / 300
leituras; Sheets 300 / 60 leituras; Slides 3.000 / 600 leituras (leituras caras:
300 / 60). Evidência privada em `.private/evidence/google-quota-before-reads.json`.
Não confundir cotas técnicas com volume autorizado: o primeiro ensaio continua
restrito a páginas limitadas e recursos escolhidos por ID, sem recorrência.

O app permanece Externo/Testing, com limite de 100 usuários; não foi publicado como
app Google de produção nem enviado para verificação. [Política de privacidade](https://fabio-ara.github.io/AraHub/privacy.html)
e página inicial cadastradas no branding. A política descreve consultas pelo
assistente, armazenamento, isolamento, uso limitado e desconexão. Publicação MIT e
interface continuam no lote de hospedagem; dados e segredo não são publicados.
