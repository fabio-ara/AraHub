# Preferências contextuais

Uma preferência é um delta auditável. `hub_record_delta` aceita opcionalmente `preference` com `key`, `state` (`active` ou `withdrawn`), `supersedes` (IDs anteriores), `valid_from` e `valid_until` (instantes ISO com fuso). O escopo continua no campo `scope`. A chave identifica a dimensão declarada pelo usuário; não deve ser inventada para resolver textos ambíguos.

Superação exige `evidence_kind=user_report`, mesmo contexto, mesmo escopo e chave compatível. O alvo precisa ser uma preferência anterior do mesmo proprietário. Um evento legado sem chave pode ser explicitamente identificado e superado. A gravação preserva o alvo, aplica controle de versão do contexto e mantém retry idempotente. Uma retirada precisa identificar seus alvos e não tem fim automático.

`hub_preferences(scope, at?)` retorna vigência no instante solicitado, histórico, hipóteses para revisão, superações e conflitos. Uma preferência explícita mais específica pode reger aquele contexto: uma regra de fórum não substitui a regra de artigo. Escopos incomparáveis ou duas regras máximas da mesma dimensão geram conflito, sem escolher a mais recente. A instrução explícita da tarefa atual permanece prioritária e nenhuma preferência altera políticas de segurança.

Uma revisão agendada só supera seus alvos ao entrar em vigor. Quando a revisão expira, os alvos explicitamente superados permanecem históricos; uma regra geral independente pode voltar a ser aplicável. Hipóteses e interpretações não superam regras explícitas. Preferências legadas sem chave aparecem com `legacy_requires_review` no histórico
e em review_required, nunca em applicable. Seu texto exige avaliação contextual,
sem vigência presumida por recência. Objetivos datados, convenções operacionais e
fronteiras de autorização podem ter sido classificados como preferências na
origem; recuperar esses textos não os transforma em regras atuais.

O retorno resolve até 200 eventos pertinentes. Acima disso declara cobertura parcial e não confirma regras aplicáveis; o histórico por contexto é paginado por `hub_history`. Não se trata de remoção de conteúdo. Textos, fontes e os metadados de vigência permanecem na exportação privada.

Provas locais: SQL real com dois donos, revisão futura/expiração/retirada, conflito, escopo mais específico, hipótese, alvo estrangeiro, validação de insert direto e retry. Um cliente MCP SDK por HTTP também registra, recupera e retira a regra. Identidade e dados dessas provas são sintéticos; uso em conversa e destino hospedado continuam pendentes.

Revisão privada das 21 preferências legadas separou escopo editorial, objetivos
históricos e fronteiras de evidência/segurança/autorização. Propostas e fontes
ficam fora do Git; nenhuma política hospedada foi promovida ou reescrita.
A instrução atual explícita conserva prioridade e a virada tem autorização própria.
