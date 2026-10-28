# Copyright (c) 2026 DPSystems, LLC.
# ABOUTME: Full paths to the Windows builds of scp, ssh and tar for the NAS scripts, so they behave
# ABOUTME: the same whether PowerShell or Git Bash started them.

function Get-WindowsTool {
    # A bare `scp` or `tar` resolves through PATH, and under Git Bash that finds Git's Unix builds,
    # which read "C:\..." as a remote host called C. Naming the Windows binary removes that dependency.
    param([Parameter(Mandatory)][ValidateSet('scp', 'ssh', 'tar')][string]$Name)
    $relative = @{ scp = 'System32\OpenSSH\scp.exe'; ssh = 'System32\OpenSSH\ssh.exe'; tar = 'System32\tar.exe' }[$Name]
    $path = Join-Path $env:SystemRoot $relative
    if (-not (Test-Path -LiteralPath $path)) { throw "$Name not found at $path (install the Windows OpenSSH client)." }
    $path
}
