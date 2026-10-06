# Prova delimitada de produção Google

Estado em 2026-10-06: **lote autorizado e concluído**. O titular autorizou somente os
três recursos sintéticos e as cinco operações abaixo. A conexão institucional
retornou do callback Google com nove permissões solicitadas/concedidas e uma
pendência OAuth consumida. O titular aprovou as cinco versões na interface confiável;
cada recibo tinha hash/revisão válidos e foi consumido uma vez. As cinco operações
obtiveram `succeeded` e IDs nativos, sem resultado incerto. Consentimento OAuth,
aprovação de lote e revisão de cada versão foram atos distintos.

Destino: a conexão institucional já vinculada ao próprio usuário AraHub,
no aplicativo Google exclusivo existente. Conferir conta, plano e cotas antes da
execução: custo adicional máximo zero, sem faturamento, cartão, trial ou aumento
de permissões administrativas. Identificadores reais e recibos ficam privados.

Conferência de 2026-10-06: as páginas oficiais de [Docs](https://developers.google.com/workspace/docs/api/limits), [Sheets](https://developers.google.com/workspace/sheets/api/limits) e [Slides](https://developers.google.com/workspace/slides/api/limits) indicam uso padrão sem custo adicional e limite de 60 escritas/minuto por usuário/projeto para cada API. O lote executou cinco operações, abaixo desses limites. A evidência privada anterior do projeto registrou faturamento desvinculado; o painel Cloud não pôde ser reconferido nesta sessão sem novo login institucional. Nenhum faturamento, trial ou aumento foi ativado.

Permissões incrementais necessárias: `documents`, `spreadsheets` e `presentations`
sob `https://www.googleapis.com/auth/`. Não pedir escrita ampla de Drive, Gmail
ou Calendar. A concessão OAuth habilita capacidades; não substitui a aprovação
de conteúdo no AraHub. Negação de capacidade interrompe apenas aquela operação.

## Conteúdo fixado para revisão

Criar somente três recursos privados novos, sem compartilhar ou publicar:

| Recurso | Nome | Conteúdo sintético |
|---|---|---|
| Documento | `[AraHub teste] Documento` | `AraHub — prova sintética de produção.\nNenhum dado acadêmico real.\n` |
| Planilha | `[AraHub teste] Planilha` | Aba `Dados`; A1=`Valor`, A2=2, A3=3, A4=fórmula `=SUM(A2:A3)`; B1=texto literal `=1+1`; C1=verdadeiro; D1=vazia |
| Apresentação | `[AraHub teste] Apresentação` | Um slide vazio novo com caixa: `AraHub — prova sintética\nNenhum dado acadêmico real.`; x/y=40 pt, largura=600 pt, altura=300 pt |

Sequência de **cinco escritas**: criar documento; criar planilha já com células;
criar apresentação; inserir o texto no documento novo, índice 1, revisão fixada;
acrescentar slide/caixa/texto na apresentação nova, revisão fixada. IDs dos novos
recursos vêm dos recibos nativos; não localizar o destino somente pelo nome.
IDs novos do slide/caixa são preparados e mostrados antes da aprovação.

Para cada ação, o assistente prepara o snapshot; o titular confere conta,
destino/conteúdo e autoriza essa versão pelo ícone na interface. Uma autorização
de lote não permite fabricar esses recibos, alterar conteúdo depois de aprovado
ou executar em outro recurso. Aprovação expirada exige nova revisão.

## Conferência e limites

Após as aprovações por versão, executar via cliente MCP real, recuperar cada recibo e ler os três recursos pelas
APIs nativas. Conferir texto e IDs, valor/fórmula/valor calculado 5 da célula A4,
texto literal B1, tipos das células e slide/caixa/geometria. Repetir a invocação do
mesmo action_id comprova ausência de reenvio; não autoriza uma ação equivalente
com ID novo. Em revisão obsoleta, reprepare e devolva a revisão ao titular.

Resultado incerto exige leitura do destino e reconciliação antes de outra ação;
não reenviar automaticamente nem inferir êxito por timeout. Registrar somente
metadados de validação/IDs protegidos e hashes na evidência privada.

Resultado: o MCP pessoal executou as três criações e as duas alterações nos
recursos recém-criados. A leitura nativa confirmou um Documento com o texto
sintético, uma Planilha `Dados` com tipos corretos e A4 calculada em 5, e uma
Apresentação com novo slide/caixa/texto em 40×40 pt e 600×300 pt. Docs e Slides
acrescentaram uma quebra de linha final própria do provedor. Cinco consultas
repetidas pelos mesmos `action_id` devolveram os recibos existentes; o código
retorna antes de qualquer POST nesse estado. Três buscas exatas e completas no
Drive encontraram um único ID esperado por título. Prova detalhada, IDs,
revisões, hashes e limites em `.private/evidence/google-write-lot-final-proof.json`.
O AraHub não compartilhou arquivos; a listagem Drive usada não devolveu ACL,
portanto a privacidade não foi auditada independentemente por permissão.

Este lote não altera arquivos existentes, não envia mensagens, não compartilha,
não apaga/move recursos, não agenda tarefas e não importa conteúdo privado.
Os três recursos ficam identificados como testes na conta; exclusão posterior
não exige ampliar a capacidade do aplicativo e pode ser feita pelo titular.
Não encerra edição de células existentes (sem precondição nativa atômica), testes
em segunda conta, sincronização com alterações reais ou aceite móvel.
