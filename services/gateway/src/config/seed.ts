type Allowlist = Record<string, string[]>;

/** @deprecated Use kernel/config-store/seed.ts (createSeedData) instead. M0 static seed; replaced by ConfigStore in M1. */
export function loadSeedAllowlist(): Allowlist {
  return {
    'seed-sp-appid': ['gpt-4.1', 'Kimi-K2.5', 'DeepSeek-V4-Flash', 'gpt-5-mini', 'gpt-5.1-codex-mini'],
    'seed-user-oid': ['gpt-4.1', 'gpt-5-mini', 'Kimi-K2.5'],
  };
}
