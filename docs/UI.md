# Interface do AraHub

Superfície auxiliar mínima do AraHub: acesso, conexões Moodle, biblioteca de materiais, exportação privada
e uma tela focada de aprovação acadêmica. O uso
cotidiano continua no chat; a interface não é um painel de operações técnicas.

Arquivos: `web/index.html`, `web/app.ts`, `web/action_preview.ts`, `web/style.css`,
`web/privacy.html`, `web/theme.ts` e `web/icons.ts`. O bundle `web/app.js` é gerado e ignorado pelo Git
(`deno task web:build`).

Preferências e revisão de registros importados pertencem à memória e ao fluxo do
assistente. A interface não oferece nem carrega a antiga lista “para revisar”. Sua
remoção não altera registros, vigência, fontes ou ferramentas MCP.

## Superfícies

- **Conta (acesso):** entrada por senha local ou link por e-mail em HTTPS; sessão
  sintética quando o ambiente é sintético.
- **Conexões:** lista as conexões Moodle do dono. O estado normal fica em ícone com
  nome acessível e dica; falhas de acesso continuam visíveis quando exigem atenção. Renovar, atualizar cursos e
  desconectar agem sobre a origem Moodle; nenhum estado prova frescor da fonte.
- **Exportação privada:** `GET /api/export` mostra o JSON do dono; credenciais têm
  recuperação separada e nunca entram na exportação.
- **Materiais:** biblioteca dos originais preservados, com nome, origem e tamanho. Abrir
  (PDF, imagens, texto e áudio/vídeo compatíveis) e baixar são ícones à direita. DOCX,
  HTML e outros formatos oferecem download; conteúdo HTML/SVG nunca é executado
  no domínio da interface. Mais itens entram automaticamente conforme a rolagem.
  Não há controles de extração ou processamento. Versões e ocorrências são preservadas.
- **Novo acesso Moodle:** formulário próprio pelo ícone de adicionar, sem cartão
  expansível na tela de conexões. A orientação de entrada fica na ajuda contextual.
- **Ações acadêmicas:** tela focada de aprovação descrita abaixo. Intenções pendentes
  abrem essa tela na entrada; sem ações pendentes ou resultado incerto, o acesso fica oculto.
  Operações aposentadas e estados terminais não aparecem nessa tela; o histórico permanece na memória.

## Remoção da operação Google própria

A interface não conecta, renova, amplia permissões nem sincroniza contas Google. O
formulário `google-connect`, o callback OAuth próprio, o `action_preview` de
Docs/Sheets/Slides e os testes correspondentes foram retirados. `web/privacy.html` foi
ajustado: o material Google já preservado permanece como registro histórico, sem exigir
revogação nem apagar a memória. Fontes importadas históricas permanecem na memória, consultáveis pelo assistente;
não ocupam a configuração das conexões ativas.

## Contrato de dados consumido

- `GET /api/config` → `synthetic`, `canConnectMoodle`, `canApproveActions`,
  `canBrowseMaterials`.
- `GET /api/context` → `contexts`, `deltas`, `connections`, `coverage`.
- `GET /api/actions` → lista de `{ action, state }` do dono.
- `POST /api/actions/approve` e `POST /api/actions/deny` → `{ action_id,
  content_hash, statement_accepted }`.
- `POST /api/connections/moodle`, `POST /api/connections/disconnect`,
  `POST /api/sync/moodle-courses`.
- `POST /api/library/list` → até 20 originais e cursor; `POST /api/library/part` →
  parte de até 1 MiB, vinculada ao dono, ID e SHA-256. Sessão pessoal revalidada em
  cada parte, sem credencial em URL. O cliente recusa truncamento e confere o hash
  completo antes de abrir ou baixar; limite de 128 MiB por original. Rotas de extração
  PDF existentes permanecem disponíveis, mas não são chamadas pela biblioteca.

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

Operações aposentadas não são renderizadas. Uma operação Moodle desconhecida ainda
pendente mostra que não pode ser revisada nesta interface e não oferece aprovação.
Nenhum registro histórico é removido do banco.

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
foco visível e estados habilitado/selecionado. Grupos de ações ficam alinhados à direita. Permissões e declaração de autoria
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
real) e cobre login, conexões, ausência da revisão interna de preferências,
renovação Moodle pelo link móvel, aprovação das três ações
acadêmicas com `statement_accepted` correto, ausência das operações aposentadas, texto hostil não executado, ausência de Google e de JSON cru,
exportação e saída. As capturas usam o retorno nativo do instrumento e são gravadas fora
da interface, em `.private/evidence/ui/`.

A QA do Pages verifica paginação automática e alinhamento da biblioteca. Não aciona
os controles de abrir/baixar. `tests/library_test.ts` verifica a transferência diretamente
pela API, com banco SQL, JWT assinado, isolamento, revogação, integridade e limites.

O pacote Pages usa URLs de JS/CSS com SHA-256 do conteúdo na consulta `v`,
compartilhadas por entrada, callbacks e Privacidade. Uma atualização não reutiliza
a URL do bundle anterior em cache. Nenhuma preferência do navegador é alterada.
