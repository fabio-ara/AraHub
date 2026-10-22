# Guia do desenvolvedor

O código está organizado por responsabilidades de domínio, transporte e
apresentação. O objetivo é acrescentar comportamento completo sem tornar a
instalação dependente de uma pessoa ou instituição específica.

## Mapa do código

| Local | Responsabilidade |
| --- | --- |
| `src/domain.ts` | Contextos, deltas, entidades, arquivos, exportação e uso. |
| `src/http.ts`, `src/edge.ts` | APIs HTTP, configuração pública e adaptação ao gateway. |
| `src/auth.ts`, `src/db.ts` | Verificação de identidade e transações sujeitas a RLS. |
| `src/login_config.ts` | Configuração validada dos métodos de entrada apresentados. |
| `src/mcp.ts` | Ferramentas MCP e seus contratos de entrada/saída. |
| `src/connections.ts`, `src/adapters/` | Ciclo de conexão, cofre, transporte e Moodle. |
| `src/materials.ts`, `src/artifacts.ts`, `src/importer.ts` | Caminhos de preservação que verificam e deduplicam binários. |
| `src/library.ts`, `src/material_transfer.ts` | Leitura e transferência limitada de arquivos preservados. |
| `src/work_context.ts`, `src/attention.ts` | Registro de acontecimentos e reconciliação da atenção. |
| `src/approval_store.ts`, `src/moodle_actions.ts` | Aprovações persistentes e execução externa. |
| `web/` | Interface, identidade no navegador, temas e processamento cliente. |
| `supabase/migrations/` | Evolução ordenada do banco e dos controles de acesso. |
| `scripts/`, `tests/` | Preparação, manutenção e verificação. |

O [mapa de arquitetura](arquitetura.md) explica as relações. Antes de alterar um
contrato, procure consumidores reais; uma referência de arquivo também pode ser
usada por biblioteca, extração, ações, MCP, backup e exportação.

## Ambiente e testes

Siga o [guia de instalação](guia-de-instalacao.md) para o banco local. Os testes
usam dados sintéticos e PostgreSQL real. Deno e dependências estão fixados; não
atualize o lock por conveniência durante uma correção sem avaliar a mudança.

```powershell
deno task check
deno task edge:check
deno task web:check
deno task web:build
deno task db:setup
deno task test
deno task docs:check
```

Use testes dirigidos durante a implementação e a regressão pertinente no gate de
entrega. A suíte contém casos opcionais de ASR que podem ser ignorados conforme
seus requisitos; registre isso. Não transforme uma falha de integração em sucesso
simplesmente substituindo o provedor por um stub.

`deno task validation:fresh` cria cache e banco novos e prova instalação com as
migrations atuais, cliente MCP HTTP, dois donos e recusas de autenticação. É uma
prova local, detalhada em [INSTALACAO](INSTALACAO.md). O workflow de verificação
executa tipos, bundle, banco, regressão e documentação no GitHub. A publicação
Pages é um workflow manual separado.

## Alterar persistência

Crie uma migration pelo CLI Supabase, depois de conferir sua ajuda. Mantenha
histórico aplicado imutável. Uma instalação existente precisa de atualização
incremental; instalação nova deve produzir o mesmo contrato final.

Tabelas expostas exigem RLS e grants explícitos. Políticas de dono usam a
identidade autenticada, e relações entre objetos devem incluir o proprietário.
Não use metadados editáveis pelo usuário como autoridade. Funções de manutenção
devem preferir `security invoker`; permissões maiores não são uma correção para
uma consulta feita sob o papel errado.

No armazenamento deduplicado, leitores de bytes usam `hub_file_contents`.
Escritores usam `hub_files` como área transacional e concluem com
`hub_compact_file`. Consultas que precisam bloquear metadados bloqueiam a tabela
base; uma view com `LEFT JOIN` não pode ser tratada como uma tabela atualizável
para todo tipo de `FOR UPDATE`. Teste concorrência, replay e hashes, além do caso
nominal.

## Alterar identidade e interface

Métodos de entrada são configuração. O cliente consulta `/api/config`; o Auth
real determina se o cadastro e o provedor são permitidos. Mantenha callbacks
exatos, preserve a solicitação de consentimento MCP e trate falhas sem expor o
corpo privado de um erro.

UI exige interação e inspeção visual, inclusive em tela estreita, tema escuro,
teclado e estado de erro. Os roteiros `qa_ui.mjs` e `qa_pages.mjs` usam fontes e
identidades controladas. A prova hospedada precisa conferir o asset efetivamente
servido e o cliente real. Capturas são obtidas pelo retorno nativo do instrumento;
não automatize downloads ou diálogos “Salvar como”.

## Acrescentar uma fonte

Defina primeiro o que o adaptador pode observar e executar. Estabeleça como
identificar conta, origem, recurso, versão e permissão. Depois descreva paginação,
continuação, limites de rede, expiração e revogação. Uma capacidade ausente deve
produzir uma lacuna compreensível, sem inventar um resultado vazio conclusivo.

Observe o transporte que impede destinos internos e redirecionamentos indevidos.
Uma URL arbitrária enviada pelo cliente não deve se transformar em acesso de rede
com a credencial institucional. Novas operações de escrita precisam passar pelo
mesmo vínculo entre conteúdo preparado, revisão, recibo e resultado incerto.

## Revisar e entregar

Confira diff, comandos executados e evidências. Separe prova local, fonte
controlada, homologação hospedada e instituição real. Atualize o guia que será
usado por quem não conhece a implementação. Não publique logs de contas, arquivos
acadêmicos ou caminhos privados.

Uma mudança que economiza espaço precisa demonstrar a preservação do conteúdo,
não só uma soma menor. Uma mudança que facilita login precisa demonstrar
isolamento e revogação, não só um formulário funcionando. Veja
[CONTRIBUTING](../CONTRIBUTING.md) e [aceite](ACEITE.md).
