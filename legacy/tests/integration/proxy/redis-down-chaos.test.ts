import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { DeploymentConfig } from '../../../src/config/deployments';
import { sql } from '../../../src/db/client';
import { redis } from '../../../src/db/redis';
import { getPrometheusMetrics } from '../../../src/observability/metrics';
import { finalizeProxyUsage } from '../../../src/proxy/shared';
import {
  checkAndReserve,
  type QuotaReservation,
} from '../../../src/services/quota.service';
import { runReconcilerJob } from '../../../src/services/scheduler.service';
import { Decimal } from 'decimal.js';
import { randomUUID } from 'node:crypto';

const fakeDeployment: DeploymentConfig = {
  name: 'test-deployment',
  modelAlias: 'gpt-5-mini',
  modelFamily: 'gpt',
  protocolFamily: 'chat-completions',
  azureModelName: 'gpt-5-mini',
  endpoint: 'https://example.invalid',
  authConfig: { type: 'api-key', apiKey: 'fake', keyHeader: 'api-key' },
  apiVersion: '2024-02-15',
  enabled: true,
};

let hasPostgres = false;
try {
  await sql`SELECT 1`;
  hasPostgres = true;
} catch {
  hasPostgres = false;
}

const describeOrSkip = hasPostgres ? describe : describe.skip;

function unbilledCount(): number {
  const text = getPrometheusMetrics();
  const line = text.split('\n').find((l) => l.startsWith('unbilled_requests_total '));
  return line ? Number(line.split(' ')[1]) : 0;
}

describeOrSkip('Streaming reconcile fail-closed (Redis-down chaos)', () => {
  let walDir: string;
  let originalWalDir: string | undefined;
  const userId = randomUUID();
  const testUserPatId = `chaos-${userId}`;

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
      INSERT INTO users (id, email, pat_subject, monthly_budget_usd, hard_limit)
      VALUES (${userId}, ${`chaos-${userId}@x.test`}, ${testUserPatId}, 100, true)
      ON CONFLICT (id) DO NOTHING
    `;
  });

  beforeEach(() => {
    walDir = mkdtempSync(join(tmpdir(), 'chaos-wal-'));
    originalWalDir = process.env.WAL_DIR;
    process.env.WAL_DIR = walDir;
  });

  afterEach(async () => {
    rmSync(walDir, { recursive: true, force: true });
    if (originalWalDir === undefined) delete process.env.WAL_DIR;
    else process.env.WAL_DIR = originalWalDir;
    await sql`DELETE FROM request_audit WHERE user_id = ${userId}`;
  });

  afterAll(async () => {
    await sql`DELETE FROM request_audit WHERE user_id = ${userId}`;
    await sql`DELETE FROM users WHERE id = ${userId}`;
  });

  test('Redis fail + PG OK → audit written, no WAL, no throw', async () => {
    const reservation: QuotaReservation = await checkAndReserve(
      testUserPatId,
      new Decimal('0.01')
    );
    expect(reservation.allowed).toBe(true);

    const originalEval = redis.eval.bind(redis);
    redis.eval = (async () => {
      throw new Error('simulated Redis outage');
    }) as unknown as typeof redis.eval;

    const before = unbilledCount();

    try {
      await finalizeProxyUsage({
        usage: { prompt_tokens: 100, completion_tokens: 50 },
        reservationId: reservation.reservationId!,
        requestId: `req-redisfail-${randomUUID()}`,
        userId: testUserPatId,
        deployment: fakeDeployment,
        startTime: Date.now() - 100,
      });
    } finally {
      redis.eval = originalEval;
    }

    const walFiles = readdirSync(walDir).filter((f) => f.endsWith('.json'));
    expect(walFiles).toHaveLength(0);

    const auditRows = (await sql`
      SELECT cost_usd::text AS cost FROM request_audit WHERE user_id = ${userId}
    `) as unknown as Array<{ cost: string }>;
    expect(auditRows.length).toBeGreaterThanOrEqual(1);

    expect(unbilledCount()).toBe(before);
  });

  test('Redis OK + PG fail → WAL written, metric incremented, no throw', async () => {
    const reservation: QuotaReservation = await checkAndReserve(
      testUserPatId,
      new Decimal('0.01')
    );
    expect(reservation.allowed).toBe(true);

    const originalUnsafe = sql.unsafe.bind(sql);
    sql.unsafe = (async () => {
      throw new Error('simulated Postgres outage');
    }) as unknown as typeof sql.unsafe;

    const before = unbilledCount();
    const reqId = `req-pgfail-${randomUUID()}`;

    try {
      await finalizeProxyUsage({
        usage: { prompt_tokens: 100, completion_tokens: 50 },
        reservationId: reservation.reservationId!,
        requestId: reqId,
        userId: testUserPatId,
        deployment: fakeDeployment,
        startTime: Date.now() - 100,
      });
    } finally {
      sql.unsafe = originalUnsafe;
    }

    const walFiles = readdirSync(walDir).filter((f) => f.endsWith('.json'));
    expect(walFiles).toHaveLength(1);
    const walContent = JSON.parse(readFileSync(join(walDir, walFiles[0]), 'utf8'));
    expect(walContent.requestId).toBe(reqId);
    expect(walContent.reason).toBe('pg_fail');
    expect(walContent.tokensInput).toBe(100);
    expect(walContent.tokensOutput).toBe(50);

    expect(unbilledCount()).toBe(before + 1);
  }, 5000);

  test('Both Redis + PG fail → WAL written, metric incremented, throws QuotaReconciliationError', async () => {
    const reservation: QuotaReservation = await checkAndReserve(
      testUserPatId,
      new Decimal('0.01')
    );
    expect(reservation.allowed).toBe(true);

    const originalEval = redis.eval.bind(redis);
    const originalUnsafe = sql.unsafe.bind(sql);
    redis.eval = (async () => {
      throw new Error('simulated Redis outage');
    }) as unknown as typeof redis.eval;
    sql.unsafe = (async () => {
      throw new Error('simulated Postgres outage');
    }) as unknown as typeof sql.unsafe;

    const before = unbilledCount();
    const reqId = `req-bothfail-${randomUUID()}`;
    let thrown: Error | null = null;

    try {
      await finalizeProxyUsage({
        usage: { prompt_tokens: 50, completion_tokens: 25 },
        reservationId: reservation.reservationId!,
        requestId: reqId,
        userId: testUserPatId,
        deployment: fakeDeployment,
        startTime: Date.now() - 100,
      });
    } catch (err) {
      thrown = err as Error;
    } finally {
      redis.eval = originalEval;
      sql.unsafe = originalUnsafe;
    }

    expect(thrown).not.toBeNull();
    expect(thrown?.name).toBe('QuotaReconciliationError');

    const walFiles = readdirSync(walDir).filter((f) => f.endsWith('.json'));
    expect(walFiles).toHaveLength(1);
    const walContent = JSON.parse(readFileSync(join(walDir, walFiles[0]), 'utf8'));
    expect(walContent.requestId).toBe(reqId);
    expect(walContent.reason).toBe('both_fail');

    expect(unbilledCount()).toBe(before + 1);
  }, 5000);

  test('Reconciler job rebuilds Redis spent from Postgres audit', async () => {
    const month = new Date().toISOString().substring(0, 7);
    const quotaKey = `quota:${testUserPatId}:${month}`;

    await redis.del(quotaKey);
    await redis.hset(quotaKey, { budget: '100000000', spent: '0', hard_limit: '1' });

    const reqId = `req-reconcile-${randomUUID()}`;
    await sql`
      INSERT INTO request_audit
        (request_id, user_id, model, deployment, protocol_family,
         tokens_input, tokens_output, tokens_thinking, cost_usd,
         thinking_enabled, azure_auth_type, duration_ms, status_code, created_at)
      VALUES
        (${reqId}, ${userId}, 'gpt-4o', 'gpt-4o', 'openai',
         100, 50, 0, '0.500000',
         false, 'apikey', 100, 200, NOW())
    `;

    await runReconcilerJob();

    const after = await redis.hget(quotaKey, 'spent');
    expect(after).toBe('500000');

    await redis.del(quotaKey);
  }, 10000);
});
