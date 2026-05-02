# Operations Guide

## PAT Rotation

1. Generate new PAT_SECRET (≥32 chars)
2. Update `.env` with new secret
3. Restart all gateway instances
4. Old PATs signed with previous secret will be rejected
5. Notify users to regenerate their PATs

## Quota Drift Recovery

If Redis quota state diverges from PostgreSQL:

```bash
# Force full sync from Postgres to Redis
POST /admin/quota/sync
# (requires admin scope PAT)
```

## Circuit Breaker Recovery

If a deployment circuit is stuck OPEN:

```bash
# Check circuit state
GET /health/ready

# Wait for 30s automatic reset, or restart the gateway
```

## Database Migrations

```bash
# Run pending migrations
bun run db:migrate

# Check migration status
bun run db:status
```

## Common Issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| 429 Quota Exceeded | Budget exhausted | Increase monthly_budget_usd in users table |
| 429 Rate Limited | RPM/TPM exceeded | Wait or increase RATE_LIMIT_RPM/TPM |
| 503 Service Unavailable | Circuit breaker OPEN | Wait 30s or check deployment health |
| 504 Gateway Timeout | Upstream slow | Increase REQUEST_TIMEOUT_MS |
| Streaming stops mid-response | Client abort | Normal — quota released automatically |
