/**
 * Chaos: Partial Commit scenarios.
 *
 * Tests that the gateway remains operational when Redis succeeds
 * but Postgres operations fail. Redis is the primary mechanism for
 * quota enforcement; Postgres is for audit and policy authority.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import database from '../../src/db/client';
import { logRequestAudit, getUserQuotaPolicyByPatSubject } from '../../src/db/data-access';
import { checkAndReserve, getQuotaStatus } from '../../src/services/quota.service';
import { createTestApp } from '../integration/helpers/test-app';
import { createTestPat } from '../integration/helpers/test-pat';
import { Decimal } from 'decimal.js';

type ExecuteFn = typeof database.execute;

const VALID_PAT = createTestPat('user1');

let originalExecute: ExecuteFn | null = null;

function patchExecute(replacement: ExecuteFn): void {
  if (originalExecute === null) {
    originalExecute = database.execute.bind(database);
  }
  (database as { execute: ExecuteFn }).execute = replacement;
}

function restoreExecute(): void {
  if (originalExecute !== null) {
    (database as { execute: ExecuteFn }).execute = originalExecute;
    originalExecute = null;
  }
}

describe('Chaos: Partial Commit', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'test';
  });

  afterEach(() => {
    restoreExecute();
    delete process.env.QUOTA_PG_SYNC_IN_TESTS;
  });

  it('logRequestAudit swallows Postgres failure without throwing', async () => {
    let auditAttempts = 0;
    patchExecute((async ({ query }: { query: string; params?: unknown[] }) => {
      if (String(query).includes('request_audit')) {
        auditAttempts++;
        throw new Error('Postgres connection lost');
      }
      return { rows: [], rowCount: 0 };
    }) as unknown as ExecuteFn);

    await logRequestAudit({
      userId: '550e8400-e29b-41d4-a716-446655440000',
      requestId: `req-${Date.now()}`,
      model: 'gpt-5.4',
      deployment: 'gpt-5.4-global',
      protocolFamily: 'chat-completions',
      tokensInput: 10,
      tokensOutput: 5,
      tokensThinking: 0,
      costUsd: '0.000030',
      thinkingEnabled: false,
      azureAuthType: 'api-key',
      durationMs: 100,
      statusCode: 200,
    });

    expect(auditAttempts).toBeGreaterThan(0);
  });

  it('checkAndReserve succeeds when Redis is healthy (Postgres sync skipped in test env)', async () => {
    patchExecute((async () => {
      throw new Error('Postgres totally down');
    }) as unknown as ExecuteFn);

    const reservation = await checkAndReserve('chaos-user', new Decimal(0.01));
    expect(reservation.allowed).toBe(true);
    expect(reservation.reservationId).toBeDefined();
  });

  it('getQuotaStatus returns defaults when Postgres policy sync is enabled but fails', async () => {
    process.env.QUOTA_PG_SYNC_IN_TESTS = 'true';
    patchExecute((async ({ query }: { query: string; params?: unknown[] }) => {
      if (String(query).includes('users')) {
        throw new Error('Postgres policy query timeout');
      }
      return { rows: [], rowCount: 0 };
    }) as unknown as ExecuteFn);

    const status = await getQuotaStatus('chaos-user');
    expect(status.monthly_budget_usd).toBeGreaterThan(0);
    expect(status.spent_usd).toBeGreaterThanOrEqual(0);
    expect(status.hard_limit).toBe(true);
  });

  it('getUserQuotaPolicyByPatSubject returns null on Postgres failure', async () => {
    patchExecute((async () => {
      throw new Error('Postgres unavailable');
    }) as unknown as ExecuteFn);

    const policy = await getUserQuotaPolicyByPatSubject('chaos-user');
    expect(policy).toBeNull();
  });

  it('full request succeeds when Redis works but Postgres audit fails', async () => {
    let auditAttempts = 0;
    patchExecute((async ({ query }: { query: string; params?: unknown[] }) => {
      if (String(query).includes('request_audit')) {
        auditAttempts++;
        throw new Error('Postgres audit write failed');
      }
      return { rows: [], rowCount: 0 };
    }) as unknown as ExecuteFn);

    const app = await createTestApp();
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: createTestPat('550e8400-e29b-41d4-a716-446655440000'),
      },
      body: JSON.stringify({
        model: 'gpt-5.4',
        messages: [{ role: 'user', content: 'test' }],
      }),
    });

    expect(res.status).toBe(200);
    expect(auditAttempts).toBeGreaterThan(0);
  });

  it('full request succeeds when Redis works but all Postgres queries fail', async () => {
    process.env.QUOTA_PG_SYNC_IN_TESTS = 'true';
    patchExecute((async () => {
      throw new Error('Postgres completely unavailable');
    }) as unknown as ExecuteFn);

    const app = await createTestApp();
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: VALID_PAT,
      },
      body: JSON.stringify({
        model: 'gpt-5.4',
        messages: [{ role: 'user', content: 'test' }],
      }),
    });

    expect(res.status).toBe(200);
  });
});
