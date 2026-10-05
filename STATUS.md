# Estado do AraHub

Atualizado: 2026-10-05. Branch: main. Fundação local validada; integrações em revisão.

## Objetivo corrente

Implementar fundação executável e adaptar fontes; preparar migração local privada sem declarar virada nem implantação.

## Estado comprovado

- Pacote extraído sem sobrescrita; 20 hashes válidos.
- Git inicializado; ZIP, bootstrap, `.private/`, `.env` e credenciais confirmados por `git check-ignore`.
- Auditoria inicial e plano em `docs/PLANO.md`; fontes privadas fixadas em `.private/`.
- Docker, Deno e GitHub autenticado disponíveis. Nenhuma escrita externa efetuada.
- Postgres exclusivo em `127.0.0.1:55432`; migrations aplicadas. RLS, FKs, deltas/concorrência, falha de refresh e reconciliação testadas com dados sintéticos.
- Cliente MCP SDK usado por HTTP local: descoberta, assinatura/claims sintéticos, gravação e retomada numa nova sessão.
- UI local inspecionada visualmente e operada em desktop e viewport 390×844. Isto não é teste no smartphone.
- Moodle: prova real local de leitura no adaptador independente; evidência privada. Endereço/IP hospedado não testado.
- Migração: staging e restore de 57 arquivos, curadoria de 109 registros; importação no Postgres local e retry sem duplicação. Não houve virada.

## Requisitos e evidências

Matriz A01–A30 em `docs/ACEITE.md`. Implementação e provas em andamento; não há implantação autorizada ou prova em cliente móvel.

## Aprovações e bloqueios

Engenharia, commits e staging locais autorizados. Provisionamento remoto, importação real hospedada, OAuth externo, recorrência e escrita externa dependem do alvo/escopo autorizado. Nenhuma credencial deve ser enviada no chat. Destinos particulares somente em `.private/`. O destino cloud e o app OAuth Google ainda não foram criados.

## Próximo passo executável

Continuar revisão de transportes/segredos, integrar recuperação de arquivos e sincronização; comprovar backup do banco em destino local limpo. Ler `docs/ACEITE.md` e a especificação pertinente. Gate: `deno task check`, `deno task web:check`, `deno task test`, `deno task secrets`.

## Últimos testes

`deno task test`: 71 aprovados/0 falhas (antes de revisão Google em curso). `deno task check` e `web:check` aprovados. Regressão privada A26: 4 aprovados. `git check-ignore` e scan do índice: caminhos privados excluídos, 0 achados heurísticos. Evidências reais em `.private/evidence/`.

## Retomada

Não repetir auditorias/testes cuja evidência permaneça válida. Não há transação externa incerta nem job recorrente ativado. Atualizar este checkpoint antes de encerrar.
