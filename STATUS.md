# Estado do AraHub

Atualizado: 2026-10-05. Branch main; commits locais. Produto completo A01–A30 ainda não entregue. Este checkpoint substitui o histórico do chat.

## Mandato corrente

Executar até os limites reais de ferramentas, permissões e sessão, sem encerrar o mandato ao completar uma etapa. Código MIT, dados privados separados, projetos irmãos somente leitura. Consultar a especificação da etapa no bootstrap privado e `docs/ACEITE.md`; não reduzir requisitos.

Decisões posteriores do usuário: projeto **AraHub**, nova conta institucional Supabase/organização Universidade de Lisboa, plano Free/São Paulo. Interface em **GitHub Pages**, repositório público MIT pretendido, sem Cloudflare. Interface auxiliar mínima de acesso/configurações/conexões/consentimento: reproduzir o design do AraLearn, botões somente por ícones, texto útil mínimo, largura de celular também no desktop.

## Implementado e comprovado localmente

- ZIP/bootstrap/credenciais/dados privados ignorados antes do primeiro commit. Pacote: 20 hashes conferidos; plano e auditoria em `docs/PLANO.md` e `docs/FONTES.md`. Checkpoint anterior à fatia PDF: `a79bc40`.
- Postgres exclusivo loopback `127.0.0.1:55432`, dez migrations. Instalação SQL em banco novo: dez migrations, RLS ativo/forçado, dois donos e idempotência aprovados. Backup/restore em destino novo: 14 tabelas, 1.190.181 bytes, binários/políticas/grants comparados. Bancos e backups preservados.
- Deltas/versionamento/concorrência, preferências com vigência/superação/retirada/conflitos e memória antes de refresh. MCP SDK por HTTP com identidade sintética, recuperação por cliente novo e fronteira de client ID/sessão.
- Alvo ativo por contexto: vínculo explícito com versão, ambiguidade sem palpite e relato de entrega idempotente que conserva o alvo original mesmo após mudança do contexto. Não confirma submissão externa.
- Comparação de rascunho selecionado por ID com observação Moodle qualificada: autoria vinculada, versão e proveniência; diferenças não provam outra versão. SQL/ownership/autor distinto/cobertura parcial testados.
- Moodle: transporte DNS/TLS fixado e 16 funções seguras; prova real de leitura e JPEG de 52.017 bytes por serviço/SDK, credencial de prova revogada. Renovação HTTP/cofre/estado/epoch e formulário preservam instalação/conta/IDs; provedor sintético. Checkpoint de curso retoma páginas/discussões/posts após reinício/esgotamento do job, sem corte permanente de 50 fóruns/páginas, com guarda de reordenação e orçamento por execução. Oito testes dirigidos aprovados. Lease por chave impede lote irmão simultâneo; posse expirada não grava mais. Consultar `docs/SINCRONIZACAO.md`.
- Google: OAuth incremental ligado à sessão, subject verificado, múltiplas contas, cofre/CAS/epoch e leituras nativas. Gmail/Calendar/Drive com checkpoints duráveis e ferramentas MCP; paginação retoma sem repetir/pular páginas, cursor só avança ao completar, historyId decimal exato/expiração/state() testados. Lease/fencing por chave, descritor atômico e pedido concorrente recusado sem mudar o checkpoint. 16 testes dirigidos incluídos no gate final; tenant real pendente. Consultar `docs/GOOGLE_SYNC.md`.
- Produção Google: criar Docs/Sheets/Slides, inserir texto em Docs e substituir texto em slides escolhidos. Autoridade humana persistente, hash/revisão conferidos sob lock, aprovação expira e é consumida uma única vez, resultado incerto antes do envio. Data API só SELECT nas ações. 13 testes SQL da autoridade e executor com fetch sintético aprovados; nenhuma escrita externa real. Edição de células Sheets ainda pendente.
- PDF: parser isolado em worker terminável, limites, página/localizador/hash/lacunas; sem OCR. Persistência/merge sob lock, página offline e retomada SDK testados. PDF acadêmico real: 2.215.244 bytes/15 páginas, HTTP/SQL/SDK locais, parcial→completo/cliente novo/dono/hash aprovados; identidade sintética. Supabase Edge não expõe o worker terminável necessário: parse na Edge indisponível, rota cliente implementada em worker do navegador. Não enfraquecer limites nem declarar A23 completo; consultar `docs/ARQUIVOS.md`.
- PDF cliente: Chrome extraiu o PDF acadêmico real em dois viewports; hash divergente, cancelamento e timeout terminando CPU síncrona aprovados. Resultado gravado por HTTP/SQL real local e recuperado por cliente MCP novo, identidade sintética, proveniência browser_client não corroborada. Worker sem token/CDN, lote continuável por página, licença pdf.js Apache-2.0 incluída. Gate integrado da fatia aprovado; não comprova runtime/conta hospedados.
- UI adaptada de AraLearn MIT, snapshot e atribuição em `THIRD_PARTY_NOTICES.md`: coluna até 430 px, ícones com nomes acessíveis, cartões, temas claro/escuro. Chrome isolado operou entrada, renovação Moodle, revisão/autorizações, exportação e saída em 1280×900 e 390×844; sem overflow/erros e capturas nativas inspecionadas. HTTP/Auth são fixtures; não comprova conta real ou celular físico.
- Pacote Pages preparado e testado: nove arquivos/licenças MIT/Apache-2.0/subpath/três callbacks físicos/CSP/referrer e manifesto privado. Chrome operou PKCE/consentimento/CSP/indisponibilidade e cadastro/renovação Moodle por HTTPS, token limpo e ID preservado; provedores simulados. Workflow manual Pages preparado com actions fixadas por SHA, ainda não executado. Backend Edge atende MCP/discovery/APIs com CORS exato; UI_URL inclui subpath e UI_ORIGIN apenas origem.
- Migração privada: 57 arquivos brutos completos/109 registros curados no banco local, idempotência; cliente MCP novo recuperou todos com fontes e texto bruto. Não comprova revisão semântica humana completa. Plugin/Skill genéricos preparados, sem ativação em conversa real.

## Prova hospedada e limites externos

Projeto remoto AraHub Healthy/NANO/Free em São Paulo, conferido pelo painel autenticado. Oito migrations instaladas com hashes canônicos conferidos; SQL/RLS com dois donos sintéticos e rollback passou, deixando zero usuários/contextos. Alvo e evidências em `.private/cloud/`. Não reaplicar o bundle antigo: reconciliar histórico e aplicar apenas migrations novas.

Sem aplicação implantada, repo remoto criado, Pages publicado, OAuth Google real, importação hospedada, cron ou virada. Publicar código MIT não publica a memória nem oferece serviço multiusuário. Matriz de autorizações do bootstrap continua aplicável a alvos/escopos externos e custos.

O conector Supabase não acessa o novo projeto. O usuário concluiu login CLI protegido na nova conta: CLI 2.119.0, home exclusivo `.private/supabase-cli/`, keyring global desativado, telemetria desativada. Leitura confirmou somente AraHub na organização alvo; oito hashes remotos foram reconferidos. Credencial não foi exposta no chat. Não usar contas/projetos irmãos nem ampliar permissões; login não autoriza qualquer escrita.

## Validação corrente

Gate integrado final: **202 aprovados/0 falhas** (4m31s). TypeScript, build e QA local/Pages aprovados; dois viewports em cada QA e zero violações CSP. Formatação de 78 arquivos aprovada; 121 arquivos no índice, zero achados automáticos. Ensaio incremental: banco novo/prefixo de oito→dez migrations, RLS das tabelas novas, replay/drift recusados. Instalação limpa/restore anteriores seguem válidos, schema não mudou. Evidências em `.private/evidence/gate-pdf-client-baa87a3e-9bea-422c-b03e-ced6fdd02390.log` e `.private/evidence/pdf-real-7678f0f2-c0f4-44f7-ba5e-123d846e25ca.json`; dados privados nunca vão a CI/Git público.

## Próximo passo executável

Agentes encerrados, patches revisados e gate integrado aprovado. Commit local da fatia: consultar `git log -1`. Login resolvido. Lote externo concreto/revisável em `docs/LOTE-IMPLANTACAO.md`: backend no projeto existente e código público/interface em `fabio-ara/AraHub`/Pages, sem importação privada/cron/app Google/escrita acadêmica. Em 2026-10-05 o usuário respondeu “Aprovo” ao lote: backend/OAuth no projeto existente, repositório público MIT e GitHub Pages, custo adicional máximo zero. Execução iniciada.

Executar o lote autorizado e conferir plano/cotas reais; usar SUPABASE_DB_URL injetada na Edge (DATABASE_URL/pooler protegido somente se necessário), reconciliar/aplicar só novas migrations, configurar Auth pontualmente sem `config push` global, provar cliente real/sessões/dois donos. Edição Sheets e parse PDF na Edge ainda têm limites técnicos documentados; validar a rota cliente PDF no alvo hospedado sem enfraquecer isolamento. Não substituí-los silenciosamente por outra função.

Depois do lote autorizado: provar Auth/MCP real antes de apresentar o escopo de importação privada e sua autorização. Login CLI já resolvido; não pedir novamente por rotina. Provas reais de Google, renovação Moodle, smartphone/nova conversa, delta final de migração e virada continuam no escopo; não declarar produto finalizado com esses gates omitidos.

## Retomada sem chat

Não há transação externa incerta nem recorrência ativa. Container/bancos são exclusivos do AraHub; servidor local pelos comandos do README. Demo sintética usa outro dono que a importação privada; destino local está em `.private/local-owner.json`. METD/staging/curadoria e backups continuam privados e disponíveis. Capturas somente por retorno nativo/bytes fora da interface; nunca usar download/Salvar como/data/blob para imagens, inclusive em handoffs de navegador.
