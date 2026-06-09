#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env"
DEFAULT_DATABASE_URL="postgresql://postgres:postgres@localhost:5432/llm_gateway"
DEFAULT_REDIS_HOST="localhost"
DEFAULT_REDIS_PORT="6379"
DEFAULT_PORT="3000"

print_help() {
  cat <<'EOF'
Interactive local setup for LLM Gateway.

Usage:
  bash scripts/run-local.sh
  bash scripts/run-local.sh --help

The interactive flow can:
  - Check prerequisites: bun, docker, psql, curl
  - Create or update .env with PAT_SECRET, DATABASE_URL, REDIS_HOST, REDIS_PORT, and Azure values
  - Start Redis and Postgres via docker compose
  - Install dependencies with bun install
  - Apply SQL migrations in migrations/
  - Optionally run typecheck and lint
  - Start the application with bun run dev
  - Run smoke checks against /health, /ready, and /metrics

The app reads REDIS_HOST and REDIS_PORT, not REDIS_URL.
EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  print_help
  exit 0
fi

cd "${ROOT_DIR}"

info() {
  printf '\n\033[1;34m==>\033[0m %s\n' "$1"
}

warn() {
  printf '\033[1;33mWARN:\033[0m %s\n' "$1"
}

error() {
  printf '\033[1;31mERROR:\033[0m %s\n' "$1" >&2
}

has_command() {
  command -v "$1" >/dev/null 2>&1
}

prompt_yes_no() {
  local prompt="$1"
  local default="${2:-y}"
  local suffix="[Y/n]"

  if [[ "${default}" == "n" ]]; then
    suffix="[y/N]"
  fi

  local answer
  read -r -p "${prompt} ${suffix} " answer
  answer="${answer:-${default}}"

  [[ "${answer}" =~ ^[Yy]([Ee][Ss])?$ ]]
}

get_env_value() {
  local key="$1"

  if [[ ! -f "${ENV_FILE}" ]]; then
    return 0
  fi

  awk -F= -v key="${key}" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "${ENV_FILE}"
}

upsert_env_value() {
  local key="$1"
  local value="$2"

  touch "${ENV_FILE}"

  local tmp_file
  tmp_file="$(mktemp)"

  awk -v key="${key}" -v value="${value}" '
    BEGIN { updated = 0 }
    $0 ~ "^" key "=" {
      print key "=" value
      updated = 1
      next
    }
    { print }
    END {
      if (!updated) {
        print key "=" value
      }
    }
  ' "${ENV_FILE}" >"${tmp_file}"

  mv "${tmp_file}" "${ENV_FILE}"
}

prompt_env_value() {
  local key="$1"
  local default="$2"
  local current
  current="$(get_env_value "${key}")"

  local shown_default="${current:-${default}}"
  local value
  read -r -p "${key} [${shown_default}]: " value
  value="${value:-${shown_default}}"

  upsert_env_value "${key}" "${value}"
}

generate_secret() {
  if has_command openssl; then
    openssl rand -hex 32
    return
  fi

  od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
}

load_env_file() {
  if [[ ! -f "${ENV_FILE}" ]]; then
    error ".env does not exist. Run option 3 first to create it."
    return 1
  fi

  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
}

check_prerequisites() {
  info "Checking prerequisites"

  local missing=()
  for command_name in bun docker psql curl; do
    if has_command "${command_name}"; then
      printf '  OK  %s\n' "${command_name}"
    else
      printf '  --  %s missing\n' "${command_name}"
      missing+=("${command_name}")
    fi
  done

  if ((${#missing[@]} > 0)); then
    warn "Missing commands: ${missing[*]}"
    warn "You can still use parts of this script, but related steps may fail."
  fi
}

configure_env() {
  info "Creating or updating .env"

  if [[ -f "${ENV_FILE}" ]] && prompt_yes_no "Back up existing .env first?" "y"; then
    cp "${ENV_FILE}" "${ENV_FILE}.bak.$(date +%Y%m%d%H%M%S)"
  fi

  [[ -n "$(get_env_value NODE_ENV)" ]] || upsert_env_value "NODE_ENV" "development"

  prompt_env_value "PORT" "${DEFAULT_PORT}"
  prompt_env_value "LOG_LEVEL" "info"
  prompt_env_value "DATABASE_URL" "${DEFAULT_DATABASE_URL}"
  prompt_env_value "REDIS_HOST" "${DEFAULT_REDIS_HOST}"
  prompt_env_value "REDIS_PORT" "${DEFAULT_REDIS_PORT}"

  local existing_pat_secret
  existing_pat_secret="$(get_env_value PAT_SECRET)"
  if [[ -z "${existing_pat_secret}" || "${existing_pat_secret}" == "your-secret-at-least-32-characters-long" ]]; then
    if prompt_yes_no "Generate a new PAT_SECRET?" "y"; then
      upsert_env_value "PAT_SECRET" "$(generate_secret)"
    else
      prompt_env_value "PAT_SECRET" "change-me-at-least-32-characters-long"
    fi
  else
    prompt_env_value "PAT_SECRET" "${existing_pat_secret}"
  fi

  if prompt_yes_no "Configure Azure endpoints and keys now?" "n"; then
    prompt_env_value "AZURE_OPENAI_ENDPOINT" "https://your-resource.openai.azure.com"
    prompt_env_value "AZURE_OPENAI_KEY" "your-api-key"
    prompt_env_value "AZURE_AI_FOUNDRY_ENDPOINT" "https://your-resource.aiinfused.com"
    prompt_env_value "AZURE_AI_FOUNDRY_KEY" "your-api-key"
  fi

  if prompt_yes_no "Configure optional admin operator secret now?" "n"; then
    prompt_env_value "ADMIN_OPERATOR_SECRET" "$(generate_secret)"
  fi

  info ".env is ready"
}

start_infra() {
  info "Starting Redis and Postgres"

  if ! has_command docker; then
    error "docker is required for this step"
    return 1
  fi

  docker compose up -d redis postgres
}

install_dependencies() {
  info "Installing dependencies"

  if ! has_command bun; then
    error "bun is required for this step"
    return 1
  fi

  bun install
}

apply_migrations() {
  info "Applying SQL migrations"

  if ! has_command psql; then
    error "psql is required for this step"
    return 1
  fi

  load_env_file

  psql "${DATABASE_URL:-${DEFAULT_DATABASE_URL}}" -f migrations/001_initial_schema.sql
  psql "${DATABASE_URL:-${DEFAULT_DATABASE_URL}}" -f migrations/002_pat_subject.sql
}

run_quality_checks() {
  info "Running optional quality checks"

  if prompt_yes_no "Run typecheck?" "y"; then
    bun run typecheck
  fi

  if prompt_yes_no "Run lint?" "y"; then
    bun run lint
  fi
}

run_smoke_checks() {
  info "Running smoke checks"

  load_env_file

  local base_url="http://localhost:${PORT:-${DEFAULT_PORT}}"
  for path in /health /ready /metrics; do
    printf '\nGET %s%s\n' "${base_url}" "${path}"
    curl -fsS "${base_url}${path}" || warn "Smoke check failed for ${path}"
    printf '\n'
  done
}

start_app() {
  info "Starting LLM Gateway"
  warn "This runs in the foreground. Press Ctrl+C to stop."

  load_env_file

  bun run dev
}

run_all_until_app() {
  check_prerequisites
  configure_env
  start_infra
  install_dependencies
  apply_migrations
  run_quality_checks
  start_app
}

main_menu() {
  while true; do
    cat <<'EOF'

LLM Gateway local runner

1) Run all setup steps and start app
2) Check prerequisites
3) Create/update .env
4) Start Redis and Postgres
5) Install dependencies
6) Apply migrations
7) Run typecheck/lint
8) Start app
9) Run smoke checks
0) Exit
EOF

    local choice
    read -r -p "Choose an option: " choice

    case "${choice}" in
      1) run_all_until_app ;;
      2) check_prerequisites ;;
      3) configure_env ;;
      4) start_infra ;;
      5) install_dependencies ;;
      6) apply_migrations ;;
      7) run_quality_checks ;;
      8) start_app ;;
      9) run_smoke_checks ;;
      0) exit 0 ;;
      *) warn "Unknown option: ${choice}" ;;
    esac
  done
}

main_menu
