# Fontes oficiais e critério de consulta

Consulta para os guias da linha 0.3: **22 de outubro de 2026**. Políticas de serviço,
limites e interfaces externas podem mudar; confira a fonte antes de uma nova
implantação. Os contratos do AraHub devem ser verificados também no código e nos
testes da versão em uso.

| Fonte primária | Uso nesta documentação |
| --- | --- |
| [Supabase — pausa de projetos](https://supabase.com/docs/guides/platform/free-project-pausing) | Inatividade, retomada e diferença entre Free e planos pagos. A janela documentada difere de alguns avisos por e-mail; o guia de operação registra essa divergência. |
| [Supabase — preparação para produção](https://supabase.com/docs/guides/platform/going-into-prod) | Disponibilidade e requisitos operacionais. |
| [Supabase — cobrança](https://supabase.com/docs/guides/platform/billing-on-supabase) | Plano da organização e distinção de itens de consumo. |
| [Supabase — SMTP](https://supabase.com/docs/guides/auth/auth-smtp) | Restrições do envio padrão e configuração de entrega própria. |
| [Supabase — acesso por e-mail](https://supabase.com/docs/guides/auth/auth-email-passwordless) | Link, OTP e criação de usuário. |
| [Supabase — fluxo PKCE](https://supabase.com/docs/guides/auth/sessions/pkce-flow) | Vínculo entre início e retorno do login. |
| [Supabase — URLs de retorno](https://supabase.com/docs/guides/auth/redirect-urls) | Configuração de site e callbacks. |
| [Supabase — OAuth com clientes](https://supabase.com/docs/guides/auth/social-login) | Provedores sociais como identidade. |
| [Supabase — RLS](https://supabase.com/docs/guides/database/postgres/row-level-security) | Segurança por linha e restrição por dono. |
| [Supabase — CLI](https://supabase.com/docs/reference/cli/introduction) | Descoberta de comandos de migration e implantação. |
| [PostgreSQL — CREATE VIEW](https://www.postgresql.org/docs/17/sql-createview.html) | Leitura com privilégios e políticas do invocador. |
| [PostgreSQL — constraints](https://www.postgresql.org/docs/17/ddl-constraints.html) | Integridade e chaves estrangeiras entre referências e conteúdos. |
| [Brevo — plano gratuito](https://help.brevo.com/hc/en-us/articles/208580669-FAQs-What-are-the-limits-of-the-Free-plan) | Alternativa de envio com limite diário, sujeita à validação da conta. |
| [Brevo — domínio de envio](https://help.brevo.com/hc/en-us/articles/35852083084178-Domain-setup-for-better-email-deliverability) | Remetente, autenticação de domínio e limitações sem domínio próprio. |

## Mudanças externas conferidas

O [changelog da Supabase](https://supabase.com/changelog) foi consultado antes da
implementação. Dois avisos merecem registro operacional: a
[retirada de cifras TLS antigas](https://supabase.com/changelog/cbc-tls-ciphers-deprecated)
prevê impacto em clientes antigos a partir de novembro de 2026; a atualização
[PostgreSQL 15.19/17.11](https://supabase.com/changelog/postgres-15-19-17-11-breaking-changes)
descreve cuidados com extensões e cifras PGP antigas. O cofre do AraHub usa seu
contrato de criptografia autenticada; não se deve inferir necessidade de alterar
o cofre apenas pela palavra `pgcrypto` nesse aviso.

A [mudança em templates de e-mail Free](https://supabase.com/changelog/46599-changes-to-email-template-customisation-on-free-tier)
reforça a necessidade de conferir o regime de envio efetivo da instalação. Não
presuma que uma configuração mostrada em um tutorial antigo esteja disponível
sem SMTP próprio.

## Fontes internas e históricas

[FONTES](FONTES.md) conserva a investigação inicial. Os documentos de lote e
validação são evidências datadas da evolução do AraHub; não são documentação de
terceiros nem prova automática do estado atual. O
[inventário](inventario-documentacao.md) identifica seus papéis.
