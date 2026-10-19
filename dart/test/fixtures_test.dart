// Runs every shared fixture in ../fixtures (SPEC.md section 10).
//
// Set UPDATE_GOLDENS=1 to rewrite expected files that differ. Rewritten files
// are printed and the affected tests are marked as skipped, so an update run
// never looks like a normal green run. Review the diff before committing.
import 'dart:convert';
import 'dart:io';

import 'package:path/path.dart' as p;
import 'package:test/test.dart';
import 'package:trackplan/src/cli.dart';
import 'package:trackplan/src/diagnostic.dart';
import 'package:trackplan/trackplan.dart';

final _updateGoldens = Platform.environment['UPDATE_GOLDENS'] == '1';

String _fixturesRoot() {
  final override = Platform.environment['TRACKPLAN_FIXTURES'];
  final root =
      override ?? p.normalize(p.join(Directory.current.path, '..', 'fixtures'));
  if (!Directory(root).existsSync()) {
    throw StateError('Fixtures not found at $root. Run tests from dart/.');
  }
  return root;
}

List<Directory> _cases(String root, String kind) {
  final dirs =
      Directory(p.join(root, kind)).listSync().whereType<Directory>().toList()
        ..sort((a, b) => a.path.compareTo(b.path));
  return dirs;
}

/// Compares [actual] with the expected file, or rewrites it in update mode.
void _expectFile(String path, String actual) {
  final file = File(path);
  final expected = file.existsSync() ? file.readAsStringSync() : null;
  if (expected == actual) return;
  if (_updateGoldens) {
    file.writeAsStringSync(actual);
    print('UPDATED $path');
    markTestSkipped('Golden updated: $path');
    return;
  }
  expect(actual, expected, reason: 'Output differs from $path');
}

Map<String, Object?> _json(List<Diagnostic> diagnostics) =>
    jsonDecode(diagnosticsToJson('plan.yaml', diagnostics))
        as Map<String, Object?>;

/// Compares diagnostics field by field; `null` in the fixture means "not
/// compared" and is only allowed for TP001.
void _expectDiagnostics(String path, List<Diagnostic> diagnostics) {
  final file = File(path);
  final actual = _json(diagnostics);
  if (!file.existsSync()) {
    expect(
      diagnostics,
      isEmpty,
      reason: 'No $path, so no diagnostics expected',
    );
    return;
  }
  final expected = jsonDecode(file.readAsStringSync()) as Map<String, Object?>;
  final expectedList = (expected['diagnostics']! as List)
      .cast<Map<String, Object?>>();
  final actualList = (actual['diagnostics']! as List)
      .cast<Map<String, Object?>>();

  final matches =
      actualList.length == expectedList.length &&
      expected['error_count'] == actual['error_count'] &&
      expected['warning_count'] == actual['warning_count'] &&
      [
        for (var i = 0; i < actualList.length; i++)
          _diagnosticMatches(expectedList[i], actualList[i]),
      ].every((m) => m);
  if (matches) return;

  if (_updateGoldens) {
    final hasWildcards = expectedList.any((d) => d['line'] == null);
    if (!hasWildcards) {
      file.writeAsStringSync(diagnosticsToJson('plan.yaml', diagnostics));
      print('UPDATED $path');
      markTestSkipped('Golden updated: $path');
      return;
    }
  }
  expect(
    const JsonEncoder.withIndent('  ').convert(actual),
    const JsonEncoder.withIndent('  ').convert(expected),
    reason: 'Diagnostics differ from $path',
  );
}

bool _diagnosticMatches(
  Map<String, Object?> expected,
  Map<String, Object?> actual,
) {
  for (final key in ['code', 'severity', 'line', 'column', 'message']) {
    final e = expected[key];
    if (e == null) {
      if (expected['code'] != 'TP001') return false;
      if (actual[key] == null) return false;
      continue;
    }
    if (e != actual[key]) return false;
  }
  return true;
}

void main() {
  final root = _fixturesRoot();

  group('valid fixtures', () {
    for (final dir in _cases(root, 'valid')) {
      final name = p.basename(dir.path);
      group(name, () {
        late ValidationResult result;
        setUpAll(() {
          result = validatePlan(
            File(p.join(dir.path, 'plan.yaml')).readAsBytesSync(),
          );
        });

        test('has no errors and the expected warnings', () {
          expect(
            result.diagnostics
                .where((d) => d.isError)
                .map((d) => d.format('plan.yaml')),
            isEmpty,
          );
          _expectDiagnostics(
            p.join(dir.path, 'expected_errors.json'),
            result.diagnostics,
          );
        });

        test('generates expected.dart', () {
          _expectFile(
            p.join(dir.path, 'expected.dart'),
            generateDart(result.plan!, 'plan.yaml'),
          );
        });

        test('generates expected_docs.md', () {
          _expectFile(
            p.join(dir.path, 'expected_docs.md'),
            generateDocs(result.plan!, 'plan.yaml'),
          );
        });
      });
    }
  });

  group('invalid fixtures', () {
    for (final dir in _cases(root, 'invalid')) {
      final name = p.basename(dir.path);
      final expectedPath = p.join(dir.path, 'expected_errors.json');

      test('$name: diagnostics', () {
        final result = validatePlan(
          File(p.join(dir.path, 'plan.yaml')).readAsBytesSync(),
        );
        _expectDiagnostics(expectedPath, result.diagnostics);
        final expected =
            jsonDecode(File(expectedPath).readAsStringSync())
                as Map<String, Object?>;
        expect(result.plan == null, (expected['error_count']! as int) > 0);
      });

      test('$name: validate --json matches byte for byte', () {
        final expected = File(expectedPath).readAsStringSync();
        if (expected.contains('"line": null')) {
          markTestSkipped('TP001 positions are not compared');
          return;
        }
        final out = StringBuffer();
        final err = StringBuffer();
        final code = runCli(
          ['validate', '--plan', 'plan.yaml', '--json'],
          cwd: dir.path,
          out: out,
          err: err,
        );
        expect(err.toString(), isEmpty);
        expect(out.toString(), expected);
        expect(
          code,
          expected.contains('"error_count": 0') ? exitOk : exitInvalid,
        );
      });
    }
  });
}
