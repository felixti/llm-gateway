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

  async set(
    key: string,
    value: string | number | Buffer,
    ...args: unknown[]
  ): Promise<string | undefined> {
    const hasNx = args.includes('NX');
    if (hasNx && this.store.has(key)) {
      return undefined;
    }
    this.store.set(key, String(value));
    return 'OK';
  }

  async setex(key: string, _ttl: number, value: string | number | Buffer): Promise<void> {
    this.store.set(key, String(value));
  }

  async eval(script: string, _numKeys: number, ...args: (string | number)[]): Promise<unknown> {
    if (script.includes('zremrangebyscore') || script.includes('zcard')) {
      return [1, 0];
    }

    if (script.includes('already_released')) {
      return this.evalRelease(args);
    }

    if (script.includes('already_reconciled')) {
      return this.evalReconcile(args);
    }

    if (script.includes('orphan_cleanup')) {
      return this.evalCleanup(args);
    }

    if (script.includes('top_up_reservation') || script.includes('deltaMicro')) {
      return this.evalTopUp(args);
    }

    if (script.includes('monthly_budget') || script.includes('reserved')) {
      return this.evalCheckAndReserve(args);
    }

    if (script.includes('threshold')) {
      return this.evalCircuitBreakerFailure(args);
    }

    if (script.includes('nextAttemptTime') && !script.includes('failureCount')) {
      return this.evalCircuitBreakerCheck(args);
    }

    return this.evalCircuitBreakerSuccess(args);
  }

  private evalTopUp(args: (string | number)[]): unknown {
    const quotaKey = args[0] as string;
    const reservationKey = args[1] as string;
    const deltaMicro = Number(args[2]);
    const reservationId = args[3] as string;
    const defaultBudget = Number(args[4]);

    const data = this.store.get(reservationKey);
    if (!data) {
      return [0, 'not_found'];
    }

    const parts = data.split('|');
    const amountMicroStr = parts[0];
    const userId = parts[1];
    const month = parts[2];
    const createdAt = parts[3] || '0';

    if (!amountMicroStr || !userId || !month) {
      return [0, 'parse_error'];
    }

    const amountMicro = Number(amountMicroStr);
    let newAmount = amountMicro + deltaMicro;
    if (newAmount < 0) newAmount = 0;

    const reservedKey = `reserved:${userId}:${month}`;
    const hashKey = `reservations_meta:${userId}:${month}`;

    if (deltaMicro > 0) {
      const budgetRaw = this.hashes.get(quotaKey)?.get('budget') || String(defaultBudget);
      const budget = Number(budgetRaw);
      const spent = Number(this.hashes.get(quotaKey)?.get('spent') || '0');
      const reserved = Number(this.store.get(reservedKey) || '0');
      const hardLimitRaw = this.hashes.get(quotaKey)?.get('hard_limit');
      const isHard = hardLimitRaw !== '0' && hardLimitRaw !== 'false';

      if (spent + reserved + deltaMicro > budget) {
        if (isHard) {
          return [0, 'hard_rejected'];
        }
        const currentReserved = Number(this.store.get(reservedKey) || '0');
        this.store.set(reservedKey, String(currentReserved + deltaMicro));
        const newData = `${newAmount}|${userId}|${month}|${createdAt}`;
        this.store.set(reservationKey, newData);
        if (!this.hashes.has(hashKey)) this.hashes.set(hashKey, new Map());
        this.hashes.get(hashKey)!.set(reservationId, newData);
        return [1, 'soft_overage'];
      }
    }

    const currentReserved = Number(this.store.get(reservedKey) || '0');
    this.store.set(reservedKey, String(currentReserved + deltaMicro));
    const newData = `${newAmount}|${userId}|${month}|${createdAt}`;
    this.store.set(reservationKey, newData);
    if (!this.hashes.has(hashKey)) this.hashes.set(hashKey, new Map());
    this.hashes.get(hashKey)!.set(reservationId, newData);
    return [1, 'within_budget'];
  }

  private evalCheckAndReserve(args: (string | number)[]): unknown {
    const quotaKey = args[0] as string;
    const reservedKey = args[1] as string;
    const reservationKey = args[2] as string;
    const hashKey = args[3] as string;
    const cost = Number(args[4]);
    const reservationData = args[5] as string;
    const reservationId = args[8] as string;

    const budgetRaw = this.hashes.get(quotaKey)?.get('budget') || '50000000';
    const budget = Number(budgetRaw);
    const spent = Number(this.hashes.get(quotaKey)?.get('spent') || '0');
    const reserved = Number(this.store.get(reservedKey) || '0');
    const hardLimitRaw = this.hashes.get(quotaKey)?.get('hard_limit');
    const isHard = hardLimitRaw !== '0' && hardLimitRaw !== 'false';

    if (spent + reserved + cost > budget && isHard) {
      return [0, 'insufficient_quota'];
    }

    this.store.set(reservationKey, reservationData);
    this.incrby(reservedKey, Math.floor(cost));
    if (!this.hashes.has(hashKey)) {
      this.hashes.set(hashKey, new Map());
    }
    this.hashes.get(hashKey)!.set(reservationId, reservationData);

    if (spent + reserved + cost > budget) {
      return [1, 'soft_overage'];
    }

    return [1, 'ok'];
  }

  private evalRelease(args: (string | number)[]): unknown {
    const idempotencyKey = args[0] as string;
    const reservationKey = args[1] as string;
    const reservationId = args[2] as string;

    if (this.store.has(idempotencyKey)) {
      return [0, 'already_released'];
    }

    const data = this.store.get(reservationKey);
    if (!data) {
      this.store.set(idempotencyKey, '0');
      return [0, 'not_found'];
    }

    const parts = data.split('|');
    const amountMicro = parts[0];
    const userId = parts[1];
    const month = parts[2];

    if (!amountMicro || !userId || !month) {
      this.store.set(idempotencyKey, '0');
      return [0, 'parse_error'];
    }

    const reservedKey = `reserved:${userId}:${month}`;
    const hashKey = `reservations_meta:${userId}:${month}`;

    const currentReserved = Number(this.store.get(reservedKey) || '0');
    this.store.set(reservedKey, String(currentReserved - Number(amountMicro)));

    this.store.delete(reservationKey);
    const hash = this.hashes.get(hashKey);
    if (hash) {
      hash.delete(reservationId);
      if (hash.size === 0) this.hashes.delete(hashKey);
    }

    this.store.set(idempotencyKey, amountMicro);

    return [1, 'ok', amountMicro];
  }

  private evalReconcile(args: (string | number)[]): unknown {
    const idempotencyKey = args[0] as string;
    const reservationKey = args[1] as string;
    const reservationId = args[2] as string;
    const costMicro = args[3] as string;

    if (this.store.has(idempotencyKey)) {
      return [0, 'already_reconciled'];
    }

    const data = this.store.get(reservationKey);
    if (!data) {
      this.store.set(idempotencyKey, costMicro);
      return [0, 'not_found'];
    }

    const parts = data.split('|');
    const reservedAmountMicro = parts[0];
    const userId = parts[1];
    const month = parts[2];

    if (!reservedAmountMicro || !userId || !month) {
      this.store.set(idempotencyKey, costMicro);
      return [0, 'parse_error'];
    }

    const quotaKey = `quota:${userId}:${month}`;
    const reservedKey = `reserved:${userId}:${month}`;
    const hashKey = `reservations_meta:${userId}:${month}`;

    if (!this.hashes.has(quotaKey)) {
      this.hashes.set(quotaKey, new Map());
    }
    const quotaMap = this.hashes.get(quotaKey)!;
    const currentSpent = Number(quotaMap.get('spent') || '0');
    quotaMap.set('spent', String(currentSpent + Number(costMicro)));

    const currentReserved = Number(this.store.get(reservedKey) || '0');
    this.store.set(reservedKey, String(currentReserved - Number(reservedAmountMicro)));

    this.store.delete(reservationKey);
    const hash = this.hashes.get(hashKey);
    if (hash) {
      hash.delete(reservationId);
      if (hash.size === 0) this.hashes.delete(hashKey);
    }

    this.store.set(idempotencyKey, costMicro);

    return [1, 'ok', costMicro, reservedAmountMicro];
  }

  private evalCleanup(args: (string | number)[]): number {
    const hashKey = args[0] as string;
    const nowMs = Number(args[1]);
    const ttlMs = Number(args[2]);

    const hash = this.hashes.get(hashKey);
    if (!hash) return 0;

    let cleaned = 0;
    const entriesToDelete: string[] = [];

    for (const [reservationId, data] of hash) {
      const parts = data.split('|');
      if (parts.length < 4) continue;

      const amountMicro = parts[0];
      const userId = parts[1];
      const month = parts[2];
      const createdAtStr = parts[3];
      const createdAt = Number(createdAtStr);

      if (!createdAt || nowMs - createdAt <= ttlMs) continue;

      const reservationKey = `reservation:${reservationId}`;
      if (this.store.has(reservationKey)) continue;

      const idemKey = `cleanup:${reservationId}`;
      if (this.store.has(idemKey)) continue;

      const reservedKey = `reserved:${userId}:${month}`;
      const currentReserved = Number(this.store.get(reservedKey) || '0');
      this.store.set(reservedKey, String(currentReserved - Number(amountMicro)));

      entriesToDelete.push(reservationId);
      this.store.set(idemKey, '1');
      cleaned++;
    }

    for (const id of entriesToDelete) {
      hash.delete(id);
    }
    if (hash.size === 0) {
      this.hashes.delete(hashKey);
    }

    return cleaned;
  }

  private evalCircuitBreakerFailure(args: (string | number)[]): number {
    const key = args[0] as string;
    const probeKey = args[1] as string;
    const now = Number(args[2]);
    const threshold = Number(args[3]);
    const resetTimeout = Number(args[4]);

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
      this.store.delete(probeKey);
      return 2;
    }
    return 1;
  }

  private evalCircuitBreakerCheck(args: (string | number)[]): number {
    const key = args[0] as string;
    const probeKey = args[1] as string;
    const now = Number(args[2]);

    const map = this.hashes.get(key);
    const state = map?.get('state') || 'CLOSED';

    if (state === 'CLOSED') return 1;
    if (state === 'OPEN') {
      const nextAttemptTime = Number(map?.get('nextAttemptTime') || 0);
      if (now >= nextAttemptTime) {
        this.hset(key, { state: 'HALF_OPEN' });
        this.store.set(probeKey, '1');
        return 1;
      }
      return 0;
    }
    if (state === 'HALF_OPEN') {
      const probeSet = this.store.has(probeKey) ? null : 'OK';
      if (!probeSet) {
        return 0;
      }
      this.store.set(probeKey, '1');
      return 1;
    }
    return 0;
  }

  private evalCircuitBreakerSuccess(args: (string | number)[]): number {
    const key = args[0] as string;
    const probeKey = args.length > 1 ? (args[1] as string) : undefined;
    const state = this.hashes.get(key)?.get('state');
    if (state === 'HALF_OPEN') {
      this.hset(key, { state: 'CLOSED', failureCount: 0, nextAttemptTime: 0 });
      if (probeKey) this.store.delete(probeKey);
    } else {
      this.hset(key, { failureCount: 0 });
    }
    return 1;
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
      for (const [field, value] of Object.entries(args[0] as Record<string, unknown>)) {
        if (!map.has(field)) added++;
        map.set(field, String(value));
      }
    } else if (args.length >= 2) {
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
      hincrby(key: string, field: string, value: number) {
        cmds.push({ method: 'hincrby', args: [key, field, value] });
        return builder;
      },
      incrby(key: string, value: number) {
        cmds.push({ method: 'incrby', args: [key, value] });
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
      hdel(key: string, ...fields: string[]) {
        cmds.push({ method: 'hdel', args: [key, ...fields] });
        return builder;
      },
      exec: async (): Promise<unknown[][]> => {
        const results: unknown[][] = [];
        for (const cmd of cmds) {
          if (cmd.method === 'hincrby') {
            const [key, field, value] = cmd.args as [string, string, number];
            if (!this.hashes.has(key)) this.hashes.set(key, new Map());
            const map = this.hashes.get(key)!;
            const current = Number.parseInt(map.get(field) || '0', 10);
            const newVal = current + Math.floor(value);
            map.set(field, String(newVal));
            results.push([null, newVal]);
          } else if (cmd.method === 'hincrbyfloat') {
            const [key, field, value] = cmd.args as [string, string, string];
            if (!this.hashes.has(key)) this.hashes.set(key, new Map());
            const map = this.hashes.get(key)!;
            const current = Number.parseFloat(map.get(field) || '0');
            const newVal = current + Number.parseFloat(value);
            map.set(field, String(newVal));
            results.push([null, String(newVal)]);
          } else if (cmd.method === 'incrby') {
            const [key, value] = cmd.args as [string, number];
            const current = Number.parseInt(this.store.get(key) || '0', 10);
            const newVal = current + Math.floor(value);
            this.store.set(key, String(newVal));
            results.push([null, newVal]);
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
              for (const [hk] of this.hashes) {
                if (hk === k) {
                  this.hashes.delete(hk);
                  count++;
                }
              }
            }
            results.push([null, count]);
          } else if (cmd.method === 'hdel') {
            const key = cmd.args[0] as string;
            const fields = cmd.args.slice(1) as string[];
            const map = this.hashes.get(key);
            let deleted = 0;
            if (map) {
              for (const field of fields) {
                if (map.delete(field)) deleted++;
              }
              if (map.size === 0) this.hashes.delete(key);
            }
            results.push([null, deleted]);
          }
        }
        return results;
      },
    };

    return builder;
  }

  async hincrby(key: string, field: string, value: number): Promise<number> {
    if (!this.hashes.has(key)) this.hashes.set(key, new Map());
    const map = this.hashes.get(key)!;
    const current = Number.parseInt(map.get(field) || '0', 10);
    const newVal = current + Math.floor(value);
    map.set(field, String(newVal));
    return newVal;
  }

  async incrby(key: string, value: number): Promise<number> {
    const current = Number.parseInt(this.store.get(key) || '0', 10);
    const newVal = current + Math.floor(value);
    this.store.set(key, String(newVal));
    return newVal;
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

  async scan(_cursor: string, ...args: unknown[]): Promise<[string, string[]]> {
    let pattern = '*';
    for (let i = 0; i < args.length; i++) {
      if (args[i] === 'MATCH' && i + 1 < args.length) {
        pattern = String(args[i + 1]);
      }
    }

    const regex = new RegExp(pattern.replace(/\*/g, '.*'));
    const keys: string[] = [];

    for (const key of this.store.keys()) {
      if (regex.test(key)) keys.push(key);
    }
    for (const key of this.hashes.keys()) {
      if (regex.test(key)) keys.push(key);
    }

    return ['0', keys];
  }

  async exists(...keys: string[]): Promise<number> {
    let count = 0;
    for (const key of keys) {
      if (this.store.has(key) || this.hashes.has(key)) count++;
    }
    return count;
  }

  async hdel(key: string, ...fields: string[]): Promise<number> {
    const map = this.hashes.get(key);
    if (!map) return 0;
    let deleted = 0;
    for (const field of fields) {
      if (map.delete(field)) deleted++;
    }
    if (map.size === 0) {
      this.hashes.delete(key);
    }
    return deleted;
  }

  async ttl(_key: string): Promise<number> {
    return -1;
  }
}
