#!/usr/bin/env bash
# Run compose E2E smoke tests (stack must be up, or use: local-e2e.sh up first).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

if [[ ! -f .env ]]; then
  cp .env.example .env
fi

exec docker compose --env-file .env -f docker-compose.yml --profile e2e run --rm e2e "$@"
