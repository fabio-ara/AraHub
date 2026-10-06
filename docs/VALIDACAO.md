# Checkpoint de validação

Data: 2026-10-05. Commits somente locais, sem remoto Git configurado ou publicação. Este checkpoint substitui o diário de execução. Produto completo A01–A30 ainda não entregue; pendências em STATUS e na matriz de aceite.

| Verificação executada | Resultado | Limite da evidência |
|---|---|---|
| TypeScript raiz/Edge/web | Aprovados | Não comprova runtime hospedado |
| Build UI | Bundle gerado e operado em Chrome | Saída ignorada; bundler experimental |
| Suíte completa | 183 aprovados/0 falhas, 2m29s; regressão temporal corrigida e incluída | Postgres/HTTP/SDK locais; identidade/provedores sintéticos salvo provas separadas |
| Preferências SQL/tempo | Três testes dirigidos aprovados; regressão de milissegundos | Datas do driver SQL e strings ISO; conversa real pendente |
| Formatação | 72 arquivos aprovados após a correção temporal | Não comprova comportamento |
| Instalação limpa | Dez migrations em banco novo; dois donos/RLS/idempotência | SQL local; cache vazio e implantação limpa não testados |
| Contexto/autoria | Três testes SQL dirigidos aprovados | Alvo versionado, relato idempotente e observação qualificada; conta real pendente |
| Google sync | 15 testes dirigidos e MCP SDK aprovados | Paginação, expiração, checkpoints e historyId exato; APIs simuladas |
| Moodle sync | Quatro testes dirigidos aprovados | Páginas/posts/reinício/job esgotado; provedor simulado, SQL real; teto de fóruns e lease por curso pendentes |
| Aprovação persistente | 13 testes SQL dirigidos aprovados | Snapshot/hash/expiração/consumo único/isolamento/Data API; nenhuma escrita externa |
| Executor Google | Teste SQL/fetch dirigido aprovado | Criar Docs/Sheets/Slides e editar Docs/Slides; edição de células Sheets e OAuth real pendentes |
| PDF/material/MCP | Dez testes dirigidos aprovados; cliente novo/merge concorrente | PDF sintético, parser/SQL/SDK locais; PDF acadêmico/OCR/Worker hospedado não comprovados |
| UI AraLearn | Dois cenários Chrome: 1280×900 e 390×844; entrada, renovação, aprovação, temas, exportação e saída operados; capturas nativas inspecionadas | Design MIT copiado, coluna até 430 px, ícones; HTTP/Auth fixtures, smartphone físico pendente |
| Pacote Pages | Três testes de empacotamento; dois cenários Chrome PKCE/consentimento/CSP/falha aprovados | Oito arquivos/atribuições/subpath/callbacks físicos; rede simulada, sem email enviado/hosting |
| Regressão privada A26 | Quatro aprovados; dez cenários ancorados nas fontes | Não é avaliação semântica completa |
| Migração privada | 57 arquivos brutos/109 registros curados; retry sem duplicar | Staging/destino locais; sem virada/importação hospedada |
| Recuperação privada | Cliente MCP novo recuperou 109 registros com fontes e texto bruto | Dados reais privados; identidade/transportes locais sintéticos |
| Backup/restore | 14 tabelas/binários/RLS/grants conferidos; dump de 1.190.181 bytes | Banco novo exclusivo; chaves do cofre têm backup separado |
| Moodle real fixado | Conta/instância reais, 16 funções permitidas; arquivo de 22.077 bytes | Somente leitura; IP remoto e segundo Moodle não comprovados |
| Material/SDK Moodle real | JPEG de 52.017 bytes preservado, retry/id/hash/isolamento; credencial de prova revogada | Sem OCR; renovação real e PDF pelo cliente pendentes |
| Supabase hospedado | Oito hashes canônicos; RLS ativo/forçado, dois donos sintéticos e rollback aprovados | Zero usuários/contextos ao concluir; claims sintéticos, não Auth/MCP real; duas migrations novas locais |
| Skill/manifesto | Validador aprovado; schemas oficiais conferidos | Plugin não instalado/chamado em conversa real |
| Git/exclusões/licenças | 114 arquivos indexados, zero achados heurísticos; revisão manual/atribuições AraLearn e dependências feitas; diff sem erros de whitespace | Scan não equivale a auditoria completa |

O projeto remoto AraHub Free existe, com schema anterior instalado. Aplicação, Pages, OAuth Google, cron, escritas acadêmicas e APIs faturadas não foram ativados. O conector não acessa a nova conta. Login CLI protegido solicitado, resposta pendente; login não amplia o lote de escrita autorizado.

O design do AraLearn foi auditado e copiado somente por leitura de snapshot MIT identificado em THIRD_PARTY_NOTICES. Nenhuma escrita em projetos irmãos foi executada. O estado vivo do irmão pode conter trabalho independente: não reverter nem incorporar alterações sem auditar a fonte necessária.

Evidências privadas em .private/evidence/, .private/cloud/, manifestos em .private/backups/ e artefatos em .private/deploy/. Capturas nativas foram gravadas diretamente dos bytes, sem download/Salvar como pela interface. Não enviar evidências pessoais, dumps ou esses artefatos para Git/CI público. Bancos de instalação/restore têm nomes únicos e foram preservados.
