#!/usr/bin/env bun
import { sql } from '../src/db/client';
import { logger } from '../src/observability/logger';

const APPLY = process.argv.includes('--apply');

interface ArchiveRow {
  user_id: string;
  month: string;
  total_requests: number;
  total_tokens_input: number;
  total_tokens_output: number;
  total_tokens_thinking: number;
}

interface RecomputedStats {
  total_requests: number;
  total_tokens_input: number;
  total_tokens_output: number;
  total_tokens_thinking: number;
}

async function main(): Promise<void> {
  logger.info({ apply: APPLY }, 'Starting usage_history backfill');

  const archiveRows = await sql<ArchiveRow[]>`
    SELECT
      user_id::text AS user_id,
      month,
      total_requests,
      total_tokens_input,
      total_tokens_output,
      total_tokens_thinking
    FROM usage_history
    ORDER BY month, user_id
  `;

  logger.info({ count: archiveRows.length }, 'Loaded archive rows');

  let candidates = 0;
  let updates = 0;

  for (const row of archiveRows) {
    const year = Number.parseInt(row.month.substring(0, 4), 10);
    const monthNum = Number.parseInt(row.month.substring(5, 7), 10);

    const stats = await sql<RecomputedStats[]>`
      SELECT
        COUNT(*)::int AS total_requests,
        COALESCE(SUM(tokens_input), 0)::int AS total_tokens_input,
        COALESCE(SUM(tokens_output), 0)::int AS total_tokens_output,
        COALESCE(SUM(tokens_thinking), 0)::int AS total_tokens_thinking
      FROM request_audit
      WHERE user_id = ${row.user_id}
        AND created_at >= make_date(${year}, ${monthNum}, 1)
        AND created_at < make_date(${year}, ${monthNum}, 1) + INTERVAL '1 month'
    `;

    const recomputed = stats[0];
    if (!recomputed || recomputed.total_requests === 0) continue;

    const drift =
      recomputed.total_requests !== row.total_requests ||
      recomputed.total_tokens_input !== row.total_tokens_input ||
      recomputed.total_tokens_output !== row.total_tokens_output ||
      recomputed.total_tokens_thinking !== row.total_tokens_thinking;

    if (!drift) continue;

    candidates++;

    logger.info(
      {
        userId: row.user_id,
        month: row.month,
        before: {
          requests: row.total_requests,
          input: row.total_tokens_input,
          output: row.total_tokens_output,
          thinking: row.total_tokens_thinking,
        },
        after: recomputed,
      },
      'Drift detected'
    );

    if (APPLY) {
      await sql`
        UPDATE usage_history
        SET total_requests = ${recomputed.total_requests},
            total_tokens_input = ${recomputed.total_tokens_input},
            total_tokens_output = ${recomputed.total_tokens_output},
            total_tokens_thinking = ${recomputed.total_tokens_thinking}
        WHERE user_id = ${row.user_id} AND month = ${row.month}
      `;
      updates++;
    }
  }

  logger.info({ candidates, updates, apply: APPLY }, 'Backfill complete');
  await sql.end();
  process.exit(0);
}

main().catch(async (err) => {
  logger.error({ err }, 'Backfill failed');
  try {
    await sql.end();
  } catch {
    void 0;
  }
  process.exit(1);
});
