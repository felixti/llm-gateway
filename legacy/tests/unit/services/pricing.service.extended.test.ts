import { describe, it, expect } from 'bun:test';
import {
  reloadPricingFromFile,
  getPricingByPattern,
  reloadPricing,
  validatePricingData,
} from '../../../src/services/pricing.service';

describe('Pricing Service - extended coverage', () => {
  describe('reloadPricingFromFile - invalid payloads', () => {
    it('rejects payload with wrong currency', async () => {
      const tempPath = `/tmp/llm-gateway-pricing-currency-${Date.now()}.json`;
      await Bun.write(
        tempPath,
        JSON.stringify({
          version: '1',
          currency: 'EUR',
          models: {
            test: {
              deployment_pattern: 'test',
              input_per_million: 1,
              output_per_million: 2,
            },
          },
        })
      );

      const loaded = await reloadPricingFromFile(tempPath);
      expect(loaded).toBe(false);
    });

    it('rejects payload without version', async () => {
      const tempPath = `/tmp/llm-gateway-pricing-noversion-${Date.now()}.json`;
      await Bun.write(
        tempPath,
        JSON.stringify({
          currency: 'USD',
          models: {
            test: {
              deployment_pattern: 'test',
              input_per_million: 1,
              output_per_million: 2,
            },
          },
        })
      );

      const loaded = await reloadPricingFromFile(tempPath);
      expect(loaded).toBe(false);
    });

    it('rejects payload with empty models', async () => {
      const tempPath = `/tmp/llm-gateway-pricing-empty-${Date.now()}.json`;
      await Bun.write(
        tempPath,
        JSON.stringify({
          version: '1',
          currency: 'USD',
          models: {},
        })
      );

      const loaded = await reloadPricingFromFile(tempPath);
      expect(loaded).toBe(false);
    });

    it('rejects payload with missing models field', async () => {
      const tempPath = `/tmp/llm-gateway-pricing-nomodels-${Date.now()}.json`;
      await Bun.write(
        tempPath,
        JSON.stringify({
          version: '1',
          currency: 'USD',
        })
      );

      const loaded = await reloadPricingFromFile(tempPath);
      expect(loaded).toBe(false);
    });

    it('rejects payload with non-numeric input_per_million', async () => {
      const tempPath = `/tmp/llm-gateway-pricing-badinput-${Date.now()}.json`;
      await Bun.write(
        tempPath,
        JSON.stringify({
          version: '1',
          currency: 'USD',
          models: {
            test: {
              deployment_pattern: 'test',
              input_per_million: 'bad',
              output_per_million: 2,
            },
          },
        })
      );

      const loaded = await reloadPricingFromFile(tempPath);
      expect(loaded).toBe(false);
    });

    it('rejects non-object payload', async () => {
      const tempPath = `/tmp/llm-gateway-pricing-null-${Date.now()}.json`;
      await Bun.write(tempPath, 'null');

      const loaded = await reloadPricingFromFile(tempPath);
      expect(loaded).toBe(false);
    });

    it('rejects file that does not exist', async () => {
      const loaded = await reloadPricingFromFile('/tmp/nonexistent-pricing-xxx.json');
      expect(loaded).toBe(false);
    });

    it('rejects model with non-string deployment_pattern', async () => {
      const tempPath = `/tmp/llm-gateway-pricing-badpattern-${Date.now()}.json`;
      await Bun.write(
        tempPath,
        JSON.stringify({
          version: '1',
          currency: 'USD',
          models: {
            test: {
              deployment_pattern: 123,
              input_per_million: 1,
              output_per_million: 2,
            },
          },
        })
      );

      const loaded = await reloadPricingFromFile(tempPath);
      expect(loaded).toBe(false);
    });

    it('rejects model with non-object value', async () => {
      const tempPath = `/tmp/llm-gateway-pricing-badmodel-${Date.now()}.json`;
      await Bun.write(
        tempPath,
        JSON.stringify({
          version: '1',
          currency: 'USD',
          models: {
            test: 'not-an-object',
          },
        })
      );

      const loaded = await reloadPricingFromFile(tempPath);
      expect(loaded).toBe(false);
    });
  });

  describe('reloadPricing (default path)', () => {
    it('reloads from default path successfully', async () => {
      const loaded = await reloadPricing();
      expect(loaded).toBe(true);
    });
  });

  describe('validatePricingData', () => {
    it('returns true for valid pricing data', () => {
      expect(validatePricingData()).toBe(true);
    });
  });

  describe('getPricingByPattern - wildcard matching', () => {
    it('matches wildcard suffix patterns', async () => {
      await reloadPricing();
      const result = getPricingByPattern('gpt-5.4');
      expect(result).toBeDefined();
    });
  });
});
