<?php
// AraHub, MIT. Author-written calls to the installed Moodle APIs/generators;
// no Moodle implementation is vendored. CLI fixtures only, never client reads.
// Usage: php /opt/arahub-lab/tools/read_fixtures.php COMMAND RUN_UUID EXPECTED_INSTANCE_UUID
// Expected identity comes from the private manifest, after read_prove.ts checks
// it against the private instance file. Never embed deployment IDs in this code.
// Setup creates the course; assignments/forum add only this run's fixtures.
// All remaining commands require that run's state and owned course modules.
define('CLI_SCRIPT', true);
require('/var/www/html/config.php');
require_once($CFG->dirroot . '/lib/testing/generator/lib.php');
require_once($CFG->dirroot . '/lib/enrollib.php');
require_once($CFG->dirroot . '/lib/filelib.php');
require_once($CFG->dirroot . '/course/lib.php');
require_once($CFG->dirroot . '/mod/forum/lib.php');
require_once($CFG->dirroot . '/mod/forum/classes/post_form.php');
require_once($CFG->dirroot . '/webservice/lib.php');

$CFG->debugdisplay = 0;
$command = $argv[1] ?? '';
$run = $argv[2] ?? '';
$expected = $argv[3] ?? '';
if (!preg_match('/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/D', $run) ||
    !preg_match('/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/D', $expected) ||
    trim((string)@file_get_contents($CFG->dataroot . '/.arahub-lab-instance-id')) !== $expected ||
    rtrim($CFG->wwwroot, '/') !== 'http://localhost:8480') {
    fwrite(STDERR, "READ-GUARD: instance/origin/run mismatch\n");
    exit(1);
}
\core\session\manager::set_user(get_admin());
$student = $DB->get_record('user', ['username' => 'labstudentb'], '*', MUST_EXIST);
$role = $DB->get_record('role', ['shortname' => 'student'], '*', MUST_EXIST);
$statepath = $CFG->dataroot . '/arahub-lab/read-suite-' . $run . '.json';
$shortname = 'lab_read_suite/' . $run;
$state = is_file($statepath) ? json_decode(file_get_contents($statepath), true) : null;
function read_out($data) {
    echo 'ARAHUB-READ-JSON:', json_encode($data, JSON_UNESCAPED_SLASHES), "\n";
}
function read_save() {
    global $state, $statepath;
    file_put_contents($statepath, json_encode($state), LOCK_EX);
    chmod($statepath, 0600);
}
function read_cm($module, $name) {
    return (int)get_coursemodule_from_instance($name, $module->id, 0, false, MUST_EXIST)->id;
}
if ($command === 'setup' && !$state) {
    // Refuse adoption of anything not created by this run.
    if ($DB->record_exists('course', ['shortname' => $shortname])) {
        throw new RuntimeException('READ-GUARD: course exists without run state');
    }
    $category = $DB->get_record('course_categories', ['idnumber' => 'LAB'], '*', MUST_EXIST);
    $course = create_course((object)[
        'fullname' => $shortname, 'shortname' => $shortname,
        'idnumber' => 'arahub-read:' . $run, 'category' => $category->id,
        'format' => 'topics', 'numsections' => 5, 'visible' => 1,
        'enablecompletion' => 1, 'summary' => 'Synthetic read suite',
    ]);
    $manual = enrol_get_plugin('manual');
    $enrol = $DB->get_record('enrol', ['courseid' => $course->id, 'enrol' => 'manual']);
    if (!$enrol) {
        $id = $manual->add_default_instance($course);
        $enrol = $DB->get_record('enrol', ['id' => $id], '*', MUST_EXIST);
    }
    $manual->enrol_user($enrol, $student->id, $role->id);
    $gen = new testing_data_generator();
    $stealth = $gen->create_module('page', [
        'course' => $course->id, 'section' => 1, 'name' => 'Stealth fixture',
        'content' => '<p>READ_STEALTH_BODY_' . $run . '</p>', 'contentformat' => FORMAT_HTML,
    ]);
    set_coursemodule_visible(read_cm($stealth, 'page'), 1, 0);
    $link = $CFG->wwwroot . '/mod/page/view.php?id=' . read_cm($stealth, 'page');
    $book = $gen->create_module('book', [
        'course' => $course->id, 'section' => 1, 'name' => 'Book fixture',
    ]);
    $bookgen = $gen->get_plugin_generator('mod_book');
    $chapters = [];
    foreach (['CALENDAR', 'TASK'] as $i => $kind) {
        $chapter = $bookgen->create_chapter([
            'bookid' => $book->id, 'pagenum' => $i + 1, 'title' => $kind,
            'content' => '<h2>' . $kind . '</h2><p>READ_BOOK_' . $kind . '_' . $run .
                '</p><p>Prazo: 2026-11-03 18:00 Europe/Lisbon.</p><a href="' . $link .
                '">Related page</a><a href="https://example.org/read-reference">Reference</a>',
            'contentformat' => FORMAT_HTML,
        ]);
        $chapters[] = (int)$chapter->id;
    }
    $url = $gen->create_module('url', [
        'course' => $course->id, 'section' => 2, 'name' => 'External reference',
        'externalurl' => 'https://example.org/read-reference',
    ]);
    $draftid = file_get_unused_draft_itemid();
    $bytes = '<html><body>READ_AUTH_FILE_' . $run . '</body></html>';
    get_file_storage()->create_file_from_string([
        'contextid' => context_user::instance($USER->id)->id, 'component' => 'user',
        'filearea' => 'draft', 'itemid' => $draftid, 'filepath' => '/',
        'filename' => 'read-auth.html', 'userid' => $USER->id,
    ], $bytes);
    $resource = $gen->create_module('resource', [
        'course' => $course->id, 'section' => 2, 'name' => 'Authenticated file', 'files' => $draftid,
    ]);
    $movable = $gen->create_module('page', [
        'course' => $course->id, 'section' => 2, 'name' => 'Movable before',
        'content' => '<p>READ_MOVABLE_' . $run . '</p>', 'contentformat' => FORMAT_HTML,
    ]);
    rebuild_course_cache($course->id, true);
    $state = [
        'run' => $run, 'course_id' => (int)$course->id, 'student_id' => (int)$student->id,
        'stealth_cmid' => read_cm($stealth, 'page'), 'stealth_id' => (int)$stealth->id,
        'book_cmid' => read_cm($book, 'book'), 'book_id' => (int)$book->id, 'chapters' => $chapters,
        'url_cmid' => read_cm($url, 'url'), 'resource_cmid' => read_cm($resource, 'resource'),
        'file_sha256' => hash('sha256', $bytes),
        'movable_cmid' => read_cm($movable, 'page'), 'movable_id' => (int)$movable->id,
        'tokens' => [],
    ];
    read_save();
}
if (!$state) throw new RuntimeException('READ-GUARD: setup required');
$course = $DB->get_record('course', ['id' => $state['course_id'], 'shortname' => $shortname,
    'idnumber' => 'arahub-read:' . $run], '*', MUST_EXIST);
if ((int)$course->id <= 4 || $state['student_id'] !== (int)$student->id) {
    throw new RuntimeException('READ-GUARD: unsafe course/student');
}
$enrol = $DB->get_record('enrol', ['courseid' => $course->id, 'enrol' => 'manual'], '*', MUST_EXIST);
switch ($command) {
case 'setup': case 'state':
    read_out(array_diff_key($state, ['tokens' => true]) + [
        'allowstealth' => !empty($CFG->allowstealth),
        'stored_visibleoncoursepage' => (int)$DB->get_field('course_modules', 'visibleoncoursepage',
            ['id' => $state['stealth_cmid']], MUST_EXIST),
    ]);
    break;
case 'assignments':
    $state['read01_assignments'] = $state['read01_assignments'] ?? [];
    $gen = new testing_data_generator();
    for ($i = count($state['read01_assignments']); $i < 3; $i++) {
        $assignment = $gen->create_module('assign', [
            'course' => $course->id, 'section' => 5, 'name' => 'Read assignment ' . $i,
            'intro' => '<p>READ_ASSIGN_' . $i . '_' . $run . '</p>',
            'introformat' => FORMAT_HTML, 'grade' => 0, 'nosubmissions' => 1,
            'sendnotifications' => 0, 'sendstudentnotifications' => 0,
            'sendlatenotifications' => 0,
        ]);
        $state['read01_assignments'][] = [
            'id' => (int)$assignment->id, 'cmid' => read_cm($assignment, 'assign'), 'index' => $i,
        ];
        read_save();
    }
    rebuild_course_cache($course->id, true);
    read_out(array_diff_key($state, ['tokens' => true]));
    break;
case 'assignments-deny': case 'assignments-restore':
    if (count($state['read01_assignments'] ?? []) !== 3) {
        throw new RuntimeException('READ-GUARD: assignments required');
    }
    $targets = array_slice($state['read01_assignments'], 1);
    $current = [];
    foreach ($targets as $target) {
        $cm = get_coursemodule_from_id('assign', $target['cmid'], $course->id, false, MUST_EXIST);
        if ((int)$cm->instance !== $target['id']) {
            throw new RuntimeException('READ-GUARD: assignment identity mismatch');
        }
        $current[$target['cmid']] = [
            'visible' => (int)$cm->visible, 'visibleold' => (int)$cm->visibleold,
            'visibleoncoursepage' => (int)$cm->visibleoncoursepage,
        ];
    }
    if ($command === 'assignments-deny') {
        if (!isset($state['read01_visibility_before'])) {
            foreach ($current as $flags) {
                if ($flags !== ['visible' => 1, 'visibleold' => 1, 'visibleoncoursepage' => 1]) {
                    throw new RuntimeException('READ-GUARD: unexpected assignment visibility');
                }
            }
            // Persist recovery before the first temporary mutation.
            $state['read01_visibility_before'] = $current;
            read_save();
        }
        foreach ($targets as $target) set_coursemodule_visible($target['cmid'], 0);
        read_out(['denied_cmids' => array_column($targets, 'cmid'), 'before' => $state['read01_visibility_before']]);
    } else if (isset($state['read01_visibility_before'])) {
        $before = $state['read01_visibility_before'];
        foreach ($targets as $target) {
            $flags = $before[$target['cmid']];
            set_coursemodule_visible($target['cmid'], $flags['visible'], $flags['visibleoncoursepage']);
        }
        $after = [];
        foreach ($targets as $target) {
            $cm = get_coursemodule_from_id('assign', $target['cmid'], $course->id, false, MUST_EXIST);
            $after[$target['cmid']] = [
                'visible' => (int)$cm->visible, 'visibleold' => (int)$cm->visibleold,
                'visibleoncoursepage' => (int)$cm->visibleoncoursepage,
            ];
        }
        if ($after !== $before) throw new RuntimeException('READ_ASSIGNMENT_RESTORE_FAILED');
        unset($state['read01_visibility_before']);
        read_save();
        read_out(['restored' => true, 'before' => $before, 'after' => $after]);
    } else read_out(['restored' => true, 'no_pending_change' => true]);
    break;
case 'suspend': case 'restore':
    enrol_get_plugin('manual')->update_user_enrol($enrol, $student->id,
        $command === 'suspend' ? ENROL_USER_SUSPENDED : ENROL_USER_ACTIVE);
    read_out(['active' => $command === 'restore', 'course_id' => (int)$course->id]);
    break;
case 'stealth-enable':
    if (!isset($state['stealth_config_before'])) {
        $config = $DB->get_record('config', ['name' => 'allowstealth']);
        $state['stealth_config_before'] = ['exists' => (bool)$config,
            'value' => $config ? $config->value : null, 'effective' => !empty($CFG->allowstealth)];
        // Persist recovery information BEFORE the authorized temporary global write.
        read_save();
    }
    set_config('allowstealth', 1);
    rebuild_course_cache($course->id, true);
    read_out(['before' => $state['stealth_config_before'], 'after' => get_config('moodle', 'allowstealth')]);
    break;
case 'stealth-restore':
    if (isset($state['stealth_config_before'])) {
        $before = $state['stealth_config_before'];
        if ($before['exists']) set_config('allowstealth', $before['value']);
        else unset_config('allowstealth');
        rebuild_course_cache($course->id, true);
        $after = $DB->get_record('config', ['name' => 'allowstealth']);
        $restored = (bool)$after === $before['exists'] &&
            (!$after || $after->value === $before['value']);
        if (!$restored) throw new RuntimeException('READ_STEALTH_RESTORE_FAILED');
        unset($state['stealth_config_before']);
        read_save();
        read_out(['before' => $before, 'after' => $after ? $after->value : null, 'restored' => true]);
    } else read_out(['restored' => true, 'no_pending_change' => true]);
    break;
case 'moverename': case 'moveback':
    $cm = get_coursemodule_from_id('page', $state['movable_cmid'], $course->id, false, MUST_EXIST);
    $target = $DB->get_record('course_sections', ['course' => $course->id,
        'section' => $command === 'moveback' ? 2 : 4], '*', MUST_EXIST);
    moveto_module($cm, $target);
    set_coursemodule_name($cm->id, $command === 'moveback' ? 'Movable before' : 'Movable after');
    rebuild_course_cache($course->id, true);
    read_out(['cmid' => (int)$cm->id, 'old_section' => (int)$cm->section, 'new_section' => (int)$target->id]);
    break;
case 'forum':
    if (!isset($state['forum_id'])) {
        $gen = new testing_data_generator();
        $forum = $gen->create_module('forum', ['course' => $course->id, 'section' => 3,
            'name' => 'Paged forum', 'type' => 'general', 'forcesubscribe' => 3]);
        $fg = $gen->get_plugin_generator('mod_forum');
        $discussions = [];
        // 45 discussions exceed two 20-item pages and the normal sync call budget.
        for ($i = 0; $i < 45; $i++) {
            $d = $fg->create_discussion(['course' => $course->id, 'forum' => $forum->id,
                'userid' => $student->id, 'name' => 'Discussion ' . $i,
                'message' => '<p>READ_OLD_BEFORE_' . $run . '</p>', 'messageformat' => FORMAT_HTML,
                'timemodified' => time() - ($i === 0 ? 20000 : 10000) + $i * 10]);
            $discussions[] = (int)$d->id;
            if ($i === 0) {
                $first = $DB->get_field('forum_discussions', 'firstpost', ['id' => $d->id], MUST_EXIST);
                for ($j = 1; $j < 130; $j++) {
                    $fg->create_post(['discussion' => $d->id, 'userid' => $student->id,
                        'parent' => $first, 'subject' => 'Reply ' . $j,
                        'message' => '<p>Synthetic reply ' . $j . '</p>', 'messageformat' => FORMAT_HTML,
                        'created' => time() - 20000 + $j, 'mailed' => 1]);
                }
                $state['old_post_id'] = (int)$first;
                $state['long_discussion_id'] = (int)$d->id;
            }
        }
        $state['forum_id'] = (int)$forum->id;
        $state['discussions'] = $discussions;
        read_save();
        rebuild_course_cache($course->id, true);
    }
    read_out(array_diff_key($state, ['tokens' => true]));
    break;
case 'editold':
    $post = $DB->get_record('forum_posts', ['id' => $state['old_post_id'],
        'discussion' => $state['long_discussion_id']], '*', MUST_EXIST);
    $post->message = '<p>READ_OLD_AFTER_' . $run . '</p>';
    $discussion = $DB->get_record('forum_discussions', ['id' => $post->discussion], '*', MUST_EXIST);
    $post->timestart = $discussion->timestart;
    $post->timeend = $discussion->timeend;
    $post->itemid = file_get_unused_draft_itemid();
    forum_update_post($post, null);
    read_out(['post_id' => (int)$post->id, 'discussion_id' => (int)$post->discussion]);
    break;
case 'token':
    $service = $DB->get_record('external_services', ['shortname' => 'arahub_lab'], '*', MUST_EXIST);
    $before = $DB->get_fieldset_select('external_tokens', 'id', 'userid = ?', [$student->id]);
    $token = \core_external\util::generate_token(EXTERNAL_TOKEN_PERMANENT, $service,
        $student->id, context_system::instance(), time() + 3600);
    $record = $DB->get_record('external_tokens', ['token' => $token], '*', MUST_EXIST);
    if (in_array($record->id, $before)) throw new RuntimeException('READ-GUARD: reused token refused');
    $state['tokens'][] = (int)$record->id;
    read_save();
    // Secret output is consumed only by a captured child pipe, never terminal/evidence.
    read_out(['token' => $token, 'token_id' => (int)$record->id]);
    break;
case 'revoke':
    // Can only delete IDs minted by THIS run, never a token ID supplied by a caller.
    foreach ($state['tokens'] as $id) {
        $record = $DB->get_record('external_tokens', ['id' => $id, 'userid' => $student->id]);
        if ($record) (new webservice())->delete_user_ws_token($id);
    }
    $state['tokens'] = [];
    read_save();
    read_out(['revoked_owned_tokens' => true]);
    break;
default:
    throw new RuntimeException('READ-GUARD: unknown command');
}
