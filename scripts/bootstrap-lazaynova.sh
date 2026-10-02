#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${LAZAYNOVA_ENV_FILE:-$ROOT_DIR/infrastructure/private.env}"
COMPOSE_FILE="$ROOT_DIR/infrastructure/compose.private.yaml"
GPU_FILE="$ROOT_DIR/infrastructure/compose.gpu.yaml"
USE_GPU=false

usage() {
  cat <<'USAGE'
Usage: scripts/bootstrap-lazaynova.sh [--gpu]

Starts the private PostgreSQL/Redis/API/worker stack and local Ollama profile,
waits for real health checks, pulls the configured local model, sends one fixed
non-sensitive inference smoke prompt, runs live service probes, and creates the
first admin only if none exists.

Options:
  --gpu    Add the optional NVIDIA GPU Compose override.
  --help   Show this help.

Requires infrastructure/private.env. If absent, the example is copied there
with mode 0600 and the script stops so the operator can set local secrets.
USAGE
}

fail() {
  printf 'ERROR: %s\n' "$1" >&2
  exit 1
}

while (($#)); do
  case "$1" in
    --gpu) USE_GPU=true ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; fail "Unknown option: $1" ;;
  esac
  shift
done

for tool in docker node; do
  command -v "$tool" >/dev/null 2>&1 || fail "Required command '$tool' is not installed."
done
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 plugin is required (docker compose)."
docker info >/dev/null 2>&1 || fail "Docker daemon is unavailable; start Docker and rerun this script."

if [[ ! -f "$ENV_FILE" ]]; then
  cp "$ROOT_DIR/infrastructure/private.env.example" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  printf 'Created %s with mode 0600. Set unique secrets and rerun this script.\n' "$ENV_FILE"
  exit 2
fi
chmod 600 "$ENV_FILE"

if [[ "$USE_GPU" == true ]]; then
  command -v nvidia-smi >/dev/null 2>&1 || fail "--gpu requires NVIDIA drivers and nvidia-smi on the host."
  nvidia-smi -L >/dev/null 2>&1 || fail "NVIDIA GPU is not visible to the host."
  [[ -f "$GPU_FILE" ]] || fail "GPU Compose override is missing: $GPU_FILE"
fi

# Parse the dotenv file as data, never as shell code; report variable names only.
node - "$ENV_FILE" <<'NODE'
const fs = require('node:fs');
const path = process.argv[2];
const values = new Map();
for (const raw of fs.readFileSync(path, 'utf8').split(/\r?\n/)) {
  const line = raw.trim();
  if (!line || line.startsWith('#')) continue;
  const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
  if (!match) continue;
  let value = match[2].trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
  values.set(match[1], value);
}
const problems = [];
for (const key of ['POSTGRES_PASSWORD', 'REDIS_PASSWORD']) {
  const value = values.get(key) ?? '';
  if (!/^[A-Za-z0-9_-]{32,}$/.test(value) || value.startsWith('replace-')) problems.push(`${key} must be a unique URL-safe secret of at least 32 characters`);
}
if (values.get('POSTGRES_PASSWORD') && values.get('POSTGRES_PASSWORD') === values.get('REDIS_PASSWORD')) problems.push('POSTGRES_PASSWORD and REDIS_PASSWORD must differ');
const providers = (values.get('AI_GATEWAY_PROVIDERS') ?? '').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
if (providers.length !== 1 || providers[0] !== 'local') problems.push('AI_GATEWAY_PROVIDERS must be exactly local for this private bootstrap');
if (values.get('AI_GATEWAY_LOCAL_BASE_URL') !== 'http://ollama:11434/v1') problems.push('AI_GATEWAY_LOCAL_BASE_URL must target the internal Ollama service');
if (values.get('AI_GATEWAY_LOCAL_ALLOW_INSECURE_HTTP')?.toLowerCase() !== 'true') problems.push('internal Ollama HTTP requires explicit AI_GATEWAY_LOCAL_ALLOW_INSECURE_HTTP=true');
if (!/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/.test(values.get('AI_GATEWAY_LOCAL_MODEL') ?? '')) problems.push('AI_GATEWAY_LOCAL_MODEL must be configured to a valid model identifier');
if (values.get('API_BIND_ADDRESS') !== '127.0.0.1') problems.push('API_BIND_ADDRESS must remain 127.0.0.1 for this bootstrap; front it with a TLS reverse proxy');
if ((values.get('OLLAMA_IMAGE') ?? 'ollama/ollama:0.35.0').endsWith(':latest')) problems.push('OLLAMA_IMAGE must use a reviewed version tag or digest, not latest');
if (problems.length) {
  console.error('Private environment needs attention:');
  for (const problem of problems) console.error(`- ${problem}`);
  process.exit(1);
}
console.log('Private environment structure validated; secret values were not displayed.');
NODE

COMPOSE=(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" --profile local-ai)
if [[ "$USE_GPU" == true ]]; then COMPOSE+=(-f "$GPU_FILE"); fi

"${COMPOSE[@]}" config --quiet || fail "Docker Compose configuration validation failed."
printf '\n[1/6] Build and start PostgreSQL, Redis, API, worker, migrations, and local Ollama.\n'
"${COMPOSE[@]}" up -d --build

wait_healthy() {
  local service="$1" timeout_seconds="$2" started="$SECONDS" container status
  printf 'Waiting for %s health check' "$service"
  while (( SECONDS - started < timeout_seconds )); do
    container="$("${COMPOSE[@]}" ps -q "$service" 2>/dev/null || true)"
    if [[ -n "$container" ]]; then
      status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container" 2>/dev/null || true)"
      if [[ "$status" == healthy ]]; then printf ' — healthy\n'; return 0; fi
      if [[ "$status" == unhealthy ]]; then
        printf '\n'
        "${COMPOSE[@]}" logs --tail=50 "$service" >&2 || true
        fail "$service health check is unhealthy."
      fi
    fi
    printf '.'
    sleep 3
  done
  printf '\n'
  "${COMPOSE[@]}" logs --tail=50 "$service" >&2 || true
  fail "$service did not become healthy within ${timeout_seconds}s."
}

wait_migration() {
  local timeout_seconds=180 started="$SECONDS" container state exit_code
  printf 'Waiting for SQL migrations'
  while (( SECONDS - started < timeout_seconds )); do
    container="$("${COMPOSE[@]}" ps -a -q migrate 2>/dev/null || true)"
    if [[ -n "$container" ]]; then
      state="$(docker inspect --format '{{.State.Status}}' "$container" 2>/dev/null || true)"
      if [[ "$state" == exited ]]; then
        exit_code="$(docker inspect --format '{{.State.ExitCode}}' "$container" 2>/dev/null || true)"
        if [[ "$exit_code" == 0 ]]; then printf ' — completed\n'; return 0; fi
        printf '\n'
        "${COMPOSE[@]}" logs --tail=80 migrate >&2 || true
        fail "SQL migration service exited with code ${exit_code:-unknown}."
      fi
      if [[ "$state" == dead ]]; then fail 'SQL migration container is dead.'; fi
    fi
    printf '.'
    sleep 3
  done
  printf '\n'
  "${COMPOSE[@]}" logs --tail=80 migrate >&2 || true
  fail "SQL migrations did not complete within ${timeout_seconds}s."
}

wait_healthy postgres 180
wait_healthy redis 180
wait_migration
wait_healthy ollama 180
wait_healthy api 180

printf '\n[2/6] Pull the configured local model into its persistent volume.\n'
model="$("${COMPOSE[@]}" exec -T api node -e 'process.stdout.write(process.env.AI_GATEWAY_LOCAL_MODEL || "")')"
[[ "$model" =~ ^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$ ]] || fail 'The running API has no valid AI_GATEWAY_LOCAL_MODEL.'
"${COMPOSE[@]}" exec -T ollama ollama pull "$model"

printf '\n[3/6] Run a bounded real local-inference smoke request (fixed prompt; output is not logged).\n'
"${COMPOSE[@]}" exec -T api node dist/src/scripts/local-inference-smoke.js

printf '\n[4/6] Run live PostgreSQL/migration, Redis/BullMQ, and model-inventory probes in the service network.\n'
"${COMPOSE[@]}" exec -T api node dist/src/scripts/diagnostics.js live-only
"${COMPOSE[@]}" exec -T api node -e '
const fs = require("node:fs");
const report = JSON.parse(fs.readFileSync("/app/backend/.diagnostics/latest-report.json", "utf8"));
const required = ["PostgreSQL and migrations", "Redis/BullMQ", "AI model inventory"];
for (const name of required) {
  const result = report.results.find((item) => item.check === name);
  if (!result || result.status !== "PASS") {
    console.error(`[FAIL] Required live check did not pass: ${name} (${result?.status ?? "missing"}).`);
    process.exitCode = 1;
  }
}
for (const name of ["S3 artifact round-trip", "Docker/gVisor readiness"]) {
  const result = report.results.find((item) => item.check === name);
  console.log(`[${result?.status ?? "MISSING"}] ${name}: ${result?.summary ?? "no report entry"}`);
}
' || fail 'One or more required live service checks failed. Review the redacted output; no success is claimed.'

printf '\n[5/6] Create the first admin only if the database has none.\n'
admin_state="$("${COMPOSE[@]}" exec -T postgres psql -U lazaynova -d lazaynova -Atqc "SELECT CASE WHEN EXISTS (SELECT 1 FROM users WHERE role = 'ADMIN') THEN 'present' ELSE 'absent' END" | tr -d '\r')"
if [[ "$admin_state" == absent ]]; then
  node - "$ENV_FILE" <<'NODE'
const fs = require('node:fs');
const values = new Map();
for (const raw of fs.readFileSync(process.argv[2], 'utf8').split(/\r?\n/)) {
  const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(raw);
  if (!match || match[1].startsWith('#')) continue;
  let value = match[2].trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
  values.set(match[1], value);
}
const email = values.get('BOOTSTRAP_ADMIN_EMAIL') ?? '';
const password = values.get('BOOTSTRAP_ADMIN_PASSWORD') ?? '';
if (!/^\S+@\S+\.\S+$/.test(email) || password.length < 14 || password.startsWith('replace-')) {
  console.error('Set a valid BOOTSTRAP_ADMIN_EMAIL and a unique BOOTSTRAP_ADMIN_PASSWORD of at least 14 characters in the ignored private env file.');
  process.exit(1);
}
console.log('One-time administrator configuration validated; secret values were not displayed.');
NODE
  BOOTSTRAP_COMPOSE=("${COMPOSE[@]}" --profile bootstrap)
  "${BOOTSTRAP_COMPOSE[@]}" run --rm admin-bootstrap
  admin_state="$("${COMPOSE[@]}" exec -T postgres psql -U lazaynova -d lazaynova -Atqc "SELECT CASE WHEN EXISTS (SELECT 1 FROM users WHERE role = 'ADMIN') THEN 'present' ELSE 'absent' END" | tr -d '\r')"
  [[ "$admin_state" == present ]] || fail 'Admin bootstrap did not create an administrator.'
  printf 'Remove BOOTSTRAP_ADMIN_PASSWORD from %s after securely recording it.\n' "$ENV_FILE"
elif [[ "$admin_state" == present ]]; then
  printf 'An administrator already exists; one-time bootstrap was not repeated.\n'
else
  fail 'Could not determine whether an administrator exists.'
fi

printf '\n[6/6] Deployment bootstrap finished with required live checks passing.\n'
printf 'PostgreSQL, Redis/BullMQ, local model inventory, and one real local inference request passed.\n'
printf 'S3 remains intentionally deferred; Coding remains disabled until the isolated sandbox is fully integrated and tested.\n'
printf 'API is bound to 127.0.0.1:8080; configure a host TLS reverse proxy before remote access.\n'
