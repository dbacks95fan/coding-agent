# Copyright (c) 2026 DPSystems, LLC.
# ABOUTME: Builds the Coding Agent image from a committed revision on this PC, ships it to the
# ABOUTME: Synology NAS over SSH, and runs scripts/install-on-nas.sh there, which verifies the service.

[CmdletBinding()]
param(
    [string]$NasHost = '10.100.10.10',
    [string]$SshKeyPath = (Join-Path $env:USERPROFILE '.ssh\nas_key'),
    [string]$Ref = 'HEAD',
    [string]$RemoteUser = 'DockerDeploy',
    # Build the package into this folder and stop, without contacting the NAS.
    [string]$PackageOnly
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'WindowsTools.ps1')

function Get-ImageTag {
    # One tag per commit, so the NAS can always tell which revision it is running.
    param([Parameter(Mandatory)][string]$Commit)
    "coding-agent:$($Commit.Substring(0, 12))"
}

# The package is staged on /volume2, never /tmp: on this NAS /tmp is a RAM-backed tmpfs
# smaller than the image, so staging there would starve every running service of memory.
$IncomingDir = '/volume2/docker/coding-agent-data/incoming'

function Get-RemoteInstallCommand {
    # One line for ssh with no double quotes: Windows PowerShell strips them from native
    # arguments, and none of these paths contain spaces.
    param([Parameter(Mandatory)][string]$PackageName)
    $bundle = "$IncomingDir/$PackageName.tar.gz"
    $staging = "$IncomingDir/$PackageName"
    "set -eu; rm -rf $staging; mkdir -p $staging; tar xzf $bundle -C $staging; rm -f $bundle; " +
    "sh $staging/$PackageName/install-on-nas.sh $staging/$PackageName; rm -rf $staging"
}

function Write-PackageManifest {
    # SHA256SUMS lets the NAS refuse a package damaged in transit before it loads anything.
    param([Parameter(Mandatory)][string]$Directory, [Parameter(Mandatory)][string]$Image, [Parameter(Mandatory)][string]$Commit)
    $utf8 = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText((Join-Path $Directory 'manifest.txt'), "image=$Image`ncommit=$Commit`n", $utf8)
    $lines = Get-ChildItem -LiteralPath $Directory -File | Where-Object { $_.Name -ne 'SHA256SUMS' } | Sort-Object Name | ForEach-Object {
        "$((Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant())  $($_.Name)"
    }
    [System.IO.File]::WriteAllText((Join-Path $Directory 'SHA256SUMS'), (($lines -join "`n") + "`n"), $utf8)
}

function Invoke-Native {
    # Native tools report through exit codes, not exceptions. Their stderr is not redirected:
    # under 'Stop', Windows PowerShell turns redirected native stderr into a terminating error.
    param([Parameter(Mandatory)][string]$Description, [Parameter(Mandatory)][scriptblock]$Command)
    & $Command
    if ($LASTEXITCODE -ne 0) { throw "$Description failed (exit $LASTEXITCODE)." }
}

# Dot-sourcing this file (as the tests do) only defines the functions above.
if ($MyInvocation.InvocationName -ne '.') {
    $repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
    $commit = (git -C $repo rev-parse $Ref).Trim()
    if ($LASTEXITCODE -ne 0) { throw "Unknown revision $Ref." }
    $image = Get-ImageTag -Commit $commit
    $packageName = "coding-agent-$($commit.Substring(0, 12))"
    $work = Join-Path ([System.IO.Path]::GetTempPath()) ("coding-agent-deploy-" + [guid]::NewGuid().ToString())
    $source = Join-Path $work 'source'
    $package = Join-Path $work $packageName
    New-Item -ItemType Directory -Path $source, $package | Out-Null
    $target = "$RemoteUser@$NasHost"
    try {
        # git archive ships only committed files, so an uncommitted secret can never be deployed.
        $archive = Join-Path $work 'source.tar'
        Invoke-Native 'git archive' { git -C $repo archive --format=tar --output=$archive $commit }
        $tar = Get-WindowsTool tar
        Invoke-Native 'Unpacking the source' { & $tar -xf $archive -C $source }
        Invoke-Native 'docker build' { docker build --quiet --tag $image $source }
        Invoke-Native 'docker save' { docker save --output (Join-Path $package 'image.tar') $image }
        Copy-Item -LiteralPath (Join-Path $source 'compose.yaml'), (Join-Path $source 'scripts\install-on-nas.sh') -Destination $package
        Copy-Item -LiteralPath (Join-Path $source 'config\manifest.json') -Destination (Join-Path $package 'manifest.json')
        Write-PackageManifest -Directory $package -Image $image -Commit $commit
        $bundle = Join-Path $work "$packageName.tar.gz"
        Invoke-Native 'Packing the deployment' { & $tar -czf $bundle -C $work $packageName }

        if ($PackageOnly) {
            Copy-Item -LiteralPath $bundle -Destination $PackageOnly
            Write-Output "Packaged $image (commit $commit) to $(Join-Path $PackageOnly (Split-Path -Leaf $bundle))."
            return
        }
        $scp = Get-WindowsTool scp
        $ssh = Get-WindowsTool ssh
        # -O: the classic SCP protocol. OpenSSH 9+ defaults to SFTP, which this NAS has off.
        Invoke-Native 'Preparing the NAS upload folder' { & $ssh -i $SshKeyPath $target "mkdir -p $IncomingDir" }
        Invoke-Native 'Copying the package to the NAS' { & $scp -O -i $SshKeyPath $bundle "${target}:$IncomingDir/" }
        Invoke-Native 'Install on the NAS' { & $ssh -i $SshKeyPath $target (Get-RemoteInstallCommand -PackageName $packageName) }
        Write-Output "Deployed $image (commit $commit) to $NasHost."
    }
    finally {
        Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
    }
}
