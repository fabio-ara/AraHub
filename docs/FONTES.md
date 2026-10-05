# Auditoria de fontes e ferramentas

Data de referência: 2026-10-05. Pacote privado: manifesto/hash de 20 arquivos válidos; sem credenciais copiadas. Git local criado após as exclusões; bootstrap e dados privados não são documentação distribuída.

Fonte técnica Moodle: commit `5669eee7072e6833cd3ee5f25ac63c463d7fdfbd`, árvore limpa na auditoria. Não há LICENSE rastreada; reaproveitamento de contratos e conclusões, implementação independente. O relatório anterior não conta como teste executado nesta sessão. A allowlist preserva exclusões de recálculo de notas/submissão.

Memória de origem fixada e evidenciada exclusivamente em `.private/`; não há modificação da origem. Inventário e curadoria têm localizadores de origem, hash, commit e linhas; links não contam como destinos lidos.

Ferramentas observadas: Deno 2.9.3, Node 24.14.0, Docker Server 29.8.2, GitHub CLI autenticado; Supabase CLI 2.119.0 invocado com versão exata. Nenhum recurso remoto criado. SDK MCP 1.31.0 fixado: a 1.32.1 foi recusada pela proteção de idade das dependências, que permanece ativa.

Fontes primárias revalidadas:

- [Supabase changelog](https://supabase.com/changelog): deprecação recente dos adapters de frameworks não afeta o servidor Deno com Fetch handlers.
- [OAuth Server/MCP](https://supabase.com/docs/guides/auth/oauth-server/mcp-authentication) e [segurança dos tokens](https://supabase.com/docs/guides/auth/oauth-server/token-security): separar scopes de identidade e acesso operacional; vincular client ID e testar tokens reais antes de ativação.
- [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security): políticas por owner + FK composta; role privilegiada não substitui isolamento de backend.
- [Runtime](https://supabase.com/docs/guides/functions/limits): lotes limitados; medição local não comprova limites do runtime hospedado.
- [MCP SDK oficial](https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x): transporte Web Standard e cliente SDK, com versão efetivamente instalada testada. Não adotar silenciosamente protocolo latest diferente do suportado pelo cliente.
- [Empacotamento de plugin](https://developers.openai.com/plugins/build/plugins): portable `plugin.json`, `mcp.json`, `skills/`; formato não comprova instalação nem nova chamada móvel.

Incertezas remanescentes: plano/quota/titularidade do destino separado, configuração OAuth Google/Workspace e audience/client ID reais, suporte da superfície móvel e armazenamento/execução remotos. Critério da auditoria inicial atingido: contratos e limites suficientes para fundação; gates externos continuam pendentes.
