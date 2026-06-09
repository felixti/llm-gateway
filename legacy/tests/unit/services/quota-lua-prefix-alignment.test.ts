import { describe, expect, test } from 'bun:test';
import {
  QUOTA_KEY_PREFIX,
  RESERVED_KEY_PREFIX,
  RESERVATION_KEY_PREFIX,
  RESERVATION_HASH_PREFIX,
  IDEMPOTENCY_CLEANUP_PREFIX,
} from '@/services/quota/constants';
import {
  RELEASE_RESERVATION_SCRIPT,
  RECONCILE_USAGE_SCRIPT,
  CLEANUP_ORPHAN_SCRIPT,
} from '@/services/quota/scripts';

describe('Lua script prefix alignment', () => {
  test('RELEASE_RESERVATION_SCRIPT uses ARGV for prefixes', () => {
    expect(RELEASE_RESERVATION_SCRIPT).not.toContain("'reserved:'");
    expect(RELEASE_RESERVATION_SCRIPT).not.toContain("'reservations_meta:'");
    expect(RELEASE_RESERVATION_SCRIPT).toContain('ARGV[3]');
    expect(RELEASE_RESERVATION_SCRIPT).toContain('ARGV[4]');
  });

  test('RECONCILE_USAGE_SCRIPT uses ARGV for prefixes', () => {
    expect(RECONCILE_USAGE_SCRIPT).not.toContain("'quota:'");
    expect(RECONCILE_USAGE_SCRIPT).not.toContain("'reserved:'");
    expect(RECONCILE_USAGE_SCRIPT).not.toContain("'reservations_meta:'");
    expect(RECONCILE_USAGE_SCRIPT).toContain('ARGV[4]');
    expect(RECONCILE_USAGE_SCRIPT).toContain('ARGV[5]');
    expect(RECONCILE_USAGE_SCRIPT).toContain('ARGV[6]');
  });

  test('CLEANUP_ORPHAN_SCRIPT uses ARGV for prefixes', () => {
    expect(CLEANUP_ORPHAN_SCRIPT).not.toContain("'reservation:'");
    expect(CLEANUP_ORPHAN_SCRIPT).not.toContain("'reserved:'");
    expect(CLEANUP_ORPHAN_SCRIPT).toContain('ARGV[4]');
    expect(CLEANUP_ORPHAN_SCRIPT).toContain('ARGV[5]');
    expect(CLEANUP_ORPHAN_SCRIPT).toContain('ARGV[6]');
  });

  test('TypeScript prefix constants match expected values', () => {
    expect(QUOTA_KEY_PREFIX).toBe('quota:');
    expect(RESERVED_KEY_PREFIX).toBe('reserved:');
    expect(RESERVATION_KEY_PREFIX).toBe('reservation:');
    expect(RESERVATION_HASH_PREFIX).toBe('reservations_meta:');
    expect(IDEMPOTENCY_CLEANUP_PREFIX).toBe('cleanup:');
  });
});
