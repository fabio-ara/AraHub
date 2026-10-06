# Lote autorizado de conexão Google

Preparado e autorizado em 2026-10-06 para aplicativo próprio e leitura.
Código OAuth/leitura já implementado e testado com provedores sintéticos; não é uma
conta Google conectada. Login e aceite pessoal dos Termos de Serviço Google Cloud
concluídos pelo titular. Consentimento OAuth
será dado pelo titular após o cadastro e a conferência de cotas.

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
