-- Add CHECK constraints for financial integrity (idempotent)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_monthly_budget_nonnegative'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT chk_monthly_budget_nonnegative
      CHECK (monthly_budget_usd >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_cost_nonnegative'
  ) THEN
    ALTER TABLE request_audit
      ADD CONSTRAINT chk_cost_nonnegative
      CHECK (cost_usd >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_total_cost_nonnegative'
  ) THEN
    ALTER TABLE usage_history
      ADD CONSTRAINT chk_total_cost_nonnegative
      CHECK (total_cost_usd >= 0);
  END IF;
END $$;
