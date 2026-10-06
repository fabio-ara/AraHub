# Estado do AraHub

Atualizado: 2026-10-06. Branch main; remoto público MIT publicado. Produto completo A01–A30 ainda não entregue. Este checkpoint substitui o histórico do chat.

## Mandato corrente

Executar até os limites reais de ferramentas, permissões e sessão, sem encerrar o mandato ao completar uma etapa. Código MIT, dados privados separados, projetos irmãos somente leitura. Consultar a especificação da etapa no bootstrap privado e `docs/ACEITE.md`; não reduzir requisitos.

Decisões posteriores do usuário: projeto **AraHub**, nova conta institucional Supabase/organização Universidade de Lisboa, plano Free/São Paulo. Interface em **GitHub Pages**, repositório público MIT pretendido, sem Cloudflare. Interface auxiliar mínima de acesso/configurações/conexões/consentimento: reproduzir o design do AraLearn, botões somente por ícones, texto útil mínimo, largura de celular também no desktop.

## Implementado e comprovado localmente

- ZIP/bootstrap/credenciais/dados privados ignorados antes do primeiro commit. Pacote: 20 hashes conferidos; plano e auditoria em `docs/PLANO.md` e `docs/FONTES.md`. Checkpoint anterior à fatia PDF: `a79bc40`.
- Postgres exclusivo loopback `127.0.0.1:55432`; instalação SQL em banco novo: onze migrations, RLS ativo/forçado, dois donos e idempotência aprovados. Backup/restore anterior com dez migrations: 14 tabelas, 1.190.181 bytes, binários/políticas/grants comparados. A migration nova altera somente permissão do event trigger do provedor. Bancos e backups preservados.
- Deltas/versionamento/concorrência, preferências com vigência/superação/retirada/conflitos e memória antes de refresh. MCP SDK por HTTP com identidade sintética, recuperação por cliente novo e fronteira de client ID/sessão.
- Alvo ativo por contexto: vínculo explícito com versão, ambiguidade sem palpite e relato de entrega idempotente que conserva o alvo original mesmo após mudança do contexto. Não confirma submissão externa.
- Comparação de rascunho selecionado por ID com observação Moodle qualificada: autoria vinculada, versão e proveniência; diferenças não provam outra versão. SQL/ownership/autor distinto/cobertura parcial testados.
- Moodle: transporte DNS/TLS fixado e 16 funções seguras; prova real de leitura e JPEG de 52.017 bytes por serviço/SDK, credencial de prova revogada. Renovação HTTP/cofre/estado/epoch e formulário preservam instalação/conta/IDs; provedor sintético. Checkpoint de curso retoma páginas/discussões/posts após reinício/esgotamento do job, sem corte permanente de 50 fóruns/páginas, com guarda de reordenação e orçamento por execução. Oito testes dirigidos aprovados. Lease por chave impede lote irmão simultâneo; posse expirada não grava mais. Consultar `docs/SINCRONIZACAO.md`.
- Google: OAuth incremental ligado à sessão, subject verificado, múltiplas contas, cofre/CAS/epoch e leituras nativas. Gmail/Calendar/Drive com checkpoints duráveis e ferramentas MCP; paginação retoma sem repetir/pular páginas, cursor só avança ao completar, historyId decimal exato/expiração/state() testados. Lease/fencing por chave, descritor atômico e pedido concorrente recusado sem mudar o checkpoint. 16 testes dirigidos incluídos no gate final; tenant real pendente. Consultar `docs/GOOGLE_SYNC.md`.
- Produção Google: criar Docs/Sheets/Slides, inserir texto em Docs e substituir texto em slides escolhidos. Autoridade humana persistente, hash/revisão conferidos sob lock, aprovação expira e é consumida uma única vez, resultado incerto antes do envio. Data API só SELECT nas ações. 13 testes SQL da autoridade e executor com fetch sintético aprovados; nenhuma escrita externa real. Edição de células Sheets ainda pendente.
- PDF: parser isolado em worker terminável, limites, página/localizador/hash/lacunas; sem OCR. Persistência/merge sob lock, página offline e retomada SDK testados. PDF acadêmico real: 2.215.244 bytes/15 páginas, HTTP/SQL/SDK locais, parcial→completo/cliente novo/dono/hash aprovados; identidade sintética. Supabase Edge não expõe o worker terminável necessário: parse na Edge indisponível, rota cliente implementada em worker do navegador. Não enfraquecer limites nem declarar A23 completo; consultar `docs/ARQUIVOS.md`.
- PDF cliente: Chrome extraiu o PDF acadêmico real em dois viewports; hash divergente, cancelamento e timeout terminando CPU síncrona aprovados. Resultado gravado por HTTP/SQL real local e recuperado por cliente MCP novo, identidade sintética, proveniência browser_client não corroborada. Worker sem token/CDN, lote continuável por página, licença pdf.js Apache-2.0 incluída. Gate integrado da fatia aprovado; não comprova runtime/conta hospedados.
- UI adaptada de AraLearn MIT, snapshot e atribuição em `THIRD_PARTY_NOTICES.md`: coluna até 430 px, ícones com nomes acessíveis, cartões, temas claro/escuro. Chrome isolado operou entrada, renovação Moodle, revisão/autorizações, exportação e saída em 1280×900 e 390×844; sem overflow/erros e capturas nativas inspecionadas. HTTP/Auth são fixtures; não comprova conta real ou celular físico.
- Pacote Pages preparado e testado: nove arquivos/licenças MIT/Apache-2.0/subpath/três callbacks físicos/CSP/referrer e manifesto privado. Chrome operou PKCE/consentimento/CSP/indisponibilidade e cadastro/renovação Moodle por HTTPS, token limpo e ID preservado; provedores simulados. Workflow manual Pages com actions fixadas por SHA executado no lote aprovado. Backend Edge atende MCP/discovery/APIs com CORS exato; UI_URL inclui subpath e UI_ORIGIN apenas origem.
- Migração privada: 57 arquivos brutos completos/109 registros curados no banco local, idempotência; cliente MCP novo recuperou todos com fontes e texto bruto. Não comprova revisão semântica humana completa. Plugin/Skill genéricos preparados, sem ativação em conversa real.

## Prova hospedada e limites externos

Lote aprovado em 2026-10-05; execução em 2026-10-06. Repositório público MIT https://github.com/fabio-ara/AraHub e interface HTTPS https://fabio-ara.github.io/AraHub/ publicados. Dois workflows manuais concluídos; nove assets/licenças, sem evidências privadas. GitHub Free: 8/2.000 minutos e 0/0,5 GB de storage conferidos antes; runners padrão, sem serviços pagos.

Supabase AraHub Free/NANO em São Paulo: spend cap ativo, sem cartão; cotas conferidas (26,2 MB/500 MB de banco, zero chamadas/500.000 antes). Função arahub implantada; configuração Auth pontual, inscrições públicas/DCR fechados, consentimento no subpath exato. Cofre gerado com backup privado. TLS e sessão ativa comprovados na API pessoal. Runtime encaminha HTTP /arahub/...: adaptador normaliza apenas host/prefixo configurados, sem confiar em forwarded headers; assinatura/client ID/CORS permanecem restritos.

Onze migrations hospedadas: oito hashes originais reconferidos, duas novas aplicadas com guarda de prefixo; uma correção da auditoria retira EXECUTE público de rls_auto_enable() sem remover seu event trigger. Zero avisos SQL restantes; aviso de proteção contra senhas vazadas exige Pro, sem upgrade (interface usa e-mail, não senha). RLS/FORCE/dois donos/rollback reconferidos.

HTTPS real: 32 verificações aprovadas, zero falhas/skips, duas identidades sintéticas temporárias criadas no Auth real, autorização-code/PKCE nativos, cliente MCP SDK, idempotência/isolamento/busca/exportação/sessão revogada. PDF sintético hospedado extraído/gravado pelo worker real em dois viewports, sem rede simulada/overflow/violação CSP; capturas nativas inspecionadas. Consentimento na interface hospedada e troca PKCE/callback nativos também operados com usuário sintético. Limpeza dirigida concluída: dois usuários sintéticos/dados/sessões e cliente temporário removidos por IDs e guardas; titular preservado. Estado remoto: um usuário, zero contextos/conexões/entidades/deltas, onze migrations.

Conta titular confirmou seu e-mail, entrou e concedeu consentimento humano no navegador habitual. Primeira entrada encontrou signup_disabled; fallback para resend nativo com PKCE implementado. Fixture de QA corrigida para devolver HTTP 422/error_code de verdade; ensaio PKCE/consentimento em dois viewports aprovado. Não houve confirmação artificial, leitura de e-mail/códigos ou senha no chat. Mensagem de autorizações duplicada por renderizações concorrentes corrigida.

Plugin pessoal AraHub criado e conectado no ChatGPT, sem publicação no catálogo público. Cliente público/PKCE, callback específico conferido no cadastro, sem segredo e sem DCR; somente identidade/e-mail/perfil. Nova conversa ChatGPT chamou a retomada de contextos: contextos/deltas/conexões vazios e cobertura persisted, sem escrita ou sincronização. Identificador do plugin/cliente/conversa e comprovantes ficam em .private/cloud, não nos arquivos genéricos.

CLI 2.119.0 autenticado na conta nova, home exclusivo .private/supabase-cli; keyring global/telemetria desativados. Conector Supabase antigo não acessa o alvo; não usar para operações. Importação privada hospedada, cron, app Google e escritas acadêmicas não estão autorizados neste lote. Projetos irmãos intactos.

## Validação corrente

Gate integrado final: **202 aprovados/0 falhas** (4m31s). TypeScript, build e QA local/Pages aprovados; dois viewports em cada QA e zero violações CSP. Formatação de 78 arquivos aprovada; 121 arquivos no índice, zero achados automáticos. Ensaio incremental: banco novo/prefixo de oito→dez migrations, RLS das tabelas novas, replay/drift recusados. Instalação limpa/restore anteriores seguem válidos, schema não mudou. Evidências em `.private/evidence/gate-pdf-client-baa87a3e-9bea-422c-b03e-ced6fdd02390.log` e `.private/evidence/pdf-real-7678f0f2-c0f4-44f7-ba5e-123d846e25ca.json`; dados privados nunca vão a CI/Git público.

## Próximo passo executável

Login CLI, publicação MIT/Pages, implantação, entrada humana e cliente pessoal resolvidos. Publicar/inspecionar a correção da mensagem duplicada, concluir commit/push das evidências genéricas. A fixture PKCE antes devolvia 200 apesar de solicitar 422: foi corrigida e executada novamente, sem aproveitar aquela aprovação como prova do fallback.

Evidência HTTPS32: .private/evidence/hosted-3d29dd39-053f-4add-b561-56c8fe1931b9.json; UI/PDF: .private/evidence/hosted-ui-pdf-result.json; consentimento: .private/evidence/hosted-consent-result.json. Registro final/limpeza em .private/cloud/registry-eleven-hashes.json e hosted-current-counts.json. Contexto de implantação e chaves ficam exclusivamente em .private/cloud.

Após concluir o lote: apresentar o escopo concreto de importação privada para aprovação específica, somente com isolamento comprovado. Provas reais Google/renovação Moodle/smartphone/nova conversa, edição Sheets, delta final METD e virada continuam no escopo; não declarar A01–A30 encerrados. Não pedir login CLI ou senha de banco novamente por rotina.

## Retomada sem chat

Não há transação externa incerta nem recorrência ativa. Container/bancos são exclusivos do AraHub; servidor local pelos comandos do README. Demo sintética usa outro dono que a importação privada; destino local está em `.private/local-owner.json`. METD/staging/curadoria e backups continuam privados e disponíveis. Capturas somente por retorno nativo/bytes fora da interface; nunca usar download/Salvar como/data/blob para imagens, inclusive em handoffs de navegador.
