# Changelog

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
