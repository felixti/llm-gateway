#!/usr/bin/env bash
# Start the full local AI Gateway stack (compose).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "Created $ROOT/.env from .env.example"
fi

exec docker compose --env-file .env -f docker-compose.yml up --build "$@"
