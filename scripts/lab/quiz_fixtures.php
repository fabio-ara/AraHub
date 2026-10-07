<?php
// AraHub MIT. Calls the installed Moodle APIs; no Moodle implementation copied.
// php /opt/arahub-lab/tools/quiz_fixtures.php COMMAND RUN_UUID INSTANCE_UUID
// Admin creates only this run's course/quizzes/service and temporary deadline.
// Student REST calls start/save/finish attempts. Oracle never advances state.
define('CLI_SCRIPT', true);
require('/var/www/html/config.php');
require_once($CFG->dirroot . '/lib/testing/generator/lib.php');
require_once($CFG->dirroot . '/lib/enrollib.php');
require_once($CFG->dirroot . '/lib/questionlib.php');
require_once($CFG->dirroot . '/course/lib.php');
require_once($CFG->dirroot . '/mod/quiz/lib.php');
require_once($CFG->dirroot . '/mod/quiz/locallib.php');
require_once($CFG->dirroot . '/webservice/lib.php');
$CFG->debugdisplay = 0;
$command = $argv[1] ?? '';
$run = $argv[2] ?? '';
$expected = $argv[3] ?? '';
foreach ([$run, $expected] as $uuid) {
    if (!preg_match('/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/D', $uuid)) {
        throw new RuntimeException('QUIZ_GUARD_UUID');
    }
}
if (trim((string)@file_get_contents($CFG->dataroot . '/.arahub-lab-instance-id')) !== $expected ||
        rtrim($CFG->wwwroot, '/') !== 'http://localhost:8480') {
    throw new RuntimeException('QUIZ_GUARD_INSTANCE');
}
\core\session\manager::set_user(get_admin());
$student = $DB->get_record('user', ['username' => 'labstudentb'], '*', MUST_EXIST);
$path = $CFG->dataroot . '/arahub-lab/quiz-suite-' . $run . '.json';
$state = is_file($path) ? json_decode(file_get_contents($path), true) : null;
$shortname = 'lab_quiz_suite/' . $run;
$servicename = 'arahub_quiz_' . str_replace('-', '', $run);
function quiz_proof_out($data) {
    echo 'ARAHUB-QUIZ-JSON:', json_encode($data, JSON_UNESCAPED_SLASHES), "\n";
}
function quiz_proof_save() {
    global $state, $path;
    file_put_contents($path, json_encode($state), LOCK_EX);
    chmod($path, 0600);
}
if ($command === 'setup' && !$state) {
    if ($DB->record_exists('course', ['shortname' => $shortname]) ||
            $DB->record_exists('external_services', ['shortname' => $servicename])) {
        throw new RuntimeException('QUIZ_GUARD_REFUSE_ADOPTION');
    }
    $transaction = $DB->start_delegated_transaction();
    $category = $DB->get_record('course_categories', ['idnumber' => 'LAB'], '*', MUST_EXIST);
    $course = create_course((object)[
        'fullname' => $shortname, 'shortname' => $shortname, 'idnumber' => 'arahub-quiz:' . $run,
        'category' => $category->id, 'format' => 'topics', 'numsections' => 1, 'visible' => 1,
    ]);
    $manual = enrol_get_plugin('manual');
    $enrol = $DB->get_record('enrol', ['courseid' => $course->id, 'enrol' => 'manual']);
    if (!$enrol) {
        $enrolid = $manual->add_default_instance($course);
        $enrol = $DB->get_record('enrol', ['id' => $enrolid], '*', MUST_EXIST);
    }
    $role = $DB->get_record('role', ['shortname' => 'student'], '*', MUST_EXIST);
    $manual->enrol_user($enrol, $student->id, $role->id);
    $gen = new testing_data_generator();
    $qgen = $gen->get_plugin_generator('core_question');
    $qcategory = $qgen->create_question_category([
        'contextid' => context_course::instance($course->id)->id, 'name' => 'Quiz proof questions',
    ]);
    $empty = ['text' => '', 'format' => FORMAT_HTML];
    // Original synthetic question, saved through the public question type API.
    $form = (object)[
        'category' => (string)$qcategory->id, 'name' => 'Synthetic arithmetic',
        'questiontext' => ['text' => '<p>Choose the value of 2 + 2.</p>', 'format' => FORMAT_HTML],
        'generalfeedback' => $empty, 'defaultmark' => 1, 'penalty' => 0,
        'single' => 1, 'shuffleanswers' => 0, 'answernumbering' => 'abc', 'shownumcorrect' => 0,
        'answer' => [['text' => '4', 'format' => FORMAT_PLAIN], ['text' => '5', 'format' => FORMAT_PLAIN]],
        'fraction' => [1, 0], 'feedback' => [$empty, $empty], 'hint' => [],
        'correctfeedback' => $empty, 'partiallycorrectfeedback' => $empty, 'incorrectfeedback' => $empty,
    ];
    $question = question_bank::get_qtype('multichoice')->save_question((object)['qtype' => 'multichoice'], $form);
    $quizzes = [];
    foreach (['manual', 'timeout'] as $mode) {
        $quiz = $gen->create_module('quiz', [
            'course' => $course->id, 'section' => 1, 'name' => 'Quiz proof ' . $mode,
            'intro' => '<p>Synthetic quiz proof only.</p>', 'introformat' => FORMAT_HTML,
            'timelimit' => 600, 'attempts' => 1, 'overduehandling' => 'autosubmit',
            'shuffleanswers' => 0, 'preferredbehaviour' => 'deferredfeedback',
        ]);
        quiz_add_quiz_question($question->id, $quiz);
        \mod_quiz\quiz_settings::create($quiz->id)->get_grade_calculator()->recompute_quiz_sumgrades();
        $quizzes[$mode] = ['id' => (int)$quiz->id, 'cmid' => (int)$quiz->cmid, 'timelimit' => 600];
    }
    $ws = new webservice();
    $serviceid = $ws->add_external_service((object)[
        'name' => $servicename, 'shortname' => $servicename, 'enabled' => 1,
        'restrictedusers' => 1, 'downloadfiles' => 0, 'uploadfiles' => 0,
    ]);
    $functions = [
        'core_webservice_get_site_info', 'core_course_get_contents',
        'mod_quiz_get_quizzes_by_courses', 'mod_quiz_get_quiz_access_information',
        'mod_quiz_get_user_attempts', 'mod_quiz_start_attempt', 'mod_quiz_get_attempt_data',
        'mod_quiz_save_attempt', 'mod_quiz_process_attempt',
    ];
    foreach ($functions as $function) $ws->add_external_function_to_service($function, $serviceid);
    $ws->add_ws_authorised_user((object)[
        // Token has the one-hour expiry; this disposable service membership ends at cleanup.
        'externalserviceid' => $serviceid, 'userid' => $student->id, 'validuntil' => null,
    ]);
    $state = [
        'run' => $run, 'course_id' => (int)$course->id, 'student_id' => (int)$student->id,
        'quizzes' => $quizzes, 'service_id' => (int)$serviceid, 'service_functions' => $functions,
        'token_scope' => ['context' => 'course', 'course_id' => (int)$course->id],
    ];
    rebuild_course_cache($course->id, true);
    $transaction->allow_commit();
    quiz_proof_save();
}
if (!$state) throw new RuntimeException('QUIZ_GUARD_SETUP_REQUIRED');
$course = $DB->get_record('course', [
    'id' => $state['course_id'], 'shortname' => $shortname, 'idnumber' => 'arahub-quiz:' . $run,
], '*', MUST_EXIST);
if ((int)$course->id <= 4 || (int)$student->id !== $state['student_id']) {
    throw new RuntimeException('QUIZ_GUARD_COURSE_STUDENT');
}
foreach ($state['quizzes'] as $quiz) {
    $cm = get_coursemodule_from_id('quiz', $quiz['cmid'], $course->id, false, MUST_EXIST);
    if ((int)$cm->instance !== $quiz['id']) throw new RuntimeException('QUIZ_GUARD_MODULE');
}
switch ($command) {
case 'setup': case 'state':
    quiz_proof_out($state);
    break;
case 'token':
    $service = $DB->get_record('external_services', ['id' => $state['service_id'],
        'shortname' => $servicename, 'restrictedusers' => 1], '*', MUST_EXIST);
    // Secret is captured by the runner's child pipe, never terminal or evidence.
    $token = \core_external\util::generate_token(EXTERNAL_TOKEN_PERMANENT, $service,
        $student->id, context_course::instance($course->id), time() + 3600, '', 'Quiz proof ' . $run);
    quiz_proof_out(['token' => $token]);
    break;
case 'expire':
    $quizid = $state['quizzes']['timeout']['id'];
    if ($DB->record_exists('quiz_overrides', ['quiz' => $quizid])) {
        throw new RuntimeException('QUIZ_GUARD_EXISTING_OVERRIDE');
    }
    $attempt = $DB->get_record('quiz_attempts', ['quiz' => $quizid, 'userid' => $student->id,
        'state' => 'inprogress', 'preview' => 0], '*', MUST_EXIST);
    $manager = \mod_quiz\quiz_settings::create($quizid)->get_override_manager();
    $manager->require_manage_capability();
    $deadline = time() - 2;
    if ($deadline < (int)$attempt->timestart) throw new RuntimeException('QUIZ_GUARD_TOO_EARLY');
    $transaction = $DB->start_delegated_transaction();
    $id = $manager->save_override(['userid' => $student->id, 'timeclose' => $deadline]);
    $state['override_id'] = $id;
    quiz_proof_save();
    $transaction->allow_commit();
    quiz_proof_out(['override_id' => $id, 'quiz_id' => $quizid, 'deadline' => $deadline,
        'original_timeclose' => 0, 'clock_changed' => false,
        'online_grace_seconds' => (int)get_config('quiz', 'graceperiodmin')]);
    break;
case 'restore': case 'cleanup':
    $restored = false;
    if (isset($state['override_id'])) {
        $id = $state['override_id'];
        $quizid = $state['quizzes']['timeout']['id'];
        $override = $DB->get_record('quiz_overrides', ['id' => $id, 'quiz' => $quizid, 'userid' => $student->id]);
        if ($override) {
            $manager = \mod_quiz\quiz_settings::create($quizid)->get_override_manager();
            $manager->require_manage_capability();
            $manager->delete_overrides_by_id([$id]);
            quiz_update_open_attempts(['quizid' => $quizid]);
        }
        $restored = !$DB->record_exists('quiz_overrides', ['id' => $id]);
        if (!$restored) throw new RuntimeException('QUIZ_RESTORE_FAILED');
        unset($state['override_id']);
        quiz_proof_save();
    }
    $servicegone = false;
    if ($command === 'cleanup') {
        $service = $DB->get_record('external_services', ['id' => $state['service_id']]);
        if ($service && $service->shortname !== $servicename) throw new RuntimeException('QUIZ_GUARD_SERVICE');
        if ($service) (new webservice())->delete_service($service->id);
        $servicegone = !$DB->record_exists('external_services', ['id' => $state['service_id']]) &&
            !$DB->record_exists('external_tokens', ['externalserviceid' => $state['service_id']]);
        if (!$servicegone) throw new RuntimeException('QUIZ_TOKEN_CLEANUP_FAILED');
    }
    $settings = quiz_update_effective_access(
        $DB->get_record('quiz', ['id' => $state['quizzes']['timeout']['id']], '*', MUST_EXIST), $student->id);
    quiz_proof_out(['override_removed' => $restored || !isset($state['override_id']),
        'effective_timeclose' => (int)$settings->timeclose, 'effective_timelimit' => (int)$settings->timelimit,
        'owned_service_and_tokens_removed' => $servicegone]);
    break;
case 'oracle':
    $out = [];
    foreach ($state['quizzes'] as $mode => $quiz) {
        $attempts = $DB->get_records('quiz_attempts', ['quiz' => $quiz['id'], 'userid' => $student->id], 'id');
        $records = [];
        foreach ($attempts as $attempt) {
            // Read-only question-engine inspection; no handle_if_time_expired/process methods.
            $obj = \mod_quiz\quiz_attempt::create($attempt->id);
            $qa = $obj->get_question_attempt(1);
            $response = $qa->get_last_qt_data();
            $records[] = [
                'id' => (int)$attempt->id, 'userid' => (int)$attempt->userid,
                'quiz' => (int)$attempt->quiz, 'attempt' => (int)$attempt->attempt,
                'state' => $attempt->state, 'timestart' => (int)$attempt->timestart,
                'timefinish' => (int)$attempt->timefinish, 'timemodified' => (int)$attempt->timemodified,
                'timemodifiedoffline' => (int)$attempt->timemodifiedoffline,
                'timecheckstate' => $attempt->timecheckstate === null ? null : (int)$attempt->timecheckstate,
                'preview' => (int)$attempt->preview, 'steps' => $qa->get_num_steps(),
                'has_response' => array_key_exists('answer', $response),
                'first_choice_saved' => isset($response['answer']) && (string)$response['answer'] === '0',
                'response_sha256' => hash('sha256', json_encode($response)),
            ];
        }
        $out[$mode] = ['attempts' => $records, 'count' => count($records)];
    }
    quiz_proof_out($out);
    break;
default:
    throw new RuntimeException('QUIZ_GUARD_COMMAND');
}
