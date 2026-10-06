# Estado do AraHub

Atualizado: 2026-10-06. Branch main; código MIT/Pages publicados e backend Supabase implantado. **Produto completo A01–A30 ainda não entregue.** Este checkpoint substitui o histórico do chat.

## Mandato e autorizações

Executar até limites reais da sessão/ferramentas/permissões, sem parar ao concluir uma fatia. Requisitos e provas em docs/ACEITE.md; consultar a especificação pertinente do bootstrap privado. Engenharia/local/sintéticos autorizados; fontes e projetos irmãos somente leitura. Dados/credenciais/bootstrap ficam fora do Git.

Decisões do titular: projeto AraHub (maiúsculas), conta institucional nova/organização Universidade de Lisboa, Free/São Paulo; repositório público MIT; GitHub Pages para interface, Supabase para Auth/banco/API. Interface auxiliar mínima reproduz AraLearn MIT: largura até 430 px inclusive no desktop, ícones com nomes acessíveis, mínimo texto de bastidor.

Lotes já aprovados: provisionamento/schema/isolamento sintético; publicação MIT/Pages/backend próprio; importação privada de 57 arquivos/109 registros; app Google exclusivo e leitura da conta institucional; plugin pessoal/Skill e MCP. Não pedir novamente login CLI, senha de banco, aprovação desses lotes ou planilha inexistente.

Não aprovados: escritas acadêmicas reais, escopos Google de escrita, cron/recorrência, virada/alteração do METD, segunda conta ainda não identificada, faturamento/cartão/trial/aumento de cotas/permissões. A ausência do titular não amplia consentimentos. Não há transação externa incerta ou recorrência ativa.

## Implementação e prova local

- Fundação: onze migrations, RLS/FORCE/FKs por dono/conexão, deltas idempotentes/versionados e controle de concorrência; MCP Streamable HTTP com assinatura/emissor/audience/client ID/sessão ativa. Isolamento de dois donos, recusas e busca/exportação testados.
- Instalação nova: cache Deno começou vazio, lock congelado e byte-idêntico, onze migrations em banco único; SDK MCP HTTP gravou/recuperou, retry conservou recibo e donos ficaram isolados. Manifesto em .private/fresh-install/2026-10-06T05-32-09-641Z-bb14feea/evidence/fresh-install.json. Gate deno task validation:fresh; 4.604 arquivos/105.201.967 bytes de cache. Não equivale a OS novo ou Auth real.
- Memória: preferências contextuais com vigência/superação/retirada/conflitos; IANA/DST/precisão temporal; memória antes do refresh. Alvo ativo por versão/ambiguidades, relato de entrega sem falsa confirmação e comparação por rascunho/observação Moodle qualificada. SQL/SDK testados; provas acadêmicas atuais específicas continuam pendentes.
- Moodle: transporte DNS/TLS fixado e 16 funções auditadas; curso/conteúdos/fóruns/Feedback/material. Checkpoints retomam discussões/posts após reinício/esgotamento, sem corte permanente de 50 fóruns/páginas. Lease/fencing por chave e reordenação testados; credencial não renova sozinha. Prova real local de leitura e JPEG 52.017 bytes; token de prova revogado. Renovação/IP hospedados e segunda instalação reais pendentes.
- Google: identidade/sub verificados, OAuth incremental vinculado à sessão, seleção de conta, capacidades desejadas/concedidas/negadas, cofre AES-GCM/CAS/epoch, paginação e sync Gmail/Calendar/Drive duráveis. Lease/fencing, historyId decimal exato, cursor expirado/reconstrução delimitada, limites/continuação testados sinteticamente.
- Produção Google: preparar/aprovar/executar operações nativas fixadas; autoridade SQL humana, hash/revisão sob lock, aprovação expira/consumo único e incerto antes do POST; Data API apenas SELECT nas ações. Criar Docs/Sheets/Slides, inserir texto Docs, substituir texto selecionado Slides. Agora planilha nova com células tipadas/fórmulas locais e novo slide/caixa/texto, IDs/geometria/revisão conferidos; prévia integral por endereço/tipo e texto/posição. Edição de células existentes continua pendente por ausência de precondição nativa atômica. Nenhuma escrita Google real.
- PDF: bytes/hash/texto por página, merge sob lock e retomada/cliente novo. PDF acadêmico real 2.215.244 bytes/15 páginas comprovado localmente por HTTP/SQL/SDK. Edge não oferece worker terminável; parser nessa thread é recusado. Worker navegador implementado/implantado, cancelamento/CPU síncrona/hash divergente testados. Sem OCR/interpretação de imagens; origem browser_client não corroborada pelo servidor.
- UI copiada de snapshot MIT AraLearn com atribuição, clara/escura, coluna até 430 px, botões por ícones ≥44 px. Chrome operou acesso/conexões/renovação/revisão/temas/exportação/saída em 390×844 e 1280×900; capturas nativas inspecionadas, sem overflow/erro. HTTP/Auth fixtures nesses ensaios; não prova celular físico.

## Implantação e provas reais

Interface: https://fabio-ara.github.io/AraHub/ ; código: https://github.com/fabio-ara/AraHub . Inscrições públicas fechadas; cada instalação MIT mantém seus dados privados. Pages usa workflow manual com actions fixadas por SHA, assets/licenças MIT/Apache-2.0/subpath/CSP/referrer/callbacks físicos. Somente artefatos públicos vão a CI.

Supabase AraHub Free/NANO/São Paulo, spend cap/sem cartão e cotas conferidas; alvo/configuração/cofre protegidos em .private/cloud. Onze migrations/hashes e event trigger de RLS reconferidos, zero avisos SQL restantes. Sem config push global. Gateway encaminha prefixo exato; aplicação mantém JWT/client ID/sessão/CORS mesmo com --no-verify-jwt do gateway.

Prova HTTPS: 32 verificações aprovadas com dois usuários temporários no Auth nativo, autorização-code/PKCE, SDK MCP, retry/isolamento/exportação e sessão revogada; UI hospedada consentiu e extraiu PDF sintético em dois viewports. Limpeza dirigida removeu usuários/cliente de teste, preservando titular. Evidência .private/evidence/hosted-3d29dd39-053f-4add-b561-56c8fe1931b9.json e hosted-ui-pdf-result.json/hosted-consent-result.json; contexto em .private/cloud/CHECKPOINT.json.

Titular confirmou e-mail, entrou, consentiu MCP e conectou Primary. CLI 2.119.0 autenticado com home exclusivo .private/supabase-cli; não usar conector Supabase antigo que não acessa o projeto. Fallback signup_disabled→resend nativo com PKCE corrigido/testado; mensagem duplicada de autorizações corrigida e conferida na conta titular.

Importação privada aprovada/concluída: origem METD HEAD fixado e remoto sem delta; 57 arquivos originais/hashes (584.161 bytes/11.114 linhas), 109 registros curados, nove contextos/166 entidades. Ferramenta MCP pessoal recuperou todos os registros/arquivos/proveniência; evidências native-plugin-import-retrieval.json e PENDING-IMPORT.json privados. O contexto sintético móvel posterior é separado dos nove importados.

Snapshot pós-Google restaurado em banco local novo: onze tabelas/fingerprints, 57 binários/hashes, RLS e segundo dono. Credencial Google cifrada versão 2 tem backup separado. Não prova restauração do serviço Auth Supabase. Manifestos/caminhos em .private/cloud/CHECKPOINT.json; preservar configuração/chave do cofre.

App Google próprio exclusivo Externo/Testing, seis APIs/cotas conferidas, sem faturamento/trial/aumento. Callback Pages e OAuth Web exatos, segredo somente backend/cofre. Titular fez login/Termos/consentimento. Conexão institucional possui identidade + Gmail/Calendar/Drive readonly; Drive cobre leitura nativa Docs/Sheets/Slides. Aliases OIDC normalizados e resposta original preservada; escritas desativadas. Testing pode exigir reconsentimento em sete dias, sem garantia de operação permanente.

Leituras reais: conversa ChatGPT nova e MCP pessoal leram Gmail/Drive duas páginas de três itens sem duplicação (parciais), Calendar três calendários; documento uma aba/apresentação 13 slides/mensagem/eventos nativos. Refresh CAS 1→2 comprovado após alteração guardada somente da expiração do cache. Calendar inicial→incremental com cursor durável em janela de cinco minutos sem eventos. Não prova alteração real/falha/reconstrução. Nenhuma planilha nativa existente; titular confirmou ausência. Evidências google-chatgpt-first-reads.json, google-refresh-native-proof.json, google-hosted-settings-check.json, google-calendar-sync-native-proof.json e google-pagination-native-proof.json.

Plugin/Skill pessoal 1.0.3 instalado: ID/nome técnico/apelido/required conferidos no cadastro real, quatro entradas/hashes ZIP e quatro testes aprovados. Recusas anteriores por ID/nome preservadas. Upload manual humano resolveu recusa de pasta da ferramenta, sem ampliar acesso. Conversa nova via Testar no chat recuperou dois cenários afetados sem inserir orientação no prompt e relatou skills__read/context/history/search; atividade/resultado conferidos. Corpo bruto do streaming indisponível: prova pelo cliente, não trace completo. Identidade/recibos em personal-plugin-package.json/personal-plugin-existing-identity.json e a26-installed-skill-proof.json privados.

Revisão A26: dez cenários reais/34 referências cobertas, oito aprovados inicialmente; dois corrigidos/repetidos com Skill instalada, conservando marco/valor, granularidade temporal, contribuições/debate/consenso/fechamento e incerteza de versão final. Preferências legadas e virada têm gates próprios.

## Validação corrente e execução seguinte

Gate integrado PDF anterior: 202 aprovados/0 falhas (4m31s), evidência preservada. Depois: Google 88 testes dirigidos distintos, três testes Pages/QA dois viewports; HTTP/temporal/leases/importador dirigidos; onze migrations novas/32 HTTPS; plugin quatro testes/cliente real. Scan anterior: 131 arquivos/zero achados. Não repetir suítes caras cuja evidência permaneça válida.

Fatia atual de produção/conteúdo: 21 testes dirigidos aprovados (13 autoridade SQL, três executores/esquema, dois prévia e três Pages), check raiz dirigido/web e bundle. Chrome dois viewports aprovou revisão de toda a planilha/slide, gating do checkbox/hash e texto hostil sem execução; capturas atuais em .private/evidence/ui/. Um seletor .card incorreto no roteiro foi corrigido para .panel antes do ensaio aprovado; não conta como falha do produto.

Próximo passo: finalizar check Edge/diff/scan/commit e implantar/publicar a fatia atual dentro do lote existente. Produção Google real fica aguardando autorização/consentimento/revisão humana conforme docs/LOTE-GOOGLE-ESCRITA.md, já preparado com três recursos sintéticos/cinco escritas fixadas. Não chamar APIs de escrita ou ampliar scopes enquanto titular dorme.

Trabalho paralelo ativo: medição A30 por tentativa de job (duração/chamadas/memória compartilhada amostrada), em adaptadores/sync/jobs e docs/OPERACAO.md. Integrar após revisão e testes; não implantar código parcial do agente. Cache vazio A01 já integrado/revisado, sem repetir gate.

Pendências humanas/externas: celular físico A28/A29 (contexto sintético/roteiro enviados; .private/evidence/mobile-gate-prepared.json; aguardar resposta e conferir delta/recuperação web); segunda conta Google/renovação Moodle reais; OAuth/write/content approvals Google; autorização específica de virada METD. Continuidade autônoma deve avançar nas demais lacunas de implementação/aceite, não reduzir a matriz nem encerrar por essas pendências.

## Retomada sem este chat

Leia este arquivo, Git e documentos da etapa. Configuração/autorizações/IDs/evidência operacional em .private/cloud/CHECKPOINT.json; bootstrap privado conserva contrato, docs/ACEITE.md conserva gates. Bancos de instalação/restore/staging e snapshots têm nomes únicos e foram preservados. Servidor local/comandos no README; fontes irmãs intactas. Não importar fixtures no domínio privado real ou trocar chaves do cofre.

Capturas somente retorno nativo/bytes gravados fora da UI; proibidos download/Salvar como/data/blob ou preferências para imagens, inclusive nos handoffs. Não transportar dados/credenciais privados para logs/agentes/Git/CI. Em limite de sessão, persistir checkpoint factual, sem declarar produto acabado ou prometer execução sem chamada ativa.
