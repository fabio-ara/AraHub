# Checkpoint de validação

Data: 2026-10-06. Código MIT e interface GitHub Pages publicados, backend Supabase implantado. Este checkpoint substitui o diário de execução. Produto completo A01–A30 ainda não entregue; pendências em STATUS e na matriz de aceite.

| Verificação executada | Resultado | Limite da evidência |
|---|---|---|
| TypeScript raiz/Edge/web | Aprovados | Não comprova runtime hospedado |
| Build UI | Bundle gerado e operado em Chrome | Saída ignorada; bundler experimental |
| Suíte completa | 202 aprovados/0 falhas, 4m31s; 12 regressões HTTP dirigidas após servir o worker local aprovadas; regressões temporais, concorrência e continuação incluídas | Postgres/HTTP/SDK locais; identidade/provedores sintéticos salvo provas separadas |
| Preferências SQL/tempo | Três testes dirigidos aprovados; regressão de milissegundos | Datas do driver SQL e strings ISO; conversa real pendente |
| Formatação | 78 arquivos aprovados | Não comprova comportamento |
| Instalação limpa | Onze migrations em banco novo; dois donos/RLS/idempotência | SQL local; cache vazio e nova implantação independente não testados |
| Contexto/autoria | Três testes SQL dirigidos aprovados | Alvo versionado, relato idempotente e observação qualificada; conta real pendente |
| Google sync | 16 testes dirigidos e MCP SDK aprovados | Paginação/expiração/historyId/checkpoints, descritor atômico e concorrência por chave; APIs simuladas |
| Moodle sync | Oito testes dirigidos aprovados | Além de 50 fóruns/páginas, reordenação, reinício/job esgotado e lease; provedor simulado, SQL real |
| Lease/fencing | Exclusão entre jobs/processos e rejeição após expirar/takeover/finish | SQL real; capability de runtime não pode ser criada por JSON/JWT |
| Atualização incremental | Oito→dez em ensaio local; remoto oito→dez→onze, guardas e onze hashes canônicos reconferidos | Duas migrations funcionais e correção de EXECUTE do event trigger aplicadas; nenhum bundle inicial reaplicado |
| Aprovação persistente | 13 testes SQL dirigidos aprovados | Snapshot/hash/expiração/consumo único/isolamento/Data API; nenhuma escrita externa |
| Executor Google | Teste SQL/fetch dirigido aprovado | Criar Docs/Sheets/Slides e editar Docs/Slides; edição de células Sheets e OAuth real pendentes |
| Recepção PDF cliente | Dez testes SQL/HTTP aprovados; esquema estrito, hash binário sob lock, tamanho/dono/client ID, idempotência, retomada e cobertura forjada recusada | Não corrobora autenticidade da extração; origem browser_client não verificada |
| PDF navegador | PDF acadêmico real parseado no Chrome em dois viewports; gravação do resultado por HTTP/SQL e leitura MCP local; hash adulterado, cancelamento e CPU síncrona terminada por timeout | Auth sintético; sem OCR; arquivo privado e origem browser_client não corroborada. Hospedagem/conta real pendentes |
| PDF/material/MCP | PDF acadêmico real de 2.215.244 bytes/15 páginas via socket HTTP/MCP SDK, dono/hash/cliente novo; dez testes material e nove parser | Identidade sintética; sem OCR; extração no Supabase Edge indisponível sem Worker terminável |
| UI AraLearn | Dois cenários Chrome: 1280×900 e 390×844; entrada, renovação, aprovação, temas, exportação e saída operados; capturas nativas inspecionadas | Design MIT copiado, coluna até 430 px, ícones; HTTP/Auth fixtures, smartphone físico pendente |
| Pacote Pages | Três testes de empacotamento; dois cenários Chrome PKCE/consentimento/CSP/falha/cadastro-renovação Moodle HTTPS aprovados | Nove arquivos/atribuições Apache-2.0 do worker e MIT do app/subpath/callbacks; rede simulada, sem email/hosting. Workflow manual com SHAs executado; esta linha descreve os ensaios com provedores simulados |
| Regressão privada A26 | Quatro aprovados; dez cenários ancorados nas fontes | Não é avaliação semântica completa |
| Migração privada | 57 arquivos brutos/109 registros curados; retry sem duplicar | Staging/destino locais; sem virada/importação hospedada |
| Recuperação privada | Cliente MCP novo recuperou 109 registros com fontes e texto bruto | Dados reais privados; identidade/transportes locais sintéticos |
| Backup/restore | 14 tabelas/binários/RLS/grants conferidos; dump de 1.190.181 bytes | Banco novo exclusivo; chaves do cofre têm backup separado |
| Moodle real fixado | Conta/instância reais, 16 funções permitidas; arquivo de 22.077 bytes | Somente leitura; IP remoto e segundo Moodle não comprovados |
| Material/SDK Moodle real | JPEG de 52.017 bytes preservado, retry/id/hash/isolamento; credencial de prova revogada | Sem OCR; renovação real e PDF obtido do Moodle pelo cliente pendentes |
| Supabase hospedado | Onze hashes canônicos; RLS ativo/forçado, dois donos e rollback aprovados; 32 verificações HTTPS/Auth/OAuth/MCP nativos sem falhas/skips | Ensaio com identidades sintéticas anterior à importação privada. Contas/dados de teste removidos por IDs/guardas, titular preservado |
| UI hospedada | PDF sintético extraído e gravado em 390×844 e 1280×900; consentimento real/PKCE no Chrome com usuário sintético; zero violações CSP, capturas inspecionadas | Rede/provedor reais; arquivo sintético. Smartphone e material acadêmico hospedado pendentes |
| Titular/OAuth pessoal | E-mail confirmado, sessão e consentimento humanos; AraHub conectado ao titular no ChatGPT | Cliente pessoal com callback exato, apenas identidade/e-mail/perfil; nova conversa consultou contextos/coverage, sem registros ou sincronização |
| Importação privada hospedada | Nove contextos/57 arquivos-hash/109 deltas-vínculos verificados; plugin real recuperou 109 registros únicos/proveniência e 57 arquivos | Origem privada atual reconferida; aprovação separada, sem publicar dados. Revisão semântica e virada pendentes |
| Snapshot hospedado/restore | Onze tabelas/fingerprints e 57 binários/hash em banco local novo; RLS/segundo dono aprovados | Snapshot real da aplicação, não restore do serviço Auth do provedor; chaves/configurações separadas |
| Importador administrativo | Teste SQL novo: replay/bytes/permissões/colisão entre donos aprovado | Corrige upsert que dependia de UPDATE bloqueado; não amplia grant nem expõe importação ao MCP |
| ChatGPT após importação | Nova conversa chamou AraHub em leitura, recuperou nove contextos e dois registros com fontes/versões conferidas no histórico nativo | Distinguiu fato histórico e vigência não comprovada da preferência. Amostra de dois registros, não revisão semântica integral; nenhuma sincronização ou escrita solicitada |
| Skill/manifesto | Validador aprovado; schemas oficiais conferidos | Template genérico; instalação pessoal e consulta em nova conversa comprovadas separadamente |
| Git/exclusões/licenças | 121 arquivos indexados, zero achados heurísticos; revisão manual/atribuições AraLearn e dependências feitas; diff sem erros de whitespace | Scan não equivale a auditoria completa |
| Google real | Consentimento humano institucional, identidade/seis permissões e escritas desativadas; leituras por ChatGPT novo, refresh real CAS 1→2, Docs/Slides/Gmail/Calendar nativos | Externo/Testing; planilha nativa não encontrada, segunda conta/cron/escritas/operação durável pendentes |
| Verificação Google na UI | HTTP/Auth/MCP dirigidos; negação parcial, isolamento e resposta sem conteúdo; QA Chrome em dois viewports, zero CSP, inspeção visual | Ícone de verificar leitura, uma página de até três itens; ainda precisa publicação e prova da sessão real |

O projeto remoto AraHub Free tem onze migrations e função implantada; Pages está publicado. OAuth Google próprio foi configurado no lote de leitura aprovado e a conta institucional conectada em Testing; cron, escritas acadêmicas e APIs faturadas não foram ativados. O usuário concluiu login CLI protegido: home exclusivo, keyring global/telemetria desativados; projeto e hashes reconferidos por leitura. Login não amplia o lote de escrita autorizado. Auth recebeu somente o PATCH pontual aprovado. Não executar config push global: ele modificaria valores alheios ao lote (incluindo MFA).

O design do AraLearn foi auditado e copiado somente por leitura de snapshot MIT identificado em THIRD_PARTY_NOTICES. Nenhuma escrita em projetos irmãos foi executada. O estado vivo do irmão pode conter trabalho independente: não reverter nem incorporar alterações sem auditar a fonte necessária.

Evidências privadas em .private/evidence/, .private/cloud/, manifestos em .private/backups/ e artefatos em .private/deploy/. Capturas nativas foram gravadas diretamente dos bytes, sem download/Salvar como pela interface. Não enviar evidências pessoais, dumps ou esses artefatos para Git/CI público. Bancos de instalação/restore têm nomes únicos e foram preservados.
