# Estado do AraHub

## Versão 0.3.0 — preparada em 22/10/2026

A evolução solicitada inclui documentação oficial organizada, métodos de entrada
configuráveis e deduplicação de arquivos dentro de cada conta. O índice corrente
é [docs/README.md](docs/README.md). O histórico anterior permanece no Git; este
arquivo registra somente a situação e o próximo passo executável.

## Implementação

- Guias didáticos de uso, instalação, identidade, arquitetura, privacidade,
  armazenamento, operação, recuperação e desenvolvimento; inventário do acervo.
- Entrada por link, senha e recuperação; Google/GitHub/Microsoft opcionais por
  configuração. Política de cadastro apresentada pela UI e aplicada pelo Auth.
- Conteúdo binário reutilizado por dono e SHA-256, com igualdade dos bytes,
  integridade, referências e RLS preservadas. Exportação mantém os bytes resolvidos.
- Métricas de conteúdo efetivamente armazenado e economia por conta; manutenção
  local explícita e verificador de links da documentação; CI com PostgreSQL real.

## Validação concluída antes da implantação

Regressão consolidada: **283 testes passaram, 2 ignorados**, com PostgreSQL local
real. Duas falhas da primeira execução foram corrigidas e os respectivos cinco
casos passaram na repetição dirigida. Testes de armazenamento/exportação e do
importador processado também passaram após seus ajustes finais. Tipos gerais,
Edge e interface, build e 196 links locais passaram. Os dois casos ignorados
continuam dependentes de pré-requisitos opcionais, sem alegação de execução.

Instalação limpa comprovou as 17 migrations e cliente MCP SDK/HTTP com duas
identidades locais. O backup hospedado foi restaurado em banco separado: 117
arquivos, hashes e 12 tabelas; cofre verificado separadamente, sem gravar texto
aberto. Isso não constitui restauração do Supabase Auth gerenciado.

Na cópia restaurada, 117 referências passaram a usar 104 objetos, reduzindo bytes
binários de 89.900.839 para 80.118.099. Os bytes originais e os metadados das 12
tabelas coincidiram antes/depois. Esses números são conteúdo lógico armazenado,
não uma promessa de diminuição imediata do tamanho físico do PostgreSQL.

UI inspecionada visualmente e exercitada em 390 e 1280 pixels no Chrome dedicado:
link, convite/cadastro, senha, recuperação, consentimento pendente, início social
PKCE e indisponibilidade/retentativa. Respostas Auth controladas nessa prova;
nenhum e-mail real foi enviado. Os roteiros gerais de UI e Pages também passaram.

## Implantação existente e limites

Antes desta atualização, a instalação hospedada estava ativa, no plano Free,
Edge36 e 16 migrations. A publicação 0.3.0, a conversão dos arquivos existentes e
a prova hospedada final estão em execução; ainda não são declaradas concluídas.
Evidências e recuperação ficam em `.private/universal/`, fora do repositório.

A escolha do titular foi e-mail com SMTP próprio. A instância usa SMTP padrão,
sem Google configurado e com cadastro fechado. A entrada de terceiros depende de
conta de envio, remetente verificado e teste real de entrega. A preparação da
opção gratuita está em [acesso e identidade](docs/acesso-e-identidade.md).

O diagnóstico Supabase anterior à mudança contém 29 avisos de desempenho de RLS
preexistentes e um aviso de proteção contra senhas vazadas desativada; nenhum
aviso de RLS ausente. A nova tabela usa políticas com identidade avaliada uma vez.
Não houve contratação, cron de manutenção artificial nem alteração de projeto
irmão. Economizar armazenamento não impede a pausa por inatividade do plano Free.

Os workers solicitados foram tentados com o modelo herdado, mas retornaram 429
repetidamente; não produziram alterações. O trabalho foi executado pela sessão
principal, sem recorrer a outro provedor pago.

## Próximo passo

Aplicar a migration aditiva conferida, implantar o backend, compactar com guarda
de hashes, comprovar identidade/MCP real de duas contas descartáveis, publicar
Pages e verificar CI, assets servidos e dados preservados. SMTP permanece uma
etapa humana de credencial e validação do remetente, nunca uma senha enviada no chat.
