/**
 * PostgreSQL Data Access Layer
 * Provides async, fire-and-forget audit logging and usage archival
 */

import { logger } from '@/observability/logger';
import { database } from './client';

// UUID validation regex (v4 + generic 8-4-4-4-12 hex pattern)
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

import { redis } from './redis';

const PAT_SUBJECT_CACHE_TTL_SECONDS = 300;
const PAT_SUBJECT_CACHE_PREFIX = 'pat_subject:';

/**
 * Resolve a PAT subject (userId) to a UUID for PostgreSQL columns.
 * If already a valid UUID, returns it directly.
 * Otherwise, looks up users.pat_subject to find the corresponding user UUID.
 * Caches non-UUID resolutions in Redis to avoid repeated Postgres hits.
 * Returns null if resolution fails (non-UUID with no pat_subject match).
 */
async function resolveUserIdToUuid(patSubject: string): Promise<string | null> {
  if (UUID_REGEX.test(patSubject)) {
    return patSubject;
  }

  const cacheKey = `${PAT_SUBJECT_CACHE_PREFIX}${patSubject}`;
  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      return cached;
    }
  } catch {
    void 0;
  }

  try {
    const { rows } = await database.execute<{ id: string }>({
      query: 'SELECT id::text AS id FROM users WHERE pat_subject = $1 LIMIT 1',
      params: [patSubject],
    });

    if (rows.length > 0) {
      const userId = rows[0].id;
      try {
        await redis.setex(cacheKey, PAT_SUBJECT_CACHE_TTL_SECONDS, userId);
      } catch {
        void 0;
      }
      return userId;
    }

    logger.warn('Cannot resolve non-UUID userId to user UUID', { patSubject });
    return null;
  } catch (error) {
    logger.error('Failed to resolve userId to UUID', { patSubject, error });
    return null;
  }
}

/**
 * Batch-resolve an array of PAT subjects to UUIDs in a single query.
 * Returns a Map<patSubject, uuid|null>.
 */
export async function batchResolveUserIds(
  patSubjects: string[]
): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>();

  if (patSubjects.length === 0) return result;

  // Pre-populate with subjects that are already valid UUIDs
  const nonUuidSubjects: string[] = [];
  for (const subject of patSubjects) {
    if (UUID_REGEX.test(subject)) {
      result.set(subject, subject);
    } else {
      result.set(subject, null);
      nonUuidSubjects.push(subject);
    }
  }

  if (nonUuidSubjects.length === 0) return result;

  try {
    const { rows } = await database.execute<{ pat_subject: string; id: string }>({
      query: 'SELECT pat_subject, id::text AS id FROM users WHERE pat_subject = ANY($1)',
      params: [nonUuidSubjects],
    });

    for (const row of rows) {
      result.set(row.pat_subject, row.id);
    }

    // Warn about unresolved subjects
    for (const subject of nonUuidSubjects) {
      if (result.get(subject) === null) {
        logger.warn('Cannot resolve non-UUID userId to user UUID (batch)', { patSubject: subject });
      }
    }
  } catch (error) {
    logger.error('Failed to batch-resolve userIds', { error });
  }

  return result;
}

/**
 * Batch-fetch audit stats for multiple user_id + month combinations.
 * Returns a Map keyed by `${resolvedUserId}:${month}`.
 */
export async function batchGetRequestAuditStats(
  entries: Array<{ resolvedUserId: string; month: string }>
): Promise<Map<string, AuditStats>> {
  const result = new Map<string, AuditStats>();

  if (entries.length === 0) return result;

  const userIds = [...new Set(entries.map((e) => e.resolvedUserId))];
  const uniqueMonths = [...new Set(entries.map((e) => e.month))];

  try {
    const query = `
      SELECT
        user_id::text AS user_id,
        to_char(created_at, 'YYYY-MM') AS month,
        COUNT(*) AS total_requests,
        COALESCE(SUM(tokens_input), 0) AS total_tokens_input,
        COALESCE(SUM(tokens_output), 0) AS total_tokens_output,
        COALESCE(SUM(tokens_thinking), 0) AS total_tokens_thinking
      FROM request_audit
      WHERE user_id = ANY($1)
        AND to_char(created_at, 'YYYY-MM') = ANY($2)
      GROUP BY user_id, to_char(created_at, 'YYYY-MM')
    `;

    const { rows } = await database.execute<{
      user_id: string;
      month: string;
      total_requests: string;
      total_tokens_input: string;
      total_tokens_output: string;
      total_tokens_thinking: string;
    }>({ query, params: [userIds, uniqueMonths] });

    for (const row of rows) {
      result.set(`${row.user_id}:${row.month}`, {
        totalRequests: Number(row.total_requests),
        totalTokensInput: Number(row.total_tokens_input),
        totalTokensOutput: Number(row.total_tokens_output),
        totalTokensThinking: Number(row.total_tokens_thinking),
      });
    }
  } catch (error) {
    logger.error('Failed to batch-query request audit stats', { error });
  }

  return result;
}

/**
 * Batch-upsert monthly usage archive records in a single query.
 * Uses unnest for efficient multi-row INSERT ... ON CONFLICT.
 */
export async function batchArchiveMonthlyUsage(
  records: Array<UsageArchiveRecord & { resolvedUserId: string }>
): Promise<void> {
  if (records.length === 0) return;

  const userIds = records.map((r) => r.resolvedUserId);
  const months = records.map((r) => r.month);
  const totalRequests = records.map((r) => r.totalRequests);
  const totalTokensInput = records.map((r) => r.totalTokensInput);
  const totalTokensOutput = records.map((r) => r.totalTokensOutput);
  const totalTokensThinking = records.map((r) => r.totalTokensThinking);
  const totalCostUsd = records.map((r) => r.totalCostUsd);

  try {
    await database.execute({
      query: `
        INSERT INTO usage_history (
          user_id, month, total_requests, total_tokens_input,
          total_tokens_output, total_tokens_thinking, total_cost_usd
        )
        SELECT * FROM unnest(
          $1::uuid[], $2::text[], $3::bigint[], $4::bigint[],
          $5::bigint[], $6::bigint[], $7::numeric[]
        )
        ON CONFLICT (user_id, month) DO UPDATE SET
          total_requests = EXCLUDED.total_requests,
          total_tokens_input = EXCLUDED.total_tokens_input,
          total_tokens_output = EXCLUDED.total_tokens_output,
          total_tokens_thinking = EXCLUDED.total_tokens_thinking,
          total_cost_usd = EXCLUDED.total_cost_usd
      `,
      params: [
        userIds,
        months,
        totalRequests,
        totalTokensInput,
        totalTokensOutput,
        totalTokensThinking,
        totalCostUsd,
      ],
    });
  } catch (error) {
    logger.error('Failed to batch-archive monthly usage', {
      count: records.length,
      error,
    });
    throw error;
  }
}

// Types for audit records
interface RequestAuditRecord {
  userId: string;
  requestId: string;
  model: string;
  deployment: string;
  protocolFamily: string;
  tokensInput: number;
  tokensOutput: number;
  tokensThinking: number;
  costUsd: string;
  thinkingEnabled: boolean;
  azureAuthType: string;
  durationMs: number;
  statusCode: number;
  errorMessage?: string;
}

interface UsageArchiveRecord {
  userId: string;
  month: string;
  totalRequests: number;
  totalTokensInput: number;
  totalTokensOutput: number;
  totalTokensThinking: number;
  totalCostUsd: string;
}

export interface AuditStats {
  totalRequests: number;
  totalTokensInput: number;
  totalTokensOutput: number;
  totalTokensThinking: number;
}

interface PatRevocationRecord {
  patId: string;
  revokedBy: string;
  reason?: string;
}

export interface PatExpiryRecord {
  expiresAt: Date | null;
}

/** Monthly quota policy from Postgres (authoritative); keyed by PAT user id / pat_subject / users.id */
export interface UserQuotaPolicy {
  monthly_budget_usd: string;
  hard_limit: boolean;
}

/**
 * Load quota policy for a PAT subject. Matches users.pat_subject, or users.id::text (UUID strings).
 */
export async function getUserQuotaPolicyByPatSubject(
  patSubject: string
): Promise<UserQuotaPolicy | null> {
  const query = `
    SELECT monthly_budget_usd::text AS monthly_budget_usd, COALESCE(hard_limit, true) AS hard_limit
    FROM users
    WHERE pat_subject = $1 OR id::text = $1
    LIMIT 1
  `;

  try {
    const { rows } = await database.execute<{
      monthly_budget_usd: string;
      hard_limit: boolean;
    }>({ query, params: [patSubject] });

    if (!rows.length) {
      return null;
    }

    const row = rows[0];
    return {
      monthly_budget_usd: row.monthly_budget_usd,
      hard_limit: row.hard_limit,
    };
  } catch (error) {
    logger.error('Failed to load user quota policy', { patSubject, error });
    return null;
  }
}

/**
 * Log request audit record to PostgreSQL.
 * Resolves non-UUID userId via users.pat_subject before inserting.
 * Skips insert (warns) if userId cannot be resolved to a valid UUID.
 */
export async function logRequestAudit(record: RequestAuditRecord): Promise<void> {
  const resolvedUserId = await resolveUserIdToUuid(record.userId);

  if (!resolvedUserId) {
    logger.warn('Skipping audit log: userId is not a valid UUID and has no pat_subject mapping', {
      requestId: record.requestId,
      userId: record.userId,
    });
    return;
  }

  const query = `
    INSERT INTO request_audit (
      user_id, request_id, model, deployment, protocol_family,
      tokens_input, tokens_output, tokens_thinking, cost_usd,
      thinking_enabled, azure_auth_type, duration_ms, status_code, error_message
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
  `;

  const params = [
    resolvedUserId,
    record.requestId,
    record.model,
    record.deployment,
    record.protocolFamily,
    record.tokensInput,
    record.tokensOutput,
    record.tokensThinking,
    record.costUsd,
    record.thinkingEnabled,
    record.azureAuthType,
    record.durationMs,
    record.statusCode,
    record.errorMessage ?? null,
  ];

  try {
    await database.execute({ query, params });
  } catch (error) {
    logger.error('Failed to log request audit', { requestId: record.requestId, error });
  }
}

/**
 * Archive monthly usage from Redis to PostgreSQL.
 * Resolves non-UUID userId via users.pat_subject before upserting.
 * Uses UPSERT to handle re-runs gracefully
 */
export async function archiveMonthlyUsage(record: UsageArchiveRecord): Promise<void> {
  const resolvedUserId = await resolveUserIdToUuid(record.userId);

  if (!resolvedUserId) {
    logger.warn(
      'Skipping usage archive: userId is not a valid UUID and has no pat_subject mapping',
      {
        userId: record.userId,
        month: record.month,
      }
    );
    return;
  }

  const query = `
    INSERT INTO usage_history (
      user_id, month, total_requests, total_tokens_input,
      total_tokens_output, total_tokens_thinking, total_cost_usd
    ) VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (user_id, month) DO UPDATE SET
      total_requests = EXCLUDED.total_requests,
      total_tokens_input = EXCLUDED.total_tokens_input,
      total_tokens_output = EXCLUDED.total_tokens_output,
      total_tokens_thinking = EXCLUDED.total_tokens_thinking,
      total_cost_usd = EXCLUDED.total_cost_usd
  `;

  const params = [
    resolvedUserId,
    record.month,
    record.totalRequests,
    record.totalTokensInput,
    record.totalTokensOutput,
    record.totalTokensThinking,
    record.totalCostUsd,
  ];

  try {
    await database.execute({ query, params });
  } catch (error) {
    logger.error('Failed to archive monthly usage', {
      userId: record.userId,
      month: record.month,
      error,
    });
    throw error;
  }
}

export async function getRequestAuditStats(userId: string, month: string): Promise<AuditStats> {
  const resolvedUserId = await resolveUserIdToUuid(userId);

  if (!resolvedUserId) {
    return { totalRequests: 0, totalTokensInput: 0, totalTokensOutput: 0, totalTokensThinking: 0 };
  }

  const query = `
    SELECT
      COUNT(*) AS total_requests,
      COALESCE(SUM(tokens_input), 0) AS total_tokens_input,
      COALESCE(SUM(tokens_output), 0) AS total_tokens_output,
      COALESCE(SUM(tokens_thinking), 0) AS total_tokens_thinking
    FROM request_audit
    WHERE user_id = $1
      AND created_at >= to_date($2, 'YYYY-MM')
      AND created_at < to_date($2, 'YYYY-MM') + INTERVAL '1 month'
  `;

  try {
    const { rows } = await database.execute<{
      total_requests: string;
      total_tokens_input: string;
      total_tokens_output: string;
      total_tokens_thinking: string;
    }>({ query, params: [resolvedUserId, month] });

    const row = rows[0];
    return {
      totalRequests: Number(row?.total_requests ?? 0),
      totalTokensInput: Number(row?.total_tokens_input ?? 0),
      totalTokensOutput: Number(row?.total_tokens_output ?? 0),
      totalTokensThinking: Number(row?.total_tokens_thinking ?? 0),
    };
  } catch (error) {
    logger.error('Failed to query request audit stats', { userId, month, error });
    return { totalRequests: 0, totalTokensInput: 0, totalTokensOutput: 0, totalTokensThinking: 0 };
  }
}

/**
 * Log PAT revocation event to PostgreSQL
 */
export async function logPatRevocation(record: PatRevocationRecord): Promise<void> {
  const query = `
    INSERT INTO pat_revocation_log (pat_id, revoked_by, reason)
    VALUES ($1, $2, $3)
  `;

  const params = [record.patId, record.revokedBy, record.reason ?? null];

  try {
    await database.execute({ query, params });
  } catch (error) {
    logger.error('Failed to log PAT revocation', { patId: record.patId, error });
    throw error;
  }
}

export async function getPatExpiryForRevocation(patId: string): Promise<PatExpiryRecord | null> {
  const query = `
    SELECT expires_at
    FROM api_keys
    WHERE jti = $1 OR id::text = $1
    LIMIT 1
  `;

  const { rows } = await database.execute<{ expires_at: Date | string | null }>({
    query,
    params: [patId],
  });

  if (!rows.length) {
    return null;
  }

  const expiresAt = rows[0].expires_at;
  return {
    expiresAt: expiresAt ? new Date(expiresAt) : null,
  };
}

/**
 * Look up a PAT by its jti or id.
 * Returns the api_keys record with id and jti if found.
 */
export async function getApiKeyByJti(jti: string): Promise<{ id: string; jti: string } | null> {
  const query = `
    SELECT id::text AS id, jti
    FROM api_keys
    WHERE jti = $1 OR id::text = $1
    LIMIT 1
  `;

  const { rows } = await database.execute<{ id: string; jti: string }>({
    query,
    params: [jti],
  });

  return rows[0] || null;
}
