import { env } from '@/config/env';
import { logger } from '@/observability/logger';
import postgres from 'postgres';

const connectionString = env.DATABASE_URL || 'postgres://localhost:5432/postgres';

export const sql = postgres(connectionString, {
  max: 20,
  idle_timeout: 30,
  connect_timeout: 10,
  prepare: true,
  transform: {
    undefined: null,
  },
});

export const database = {
  async execute<T extends Record<string, unknown>>({
    query,
    params = [],
  }: {
    query: string;
    params?: unknown[];
  }): Promise<{ rows: T[]; rowCount: number }> {
    try {
      const rows = await sql.unsafe<T[]>(query, params as never[]);
      return {
        rows: Array.isArray(rows) ? rows : [],
        rowCount: Array.isArray(rows) ? rows.length : 0,
      };
    } catch (error) {
      logger.error({ error }, 'Database query failed');
      throw error;
    }
  },

  getConnection() {
    return sql;
  },
};

export async function isPostgresHealthy(): Promise<boolean> {
  try {
    const result = await sql`SELECT 1 AS healthy`;
    return result.length > 0 && result[0].healthy === 1;
  } catch {
    return false;
  }
}

export async function closeDatabase(): Promise<void> {
  await sql.end();
}

export default database;
