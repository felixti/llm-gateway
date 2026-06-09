import { describe, expect, test } from 'bun:test';

const scriptPath = 'scripts/curl-tests.sh';

describe('curl-tests script', () => {
  test('has valid shell syntax', async () => {
    const process = Bun.spawn(['bash', '-n', scriptPath], {
      stderr: 'pipe',
      stdout: 'pipe',
    });

    const exitCode = await process.exited;
    const stderr = await new Response(process.stderr).text();

    expect(stderr).toBe('');
    expect(exitCode).toBe(0);
  });

  test('prints non-interactive help', async () => {
    const process = Bun.spawn(['bash', scriptPath, '--help'], {
      stderr: 'pipe',
      stdout: 'pipe',
    });

    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
    expect(stdout).toContain('Curl smoke tests for LLM Gateway');
    expect(stdout).toContain('HOST');
    expect(stdout).toContain('TOKEN');
    expect(stdout).toContain('RUN_LLM_TESTS');
  });
});
