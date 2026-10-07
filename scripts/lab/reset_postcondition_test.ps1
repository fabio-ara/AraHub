# Teste unitario: importa apenas Reset-Lab e simula todo acesso Docker.
# Nao carrega o controlador, nao consulta o daemon, nao remove recursos.
#requires -Version 7.0
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile(
    (Join-Path $PSScriptRoot 'aralab.ps1'), [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'Erro de sintaxe no controlador.' }
$reset = $ast.Find({ param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Reset-Lab'
}, $false)
if (-not $reset) { throw 'Reset-Lab ausente.' }
. ([scriptblock]::Create($reset.Extent.Text))
$lib = [Management.Automation.Language.Parser]::ParseFile(
    (Join-Path $PSScriptRoot 'aralab-lib.ps1'), [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'Erro de sintaxe na biblioteca.' }
foreach ($name in @('Assert-LabOrigin','Get-LabelValue','Get-DockerLabelsJson','Remove-LabResetRemainders')) {
    $fn = $lib.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name}, $false)
    . ([scriptblock]::Create($fn.Extent.Text))
}
$script:LabRoot = $PSScriptRoot
function Get-LabInstance {
    [pscustomobject]@{ instance_id='11111111-2222-4333-8444-555555555555'; project='arahublabunit';wwwroot='http://127.0.0.1:8480' }
}
function Assert-LabOwnership {
    param([switch]$Destructive)
    if (-not $Destructive) { throw 'Reset sem guarda destrutiva.' }
    $script:Guarded = $true
}
function Invoke-LabCompose {
    if (-not $script:Guarded) { throw 'Compose anterior a guarda.' }
    if (($args[0] -join ' ') -ne 'down -v --remove-orphans') { throw 'Compose inesperado.' }
    $script:Down = $true
}
function Test-Path { return $false }
function Write-Lab { param([string]$Message); $script:Messages.Add($Message) }
function Write-Evidence { param($Name, $Payload); $script:Evidence = $Payload }
function docker {
    $global:LASTEXITCODE = 0
    if ($args[0] -eq 'inspect' -or ($args[0] -eq 'volume' -and $args[1] -eq 'inspect')) {
        $id = if ($script:Case -eq 'container_label_changed' -or $script:Case -eq 'volume_label_changed') { 'wrong-owner' } else { (Get-LabInstance).instance_id }
        $labels = @{'com.arahub.lab.instance'=$id;'com.docker.compose.project'='arahublabunit'}
        if ($args -contains '{{json .}}') {
            return (@{Id=('a'*64);Name='/arahublabunit-webserver-1';Config=@{Labels=$labels}} | ConvertTo-Json -Depth 4 -Compress)
        }
        return ($labels | ConvertTo-Json -Compress)
    }
    if ($args[0] -eq 'rm') {
        if ($args[-1] -cne ('a'*64)) { throw 'Remocao fora do ID proprio inspecionado.' }
        $script:ContainerRemoved = $true
        return
    }
    if ($args[0] -eq 'volume' -and $args[1] -eq 'rm') {
        if ($args -contains '-f' -or $args[-1] -cne 'arahublabunit_labdata') { throw 'Remocao de volume insegura.' }
        if ($script:Case -eq 'volume_in_use') { $global:LASTEXITCODE=1; return }
        $script:VolumeRemoved = $true
        return
    }
    $isVolume = $args[0] -eq 'volume' -and $args[1] -eq 'ls'
    if ($args[0] -ne 'ps' -and -not $isVolume) { throw 'Comando Docker inesperado.' }
    if ($args -contains 'name=arahublab-sentinel') { return }
    if ($args -contains 'label=com.docker.compose.project=arahublabunit') {
        if (($script:Case -eq 'query_before_fails' -and -not $script:Down) -or
            ($script:Case -eq 'query_after_fails' -and $script:Down) -or
            ($script:Case -eq 'volume_query_after_fails' -and $script:Down -and $isVolume)) {
            $global:LASTEXITCODE = 1
            return
        }
        if ($isVolume) {
            if ($script:Down -and $script:Case -eq 'new_volume') { return 'arahublabunit_new' }
            if (-not $script:Down -or ($script:Case -in @('volume_remains', 'both_remain','volume_label_changed','volume_in_use') -and -not $script:VolumeRemoved)) { return 'arahublabunit_labdata' }
        } elseif ($script:Down -and $script:Case -eq 'new_container') {
            return 'arahublabunit-new'
        } elseif (-not $script:Down -or ($script:Case -in @('container_remains', 'both_remain','container_label_changed') -and -not $script:ContainerRemoved)) {
            return 'arahublabunit-webserver-1'
        }
        return
    }
    if ($args -contains '--filter') { throw 'Filtro Docker inesperado.' }
    if ($isVolume) {
        if (-not $script:Down) { 'arahublabunit_labdata' }
        if (-not ($script:Case -eq 'foreign_volume_missing' -and $script:Down)) { 'foreign-volume' }
        return
    }
    if (-not $script:Down) { 'arahublabunit-webserver-1' }
    if (-not ($script:Case -eq 'foreign_missing' -and $script:Down)) { 'foreign-preserved' }
}
$results = foreach ($case in @('empty', 'container_remains', 'volume_remains', 'both_remain',
        'query_before_fails', 'query_after_fails', 'volume_query_after_fails', 'foreign_missing',
        'foreign_volume_missing','new_container','new_volume','container_label_changed','volume_label_changed','volume_in_use')) {
    $script:Case = $case
    $script:Down = $false
    $script:ContainerRemoved = $false
    $script:VolumeRemoved = $false
    $script:Guarded = $false
    $script:Evidence = $null
    $script:Messages = [Collections.Generic.List[string]]::new()
    $accepted = $false
    $failure = $null
    try { Reset-Lab; $accepted = $true } catch { $failure = $_.Exception.Message }
    $passed = $accepted -eq ($case -in @('empty','container_remains','volume_remains','both_remain'))
    $passed = $passed -and ($script:Down -eq ($case -ne 'query_before_fails'))
    if ($case -like '*fails') {
        $passed = $passed -and $failure -like '*falhou a leitura*' -and $null -eq $script:Evidence
    } else {
        $passed = $passed -and $null -ne $script:Evidence -and $script:Evidence.passed -eq $accepted
        $expectedContainerRemoved = $case -ne 'container_label_changed'
        $expectedVolumeRemoved = $case -notin @('volume_label_changed','volume_in_use')
        $passed = $passed -and ($script:Evidence.removed.lab_containers.Count -eq [int]$expectedContainerRemoved)
        $passed = $passed -and ($script:Evidence.removed.lab_volumes.Count -eq [int]$expectedVolumeRemoved)
    }
    if ($case -in @('new_container','new_volume','container_label_changed','volume_label_changed')) {
        $passed = $passed -and -not $script:ContainerRemoved -and -not $script:VolumeRemoved
    }
    if (-not $accepted) { $passed = $passed -and $script:Messages.Count -eq 0 }
    [pscustomobject]@{ case=$case; passed=$passed; reset_accepted=$accepted; calls_real_docker=$false }
}
$results | ConvertTo-Json -Compress
if (@($results | Where-Object { -not $_.passed }).Count) { exit 1 }
