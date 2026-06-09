#!/usr/bin/bash
set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is required" >&2
  exit 1
fi

# Sort migration files deterministically
migrations=($(ls -1 migrations/*.sql 2>/dev/null | sort))

if [[ ${#migrations[@]} -eq 0 ]]; then
  echo "No migrations found"
  exit 0
fi

# Bootstrap migration: 000_migration_tracking.sql creates the ledger table.
# Apply it first without transaction wrapper (table doesn't exist yet).
# IF NOT EXISTS in the CREATE TABLE handles idempotency on retry.
for migration in "${migrations[@]}"; do
  version=$(basename "${migration}" .sql)

  if [[ "${version}" == "000_migration_tracking" ]]; then
    echo "Applying bootstrap migration: ${migration}"
    psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -f "${migration}"
    echo "Bootstrap migration applied: ${migration}"
    continue
  fi
  break
done

# Subsequent migrations: wrap apply + ledger INSERT in a single atomic transaction.
# Uses BEGIN...COMMIT to ensure both steps are atomic. On failure, both roll back -
# no orphaned migrations (applied but unrecorded).
for migration in "${migrations[@]}"; do
  version=$(basename "${migration}" .sql)

  # Skip bootstrap migration (already applied above)
  if [[ "${version}" == "000_migration_tracking" ]]; then
    continue
  fi

  # Check if already recorded in ledger
  if psql "${DATABASE_URL}" -t -c "SELECT 1 FROM schema_migrations WHERE version = '${version}'" 2>/dev/null | grep -q 1; then
    echo "Skipping ${migration} (already recorded in ledger)"
    continue
  fi

  echo "Applying ${migration} with atomic transaction"
  migration_abs=$(realpath "${migration}")
  psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 << SQL
BEGIN;
$(cat "${migration_abs}")
INSERT INTO schema_migrations (version) VALUES ('${version}') ON CONFLICT (version) DO NOTHING;
COMMIT;
SQL
  echo "Applied and recorded: ${migration}"
done

echo "Migration run complete"
