# Changelog

## 0.2.0

First release. The version matches the Dart package `trackplan` 0.2.0 on
pub.dev, which behaves the same.

- `trackplan` command with `init`, `validate`, `generate`, `check` and `docs`.
- Validates tracking plan version 1 with stable error codes (TP001 to TP118),
  reported with line and column; `--json` output for tools. Same diagnostics
  as the Dart package for well-formed YAML (checked by shared fixtures and a
  parity test).
- Generates a dependency-free TypeScript file with an `Analytics` class,
  string literal union types for enums, `AnalyticsAdapter`,
  `RecordingAnalyticsAdapter` and `DebugAnalyticsAdapter`.
- Optional runtime checks (`runtime_checks: true`).
- Optional Firebase Analytics limit warnings.
- Generates a Markdown event catalog.
