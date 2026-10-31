#!/bin/sh
# Copyright (c) 2026 DPSystems, LLC.
# ABOUTME: Installs an unpacked deployment package on the Synology NAS and proves the service works.
# ABOUTME: Usage: sh install-on-nas.sh <package-dir>. Checks secrets before changing anything.
set -eu

package_dir=${1:?usage: install-on-nas.sh <package-dir>}
app_dir=${CODING_AGENT_APP_DIR:-/volume2/docker/coding-agent}
data_dir=${CODING_AGENT_DATA:-/volume2/docker/coding-agent-data}
port=${CODING_AGENT_PORT:-8081}
docker=/usr/local/bin/docker
compose=/usr/local/bin/docker-compose
secrets="$app_dir/.runtime.env"
app_key="$app_dir/github-app.pem"

fail() {
  echo "INSTALL FAILED: $*" >&2
  exit 1
}

cd "$package_dir"
sha256sum -c SHA256SUMS >/dev/null || fail "package checksums do not match"
image=$(sed -n 's/^image=//p' manifest.txt)
[ -n "$image" ] || fail "manifest.txt names no image"

# Secrets first: a deployment that cannot start must not replace one that can.
[ -f "$secrets" ] || fail "missing $secrets (run scripts/set-nas-secrets.ps1 from the workstation)"
for name in ANTHROPIC_API_KEY CODING_AGENT_GITHUB_APP_ID CODING_AGENT_GITHUB_APP_INSTALLATION_ID \
  CODING_AGENT_INTENT_TOKEN CODING_AGENT_API_TOKEN; do
  grep -q "^$name=..*" "$secrets" || fail "$name is not set in $secrets"
done
[ -s "$app_key" ] || fail "missing $app_key (run scripts/set-nas-secrets.ps1 from the workstation)"
grep -q 'PRIVATE KEY-----' "$app_key" || fail "$app_key is not a PEM private key"

echo "Loading $image"
sudo "$docker" load -i image.tar >/dev/null

mkdir -p "$app_dir" "$data_dir/work" "$data_dir/cache" "$data_dir/secrets"
# The container runs as uid 10001; its data folders must be writable by that user.
# Only work/ and cache/: the upload folder beside them stays DockerDeploy's so it can be cleaned up.
sudo "$docker" run --rm --user root --entrypoint chown \
  -v "$data_dir/work:/data/work" -v "$data_dir/cache:/data/cache" "$image" -R 10001:999 /data/work /data/cache
# The uploaded key is readable only by DockerDeploy; the service reads a copy readable only by root, which
# it opens before dropping to uid 10001, so job commands (also uid 10001) cannot read it.
# This NAS allows DockerDeploy passwordless sudo for docker alone, so a root container makes the copy.
sudo "$docker" run --rm --user root --entrypoint sh \
  -v "$app_key:/in/github-app.pem:ro" -v "$data_dir/secrets:/out" "$image" \
  -c 'cp /in/github-app.pem /out/github-app.pem && chown 0:0 /out/github-app.pem && chmod 400 /out/github-app.pem'
cp compose.yaml "$app_dir/docker-compose.yml"
cp manifest.json "$app_dir/manifest.json"
printf 'CODING_AGENT_IMAGE=%s\nCODING_AGENT_DATA=%s\n' "$image" "$data_dir" >"$app_dir/.env"

cd "$app_dir"
sudo "$compose" up -d --no-build --remove-orphans

echo "Waiting for http://127.0.0.1:$port/health"
attempt=0
until curl -fsS "http://127.0.0.1:$port/health" >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 30 ] || {
    sudo "$docker" logs --tail 40 coding-agent >&2 || true
    fail "health check did not return 200 within 60 seconds"
  }
  sleep 2
done
echo "PASS health: $(curl -fsS "http://127.0.0.1:$port/health")"

# The self-test makes one tiny model request and checks GitHub App tokens and Git access.
# The bearer header goes through a private file so the token never appears in the process list.
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
(
  umask 077
  sed -n 's/^CODING_AGENT_API_TOKEN=/Authorization: Bearer /p' "$secrets" >"$scratch/header"
)
result=$(curl -sS -o "$scratch/self-test.json" -w '%{http_code}' -X POST \
  -H "@$scratch/header" "http://127.0.0.1:$port/self-test") || fail "self-test request failed"
cat "$scratch/self-test.json"
echo
[ "$result" = "200" ] || fail "self-test returned HTTP $result"
echo "PASS self-test"
echo "Deployed $image to $app_dir"
