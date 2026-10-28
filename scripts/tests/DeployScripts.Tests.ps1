# Copyright (c) 2026 DPSystems, LLC.
# ABOUTME: Pester tests for the NAS deployment scripts: package layout, remote command, secrets checks,
# ABOUTME: and agreement between the compose file, the installer, and the /volume2 rule.

BeforeAll {
    $scripts = Split-Path -Parent $PSScriptRoot
    $script:repo = Split-Path -Parent $scripts
    . (Join-Path $scripts 'deploy-synology.ps1')
    . (Join-Path $scripts 'set-nas-secrets.ps1')
}

Describe 'deploy-synology' {
    It 'tags the image with the first 12 characters of the commit' {
        Get-ImageTag -Commit ('a' * 40) | Should -Be ('coding-agent:' + ('a' * 12))
    }

    It 'stages the package on /volume2 and never in the RAM-backed /tmp' {
        $command = Get-RemoteInstallCommand -PackageName 'coding-agent-abc'
        $command | Should -Match '/volume2/docker/coding-agent-data/incoming/coding-agent-abc.tar.gz'
        $command | Should -Not -Match '/tmp'
    }

    It 'builds a remote command Windows PowerShell can pass to ssh unchanged' {
        $command = Get-RemoteInstallCommand -PackageName 'coding-agent-abc'
        $command | Should -Not -Match '"'
        $command | Should -Match '^set -eu;'
        $command | Should -Match 'sh \S+/install-on-nas.sh'
    }

    It 'writes a manifest and LF checksums without a byte order mark' {
        $dir = Join-Path ([System.IO.Path]::GetTempPath()) ([guid]::NewGuid())
        New-Item -ItemType Directory -Path $dir | Out-Null
        try {
            [System.IO.File]::WriteAllText((Join-Path $dir 'image.tar'), 'image bytes')
            Write-PackageManifest -Directory $dir -Image 'coding-agent:abc' -Commit ('b' * 40)
            $sums = [System.IO.File]::ReadAllBytes((Join-Path $dir 'SHA256SUMS'))
            $sums[0] | Should -Not -Be 0xEF
            $text = [System.Text.Encoding]::UTF8.GetString($sums)
            $text | Should -Not -Match "`r"
            $expected = (Get-FileHash -LiteralPath (Join-Path $dir 'image.tar') -Algorithm SHA256).Hash.ToLowerInvariant()
            $text | Should -Match "$expected  image.tar"
            $text | Should -Match '  manifest.txt'
            Get-Content -LiteralPath (Join-Path $dir 'manifest.txt') -Raw | Should -Match 'image=coding-agent:abc'
        }
        finally {
            Remove-Item -LiteralPath $dir -Recurse -Force
        }
    }
}

Describe 'set-nas-secrets' {
    BeforeEach {
        $script:good = [ordered]@{
            ANTHROPIC_API_KEY      = 'sk-ant-real-looking-value'
            CODING_AGENT_GIT_TOKEN = 'github_pat_real_looking_value'
            CODING_AGENT_API_TOKEN = 'x' * 40
        }
    }

    It 'accepts a complete settings file' {
        Test-RuntimeSetting -Values $good | Should -BeNullOrEmpty
    }

    It 'names every missing setting without showing any value' {
        $values = [ordered]@{ CODING_AGENT_API_TOKEN = 'tiny-secret-value' }
        $problems = Test-RuntimeSetting -Values $values
        $problems | Should -Contain 'ANTHROPIC_API_KEY is not set'
        $problems | Should -Contain 'CODING_AGENT_GIT_TOKEN is not set'
        $problems | Should -Contain 'CODING_AGENT_API_TOKEN is shorter than 32 characters'
        ($problems -join ' ') | Should -Not -Match 'tiny-secret-value'
    }

    It 'refuses the .env.example placeholders' {
        $good['ANTHROPIC_API_KEY'] = 'replace-with-an-anthropic-api-key'
        Test-RuntimeSetting -Values $good | Should -Contain 'ANTHROPIC_API_KEY is still the placeholder'
    }

    It 'refuses a /volume1 path' {
        $good['CODING_AGENT_WORK_ROOT'] = '/volume1/docker/x'
        Test-RuntimeSetting -Values $good | Should -Contain 'CODING_AGENT_WORK_ROOT points at /volume1; this service lives on /volume2'
    }

    It 'reads NAME=value lines, skipping comments and a byte order mark' {
        $file = Join-Path ([System.IO.Path]::GetTempPath()) ([guid]::NewGuid())
        try {
            [System.IO.File]::WriteAllText($file, "$([char]0xFEFF)# comment`nA=1`nB=x=y`n`n", (New-Object System.Text.UTF8Encoding $false))
            $values = Read-EnvFile $file
            @($values.Keys) | Should -Be @('A', 'B')
            $values['B'] | Should -Be 'x=y'
            ConvertTo-EnvText $values | Should -Be "A=1`nB=x=y`n"
        }
        finally {
            Remove-Item -LiteralPath $file -Force
        }
    }
}

Describe 'deployment files agree' {
    It 'listens on the same port in compose, its health check, and the installer' {
        $compose = Get-Content -LiteralPath (Join-Path $repo 'compose.yaml') -Raw
        $install = Get-Content -LiteralPath (Join-Path $repo 'scripts\install-on-nas.sh') -Raw
        $compose | Should -Match 'PORT: "8081"'
        $compose | Should -Match '127\.0\.0\.1:8081/health'
        $compose | Should -Match 'network_mode: host'
        $install | Should -Match 'CODING_AGENT_PORT:-8081'
    }

    It 'requires the same secrets in the installer and the secrets script' {
        $install = Get-Content -LiteralPath (Join-Path $repo 'scripts\install-on-nas.sh') -Raw
        foreach ($name in $Required) { $install | Should -Match $name }
    }

    It 'never deploys to /volume1' {
        # set-nas-secrets.ps1 is left out: it names /volume1 only to refuse it.
        foreach ($file in 'compose.yaml', 'scripts\install-on-nas.sh', 'scripts\deploy-synology.ps1') {
            Get-Content -LiteralPath (Join-Path $repo $file) -Raw | Should -Not -Match '/volume1' -Because $file
        }
    }

    It 'checks secrets before loading the image' {
        $install = Get-Content -LiteralPath (Join-Path $repo 'scripts\install-on-nas.sh') -Raw
        $install.IndexOf('CODING_AGENT_API_TOKEN; do') | Should -BeLessThan $install.IndexOf('docker" load')
    }
}
