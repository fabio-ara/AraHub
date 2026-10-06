# Matriz de aceite

Atualizada em 2026-10-05. Contrato completo: `.arahub-bootstrap/07-ACEITE-E-TESTES.md` (privado). Esta matriz é um índice público, não substitui as nuances do contrato. Nenhum gate remoto/móvel foi encerrado por configuração, fixture ou viewport.

| ID | Capacidade | Estado local | Prova real / pendência |
|---|---|---|---|
| A01 | Instalação limpa e MCP | Dez migrations em banco SQL novo, RLS/dois donos/retry; cliente SDK HTTP local | Oito migrations hospedadas no projeto Free autorizado, hashes conferidos; atualizações/cache vazio e MCP hospedado pendentes |
| A02 | Isolamento por usuário | SQL/RLS/FKs, busca/exportação/jobs testados | SQL hospedado com dois donos sintéticos/rollback aprovado; cliente Auth/backend/Storage hospedados pendentes |
| A03 | Isolamento por conexão | IDs colidentes e relações cruzadas testados | Segunda instalação/duas contas Google reais pendentes |
| A04 | Segredos em todas as superfícies | Exclusões verificadas; scan índice/histórico e markers no gate | Auditoria pré-publicação futura |
| A05 | Conteúdo hostil e redirects | Rede limitada, saídas como dados; PDF em worker terminável/limites e script hostil sem execução; HTML como texto | Runtime hospedado/provedores reais pendentes |
| A06 | Deltas idempotentes | SQL real, retry e recibo | Cliente hospedado pendente |
| A07 | Memória antes de refresh com falha | Domínio e ferramenta MCP gravam recibo antes do refresh dirigido | Fluxo com fontes/cliente hospedados pendente |
| A08 | Concorrência web/mobile | Transação/lock/version em Postgres testados | Duas superfícies reais pendentes |
| A09 | Preferência contextual e história | Vigência, superação/retirada explícita, prioridade do escopo específico, hipóteses e conflitos sem escolha por recência; SQL + MCP SDK; milissegundos das datas SQL preservados e testados | Preferências legadas exigem revisão; uso em conversa real e tarefa atual pendentes |
| A10 | Recuperação sem chat | Cliente SDK novo recupera evento no HTTP local | Ativação da Skill e conversa real pendentes |
| A11 | Relato de entrega | Alvos ativos por contexto, ambiguidade/versionamento/relato idempotente; SQL real sem falsa confirmação | Uso em conversa real/cliente hospedado pendente |
| A12 | Falsa confirmação | Completion/nota não provam entrega; rotas perigosas bloqueadas | Mesma política a validar remotamente |
| A13 | Autoria e versão publicada | Comparação por rascunho explícito/observação Moodle qualificada, autoria/cobertura e diferenças testadas em SQL | Comparação em conta real/HTML ainda precisa de prova específica; não presume equivalência semântica |
| A14 | Reabertura | Estado de disponibilidade independente | Refresh integrado pendente |
| A15 | Fusos e datas vagas | IANA/DST testados; precisão migrada preservada | Interface de planejamento pendente |
| A16 | Moodle real | Adaptador próprio + fixtures | Prova real local de leitura e pequeno arquivo; renovação HTTP/SQL sintética preserva identidade/histórico e respeita desconexão; renovação real/IP remoto pendentes |
| A17 | Outro Moodle | Fixtures de subdiretório/funções faltantes; banco IDs colidentes | Segunda instalação/IFSP não comprovados |
| A18 | Erros/cobertura/cursor | Curso Moodle retoma discussão/posts após reinício/esgotamento, percorre além de 50 fóruns/páginas e trata reordenação; lease por chave impede lotes simultâneos e cerca respostas tardias; cursor não avança em partial | Orçamento/timeout hospedados e medição real pendentes |
| A19 | Google múltiplas contas | OAuth/HTTP persistente, conta verificada, cofre/CAS/epoch, callback tardio e escopos testados | App OAuth/consentimentos/duas contas reais não configurados |
| A20 | Cursores/refresh Google | Gmail/Calendar/Drive com paginação/checkpoints/expiração/historyId exato e MCP SDK; 16 testes, lease por chave e reconfiguração concorrente recusada | Tenant e Testing/Production pendentes |
| A21 | Docs/Sheets/Slides nativos | Leitura nativa; criar recursos e editar texto Docs/Slides com revisão atômica em fixture | Edição de células Sheets, OAuth real e escrita em área autorizada pendentes |
| A22 | Escrita segura | Autoridade persistente/SQL/UI, snapshot sob lock, aprovação expira/consumo único e resultado incerto antes de envio; executor sintético | Escrita real autorizada e resultado reconciliado pendentes |
| A23 | Arquivos úteis | PDF acadêmico real de 15 páginas via HTTP/SQL/MCP SDK local e cliente novo, hash/dono/continuação; worker navegador com PDF real, gravação HTTP/SQL/MCP e cancelamento/timeout/hash; fixtures hostis/merge; JPEG real e documentos nativos em fixture | Parser na Edge indisponível; rota cliente implementada/provada localmente, ainda sem implantação/Auth real. Documento/apresentação reais pelo cliente pendentes. Imagem sem OCR tem lacuna explícita; OCR é extensão condicional |
| A24 | Pacote AraLearn | Ferramenta MCP ligada a atividade/materiais/direitos, lacunas e leitura declarada testados | Vínculos completos/material real ainda parciais; criação real exige pedido |
| A25 | Migração reproduzível | 57 arquivos brutos, 109 registros curados; staging/import local idempotentes | Delta final/remote autorizado pendentes |
| A26 | Regressão acadêmica | 4 verificações privadas/10 cenários; cliente MCP novo recuperou 109 registros com referências e documento bruto | Qualidade semântica das respostas, Skill/conversa real ainda pendentes |
| A27 | Backup e virada | Staging export/restore; dump restaurado em banco novo, 14 tabelas/binários/RLS/grants conferidos | Backup hospedado, reconciliação final e virada do cliente pendentes |
| A28 | MCP remoto/OAuth | Cliente SDK HTTP local e adaptador do gateway/assinaturas/sessão revogada sintéticos | HTTPS/consentimento remoto real não executados |
| A29 | Celular/web | Design AraLearn MIT, coluna até 430 px e ícones; Chrome/viewport móvel/formulários/aprovação/temas/exportação/saída e inspeção visual; Pages/PKCE/consentimento/CSP e cadastro/renovação Moodle HTTPS em fixture | Smartphone/app real/nova invocação e delta pendentes; viewport não encerra gate móvel |
| A30 | Operação sustentável | Jobs/retries/cobertura/retomadas integradas; lease por chave e fencing/renovação por tentativa ativa; corte permanente de fóruns/páginas removido | Medição/runtime hospedados, demais limites de conteúdo e cron autorizado pendentes |

Evidência real em `.private/evidence/`; nunca transportar dados pessoais para testes/CI públicos. STATUS e relatório de validação registram comandos e contagens executadas. Requisitos parciais continuam no plano sem redução de escopo.
