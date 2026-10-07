# Entrada de outras pessoas no AraHub

Estado em 2026-10-06: o código MIT é público e a interface está hospedada, mas a
instância Supabase do titular continua **fechada a inscrições públicas**. Esta
nota separa a entrada no AraHub da conexão da conta Moodle.

## O que já funciona sem Codex

Uma pessoa que tenha conta provisionada nesta instalação entra pelo link de
e-mail e abre Conexões → Moodle. A interface abre o `launch.php` oficial da
instalação Moodle indicada; depois do SSO, a pessoa copia o endereço do link
“Abrir o aplicativo” e o cola no campo mascarado do AraHub. O cliente extrai
somente a chave Web Service e descarta a chave privada de autologin. O backend
valida a identidade Moodle, cifra a chave, isola dados por proprietário e expõe
apenas as funções de leitura auditadas. O serviço móvel do Moodle pode criar a
chave durante esse fluxo; **não é preciso entrar antes pelo aplicativo no
celular**. Se a instalação desativar o serviço móvel ou não oferecer o link, o
AraHub deve mostrar a lacuna e não tentar contornar a política institucional.

O uso cotidiano é pelo plugin no ChatGPT. A interface é necessária para a
primeira entrada, conexão/renovação Moodle, autorizações específicas e extração
de PDFs no navegador enquanto o backend não dispõe de worker isolado para isso.
Nenhum terminal, script ou Codex é necessário para a pessoa conectar o Moodle.

## Fronteira ainda fechada

O formulário hospedado usa `signInWithOtp` com `shouldCreateUser: false`; um
endereço novo não se cadastra sozinho. Trocar só esse parâmetro no JavaScript
não é controle de segurança: a política de cadastro tem de permanecer no Auth
do projeto. O SMTP padrão do Supabase entrega apenas a endereços autorizados da
equipe do projeto e está limitado a duas mensagens por hora, segundo a
[documentação de SMTP](https://supabase.com/docs/guides/auth/auth-smtp) e de
[limites de Auth](https://supabase.com/docs/guides/auth/rate-limits). Assim, o
projeto pessoal Free atual não suporta, de forma confiável, cadastro por e-mail
de qualquer visitante. Abrir inscrições exigiria provedor de identidade/entrega
adequado, controle de abuso, cota/backup e testes reais de dois usuários.

O mandato privado exige aprovação específica antes de convidar terceiros ou
oferecer esta instância como serviço público. Publicar código MIT ou uma página
estática não concedeu essa aprovação. Quem hospeda sua própria instalação pode
configurar seu Auth e suas cotas sem acessar os dados do titular.

## Lote para eventual serviço público

Antes de alterar a instância pessoal, apresentar ao titular o provedor de
entrada escolhido, eventual custo e conta responsável, domínio/redirecionamentos,
política de retenção/exclusão, limites de uso e prova de isolamento com uma
segunda conta real consentida. Depois da aprovação específica, configurar o
Auth do projeto, liberar o formulário, testar entrega/login/consentimento Moodle
sem Codex, RLS/recusas cruzadas e consumo de cota. Não ativar cron, importar
dados de outra pessoa, conceder scopes adicionais ou assumir que o SSO Moodle
é um OAuth público do AraHub.
