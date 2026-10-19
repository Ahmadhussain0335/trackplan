// The temp file name is random; this test fixes the random bytes so it can
// plant a symlink at the exact name and check that it is not followed.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { expect, it, vi } from 'vitest';

vi.mock('node:crypto', () => ({ randomBytes: (size: number) => Buffer.alloc(size, 0xab) }));

const { exitToolFailure, runCli } = await import('../src/cli.js');

it('does not follow a planted symlink at the temp file name', () => {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'trackplan-temp-')));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'trackplan-victim-'));
  try {
    const victim = path.join(outside, 'victim.txt');
    fs.writeFileSync(victim, 'safe');
    fs.writeFileSync(
      path.join(cwd, 'tracking_plan.yaml'),
      'version: 1\nevents:\n  a: {description: d}\n',
    );
    fs.mkdirSync(path.join(cwd, 'src/analytics'), { recursive: true });
    fs.symlinkSync(
      victim,
      path.join(cwd, `src/analytics/.analytics.ts.${'ab'.repeat(8)}.trackplan.tmp`),
    );
    let err = '';
    const code = runCli(['generate'], {
      cwd,
      out: { write: () => undefined },
      err: { write: (s) => (err += s) },
    });
    expect(code).toBe(exitToolFailure);
    expect(err).toContain('EEXIST');
    expect(fs.readFileSync(victim, 'utf8')).toBe('safe');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
