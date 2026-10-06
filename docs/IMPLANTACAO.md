# Gate de implantação

O projeto **AraHub** foi criado no plano Free, em São Paulo, na nova conta autorizada. Oito migrations foram aplicadas pelo editor SQL autenticado, com histórico compatível com o CLI e hashes conferidos após normalização CRLF/LF. RLS ativo/forçado e isolamento SQL com dois donos sintéticos foram verificados; o rollback deixou zero usuários e contextos de aplicação. Alvo/conta e evidências ficam em `.private/cloud/`.

Hosting do backend, app OAuth Google e importação privada não foram autorizados neste lote. A interface pública MIT tem destino fixado em GitHub Pages, com pacote estático preparado localmente e ainda não publicado. `supabase/functions/arahub/index.ts` continua candidato, validado por TypeScript e adaptação HTTP sintética. O projeto criado e a prova SQL não comprovam MCP hospedado, autenticação real de cliente ou virada.

## Pré-requisitos concretos

1. Projeto separado e Free aprovados/criados. O conector pertence à conta anterior: não utilizar para ampliar acesso ou modificar irmãos. CLI autenticado por login protegido, com home exclusivo e keyring global desativado; projeto/registro reconferidos por leitura. A Edge usa SUPABASE_DB_URL injetada pelo provedor; não pedir a senha de banco por rotina. DATABASE_URL explícita serve a um pooler escolhido quando necessário. Alterar somente configurações Auth do lote, sem config push global.
2. PostgreSQL padrão; Auth assimétrico e OAuth Server configurados com tela de consentimento. Audience e IDs dos clientes devem corresponder aos tokens efetivos; nenhum client ID é aceito por omissão. A UI de consentimento já usa métodos Supabase, mas precisa de endereço aprovado e prova real.
3. Configurar segredos por superfície protegida: database/pooler com TLS, issuer e vault AES-GCM de 256 bits. Publishable key pode ir ao browser; DB e vault nunca. Backup das chaves é separado da memória exportada.
4. Aplicar migrations e testar dois usuários no alvo real antes de importar qualquer dado. A fixture `scripts/local_identity.sql` é exclusivamente local e não é migration.
5. Endpoint candidato: `https://<project-ref>.supabase.co/functions/v1/arahub/mcp`; discovery no mesmo base path. O adaptador trata o prefixo do gateway. A UI é um componente complementar servido como pacote estático MIT em GitHub Pages, com URL própria; não afirmar que o MCP hospeda a interface.
6. Validar sessão revogada, token expirado, audience/client ID, discovery, consentimento e chamadas pelo cliente real. A API direta rejeita OAuth clients; o MCP aplica validação e usa transações com identidade confiável.
7. Medir duração/CPU/memória, TLS/Node compatibility e origem/IP Moodle no runtime. Só então lote de importação autorizado e teste de restauração no destino. Agendamentos têm aprovação própria de fonte/escopo/frequência.

Configurar a função com `verify_jwt=false` no gateway somente porque a assinatura/claims/sessão/client ID são verificados pelo próprio AraHub, permitindo discovery anônimo. Sem token válido, `/mcp` continua retornando 401. Essa configuração não dispensa a prova real nem autoriza ignorar autenticação. CLI e comandos remotos são descobertos por `--help` na etapa, nunca executados sem autorização correspondente.

## Interface pública (GitHub Pages)

A interface MIT será publicada como pacote estático em GitHub Pages, no subpath de projeto (`https://<conta>.github.io/AraHub/`). GitHub Pages não aceita cabeçalhos HTTP customizados, então CSP e `referrer` viajam em `<meta>` no próprio HTML; `frame-ancestors` fica de fora porque o navegador ignora esse diretivo em meta, e a defesa de enquadramento é o frameguard do app (`window.top !== window.self`). As rotas `oauth/consent`, `oauth/google/callback` e `oauth/callback` são cópias físicas de `index.html`, e o `.nojekyll` desliga o Jekyll. O pacote é gerado por `deno task ui:prepare <base-api> <origem-supabase> <URL-da-UI>` em diretório novo de `.private/deploy/`, com manifesto/hashes fora dos assets e sem credenciais, e não contata provedor nem publica. Configure `UI_URL` como base completa terminada em `/` e `UI_ORIGIN` como origem sem caminho. Os callbacks Auth/Google incluem o subpath e precisam de prova real, inclusive o redirecionamento para barras finais do Pages.

## Virada

Reconsultar commit remoto da origem somente de leitura, curar delta se houver, reconciliar importação e validar nova conversa/arquivos. Ativar o cliente e verificar nova chamada no smartphone, delta e continuidade web. Registrar marco de corte e rollback. Até isso acontecer, a origem permanece referência operacional disponível.

## Pendências de produto

Google tem biblioteca própria, cofre, consentimento persistente ligado à sessão, rotas HTTP locais e leitura nativa pelo MCP. O ciclo HTTP → OAuth → MCP foi exercitado com assinaturas e transporte Google sintéticos. O gateway Edge preparado atende MCP/discovery; a publicação da interface e o roteamento remoto das APIs de conexão ainda precisam ser validados no alvo autorizado. Não basta criar credenciais.

Sincronização preserva conteúdo/hierarquia Moodle e leituras Google; checkpoints, continuação e leases descritos nos documentos específicos, sem prova de tenant real. Renovação Moodle passou na API/SQL e no formulário local/HTTPS com fixtures e inspeção visual; conta real/IP remoto pendentes. Autoridade persistente e executor Docs/Slides/Sheets-create testados com SQL/provedor sintético; nenhuma escrita externa. PDF acadêmico real de 15 páginas passou por HTTP/MCP local/cliente novo; o Supabase Edge não oferece Worker terminável, então o parse na Edge permanece indisponível, mas a rota cliente foi implementada em worker terminável do navegador, com gravação HTTP/SQL e recuperação MCP locais comprovadas. Não habilitar thread principal por flag nem declarar A23 entregue. Contexto/alvos/relato e preferências com vigência/superação implementados. Conversa real, revisão semântica legada e virada permanecem no escopo.

`deno task cloud:prepare` deriva um bundle privado dos arquivos de migration; não provisiona nem aplica remotamente. `cloud:prove` confere transação/hashes/recusa de reaplicação e a prova SQL sintética em banco local novo. `scripts/verify_cloud_sql.sql` usa os papéis e funções Auth efetivos no alvo, com claims sintéticos e rollback; não enviar `scripts/local_identity.sql` ao Supabase. Fontes do registro: [CLI v2.119.0](https://github.com/supabase/cli/blob/v2.119.0/apps/cli-go/pkg/migration/history.go) e [migrations oficiais](https://supabase.com/docs/guides/deployment/database-migrations). Novas mudanças continuam em migrations versionadas; não reaplicar o bundle de instalação.

Conexão Edge: o entrypoint prefere DATABASE_URL explícita e usa SUPABASE_DB_URL protegida como reserva. O provedor injeta essa variável: [segredos padrão oficiais](https://supabase.com/docs/guides/functions/secrets#default-secrets). Isso prepara a implantação sem solicitar novamente a senha humana; conexão/TLS no runtime ainda exigem prova hospedada.
