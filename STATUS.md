# Estado do AraHub

## Correção de continuidade acadêmica — 2026-10-13

Backend/plugin fonte 0.2.9 concluído e validado localmente na branch
`fix/academic-memory-continuity`; **não implantado**. A versão pessoal publicada
abaixo permanece inalterada. Contrato e diagnóstico:
[acontecimentos acadêmicos](docs/ACONTECIMENTOS-ACADEMICOS.md).

Implementados `hub_record_event` (relato imediato, resolução/vínculo/contexto,
idempotência e correções transacionais), preservação das consultas Moodle no
grafo existente, reconciliação de publicação/respostas/status individual e
resumo de atenção por resultados. Skill prioriza gravar antes de consultar
fontes. Sem captura passiva, migration, dependência nova, alteração de UI,
escrita acadêmica externa ou Calendar. Consentimento de status próprio permanece
obrigatório; recorrência e notificações continuam inativas.

Validação: `deno task db:setup`, `deno task check` e `deno task edge:check` passaram.
`deno task test` percorreu a regressão completa: 277 aprovados, uma fixture nova
incoerente corrigida e dois testes opcionais de ASR ignorados como antes. A
fixture usava o ID do titular numa discussão que pretendia representar outro
aluno; o sistema reconheceu corretamente a publicação. A reexecução dirigida de
`summary compacta` e `B/C/D/E` passou. `academic_mcp_test.ts` passou com três
testes, incluindo o caso adicional de consultas A→B→A e mudanças de
prazo/orientação/feedback. Resultado consolidado: **279 casos aprovados, nenhuma
falha pendente e dois ignorados fora do escopo**; não se repetiu o gate caro após
uma correção apenas de fixture. A revisão final acrescentou a divergência entre
recibo histórico e status nativo `reopened`; os cinco testes de `attention_test.ts`
passaram novamente, incluindo esse caso. Formatação e revisão de diff conferidas.
O gate Git examinou 240 arquivos no índice sem achados de credenciais/caminhos
privados; os acréscimos finais de teste usam somente valores sintéticos.

As provas usam contas sintéticas, PostgreSQL local e cliente MCP SDK por HTTP,
incluindo nova sessão de cliente. Fonte Moodle controlada não equivale à
universidade nem à prova hospedada. Nenhum dado acadêmico real foi alterado; o
Docker/banco local exclusivo foi iniciado para a validação. Não houve navegador.

Próximo passo executável, após autorização de disponibilização: publicar a função
principal, atualizar a descoberta do app existente e sua skill; não exige cron.

## Instância pessoal publicada (histórico preservado)

Atualizado em 2026-10-08. **Versão 0.2.8 liberada para uso pessoal cotidiano.** Backend e plugin pessoal 1.1.4 publicados. Contrato: [docs/ENTREGA-1.md](docs/ENTREGA-1.md).

Biblioteca simples publicada com 52 originais acadêmicos na conta real: abrir formatos compatíveis, baixar, ações à direita e paginação automática. Retirados Preferências, controles de extração, botão “Mais PDFs” e histórico de operações aposentadas/terminais; memória, fontes e versões permanecem preservadas. Arquivos técnicos do antigo repositório e snapshots Google continuam na memória, fora da biblioteca. A revisão acadêmica aparece quando há intenção pendente ou resultado incerto.

Backend Edge35 ativo e Pages publicados a partir de `27b2305` (workflow `37811049634`). Sete assets conferidos por SHA-256; URLs de JS/CSS versionadas corrigem a mistura de página nova com bundle antigo em cache, sem alterar preferências do navegador. Chrome normal autenticado confirmou a biblioteca, 20→40 itens pela rolagem, alinhamento dos controles, geometria de 460×903 e Privacidade em tema escuro. A API hospedada listou as três páginas e transferiu um PDF real de 1.829.116 bytes em duas partes, com hash integral confirmado. Nenhum download foi iniciado pela automação da interface e não houve consulta ou escrita na universidade nesta correção.

Validação local: 17 testes dirigidos (biblioteca/transferência, revisão de ações e pacote Pages), tipos e dois roteiros de navegador com dois viewports cada. O gate Git conferiu 235 arquivos com zero achados; os ajustes posteriores de cache e seleção de materiais tiveram revisão dirigida. Sem migration, nova credencial, mudança de plano ou mutação dos dados privados. Uso dos botões de abrir/baixar no navegador não foi automatizado; a transferência foi verificada diretamente pela API.

Correção visual anterior solicitada pelo titular: removidos cartões de configuração e textos de bastidor; botões só com ícones e nomes acessíveis; telas próprias para Moodle/PDFs; geometria comum e tema persistente também em Privacidade. Validação local: 11 testes dirigidos e os dois roteiros de navegador em desktop/viewport móvel, incluindo aprovações, PDF, consentimento, retorno e recarga em tema escuro. Interface publicada pelo Pages a partir de `4d991fe`, com sete assets conferidos por SHA-256. Na conta real, o Chrome normal confirmou sessão preservada, troca de telas, títulos alinhados e Privacidade em tema escuro após retorno e recarga. Backend e dados inalterados.

O titular definiu o uso real em produção como a próxima etapa de validação. Não há impedimento conhecido nem nova instalação, aprovação geral ou rodada de simulação necessária para começar a usar a versão publicada. A leitura autenticada da memória foi reconfirmada pelo conector pessoal, recuperando as quatro versões esperadas. As provas existentes de laboratório, ChatGPT, interface e recuperação permanecem válidas; falhas concretas no uso orientarão as correções. Aprovações de publicações e entregas acadêmicas continuam específicas à ação. Acompanhamento e processamento automático de novos vídeos fora da conversa permanecem inativos; a R1 integral continua aberta, sem bloquear esta versão cotidiana.

Após o pedido de publicação imediata, backend 0.2.7 e migration 16 foram implantados na instância existente, sem alterar plano, conta, conexão ou interface. Função principal ativa, saúde HTTP 200, MCP sem autenticação recusado com 401 e conector pessoal real recuperando as quatro versões de um material. As 12 tabelas do titular permaneceram iguais durante a implantação. A entrega utilizável não depende do cron.

Engenharia do acompanhamento hospedado preparada: autorização privada, janelas com fuso, limites por curso/tentativa, admissão de escrita, transporte HTTPS com IP fixado, saúde e pausa no MCP. A função executora separada e o cron não foram implantados/ativados; a tabela de autorizações está vazia. Provas locais e Moodle Lab não substituem validação do runtime hospedado nem disparo real pelo relógio. Essa frente permanece explicitamente fora da entrega cotidiana atual.

Nesta frente passaram 30 testes dirigidos e a regressão de 60 testes (há sobreposição), tipos e advisors locais. Backup/restore local com 17 tabelas, inclusive a nova autorização, comparou dados, hashes reais dos binários, RLS e grants. O verificador foi corrigido para volumes maiores e o dump foi transferido diretamente pelo PostgreSQL enquanto o CLI Docker estava indisponível; nenhum serviço precisou ser reiniciado. Isso não substitui a prova hospedada após implantação.

Os três lotes autorizados estão executados: homologação nativa no Moodle Lab, importação privada dos materiais atuais e transição do METD para o AraHub como memória cotidiana principal. Git permanece como história e recuperação. Nenhum teste mutável foi feito na universidade.

A ponte ChatGPT/Google → AraHub → Moodle Lab passou com arquivos reais, bytes, nomes e hashes, OAuth real e estudante sintético. Fórum com anexo, resposta ao post escolhido e entrega final tiveram recibos, conferência independente e inspeção visual no Chrome normal. Aprovação vencida é recusada; revisão autenticada pode autorizar novamente uma versão ainda válida. Resultados incertos e aprovações consumidas impedem reenvio automático. Recursos temporários da homologação foram encerrados.

Os 19 materiais autorizados (18 binários) estão na conta privada com origem, versões, hashes e representações. O ChatGPT pessoal recuperou DOCX, HTML, localizadores e transcrição parcial do vídeo, explicitando lacunas e erros de ASR. Uma rota até fórum institucional foi confirmada por leitura, incluindo atividade acessível oculta no menu e deeplink. As integrações Google próprias foram retiradas, preservando snapshots históricos.

A reconciliação METD preservou 63 versões de 58 caminhos e 109 registros curados. Instruções e apontador do Projeto foram atualizados; o anexo anterior permanece como histórico. Dois chats e um conector independente comprovaram recuperação de memória e persistência idempotente de uma ocorrência técnica.

A consulta das próprias entregas individuais foi autorizada pelo titular, publicada e verificada no cliente ChatGPT contra a ULisboa. Recibo autenticado vincula conta, conexão, época e política. A resposta real indicou estado `new`, sem arquivos enviados; não houve submissão acadêmica. Os efeitos técnicos incidentais auditados foram aceitos, sem alegar ausência de efeitos internos. Acesso alheio, notas, grupos e operações gerais bloqueadas continuam recusados. Renovação/revogação invalidam a autorização anterior.

Recuperação corrente: snapshot atualizado antes do deploy, incluindo duas entradas novas de memória, 117 binários, 12 tabelas públicas, um recibo privado de consentimento e o cofre restaurados. Esse banco verificado foi clonado para outro destino exclusivo e recebeu a migration 16; dados do titular e controles da nova tabela privada coincidiram com produção. Inclui as quatro versões audiovisuais. Hashes, sequência, estabilidade da origem e isolamento de dois donos verificados. Auth gerenciado não foi restaurado.

Áudio deve atender português de Portugal, tempo/RAM viáveis e custo adicional zero. A ponte privada AraHub → Work transferiu um vídeo real em partes, com hash completo conferido. A primeira transferência truncada foi recusada; a correção está publicada. O cliente executou `large-v3` completo otimizado em INT8 e analisou quadros distribuídos pela duração. Transcrição bruta, observação visual, síntese e revisão com detecção de fala foram persistidas e recuperadas por conector independente e nova conversa do Projeto METD. A revisão eliminou um segmento suspeito sem apagar o bruto ou mudar a síntese acadêmica. A Skill instalada incorpora a configuração exercitada, reutilização e limites; outra conversa nova confirmou sua leitura. Isso não certifica exatidão PT-PT nem escuta independente.

Validação anterior preservada: 230 testes aprovados, zero falhas e dois ignorados; gates de aprovação, SQL, web e instalação passaram. A política de status próprio acrescentou nove testes específicos e quatro de ações aprovados, além da prova visual no Lab e consulta institucional. A transferência acrescentou cinco testes com SQL real e seis regressões MCP/Edge/plugin; tipos passaram. O histórico de ASR local tem teste de preservação, repetição idempotente e recusa de corrupção. Evidências distinguem fixture, SDK local, Moodle Lab, ChatGPT e ULisboa.

Matriz: **66/66 nos níveis declarados**. Processamento hospedado durante conversa foi demonstrado com um vídeo real; recorrência não está ativa. Uso em aparelho móvel físico e restauração do Auth gerenciado não foram demonstrados. Execução em conversa não comprova agendamento, disponibilidade ilimitada ou comportamento após fechar o cliente. Nenhum recurso pago está autorizado.

ZIP, pacote, credenciais e evidências continuam fora do Git. A regra geral proíbe downloads pela UI e alterações de preferências para contornar a restrição. Capturas usam retorno nativo; arquivos usam conectores/APIs. Checkpoint privado: `.private/entrega-1/STATUS.md`. Próximo passo de produto: uso cotidiano no ChatGPT com consultas atuais quando solicitadas e correção de falhas observadas. O acompanhamento recorrente hospedado permanece frente separada, com escopo finito e ativação especificamente autorizada; a prova local não substitui essa integração.
