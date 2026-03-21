/**
 * Redis Client
 * Uses Bun's built-in Redis support (Bun.redis global)
 */
import { redis } from "bun";

// Health check function
export async function isRedisHealthy(): Promise<boolean> {
  try {
    const result = await redis.ping();
    return result === "PONG";
  } catch {
    return false;
  }
}

// Re-export for convenience
export { redis };
