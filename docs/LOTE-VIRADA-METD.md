# Virada da memória canônica

Estado: **preparado, não autorizado, não aplicado**. Importar a memória no AraHub
e instalar a Skill não autoriza alterar o repositório privado de origem.

Destino operacional pretendido: AraHub como única memória de novas decisões;
METD preservado como fonte histórica, com seus arquivos e histórico Git. A
preparação privada contém novo AGENTS.md, README com aviso inicial, diff exato,
cópias originais e hashes. Nenhum arquivo da origem foi modificado.

## Lote para aprovação

Somente no repositório privado METD: substituir as instruções operacionais de
AGENTS.md por orientação de fonte histórica somente leitura e acrescentar aviso
no início do README. Preservar integralmente o conteúdo original do README, todos
os outros arquivos e o histórico. Publicar essas duas alterações exclusivamente
no remoto privado após os gates; sem arquivar/apagar o repositório, alterar
visibilidade, permissões, proteção de branch, workflows ou projetos irmãos.

Conferir e configurar o procedimento efetivo do cliente para recuperar/registrar
memória pelo AraHub. A Skill já instalada é a base; não pressupor que carregue
automaticamente em todas as superfícies. A aprovação deve identificar as
superfícies/instruções de cliente que poderão ser alteradas. Não substituir
instruções pessoais globais nem ampliar permissões do aplicativo por inferência.

## Gates antes de aplicar

- Conferir HEAD remoto/árvore/hashes contra o manifesto privado. Origem com
  mudanças novas exige staging/reconciliação/restore dessas mudanças antes da
  virada; nunca sobrescrever trabalho independente.
- Confirmar revisão semântica da recuperação e preferências legadas com fonte,
  escopo e incertezas. Correção pontual ou sugestão não vira preferência global.
- Confirmar backup corrente de banco/binários/manifesto, restauração local,
  configuração e chave/credencial protegidas separadamente; não presumir backup
  automático Free nem restauração do serviço Auth pelo dump da aplicação.
- O teste em celular físico foi dispensado pelo titular em 2026-10-06; registrar
  essa dispensa como mudança de aceite, sem fingir prova móvel. Reconfirmar
  recuperação e registro em conversa nova no cliente web antes da virada.
- Após os gates e a autorização, fixar marco UTC, commit de origem/destino, lote,
  configurações de cliente e recibos privados. Fazer conversa nova usando apenas
  AraHub; observar leitura e registro com proveniência e sem escrita no METD.

## Recuperação

Guardar os blobs/commit anteriores e as instruções/configuração de cliente
anteriores. Em falha, reverter somente os dois arquivos da virada e restaurar a
referência anterior do cliente, preservando os deltas novos no AraHub. Registrar
o intervalo/IDs e reconciliar antes de outra tentativa; não manter duas memórias
operacionais divergentes. Não fazer reset destrutivo, excluir dados, sobrescrever
histórico ou reenviar importação indiscriminada.

O diff, hashes, estado dos gates e roteiro executável ficam em
`.private/cloud/cutover/`. Este documento público não contém memória, credenciais
ou trechos das instruções privadas. A ausência do titular é um bloqueio de
autorização para aplicar, não motivo para perder a preparação.
