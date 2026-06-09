import { describe, expect, it } from 'bun:test';

describe('PAT contract documentation', () => {
  it('documents the canonical token and revocation contract', async () => {
    const doc = await Bun.file('docs/security/pat-contract.md').text();

    expect(doc).toContain('lg_{userId}_{header}.{payload}.{signature}');
    expect(doc).toContain('HMAC-SHA256');
    expect(doc).toContain('jti');
    expect(doc).toContain('blocklist:pat:{hash(jti)}');
    expect(doc).toContain('scope: admin');
    expect(doc).toContain('X-Operator-Secret');
    expect(doc).toContain('no TTL');
    expect(doc).not.toContain('lg_{env}_{userId}_{random}_{signature}');
  });

  it('keeps active specs aligned with the canonical revocation contract', async () => {
    const paths = [
      '.context/specs/llm-gateway/requirements.md',
      '.context/specs/llm-gateway/design.md',
      '.context/specs/llm-gateway/tasks.md',
    ];
    const docs = await Promise.all(paths.map((path) => Bun.file(path).text()));
    const combined = docs.join('\n');

    expect(combined).toContain('blocklist:pat:{hash(jti)}');
    expect(combined).not.toContain('lg_{env}_{userId}_{random}_{signature}');
    expect(combined).not.toContain("TTL matching the token's remaining lifetime");
    expect(combined).not.toContain('blocklist:pat:{jti}');
  });
});
