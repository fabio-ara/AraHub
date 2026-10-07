# Plano executável

Mandato de 2026-10-05. O pacote privado foi verificado (20 hashes). Consultar a especificação da etapa em `.arahub-bootstrap/`; o pacote e dados pessoais não são distribuídos.

Em 2026-10-06, o titular dispensou o gate de celular físico e esclareceu o produto:
acesso amplo ao Moodle pelo MCP (cursos, materiais, PDFs, fóruns e novidades) e
memória privada organizada do METD para retomada e análise interpretativa. O
GitHub público distribui o código e o Pages hospeda a configuração; nenhum deles
é a memória operacional. Gmail, Google Drive e Google Calendar oficiais continuam
sendo o caminho principal para essas fontes, inclusive produção e formatação de
documentos. O adaptador Google
próprio já entregue conserva provas e pode servir à proveniência entre fontes,
mas não deve ser apresentado como editor superior ou ampliado para duplicar o
plugin oficial sem ganho concreto demonstrado. Os itens abaixo registram o
mandato original e suas provas; a matriz A01–A30 continua explícita.

Próxima sequência: conectar a conta Moodle do titular na instância hospedada
com credencial inserida somente na interface protegida; comprovar cursos,
conteúdo, fóruns/postagens e PDF no cliente pessoal; medir cobertura e atrasos.
Hoje a sincronização é dirigida, sem cron. Detectar postagens novas ao solicitar
atualização é viável; acompanhamento automático com latência definida exige
política de consultas, cotas e autorização específica para agendamento. O serviço
Web Moodle de cada instalação pode omitir funções ou conteúdo; registrar lacunas
em vez de afirmar acesso integral. Identidades de curso/módulo precisam sobreviver
a renomeações e mudanças de seção; observações antigas devem permanecer legíveis,
mas a visão da estrutura atual não pode tratar vínculos antigos como ativos.
Análises interpretativas usam fontes e contexto recuperados, distinguindo fato,
inferência e lacuna; o MCP não grava toda a conversa automaticamente. Depois,
reconciliar memória importada com
referências Moodle e concluir a virada do METD apenas com sua autorização.

1. Fundação: TypeScript/Deno, Postgres compatível com Supabase, identidade autenticada, conexões qualificadas, RLS e referências por proprietário. Prova vertical MCP → delta transacional → contexto, com dois usuários sintéticos.
2. Viabilidade: conferir Auth OAuth do Supabase e SDK MCP atuais; preparar discovery, verificação de tokens e consentimento. Nenhuma criação remota sem alvo/custo/autorização.
3. Adaptadores: Moodle generalizado com interseção da allowlist auditada e capacidades da instalação; Google próprio com OAuth incremental, múltiplas contas e cursores. Escritas exigem aprovação por superfície confiável.
4. Memória: contexto de trabalho, eventos/proveniência, revisões concorrentes, preferências contextuais, reconciliação por dimensões e datas IANA. Busca textual antes de vetores.
5. Migração: snapshot privado fixado, inventário/hashes, preservação bruta, curadoria com trechos, staging retomável, regressões semânticas e restore. A origem permanece somente leitura.
6. Produto: interface auxiliar mínima para acesso/conexões/consentimento e revisão, com design MIT do AraLearn reproduzido, coluna até 430 px em todas as telas e botões somente com ícones/nome acessível. GitHub Pages hospeda os arquivos públicos; Supabase fornece Auth/banco/API. Arquivos/pacotes de estudo, jobs/freshness e Skill/plugin conforme formato oficial continuam no escopo completo.
7. Gate externo: aprovar projeto separado, OAuth/contas/escopos; validar isolamento hospedado antes de importação; testar MCP real e novas invocações mobile/web; reconciliação final e virada reversível.

Critério de encerramento da auditoria inicial: versões/estado das fontes fixados, limites/licenças identificados e contratos suficientes para a prova vertical. Incertezas de conta são bloqueios, não hipóteses aprovadas.

Não abreviar A01–A30: `docs/ACEITE.md` mantém a matriz. Código, sintéticos, contas reais e implantação têm estados separados. Checkpoints substituem diário acumulado.
