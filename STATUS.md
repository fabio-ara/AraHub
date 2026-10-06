# Estado do AraHub

Atualizado: 2026-10-05. Branch main; commits locais. Produto completo A01–A30 ainda não entregue. Este checkpoint substitui o histórico do chat.

## Mandato corrente

Executar até os limites reais de ferramentas, permissões e sessão, sem encerrar o mandato ao completar uma etapa. Código MIT, dados privados separados, projetos irmãos somente leitura. Consultar a especificação da etapa no bootstrap privado e `docs/ACEITE.md`; não reduzir requisitos.

Decisões posteriores do usuário: projeto **AraHub**, nova conta institucional Supabase/organização Universidade de Lisboa, plano Free/São Paulo. Interface em **GitHub Pages**, repositório público MIT pretendido, sem Cloudflare. Interface auxiliar mínima de acesso/configurações/conexões/consentimento: reproduzir o design do AraLearn, botões somente por ícones, texto útil mínimo, largura de celular também no desktop.

## Implementado e comprovado localmente

- ZIP/bootstrap/credenciais/dados privados ignorados antes do primeiro commit. Pacote: 20 hashes conferidos; plano e auditoria em `docs/PLANO.md` e `docs/FONTES.md`. Último commit anterior à fatia atual: `54bb56c`.
- Postgres exclusivo loopback `127.0.0.1:55432`, dez migrations. Instalação SQL em banco novo: dez migrations, RLS ativo/forçado, dois donos e idempotência aprovados. Backup/restore em destino novo: 14 tabelas, 1.190.181 bytes, binários/políticas/grants comparados. Bancos e backups preservados.
- Deltas/versionamento/concorrência, preferências com vigência/superação/retirada/conflitos e memória antes de refresh. MCP SDK por HTTP com identidade sintética, recuperação por cliente novo e fronteira de client ID/sessão.
- Alvo ativo por contexto: vínculo explícito com versão, ambiguidade sem palpite e relato de entrega idempotente que conserva o alvo original mesmo após mudança do contexto. Não confirma submissão externa.
- Comparação de rascunho selecionado por ID com observação Moodle qualificada: autoria vinculada, versão e proveniência; diferenças não provam outra versão. SQL/ownership/autor distinto/cobertura parcial testados.
- Moodle: transporte DNS/TLS fixado e 16 funções seguras; prova real de leitura e JPEG de 52.017 bytes por serviço/SDK, credencial de prova revogada. Renovação HTTP/cofre/estado/epoch e formulário preservam instalação/conta/IDs; provedor sintético. Sincronização de curso preserva hierarquia, conteúdo e observações; checkpoint durável retoma páginas/discussões/posts após reinício e esgotamento do job, com orçamento por execução. Quatro testes dirigidos aprovados. Mais de 50 fóruns e execuções simultâneas do mesmo curso permanecem limites explícitos; consultar `docs/SINCRONIZACAO.md`.
- Google: OAuth incremental ligado à sessão, subject verificado, múltiplas contas, cofre/CAS/epoch e leituras nativas. Sincronização Gmail/Calendar/Drive com observações/checkpoints duráveis e ferramentas MCP ligadas. Paginação limitada retoma sem repetir/pular páginas, cursor só avança ao completar; historyId decimal exato, reconstrução por expiração e state() testados. 15 testes dirigidos do worker aprovados; tenant real pendente. Consultar `docs/GOOGLE_SYNC.md`.
- Produção Google: criar Docs/Sheets/Slides, inserir texto em Docs e substituir texto em slides escolhidos. Autoridade humana persistente, hash/revisão conferidos sob lock, aprovação expira e é consumida uma única vez, resultado incerto antes do envio. Data API só SELECT nas ações. 13 testes SQL da autoridade e executor com fetch sintético aprovados; nenhuma escrita externa real. Edição de células Sheets ainda pendente.
- PDF: parser isolado em worker terminável, limites, texto por página/localizador, hash e lacunas; sem OCR. Sem worker, recusa extração pesada. Persistência/merge sob lock, página offline e cliente MCP novo retomando páginas: 10 testes dirigidos root aprovados. PDF sintético, SQL/SDK reais locais; consultar `docs/ARQUIVOS.md`.
- UI adaptada de AraLearn MIT, snapshot e atribuição em `THIRD_PARTY_NOTICES.md`: coluna até 430 px, ícones com nomes acessíveis, cartões, temas claro/escuro. Chrome isolado operou entrada, renovação Moodle, revisão/autorizações, exportação e saída em 1280×900 e 390×844; sem overflow/erros e capturas nativas inspecionadas. HTTP/Auth são fixtures; não comprova conta real ou celular físico.
- Pacote Pages preparado e testado: oito arquivos, incluindo licenças/atribuições, subpath, três callbacks físicos, `.nojekyll`, CSP/referrer em meta e manifesto/hashes fora dos assets. Acesso por link PKCE/consentimento/CSP e indisponibilidade operados em Chrome com todos os provedores simulados. Script não publica. Backend Edge atende MCP/discovery e APIs com CORS exato; UI_URL inclui o subpath e UI_ORIGIN apenas a origem.
- Migração privada: 57 arquivos brutos completos/109 registros curados no banco local, idempotência; cliente MCP novo recuperou todos com fontes e texto bruto. Não comprova revisão semântica humana completa. Plugin/Skill genéricos preparados, sem ativação em conversa real.

## Prova hospedada e limites externos

Projeto remoto AraHub Healthy/NANO/Free em São Paulo, conferido pelo painel autenticado. Oito migrations instaladas com hashes canônicos conferidos; SQL/RLS com dois donos sintéticos e rollback passou, deixando zero usuários/contextos. Alvo e evidências em `.private/cloud/`. Não reaplicar o bundle antigo: reconciliar histórico e aplicar apenas migrations novas.

Sem aplicação implantada, repo remoto criado, Pages publicado, OAuth Google real, importação hospedada, cron ou virada. Publicar código MIT não publica a memória nem oferece serviço multiusuário. Matriz de autorizações do bootstrap continua aplicável a alvos/escopos externos e custos.

O conector Supabase não acessa o novo projeto: leitura de `get_project` recusada por falta de permissão. Não usar a conta/projetos irmãos nem ampliar permissões. Foi solicitado login CLI protegido na nova conta; resposta pendente. Nunca pedir senha/token no chat. A aba autorizada do painel continua no alvo correto; login humano não autoriza qualquer escrita.

## Validação corrente

Gate integrado final: **183 aprovados/0 falhas** (2m29s). A falha anterior revelou perda dos milissegundos ao converter datas SQL para texto na resolução de preferências; conversão corrigida e regressão determinística incluída. TypeScript raiz/Edge/web, build UI, formatação de 72 arquivos e QA visual/interações passaram. Instalação limpa e restore acima já executados nesta fatia. Evidência do gate em `.private/evidence/gate-final-fa6ffd1a-57f5-4bd6-9940-b85c44b980d0.log`; dados pessoais nunca vão a CI/Git público.

## Próximo passo executável

Os agentes terminaram; patches e testes foram revisados e o gate integrado passou. A fatia atual constitui o checkpoint local validado; consultar `git log -1` para seu commit. Scan de 114 arquivos indexados/histórico sem achados heurísticos e revisão manual de dados/licenças concluídos. Para implantação, aguardar resposta ao login protegido, abrir somente o fluxo autorizado e autenticar na nova conta. Não presumir autorização de login/publicação: não houve resposta à pergunta pendente. Limites locais de sincronização concorrente, teto de fóruns, edição Sheets e runtime PDF hospedado estão explicitados nos documentos da etapa e permanecem no plano.

Depois: fechar o lote de publicação/hosting em `docs/LOTE-IMPLANTACAO.md`, autenticar no novo alvo por superfície protegida, respeitar aprovação específica exigida pela matriz, implantar e provar Auth/MCP real antes de importar dados privados. Provas reais de Google, renovação Moodle, smartphone/nova conversa, delta final de migração e virada continuam no escopo; não declarar produto finalizado com esses gates omitidos.

## Retomada sem chat

Não há transação externa incerta nem recorrência ativa. Container/bancos são exclusivos do AraHub; servidor local pelos comandos do README. Demo sintética usa outro dono que a importação privada; destino local está em `.private/local-owner.json`. METD/staging/curadoria e backups continuam privados e disponíveis. Capturas somente por retorno nativo/bytes fora da interface; nunca usar download/Salvar como/data/blob para imagens, inclusive em handoffs de navegador.
