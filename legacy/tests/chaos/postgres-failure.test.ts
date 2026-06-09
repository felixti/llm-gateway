/**
 * Chaos: PostgreSQL failure injection.
 *
 * Replaces the prior happy-path stubs with real failure injection against
 * the shared `database.execute` wrapper. Asserts that audit logging and
 * quota-policy lookups degrade without throwing so request handling is
 * never coupled to Postgres availability.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import database from '../../src/db/client';
import { getUserQuotaPolicyByPatSubject, logRequestAudit } from '../../src/db/data-access';

type ExecuteFn = typeof database.execute;

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

function failingExecute(message = 'ECONNREFUSED 127.0.0.1:5432'): ExecuteFn {
  return (async () => {
    throw new Error(message);
  }) as ExecuteFn;
}

describe('Chaos: PostgreSQL Failure', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'test';
  });

  afterEach(() => {
    restoreExecute();
  });

  it('logRequestAudit swallows Postgres failures (fire-and-forget semantics)', async () => {
    patchExecute(failingExecute('timeout expired'));

    // MUST NOT throw — audit failures must not block the request path.
    await logRequestAudit({
      userId: 'chaos-user',
      requestId: `req-${Date.now()}`,
      model: 'gpt-5-mini',
      deployment: 'gpt-5-mini',
      protocolFamily: 'chat-completions',
      tokensInput: 10,
      tokensOutput: 20,
      tokensThinking: 0,
      costUsd: '0.000123',
      thinkingEnabled: false,
      azureAuthType: 'api-key',
      durationMs: 150,
      statusCode: 200,
    });
  });

  it('getUserQuotaPolicyByPatSubject returns null when Postgres rejects', async () => {
    patchExecute(failingExecute('connection terminated unexpectedly'));

    const policy = await getUserQuotaPolicyByPatSubject('chaos-user');
    expect(policy).toBeNull();
  });

  it('getUserQuotaPolicyByPatSubject returns null when query returns zero rows', async () => {
    patchExecute((async () => ({ rows: [], rowCount: 0 })) as unknown as ExecuteFn);

    const policy = await getUserQuotaPolicyByPatSubject('unknown-subject');
    expect(policy).toBeNull();
  });
});
