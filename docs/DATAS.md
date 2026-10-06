# Datas preservadas e fusos

`hub_time_context` recebe `entity_ids` (1–20 IDs de recursos do dono) e, opcionalmente,
`display_zones` (1–4 fusos IANA). O padrão compara `Europe/Lisbon` e
`America/Sao_Paulo`. Não precisa de uma interface de planejamento: o consumidor é
o assistente pelo MCP. A interface auxiliar continua limitada a acesso/configuração/revisão.

Lê a observação preservada mais recente de cada recurso, com cobertura,
proveniência e conexão. Sem observação, a projeção do estado é explicitamente
`unverified_state_projection`. Não mistura datas de versões diferentes, atualiza
fonte, escreve calendário ou afirma disponibilidade atual. Um ID de outro dono
recusa a chamada inteira sem revelar nome/contagem do recurso alheio.

Para atividades Moodle, interpreta os segundos Unix positivos de `duedate`,
`cutoffdate`, `allowsubmissionsfromdate`, `gradingduedate` e até vinte datas de
estrutura de módulo. Zero significa ausência, não 1970. Para eventos Calendar,
preserva `start`, `end`, `originalStartTime`, status e transparência. O fim é
exclusivo; `endTimeUnspecified` conserva a incerteza, mesmo que a API forneça um
fim de compatibilidade. Isso segue a [representação oficial de eventos Google](https://developers.google.com/workspace/calendar/api/v3/reference/events).

Um instante com offset explícito é convertido para os fusos pedidos, incluindo
DST. Horário local com fuso confirmado é resolvido pelas regras IANA do runtime;
se cair em horário repetido ou inexistente, pede esclarecimento em vez de escolher.
Offset e fuso discordantes conservam o instante do offset e uma lacuna explícita.
Dia inteiro conserva somente a data; horário sem fuso confirmado conserva a
incerteza. Valores inválidos nunca viram datas corrigidas automaticamente.

A representação original é devolvida. Conversões têm precisão de milissegundos;
frações mais precisas continuam no original. Não interpreta datas vagas em texto
livre, expande recorrências ou infere envio/presença a partir de prazos. Observação
parcial, conexão expirada e ausência de dados permanecem visíveis.

Prova local: três cenários de normalização e um SQL/SDK integrado exercitam
Lisboa/São Paulo, verão/inverno, DST repetido/inexistente, dia inteiro, fim
indeterminado, data inválida, divergência de offset, fonte preservada e isolamento.
A função foi implantada no AraHub (ACTIVE v17) e anunciada ao plugin pessoal
após atualização de metadados. Em nova conversa ChatGPT, dois recursos
sintéticos deram prazo convertido para Lisboa/São Paulo e intervalo de dia
inteiro sem hora artificial, com `unverified_state_projection`. O ensaio
exercitou o cliente real, mas não exportou o trace bruto do streaming nem
consultou uma fonte acadêmica atual. A fixture foi removida e as onze
tabelas do dono conservaram os fingerprints do snapshot anterior.
