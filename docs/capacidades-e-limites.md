# Capacidades e limites atuais

Referência funcional da linha 0.3, revista em 22/10/2026. O resultado da publicação
na instância inicial e suas provas estão em [STATUS](../STATUS.md). Capacidade do
código, configuração da instalação e evidência de uso são níveis diferentes.

| Capacidade | O que o código oferece | Condição ou limite |
| --- | --- | --- |
| Várias contas | Memória, conexões e arquivos separados por proprietário com RLS. | Admissão depende de Auth; não há espaço coletivo implícito. |
| Login configurável | Link por e-mail, senha para contas existentes e provedores Google/GitHub/Azure. | Provedores e SMTP precisam ser configurados e testados na instalação. |
| Cadastro aberto | Criação de conta pelo fluxo de link quando permitida pelo Auth. | Flag da UI não substitui política do servidor; não há cota de bytes por conta. |
| Recuperação de senha | Pedido de link e formulário autenticado de nova senha. | Depende de entrega do e-mail e validade do fluxo. |
| Moodle | Conexões por origem/conta, consulta de capacidades auditadas e preservação de materiais. | Serviço móvel e permissões variam por instituição. |
| Memória longitudinal | Contextos, deltas, acontecimentos, correções e proveniência. | Depende da invocação das ferramentas; não há captura passiva do chat. |
| Arquivos | Originais, hashes e representações; biblioteca e transferências em partes. | Limites de formato, tamanho e processamento continuam aplicáveis. |
| Deduplicação | Reutilização de binários idênticos dentro da mesma conta. | Não compartilha conteúdo entre donos nem apaga versões diferentes. |
| Ações acadêmicas | Preparação, revisão autenticada e reconciliação de resultado. | Exigem conteúdo/destino aprovados; resultado incerto não autoriza reenvio. |
| Cliente MCP | Ferramentas sobre HTTP e autenticação OAuth. | Cliente precisa ser compatível e autorizado pela instalação. |
| Recorrência | Engenharia e contratos próprios de acompanhamento. | Não é ativada automaticamente por cadastro, publicação ou conversa. |
| Hospedagem Free | Operação dentro dos limites do provedor. | Pausa por inatividade continua possível; não há disponibilidade garantida. |

## Generalidade com limites explícitos

O código pode ser usado por outras pessoas e instituições sem importar a memória
do titular original. URLs e métodos de entrada são configuráveis; cada usuário
conecta suas fontes. Isso não significa compatibilidade automática com qualquer
portal, cliente de IA, extensão Moodle ou sistema de identidade.

Não há um adaptador genérico que leia qualquer sistema acadêmico. As integrações
próprias Google de conteúdo foram retiradas; use ferramentas do cliente para
essas fontes e preserve resultados pelo caminho autorizado quando necessário.
Login social é apenas identidade e não reintroduz essas integrações.

## Evidência que uma adoção precisa conferir

Testes locais verificam contratos, concorrência, idempotência e isolamento sob
identidades controladas. Provas hospedadas verificam infraestrutura e Auth
reais. Uma instituição exige sua própria verificação de capacidades permitidas.
Uma sessão desktop em viewport estreito não equivale a teste em aparelho móvel
físico. Uma restauração do banco da aplicação não equivale à restauração do
Supabase Auth gerenciado.

Ao oferecer uma instalação a outras pessoas, confira SMTP/remetente, duas contas,
revogação, recuperação, limites e procedimento de suporte. O operador precisa
acompanhar crescimento, pois a economia de duplicatas não limita conteúdos novos.
Os guias de [instalação](guia-de-instalacao.md), [privacidade](privacidade.md) e
[operação](operacao-e-recuperacao.md) detalham essas responsabilidades.

## O que não é uma confirmação

Um relato de entrega não é recibo institucional. Uma consulta vazia após erro não
é prova de ausência. Um arquivo preservado não prova leitura integral. Uma ação
incerta não comprova sucesso ou fracasso. Esses estados são parte do produto e
devem permanecer visíveis para orientar a próxima decisão.
