import type { Allowlist } from '../pipeline/scope';

/** M0 static seed; M1 replaces with Table Storage tenancy. principalId -> allowed model aliases. */
export function loadSeedAllowlist(): Allowlist {
  return {
    'seed-sp-appid': ['gpt-5.4', 'claude-opus-4-6'],
    'seed-user-oid': ['gpt-5-mini', 'claude-haiku-4-5'],
  };
}
