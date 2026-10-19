import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { exitInvalid, exitOk, exitToolFailure, maxPlanBytes, runCli } from '../src/cli.js';
import { samplePlan } from '../src/samplePlan.js';
import { packageVersion } from '../src/version.js';

const plan = `version: 1
targets:
  typescript:
    output: src/gen/analytics.ts
events:
  app_opened:
    description: User opened the app.
`;

let cwd: string;
const cleanup: string[] = [];

beforeEach(() => {
  // Resolve symlinks (macOS /var -> /private/var) so path checks are exact.
  cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'trackplan-cli-')));
  cleanup.push(cwd);
});

afterEach(() => {
  for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function run(args: string[]) {
  let out = '';
  let err = '';
  const code = runCli(args, {
    cwd,
    out: { write: (s) => (out += s) },
    err: { write: (s) => (err += s) },
  });
  return { code, out, err };
}

const writePlan = (content = plan) => {
  fs.writeFileSync(path.join(cwd, 'tracking_plan.yaml'), content);
};
const tempDir = (prefix: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanup.push(dir);
  return dir;
};

describe('general', () => {
  it('--version prints the package.json version', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8'),
    ) as {
      version: string;
    };
    expect(packageVersion).toBe(pkg.version);
    expect(run(['--version'])).toEqual({
      code: exitOk,
      out: `trackplan ${packageVersion}\n`,
      err: '',
    });
  });

  it('prints usage and help', () => {
    expect(run([]).code).toBe(exitToolFailure);
    expect(run(['--help']).code).toBe(exitOk);
    expect(run(['validate', '--help']).out).toContain('--json');
  });

  it('rejects unknown commands, options and arguments with exit 2', () => {
    expect(run(['publish']).code).toBe(exitToolFailure);
    expect(run(['validate', '--nope']).code).toBe(exitToolFailure);
    expect(run(['validate', 'extra']).code).toBe(exitToolFailure);
    expect(run(['generate', '--json']).code).toBe(exitToolFailure);
    expect(run(['init', '--allow-outside']).code).toBe(exitToolFailure);
  });

  it('accepts the same arguments as the Dart CLI', () => {
    expect(run(['toString']).code).toBe(exitToolFailure);
    expect(run(['validate', '--help', 'extra']).code).toBe(exitOk);
    fs.writeFileSync(path.join(cwd, '-p.yaml'), plan);
    expect(run(['validate', '--plan', '-p.yaml']).code).toBe(exitOk);
    expect(run(['validate', '--plan=-p.yaml']).code).toBe(exitOk);
    expect(run(['validate', '--plan']).err).toContain('Missing argument for "plan".');
    expect(run(['validate', '--json=1']).code).toBe(exitToolFailure);
    expect(run(['validate', '-x']).code).toBe(exitToolFailure);
  });

  it('escapes the plan path in --json output', () => {
    fs.writeFileSync(path.join(cwd, '\u009b.yaml'), plan);
    const result = run(['validate', '--plan', '\u009b.yaml', '--json']);
    expect(JSON.parse(result.out)).toMatchObject({ file: '\\u{009B}.yaml' });
  });

  it('escapes arguments in messages', () => {
    const result = run(['\u001B[2Jx']);
    expect(result.err).toContain('Unknown command "\\u{001B}[2Jx"');
    expect(result.err).not.toContain('\u001B');
  });

  it('reports a missing, oversized or directory plan with exit 2', () => {
    expect(run(['validate']).err).toBe('Cannot read tracking_plan.yaml: file not found.\n');
    writePlan(`# ${'x'.repeat(maxPlanBytes + 10)}\n`);
    expect(run(['validate']).err).toContain('larger than 1 MB');
    fs.rmSync(path.join(cwd, 'tracking_plan.yaml'));
    fs.mkdirSync(path.join(cwd, 'tracking_plan.yaml'));
    expect(run(['validate']).code).toBe(exitToolFailure);
  });
});

describe('init', () => {
  it('writes a valid sample plan and refuses to overwrite', () => {
    expect(run(['init']).code).toBe(exitOk);
    expect(fs.readFileSync(path.join(cwd, 'tracking_plan.yaml'), 'utf8')).toBe(samplePlan);
    expect(run(['validate'])).toEqual({ code: exitOk, out: '0 errors, 0 warnings.\n', err: '' });
    expect(run(['init']).code).toBe(exitToolFailure);
  });

  it('reports a missing folder as a file error', () => {
    const result = run(['init', '--plan', 'missing/plan.yaml']);
    expect(result.code).toBe(exitToolFailure);
    expect(result.err).not.toContain('already exists');
  });
});

describe('validate', () => {
  it('prints diagnostics and a summary', () => {
    writePlan('version: 2\nevents:\n  Bad: {}\n');
    expect(run(['validate'])).toEqual({
      code: exitInvalid,
      out:
        'tracking_plan.yaml:1:10 error TP013 Unsupported version 2. The only supported version is 1.\n' +
        'tracking_plan.yaml:3:3 error TP020 Invalid event name "Bad": use lowercase snake_case starting with a letter.\n' +
        'tracking_plan.yaml:3:3 warning TP100 Event "Bad" has no description.\n' +
        '2 errors, 1 warning.\n',
      err: '',
    });
  });

  it('exits 0 with only warnings', () => {
    writePlan('version: 1\nevents:\n  a:\n');
    expect(run(['validate']).code).toBe(exitOk);
  });
});

describe('generate and check', () => {
  const output = () => path.join(cwd, 'src/gen/analytics.ts');

  it('generates, then check passes; check fails when missing or outdated', () => {
    writePlan();
    expect(run(['check']).err).toContain('does not exist');
    expect(run(['generate'])).toEqual({
      code: exitOk,
      out: 'Wrote src/gen/analytics.ts.\n',
      err: '',
    });
    expect(fs.readdirSync(path.dirname(output()))).toEqual(['analytics.ts']);
    expect(run(['check']).code).toBe(exitOk);
    writePlan(plan.replace('User opened', 'Someone opened'));
    expect(run(['check']).err).toContain('is out of date');
    expect(run(['generate']).code).toBe(exitOk);
    expect(fs.readFileSync(output(), 'utf8')).toContain('Someone opened');
    fs.writeFileSync(output(), Buffer.from([0xff]));
    expect(run(['check']).code).toBe(exitInvalid);
  });

  it('stops on plan errors and prints warnings to stderr', () => {
    writePlan('version: 1\nevents: {}\n');
    expect(run(['generate']).code).toBe(exitInvalid);
    expect(fs.existsSync(path.join(cwd, 'src'))).toBe(false);
    writePlan('version: 1\nevents:\n  a:\n');
    const result = run(['generate']);
    expect(result.code).toBe(exitOk);
    expect(result.err).toContain('TP100');
  });

  it('validates --out before the plan', () => {
    writePlan('version: 2\nevents: {}\n');
    expect(run(['generate', '--out', '../a.ts']).code).toBe(exitToolFailure);
    writePlan();
    expect(run(['generate', '--out', 'a.dart']).code).toBe(exitToolFailure);
    expect(run(['generate', '--out', 'x/a.mts']).code).toBe(exitOk);
    expect(run(['check', '--out', 'x/a.mts']).code).toBe(exitOk);
  });

  it('writes into a folder whose name starts with two dots', () => {
    writePlan();
    expect(run(['generate', '--out', '..gen/a.ts']).code).toBe(exitOk);
    expect(fs.existsSync(path.join(cwd, '..gen/a.ts'))).toBe(true);
  });

  it('refuses to overwrite foreign files or directories', () => {
    writePlan();
    fs.writeFileSync(path.join(cwd, 'main.ts'), 'export {};\n');
    const refused = run(['generate', '--out', 'main.ts']);
    expect(refused.code).toBe(exitToolFailure);
    expect(refused.err).toContain('not generated by trackplan');
    expect(fs.readFileSync(path.join(cwd, 'main.ts'), 'utf8')).toBe('export {};\n');
    fs.mkdirSync(path.join(cwd, 'd.ts'));
    expect(run(['generate', '--out', 'd.ts']).code).toBe(exitToolFailure);
  });

  it('refuses symlinks out of the project unless --allow-outside', () => {
    const outside = tempDir('trackplan-out-');
    fs.symlinkSync(outside, path.join(cwd, 'src'));
    writePlan();
    expect(run(['generate']).err).toContain('outside the current directory');
    expect(run(['check']).code).toBe(exitToolFailure);
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(run(['generate', '--allow-outside']).code).toBe(exitOk);
    expect(fs.existsSync(path.join(outside, 'gen/analytics.ts'))).toBe(true);
  });
});

describe('docs', () => {
  it('writes TRACKING_PLAN.md and refuses foreign files', () => {
    writePlan();
    expect(run(['docs']).code).toBe(exitOk);
    expect(fs.readFileSync(path.join(cwd, 'TRACKING_PLAN.md'), 'utf8')).toMatch(
      /^<!-- Generated by trackplan from tracking_plan\.yaml\./,
    );
    expect(run(['docs']).code).toBe(exitOk);
    fs.writeFileSync(path.join(cwd, 'README.md'), '# Mine\n');
    expect(run(['docs', '--out', 'README.md']).code).toBe(exitToolFailure);
    expect(run(['docs', '--out', 'docs/events.txt']).code).toBe(exitOk);
  });
});
