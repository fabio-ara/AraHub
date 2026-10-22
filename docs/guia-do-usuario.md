# Guia do usuário

Este guia acompanha uma conta individual. Os controles disponíveis dependem dos
métodos de entrada habilitados pelo administrador. Comece pela URL da instalação
que pretende usar: uma conta de uma instalação não concede acesso a outra.

## 1. Entrar e reconhecer as duas contas

A conta AraHub identifica o dono da memória. A conta Moodle permite consultar uma
instituição. Você entra primeiro no AraHub e conecta o Moodle depois. As senhas e
os consentimentos dessas duas contas não são intercambiáveis.

Na tela inicial, escolha uma forma de entrada oferecida. Se usar link por e-mail,
solicite o link e abra-o no mesmo navegador que iniciou o processo. Se a
instalação exigir convite, um endereço ainda não cadastrado precisa ser admitido
pelo administrador. Quando houver login social, o botão leva ao provedor
configurado; não cole tokens ou senhas na conversa com o assistente.

Uma instalação pode aceitar senha e oferecer recuperação. O método disponível e
a entrega de mensagens dependem da configuração de identidade.
[Acesso e identidade](acesso-e-identidade.md) explica os casos em detalhe.

## 2. Conectar o Moodle

Em Conexões, use **Adicionar Moodle**. Dê um nome que reconheça, como
“Universidade — pós-graduação”, e informe a origem HTTPS oficial. A conexão será
usada para consultar conteúdo com sua identidade institucional.

A interface oferece a entrada móvel oficial do Moodle. Depois de autenticar-se
na instituição, siga a instrução para copiar o endereço do link “Abrir o
aplicativo” e cole-o no campo mascarado do AraHub. O sistema extrai a chave
necessária, descarta a chave privada de autologin e valida a identidade pela API.
O valor não deve ser publicado, enviado ao chat ou incluído em capturas.

O serviço móvel pode conceder à chave mais funções do que o AraHub utiliza.
O adaptador aplica sua própria lista de operações permitidas. Se a instituição
não oferecer esse acesso, procure o suporte institucional. Consulte [Moodle](MOODLE.md).

Se a chave expirar ou for revogada, renove a conexão pela interface. A renovação
pode invalidar consentimentos ligados à identidade anterior. Revogar uma conexão
não deve ser confundido com apagar toda a memória histórica que tem aquela origem.

## 3. Conectar o assistente

Use o [manual de instalação MCP](INSTALAR-MCP-SEM-CODEX.md). A autenticação OAuth
do cliente apresenta uma revisão do acesso. Confira aplicativo e conta antes de
aprovar. O MCP é o canal pelo qual o assistente chama o AraHub; ter uma conexão
não significa que cada mensagem seja gravada automaticamente.

Peça uma operação concreta e confira o resultado quando precisar de persistência:

> “Retome o contexto desta atividade, incluindo minhas decisões e os materiais
> preservados. Indique o que precisa de uma consulta atual.”

Para registrar algo:

> “Registre que concluí a leitura do capítulo 2 hoje. Essa é uma informação que
> estou relatando; ainda não existe confirmação da instituição.”

O assistente deve vincular o acontecimento à atividade correta. Se houver duas
atividades plausíveis, esclarecer evita gravar no contexto errado. Os
identificadores são obtidos pela consulta do AraHub; você não precisa inventá-los.

## 4. Consultar informações atuais

Retomar a memória recupera registros preservados. Consultar o Moodle agora
observa a fonte no momento da execução e pode encontrar mudanças.

> “Consulte a orientação atual da atividade e compare com o que está registrado.
> Mostre mudanças de prazo e mantenha as fontes de cada informação.”

Uma consulta parcial deve continuar identificada como parcial. Falha de acesso
não demonstra ausência de atividades nem entrega concluída. Datas de ocorrência,
observação e gravação também podem diferir. Os guias de [datas](DATAS.md) e
[sincronização](SINCRONIZACAO.md) explicam essa distinção.

## 5. Trabalhar com materiais

A biblioteca apresenta materiais preservados disponíveis na conta. Abrir um
formato suportado permite examiná-lo; baixar permite obter uma cópia pelos
controles destinados à pessoa usuária. Uma referência institucional pode existir
sem uma cópia binária preservada.

O texto extraído de um PDF, documento ou vídeo tem origem e cobertura próprias.
Um PDF digitalizado pode depender de OCR que a instalação não oferece. Uma
transcrição pode conter lacunas. Peça quais páginas, trechos ou intervalos
sustentam uma resposta.

Quando o mesmo binário aparece em duas atividades da sua conta, o armazenamento
pode reaproveitar os bytes. As duas referências continuam existindo, pois seus
contextos diferem. Outro usuário não ganha acesso ao arquivo por ter o mesmo nome
ou a mesma impressão digital.

## 6. Relatar uma entrega ou executar uma ação

Se você relata que entregou um trabalho diretamente no Moodle, o AraHub pode
guardar o relato. Isso não executa uma entrega nem cria recibo institucional.
Quando houver autorização para consultar seu próprio status, a observação pode
complementar ou divergir desse relato.

Se pedir uma publicação ou entrega pelo AraHub, revise na interface o destino,
conteúdo, anexos e versão. A autorização vale para aquela ação. Uma mudança de
conteúdo ou uma autorização vencida exige nova revisão.

Após falha de rede, o resultado pode ficar **incerto**. A prioridade é verificar o
que aconteceu na fonte. Repetir automaticamente poderia duplicar uma publicação;
“incerto” não confirma sucesso nem fracasso.

## 7. Corrigir, exportar e sair

Para corrigir, indique a afirmação anterior e a correção. O histórico deve
permanecer, sem tratar as versões como fatos independentes. Uma preferência não
concede permissão para publicar, mudar políticas ou ler dados de terceiros.

A exportação privada disponível na interface reúne registros para inspeção e
portabilidade. Ela não substitui sozinha a recuperação completa do serviço, que
também considera binários e credenciais protegidas. Antes de excluir uma conta,
confira o alcance e a recuperação pretendida. [Privacidade](privacidade.md)
detalha as responsabilidades.

Em computador compartilhado, use **Sair** e encerre também as sessões
institucionais necessárias. Não deixe chaves Moodle em mensagens ou arquivos
públicos.

## Quando algo não funciona

| Sintoma | Verificação inicial |
| --- | --- |
| O link de entrada não chega | Cadastro permitido, spam e e-mail da instalação; repetir pode atingir limites. |
| Serviço indisponível | Rede e estado da instância; a pausa Free depende do administrador. |
| Memória não encontrada | Conta/instância conectada, contexto e existência de gravação confirmada. |
| Moodle recusou conexão | Origem oficial, chave válida, identidade e serviço móvel permitido. |
| Extração incompleta | Cobertura e formato original; não presuma leitura integral. |
| Ação incerta | Verifique a fonte antes de uma nova tentativa. |

Veja também [operação e recuperação](operacao-e-recuperacao.md).
