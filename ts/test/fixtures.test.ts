// Runs every shared fixture in ../fixtures (SPEC.md section 10).
//
// Set UPDATE_GOLDENS=1 to rewrite expected files that differ. Rewritten files
// are printed and the test fails, so an update run never looks like a normal
// green run. Review the diff before committing.
import * as fs from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { exitInvalid, exitOk, runCli } from '../src/cli.js';
import { type Diagnostic, diagnosticsToJson } from '../src/diagnostic.js';
import { generateDocs } from '../src/docsGenerator.js';
import { generateTypescript } from '../src/tsGenerator.js';
import { validatePlan } from '../src/validator.js';

const updateGoldens = process.env['UPDATE_GOLDENS'] === '1';
const root =
  process.env['TRACKPLAN_FIXTURES'] ?? path.resolve(import.meta.dirname, '..', '..', 'fixtures');
if (!fs.existsSync(root)) throw new Error(`Fixtures not found at ${root}.`);

function cases(kind: string): string[] {
  return fs
    .readdirSync(path.join(root, kind), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

function expectFile(file: string, actual: string): void {
  const expected = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
  if (expected === actual) return;
  if (updateGoldens) {
    fs.writeFileSync(file, actual);
    console.log(`UPDATED ${file}`);
  }
  expect(actual, `Output differs from ${file}`).toBe(expected);
}

interface JsonDiagnostic {
  code: string;
  severity: string;
  line: number | null;
  column: number | null;
  message: string | null;
}

interface JsonResult {
  file: string;
  error_count: number;
  warning_count: number;
  diagnostics: JsonDiagnostic[];
}

/** Field-by-field comparison; null in the fixture means "not compared" (TP001 only). */
function expectDiagnostics(file: string, diagnostics: readonly Diagnostic[]): void {
  const actual = JSON.parse(diagnosticsToJson('plan.yaml', diagnostics)) as JsonResult;
  if (!fs.existsSync(file)) {
    expect(diagnostics, `No ${file}, so no diagnostics expected`).toEqual([]);
    return;
  }
  const expected = JSON.parse(fs.readFileSync(file, 'utf8')) as JsonResult;
  const normalized = {
    ...actual,
    diagnostics: actual.diagnostics.map((d, i) => {
      const e = expected.diagnostics[i];
      if (e?.code !== 'TP001') return d;
      // null in the fixture means "not compared"; the tool must still report a position.
      expect(typeof d.line).toBe('number');
      expect(typeof d.message).toBe('string');
      return {
        ...d,
        line: e.line ?? null,
        column: e.column ?? null,
        message: e.message ?? null,
        ...(e.line === null ? {} : { line: d.line }),
        ...(e.column === null ? {} : { column: d.column }),
        ...(e.message === null ? {} : { message: d.message }),
      };
    }),
  };
  const matches = JSON.stringify(normalized) === JSON.stringify(expected);
  if (!matches && updateGoldens && !expected.diagnostics.some((d) => d.line === null)) {
    fs.writeFileSync(file, diagnosticsToJson('plan.yaml', diagnostics));
    console.log(`UPDATED ${file}`);
  }
  expect(normalized, `Diagnostics differ from ${file}`).toEqual(expected);
}

describe('valid fixtures', () => {
  for (const name of cases('valid')) {
    describe(name, () => {
      const dir = path.join(root, 'valid', name);
      const result = validatePlan(fs.readFileSync(path.join(dir, 'plan.yaml')));

      it('has no errors and the expected warnings', () => {
        expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
        expectDiagnostics(path.join(dir, 'expected_errors.json'), result.diagnostics);
      });

      it('generates expected.ts', () => {
        expect(result.plan).toBeDefined();
        if (result.plan)
          expectFile(path.join(dir, 'expected.ts'), generateTypescript(result.plan, 'plan.yaml'));
      });

      it('generates expected_docs.md', () => {
        expect(result.plan).toBeDefined();
        if (result.plan)
          expectFile(path.join(dir, 'expected_docs.md'), generateDocs(result.plan, 'plan.yaml'));
      });
    });
  }
});

describe('invalid fixtures', () => {
  for (const name of cases('invalid')) {
    const dir = path.join(root, 'invalid', name);
    const expectedPath = path.join(dir, 'expected_errors.json');

    it(`${name}: diagnostics`, () => {
      const result = validatePlan(fs.readFileSync(path.join(dir, 'plan.yaml')));
      expectDiagnostics(expectedPath, result.diagnostics);
      const expected = JSON.parse(fs.readFileSync(expectedPath, 'utf8')) as JsonResult;
      expect(result.plan === undefined).toBe(expected.error_count > 0);
    });

    it(`${name}: validate --json matches byte for byte`, ({ skip }) => {
      const expected = fs.readFileSync(expectedPath, 'utf8');
      if (expected.includes('"line": null')) skip('TP001 positions are not compared');
      let out = '';
      let err = '';
      const code = runCli(['validate', '--plan', 'plan.yaml', '--json'], {
        cwd: dir,
        out: { write: (s) => (out += s) },
        err: { write: (s) => (err += s) },
      });
      expect(err).toBe('');
      expect(out).toBe(expected);
      expect(code).toBe(expected.includes('"error_count": 0') ? exitOk : exitInvalid);
    });
  }
});
