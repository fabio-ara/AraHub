# Moodle Lab do AraHub

Laboratório Moodle descartável, privado e sintético para exercitar a cadeia real
AraHub → Moodle sem tocar na universidade, sem expor serviço e sem dados reais.

O laboratório é **instrumento de teste**, não o produto. Ele existe para provar
contratos (upload, salvar, finalizar, fórum, leitura) e para auditar efeitos que
a produção bloqueia.

## Fronteira de licença

O código de controle em `scripts/lab/**` é do AraHub (MIT), inclusive o gerador
nativo `scripts/lab/moodle_lab.php`, que roda dentro do container e usa
APIs nativas da versão Moodle pinada; a reprodução não depende de material privado.
O Moodle e o `moodlehq/moodle-docker` são GPL e ficam **somente** clonados sob
`.private/entrega-1/lab/src/` (ignorado pelo Git). Nada de GPL é copiado para
arquivos rotulados MIT; o template `config.docker-template.php` também vive no
diretório privado e é montado em `/opt/arahub-lab/private`.

O `init` não depende de arquivo privado pré-existente: ele clona o
moodle-docker oficial no commit pinado, copia o template para o diretório privado e
obtém o checkout Moodle oficial e materializa o override genérico do Compose a partir de
`scripts/lab/compose/local.yml.template`, tudo de forma idempotente.
O `up` empacota o commit local com `git archive` e o materializa no volume por um
auxiliar sem rede. O código existente deve comprovar o commit pelo marcador privado
ou pelo Git; arquivos inesperados impedem sobrescrita. Falha de inventário ou da
sonda Docker não autoriza tratar o volume como vazio.

## Versões fixadas

| Componente | Fixado em |
|---|---|
| `moodlehq/moodle-docker` | commit `f4c2324d32fb74d7753264381f0a9b418b6034b2` |
| Moodle | `v4.5.6` (commit `fb02f4fa9f2c5d6ba37d1032e2357554cea37fc2`) |
| PHP | `moodlehq/moodle-php-apache:8.3` (PHP 8.3.35) |
| PostgreSQL | `postgres:17` |
| Mailpit | `axllent/mailpit:v1.10` |

`v4.5.6` é o baseline fixado para esta prova; não reproduz necessariamente o
build institucional `4.5.6+`. O perfil `4.5.15` está disponível para smoke separado.
As tags de imagens são registradas acima; não equivalem a pins por digest.

## Isolamento

- Rede: web publicada apenas em `127.0.0.1:<porta>`; o banco não publica porta.
- E-mail: `smtphosts = mailpit:1025`; nenhum SMTP real é alcançado.
- Cron: serviço dedicado rodando `admin/cli/cron.php` a cada 60s.
- Código e dataroot em volumes nomeados do projeto (não em bind mount do host,
  que travava o instalador em `p9_client_rpcWrite`).
- Guarda de propriedade: um UUID por instância (`ARAHUB_LAB_INSTANCE_ID`) gravado
  no `instance.json`, nas etiquetas dos containers/volumes e num marcador dentro
  do dataroot. Toda operação mutável confere marcador, etiquetas e origem loopback
  antes de escrever. Na instalação nova, o bootstrap limitado inicializa o
  marcador ausente somente depois de conferir os rótulos; marcador divergente
  nunca é substituído.
- `reset` remove **apenas** containers/volumes/rede do projeto do Lab
  (`down -v --remove-orphans`). Se restarem helpers criados fora do Compose, remove
  somente recursos do inventário anterior, reconfirmando UUID/projeto de todos
  antes da limpeza. Containers são removidos pelo ID inspecionado; volumes usam
  remoção sem `force`. Recurso novo, rótulo divergente ou volume ainda em uso
  impede sucesso. É proibido `docker system prune`, limpeza global de volumes ou
  remoção por nome digitado.

## Comandos

Pré-requisitos: PowerShell 7, Git, Docker/Compose com suporte a `!override` e Deno
para os harnesses SDK. As provas SDK usam também o banco AraHub sintético local
com as migrations do projeto aplicadas; o controlador Moodle não cria esse banco.
Execute a partir da raiz do checkout:

```
pwsh scripts/lab/aralab.ps1 init          # marcador da instância + arquivo de ambiente
pwsh scripts/lab/aralab.ps1 up            # sobe db+mailpit+webserver+cron, instala e semeia
pwsh scripts/lab/aralab.ps1 health        # containers, HTTP, banco, Mailpit, fixtures
pwsh scripts/lab/aralab.ps1 seed          # contas, cursos, atividades, tokens e manifesto
pwsh scripts/lab/aralab.ps1 verify        # contrato REST com token de estudante
pwsh scripts/lab/aralab.ps1 audit         # efeitos de mod_assign_get_submission_status
pwsh scripts/lab/aralab.ps1 prove         # cadeia SDK MCP -> AraHub -> Moodle
pwsh scripts/lab/aralab.ps1 guardas       # provas negativas de origem e marcador
pwsh scripts/lab/aralab.ps1 sentinela      # projeto Docker alheio para provar o reset
pwsh scripts/lab/aralab.ps1 reset         # apaga só o Lab (e confere a sentinela)
pwsh scripts/lab/aralab.ps1 shell         # shell no container webserver
pwsh scripts/lab/aralab.ps1 manifest      # caminho e esquema do manifesto
```

Opções: `-MoodleVersion 4.5.6|4.5.15` e `-Reinstall`.

Uma segunda versão usa `-MoodleVersion 4.5.15`, web 8481 e Mailpit 8026, ambos
em loopback. `init` obtém os dois repositórios oficiais se ausentes e confere os
commits: Moodle 4.5.15 em `215f44380bdc3ccf852a3a22e34f8423ff64033a`.
O manifesto, override, arquivos e evidências desse perfil ficam em
`.private/entrega-1/lab/instances/arahublab4515/`. O perfil 4.5.6 preserva o caminho
anterior na raiz privada do Lab. Os clones GPL são compartilhados apenas como
fontes pinadas. O controlador repassa manifesto e `instance.json` ao `prove.ts`:

```
deno run -A scripts/lab/prove.ts <manifest.lab.json> <instance.json>
```

Antes de `down -v`, a guarda exige UUID e projeto Compose exatos em cada recurso.
O marcador do dataroot deve estar presente e igual mesmo com containers parados;
nesse caso um container temporário usa a imagem local `alpine:3.20`, sem rede,
sem pull e com o volume somente leitura. Bootstrap de marcador é reservado ao
`up` com os rótulos confirmados; nunca substitui a guarda destrutiva.
O recibo de reset registra inventário anterior, limpeza residual, recursos
restantes e preservação de containers/volumes alheios. Se uma execução antiga
parar depois de apagar o dataroot, a recuperação precisa de autorização delimitada,
recibo anterior e rótulos reconferidos: não se recria marcador para fazer a guarda
passar nem se apresenta a recuperação como um reset integral novo.


## Helper nativo público

O gerador e as sondas ficam em `scripts/lab/moodle_lab.php` (MIT) e rodam
dentro do container do Lab usando APIs nativas do Moodle:

- `seed` — cria ou atualiza contas, cursos, atividades e arquivos sintéticos.
- `ws` — habilita Web Services e cria serviço e tokens, gravados com permissão
  0600 no dataroot e nunca impressos.
- `snap <tag> <assignid> <userid>` e `sdiff <tagA> <tagB>` — medem linhas de nota,
  submissões e eventos antes e depois.
- `oracle <assignid> <userid>` — leitura direta do estado, sem helpers de nota.
- `resetassign <assignid> <userid>` — devolve a entrega desse aluno ao estado inicial;
  preserva as notas dos outros alunos.
- `diag <assignid> <userid>` — explica por que a submissão está aberta ou fechada.

Provas negativas ficam em `scripts/lab/negative_prove.ts` (MIT), com a mesma
fixture sintética de SDK do `prove.ts` e alvos no laboratório existente: ACT-04
(timeout real depois do efeito, sem reenvio), ACT-05 (execuções concorrentes da mesma
ação rendem efeito único), ACT-02 (conteúdo alterado após a preparação é recusado sem
execução) e ACT-03 (precondições alteradas bloqueiam antes do efeito), além de guardas
de origem verificadas como prova unitária sem chamar o laboratório.

```
deno run -A scripts/lab/negative_prove.ts
deno run -A scripts/lab/negative_prove.ts --extended
deno run -A scripts/lab/negative_prove.ts --extended --forum-only
deno run -A scripts/lab/negative_prove.ts --groups-only
deno run -A scripts/lab/negative_prove.ts --warning-only
```

O helper recusa origem não local e marcador inválido antes de criar arquivos ou
assumir a conta administrativa. O adapter também confere UUID, projeto, origem e
endpoints de objetos em memória; recusa redirecionamentos no transporte autenticado.

O runner cria um curso sintético exclusivo por execução, com aluno B, colega C
e docente. Preserva as contas e atividades existentes do aluno A. O helper público
`negative_fixtures.php` confere origem, UUID e identificador do lote antes de criar
as atividades ou alterar a configuração do alvo desse lote. Não faz reset geral.
As ações passam pelo SDK MCP/HTTP e a aprovação pelo endpoint HTTP autenticado;
o JWT ES256 e a sessão são fixtures locais, identificadas na evidência.
Um `passed: false` torna o resultado agregado uma falha e o processo retorna 1.

O lote complementar cobre due/cutoff, extensão individual, reabertura nativa da
mesma tentativa, substituição de arquivo, grupos separados, fechamento após
aprovação e contagem de colegas. Esta última consulta `hub_attention` pelo SDK
após sincronizar os posts reais e compara o resultado ao oráculo independente;
rascunhos, respostas próprias e repetições não aumentam a contagem esperada.
`--forum-only` permite repetir só a parte de fórum depois de uma correção.
O lote `--warning-only` fecha uma tarefa exclusiva depois do preflight, antes do
save real, para obter o aviso HTTP 200 do próprio Moodle e conferir ausência de
finalização e de reenvio. Não substitui o corpo da resposta por uma fixture.

No Windows, caso o cliente Docker responda e a conexão padrão com o daemon fique
sem retorno, a instalação validada também oferece o pipe Linux. Configure-o apenas
no processo do comando, sem alterar o contexto global:

```powershell
$env:DOCKER_HOST = 'npipe:////./pipe/docker_engine_linux'
deno run -A scripts/lab/negative_prove.ts --extended
```

Ao gerar `lab.env` nesse pipe, o controlador traduz somente os binds Windows
para `/run/desktop/mnt/host/<drive>/...`. Caminhos de arquivos passados ao curl
continuam no formato Windows. Essa seleção não altera o contexto global Docker.

Validação de código sem chamar Docker ou Moodle:

```
pwsh -NoProfile -File scripts/lab/controller_test.ps1
pwsh -NoProfile -File scripts/lab/ownership_test.ps1
pwsh -NoProfile -File scripts/lab/reset_postcondition_test.ps1
deno test --allow-read --allow-write scripts/lab/guards_test.ts
php -n -l scripts/lab/moodle_lab.php
php -n scripts/lab/helper_test.php
```

Os testes PowerShell substituem Docker/Git por funções locais simuladas; o teste
PHP importa apenas a função sob teste e usa um banco simulado. Não equivalem aos
gates de integração no laboratório.

Os critérios de aceitação são os comandos do controlador: `health`, `verify`,
`audit`, `guardas` e `reset` com a sentinela.

## Contas e fixtures
Admin de instalação, docente, alunos A/B/C, um aluno sem matrícula e um dono B;
curso de ambientação, disciplina (Book com capítulos, Page, rótulo, URL, recursos
DOCX/PDF/MP4, assignment fingerprint, fórum geral/Q&A/avisos) e um curso de
isolamento. O assignment "fingerprint" reproduz o perfil da Etividade 1: um
arquivo, rascunho, declaração de autoria, individual, tentativa única.

Fixtures sintéticas ficam em `.private/entrega-1/lab/out/` e são verificadas por
tamanho e bytes mágicos no `health` (DOCX `PK`, PDF `%PDF`, MP4 `ftyp`).

## Credenciais sintéticas

O manifesto fica **somente** em `.private/entrega-1/lab/manifest.lab.json`
(ignorado pelo Git). Esquema:

```
schema, instance_id, project, origin, rest_endpoint, upload_endpoint, mailpit_url,
moodle {version, ref, commit}, runtime {php, postgres, images}, service {id, shortname, functions},
accounts_password, accounts.<usuario> {userid, token}, fixture {courses, assignment, forum, ...}
```

Tarefas de laboratório leem esse arquivo diretamente; os tokens nunca são
impressos. Nenhum token da universidade participa deste runner, e a guarda de
origem rejeita qualquer alvo fora de loopback antes de tocar a rede.

## Evidência

`.private/entrega-1/lab/evidence/`:

- `rest-contract-*.json` — contrato REST com token de estudante e verificação independente.
- `submission-status-audit-*.json` — deltas de linhas e eventos por cenário.
- `sdk-chain-*.json` — cadeia SDK MCP → AraHub → Moodle, passo a passo.
- `negative-*.json` — provas ACT-02/03/04/05, limites de assignment, restrições
  de fórum e guardas unitárias. Confira `failed_steps` e cada `passed`, sobretudo
  em evidências antigas sem agregação de asserções.
- `reset-isolation-*.json` — inventários antes/depois: sucesso exige zero containers
  e volumes do projeto, com a sentinela de terceiro intacta. Falha na consulta do
  inventário recusa sucesso; `removed` contém somente a diferença observada.
- `normal-browser-ui-proof.json` e `normal-chrome-*.png` — prova de UI
  independente, com capturas nativas da entrega e do fórum.

## Regra obrigatória de captura

É proibido baixar ou salvar imagens pela interface do navegador ou do aplicativo,
incluindo capturas, menus "Salvar imagem como", atalhos, links com download e URLs
`data:`/`blob:`. Capturas usam apenas o retorno nativo do instrumento e, quando
suportado, gravação direta dos bytes fora da interface. A regra vale para este
laboratório e para qualquer handoff que delegue operação de navegador.

## Autorização e limites da prova

Mutações sintéticas neste laboratório estão autorizadas pelo mandato, desde que
as guardas de alvo e propriedade passem. Isso não dispensa a aprovação de ação
exigida pelo produto: o harness exercita essa aprovação com sessão sintética.
O runner de negativas preserva o servidor em uso e não reinicia containers nem
altera senhas. Operações destrutivas ficam no comando `reset`, com guarda estrita.

A cadeia SDK de assignment (arquivo, declaração e confirmação por estudante e
docente), tópico anexado e resposta passou. A entrega e o fórum também tiveram
inspeção visual independente em aba normal. Os resultados operacionais datados e
as pendências ficam no checkpoint privado, não no manual de reprodução.

A rota `getSubmissionStatus` permanece bloqueada em produção. A exceção é exclusiva
do adapter do Lab: a auditoria observou criação de linha `assign_submission` na
primeira leitura. A ausência de delta de nota nesse cenário não autoriza habilitar
a rota institucional. O SDK local não comprova a cadeia do aplicativo ChatGPT
hospedado. Resultados por versão, inclusive `4.5.15`, ficam nas evidências privadas
da respectiva instância; não são inferidos dos resultados do baseline.

## Homologação pelo host

`scripts/lab/host_server.ts` é um servidor temporário preparado para o lote de
homologação. Sua execução externa depende da autorização específica do túnel,
cliente OAuth e callback. Dados e Moodle ficam locais; a sessão usa a identidade
nativa do alvo autorizado. Não existe login sintético público.

O lookup de sessão reutiliza a credencial protegida da Management API existente
para uma consulta fixa `SELECT` em `auth.sessions`. Assinatura e cliente JWT são
verificados antes dessa consulta. Dono, UUID da sessão, projeto, expiração,
cancelamento, redirecionamentos e tamanho da resposta são restringidos; falhas
recusam autenticação. Nenhuma senha de conexão direta ao banco é necessária.
Esse caminho pertence somente ao harness, sem alterar o backend de produção.

Os testes de transporte injetado e encerramento do processo não demonstram login
na nova origem. A prova nativa desse lote e a cadeia de arquivo pelo ChatGPT
continuam distintas e precisam de recibos reais após a ativação autorizada.

## Quiz sintético: QUIZ-01/02

O runner `quiz_prove.ts` exercita o REST real do Moodle 4.5.6 em
`http://localhost:8480`, como estudante B. Cria um curso exclusivo por execução,
dois quizzes de múltipla escolha e um serviço temporário restrito ao estudante.
O token é limitado ao contexto desse curso e expira em uma hora. Não altera os
serviços, tokens ou atividades das outras provas.

Com o Lab já instalado e o manifesto privado disponível:

```powershell
deno check scripts/lab/quiz_prove.ts
deno lint scripts/lab/quiz_prove.ts
docker --host npipe:////./pipe/docker_engine_linux exec arahublab456-webserver-1 php -l /opt/arahub-lab/tools/quiz_fixtures.php
deno run --cached-only --allow-read --allow-env --allow-net=localhost:8480 --allow-run=docker --allow-write=.private/entrega-1/lab/evidence scripts/lab/quiz_prove.ts --execute
```

Sem `--execute`, o runner termina sem acessar o Lab. `--manifest=PATH` e
`--instance=PATH` permitem indicar os arquivos privados; ambos devem corresponder
ao projeto, UUID e origem guardados. A execução usa o pipe Linux sem mudar o
contexto global Docker, e o helper é lido do mount existente.

QUIZ-01 compara o estado nativo antes/depois da descoberta e do início
explicitamente autorizado. QUIZ-02 salva uma resposta sintética, reconecta,
confere sua persistência, finaliza e testa o vencimento de prazo e as recusas após
encerramento. O timeout usa um override temporário apenas no quiz e estudante
próprios; o relógio do sistema não muda. `get_attempt_data` pode avançar uma
tentativa vencida no Moodle, por isso requer autorização no harness e não integra
a descoberta passiva.

Os recibos `quiz-suite-*.json` ficam em `.private/entrega-1/lab/evidence/`, com
checks, IDs, estados, tempos e hashes, sem tokens nem corpos das questões.
O `finally` remove o override, o serviço e seus tokens. Curso e tentativas ficam
preservados para inspeção. Após interrupção, use o UUID do recibo com as mesmas
permissões do comando acima e substitua `--execute` por
`--cleanup-only --run=UUID`; uma escrita sem resposta nunca é reenviada
automaticamente.

Esta é uma prova REST no Lab, separada das operações AraHub. O runner também
verifica que a allowlist e o schema de ações do produto continuam recusando quiz.
Não demonstra aprovação acadêmica, execução de avaliações pelo AraHub, cadeia
MCP/host, UI ou uso institucional. Nenhuma função de quiz é habilitada em produção.

## Referências primárias

- [moodlehq/moodle-docker](https://github.com/moodlehq/moodle-docker), base oficial do ambiente.
- [Assignment settings — Moodle 4.5](https://docs.moodle.org/405/en/Assignment_settings),
  tipos, tamanho por arquivo, botão final e assentimento de grupo.
- [Forum settings — Moodle 4.5](https://docs.moodle.org/405/en/Forum_settings),
  tipos de fórum e acesso condicionado Q&A.
