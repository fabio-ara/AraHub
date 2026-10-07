<?php
// AraHub — Moodle Lab: gerador de fixtures e utilidades nativas.
//
// Autoria própria do AraHub (não é código do Moodle copiado). Executa DENTRO do
// container do Lab, sobre uma instalação Moodle pinada, usando apenas APIs
// públicas do Moodle (data generators, enrol, file_storage, external services).
// Nunca imprime tokens; segredos sintéticos vão para arquivos sob o dataroot.
//
// Uso:
//   php moodle_lab.php seed
//   php moodle_lab.php ws
//   php moodle_lab.php snapshot <tag> <assignid> <userid>
//   php moodle_lab.php oracle <assignid> <userid>

define('CLI_SCRIPT', true);

$wwwroot = getenv('ARAHUB_LAB_WWWROOT') ?: '/var/www/html';
$fixtures = getenv('ARAHUB_LAB_FIXTURES') ?: '/opt/arahub-lab/fixtures';

require($wwwroot . '/config.php');
require_once($CFG->libdir . '/clilib.php');
require_once($CFG->dirroot . '/lib/testing/generator/lib.php');
require_once($CFG->dirroot . '/lib/externallib.php');
require_once($CFG->dirroot . '/lib/filelib.php');
require_once($CFG->dirroot . '/lib/enrollib.php');
require_once($CFG->dirroot . '/course/lib.php');
require_once($CFG->dirroot . '/group/lib.php');
require_once($CFG->dirroot . '/grade/lib.php');
require_once($CFG->dirroot . '/user/lib.php');
require_once($CFG->dirroot . '/lib/navigationlib.php');
require_once($CFG->dirroot . '/mod/forum/lib.php');
require_once($CFG->dirroot . '/mod/assign/locallib.php');

global $DB, $CFG, $USER;

$cmd = $argv[1] ?? 'help';
// Antes de criar diretorios, assumir admin ou executar qualquer comando nativo.
// O controlador confere tambem as etiquetas Docker; o helper recusa uso avulso
// fora de uma instalacao local com marcador de propriedade valido.
$labmarker = trim((string)@file_get_contents($CFG->dataroot . '/.arahub-lab-instance-id'));
$laburl = parse_url($CFG->wwwroot);
$labhost = $laburl['host'] ?? '';
$lablocal = $labhost === 'localhost' || $labhost === '[::1]' ||
    (filter_var($labhost, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4) && explode('.', $labhost)[0] === '127');
if (!preg_match('/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i', $labmarker) ||
        !$lablocal || !in_array($laburl['scheme'] ?? '', ['http', 'https'], true) ||
        ($laburl['port'] ?? 0) < 1024 || !in_array($laburl['path'] ?? '', ['', '/'], true) ||
        isset($laburl['user']) || isset($laburl['pass']) || isset($laburl['query']) || isset($laburl['fragment'])) {
    lab_fail('origem local ou marcador de propriedade invalido');
}
$outdir = $CFG->dataroot . '/arahub-lab';
if (!is_dir($outdir)) {
    mkdir($outdir, 0777, true);
}

\core\session\manager::set_user(get_admin());
// Mantem o stdout limpo para o JSON: debugging vai para o error_log (stderr).
$CFG->debugdisplay = 0;

function lab_out(array $data): void {
    echo "ARAHUB-LAB-JSON:", json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), "\n";
}

function lab_fail(string $message): void {
    fwrite(STDERR, "LAB-ERROR: {$message}\n");
    exit(1);
}

/** PDF mínimo válido (1 página, texto). Autoria própria. */
function lab_make_pdf(string $title, array $lines): string {
    $esc = function (string $s): string {
        return str_replace(['\\', '(', ')'], ['\\\\', '\\(', '\\)'], $s);
    };
    $content = "BT /F1 16 Tf 60 780 Td (" . $esc($title) . ") Tj ET\n";
    $y = 750;
    foreach ($lines as $line) {
        $content .= "BT /F1 11 Tf 60 {$y} Td (" . $esc($line) . ") Tj ET\n";
        $y -= 18;
    }
    $objects = [];
    $objects[] = "<< /Type /Catalog /Pages 2 0 R >>";
    $objects[] = "<< /Type /Pages /Kids [3 0 R] /Count 1 >>";
    $objects[] = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] "
        . "/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>";
    $objects[] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
    $objects[] = "<< /Length " . strlen($content) . " >>\nstream\n" . $content . "endstream";
    $pdf = "%PDF-1.4\n";
    $offsets = [];
    foreach ($objects as $i => $body) {
        $offsets[$i + 1] = strlen($pdf);
        $pdf .= ($i + 1) . " 0 obj\n" . $body . "\nendobj\n";
    }
    $xref = strlen($pdf);
    $count = count($objects) + 1;
    $pdf .= "xref\n0 {$count}\n0000000000 65535 f \n";
    foreach ($offsets as $offset) {
        $pdf .= sprintf("%010d 00000 n \n", $offset);
    }
    $pdf .= "trailer\n<< /Size {$count} /Root 1 0 R >>\nstartxref\n{$xref}\n%%EOF\n";
    return $pdf;
}

/** DOCX mínimo válido (OOXML). Autoria própria. */
function lab_make_docx(string $title, array $paragraphs): string {
    $tmp = tempnam(sys_get_temp_dir(), 'labdocx');
    $zip = new ZipArchive();
    if ($zip->open($tmp, ZipArchive::OVERWRITE) !== true) {
        lab_fail('ZipArchive indisponível para DOCX');
    }
    $zip->addFromString('[Content_Types].xml',
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        . '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        . '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        . '<Default Extension="xml" ContentType="application/xml"/>'
        . '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
        . '</Types>');
    $zip->addFromString('_rels/.rels',
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        . '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        . '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
        . '</Relationships>');
    $paras = '<w:p><w:r><w:t>' . htmlspecialchars($title, ENT_XML1) . '</w:t></w:r></w:p>';
    foreach ($paragraphs as $p) {
        $paras .= '<w:p><w:r><w:t xml:space="preserve">' . htmlspecialchars($p, ENT_XML1) . '</w:t></w:r></w:p>';
    }
    $zip->addFromString('word/document.xml',
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        . '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        . '<w:body>' . $paras . '<w:sectPr/></w:body></w:document>');
    $zip->close();
    $bytes = file_get_contents($tmp);
    unlink($tmp);
    return $bytes;
}

/** Cria arquivo na área de rascunho do usuário corrente e devolve o draft itemid. */
function lab_draft_file(string $filename, string $content): int {
    global $USER;
    $fs = get_file_storage();
    $draftid = file_get_unused_draft_itemid();
    $context = context_user::instance($USER->id);
    $fs->create_file_from_string([
        'contextid' => $context->id,
        'component' => 'user',
        'filearea' => 'draft',
        'itemid' => $draftid,
        'filepath' => '/',
        'filename' => $filename,
        'userid' => $USER->id,
    ], $content);
    return $draftid;
}

function lab_user(string $username, string $first, string $last, string $password): stdClass {
    global $DB, $CFG;
    $existing = $DB->get_record('user', ['username' => $username, 'mnethostid' => $CFG->mnet_localhost_id]);
    if ($existing) {
        $expected = $username . '@example.com';
        if ($existing->email !== $expected) {
            $DB->set_field('user', 'email', $expected, ['id' => $existing->id]);
            $existing->email = $expected;
        }
        return $existing;
    }
    $user = (object)[
        'username' => $username,
        'firstname' => $first,
        'lastname' => $last,
        'email' => $username . '@example.com',
        'auth' => 'manual',
        'confirmed' => 1,
        'mnethostid' => $CFG->mnet_localhost_id,
        'password' => $password,
        'city' => 'Lab',
        'country' => 'PT',
    ];
    $user->id = user_create_user($user, true, false);
    return $DB->get_record('user', ['id' => $user->id], '*', MUST_EXIST);
}

function lab_role_id(string $shortname): int {
    global $DB;
    return (int)$DB->get_field('role', 'id', ['shortname' => $shortname], MUST_EXIST);
}

function lab_enrol(int $userid, int $courseid, string $shortname): void {
    global $DB;
    $roleid = lab_role_id($shortname);
    $context = context_course::instance($courseid);
    if (!$DB->record_exists('role_assignments', ['roleid' => $roleid, 'userid' => $userid, 'contextid' => $context->id])) {
        role_assign($roleid, $userid, $context->id);
    }
    $instance = $DB->get_record('enrol', ['courseid' => $courseid, 'enrol' => 'manual']);
    if (!$instance) {
        $plugin = enrol_get_plugin('manual');
        $instanceid = $plugin->add_default_instance(get_course($courseid));
        $instance = $DB->get_record('enrol', ['id' => $instanceid], '*', MUST_EXIST);
    }
    $plugin = enrol_get_plugin('manual');
    if (!$DB->record_exists('user_enrolments', ['enrolid' => $instance->id, 'userid' => $userid])) {
        $plugin->enrol_user($instance, $userid, $roleid, 0, 0, ENROL_USER_ACTIVE);
    }
}

function lab_course(string $shortname, string $fullname, int $categoryid, int $sections): stdClass {
    global $DB;
    $course = $DB->get_record('course', ['shortname' => $shortname]);
    if ($course) {
        return $course;
    }
    $created = create_course((object)[
        'fullname' => $fullname,
        'shortname' => $shortname,
        'category' => $categoryid,
        'format' => 'topics',
        'numsections' => $sections,
        'visible' => 1,
        'summary' => 'Curso sintético do Moodle Lab AraHub.',
        'summaryformat' => FORMAT_HTML,
        'enablecompletion' => 1,
    ]);
    return $created;
}

function lab_find_module(int $courseid, string $modulename, ?string $name, int $section): ?stdClass {
    global $DB;
    $sql = "SELECT cm.id AS cmid, i.* FROM {course_modules} cm "
        . "JOIN {modules} m ON m.id = cm.module "
        . "JOIN {" . $modulename . "} i ON i.id = cm.instance "
        . "WHERE cm.course = :courseid AND m.name = :modname";
    $params = ['courseid' => $courseid, 'modname' => $modulename];
    if ($name !== null && $name !== '') {
        $sql .= " AND i.name = :name";
        $params['name'] = $name;
    } else {
        $sql .= " AND cm.section = :section";
        $params['section'] = $section;
    }
    $record = $DB->get_record_sql($sql, $params, IGNORE_MULTIPLE);
    return $record ?: null;
}

/** Cria o modulo se ainda nao existir (idempotente por curso+nome+secao). */
function lab_module(string $modulename, array $record, array $options = []): stdClass {
    $courseid = (int)(isset($record['course']) ? (is_object($record['course']) ? $record['course']->id : $record['course']) : 0);
    $section = (int)($record['section'] ?? 0);
    $existing = lab_find_module($courseid, $modulename, $record['name'] ?? null, $section);
    if ($existing) {
        return $existing;
    }
    $gen = new testing_data_generator();
    return $gen->create_module($modulename, $record, $options);
}

/** Cria a discussao de forum se ainda nao existir (idempotente por forum+titulo). */
function lab_discussion($forumgen, int $courseid, int $forumid, int $userid, string $name, string $message): void {
    global $DB;
    if ($DB->record_exists('forum_discussions', ['forum' => $forumid, 'name' => $name])) {
        return;
    }
    $forumgen->create_discussion([
        'course' => $courseid, 'forum' => $forumid, 'userid' => $userid,
        'name' => $name, 'message' => $message, 'messageformat' => FORMAT_HTML,
    ]);
}

function lab_cmid(int $instanceid, string $modulename): int {
    global $DB;
    $sql = "SELECT cm.id FROM {course_modules} cm JOIN {modules} m ON m.id = cm.module "
        . "WHERE m.name = :name AND cm.instance = :instance";
    return (int)$DB->get_field_sql($sql, ['name' => $modulename, 'instance' => $instanceid], MUST_EXIST);
}

function lab_seed(): void {
    global $DB, $CFG, $fixtures, $outdir;

    // --- Categoria e usuários -------------------------------------------------
    $category = $DB->get_record('course_categories', ['idnumber' => 'LAB']);
    if (!$category) {
        $gen = new testing_data_generator();
        $category = $gen->create_category(['name' => 'Laboratório AraHub', 'idnumber' => 'LAB']);
    }

    // Senha sintética derivada do marcador de propriedade da instância; nunca impressa.
    $marker = trim((string)@file_get_contents($CFG->dataroot . '/.arahub-lab-instance-id'));
    if ($marker === '') {
        lab_fail('marcador de instância ausente no dataroot');
    }
    $pass = 'Lab-' . substr(hash('sha256', 'arahub-lab:' . $marker), 0, 16) . '!';
    $admin = lab_user('labadmin', 'Lab', 'Admin', $pass);
    $teacher = lab_user('labteacher', 'Lab', 'Docente', $pass);
    $studenta = lab_user('labstudenta', 'Aluno', 'A', $pass);
    $studentb = lab_user('labstudentb', 'Aluno', 'B', $pass);
    $studentc = lab_user('labstudentc', 'Aluno', 'C', $pass);
    $noenrol = lab_user('labstudentnoenrol', 'Aluno', 'Sem Matrícula', $pass);
    $ownerb = lab_user('labownerb', 'Dono', 'B', $pass);

    // --- Cursos ---------------------------------------------------------------
    $ambient = lab_course('lab_ambientacao', 'LAB — Ambientação (sintético)', $category->id, 3);
    $disc = lab_course('lab_disciplina', 'LAB — Disciplina (sintético)', $category->id, 6);
    $isol = lab_course('lab_isolamento', 'LAB — Isolamento (sintético)', $category->id, 3);

    foreach ([[$teacher, 'editingteacher'], [$studenta, 'student'], [$studentb, 'student'], [$studentc, 'student']] as [$u, $r]) {
        lab_enrol($u->id, $ambient->id, $r);
        lab_enrol($u->id, $disc->id, $r);
    }
    lab_enrol($teacher->id, $isol->id, 'editingteacher');
    lab_enrol($ownerb->id, $isol->id, 'student');

    // --- Conteúdo do curso de ambientação ------------------------------------
    $gen = new testing_data_generator();
    lab_module('forum', [
        'course' => $ambient->id, 'section' => 0, 'name' => 'Avisos (somente docente)',
        'intro' => 'Fórum de avisos sintético.', 'type' => 'news', 'forcesubscribe' => 1,
    ], ['visible' => 1]);
    lab_module('page', [
        'course' => $ambient->id, 'section' => 1, 'name' => 'Boas-vindas',
        'intro' => 'Página sintética de boas-vindas.',
        'content' => '<p>Bem-vindo ao laboratório sintético do AraHub.</p>',
        'contentformat' => FORMAT_HTML,
    ]);
    lab_module('label', [
        'course' => $ambient->id, 'section' => 2, 'name' => '',
        'intro' => '<p>Rótulo sintético de ambientação.</p>', 'introformat' => FORMAT_HTML,
    ]);

    // --- Curso disciplina: Book/Page/Label/URL -------------------------------
    $book = lab_module('book', [
        'course' => $disc->id, 'section' => 0, 'name' => 'Guia da disciplina (Book)',
        'intro' => 'Book sintético com capítulos.', 'numbering' => 1, 'customtitles' => 1,
    ]);
    $bookgen = $gen->get_plugin_generator('mod_book');
    $bookgen->create_chapter([
        'bookid' => $book->id, 'pagenum' => 1, 'subchapter' => 0, 'title' => 'Calendário',
        'content' => '<h3>Calendário do laboratório</h3><p>Datas controladas pelo teste: '
            . 'prazo em 2026-10-20 18:00 (Europe/Lisbon).</p>', 'contentformat' => FORMAT_HTML,
    ]);
    $bookgen->create_chapter([
        'bookid' => $book->id, 'pagenum' => 2, 'subchapter' => 0, 'title' => 'Tarefas',
        'content' => '<h3>Tarefas</h3><p>Atividade 1: ficha de leitura com arquivo e declaração.</p>',
        'contentformat' => FORMAT_HTML,
    ]);

    lab_module('page', [
        'course' => $disc->id, 'section' => 1, 'name' => 'Orientações gerais',
        'intro' => 'Página sintética com orientações.',
        'content' => '<p>Orientações sintéticas de estudo e netiqueta do laboratório.</p>',
        'contentformat' => FORMAT_HTML,
    ]);
    lab_module('label', [
        'course' => $disc->id, 'section' => 1, 'name' => '',
        'intro' => '<p>Rótulo sintético da disciplina.</p>', 'introformat' => FORMAT_HTML,
    ]);
    lab_module('url', [
        'course' => $disc->id, 'section' => 1, 'name' => 'Recurso externo (URL)',
        'intro' => 'URL sintética externa.', 'externalurl' => 'https://example.org/lab-recurso-sintetico',
    ]);

    // --- Arquivos sintéticos: DOCX, PDF, vídeo ------------------------------
    $docx = lab_make_docx('Ficha de leitura (sintética)', [
        'Conteúdo sintético para exercitar a ponte de arquivos do AraHub.',
        'Este DOCX não contém dados reais de pessoas ou instituições.',
    ]);
    $pdf = lab_make_pdf('Texto base (sintético)', [
        'Documento PDF sintético do Moodle Lab.',
        'Serve para exercitar extração de texto e hashes.',
    ]);
    $mp4 = is_readable($fixtures . '/video-sintetico.mp4')
        ? file_get_contents($fixtures . '/video-sintetico.mp4')
        : '';

    // Exporta os mesmos bytes para o host (verificacao byte a byte na ponte REST).
    $filesdir = $outdir . '/files';
    if (!is_dir($filesdir)) {
        mkdir($filesdir, 0777, true);
    }
    file_put_contents($filesdir . '/ficha-leitura-sintetica.docx', $docx);
    file_put_contents($filesdir . '/texto-base-sintetico.pdf', $pdf);
    if ($mp4 !== '') {
        file_put_contents($filesdir . '/video-aula-sintetico.mp4', $mp4);
    }

    $docxId = lab_draft_file('ficha-leitura-sintetica.docx', $docx);
    $pdfId = lab_draft_file('texto-base-sintetico.pdf', $pdf);
    $docxModule = lab_module('resource', [
        'course' => $disc->id, 'section' => 2, 'name' => 'Ficha de leitura (DOCX)',
        'intro' => 'DOCX sintético.', 'files' => $docxId, 'display' => 0,
    ]);
    $pdfModule = lab_module('resource', [
        'course' => $disc->id, 'section' => 2, 'name' => 'Texto base (PDF)',
        'intro' => 'PDF sintético.', 'files' => $pdfId, 'display' => 0,
    ]);
    $videoModule = null;
    if ($mp4 !== '') {
        $mp4Id = lab_draft_file('video-aula-sintetico.mp4', $mp4);
        $videoModule = lab_module('resource', [
            'course' => $disc->id, 'section' => 2, 'name' => 'Vídeo da aula (MP4)',
            'intro' => 'Vídeo sintético.', 'files' => $mp4Id, 'display' => 0,
        ]);
    }

    // --- Assignment fingerprint (Etividade 1) --------------------------------
    $assign = lab_module('assign', [
        'course' => $disc->id, 'section' => 3, 'name' => 'Etividade 1 (fingerprint)',
        'intro' => '<p>Entrega de <strong>um arquivo</strong>, individual, com declaração de autoria.</p>',
        'introformat' => FORMAT_HTML,
        'submissiondrafts' => 1,
        'requiresubmissionstatement' => 1,
        'teamsubmission' => 0,
        'attemptreopenmethod' => 'manual',
        'maxattempts' => 1,
        'grade' => 100,
        'duedate' => strtotime('2026-10-20 18:00:00'),
        'cutoffdate' => strtotime('2026-10-27 18:00:00'),
        'assignsubmission_file_enabled' => 1,
        'assignsubmission_file_maxfiles' => 1,
        'assignsubmission_file_maxsizebytes' => 5242880,
        'assignsubmission_onlinetext_enabled' => 0,
    ]);
    $assignNoButton = lab_module('assign', [
        'course' => $disc->id, 'section' => 3, 'name' => 'Tarefa sem botão de envio',
        'intro' => 'Assignment sem botão de submissão final (salvar já é definitivo).',
        'submissiondrafts' => 0, 'requiresubmissionstatement' => 0, 'teamsubmission' => 0,
        'grade' => 100, 'assignsubmission_file_enabled' => 1, 'assignsubmission_file_maxfiles' => 1,
    ]);
    $assignPdfOnly = lab_module('assign', [
        'course' => $disc->id, 'section' => 3, 'name' => 'Entrega só PDF',
        'intro' => 'Aceita um único PDF.', 'submissiondrafts' => 1, 'requiresubmissionstatement' => 0,
        'grade' => 100, 'assignsubmission_file_enabled' => 1, 'assignsubmission_file_maxfiles' => 1,
        'assignsubmission_file_filetypes' => '.pdf',
    ]);

    // --- Grupos e assignment de grupo ----------------------------------------
    $group = $DB->get_record('groups', ['courseid' => $disc->id, 'name' => 'Grupo A']);
    if (!$group) {
        $group = (object)['courseid' => $disc->id, 'name' => 'Grupo A', 'description' => 'Grupo sintético',
            'descriptionformat' => FORMAT_HTML, 'timecreated' => time(), 'timemodified' => time()];
        $group->id = groups_create_group($group);
    }
    foreach ([$studenta, $studentb] as $member) {
        if (!groups_is_member($group->id, $member->id)) {
            groups_add_member($group->id, $member->id);
        }
    }
    $assignGroup = lab_module('assign', [
        'course' => $disc->id, 'section' => 3, 'name' => 'Entrega em grupo (assentimento)',
        'intro' => 'Entrega em grupo; exige submissão de todos os membros.',
        'submissiondrafts' => 1, 'requiresubmissionstatement' => 0,
        'teamsubmission' => 1, 'requireallteammemberssubmit' => 1,
        'grade' => 100, 'assignsubmission_file_enabled' => 1,
    ]);

    // --- Fóruns ---------------------------------------------------------------
    $forum = lab_module('forum', [
        'course' => $disc->id, 'section' => 4, 'name' => 'Fórum de discussão',
        'intro' => 'Fórum geral sintético.', 'type' => 'general',
    ]);
    $forumqa = lab_module('forum', [
        'course' => $disc->id, 'section' => 4, 'name' => 'Fórum Q&A',
        'intro' => 'Fórum Q&A sintético.', 'type' => 'qanda',
    ]);
    $forumNews = lab_module('forum', [
        'course' => $disc->id, 'section' => 4, 'name' => 'Avisos da disciplina',
        'intro' => 'Fórum de avisos; estudantes não iniciam discussões.', 'type' => 'news',
    ]);

    $forumgen = $gen->get_plugin_generator('mod_forum');
    foreach ([$teacher, $studentb] as $author) {
        lab_discussion($forumgen, $disc->id, $forum->id, $author->id,
            'Discussão sintética de ' . $author->firstname,
            '<p>Contribuição sintética de ' . $author->firstname . ' para o laboratório.</p>');
    }

    // --- Curso de isolamento (IDs sobrepostos) -------------------------------
    $assignIso = lab_module('assign', [
        'course' => $isol->id, 'section' => 1, 'name' => 'Etividade 1 (isolamento)',
        'intro' => 'Assignment sintético do curso de isolamento.', 'submissiondrafts' => 1,
        'requiresubmissionstatement' => 1, 'grade' => 100, 'assignsubmission_file_enabled' => 1,
    ]);
    $forumIso = lab_module('forum', [
        'course' => $isol->id, 'section' => 1, 'name' => 'Fórum (isolamento)',
        'intro' => 'Fórum sintético do curso de isolamento.', 'type' => 'general',
    ]);
    lab_discussion($forumgen, $isol->id, $forumIso->id, $teacher->id,
        'Discussão sintética (isolamento)', '<p>Tópico sintético no curso de isolamento.</p>');

    $summary = [
        'stage' => 'done',
        'category_id' => (int)$category->id,
        'users' => [
            'admin' => (int)$admin->id, 'teacher' => (int)$teacher->id,
            'student_a' => (int)$studenta->id, 'student_b' => (int)$studentb->id,
            'student_c' => (int)$studentc->id, 'student_noenrol' => (int)$noenrol->id,
            'owner_b' => (int)$ownerb->id,
        ],
        'courses' => [
            'ambientacao' => (int)$ambient->id, 'disciplina' => (int)$disc->id, 'isolamento' => (int)$isol->id,
        ],
        'assignment' => [
            'fingerprint' => (int)$assign->id, 'fingerprint_cmid' => lab_cmid($assign->id, 'assign'),
            'no_submit_button' => (int)$assignNoButton->id, 'pdf_only' => (int)$assignPdfOnly->id,
            'group' => (int)$assignGroup->id, 'isolamento' => (int)$assignIso->id,
        ],
        'forum' => [
            'general' => (int)$forum->id, 'qanda' => (int)$forumqa->id, 'news' => (int)$forumNews->id,
            'general_cmid' => lab_cmid($forum->id, 'forum'), 'isolamento' => (int)$forumIso->id,
        ],
        'book' => (int)$book->id, 'group_id' => (int)$group->id,
        'modules' => [
            'docx' => (int)$docxModule->id, 'pdf' => (int)$pdfModule->id,
            'video' => $videoModule ? (int)$videoModule->id : null,
        ],
    ];
    file_put_contents($outdir . '/seed.json', json_encode($summary, JSON_PRETTY_PRINT));
    lab_out($summary);
}

function lab_ws(): void {
    global $DB, $CFG, $outdir;

    set_config('enablewebservices', 1);
    set_config('webserviceprotocols', 'rest');
    set_config('enablewsdocumentation', 0);
    set_config('passwordpolicy', 0);

    $shortname = 'arahub_lab';
    $service = $DB->get_record('external_services', ['shortname' => $shortname]);
    $now = time();
    if (!$service) {
        $service = (object)[
            'name' => 'AraHub Moodle Lab (sintético)',
            'shortname' => $shortname,
            'enabled' => 1,
            'restrictedusers' => 0,
            'requiredcapability' => '',
            'component' => null,
            'timecreated' => $now,
            'timemodified' => $now,
            'downloadfiles' => 1,
            'uploadfiles' => 1,
        ];
        $service->id = $DB->insert_record('external_services', $service);
    } else {
        $service->enabled = 1;
        $service->downloadfiles = 1;
        $service->uploadfiles = 1;
        $service->timemodified = $now;
        $DB->update_record('external_services', $service);
    }

    $functions = [
        // Leituras auditadas pelo AraHub.
        'core_webservice_get_site_info', 'core_enrol_get_users_courses', 'core_course_get_contents',
        'core_calendar_get_calendar_events', 'mod_assign_get_assignments',
        'mod_page_get_pages_by_courses', 'mod_book_get_books_by_courses',
        'mod_resource_get_resources_by_courses', 'mod_url_get_urls_by_courses',
        'mod_forum_get_forums_by_courses', 'mod_forum_get_forum_discussions',
        'mod_forum_get_discussion_posts', 'mod_forum_get_forum_access_information',
        'mod_forum_can_add_discussion',
        'mod_feedback_get_feedbacks_by_courses', 'mod_feedback_get_items',
        'core_completion_get_activities_completion_status', 'core_completion_get_course_completion_status',
        // Escritas com aprovação durável no serviço raiz.
        'mod_forum_add_discussion', 'mod_forum_add_discussion_post',
        'mod_assign_save_submission', 'mod_assign_submit_for_grading',
        // Rotas usadas apenas pelo laboratório/auditoria.
        'mod_assign_get_submission_status', 'mod_assign_get_submissions', 'mod_assign_get_grades',
        'mod_assign_get_user_flags', 'mod_assign_save_grade', 'gradereport_user_get_grade_items', 'core_files_get_files',
        'core_course_get_courses_by_field', 'core_user_get_users_by_field',
    ];
    $existing = $DB->get_fieldset_select('external_services_functions', 'functionname',
        'externalserviceid = ?', [$service->id]);
    foreach ($functions as $fn) {
        if (!in_array($fn, $existing, true)) {
            $DB->insert_record('external_services_functions',
                (object)['externalserviceid' => $service->id, 'functionname' => $fn]);
        }
    }

    $context = context_system::instance();

    // Sem esta capacidade o protocolo REST e recusado para os papeis sinteticos.
    foreach (['user', 'student', 'editingteacher', 'teacher'] as $roleshortname) {
        $role = $DB->get_record('role', ['shortname' => $roleshortname]);
        if ($role) {
            assign_capability('webservice/rest:use', CAP_ALLOW, $role->id, $context->id, true);
        }
    }
    if (function_exists('purge_all_caches')) {
        purge_all_caches();
    }

    $usernames = ['labteacher', 'labstudenta', 'labstudentb', 'labstudentc', 'labstudentnoenrol', 'labownerb'];
    $tokens = [];
    foreach ($usernames as $username) {
        $user = $DB->get_record('user', ['username' => $username], '*', MUST_EXIST);
        // Remove token anterior do mesmo serviço/usuário para manter idempotência.
        $DB->delete_records('external_tokens', ['externalserviceid' => $service->id, 'userid' => $user->id]);
        $token = external_generate_token(EXTERNAL_TOKEN_PERMANENT, $service->id, $user->id, $context, 0);
        $tokens[$username] = ['token' => $token, 'userid' => (int)$user->id];
    }

    $payload = [
        'service' => ['id' => (int)$service->id, 'shortname' => $shortname, 'uploadfiles' => 1, 'downloadfiles' => 1],
        'functions' => $functions,
        'tokens' => $tokens,
    ];
    file_put_contents($outdir . '/tokens.json', json_encode($payload, JSON_PRETTY_PRINT));
    chmod($outdir . '/tokens.json', 0600);
    lab_out(['stage' => 'ws', 'service_id' => (int)$service->id, 'functions' => count($functions),
        'token_users' => array_keys($tokens), 'written' => $outdir . '/tokens.json']);
}

/** Snapshot de linhas de nota e eventos para auditar efeitos indiretos. */
function lab_snap(string $tag, int $assignid, int $userid): void {
    global $DB, $outdir;
    $assign = $DB->get_record('assign', ['id' => $assignid], '*', MUST_EXIST);
    $course = $DB->get_record('course', ['id' => $assign->course], '*', MUST_EXIST);
    $items = $DB->get_records('grade_items', ['courseid' => $course->id, 'itemmodule' => 'assign', 'iteminstance' => $assignid]);
    $itemids = array_map(fn($i) => (int)$i->id, array_values($items));
    $grades = $itemids ? $DB->get_records_list('grade_grades', 'itemid', $itemids) : [];
    $history = 0;
    if ($itemids) {
        list($insql, $inparams) = $DB->get_in_or_equal($itemids);
        $history = (int)$DB->count_records_sql(
            "SELECT COUNT(1) FROM {grade_grades_history} WHERE itemid $insql", $inparams);
    }
    $assigngrades = $DB->get_records('assign_grades', ['assignment' => $assignid]);
    $maxlog = (int)$DB->get_field_sql('SELECT COALESCE(MAX(id),0) FROM {logstore_standard_log}');
    $data = [
        'tag' => $tag,
        'assignid' => $assignid,
        'userid' => $userid,
        'courseid' => (int)$course->id,
        'grade_items' => count($items),
        'grade_item_ids' => $itemids,
        'grade_grades' => count($grades),
        'grade_grades_history' => $history,
        'assign_grades' => count($assigngrades),
        'assign_submission' => $DB->count_records('assign_submission', ['assignment' => $assignid]),
        'log_max_id' => $maxlog,
        'log_total' => (int)$DB->count_records('logstore_standard_log'),
    ];
    file_put_contents($outdir . "/snap-{$tag}.json", json_encode($data, JSON_PRETTY_PRINT));
    lab_out(['stage' => 'snap', 'tag' => $tag, 'snapshot' => $data]);
}

/** Compara dois snapshots e lista eventos novos e deltas de linhas. */
function lab_sdiff(string $tagfrom, string $tagto): void {
    global $DB, $outdir;
    $pathFrom = $outdir . "/snap-{$tagfrom}.json";
    $pathTo = $outdir . "/snap-{$tagto}.json";
    if (!is_readable($pathFrom) || !is_readable($pathTo)) {
        lab_fail('snapshots ausentes para o diff: ' . $tagfrom . '/' . $tagto);
    }
    $before = json_decode(file_get_contents($pathFrom), true);
    $after = json_decode(file_get_contents($pathTo), true);
    $events = $DB->get_records_sql(
        "SELECT id, eventname, component, action, crud, target, objectid
           FROM {logstore_standard_log} WHERE id > :maxid AND id <= :maxid2 ORDER BY id",
        ['maxid' => $before['log_max_id'], 'maxid2' => $after['log_max_id']]);
    $compact = [];
    foreach ($events as $e) {
        $compact[] = ['id' => (int)$e->id, 'eventname' => $e->eventname, 'component' => $e->component,
            'action' => $e->action, 'crud' => $e->crud, 'target' => $e->target, 'objectid' => $e->objectid];
    }
    $diff = [
        'from' => $tagfrom, 'to' => $tagto,
        'grade_items_delta' => $after['grade_items'] - $before['grade_items'],
        'grade_grades_delta' => $after['grade_grades'] - $before['grade_grades'],
        'grade_grades_history_delta' => $after['grade_grades_history'] - $before['grade_grades_history'],
        'assign_grades_delta' => $after['assign_grades'] - $before['assign_grades'],
        'assign_submission_delta' => $after['assign_submission'] - $before['assign_submission'],
        'new_log_event_count' => count($compact),
        'new_log_events' => $compact,
    ];
    file_put_contents($outdir . "/sdiff-{$tagfrom}-{$tagto}.json", json_encode(['before' => $before, 'after' => $after, 'diff' => $diff], JSON_PRETTY_PRINT));
    lab_out(['stage' => 'sdiff', 'diff' => $diff]);
}

/** Oráculo do laboratório: leitura direta de estado, sem helpers de notas. */
/** Limpa o estado de submissão do estudante (apenas dados sintéticos do Lab). */
function lab_reset_assign(int $assignid, int $userid): void {
    global $DB;
    $cmid = (int)$DB->get_field_sql(
        "SELECT cm.id FROM {course_modules} cm JOIN {modules} m ON m.id = cm.module "
        . "WHERE m.name = 'assign' AND cm.instance = :instance",
        ['instance' => $assignid]);
    $fs = get_file_storage();
    $removed = 0;
    foreach ($DB->get_records('assign_submission', ['assignment' => $assignid, 'userid' => $userid]) as $submission) {
        if ($cmid) {
            $fs->delete_area_files(context_module::instance($cmid)->id, 'assignsubmission_file', 'submission_files', $submission->id);
            $fs->delete_area_files(context_module::instance($cmid)->id, 'assignsubmission_onlinetext', 'submission_onlinetext', $submission->id);
        }
        $DB->delete_records('assignsubmission_file', ['submission' => $submission->id]);
        $DB->delete_records('assignsubmission_onlinetext', ['submission' => $submission->id]);
        $DB->delete_records('assign_submission', ['id' => $submission->id]);
        $removed++;
    }
    $DB->delete_records('assign_grades', ['assignment' => $assignid, 'userid' => $userid]);
    // Restaura o estado "sem nota" para tornar a auditoria repetivel.
    $assign = $DB->get_record('assign', ['id' => $assignid], '*', MUST_EXIST);
    foreach ($DB->get_records('grade_items',
            ['courseid' => $assign->course, 'itemmodule' => 'assign', 'iteminstance' => $assignid]) as $item) {
        $DB->delete_records('grade_grades_history', ['itemid' => $item->id, 'userid' => $userid]);
        $DB->delete_records('grade_grades', ['itemid' => $item->id, 'userid' => $userid]);
    }
    lab_out(['stage' => 'resetassign', 'assignid' => $assignid, 'userid' => $userid, 'removed' => $removed]);
}

/** Diagnostico: por que submissions_open e' falso para este usuario/atividade. */
/** Troca a senha de uma conta sintetica (uso exclusivo do laboratorio). */
function lab_setpass(string $username, string $password): void {
    global $DB;
    if (strlen($password) < 8) {
        lab_fail('senha de laboratorio curta');
    }
    $user = $DB->get_record('user', ['username' => $username], '*', MUST_EXIST);
    update_internal_user_password($user, $password);
    lab_out(['stage' => 'setpass', 'username' => $username, 'changed' => true]);
}

function lab_diag(int $assignid, int $userid): void {
    global $DB;
    $cmid = (int)$DB->get_field_sql(
        "SELECT cm.id FROM {course_modules} cm JOIN {modules} m ON m.id = cm.module "
        . "WHERE m.name = 'assign' AND cm.instance = :instance",
        ['instance' => $assignid]);
    $cm = get_coursemodule_from_id('assign', $cmid, 0, false, MUST_EXIST);
    $context = context_module::instance($cmid);
    $assign = new assign($context, $cm, $cm->course);
    $instance = $assign->get_instance();
    $flags = $assign->get_user_flags($userid, false) ?: false;
    lab_out([
        'stage' => 'diag',
        'assignid' => $assignid,
        'userid' => $userid,
        'now' => time(),
        'allowsubmissionsfromdate' => (int)$instance->allowsubmissionsfromdate,
        'duedate' => (int)$instance->duedate,
        'cutoffdate' => (int)$instance->cutoffdate,
        'submissiondrafts' => (int)$instance->submissiondrafts,
        'teamsubmission' => (int)$instance->teamsubmission,
        'maxattempts' => (int)$instance->maxattempts,
        'attemptreopenmethod' => $instance->attemptreopenmethod,
        'enrolled' => is_enrolled($assign->get_course_context(), $userid),
        'flags_locked' => $flags ? (int)$flags->locked : null,
        'can_submit' => has_capability('mod/assign:submit', $context, $userid),
        'plugin_enabled' => $assign->is_any_submission_plugin_enabled(),
        'submission_rows' => $DB->count_records('assign_submission', ['assignment' => $assignid, 'userid' => $userid]),
        'submissions_open' => $assign->submissions_open($userid),
    ]);
}

function lab_oracle(int $assignid, int $userid): void {
    global $DB;
    $submissions = $DB->get_records('assign_submission', ['assignment' => $assignid, 'userid' => $userid], 'attemptnumber DESC');
    $out = [];
    foreach ($submissions as $s) {
        $out[] = ['id' => (int)$s->id, 'status' => $s->status, 'attemptnumber' => (int)$s->attemptnumber,
            'timemodified' => (int)$s->timemodified, 'timecreated' => (int)$s->timecreated];
    }
    $grades = $DB->get_records('assign_grades', ['assignment' => $assignid, 'userid' => $userid]);
    $flat = [];
    foreach ($grades as $g) {
        $flat[] = ['id' => (int)$g->id, 'grade' => $g->grade, 'attemptnumber' => (int)$g->attemptnumber,
            'timemodified' => (int)$g->timemodified];
    }
    $sql = "SELECT COUNT(1) FROM {assign_submission} WHERE assignment = :a AND userid = :u";
    lab_out([
        'stage' => 'oracle',
        'assignid' => $assignid, 'userid' => $userid,
        'submission_rows' => (int)$DB->get_field_sql($sql, ['a' => $assignid, 'u' => $userid]),
        'submissions' => $out,
        'grades' => $flat,
    ]);
}

switch ($cmd) {
    case 'negative':
        require_once(__DIR__ . '/negative_fixtures.php');
        lab_negative(array_slice($argv, 2));
        break;
    case 'seed':
        lab_seed();
        break;
    case 'ws':
        lab_ws();
        break;
    case 'snap':
        lab_snap($argv[2] ?? 'a', (int)($argv[3] ?? 0), (int)($argv[4] ?? 0));
        break;
    case 'sdiff':
        lab_sdiff($argv[2] ?? 'a', $argv[3] ?? 'b');
        break;
    case 'oracle':
        lab_oracle((int)($argv[2] ?? 0), (int)($argv[3] ?? 0));
        break;
    case 'resetassign':
        lab_reset_assign((int)($argv[2] ?? 0), (int)($argv[3] ?? 0));
        break;
    case 'diag':
        lab_diag((int)($argv[2] ?? 0), (int)($argv[3] ?? 0));
        break;
    case 'setpass':
        lab_setpass((string)($argv[2] ?? ''), (string)($argv[3] ?? ''));
        break;
    default:
        lab_fail('comando desconhecido: ' . $cmd);
}
