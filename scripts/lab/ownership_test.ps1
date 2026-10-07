# Unitário da guarda destrutiva. Docker é uma função local simulada; não chama o Lab.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'aralab-lib.ps1')
$script:TestInstance = [pscustomobject]@{ instance_id = '11111111-2222-4333-8444-555555555555'; project = 'arahublabunit'; wwwroot = 'http://127.0.0.1:8480' }
function Get-LabInstance { $script:TestInstance }
function Write-Lab { param([string]$Message, [string]$Level) }
function docker {
    $global:LASTEXITCODE = 0
    $script:Calls.Add(($args -join ' '))
    $project = $script:TestInstance.project
    if ($args[0] -eq 'ps') {
        if ($args -contains '-a') { return "$project-webserver-1" }
        return
    }
    if ($args[0] -eq 'inspect') {
        if ($script:Case -eq 'container_html_output') { return '<html>unavailable</html>' }
        $value = if ($script:Case -eq 'container_missing_label') { '' } else { $script:TestInstance.instance_id }
        if ($script:Case -eq 'container_label_whitespace') { $value = ' ' + $value }
        return (@{ 'com.arahub.lab.instance' = $value; 'com.docker.compose.project' = $project } | ConvertTo-Json -Compress)
    }
    if ($args[0] -eq 'volume' -and $args[1] -eq 'ls') { return @("${project}_labdata", "${project}_html") }
    if ($args[0] -eq 'volume' -and $args[1] -eq 'inspect') {
        $value = if ($script:Case -eq 'html_missing_label' -and $args[-1] -eq "${project}_html") { '' } else { $script:TestInstance.instance_id }
        $ownerProject = if ($script:Case -eq 'volume_wrong_project') { 'other' } else { $project }
        return (@{ 'com.arahub.lab.instance' = $value; 'com.docker.compose.project' = $ownerProject } | ConvertTo-Json -Compress)
    }
    if ($args[0] -eq 'image' -and $args[1] -eq 'inspect') {
        if ($script:Case -eq 'image_missing') { $global:LASTEXITCODE = 1 }
        return
    }
    if ($args[0] -eq 'run') {
        if ($args -notcontains '--read-only' -or ($args -join ' ') -notmatch '--network none' -or
            ($args -join ' ') -notmatch '--pull never' -or $args -notcontains "${project}_labdata:/data:ro") {
            throw 'Montagem de leitura insegura'
        }
        if ($script:Case -eq 'marker_missing') { $global:LASTEXITCODE = 1; return }
        if ($script:Case -eq 'marker_wrong') { return 'other-instance' }
        return $script:TestInstance.instance_id
    }
    throw ('Docker simulado recebeu comando inesperado: ' + ($args -join ' '))
}
$results = @()
foreach ($case in @('stopped_valid', 'container_missing_label', 'container_html_output', 'container_label_whitespace', 'html_missing_label', 'volume_wrong_project', 'marker_missing', 'marker_wrong', 'image_missing')) {
    $script:Case = $case
    $script:Calls = [Collections.Generic.List[string]]::new()
    $accepted = $false
    try { Assert-LabOwnership -Destructive; $accepted = $true } catch { }
    $passed = $accepted -eq ($case -eq 'stopped_valid')
    $results += [pscustomobject]@{ case=$case; passed=$passed; accepted=$accepted; calls_real_docker=$false }
}
foreach ($field in @('instance_id','project')) {
    $old = $script:TestInstance.$field
    $script:TestInstance.$field = 'invalid value'
    $script:Calls = [Collections.Generic.List[string]]::new()
    $accepted = $false
    try { Assert-LabOwnership -Destructive; $accepted = $true } catch { }
    $results += [pscustomobject]@{case="invalid_$field";passed=(-not $accepted -and $script:Calls.Count -eq 0);accepted=$accepted;calls_real_docker=$false}
    $script:TestInstance.$field = $old
}
foreach ($case in @('manifest_valid', 'manifest_wrong_instance', 'manifest_external_endpoint')) {
    $manifest = [pscustomobject]@{ schema = 'arahub.moodle-lab.manifest/1'; instance_id = $script:TestInstance.instance_id;
        project = $script:TestInstance.project; origin = $script:TestInstance.wwwroot;
        rest_endpoint = 'http://127.0.0.1:8480/webservice/rest/server.php'; upload_endpoint = 'http://127.0.0.1:8480/webservice/upload.php' }
    if ($case -eq 'manifest_wrong_instance') { $manifest.instance_id = 'other-instance' }
    if ($case -eq 'manifest_external_endpoint') { $manifest.rest_endpoint = 'https://example.org/webservice/rest/server.php' }
    $accepted = $false
    try { Assert-LabManifest $manifest; $accepted = $true } catch { }
    $results += [pscustomobject]@{ case=$case; passed=($accepted -eq ($case -eq 'manifest_valid')); accepted=$accepted; calls_real_docker=$false }
}
$results | ConvertTo-Json -Compress
if (@($results | Where-Object { -not $_.passed }).Count) { exit 1 }
