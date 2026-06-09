# Chaos Testing

This directory contains chaos tests for the LLM Gateway that verify resilience under failure conditions.

## Test Suites

### Redis Failure Tests
File: `redis-failure.test.ts`

Tests the gateway's behavior when Redis is unavailable:
- Quota reservation during Redis issues
- Quota status checks during Redis issues
- Graceful error handling

### PostgreSQL Failure Tests
File: `postgres-failure.test.ts`

Tests the gateway's behavior when PostgreSQL is unavailable:
- Health check reporting
- Audit logging failure handling
- Quota policy lookup failure handling

## Running Chaos Tests

```bash
# Run all chaos tests
bun test tests/chaos

# Run specific test suite
bun test tests/chaos/redis-failure.test.ts
bun test tests/chaos/postgres-failure.test.ts
```

## Simulating Failures

### Redis Failure
To simulate Redis failure:
1. Stop Redis: `docker stop redis`
2. Run tests
3. Start Redis: `docker start redis`

### PostgreSQL Failure
To simulate PostgreSQL failure:
1. Stop PostgreSQL: `docker stop postgres`
2. Run tests
3. Start PostgreSQL: `docker start postgres`

## Expected Behavior

The gateway should:
- Return appropriate error responses (503, 500)
- Log errors with structured logging
- Not crash or hang
- Continue serving requests that don't depend on failed services
- Recover automatically when services are restored

## Integration with CI/CD

Add chaos tests to your CI pipeline:
```yaml
chaos-tests:
  runs-on: ubuntu-latest
  services:
    redis:
      image: redis:7-alpine
      ports:
        - 6379:6379
    postgres:
      image: postgres:16-alpine
      env:
        POSTGRES_PASSWORD: postgres
      ports:
        - 5432:5432
  steps:
    - uses: actions/checkout@v4
    - uses: oven-sh/setup-bun@v2
    - run: bun install
    - run: bun test tests/chaos
```
