# Estado do AraHub

Atualizado em 2026-10-07. Primeira entrega em implementação na branch `entrega-1`.
Backend 0.2.1 e interface publicados; correção 0.2.2 validada localmente, em
implantação. Plugin pessoal 1.1.0 instalado e verificado
em uma conversa nova. **R1 não está concluída**: a ponte completa pelo host
ChatGPT até o Moodle sintético ainda requer homologação.

O contrato vigente está em [docs/ENTREGA-1.md](docs/ENTREGA-1.md), com plano e
aceite reconciliados. O pacote privado foi validado e está excluído do Git.
Os registros anteriores continuam no histórico; dados/evidências ficam privados.

Implementado: importação de arquivos do host com conferência de bytes; preparação,
aprovação humana e execução de ações Moodle; retirada Google operacional com
histórico preservado; DOCX/HTML estruturados e fila local; processamento separado
de vídeo; preferências, obrigações, atenção e histórico por ocorrência; interface
simplificada. Modelos e fontes privadas permanecem fora da distribuição.

Validação da 0.2.1: 211 testes passaram, sem falhas, e dois ignorados possuem gates
próprios. A 0.2.2 passou em 12 testes dirigidos e tipos/Edge; a suíte ampla anterior
não foi repetida. Tipos, Edge, instalação nova com 14 migrations, dois donos e isolamento
passaram. A interface foi interagida e inspecionada em dois viewports com fixtures.
A escala local de 10 mil posts e 100 mil observações/ocorrências teve p95 de 183 ms.
Backup hospedado por leitura foi restaurado localmente, incluindo hashes de 81
arquivos; restauração do provedor Auth não está demonstrada.

No alvo hospedado existente, 32 verificações de Auth/OAuth/SDK passaram. As 14
migrations foram reconciliadas e os dados anteriores permaneceram íntegros. O
plugin instalado expõe 42 ferramentas atuais. A conversa nova recuperou fontes,
trajetória, preferências e diferenças entre rascunhos e publicação relatada, sem
promover relatos a confirmação institucional.

No Moodle Lab real, o SDK MCP enviou arquivo exportado do conector, com declaração
aprovada, e confirmou a submissão e os bytes. Tópico com anexo e resposta também
passaram. A visão do estudante foi conferida por interação e inspeção visual em
aba normal do Chrome. Vinte e dois subcasos negativos passaram. Uma segunda
versão Moodle passou pela cadeia SDK, e duas origens físicas com IDs iguais
foram isoladas em 17 verificações. O reset da segunda instância tem prova própria.
Isso não substitui a ponte pelo arquivo do host no aplicativo ChatGPT instalado.

Materiais institucionais atuais: leitura autorizada, processamento e preservação
local de 19 ocorrências/18 binários distintos; recuperação via MCP e isolamento
verificados. Transcrição automática permanece sem revisão de exatidão. Nenhuma
escrita de teste foi feita na universidade.

Aprovação vem da sessão humana autenticada, vinculada ao conteúdo e ao alvo.
Resultado incerto não é reenviado. Status de assignment continua bloqueado em
produção por efeitos indiretos: validação sintética não altera essa política.
O processador local não é executor remoto nem rotina recorrente ativa.

Próximo passo executável: publicar a 0.2.2 e conferir a memória no cliente real,
integrar o harness e reconciliar a matriz por nível. Topologia de
homologação remota, revisão da rota institucional, processamento remoto e virada
da memória têm gates próprios. Contextos já declarados como testes técnicos ficam
fora da retomada, busca e preferências cotidianas na 0.2.2. Permanecem acessíveis
por consulta explícita, histórico e exportação; nenhum registro foi apagado ou
reclassificado. Títulos e conteúdo não determinam essa separação.

Correções validadas após os testes reais: links dos capítulos HTML conservados
na leitura textual; matrícula suspensa classificada como acesso negado; mudança
de seção com um único vínculo atual e histórico preservado. A atenção distingue
colegas presentes de colegas efetivamente respondidos e sinaliza material que
mudou desde a versão explicitamente vinculada ao rascunho. PDFs retornam escopo
textual, lacunas visuais e inventário limitado de campos, sem afirmar preenchimento.

Checkpoint operacional detalhado: `.private/entrega-1/STATUS.md`.
