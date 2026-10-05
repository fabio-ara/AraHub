# Matriz de aceite

Atualizada em 2026-10-05. Contrato completo: `.arahub-bootstrap/07-ACEITE-E-TESTES.md` (privado). Esta matriz é um índice público, não substitui as nuances do contrato. Nenhum gate remoto/móvel foi encerrado por configuração, fixture ou viewport.

| ID | Capacidade | Estado local | Prova real / pendência |
|---|---|---|---|
| A01 | Instalação limpa e MCP | Oito migrations em banco SQL novo, RLS/dois donos/retry; cliente SDK HTTP local | Schema aplicado no projeto Free autorizado, hashes conferidos; cache vazio e MCP hospedado pendentes |
| A02 | Isolamento por usuário | SQL/RLS/FKs, busca/exportação/jobs testados | SQL hospedado com dois donos sintéticos/rollback aprovado; cliente Auth/backend/Storage hospedados pendentes |
| A03 | Isolamento por conexão | IDs colidentes e relações cruzadas testados | Segunda instalação/duas contas Google reais pendentes |
| A04 | Segredos em todas as superfícies | Exclusões verificadas; scan índice/histórico e markers no gate | Auditoria pré-publicação futura |
| A05 | Conteúdo hostil e redirects | Sem executor a partir de conteúdo, saídas como dados; fixtures | Parsing PDF/HTML aprofundado pendente |
| A06 | Deltas idempotentes | SQL real, retry e recibo | Cliente hospedado pendente |
| A07 | Memória antes de refresh com falha | Domínio e ferramenta MCP gravam recibo antes do refresh dirigido | Fluxo com fontes/cliente hospedados pendente |
| A08 | Concorrência web/mobile | Transação/lock/version em Postgres testados | Duas superfícies reais pendentes |
| A09 | Preferência contextual e história | Vigência, superação/retirada explícita, prioridade do escopo específico, hipóteses e conflitos sem escolha por recência; SQL + MCP SDK | Preferências legadas exigem revisão; uso em conversa real e tarefa atual pendentes |
| A10 | Recuperação sem chat | Cliente SDK novo recupera evento no HTTP local | Ativação da Skill e conversa real pendentes |
| A11 | Relato de entrega | Dimensões e ambiguidade testadas | Resolução automática de contexto ativo parcial |
| A12 | Falsa confirmação | Completion/nota não provam entrega; rotas perigosas bloqueadas | Mesma política a validar remotamente |
| A13 | Autoria e versão publicada | Regra no domínio, versões migradas preservadas | Comparação de rascunho/post ainda parcial |
| A14 | Reabertura | Estado de disponibilidade independente | Refresh integrado pendente |
| A15 | Fusos e datas vagas | IANA/DST testados; precisão migrada preservada | Interface de planejamento pendente |
| A16 | Moodle real | Adaptador próprio + fixtures | Prova real local de leitura e pequeno arquivo; renovação HTTP/SQL sintética preserva identidade/histórico e respeita desconexão; renovação real/IP remoto pendentes |
| A17 | Outro Moodle | Fixtures de subdiretório/funções faltantes; banco IDs colidentes | Segunda instalação/IFSP não comprovados |
| A18 | Erros/cobertura/cursor | Fixtures e jobs testados; cursor não avança em partial | Orquestração de sync ainda parcial |
| A19 | Google múltiplas contas | OAuth/HTTP persistente, conta verificada, cofre/CAS/epoch, callback tardio e escopos testados | App OAuth/consentimentos/duas contas reais não configurados |
| A20 | Cursores/refresh Google | Biblioteca e fixtures | Tenant e Testing/Production pendentes |
| A21 | Docs/Sheets/Slides nativos | Leitura MCP nativa com abas/grid data; preparação de escrita | OAuth real, produção completa e escrita em área autorizada pendentes |
| A22 | Escrita segura | Máquina de aprovação independente e resultado incerto testada | Autoridade/UI persistente e executor real pendentes |
| A23 | Arquivos úteis | MCP preserva material Moodle qualificado; prova real de um JPEG/binário e isolamento; textos brutos da memória legíveis | PDF/OCR/página e entrega/leitura de material binário pelo cliente pendentes |
| A24 | Pacote AraLearn | Ferramenta MCP ligada a atividade/materiais/direitos, lacunas e leitura declarada testados | Vínculos completos/material real ainda parciais; criação real exige pedido |
| A25 | Migração reproduzível | 57 arquivos brutos, 109 registros curados; staging/import local idempotentes | Delta final/remote autorizado pendentes |
| A26 | Regressão acadêmica | 4 verificações privadas/10 cenários; cliente MCP novo recuperou 109 registros com referências e documento bruto | Qualidade semântica das respostas, Skill/conversa real ainda pendentes |
| A27 | Backup e virada | Staging export/restore; dump restaurado em banco novo, 11 tabelas/binários/RLS/grants conferidos | Backup hospedado, reconciliação final e virada do cliente pendentes |
| A28 | MCP remoto/OAuth | Cliente SDK HTTP local e adaptador do gateway/assinaturas/sessão revogada sintéticos | HTTPS/consentimento remoto real não executados |
| A29 | Celular/web | UI base inspecionada em desktop/viewport móvel; entrada/exportação/saída operadas | QA visual dos novos formulários bloqueado nas capturas; smartphone/app real/nova invocação e delta pendentes |
| A30 | Operação sustentável | Jobs/leases/retries/cobertura implementados | Worker integrado, medição hospedada e cron autorizado pendentes |

Evidência real em `.private/evidence/`; nunca transportar dados pessoais para testes/CI públicos. STATUS e relatório de validação registram comandos e contagens executadas. Requisitos parciais continuam no plano sem redução de escopo.
