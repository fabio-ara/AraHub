# Matriz de aceite

Atualizada em 2026-10-05. Contrato completo: `.arahub-bootstrap/07-ACEITE-E-TESTES.md` (privado). Esta matriz é um índice público, não substitui as nuances do contrato. Nenhum gate remoto/móvel foi encerrado por configuração, fixture ou viewport.

| ID | Capacidade | Estado local | Prova real / pendência |
|---|---|---|---|
| A01 | Instalação limpa e MCP | Dependências exatas, migrations/cliente HTTP local; prova de instalação em ambiente vazio ainda a consolidar | Hospedado pendente |
| A02 | Isolamento por usuário | SQL/RLS/FKs, busca/exportação/jobs testados | Revisão de backend privilegiado/Storage hospedado pendente |
| A03 | Isolamento por conexão | IDs colidentes e relações cruzadas testados | Segunda instalação/duas contas Google reais pendentes |
| A04 | Segredos em todas as superfícies | Exclusões verificadas; scan índice/histórico e markers no gate | Auditoria pré-publicação futura |
| A05 | Conteúdo hostil e redirects | Sem executor a partir de conteúdo, saídas como dados; fixtures | Parsing PDF/HTML aprofundado pendente |
| A06 | Deltas idempotentes | SQL real, retry e recibo | Cliente hospedado pendente |
| A07 | Memória antes de refresh com falha | Testado no domínio | Integrar refresh real persistente |
| A08 | Concorrência web/mobile | Transação/lock/version em Postgres testados | Duas superfícies reais pendentes |
| A09 | Preferência contextual e história | Filtro por escopo, eventos preservados | Precedência/superação explícita ainda parcial |
| A10 | Recuperação sem chat | Cliente SDK novo recupera evento no HTTP local | Ativação da Skill e conversa real pendentes |
| A11 | Relato de entrega | Dimensões e ambiguidade testadas | Resolução automática de contexto ativo parcial |
| A12 | Falsa confirmação | Completion/nota não provam entrega; rotas perigosas bloqueadas | Mesma política a validar remotamente |
| A13 | Autoria e versão publicada | Regra no domínio, versões migradas preservadas | Comparação de rascunho/post ainda parcial |
| A14 | Reabertura | Estado de disponibilidade independente | Refresh integrado pendente |
| A15 | Fusos e datas vagas | IANA/DST testados; precisão migrada preservada | Interface de planejamento pendente |
| A16 | Moodle real | Adaptador próprio + fixtures | Prova real local de leitura e pequeno arquivo; IP remoto não testado |
| A17 | Outro Moodle | Fixtures de subdiretório/funções faltantes; banco IDs colidentes | Segunda instalação/IFSP não comprovados |
| A18 | Erros/cobertura/cursor | Fixtures e jobs testados; cursor não avança em partial | Orquestração de sync ainda parcial |
| A19 | Google múltiplas contas | Biblioteca OAuth, vinculação/CAS/vault e testes sintéticos | App OAuth/consentimentos não configurados |
| A20 | Cursores/refresh Google | Biblioteca e fixtures | Tenant e Testing/Production pendentes |
| A21 | Docs/Sheets/Slides nativos | JSON nativo e preparação de escrita | OAuth real e escrita em área autorizada pendentes |
| A22 | Escrita segura | Máquina de aprovação independente e resultado incerto testada | Autoridade/UI persistente e executor real pendentes |
| A23 | Arquivos úteis | Binário/texto separados no banco; material Moodle baixado | PDF/página e leitura pelo cliente ainda pendentes |
| A24 | Pacote AraLearn | Contrato/rights/leitura declarada testados | Ferramenta MCP/pacote material integrado ainda parcial; criação real exige pedido |
| A25 | Migração reproduzível | 57 arquivos brutos, 109 registros curados; staging/import local idempotentes | Delta final/remote autorizado pendentes |
| A26 | Regressão acadêmica | 4 verificações privadas de fontes/nuances, 10 cenários de recuperação | Recuperação completa no MCP privado ainda a consolidar |
| A27 | Backup e virada | Staging export/restore verificados | Restore banco/binários e virada do cliente ainda pendentes |
| A28 | MCP remoto/OAuth | Cliente SDK HTTP local + assinatura/claims sintéticos | HTTPS/consentimento remoto real não executados |
| A29 | Celular/web | UI inspecionada e usada em desktop e viewport móvel | Smartphone/app real/nova invocação e delta pendentes |
| A30 | Operação sustentável | Jobs/leases/retries/cobertura implementados | Worker integrado, medição hospedada e cron autorizado pendentes |

Evidência real em `.private/evidence/`; nunca transportar dados pessoais para testes/CI públicos. STATUS e relatório de validação registram comandos e contagens executadas. Requisitos parciais continuam no plano sem redução de escopo.
