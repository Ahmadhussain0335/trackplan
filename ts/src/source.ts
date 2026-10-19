import {
  type Document,
  isAlias,
  isMap,
  isScalar,
  isSeq,
  LineCounter,
  type Node as YamlNode,
  Parser,
  parseDocument,
  type Scalar,
} from 'yaml';

import {
  type Diagnostic,
  escapeForMessage,
  isDisallowedCharacter,
  unicodeName,
} from './diagnostic.js';
import { isBlank } from './text.js';

/** 1-based source position. */
export interface Pos {
  readonly line: number;
  readonly column: number;
}

/** Scalar styles, named as in the YAML spec. */
export type ScalarStyle =
  'PLAIN' | 'QUOTE_SINGLE' | 'QUOTE_DOUBLE' | 'BLOCK_LITERAL' | 'BLOCK_FOLDED';

/** A scalar with its exact source text. */
export interface PScalar {
  readonly kind: 'scalar';
  readonly pos: Pos;
  readonly style: ScalarStyle;
  /** Source text of the value, without anchors or tags. */
  readonly source: string;
  /** Value as parsed by the YAML library. */
  readonly value: unknown;
}

/** A mapping, entries in document order. */
export interface PMap {
  readonly kind: 'map';
  readonly pos: Pos;
  readonly entries: readonly { readonly key: PNode; readonly value: PNode }[];
}

/** A sequence. */
export interface PList {
  readonly kind: 'list';
  readonly pos: Pos;
  readonly items: readonly PNode[];
}

/** A YAML node of a successfully loaded plan. */
export type PNode = PScalar | PMap | PList;

/** The result of loading a plan: either a root mapping or one fatal diagnostic. */
export type LoadResult =
  { root: PMap; fatal?: undefined } | { root?: undefined; fatal: Diagnostic };

const startPos: Pos = { line: 1, column: 1 };

function fatal(code: string, pos: Pos, message: string): LoadResult {
  return { fatal: { code, severity: 'error', line: pos.line, column: pos.column, message } };
}

function offsetToPos(source: string, offset: number): Pos {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset; i++) {
    if (source.charCodeAt(i) === 0x0a) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}

/** Decodes the plan and runs the fatal checks of SPEC.md section 5.2, rule 1. */
export function loadPlan(bytes: Uint8Array): LoadResult {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return fatal('TP006', startPos, 'The file is not valid UTF-8.');
  }
  const source = text.startsWith('﻿') ? text.slice(1) : text;

  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 0x0d && source.charCodeAt(i + 1) !== 0x0a) {
      return fatal('TP005', offsetToPos(source, i), 'Unsupported line ending: use LF or CRLF.');
    }
  }
  for (let i = 0; i < source.length; i++) {
    const unit = source.charCodeAt(i);
    // A CR here is always part of CRLF, because lone CRs were rejected first.
    if (unit === 0x0d || !isDisallowedCharacter(unit)) continue;
    return fatal(
      'TP007',
      offsetToPos(source, i),
      `The file contains the disallowed character ${unicodeName(unit)}.`,
    );
  }
  let line = 1;
  let lineStart = true;
  for (let i = 0; i < source.length; i++) {
    const unit = source.charCodeAt(i);
    if (lineStart && unit === 0x09) {
      return fatal('TP008', { line, column: 1 }, 'Tab at the start of a line: indent with spaces.');
    }
    lineStart = unit === 0x0a;
    if (lineStart) line++;
  }
  line = 1;
  lineStart = true;
  for (let i = 0; i < source.length; i++) {
    const unit = source.charCodeAt(i);
    if (lineStart && unit === 0x25 /* % */) {
      return fatal(
        'TP003',
        { line, column: 1 },
        'YAML directives are not supported in tracking plans.',
      );
    }
    lineStart = unit === 0x0a;
    if (lineStart) line++;
  }
  return load(source);
}

function isSpace(unit: number): boolean {
  return unit === 0x20 || unit === 0x09 || unit === 0x0a || unit === 0x0d;
}

function isFlowIndicator(unit: number): boolean {
  return unit === 0x5b || unit === 0x7b || unit === 0x2c; // [ { ,
}

/**
 * Anchor and tag positions and comment ranges, taken from the YAML library's
 * concrete syntax tree. Text that only looks like a tag (`"Bienvenue !"`) or
 * sits in a comment is therefore never mistaken for one.
 */
interface SourceIndex {
  /** Offsets of anchor (`&a`) and tag (`!t`) tokens. */
  readonly props: ReadonlySet<number>;
  /** Comment start offset by the offset just after the comment's last non-space character. */
  readonly commentStartByEnd: ReadonlyMap<number, number>;
}

function indexSource(source: string): SourceIndex {
  const props = new Set<number>();
  const commentStartByEnd = new Map<number, number>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value !== 'object' || value === null) return;
    const token = value as { type?: unknown; offset?: unknown; source?: unknown };
    if (typeof token.type === 'string' && typeof token.offset === 'number') {
      if (token.type === 'anchor' || token.type === 'tag') props.add(token.offset);
      if (token.type === 'comment' && typeof token.source === 'string') {
        let end = token.offset + token.source.length;
        while (end > token.offset && isSpace(source.charCodeAt(end - 1))) end--;
        commentStartByEnd.set(end, token.offset);
      }
    }
    for (const child of Object.values(value)) {
      if (typeof child === 'object' && child !== null) visit(child);
    }
  };
  for (const token of new Parser().parse(source)) visit(token);
  return { props, commentStartByEnd };
}

/**
 * Offset of the first anchor or tag written before the node starting at
 * `start`, or `undefined`. Comments between the props and the node are
 * skipped. The YAML library does not always record the tag on the node (for
 * example `!e!foo`), so the token positions decide, as in Dart.
 */
function propsStart(source: string, index: SourceIndex, start: number): number | undefined {
  let found: number | undefined;
  let i = start;
  for (;;) {
    let end = i;
    for (;;) {
      while (end > 0 && isSpace(source.charCodeAt(end - 1))) end--;
      const commentStart = index.commentStartByEnd.get(end);
      if (commentStart === undefined) break;
      end = commentStart;
    }
    let tokenStart = end;
    while (
      tokenStart > 0 &&
      !isSpace(source.charCodeAt(tokenStart - 1)) &&
      !isFlowIndicator(source.charCodeAt(tokenStart - 1))
    ) {
      tokenStart--;
    }
    if (tokenStart === end || !index.props.has(tokenStart)) return found;
    found = tokenStart;
    i = tokenStart;
  }
}

/** Whether a double-quoted scalar's source has a `\u`/`\U` escape for a surrogate. */
function hasSurrogateEscape(quoted: string): boolean {
  for (let i = 0; i < quoted.length; i++) {
    if (quoted[i] !== '\\') continue;
    const kind = quoted[i + 1];
    const digits = kind === 'u' ? 4 : kind === 'U' ? 8 : 0;
    if (digits > 0) {
      const code = Number.parseInt(quoted.slice(i + 2, i + 2 + digits), 16);
      if (code >= 0xd800 && code <= 0xdfff) return true;
    }
    i++; // Skip the escaped character.
  }
  return false;
}

function rangeStart(node: YamlNode | null | undefined): number {
  return node?.range?.[0] ?? 0;
}

const plainIntPattern = /^([-+]?[0-9]+|0o[0-7]+|0x[0-9a-fA-F]+)$/;

/**
 * A string that is equal for two scalar keys exactly when Dart's YAML loader
 * treats them as the same key: integers compare exactly (beyond 2^53), an
 * integral double equals the integer, and NaN equals NaN.
 */
function scalarKeyHash(node: Scalar, source: string): string {
  const value = node.value;
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return `b:${String(value)}`;
  if (typeof value === 'string') return `s:${value}`;
  if (typeof value === 'number') {
    const text = node.range ? source.slice(node.range[0], node.range[1]) : '';
    if (node.type === 'PLAIN' && plainIntPattern.test(text)) {
      return `n:${BigInt(text.replace(/^\+/, '').replace(/^(-?)0o/, '$10o')).toString()}`;
    }
    if (Number.isNaN(value)) return 'nan';
    if (!Number.isFinite(value)) return value > 0 ? 'inf' : '-inf';
    return Number.isInteger(value) ? `n:${BigInt(value).toString()}` : `f:${String(value)}`;
  }
  return `o:${JSON.stringify(value)}`;
}

function sameCollectionKey(a: YamlNode, b: YamlNode): boolean {
  return JSON.stringify(a.toJSON()) === JSON.stringify(b.toJSON());
}

function load(source: string): LoadResult {
  const lineCounter = new LineCounter();
  const doc: Document.Parsed = parseDocument(source, {
    lineCounter,
    uniqueKeys: false,
    prettyErrors: false,
    version: '1.2',
    merge: false,
  });
  const pos = (offset: number): Pos => {
    const p = lineCounter.linePos(offset);
    return { line: p.line, column: p.col };
  };

  // Syntax errors (TP001) and duplicate keys (TP002): whichever Dart's parser
  // would meet first wins (SPEC.md 5.2). Unresolvable tags are TP003 instead.
  let firstError: { offset: number; message: string } | undefined;
  const noteError = (offset: number, message: string) => {
    if (firstError === undefined || offset < firstError.offset) firstError = { offset, message };
  };
  for (const error of doc.errors) {
    if (error.code === 'TAG_RESOLVE_FAILED') continue;
    noteError(error.pos[0], error.message.split('\n')[0] ?? error.message);
  }

  let duplicate: { detectedAt: number; keyOffset: number; key: string } | undefined;
  let index: SourceIndex | undefined;
  // Anchors seen so far in document order. Resolving each alias through the
  // library would walk the whole document every time (quadratic).
  const anchors = new Map<string, YamlNode>();
  const resolveAlias = (alias: YamlNode): YamlNode | undefined =>
    isAlias(alias) ? anchors.get(alias.source) : alias;
  const scan = (node: YamlNode | null): void => {
    if (node === null) return;
    if (isAlias(node)) {
      if (!anchors.has(node.source)) noteError(rangeStart(node), 'Undefined alias.');
      return;
    }
    const anchor = (node as { anchor?: unknown }).anchor;
    if (typeof anchor === 'string') anchors.set(anchor, node);
    if (isScalar(node)) {
      if (node.type === 'QUOTE_DOUBLE' && node.range) {
        if (hasSurrogateEscape(source.slice(node.range[0], node.range[1]))) {
          noteError(node.range[0], 'Invalid Unicode character escape code.');
        }
      }
      return;
    }
    if (isSeq(node)) {
      for (const item of node.items) scan(item as YamlNode | null);
      return;
    }
    if (isMap(node)) {
      const seenScalars = new Set<string>();
      const seenCollections: YamlNode[] = [];
      for (const pair of node.items) {
        const key = pair.key as YamlNode | null;
        const value = pair.value as YamlNode | null;
        scan(key);
        scan(value);
        if (key === null) continue;
        // Dart compares keys by value, so an alias key counts as its anchor's value.
        const resolved = resolveAlias(key);
        if (resolved === undefined) continue;
        let earlier: boolean;
        if (isScalar(resolved)) {
          const hash = scalarKeyHash(resolved, source);
          earlier = seenScalars.has(hash);
          seenScalars.add(hash);
        } else {
          earlier = seenCollections.some((seen) => sameCollectionKey(seen, resolved));
          seenCollections.push(resolved);
        }
        if (!earlier) continue;
        // Dart's loader checks for a duplicate after loading the value.
        const detectedAt = value?.range?.[2] ?? key.range?.[2] ?? 0;
        if (duplicate === undefined || detectedAt < duplicate.detectedAt) {
          const keyText =
            isScalar(resolved) && typeof resolved.value === 'string'
              ? resolved.value
              : source.slice(rangeStart(key), key.range?.[1] ?? rangeStart(key));
          // Dart reports an alias key at its anchored node, where `&name` starts.
          const keyOffset = isAlias(key)
            ? (propsStart(source, (index ??= indexSource(source)), rangeStart(resolved)) ??
              rangeStart(resolved))
            : rangeStart(key);
          duplicate = { detectedAt, keyOffset, key: keyText };
        }
      }
    }
  };
  scan(doc.contents);

  if (
    duplicate !== undefined &&
    (firstError === undefined || duplicate.detectedAt < firstError.offset)
  ) {
    return fatal(
      'TP002',
      pos(duplicate.keyOffset),
      `Duplicate key "${escapeForMessage(duplicate.key)}".`,
    );
  }
  if (firstError !== undefined) {
    return fatal(
      'TP001',
      pos(firstError.offset),
      `Invalid YAML: ${escapeForMessage(firstError.message)}`,
    );
  }

  const feature = findUnsupportedFeature(doc.contents, source, pos);
  if (feature !== undefined) {
    return fatal('TP003', feature.pos, `YAML ${feature.name} are not supported in tracking plans.`);
  }

  const root = doc.contents as YamlNode | null;
  if (!isMap(root)) return fatal('TP004', startPos, 'The tracking plan must be a YAML mapping.');
  return { root: convert(root, source, pos) as PMap };
}

function findUnsupportedFeature(
  root: YamlNode | null,
  source: string,
  pos: (offset: number) => Pos,
): { name: string; pos: Pos } | undefined {
  const features: { offset: number; name: string; pos: Pos }[] = [];
  const index = indexSource(source);

  const inspect = (node: YamlNode | null, owner: Pos | undefined) => {
    if (node === null) return;
    const ownerPos = owner ?? startPos;
    if (isAlias(node)) {
      features.push({ offset: rangeStart(node), name: 'aliases', pos: ownerPos });
      return;
    }
    const props = propsStart(source, index, rangeStart(node));
    if (props !== undefined) {
      const name = source.charCodeAt(props) === 0x26 ? 'anchors' : 'tags';
      features.push({ offset: props, name, pos: ownerPos });
    }
  };

  const walk = (node: YamlNode | null, owner: Pos | undefined) => {
    if (isMap(node)) {
      for (const pair of node.items) {
        const key = pair.key as YamlNode | null;
        const value = pair.value as YamlNode | null;
        if (isMap(key) || isSeq(key)) {
          features.push({ offset: rangeStart(key), name: 'complex keys', pos: owner ?? startPos });
          continue;
        }
        if (isScalar(key) && key.type === 'PLAIN' && key.value === '<<') {
          features.push({ offset: rangeStart(key), name: 'merge keys', pos: owner ?? startPos });
        }
        inspect(key, owner);
        const keyPos = pos(rangeStart(key));
        inspect(value, keyPos);
        walk(value, keyPos);
      }
    } else if (isSeq(node)) {
      for (const item of node.items) {
        inspect(item as YamlNode | null, owner);
        walk(item as YamlNode | null, owner);
      }
    }
  };

  inspect(root, undefined);
  walk(root, undefined);
  if (features.length === 0) return undefined;
  features.sort((a, b) => a.offset - b.offset);
  return features[0];
}

function convert(
  node: YamlNode | null,
  source: string,
  pos: (offset: number) => Pos,
  fallback = 0,
): PNode {
  if (node === null) {
    return { kind: 'scalar', pos: pos(fallback), style: 'PLAIN', source: '', value: null };
  }
  const start = rangeStart(node);
  if (isMap(node)) {
    return {
      kind: 'map',
      pos: pos(start),
      entries: node.items.map((pair) => {
        const keyNode = pair.key as YamlNode | null;
        let key = convert(keyNode, source, pos, start);
        if (key.kind === 'scalar' && key.source === '') {
          // An empty explicit key (`? `) is reported at its `?`, as in Dart.
          let i = rangeStart(keyNode);
          while (i > 0 && (source[i - 1] === ' ' || source[i - 1] === '\t')) i--;
          if (source[i - 1] === '?') key = { ...key, pos: pos(i - 1) };
        }
        const keyEnd = keyNode?.range?.[1] ?? start;
        return { key, value: convert(pair.value as YamlNode | null, source, pos, keyEnd) };
      }),
    };
  }
  if (isSeq(node)) {
    return {
      kind: 'list',
      pos: pos(start),
      items: node.items.map((item) => convert(item as YamlNode | null, source, pos, start)),
    };
  }
  const scalar = node as Scalar;
  const end = scalar.range?.[1] ?? start;
  return {
    kind: 'scalar',
    pos: pos(start),
    style: scalar.type ?? 'PLAIN',
    source: source.slice(start, end),
    value: scalar.value,
  };
}

/** The YAML 1.2 core schema type of a scalar, decided from its source text. */
export type ScalarKind = 'null' | 'boolean' | 'integer' | 'number' | 'string';

const nullPattern = /^(|~|null|Null|NULL)$/;
const boolPattern = /^(true|True|TRUE|false|False|FALSE)$/;
const intPattern = /^([-+]?[0-9]+|0o[0-7]+|0x[0-9a-fA-F]+)$/;
const floatPattern =
  /^([-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?|[-+]?\.(inf|Inf|INF)|\.(nan|NaN|NAN))$/;

/** Classifies a scalar by its source text (SPEC.md section 2.2.1). */
export function scalarKind(scalar: PScalar): ScalarKind {
  if (scalar.style !== 'PLAIN') return 'string';
  const text = scalar.source;
  if (nullPattern.test(text)) return 'null';
  if (boolPattern.test(text)) return 'boolean';
  if (intPattern.test(text)) return 'integer';
  if (floatPattern.test(text)) return 'number';
  return 'string';
}

/** The string value of a scalar that `scalarKind` classified as a string. */
export function scalarString(scalar: PScalar): string {
  return typeof scalar.value === 'string' ? scalar.value : scalar.source;
}

const kindWords: Readonly<Record<ScalarKind, string>> = {
  null: 'null',
  boolean: 'a boolean',
  integer: 'an integer',
  number: 'a number',
  string: 'a string',
};

/** The type word for a node in messages (SPEC.md section 6.1). */
export function typeWord(node: PNode): string {
  if (node.kind === 'map') return 'a mapping';
  if (node.kind === 'list') return 'a list';
  const kind = scalarKind(node);
  if (kind === 'string' && isBlank(scalarString(node))) return 'an empty string';
  return kindWords[kind];
}

/** Whether a node is a null scalar (empty, `~` or `null`). */
export function isNullScalar(node: PNode): boolean {
  return node.kind === 'scalar' && scalarKind(node) === 'null';
}

/** Whether diagnostics about a node can point at the node itself (SPEC.md 5.1). */
export function hasOwnPosition(node: PNode): boolean {
  return (
    node.kind === 'scalar' &&
    !isNullScalar(node) &&
    (node.style === 'PLAIN' || node.style === 'QUOTE_SINGLE' || node.style === 'QUOTE_DOUBLE') &&
    !node.source.includes('\n')
  );
}
