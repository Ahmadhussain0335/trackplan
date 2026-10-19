# Shared fixtures

These fixtures define the behavior of both the Dart and the TypeScript
implementation. Both test suites loop over every directory here. See
[spec/SPEC.md, section 10](../spec/SPEC.md#10-fixtures) for the rules.

## Status: provisional

The expected files were written in Phase 1, before any implementation exists.
They follow the templates in the spec and were checked as follows:

- every `expected.dart` is formatted with `dart format` (Dart 3.13.5) and
  passes `dart analyze --fatal-infos` with `package:lints/recommended.yaml`
  and strict analysis
- every `expected.ts` passes `tsc --noEmit` (TypeScript 5.9.3 and 7.0.2) with
  `strict` and the extra flags listed in SPEC section 7.3
- every valid `plan.yaml` passes `spec/tracking_plan.schema.json`
- every position in `expected_errors.json` was checked against the source token
  it points at, and both YAML libraries report the same positions for them

Phase 2 (Dart) freezes them. Any change made then will be listed in the
Phase 2 review, never applied silently.

## Valid fixtures

| Case | Covers |
|---|---|
| `minimal` | One event, no params, no optional sections |
| `all_types` | Every param type, `min`/`max`/`max_length`, custom `class_name` |
| `enums` | Several enums (sorted output), required and optional enum params, enum without description |
| `optional_params` | Optional params of every type; event whose params are all optional |
| `deprecated_event` | Deprecated events with and without params, `owner` |
| `reserved_word_escaping` | Renaming of reserved words for events, params and enum values (including `then` and `Object` members); contextual keywords left alone |
| `special_characters_in_descriptions` | `*/`, quotes, backslashes, `$`, HTML, pipes, Unicode, tabs, multi-line text, text that looks like YAML anchors, aliases or tags |
| `missing_descriptions` | Warnings in a valid plan (`expected_errors.json`): events without descriptions, whitespace-only description, owner-only doc comment, unused enum |
| `runtime_checks` | TypeScript `runtime_checks: true`, negative and decimal bounds |
| `shop_app` | The example plan from the README |

## Invalid fixtures

| Case | Codes |
|---|---|
| `malformed_yaml`, `surrogate_escape` | TP001 |
| `duplicate_event` | TP002 |
| `yaml_alias`, `yaml_tag`, `yaml_directive`, `yaml_merge_key`, `yaml_complex_key` | TP003 |
| `root_not_mapping` | TP004 |
| `lone_cr` | TP005 |
| `invalid_utf8` | TP006 |
| `raw_control_character` | TP007 (raw bidi character in a comment) |
| `tab_indentation` | TP008 |
| `missing_required_keys` | TP010 |
| `unknown_key` | TP011, TP010, TP100 |
| `wrong_value_types` | TP012, TP037 |
| `unsupported_version`, `version_float` | TP013 |
| `version_string` | TP012 |
| `empty_events` | TP014 |
| `invalid_event_name` | TP020 |
| `escaped_key` | TP020, with control characters escaped in the message |
| `camelcase_collision` | TP021 |
| `enum_errors` | TP010, TP020, TP021, TP022, TP034, TP035 |
| `invalid_targets` | TP023, TP050, TP051 |
| `output_path_rules` | TP050 (`.git` segment), TP052, two diagnostics at one position |
| `disallowed_characters` | TP024 |
| `unknown_type` | TP030 |
| `bad_enum_reference` | TP031, TP032 |
| `option_not_allowed` | TP033 |
| `min_greater_than_max` | TP036 |
| `warnings_only` | TP100, TP101 (exit code 0) |
| `firebase_limits` | TP110, TP111, TP112, TP114, TP115, TP116, TP117 (exit code 0) |
| `firebase_param_count` | TP113 (exit code 0) |
| `firebase_event_count` | TP118 (exit code 0) |

Some fixtures contain deliberately unusual bytes (lone CR, invalid UTF-8, a
raw U+202E, literal `\u` escapes). Write such files with a script that emits
exact bytes, and check them with `xxd`; editors and tools may silently
convert them. `.gitattributes` stops git from changing line endings.

## Adding a fixture

1. Create `valid/<case>/` or `invalid/<case>/` with a `plan.yaml`.
2. Write the expected files by hand, or run the tests with `UPDATE_GOLDENS=1`
   and review every line of the diff before committing.
3. Run both test suites.
