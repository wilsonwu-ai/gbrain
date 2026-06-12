/**
 * v0.43 (#2095) — `gbrain watch` SIGINT lifecycle. SERIAL: spawns a real CLI
 * subprocess with a tmpdir brain (the parallel unit shards flake on
 * concurrent subprocess spawns — same isolation rationale as
 * apply-migrations-pglite-spawn.serial.test.ts).
 */
import { describe, test, expect } from 'bun:test';

describe('gbrain watch — SIGINT lifecycle (real subprocess)', () => {
  test('SIGINT mid-stream closes the stream and exits cleanly (drain path, exit 0)', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('fs');
    const { join, resolve } = await import('path');
    const { tmpdir } = await import('os');
    const REPO = resolve(import.meta.dir, '..');
    const home = mkdtempSync(join(tmpdir(), 'gbrain-watch-sigint-'));
    try {
      mkdirSync(join(home, '.gbrain'), { recursive: true });
      writeFileSync(
        join(home, '.gbrain', 'config.json'),
        JSON.stringify({
          engine: 'pglite',
          database_path: join(home, '.gbrain', 'brain.pglite'),
          embedding_dimensions: 1536,
        }) + '\n',
      );
      // Piped stdin that NEVER reaches EOF — only SIGINT can end the stream.
      const proc = Bun.spawn(['bun', 'run', join(REPO, 'src', 'cli.ts'), 'watch'], {
        cwd: REPO,
        env: { ...process.env, HOME: home, GBRAIN_HOME: home, GBRAIN_SKIP_STARTUP_HOOKS: '1' },
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      proc.stdin.write('user: nothing relevant here\n');
      await proc.stdin.flush();
      // Give the brain time to init + process the turn, then interrupt.
      await new Promise((r) => setTimeout(r, 15_000));
      proc.kill('SIGINT');
      const killer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* already dead */ }
      }, 30_000);
      const exitCode = await proc.exited;
      clearTimeout(killer);
      const stderr = await new Response(proc.stderr).text();
      // Clean drain-then-exit: no force-exit banner, no SIGKILL (137), exit 0.
      expect(stderr).not.toContain('force-exiting');
      expect(exitCode).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 120_000);
});
