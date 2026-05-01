#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env"
HOST="${HOST:-http://localhost:3000}"
RUN_LLM_TESTS="${RUN_LLM_TESTS:-false}"
RUN_ADMIN_REVOKE="${RUN_ADMIN_REVOKE:-false}"

print_help() {
  cat <<'EOF'
Curl smoke tests for LLM Gateway.

Usage:
  bash scripts/curl-tests.sh
  bun run test:curl

Environment:
  HOST=http://localhost:3000          Gateway base URL
  TOKEN=<pat-or-bearer-token>         User PAT. If omitted, generated from PAT_SECRET
  ADMIN_TOKEN=<pat-or-bearer-token>   Admin PAT. If omitted, generated from PAT_SECRET
  PAT_SECRET=<secret>                 Used to generate local PATs when TOKEN is absent
  ADMIN_OPERATOR_SECRET=<secret>      Optional /admin second factor header
  RUN_LLM_TESTS=true                  Also call upstream-backed LLM routes
  RUN_ADMIN_REVOKE=true               Also call /admin/pat/revoke (mutates Redis blocklist)

Default tests are safe local smoke checks:
  /health, /ready, /metrics, /v1/models, /quota, and one protocol-guard rejection.
EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  print_help
  exit 0
fi

cd "${ROOT_DIR}"

if [[ -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
fi

info() {
  printf '\n\033[1;34m==>\033[0m %s\n' "$1"
}

warn() {
  printf '\033[1;33mWARN:\033[0m %s\n' "$1"
}

has_command() {
  command -v "$1" >/dev/null 2>&1
}

require_command() {
  if ! has_command "$1"; then
    printf 'Missing required command: %s\n' "$1" >&2
    exit 1
  fi
}

normalize_bearer() {
  local token="$1"

  if [[ "${token}" == Bearer\ * ]]; then
    printf '%s' "${token}"
  else
    printf 'Bearer %s' "${token}"
  fi
}

generate_pat() {
  local user_id="$1"
  local scope="$2"
  local jti="$3"

  if [[ -z "${PAT_SECRET:-}" ]]; then
    printf 'PAT_SECRET is required to auto-generate PATs. Set TOKEN or PAT_SECRET.\n' >&2
    exit 1
  fi

  USER_ID="${user_id}" SCOPE="${scope}" JTI="${jti}" bun --silent <<'EOF'
import { createHmac } from 'node:crypto';

const secret = process.env.PAT_SECRET;
const userId = process.env.USER_ID || 'local-user';
const scope = process.env.SCOPE || 'all';
const jti = process.env.JTI || crypto.randomUUID();

if (!secret || secret.length < 32) {
  throw new Error('PAT_SECRET must be at least 32 characters');
}

const base64Url = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString('base64url').replace(/=+$/, '');

const header = `lg_${userId}_${base64Url({ alg: 'HS256', typ: 'JWT' })}`;
const payload = base64Url({
  jti,
  exp: Math.floor(Date.now() / 1000) + 3600,
  scope,
});
const signature = createHmac('sha256', secret).update(`${header}.${payload}`).digest('hex');

console.log(`Bearer ${header}.${payload}.${signature}`);
EOF
}

generate_uuid() {
  bun --silent -e 'console.log(crypto.randomUUID())'
}

request() {
  local name="$1"
  local expected_status="$2"
  shift 2

  info "${name}"

  local response_file status
  response_file="$(mktemp)"
  status="$(curl --silent --show-error --output "${response_file}" --write-out '%{http_code}' "$@")"

  printf 'HTTP %s (expected %s)\n' "${status}" "${expected_status}"
  sed -n '1,40p' "${response_file}"
  printf '\n'
  rm -f "${response_file}"

  if [[ "${status}" != "${expected_status}" ]]; then
    warn "${name} returned HTTP ${status}, expected ${expected_status}"
  fi
}

require_command curl
require_command bun

AUTH_HEADER="$(normalize_bearer "${TOKEN:-$(generate_pat local-user all "$(generate_uuid)")}")"
ADMIN_AUTH_HEADER="$(normalize_bearer "${ADMIN_TOKEN:-$(generate_pat admin-user admin "$(generate_uuid)")}")"
OPERATOR_HEADERS=()

if [[ -n "${ADMIN_OPERATOR_SECRET:-}" ]]; then
  OPERATOR_HEADERS=(-H "X-Operator-Secret: ${ADMIN_OPERATOR_SECRET}")
fi

request "Liveness" "200" \
  "${HOST}/health"

request "Readiness" "200" \
  "${HOST}/ready"

request "Metrics" "200" \
  "${HOST}/metrics"

request "List models" "200" \
  -H "Authorization: ${AUTH_HEADER}" \
  "${HOST}/v1/models"

request "Quota status" "200" \
  -H "Authorization: ${AUTH_HEADER}" \
  "${HOST}/quota"

request "Protocol guard rejects Claude on chat completions" "400" \
  -X POST \
  -H "Authorization: ${AUTH_HEADER}" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4-6","messages":[{"role":"user","content":"Hello Claude"}],"stream":false,"max_tokens":50}' \
  "${HOST}/v1/chat/completions"

if [[ "${RUN_LLM_TESTS}" == "true" ]]; then
  request "OpenAI chat completion" "200" \
    -X POST \
    -H "Authorization: ${AUTH_HEADER}" \
    -H "Content-Type: application/json" \
    -d '{"model":"gpt-5-mini","messages":[{"role":"user","content":"Say hello in one short sentence."}],"stream":false,"max_tokens":50}' \
    "${HOST}/v1/chat/completions"

  request "Anthropic messages completion" "200" \
    -X POST \
    -H "Authorization: ${AUTH_HEADER}" \
    -H "Content-Type: application/json" \
    -H "anthropic-version: 2023-06-01" \
    -d '{"model":"claude-sonnet-4-6","messages":[{"role":"user","content":"Say hello in one short sentence."}],"stream":false,"max_tokens":50}' \
    "${HOST}/v1/messages"

  request "Responses API completion" "200" \
    -X POST \
    -H "Authorization: ${AUTH_HEADER}" \
    -H "Content-Type: application/json" \
    -d '{"model":"gpt-5.3-codex","input":"Say hello in one short sentence.","stream":false}' \
    "${HOST}/v1/responses"
else
  warn "Skipping upstream-backed LLM curls. Set RUN_LLM_TESTS=true to enable them."
fi

if [[ "${RUN_ADMIN_REVOKE}" == "true" ]]; then
  request "Admin PAT revoke" "200" \
    -X POST \
    -H "Authorization: ${ADMIN_AUTH_HEADER}" \
    "${OPERATOR_HEADERS[@]}" \
    -H "Content-Type: application/json" \
    -d "{\"pat_id\":\"$(generate_uuid)\",\"reason\":\"curl smoke test\"}" \
    "${HOST}/admin/pat/revoke"
else
  warn "Skipping admin revocation curl. Set RUN_ADMIN_REVOKE=true to enable it."
fi
