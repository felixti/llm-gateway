-- Keep monthly request_audit aggregations index-friendly.
-- getRequestAuditStats filters by user_id and a created_at range so this
-- covering index can satisfy the token aggregation query efficiently.
CREATE INDEX IF NOT EXISTS idx_request_audit_user_created_usage
  ON request_audit(user_id, created_at)
  INCLUDE (tokens_input, tokens_output, tokens_thinking);
