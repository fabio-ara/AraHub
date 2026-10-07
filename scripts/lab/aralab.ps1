#requires -Version 7.0
<#
.SYNOPSIS
  Moodle Lab do AraHub — comandos: init, up, health, seed, verify, audit,
  sentinela, reset, shell.

.EXAMPLE
  pwsh scripts/lab/aralab.ps1 init
  pwsh scripts/lab/aralab.ps1 up
  pwsh scripts/lab/aralab.ps1 health
  pwsh scripts/lab/aralab.ps1 seed
  pwsh scripts/lab/aralab.ps1 verify
  pwsh scripts/lab/aralab.ps1 audit
  pwsh scripts/lab/aralab.ps1 reset
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('init', 'up', 'health', 'seed', 'verify', 'audit', 'prove', 'sentinela', 'guardas', 'reset', 'shell', 'manifest', 'help')]
    [string]$Command = 'help',

    [ValidateSet('4.5.6', '4.5.15')]
    [string]$MoodleVersion = '4.5.6',

    [switch]$Reinstall
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
    $PSNativeCommandUseErrorActionPreference = $false
}

. (Join-Path $PSScriptRoot 'aralab-lib.ps1') -MoodleVersion $MoodleVersion -Reinstall:$Reinstall

$script:ManifestPath = Join-Path (Get-LabOutputRoot) 'manifest.lab.json'

function Get-LabManifest {
    if (-not (Test-Path $script:ManifestPath)) { throw 'Manifesto ausente. Rode: aralab.ps1 seed' }
    Get-Content -Raw -Encoding UTF8 $script:ManifestPath | ConvertFrom-Json
}

function Set-LabEndpoints {
    $manifest = Get-LabManifest
    Assert-LabManifest $manifest
    Assert-LabOwnership
    $script:Manifest = $manifest
    $script:Origin = $manifest.origin
    $script:RestEndpoint = $manifest.rest_endpoint
    $script:UploadEndpoint = $manifest.upload_endpoint
}

function Get-LabJson {
    param([string]$Raw)
    $marker = 'ARAHUB-LAB-JSON:'
    $index = $Raw.LastIndexOf($marker)
    if ($index -lt 0) { throw "Saida sem marcador JSON: $Raw" }
    $json = $Raw.Substring($index + $marker.Length)
    $newline = $json.IndexOf([char]10)
    if ($newline -ge 0) { $json = $json.Substring(0, $newline) }
    $json.Trim() | ConvertFrom-Json
}

function Get-LabContainerName {
    param([string]$Role)
    $inst = Get-LabInstance
    $filterInstance = "label=com.arahub.lab.instance=$($inst.instance_id)"
    $filterRole = "label=com.arahub.lab.role=$Role"
    $names = @(& docker ps -a --filter $filterInstance --filter $filterRole --format '{{.Names}}')
    if ($names.Count -eq 0) { throw "Container do papel '$Role' ausente." }
    $names[0]
}

function Invoke-MoodleRest {
    param([string]$Token, [string]$Function, [string[]]$Params = @())
    $argv = @('-s', '-S', '-X', 'POST', $script:RestEndpoint,
        '--data-urlencode', "wstoken=$Token",
        '--data-urlencode', "wsfunction=$Function",
        '--data-urlencode', 'moodlewsrestformat=json')
    foreach ($p in $Params) { $argv += @('--data-urlencode', $p) }
    $raw = (& curl.exe @argv) -join $script:NL
    if ([string]::IsNullOrWhiteSpace($raw)) { throw "Resposta vazia de $Function" }
    $parsed = $null
    try { $parsed = $raw | ConvertFrom-Json } catch { throw "Resposta nao-JSON de $Function : $raw" }
    if ($null -ne (Get-Field $parsed 'exception')) {
        throw ("Moodle exception [{0}]: {1}" -f (Get-Field $parsed 'errorcode'), (Get-Field $parsed 'message'))
    }
    $parsed
}

function Invoke-MoodleUpload {
    param([string]$Token, [string]$Path, [string]$Mime, [int]$ItemId = 0)
    # upload.php le token/itemid da query string (mesmo contrato do adapter raiz).
    $url = $script:UploadEndpoint + '?token=' + [uri]::EscapeDataString($Token) + '&itemid=' + $ItemId
    $field = 'file_1=@' + (ConvertTo-ComposePath $Path) + ';type=' + $Mime
    $argv = @('-s', '-S', '-X', 'POST', $url, '-F', $field)
    $raw = (& curl.exe @argv) -join $script:NL
    $parsed = $null
    try { $parsed = $raw | ConvertFrom-Json } catch { throw "Resposta nao-JSON do upload: $raw" }
    if ($null -ne (Get-Field $parsed 'exception')) {
        throw ("Moodle exception no upload [{0}]: {1}" -f (Get-Field $parsed 'errorcode'), (Get-Field $parsed 'message'))
    }
    $parsed
}

# Acesso a campo tolerante a ausencia (StrictMode seguro).
function Get-Field {
    param($Object, [string]$Name, $Default = $null)
    if ($null -eq $Object) { return $Default }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -ne $property) { return $property.Value }
    if ($Object -is [System.Collections.IDictionary] -and $Object.Contains($Name)) {
        return $Object[$Name]
    }
    return $Default
}

# Conta avisos do Moodle: listas de warnings ou campo warnings do envelope.
function Get-MoodleWarningCount {
    param($Response)
    if ($null -eq $Response) { return 0 }
    if ($Response -is [System.Array]) { return @($Response).Count }
    $warnings = Get-Field $Response 'warnings'
    if ($warnings) { return @($warnings).Count }
    return 0
}

function Wait-DbReady {
    for ($i = 0; $i -lt 60; $i++) {
        $out = Invoke-LabCompose @('exec', '-T', 'db', 'pg_isready', '-U', 'moodle') -IgnoreExit
        if ($out -match 'accepting connections') { return }
        Start-Sleep -Seconds 2
    }
    throw 'Banco do Lab nao ficou pronto em ~120s.'
}

function Test-DatabaseInstalled {
    $argv = (Get-ComposeArgv) + @('exec', '-T', 'webserver', 'test', '-f', '/var/www/moodledata/.arahub-lab-installed')
    & docker @argv *> $null
    return ($LASTEXITCODE -eq 0)
}

function Install-LabDatabase {
    $password = Get-AdminPassword
    Write-Lab 'Instalando a base do Moodle Lab (sintetica)...'
    Invoke-MoodleCli @(
        'admin/cli/install_database.php', '--agree-license',
        '--fullname=AraHub Moodle Lab (sintetico)', '--shortname=arahublab',
        '--summary=Laboratorio sintetico do AraHub.',
        '--adminuser=labadmin', "--adminpass=$password", '--adminemail=labadmin@lab.invalid'
    )
    $inst = Get-LabInstance
    $markerCmd = "printf '%s' '$($inst.instance_id)' > /var/www/moodledata/.arahub-lab-instance-id" +
        " && touch /var/www/moodledata/.arahub-lab-installed" +
        " && chown -R www-data:www-data /var/www/moodledata"
    Invoke-LabCompose @('exec', '-T', 'webserver', 'sh', '-c', $markerCmd)
}

function Invoke-LabSeed {
    Assert-LabOwnership
    $seed = Get-LabJson (Invoke-MoodleCli @('/opt/arahub-lab/tools/moodle_lab.php', 'seed'))
    $ws = Get-LabJson (Invoke-MoodleCli @('/opt/arahub-lab/tools/moodle_lab.php', 'ws'))

    $outFiles = Join-Path (Get-LabOutputRoot) 'out'
    New-Item -ItemType Directory -Force -Path $outFiles | Out-Null
    $webContainer = Get-LabContainerName 'webserver'
    & docker cp ($webContainer + ':/var/www/moodledata/arahub-lab/files/.') $outFiles *> $null
    if ($LASTEXITCODE -ne 0) { throw 'Falha ao copiar fixtures do dataroot para a saída privada.' }

    $tokensRaw = (Invoke-LabCompose @('exec', '-T', 'webserver', 'cat', '/var/www/moodledata/arahub-lab/tokens.json'))
    $tokens = $tokensRaw | ConvertFrom-Json

    $inst = Get-LabInstance
    $images = [ordered]@{}
    foreach ($img in @('moodlehq/moodle-php-apache:8.3', 'postgres:17', 'axllent/mailpit:v1.10')) {
        $digest = (& docker image inspect --format '{{index .RepoDigests 0}}' $img 2>$null)
        $images[$img] = ($digest -join '')
    }

    $manifest = [ordered]@{
        schema            = 'arahub.moodle-lab.manifest/1'
        instance_id       = $inst.instance_id
        project           = $inst.project
        origin            = $inst.wwwroot
        rest_endpoint     = "$($inst.wwwroot)/webservice/rest/server.php"
        upload_endpoint   = "$($inst.wwwroot)/webservice/upload.php"
        mailpit_url       = "$($inst.wwwroot)/_/mail/"
        moodle            = [ordered]@{ version = $inst.moodle_version; ref = $inst.moodle_ref; commit = $inst.moodle_commit }
        runtime           = [ordered]@{ php = $inst.php; postgres = $inst.postgres; images = $images }
        service           = [ordered]@{ id = $ws.service_id; shortname = 'arahub_lab'; functions = $ws.functions }
        accounts_password = (Get-AdminPassword)
        accounts          = [ordered]@{}
        fixture           = $seed
        created_at        = (Get-Date).ToUniversalTime().ToString('o')
    }
    $tokenUsers = @($tokens.tokens.PSObject.Properties.Name)
    foreach ($user in (@('labadmin') + $tokenUsers)) {
        $userId = $null
        $tokenValue = $null
        if ($tokenUsers -contains $user) {
            $userId = $tokens.tokens.$user.userid
            $tokenValue = $tokens.tokens.$user.token
        }
        $manifest.accounts[$user] = [ordered]@{ userid = $userId; token = $tokenValue }
    }
    $manifest | ConvertTo-Json -Depth 12 | Set-Content -Encoding UTF8 $script:ManifestPath
    Write-Lab "Manifesto privado escrito (tokens nao impressos): $script:ManifestPath"
    Write-Lab "Contas: $((@($manifest.accounts.Keys) -join ', '))"
    Write-Lab "Fixture: disciplina=$($seed.courses.disciplina) assign=$($seed.assignment.fingerprint) forum=$($seed.forum.general)"
}

function Test-LabHealth {
    Assert-LabOwnership
    $inst = Get-LabInstance
    $checks = [System.Collections.Generic.List[object]]::new()
    $fixturesOk = $true
    $fixtureSpecs = @(
        @{ name = 'ficha-leitura-sintetica.docx'; magic = 'PK'; min = 200 },
        @{ name = 'texto-base-sintetico.pdf'; magic = '%PDF'; min = 200 },
        @{ name = 'video-aula-sintetico.mp4'; magic = 'ftyp'; min = 1000 }
    )
    foreach ($spec in $fixtureSpecs) {
        $path = Join-Path (Join-Path (Get-LabOutputRoot) 'out') $spec.name
        if (-not (Test-Path $path)) { $fixturesOk = $false; continue }
        $length = (Get-Item $path).Length
        $head = [Text.Encoding]::ASCII.GetString((Get-Content $path -AsByteStream -TotalCount 8))
        if ($length -lt $spec.min -or $head -notmatch [regex]::Escape($spec.magic)) { $fixturesOk = $false }
    }
    $checks.Add([ordered]@{ name = 'fixtures'; ok = $fixturesOk; detail = 'DOCX/PDF/MP4 com bytes reais (nao 1 byte)' })
    $running = @(& docker ps --filter "name=$($inst.project)" --format '{{.Names}}')
    $checks.Add([ordered]@{ name = 'containers'; ok = ($running.Count -ge 4); detail = ($running -join ',') })
    try {
        $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 25 -Uri "$($inst.wwwroot)/login/index.php"
        $checks.Add([ordered]@{ name = 'http_login'; ok = ($response.StatusCode -eq 200); detail = "HTTP $($response.StatusCode)" })
    } catch {
        $checks.Add([ordered]@{ name = 'http_login'; ok = $false; detail = $_.Exception.Message })
    }
    try {
        $null = Invoke-RestMethod -TimeoutSec 25 -Uri "$($inst.wwwroot)/_/mail/api/v1/messages?limit=1"
        $checks.Add([ordered]@{ name = 'mailpit'; ok = $true })
    } catch {
        $checks.Add([ordered]@{ name = 'mailpit'; ok = $false; detail = $_.Exception.Message })
    }
    $db = Invoke-LabCompose @('exec', '-T', 'db', 'pg_isready', '-U', 'moodle') -IgnoreExit
    $checks.Add([ordered]@{ name = 'db'; ok = ($db -match 'accepting connections') })
    $checks.Add([ordered]@{ name = 'installed'; ok = (Test-DatabaseInstalled) })
    $failedChecks = @(@($checks) | Where-Object { -not $_.ok })
    $ok = $failedChecks.Count -eq 0
    foreach ($c in $checks) {
        $status = if (Get-Field $c 'ok') { 'OK   ' } else { 'FALHA' }
        Write-Lab ("{0,-12} {1} {2}" -f (Get-Field $c 'name'), $status, (Get-Field $c 'detail' ''))
    }
    if (-not $ok) { throw 'Saude do Lab: ha verificacoes falhando.' }
    Write-Lab 'Saude do Lab OK.'
}

function Invoke-LabVerify {
    Set-LabEndpoints
    $m = $script:Manifest
    $student = $m.accounts.labstudenta.token
    $teacher = $m.accounts.labteacher.token
    $results = [System.Collections.Generic.List[object]]::new()
    $add = {
        param($id, $ok, $detail)
        $results.Add([ordered]@{ id = $id; ok = [bool]$ok; detail = $detail })
        Write-Lab ("{0,-15} {1} {2}" -f $id, $(if ($ok) { 'OK   ' } else { 'FALHA' }), $detail)
    }

    $guardOk = $false
    try { Assert-LabOrigin 'https://elearning.ulisboa.pt/webservice/rest/server.php' } catch { $guardOk = $true }
    & $add 'LAB-04' $guardOk 'origem institucional recusada sem rede'

    $site = Invoke-MoodleRest $student 'core_webservice_get_site_info'
    $siteUser = Get-Field $site 'username'
    & $add 'REST-01' ($siteUser -eq 'labstudenta') "site_info de $siteUser"
    $userid = [int](Get-Field $site 'userid')

    $courses = Invoke-MoodleRest $student 'core_enrol_get_users_courses' @('userid=' + $userid)
    $courseIds = @($courses | ForEach-Object { $_.id })
    & $add 'READ-01' ($courseIds -contains [int]$m.fixture.courses.disciplina) "cursos: $($courseIds -join ',')"

    $contents = Invoke-MoodleRest $student 'core_course_get_contents' @('courseid=' + $m.fixture.courses.disciplina)
    $mods = @($contents | ForEach-Object { $_.modules } | ForEach-Object { $_.modname } | Sort-Object -Unique)
    $required = @('assign', 'forum', 'book', 'resource', 'url', 'page', 'label')
    $missing = @($required | Where-Object { $mods -notcontains $_ })
    & $add 'READ-03' ($missing.Count -eq 0) "modulos faltando: $($missing -join ',')"

    $access = Invoke-MoodleRest $student 'mod_forum_get_forum_access_information' @('forumid=' + $m.fixture.forum.general)
    $canStart = Get-Field $access 'canstartdiscussion'
    & $add 'LAB-02P' ($canStart -eq $true) "estudante inicia discussoes; canreplypost=$(Get-Field $access 'canreplypost') cancreateattachment=$(Get-Field $access 'cancreateattachment')"

    $flags = Invoke-MoodleRest $student 'mod_assign_get_user_flags' @('assignmentids[0]=' + $m.fixture.assignment.fingerprint)
    $warnings = @(Get-Field $flags 'warnings')
    $assignments = @(Get-Field $flags 'assignments')
    $refused = ($warnings.Count -ge 1) -and ($assignments.Count -eq 0)
    & $add 'LAB-02N' $refused "funcao so-docente recusada (warnings=$($warnings.Count))"

    $pdfPath = Join-Path (Get-LabOutputRoot) 'out\texto-base-sintetico.pdf'
    $localHash = (Get-FileHash -Algorithm SHA256 $pdfPath).Hash.ToLowerInvariant()
    $upload = Invoke-MoodleUpload $student $pdfPath 'application/pdf'
    $file = @($upload)[0]
    $size = (Get-Item $pdfPath).Length
    & $add 'FILE-UPLOAD' ($file.component -eq 'user' -and $file.filearea -eq 'draft' -and [int]$file.filesize -eq $size) "draft itemid=$($file.itemid) bytes=$($file.filesize)"
    $draftId = [int]$file.itemid

    $assignId = [int]$m.fixture.assignment.fingerprint
    # Estado limpo para tornar o gate repetivel (dados sinteticos do Lab).
    $null = Get-LabJson (Invoke-MoodleCli @('/opt/arahub-lab/tools/moodle_lab.php', 'resetassign', $assignId, $userid))
    $save = Invoke-MoodleRest $student 'mod_assign_save_submission' @("assignmentid=$assignId", "plugindata[files_filemanager]=$draftId")
    $saveWarnings = Get-MoodleWarningCount $save
    & $add 'ASSIGN-SAVE' ($saveWarnings -eq 0) "warnings=$saveWarnings"

    $oracle = Get-LabJson (Invoke-MoodleCli @('/opt/arahub-lab/tools/moodle_lab.php', 'oracle', $assignId, $userid))
    $statuses = @($oracle.submissions | ForEach-Object { $_.status })
    & $add 'ASSIGN-DRAFT' ($oracle.submission_rows -ge 1 -and $statuses -contains 'draft') "estado pos-save: $($statuses -join ',')"

    $submit = Invoke-MoodleRest $student 'mod_assign_submit_for_grading' @("assignmentid=$assignId", 'acceptsubmissionstatement=1')
    $submitWarnings = Get-MoodleWarningCount $submit
    & $add 'ASSIGN-SUBMIT' ($submitWarnings -eq 0) "warnings=$submitWarnings"

    $oracle2 = Get-LabJson (Invoke-MoodleCli @('/opt/arahub-lab/tools/moodle_lab.php', 'oracle', $assignId, $userid))
    $statuses2 = @($oracle2.submissions | ForEach-Object { $_.status })
    & $add 'ASSIGN-SUBMITTED' ($statuses2 -contains 'submitted') "estado pos-submit: $($statuses2 -join ',')"

    $subs = Invoke-MoodleRest $teacher 'mod_assign_get_submissions' @('assignmentids[0]=' + $assignId)
    $sub = @(@($subs.assignments)[0].submissions | Where-Object { [int]$_.userid -eq $userid })[0]
    & $add 'INDEP-SUBMIT' ($sub.status -eq 'submitted') "docente observou status=$($sub.status)"

    $forumId = [int]$m.fixture.forum.general
    $disc = Invoke-MoodleRest $student 'mod_forum_add_discussion' @(
        "forumid=$forumId", 'subject=Topico sintetico do estudante A',
        'message=<p>Contribuicao sintetica do Moodle Lab.</p>',
        'options[0][name]=discussionsubscribe', 'options[0][value]=0')
    $discussionId = [int]$disc[0].discussionid
    & $add 'FORUM-TOPIC' ($discussionId -gt 0) "discussionid=$discussionId"

    $posts = Invoke-MoodleRest $student 'mod_forum_get_discussion_posts' @('discussionid=' + $discussionId)
    $authorOf = { param($Post) [int](Get-Field (Get-Field $Post 'author') 'id') }
    $mine = @($posts.posts | Where-Object { & $authorOf $_ -eq $userid })
    & $add 'FORUM-AUTHOR' ($mine.Count -ge 1) "posts proprios: $($mine.Count)"
    $targetPost = @($posts.posts | Where-Object { & $authorOf $_ -ne $userid })[0]

    $parentId = [int]$targetPost.id
    $reply = Invoke-MoodleRest $student 'mod_forum_add_discussion_post' @(
        "postid=$parentId", 'subject=Resposta sintetica',
        'message=<p>Resposta sintetica do estudante A.</p>', 'messageformat=1',
        'options[0][name]=discussionsubscribe', 'options[0][value]=0')
    $newPostId = [int]$reply.postid
    $posts2 = Invoke-MoodleRest $student 'mod_forum_get_discussion_posts' @('discussionid=' + $discussionId)
    $child = @($posts2.posts | Where-Object { [int]$_.id -eq $newPostId })[0]
    $childParent = [int](Get-Field $child 'parentid')
    & $add 'FORUM-REPLY' ($childParent -eq $parentId) "parentid=$childParent esperado=$parentId"

    $isolatedDenied = $false
    try { $null = Invoke-MoodleRest $student 'core_course_get_contents' @('courseid=' + $m.fixture.courses.isolamento) }
    catch { $isolatedDenied = $true }
    & $add 'LAB-ISO' $isolatedDenied 'acesso cruzado a curso recusado'

    $payload = [ordered]@{
        schema      = 'arahub.moodle-lab.rest-contract/1'
        instance_id = $m.instance_id
        moodle      = "$($m.moodle.version) ($($m.moodle.ref))"
        origin      = $m.origin
        pdf_sha256  = $localHash
        when        = (Get-Date).ToUniversalTime().ToString('o')
        results     = $results
        failed      = @(@($results) | Where-Object { -not $_.ok }).Count
    }
    Write-Evidence ('rest-contract-' + (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')) $payload | Out-Null
    if ($payload.failed -gt 0) { throw "Contrato REST: $($payload.failed) verificacao(oes) falhando." }
    Write-Lab 'Contrato REST aprovado (upload/save/submit/forum) com verificacao independente.'
}

function Invoke-SubmissionStatusAudit {
    Set-LabEndpoints
    $m = $script:Manifest
    $student = $m.accounts.labstudenta.token
    $teacher = $m.accounts.labteacher.token
    $assignId = [int]$m.fixture.assignment.fingerprint
    $site = Invoke-MoodleRest $student 'core_webservice_get_site_info'
    $userid = [int](Get-Field $site 'userid')
    $tool = '/opt/arahub-lab/tools/moodle_lab.php'

    # Estado inicial limpo (submissao + nota) para a auditoria ser repetivel.
    $null = Get-LabJson (Invoke-MoodleCli @($tool, 'resetassign', $assignId, $userid))

    $snap = { param($Tag) Get-LabJson (Invoke-MoodleCli @($tool, 'snap', $Tag, $assignId, $userid)) }
    $sdiff = { param($From, $To) (Get-LabJson (Invoke-MoodleCli @($tool, 'sdiff', $From, $To))).diff }

    # A) controle: leitura sabidamente sem efeito de nota.
    $null = & $snap 'c0'
    $null = Invoke-MoodleRest $student 'core_webservice_get_site_info'
    $c1 = & $snap 'c1'
    $control = & $sdiff 'c0' 'c1'

    # B) alvo sem nota lancada.
    $null = & $snap 's0'
    $statusRaw = $null
    try { $statusRaw = Invoke-MoodleRest $student 'mod_assign_get_submission_status' @("assignid=$assignId") }
    catch { $statusRaw = [ordered]@{ error = $_.Exception.Message } }
    $s1 = & $snap 's1'
    $targetUngraded = & $sdiff 's0' 's1'

    # C) referencia: o docente lanca uma nota (escrita real de avaliacao).
    $null = & $snap 'g0'
    $gradeResult = $null
    try {
        $gradeResult = Invoke-MoodleRest $teacher 'mod_assign_save_grade' @(
            "assignmentid=$assignId", "userid=$userid", 'grade=80', 'attemptnumber=-1',
            'addattempt=0', 'workflowstate=released', 'applytoall=0')
    } catch { $gradeResult = [ordered]@{ error = $_.Exception.Message } }
    $g1 = & $snap 'g1'
    $gradingWrite = & $sdiff 'g0' 'g1'

    # D) alvo com nota lancada (exercita o caminho de feedback/nota).
    $null = & $snap 's2'
    $statusGraded = $null
    try { $statusGraded = Invoke-MoodleRest $student 'mod_assign_get_submission_status' @("assignid=$assignId") }
    catch { $statusGraded = [ordered]@{ error = $_.Exception.Message } }
    $s3 = & $snap 's3'
    $targetGraded = & $sdiff 's2' 's3'

    # E) comparador: navegacao normal do estudante na pagina da atividade (web).
    $pageRead = [ordered]@{ ran = $false; detail = 'nao executado' }
    try {
        $cookie = Join-Path (Get-LabOutputRoot) 'out\lab-cookies.txt'
        Remove-Item $cookie -ErrorAction SilentlyContinue
        $labPassword = $m.accounts_password
        $loginPage = (& curl.exe -s -c $cookie "$($m.origin)/login/index.php") -join ''
        $tokenMatch = [regex]::Match($loginPage, 'name="logintoken" value="([^"]+)"')
        $loginToken = if ($tokenMatch.Success) { $tokenMatch.Groups[1].Value } else { '' }
        # A senha vai como campo do formulario; nunca em arquivo nem no transcript.
        $null = & curl.exe -s -b $cookie -c $cookie "$($m.origin)/login/index.php" --data-urlencode "logintoken=$loginToken" --data-urlencode 'username=labstudenta' --data-urlencode "password=$labPassword"
        $cmid = [int]$m.fixture.assignment.fingerprint_cmid
        $null = & $snap 'p0'
        $page = (& curl.exe -s -b $cookie "$($m.origin)/mod/assign/view.php?id=$cmid") -join ''
        $p1 = & $snap 'p1'
        $pageDiff = & $sdiff 'p0' 'p1'
        $pageRead = [ordered]@{ ran = $true; http_len = $page.Length; diff = $pageDiff }
        Remove-Item -Force $cookie -ErrorAction SilentlyContinue
    } catch {
        $pageRead = [ordered]@{ ran = $false; detail = $_.Exception.Message }
    }

    $oracle = Get-LabJson (Invoke-MoodleCli @($tool, 'oracle', $assignId, $userid))

    $payload = [ordered]@{
        schema          = 'arahub.moodle-lab.submission-status-audit/1'
        instance_id     = $m.instance_id
        moodle          = "$($m.moodle.version) ($($m.moodle.ref))"
        when            = (Get-Date).ToUniversalTime().ToString('o')
        target_function = 'mod_assign_get_submission_status'
        control_read    = $control
        target_ungraded = $targetUngraded
        grading_write_reference = $gradingWrite
        target_graded   = $targetGraded
        page_read_normal_navigation = $pageRead
        absolute_rows   = [ordered]@{
            after_control = [ordered]@{ grade_items = $c1.snapshot.grade_items; grade_grades = $c1.snapshot.grade_grades; history = $c1.snapshot.grade_grades_history }
            after_ungraded = [ordered]@{ grade_items = $s1.snapshot.grade_items; grade_grades = $s1.snapshot.grade_grades; history = $s1.snapshot.grade_grades_history }
            after_grading = [ordered]@{ grade_items = $g1.snapshot.grade_items; grade_grades = $g1.snapshot.grade_grades; history = $g1.snapshot.grade_grades_history }
            after_graded_read = [ordered]@{ grade_items = $s3.snapshot.grade_items; grade_grades = $s3.snapshot.grade_grades; history = $s3.snapshot.grade_grades_history }
        }
        oracle_state    = [ordered]@{
            submission_rows = $oracle.submission_rows
            statuses        = @($oracle.submissions | ForEach-Object { $_.status })
        }
        status_response_keys = @($statusRaw.PSObject.Properties | ForEach-Object { $_.Name })
    }
    Write-Evidence ('submission-status-audit-' + (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')) $payload | Out-Null
    Write-Lab "controle: itens+$($control.grade_items_delta) grades+$($control.grade_grades_delta) hist+$($control.grade_grades_history_delta) submissao+$($control.assign_submission_delta) eventos=$($control.new_log_event_count)"
    Write-Lab "alvo sem nota: itens+$($targetUngraded.grade_items_delta) grades+$($targetUngraded.grade_grades_delta) hist+$($targetUngraded.grade_grades_history_delta) submissao+$($targetUngraded.assign_submission_delta) eventos=$($targetUngraded.new_log_event_count)"
    Write-Lab "nota (docente): itens+$($gradingWrite.grade_items_delta) grades+$($gradingWrite.grade_grades_delta) hist+$($gradingWrite.grade_grades_history_delta) submissao+$($gradingWrite.assign_submission_delta) eventos=$($gradingWrite.new_log_event_count)"
    Write-Lab "alvo com nota: itens+$($targetGraded.grade_items_delta) grades+$($targetGraded.grade_grades_delta) hist+$($targetGraded.grade_grades_history_delta) submissao+$($targetGraded.assign_submission_delta) eventos=$($targetGraded.new_log_event_count)"
    if ($targetUngraded.assign_submission_delta -ne 0) {
        Write-Lab 'ATENCAO: a leitura materializou linha de submissao em estado limpo (nao e somente leitura).' 'ALERTA'
    }
    if ($pageRead.ran) {
        Write-Lab "pagina normal do aluno: itens+$($pageRead.diff.grade_items_delta) grades+$($pageRead.diff.grade_grades_delta) hist+$($pageRead.diff.grade_grades_history_delta) eventos=$($pageRead.diff.new_log_event_count)"
    } else {
        Write-Lab "pagina normal do aluno: nao executada ($($pageRead.detail))"
    }
}

# Provas negativas: recusa de origem e recusa de marcador divergente.
function Test-LabGuards {
    Assert-LabOwnership -AllowMarkerBootstrap
    $inst = Get-LabInstance
    $results = [ordered]@{}

    $originCases = @(
        @{ name = 'institutional_origin_refused'; origin = 'https://elearning.ulisboa.pt/webservice/rest/server.php'; expect = 'refuse' },
        @{ name = 'public_http_origin_refused'; origin = 'http://moodle.example.org'; expect = 'refuse' },
        @{ name = 'empty_origin_refused'; origin = ''; expect = 'refuse' },
        @{ name = 'whitespace_origin_refused'; origin = 'http://127.0.0.1:8480/ x'; expect = 'refuse' },
        @{ name = 'prefix_lookalike_host_refused'; origin = 'http://127.evil.com:8480'; expect = 'refuse' },
        @{ name = 'credentials_origin_refused'; origin = 'http://lab:lab@127.0.0.1:8480'; expect = 'refuse' },
        @{ name = 'default_port_refused'; origin = 'http://127.0.0.1'; expect = 'refuse' },
        @{ name = 'privileged_port_refused'; origin = 'http://127.0.0.1:80'; expect = 'refuse' },
        @{ name = 'subdirectory_refused'; origin = 'http://127.0.0.1:8480/moodle'; expect = 'refuse' },
        @{ name = 'query_refused'; origin = 'http://127.0.0.1:8480?a=1'; expect = 'refuse' },
        @{ name = 'fragment_refused'; origin = 'http://127.0.0.1:8480#x'; expect = 'refuse' },
        @{ name = 'non_loopback_ip_refused'; origin = 'http://10.0.0.5:8480'; expect = 'refuse' },
        @{ name = 'loopback_accepted'; origin = $inst.wwwroot; expect = 'accept' },
        @{ name = 'ipv6_loopback_accepted'; origin = 'http://[::1]:8480'; expect = 'accept' }
    )
    foreach ($case in $originCases) {
        $accepted = $false
        try { $null = Assert-LabOrigin $case.origin; $accepted = $true } catch { $accepted = $false }
        $wanted = ($case.expect -eq 'accept')
        $results[$case.name] = ($accepted -eq $wanted)
    }

    # Marcador divergente no dataroot tem de abortar antes de qualquer mutacao.
    Invoke-LabCompose @('exec', '-T', 'webserver', 'sh', '-c',
        "printf '%s' 'wrong-marker' > /var/www/moodledata/.arahub-lab-instance-id") | Out-Null
    $mismatchRefused = $false
    try { Assert-LabOwnership } catch { $mismatchRefused = $true }
    $results.dataroot_marker_mismatch_refused = $mismatchRefused
    Invoke-LabCompose @('exec', '-T', 'webserver', 'sh', '-c',
        "printf '%s' '$($inst.instance_id)' > /var/www/moodledata/.arahub-lab-instance-id") | Out-Null
    Assert-LabOwnership
    $results.marker_restored = $true

    foreach ($key in $results.Keys) {
        $status = if ($results[$key]) { 'OK   ' } else { 'FALHA' }
        Write-Lab ("{0,-34} {1}" -f $key, $status)
    }
    $payload = [ordered]@{
        schema = 'arahub.moodle-lab.guards/1'
        instance_id = $inst.instance_id
        when = (Get-Date).ToUniversalTime().ToString('o')
        results = $results
    }
    Write-Evidence ('guards-' + (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')) $payload | Out-Null
    $failed = @($results.Keys | Where-Object { -not $results[$_] })
    if ($failed.Count -gt 0) { throw ("Guardas falhando: " + ($failed -join ', ')) }
    Write-Lab 'Guardas negativas OK.'
}

function Reset-Lab {
    Assert-LabOwnership -Destructive
    $inst = Get-LabInstance
    # Uma consulta que falha nao comprova ausencia de recursos.
    function Read-ResetDockerNames {
        param([string[]]$DockerArgs)
        $names = @(& docker @DockerArgs)
        if ($LASTEXITCODE -ne 0) { throw 'GUARDA: falhou a leitura do inventario Docker do reset.' }
        return $names
    }
    $before = [ordered]@{
        lab_containers = @(Read-ResetDockerNames @('ps', '-a', '--filter', "label=com.docker.compose.project=$($inst.project)", '--format', '{{.Names}}'))
        lab_volumes    = @(Read-ResetDockerNames @('volume', 'ls', '--filter', "label=com.docker.compose.project=$($inst.project)", '--format', '{{.Name}}'))
        sentinel_containers = @(Read-ResetDockerNames @('ps', '-a', '--filter', 'name=arahublab-sentinel', '--format', '{{.Names}}'))
        sentinel_volumes    = @(Read-ResetDockerNames @('volume', 'ls', '--filter', 'name=arahublab-sentinel', '--format', '{{.Name}}'))
        foreign_containers_before = @(Read-ResetDockerNames @('ps', '-a', '--format', '{{.Names}}'))
        foreign_volumes_before = @(Read-ResetDockerNames @('volume', 'ls', '--format', '{{.Name}}'))
    }
    Invoke-LabCompose @('down', '-v', '--remove-orphans')
    $cleanupError = $null
    $cleanup = $null
    try {
        $cleanup = Remove-LabResetRemainders -Instance $inst -BeforeContainers $before.lab_containers -BeforeVolumes $before.lab_volumes
    } catch { $cleanupError = $_.Exception.Message }
    $remainingContainers = @(Read-ResetDockerNames @('ps', '-a', '--filter', "label=com.docker.compose.project=$($inst.project)", '--format', '{{.Names}}'))
    $remainingVolumes = @(Read-ResetDockerNames @('volume', 'ls', '--filter', "label=com.docker.compose.project=$($inst.project)", '--format', '{{.Name}}'))
    if (Test-Path (Join-Path $script:LabRoot 'sentinel\compose.yml')) { Assert-SentinelIntact }
    $foreignBefore = @($before.foreign_containers_before | Where-Object { $before.lab_containers -notcontains $_ })
    $foreignAfter = @(Read-ResetDockerNames @('ps', '-a', '--format', '{{.Names}}') | Where-Object { $before.lab_containers -notcontains $_ })
    $missingForeign = @($foreignBefore | Where-Object { $foreignAfter -notcontains $_ })
    $foreignVolumesBefore = @($before.foreign_volumes_before | Where-Object { $before.lab_volumes -notcontains $_ })
    $foreignVolumesAfter = @(Read-ResetDockerNames @('volume', 'ls', '--format', '{{.Name}}') | Where-Object { $before.lab_volumes -notcontains $_ })
    $missingForeignVolumes = @($foreignVolumesBefore | Where-Object { $foreignVolumesAfter -notcontains $_ })
    $payload = [ordered]@{
        schema      = 'arahub.moodle-lab.reset-isolation/1'
        instance_id = $inst.instance_id
        project     = $inst.project
        when        = (Get-Date).ToUniversalTime().ToString('o')
        passed      = (-not $cleanupError -and $remainingContainers.Count -eq 0 -and $remainingVolumes.Count -eq 0 -and $missingForeign.Count -eq 0 -and $missingForeignVolumes.Count -eq 0)
        initial_guard = 'uuid_project_and_dataroot_verified_before_down'
        inventory_before = $before
        residual_cleanup = $cleanup
        residual_cleanup_error = $cleanupError
        removed = [ordered]@{
            lab_containers = @($before.lab_containers | Where-Object { $remainingContainers -notcontains $_ })
            lab_volumes    = @($before.lab_volumes | Where-Object { $remainingVolumes -notcontains $_ })
        }
        lab_remaining_after = [ordered]@{
            containers = $remainingContainers
            volumes    = $remainingVolumes
        }
        sentinel = [ordered]@{
            containers_before = $before.sentinel_containers
            volumes_before    = $before.sentinel_volumes
            containers_after  = @(Read-ResetDockerNames @('ps', '-a', '--filter', 'name=arahublab-sentinel', '--format', '{{.Names}}'))
            volumes_after     = @(Read-ResetDockerNames @('volume', 'ls', '--filter', 'name=arahublab-sentinel', '--format', '{{.Name}}'))
        }
        foreign_containers_missing_after = $missingForeign
        foreign_volumes_missing_after = $missingForeignVolumes
    }
    Write-Evidence ('reset-isolation-' + (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')) $payload | Out-Null
    if ($missingForeign.Count -gt 0) {
        throw ("GUARDA: reset removeu containers alheios ao Lab: " + ($missingForeign -join ', '))
    }
    if ($missingForeignVolumes.Count -gt 0) { throw 'GUARDA: reset removeu volumes alheios ao Lab.' }
    if ($cleanupError) { throw $cleanupError }
    if ($remainingContainers.Count -gt 0 -or $remainingVolumes.Count -gt 0) {
        throw ("GUARDA: reset incompleto; restam {0} containers e {1} volumes do projeto." -f $remainingContainers.Count, $remainingVolumes.Count)
    }
    Write-Lab 'Reset OK: zero containers/volumes do projeto; containers alheios preservados e sentinela conferida quando configurada.'
}

# Reinicia o estado da entrega e roda a prova SDK -> AraHub -> Moodle.
function Invoke-LabProve {
    Set-LabEndpoints
    $m = $script:Manifest
    $studentToken = $m.accounts.labstudenta.token
    $userId = [int]$m.accounts.labstudenta.userid
    $assignId = [int]$m.fixture.assignment.fingerprint
    $null = Get-LabJson (Invoke-MoodleCli @('/opt/arahub-lab/tools/moodle_lab.php', 'resetassign', $assignId, $userId))
    Write-Lab 'Entrega zerada (sem rascunho): a prova parte do zero.'
    Write-Lab 'Executando scripts/lab/prove.ts (SDK MCP -> AraHub -> Moodle) ...'
    & deno run -A (Join-Path $PSScriptRoot 'prove.ts') $script:ManifestPath (Get-InstanceFile)
    if ($LASTEXITCODE -ne 0) { throw "prove.ts falhou ($LASTEXITCODE)" }
    Write-Lab 'Prova SDK->AraHub->Moodle concluida.'
}

function Show-Help {
    Write-Host @'
Moodle Lab do AraHub

  init        cria o marcador da instancia e o arquivo de ambiente
  up          sobe db+mailpit+webserver+cron, instala a base e semeia
  health      verifica containers, HTTP, banco, Mailpit e instalacao
  seed        semeia contas/cursos/atividades e cria tokens + manifesto
  verify      contrato REST com token de estudante e verificacao independente
  audit       mede efeitos de mod_assign_get_submission_status (antes/depois)
  sentinela   cria um projeto Docker alheio para provar isolamento do reset
  reset       remove apenas containers/volumes do projeto Lab
  shell       abre shell no container webserver
  manifest    mostra o caminho e o esquema do manifesto (sem segredos)

Opcoes: -MoodleVersion 4.5.6|4.5.15  -Reinstall
'@
}

switch ($Command) {
    'init' { New-LabInstance -Force:$Reinstall; Write-Lab 'Instancia inicializada.' }
    'up' {
        if ($Reinstall) { Assert-LabOwnership -Destructive } else { Assert-LabOwnership -AllowMarkerBootstrap }
        New-LabEnvFile
        if ($Reinstall) { Invoke-LabCompose @('down', '-v', '--remove-orphans') | Out-Null }
        Initialize-LabCode
        Invoke-LabCompose @('up', '-d', 'db', 'mailpit', 'webserver', 'cron') | Out-Null
        Wait-DbReady
        Ensure-ConfigPhp
        # Bootstrap do marcador ANTES da instalacao: exige rotulos confirmados e
        # apenas inicializa o dataroot em instancia nova; nunca aceita divergencia.
        Assert-LabOwnership -AllowMarkerBootstrap | Out-Null
        if (-not (Test-DatabaseInstalled)) { Install-LabDatabase } else { Write-Lab 'Base Moodle ja instalada.' }
        Invoke-LabSeed
        Write-Lab "Lab pronto em $((Get-LabInstance).wwwroot)"
    }
    'health' {
        try { Test-LabHealth } catch {
            Write-Lab ($_.InvocationInfo.PositionMessage) 'FALHA'
            throw
        }
    }
    'seed' { Invoke-LabSeed }
    'verify' { Invoke-LabVerify }
    'audit' { Invoke-SubmissionStatusAudit }
    'prove' { Invoke-LabProve }
    'sentinela' { New-Sentinel }
    'guardas' { Test-LabGuards }
    'reset' { Reset-Lab }
    'shell' { Invoke-LabCompose @('exec', 'webserver', 'bash') | Out-Null }
    'manifest' { Write-Lab "Caminho: $script:ManifestPath"; Write-Lab 'Esquema: accounts.<usuario>.token|userid, origin, rest_endpoint, upload_endpoint, fixture.*' }
    default { Show-Help }
}
