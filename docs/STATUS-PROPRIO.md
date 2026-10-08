# Consulta do status da própria entrega

Implementação opt-in e desativada por padrão. Não remove o bloqueio geral de
`mod_assign_get_submission_status` nem libera funções de notas. Somente o método
restrito do adaptador pode chamar essa função após verificar consentimento,
inscrição no curso e configuração individual da atividade. `userid=0` e
`groupid=0` são fixos; o resultado expõe apenas a própria tentativa.

A consulta pode criar linha técnica vazia, registrar feedback visto e logs.
No Lab auditado, duas consultas não mudaram notas. Isso não demonstra ausência
de efeitos internos em outras versões ou plugins. A política não autoriza
upload, fórum, submissão, teste institucional ou alteração de nota.

A interface mostra conta, origem e efeitos; exige assentimento explícito e
envia a versão da política, época da credencial e último recibo revisado.
O servidor recusa principal MCP, sessão inativa, dono diferente, versão antiga,
credencial renovada e decisão concorrente. Os recibos são append-only em tabela
privada, sem grants para Data API, com RLS/FORCE. Revogar ou renovar não apaga
decisões anteriores. Apagar a conta mantém a política existente de cascata.

Leituras autorizadas seguram lock compartilhado da conexão durante a chamada
limitada do provedor. Revogação e renovação usam lock exclusivo: aguardam uma
consulta já despachada e bloqueiam as posteriores. Uma chamada em andamento não
pode ter seus efeitos institucionais desfeitos pelo AraHub.

Preparação operacional: aplicar a migration de consentimento e publicar backend
e UI com `ARAHUB_OWN_STATUS_POLICY_ENABLED` ausente/false. A ativação específica
usa `true` no ambiente protegido, seguida de consentimento na própria interface.
Nenhum argumento MCP ou preferência inferida habilita a política. A ferramenta
`hub_moodle_own_submission_status` só é oferecida quando a implantação habilita
o recurso e informa `readOnlyHint:false` por causa dos efeitos incidentais.

Antes de ativar, incluir a tabela privada de consentimentos no backup hospedado
e conferir a migration adicional. O backup local por pg_dump já cobre todas as
tabelas do schema privado, suas políticas e grants. Um snapshot antigo de 14
migrations não comprova restauração desta implementação de 15 migrations.

Testes: `tests/own_submission_status_test.ts` cobre autoridade, isolamento,
revogação, concorrência, renovação, Data API, grupos, escopo próprio e cliente SDK.
Prova de navegador com identidade assinada sintética e consulta efetiva do Moodle
Lab permanece separada da prova hospedada e da leitura institucional. Publicar
código desativado não comprova nem autoriza essas duas verificações.
