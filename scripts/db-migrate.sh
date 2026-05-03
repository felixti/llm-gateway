#!/usr/bin/bash
set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is required" >&2
  exit 1
fi

for migration in migrations/*.sql; do
  version=$(basename "${migration}" .sql)

  if psql "${DATABASE_URL}" -t -c "SELECT 1 FROM schema_migrations WHERE version = '${version}'" 2>/dev/null | grep -q 1; then
    echo "Skipping ${migration} (already applied)"
    continue
  fi

  echo "Applying ${migration}"
  psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -f "${migration}"

  psql "${DATABASE_URL}" -c "INSERT INTO schema_migrations (version) VALUES ('${version}') ON CONFLICT (version) DO NOTHING"
done
