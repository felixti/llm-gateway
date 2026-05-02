/**
 * PostgreSQL Data Access Layer
 * Provides async, fire-and-forget audit logging and usage archival
 */

import { logger } from '@/observability/logger';
import { database } from './client';

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
 * Log request audit record to PostgreSQL
 * Fire-and-forget with error logging - does not block the request
 */
export async function logRequestAudit(record: RequestAuditRecord): Promise<void> {
  const query = `
    INSERT INTO request_audit (
      user_id, request_id, model, deployment, protocol_family,
      tokens_input, tokens_output, tokens_thinking, cost_usd,
      thinking_enabled, azure_auth_type, duration_ms, status_code, error_message
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
  `;

  const params = [
    record.userId,
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
 * Archive monthly usage from Redis to PostgreSQL
 * Uses UPSERT to handle re-runs gracefully
 */
export async function archiveMonthlyUsage(record: UsageArchiveRecord): Promise<void> {
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
    record.userId,
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
  const query = `
    SELECT
      COUNT(*) AS total_requests,
      COALESCE(SUM(tokens_input), 0) AS total_tokens_input,
      COALESCE(SUM(tokens_output), 0) AS total_tokens_output,
      COALESCE(SUM(tokens_thinking), 0) AS total_tokens_thinking
    FROM request_audit
    WHERE user_id = $1 AND to_char(created_at, 'YYYY-MM') = $2
  `;

  try {
    const { rows } = await database.execute<{
      total_requests: string;
      total_tokens_input: string;
      total_tokens_output: string;
      total_tokens_thinking: string;
    }>({ query, params: [userId, month] });

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
