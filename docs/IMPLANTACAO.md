# Gate de implantação

O projeto **AraHub** foi criado no plano Free, em São Paulo, na nova conta autorizada. Sete migrations foram aplicadas pelo editor SQL autenticado, com histórico compatível com o CLI e hashes conferidos após normalização CRLF/LF. RLS ativo/forçado e isolamento SQL com dois donos sintéticos foram verificados; o rollback deixou zero usuários e contextos de aplicação. Alvo/conta e evidências ficam em `.private/cloud/`.

Hosting da aplicação, app OAuth Google e importação privada não foram autorizados neste lote. `supabase/functions/arahub/index.ts` continua candidato, validado por TypeScript e adaptação HTTP sintética. O projeto criado e a prova SQL não comprovam MCP hospedado, autenticação real de cliente ou virada.

## Pré-requisitos concretos

1. Projeto separado e Free aprovados/criados. O conector da sessão ainda pertence à conta anterior: não utilizá-lo para ampliar acesso ou modificar projetos irmãos. Para CLI/conector no novo alvo, autenticar por superfície protegida. Senhas ficaram sob gestão humana.
2. PostgreSQL padrão; Auth assimétrico e OAuth Server configurados com tela de consentimento. Audience e IDs dos clientes devem corresponder aos tokens efetivos; nenhum client ID é aceito por omissão. A UI de consentimento já usa métodos Supabase, mas precisa de endereço aprovado e prova real.
3. Configurar segredos por superfície protegida: database/pooler com TLS, issuer e vault AES-GCM de 256 bits. Publishable key pode ir ao browser; DB e vault nunca. Backup das chaves é separado da memória exportada.
4. Aplicar migrations e testar dois usuários no alvo real antes de importar qualquer dado. A fixture `scripts/local_identity.sql` é exclusivamente local e não é migration.
5. Endpoint candidato: `https://<project-ref>.supabase.co/functions/v1/arahub/mcp`; discovery no mesmo base path. O adaptador trata o prefixo do gateway. A UI é um componente complementar que ainda precisa de hospedagem/configuração; não afirmar que o MCP hospeda a interface.
6. Validar sessão revogada, token expirado, audience/client ID, discovery, consentimento e chamadas pelo cliente real. A API direta rejeita OAuth clients; o MCP aplica validação e usa transações com identidade confiável.
7. Medir duração/CPU/memória, TLS/Node compatibility e origem/IP Moodle no runtime. Só então lote de importação autorizado e teste de restauração no destino. Agendamentos têm aprovação própria de fonte/escopo/frequência.

Configurar a função com `verify_jwt=false` no gateway somente porque a assinatura/claims/sessão/client ID são verificados pelo próprio AraHub, permitindo discovery anônimo. Sem token válido, `/mcp` continua retornando 401. Essa configuração não dispensa a prova real nem autoriza ignorar autenticação. CLI e comandos remotos são descobertos por `--help` na etapa, nunca executados sem autorização correspondente.

## Virada

Reconsultar commit remoto da origem somente de leitura, curar delta se houver, reconciliar importação e validar nova conversa/arquivos. Ativar o cliente e verificar nova chamada no smartphone, delta e continuidade web. Registrar marco de corte e rollback. Até isso acontecer, a origem permanece referência operacional disponível.

## Pendências de produto

Google tem biblioteca própria, cofre, consentimento persistente ligado à sessão, rotas HTTP locais e leitura nativa pelo MCP. O ciclo HTTP → OAuth → MCP foi exercitado com assinaturas e transporte Google sintéticos. O gateway Edge preparado atende MCP/discovery; o roteamento remoto da interface e das APIs de conexão ainda precisa ser implementado e validado no alvo autorizado. Não basta criar credenciais.

Sincronização integrada cobre cursos Moodle; materiais registrados na estrutura podem ser preservados de forma dirigida. Conteúdo/deltas de todos os provedores, renovação guiada do token Moodle e recuperação automática de cursores continuam parciais. Escritas têm máquina de autorização/resultado incerto, mas não há autoridade humana persistente/executor real ativado. PDF/OCR, extração por página e resolução de contexto ativo permanecem pendentes. Preferências já têm vigência e superação explícitas (`docs/PREFERENCIAS.md`), com revisão dos registros legados e prova em conversa real pendentes. Nenhum requisito foi removido.

`deno task cloud:prepare` deriva um bundle privado dos arquivos de migration; não provisiona nem aplica remotamente. `cloud:prove` confere transação/hashes/recusa de reaplicação e a prova SQL sintética em banco local novo. `scripts/verify_cloud_sql.sql` usa os papéis e funções Auth efetivos no alvo, com claims sintéticos e rollback; não enviar `scripts/local_identity.sql` ao Supabase. Fontes do registro: [CLI v2.119.0](https://github.com/supabase/cli/blob/v2.119.0/apps/cli-go/pkg/migration/history.go) e [migrations oficiais](https://supabase.com/docs/guides/deployment/database-migrations). Novas mudanças continuam em migrations versionadas; não reaplicar o bundle de instalação.
