-- Add CHECK constraints for financial integrity
ALTER TABLE users
  ADD CONSTRAINT chk_monthly_budget_nonnegative
  CHECK (monthly_budget_usd >= 0);

ALTER TABLE request_audit
  ADD CONSTRAINT chk_cost_nonnegative
  CHECK (cost_usd >= 0);

ALTER TABLE usage_history
  ADD CONSTRAINT chk_total_cost_nonnegative
  CHECK (total_cost_usd >= 0);