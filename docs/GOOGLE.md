# Integrações Google de conteúdo (caminho aposentado)

Este documento trata das antigas ferramentas de conteúdo. O login com Google
é uma opção independente do Supabase Auth, descrita em
[acesso e identidade](acesso-e-identidade.md#entrar-com-google-sem-esperar-um-e-mail).

O caminho operacional Google próprio do AraHub foi **retirado**: OAuth, leituras
(Gmail/Calendar/Drive/Docs/Sheets/Slides), sincronização e as escritas de
Docs/Sheets/Slides não existem mais como ferramentas do servidor.

Para Gmail, Drive/Docs/Sheets/Slides e Calendar, use as ferramentas do próprio
assistente. O AraHub não chama essas ferramentas internamente; a composição
acontece na conversa e o AraHub guarda contexto, referências, proveniência e
memória entre conversas.

O histórico já preservado continua acessível e não foi apagado: conexões,
credenciais no cofre, observações e registros de ações permanecem no banco, e os
snapshots JSON nativos gravados podem ser lidos offline por `hub_read_material`
(leitor genérico de material preservado, por file_id/hash e JSON Pointer). As
tabelas, migrations e o cofre não foram removidos.

Ações Google antigas registradas permanecem apenas como histórico e não são
aprováveis nem executáveis; o caminho de execução foi removido.
