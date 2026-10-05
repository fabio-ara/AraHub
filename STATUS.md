# Estado do AraHub

Atualizado: 2026-10-05. Branch: main. Fundação, integrações locais e migração privada implementadas; produto completo e gates externos ainda pendentes.

## Objetivo corrente

Concluir a próxima etapa local guiada por A01–A30 e continuar a implementação após provisionar o projeto Free autorizado. Aplicação, publicação e virada permanecem pendentes.

## Estado comprovado

- Pacote extraído sem sobrescrita; 20 hashes válidos. ZIP, bootstrap, `.private/`, ambientes e credenciais excluídos do Git antes do primeiro commit.
- Plano em `docs/PLANO.md`; auditoria/licenças em `docs/FONTES.md`. Origem e irmão fixados, limpos e somente de leitura. Criação do projeto/schema externos autorizados; fontes continuam somente leitura.
- Postgres exclusivo em `127.0.0.1:55432`; oito migrations aplicadas. RLS/FKs, deltas, concorrência, falha de refresh, jobs e reconciliação testados com dados sintéticos.
- Preferências: vigência, superação/retirada explícita, escopo específico e conflitos sem escolha por recência; SQL e cliente MCP testados. Legados exigem revisão.
- Projeto remoto AraHub Free/São Paulo criado na nova conta autorizada. Oito migrations com hashes conferidos; SQL/RLS sintético com dois donos e rollback aprovado. Zero usuários/contextos após a prova. Alvo privado em `.private/cloud/`. Sem aplicação implantada.
- Cliente MCP SDK por HTTP local: descoberta, assinatura/claims sintéticos, persistência e retomada por cliente novo. Adaptador do prefixo Edge e sessão revogada testados sinteticamente.
- Moodle: renovação de token pela API HTTP e formulário preparada, mesma instalação/conta/IDs; cofre + estado atômicos e epoch impede reativação após disconnect. Prova sintética HTTP/SQL aprovada; UI/conta real de renovação pendentes. Atualização direta da conexão pela Data API foi revogada no local e no alvo remoto.
- Google: start/callback HTTP ligados à sessão e ao cofre, conta verificada, autorização incremental, leituras nativas por MCP e proteção de callback/refresh concorrentes. Somente fixtures de provedor; nenhuma conta real conectada.
- Moodle: transporte DNS/TLS pinado retestado realmente; 16 funções seguras disponíveis. Material JPEG de 52.017 bytes preservado por serviço + cliente SDK; binário sem extração, credencial de prova revogada. Não equivale a PDF lido.
- Migração: 57 arquivos brutos completos e 109 registros curados no banco local; retry sem duplicação. Cliente MCP novo recuperou os 109 com fontes e texto bruto. Dados reais privados; identidade/transporte de prova sintéticos locais.
- Instalação SQL em banco vazio aprovada. Backup restaurado em banco novo: 11 tabelas, 932.555 bytes de dump, binários/RLS/grants conferidos. Destinos privados preservados.
- Plugin/Skill genéricos preparados conforme fontes oficiais; não instalados nem ativados em conversa real.

## Requisitos e evidências

Matriz completa A01–A30 em `docs/ACEITE.md`; código e provas locais disponíveis, com pendências explícitas. Evidências reais em `.private/evidence/`; backups em `.private/backups/`. Não transportar dados para CI ou docs públicos.

## Autorizações e bloqueios

Engenharia, commits e staging locais autorizados. A nova conta e o projeto AraHub Free foram criados com participação humana; schema e testes sintéticos constituem o lote remoto aprovado. Senhas não foram capturadas. O conector Supabase ainda usa a conta anterior: autenticação CLI/conector no novo alvo requer superfície protegida. Importação privada, hospedagem da aplicação, app/consentimentos Google, recorrência e outras escritas externas aguardam aprovação própria. Consulte `docs/IMPLANTACAO.md` e `.private/cloud/target.json`.

QA: UI base desktop e viewport 390×844 inspecionados; entrada/exportação/saída operadas. Novos formulários têm inspeção DOM e ausência de overflow, mas a captura nativa ficou sem retorno e a gravação direta foi recusada pelas raízes da ferramenta; `cua_repl` alternativo falhou ao iniciar o app-server. Revisão visual dos formulários e operação da renovação Moodle pendentes; build/TypeScript não encerram esse gate. Não contornar pela UI nem alterar instalação global. Isto não comprova smartphone/app real.

## Últimos testes

`deno task test`: 125 aprovados/0 falhas. TypeScript raiz/Edge/web, bundle e format check aprovados. Regressão privada A26: 4 aprovados. `validation:clean`, `migration:import` (0 novos/109 reutilizados), `migration:validate` e `backup:local` aprovados. `cloud:prove` confere lote/hashes/recusa de reaplicação e isolamento SQL local; `verify_cloud_sql.sql` passou no Supabase com claims sintéticos, cofre/anon negados e rollback. Não é prova de Auth/MCP real hospedado. Scan Git final e commits constam em `docs/VALIDACAO.md`.

## Próximo passo executável

Ler a matriz e os capítulos 02/03 do bootstrap. Prioridades locais: sincronização de conteúdo/cursores e observações além dos cursos, extração PDF/página e entrega legível, revisão de preferências legadas e uso em conversa real, QA visual/real da renovação Moodle, autoridade humana persistente para produção e roteamento remoto UI/APIs. Executar fatias com provas dirigidas; não reabrir gates válidos sem mudança relevante.

## Retomada

Não há transação externa incerta nem cron ativado. O schema remoto já está instalado: não reaplicar `.private/cloud/schema.sql`; reconciliar pelo histórico/hashes antes de qualquer atualização. Containers e bancos locais de prova/restore são exclusivos do AraHub e foram preservados; reiniciar a UI pelos comandos do README. A demo sintética usa outro dono e não acessa a importação privada; o dono local da importação está em `.private/local-owner.json`. Fontes METD/staging/curadoria/checks privados permanecem disponíveis. Este checkpoint substitui o histórico do chat.
