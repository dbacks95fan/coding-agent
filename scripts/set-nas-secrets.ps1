# Copyright (c) 2026 DPSystems, LLC.
# ABOUTME: Copies this PC's .runtime.env to the NAS after checking it. Values are never shown,
# ABOUTME: logged, or passed on a command line; they travel over the SSH session's stdin.

[CmdletBinding()]
param(
    [string]$NasHost = '10.100.10.10',
    [string]$SshKeyPath = (Join-Path $env:USERPROFILE '.ssh\nas_key'),
    [string]$RemoteUser = 'DockerDeploy',
    [string]$RemoteFile = '/volume2/docker/coding-agent/.runtime.env',
    # Defaults to .runtime.env at the repository root. Resolved in the body: Windows PowerShell 5.1
    # leaves $PSScriptRoot empty while evaluating parameter defaults under -File.
    [string]$LocalFile
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'WindowsTools.ps1')

$Required = @('ANTHROPIC_API_KEY', 'CODING_AGENT_GIT_TOKEN', 'CODING_AGENT_API_TOKEN')

function Read-EnvFile {
    # NAME=value lines in file order. Comments and blank lines are dropped; .env.example is
    # where the explanations live.
    param([Parameter(Mandatory)][string]$Path)
    $values = [ordered]@{}
    foreach ($line in [System.IO.File]::ReadAllLines($Path)) {
        if ($line -match '^\s*#' -or $line -notmatch '=') { continue }
        $name, $value = $line -split '=', 2
        $values[$name.Trim().TrimStart([char]0xFEFF)] = $value.Trim()
    }
    $values
}

function Test-RuntimeSetting {
    # Problems that must stop the copy, naming the setting only, never its value.
    param([Parameter(Mandatory)][System.Collections.Specialized.OrderedDictionary]$Values)
    $problems = @()
    foreach ($name in $Required) {
        if (-not $Values.Contains($name) -or -not ([string]$Values[$name])) { $problems += "$name is not set" }
        elseif (([string]$Values[$name]) -match '^replace-with') { $problems += "$name is still the placeholder" }
    }
    $apiToken = [string]$Values['CODING_AGENT_API_TOKEN']
    if ($apiToken -and $apiToken.Length -lt 32) { $problems += 'CODING_AGENT_API_TOKEN is shorter than 32 characters' }
    foreach ($name in $Values.Keys) {
        if (([string]$Values[$name]) -match '/volume1') { $problems += "$name points at /volume1; this service lives on /volume2" }
    }
    $problems
}

function ConvertTo-EnvText {
    param([Parameter(Mandatory)][System.Collections.Specialized.OrderedDictionary]$Values)
    (($Values.Keys | ForEach-Object { "$_=$($Values[$_])" }) -join "`n") + "`n"
}

function Send-EnvText {
    # Writes the bytes over stdin, readable only by the remote user, with no byte order mark:
    # a BOM made Docker read the first name as "<BOM>NAME" on this NAS.
    param([string]$Text, [string]$Target, [string]$KeyPath, [string]$Path)
    $folder = $Path.Substring(0, $Path.LastIndexOf('/'))
    $remote = "umask 077 && mkdir -p $folder && cat > $Path && chmod 600 $Path"
    $start = New-Object System.Diagnostics.ProcessStartInfo (Get-WindowsTool ssh)
    $start.Arguments = "-i `"$KeyPath`" -o BatchMode=yes $Target `"$remote`""
    $start.UseShellExecute = $false
    $start.RedirectStandardInput = $true
    $previous = [Console]::InputEncoding
    [Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false
    try { $process = [System.Diagnostics.Process]::Start($start) }
    finally { [Console]::InputEncoding = $previous }
    $bytes = (New-Object System.Text.UTF8Encoding $false).GetBytes($Text)
    $process.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
    $process.StandardInput.Close()
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) { throw "Writing $Path on the NAS failed (ssh exit $($process.ExitCode))." }
}

# Dot-sourcing this file (as the tests do) only defines the functions above.
if ($MyInvocation.InvocationName -ne '.') {
    if (-not $LocalFile) { $LocalFile = Join-Path (Split-Path -Parent $PSScriptRoot) '.runtime.env' }
    if (-not (Test-Path -LiteralPath $LocalFile)) { throw "$LocalFile does not exist. Copy .env.example to it and fill it in." }
    $values = Read-EnvFile $LocalFile
    $problems = Test-RuntimeSetting -Values $values
    if ($problems) {
        $problems | ForEach-Object { Write-Output "  PROBLEM  $_" }
        throw 'Nothing was sent to the NAS. Fix the settings above and run this again.'
    }
    Send-EnvText -Text (ConvertTo-EnvText $values) -Target "$RemoteUser@$NasHost" -KeyPath $SshKeyPath -Path $RemoteFile
    Write-Output "Saved $($values.Count) settings to $RemoteFile (readable only by $RemoteUser)."
}
