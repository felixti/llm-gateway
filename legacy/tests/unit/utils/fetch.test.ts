import { describe, expect, test } from 'bun:test';
import { upstreamHttpsFetch } from '../../../src/utils/fetch';

describe('upstreamHttpsFetch', () => {
  test('rejects non-HTTPS URLs', async () => {
    await expect(upstreamHttpsFetch('http://example.com')).rejects.toThrow(
      'Upstream requests must use HTTPS'
    );
  });
});
