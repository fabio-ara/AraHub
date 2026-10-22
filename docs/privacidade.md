# Privacidade, segurança e responsabilidade

O AraHub conserva informações que podem revelar cursos, atividades, decisões e
trabalho intelectual. A finalidade é permitir continuidade ao dono da conta.
Instalar ou publicar o código sob MIT não autoriza divulgar esses dados.

## O que fica guardado e por quê

| Informação | Finalidade e cuidado |
| --- | --- |
| Identidade AraHub | Autenticar a pessoa, vincular sessões e separar contas. |
| Conexão institucional | Identificar origem, conta associada e estado de acesso. |
| Credencial Moodle | Consultar operações permitidas; fica cifrada em esquema privado. |
| Entidades e observações | Preservar a identificação e o conteúdo observado, com proveniência e cobertura. |
| Contextos e deltas | Retomar decisões e acontecimentos, incluindo correções e versões. |
| Arquivos e representações | Conservar originais e resultados de extração sem confundir suas evidências. |
| Ações e aprovações | Demonstrar o conteúdo autorizado e o resultado conhecido ou incerto. |

A memória é formada pelas ferramentas invocadas. O AraHub não recebe
automaticamente todas as mensagens de uma conversa nem toda a navegação da pessoa.
O cliente de inteligência artificial tem suas próprias condições de tratamento;
configurar o AraHub não altera as políticas desse cliente.

## Quem pode acessar

Usuários autenticados recebem seus próprios registros. O isolamento usa o dono
validado no servidor e políticas PostgreSQL por linha. Conhecer um UUID, um nome
de arquivo ou um hash não dá acesso aos dados de outra conta. A deduplicação é
restrita ao mesmo dono; não cria uma biblioteca global compartilhada.

Administradores de infraestrutura têm privilégios operacionais. RLS protege os
usuários comuns e as APIs que a respeitam, mas não constitui criptografia ponta a
ponta contra quem administra banco, serviço ou chaves. Escolher uma instalação
implica confiar no seu operador e conhecer suas práticas de backup e suporte.

A fonte institucional continua com seus próprios controles e registros de
atividade. Uma consulta de leitura pode produzir efeitos técnicos internos,
como logs e atualização de último acesso. O AraHub não promete invisibilidade
perante a instituição.

## Credenciais e permissões

A interface recebe apenas a chave pública apropriada para o cliente. Chaves
administrativas, segredo do cofre e acesso ao banco permanecem no servidor ou em
ambiente protegido. O conteúdo de um documento não pode substituir consentimento
nem alterar uma política de acesso.

Uma chave móvel Moodle pode possuir permissões mais amplas que as operações
expostas pelo AraHub. O adaptador restringe o que executa, mas a proteção da chave
continua essencial. Para revogar o acesso, considere tanto a conexão AraHub quanto
a chave e a sessão na instituição.

Aprovação de uma ação externa é específica a conteúdo, destino e versão. Um
consentimento para consultar o próprio status não permite ler o status de colegas
nem executar entregas. Preferências de estilo ou autonomia não concedem novos
privilégios.

## Retenção, versões e exclusão

Uma correção de memória conserva o histórico para explicar como a informação
mudou. Essa é uma escolha funcional, não uma política legal universal de retenção.
Cada operador deve estabelecer finalidade, período de conservação, suporte e
procedimento para solicitações dos usuários conforme seu contexto.

Revogar uma conexão impede usos futuros daquele acesso, mas não equivale a apagar
todas as informações já preservadas. A exclusão da conta é outra operação. Antes
de executá-la, verifique o alcance: registros vinculados, binários, credenciais,
sessões e eventuais cópias de recuperação. Um arquivo reutilizado por outras
referências do mesmo dono precisa continuar disponível enquanto elas existirem.

Backups têm vida própria. Apagar um registro no serviço ativo não reescreve
automaticamente todas as cópias anteriores. O operador deve prever retenção e
descarte dessas cópias e evitar que uma restauração reintroduza inadvertidamente
dados cuja exclusão foi solicitada.

## Exportação e recuperação

A exportação de registros facilita inspeção e portabilidade. Recuperação de uma
instalação exige mais: estrutura do banco, dados, binários, configuração, chaves e
identidade precisam de procedimentos próprios. Uma cópia sem a chave necessária
para abrir o cofre não restabelece as conexões. Restaurar a aplicação não prova
restauração do Supabase Auth gerenciado.

Consulte [operação e recuperação](operacao-e-recuperacao.md) e
[armazenamento](armazenamento.md). Os arquivos de backup devem ter acesso restrito;
nunca devem ser enviados ao repositório público ou servidos pelo GitHub Pages.

## Ao relatar um problema

Prefira descrever o comportamento, o horário, a versão e o caminho percorrido.
Remova senhas, tokens, links assinados, conteúdos acadêmicos privados e dados de
outras pessoas. Uma captura de tela também pode expor esses elementos. O suporte
não precisa de uma senha colada em uma issue pública para começar a investigação.

Esta documentação descreve mecanismos técnicos e responsabilidades operacionais.
Ela não certifica conformidade jurídica de qualquer adoção institucional.
