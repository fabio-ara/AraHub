# Lote de importação privada

Preparado e autorizado em 2026-10-06 com a resposta “Autorizo a importação privada”.
**Executado e verificado no destino.** Este lote é separado da publicação MIT/Pages
e do backend já aprovados.

Destino: somente a conta titular que confirmou e-mail e consentimento no projeto
Supabase **AraHub**, organização Universidade de Lisboa, Free/São Paulo. Nenhuma
outra conta recebe acesso. Os dados ficam no banco privado protegido por login/RLS,
fora do repositório público e dos arquivos servidos pelo GitHub Pages.

Escopo: 57 documentos brutos e 109 registros curados de memória, distribuídos em
nove contextos; 166 entidades e 109 vínculos às fontes. Preservar bytes/hash,
commit/localizador, texto original, evidência, datas vagas e versões. Origem METD
somente leitura; seu HEAD remoto foi reconferido e permanece igual ao staging.
Nenhum link externo passa a ser declarado lido por causa da importação.

O payload privado está preparado em `.private/cloud/PENDING-IMPORT.json` e no
diretório ali indicado, com SQL/manifesto/hash. O preparo usa o importador existente
em banco local novo com onze migrations e o identificador da conta de destino.
A restauração em outro banco novo, replay sem duplicação, hashes dos 57 binários,
isolamento de um segundo dono e recusa após mudança do destino foram aprovados.
O SQL tem transação, locks, verificação da conta confirmada, conflitos e igualdade
de snapshot. Não sobrescreve trabalho novo ou relaxa permissões.

Execução: origem/alvo/conta/registro/hash reconferidos, estado anterior preservado.
A primeira requisição foi recusada por tamanho (HTTP 413); destino reconferido vazio.
SQL compacto enviou cada conteúdo uma vez, com tabelas temporárias na mesma
transação e as mesmas guardas, sem alteração do snapshot. Restore/replay local dessa
versão aprovado antes de reenviar. O provedor confirmou a transação; nove contextos,
57 arquivos/hashes, 109 deltas e 109 vínculos conferidos por leitura independente.

O plugin real conectado nesta sessão recuperou os 109 registros únicos dos nove
históricos, com proveniência, os 57 arquivos e trecho de documento bruto. Nenhum
conteúdo foi tratado como autoridade. Snapshot obtido do Supabase foi restaurado
em banco local novo: onze tabelas/fingerprints, 57 binários/hashes, RLS e segundo
dono conferidos. Esse restore é de dados da aplicação; não restaura o serviço Auth
do provedor. Chaves/configurações possuem backup separado. A virada canônica exige
seus gates próprios; a importação não alterou METD nem instruções de projetos irmãos.

Sem custo adicional autorizado, serviços pagos, cron, coleta Google/Moodle,
publicação de dados, e-mails ou escritas acadêmicas. Não inclui alterações de
permissões ou compartilhamento com terceiros. Credenciais têm backup separado e
não fazem parte do lote de memória.
