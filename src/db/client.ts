/**
 * PostgreSQL Database Client
 * Uses Bun's built-in SQL support from "bun" module
 */
import { SQL } from "bun";

// Create database connection
const connectionString = process.env.DATABASE_URL || "postgres://localhost:5432/postgres";

export const db = new SQL(connectionString);

// Database client wrapper with typed methods
export const database = {
  /**
   * Execute a parameterized query using sql.unsafe
   * Note: Bun.sql uses .unsafe() for parameterized queries
   */
  async execute<T extends Record<string, unknown>>({
    query,
    params = [],
  }: {
    query: string;
    params?: unknown[];
  }): Promise<{ rows: T[]; rowCount: number }> {
    try {
      // Bun.sql.unsafe returns a Query that resolves to array of results
      const rows = await db.unsafe<T[]>(query, params);
      return {
        rows: Array.isArray(rows) ? rows : [],
        rowCount: Array.isArray(rows) ? rows.length : 0,
      };
    } catch (error) {
      console.error("Database query failed:", error);
      throw error;
    }
  },

  /**
   * Get the underlying connection for transactions
   */
  getConnection() {
    return db;
  },
};

export default database;
