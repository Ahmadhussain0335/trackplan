# Changelog

## 0.2.0

Same behavior as the TypeScript package `trackplan` 0.2.0 on npm.

Breaking changes:

- Params named after `Object` members, and events or params named `then` or
  `to_j_s_o_n`, now get a trailing underscore in generated code (for example
  `value_of` becomes `valueOf_`), like events already did. The names sent to
  analytics are unchanged.
- A tab at the start of a line is now an error (TP008).

Other changes:

- `--json` output escapes control characters in the `file` value.
- Output paths may not contain invisible characters (U+200B to U+200D,
  U+2060).
- `generate` checks again that the target folder is inside the project just
  before writing.
- README: links to the TypeScript package and the main README.

## 0.1.0

First release.

- `trackplan` command with `init`, `validate`, `generate`, `check` and `docs`.
- Validates tracking plan version 1 with stable error codes (TP001 to TP118),
  reported with line and column; `--json` output for tools.
- Generates a dependency-free Dart file with an `Analytics` class, enums,
  `AnalyticsAdapter`, `RecordingAnalyticsAdapter` and
  `DebugAnalyticsAdapter`.
- Optional Firebase Analytics limit warnings.
- Generates a Markdown event catalog.
