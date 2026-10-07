<?php
// AraHub (MIT). Unitario sem Moodle: importa apenas a funcao sob teste via tokens.
// Nao carrega config.php, nao acessa banco/rede nem executa o dispatcher do helper.
$tokens = token_get_all(file_get_contents(__DIR__ . '/moodle_lab.php'));
$function = '';
$capturing = false;
$body = false;
$depth = 0;
foreach ($tokens as $index => $token) {
    if (is_array($token) && $token[0] === T_FUNCTION) {
        $next = $index + 1;
        while (is_array($tokens[$next]) && $tokens[$next][0] === T_WHITESPACE) { $next++; }
        if (is_array($tokens[$next]) && $tokens[$next][1] === 'lab_reset_assign') { $capturing = true; }
    }
    if (!$capturing) { continue; }
    $function .= is_array($token) ? $token[1] : $token;
    if ($token === '{') { $body = true; $depth++; }
    if ($token === '}' && $body && --$depth === 0) { break; }
}
if (!$function || !$body || $depth !== 0) { throw new RuntimeException('Funcao sob teste nao encontrada.'); }
eval($function);
class FixtureDb {
    public array $deleted = [];
    public function get_field_sql(...$args) { return 10; }
    public function get_records(string $table, array $conditions) {
        return match ($table) {
            'assign_submission' => [(object)['id' => 11]],
            'grade_items' => [(object)['id' => 12]],
            default => throw new RuntimeException('Leitura inesperada.'),
        };
    }
    public function get_record(...$args) { return (object)['course' => 13]; }
    public function delete_records(string $table, array $conditions): void { $this->deleted[$table] = $conditions; }
}
class context_module { public static function instance($id) { return (object)['id' => $id]; } }
function get_file_storage() { return new class { public function delete_area_files(...$args) {} }; }
function lab_out(array $value): void {}
define('MUST_EXIST', 2);
$DB = new FixtureDb();
lab_reset_assign(14, 15);
foreach (['grade_grades_history', 'grade_grades'] as $table) {
    if (($DB->deleted[$table] ?? null) !== ['itemid' => 12, 'userid' => 15]) {
        throw new RuntimeException('Reset de notas atingiria outros alunos.');
    }
}
if ($DB->deleted['assign_grades'] !== ['assignment' => 14, 'userid' => 15]) {
    throw new RuntimeException('Reset de nota da atividade sem usuario.');
}
echo json_encode(['case' => 'resetassign_preserves_other_students_grades', 'passed' => true,
    'calls_lab' => false, 'database' => 'unit_fixture']), PHP_EOL;
