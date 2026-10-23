# Operação e recuperação

Operar o AraHub significa manter identidade, dados e serviço utilizáveis e saber
recuperá-los. Um backend responder HTTP 200 é um sinal de saúde do endpoint; não
prova sozinho que login, banco, fontes e processamento funcionam.

## O aviso de pausa da Supabase

No plano Free, atividade insuficiente durante uma janela de sete dias pode levar
à pausa. Um aviso informa uma possibilidade futura; o estado atual deve ser
conferido no projeto. Esse mecanismo considera atividade do serviço e não equivale
a falta de espaço. Reduzir arquivos duplicados é útil, mas não elimina a política
de inatividade. [Supabase: pausa de projetos](https://supabase.com/docs/guides/platform/free-project-pausing).

Há uma diferença relevante entre comunicações: a documentação consultada em
22/10/2026 informa uma janela de restauração de um ano, enquanto o aviso recebido
na instalação inicial informava 90 dias. Para uma ocorrência concreta, confira o
prazo apresentado no painel e no aviso do projeto, adote o menor prazo enquanto
houver dúvida e não dependa dessa janela como seu único backup.

O uso real pode gerar atividade suficiente, mas não há promessa de funcionamento
contínuo no Free. Um plano pago elimina a pausa por inatividade segundo a
documentação do provedor; contratação é uma decisão de custo da organização.
O AraHub não instala um cron de requisições artificiais para manter o projeto
ativo e não muda o plano automaticamente.

## Se o projeto estiver ativo

Confira a URL da interface, `/health` e `/api/config` do backend. Teste uma entrada
autenticada e uma consulta de memória. Se só a interface abrir, ela pode estar
sendo servida pelo GitHub Pages enquanto o backend está indisponível. O cliente
deve exibir essa falha; não deve inventar uma conta vazia ou uma consulta concluída.

Faça uma cópia de recuperação atual e verifique seu conteúdo antes de mudanças
de estrutura. Registre versão do código, migrations aplicadas, configuração
necessária e estado dos serviços, sem publicar dados pessoais.

## Se o projeto estiver pausado

Entre no painel Supabase da conta correta, selecione o projeto e use a operação
de retomada oferecida pelo provedor. A retomada depende da janela de recuperação
e das condições da plataforma. Depois confira estado, banco, função, Auth,
callback, sessão e leitura de arquivos. Não trate a mera abertura do painel como
prova de recuperação integral.

Se a retomada já não estiver disponível, siga o caminho de obtenção de dados e
recriação oferecido pelo provedor, usando também suas cópias independentes.
Não apague o projeto antigo enquanto não houver recuperação verificada. URLs e
chaves de uma instalação nova podem mudar, exigindo reconfigurar interface e
clientes MCP.

## O que uma cópia de recuperação precisa conter

| Componente | Por que é necessário |
| --- | --- |
| Código e migrations | Recriar a mesma estrutura e interpretar os dados. |
| Tabelas de memória e relações | Preservar histórico, versões e vínculos acadêmicos. |
| Binários e objetos deduplicados | Restituir arquivos, não apenas seus nomes e hashes. |
| Políticas, grants e sequências | Reestabelecer isolamento e continuidade das gravações. |
| Cofre cifrado e chave correspondente | Recuperar conexões; guardar em locais protegidos distintos quando apropriado. |
| Configuração de identidade e implantação | Restabelecer emissor, clientes, callbacks, SMTP e URLs. |
| Identidade gerenciada | Exige procedimento específico do provedor, separado da fixture Auth local. |

O script `deno task backup:local` verifica backup e restore no banco local
exclusivo, incluindo hashes e políticas. Ele não faz automaticamente backup da
instância hospedada. O roteiro de produção deve identificar seu alvo, obter os
dados por canal autorizado e verificar a restauração em destino separado.

Exportação de memória pela interface não substitui esse conjunto. Um relatório
de teste local também não comprova restauração do Auth gerenciado, das sessões ou
da entrega de e-mails.

## Atualização segura

1. Confirme Git, alvo, versão remota e ausência de mudanças concorrentes relevantes.
2. Gere backup e verifique restauração antes de alterar dados úteis.
3. Execute tipos, testes afetados e os gates necessários ao risco.
4. Aplique migrations na ordem prevista e publique o backend e os assets.
5. Verifique saúde, recusa anônima, identidade real, cliente MCP e arquivos.
6. Compare os dados preservados e registre o resultado com suas limitações.

O empacotamento Pages inclui hashes nos URLs de JavaScript e CSS para evitar
mistura de assets em cache. A publicação não exige mudar preferências globais do
navegador. `prepare_cloud_update.ts` confere se o registro remoto é prefixo exato
das migrations locais antes de preparar a atualização incremental.

## Recuperação após deduplicação

A versão que lê objetos deduplicados precisa permanecer compatível com os dados.
Para retornar a um código anterior que lê apenas `hub_files.binary_content`,
primeiro recupere esses bytes a partir da view ou restaure o snapshot compatível.
Valide hashes e metadados antes de trocar o backend. Os objetos só podem ser
retirados depois de todas as referências terem sido recuperadas e verificadas.

A abordagem preferida para uma falha pequena é corrigir o leitor mantendo os
dados íntegros. Uma restauração integral pode perder gravações posteriores ao
backup; esse efeito precisa ser avaliado, não escondido como rollback automático.

## Diagnóstico por camada

| Sintoma | Camada a investigar |
| --- | --- |
| Página abre, mas acesso não carrega | API base, rede, Edge Function, pausa e CORS. |
| Link de entrada não chega | Auth, SMTP, remetente, limite e cadastro permitido. |
| Sessão existe, mas API retorna 401 | Emissor, assinatura, audiência, sessão revogada ou cliente MCP não autorizado. |
| AraHub não aparece no ChatGPT | Conta/workspace, cadastro pessoal, instalação e conexão; siga o [diagnóstico do cliente](INSTALAR-MCP-SEM-CODEX.md#se-o-arahub-não-aparecer-no-chatgpt). |
| Arquivo aparece sem bytes | Referência, view, objeto, tamanho e hash; não marcar como íntegro sem conferir. |
| Apenas uma conexão Moodle falha | Credencial, identidade, origem e capacidades da instituição. |
| Ação externa ficou incerta | Resultado na fonte e recibo; não repetir antes da reconciliação. |
| Docker informa falta de recursos WSL | Disponibilidade do banco local e recursos do host; esse erro não prova falha da instância remota. |

Ao encerrar a investigação, registre a causa sustentada pela evidência ou a
limitação que impede distingui-la, o teste que faltou e o próximo passo executável.
Não mantenha um diário infinito como substituto de um checkpoint corrente.
