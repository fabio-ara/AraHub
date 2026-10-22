# Documentação oficial do AraHub

O AraHub ajuda a preservar a continuidade do trabalho acadêmico: o que foi
consultado, quais materiais foram guardados, que decisões foram tomadas e quais
acontecimentos ainda precisam de confirmação. Este mapa organiza a documentação
por tarefa. Os exemplos usam pessoas, contas e instituições fictícias.

Os guias deste mapa explicam o uso e a operação atuais. As referências técnicas
detalham contratos específicos. Relatórios de validação e lotes conservam
evidências datadas; uma condição antiga não substitui o
[estado corrente da entrega](../STATUS.md).

## Começar a usar

1. A [visão do produto](visao-do-produto.md) apresenta o problema, o público e o
   alcance da proposta.
2. O [guia do usuário](guia-do-usuario.md) acompanha entrada, conexão Moodle,
   retomada de uma atividade e revisão de ações.
3. [Acesso e identidade](acesso-e-identidade.md) explica os métodos de entrada e a
   diferença entre a conta AraHub e a conta institucional.
4. [Instalar o MCP sem Codex](INSTALAR-MCP-SEM-CODEX.md) trata da conexão do cliente.
   [Capacidades e limites](capacidades-e-limites.md) ajuda a avaliar o uso pretendido.

## Entender memória e fontes

| Pergunta | Leitura |
| --- | --- |
| Como retomar algo dito em outra conversa? | [Memória](MEMORIA.md) e [acontecimentos acadêmicos](ACONTECIMENTOS-ACADEMICOS.md) |
| O que significa “entregue” ou “pendente”? | [Acontecimentos](ACONTECIMENTOS-ACADEMICOS.md) e [consulta do próprio status](STATUS-PROPRIO.md) |
| O sistema leu todo o material? | [Arquivos](ARQUIVOS.md), [processamento](PROCESSAMENTO-MATERIAIS.md) e [pacote de estudo](PACOTE-ESTUDO.md) |
| Quando uma informação fica desatualizada? | [Sincronização](SINCRONIZACAO.md) e [datas](DATAS.md) |
| Minhas preferências mudam as permissões? | [Preferências](PREFERENCIAS.md) e [privacidade](privacidade.md) |

## Administrar uma instalação

Comece pela [instalação e configuração](guia-de-instalacao.md). Ela apresenta a
separação entre interface, autenticação, backend e banco. Em seguida:

- [Acesso e identidade](acesso-e-identidade.md): métodos de entrada, cadastro e
  condições necessárias para receber outras pessoas.
- [Armazenamento](armazenamento.md): referências, binários, deduplicação, medição
  de uso e preservação de versões.
- [Operação e recuperação](operacao-e-recuperacao.md): pausa no plano Free,
  diagnóstico, cópias de segurança e retorno ao serviço.
- [Privacidade](privacidade.md): isolamento, credenciais, direitos e exclusão.

O aviso de inatividade da Supabase não é um aviso de armazenamento cheio. Para
entender essa distinção, consulte [operação e recuperação](operacao-e-recuperacao.md).

## Desenvolver e verificar

1. A [arquitetura](arquitetura.md) explica o caminho de uma requisição e as
   fronteiras entre identidade, memória e fontes.
2. O [guia do desenvolvedor](guia-do-desenvolvedor.md) descreve ambiente, módulos e
   testes. [CONTRIBUTING](../CONTRIBUTING.md) define a entrega de mudanças.
3. [Cliente MCP](CLIENTES.md), [Moodle](MOODLE.md) e
   [acontecimentos](ACONTECIMENTOS-ACADEMICOS.md) detalham os contratos.
4. O [aceite](ACEITE.md), a [instalação limpa](INSTALACAO.md) e a
   [validação hospedada](VALIDACAO-HOSPEDADA.md) explicam o alcance de cada prova.

## Consultar termos, fontes e história

O [glossário](glossario.md) define os termos usados. As
[fontes oficiais](fontes-oficiais.md) reúnem a documentação dos serviços externos.
O [inventário integral](inventario-documentacao.md) identifica cada referência.
O [Git](https://github.com/fabio-ara/AraHub) conserva a evolução do código.

Uma mudança de comportamento deve atualizar o guia correspondente e a referência
técnica afetada. Evidências com contas, tokens ou materiais pessoais ficam fora
do repositório público. `deno task docs:check` verifica destinos locais dos links;
a revisão de conteúdo continua necessária para confirmar a precisão do texto.
