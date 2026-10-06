# Instalação limpa com cache vazio (gate A01)

Este documento descreve a prova local de instalação limpa: dependências travadas
baixadas em um cache Deno realmente vazio, onze migrations aplicadas em um banco
local novo e o servidor MCP exercitado pelo SDK oficial em transporte HTTP, com
dois proprietários sintéticos no mesmo banco. É o pedaço local do aceite A01; não é
implantação hospedada nem Auth real.

## O que este gate cobre, e o que ele não cobre

`scripts/validate_clean.ts` já provava banco novo, RLS, dois donos e retry, mas
marcava `dependencies_fresh_cache: false`: ele reutiliza o cache Deno da máquina.
`tests/mcp_test.ts` prova o cliente SDK sobre HTTP, mas contra o banco de
desenvolvimento compartilhado. Faltava a prova conjunta: cache vazio de verdade e
MCP em um banco recém-criado.

O gate resolve isso orquestrando um processo filho sob um `DENO_DIR` novo, criado
exclusivamente em `.private/fresh-install/`, com o lock congelado. O filho roda com
`--frozen` e `--node-modules-dir=none`, portanto toda dependência precisa vir da
rede e o `deno.lock` não pode ser alterado. O próprio orquestrador não declara
nenhum especificador externo, então não reescreve o lock; ainda assim ele mede o
hash do `deno.lock` antes e depois de todo o gate e reprova se mudar. Em seguida,
no mesmo processo, ele cria
um banco local com nome único, aplica `scripts/local_identity.sql` e as onze
migrations, e chama o servidor por HTTP usando `@modelcontextprotocol/sdk`.

O gate **não** prova implantação hospedada, Supabase Auth nativo, provisionamento
remoto, RLS hospedada nem credenciais de provedor. Banco, identidade e tokens são
sintéticos e locais (`127.0.0.1:55432`). O que é hospedado tem prova própria em
`docs/VALIDACAO-HOSPEDADA.md`; a hospedagem, em `docs/IMPLANTACAO.md`.

## Arquivos

- `scripts/validate_fresh_install.ts` — orquestrador. Cria o `DENO_DIR` vazio,
  calcula o hash do `deno.lock` antes e depois, dispara o filho, mede o cache que
  foi baixado e grava o manifesto privado.
- `scripts/fresh_install_child.ts` — trabalho pesado. Cria o banco, aplica
  identidade e migrations, sobe o servidor MCP e faz as chamadas do SDK.

Os dois reaproveitam contratos públicos já existentes: a fixture
`scripts/local_identity.sql`, o padrão de migrations de `scripts/db_setup.ts`, o
contrato de RLS de `scripts/validate_clean.ts` e o cliente
`@modelcontextprotocol/sdk` de `tests/mcp_test.ts`. Nenhum `deno.json`, migration,
fonte ou outro documento é alterado pelo gate.

## Como executar

A partir da raiz do repositório:

```
deno run --allow-read --allow-write=.private/fresh-install --allow-run --allow-env \
  scripts/validate_fresh_install.ts
```

O orquestrador precisa de `--allow-run` para chamar o Deno filho, de
`--allow-read` para o `deno.lock` e as migrations e de `--allow-write` apenas em
`.private/fresh-install`. As flags de cache foram conferidas em `deno run --help`
(Deno 2.9.3): `--frozen`, `--node-modules-dir=none`, `--cached-only`, `--lock`.

O filho recebe um `DENO_DIR` novo (ambiente), um nome de banco sintético único e
uma porta aleatória entre 8800 e 8899; a allowlist de rede cobre só
`127.0.0.1:55432` e essa porta. Ninguém lê `.private` existente: o gate cria e usa
somente o próprio diretório.

## O que a execução comprova

- O cache Deno começou com zero arquivos e terminou com as dependências
  travadas baixadas (por exemplo `postgres`, `jose`, `zod`,
  `@modelcontextprotocol/sdk` e `pdfjs-dist`), com `deno.lock` inalterado.
- Onze migrations aplicadas em um banco local novo, com RLS forçada em todas as
  tabelas de memória.
- O cliente SDK oficial em transporte Streamable HTTP lista as ferramentas
  esperadas e recusa token ausente, cliente fora da allowlist, token expirado e
  emissor errado.
- Gravação de delta, recuperação por contexto e por busca, e retry idempotente
  devolvendo o mesmo recibo.
- Isolamento entre dois donos no mesmo banco novo: o segundo dono não lista, não
  lê nem encontra por busca a memória do primeiro.

Ao final, o orquestrador imprime um resumo compacto e grava o manifesto privado
em `.private/fresh-install/<execução>/evidence/fresh-install.json`. O manifesto
registra versão do Deno, flags, contagem e bytes do cache, pacotes npm resolvidos,
hash do lock, nome do banco e o resultado do filho. Ele não contém senha, token
nem caminho de credencial; a senha local sintética (`synthetic-local-only`) existe
no `compose.yaml` público e não é reproduzida no manifesto. O diretório `.private`
é ignorado pelo Git.

O banco de prova é preservado (como em `validate_clean.ts`) para inspeção direta.
Para conferir manualmente:

```
docker exec arahub-db-1 psql -U arahub -d <nome-do-banco> -Atc \
  "select count(*) from public.arahub_migrations"
```

Cada execução cria um banco novo com nome próprio (`arahub_fresh_<12 hex>`); a
limpeza de bancos antigos é uma decisão de operação local, não do gate.

## Limites

O gate exige o Postgres local do `compose.yaml` saudável em `127.0.0.1:55432` e
acesso de rede ao registro npm. Sem rede, o cache vazio não pode ser preenchido e
o `--frozen` deve falhar, o que é o comportamento desejado. A atualização de
`STATUS.md` e da matriz de aceite após este gate é responsabilidade do
responsável pela etapa.
