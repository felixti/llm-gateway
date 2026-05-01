/**
 * In-memory Redis mock for integration tests.
 * Replaces the ioredis singleton so tests run without a live Redis server.
 */

export class MockRedis {
  private store = new Map<string, string>();
  private hashes = new Map<string, Map<string, string>>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: string | number | Buffer, ..._args: unknown[]): Promise<void> {
    // Support both redis.set(key, value) and redis.set(key, value, 'EX', seconds)
    this.store.set(key, String(value));
  }

  async setex(key: string, _ttl: number, value: string | number | Buffer): Promise<void> {
    this.store.set(key, String(value));
  }

  async eval(script: string, _numKeys: number, ...args: (string | number)[]): Promise<unknown> {
    // Rate-limit scripts (use sorted sets)
    if (script.includes('zremrangebyscore') || script.includes('zcard')) {
      return [1, 0];
    }

    // Quota check-and-reserve scripts
    if (script.includes('monthly_budget') || script.includes('reserved')) {
      return [1, 0];
    }

    // Circuit breaker: record failure
    if (script.includes('threshold')) {
      const key = args[0] as string;
      const now = Number(args[1]);
      const threshold = Number(args[2]);
      const resetTimeout = Number(args[3]);

      const map = this.hashes.get(key);
      const currentState = map?.get('state') || 'CLOSED';
      const failureCount = Number(map?.get('failureCount') || 0) + 1;

      this.hset(key, { failureCount: String(failureCount), lastFailureTime: String(now) });

      if (currentState === 'CLOSED' && failureCount >= threshold) {
        this.hset(key, { state: 'OPEN', nextAttemptTime: String(now + resetTimeout) });
        return 2;
      }
      if (currentState === 'HALF_OPEN') {
        this.hset(key, { state: 'OPEN', nextAttemptTime: String(now + resetTimeout) });
        return 2;
      }
      return 1;
    }

    // Circuit breaker: check request allowed
    if (script.includes('nextAttemptTime') && !script.includes('failureCount')) {
      const key = args[0] as string;
      const now = Number(args[1]);

      const map = this.hashes.get(key);
      const state = map?.get('state') || 'CLOSED';

      if (state === 'CLOSED') return 1;
      if (state === 'OPEN') {
        const nextAttemptTime = Number(map?.get('nextAttemptTime') || 0);
        if (now >= nextAttemptTime) {
          this.hset(key, { state: 'HALF_OPEN' });
          return 1;
        }
        return 0;
      }
      if (state === 'HALF_OPEN') return 1;
      return 0;
    }

    // Circuit breaker: record success (default catch-all for circuit breaker scripts)
    {
      const key = args[0] as string;
      const state = this.hashes.get(key)?.get('state');
      if (state === 'HALF_OPEN') {
        this.hset(key, { state: 'CLOSED', failureCount: 0, nextAttemptTime: 0 });
      } else {
        this.hset(key, { failureCount: 0 });
      }
      return 1;
    }
  }

  async hget(key: string, field: string): Promise<string | null> {
    return this.hashes.get(key)?.get(field) ?? null;
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    const map = this.hashes.get(key);
    if (!map) return {};
    const result: Record<string, string> = {};
    for (const [k, v] of map) {
      result[k] = v;
    }
    return result;
  }

  async hset(key: string, ...args: unknown[]): Promise<number> {
    if (!this.hashes.has(key)) {
      this.hashes.set(key, new Map());
    }
    const map = this.hashes.get(key)!;
    let added = 0;

    if (args.length === 1 && typeof args[0] === 'object' && args[0] !== null) {
      // Object form: hset(key, { field: value })
      for (const [field, value] of Object.entries(args[0] as Record<string, unknown>)) {
        if (!map.has(field)) added++;
        map.set(field, String(value));
      }
    } else if (args.length >= 2) {
      // Variadic form: hset(key, field, value, field2, value2, ...)
      for (let i = 0; i < args.length; i += 2) {
        const field = String(args[i]);
        const value = String(args[i + 1]);
        if (!map.has(field)) added++;
        map.set(field, value);
      }
    }

    return added;
  }

  pipeline() {
    const cmds: Array<{ method: string; args: unknown[] }> = [];

    const builder = {
      hincrbyfloat(key: string, field: string, value: string) {
        cmds.push({ method: 'hincrbyfloat', args: [key, field, value] });
        return builder;
      },
      incrbyfloat(key: string, value: string) {
        cmds.push({ method: 'incrbyfloat', args: [key, value] });
        return builder;
      },
      del(...keys: string[]) {
        cmds.push({ method: 'del', args: keys });
        return builder;
      },
      exec: async (): Promise<unknown[][]> => {
        const results: unknown[][] = [];
        for (const cmd of cmds) {
          if (cmd.method === 'hincrbyfloat') {
            const [key, field, value] = cmd.args as [string, string, string];
            if (!this.hashes.has(key)) this.hashes.set(key, new Map());
            const map = this.hashes.get(key)!;
            const current = Number.parseFloat(map.get(field) || '0');
            const newVal = current + Number.parseFloat(value);
            map.set(field, String(newVal));
            results.push([null, String(newVal)]);
          } else if (cmd.method === 'incrbyfloat') {
            const [key, value] = cmd.args as [string, string];
            const current = Number.parseFloat(this.store.get(key) || '0');
            const newVal = current + Number.parseFloat(value);
            this.store.set(key, String(newVal));
            results.push([null, String(newVal)]);
          } else if (cmd.method === 'del') {
            const keys = cmd.args as string[];
            let count = 0;
            for (const k of keys) {
              if (this.store.delete(k)) count++;
              // Also clean up hashes if any
              for (const [hk] of this.hashes) {
                if (hk === k) {
                  this.hashes.delete(hk);
                  count++;
                }
              }
            }
            results.push([null, count]);
          }
        }
        return results;
      },
    };

    return builder;
  }

  async incrbyfloat(key: string, value: number): Promise<string> {
    const current = Number.parseFloat(this.store.get(key) || '0');
    const newVal = current + value;
    this.store.set(key, String(newVal));
    return String(newVal);
  }

  async del(...keys: string[]): Promise<number> {
    let count = 0;
    for (const key of keys) {
      if (this.store.delete(key)) count++;
      if (this.hashes.delete(key)) count++;
    }
    return count;
  }

  async ping(): Promise<string> {
    return 'PONG';
  }

  async scan(_cursor: string, ..._args: unknown[]): Promise<[string, string[]]> {
    return ['0', []];
  }

  async ttl(_key: string): Promise<number> {
    return -1;
  }
}
