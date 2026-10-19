import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  diagnosticsToJson,
  escapeForMessage,
  formatDiagnostic,
  summaryLine,
} from './diagnostic.js';
import { docsHeaderPrefix, generateDocs } from './docsGenerator.js';
import { samplePlan } from './samplePlan.js';
import { generateTypescript, tsHeaderLine } from './tsGenerator.js';
import { hasErrors, outputPathProblem, validatePlan } from './validator.js';
import { packageVersion } from './version.js';

/** Exit code: success. */
export const exitOk = 0;
/** Exit code: the plan has errors, or `check` found an outdated file. */
export const exitInvalid = 1;
/** Exit code: the tool itself failed (usage, IO). */
export const exitToolFailure = 2;

/** Largest plan file the CLI reads (SPEC.md section 9). */
export const maxPlanBytes = 1024 * 1024;

const defaultPlan = 'tracking_plan.yaml';
const defaultDocs = 'TRACKING_PLAN.md';

const commands: Readonly<Record<string, string>> = {
  init: 'Create a sample tracking_plan.yaml.',
  validate: 'Validate the tracking plan.',
  generate: 'Generate the TypeScript file.',
  check: 'Exit with 1 if the generated TypeScript file is missing or out of date.',
  docs: 'Generate the Markdown event catalog.',
};

/** Where the CLI writes text. */
export interface Output {
  write(text: string): void;
}

/** A failure that stops the CLI with exit code 2. */
class ToolError extends Error {}

// Escapes text that comes from arguments or the plan before printing it.
const e = escapeForMessage;

type Options = Record<string, { type: 'string' | 'boolean'; default?: string }>;

function optionsFor(command: string): Options {
  const options: Options = {
    help: { type: 'boolean' },
    plan: { type: 'string', default: defaultPlan },
  };
  if (command !== 'init') options['allow-outside'] = { type: 'boolean' };
  if (command === 'validate') options['json'] = { type: 'boolean' };
  if (command === 'generate' || command === 'check' || command === 'docs') {
    options['out'] = { type: 'string' };
  }
  return options;
}

/** A command-line usage error (exit code 2). */
class UsageError extends Error {}

/**
 * Parses options the way Dart's `package:args` does, so both CLIs accept the
 * same arguments: `--name value`, `--name=value`, `-h`, and a value may start
 * with `-`. Arguments that are not options are returned in `rest`.
 */
function parseOptions(
  args: readonly string[],
  options: Options,
): { values: Map<string, string | true>; rest: string[] } {
  const values = new Map<string, string | true>();
  const rest: string[] = [];
  for (const [name, option] of Object.entries(options)) {
    if (option.default !== undefined) values.set(name, option.default);
  }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (arg === '--') {
      rest.push(...args.slice(i + 1));
      break;
    }
    if (arg === '-h') {
      values.set('help', true);
      continue;
    }
    if (!arg.startsWith('-') || arg === '-') {
      rest.push(arg);
      continue;
    }
    if (!arg.startsWith('--')) {
      throw new UsageError(`Could not find an option with short name "${arg}".`);
    }
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const option = Object.hasOwn(options, name) ? options[name] : undefined;
    if (option === undefined) throw new UsageError(`Could not find an option named "--${name}".`);
    if (option.type === 'boolean') {
      if (eq !== -1) throw new UsageError(`Flag option "--${name}" should not be given a value.`);
      values.set(name, true);
      continue;
    }
    if (eq !== -1) {
      values.set(name, arg.slice(eq + 1));
    } else if (i + 1 < args.length) {
      values.set(name, args[++i] ?? '');
    } else {
      throw new UsageError(`Missing argument for "${name}".`);
    }
  }
  return { values, rest };
}

function optionUsage(command: string): string {
  const help: Record<string, string> = {
    help: '-h, --help          Show this help.',
    plan: '    --plan <path>   Path to the tracking plan (default: tracking_plan.yaml).',
    'allow-outside': '    --allow-outside Allow absolute output paths and paths with "..".',
    json: '    --json          Print machine-readable output.',
    out: '    --out <path>    Override the output path.',
  };
  return Object.keys(optionsFor(command))
    .map((name) => help[name])
    .join('\n');
}

function usage(): string {
  const lines = [
    'Generates type-safe TypeScript analytics code from a tracking plan.',
    '',
    'Usage: npx trackplan <command> [options]',
    '',
    'Commands:',
    ...Object.entries(commands).map(([name, text]) => `  ${name.padEnd(10)}${text}`),
    '',
    'Run "npx trackplan <command> --help" for command options.',
    'Global options: --help, --version',
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * Runs the CLI and returns the exit code. Paths are resolved against `cwd`.
 * Output goes to `out`, diagnostics and errors to `err`.
 */
export function runCli(
  args: readonly string[],
  io: { cwd: string; out: Output; err: Output },
): number {
  const { cwd, out, err } = io;
  const [command, ...rest] = args;
  if (command === undefined || command === '--help' || command === '-h') {
    out.write(usage());
    return command === undefined ? exitToolFailure : exitOk;
  }
  if (command === '--version') {
    out.write(`trackplan ${packageVersion}\n`);
    return exitOk;
  }
  if (!Object.hasOwn(commands, command)) {
    err.write(`Unknown command "${e(command)}".\n\n${usage()}`);
    return exitToolFailure;
  }

  let parsed: { values: Map<string, string | true>; rest: string[] };
  try {
    parsed = parseOptions(rest, optionsFor(command));
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    err.write(
      `${e(error.message)}\n\nUsage: npx trackplan ${command} [options]\n${optionUsage(command)}\n`,
    );
    return exitToolFailure;
  }
  const { values } = parsed;
  if (values.get('help') === true) {
    out.write(
      `${commands[command] ?? ''}\n\nUsage: npx trackplan ${command} [options]\n${optionUsage(command)}\n`,
    );
    return exitOk;
  }
  const [unexpected] = parsed.rest;
  if (unexpected !== undefined) {
    err.write(`Unexpected argument "${e(unexpected)}".\n`);
    return exitToolFailure;
  }

  try {
    const stringValue = (name: string) => {
      const value = values.get(name);
      return typeof value === 'string' ? value : undefined;
    };
    const planPath = stringValue('plan') ?? defaultPlan;
    const allowOutside = values.get('allow-outside') === true;
    switch (command) {
      case 'init':
        return init(planPath, cwd, out);
      case 'validate':
        return validate(planPath, values.get('json') === true, allowOutside, cwd, out);
      default:
        return generateCommand(command, planPath, stringValue('out'), allowOutside, cwd, out, err);
    }
  } catch (error) {
    if (error instanceof ToolError) {
      err.write(`${error.message}\n`);
    } else if (error instanceof RangeError) {
      err.write('The plan is nested too deeply to be read.\n');
    } else {
      const code = (error as NodeJS.ErrnoException).code ?? 'unknown';
      const message = error instanceof Error ? error.message : String(error);
      err.write(`File error (${e(code)}): ${e(message)}\n`);
    }
    return exitToolFailure;
  }
}

function resolve(cwd: string, file: string): string {
  return path.resolve(cwd, file);
}

type EntityType = 'file' | 'directory' | 'other' | 'notFound';

function entityType(file: string): EntityType {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : 'other';
  } catch {
    return 'notFound';
  }
}

/** Reads at most `limit` + 1 bytes, so special files such as /dev/zero cannot exhaust memory. */
function readLimited(file: string, limit: number): Buffer {
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(limit + 1);
    let total = 0;
    while (total < buffer.length) {
      const read = fs.readSync(fd, buffer, total, buffer.length - total, null);
      if (read === 0) break;
      total += read;
    }
    return buffer.subarray(0, total);
  } finally {
    fs.closeSync(fd);
  }
}

function readPlan(cwd: string, planPath: string): Uint8Array {
  const file = resolve(cwd, planPath);
  const type = entityType(file);
  if (type === 'notFound') throw new ToolError(`Cannot read ${e(planPath)}: file not found.`);
  if (type === 'directory') throw new ToolError(`Cannot read ${e(planPath)}: it is a directory.`);
  const bytes = readLimited(file, maxPlanBytes);
  if (bytes.length > maxPlanBytes)
    throw new ToolError(`Cannot read ${e(planPath)}: it is larger than 1 MB.`);
  return bytes;
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/** Throws unless `target`, with symlinks resolved, is inside `cwd`. */
function ensureInside(cwd: string, target: string, shownPath: string): void {
  const realCwd = fs.realpathSync(cwd);
  let existing = target;
  while (entityType(existing) === 'notFound') existing = path.dirname(existing);
  const realExisting = fs.realpathSync(existing);
  const rest = path.relative(existing, target);
  const resolved = rest === '' ? realExisting : path.join(realExisting, rest);
  if (!isWithin(realCwd, resolved)) {
    throw new ToolError(
      `Refusing to use ${e(shownPath)}: it resolves to ${e(resolved)}, outside the current directory. ` +
        'Use --allow-outside if this is intended.',
    );
  }
}

function init(planPath: string, cwd: string, out: Output): number {
  const file = resolve(cwd, planPath);
  let exists = true;
  try {
    fs.lstatSync(file);
  } catch {
    exists = false;
  }
  if (exists) {
    throw new ToolError(
      `${e(planPath)} already exists. Delete it first or choose another path with --plan.`,
    );
  }
  // 'wx' also guards against a file created since the check above.
  fs.writeFileSync(file, samplePlan, { flag: 'wx' });
  out.write(`Created ${e(planPath)}.\n`);
  return exitOk;
}

function validate(
  planPath: string,
  json: boolean,
  allowOutside: boolean,
  cwd: string,
  out: Output,
): number {
  const result = validatePlan(readPlan(cwd, planPath), { allowOutside });
  if (json) {
    out.write(diagnosticsToJson(planPath, result.diagnostics));
  } else {
    for (const d of result.diagnostics) out.write(`${formatDiagnostic(d, e(planPath))}\n`);
    out.write(`${summaryLine(result.diagnostics)}\n`);
  }
  return hasErrors(result) ? exitInvalid : exitOk;
}

function checkOutOption(out: string, isDocs: boolean, allowOutside: boolean): void {
  if (outputPathProblem(out, allowOutside) !== undefined) {
    throw new ToolError(
      `Invalid --out "${e(out)}": it must be relative and stay inside the project (use --allow-outside to write elsewhere).`,
    );
  }
  if (!isDocs && !['.ts', '.mts', '.cts'].some((ext) => out.endsWith(ext))) {
    throw new ToolError(`Invalid --out "${e(out)}": it must end with .ts, .mts or .cts.`);
  }
}

function generateCommand(
  command: string,
  planPath: string,
  outOption: string | undefined,
  allowOutside: boolean,
  cwd: string,
  out: Output,
  err: Output,
): number {
  const isDocs = command === 'docs';
  if (outOption !== undefined) checkOutOption(outOption, isDocs, allowOutside);
  const result = validatePlan(readPlan(cwd, planPath), { allowOutside });
  for (const d of result.diagnostics) err.write(`${formatDiagnostic(d, e(planPath))}\n`);
  const plan = result.plan;
  if (plan === undefined) {
    err.write(`${summaryLine(result.diagnostics)}\n`);
    return exitInvalid;
  }

  const target = outOption ?? (isDocs ? defaultDocs : plan.typescriptOutput);
  const content = isDocs ? generateDocs(plan, planPath) : generateTypescript(plan, planPath);

  if (command === 'check') {
    const file = resolve(cwd, target);
    if (!allowOutside) ensureInside(cwd, file, target);
    if (entityType(file) !== 'file') {
      err.write(`${e(target)} does not exist. Run \`npx trackplan generate\`.\n`);
      return exitInvalid;
    }
    const expected = Buffer.from(content, 'utf8');
    // Compare lengths first so a huge or special file is never read whole.
    if (
      fs.statSync(file).size !== expected.length ||
      !readLimited(file, expected.length).equals(expected)
    ) {
      err.write(`${e(target)} is out of date. Run \`npx trackplan generate\`.\n`);
      return exitInvalid;
    }
    out.write(`${e(target)} is up to date.\n`);
    return exitOk;
  }

  writeGeneratedFile({
    cwd,
    file: target,
    content,
    isGenerated: isDocs
      ? (line) => line.startsWith(docsHeaderPrefix)
      : (line) => line === tsHeaderLine,
    allowOutside,
  });
  out.write(`Wrote ${e(target)}.\n`);
  return exitOk;
}

/**
 * Writes `content` atomically (SPEC.md sections 2.4 and 9). Refuses to write
 * outside `cwd` after resolving symlinks, unless `allowOutside`, and refuses
 * to overwrite a file whose first line does not satisfy `isGenerated`.
 */
export function writeGeneratedFile(options: {
  cwd: string;
  file: string;
  content: string;
  isGenerated: (firstLine: string) => boolean;
  allowOutside: boolean;
}): void {
  const { cwd, file, content, isGenerated, allowOutside } = options;
  const target = resolve(cwd, file);
  if (!allowOutside) ensureInside(cwd, target, file);

  const type = entityType(target);
  if (type === 'directory') throw new ToolError(`Refusing to write ${e(file)}: it is a directory.`);
  if (type !== 'notFound') {
    // Only the start of the file is needed; it may be large or not UTF-8.
    let firstLine = readLimited(target, 4096).toString('utf8').split('\n')[0] ?? '';
    if (firstLine.endsWith('\r')) firstLine = firstLine.slice(0, -1);
    if (!isGenerated(firstLine)) {
      throw new ToolError(
        `Refusing to overwrite ${e(file)}: it was not generated by trackplan. Delete it or choose another output path.`,
      );
    }
  }

  const directory = path.dirname(target);
  fs.mkdirSync(directory, { recursive: true });
  // Check again: a folder could have been swapped for a symlink meanwhile.
  if (!allowOutside) ensureInside(cwd, target, file);
  // A random name created exclusively: a planted symlink or file with a
  // predictable name could otherwise redirect the write.
  const temp = path.join(
    directory,
    `.${path.basename(target)}.${randomBytes(8).toString('hex')}.trackplan.tmp`,
  );
  try {
    fs.writeFileSync(temp, content, { flag: 'wx' });
    fs.renameSync(temp, target);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}
