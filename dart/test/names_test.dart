import 'dart:io';

import 'package:path/path.dart' as p;
import 'package:test/test.dart';
import 'package:trackplan/src/names.dart';

void main() {
  group('name pattern', () {
    for (final name in ['a', 'checkout_completed', 'step_2_done', 'x1_y2']) {
      test('accepts "$name"', () => expect(matchesNamePattern(name), isTrue));
    }
    for (final name in [
      '',
      'A',
      'orderId',
      '2fa',
      '_a',
      'a_',
      'a__b',
      'a-b',
      'a b',
      'é',
    ]) {
      test('rejects "$name"', () => expect(matchesNamePattern(name), isFalse));
    }
  });

  group('case conversion (SPEC 4.2)', () {
    final cases = {
      'checkout_completed': ('checkoutCompleted', 'CheckoutCompleted'),
      'step_2_done': ('step2Done', 'Step2Done'),
      'step2_done': ('step2Done', 'Step2Done'),
      'x_y_z': ('xYZ', 'XYZ'),
      'a': ('a', 'A'),
    };
    for (final MapEntry(:key, :value) in cases.entries) {
      test(key, () {
        expect(camelCase(key), value.$1);
        expect(pascalCase(key), value.$2);
      });
    }
  });

  group('identifierFor (SPEC 4.4)', () {
    test('appends _ to reserved words in every kind', () {
      for (final kind in IdentifierKind.values) {
        expect(identifierFor('class', kind), 'class_');
        expect(identifierFor('delete', kind), 'delete_');
      }
    });

    test('leaves contextual keywords alone', () {
      for (final word in ['type', 'get', 'set', 'on', 'required', 'async']) {
        expect(identifierFor(word, IdentifierKind.param), word);
      }
    });

    test('renames Object members and then for methods and params', () {
      expect(identifierFor('to_string', IdentifierKind.method), 'toString_');
      expect(identifierFor('to_string', IdentifierKind.param), 'toString_');
      expect(identifierFor('value_of', IdentifierKind.param), 'valueOf_');
      expect(identifierFor('then', IdentifierKind.method), 'then_');
      expect(identifierFor('to_j_s_o_n', IdentifierKind.method), 'toJSON_');
      expect(identifierFor('to_string', IdentifierKind.enumValue), 'toString_');
      expect(identifierFor('then', IdentifierKind.enumValue), 'then');
    });

    test('renames enum members only for enum values', () {
      expect(identifierFor('values', IdentifierKind.enumValue), 'values_');
      expect(identifierFor('values', IdentifierKind.param), 'values');
      expect(identifierFor('index', IdentifierKind.enumValue), 'index_');
    });

    test('reserved word lists match the code blocks in SPEC.md', () {
      final spec = File(p.join('..', 'spec', 'SPEC.md')).readAsStringSync();
      Set<String> block(String heading) {
        final start = spec.indexOf(heading);
        final open = spec.indexOf('```\n', start) + 4;
        final close = spec.indexOf('```', open);
        return spec
            .substring(open, close)
            .split(RegExp(r'\s+'))
            .where((w) => w.isNotEmpty)
            .toSet();
      }

      expect(reservedWords, block('**All identifiers'));
      expect(reservedMethodNames, block('**Additionally for events'));
      expect(reservedEnumValueNames, block('**Additionally for enum values'));
    });
  });

  group('editDistance', () {
    test('computes Levenshtein distance', () {
      expect(editDistance('', ''), 0);
      expect(editDistance('abc', ''), 3);
      expect(editDistance('strng', 'string'), 1);
      expect(editDistance('requried', 'required'), 2);
      expect(editDistance('kitten', 'sitting'), 3);
    });
  });

  group('suggest (SPEC 6.3.1)', () {
    test('suggests the closest candidate within distance 2', () {
      expect(suggest('descripton', ['description', 'owner']), 'description');
    });

    test('breaks ties by candidate order', () {
      expect(suggest('mix', ['min', 'max']), 'min');
      expect(suggest('mix', ['max', 'min']), 'max');
    });

    test('requires the distance to be smaller than the written length', () {
      expect(suggest('a', ['max']), isNull);
      expect(suggest('ab', ['max']), isNull);
      expect(suggest('mn', ['min']), 'min');
    });

    test('returns null when nothing is close', () {
      expect(suggest('whatever', ['string', 'int']), isNull);
    });
  });
}
