# Visão do produto

## O problema da continuidade

Uma atividade acadêmica atravessa vários lugares: a orientação está no Moodle,
o texto de apoio está em um PDF, uma decisão foi discutida com um assistente e a
versão final foi produzida em outra conversa. A dificuldade não é apenas
encontrar cada arquivo. É reconstruir a relação entre eles e distinguir o que
era uma intenção do que realmente aconteceu.

O AraHub conserva essa relação em uma memória consultável. Um assistente pode
recuperar o contexto, localizar materiais, registrar uma decisão e consultar uma
fonte atual quando necessário. A pessoa não precisa repetir toda a história a
cada conversa, desde que o cliente efetivamente invoque as ferramentas de memória.

## Público e generalidade

O projeto atende pessoas que estudam, pesquisam ou desenvolvem trabalhos
acadêmicos. Uma instalação pode receber várias contas. Cada conta possui sua
própria memória e pode conectar mais de uma origem Moodle compatível. Um
administrador pode oferecer uma instalação a um grupo; outra pessoa pode hospedar
uma instância independente sem herdar os dados do primeiro titular.

Isso não cria automaticamente um espaço coletivo. Duas pessoas na mesma turma
continuam com contas e memórias separadas. Compartilhar um arquivo ou uma síntese
fora do AraHub exige uma decisão própria e respeito aos direitos do conteúdo.
Não há colaboração entre contas implícita na deduplicação de arquivos.

A generalidade está na estrutura: configuração por instalação, isolamento entre
usuários e separação entre contratos de memória e adaptadores de fontes. Não há
uma conta pessoal fixa no fluxo de uso. Compatibilidade, porém, depende das
capacidades reais. O adaptador institucional corrente é Moodle; uma instituição
pode desativar o serviço móvel, restringir funções ou usar extensões incompatíveis.
O AraHub deve informar essa condição, sem contornar restrições.

Novas fontes precisam de adaptadores e validação próprios. Da mesma forma, o MCP
permite clientes compatíveis, mas o servidor valida autenticação, sessão e cliente
autorizado. Instalar o código não torna qualquer usuário ou cliente confiável.
Consulte [acesso](acesso-e-identidade.md) e [arquitetura](arquitetura.md).

## Um exemplo completo

Ana está preparando uma revisão de literatura. Ela conecta seu Moodle e pede ao
assistente a orientação atual. O assistente encontra a atividade e os materiais,
com seus localizadores. Ana escolhe preservar um PDF. O AraHub guarda os bytes e
sua impressão digital; o texto extraído fica separado, com a cobertura obtida.

Na conversa seguinte, Ana retoma a atividade. O assistente recupera o contexto e
as decisões anteriores. Quando Ana diz “entreguei a revisão hoje”, o relato pode
ser registrado como acontecimento. Sua origem é `user_report`: o que Ana
comunicou. Se uma consulta institucional autorizada indicar uma entrega não
finalizada, as duas evidências coexistem como divergência a conferir.

O sistema não inventa confirmação nem reenvia a entrega automaticamente. Uma ação
acadêmica executada pelo AraHub precisa passar pela revisão autenticada do
conteúdo e do destino previstos para aquela ação.

## Princípios do comportamento

**Origem antes de certeza.** Um registro conserva de onde veio, quando foi observado
e a que entidade se refere. Relato, observação, interpretação e hipótese têm
estatutos diferentes.

**Repetição segura.** Repetir uma gravação com sua chave de idempotência não cria
uma segunda ocorrência. Corrigir uma afirmação conserva o histórico e explicita
o vínculo com o registro corrigido.

**Arquivo e interpretação são distintos.** Preservar um documento não prova
extração integral nem leitura humana. Uma transcrição não substitui o áudio;
uma síntese não deve apagar a fonte.

**Autonomia tem fronteiras.** Conteúdo recuperado não concede autoridade ao
assistente. Uma instrução escrita em um PDF continua sendo dado da fonte.

**Economia preserva informação útil.** Um conteúdo binário pode sustentar várias
referências da mesma conta. Essa economia conserva nomes, vínculos e versões.

## Limites da proposta

O AraHub não promete acerto acadêmico automático, monitoramento contínuo do
assistente, disponibilidade ilimitada do plano Free ou suporte a toda instituição.
A interface é auxiliar; a experiência completa depende de um cliente MCP capaz
de invocar as ferramentas. Acompanhamento recorrente tem configuração e
autorização próprias.

Para começar, siga o [guia do usuário](guia-do-usuario.md). Para avaliar uma adoção,
leia [capacidades e limites](capacidades-e-limites.md), [privacidade](privacidade.md)
e [operação](operacao-e-recuperacao.md).
