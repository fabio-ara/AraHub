# Unitario: Docker/Git simulados; escrita apenas em diretorio temporario.
#requires -Version 7.0
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'aralab-lib.ps1')
$script:TestRoot = Join-Path $script:LabRoot ('unit-controller-' + [guid]::NewGuid().ToString('N'))
$script:InstancesDir = Join-Path $script:TestRoot 'instances'
$script:TestInstance = [pscustomobject]@{instance_id='11111111-2222-4333-8444-555555555555';project='arahublabunit';wwwroot='http://localhost:8480'}
function Get-LabInstance { $script:TestInstance }
function Write-Lab { param($Message, $Level) }
function git {
    $global:LASTEXITCODE = 0
    if ($args -contains 'rev-parse') { return (Get-VersionSpec).commit }
    if ($args -contains 'archive') {
        $target = @($args | Where-Object { $_ -like '--output=*' })[0].Substring(9)
        Set-Content -LiteralPath $target -Value 'synthetic-unit-archive'
        return
    }
    throw 'Git simulado: comando inesperado.'
}
function docker {
    $global:LASTEXITCODE = 0
    $script:Calls.Add(($args -join ' '))
    if ($args[0] -eq 'volume' -and $args[1] -eq 'ls') {
        if ($script:Case -eq 'inventory_error') { $global:LASTEXITCODE = 1; return }
        return 'arahublabunit_html'
    }
    if ($args[0] -eq 'inspect' -or ($args[0] -eq 'volume' -and $args[1] -eq 'inspect')) {
        $project = if (($script:Case -eq 'volume_project_error' -and $args[0] -eq 'volume') -or
            ($script:Case -eq 'helper_project_error' -and $args[0] -eq 'inspect')) { 'foreign' } else { $script:TestInstance.project }
        return (@{'com.arahub.lab.instance'=$script:TestInstance.instance_id;'com.docker.compose.project'=$project} | ConvertTo-Json -Compress)
    }
    if ($args[0] -eq 'run') {
        if ($args -notcontains '--pull=never' -or $args -notcontains '--network=none') { throw 'Sonda com rede/pull.' }
        if ($args -contains 'test') {
            $global:LASTEXITCODE = if ($script:Case -eq 'probe_error') { 125 } elseif ($script:Case -like 'existing_*') { 0 } else { 1 }
            return
        }
        if ($args -contains '--entrypoint') {
            if ($script:Case -eq 'existing_wrong_pin') { return 'wrong-pin' }
            return (Get-VersionSpec).commit
        }
        if ($args -contains '-d') { return 'synthetic-helper-id' }
    }
    if ($args[0] -eq 'exec') {
        if ($args -contains 'find') {
            if ($script:Case -eq 'unexpected_data') { return '/source/foreign-file' }
            return
        }
        if ($args -contains 'tar' -or $args -contains 'sh') { $script:Writes++; return }
    }
    if ($args[0] -eq 'cp') { $script:Writes++; return }
    if ($args[0] -eq 'rm') { $script:Removed++; return }
    throw ('Docker simulado: comando inesperado ' + ($args -join ' '))
}
$results = [Collections.Generic.List[object]]::new()
$oldHost = $env:DOCKER_HOST
try {
    $env:DOCKER_HOST = 'npipe:////./pipe/docker_engine'
    $defaultPath = ConvertTo-LabBindPath 'C:\fixture path\lab'
    $env:DOCKER_HOST = 'npipe:////./pipe/docker_engine_linux'
    $directPath = ConvertTo-LabBindPath 'C:\fixture path\lab'
    $unchangedCurl = ConvertTo-ComposePath 'C:\fixture path\lab'
    $results.Add(@{case='bind_translation_only_linux_pipe';passed=($defaultPath -eq 'C:/fixture path/lab' -and $directPath -eq '/run/desktop/mnt/host/c/fixture path/lab' -and $unchangedCurl -eq $defaultPath -and (ConvertTo-LabBindPath '/already/linux') -eq '/already/linux');calls_real_docker=$false})
    foreach ($version in @('4.5.6','4.5.15')) {
        $MoodleVersion = $version
        $spec = Get-VersionSpec
        New-Item -ItemType Directory -Force -Path (Get-InstanceRoot) | Out-Null
        New-LabEnvFile
        $lines = Get-Content (Join-Path (Get-InstanceRoot) 'lab.env')
        $results.Add(@{case="env_$version";passed=($lines -contains "MOODLE_DOCKER_WEB_PORT=127.0.0.1:$($spec.port)" -and $lines -contains "ARAHUB_LAB_MAIL_PORT=127.0.0.1:$($spec.mailport)" -and @($lines | Where-Object {$_ -like 'ARAHUB_LAB_TOOLS=/run/desktop/mnt/host/*'}).Count -eq 1);calls_real_docker=$false})
    }
    foreach ($case in @('inventory_error','volume_project_error','probe_error','existing_valid','existing_wrong_pin','fresh_archive','unexpected_data','helper_project_error')) {
        $script:Case = $case
        $script:Calls = [Collections.Generic.List[string]]::new()
        $script:Writes = 0
        $script:Removed = 0
        $accepted = $false
        try { Initialize-LabCode; $accepted = $true } catch { }
        $expected = $case -in @('existing_valid','fresh_archive')
        $passed = $accepted -eq $expected
        $passed = $passed -and $script:Writes -eq $(if ($case -eq 'fresh_archive') {3} else {0})
        $passed = $passed -and $script:Removed -eq $(if ($case -in @('fresh_archive','unexpected_data')) {1} else {0})
        $results.Add(@{case=$case;passed=$passed;accepted=$accepted;volume_write_commands=$script:Writes;calls_real_docker=$false})
    }
} finally {
    $env:DOCKER_HOST = $oldHost
    # O unico alvo removido e o temporario deste teste, dentro do Lab privado.
    $resolved = [IO.Path]::GetFullPath($script:TestRoot)
    if (-not $resolved.StartsWith([IO.Path]::GetFullPath($script:LabRoot) + [IO.Path]::DirectorySeparatorChar)) { throw 'Temporario fora do Lab.' }
    if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse }
}
$results | ConvertTo-Json -Compress
if (@($results | Where-Object { -not $_.passed }).Count) { exit 1 }
