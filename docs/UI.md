# Interface do AraHub

Superfície auxiliar mínima do AraHub: acesso, conexões Moodle com saúde, preferências
por escopo legíveis, exportação privada e uma tela focada de aprovação acadêmica. O uso
cotidiano continua no chat; a interface não é um painel de operações técnicas.

Arquivos: `web/index.html`, `web/app.ts`, `web/action_preview.ts`, `web/style.css`,
`web/privacy.html`, `web/theme.ts` e `web/icons.ts`. O bundle `web/app.js` é gerado e ignorado pelo Git
(`deno task web:build`).

## Superfícies

- **Conta (acesso):** entrada por senha local ou link por e-mail em HTTPS; sessão
  sintética quando o ambiente é sintético.
- **Conexões:** lista as conexões Moodle do dono. O estado normal fica em ícone com
  nome acessível e dica; falhas de acesso continuam visíveis quando exigem atenção. Renovar, atualizar cursos e
  desconectar agem sobre a origem Moodle; nenhum estado prova frescor da fonte.
- **Preferências:** lê `GET /api/preferences?scope={}` e apresenta o que está vigente,
  os conflitos e o que exige revisão humana, com escopo, vigência e situação em português.
- **Exportação privada:** `GET /api/export` mostra o JSON do dono; credenciais têm
  recuperação separada e nunca entram na exportação.
- **PDFs:** tela própria, acessível pelo ícone de documento quando disponível.
- **Novo acesso Moodle:** formulário próprio pelo ícone de adicionar, sem cartão
  expansível na tela de conexões. A orientação de entrada fica na ajuda contextual.
- **Ações acadêmicas:** tela focada de aprovação descrita abaixo. Intenções pendentes
  abrem essa tela na entrada; sem ações, não há aviso vazio na tela inicial.

## Remoção da operação Google própria

A interface não conecta, renova, amplia permissões nem sincroniza contas Google. O
formulário `google-connect`, o callback OAuth próprio, o `action_preview` de
Docs/Sheets/Slides e os testes correspondentes foram retirados. `web/privacy.html` foi
ajustado: o material Google já preservado permanece como registro histórico, sem exigir
revogação nem apagar a memória. Fontes importadas históricas permanecem na memória, consultáveis pelo assistente;
não ocupam a configuração das conexões ativas.

## Contrato de dados consumido

- `GET /api/config` → `synthetic`, `canConnectMoodle`, `canApproveActions`,
  `canExtractPdf`.
- `GET /api/context` → `contexts`, `deltas`, `connections`, `coverage`.
- `GET /api/preferences?scope=<JSON>` → `hub.preferences(p, scope)`: `applicable`,
  `history` (com `status`), `conflicts`, `contextual_overrides`, `review_required`,
  `coverage`, `at`. A interface chama com `scope={}`.
- `GET /api/actions` → lista de `{ action, state }` do dono.
- `POST /api/actions/approve` e `POST /api/actions/deny` → `{ action_id,
  content_hash, statement_accepted }`.
- `POST /api/connections/moodle`, `POST /api/connections/disconnect`,
  `POST /api/sync/moodle-courses`, `POST /api/pdf/*`.

### Conteúdo da ação acadêmica

As operações `moodle.forum.discussion`, `moodle.forum.reply` e
`moodle.assignment.submit` preparam um `content` com:

```
{
  kind, connection: { label, origin, username },
  target: { course_id, course_name, cmid, activity_name, instance_id,
            discussion_id?, parent_id? },
  text?: { subject, body },
  files: [{ id, name, mime, bytes, sha256 }],
  statement: { text, required },
  expected: { epoch, user_id, fingerprint, attempt, status },
  rules, prepared_at, expires_at
}
```

`describeAction` (`web/action_preview.ts`) traduz a operação em seções legíveis: título,
conta e origem, destino, título, texto integral, arquivos (nome, tipo, tamanho) e as
**condições da fonte** que afetam a decisão — prazos, janela de envio, limites de
arquivo e tipo, tentativas, estado atual, permissões do fórum, trava e, na resposta, o
autor, o assunto e o texto do post original sem marcação. Não há JSON cru nem detalhes
técnicos no fluxo; hashes (`sha256`, `fingerprint`) não aparecem na revisão humana.

### Operações não reconhecidas

Operação fora das três acadêmicas vira **registro histórico**, sem conteúdo cru:
"Operação aposentada" quando a origem não é `moodle.*` (por exemplo, a escrita Google
retirada) ou "Operação não reconhecida" quando é `moodle.*` sem revisão nesta interface.
Nos dois casos os botões de autorizar e recusar ficam **indisponíveis**: esta interface
não aprova legado.

## Aprovação acadêmica

Cada ação é exibida por inteiro. Quando `statement.required` é verdadeiro, a interface
mostra a declaração e exige o assentimento explícito ("Concordo com esta declaração e
assumo a autoria.") antes de habilitar o botão de autorizar. Quando não é exigida,
nenhuma caixa de concordância aparece. Autorizar ou recusar envia `statement_accepted`
booleano; recusar e autorizar sem declaração exigida enviam `false`.

A aprovação é de sessão de navegador: não existe aprovação por modelo, token MCP ou
booleano produzido por argumento. O conteúdo é fixado por `content_hash` e revalidado no
servidor, que também impõe a declaração quando a operação é `moodle.*` e
`statement.required` é verdadeiro (`src/approval_store.ts`).

## Layout e legibilidade

A instrução visual corrente do titular exige botões exclusivamente de ícone,
sem cartões HTML de configuração e sem textos de bastidor. Esta definição substitui
os rótulos visíveis e cartões que a versão anterior introduziu.

Todas as telas usam a mesma coluna de até 460 px e altura de 100dvh, com cabeçalho
fixo, margens alinhadas, rodapé reservado e conteúdo rolável sem encolher controles.
As listas são linhas simples. Botões medem 44 × 44 px, com `aria-label`, título,
foco visível e estados habilitado/selecionado. Permissões e declaração de autoria
continuam explícitas na revisão da ação, sem mudar os controles de autorização.

O tema claro/escuro/sistema é inicializado antes do CSS pelo bundle compartilhado
`theme.js`; Privacidade, entrada e callbacks usam a mesma preferência. Privacidade
resume os efeitos que interessam ao titular, sem arquitetura, migrações ou histórico
de desenvolvimento. Ajuda operacional aparece quando solicitada.

O QA mede dimensões, alinhamento e interseções de controles considerando a área
rolável. Cobre desktop 1280×900 e viewport móvel 390×844, troca de telas, diálogo de
permissão e ida/volta/reload de Privacidade em tema escuro. Viewport móvel não é
prova em aparelho físico.

## Construir e verificar

```
deno task web:check
deno task web:build
deno test --allow-read tests/action_preview_test.ts
node scripts/qa_ui.mjs
```

`scripts/qa_ui.mjs` sobe um navegador isolado com fixtures sintéticos (nenhuma conta
real) e cobre login, conexões, preferências com escopo/conflito/revisão via
`/api/preferences`, renovação Moodle pelo link móvel, aprovação das três ações
acadêmicas com `statement_accepted` correto, operação retirada como registro histórico
com botões indisponíveis, texto hostil não executado, ausência de Google e de JSON cru,
exportação e saída. As capturas usam o retorno nativo do instrumento e são gravadas fora
da interface, em `.private/evidence/ui/`.
