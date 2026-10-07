# Primeira captura privada do Moodle

Estado em 2026-10-06: **autorizado e executado** no projeto próprio. O manifesto
com os IDs e nomes acadêmicos fica somente em
`.private/cloud/moodle-import-lot-2026-10-06.json`, fora do Git.

## Destino e limite

Somente a conta já conectada ao projeto Supabase **AraHub** do titular. Os dois
cursos retornados para essa conta serão espelhados no banco privado, com
proveniência, cobertura e isolamento pelo proprietário. O lote lê a estrutura,
atividades, fóruns, discussões e postagens visíveis nesses cursos; não consulta
outras contas nem perfis de colegas como objeto de coleta.

A estrutura atual referencia 22 PDFs distintos, somando **39.493.053 bytes**
(observação de 2026-10-06); o maior tem menos de 8 MiB. Preservar esses PDFs
privadamente, em sequência, com teto de **50 MiB de binários no lote** e **20 MiB
por arquivo**. Se a origem, o tamanho ou a cobertura divergir do manifesto,
interromper o arquivo afetado e registrar lacuna; não ampliar o lote por
inferência. Links externos e outros tipos de arquivo ficam fora desta captura.

Antes de escrever, reconferir plano Free e tamanho físico do banco. O lote só
prossegue se a projeção após os binários e margem operacional permanecer abaixo
de 400 MB; a cota oficial do banco Free é 500 MB por projeto e excedê-la pode
colocar o banco em modo somente leitura. Não contratar plano, serviço ou cota
extra. [Cotas Supabase](https://supabase.com/docs/guides/platform/billing-on-supabase),
[limite de banco Free](https://supabase.com/docs/guides/platform/database-size).

## Execução e prova

1. Conferir conexão/identidade Moodle e RLS no projeto próprio; registrar
   contagens e tamanho sem conteúdo acadêmico em logs.
2. Executar `hub_sync_moodle_course` para cada um dos dois cursos e retomar
   janelas parciais até obter cobertura completa ou lacunas explícitas. O espelho
   mantém relações/versões; uma ausência em cobertura parcial não é exclusão.
3. Executar `hub_preserve_moodle_material` só para os 22 IDs de PDF fixados no
   manifesto, até o teto. Conferir bytes, SHA-256, proveniência e repetição
   idempotente. Preservar o binário não significa que suas páginas foram lidas;
   a extração de texto tem prova separada na interface com worker.
4. Em cliente MCP novo, ler contexto/observações offline de uma amostra e
   comparar com fonte/cobertura. Testar recusa de outro dono por dados sintéticos,
   sem expor títulos, URLs com chave ou texto de posts em evidência pública.

## Resultado verificado

Os dois cursos foram espelhados privadamente. O primeiro terminou sem janela
pendente: 8 seções, 14 módulos, 2 fóruns, 11 discussões e 146 postagens. O segundo
terminou sem janela pendente: 3 seções, 36 módulos, 2 fóruns, 2 discussões e 2
postagens. A cobertura de conclusão de curso é `unavailable` em ambos porque a
fonte respondeu `nocriteriaset`; no segundo, a consulta de tarefas manteve
`partial` com avisos Moodle. Esses estados não foram apresentados como completos.

Os 22 PDFs do manifesto foram preservados com cobertura de download `complete`:
**39.493.053 bytes**, SHA-256 individual e proveniência Moodle. A consulta direta
ao banco encontrou 22 arquivos, a mesma soma de bytes, nenhuma ausência e
nenhuma divergência de tamanho ou hash. Uma repetição do maior arquivo devolveu
o mesmo ID/hash/tamanho, sem criar nova cópia. Após a extração, o banco ficou
com 118.314.675 bytes, abaixo da margem de 400 MB deste lote. Uma amostra foi
recuperada pelo MCP sem nova consulta ao Moodle: arquivo, entidade e observação
com proveniência `moodle`, cobertura `complete` e conteúdo marcado como dado não
confiável.

A primeira tentativa com um PDF de 7,9 MB atingiu o limite de memória da Edge
Function (HTTP 546). A versão 21 grava em blocos de 1 MiB, com transação e
verificação de hash no banco; após a implantação, os dois arquivos pendentes
passaram. A suíte local terminou com 248 testes aprovados. Os recibos individuais,
IDs e consulta de integridade ficam em `.private/evidence/`, fora do Git.

Na interface hospedada, o worker extraiu os 22 PDFs em sequência e retomou os
parciais sem perder páginas. A consulta independente ao banco confirmou
**22 extrações completas, 1.434 páginas declaradas e 1.434 guardadas**, zero
arquivo truncado e zero divergência de hash. Há 18 páginas sem texto; a extração
não faz OCR nem interpreta imagens, fórmulas ou layout. O MCP pessoal recuperou
texto de uma página profunda (429) com cobertura completa e proveniência, sem
consultar o Moodle. A UI foi inspecionada visualmente antes/depois. Isso prova
acesso ao texto disponível, não compreensão integral do conteúdo visual. A
recusa de outro dono foi testada com dados sintéticos, não com uma segunda conta
acadêmica real. Detecção automática de novidades segue sem autorização de
agendamento.

Este lote não ativa cron, alerta em tempo real, cadastro público, publicação de
materiais, escrita no Moodle, e-mail ou virada do METD. Novidades só serão
detectadas após consulta/atualização solicitada até haver autorização específica
para frequência recorrente. Não é autorização para raspar outros cursos ou toda
a comunidade acadêmica. Critérios relacionados: A16, A18 e A23 em
[ACEITE.md](ACEITE.md).
