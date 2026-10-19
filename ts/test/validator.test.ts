import { describe, expect, it } from 'vitest';

import {
  escapeForMessage,
  isDisallowedCharacter,
  sortDiagnostics,
  summaryLine,
} from '../src/diagnostic.js';
import {
  camelCase,
  editDistance,
  identifierFor,
  matchesNamePattern,
  pascalCase,
  suggest,
} from '../src/names.js';
import { headerFileName, textLines } from '../src/text.js';
import { outputPathProblem, validatePlan } from '../src/validator.js';

const encode = (text: string) => new TextEncoder().encode(text);
const validate = (yaml: string, allowOutside = false) =>
  validatePlan(encode(yaml), { allowOutside });
const diags = (yaml: string, allowOutside = false) =>
  validate(yaml, allowOutside).diagnostics.map(
    (d) => `${d.code} ${d.line}:${d.column} ${d.message}`,
  );
const codes = (yaml: string) => validate(yaml).diagnostics.map((d) => d.code);

const event = 'events:\n  app_opened:\n    description: Opened.\n';

describe('loading', () => {
  it('ignores a leading BOM and accepts CRLF', () => {
    expect(diags('\uFEFFversion: 1\r\nevents:\r\n  a: {description: d}\r\n')).toEqual([]);
  });

  it('reports a lone CR, raw control characters, directives and invalid UTF-8', () => {
    expect(diags('version: 1\n\na: b\rc: d\n')).toEqual([
      'TP005 3:5 Unsupported line ending: use LF or CRLF.',
    ]);
    expect(diags('version: 1\nname: a\u0007b\n')).toEqual([
      'TP007 2:8 The file contains the disallowed character U+0007.',
    ]);
    expect(diags('version: 1\n%TAG ! tag:x\n---\n')).toEqual([
      'TP003 2:1 YAML directives are not supported in tracking plans.',
    ]);
    expect(validatePlan(new Uint8Array([0x61, 0xff])).diagnostics[0]?.code).toBe('TP006');
  });

  it('reports syntax errors, multiple documents and duplicate keys', () => {
    expect(codes('a: [1\n')).toEqual(['TP001']);
    expect(codes('a: 1\n---\nb: 2\n')).toEqual(['TP001']);
    expect(diags('a: 1\nb: 2\na: 3\n')).toEqual(['TP002 3:1 Duplicate key "a".']);
    expect(diags('1: a\n01: b\n')).toEqual(['TP002 2:1 Duplicate key "01".']);
    expect(codes('a: *nope\n')).toEqual(['TP001']);
    expect(codes('a: "\\ud83d\\ude00"\n')).toEqual(['TP001']);
  });

  it('reports a duplicate inside a duplicate at the inner key, as Dart does', () => {
    expect(diags('a: {x: 1}\na:\n  b: 1\n  b: 2\n')).toEqual(['TP002 4:3 Duplicate key "b".']);
  });

  it('reports unsupported YAML features at the enclosing entry', () => {
    expect(diags('version: 1\nx: !!int abc\n')).toEqual([
      'TP003 2:1 YAML tags are not supported in tracking plans.',
    ]);
    expect(diags('a: &x 1\nb: *x\n')).toEqual([
      'TP003 1:1 YAML anchors are not supported in tracking plans.',
    ]);
    expect(diags('events:\n  !k app: 1\n')).toEqual([
      'TP003 1:1 YAML tags are not supported in tracking plans.',
    ]);
    expect(diags('!t {a: 1}\n')).toEqual([
      'TP003 1:1 YAML tags are not supported in tracking plans.',
    ]);
    expect(codes('x: !e!foo y\n')).toEqual(['TP003']);
  });

  it('accepts text that only looks like YAML features', () => {
    const found = codes('a: Tom & Jerry\nb: a *b\nc: "&x"\n# see !important\nd: "!x"\n');
    expect(found).not.toContain('TP003');
    expect(found).toContain('TP011');
  });

  it('reports an empty file and a non-mapping root as TP004', () => {
    expect(codes('')).toEqual(['TP004']);
    expect(codes('- a\n')).toEqual(['TP004']);
  });

  it('reports an empty explicit key at its question mark', () => {
    expect(diags('version: 1\nevents:\n  ? \n  : {}\n')).toEqual([
      'TP012 3:3 Keys must be strings, got null. Quote the key.',
    ]);
  });
});

describe('model', () => {
  it('uses defaults and sorts by UTF-16 code units', () => {
    const plan = validate(
      'version: 1\nenums:\n  b_e: {values: [x]}\n  a_e: {values: [y]}\nevents:\n' +
        '  step_1: {description: d, params: {p: {type: enum, enum: b_e}}}\n' +
        '  step2: {description: d, params: {p: {type: enum, enum: a_e}}}\n',
    ).plan;
    expect(plan?.typescriptClassName).toBe('Analytics');
    expect(plan?.typescriptOutput).toBe('src/analytics/analytics.ts');
    expect(plan?.events.map((e) => e.name)).toEqual(['step2', 'step_1']);
    expect(plan?.enums.map((e) => e.name)).toEqual(['a_e', 'b_e']);
  });

  it('treats null sections as empty and keeps numbers as written', () => {
    const result = validate(
      'version: 1\nmeta:\ntargets:\n  dart:\nsettings:\nenums:\nevents:\n  a:\n    description: d\n' +
        '    params:\n      x: {type: double, min: 0.50, max: 10}\n',
    );
    expect(result.diagnostics).toEqual([]);
    const param = result.plan?.events[0]?.params[0];
    expect([param?.min, param?.max]).toEqual(['0.50', '10']);
  });
});

describe('validation rules', () => {
  const param = (options: string) =>
    `version: 1\nevents:\n  e:\n    description: d\n    params:\n      x: {${options}}\n`;

  it('checks version type and value', () => {
    expect(diags(`version:\n${event}`)).toEqual([
      'TP012 1:1 Expected an integer for "version", got null.',
    ]);
    expect(diags(`version: 1.0\n${event}`)).toEqual([
      'TP013 1:10 Unsupported version 1.0. The only supported version is 1.',
    ]);
  });

  it('checks numbers in SPEC order', () => {
    expect(diags(param('type: double, max: 9007199254740992'))).toEqual([
      'TP037 6:30 Invalid number 9007199254740992 for "max": out of range.',
    ]);
    expect(diags(param('type: string, max_length: 0x10'))[0]).toContain(
      'expected a decimal number',
    );
    expect(diags(param('type: string, max_length: 1.5'))[0]).toContain('expected an integer.');
    expect(diags(param('type: string, max_length: -1'))[0]).toContain('at least 1');
    expect(diags(param('type: int, min: 3, max: 3'))).toEqual([]);
    expect(codes(param('type: int, min: 5, max: 1'))).toEqual(['TP036']);
  });

  it('skips option checks when the type is missing or not a string', () => {
    expect(diags(param('min: abc, enum: 5'))).toEqual([
      'TP010 6:7 Missing required key "type" in param "x" of event "e".',
    ]);
    expect(diags(param('type: 1, max_length: 0'))).toEqual([
      'TP012 6:17 Expected a string for "type", got an integer.',
    ]);
  });

  it('suggests types and keys', () => {
    expect(diags(param('type: float'))[0]).toContain('Did you mean "double"?');
    expect(diags(param('type: whatever'))[0]).toContain('Supported types:');
    expect(diags(param('type: string, requried: false'))[0]).toContain('Did you mean "required"?');
  });

  it('reports enum problems', () => {
    expect(codes(`version: 1\nenums:\n  e: {values: [Pro, Pro]}\n${event}`)).toEqual([
      'TP020',
      'TP020',
      'TP035',
    ]);
    expect(codes(`version: 1\nenums:\n  map_entry: {values: [a]}\n${event}`)).toEqual(['TP022']);
    expect(
      codes(
        'version: 1\ntargets:\n  dart: {class_name: Step2Done}\nenums:\n' +
          `  step_2_done: {values: [a]}\n  step2_done: {values: [b]}\n${event}`,
      ),
    ).toEqual(['TP022', 'TP021', 'TP022']);
    expect(
      codes(
        'version: 1\ntargets:\n  dart: {class_name: bad}\n  typescript: {class_name: bad}\n' +
          'enums:\n  analytics: {values: [a]}\nevents:\n  e: {description: d, params: {p: {type: enum, enum: analytics}}}\n',
      ),
    ).toEqual(['TP023', 'TP023']);
    expect(codes(`version: 1\nenums:\n  unused: {values: [a]}\n${event}`)).toEqual(['TP101']);
  });

  it('counts events with non-string keys as present', () => {
    expect(codes('version: 1\nevents:\n  1: {}\n')).toEqual(['TP012']);
  });

  it('applies provider checks only to valid names', () => {
    const plan =
      'version: 1\nsettings: {warn_provider_limits: [firebase, firebase]}\nevents:\n  e:\n    description: d\n' +
      '    params:\n      Bad: {type: string, max_length: 200}\n      Flag: {type: bool}\n';
    expect(codes(plan)).toEqual(['TP020', 'TP020']);
  });

  it('rejects blank tags, unsafe output paths and control characters', () => {
    expect(codes('version: 1\nevents:\n  e: {description: d, tags: ["  ", a]}\n')).toEqual([
      'TP012',
    ]);
    expect(diags(`version: 1\ntargets:\n  dart: {output: "a\\e[2Jb.dart"}\n${event}`)).toEqual([
      'TP024 3:18 "output" contains the disallowed character U+001B.',
    ]);
    expect(diags(`version: 1\nevents:\n  "a\\tb": {description: d}\n`)).toEqual([
      'TP020 3:3 Invalid event name "a\\u{0009}b": use lowercase snake_case starting with a letter.',
    ]);
    expect(diags(`version: 1\ntargets:\n  typescript: {output: ../x.ts}\n${event}`, true)).toEqual(
      [],
    );
  });

  it('treats only space, tab, LF and CR as whitespace', () => {
    expect(codes('version: 1\nevents:\n  e: {description: "\\u00A0"}\n')).toEqual([]);
    expect(codes('version: 1\nevents:\n  e: {description: "  "}\n')).toEqual(['TP100']);
  });
});

describe('helpers', () => {
  it('outputPathProblem follows SPEC 2.4', () => {
    expect(outputPathProblem('lib/a.ts', false)).toBeUndefined();
    expect(outputPathProblem('', true)).toBe('empty');
    expect(outputPathProblem('/a.ts', false)).toBe('absolute');
    expect(outputPathProblem('C:/a.ts', false)).toBe('absolute');
    expect(outputPathProblem('C:/a.ts', true)).toBeUndefined();
    expect(outputPathProblem('a/../b.ts', false)).toBe('..');
    expect(outputPathProblem('.GIT./x.ts', true)).toBe('.git');
    expect(outputPathProblem('GIT~1/x.ts', false)).toBe('.git');
    expect(outputPathProblem('a/b.ts:x', false)).toBe('colon');
    expect(outputPathProblem('.github/x.ts', false)).toBeUndefined();
  });

  it('converts names and renames reserved words', () => {
    expect(matchesNamePattern('step_2_done')).toBe(true);
    expect(matchesNamePattern('a__b')).toBe(false);
    expect([camelCase('step_2_done'), pascalCase('x_y_z')]).toEqual(['step2Done', 'XYZ']);
    expect(identifierFor('class', 'param')).toBe('class_');
    expect(identifierFor('type', 'param')).toBe('type');
    expect(identifierFor('to_string', 'method')).toBe('toString_');
    expect(identifierFor('to_string', 'param')).toBe('toString_');
    expect(identifierFor('values', 'enumValue')).toBe('values_');
  });

  it('suggests with SPEC tie-breaking and length rule', () => {
    expect(editDistance('requried', 'required')).toBe(2);
    expect(suggest('mix', ['min', 'max'])).toBe('min');
    expect(suggest('a', ['max'])).toBeUndefined();
    expect(suggest('z'.repeat(400), ['zz'])).toBeUndefined();
  });

  it('escapes, sorts and summarizes diagnostics', () => {
    expect(escapeForMessage('a\u001B\t\u202E')).toBe('a\\u{001B}\\u{0009}\\u{202E}');
    expect(isDisallowedCharacter(0x0a)).toBe(false);
    expect(isDisallowedCharacter(0xfeff)).toBe(true);
    const d = (code: string, line: number, severity: 'error' | 'warning' = 'error') => ({
      code,
      severity,
      line,
      column: 1,
      message: 'm',
    });
    expect(
      sortDiagnostics([d('TP100', 1, 'warning'), d('TP020', 1), d('TP010', 0)]).map((x) => x.code),
    ).toEqual(['TP010', 'TP020', 'TP100']);
    expect(summaryLine([d('TP010', 1), d('TP100', 1, 'warning'), d('TP101', 1, 'warning')])).toBe(
      '1 error, 2 warnings.',
    );
  });

  it('handles text lines and header file names', () => {
    expect(textLines('\n\na \t\r\n\u00A0b\n\n')).toEqual(['a', '\u00A0b']);
    const start = Date.now();
    expect(textLines(`a${' '.repeat(200_000)}b${' '.repeat(200_000)}`)).toEqual([
      `a${' '.repeat(200_000)}b`,
    ]);
    expect(Date.now() - start).toBeLessThan(10_000);
    expect(headerFileName('config\\plan.yaml')).toBe('plan.yaml');
    expect(headerFileName('a\nb*?.yaml')).toBe('a_b__.yaml');
  });
});

describe('review and audit regressions', () => {
  it('does not mistake text ending in ! or & for a tag or anchor', () => {
    expect(
      codes('version: 1\nevents:\n  e:\n    description: "Bienvenue !"\n    owner: o\n'),
    ).toEqual([]);
    expect(codes('version: 1\nevents:\n  e:\n    description: Tom &\n    owner: o\n')).toEqual([]);
  });

  it('finds anchors behind comments and after # inside quotes', () => {
    expect(codes('version: 1\nevents:\n  e:\n    description: &x # c\n      hello\n')).toEqual([
      'TP003',
    ]);
    expect(codes('version: 1\nevents:\n  e: {description: d, tags: ["x #", &q y]}\n')).toEqual([
      'TP003',
    ]);
  });

  it('compares duplicate keys like Dart', () => {
    expect(
      codes('9007199254740993: a\n9007199254740992: b\n').filter((c) => c !== 'TP010'),
    ).toEqual(['TP012', 'TP012']);
    expect(codes('.nan: a\n.NaN: b\n')).toEqual(['TP002']);
    expect(codes('1: a\n1.0: b\n')).toEqual(['TP002']);
    expect(codes('&k x: 1\n*k : 2\n')).toEqual(['TP002']);
  });

  it('never looks up plan text on Object.prototype', () => {
    expect(
      diags(
        'version: 1\nevents:\n  e:\n    description: d\n    params:\n      x: {type: constructor}\n',
      ),
    ).toEqual([
      'TP030 6:17 Unknown type "constructor". Supported types: string, int, double, bool, enum, list<string>.',
    ]);
  });

  it('renames params and events that match Object members or then', () => {
    expect(identifierFor('value_of', 'param')).toBe('valueOf_');
    expect(identifierFor('then', 'method')).toBe('then_');
    expect(identifierFor('to_j_s_o_n', 'method')).toBe('toJSON_');
    expect(identifierFor('index', 'param')).toBe('index');
  });

  it('rejects tabs at the start of a line and invisible characters in output paths', () => {
    expect(diags('version: 1\nevents:\n\ta: {}\n')).toEqual([
      'TP008 3:1 Tab at the start of a line: indent with spaces.',
    ]);
    expect(
      codes(`version: 1\ntargets:\n  typescript: {output: ".g\\u200Cit/x.ts"}\n${event}`),
    ).toEqual(['TP024']);
  });

  it('stays fast on many keys, tags and aliases', () => {
    const start = Date.now();
    validate(
      `version: 1\nevents:\n${Array.from({ length: 40_000 }, (_, i) => `  e${i}: {description: d}\n`).join('')}`,
    );
    validate(`version: 1\nx: [${Array.from({ length: 40_000 }, () => '!!str a').join(', ')}]\n`);
    validate(`version: 1\nx: [&a x, ${Array.from({ length: 40_000 }, () => '*a').join(', ')}]\n`);
    expect(Date.now() - start).toBeLessThan(20_000);
  });
});
