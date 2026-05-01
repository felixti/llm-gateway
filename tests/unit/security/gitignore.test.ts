import { describe, expect, it } from 'bun:test';

describe('secret file ignore rules', () => {
  it('ignores local environment backup files', async () => {
    const gitignore = await Bun.file('.gitignore').text();

    expect(gitignore).toContain('.env.bak*');
    expect(gitignore).toContain('.env.backup*');
  });
});
