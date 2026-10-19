/** Maximum length of an event, param, enum or enum value name. */
export const maxNameLength = 64;

const namePattern = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;

/** Whether a name matches the pattern of SPEC.md section 4.1 (length is checked separately). */
export function matchesNamePattern(name: string): boolean {
  return namePattern.test(name);
}

function capitalize(part: string): string {
  return part.charAt(0).toUpperCase() + part.slice(1);
}

/** Converts a snake_case name to camelCase (SPEC.md section 4.2). */
export function camelCase(name: string): string {
  const [first = '', ...rest] = name.split('_');
  return first + rest.map(capitalize).join('');
}

/** Converts a snake_case name to PascalCase (SPEC.md section 4.2). */
export function pascalCase(name: string): string {
  return name.split('_').map(capitalize).join('');
}

/** Words renamed in every identifier (SPEC.md section 4.4). */
export const reservedWords: ReadonlySet<string> = new Set(
  `assert await bool break case catch class const continue debugger default
delete do double dynamic else enum export extends false final finally for
function if implements import in instanceof int interface is let new null
num package private protected public rethrow return static super switch this
throw true try typeof var void while with yield`.split(/\s+/),
);

/** Additional words renamed in method and param names (SPEC.md section 4.4). */
export const reservedMethodNames: ReadonlySet<string> = new Set(
  `constructor hashCode hasOwnProperty isPrototypeOf noSuchMethod
propertyIsEnumerable runtimeType then toJSON toLocaleString toString valueOf`.split(/\s+/),
);

/** Additional words renamed in Dart enum constants (SPEC.md section 4.4). */
export const reservedEnumValueNames: ReadonlySet<string> = new Set(
  'hashCode index noSuchMethod runtimeType toString value values'.split(' '),
);

/** Type names that enums and `class_name` must not use (SPEC.md section 4.5). */
export const reservedTypeNames: ReadonlySet<string> = new Set([
  'AnalyticsAdapter',
  'AnalyticsParams',
  'AnalyticsValue',
  'DebugAnalyticsAdapter',
  'RecordingAnalyticsAdapter',
  'Array',
  'Boolean',
  'Date',
  'Deprecated',
  'Enum',
  'Error',
  'Function',
  'Iterable',
  'JSON',
  'List',
  'Map',
  'MapEntry',
  'Never',
  'Null',
  'Number',
  'Object',
  'Promise',
  'RangeError',
  'Readonly',
  'Record',
  'Set',
  'String',
  'Symbol',
  'Type',
]);

/** The kind of generated identifier, which decides the rename list. */
export type IdentifierKind = 'method' | 'param' | 'enumValue';

/** The generated camelCase identifier, with `_` appended when it is a reserved word. */
export function identifierFor(name: string, kind: IdentifierKind): string {
  const id = camelCase(name);
  const reserved =
    reservedWords.has(id) ||
    (kind !== 'enumValue' && reservedMethodNames.has(id)) ||
    (kind === 'enumValue' && reservedEnumValueNames.has(id));
  return reserved ? `${id}_` : id;
}

/** Levenshtein distance on UTF-16 code units. */
export function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      current.push(
        Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + cost),
      );
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

/**
 * The suggestion for `written` among `candidates` (SPEC.md section 6.3.1), or
 * `undefined`. `candidates` must be in tie-break order.
 */
export function suggest(written: string, candidates: Iterable<string>): string | undefined {
  let best: string | undefined;
  let bestDistance = 3;
  for (const candidate of candidates) {
    // Cheap bound that also keeps long inputs from being compared in full.
    if (Math.abs(written.length - candidate.length) > 2) continue;
    const distance = editDistance(written, candidate);
    if (distance <= 2 && distance < written.length && distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}
