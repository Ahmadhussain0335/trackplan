# trackplan tracking plan format, version 1

Status: draft for review (Phase 1). Nothing here is released yet.

This document defines the `tracking_plan.yaml` format, how it is validated, and
what code and docs are generated from it. The Dart and TypeScript
implementations must behave identically; the shared fixtures in `/fixtures`
are the executable form of this spec. Where this text and a fixture disagree,
that is a bug in one of them.

## Contents

1. [Decisions taken in this draft](#1-decisions-taken-in-this-draft)
2. [File format](#2-file-format)
3. [Parameter types](#3-parameter-types)
4. [Names and identifiers](#4-names-and-identifiers)
5. [Validation](#5-validation)
6. [Diagnostic codes](#6-diagnostic-codes)
7. [Generated code](#7-generated-code)
8. [Generated docs](#8-generated-docs)
9. [CLI](#9-cli)
10. [Fixtures](#10-fixtures)
11. [Future (out of scope for v1)](#11-future-out-of-scope-for-v1)

## 1. Decisions taken in this draft

These were open questions in the brief. Each has a default chosen here; all of
them are easy to change before v0.1.0 and hard to change after.

| # | Question | Decision in this draft | Why |
|---|---|---|---|
| D1 | Format of enum values | Same snake_case rule as event names | Starting strict and relaxing later is not a breaking change; the reverse is. |
| D2 | Reserved words as event, param or enum value names | Rename by appending `_` (`class` becomes `class_`) in both languages. The wire name is never changed. | Wire names are what dashboards key on. Rejecting `default` or `new` would force teams to break their data history. |
| D3 | Enum type names that collide with generated or core types | Reject (TP022) | Enum type names never reach the wire, so rejecting costs nothing. |
| D4 | Unknown keys in the plan | Error (TP011) with a "did you mean" hint | Catches typos such as `requried: false`, which would otherwise silently make a param required. |
| D5 | Maximum name length | 64 characters (TP020) | The tool's own limit. Provider limits (Firebase: 40) are opt-in warnings. |
| D6 | Ordering in generated output | Events and enums sorted by name; params and enum values in plan order | Reordering events in the YAML causes no diff; param order carries meaning for readers. |
| D7 | `targets` section | Optional, with defaults (Section 2.3) | A minimal plan should just work. |
| D8 | Helper type names | Fixed names (`AnalyticsAdapter`, `RecordingAnalyticsAdapter`, ...); only the main class name is configurable | Simple and predictable. Each generated file is its own library or module, so two plans in one project only clash if both files are imported in the same scope. |
| D9 | Diagnostic messages in fixtures | Compared exactly, except for TP001 | Messages are part of the user experience and must match across the two tools. |
| D10 | YAML anchors, aliases and tags | Rejected (TP003) | They add little to a tracking plan, and the two parsers report different positions for them. |

## 2. File format

### 2.1 Encoding and YAML subset

- The file must be UTF-8 (TP006). A leading byte order mark is ignored.
- Line endings must be LF or CRLF. A lone CR is rejected (TP005) because the
  two YAML parsers treat it differently.
- The raw file must not contain any character from the disallowed set in
  Section 2.9, anywhere, including comments (TP007). A CR that is part of a
  CRLF line ending is allowed. This blocks "Trojan
  Source" bidi tricks in comments and avoids a parser difference: Dart's YAML
  parser rejects raw control characters, npm's accepts them.
- YAML directives (any line starting with `%`, such as `%YAML 1.1`) are not
  supported (TP003). npm's parser switches to YAML 1.1 rules on `%YAML 1.1`
  (`yes` becomes `true`, `010` becomes 8); Dart's does not.
- A `\u` or `\U` escape in a double-quoted scalar that encodes a UTF-16
  surrogate (U+D800 to U+DFFF) is TP001, even as a valid pair. Dart's parser
  rejects these; the TypeScript tool must check for them itself. Write the
  character directly instead (`"😀"` is fine).
- The file must contain exactly one YAML document whose root is a mapping
  (TP001, TP004).
- Anchors (`&a`), aliases (`*a`), tags (`!!str`), merge keys (`<<`) and
  complex (non-scalar) keys are not supported (TP003).
- Mapping keys must be strings. A plain key that YAML reads as another type,
  such as `true:` or `123:`, is TP012; quote it if you really mean it.
- A key may appear only once in a mapping (TP002). This covers duplicate
  events, params and enums.

### 2.2 Top-level keys

```yaml
# yaml-language-server: $schema=./tracking_plan.schema.json
version: 1          # required, integer 1
meta: {}            # optional
targets: {}         # optional
settings: {}        # optional
enums: {}           # optional
events: {}          # required, at least one event
```

Any other top-level key is TP011.

A key with an empty value (YAML `null`) is treated as an empty mapping for
`meta`, `targets`, `targets.dart`, `targets.typescript`, `settings`, `enums`,
an event, and an event's `params`. Everywhere else, `null` is a type error
(TP012).

### 2.2.1 Scalar types

The type of a plain (unquoted) scalar is decided from its **source text**
using the YAML 1.2 core schema patterns below, not from the value the parser
returns. This keeps the two tools in step (for example, Dart parses `1.0` as a
double while JavaScript has a single number type). Quoted and block scalars
are always strings.

| Type word in messages | Pattern (whole text) |
|---|---|
| `null` | empty, `~`, `null`, `Null`, `NULL` |
| `a boolean` | `true`, `True`, `TRUE`, `false`, `False`, `FALSE` |
| `an integer` | `[-+]?[0-9]+`, `0o[0-7]+`, `0x[0-9a-fA-F]+` |
| `a number` | `[-+]?(\.[0-9]+\|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?`, `[-+]?\.(inf\|Inf\|INF)`, `\.(nan\|NaN\|NAN)` |
| `a string` / `an empty string` | anything else |

Where a number is expected, both `an integer` and `a number` are accepted
(then Section 2.8 applies). A string that is empty or contains only
whitespace counts as `an empty string`.

"Whitespace" in this spec always means exactly these four characters: space
(U+0020), tab (U+0009), line feed (U+000A) and carriage return (U+000D).
Other Unicode spaces such as U+00A0 or U+3000 are ordinary characters.
Implementations must not use their language's general `trim` functions for
this.

### 2.2.2 `version`

`version` must be a plain scalar whose source text is exactly `1`. A value
that is not `an integer` or `a number` is TP012 (`Expected an integer for
"version", got ...`). Any other integer or number, such as `2` or `1.0`, is
TP013.

### 2.3 `meta`

| Key | Type | Required | Default | Used in |
|---|---|---|---|---|
| `name` | string | no | `Tracking plan` | Docs title |
| `description` | string | no | none | Docs intro |

### 2.4 `targets`

| Key | Type | Default |
|---|---|---|
| `targets.dart.output` | string (relative path) | `lib/analytics/analytics.g.dart` |
| `targets.dart.class_name` | string (PascalCase) | `Analytics` |
| `targets.typescript.output` | string (relative path) | `src/analytics/analytics.ts` |
| `targets.typescript.class_name` | string (PascalCase) | `Analytics` |
| `targets.typescript.runtime_checks` | bool | `false` |

Output paths are relative to the directory the CLI runs in. Both `/` and `\`
count as separators. A path starting with `/`, `\` or a drive letter (`C:`)
counts as absolute. The validator checks the text of the path:

- it must not contain a tab, line feed or any character from the disallowed
  set of Section 2.9 (TP024), so a plan cannot inject control sequences into
  CI logs through file names
- it must not be empty, absolute, contain `:` (other than a leading drive
  letter), or contain a `..` or `.git` segment (TP050,
  unless the CLI is run with `--allow-outside`, which lifts only the absolute
  and `..` rules). A segment counts as `.git` after removing trailing dots
  and spaces and ignoring case (Windows treats `.GIT.` as `.git`), and
  `git~1` (any digits) counts too, because it is the Windows short name.
- `targets.dart.output` must end with `.dart`; `targets.typescript.output`
  must end with `.ts`, `.mts` or `.cts` (TP052)

When writing, the CLI also (exit code 2 on failure):

- resolves symlinks in the existing part of the path and refuses to write
  outside the current directory unless `--allow-outside` is given
- refuses to overwrite an existing file whose first line is not the generated
  header (Section 7.1), so a plan can never be used to overwrite
  `pubspec.yaml`, `package.json` or source files

`class_name` must match `^[A-Z][A-Za-z0-9]*$` and must not be a reserved type
name (Section 4.5) (TP023). Both `class_name` values are checked by both tools,
even though each tool only generates its own language.

### 2.5 `settings`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `warn_provider_limits` | list of strings | `[]` | Enables provider limit warnings. v1 supports only `firebase` (TP051 otherwise). Repeating a provider has no effect. |

### 2.6 `enums`

```yaml
enums:
  payment_method:              # enum name, snake_case
    description: How the user paid.   # optional
    values: [card, paypal, cash]       # required, at least one value
```

- `values` items must be strings and follow the name rule (TP020). Plain
  values that YAML reads as other types (`true`, `null`, `1`) are TP012.
- Values must be unique within the enum (TP035), including after case
  conversion (TP021). Every item that breaks the name rule gets TP020, and
  every repeat of an earlier item gets TP035, so `[Bad, Bad]` produces TP020,
  TP020 and TP035.
- An enum that no param uses is a warning (TP101).

### 2.7 `events`

```yaml
events:
  checkout_completed:          # event name, snake_case
    description: User finished payment successfully.   # should be present (TP100)
    owner: growth-team         # optional, docs and doc comments
    tags: [checkout, revenue]  # optional, docs only; items must not be blank
    deprecated: Use checkout_completed instead.        # optional, non-empty reason
    params:                    # optional
      order_id:                # param name, snake_case
        type: string           # required
        description: Unique order ID.  # optional
        required: true         # optional, default true
        max_length: 32         # string only
        min: 0                 # int and double only
        max: 100               # int and double only
        enum: payment_method   # required when type is enum, not allowed otherwise
```

### 2.8 Numbers

`min`, `max` and `max_length` are checked against their **source text**, not
the parsed value, because JavaScript cannot tell `1` from `1.0`:

- `min` and `max` must match `^-?(0|[1-9][0-9]*)(\.[0-9]+)?$`. Hex, octal,
  exponents, `+`, `.inf` and `.nan` are TP037.
- For `int` params, `min` and `max` must be integers (no `.`) (TP037).
- `max_length` must be an integer of at least 1 (TP037).
- Integers must be within ±9007199254740991 (2^53 − 1) (TP037).
- `min` must not be greater than `max` (TP036), compared numerically.

TP037 reports one reason per value, the first that applies:

1. text does not match the decimal pattern: `expected a decimal number`
2. an integer is required (`int` params, `max_length`) and the text has a
   `.`: `expected an integer`
3. `max_length` is less than 1: `expected an integer of at least 1`
4. the text has no `.` and its value is outside ±(2^53 − 1), in any context
   (Dart rejects larger integer literals even where a double is expected):
   `out of range`
- The source text is copied unchanged into generated code and messages
  (`min: 0.50` produces `>= 0.50`).

### 2.9 Free text

`meta.name`, `meta.description`, every `description`, `deprecated`, `owner`
and `tags` items are free text. They may contain any character except:

- C0 control characters other than tab and line feed (U+0000–U+0008,
  U+000B–U+001F), DEL (U+007F) and C1 controls (U+0080–U+009F)
- U+2028 and U+2029 (JavaScript line terminators)
- Bidirectional formatting characters U+202A–U+202E and U+2066–U+2069
  ("Trojan Source", CVE-2021-42574)
- U+FEFF

Violations are TP024, reported once per value, for its first disallowed
character. Free text is escaped for each output (Section 7.6).

A `description`, `owner` or `meta.name` that is empty or only whitespace
counts as absent (TP100 for event descriptions). `deprecated` must not be empty or only whitespace (TP012).

`meta.name`, `owner` and `tags` items are single-line in all outputs: line
breaks in them are replaced with a space. Descriptions and `deprecated` keep
their line breaks.

## 3. Parameter types

| Plan type | Dart type | TypeScript type | Allowed options |
|---|---|---|---|
| `string` | `String` | `string` | `max_length` |
| `int` | `int` | `number` | `min`, `max` |
| `double` | `double` | `number` | `min`, `max` |
| `bool` | `bool` | `boolean` | none |
| `enum` | generated Dart `enum` (wire value in `.value`) | string literal union | `enum` (required) |
| `list<string>` | `List<String>` | `readonly string[]` | none |

All types also allow `description` and `required`. An option that the type
does not allow is TP033. An unknown type is TP030 with a suggestion (Section
6.3).

## 4. Names and identifiers

### 4.1 Name rule

Event names, param names, enum names and enum values must:

- match `^[a-z][a-z0-9]*(_[a-z0-9]+)*$` (lowercase snake_case, starting with
  a letter, no leading, trailing or double underscores)
- be at most 64 characters long

Otherwise TP020. The pattern is checked first; the length message is only
used for names that match the pattern.

### 4.2 Case conversion

Split the name on `_`.

- **camelCase**: keep the first part as is; upper-case the first character of
  each later part. Parts that start with a digit are unchanged.
- **PascalCase**: upper-case the first character of every part.

| Name | camelCase | PascalCase |
|---|---|---|
| `checkout_completed` | `checkoutCompleted` | `CheckoutCompleted` |
| `step_2_done` | `step2Done` | `Step2Done` |
| `step2_done` | `step2Done` | `Step2Done` |
| `x_y_z` | `xYZ` | `XYZ` |

Used as follows:

| Plan name | Dart | TypeScript |
|---|---|---|
| Event | method, camelCase | method, camelCase |
| Param | named argument, camelCase | property of the `params` object, camelCase |
| Enum | `enum` type, PascalCase | union type, PascalCase |
| Enum value | enum constant, camelCase | string literal (unchanged) |

The original snake_case names are always used on the wire (event name, payload
keys, enum values).

### 4.3 Collisions

Two names in the same scope must not produce the same identifier (TP021). The
scopes are: all events; the params of one event; all enums; the values of one
enum. Because of the name rule, a collision can only happen when a part starts
with a digit (`step_2_done` and `step2_done`). An enum value that is an exact
duplicate is reported as TP035 only, not also as TP021.

### 4.4 Reserved words

If a generated camelCase identifier is in the list below, `_` is appended (for
example `class` becomes `class_`, `to_string` becomes `toString_`). The same
renaming is applied in Dart and TypeScript so both APIs have the same names.
The wire name is unchanged. Renaming cannot cause a new collision, because the
name rule forbids a trailing `_`.

This list is frozen for plan `version: 1`. Adding a word would rename a user's
method, which is a breaking change.

**All identifiers (events, params, enum values):** Dart reserved words, the
Dart type names that generated code uses (a param named `int` would hide the
`int` type), and JavaScript reserved and strict-mode words:

```
assert await bool break case catch class const continue debugger default
delete do double dynamic else enum export extends false final finally for
function if implements import in instanceof int interface is let new null
num package private protected public rethrow return static super switch this
throw true try typeof var void while with yield
```

Dart built-in identifiers and contextual keywords that are legal in every
position used by generated code (for example `type`, `get`, `set`, `on`,
`required`, `async`) are not renamed, so common param names like `type` stay
as they are. This was checked against the Dart 3.13 analyzer.

**Additionally for events (methods on the generated class):**

```
constructor hashCode hasOwnProperty isPrototypeOf noSuchMethod
propertyIsEnumerable runtimeType toLocaleString toString valueOf
```

**Additionally for enum values (Dart enum constants):**

```
hashCode index noSuchMethod runtimeType toString value values
```

### 4.5 Reserved type names

An enum whose PascalCase name, or a `class_name`, is one of these is rejected
(TP022 for enums, TP023 for `class_name`):

- Generated names: `AnalyticsAdapter`, `AnalyticsParams`, `AnalyticsValue`,
  `DebugAnalyticsAdapter`, `RecordingAnalyticsAdapter`
- Core types and globals that generated code uses or that commonly clash:
  `Array`, `Boolean`, `Date`, `Deprecated`, `Enum`, `Error`, `Function`,
  `Iterable`, `JSON`, `List`, `Map`, `MapEntry`, `Never`, `Null`, `Number`, `Object`,
  `Promise`, `RangeError`, `Readonly`, `Record`, `Set`, `String`, `Symbol`,
  `Type`

An enum is also rejected (TP022) if its PascalCase name equals either target's
`class_name` (or `Analytics` when that target has no `class_name`). An invalid
`class_name` (TP023) is not compared with enum names. TP022 is reported even
when the same enum also has TP021.

Private members in generated code start with `_` (`_adapters`, `_track`), so
they can never collide with a generated name.

## 5. Validation

### 5.1 Positions

Every diagnostic has a 1-based `line` and `column`. Columns count UTF-16 code
units, which is what both YAML libraries report natively (an emoji counts as
two columns). Both tools must report the same position for the same input.

Where the position points:

- **A key** (unknown key, invalid name, duplicate key): the first character
  of the key.
- **A value**: the first character of the value (for a quoted scalar, the
  opening quote). This is used only when the value is a single-line plain or
  quoted scalar that is not null. For a collection, a null value (empty, `~`
  or `null`), or a block scalar (`|`, `>`), the position of its key is used
  instead.
- **A sequence item**: the first character of the item. Block (`- a`) and flow
  (`[a, b]`) sequences behave the same. For an item that is a collection, null
  or a block scalar, the position of the sequence's key is used instead.
- Columns on line 1 are counted after a leading byte order mark is removed.
- **The whole file** (missing root key, root not a mapping, invalid UTF-8):
  `1:1`.
- **TP003**: the key of the innermost mapping entry whose value contains the
  unsupported node. For a merge key or complex key, that is the entry of the
  mapping that holds the key (for example `screen:` for a `<<:` inside it).
  `1:1` if there is no such entry.
- **TP001**: the position the YAML parser reports. It is shown to the user,
  but it is not compared between the two tools, because their parsers report
  syntax errors differently.

### 5.2 Cascade rules

To keep the two tools in step, checks are skipped in these cases:

1. A **fatal** diagnostic (TP001–TP007) stops validation; it is the only
   diagnostic reported. Fatal checks run in this order, and the first one
   that fails wins:
   1. TP006 (not UTF-8)
   2. TP005 (lone CR)
   3. TP007 (disallowed raw character; the first one in the file)
   4. TP003 for directives (the first `%` line)
   5. TP001 or TP002, whichever comes first in the document (Dart's parser
      stops at the first of the two it meets). When Dart's parser rejects a
      core tag (for example `!!int abc`), the tag is blanked out and the file
      is parsed again; after 20 such tags the Dart tool reports TP003 at the
      first of them without parsing further. Both tools exit with 1; the
      position may differ for such a file.
   6. TP003 for anchors, aliases, tags, merge keys and complex keys (the
      first one in document order)
   7. TP004 (root is not a mapping)
2. A name that fails TP020 is not checked for TP021, TP022, or reserved
   words, and is skipped by provider checks.
3. A param whose `type` is missing, unknown, or not a string is not checked
   for TP031–TP033 or TP036–TP037, and its `min`, `max`, `max_length` and
   `enum` values are not type-checked (no TP012 for them).
4. A value with the wrong YAML type (TP012) is not checked further.
5. TP036 (`min` > `max`) is only checked when both numbers passed TP037.
6. TP101 (unused enum) is only checked when the plan has no errors.
7. An enum with an invalid name (TP020) still counts as defined, so params
   that reference it do not also get TP032.
8. Counts (TP014 empty `events`, TP113, TP118) include entries whose keys
   are not strings, so a mapping with only a `1:` key is not "empty".
9. Provider checks: TP110–TP113 are skipped for an event with an invalid
   name; TP114–TP117 are skipped for a param with an invalid name. Params of
   an event with an invalid name are still checked.

### 5.3 Ordering and exit codes

Diagnostics are sorted by line, then column, then severity (errors first),
then code, then message. Strings are always compared by UTF-16 code units,
never by locale.

`validate` exits with `0` when there are no errors (warnings are allowed),
`1` when there is at least one error, and `2` when the tool itself fails (file
not found, unreadable, bad arguments). `generate`, `check` and `docs` validate
first and refuse to write anything if there are errors.

### 5.4 Output

Human-readable (default), one line per diagnostic:

```
tracking_plan.yaml:14:11 error TP030 Unknown type "float". Did you mean "double"?
```

followed by a summary line: `1 error, 0 warnings.`

Machine-readable (`--json`):

```json
{
  "file": "tracking_plan.yaml",
  "error_count": 1,
  "warning_count": 0,
  "diagnostics": [
    {
      "code": "TP030",
      "severity": "error",
      "line": 14,
      "column": 11,
      "message": "Unknown type \"float\". Did you mean \"double\"?"
    }
  ]
}
```

`file` is the `--plan` path exactly as given. The output is exactly what
JavaScript's `JSON.stringify(value, null, 2)` produces (Dart:
`JsonEncoder.withIndent('  ')`), with keys in the order shown, followed by a
final line feed. Non-ASCII characters are not escaped.

## 6. Diagnostic codes

Codes are stable. A code is never reused for a different check. Gaps are left
for future codes.

### 6.1 Errors

| Code | Fatal | Check | Position | Message |
|---|---|---|---|---|
| TP001 | yes | Invalid YAML syntax, or more than one document | Parser's own | `Invalid YAML: <parser message>` |
| TP002 | yes | Duplicate key in a mapping (only the first one in document order is reported). Keys are compared by value, so `1` and `01` are duplicates, and two complex keys `[a]` are duplicates too (this TP002 wins over TP003). | The second key | `Duplicate key "<key>".` where key is the key's string value, or its source text if it is not a string |
| TP003 | yes | Directive, anchor, alias, tag, merge key or complex key | Directive: `<line>:1`. Others: the nearest mapping key that contains it; `1:1` if none | `YAML <feature> are not supported in tracking plans.` where feature is `directives`, `anchors`, `aliases`, `tags`, `merge keys` or `complex keys` |
| TP004 | yes | Empty file, or root is not a mapping | `1:1` | `The tracking plan must be a YAML mapping.` |
| TP005 | yes | Lone CR line ending | The CR | `Unsupported line ending: use LF or CRLF.` |
| TP006 | yes | File is not valid UTF-8 | `1:1` | `The file is not valid UTF-8.` |
| TP007 | yes | Raw disallowed character (Section 2.9) anywhere in the file | The character | `The file contains the disallowed character U+<XXXX>.` |
| TP010 | | Required key missing: `version`, `events` (root), `type` (param), `values` (enum) | Parent key; `1:1` for root | `Missing required key "<key>" in <context>.` |
| TP011 | | Unknown key | The key | `Unknown key "<key>" in <context>.` plus ` Did you mean "<s>"?` when a key at the same level is within edit distance 2 |
| TP012 | | Value has the wrong YAML type, a key is not a string, or `deprecated` is empty | Value (Section 5.1) or the key | `Expected <expected> for "<key>", got <actual>.` / `Keys must be strings, got <actual>. Quote the key.` |
| TP013 | | `version` is not the integer `1` | Value | `Unsupported version <source text>. The only supported version is 1.` |
| TP014 | | `events` has no events | `events` key | `"events" must contain at least one event.` |
| TP020 | | Name breaks the name rule | The key, or the sequence item for enum values | `Invalid <kind> name "<name>": use lowercase snake_case starting with a letter.` / `Invalid <kind> name "<name>": longer than 64 characters.` |
| TP021 | | Two names produce the same identifier | The later name | `<Kind> "<name>" generates the same identifier "<id>" as "<other>" (line <n>).` |
| TP022 | | Enum type name is reserved or equals a `class_name` | Enum key | `Enum "<name>" generates the type name "<Type>", which is reserved.` |
| TP023 | | Invalid or reserved `class_name` | Value | `Invalid class name "<v>": use PascalCase starting with A-Z.` / `Class name "<v>" is reserved.` |
| TP024 | | Free text contains a disallowed character | Value (Section 5.1) or the key | `"<key>" contains the disallowed character U+<XXXX>.` |
| TP030 | | Unknown param type | `type` value | `Unknown type "<t>".` plus ` Did you mean "<s>"?` or ` Supported types: string, int, double, bool, enum, list<string>.` |
| TP031 | | `type: enum` without an `enum` key | `type` value | `Param "<p>" has type enum but no "enum" key.` |
| TP032 | | `enum` names an enum that does not exist | `enum` value | `Unknown enum "<name>".` plus ` Did you mean "<s>"?` when one is within edit distance 2 |
| TP033 | | Option not allowed for the type | The option key | `Option "<option>" is not allowed for type <type>.` |
| TP034 | | Enum has no values | `values` key | `Enum "<name>" has no values.` |
| TP035 | | Duplicate enum value | The second item | `Duplicate value "<v>" in enum "<name>".` |
| TP036 | | `min` greater than `max` | `min` value | `"min" (<min>) is greater than "max" (<max>).` |
| TP037 | | Invalid number (Section 2.8) | Value | `Invalid number <text> for "<key>": <reason>.` where reason is `expected a decimal number`, `expected an integer`, `expected an integer of at least 1` or `out of range` |
| TP050 | | Output path is empty, absolute, or has a `..` or `.git` segment | `output` value | `Output path "<path>" must be relative and stay inside the project.` |
| TP051 | | Unknown provider in `warn_provider_limits` | The item | `Unknown provider "<p>". Supported providers: firebase.` |
| TP052 | | Output path has the wrong file extension | `output` value | `Output path "<path>" must end with <extensions>.` where extensions is `.dart` or `.ts, .mts or .cts` |

Text taken from the plan (names, keys, values, source text) is inserted into
messages with these characters written as `\u{XXXX}` (uppercase hex, at
least 4 digits): tab, line feed, carriage return, and every character in the
disallowed set of Section 2.9. A plan can therefore never inject terminal
escape sequences or bidi overrides into CI logs.

In TP012 and TP024, `<key>` is the mapping key that holds the value; for a
list item it is the list's key (for example `"tags"`), and the position is
the item.

`<context>` is one of: `the plan`, `meta`, `targets`, `targets.dart`,
`targets.typescript`, `settings`, `enum "<name>"`, `event "<name>"`,
`param "<param>" of event "<event>"`.

`<kind>` is one of `event`, `param`, `enum`, `enum value`; `<Kind>` is the
same with a capital first letter.

`<expected>` and `<actual>` are one of: `a string`, `an integer`,
`a number`, `a boolean`, `a list`, `a mapping`, `null`, `a non-empty string`
(expected only) and `an empty string` (actual only).

TP003 is fatal, so only the first unsupported feature in document order is
reported. TP100 is only reported when the `description` key is absent; a
`description` with the wrong type is TP012 instead.

### 6.2 Warnings

| Code | Check | Position | Message |
|---|---|---|---|
| TP100 | Event has no `description` | Event key | `Event "<name>" has no description.` |
| TP101 | Enum not used by any param | Enum key | `Enum "<name>" is not used by any param.` |

### 6.3 Type suggestions (TP030)

First an alias table, then edit distance:

| Written | Suggested |
|---|---|
| `float`, `number`, `decimal` | `double` |
| `integer`, `long` | `int` |
| `boolean` | `bool` |
| `str`, `text` | `string` |
| `list`, `array`, `string[]`, `list<String>`, `List<String>` | `list<string>` |

If there is no alias, the closest type is suggested using the rule below.

### 6.3.1 Suggestions (TP011, TP030, TP032)

A candidate is suggested when its Levenshtein distance (on UTF-16 code units)
to the written text is at most 2 **and** smaller than the length of the
written text. The candidate with the smallest distance wins; ties go to the
candidate that comes first in this order:

- TP030: the type table order in Section 3
- TP032: enum names sorted by UTF-16 code units
- TP011: the order in which keys are listed for that level:
  - root: `version`, `meta`, `targets`, `settings`, `enums`, `events`
  - `meta`: `name`, `description`
  - `targets`: `dart`, `typescript`
  - `targets.dart`: `output`, `class_name`
  - `targets.typescript`: `output`, `class_name`, `runtime_checks`
  - `settings`: `warn_provider_limits`
  - enum: `description`, `values`
  - event: `description`, `owner`, `tags`, `deprecated`, `params`
  - param: `type`, `description`, `required`, `min`, `max`, `max_length`,
    `enum` (all param keys, whatever the param's type)

### 6.4 Provider limit warnings (opt-in)

Enabled with `settings.warn_provider_limits: [firebase]`. Limits are taken from
the official Firebase documentation (checked 2026-10-19):

- `FirebaseAnalytics.logEvent`:
  https://firebase.google.com/docs/reference/android/com/google/firebase/analytics/FirebaseAnalytics#logEvent(java.lang.String,android.os.Bundle)
- `FirebaseAnalytics.Event` (reserved event names):
  https://firebase.google.com/docs/reference/android/com/google/firebase/analytics/FirebaseAnalytics.Event
- Google Analytics collection limits:
  https://support.google.com/analytics/answer/9267744

| Code | Check | Position | Message |
|---|---|---|---|
| TP110 | Event name longer than 40 characters | Event key | `Firebase: event name "<e>" is longer than 40 characters.` |
| TP111 | Event name starts with `firebase_`, `google_` or `ga_` | Event key | `Firebase: event name "<e>" uses the reserved prefix "<prefix>".` |
| TP112 | Event name is reserved by Firebase (list below) | Event key | `Firebase: event name "<e>" is reserved and will be dropped.` |
| TP113 | Event has more than 25 params | `params` key | `Firebase: event "<e>" has <n> params; the limit is 25.` |
| TP114 | Param name longer than 40 characters | Param key | `Firebase: param name "<p>" is longer than 40 characters.` |
| TP115 | Param name starts with `firebase_`, `google_` or `ga_` | Param key | `Firebase: param name "<p>" uses the reserved prefix "<prefix>".` |
| TP116 | `max_length` greater than 100 | `max_length` value | `Firebase: string values are limited to 100 characters, but "max_length" is <n>.` |
| TP117 | Param type `bool` or `list<string>` (Firebase supports string, long and double params) | `type` value | `Firebase: type <t> is not supported for event params; the adapter must convert it.` |
| TP118 | More than 500 events | `events` key | `Firebase: the plan has <n> events; the limit is 500 distinct events per app.` |

Reserved Firebase event names (TP112):

```
ad_activeview ad_click ad_exposure ad_query ad_reward adunit_exposure
app_background app_clear_data app_exception app_remove app_store_refund
app_store_subscription_cancel app_store_subscription_convert
app_store_subscription_renew app_update app_upgrade dynamic_link_app_open
dynamic_link_app_update dynamic_link_first_open error first_open first_visit
notification_dismiss notification_foreground notification_open
notification_receive os_update session_start session_start_with_rollout
user_engagement
```

## 7. Generated code

### 7.1 General rules

- Output is deterministic: the same plan always produces byte-identical
  output. No timestamps, no tool version, no absolute paths.
- Line endings are LF and the file ends with exactly one line feed.
- Generated files have zero runtime dependencies.
- The header names the plan file by its base name only. Characters outside
  `[A-Za-z0-9._ -]` in the base name are replaced with `_` so a file name can
  never inject code into the header comment.
- Order: header, adapter interface (and TS value types), enums, the main
  class with one method per event, `RecordingAnalyticsAdapter`,
  `DebugAnalyticsAdapter`. Enums and events are sorted by their snake_case
  plan name, compared by UTF-16 code units (so `step2` sorts before
  `step_1`).
- Within a method, params are in plan order. Enum constants are in plan order.
- Every adapter receives the same params object for an event. It is
  read-only, including `list<string>` values, which are copied (Dart
  `Map.unmodifiable` and `List.unmodifiable`, TS `Object.freeze`), so one
  adapter cannot change what the next one sees and later changes to the
  caller's list do not leak into recorded events.

### 7.2 Dart

- Requires Dart language version 3.8 or later in the user's package, because
  optional params use null-aware map elements (`'coupon_code': ?couponCode`),
  which the `use_null_aware_elements` lint in `package:lints` 6 asks for.
  Dart 3.8 shipped with Flutter 3.32.
- Formatted with `dart_style` at language version 3.8 (tall style). The
  version is pinned so that upgrading the tool's `dart_style` within the same
  style does not change the output.
- The line `// dart format off` follows the header, so `dart format` in the
  user's project never rewrites the generated file. Without it, a user whose
  SDK bundles a different `dart_style`, or whose package uses a newer language
  version, could see `check` fail after running `dart format .`.
- Must pass `dart analyze` with `package:lints/recommended.yaml` and
  `strict-casts`, `strict-inference`, `strict-raw-types`. The file starts with
  `// ignore_for_file: type=lint` so stricter lint sets in user projects do not
  report generated code.
- Optional params are nullable named arguments; they are left out of the
  payload when `null` (null-aware map elements).
- `min`, `max` and `max_length` become `assert`s (debug builds only).
- Enum params send `.value`.
- Deprecated events get `@Deprecated('<reason>')`.
- The method doc comment holds the event description, then `Owner: <owner>`
  if set, then the param descriptions under a `Parameters:` heading, because
  Dart has no per-argument doc comments. Blocks are separated by an empty
  `///` line.

### 7.3 TypeScript

- Must compile with `tsc --noEmit` under `strict: true`, and also under
  `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`,
  `noPropertyAccessFromIndexSignature`, `noUnusedLocals`,
  `noUnusedParameters`, `verbatimModuleSyntax`, `isolatedModules` and
  `erasableSyntaxOnly`, because users may have any of these on.
- The file starts with `/* eslint-disable */`.
- Each method takes one `params` object. If every param is optional, the
  object itself is optional (`= {}`).
- Optional properties are typed `name?: T | undefined` and are left out of the
  payload when `undefined`.
- The method JSDoc holds the event description, then `Owner: <owner>` if
  set, then `@deprecated <reason>` if deprecated. A one-line JSDoc is written
  as `/** text */`.
- Param descriptions become JSDoc comments on the properties.
- No parameter properties in constructors (not allowed by
  `erasableSyntaxOnly`).

### 7.4 Runtime checks

| | Dart | TypeScript |
|---|---|---|
| `min`, `max` | `assert(x >= min, ...)` | only when `runtime_checks: true`: `if (!(x >= min)) throw new RangeError(...)` |
| `max_length` | `assert(x.length <= n, ...)` | only when `runtime_checks: true`: `if (x.length > n) throw new RangeError(...)` |
| `int` | enforced by the type system | only when `runtime_checks: true`: `if (!Number.isInteger(x)) throw new RangeError(...)` |

The `!(x >= min)` form also rejects `NaN`. String length is counted in UTF-16
code units in both languages. Messages use the camelCase argument name:
`total must be >= 0`, `couponCode must be at most 32 characters`,
`position must be an integer`.

### 7.5 Helper classes

Generated in every file:

- `AnalyticsAdapter`: the interface users implement for each backend.
- `RecordingAnalyticsAdapter`: stores events in `events` (oldest first) for
  unit tests; `clear()` empties it.
- `DebugAnalyticsAdapter`: takes a logging callback (no `print` or `console`
  dependency) and passes it one line per event.

TypeScript also exports `AnalyticsValue` (the value types a param can have)
and `AnalyticsParams` (the read-only params object).

### 7.6 Escaping

Free text never reaches generated code unescaped:

| Where | Rule |
|---|---|
| Dart doc comment (`///`) | Each line of the text becomes its own `///` line. Trailing whitespace (space and tab only) on each line and leading/trailing blank lines are removed. In the `Parameters:` list, continuation lines of a multi-line description are indented by two spaces. |
| TS JSDoc (`/** */`) | Same line handling, with ` * ` prefixes. `*/` is written as `*\/`. |
| Dart string literal (`@Deprecated`) | Single-quoted. `\` → `\\`, `'` → `\'`, `$` → `\$`, line feed → `\n`, tab → `\t`. |
| Markdown docs | See Section 8. |

Names in code come only from names that passed the name rule, so they need no
escaping.

## 8. Generated docs

`docs` writes `TRACKING_PLAN.md` (override with `--out`). Both tools produce
byte-identical docs.

Structure:

1. A generated-file comment: `<!-- Generated by trackplan from <file>. Do not edit by hand. -->`
2. `# <meta.name>` (default `Tracking plan`), then `meta.description` if
   present.
3. `Events: <n>. Enums: <n>.`
4. `## Events`: a summary table (Event, Description, Owner, Tags, Status),
   then one `### <event>` section per event with, in this order: the
   description (or `_No description._`), the deprecation note
   (`**Deprecated:** <reason>`), owner and tags as a list, and a params table
   (Param, Type, Required, Constraints, Description) or `No parameters.`
5. `## Enums` (only if the plan has enums): one `### <enum>` section per enum
   with description, values, and `Used by: <event.param>, ...` (or
   `Not used by any param.`).

Events and enums are sorted as in Section 7.1.

Text rules:

- Free text is treated as Markdown, except that `&`, `<` and `>` are written
  as `&amp;`, `&lt;` and `&gt;` so the catalog cannot contain raw HTML.
- In table cells, `|` is written as `\|` and line breaks as `<br>`.
- Empty cells contain `-`.
- A line of free text that starts with up to three spaces and then ```` ``` ````
  or `~~~` gets a backslash before the fence characters, so a description
  cannot open a code block that hides the rest of the catalog.
- Line handling is the same as for code comments (Section 7.6): trailing
  whitespace on each line and leading/trailing blank lines are removed. This
  also drops Markdown hard line breaks made with two trailing spaces.
- The file ends with exactly one line feed.
- The catalog is CommonMark/GitHub Flavored Markdown. It is not safe to render
  as MDX, where `{...}` and lines starting with `import` or `export` are code.

## 9. CLI

Both packages ship the same commands. The Dart CLI generates Dart only; the
TypeScript CLI generates TypeScript only.

| Command | Behavior |
|---|---|
| `init` | Writes a sample `tracking_plan.yaml`. Refuses to overwrite an existing file (exit 2). |
| `validate` | Validates the plan. `--json` for machine-readable output. |
| `generate` | Validates, then writes this language's output file atomically (temp file + rename). |
| `check` | Validates, then exits `1` if the output file is missing or its bytes differ from what `generate` would write (including a file that is not valid UTF-8). Writes nothing. |
| `docs` | Validates, then writes `TRACKING_PLAN.md`. |

Flags:

| Flag | Commands |
|---|---|
| `--plan <path>` (default `tracking_plan.yaml`) | all |
| `--allow-outside` | `validate`, `generate`, `check`, `docs` |
| `--out <path>` (overrides the target output) | `generate`, `check`, `docs` |
| `--json` | `validate` |
| `--help`, `-h` | all, and on its own |
| `--version` | on its own only (`trackplan --version`) |

Usage errors (unknown command or flag, invalid `--out`, plan file not found,
a plan larger than 1 MB) exit with 2 before the plan is validated. File names,
arguments and paths in CLI messages are escaped like plan text in messages
(Section 6.1).

`check` refuses (exit 2) an output path that resolves outside the current
directory unless `--allow-outside` is given. It compares the file length
first, so it never reads a large or special file in full. `generate` writes
through a temporary file with a random name created exclusively in the target
directory, then renames it.

`docs --out` follows the path rules except the file extension rule. `generate`,
`check` and `docs` print warnings to stderr and continue; errors stop them with
exit code 1.

A plan nested so deeply that a parser runs out of stack is a tool failure
(exit 2), not a diagnostic.

`--out` follows the same path rules as `output`, but because it does not
come from the plan, a bad `--out` is a usage error (exit 2) rather than a
diagnostic.

## 10. Fixtures

```
fixtures/
  valid/<case>/plan.yaml
  valid/<case>/expected.dart
  valid/<case>/expected.ts
  valid/<case>/expected_docs.md
  valid/<case>/expected_errors.json   (optional, warnings only)
  invalid/<case>/plan.yaml
  invalid/<case>/expected_errors.json
```

- Valid fixtures must produce no errors, and the generated outputs must
  match the expected files byte for byte. A valid fixture may have an
  `expected_errors.json` listing its warnings; without one it must produce no
  diagnostics at all.
- `invalid/` fixtures contain any plan that produces diagnostics, including
  warning-only plans (exit code 0).
- `expected_errors.json` has the `--json` shape from Section 5.4, produced by
  running `validate --plan plan.yaml --json` in the fixture directory. Tests
  compare it field by field. For TP001, `line`, `column` and `message` are
  `null` in the fixture, meaning "not compared"; the tool must still report
  non-null values.
- Setting `UPDATE_GOLDENS=1` rewrites expected files. Any rewrite must be
  reviewed in the diff before it is committed.

## 11. Future (out of scope for v1)

- User properties, super properties and global context params
- Nested objects and lists of types other than string
- Screen tracking helpers
- Multiple plan files and imports
- Per-provider name mapping
- Kotlin and Swift output
- Provider limit checks for providers other than Firebase
- Relaxed enum values (any string, with a separate identifier)
