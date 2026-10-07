<?php
// MIT. Prova de captura de mensagem sintética, sem encaminhamento externo.
define('CLI_SCRIPT', true);
require('/var/www/html/config.php');

$instance = $argv[1] ?? '';
$subject = $argv[2] ?? '';
$url = parse_url($CFG->wwwroot);
$marker = trim(file_get_contents($CFG->dataroot . '/.arahub-lab-instance-id'));
if (!preg_match('/^[a-f0-9-]{36}$/', $instance) || $marker !== $instance ||
    !in_array($url['host'] ?? '', ['localhost', '127.0.0.1'], true) ||
    !in_array($url['port'] ?? 0, [8480, 8481], true) ||
    ($CFG->smtphosts ?? '') !== 'mailpit:1025' ||
    !preg_match('/^AraHub-LAB03-[a-f0-9-]{36}$/', $subject)) {
    fwrite(STDERR, "Origem, marcador ou destino SMTP fora do Lab.\n");
    exit(1);
}
$recipient = $DB->get_record('user', ['username' => 'labstudenta'], '*', MUST_EXIST);
$sender = $DB->get_record('user', ['username' => 'labteacher'], '*', MUST_EXIST);
foreach ([$recipient, $sender] as $person) {
    if (!preg_match('/^lab[a-z]+@example\.(com|invalid)$/', $person->email)) {
        fwrite(STDERR, "Conta não sintética recusada.\n");
        exit(1);
    }
}
$ok = email_to_user($recipient, $sender, $subject, 'Mensagem sintética capturada apenas no Moodle Lab.');
echo json_encode(['sent' => $ok, 'smtp_host' => $CFG->smtphosts,
    'synthetic_recipient' => true, 'instance_id' => $instance]), "\n";
exit($ok ? 0 : 1);
