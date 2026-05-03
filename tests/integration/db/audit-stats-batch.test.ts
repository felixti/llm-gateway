import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { sql } from '../../../src/db/client';
import { batchGetRequestAuditStats } from '../../../src/db/data-access';

let hasPostgres = false;
try {
  await sql`SELECT 1`;
  hasPostgres = true;
} catch {
  hasPostgres = false;
}

const describeOrSkip = hasPostgres ? describe : describe.skip;

describeOrSkip('batchGetRequestAuditStats — Postgres integration', () => {
  const userId = randomUUID();

  beforeAll(async () => {
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email VARCHAR(255) UNIQUE NOT NULL,
        monthly_budget_usd DECIMAL(10, 6) NOT NULL DEFAULT 50.00,
        hard_limit BOOLEAN DEFAULT true,
        rate_limit_tier VARCHAR(20) DEFAULT 'standard',
        pat_subject VARCHAR(255),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS request_audit (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id),
        request_id VARCHAR(255) NOT NULL,
        model VARCHAR(100),
        deployment VARCHAR(100),
        protocol_family VARCHAR(30),
        tokens_input INTEGER,
        tokens_output INTEGER,
        tokens_thinking INTEGER,
        cost_usd DECIMAL(10, 6),
        thinking_enabled BOOLEAN DEFAULT false,
        azure_auth_type VARCHAR(20),
        duration_ms INTEGER,
        status_code INTEGER,
        error_message TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await sql`
      INSERT INTO users (id, email)
      VALUES (${userId}, ${`audit-stats-${userId}@example.com`})
      ON CONFLICT (id) DO NOTHING
    `;
  });

  beforeEach(async () => {
    await sql`DELETE FROM request_audit WHERE user_id = ${userId}`;
  });

  afterAll(async () => {
    try {
      await sql`DELETE FROM request_audit WHERE user_id = ${userId}`;
      await sql`DELETE FROM users WHERE id = ${userId}`;
    } catch {
      void 0;
    }
  });

  it('aggregates token totals across two distinct months', async () => {
    const rows: Array<[string, string, number, number, string]> = [
      [randomUUID(), '2026-04-15 12:00:00+00', 100, 50, '0.010000'],
      [randomUUID(), '2026-04-20 12:00:00+00', 200, 75, '0.020000'],
      [randomUUID(), '2026-05-01 12:00:00+00', 50, 25, '0.005000'],
      [randomUUID(), '2026-05-10 12:00:00+00', 60, 30, '0.006000'],
      [randomUUID(), '2026-05-25 12:00:00+00', 70, 35, '0.007000'],
    ];

    for (const [reqId, ts, tIn, tOut, cost] of rows) {
      await sql`
        INSERT INTO request_audit
          (request_id, user_id, model, deployment, protocol_family,
           tokens_input, tokens_output, tokens_thinking, cost_usd,
           thinking_enabled, azure_auth_type, duration_ms, status_code, created_at)
        VALUES
          (${reqId}, ${userId}, 'gpt-4o', 'gpt-4o', 'openai',
           ${tIn}, ${tOut}, 0, ${cost},
           false, 'apikey', 100, 200, ${ts})
      `;
    }

    const result = await batchGetRequestAuditStats([
      { resolvedUserId: userId, month: '2026-04' },
      { resolvedUserId: userId, month: '2026-05' },
    ]);

    const april = result.get(`${userId}:2026-04`);
    const may = result.get(`${userId}:2026-05`);

    expect(april).toBeDefined();
    expect(april?.totalRequests).toBe(2);
    expect(april?.totalTokensInput).toBe(300);
    expect(april?.totalTokensOutput).toBe(125);

    expect(may).toBeDefined();
    expect(may?.totalRequests).toBe(3);
    expect(may?.totalTokensInput).toBe(180);
    expect(may?.totalTokensOutput).toBe(90);
  });

  it('returns empty map for empty input', async () => {
    const result = await batchGetRequestAuditStats([]);
    expect(result.size).toBe(0);
  });

  it('does not include rows from adjacent months', async () => {
    await sql`
      INSERT INTO request_audit
        (request_id, user_id, model, deployment, protocol_family,
         tokens_input, tokens_output, tokens_thinking, cost_usd,
         thinking_enabled, azure_auth_type, duration_ms, status_code, created_at)
      VALUES
        (${randomUUID()}, ${userId}, 'gpt-4o', 'gpt-4o', 'openai',
         100, 50, 0, '0.010000',
         false, 'apikey', 100, 200, '2026-04-30 23:59:59+00'),
        (${randomUUID()}, ${userId}, 'gpt-4o', 'gpt-4o', 'openai',
         200, 100, 0, '0.020000',
         false, 'apikey', 100, 200, '2026-05-01 00:00:00+00')
    `;

    const result = await batchGetRequestAuditStats([
      { resolvedUserId: userId, month: '2026-04' },
    ]);

    const april = result.get(`${userId}:2026-04`);
    expect(april).toBeDefined();
    expect(april?.totalRequests).toBe(1);
    expect(april?.totalTokensInput).toBe(100);
    expect(april?.totalTokensOutput).toBe(50);
  });

  it('handles multiple non-contiguous months in a single call', async () => {
    await sql`
      INSERT INTO request_audit
        (request_id, user_id, model, deployment, protocol_family,
         tokens_input, tokens_output, tokens_thinking, cost_usd,
         thinking_enabled, azure_auth_type, duration_ms, status_code, created_at)
      VALUES
        (${randomUUID()}, ${userId}, 'gpt-4o', 'gpt-4o', 'openai',
         11, 12, 0, '0.001100',
         false, 'apikey', 100, 200, '2026-01-15 12:00:00+00'),
        (${randomUUID()}, ${userId}, 'gpt-4o', 'gpt-4o', 'openai',
         21, 22, 0, '0.002100',
         false, 'apikey', 100, 200, '2026-06-15 12:00:00+00')
    `;

    const result = await batchGetRequestAuditStats([
      { resolvedUserId: userId, month: '2026-01' },
      { resolvedUserId: userId, month: '2026-06' },
    ]);

    expect(result.get(`${userId}:2026-01`)?.totalTokensInput).toBe(11);
    expect(result.get(`${userId}:2026-01`)?.totalTokensOutput).toBe(12);
    expect(result.get(`${userId}:2026-06`)?.totalTokensInput).toBe(21);
    expect(result.get(`${userId}:2026-06`)?.totalTokensOutput).toBe(22);
  });
});
