# Contribuir com o AraHub

Contribuições devem preservar a continuidade da memória, o isolamento de contas e
a distinção entre evidências. Comece pelo [mapa da documentação](docs/README.md),
pela [arquitetura](docs/arquitetura.md) e pelo [guia do desenvolvedor](docs/guia-do-desenvolvedor.md).
Leia também [AGENTS.md](AGENTS.md) e [STATUS.md](STATUS.md) antes de alterar o projeto.

## Preparar uma mudança

Descreva o problema observável e o comportamento esperado. Reutilize mecanismos
existentes antes de acrescentar dependências. Não introduza nomes, contas ou URLs
pessoais no domínio da aplicação. Configuração de instalação fica em ambiente;
credenciais e evidências privadas ficam fora do Git.

Use dados sintéticos em testes. Uma nova integração precisa de contrato explícito
para identidade, origem, permissões, paginação, revogação, limites e estados de
falha. Conteúdo de uma fonte nunca pode ampliar a autoridade do sistema.

## Validar proporcionalmente

Execute tipos, testes afetados e revisão do diff. Mudanças de interface exigem
interação e inspeção visual. Mudanças de dados exigem migração, preservação e
recuperação testadas. Integração com um provedor precisa de cliente real quando
disponível; stubs e provas locais devem ser identificados como tais.

```powershell
deno task check
deno task edge:check
deno task web:check
deno task web:build
deno task db:setup
deno task test
deno task docs:check
```

O workflow de verificação executa a regressão com PostgreSQL e identidades
sintéticas. Ele não acessa contas institucionais. Depois de preparar o índice
Git, execute `deno task secrets`; o detector auxilia a revisão, mas não prova
ausência absoluta de dados privados.

## Documentação faz parte da mudança

Atualize o guia que orienta a tarefa afetada, a referência técnica e o estado
corrente quando necessário. Explique primeiro o problema e a relação entre as
partes; depois introduza o termo técnico. Preserve exemplos didáticos e condições
de aplicação. Registre o comando e o resultado de uma prova, sem inventar
evidências nem reutilizar uma prova cujo comportamento foi alterado.

Documentos históricos conservam a data e o alcance originais. Guias atuais devem
apontar para a referência vigente, evitando apresentar decisões antigas como
exigências permanentes. O inventário ajuda a manter essa separação.

## Entregar para revisão

Faça um commit coerente e uma descrição que apresente problema, mudança e
validação. Registre limitações materiais. Não inclua dumps, materiais acadêmicos,
identificadores privados, tokens ou arquivos de configuração protegidos. Migrations
e fixtures sintéticas necessárias fazem parte do código; dados de usuários não.

Código novo segue a licença [MIT](LICENSE). Respeite as
[atribuições de terceiros](THIRD_PARTY_NOTICES.md). Publicação de código não
autoriza mudanças em outras contas, instituições ou projetos.
