import postgres from 'postgres';
import { env } from '../config/env';
import { logger } from '../observability/logger';

const connectionString = env.DATABASE_URL || 'postgres://localhost:5432/postgres';

export const sql = postgres(connectionString, {
  max: 10,
  idle_timeout: 20,
  connect_timeout: 10,
  prepare: false,
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
      logger.error('Database query failed', { error });
      throw error;
    }
  },

  getConnection() {
    return sql;
  },
};

export async function closeDatabase(): Promise<void> {
  await sql.end();
}

export default database;
