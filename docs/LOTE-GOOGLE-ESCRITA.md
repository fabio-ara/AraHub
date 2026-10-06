# Prova delimitada de produção Google

Estado: **preparado, não autorizado e não executado**. A autorização vigente cobre
aplicativo e leitura. Implementação e testes sintéticos não autorizam criar estes
recursos na conta Google. O titular pode aprovar este lote quando retornar; login,
consentimento incremental e revisão de cada versão são atos distintos.

Destino proposto: a conexão institucional já vinculada ao próprio usuário AraHub,
no aplicativo Google exclusivo existente. Conferir conta, plano e cotas antes da
execução: custo adicional máximo zero, sem faturamento, cartão, trial ou aumento
de permissões administrativas. Identificadores reais e recibos ficam privados.

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

Executar via cliente MCP real, recuperar cada recibo e ler os três recursos pelas
APIs nativas. Conferir texto e IDs, valor/fórmula/valor calculado 5 da célula A4,
texto literal B1, tipos das células e slide/caixa/geometria. Repetir a invocação do
mesmo action_id comprova ausência de reenvio; não autoriza uma ação equivalente
com ID novo. Em revisão obsoleta, reprepare e devolva a revisão ao titular.

Resultado incerto exige leitura do destino e reconciliação antes de outra ação;
não reenviar automaticamente nem inferir êxito por timeout. Registrar somente
metadados de validação/IDs protegidos e hashes na evidência privada.

Este lote não altera arquivos existentes, não envia mensagens, não compartilha,
não apaga/move recursos, não agenda tarefas e não importa conteúdo privado.
Os três recursos ficam identificados como testes na conta; exclusão posterior
não exige ampliar a capacidade do aplicativo e pode ser feita pelo titular.
Não encerra edição de células existentes (sem precondição nativa atômica), testes
em segunda conta, sincronização com alterações reais ou aceite móvel.
