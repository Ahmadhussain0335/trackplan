import 'dart:convert';

import 'package:test/test.dart';
import 'package:trackplan/trackplan.dart';
import 'package:trackplan/src/validator.dart' show outputPathProblem;

ValidationResult _validate(String yaml, {bool allowOutside = false}) =>
    validatePlan(utf8.encode(yaml), allowOutside: allowOutside);

/// Diagnostics as "CODE line:column message".
List<String> _diags(String yaml, {bool allowOutside = false}) => [
  for (final d in _validate(yaml, allowOutside: allowOutside).diagnostics)
    '${d.code} ${d.line}:${d.column} ${d.message}',
];

const _event = 'events:\n  app_opened:\n    description: Opened.\n';

void main() {
  group('model', () {
    test('uses defaults when targets are absent', () {
      final plan = _validate('version: 1\n$_event').plan!;
      expect(plan.dartClassName, 'Analytics');
      expect(plan.typescriptClassName, 'Analytics');
      expect(plan.dartOutput, 'lib/analytics/analytics.g.dart');
      expect(plan.typescriptOutput, 'src/analytics/analytics.ts');
      expect(plan.typescriptRuntimeChecks, isFalse);
      expect(plan.name, isNull);
    });

    test('sorts events and enums by UTF-16 code units', () {
      final plan = _validate('''
version: 1
enums:
  b_enum: {values: [x]}
  a_enum: {values: [y]}
events:
  step_1: {description: d, params: {p: {type: enum, enum: b_enum}}}
  step2: {description: d, params: {p: {type: enum, enum: a_enum}}}
''').plan!;
      expect(plan.events.map((e) => e.name), ['step2', 'step_1']);
      expect(plan.enums.map((e) => e.name), ['a_enum', 'b_enum']);
    });

    test('keeps params and enum values in plan order', () {
      final plan = _validate('''
version: 1
enums:
  size: {values: [small, large, medium]}
events:
  e:
    description: d
    params:
      z: {type: string}
      a: {type: enum, enum: size}
''').plan!;
      expect(plan.events.single.params.map((p) => p.name), ['z', 'a']);
      expect(plan.enums.single.values.map((v) => v.name), [
        'small',
        'large',
        'medium',
      ]);
    });

    test('treats null sections, events and params as empty', () {
      final result = _validate('''
version: 1
meta:
targets:
  dart:
settings:
enums:
events:
  a:
    description: d
    params:
''');
      expect(result.hasErrors, isFalse);
      expect(result.plan!.events.single.params, isEmpty);
    });

    test('keeps min and max as written', () {
      final param = _validate('''
version: 1
events:
  e: {description: d, params: {x: {type: double, min: 0.50, max: 10}}}
''').plan!.events.single.params.single;
      expect((param.min, param.max), ('0.50', '10'));
    });
  });

  group('version', () {
    test('a null version is TP012', () {
      expect(_diags('version:\n$_event'), [
        'TP012 1:1 Expected an integer for "version", got null.',
      ]);
    });

    test('a list version is TP012 at the key', () {
      expect(_diags('version: [1]\n$_event'), [
        'TP012 1:1 Expected an integer for "version", got a list.',
      ]);
    });
  });

  group('output paths', () {
    test('outputPathProblem follows SPEC 2.4', () {
      String? problem(String path, [bool allowOutside = false]) =>
          outputPathProblem(path, allowOutside: allowOutside);
      expect(problem('lib/a.dart'), isNull);
      expect(problem(''), 'empty');
      expect(problem('/a.dart'), 'absolute');
      expect(problem(r'\a.dart'), 'absolute');
      expect(problem('C:/a.dart'), 'absolute');
      expect(problem('a/../b.dart'), '..');
      expect(problem(r'a\..\b.dart'), '..');
      expect(problem('.GIT/x.dart'), '.git');
      expect(problem('a/.git/x.dart', true), '.git');
      expect(problem('../a.dart', true), isNull);
      expect(problem('/a.dart', true), isNull);
      expect(problem('', true), 'empty');
    });

    test('--allow-outside accepts .. but never .git', () {
      const plan = '''
version: 1
targets:
  dart: {output: ../x.dart}
  typescript: {output: .git/x.ts}
$_event''';
      expect(_diags(plan, allowOutside: true), [
        'TP050 4:24 Output path ".git/x.ts" must be relative and stay inside '
            'the project.',
      ]);
    });

    test('an empty output is TP050 and TP052', () {
      expect(_diags('version: 1\ntargets:\n  dart: {output: ""}\n$_event'), [
        'TP050 3:18 Output path "" must be relative and stay inside the '
            'project.',
        'TP052 3:18 Output path "" must end with .dart.',
      ]);
    });

    test('.mts and .cts are accepted for TypeScript', () {
      for (final ext in ['mts', 'cts']) {
        expect(
          _diags(
            'version: 1\ntargets:\n  typescript: {output: a.$ext}\n$_event',
          ),
          isEmpty,
        );
      }
    });
  });

  group('names and collisions', () {
    test('an enum named like the class is TP022', () {
      expect(
        _diags(
          'version: 1\nenums:\n  analytics: {values: [a]}\n'
          'events:\n  e: {description: d, params: {p: {type: enum, enum: analytics}}}\n',
        ),
        [
          'TP022 3:3 Enum "analytics" generates the type name "Analytics", '
              'which is reserved.',
        ],
      );
    });

    test('a custom class_name moves the TP022 check', () {
      const plan = '''
version: 1
targets:
  dart: {class_name: Tracker}
enums:
  tracker: {values: [a]}
  analytics: {values: [b]}
events:
  e: {description: d, params: {p: {type: enum, enum: tracker}, q: {type: enum, enum: analytics}}}
''';
      expect(_diags(plan), [
        'TP022 5:3 Enum "tracker" generates the type name "Tracker", which is '
            'reserved.',
        'TP022 6:3 Enum "analytics" generates the type name "Analytics", which '
            'is reserved.',
      ]);
    });

    test('enums whose type names collide are TP021', () {
      expect(
        _diags(
          'version: 1\nenums:\n  step_2: {values: [a]}\n  step2: {values: [b]}\n$_event',
        ),
        [
          'TP021 4:3 Enum "step2" generates the same identifier "Step2" as '
              '"step_2" (line 3).',
        ],
      );
    });

    test('an enum with an invalid name still counts as defined', () {
      final diags = _diags(
        'version: 1\nenums:\n  BadName: {values: [a]}\n'
        'events:\n  e: {description: d, params: {p: {type: enum, enum: BadName}}}\n',
      );
      expect(diags.map((d) => d.substring(0, 5)), ['TP020']);
    });

    test('an invalid enum value that is repeated gets TP020 and TP035', () {
      expect(
        _diags(
          'version: 1\nenums:\n  e: {values: [Pro, Pro]}\n$_event',
        ).map((d) => d.substring(0, 10)),
        ['TP020 3:16', 'TP020 3:21', 'TP035 3:21'],
      );
    });

    test('a name longer than 64 characters is TP020', () {
      final name = 'a' * 65;
      expect(_diags('version: 1\nevents:\n  $name: {description: d}\n'), [
        'TP020 3:3 Invalid event name "$name": longer than 64 characters.',
      ]);
    });

    test('a non-string key at a nested level is TP012', () {
      expect(
        _diags(
          'version: 1\nevents:\n  e:\n    description: d\n    params:\n      1: {type: string}\n',
        ),
        ['TP012 6:7 Keys must be strings, got an integer. Quote the key.'],
      );
    });
  });

  group('numbers (SPEC 2.8)', () {
    String param(String options) =>
        'version: 1\nevents:\n  e:\n    description: d\n    params:\n      x: {$options}\n';

    test('an integer outside ±(2^53 − 1) is out of range, even for double', () {
      expect(_diags(param('type: double, max: 9007199254740992')), [
        'TP037 6:30 Invalid number 9007199254740992 for "max": out of range.',
      ]);
      expect(_diags(param('type: int, min: -9007199254740991')), isEmpty);
    });

    test('max_length reasons are reported in SPEC order', () {
      expect(
        _diags(param('type: string, max_length: 0x10')).single,
        contains('expected a decimal number'),
      );
      expect(
        _diags(param('type: string, max_length: 1.5')).single,
        contains('expected an integer.'),
      );
      expect(
        _diags(param('type: string, max_length: -1')).single,
        contains('at least 1'),
      );
      expect(
        _diags(param('type: string, max_length: 99999999999999999999')).single,
        contains('out of range'),
      );
    });

    test('a non-numeric max_length is TP012 expecting an integer', () {
      expect(_diags(param('type: string, max_length: "5"')), [
        'TP012 6:37 Expected an integer for "max_length", got a string.',
      ]);
    });

    test('min equal to max is fine', () {
      expect(_diags(param('type: int, min: 3, max: 3')), isEmpty);
    });
  });

  group('cascade rules (SPEC 5.2)', () {
    test('a non-string type skips option checks', () {
      expect(
        _diags(
          'version: 1\nevents:\n  e:\n    description: d\n    params:\n      x: {type: 1, max_length: 0}\n',
        ),
        ['TP012 6:17 Expected a string for "type", got an integer.'],
      );
    });

    test('unused enums are not reported when there are errors', () {
      final diags = _diags(
        'version: 1\nenums:\n  unused: {values: [a]}\nevents:\n  Bad: {description: d}\n',
      );
      expect(diags.map((d) => d.substring(0, 5)), ['TP020']);
    });

    test('a description with the wrong type is TP012 without TP100', () {
      expect(_diags('version: 1\nevents:\n  e: {description: [x]}\n'), [
        'TP012 3:7 Expected a string for "description", got a list.',
      ]);
    });

    test('a blank description counts as missing', () {
      expect(_diags('version: 1\nevents:\n  e: {description: "  "}\n'), [
        'TP100 3:3 Event "e" has no description.',
      ]);
    });

    test('a blank deprecated reason is TP012', () {
      expect(
        _diags('version: 1\nevents:\n  e: {description: d, deprecated: " "}\n'),
        [
          'TP012 3:35 Expected a non-empty string for "deprecated", got an '
              'empty string.',
        ],
      );
    });

    test('provider checks skip invalid event names', () {
      expect(
        _diags(
          'version: 1\nsettings: {warn_provider_limits: [firebase]}\nevents:\n  Ga_x: {description: d}\n',
        ),
        [
          'TP020 4:3 Invalid event name "Ga_x": use lowercase snake_case starting with a letter.',
        ],
      );
    });
  });

  group('lists', () {
    test('a null tag item is reported at the list key', () {
      expect(
        _diags(
          'version: 1\nevents:\n  e:\n    description: d\n    tags:\n      -\n',
        ),
        ['TP012 5:5 Expected a string for "tags", got null.'],
      );
    });

    test('a tag with a disallowed escape is TP024 at the item', () {
      expect(
        _diags('version: 1\nevents:\n  e: {description: d, tags: ["a\\eb"]}\n'),
        ['TP024 3:30 "tags" contains the disallowed character U+001B.'],
      );
    });

    test('a non-string provider is TP012', () {
      expect(
        _diags('version: 1\nsettings: {warn_provider_limits: [1]}\n$_event'),
        [
          'TP012 2:35 Expected a string for "warn_provider_limits", got an integer.',
        ],
      );
    });

    test('a repeated provider has no effect', () {
      expect(
        _diags(
          'version: 1\nsettings: {warn_provider_limits: [firebase, firebase]}\n$_event',
        ),
        isEmpty,
      );
    });

    test('a scalar enum body is TP012', () {
      expect(_diags('version: 1\nenums:\n  e: x\n$_event'), [
        'TP012 3:6 Expected a mapping for "e", got a string.',
      ]);
    });
  });

  group('review regressions', () {
    test('an enum named map_entry is TP022', () {
      expect(_diags('version: 1\nenums:\n  map_entry: {values: [a]}\n$_event'), [
        'TP022 3:3 Enum "map_entry" generates the type name "MapEntry", which is reserved.',
      ]);
    });

    test('events with only non-string keys are not reported as empty', () {
      expect(_diags('version: 1\nevents:\n  1: {}\n'), [
        'TP012 3:3 Keys must be strings, got an integer. Quote the key.',
      ]);
    });

    test('a param without a type skips the type checks of its options', () {
      expect(
        _diags(
          'version: 1\nevents:\n  e:\n    description: d\n    params:\n      p: {min: abc, enum: 5}\n',
        ),
        ['TP010 6:7 Missing required key "type" in param "p" of event "e".'],
      );
    });

    test('TP021 does not suppress TP022', () {
      const plan =
          'version: 1\ntargets:\n  dart: {class_name: Step2Done}\n'
          'enums:\n  step_2_done: {values: [a]}\n  step2_done: {values: [b]}\n$_event';
      expect(_diags(plan).map((d) => d.substring(0, 10)), [
        'TP022 5:3 ',
        'TP021 6:3 ',
        'TP022 6:3 ',
      ]);
    });

    test('invalid class names are not compared with enum names', () {
      const plan =
          'version: 1\ntargets:\n  dart: {class_name: bad}\n  typescript: {class_name: bad}\n'
          'enums:\n  analytics: {values: [a]}\n'
          'events:\n  e: {description: d, params: {p: {type: enum, enum: analytics}}}\n';
      expect(_diags(plan).map((d) => d.substring(0, 5)), ['TP023', 'TP023']);
    });

    test('param provider checks skip invalid param names', () {
      const plan =
          'version: 1\nsettings: {warn_provider_limits: [firebase]}\nevents:\n  e:\n'
          '    description: d\n    params:\n      Bad: {type: string, max_length: 200}\n      Flag: {type: bool}\n';
      expect(_diags(plan).map((d) => d.substring(0, 5)), ['TP020', 'TP020']);
    });

    test('a blank tag is TP012', () {
      expect(
        _diags('version: 1\nevents:\n  e: {description: d, tags: ["  ", a]}\n'),
        [
          'TP012 3:30 Expected a non-empty string for "tags", got an empty string.',
        ],
      );
    });

    test('U+00A0 is not whitespace', () {
      expect(
        _diags('version: 1\nevents:\n  e: {description: "\u00A0"}\n'),
        isEmpty,
      );
    });
  });

  group('security regressions', () {
    test('an output path with control characters is TP024', () {
      expect(
        _diags(
          'version: 1\ntargets:\n  dart: {output: "a\\e[2Jb.dart"}\n$_event',
        ),
        ['TP024 3:18 "output" contains the disallowed character U+001B.'],
      );
      expect(
        _diags('version: 1\ntargets:\n  dart: {output: "a\\nb.dart"}\n$_event'),
        ['TP024 3:18 "output" contains the disallowed character U+000A.'],
      );
    });

    test('Windows aliases of .git and colons are rejected', () {
      String? problem(String path, [bool allowOutside = false]) =>
          outputPathProblem(path, allowOutside: allowOutside);
      expect(problem('.git./x.dart'), '.git');
      expect(problem('.GIT  /x.dart'), '.git');
      expect(problem('GIT~1/x.dart'), '.git');
      expect(problem('a/b.dart:stream'), 'colon');
      expect(problem('C:/x.dart', true), isNull);
      expect(problem('C:/a:b.dart', true), 'colon');
      expect(problem('.github/x.dart'), isNull);
    });

    test('many rejected tags stop the reparse loop early', () {
      final yaml = 'version: 1\nlist:\n${'  - !!int x\n' * 5000}';
      final watch = Stopwatch()..start();
      final result = _validate(yaml);
      expect(watch.elapsed, lessThan(const Duration(seconds: 5)));
      final d = result.diagnostics.single;
      expect((d.code, d.line, d.column), ('TP003', 3, 5));
    });

    test('an unknown enum reference with a huge name is fast', () {
      final yaml =
          'version: 1\nenums:\n${List.generate(2000, (i) => '  e$i: {values: [a]}\n').join()}'
          'events:\n  x:\n    description: d\n    params:\n${List.generate(500, (i) => '      p$i: {type: enum, enum: ${'z' * 400}}\n').join()}';
      final watch = Stopwatch()..start();
      _validate(yaml);
      expect(watch.elapsed, lessThan(const Duration(seconds: 5)));
    });
  });

  test('messages escape control characters from the plan', () {
    expect(_diags('version: 1\nevents:\n  "a\\tb": {description: d}\n'), [
      r'TP020 3:3 Invalid event name "a\u{0009}b": use lowercase snake_case '
          'starting with a letter.',
    ]);
  });
}
