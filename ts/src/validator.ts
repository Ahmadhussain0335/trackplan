import {
  compareStrings,
  type Diagnostic,
  escapeForMessage,
  isDisallowedCharacter,
  sortDiagnostics,
  unicodeName,
} from './diagnostic.js';
import type {
  EnumDef,
  EnumValueDef,
  EventDef,
  ParamDef,
  ParamType,
  TrackingPlan,
} from './model.js';
import { paramTypes } from './model.js';
import {
  identifierFor,
  matchesNamePattern,
  maxNameLength,
  pascalCase,
  reservedTypeNames,
  suggest,
} from './names.js';
import {
  hasOwnPosition,
  isNullScalar,
  loadPlan,
  type PList,
  type PNode,
  type Pos,
  type PScalar,
  scalarKind,
  scalarString,
  typeWord,
} from './source.js';
import { isBlank } from './text.js';

/** Default output path of the Dart target. */
export const defaultDartOutput = 'lib/analytics/analytics.g.dart';

/** Default output path of the TypeScript target. */
export const defaultTypescriptOutput = 'src/analytics/analytics.ts';

/** Default generated class name. */
export const defaultClassName = 'Analytics';

/** The result of validating a plan. */
export interface ValidationResult {
  /** Diagnostics sorted as in SPEC.md section 5.3. */
  readonly diagnostics: readonly Diagnostic[];
  /** The validated plan, or `undefined` when there are errors. */
  readonly plan: TrackingPlan | undefined;
}

/** Whether a result has at least one error. */
export function hasErrors(result: ValidationResult): boolean {
  return result.diagnostics.some((d) => d.severity === 'error');
}

/**
 * Validates the plan in `bytes` (SPEC.md sections 2 to 6).
 *
 * When `allowOutside` is true, absolute output paths and `..` segments are
 * accepted.
 */
export function validatePlan(
  bytes: Uint8Array,
  options: { allowOutside?: boolean } = {},
): ValidationResult {
  const loaded = loadPlan(bytes);
  if (loaded.fatal !== undefined) return { diagnostics: [loaded.fatal], plan: undefined };
  return new Validator(options.allowOutside ?? false).run(loaded.root);
}

// Windows ignores trailing dots and spaces and accepts the 8.3 name GIT~1.
function isGitSegment(segment: string): boolean {
  let end = segment.length;
  while (end > 0 && (segment[end - 1] === '.' || segment[end - 1] === ' ')) end--;
  const name = segment.slice(0, end).toLowerCase();
  return name === '.git' || /^git~[0-9]+$/.test(name);
}

/**
 * Returns why `path` is not an acceptable output path, or `undefined`.
 * Checks the text only; see SPEC.md section 2.4.
 */
export function outputPathProblem(path: string, allowOutside: boolean): string | undefined {
  if (path.length === 0) return 'empty';
  const drive = /^[A-Za-z]:/.test(path);
  // ':' elsewhere could address an NTFS alternate data stream.
  if ((drive ? path.slice(2) : path).includes(':')) return 'colon';
  const segments = path.split(/[/\\]/);
  if (segments.some(isGitSegment)) return '.git';
  if (allowOutside) return undefined;
  if (path.startsWith('/') || path.startsWith('\\') || drive) return 'absolute';
  if (segments.includes('..')) return '..';
  return undefined;
}

// Zero-width characters that some file systems ignore, so `.g\u{200C}it`
// could act as `.git`.
function isInvisible(unit: number): boolean {
  return (unit >= 0x200b && unit <= 0x200d) || unit === 0x2060;
}

interface Entry {
  readonly key: string;
  readonly keyNode: PScalar;
  readonly value: PNode;
}

const rootKeys = ['version', 'meta', 'targets', 'settings', 'enums', 'events'];
const metaKeys = ['name', 'description'];
const targetsKeys = ['dart', 'typescript'];
const dartKeys = ['output', 'class_name'];
const typescriptKeys = ['output', 'class_name', 'runtime_checks'];
const settingsKeys = ['warn_provider_limits'];
const enumKeys = ['description', 'values'];
const eventKeys = ['description', 'owner', 'tags', 'deprecated', 'params'];
const paramKeys = ['type', 'description', 'required', 'min', 'max', 'max_length', 'enum'];

const typeAliases: Readonly<Record<string, string>> = {
  float: 'double',
  number: 'double',
  decimal: 'double',
  integer: 'int',
  long: 'int',
  boolean: 'bool',
  str: 'string',
  text: 'string',
  list: 'list<string>',
  array: 'list<string>',
  'string[]': 'list<string>',
  'list<String>': 'list<string>',
  'List<String>': 'list<string>',
};

const allowedOptions: Readonly<Record<ParamType, readonly string[]>> = {
  string: ['max_length'],
  int: ['min', 'max'],
  double: ['min', 'max'],
  bool: [],
  enum: ['enum'],
  'list<string>': [],
};

// Firebase Analytics limits, from the official documentation (checked
// 2026-10-19):
// https://firebase.google.com/docs/reference/android/com/google/firebase/analytics/FirebaseAnalytics#logEvent(java.lang.String,android.os.Bundle)
// https://firebase.google.com/docs/reference/android/com/google/firebase/analytics/FirebaseAnalytics.Event
// https://support.google.com/analytics/answer/9267744
const firebaseMaxNameLength = 40;
const firebaseMaxParams = 25;
const firebaseMaxStringLength = 100;
const firebaseMaxEvents = 500;
const firebaseReservedPrefixes = ['firebase_', 'google_', 'ga_'];
const firebaseReservedEvents: ReadonlySet<string> = new Set(
  `ad_activeview ad_click ad_exposure ad_query ad_reward adunit_exposure
app_background app_clear_data app_exception app_remove app_store_refund
app_store_subscription_cancel app_store_subscription_convert
app_store_subscription_renew app_update app_upgrade dynamic_link_app_open
dynamic_link_app_update dynamic_link_first_open error first_open first_visit
notification_dismiss notification_foreground notification_open
notification_receive os_update session_start session_start_with_rollout
user_engagement`.split(/\s+/),
);

const decimalPattern = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/;
const classNamePattern = /^[A-Z][A-Za-z0-9]*$/;
const maxSafeInteger = 9007199254740991n;
const rootPos: Pos = { line: 1, column: 1 };

const q = (text: string) => `"${escapeForMessage(text)}"`;

function blankToUndefined(text: string | undefined): string | undefined {
  return text === undefined || isBlank(text) ? undefined : text;
}

function rawLength(node: PNode): number {
  return node.kind === 'map' ? node.entries.length : 0;
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

type Seen = Map<string, { name: string; line: number }>;

class Validator {
  private readonly diagnostics: Diagnostic[] = [];

  private dartClassName = defaultClassName;
  private typescriptClassName = defaultClassName;
  // Class names the enum type names are compared with (TP022); an invalid
  // class_name is not compared with anything.
  private dartClassForCheck: string | undefined = defaultClassName;
  private typescriptClassForCheck: string | undefined = defaultClassName;
  private dartOutput = defaultDartOutput;
  private typescriptOutput = defaultTypescriptOutput;
  private runtimeChecks = false;
  private firebase = false;
  private metaName: string | undefined;
  private metaDescription: string | undefined;

  private readonly definedEnums = new Set<string>();
  private sortedEnumNames: string[] | undefined;
  private readonly usedEnums = new Set<string>();
  private readonly enumKeyPos = new Map<string, Pos>();
  private readonly enumDefs = new Map<string, EnumDef>();
  private readonly events: EventDef[] = [];

  constructor(private readonly allowOutside: boolean) {}

  private error(code: string, pos: Pos, message: string): void {
    this.diagnostics.push({ code, severity: 'error', line: pos.line, column: pos.column, message });
  }

  private warning(code: string, pos: Pos, message: string): void {
    this.diagnostics.push({
      code,
      severity: 'warning',
      line: pos.line,
      column: pos.column,
      message,
    });
  }

  private hasErrors(): boolean {
    return this.diagnostics.some((d) => d.severity === 'error');
  }

  run(root: PNode): ValidationResult {
    const known = this.known(this.entries(root), rootKeys, 'the plan');

    const version = known.get('version');
    if (version === undefined) {
      this.error('TP010', rootPos, 'Missing required key "version" in the plan.');
    } else {
      this.checkVersion(version);
    }

    const meta = known.get('meta');
    if (meta !== undefined) this.checkMeta(meta);
    const targets = known.get('targets');
    if (targets !== undefined) this.checkTargets(targets);
    const settings = known.get('settings');
    if (settings !== undefined) this.checkSettings(settings);
    const enums = known.get('enums');
    if (enums !== undefined) this.checkEnums(enums);

    const events = known.get('events');
    if (events === undefined) {
      this.error('TP010', rootPos, 'Missing required key "events" in the plan.');
    } else {
      this.checkEvents(events);
    }

    const failed = this.hasErrors();
    if (!failed) {
      for (const name of this.definedEnums) {
        if (!this.usedEnums.has(name)) {
          this.warning(
            'TP101',
            this.enumKeyPos.get(name) ?? rootPos,
            `Enum ${q(name)} is not used by any param.`,
          );
        }
      }
    }

    const diagnostics = sortDiagnostics(this.diagnostics);
    if (failed) return { diagnostics, plan: undefined };

    const enumList = [...this.enumDefs.values()].sort((a, b) => compareStrings(a.name, b.name));
    this.events.sort((a, b) => compareStrings(a.name, b.name));
    return {
      diagnostics,
      plan: {
        name: this.metaName,
        description: this.metaDescription,
        dartClassName: this.dartClassName,
        dartOutput: this.dartOutput,
        typescriptClassName: this.typescriptClassName,
        typescriptOutput: this.typescriptOutput,
        typescriptRuntimeChecks: this.runtimeChecks,
        enums: enumList,
        events: this.events,
      },
    };
  }

  // ---------------------------------------------------------------- helpers

  private entries(map: PNode): Entry[] {
    if (map.kind !== 'map') return [];
    const entries: Entry[] = [];
    for (const { key, value } of map.entries) {
      // Complex keys were rejected as TP003 while loading.
      const keyNode = key as PScalar;
      if (scalarKind(keyNode) !== 'string') {
        this.error(
          'TP012',
          keyNode.pos,
          `Keys must be strings, got ${typeWord(keyNode)}. Quote the key.`,
        );
        continue;
      }
      entries.push({ key: scalarString(keyNode), keyNode, value });
    }
    return entries;
  }

  private known(entries: Entry[], allowed: readonly string[], context: string): Map<string, Entry> {
    const known = new Map<string, Entry>();
    for (const entry of entries) {
      if (allowed.includes(entry.key)) {
        known.set(entry.key, entry);
        continue;
      }
      const suggestion = suggest(entry.key, allowed);
      this.error(
        'TP011',
        entry.keyNode.pos,
        `Unknown key ${q(entry.key)} in ${context}.` +
          (suggestion === undefined ? '' : ` Did you mean "${suggestion}"?`),
      );
    }
    return known;
  }

  private valuePos(entry: Entry): Pos {
    return hasOwnPosition(entry.value) ? entry.value.pos : entry.keyNode.pos;
  }

  private itemPos(item: PNode, list: Entry): Pos {
    return hasOwnPosition(item) ? item.pos : list.keyNode.pos;
  }

  private typeError(expected: string, entry: Entry): void {
    this.error(
      'TP012',
      this.valuePos(entry),
      `Expected ${expected} for ${q(entry.key)}, got ${typeWord(entry.value)}.`,
    );
  }

  /** Entries of a mapping value, or `undefined` after reporting a type error. */
  private mapping(entry: Entry, nullAsEmpty = false): Entry[] | undefined {
    if (entry.value.kind === 'map') return this.entries(entry.value);
    if (nullAsEmpty && isNullScalar(entry.value)) return [];
    this.typeError('a mapping', entry);
    return undefined;
  }

  private string(entry: Entry): string | undefined {
    const value = entry.value;
    if (value.kind === 'scalar' && scalarKind(value) === 'string') return scalarString(value);
    this.typeError('a string', entry);
    return undefined;
  }

  private bool(entry: Entry): boolean | undefined {
    const value = entry.value;
    if (value.kind === 'scalar' && scalarKind(value) === 'boolean') return value.value === true;
    this.typeError('a boolean', entry);
    return undefined;
  }

  private list(entry: Entry): PList | undefined {
    if (entry.value.kind === 'list') return entry.value;
    this.typeError('a list', entry);
    return undefined;
  }

  /** Checks a free-text value (SPEC.md section 2.9). */
  private freeText(entry: Entry, nonEmpty = false): string | undefined {
    const value = entry.value;
    if (value.kind !== 'scalar' || scalarKind(value) !== 'string') {
      this.typeError(nonEmpty ? 'a non-empty string' : 'a string', entry);
      return undefined;
    }
    const text = scalarString(value);
    if (nonEmpty && isBlank(text)) {
      this.typeError('a non-empty string', entry);
      return undefined;
    }
    if (!this.checkTextCharacters(text, entry.key, this.valuePos(entry))) return undefined;
    return text;
  }

  private checkTextCharacters(text: string, key: string, pos: Pos): boolean {
    for (let i = 0; i < text.length; i++) {
      const unit = text.charCodeAt(i);
      if (isDisallowedCharacter(unit)) {
        this.error(
          'TP024',
          pos,
          `${q(key)} contains the disallowed character ${unicodeName(unit)}.`,
        );
        return false;
      }
    }
    return true;
  }

  /** Checks a name; returns whether it is valid (SPEC.md section 4.1). */
  private checkName(name: string, pos: Pos, kind: string): boolean {
    if (!matchesNamePattern(name)) {
      this.error(
        'TP020',
        pos,
        `Invalid ${kind} name ${q(name)}: use lowercase snake_case starting with a letter.`,
      );
      return false;
    }
    if (name.length > maxNameLength) {
      this.error(
        'TP020',
        pos,
        `Invalid ${kind} name ${q(name)}: longer than ${maxNameLength} characters.`,
      );
      return false;
    }
    return true;
  }

  /** Reports TP021 if `identifier` was already produced by another name. */
  private checkCollision(
    seen: Seen,
    identifier: string,
    name: string,
    pos: Pos,
    kind: string,
  ): boolean {
    const earlier = seen.get(identifier);
    if (earlier === undefined) {
      seen.set(identifier, { name, line: pos.line });
      return true;
    }
    this.error(
      'TP021',
      pos,
      `${kind} ${q(name)} generates the same identifier "${identifier}" as ${q(earlier.name)} (line ${earlier.line}).`,
    );
    return false;
  }

  /** Checks a number (SPEC.md section 2.8) and returns its source text. */
  private number(
    entry: Entry,
    expected: string,
    integerOnly: boolean,
    atLeastOne = false,
  ): string | undefined {
    const value = entry.value;
    if (
      value.kind !== 'scalar' ||
      (scalarKind(value) !== 'integer' && scalarKind(value) !== 'number')
    ) {
      this.typeError(expected, entry);
      return undefined;
    }
    const text = value.source;
    let reason: string | undefined;
    if (!decimalPattern.test(text)) {
      reason = 'expected a decimal number';
    } else if (integerOnly && text.includes('.')) {
      reason = 'expected an integer';
    } else if (atLeastOne && BigInt(text) < 1n) {
      reason = 'expected an integer of at least 1';
    } else if (!text.includes('.') && abs(BigInt(text)) > maxSafeInteger) {
      reason = 'out of range';
    }
    if (reason !== undefined) {
      this.error(
        'TP037',
        this.valuePos(entry),
        `Invalid number ${escapeForMessage(text)} for ${q(entry.key)}: ${reason}.`,
      );
      return undefined;
    }
    return text;
  }

  // ------------------------------------------------------------------ root

  private checkVersion(entry: Entry): void {
    const value = entry.value;
    if (
      value.kind !== 'scalar' ||
      (scalarKind(value) !== 'integer' && scalarKind(value) !== 'number')
    ) {
      this.typeError('an integer', entry);
      return;
    }
    if (value.source !== '1') {
      this.error(
        'TP013',
        this.valuePos(entry),
        `Unsupported version ${escapeForMessage(value.source)}. The only supported version is 1.`,
      );
    }
  }

  private checkMeta(entry: Entry): void {
    const entries = this.mapping(entry, true);
    if (entries === undefined) return;
    const known = this.known(entries, metaKeys, 'meta');
    const name = known.get('name');
    if (name !== undefined) this.metaName = blankToUndefined(this.freeText(name));
    const description = known.get('description');
    if (description !== undefined)
      this.metaDescription = blankToUndefined(this.freeText(description));
  }

  private checkTargets(entry: Entry): void {
    const entries = this.mapping(entry, true);
    if (entries === undefined) return;
    const known = this.known(entries, targetsKeys, 'targets');

    const dart = known.get('dart');
    if (dart !== undefined) {
      const dartEntries = this.mapping(dart, true);
      if (dartEntries !== undefined) {
        const k = this.known(dartEntries, dartKeys, 'targets.dart');
        const output = k.get('output');
        if (output !== undefined)
          this.dartOutput = this.checkOutput(output, ['.dart'], '.dart') ?? '';
        const className = k.get('class_name');
        if (className !== undefined) {
          this.dartClassForCheck = this.checkClassName(className);
          this.dartClassName = this.dartClassForCheck ?? defaultClassName;
        }
      }
    }

    const ts = known.get('typescript');
    if (ts !== undefined) {
      const tsEntries = this.mapping(ts, true);
      if (tsEntries !== undefined) {
        const k = this.known(tsEntries, typescriptKeys, 'targets.typescript');
        const output = k.get('output');
        if (output !== undefined) {
          this.typescriptOutput =
            this.checkOutput(output, ['.ts', '.mts', '.cts'], '.ts, .mts or .cts') ?? '';
        }
        const className = k.get('class_name');
        if (className !== undefined) {
          this.typescriptClassForCheck = this.checkClassName(className);
          this.typescriptClassName = this.typescriptClassForCheck ?? defaultClassName;
        }
        const checks = k.get('runtime_checks');
        if (checks !== undefined) this.runtimeChecks = this.bool(checks) ?? false;
      }
    }
  }

  private checkOutput(
    entry: Entry,
    extensions: readonly string[],
    names: string,
  ): string | undefined {
    const path = this.string(entry);
    if (path === undefined) return undefined;
    for (let i = 0; i < path.length; i++) {
      const unit = path.charCodeAt(i);
      if (unit === 0x09 || unit === 0x0a || isDisallowedCharacter(unit) || isInvisible(unit)) {
        this.error(
          'TP024',
          this.valuePos(entry),
          `${q(entry.key)} contains the disallowed character ${unicodeName(unit)}.`,
        );
        return undefined;
      }
    }
    let ok = true;
    if (outputPathProblem(path, this.allowOutside) !== undefined) {
      this.error(
        'TP050',
        this.valuePos(entry),
        `Output path ${q(path)} must be relative and stay inside the project.`,
      );
      ok = false;
    }
    if (!extensions.some((ext) => path.endsWith(ext))) {
      this.error('TP052', this.valuePos(entry), `Output path ${q(path)} must end with ${names}.`);
      ok = false;
    }
    return ok ? path : undefined;
  }

  private checkClassName(entry: Entry): string | undefined {
    const name = this.string(entry);
    if (name === undefined) return undefined;
    if (!classNamePattern.test(name)) {
      this.error(
        'TP023',
        this.valuePos(entry),
        `Invalid class name ${q(name)}: use PascalCase starting with A-Z.`,
      );
      return undefined;
    }
    if (reservedTypeNames.has(name)) {
      this.error('TP023', this.valuePos(entry), `Class name ${q(name)} is reserved.`);
      return undefined;
    }
    return name;
  }

  private checkSettings(entry: Entry): void {
    const entries = this.mapping(entry, true);
    if (entries === undefined) return;
    const known = this.known(entries, settingsKeys, 'settings');
    const providers = known.get('warn_provider_limits');
    if (providers === undefined) return;
    const list = this.list(providers);
    if (list === undefined) return;
    for (const item of list.items) {
      if (item.kind !== 'scalar' || scalarKind(item) !== 'string') {
        this.error(
          'TP012',
          this.itemPos(item, providers),
          `Expected a string for ${q(providers.key)}, got ${typeWord(item)}.`,
        );
        continue;
      }
      const provider = scalarString(item);
      if (provider === 'firebase') {
        this.firebase = true;
      } else {
        this.error(
          'TP051',
          this.itemPos(item, providers),
          `Unknown provider ${q(provider)}. Supported providers: firebase.`,
        );
      }
    }
  }

  // ----------------------------------------------------------------- enums

  private checkEnums(entry: Entry): void {
    const entries = this.mapping(entry, true);
    if (entries === undefined) return;
    const typeNames: Seen = new Map();
    for (const e of entries) {
      const keyPos = e.keyNode.pos;
      this.definedEnums.add(e.key);
      this.enumKeyPos.set(e.key, keyPos);
      const validName = this.checkName(e.key, keyPos, 'enum');
      let typeName: string | undefined;
      if (validName) {
        typeName = pascalCase(e.key);
        this.checkCollision(typeNames, typeName, e.key, keyPos, 'Enum');
        if (
          reservedTypeNames.has(typeName) ||
          typeName === this.dartClassForCheck ||
          typeName === this.typescriptClassForCheck
        ) {
          this.error(
            'TP022',
            keyPos,
            `Enum ${q(e.key)} generates the type name "${typeName}", which is reserved.`,
          );
        }
      }

      const body = this.mapping(e);
      if (body === undefined) continue;
      const known = this.known(body, enumKeys, `enum ${q(e.key)}`);
      const description = known.get('description');
      const descriptionText = description === undefined ? undefined : this.freeText(description);
      const valuesEntry = known.get('values');
      if (valuesEntry === undefined) {
        this.error('TP010', keyPos, `Missing required key "values" in enum ${q(e.key)}.`);
        continue;
      }
      const values = this.checkEnumValues(e.key, valuesEntry);
      if (values !== undefined && typeName !== undefined) {
        this.enumDefs.set(e.key, {
          name: e.key,
          typeName,
          description: blankToUndefined(descriptionText),
          values,
        });
      }
    }
  }

  private checkEnumValues(enumName: string, entry: Entry): EnumValueDef[] | undefined {
    const list = this.list(entry);
    if (list === undefined) return undefined;
    if (list.items.length === 0) {
      this.error('TP034', entry.keyNode.pos, `Enum ${q(enumName)} has no values.`);
      return undefined;
    }
    const values: EnumValueDef[] = [];
    const seen = new Set<string>();
    const identifiers: Seen = new Map();
    let ok = true;
    for (const item of list.items) {
      const pos = this.itemPos(item, entry);
      if (item.kind !== 'scalar' || scalarKind(item) !== 'string') {
        this.error('TP012', pos, `Expected a string for ${q(entry.key)}, got ${typeWord(item)}.`);
        ok = false;
        continue;
      }
      const value = scalarString(item);
      const validName = this.checkName(value, pos, 'enum value');
      if (seen.has(value)) {
        this.error('TP035', pos, `Duplicate value ${q(value)} in enum ${q(enumName)}.`);
        ok = false;
        continue;
      }
      seen.add(value);
      if (!validName) {
        ok = false;
        continue;
      }
      const identifier = identifierFor(value, 'enumValue');
      if (!this.checkCollision(identifiers, identifier, value, pos, 'Enum value')) ok = false;
      values.push({ name: value, identifier });
    }
    return ok ? values : undefined;
  }

  // ---------------------------------------------------------------- events

  private checkEvents(entry: Entry): void {
    const entries = this.mapping(entry, true);
    if (entries === undefined) return;
    const count = rawLength(entry.value);
    if (count === 0) {
      this.error('TP014', entry.keyNode.pos, '"events" must contain at least one event.');
      return;
    }
    if (this.firebase && count > firebaseMaxEvents) {
      this.warning(
        'TP118',
        entry.keyNode.pos,
        `Firebase: the plan has ${count} events; the limit is ${firebaseMaxEvents} distinct events per app.`,
      );
    }
    const identifiers: Seen = new Map();
    for (const e of entries) {
      const keyPos = e.keyNode.pos;
      const validName = this.checkName(e.key, keyPos, 'event');
      let identifier: string | undefined;
      if (validName) {
        identifier = identifierFor(e.key, 'method');
        this.checkCollision(identifiers, identifier, e.key, keyPos, 'Event');
        if (this.firebase) this.checkFirebaseEventName(e.key, keyPos);
      }
      const event = this.checkEvent(e, validName);
      if (event !== undefined && identifier !== undefined) {
        this.events.push({ name: e.key, identifier, ...event });
      }
    }
  }

  private checkFirebaseEventName(name: string, pos: Pos): void {
    if (name.length > firebaseMaxNameLength) {
      this.warning(
        'TP110',
        pos,
        `Firebase: event name ${q(name)} is longer than ${firebaseMaxNameLength} characters.`,
      );
    }
    for (const prefix of firebaseReservedPrefixes) {
      if (name.startsWith(prefix)) {
        this.warning(
          'TP111',
          pos,
          `Firebase: event name ${q(name)} uses the reserved prefix "${prefix}".`,
        );
      }
    }
    if (firebaseReservedEvents.has(name)) {
      this.warning(
        'TP112',
        pos,
        `Firebase: event name ${q(name)} is reserved and will be dropped.`,
      );
    }
  }

  private checkEvent(
    e: Entry,
    validName: boolean,
  ): Omit<EventDef, 'name' | 'identifier'> | undefined {
    const body = this.mapping(e, true);
    if (body === undefined) return undefined;
    const known = this.known(body, eventKeys, `event ${q(e.key)}`);
    let ok = true;

    let description: string | undefined;
    const descriptionEntry = known.get('description');
    if (descriptionEntry !== undefined) {
      const text = this.freeText(descriptionEntry);
      if (text === undefined) {
        ok = false;
      } else {
        description = blankToUndefined(text);
      }
    }
    if (description === undefined && (descriptionEntry === undefined || ok)) {
      this.warning('TP100', e.keyNode.pos, `Event ${q(e.key)} has no description.`);
    }

    let owner: string | undefined;
    const ownerEntry = known.get('owner');
    if (ownerEntry !== undefined) {
      const text = this.freeText(ownerEntry);
      if (text === undefined) ok = false;
      owner = blankToUndefined(text);
    }

    const tags: string[] = [];
    const tagsEntry = known.get('tags');
    if (tagsEntry !== undefined) {
      const list = this.list(tagsEntry);
      if (list === undefined) {
        ok = false;
      } else {
        for (const item of list.items) {
          const pos = this.itemPos(item, tagsEntry);
          if (item.kind !== 'scalar' || scalarKind(item) !== 'string') {
            this.error(
              'TP012',
              pos,
              `Expected a string for ${q(tagsEntry.key)}, got ${typeWord(item)}.`,
            );
            ok = false;
            continue;
          }
          const tag = scalarString(item);
          if (isBlank(tag)) {
            this.error(
              'TP012',
              pos,
              `Expected a non-empty string for ${q(tagsEntry.key)}, got an empty string.`,
            );
            ok = false;
            continue;
          }
          if (this.checkTextCharacters(tag, tagsEntry.key, pos)) {
            tags.push(tag);
          } else {
            ok = false;
          }
        }
      }
    }

    let deprecated: string | undefined;
    const deprecatedEntry = known.get('deprecated');
    if (deprecatedEntry !== undefined) {
      deprecated = this.freeText(deprecatedEntry, true);
      if (deprecated === undefined) ok = false;
    }

    const params: ParamDef[] = [];
    const paramsEntry = known.get('params');
    if (paramsEntry !== undefined) {
      const checked = this.checkParams(e.key, paramsEntry, validName);
      if (checked === undefined) {
        ok = false;
      } else {
        params.push(...checked);
      }
    }

    if (!ok) return undefined;
    return { description, owner, tags, deprecated, params };
  }

  private checkParams(
    eventName: string,
    entry: Entry,
    validEventName: boolean,
  ): ParamDef[] | undefined {
    const entries = this.mapping(entry, true);
    if (entries === undefined) return undefined;
    const count = rawLength(entry.value);
    if (this.firebase && validEventName && count > firebaseMaxParams) {
      this.warning(
        'TP113',
        entry.keyNode.pos,
        `Firebase: event ${q(eventName)} has ${count} params; the limit is ${firebaseMaxParams}.`,
      );
    }
    const identifiers: Seen = new Map();
    const params: ParamDef[] = [];
    let ok = true;
    for (const p of entries) {
      const keyPos = p.keyNode.pos;
      const validName = this.checkName(p.key, keyPos, 'param');
      let identifier = '';
      if (validName) {
        identifier = identifierFor(p.key, 'param');
        if (!this.checkCollision(identifiers, identifier, p.key, keyPos, 'Param')) ok = false;
        if (this.firebase) this.checkFirebaseParamName(p.key, keyPos);
      } else {
        ok = false;
      }
      const param = this.checkParam(eventName, p, identifier);
      if (param === undefined) {
        ok = false;
      } else {
        params.push(param);
      }
    }
    return ok ? params : undefined;
  }

  private checkFirebaseParamName(name: string, pos: Pos): void {
    if (name.length > firebaseMaxNameLength) {
      this.warning(
        'TP114',
        pos,
        `Firebase: param name ${q(name)} is longer than ${firebaseMaxNameLength} characters.`,
      );
    }
    for (const prefix of firebaseReservedPrefixes) {
      if (name.startsWith(prefix)) {
        this.warning(
          'TP115',
          pos,
          `Firebase: param name ${q(name)} uses the reserved prefix "${prefix}".`,
        );
      }
    }
  }

  private checkParam(eventName: string, p: Entry, identifier: string): ParamDef | undefined {
    const body = this.mapping(p);
    if (body === undefined) return undefined;
    const context = `param ${q(p.key)} of event ${q(eventName)}`;
    const known = this.known(body, paramKeys, context);
    let ok = true;

    let description: string | undefined;
    const descriptionEntry = known.get('description');
    if (descriptionEntry !== undefined) {
      const text = this.freeText(descriptionEntry);
      if (text === undefined) ok = false;
      description = blankToUndefined(text);
    }

    let required = true;
    const requiredEntry = known.get('required');
    if (requiredEntry !== undefined) {
      const value = this.bool(requiredEntry);
      if (value === undefined) ok = false;
      required = value ?? true;
    }

    const typeEntry = known.get('type');
    if (typeEntry === undefined) {
      this.error('TP010', p.keyNode.pos, `Missing required key "type" in ${context}.`);
      return undefined;
    }
    const typeName = this.string(typeEntry);
    if (typeName === undefined) return undefined;
    const type = paramTypes.find((t) => t === typeName);
    if (type === undefined) {
      const suggestion = Object.hasOwn(typeAliases, typeName)
        ? typeAliases[typeName]
        : suggest(typeName, paramTypes);
      this.error(
        'TP030',
        this.valuePos(typeEntry),
        `Unknown type ${q(typeName)}.` +
          (suggestion === undefined
            ? ' Supported types: string, int, double, bool, enum, list<string>.'
            : ` Did you mean "${suggestion}"?`),
      );
      return undefined;
    }

    for (const option of ['min', 'max', 'max_length', 'enum']) {
      const optionEntry = known.get(option);
      if (optionEntry !== undefined && !allowedOptions[type].includes(option)) {
        this.error(
          'TP033',
          optionEntry.keyNode.pos,
          `Option "${option}" is not allowed for type ${type}.`,
        );
        ok = false;
      }
    }

    let enumDef: EnumDef | undefined;
    if (type === 'enum') {
      const enumEntry = known.get('enum');
      if (enumEntry === undefined) {
        this.error(
          'TP031',
          this.valuePos(typeEntry),
          `Param ${q(p.key)} has type enum but no "enum" key.`,
        );
        ok = false;
      } else {
        const name = this.string(enumEntry);
        if (name === undefined) {
          ok = false;
        } else if (!this.definedEnums.has(name)) {
          this.sortedEnumNames ??= [...this.definedEnums].sort(compareStrings);
          const suggestion = suggest(name, this.sortedEnumNames);
          this.error(
            'TP032',
            this.valuePos(enumEntry),
            `Unknown enum ${q(name)}.` +
              (suggestion === undefined ? '' : ` Did you mean ${q(suggestion)}?`),
          );
          ok = false;
        } else {
          this.usedEnums.add(name);
          enumDef = this.enumDefs.get(name);
        }
      }
    }

    let min: string | undefined;
    let max: string | undefined;
    if (type === 'int' || type === 'double') {
      const integerOnly = type === 'int';
      const minEntry = known.get('min');
      const maxEntry = known.get('max');
      if (minEntry !== undefined) {
        min = this.number(minEntry, 'a number', integerOnly);
        if (min === undefined) ok = false;
      }
      if (maxEntry !== undefined) {
        max = this.number(maxEntry, 'a number', integerOnly);
        if (max === undefined) ok = false;
      }
      if (
        min !== undefined &&
        max !== undefined &&
        minEntry !== undefined &&
        Number(min) > Number(max)
      ) {
        this.error(
          'TP036',
          this.valuePos(minEntry),
          `"min" (${min}) is greater than "max" (${max}).`,
        );
        ok = false;
      }
    }

    let maxLength: number | undefined;
    const maxLengthEntry = known.get('max_length');
    if (type === 'string' && maxLengthEntry !== undefined) {
      const text = this.number(maxLengthEntry, 'an integer', true, true);
      if (text === undefined) {
        ok = false;
      } else {
        maxLength = Number(text);
        if (this.firebase && identifier !== '' && maxLength > firebaseMaxStringLength) {
          this.warning(
            'TP116',
            this.valuePos(maxLengthEntry),
            `Firebase: string values are limited to ${firebaseMaxStringLength} characters, but "max_length" is ${maxLength}.`,
          );
        }
      }
    }

    if (this.firebase && identifier !== '' && (type === 'bool' || type === 'list<string>')) {
      this.warning(
        'TP117',
        this.valuePos(typeEntry),
        `Firebase: type ${type} is not supported for event params; the adapter must convert it.`,
      );
    }

    if (!ok || identifier === '') return undefined;
    return { name: p.key, identifier, type, description, required, min, max, maxLength, enumDef };
  }
}
