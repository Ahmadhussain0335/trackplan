// Differential test: runs the Dart and TypeScript CLIs on the same plans and
// fails if their `validate --json` output, exit code, or generated docs
// differ. When either tool reports TP001, only the exit codes are compared,
// because the two YAML parsers accept slightly different malformed input
// (SPEC.md section 5.2).
//
// Usage (from the repository root, after `npm run build` in ts/):
//   node tool/parity.mjs
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'trackplan-parity-'));
const dartExe = path.join(work, 'trackplan-dart');
execFileSync('dart', ['compile', 'exe', path.join(root, 'dart/bin/trackplan.dart'), '-o', dartExe], {
  cwd: path.join(root, 'dart'),
  stdio: 'ignore',
});
const tsBin = path.join(root, 'ts/dist/bin.js');
if (!fs.existsSync(tsBin)) throw new Error('Build the TypeScript package first (npm run build in ts/).');

// Small deterministic PRNG so every run checks the same mutations.
let seed = 20261019;
const random = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};
const pick = (list) => list[Math.floor(random() * list.length)];

const plans = new Map();
for (const kind of ['valid', 'invalid']) {
  for (const name of fs.readdirSync(path.join(root, 'fixtures', kind))) {
    const file = path.join(root, 'fixtures', kind, name, 'plan.yaml');
    if (fs.existsSync(file)) plans.set(`${kind}/${name}`, fs.readFileSync(file));
  }
}

const edgeCases = {
  'null-key': 'version: 1\nevents:\n  ? \n  : {}\n',
  'int-key-only': 'version: 1\nevents:\n  1: {}\n',
  'nested-dup-in-dup': 'version: 1\nevents:\n  a: {description: d}\n  a:\n    b: 1\n    b: 2\n',
  'dup-then-syntax-error': 'a: 1\na: 2\nb: [1\n',
  'syntax-error-then-dup': 'a: [1\nb: 1\nb: 2\n',
  'dup-int-keys': '1: a\n01: b\n',
  'dup-complex-keys': '? [a]\n: 1\n? [a]\n: 2\n',
  'core-tag-mismatch': 'version: 1\nx: !!int abc\n',
  'verbatim-tag': 'x: !<tag:x> y\n',
  'undefined-tag-handle': 'x: !e!foo y\n',
  'undefined-alias': 'a: *nope\n',
  'anchor-and-tag': 'a: &x !t v\n',
  'tag-on-key': 'events:\n  !k app: 1\n',
  'tagged-root': '!t {a: 1}\n',
  'comment-with-bang': 'version: 1\n# see !important\nevents:\n  a: {description: d}\n',
  'anchor-in-flow': 'version: 1\nl: [&x a]\n',
  'merge-key-nested': 'version: 1\nevents:\n  a:\n    <<: {description: d}\n',
  'version-float': 'version: 1.0\nevents:\n  a: {description: d}\n',
  'version-null': 'version:\nevents:\n  a: {description: d}\n',
  'version-hex': 'version: 0x1\nevents:\n  a: {description: d}\n',
  'big-numbers': 'version: 1\nevents:\n  a:\n    description: d\n    params:\n      x: {type: double, min: 9007199254740992, max: 1e3}\n      y: {type: int, min: .inf}\n      z: {type: string, max_length: 0o17}\n',
  'blank-tag': 'version: 1\nevents:\n  e: {description: d, tags: ["  ", a]}\n',
  'nbsp-description': 'version: 1\nevents:\n  e: {description: "\\u00A0"}\n',
  'escaped-control-key': 'version: 1\nevents:\n  "a\\tb": {description: d}\n',
  'output-escape': 'version: 1\ntargets:\n  dart: {output: "a\\e[2Jb.dart"}\nevents:\n  a: {description: d}\n',
  'git-aliases': 'version: 1\ntargets:\n  dart: {output: ".GIT./x.dart"}\n  typescript: {output: "a/b.ts:x"}\nevents:\n  a: {description: d}\n',
  'class-name-collisions': 'version: 1\ntargets:\n  dart: {class_name: Step2Done}\n  typescript: {class_name: bad}\nenums:\n  step_2_done: {values: [a]}\n  step2_done: {values: [b]}\nevents:\n  a: {description: d}\n',
  'missing-type-bad-options': 'version: 1\nevents:\n  e:\n    description: d\n    params:\n      p: {min: abc, enum: 5}\n',
  'provider-invalid-param': 'version: 1\nsettings: {warn_provider_limits: [firebase, firebase]}\nevents:\n  e:\n    description: d\n    params:\n      Bad: {type: string, max_length: 200}\n      Flag: {type: bool}\n',
  'enum-dupes': 'version: 1\nenums:\n  e: {values: [Bad, Bad, ok, ok]}\nevents:\n  a: {description: d}\n',
  'empty-file': '',
  'only-comment': '# nothing\n',
  'scalar-root': 'hello\n',
  'list-root': '- a\n',
  'crlf': 'version: 1\r\nevents:\r\n  a:\r\n    description: d\r\n',
  'bom': '\uFEFFversion: 1\nevents:\n  a: {description: d}\n',
  'emoji-columns': 'version: 1\nevents:\n  a: {description: "😀", owner: [x]}\n',
  'multiline-plain': 'version: 1\nevents:\n  a:\n    description: first\n      second\n    owner: 12\n',
  'block-scalar-version': 'version: |\n  1\nevents:\n  a: {description: d}\n',
  'quoted-multiline-type': 'version: 1\nevents:\n  a:\n    description: d\n    params:\n      p: {type: "str\n        ing"}\n',
  'bang-before-key': 'version: 1\nevents:\n  e:\n    description: "Bienvenue !"\n    owner: o\n',
  'ampersand-before-key': 'version: 1\nevents:\n  e:\n    description: Tom &\n    owner: o\n',
  'anchor-before-comment': 'version: 1\nevents:\n  e:\n    description: &x # c\n      hello\n',
  'hash-in-quotes-then-anchor': 'version: 1\nevents:\n  e: {description: d, tags: ["x #", &q y]}\n',
  'big-int-keys': '9007199254740993: a\n9007199254740992: b\n',
  'nan-keys': '.nan: a\n.NaN: b\n',
  'int-float-keys': '1: a\n1.0: b\n',
  'alias-key': '&k x: 1\n*k : 2\n',
  'type-constructor': 'version: 1\nevents:\n  e:\n    description: d\n    params:\n      x: {type: constructor}\n',
  'tab-in-block-map': 'version: 1\nevents:\n  a:\n\tdescription: d\n',
  'tab-in-flow-map': 'version: 1\nevents:\n  a: {description: d,\n\towner: x}\n',
  'then-and-value-of': 'version: 1\nevents:\n  then:\n    description: d\n    params:\n      value_of: {type: int, required: false}\n',
  'invisible-path': 'version: 1\ntargets:\n  dart: {output: ".g\\u200Cit/x.dart"}\nevents:\n  a: {description: d}\n',
  'deep-unknown-keys': 'version: 1\nmeta: {nme: x}\ntargets: {dartt: {}}\nsettings: {warn: []}\nenums:\n  e: {valuse: [a]}\nevents:\n  a: {descripton: d, params: {p: {tpye: string}}}\n',
};
for (const [name, text] of Object.entries(edgeCases)) plans.set(`edge/${name}`, Buffer.from(text));

// Values and keys that keep the YAML well-formed but exercise the validator.
const valuePool = [
  'string', 'int', 'double', 'bool', 'enum', 'list<string>', 'float', 'strng', '1', '0', '-3', '1.5', '0x10',
  '9007199254740992', 'true', 'false', '~', '""', '"  "', '[]', '[a, b]', '{}', 'Bad', 'x_y', 'a__b', 'payment_method',
  'app_theme', 'firebase', 'mixpanel', '../x.dart', 'lib/a.ts', '.git/x.dart', 'Analytics', 'MapEntry', '|\n      text',
];
const keyPool = [
  'type', 'description', 'required', 'min', 'max', 'max_length', 'enum', 'owner', 'tags', 'deprecated', 'params',
  'values', 'output', 'class_name', 'runtime_checks', 'warn_provider_limits', 'name', 'requried', 'Bad_Name',
  'class', 'to_string', 'step_2', 'step2', 'first_open', 'ga_x', '"1"',
];
const semanticMutate = (text) => {
  const lines = text.split('\n');
  const candidates = lines.map((l, i) => (/^\s*[^\s#][^:]*:( |$)/.test(l) ? i : -1)).filter((i) => i >= 0);
  if (candidates.length === 0) return text;
  const i = pick(candidates);
  const match = /^(\s*)([^:]+):(.*)$/.exec(lines[i]);
  if (match === null) return text;
  const [, indent, key, rest] = match;
  lines[i] = random() < 0.5 ? `${indent}${pick(keyPool)}:${rest}` : `${indent}${key}: ${pick(valuePool)}`;
  return lines.join('\n');
};
for (const [name, bytes] of [...plans]) {
  if (!name.startsWith('valid/')) continue;
  for (let n = 0; n < 40; n++) {
    let text = bytes.toString('utf8');
    for (let k = 0; k <= n % 3; k++) text = semanticMutate(text);
    plans.set(`semantic/${name}/${n}`, Buffer.from(text));
  }
}

// Mutations of every fixture plan.
const mutate = (text) => {
  const lines = text.split('\n');
  const i = Math.floor(random() * lines.length);
  switch (pick(['delete', 'duplicate', 'indent', 'dedent', 'insert', 'swap'])) {
    case 'delete':
      lines.splice(i, 1);
      break;
    case 'duplicate':
      lines.splice(i, 0, lines[i] ?? '');
      break;
    case 'indent':
      lines[i] = `  ${lines[i] ?? ''}`;
      break;
    case 'dedent':
      lines[i] = (lines[i] ?? '').replace(/^ {1,2}/, '');
      break;
    case 'insert': {
      const line = lines[i] ?? '';
      const at = Math.floor(random() * (line.length + 1));
      lines[i] = line.slice(0, at) + pick([':', '-', '"', "'", '[', '{', '#', '&a ', '!t ', ' ', 'X', '0', '\t', '~', '*a']) + line.slice(at);
      break;
    }
    case 'swap': {
      const j = Math.floor(random() * lines.length);
      [lines[i], lines[j]] = [lines[j] ?? '', lines[i] ?? ''];
      break;
    }
  }
  return lines.join('\n');
};
for (const [name, bytes] of [...plans]) {
  if (!name.startsWith('valid/') && !name.startsWith('invalid/')) continue;
  if (name.endsWith('/invalid_utf8') || name.endsWith('/lone_cr') || name.endsWith('/firebase_event_count')) continue;
  let text = bytes.toString('utf8');
  for (let n = 0; n < 15; n++) {
    text = mutate(text);
    plans.set(`mutation/${name}/${n}`, Buffer.from(text));
  }
}

const run = (command, args, cwd) => {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  return { code: result.status, out: result.stdout, err: result.stderr };
};

const normalize = (json) => {
  const value = JSON.parse(json);
  for (const d of value.diagnostics) {
    if (d.code === 'TP001') d.line = d.column = d.message = null;
  }
  return JSON.stringify(value, null, 2);
};

let failures = 0;
let exitOnly = 0;
for (const [name, bytes] of plans) {
  const dir = fs.mkdtempSync(path.join(work, 'case-'));
  fs.writeFileSync(path.join(dir, 'plan.yaml'), bytes);
  const args = ['validate', '--plan', 'plan.yaml', '--json'];
  const dart = run(dartExe, args, dir);
  const ts = run('node', [tsBin, ...args], dir);
  let problem;
  if (dart.code !== ts.code) {
    problem = `exit code: dart ${dart.code}, ts ${ts.code}\n${dart.err}${ts.err}`;
  } else if (dart.code === 2) {
    // Both failed as a tool error; nothing to compare.
  } else if (/"TP001"/.test(dart.out) || /"TP001"/.test(ts.out)) {
    // Not well-formed YAML: the parsers may disagree on TP001 vs TP002/TP003
    // (SPEC.md section 5.2); matching exit codes is enough.
    exitOnly++;
  } else if (normalize(dart.out) !== normalize(ts.out)) {
    problem = `diagnostics differ\n--- dart\n${normalize(dart.out)}\n--- ts\n${normalize(ts.out)}`;
  } else if (dart.code === 0) {
    const dartDocs = run(dartExe, ['docs', '--plan', 'plan.yaml', '--out', 'dart.md'], dir);
    const tsDocs = run('node', [tsBin, 'docs', '--plan', 'plan.yaml', '--out', 'ts.md'], dir);
    if (dartDocs.code !== 0 || tsDocs.code !== 0) {
      problem = `docs failed: ${dartDocs.err}${tsDocs.err}`;
    } else if (!fs.readFileSync(path.join(dir, 'dart.md')).equals(fs.readFileSync(path.join(dir, 'ts.md')))) {
      problem = 'generated docs differ';
    }
  }
  if (problem !== undefined) {
    failures++;
    console.log(`FAIL ${name}: ${problem}\n--- plan\n${bytes.toString('utf8')}\n`);
  }
}
console.log(
  `${plans.size} plans compared (${plans.size - exitOnly} in full, ${exitOnly} malformed YAML by exit code only), ${failures} differences.`,
);
fs.rmSync(work, { recursive: true, force: true });
process.exitCode = failures === 0 ? 0 : 1;
