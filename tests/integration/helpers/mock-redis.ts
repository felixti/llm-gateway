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

  async eval(_script: string, _numKeys: number, ..._args: (string | number)[]): Promise<unknown> {
    // Rate-limit and quota scripts: always allow
    return [1, 0];
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

  async hset(key: string, obj: Record<string, string | number | Buffer>): Promise<number> {
    if (!this.hashes.has(key)) {
      this.hashes.set(key, new Map());
    }
    const map = this.hashes.get(key)!;
    let added = 0;
    for (const [field, value] of Object.entries(obj)) {
      if (!map.has(field)) added++;
      map.set(field, String(value));
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
