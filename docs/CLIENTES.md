# Clientes e primeiro uso

AraHub fornece Moodle e memória acadêmica privada ao assistente. Google Drive, Docs, Sheets, Slides,
Gmail e Calendar são usados pelas ferramentas do cliente; o servidor AraHub não chama esses
conectores nem recebe seus tokens OAuth.

1. Entre na interface HTTPS da instalação. Abra o link de acesso no navegador que iniciou o pedido;
   não envie códigos ou links de login ao assistente.
2. Em Conexões, cadastre a origem Moodle e sua chave somente no formulário protegido. Renovação
   mantém a identidade da conexão e o histórico.
3. No plugin pessoal, peça a retomada do contexto com fontes, cobertura e incertezas. Uma fonte sem
   consulta recente deve aparecer como desatualizada.
4. Produza documentos nas ferramentas adequadas do cliente. Para transferir, passe o objeto de
   arquivo/exportação para `hub_import_artifact`; não converta um caminho local em link público nem
   envie base64 nos argumentos.
5. Para publicar ou entregar, prepare uma ação e revise sua versão completa na interface
   autenticada. Quando houver declaração, leia e assinta ali. A execução usa a aprovação dessa
   intenção uma única vez. Resultado incerto exige consultar recibos, sem repetir o envio.

A disponibilidade depende das funções oferecidas pela instituição e dos gates registrados em
`../STATUS.md`. A implementação local de uma ferramenta não prova que já foi instalada no cliente.
Assignment permanece bloqueado em produção pela rota de status até revisão específica da política;
não usar uma entrega real para preencher a matriz de testes.

Para estudo, consulte materiais por entidade, versão/hash e localizador. A fila `hub_queue_document`
aceita DOCX/HTML preservados; `hub_document_blocks` recupera parágrafos, tabelas e links extraídos.
Job pendente requer executor; não indica que o conteúdo foi lido. Snapshots Google antigos
permanecem consultáveis por `hub_read_material`, sem reativar conexão operacional Google.

O MCP não captura o transcript completo. A Skill registra fatos e decisões pertinentes por
`hub_record_delta`, preservando fonte, escopo, hipótese e revisão. História e biografia não se
reduzem à lista de tarefas. `hub_observations` e `hub_observation` permitem aprofundar versões; a
prévia não é o histórico inteiro.

O plugin distribuído contém manifest, ligação ao app, Skill e licença. Prepare com
`deno task plugin:prepare` e confira o ID e o nome técnico já cadastrados; IDs e vínculos pessoais
ficam na cópia privada. Depois de atualizar o backend, a descoberta de ferramentas deve ser
atualizada no app existente. Verifique a versão ativa e teste uma conversa nova. Não remova uma
conexão para tentar instalar uma Skill, nem confunda preparação do ZIP com instalação.

Não há acompanhamento recorrente ativo por padrão. Layout em viewport móvel e celular físico são
provas diferentes. A interface concentra autenticação, conexões, preferências, saúde/exportação e
aprovação; a rotina acadêmica ocorre no chat.

## Pedidos cotidianos

- “Retome meu contexto acadêmico, indicando as fontes e o que está desatualizado.”
- “Leia o enunciado e compare as versões da ficha; justifique a escolha pelo conteúdo.”
- “Mostre separadamente a postagem inicial e os comentários exigidos no fórum.”
- “Prepare o envio desta versão do arquivo e abra a revisão, sem executá-lo ainda.”
- “Recupere o recibo da ação anterior e a versão exata do arquivo.”

Retomada, busca e preferências omitem contextos explicitamente declarados como testes técnicos. Esse
histórico continua preservado: uma auditoria pode usar `include_synthetic=true`, o ID do contexto ou
`hub_history`. Nome de arquivo, título ou texto contendo a palavra “teste” não classifica uma
memória como fixture.

Um pedido para preparar envio não é consentimento para executá-lo. Confira na revisão a conta,
atividade, versão e anexos; alteração desses dados exige nova aprovação. Os exemplos de envio
dependem das permissões da instalação e das homologações registradas no STATUS, inclusive a revisão
institucional do status.
