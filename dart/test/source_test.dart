import 'dart:convert';

import 'package:test/test.dart';
import 'package:trackplan/src/diagnostic.dart';
import 'package:trackplan/src/source.dart';
import 'package:yaml/yaml.dart';

Diagnostic? _fatal(String text) => loadPlan(utf8.encode(text)).fatal;

YamlScalar _scalar(String text) =>
    (loadYamlNode('a: $text') as YamlMap).nodes['a']! as YamlScalar;

void main() {
  group('raw text checks', () {
    test('a leading BOM is ignored and columns start after it', () {
      final result = loadPlan(utf8.encode('\uFEFFversion: 1\nevents: {}\n'));
      expect(result.fatal, isNull);
      expect(posOf((result.root!.nodes.keys.first as YamlNode)), (
        line: 1,
        column: 1,
      ));
    });

    test('CRLF line endings are accepted', () {
      expect(_fatal('version: 1\r\nevents: {}\r\n'), isNull);
    });

    test('a lone CR is TP005 at its position', () {
      final d = _fatal('version: 1\n\na: b\rc: d\n')!;
      expect((d.code, d.line, d.column), ('TP005', 3, 5));
    });

    test('a lone CR at the end of the file is TP005', () {
      expect(_fatal('version: 1\r')!.code, 'TP005');
    });

    test('a raw control character is TP007 at its position', () {
      final d = _fatal('version: 1\nname: a\u0007b\n')!;
      expect(
        (d.code, d.line, d.column, d.message),
        ('TP007', 2, 8, 'The file contains the disallowed character U+0007.'),
      );
    });

    test('a raw bidi override in a comment is TP007', () {
      expect(_fatal('# \u202E\nversion: 1\n')!.code, 'TP007');
    });

    test('a U+FEFF that is not leading is TP007', () {
      expect(_fatal('version: 1\nx: \uFEFF\n')!.code, 'TP007');
    });

    test('a directive line is TP003 at column 1', () {
      final d = _fatal('version: 1\n%TAG ! tag:x\n---\n')!;
      expect((d.code, d.line, d.column), ('TP003', 2, 1));
      expect(d.message, 'YAML directives are not supported in tracking plans.');
    });

    test('a % inside a value is not a directive', () {
      expect(_fatal('version: 1\nx: 50% off\n'), isNull);
    });

    test('invalid UTF-8 is TP006', () {
      expect(loadPlan([0x61, 0xFF]).fatal!.code, 'TP006');
    });

    test('lone CR wins over a raw control character', () {
      expect(_fatal('a: \u0007\rb: 1\n')!.code, 'TP005');
    });
  });

  group('YAML loading', () {
    test('a syntax error is TP001 with the parser position', () {
      final d = _fatal('a: [1\n')!;
      expect(d.code, 'TP001');
      expect(d.message, startsWith('Invalid YAML: '));
    });

    test('more than one document is TP001', () {
      expect(_fatal('a: 1\n---\nb: 2\n')!.code, 'TP001');
    });

    test('a duplicate key is TP002 at the second key', () {
      final d = _fatal('a: 1\nb: 2\na: 3\n')!;
      expect(
        (d.code, d.line, d.column, d.message),
        ('TP002', 3, 1, 'Duplicate key "a".'),
      );
    });

    test('a quoted duplicate key is reported by its value', () {
      expect(_fatal('a: 1\n"a": 2\n')!.message, 'Duplicate key "a".');
    });

    test('keys are compared by value', () {
      final d = _fatal('1: a\n01: b\n')!;
      expect((d.code, d.message), ('TP002', 'Duplicate key "01".'));
    });

    test('a core tag that does not fit its value is TP003, not TP001', () {
      final d = _fatal('version: 1\nx: !!int abc\n')!;
      expect((d.code, d.line, d.column), ('TP003', 2, 1));
      expect(d.message, 'YAML tags are not supported in tracking plans.');
    });

    test('a verbatim tag is TP003', () {
      expect(_fatal('x: !<tag:x> y\n')!.code, 'TP003');
    });

    test('a tag followed by a syntax error is TP001', () {
      expect(_fatal('x: !!int abc\ny: [1\n')!.code, 'TP001');
    });

    test('a tag on a key is reported at the enclosing entry', () {
      final d = _fatal('events:\n  !k app: 1\n')!;
      expect((d.code, d.line, d.column), ('TP003', 1, 1));
    });

    test('an alias is reported as an anchor, which always comes first', () {
      final d = _fatal('a: &x 1\nb: *x\n')!;
      expect(d.message, 'YAML anchors are not supported in tracking plans.');
      expect((d.line, d.column), (1, 1));
    });

    test('an alias in a list is reported', () {
      final d = _fatal('a: &x 1\nb:\n  - *x\n')!;
      expect(d.code, 'TP003');
    });

    test('the earliest unsupported feature wins', () {
      final d = _fatal('a:\n  b: !t x\nc: &y 1\n')!;
      expect(d.message, contains('tags'));
      expect((d.line, d.column), (2, 3));
    });

    test('a tagged root is TP003 at 1:1', () {
      final d = _fatal('!t {a: 1}\n')!;
      expect((d.code, d.line, d.column), ('TP003', 1, 1));
    });

    test('an empty file is TP004', () {
      expect(_fatal('')!.code, 'TP004');
    });

    test('a list root is TP004', () {
      expect(_fatal('- a\n')!.code, 'TP004');
    });

    test('text that only looks like YAML features is accepted', () {
      expect(_fatal('a: Tom & Jerry\nb: a *b\nc: "&x"\nd: "!x"\n'), isNull);
    });
  });

  group('scalar kinds (SPEC 2.2.1)', () {
    final cases = {
      '': ScalarKind.nullValue,
      '~': ScalarKind.nullValue,
      'Null': ScalarKind.nullValue,
      'TRUE': ScalarKind.boolean,
      'false': ScalarKind.boolean,
      'yes': ScalarKind.string,
      '1': ScalarKind.integer,
      '+5': ScalarKind.integer,
      '-0': ScalarKind.integer,
      '0o17': ScalarKind.integer,
      '0x1F': ScalarKind.integer,
      '0o8': ScalarKind.string,
      '1.0': ScalarKind.number,
      '1.': ScalarKind.number,
      '.5': ScalarKind.number,
      '1e3': ScalarKind.number,
      '-.Inf': ScalarKind.number,
      '.NaN': ScalarKind.number,
      '1_000': ScalarKind.string,
      '"1"': ScalarKind.string,
      "'true'": ScalarKind.string,
      'abc': ScalarKind.string,
    };
    for (final MapEntry(:key, :value) in cases.entries) {
      test('"$key" is ${value.name}', () {
        expect(scalarKind(_scalar(key)), value);
      });
    }

    test('block scalars are strings', () {
      final node =
          (loadYamlNode('a: |\n  123\n') as YamlMap).nodes['a']! as YamlScalar;
      expect(scalarKind(node), ScalarKind.string);
    });
  });

  group('type words', () {
    test('describe each node type', () {
      expect(typeWord(_scalar('1')), 'an integer');
      expect(typeWord(_scalar('1.5')), 'a number');
      expect(typeWord(_scalar('"  "')), 'an empty string');
      expect(typeWord(_scalar('x')), 'a string');
      expect(typeWord(_scalar('')), 'null');
      expect(typeWord(loadYamlNode('[1]')), 'a list');
      expect(typeWord(loadYamlNode('{a: 1}')), 'a mapping');
    });
  });

  group('hasOwnPosition', () {
    test('single-line plain and quoted scalars have their own position', () {
      expect(hasOwnPosition(_scalar('x')), isTrue);
      expect(hasOwnPosition(_scalar('"x"')), isTrue);
      expect(hasOwnPosition(_scalar("'x'")), isTrue);
    });

    test('null, block and multi-line scalars and collections do not', () {
      expect(hasOwnPosition(_scalar('')), isFalse);
      expect(hasOwnPosition(_scalar('null')), isFalse);
      expect(hasOwnPosition(_scalar('"a\n  b"')), isFalse);
      expect(
        hasOwnPosition((loadYamlNode('a: |\n  x\n') as YamlMap).nodes['a']!),
        isFalse,
      );
      expect(hasOwnPosition(loadYamlNode('[1]')), isFalse);
    });
  });

  test('isBlank treats spaces, tabs and line breaks as blank', () {
    expect(isBlank(' \t\r\n'), isTrue);
    expect(isBlank(''), isTrue);
    expect(isBlank(' x '), isFalse);
  });
}
