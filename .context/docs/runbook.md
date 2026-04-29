# LLM Gateway Runbook

## Common Incidents & Resolution

### 1. All Requests Return 401 "Token has expired"

**Symptoms:** Every API call returns HTTP 401 with `authentication_error`.

**Diagnosis:**
```bash
curl -H "Authorization: Bearer $PAT" http://localhost:3000/v1/models
```

**Causes:**
- PAT `exp` claim is in the past
- System clock skew between client and server
- `PAT_SECRET` environment variable changed

**Resolution:**
1. Check PAT expiry: decode the payload (base64url) and verify `exp` > now()
2. Regenerate PAT if expired
3. Verify `PAT_SECRET` matches between token issuer and gateway
4. Check NTP sync on both client and server

**Prevention:**
- Issue PATs with reasonable TTL (e.g., 90 days)
- Monitor `http_requests_total{status="401"}` in Prometheus

---

### 2. All Requests Return 429 "Insufficient quota"

**Symptoms:** All users get HTTP 429 with `X-Quota-Remaining: 0`.

**Diagnosis:**
```bash
curl -H "Authorization: Bearer $PAT" http://localhost:3000/quota
```

**Causes:**
- Orphaned reservations not being cleaned up (check scheduler logs)
- Redis quota keys corrupted
- Monthly budget set too low

**Resolution:**
1. Check `/quota` endpoint for `reserved_usd` — if high, reservations are stuck
2. Restart background jobs: `stopBackgroundJobs(); startBackgroundJobs()`
3. Force cleanup: manually call `cleanupOrphanedReservations()`
4. If Redis keys are corrupted, flush quota keys (requires admin): `redis-cli --scan --pattern "quota:*" | xargs redis-cli del`

**Prevention:**
- Monitor `llm_quota_remaining_ratio` — alert if < 0.1 for multiple users
- Ensure scheduler service is running (check `startBackgroundJobs()` in logs)

---

### 3. Circuit Breaker Open for All Deployments

**Symptoms:** All requests return 503 with `circuit_open`.

**Diagnosis:**
```bash
curl http://localhost:3000/ready
```

**Causes:**
- Azure endpoints unreachable (network issue)
- Azure auth credentials expired (Entra ID secret rotated)
- Health checks disabled or misconfigured

**Resolution:**
1. Check `/ready` — if `deployments: false`, Azure is unreachable
2. Verify Azure credentials: `AZURE_OPENAI_KEY`, `AZURE_AI_FOUNDRY_KEY`, `AZURE_ENTRA_CLIENT_SECRET`
3. Test Azure directly:
   ```bash
   curl -H "api-key: $AZURE_OPENAI_KEY" "$AZURE_OPENAI_ENDPOINT/openai/deployments/gpt-5.4/chat/completions?api-version=2024-06-01" \
     -d '{"messages":[{"role":"user","content":"hi"}]}'
   ```
4. Wait 30 seconds for circuit breaker half-open state, or restart the gateway

**Prevention:**
- Monitor `circuit_breaker_state` gauge (0=CLOSED, 1=OPEN, 2=HALF_OPEN)
- Set up Entra ID secret rotation alerts

---

### 4. High Latency / Timeouts

**Symptoms:** Requests take > 30 seconds or timeout.

**Diagnosis:**
- Check Prometheus metrics for `duration_ms` on spans
- Check `/ready` for deployment latency

**Causes:**
- Azure throttling (429 from upstream)
- Large request bodies causing slow token estimation
- Redis under high load

**Resolution:**
1. Check upstream response headers for `Retry-After`
2. Reduce `max_tokens` or message size in client requests
3. Scale Redis if CPU-bound
4. Enable `HEALTH_CHECK_ENABLED=false` temporarily if health checks are causing load

**Prevention:**
- Monitor `azure_rate_limit_hits_total`
- Set client-side timeout < gateway timeout

---

### 5. Redis Connection Failures

**Symptoms:** `/ready` returns `redis: false`, quota/rate-limit fail.

**Diagnosis:**
```bash
redis-cli -h $REDIS_HOST -p $REDIS_PORT ping
```

**Causes:**
- Redis server down
- Network partition
- Authentication failure (`REDIS_PASSWORD` mismatch)

**Resolution:**
1. Verify Redis connectivity from gateway host
2. Check Redis logs for auth failures
3. Restart Redis if necessary (reservations will be lost — users may get temporary quota relief)
4. Verify `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD` env vars

**Prevention:**
- Run Redis with persistence (AOF or RDB)
- Monitor `checks.redis` from `/ready` endpoint

---

### 6. PostgreSQL Connection Failures

**Symptoms:** Request audit logs not written, PAT revocation not persisted.

**Diagnosis:**
```bash
psql $DATABASE_URL -c "SELECT 1"
```

**Causes:**
- PostgreSQL server down
- Connection pool exhausted
- `DATABASE_URL` misconfigured

**Resolution:**
1. Verify PostgreSQL is running and reachable
2. Check connection pool usage: `SELECT count(*) FROM pg_stat_activity;`
3. Restart gateway to reset connections
4. Verify `DATABASE_URL` format: `postgresql://user:pass@host:port/db`

**Prevention:**
- Monitor `database.execute` error rates in logs
- Set up PostgreSQL connection pool alerts

---

## Operational Commands

### Restart Gracefully
```bash
# Send SIGTERM for graceful shutdown (30s drain)
kill -TERM $(pgrep -f "bun run start")
```

### Check Metrics
```bash
curl http://localhost:3000/metrics
curl http://localhost:3000/ready
curl http://localhost:3000/health
```

### Revoke a PAT Manually
```bash
curl -X POST http://localhost:3000/admin/pat/revoke \
  -H "Authorization: Bearer $ADMIN_PAT" \
  -H "Content-Type: application/json" \
  -d '{"pat_id":"xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx","reason":"Compromised"}'
```

### View OpenAPI Spec
```bash
curl http://localhost:3000/openapi.json
```

## Escalation

If the above steps do not resolve the incident:
1. Check `.context/docs/decisions.md` for recent architecture changes
2. Review traces in OpenTelemetry collector for error spans (100% sampled)
3. Contact Platform Engineering with trace ID and request ID
