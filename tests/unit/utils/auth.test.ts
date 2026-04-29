import { describe, expect, it } from 'bun:test';
import {
  parsePatToken,
  hashPatToken,
  verifyPatHash,
  validatePatStructure,
  isJtiBlocklisted,
  hashJtiForBlocklist,
} from '../../../src/utils/auth';

describe('Auth utilities', () => {
  describe('parsePatToken', () => {
    it('should return null for non-3-part token', () => {
      expect(parsePatToken('invalid')).toBeNull();
    });

    it('should return null for header without lg_ prefix', () => {
      expect(parsePatToken('header.payload.sig')).toBeNull();
    });

    it('should parse valid PAT token', () => {
      const token = parsePatToken('lg_user1_header.payload.sig');
      expect(token).not.toBeNull();
      expect(token!.userId).toBe('user1');
      expect(token!.header).toBe('lg_user1_header');
      expect(token!.payload).toBe('payload');
      expect(token!.signature).toBe('sig');
    });
  });

  describe('hashPatToken', () => {
    it('should return consistent hash for same token', () => {
      const hash1 = hashPatToken('test-token');
      const hash2 = hashPatToken('test-token');
      expect(hash1).toBe(hash2);
      expect(hash1).toBeTruthy();
    });
  });

  describe('verifyPatHash', () => {
    it('should return true for matching hash', () => {
      const token = 'test-token';
      const hash = hashPatToken(token);
      expect(verifyPatHash(token, hash)).toBe(true);
    });

    it('should return false for non-matching hash', () => {
      const hash = hashPatToken('test-token');
      expect(verifyPatHash('different-token', hash)).toBe(false);
    });

    it('should return false for invalid hex hash', () => {
      expect(verifyPatHash('test', 'not-hex')).toBe(false);
    });

    it('should return false for hash of different length', () => {
      expect(verifyPatHash('test', 'aa')).toBe(false);
    });
  });

  describe('validatePatStructure', () => {
    it('should return error for invalid format', () => {
      const result = validatePatStructure('invalid');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Invalid PAT format');
    });

    it('should validate a syntactically correct PAT', () => {
      // Create a valid PAT
      const { createHmac } = require('node:crypto');
      const { env } = require('../../../src/config/env');
      const header = 'lg_user1_' + Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url').replace(/=+$/, '');
      const payload = Buffer.from(JSON.stringify({ jti: 'test', exp: 9999999999 })).toString('base64url').replace(/=+$/, '');
      const signature = createHmac('sha256', env.PAT_SECRET).update(`${header}.${payload}`).digest('hex');
      const pat = `${header}.${payload}.${signature}`;

      const result = validatePatStructure(pat);
      expect(result.valid).toBe(true);
      expect(result.token).toBeDefined();
      expect(result.token!.userId).toBe('user1');
    });

    it('should return error for wrong signature', () => {
      // Use a 64-char hex string (same length as SHA256 hex) but wrong content
      const wrongSig = 'a'.repeat(64);
      const result = validatePatStructure(`lg_user1_header.payload.${wrongSig}`);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Invalid signature');
    });
  });

  describe('isJtiBlocklisted', () => {
    it('should return false when JTI is not in blocklist', async () => {
      const result = await isJtiBlocklisted('jti-1', async () => null);
      expect(result).toBe(false);
    });

    it('should return true when JTI hash matches blocklist', async () => {
      const jti = 'jti-1';
      const hash = hashJtiForBlocklist(jti);
      const result = await isJtiBlocklisted(jti, async () => hash);
      expect(result).toBe(true);
    });

    it('should return false when JTI hash does not match', async () => {
      const result = await isJtiBlocklisted('jti-1', async () => 'wronghash');
      expect(result).toBe(false);
    });

    it('should return false for invalid stored hash', async () => {
      const result = await isJtiBlocklisted('jti-1', async () => 'zz');
      expect(result).toBe(false);
    });
  });

  describe('hashJtiForBlocklist', () => {
    it('should return consistent hash', () => {
      const hash1 = hashJtiForBlocklist('jti-1');
      const hash2 = hashJtiForBlocklist('jti-1');
      expect(hash1).toBe(hash2);
      expect(hash1).toBeTruthy();
    });
  });
});
