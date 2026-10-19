import 'dart:io';

import 'package:path/path.dart' as p;
import 'package:test/test.dart';
import 'package:trackplan/src/cli.dart';
import 'package:trackplan/src/sample_plan.dart';
import 'package:trackplan/src/version.dart';
import 'package:yaml/yaml.dart';

const _plan = '''
version: 1
targets:
  dart:
    output: lib/gen/analytics.g.dart
events:
  app_opened:
    description: User opened the app.
''';

final class _Run {
  _Run(this.code, this.out, this.err);

  final int code;
  final String out;
  final String err;
}

void main() {
  late Directory temp;
  late String cwd;

  setUp(() {
    temp = Directory.systemTemp.createTempSync('trackplan_cli_');
    // Resolve symlinks (macOS /var -> /private/var) so path checks are exact.
    cwd = temp.resolveSymbolicLinksSync();
  });

  tearDown(() => temp.deleteSync(recursive: true));

  _Run run(List<String> args) {
    final out = StringBuffer();
    final err = StringBuffer();
    final code = runCli(args, cwd: cwd, out: out, err: err);
    return _Run(code, out.toString(), err.toString());
  }

  void writePlan([String content = _plan]) =>
      File(p.join(cwd, 'tracking_plan.yaml')).writeAsStringSync(content);

  group('general', () {
    test('--version prints the pubspec version', () {
      final pubspec =
          loadYaml(File('pubspec.yaml').readAsStringSync()) as YamlMap;
      expect(packageVersion, pubspec['version']);
      final result = run(['--version']);
      expect(
        (result.code, result.out),
        (exitOk, 'trackplan $packageVersion\n'),
      );
    });

    test('no arguments prints usage and exits 2', () {
      final result = run([]);
      expect(result.code, exitToolFailure);
      expect(result.out, contains('Usage: dart run trackplan'));
    });

    test('--help exits 0', () {
      expect(run(['--help']).code, exitOk);
      expect(run(['validate', '--help']).out, contains('--json'));
    });

    test('an unknown command or option exits 2', () {
      expect(run(['publish']).code, exitToolFailure);
      expect(run(['validate', '--nope']).code, exitToolFailure);
      expect(run(['validate', 'extra']).code, exitToolFailure);
      expect(run(['generate', '--json']).code, exitToolFailure);
    });

    test('a missing plan exits 2', () {
      final result = run(['validate']);
      expect(result.code, exitToolFailure);
      expect(result.err, 'Cannot read tracking_plan.yaml: file not found.\n');
    });
  });

  group('init', () {
    test('writes a valid sample plan', () {
      expect(run(['init']).code, exitOk);
      expect(
        File(p.join(cwd, 'tracking_plan.yaml')).readAsStringSync(),
        samplePlan,
      );
      final validate = run(['validate']);
      expect(
        (validate.code, validate.out),
        (exitOk, '0 errors, 0 warnings.\n'),
      );
    });

    test('refuses to overwrite an existing file', () {
      writePlan('keep me');
      final result = run(['init']);
      expect(result.code, exitToolFailure);
      expect(
        File(p.join(cwd, 'tracking_plan.yaml')).readAsStringSync(),
        'keep me',
      );
    });
  });

  group('validate', () {
    test('prints diagnostics and a summary, exit 1 on errors', () {
      writePlan('version: 2\nevents:\n  Bad: {}\n');
      final result = run(['validate']);
      expect(result.code, exitInvalid);
      expect(
        result.out,
        'tracking_plan.yaml:1:10 error TP013 Unsupported version 2. The only '
        'supported version is 1.\n'
        'tracking_plan.yaml:3:3 error TP020 Invalid event name "Bad": use '
        'lowercase snake_case starting with a letter.\n'
        'tracking_plan.yaml:3:3 warning TP100 Event "Bad" has no description.\n'
        '2 errors, 1 warning.\n',
      );
    });

    test('warnings alone exit 0', () {
      writePlan('version: 1\nevents:\n  a:\n');
      expect(run(['validate']).code, exitOk);
    });

    test('--plan reads another file', () {
      File(p.join(cwd, 'other.yaml')).writeAsStringSync(_plan);
      expect(run(['validate', '--plan', 'other.yaml']).code, exitOk);
    });
  });

  group('generate and check', () {
    test('generate writes the file and check accepts it', () {
      writePlan();
      final generate = run(['generate']);
      expect(generate.code, exitOk, reason: generate.err);
      expect(generate.out, 'Wrote lib/gen/analytics.g.dart.\n');
      final file = File(p.join(cwd, 'lib/gen/analytics.g.dart'));
      expect(file.readAsStringSync(), startsWith('// GENERATED CODE'));
      expect(run(['check']).code, exitOk);
    });

    test('generate leaves no temp files behind', () {
      writePlan();
      run(['generate']);
      expect(
        Directory(
          p.join(cwd, 'lib/gen'),
        ).listSync().map((e) => p.basename(e.path)),
        ['analytics.g.dart'],
      );
    });

    test('generate overwrites its own output', () {
      writePlan();
      run(['generate']);
      writePlan(_plan.replaceFirst('User opened', 'Someone opened'));
      expect(run(['generate']).code, exitOk);
      expect(
        File(p.join(cwd, 'lib/gen/analytics.g.dart')).readAsStringSync(),
        contains('Someone opened'),
      );
    });

    test('check fails when the file is missing or outdated', () {
      writePlan();
      final missing = run(['check']);
      expect(missing.code, exitInvalid);
      expect(missing.err, contains('does not exist'));

      run(['generate']);
      writePlan(_plan.replaceFirst('User opened', 'Someone opened'));
      final outdated = run(['check']);
      expect(outdated.code, exitInvalid);
      expect(outdated.err, contains('is out of date'));
    });

    test('plan errors stop generate with exit 1 and write nothing', () {
      writePlan('version: 1\nevents: {}\n');
      final result = run(['generate']);
      expect(result.code, exitInvalid);
      expect(result.err, contains('TP014'));
      expect(Directory(p.join(cwd, 'lib')).existsSync(), isFalse);
    });

    test('warnings are printed to stderr but do not stop generate', () {
      writePlan('version: 1\nevents:\n  a:\n');
      final result = run(['generate']);
      expect(result.code, exitOk);
      expect(result.err, contains('TP100'));
    });

    test('--out overrides the output path', () {
      writePlan();
      expect(run(['generate', '--out', 'x/a.dart']).code, exitOk);
      expect(File(p.join(cwd, 'x/a.dart')).existsSync(), isTrue);
      expect(run(['check', '--out', 'x/a.dart']).code, exitOk);
    });

    test('a bad --out exits 2', () {
      writePlan();
      expect(run(['generate', '--out', '../a.dart']).code, exitToolFailure);
      expect(run(['generate', '--out', 'a.ts']).code, exitToolFailure);
      expect(run(['generate', '--out', '.git/a.dart']).code, exitToolFailure);
    });

    test('refuses to overwrite a file it did not generate', () {
      writePlan();
      File(p.join(cwd, 'pubspec.yaml')).writeAsStringSync('name: app\n');
      final result = run(['generate', '--out', 'pubspec.yaml.dart']);
      expect(result.code, exitOk);
      File(p.join(cwd, 'main.dart')).writeAsStringSync('void main() {}\n');
      final refused = run(['generate', '--out', 'main.dart']);
      expect(refused.code, exitToolFailure);
      expect(refused.err, contains('not generated by trackplan'));
      expect(
        File(p.join(cwd, 'main.dart')).readAsStringSync(),
        'void main() {}\n',
      );
    });

    test('refuses a target that is a directory', () {
      writePlan();
      Directory(p.join(cwd, 'd.dart')).createSync();
      expect(run(['generate', '--out', 'd.dart']).code, exitToolFailure);
    });

    test('refuses to follow a symlink out of the project', () {
      final outside = Directory.systemTemp.createTempSync('trackplan_out_');
      addTearDown(() => outside.deleteSync(recursive: true));
      Link(p.join(cwd, 'lib')).createSync(outside.path);
      writePlan();
      final result = run(['generate']);
      expect(result.code, exitToolFailure);
      expect(result.err, contains('outside the current directory'));
      expect(outside.listSync(), isEmpty);
    });

    test('--allow-outside allows writing through a symlink', () {
      final outside = Directory.systemTemp.createTempSync('trackplan_out_');
      addTearDown(() => outside.deleteSync(recursive: true));
      Link(p.join(cwd, 'lib')).createSync(outside.path);
      writePlan();
      expect(run(['generate', '--allow-outside']).code, exitOk);
      expect(
        File(p.join(outside.path, 'gen/analytics.g.dart')).existsSync(),
        isTrue,
      );
    });
  });

  group('review regressions', () {
    test('check exits 1 when the output is not valid UTF-8', () {
      writePlan();
      run(['generate']);
      File(p.join(cwd, 'lib/gen/analytics.g.dart')).writeAsBytesSync([0xFF]);
      expect(run(['check']).code, exitInvalid);
    });

    test(
      'init into a missing folder is a file error, not "already exists"',
      () {
        final result = run(['init', '--plan', 'missing/plan.yaml']);
        expect(result.code, exitToolFailure);
        expect(result.err, isNot(contains('already exists')));
      },
    );

    test('a bad --out exits 2 even when the plan is invalid', () {
      writePlan('version: 2\nevents: {}\n');
      expect(run(['generate', '--out', '../a.dart']).code, exitToolFailure);
    });
  });

  group('security regressions', () {
    test('a planted symlink with a predictable temp name is not followed', () {
      final outside = Directory.systemTemp.createTempSync('trackplan_victim_');
      addTearDown(() => outside.deleteSync(recursive: true));
      final victim = File(p.join(outside.path, 'victim.txt'))
        ..writeAsStringSync('safe');
      writePlan();
      Directory(p.join(cwd, 'lib/gen')).createSync(recursive: true);
      Link(
        p.join(cwd, 'lib/gen/.analytics.g.dart.$pid.trackplan.tmp'),
      ).createSync(victim.path);
      expect(run(['generate']).code, exitOk);
      expect(victim.readAsStringSync(), 'safe');
    });

    test('a plan larger than 1 MB exits 2', () {
      writePlan('# ${'x' * (maxPlanBytes + 10)}\n');
      final result = run(['validate']);
      expect(result.code, exitToolFailure);
      expect(result.err, contains('larger than 1 MB'));
    });

    test('a plan that is a directory exits 2', () {
      Directory(p.join(cwd, 'tracking_plan.yaml')).createSync();
      expect(run(['validate']).code, exitToolFailure);
    });

    test('check refuses an output that resolves outside the project', () {
      final outside = Directory.systemTemp.createTempSync('trackplan_out_');
      addTearDown(() => outside.deleteSync(recursive: true));
      Link(p.join(cwd, 'lib')).createSync(outside.path);
      writePlan();
      final result = run(['check']);
      expect(result.code, exitToolFailure);
      expect(result.err, contains('outside the current directory'));
    });

    test('arguments are escaped in messages', () {
      final result = run(['\u001B[2Jx']);
      expect(result.err, contains(r'Unknown command "\u{001B}[2Jx"'));
      expect(result.err, isNot(contains('\u001B')));
    });
  });

  group('docs', () {
    test('writes TRACKING_PLAN.md and refuses foreign files', () {
      writePlan();
      final result = run(['docs']);
      expect(result.code, exitOk);
      expect(
        File(p.join(cwd, 'TRACKING_PLAN.md')).readAsStringSync(),
        startsWith('<!-- Generated by trackplan from tracking_plan.yaml.'),
      );
      expect(run(['docs']).code, exitOk);
      File(p.join(cwd, 'README.md')).writeAsStringSync('# Mine\n');
      expect(run(['docs', '--out', 'README.md']).code, exitToolFailure);
    });

    test('accepts any extension for --out', () {
      writePlan();
      expect(run(['docs', '--out', 'docs/events.txt']).code, exitOk);
    });
  });
}
