<?php
// AraHub (MIT). Fixtures adicionais e delimitadas; não altera o seed nem contas.
// Carregado por moodle_lab.php negative <op> <UUID> <run> [...].
function lab_negative(array $args): void {
    global $CFG, $DB;
    [$op, $expected, $run] = array_pad($args, 3, '');
    $actual = trim((string)@file_get_contents($CFG->dataroot . '/.arahub-lab-instance-id'));
    $url = parse_url($CFG->wwwroot);
    $host = $url['host'] ?? '';
    $local = $host === 'localhost' || $host === '[::1]' ||
        (filter_var($host, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4) && explode('.', $host)[0] === '127');
    if (!preg_match('/^[a-f0-9-]{36}$/', $expected) || $actual !== $expected || !$local ||
            ($url['port'] ?? 0) < 1024 || !preg_match('/^[a-f0-9]{12}$/', $run)) {
        lab_fail('negative: origem, marcador ou run inválido');
    }
    $shortname = 'ARAHUB-NEG-' . $run;
    $course = $DB->get_record('course', ['shortname' => $shortname]);
    if ($op === 'init') {
        $extended = ($args[3] ?? '') === 'extended';
        if ($course) { lab_fail('negative: run já existe; nenhuma fixture sobrescrita'); }
        $gen = new testing_data_generator();
        $course = $gen->create_course(['shortname' => $shortname, 'fullname' => 'Negativas sintéticas ' . $run,
            'idnumber' => $shortname, 'numsections' => 1]);
        $users = [];
        foreach (['labteacher' => 'editingteacher', 'labstudentb' => 'student', 'labstudentc' => 'student'] as $name => $role) {
            $users[$name] = $DB->get_record('user', ['username' => $name], '*', MUST_EXIST);
            lab_enrol($users[$name]->id, $course->id, $role);
        }
        if ($extended) {
            $users['labownerb'] = $DB->get_record('user', ['username' => 'labownerb'], '*', MUST_EXIST);
            lab_enrol($users['labownerb']->id, $course->id, 'student');
        }
        $base = ['course' => $course->id, 'section' => 0, 'submissiondrafts' => 1,
            'requiresubmissionstatement' => 0, 'teamsubmission' => 0, 'grade' => 100,
            'attemptreopenmethod' => 'manual', 'maxattempts' => 1,
            'assignsubmission_file_enabled' => 1, 'assignsubmission_file_maxfiles' => 1,
            'assignsubmission_file_maxsizebytes' => 5242880, 'assignsubmission_onlinetext_enabled' => 0];
        $assignments = [];
        $specs = ['timeout' => ['requiresubmissionstatement' => 1], 'content' => [], 'config' => [],
                'pdf_only' => ['assignsubmission_file_filetypes' => '.pdf'],
                'quota' => ['assignsubmission_file_maxsizebytes' => 512],
                'no_submit_button' => ['submissiondrafts' => 0],
                'group' => ['teamsubmission' => 1, 'requireallteammemberssubmit' => 1]];
        if ($extended) {
            $specs = ['due_cutoff' => ['duedate' => time() - 1200, 'cutoffdate' => time() + 3600,
                'intro' => '<p>Prazo acadêmico encerrado. A janela técnica não autoriza atraso; consulte o docente.</p>'],
                'extension' => ['duedate' => time() - 1200, 'cutoffdate' => time() - 600],
                'reopen' => [], 'replace' => [], 'warning' => []];
        }
        foreach ($specs as $name => $overrides) {
            $assignment = $gen->create_module('assign', array_merge($base, ['name' => 'Negativa ' . $name], $overrides));
            $assignments[$name] = ['id' => (int)$assignment->id, 'cmid' => lab_cmid($assignment->id, 'assign')];
            if ($name === 'extension') {
                $cm = get_coursemodule_from_instance('assign', $assignment->id, $course->id, false, MUST_EXIST);
                $native = new assign(context_module::instance($cm->id), $cm, $course);
                if (!$native->save_user_extension($users['labstudentb']->id, time() + 3600)) {
                    lab_fail('negative: extensão nativa falhou');
                }
            }
        }
        $group = groups_create_group((object)['courseid' => $course->id, 'name' => 'Grupo sintético B C']);
        groups_add_member($group, $users['labstudentb']->id);
        groups_add_member($group, $users['labstudentc']->id);
        $forums = [];
        $forumgen = $gen->get_plugin_generator('mod_forum');
        foreach (($extended ? ['general'] : ['general', 'news', 'qanda']) as $type) {
            $forum = $gen->create_module('forum', ['course' => $course->id, 'name' => 'Negativa ' . $type, 'type' => $type]);
            $discussion = $forumgen->create_discussion(['course' => $course->id, 'forum' => $forum->id,
                'userid' => $users['labteacher']->id, 'name' => 'Pergunta sintética ' . $type,
                'timecreated' => time() - 10800, 'timemodified' => time() - 10800,
                'message' => '<p>Pergunta de fixture.</p>', 'messageformat' => FORMAT_HTML]);
            $peer = $forumgen->create_post(['discussion' => $discussion->id, 'parent' => $discussion->firstpost,
                'userid' => $users['labstudentc']->id, 'subject' => 'Resposta do colega C',
                'message' => '<p>Conteúdo condicionado sintético.</p>', 'messageformat' => FORMAT_HTML,
                'created' => time() - 7200, 'modified' => time() - 7200]);
            $forums[$type] = ['id' => (int)$forum->id, 'cmid' => lab_cmid($forum->id, 'forum'),
                'discussion' => (int)$discussion->id, 'root' => (int)$discussion->firstpost, 'peer' => (int)$peer->id];
            if ($extended) {
                $second = $forumgen->create_post(['discussion' => $discussion->id, 'parent' => $discussion->firstpost,
                    'userid' => $users['labownerb']->id, 'subject' => 'Segundo colega sintético',
                    'message' => '<p>Contribuição do segundo colega.</p>', 'messageformat' => FORMAT_HTML,
                    'created' => time() - 3600, 'modified' => time() - 3600]);
                $forums[$type]['peer2'] = (int)$second->id;
            }
        }
        if ($extended) {
            groups_remove_member($group, $users['labstudentc']->id);
            groups_add_member($group, $users['labownerb']->id);
            $othergroup = groups_create_group((object)['courseid' => $course->id, 'name' => 'Grupo separado C']);
            groups_add_member($othergroup, $users['labstudentc']->id);
            $separate = $gen->create_module('forum', ['course' => $course->id, 'name' => 'Negativa grupos separados',
                'type' => 'general', 'groupmode' => SEPARATEGROUPS]);
            $groupdiscussions = [];
            foreach (['b' => [$group, $users['labownerb']->id], 'c' => [$othergroup, $users['labstudentc']->id]] as $key => $pair) {
                $d = $forumgen->create_discussion(['course' => $course->id, 'forum' => $separate->id,
                    'userid' => $pair[1], 'groupid' => $pair[0], 'name' => 'Discussão do grupo ' . $key,
                    'message' => '<p>Conteúdo exclusivo do grupo ' . $key . '.</p>', 'messageformat' => FORMAT_HTML,
                    'timecreated' => time() - 3600, 'timemodified' => time() - 3600]);
                $groupdiscussions[$key] = ['id' => (int)$d->id, 'root' => (int)$d->firstpost, 'group' => (int)$pair[0]];
            }
            $forums['separate'] = ['id' => (int)$separate->id, 'cmid' => lab_cmid($separate->id, 'forum'),
                'groups' => $groupdiscussions];
        }
        lab_out(['course' => (int)$course->id, 'run' => $run, 'assignments' => $assignments, 'forums' => $forums]);
        return;
    }
    if (!$course || $course->idnumber !== $shortname) { lab_fail('negative: curso fora do run'); }
    $id = (int)($args[3] ?? 0);
    if ($op === 'config') {
        $assignment = $DB->get_record('assign', ['id' => $id, 'course' => $course->id, 'name' => 'Negativa config'], '*', MUST_EXIST);
        $before = (int)$assignment->cutoffdate;
        $assignment->cutoffdate = time() + 86400;
        $DB->update_record('assign', $assignment);
        rebuild_course_cache($course->id, true);
        lab_out(['field' => 'cutoffdate', 'before' => $before, 'after' => (int)$assignment->cutoffdate]);
    } elseif ($op === 'warning-close') {
        $assignment = $DB->get_record('assign', ['id' => $id, 'course' => $course->id, 'name' => 'Negativa warning'], '*', MUST_EXIST);
        $assignment->cutoffdate = time() - 60;
        $DB->update_record('assign', $assignment);
        rebuild_course_cache($course->id, true);
        lab_out(['cutoff' => (int)$assignment->cutoffdate]);
    } elseif ($op === 'reopen' || $op === 'assignment-files') {
        $record = $DB->get_record('assign', ['id' => $id, 'course' => $course->id], '*', MUST_EXIST);
        $student = $DB->get_record('user', ['username' => 'labstudentb'], '*', MUST_EXIST);
        $cm = get_coursemodule_from_instance('assign', $id, $course->id, false, MUST_EXIST);
        if ($op === 'reopen') {
            if ($record->name !== 'Negativa reopen') { lab_fail('negative: alvo fora do caso reopen'); }
            $native = new assign(context_module::instance($cm->id), $cm, $course);
            lab_out(['reverted_to_draft' => $native->revert_to_draft($student->id)]);
        } else {
            $submissions = $DB->get_records('assign_submission', ['assignment' => $id, 'userid' => $student->id]);
            $files = [];
            foreach ($submissions as $submission) {
                foreach (get_file_storage()->get_area_files(context_module::instance($cm->id)->id,
                        'assignsubmission_file', 'submission_files', $submission->id, 'id', false) as $file) {
                    $files[] = ['name' => $file->get_filename(), 'bytes' => $file->get_filesize(),
                        'sha256' => hash('sha256', $file->get_content()), 'attempt' => (int)$submission->attemptnumber];
                }
            }
            lab_out(['files' => $files]);
        }
    } elseif ($op === 'forum-close') {
        $discussion = $DB->get_record('forum_discussions', ['id' => $id, 'course' => $course->id], '*', MUST_EXIST);
        $discussion->timelocked = time() - 1;
        $DB->update_record('forum_discussions', $discussion);
        lab_out(['discussion' => $id, 'timelocked' => (int)$discussion->timelocked]);
    } elseif ($op === 'forum-oracle') {
        $DB->get_record('forum', ['id' => $id, 'course' => $course->id], '*', MUST_EXIST);
        $posts = $DB->get_records_sql('SELECT p.id,p.parent,p.userid,p.subject,p.message FROM {forum_posts} p
            JOIN {forum_discussions} d ON d.id=p.discussion WHERE d.forum=:forum ORDER BY p.id', ['forum' => $id]);
        lab_out(['posts' => array_values($posts), 'count' => count($posts)]);
    } else {
        lab_fail('negative: operação desconhecida');
    }
}
