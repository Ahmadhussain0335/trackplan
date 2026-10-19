// Checks that generated code compiles with tsc under strict settings, for
// every valid fixture and for a plan that uses every reserved word, and that
// it behaves as documented at runtime.
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import {
  matchesNamePattern,
  reservedEnumValueNames,
  reservedMethodNames,
  reservedWords,
} from '../src/names.js';
import { generateTypescript } from '../src/tsGenerator.js';
import { validatePlan } from '../src/validator.js';

const fixtures = path.resolve(import.meta.dirname, '..', '..', 'fixtures', 'valid');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'trackplan-compile-'));
afterAll(() => {
  fs.rmSync(work, { recursive: true, force: true });
});

const snake = (camel: string) => camel.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

function stressPlan(): string {
  const words = [
    ...new Set([
      ...reservedWords,
      ...[...reservedMethodNames].map(snake),
      ...[...reservedEnumValueNames].map(snake),
      'type',
      'get',
      'set',
      'params',
      'payload',
      'track',
      'adapters',
      'copy',
      'value',
      'event',
    ]),
  ]
    .filter(matchesNamePattern)
    .sort();
  const types = ['string', 'int', 'double', 'bool', 'list<string>'];
  const lines = [
    'version: 1',
    'enums:',
    '  every_word:',
    `    values: [${words.map((w) => `"${w}"`).join(', ')}]`,
    'events:',
  ];
  for (const word of words) {
    lines.push(`  "${word}":`, `    description: Event named ${word}.`, '    params:');
    words.forEach((param, i) => {
      lines.push(
        `      "${param}": {type: ${types[i % 5]}${i % 2 === 0 ? '' : ', required: false'}}`,
      );
    });
    lines.push('      e: {type: enum, enum: every_word, required: false}');
  }
  return `${lines.join('\n')}\n`;
}

describe('generated TypeScript', () => {
  it('compiles with tsc under strict flags', () => {
    const plans = new Map<string, Uint8Array>();
    for (const entry of fs.readdirSync(fixtures, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      plans.set(name, fs.readFileSync(path.join(fixtures, name, 'plan.yaml')));
    }
    plans.set('stress', new TextEncoder().encode(stressPlan()));
    for (const [name, bytes] of plans) {
      const result = validatePlan(bytes);
      expect(result.plan, `${name}: ${JSON.stringify(result.diagnostics)}`).toBeDefined();
      if (result.plan)
        fs.writeFileSync(
          path.join(work, `${name}.ts`),
          generateTypescript(result.plan, 'plan.yaml'),
        );
    }
    fs.writeFileSync(path.join(work, 'package.json'), '{"type": "module"}\n');
    const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
    const files = fs.readdirSync(work).filter((f) => f.endsWith('.ts'));
    const flags = [
      '--noEmit',
      '--strict',
      '--target',
      'es2022',
      '--module',
      'nodenext',
      '--moduleResolution',
      'nodenext',
      '--exactOptionalPropertyTypes',
      '--noUncheckedIndexedAccess',
      '--noPropertyAccessFromIndexSignature',
      '--noImplicitOverride',
      '--noUnusedLocals',
      '--noUnusedParameters',
      '--verbatimModuleSyntax',
      '--isolatedModules',
      '--erasableSyntaxOnly',
      '--lib',
      'es2022',
      '--types',
      'node',
      '--typeRoots',
      path.resolve(import.meta.dirname, '..', 'node_modules', '@types'),
    ];
    try {
      execFileSync(process.execPath, [tsc, ...flags, ...files], { cwd: work, encoding: 'utf8' });
    } catch (error) {
      throw new Error(`tsc failed:\n${(error as { stdout?: string }).stdout ?? String(error)}`, {
        cause: error,
      });
    }
  });

  it('freezes params and lists', async () => {
    const result = validatePlan(fs.readFileSync(path.join(fixtures, 'all_types', 'plan.yaml')));
    if (!result.plan) throw new Error('plan expected');
    // Node 20 cannot import .ts files, so emit JavaScript with tsc first.
    const dir = fs.mkdtempSync(path.join(work, 'run-'));
    fs.writeFileSync(path.join(dir, 'analytics.ts'), generateTypescript(result.plan, 'plan.yaml'));
    fs.writeFileSync(path.join(dir, 'package.json'), '{"type": "module"}\n');
    const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
    execFileSync(
      process.execPath,
      [
        tsc,
        '--target',
        'es2022',
        '--module',
        'nodenext',
        '--moduleResolution',
        'nodenext',
        'analytics.ts',
      ],
      { cwd: dir },
    );
    const generated = (await import(pathToFileURL(path.join(dir, 'analytics.js')).href)) as {
      Tracker: new (adapters: unknown[]) => {
        profileUpdated(params: Record<string, unknown>): void;
      };
      RecordingAnalyticsAdapter: new () => {
        events: { event: string; params: Record<string, unknown> }[];
      };
    };
    const recorder = new generated.RecordingAnalyticsAdapter();
    const interests = ['a'];
    new generated.Tracker([recorder]).profileUpdated({
      displayName: 'n',
      age: 20,
      heightCm: 1.8,
      newsletterOptIn: true,
      theme: 'dark',
      interests,
    });
    interests.push('b');
    const params = recorder.events[0]?.params;
    expect(params?.['interests']).toEqual(['a']);
    expect(Object.isFrozen(params)).toBe(true);
    expect(Object.isFrozen(params?.['interests'])).toBe(true);
  });

  it('leaves out omitted optional params and runs runtime checks', async () => {
    const compile = async (fixture: string) => {
      const result = validatePlan(fs.readFileSync(path.join(fixtures, fixture, 'plan.yaml')));
      if (!result.plan) throw new Error('plan expected');
      const dir = fs.mkdtempSync(path.join(work, 'run-'));
      fs.writeFileSync(
        path.join(dir, 'analytics.ts'),
        generateTypescript(result.plan, 'plan.yaml'),
      );
      fs.writeFileSync(path.join(dir, 'package.json'), '{"type": "module"}\n');
      const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
      execFileSync(
        process.execPath,
        [
          tsc,
          '--target',
          'es2022',
          '--module',
          'nodenext',
          '--moduleResolution',
          'nodenext',
          'analytics.ts',
        ],
        { cwd: dir },
      );
      return (await import(pathToFileURL(path.join(dir, 'analytics.js')).href)) as Record<
        string,
        unknown
      >;
    };
    type Recorder = { events: { event: string; params: Record<string, unknown> }[] };
    type Ctor<T> = new (adapters: unknown[]) => T;

    const optional = await compile('optional_params');
    const recorder = new (optional['RecordingAnalyticsAdapter'] as new () => Recorder)();
    const a = new (
      optional['Analytics'] as Ctor<{ screenViewed(p?: Record<string, unknown>): void }>
    )([recorder]);
    a.screenViewed();
    a.screenViewed({ screenName: undefined, loadTimeMs: 12 });
    expect(recorder.events.map((e) => e.params)).toEqual([{}, { load_time_ms: 12 }]);

    const checked = await compile('runtime_checks');
    const b = new (checked['Analytics'] as Ctor<{ itemRated(p: Record<string, unknown>): void }>)(
      [],
    );
    b.itemRated({ itemId: 'i', stars: 3, weight: 0 });
    expect(() => {
      b.itemRated({ itemId: 'i', stars: 6, weight: 0 });
    }).toThrow('stars must be <= 5');
    expect(() => {
      b.itemRated({ itemId: 'i', stars: 2.5, weight: 0 });
    }).toThrow('stars must be an integer');
    expect(() => {
      b.itemRated({ itemId: 'i', stars: 3, weight: Number.NaN });
    }).toThrow('weight must be >= -1.5');
    expect(() => {
      b.itemRated({ itemId: 'x'.repeat(65), stars: 3, weight: 0 });
    }).toThrow('at most 64 characters');
    expect(() => {
      b.itemRated({ itemId: 'i', stars: 3, weight: 0, reviewLength: -1 });
    }).toThrow('reviewLength must be >= 0');
  });
});
