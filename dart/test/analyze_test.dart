// Checks that generated code compiles cleanly with the Dart analyzer, for
// every valid fixture and for a plan that uses every reserved word.
@Tags(['analyze'])
library;

import 'dart:convert';
import 'dart:io';

import 'package:path/path.dart' as p;
import 'package:test/test.dart';
import 'package:trackplan/src/names.dart';
import 'package:trackplan/trackplan.dart';

String _stressPlan() {
  final words = {
    ...reservedWords,
    ...reservedMethodNames.map(_snake),
    ...reservedEnumValueNames.map(_snake),
    'type', 'get', 'set', 'on', 'required', 'async', 'params', 'payload', //
    'track', 'adapters', 'value', 'event',
  }.where(matchesNamePattern).toList()..sort();
  final buffer = StringBuffer()
    ..writeln('version: 1')
    ..writeln('enums:')
    ..writeln('  every_word:')
    ..writeln('    values: [${words.map((w) => '"$w"').join(', ')}]')
    ..writeln('events:');
  for (final word in words) {
    buffer
      ..writeln('  "$word":')
      ..writeln('    description: Event named $word.')
      ..writeln('    params:');
    for (final (i, param) in words.indexed) {
      final type = ['string', 'int', 'double', 'bool', 'list<string>'][i % 5];
      buffer.writeln(
        '      "$param": {type: $type${i.isEven ? '' : ', required: false'}}',
      );
    }
    buffer.writeln('      e: {type: enum, enum: every_word, required: false}');
  }
  return buffer.toString();
}

String _snake(String camel) =>
    camel.replaceAllMapped(RegExp('[A-Z]'), (m) => '_${m[0]!.toLowerCase()}');

void main() {
  test('generated code passes dart analyze --fatal-infos', () {
    final temp = Directory.systemTemp.createTempSync('trackplan_analyze_');
    addTearDown(() => temp.deleteSync(recursive: true));
    File(
      p.join(temp.path, 'pubspec.yaml'),
    ).writeAsStringSync('name: generated_check\nenvironment:\n  sdk: ^3.8.0\n');
    File(p.join(temp.path, 'analysis_options.yaml')).writeAsStringSync(
      'analyzer:\n  language:\n    strict-casts: true\n'
      '    strict-inference: true\n    strict-raw-types: true\n',
    );
    final lib = Directory(p.join(temp.path, 'lib'))..createSync();

    final fixtures = Directory(
      p.join('..', 'fixtures', 'valid'),
    ).listSync().whereType<Directory>();
    final plans = {
      for (final dir in fixtures)
        p.basename(dir.path): File(
          p.join(dir.path, 'plan.yaml'),
        ).readAsBytesSync(),
      'stress': utf8.encode(_stressPlan()),
    };
    for (final MapEntry(:key, :value) in plans.entries) {
      final result = validatePlan(value);
      expect(result.hasErrors, isFalse, reason: '$key: ${result.diagnostics}');
      // Remove the lint ignore so the analyzer reports everything.
      final code = generateDart(
        result.plan!,
        'plan.yaml',
      ).replaceFirst('// ignore_for_file: type=lint\n', '');
      File(p.join(lib.path, '$key.dart')).writeAsStringSync(code);
    }

    final analyze = Process.runSync(Platform.resolvedExecutable, [
      'analyze',
      '--fatal-infos',
      temp.path,
    ]);
    expect(analyze.exitCode, 0, reason: '${analyze.stdout}${analyze.stderr}');
  }, timeout: const Timeout(Duration(minutes: 3)));
}
