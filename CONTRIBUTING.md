# Contributing

Thanks for helping. trackplan has two implementations, Dart (`dart/`) and
TypeScript (`ts/`), that must behave identically. The spec in
[`spec/SPEC.md`](spec/SPEC.md) is the source of truth, and the shared
fixtures in [`fixtures/`](fixtures/) are its executable form.

## Setup

```sh
# Dart (SDK 3.11 or later)
cd dart && dart pub get && dart test

# TypeScript (Node.js 20 or later)
cd ts && npm ci && npm test

# Both tools on the same inputs (after `npm run build` in ts/)
node tool/parity.mjs
```

Before opening a pull request, run what CI runs:

- Dart: `dart format --set-exit-if-changed lib bin test tool`,
  `dart analyze --fatal-infos`, `dart test`
- TypeScript: `npm run lint`, `npm run typecheck`, `npm run format:check`,
  `npm test`, `npm run build`
- Parity: `node tool/parity.mjs`

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org)
(`feat:`, `fix:`, `docs:`, `test:`, `chore:`).

## Changing behavior

Every behavior change starts in the spec and the fixtures, then goes into
both implementations in the same pull request:

1. Update `spec/SPEC.md`.
2. Add or update fixtures.
3. Change `dart/lib/src/` and `ts/src/`.
4. Run both test suites and `tool/parity.mjs`.

Diagnostic codes are stable: never reuse a code for a different check. The
reserved word lists in SPEC.md section 4.4 are frozen for plan version 1,
because adding a word would rename a user's method.

## Adding a fixture

1. Create `fixtures/valid/<case>/` or `fixtures/invalid/<case>/` with a
   `plan.yaml`.
2. For a valid case, add `expected.dart`, `expected.ts` and
   `expected_docs.md`, plus `expected_errors.json` if the plan has warnings.
   For an invalid case, add `expected_errors.json`.
3. You can let the tests write the expected files: run
   `UPDATE_GOLDENS=1 dart test test/fixtures_test.dart` and
   `UPDATE_GOLDENS=1 npx vitest run test/fixtures.test.ts`. Review every
   line of the resulting diff; the update mode is not a way to make a failing
   test pass.
4. Some fixtures contain unusual bytes (a lone CR, invalid UTF-8, literal
   `\u` escapes). Write such files with a script and check them with `xxd`;
   editors can silently change them.

See [`fixtures/README.md`](fixtures/README.md) for the list of cases.

## Adding a parameter type

A new type touches every layer:

1. **Spec:** add it to the type table in SPEC.md section 3 (Dart type,
   TypeScript type, allowed options) and to the suggestion table in 6.3.
2. **Schema:** add it to `spec/tracking_plan.schema.json`.
3. **Validator:** add it to the type list and the allowed options in
   `dart/lib/src/model.dart` and `dart/lib/src/validator.dart`, and in
   `ts/src/model.ts` and `ts/src/validator.ts`. Decide whether Firebase
   supports it (TP117).
4. **Generators:** map it in `dart/lib/src/dart_generator.dart` and
   `ts/src/tsGenerator.ts`, including payload conversion and runtime checks.
   Generated code must still pass `dart analyze --fatal-infos` and strict
   `tsc`; the analyzer and compile tests check this.
5. **Fixtures:** extend `fixtures/valid/all_types` and add an invalid case
   for misuse.

## Good first issues

- Add more TP030 type suggestions (for example `str[]` or `timestamp`).
- Add a fixture for TP002 on duplicate params and duplicate enums.
- Show the plan's `meta.description` in the generated class doc comment.
- Add `--quiet` to `validate` to print only errors.
- Add a `--format=github` option that prints GitHub Actions annotations.
- Document a Mixpanel and an Amplitude adapter in both package READMEs,
  checked against the current SDKs.
- Add a pre-commit hook example that runs `check`.

Larger roadmap items (planned, not promised): Kotlin and Swift output, a
VS Code extension, user properties and global context params.

## Security

Treat tracking plans as untrusted input: the generators escape all free
text, and the CLIs refuse to write outside the project or overwrite files
they did not generate. If you find a way around this, please report it
privately through GitHub's security advisories for this repository instead
of a public issue.
