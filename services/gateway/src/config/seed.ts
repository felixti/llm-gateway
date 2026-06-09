type Allowlist = Record<string, string[]>;

/** @deprecated Use kernel/config-store/seed.ts (createSeedData) instead. M0 static seed; replaced by ConfigStore in M1. */
export function loadSeedAllowlist(): Allowlist {
  return {
    'seed-sp-appid': ['gpt-5.4', 'claude-opus-4-6'],
    'seed-user-oid': ['gpt-5-mini', 'claude-haiku-4-5'],
  };
}
