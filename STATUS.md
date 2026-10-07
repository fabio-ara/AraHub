# Estado do AraHub

Atualizado em 2026-10-07. Primeira entrega em implementação na branch `entrega-1`. Backend 0.2.2
publicado e ferramentas atualizadas no ChatGPT. A memória foi conferida em conversa nova. Plugin
1.1.1 preparado; o instrumento de upload recusou a pasta deste checkout. O refresh preservou a
conexão e a Skill anterior, mas regenerou os metadados como 1.0.0; resta instalar e conferir o
pacote novo. **R1 não está concluída**: a ponte completa pelo host ChatGPT até o Moodle sintético
ainda requer homologação.

O contrato vigente está em [docs/ENTREGA-1.md](docs/ENTREGA-1.md), com plano e aceite reconciliados.
O pacote privado foi validado e está excluído do Git. Os registros anteriores continuam no
histórico; dados/evidências ficam privados.

Implementado: importação de arquivos do host com conferência de bytes; preparação, aprovação humana
e execução de ações Moodle; retirada Google operacional com histórico preservado; DOCX/HTML
estruturados e fila local; processamento separado de vídeo; preferências, obrigações, atenção e
histórico por ocorrência; interface simplificada. Modelos e fontes privadas permanecem fora da
distribuição.

Validação do código corrente: 230 testes passaram, sem falhas, em 2m56s; dois ignorados possuem
gates próprios. Tipos e Edge passaram. A suíte inclui a memória 0.2.2, o harness de identidade e
as políticas locais de acompanhamento. Instalação nova com 14 migrations, dois donos e isolamento
passaram. A interface foi
interagida e inspecionada em dois viewports com fixtures. A escala local de 10 mil posts e 100 mil
observações/ocorrências teve p95 de 183 ms. O backup hospedado corrente, obtido por leitura, foi
restaurado em outra base local: 14 migrations, 12 tabelas, 81 hashes binários e RLS com dois donos.
Cofre e configuração foram recuperados localmente sem gravar segredos em texto aberto; restauração
do provedor Auth não está demonstrada.

No alvo hospedado existente, 32 verificações de Auth/OAuth/SDK passaram na 0.2.1. As 14 migrations
foram reconciliadas e os dados anteriores permaneceram íntegros. O plugin instalado expõe 42
ferramentas atuais. A conversa nova recuperou fontes, trajetória, preferências e diferenças entre
rascunhos e publicação relatada, sem promover relatos a confirmação institucional. Na 0.2.2, nova
conversa e chamadas reais do conector confirmaram nove contextos pessoais e recuperação explícita
dos dois testes preservados. Treze consultas SQL somente leitura reconfirmaram 14 migrations, 11
tabelas do titular inalteradas e 419 conteúdos/ocorrências.

No Moodle Lab real, o SDK MCP enviou arquivo exportado do conector, com declaração aprovada, e
confirmou a submissão e os bytes. Tópico com anexo e resposta também passaram. A visão do estudante
foi conferida por interação e inspeção visual em aba normal do Chrome. Vinte e dois subcasos
negativos passaram. Uma segunda versão Moodle passou pela cadeia SDK, e duas origens físicas com IDs
iguais foram isoladas em 17 verificações. O reset da segunda instância exigiu recuperação dos
helpers residuais; recibos preservam a primeira falha e a remoção final conferida, sem afetar o Lab
original ou remover serviços vizinhos. A correção do controlador passou nas guardas dirigidas.
A segunda instância foi depois reprovisionada: health, leitura como estudante e 11 verificações
da fixture passaram, sem submissões antigas. A reconstrução precisou tratar respostas perdidas
do Docker por inspeção do efeito; não comprova um `up` único desassistido. Isso não substitui a
ponte pelo arquivo do host no aplicativo ChatGPT instalado.

Quizzes sintéticos passaram em 31 verificações REST com estudante: descoberta sem tentativa,
início explícito, salvamento, reconexão, finalização e timeout. Serviço e tokens temporários foram
removidos; tentativas ficaram como evidência. Isso não habilita avaliações pelo AraHub em produção.

Acompanhamento local ganhou política durável por dono/origem/curso, reservas, pausa e retomada do
mesmo job. Dezesseis verificações no Moodle Lab incluíram processos distintos, avanço do checkpoint
e encerramento por prazo. A revisão encontrou e corrigiu a queda entre conclusão do job e registro
do resultado na política; três regressões SQL cobrem a recuperação. O CLI é finito, exclusivo do
Lab, sem cron, despachante hospedado ou notificações ativos.

Materiais institucionais atuais: leitura autorizada, processamento e preservação local de 19
ocorrências/18 binários distintos; recuperação via MCP e isolamento verificados. Comparação de
fichas, vídeo sintético acima de 20 MiB e exportações DOCX/PDF/PPTX tiveram provas próprias; cinco
arquivos/seis páginas ou slides foram inspecionados visualmente. Transcrição automática permanece
sem revisão de exatidão. Nenhuma escrita de teste foi feita na universidade.

Aprovação vem da sessão humana autenticada, vinculada ao conteúdo e ao alvo. Resultado incerto não é
reenviado. Status de assignment continua bloqueado em produção por efeitos indiretos: validação
sintética não altera essa política. O processador local não é executor remoto nem rotina recorrente
ativa.

Código do harness de identidade nativa publicado, sem exigir nova credencial direta de banco;
a autenticação desse novo alvo pelo ChatGPT ainda depende da homologação.
A prévia de virada tem executor privado desativado, recuperação atualizada e configuração real do
Projeto inspecionada; autorização específica foi solicitada. A importação adicional de materiais
tem transporte em partes implementado e desativado, após uma prova somente leitura revelar
recusa do corpo monolítico. O executor passou em 17 grupos locais contra PostgreSQL real, com
recuperação após resposta perdida e revisão independente sem achados materiais. O caminho
monolítico foi retirado da operação, com fontes e recibos preservados. Isso não constitui uma
importação hospedada. Próximo passo executável: instalar o plugin quando a pasta AraHub for
autorizada no instrumento e executar os lotes que receberem autorização, com preflight atual.
Topologia de homologação remota,
revisão da rota institucional, processamento remoto e virada da memória têm gates próprios.
Contextos já declarados como testes técnicos ficam fora da retomada, busca e preferências cotidianas
na 0.2.2. Permanecem acessíveis por consulta explícita, histórico e exportação; nenhum registro foi
apagado ou reclassificado. Títulos e conteúdo não determinam essa separação.

Correções validadas após os testes reais: links dos capítulos HTML conservados na leitura textual;
matrícula suspensa classificada como acesso negado; mudança de seção com um único vínculo atual e
histórico preservado. A atenção distingue colegas presentes de colegas efetivamente respondidos e
sinaliza material que mudou desde a versão explicitamente vinculada ao rascunho. PDFs retornam
escopo textual, lacunas visuais e inventário limitado de campos, sem afirmar preenchimento.

Matriz corrente: 57 cenários aprovados de 66; nove critérios P0 permanecem sem fechamento.
Cinco pedidos humanos foram enviados e aguardam resposta. Checkpoint operacional detalhado:
`.private/entrega-1/STATUS.md`; decisões: `.private/entrega-1/PENDENCIAS-HUMANAS.md`.
