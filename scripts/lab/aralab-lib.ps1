#requires -Version 7.0
<#
.SYNOPSIS
  Controlador do Moodle Lab privado do AraHub (base moodlehq/moodle-docker).

.DESCRIPTION
  Comandos: init, up, health, seed, verify, audit, sentinela, reset, shell.
  Toda operacao mutavel exige o marcador de propriedade da instancia
  (ARAHUB_LAB_INSTANCE_ID) conferido no JSON da instancia, nas etiquetas dos
  containers/volumes e no arquivo de marcador do dataroot. Recusa qualquer
  origem fora de loopback. Nunca imprime tokens.

.NOTES
  Codigo do AraHub (MIT). Nao copia GPL: o Moodle e o moodle-docker ficam
  clonados sob .private e sao apenas consumidos por compose/exec.
#>
[CmdletBinding()]
param(
    [ValidateSet('4.5.6', '4.5.15')]
    [string]$MoodleVersion = '4.5.6',

    [switch]$Reinstall
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:NL = [string][char]10

$script:RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$script:LabRoot = Join-Path $script:RepoRoot '.private\entrega-1\lab'
$script:MoodleDockerDir = Join-Path $script:LabRoot 'src\moodle-docker'
$script:ToolsDir = Join-Path $script:LabRoot 'tools'
$script:PublicToolsDir = Join-Path $script:RepoRoot 'scripts\lab'
$script:FixturesDir = Join-Path $script:LabRoot 'fixtures'
$script:EvidenceDir = Join-Path $script:LabRoot 'evidence'
$script:InstancesDir = Join-Path $script:LabRoot 'instances'

$script:VersionMap = @{
    '4.5.6'  = @{ ref = 'v4.5.6';  commit = 'fb02f4fa9f2c5d6ba37d1032e2357554cea37fc2'; port = 8480; mailport = 8025; project = 'arahublab456';  slug = 'moodle-4.5.6' }
    '4.5.15' = @{ ref = 'v4.5.15'; commit = '215f44380bdc3ccf852a3a22e34f8423ff64033a'; port = 8481; mailport = 8026; project = 'arahublab4515'; slug = 'moodle-4.5.15' }
}

# Fonte oficial pinada do moodle-docker. O init clona/alinha este commit.
$script:MoodleDockerRepo = 'https://github.com/moodlehq/moodle-docker.git'
$script:MoodleDockerCommit = 'f4c2324d32fb74d7753264381f0a9b418b6034b2'

function Write-Lab {
    param([string]$Message, [string]$Level = 'INFO')
    Write-Host ("[{0}] {1}" -f $Level, $Message)
}

function Get-VersionSpec { $script:VersionMap[$MoodleVersion] }
function Get-InstanceRoot { Join-Path $script:InstancesDir (Get-VersionSpec).project }
function Get-InstanceFile { Join-Path (Get-InstanceRoot) 'instance.json' }
function Get-LabOutputRoot {
    if ($MoodleVersion -eq '4.5.6') { return $script:LabRoot }
    return (Get-InstanceRoot)
}
function Get-LabOverrideFile { Join-Path (Get-LabOutputRoot) 'compose\local.yml' }
if ($MoodleVersion -ne '4.5.6') { $script:EvidenceDir = Join-Path (Get-LabOutputRoot) 'evidence' }
function Get-ComposeFile { param([string]$Leaf) Join-Path $script:MoodleDockerDir $Leaf }
function ConvertTo-ComposePath { param([string]$Path) ($Path -replace '\\', '/') }
function ConvertTo-LabBindPath {
    param([string]$Path)
    $converted = ConvertTo-ComposePath $Path
    # O pipe direto do motor Linux nao passa pelo tradutor de caminhos do
    # Docker Desktop. Usa o mount do host somente nesse endpoint explicito.
    if ($env:DOCKER_HOST -eq 'npipe:////./pipe/docker_engine_linux' -and $converted -match '^([A-Za-z]):/(.*)$') {
        return '/run/desktop/mnt/host/' + $Matches[1].ToLowerInvariant() + '/' + $Matches[2]
    }
    return $converted
}

# Garante fontes oficiais pinadas e o override generico, sem depender de arquivo
# privado pre-existente: o init materializa o que faltar (idempotente).
function Initialize-LabSources {
    if (-not (Test-Path (Join-Path $script:MoodleDockerDir '.git'))) {
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $script:MoodleDockerDir) | Out-Null
        & git clone --quiet $script:MoodleDockerRepo $script:MoodleDockerDir
        if ($LASTEXITCODE -ne 0) { throw "Falha ao clonar o moodle-docker oficial." }
    }
    $pin = $script:MoodleDockerCommit + '^{commit}'
    & git -C $script:MoodleDockerDir cat-file -e $pin 2>$null
    if ($LASTEXITCODE -ne 0) {
        & git -C $script:MoodleDockerDir fetch --quiet origin
        & git -C $script:MoodleDockerDir cat-file -e $pin 2>$null
        if ($LASTEXITCODE -ne 0) { throw "Commit pinado do moodle-docker indisponivel: $($script:MoodleDockerCommit)" }
    }
    $dockerHead = (& git -C $script:MoodleDockerDir rev-parse HEAD).Trim()
    if ($dockerHead -ne $script:MoodleDockerCommit) {
        & git -C $script:MoodleDockerDir checkout --quiet $script:MoodleDockerCommit
        if ($LASTEXITCODE -ne 0) { throw "Falha ao fixar o moodle-docker em $($script:MoodleDockerCommit)." }
    }

    $spec = Get-VersionSpec
    $moodleDir = Join-Path $script:LabRoot ('src\' + $spec.slug)
    if (-not (Test-Path $moodleDir)) {
        & git clone --quiet --depth 1 --branch $spec.ref https://github.com/moodle/moodle.git $moodleDir
        if ($LASTEXITCODE -ne 0) { throw 'Falha ao obter o Moodle oficial.' }
    }
    $moodleHead = (& git -C $moodleDir rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or $moodleHead -ne $spec.commit) {
        throw 'Checkout Moodle diverge do commit pinado; preservado sem sobrescrita.'
    }

    New-Item -ItemType Directory -Force -Path $script:ToolsDir | Out-Null
    $template = Join-Path $script:ToolsDir 'config.docker-template.php'
    if (-not (Test-Path $template)) {
        $origin = Join-Path $script:MoodleDockerDir 'config.docker-template.php'
        if (-not (Test-Path $origin)) { throw "Template do moodle-docker ausente no clone." }
        [IO.File]::Copy($origin, $template)
    }

    $composeDir = Join-Path (Get-LabOutputRoot) 'compose'
    New-Item -ItemType Directory -Force -Path $composeDir | Out-Null
    $override = Join-Path $composeDir 'local.yml'
    if (-not (Test-Path $override)) {
        $publicTemplate = Join-Path $script:PublicToolsDir 'compose\local.yml.template'
        if (-not (Test-Path $publicTemplate)) { throw "Template publico do override ausente: $publicTemplate" }
        [IO.File]::Copy($publicTemplate, $override)
    }
}

function Get-LabInstance {
    if (-not (Test-Path (Get-InstanceFile))) { throw 'Instancia nao inicializada. Rode: aralab.ps1 init' }
    Get-Content -Raw -Encoding UTF8 (Get-InstanceFile) | ConvertFrom-Json
}

function New-LabInstance {
    param([switch]$Force)
    $spec = Get-VersionSpec
    New-Item -ItemType Directory -Force -Path (Get-InstanceRoot) | Out-Null
    if ((Test-Path (Get-InstanceFile)) -and $Force) {
        throw 'init não troca UUID de instância existente. Use up -Reinstall somente após a guarda destrutiva.'
    }
    if ((Test-Path (Get-InstanceFile)) -and -not $Force) {
        Initialize-LabSources
        New-LabEnvFile
        Write-Lab "Instancia ja inicializada: $(Get-InstanceFile)"
        return
    }
    Initialize-LabSources
    $moodleDir = Join-Path $script:LabRoot ('src\' + $spec.slug)
    if (-not (Test-Path $moodleDir)) { throw "Checkout Moodle ausente: $moodleDir" }
    $commit = (& git -C $moodleDir rev-parse HEAD).Trim()
    $instance = [ordered]@{
        instance_id    = [guid]::NewGuid().ToString()
        project        = $spec.project
        moodle_version = $MoodleVersion
        moodle_ref     = $spec.ref
        moodle_commit  = $commit
        php            = '8.3'
        postgres       = '17'
        wwwroot        = ('http://localhost:{0}' -f $spec.port)
        created_at     = (Get-Date).ToUniversalTime().ToString('o')
    }
    $instance | ConvertTo-Json | Set-Content -Encoding UTF8 (Get-InstanceFile)
    Write-Lab "Marcador criado: $($instance.instance_id)"
    New-LabEnvFile
}

function New-LabEnvFile {
    $inst = Get-LabInstance
    $spec = Get-VersionSpec
    $lines = @(
        "COMPOSE_PROJECT_NAME=$($inst.project)",
        "MOODLE_DOCKER_WWWROOT=$(ConvertTo-LabBindPath (Join-Path $script:LabRoot ('src\' + $spec.slug)))",
        'MOODLE_DOCKER_DB=pgsql',
        'MOODLE_DOCKER_DB_VERSION=17',
        'MOODLE_DOCKER_PHP_VERSION=8.3',
        'MOODLE_DOCKER_WEB_HOST=localhost',
        "MOODLE_DOCKER_WEB_PORT=127.0.0.1:$($spec.port)",
        "ARAHUB_LAB_MAIL_PORT=127.0.0.1:$($spec.mailport)",
        'MOODLE_DOCKER_TIMEOUT_FACTOR=1',
        'MOODLE_DOCKER_BROWSER=firefox',
        'MOODLE_DOCKER_BROWSER_TAG=4',
        "ASSETDIR=$(ConvertTo-LabBindPath (Join-Path $script:MoodleDockerDir 'assets'))",
        "ARAHUB_LAB_TOOLS=$(ConvertTo-LabBindPath (Join-Path $script:RepoRoot 'scripts\lab'))",
        "ARAHUB_LAB_PRIVATE=$(ConvertTo-LabBindPath $script:ToolsDir)",
        "ARAHUB_LAB_FIXTURES=$(ConvertTo-LabBindPath $script:FixturesDir)",
        "ARAHUB_LAB_INSTANCE_ID=$($inst.instance_id)"
    )
    Set-Content -Encoding UTF8 (Join-Path (Get-InstanceRoot) 'lab.env') ($lines -join $script:NL)
}

function Get-AdminPassword {
    $inst = Get-LabInstance
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $hash = ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes("arahub-lab:$($inst.instance_id)")) |
        ForEach-Object { $_.ToString('x2') }) -join ''
    'Lab-' + $hash.Substring(0, 16) + '!'
}

function Get-ComposeArgv {
    $inst = Get-LabInstance
    @('compose', '--project-name', $inst.project, '--env-file', (Join-Path (Get-InstanceRoot) 'lab.env'),
        '-f', (Get-ComposeFile 'base.yml'),
        '-f', (Get-ComposeFile 'service.mail.yml'),
        '-f', (Get-ComposeFile 'db.pgsql.yml'),
        '-f', (Get-ComposeFile 'webserver.port.yml'),
        '-f', (Get-LabOverrideFile))
}

function Invoke-LabCompose {
    param([string[]]$ComposeArgs, [switch]$IgnoreExit)
    $argv = (Get-ComposeArgv) + $ComposeArgs
    $output = & docker @argv 2>&1
    if ($LASTEXITCODE -ne 0 -and -not $IgnoreExit) {
        throw ("docker compose falhou ({0}): {1}" -f $LASTEXITCODE, ($output -join $script:NL))
    }
    ($output -join $script:NL)
}

function Invoke-MoodleCli {
    param([string[]]$MoodleArgs, [switch]$IgnoreExit)
    $argv = (Get-ComposeArgv) + @('exec', '-T', 'webserver', 'php') + $MoodleArgs
    $output = & docker @argv 2>&1
    if ($LASTEXITCODE -ne 0 -and -not $IgnoreExit) {
        throw ("php CLI falhou ({0}): {1}" -f $LASTEXITCODE, ($output -join $script:NL))
    }
    ($output -join $script:NL)
}

function Assert-LabOrigin {
    param([string]$Origin)
    if ([string]::IsNullOrWhiteSpace($Origin)) { throw 'LAB-04: origem vazia recusada.' }
    if ($Origin -match '\s') { throw 'LAB-04: origem com espaco recusada.' }
    $uri = $null
    if (-not [uri]::TryCreate($Origin, [System.UriKind]::Absolute, [ref]$uri)) {
        throw "LAB-04: origem invalida: $Origin"
    }
    if ($uri.Scheme -notin @('http', 'https')) { throw "LAB-04: esquema recusado ($($uri.Scheme))." }
    if ($uri.UserInfo) { throw 'LAB-04: origem com credenciais recusada.' }
    if ($uri.Query -or $uri.Fragment) { throw 'LAB-04: origem com query ou fragmento recusada.' }
    if ($uri.AbsolutePath -notin @('', '/')) { throw 'LAB-04: subdiretorio nao permitido no laboratorio.' }
    # Loopback por endereco, nunca por prefixo de texto: 127.evil.com nao passa.
    $address = $null
    if ([System.Net.IPAddress]::TryParse($uri.Host, [ref]$address)) {
        if (-not [System.Net.IPAddress]::IsLoopback($address)) {
            throw "LAB-04: IP fora de loopback recusado: $($uri.Host)"
        }
    } elseif ($uri.Host.ToLowerInvariant() -ne 'localhost') {
        throw "LAB-04: host fora de loopback recusado: $($uri.Host)"
    }
    # Porta explicita na faixa alta; 80/443 implicitos ficam de fora.
    if ($uri.IsDefaultPort) { throw 'LAB-04: porta padrao recusada; use porta loopback explicita.' }
    if ($uri.Port -lt 1024) { throw "LAB-04: porta nao privilegiada exigida ($($uri.Port))." }
    return $uri
}

function Initialize-LabCode {
    $inst = Get-LabInstance
    $spec = Get-VersionSpec
    $volume = "$($inst.project)_html"
    $names = @(& docker volume ls --format '{{.Name}}')
    if ($LASTEXITCODE -ne 0) { throw 'GUARDA: inventario de volumes indisponivel; nenhuma criacao autorizada.' }
    if ($names -notcontains $volume) {
        & docker volume create --label "com.arahub.lab.instance=$($inst.instance_id)" --label "com.docker.compose.project=$($inst.project)" --label 'com.docker.compose.volume=html' --label 'com.arahub.lab.role=code' $volume | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Falha ao criar volume de codigo.' }
        Write-Lab "Volume de codigo criado: $volume"
    }
    $labels = Get-DockerLabelsJson @('volume', 'inspect', '--format', '{{json .Labels}}', $volume)
    if ((Get-LabelValue $labels 'com.arahub.lab.instance') -cne $inst.instance_id -or
        (Get-LabelValue $labels 'com.docker.compose.project') -cne $inst.project) {
        throw 'GUARDA: volume de codigo sem propriedade confirmada.'
    }
    & docker run --rm --pull=never --network=none --read-only --cap-drop ALL --security-opt no-new-privileges -v ($volume + ':/mnt:ro') alpine:3.20 test -f /mnt/version.php *> $null
    $probeExit = $LASTEXITCODE
    if ($probeExit -notin @(0, 1)) { throw 'GUARDA: sonda do codigo falhou; nao comprova volume vazio.' }
    if ($probeExit -eq 0) {
        $installedPin = (& docker run --rm --pull=never --network=none --read-only --cap-drop ALL --security-opt no-new-privileges -v ($volume + ':/mnt:ro') --entrypoint sh moodlehq/moodle-php-apache:8.3 -c 'if test -f /mnt/.arahub-source-commit; then cat /mnt/.arahub-source-commit; else git -c safe.directory=/mnt -C /mnt rev-parse HEAD; fi') -join ''
        if ($LASTEXITCODE -ne 0 -or $installedPin.Trim() -cne $spec.commit) { throw 'Codigo no volume sem commit pinado verificavel; preservado.' }
        Write-Lab 'Codigo Moodle ja presente no volume.'
        return
    }
    # O init ja obteve o commit oficial. Reutiliza-o sem uma segunda descarga
    # dentro do Docker, que pode nao ter acesso de rede no computador do usuario.
    $source = Join-Path $script:LabRoot ('src\' + $spec.slug)
    $head = (& git -C $source rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or $head -cne $spec.commit) { throw 'Fonte local diverge do commit Moodle pinado.' }
    $archive = Join-Path (Get-InstanceRoot) ('moodle-source-' + [guid]::NewGuid().ToString('N') + '.tar')
    $helper = $inst.project + '-source-' + [guid]::NewGuid().ToString('N').Substring(0, 12)
    $created = $false
    try {
        & git -C $source archive --format=tar "--output=$archive" $spec.commit
        if ($LASTEXITCODE -ne 0) { throw 'Falha ao empacotar o commit Moodle local.' }
        & docker run -d --pull=never --network=none --name $helper --label "com.arahub.lab.instance=$($inst.instance_id)" --label "com.docker.compose.project=$($inst.project)" -v ($volume + ':/source') alpine:3.20 sleep 600 | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Falha ao iniciar auxiliar de materializacao.' }
        $created = $true
        $helperLabels = Get-DockerLabelsJson @('inspect', '--format', '{{json .Config.Labels}}', $helper)
        if ((Get-LabelValue $helperLabels 'com.arahub.lab.instance') -cne $inst.instance_id -or
            (Get-LabelValue $helperLabels 'com.docker.compose.project') -cne $inst.project) {
            throw 'GUARDA: auxiliar sem propriedade confirmada; nao pode escrever no volume.'
        }
        # Uma tentativa anterior pode ter deixado somente .git. Outros dados
        # desconhecidos sao preservados e impedem a extracao.
        $unexpected = (& docker exec $helper find /source -mindepth 1 -maxdepth 1 '!' -name .git) -join ''
        if ($LASTEXITCODE -ne 0 -or $unexpected) { throw 'Volume contem dados inesperados; preservado sem sobrescrita.' }
        & docker cp $archive ($helper + ':/tmp/source.tar')
        if ($LASTEXITCODE -ne 0) { throw 'Falha ao transferir o commit Moodle para o auxiliar.' }
        & docker exec $helper tar -xf /tmp/source.tar -C /source
        if ($LASTEXITCODE -ne 0) { throw 'Falha ao extrair o commit Moodle no volume.' }
        & docker exec $helper sh -c ("printf '%s' '" + $spec.commit + "' > /source/.arahub-source-commit")
        if ($LASTEXITCODE -ne 0) { throw 'Falha ao registrar o commit materializado.' }
        Write-Lab "Codigo Moodle $MoodleVersion materializado do commit oficial local."
    } finally {
        if ($created) {
            $helperLabels = Get-DockerLabelsJson @('inspect', '--format', '{{json .Config.Labels}}', $helper)
            if ((Get-LabelValue $helperLabels 'com.arahub.lab.instance') -ceq $inst.instance_id -and
                (Get-LabelValue $helperLabels 'com.docker.compose.project') -ceq $inst.project) {
                & docker rm -f $helper | Out-Null
                if ($LASTEXITCODE -ne 0) { throw 'Falha ao remover auxiliar proprio de materializacao.' }
            } else {
                throw 'GUARDA: auxiliar sem propriedade confirmada; limpeza recusada.'
            }
        }
        if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive }
    }
}

function Ensure-ConfigPhp {
    # O template GPL vem do clone do moodle-docker (privado), nunca do repo MIT.
    $scriptText = 'test -f /var/www/html/config.php || cp /opt/arahub-lab/private/config.docker-template.php /var/www/html/config.php'
    Invoke-LabCompose @('exec', '-T', 'webserver', 'sh', '-c', $scriptText) | Out-Null
}

# Confere o manifesto inteiro antes de entregar tokens ao transporte REST.
function Assert-LabManifest {
    param($Manifest)
    $inst = Get-LabInstance
    $origin = Assert-LabOrigin $Manifest.origin
    $expectedOrigin = Assert-LabOrigin $inst.wwwroot
    if ($Manifest.schema -ne 'arahub.moodle-lab.manifest/1' -or
        $Manifest.instance_id -ne $inst.instance_id -or $Manifest.project -ne $inst.project -or
        $origin.AbsoluteUri -cne $expectedOrigin.AbsoluteUri) {
        throw 'GUARDA: manifesto não corresponde à instância selecionada.'
    }
    $root = $origin.AbsoluteUri.TrimEnd('/')
    if ($Manifest.rest_endpoint -cne ($root + '/webservice/rest/server.php') -or
        $Manifest.upload_endpoint -cne ($root + '/webservice/upload.php')) {
        throw 'GUARDA: endpoint REST/upload divergente da origem guardada.'
    }
}

# Le um campo de rotulo sem estourar em StrictMode; ausente devolve nulo.
function Get-LabelValue {
    param($Labels, [string]$Name)
    if ($null -eq $Labels) { return $null }
    $property = $Labels.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}

# Le rotulos como JSON; saida vazia, HTML ou erro nunca vale como rotulo.
function Get-DockerLabelsJson {
    param([string[]]$InspectArguments)
    $raw = (& docker @InspectArguments 2>$null) -join ''
    if ($LASTEXITCODE -ne 0) { return $null }
    if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
    if ($raw -match '<') { return $null }
    try { return ($raw | ConvertFrom-Json) } catch { return $null }
}

# Exige o marcador da instancia em CADA container e volume do projeto, com o
# projeto compose exato. Rotulo ausente, HTML ou erro recusam a operacao.
# Grava o marcador da instancia no dataroot. Chamado SOMENTE depois de todos os
# rotulos de container/volume terem sido confirmados como desta instancia.
function Write-DatarootMarker {
    $inst = Get-LabInstance
    Invoke-LabCompose @('exec', '-T', 'webserver', 'sh', '-c', "printf '%s' '$($inst.instance_id)' > /var/www/moodledata/.arahub-lab-instance-id") | Out-Null
}

# Guarda de propriedade.
# - Por padrao exige o marcador do dataroot presente e igual (mutacao destrutiva).
# - Com -AllowMarkerBootstrap, um marcador ausente e apenas inicializado, e nunca
#   quando algum rotulo de container/volume estiver ausente ou divergente.
function Assert-LabOwnership {
    param([switch]$AllowMarkerBootstrap, [switch]$Destructive)
    if ($AllowMarkerBootstrap -and $Destructive) { throw 'GUARDA: bootstrap não pode autorizar operação destrutiva.' }
    $inst = Get-LabInstance
    Assert-LabOrigin $inst.wwwroot | Out-Null
    if ($inst.instance_id -cnotmatch '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$') {
        throw 'GUARDA: instancia sem UUID valido; execute init.'
    }
    if ($inst.project -cnotmatch '^[a-z0-9][a-z0-9_-]+$') { throw 'GUARDA: nome de projeto invalido.' }
    $expected = $inst.instance_id.Trim()
    $project = $inst.project.Trim()

    & docker ps -a --format '{{.Names}}' *> $null
    if ($LASTEXITCODE -ne 0) { throw "GUARDA: nao foi possivel consultar containers do Docker." }

    $namePrefix = $project + "-"
    $byLabel = @(& docker ps -a --filter ("label=com.docker.compose.project=" + $project) --format '{{.Names}}')
    if ($LASTEXITCODE -ne 0) { throw 'GUARDA: falha ao listar containers por projeto.' }
    $byName = @(& docker ps -a --format '{{.Names}}' | Where-Object { $_ -eq $project -or $_.StartsWith($namePrefix) })
    if ($LASTEXITCODE -ne 0) { throw 'GUARDA: falha ao conferir nomes de containers.' }
    $containers = @(@($byLabel) + @($byName) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Sort-Object -Unique)
    foreach ($name in $containers) {
        $labels = Get-DockerLabelsJson @('inspect', '--format', '{{json .Config.Labels}}', $name)
        if ($null -eq $labels) { throw "GUARDA: rotulos ilegiveis ou ausentes em $name; recusando." }
        $value = Get-LabelValue $labels 'com.arahub.lab.instance'
        $projectValue = Get-LabelValue $labels 'com.docker.compose.project'
        if ([string]::IsNullOrWhiteSpace($value)) { throw "GUARDA: container $name sem marcador de propriedade; recusando." }
        if ($value -cne $expected) { throw "GUARDA: container $name tem marcador divergente." }
        if ([string]::IsNullOrWhiteSpace($projectValue)) { throw "GUARDA: container $name sem rotulo de projeto compose; recusando." }
        if ($projectValue -cne $project) { throw "GUARDA: container $name tem projeto compose divergente." }
    }

    $volumePrefix = $project + "_"
    $volByLabel = @(& docker volume ls --filter ("label=com.docker.compose.project=" + $project) --format '{{.Name}}')
    if ($LASTEXITCODE -ne 0) { throw 'GUARDA: falha ao listar volumes por projeto.' }
    $volByName = @(& docker volume ls --format '{{.Name}}' | Where-Object { $_.StartsWith($volumePrefix) })
    if ($LASTEXITCODE -ne 0) { throw 'GUARDA: falha ao conferir nomes de volumes.' }
    $volumes = @(@($volByLabel) + @($volByName) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Sort-Object -Unique)
    foreach ($volume in $volumes) {
        $labels = Get-DockerLabelsJson @('volume', 'inspect', '--format', '{{json .Labels}}', $volume)
        if ($null -eq $labels) { throw "GUARDA: rotulos ilegiveis ou ausentes no volume $volume; recusando." }
        $value = Get-LabelValue $labels 'com.arahub.lab.instance'
        if ([string]::IsNullOrWhiteSpace($value)) { throw "GUARDA: volume $volume sem marcador de propriedade; recusando." }
        if ($value -cne $expected) { throw "GUARDA: volume $volume tem marcador divergente." }
        $projectValue = Get-LabelValue $labels 'com.docker.compose.project'
        if ($Destructive -and $projectValue -cne $project) {
            throw "GUARDA: volume $volume sem projeto compose exato; recusa destrutiva."
        }
    }

    $running = @(& docker ps --filter ("label=com.docker.compose.project=" + $project) --filter 'label=com.docker.compose.service=webserver' --format '{{.Names}}')
    if ($LASTEXITCODE -ne 0) { throw 'GUARDA: falha ao conferir webserver ativo.' }
    $dataVolume = $project + '_labdata'
    if ($running.Count -gt 0) {
        $readMarker = 'if test -e /var/www/moodledata/.arahub-lab-instance-id; then cat /var/www/moodledata/.arahub-lab-instance-id; else exit 44; fi'
        $argv = (Get-ComposeArgv) + @('exec', '-T', 'webserver', 'sh', '-c', $readMarker)
        $marker = (@(& docker @argv 2>$null) -join '').Trim()
        $markerExit = $LASTEXITCODE
        if ($markerExit -ne 0 -and $markerExit -ne 44) { throw 'GUARDA: leitura do marcador falhou; não é ausência comprovada.' }
        if ($markerExit -eq 44) {
            if (-not $AllowMarkerBootstrap) {
                throw "GUARDA: marcador do dataroot ausente; mutacao destrutiva exige instancia ja reivindicada."
            }
            Write-Lab "Marcador do dataroot ausente; inicializando (bootstrap com rotulos confirmados)."
            Write-DatarootMarker
            $marker = (@(& docker @argv 2>$null) -join '').Trim()
            if ($LASTEXITCODE -ne 0) { throw 'GUARDA: marcador não confirmado depois do bootstrap.' }
        }
        if ($marker -ne $expected) {
            throw "GUARDA: marcador do dataroot divergente: '$marker', esperado $expected."
        }
    } elseif ($volumes -contains $dataVolume) {
        # Containers parados não dispensam o marcador. Sem rede, escrita ou pull.
        & docker image inspect alpine:3.20 *> $null
        if ($LASTEXITCODE -ne 0) { throw 'GUARDA: imagem local alpine:3.20 ausente; marcador não conferido.' }
        $raw = @(& docker run --rm --pull never --network none --read-only --cap-drop ALL --security-opt no-new-privileges -v ($dataVolume + ':/data:ro') alpine:3.20 cat /data/.arahub-lab-instance-id 2>$null)
        if ($LASTEXITCODE -ne 0 -or ($raw -join '').Trim() -ne $expected) {
            throw 'GUARDA: dataroot parado sem marcador presente e igual; recusando.'
        }
    } elseif ($Destructive -and $containers.Count -gt 0) {
        throw 'GUARDA: dataroot ausente para projeto existente; recusando mutação destrutiva.'
    }
    Write-Lab "Guarda de propriedade OK ($expected; $($containers.Count) container(es), $($volumes.Count) volume(s))."
}

function New-Sentinel {
    $sentinelDir = Join-Path $script:LabRoot 'sentinel'
    New-Item -ItemType Directory -Force -Path $sentinelDir | Out-Null
    $composePath = Join-Path $sentinelDir 'compose.yml'
    $content = @(
        'services:',
        '  sentinel:',
        '    image: alpine:3.20',
        '    command: ["sh", "-c", "echo sentinel-ready; sleep infinity"]',
        '    volumes:',
        '      - sentineldata:/data',
        '    labels:',
        '      com.arahub.lab.sentinel: not-lab-owned',
        'volumes:',
        '  sentineldata:',
        '    labels:',
        '      com.arahub.lab.sentinel: not-lab-owned'
    ) -join $script:NL
    Set-Content -Encoding UTF8 $composePath $content
    $out = & docker compose --project-name arahublab-sentinel -f $composePath up -d 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Falha ao subir sentinela: $($out -join $script:NL)" }
    Write-Lab 'Sentinela criada (arahublab-sentinel).'
}

function Assert-SentinelIntact {
    $present = @(& docker ps -a --filter 'name=arahublab-sentinel' --format '{{.Names}}')
    if ($present.Count -eq 0) { throw 'GUARDA: sentinela desapareceu; reset removeu recursos de terceiros!' }
    $vol = @(& docker volume ls --filter 'name=arahublab-sentinel' --format '{{.Name}}')
    if ($vol.Count -eq 0) { throw 'GUARDA: volume da sentinela desapareceu; reset removeu recursos de terceiros!' }
    Write-Lab 'Sentinela intacta.'
}

# Somente a segunda fase de um reset cuja guarda destrutiva ja passou ANTES de
# down -v. Nao inicializa marcador nem e alternativa a Assert-LabOwnership.
function Remove-LabResetRemainders {
    param($Instance, [string[]]$BeforeContainers, [string[]]$BeforeVolumes)
    Assert-LabOrigin $Instance.wwwroot | Out-Null
    $containers = @(& docker ps -a --filter "label=com.docker.compose.project=$($Instance.project)" --format '{{.Names}}')
    if ($LASTEXITCODE -ne 0) { throw 'GUARDA: falha ao consultar containers residuais.' }
    $volumes = @(& docker volume ls --filter "label=com.docker.compose.project=$($Instance.project)" --format '{{.Name}}')
    if ($LASTEXITCODE -ne 0) { throw 'GUARDA: falha ao consultar volumes residuais.' }
    # Conferir o conjunto inteiro ANTES da primeira remocao: recurso criado depois
    # do inventario, ou rotulo divergente, impede a limpeza automatica.
    foreach ($name in $containers) {
        if ($BeforeContainers -cnotcontains $name) { throw "GUARDA: container residual fora do inventario inicial: $name" }
        $labels = Get-DockerLabelsJson @('inspect', '--format', '{{json .Config.Labels}}', $name)
        if ((Get-LabelValue $labels 'com.arahub.lab.instance') -cne $Instance.instance_id -or
            (Get-LabelValue $labels 'com.docker.compose.project') -cne $Instance.project) {
            throw "GUARDA: propriedade residual divergente no container $name"
        }
    }
    foreach ($name in $volumes) {
        if ($BeforeVolumes -cnotcontains $name) { throw "GUARDA: volume residual fora do inventario inicial: $name" }
        $labels = Get-DockerLabelsJson @('volume', 'inspect', '--format', '{{json .Labels}}', $name)
        if ((Get-LabelValue $labels 'com.arahub.lab.instance') -cne $Instance.instance_id -or
            (Get-LabelValue $labels 'com.docker.compose.project') -cne $Instance.project) {
            throw "GUARDA: propriedade residual divergente no volume $name"
        }
    }
    foreach ($name in $containers) {
        # Reconfere imediatamente antes da mutacao e remove pelo ID inspecionado.
        $raw = (& docker inspect --format '{{json .}}' $name) -join ''
        if ($LASTEXITCODE -ne 0) { throw 'GUARDA: container residual deixou de ser inspecionavel.' }
        $resource = $raw | ConvertFrom-Json
        if ($resource.Id -cnotmatch '^[a-f0-9]{64}$' -or $resource.Name -cne ('/' + $name) -or
            (Get-LabelValue $resource.Config.Labels 'com.arahub.lab.instance') -cne $Instance.instance_id -or
            (Get-LabelValue $resource.Config.Labels 'com.docker.compose.project') -cne $Instance.project) {
            throw 'GUARDA: container residual mudou durante a limpeza.'
        }
        & docker rm -f $resource.Id | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Falha ao remover container proprio residual: $name" }
    }
    foreach ($name in $volumes) {
        $labels = Get-DockerLabelsJson @('volume', 'inspect', '--format', '{{json .Labels}}', $name)
        if ((Get-LabelValue $labels 'com.arahub.lab.instance') -cne $Instance.instance_id -or
            (Get-LabelValue $labels 'com.docker.compose.project') -cne $Instance.project) {
            throw 'GUARDA: volume residual mudou durante a limpeza.'
        }
        # Sem -f: se ainda estiver em uso, preservar e reportar reset incompleto.
        & docker volume rm $name | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Falha ao remover volume proprio residual (sem force): $name" }
    }
    [ordered]@{ containers = $containers; volumes = $volumes }
}

function Write-Evidence {
    param([string]$Name, $Data)
    New-Item -ItemType Directory -Force -Path $script:EvidenceDir | Out-Null
    $path = Join-Path $script:EvidenceDir "$Name.json"
    $Data | ConvertTo-Json -Depth 12 | Set-Content -Encoding UTF8 $path
    Write-Lab "Evidencia: $path"
    $path
}
