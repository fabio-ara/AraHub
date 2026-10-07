#requires -Version 7.0
# MIT. Envio de mensagem somente ao capturador SMTP da instalação sintética.
[CmdletBinding()]
param([ValidateSet('4.5.6', '4.5.15')][string]$MoodleVersion = '4.5.6')
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'aralab-lib.ps1') -MoodleVersion $MoodleVersion
Assert-LabOwnership
$inst = Get-LabInstance
$mailName = "$($inst.project)-mailpit-1"
$mail = (& docker inspect $mailName | ConvertFrom-Json)[0]
if ($mail.Config.Labels.'com.arahub.lab.instance' -ne $inst.instance_id) {
    throw 'Mailpit fora da instalação-alvo.'
}
$relaySettings = @($mail.Config.Env | Where-Object { $_ -match '^MP_(SMTP_RELAY|SMTP_FORWARD|FORWARD)' })
if ($relaySettings.Count -or (($mail.Config.Cmd -join ' ') -match 'relay|forward')) {
    throw 'Mailpit possui configuração de encaminhamento; envio recusado.'
}
$subject = 'AraHub-LAB03-' + [guid]::NewGuid().ToString()
$result = Invoke-MoodleCli @('/opt/arahub-lab/tools/mail_prove.php', $inst.instance_id, $subject)
$receipt = $result | ConvertFrom-Json
if (-not $receipt.sent) { throw 'Moodle não confirmou o envio ao capturador.' }
$origin = (Assert-LabOrigin $inst.wwwroot).AbsoluteUri.TrimEnd('/')
$messages = Invoke-RestMethod "$origin/_/mail/api/v1/messages?limit=100"
$captured = @($messages.messages | Where-Object { $_.Subject -eq $subject })
if ($captured.Count -ne 1) { throw 'Mensagem não encontrada exatamente uma vez no capturador.' }
$proof = [ordered]@{
    schema = 'arahub.lab.mail/1'; at = [DateTime]::UtcNow.ToString('o')
    scenario = 'LAB-03'; instance_id = $inst.instance_id; origin = $origin
    smtp_host = $receipt.smtp_host; relay_configured = $false
    synthetic_recipient = $true; captured_count = $captured.Count
    message_id = $captured[0].ID; subject = $subject
    passed = $true; real_recipient_contacted = $false
}
Write-Evidence ('mail-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ')) $proof | Out-Null
Write-Lab 'LAB-03: mensagem sintética capturada; nenhum relay configurado.'
