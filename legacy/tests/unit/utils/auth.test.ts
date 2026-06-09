import { describe, expect, it } from 'bun:test';
import {
  parsePatToken,
  validatePatStructure,
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

  describe('hashJtiForBlocklist', () => {
    it('should return consistent hash', () => {
      const hash1 = hashJtiForBlocklist('jti-1');
      const hash2 = hashJtiForBlocklist('jti-1');
      expect(hash1).toBe(hash2);
      expect(hash1).toBeTruthy();
    });
  });
});
