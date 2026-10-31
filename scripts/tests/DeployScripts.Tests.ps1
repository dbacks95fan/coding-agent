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
    BeforeAll {
        function Invoke-SecretsScript {
            # Runs the script as an operator does (-File). Output goes through files because, in
            # Windows PowerShell 5.1, redirecting a child's stderr inside Pester raises instead.
            param([string[]]$Arguments)
            $script = Join-Path (Split-Path -Parent $PSScriptRoot) 'set-nas-secrets.ps1'
            $out = [System.IO.Path]::GetTempFileName()
            $err = [System.IO.Path]::GetTempFileName()
            try {
                $argumentList = @('-NoProfile', '-File', "`"$script`"") + $Arguments
                $process = Start-Process -FilePath 'powershell' -ArgumentList $argumentList -NoNewWindow -Wait -PassThru `
                    -RedirectStandardOutput $out -RedirectStandardError $err
                [pscustomobject]@{ ExitCode = $process.ExitCode; Output = (Get-Content -LiteralPath $out, $err -Raw) -join "`n" }
            }
            finally {
                Remove-Item -LiteralPath $out, $err -Force
            }
        }
    }
    BeforeEach {
        $script:good = [ordered]@{
            ANTHROPIC_API_KEY                       = 'sk-ant-real-looking-value'
            CODING_AGENT_GITHUB_APP_ID              = '5555873'
            CODING_AGENT_GITHUB_APP_INSTALLATION_ID = '177232772'
            CODING_AGENT_INTENT_TOKEN               = 'github_pat_read_only_looking_value'
            CODING_AGENT_API_TOKEN                  = 'x' * 40
        }
    }

    It 'accepts a complete settings file' {
        Test-RuntimeSetting -Values $good | Should -BeNullOrEmpty
    }

    It 'names every missing setting without showing any value' {
        $values = [ordered]@{ CODING_AGENT_API_TOKEN = 'tiny-secret-value' }
        $problems = Test-RuntimeSetting -Values $values
        $problems | Should -Contain 'ANTHROPIC_API_KEY is not set'
        $problems | Should -Contain 'CODING_AGENT_GITHUB_APP_ID is not set'
        $problems | Should -Contain 'CODING_AGENT_GITHUB_APP_INSTALLATION_ID is not set'
        $problems | Should -Contain 'CODING_AGENT_INTENT_TOKEN is not set'
        $problems | Should -Contain 'CODING_AGENT_API_TOKEN is shorter than 32 characters'
        ($problems -join ' ') | Should -Not -Match 'tiny-secret-value'
    }

    It 'refuses non-numeric GitHub App IDs' {
        $good['CODING_AGENT_GITHUB_APP_ID'] = 'Iv23lighUM0vlezmbCTG'
        Test-RuntimeSetting -Values $good | Should -Contain 'CODING_AGENT_GITHUB_APP_ID must be a number'
    }

    It 'refuses the retired single GitHub token' {
        $good['CODING_AGENT_GIT_TOKEN'] = 'github_pat_old_value'
        $problems = Test-RuntimeSetting -Values $good
        $problems | Should -Contain 'CODING_AGENT_GIT_TOKEN is no longer used; remove it'
        ($problems -join ' ') | Should -Not -Match 'github_pat_old_value'
    }

    It 'checks the GitHub App key file by path without showing its contents' {
        $file = Join-Path ([System.IO.Path]::GetTempPath()) ([guid]::NewGuid())
        try {
            Test-GitHubAppKey -Values $good | Should -Match 'CODING_AGENT_GITHUB_APP_PRIVATE_KEY_FILE is not set'

            $good['CODING_AGENT_GITHUB_APP_PRIVATE_KEY_FILE'] = $file
            Test-GitHubAppKey -Values $good | Should -Match 'does not exist'

            [System.IO.File]::WriteAllText($file, 'secret-but-not-a-key')
            $problem = Test-GitHubAppKey -Values $good
            $problem | Should -Match 'is not a PEM private key'
            $problem | Should -Not -Match 'secret-but-not-a-key'

            [System.IO.File]::WriteAllText($file, "-----BEGIN RSA PRIVATE KEY-----`nabc`n-----END RSA PRIVATE KEY-----`n")
            Test-GitHubAppKey -Values $good | Should -BeNullOrEmpty
        }
        finally {
            Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
        }
    }

    It 'refuses the .env.example placeholders' {
        $good['ANTHROPIC_API_KEY'] = 'replace-with-an-anthropic-api-key'
        Test-RuntimeSetting -Values $good | Should -Contain 'ANTHROPIC_API_KEY is still the placeholder'
    }

    It 'refuses a /volume1 path' {
        $good['CODING_AGENT_WORK_ROOT'] = '/volume1/docker/x'
        Test-RuntimeSetting -Values $good | Should -Contain 'CODING_AGENT_WORK_ROOT points at /volume1; this service lives on /volume2'
    }

    It 'refuses an incomplete file when run as a script, without contacting the NAS' {
        # Runs the script the way an operator does (-File), which dot-sourcing cannot exercise.
        $file = Join-Path ([System.IO.Path]::GetTempPath()) ([guid]::NewGuid())
        try {
            [System.IO.File]::WriteAllText($file, "ANTHROPIC_API_KEY=replace-with-an-anthropic-api-key`n")
            $result = Invoke-SecretsScript -Arguments @('-LocalFile', "`"$file`"", '-NasHost', 'invalid.example')
            $result.ExitCode | Should -Not -Be 0
            $result.Output | Should -Match 'PROBLEM  ANTHROPIC_API_KEY is still the placeholder'
            $result.Output | Should -Match 'Nothing was sent to the NAS'
        }
        finally {
            Remove-Item -LiteralPath $file -Force
        }
    }

    It 'finds .runtime.env at the repository root by default' {
        $result = Invoke-SecretsScript -Arguments @('-NasHost', 'invalid.example')
        $result.Output | Should -Not -Match 'Cannot bind argument'
        $result.Output | Should -Match '(\.runtime\.env does not exist|PROBLEM|Saved)'
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

    It 'checks secrets and the GitHub App key before loading the image' {
        $install = Get-Content -LiteralPath (Join-Path $repo 'scripts\install-on-nas.sh') -Raw
        $load = $install.IndexOf('docker" load')
        $install.IndexOf('CODING_AGENT_API_TOKEN; do') | Should -BeLessThan $load
        $install.IndexOf('[ -s "$app_key" ]') | Should -BeGreaterThan 0
        $install.IndexOf('[ -s "$app_key" ]') | Should -BeLessThan $load
    }

    It 'gives the container a read-only key at the path the service reads, from where the installer puts it' {
        $compose = Get-Content -LiteralPath (Join-Path $repo 'compose.yaml') -Raw
        $install = Get-Content -LiteralPath (Join-Path $repo 'scripts\install-on-nas.sh') -Raw
        $compose | Should -Match 'CODING_AGENT_GITHUB_APP_PRIVATE_KEY_FILE: /config/github-app.pem'
        $compose | Should -Match '/secrets/github-app.pem:/config/github-app.pem:ro'
        $install | Should -Match '-v "\$data_dir/secrets:/out"'
        $install | Should -Match 'chown 10001:999 /out/github-app.pem && chmod 400'
    }

    It 'uploads the key to the path the installer reads' {
        $install = Get-Content -LiteralPath (Join-Path $repo 'scripts\install-on-nas.sh') -Raw
        $install | Should -Match 'app_key="\$app_dir/github-app.pem"'
        (Get-Command (Join-Path $repo 'scripts\set-nas-secrets.ps1')).Parameters['RemoteKeyFile'] | Should -Not -BeNullOrEmpty
        $secretsScript = Get-Content -LiteralPath (Join-Path $repo 'scripts\set-nas-secrets.ps1') -Raw
        $secretsScript | Should -Match "RemoteKeyFile = '/volume2/docker/coding-agent/github-app.pem'"
        $install | Should -Match 'app_dir=\$\{CODING_AGENT_APP_DIR:-/volume2/docker/coding-agent\}'
    }
}
