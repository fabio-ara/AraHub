# Checkpoint de validação local

Data: 2026-10-05. Código anterior: `d3dba5f`; integração anterior: `f11125e`; fundação anterior: `b6d28a7`. Commits somente locais, sem remoto Git configurado ou publicação. Resultado é uma etapa de implementação; A01–A30 não estão concluídos.

| Verificação executada | Resultado | Limite da evidência |
|---|---|---|
| `deno task check`, `edge:check`, `web:check` | Aprovados | TypeScript não comprova runtime hospedado |
| `deno task web:build` | Bundle de 226,12 KiB gerado | Saída ignorada; bundler Deno ainda experimental |
| `deno task test` | 125 aprovados, 0 falhas | Postgres/HTTP/SDK reais locais; identidades e provedores sintéticos salvo provas separadas |
| `deno fmt --check` em código/scripts/testes/web/entry Edge | 54 arquivos aprovados | Formatação sem mudança de comportamento |
| `deno task validation:clean` | 8 migrations em banco novo; dois donos/RLS/retry | SQL local limpo; cache de dependências e implantação limpa não testados |
| Regressão privada A26 | 4 aprovados, 0 falhas; 10 cenários ancorados nas fontes | Não é avaliação completa da qualidade semântica das respostas |
| `deno task migration:import` repetido | 57 arquivos; 0 registros novos, 109 reutilizados | Staging/destino privado local; sem virada |
| `deno task migration:validate` | 109 registros/trechos/commit recuperados por cliente MCP novo; documento bruto legível | Dados reais privados, OAuth/transportes locais sintéticos |
| `deno task backup:local` | 11 tabelas, binários, políticas RLS e grants conferidos após restore; dump 932.555 bytes | Banco novo no container exclusivo; chaves do cofre têm backup separado |
| Leitura Moodle com transporte fixado | Conta/instância reais, 16 funções permitidas; arquivo de 22.077 bytes | Somente leitura; IP hospedado e segundo Moodle não comprovados |
| Serviço/material/SDK Moodle | JPEG real de 52.017 bytes preservado, retry/id/sha/isolamento; credencial de prova revogada | Não extraiu texto da imagem, não comprovou PDF ou leitura de binário pelo assistente |
| UI local | Base desktop/viewport móvel inspecionada; entrada/exportação/saída operadas; sem overflow 390×844 | Novos formulários só DOM/layout medido: captura sem retorno/raiz recusada, controle alternativo indisponível; smartphone pendente |
| Skill e manifesto | Validador da Skill aprovado; propriedades dos schemas oficiais conferidas | Plugin não instalado nem chamado em conversa real |
| Git/exclusões | ZIP/bootstrap/dados/credenciais ignorados; scan do índice/histórico: 0 achados heurísticos | Revisão manual pública feita; heurística não equivale a auditoria completa de segredos |

O projeto AraHub Free foi criado no alvo autorizado, com schema instalado; nenhuma conta OAuth Google, hosting da aplicação, cron, escrita acadêmica ou API faturada foi criada/ativada. Fontes privadas e repositório técnico permanecem limpos e somente de leitura. O contrato completo, pendências locais e aprovações indispensáveis continuam em `STATUS.md`, `docs/ACEITE.md` e `docs/IMPLANTACAO.md`.

Evidências privadas: `.private/evidence/clean-install.json`, `import-retrieval.json`, `moodle-real-pinned.json`, `read_material_real.json`, relatórios da migração e manifestos em `.private/backups/`. Não enviar esses arquivos para Git/CI público. Bancos de instalação/restore foram criados com nomes únicos e preservados; nenhum alvo foi sobrescrito.

Etapa adicional: A09 passou com vigência, retirada, escopos incomparáveis, hipótese, idempotência e alvos estrangeiros; o cliente MCP SDK registra/consulta/retira preferências. `cloud:prove` passou em banco novo, conferindo oito hashes e recusa de reaplicação. No Supabase efetivo, os oito hashes canônicos coincidiram; RLS ativo/forçado e `verify_cloud_sql.sql` com dois donos sintéticos, FKs/cofre/anon/fronteira OAuth e rollback passaram. Prova hospedada somente SQL com claims sintéticos, sem cliente Auth/MCP real. Evidência em `.private/cloud/hosted-schema-evidence.json`; alvo privado não entra no Git.

Renovação Moodle: a prova HTTP/SQL com provedor sintético preservou conexão/histórico/cofre, recusou outra conta/origem e renewal em voo após desconexão. Data API não pode alterar identidade/origem/escopos/epoch da conexão; migration `20261005234111` aplicada localmente e no projeto autorizado, com hash conferido. Uma negação de callback Google antigo não invalida pendência mais recente. O gate completo passou com 125 testes; novas mudanças no formulário têm TypeScript/bundle aprovados, mas operação e QA visual/real permanecem pendentes.
