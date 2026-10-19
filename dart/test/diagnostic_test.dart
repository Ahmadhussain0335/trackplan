import 'dart:convert';

import 'package:test/test.dart';
import 'package:trackplan/src/diagnostic.dart';

Diagnostic _d(String code, int line, int column, [String message = 'm']) =>
    Diagnostic(
      code,
      code.startsWith('TP1') ? Severity.warning : Severity.error,
      line,
      column,
      message,
    );

void main() {
  group('escapeForMessage', () {
    test('escapes control, bidi and line break characters', () {
      expect(escapeForMessage('a\u001B[31m'), r'a\u{001B}[31m');
      expect(escapeForMessage('x\ty\nz\r'), r'x\u{0009}y\u{000A}z\u{000D}');
      expect(
        escapeForMessage('\u{202E}\u{2028}\u{FEFF}'),
        r'\u{202E}\u{2028}\u{FEFF}',
      );
    });

    test('keeps printable text, including non-ASCII', () {
      expect(escapeForMessage('Café 😀 "q"'), 'Café 😀 "q"');
    });
  });

  test('isDisallowedCharacter matches SPEC 2.9', () {
    for (final allowed in [0x09, 0x0A, 0x20, 0x7E, 0xA0, 0x200E, 0x2065]) {
      expect(isDisallowedCharacter(allowed), isFalse, reason: '$allowed');
    }
    for (final banned in [
      0x00, 0x08, 0x0B, 0x0D, 0x1F, 0x7F, 0x85, 0x9F, 0x2028, 0x2029, //
      0x202A, 0x202E, 0x2066, 0x2069, 0xFEFF,
    ]) {
      expect(isDisallowedCharacter(banned), isTrue, reason: '$banned');
    }
  });

  test('sortDiagnostics orders by line, column, severity, code, message', () {
    final sorted = sortDiagnostics([
      _d('TP100', 2, 1),
      _d('TP020', 2, 1, 'b'),
      _d('TP020', 2, 1, 'a'),
      _d('TP011', 1, 5),
      _d('TP010', 2, 1),
      _d('TP001', 1, 9),
    ]);
    expect(sorted.map((d) => '${d.code}${d.message}'), [
      'TP011m',
      'TP001m',
      'TP010m',
      'TP020a',
      'TP020b',
      'TP100m',
    ]);
  });

  test('summaryLine uses singular and plural forms', () {
    expect(summaryLine([]), '0 errors, 0 warnings.');
    expect(summaryLine([_d('TP010', 1, 1)]), '1 error, 0 warnings.');
    expect(
      summaryLine([_d('TP100', 1, 1), _d('TP101', 1, 1), _d('TP010', 1, 1)]),
      '1 error, 2 warnings.',
    );
  });

  test('format gives file:line:column severity code message', () {
    expect(
      _d('TP030', 14, 11, 'Unknown type "float".').format('plan.yaml'),
      'plan.yaml:14:11 error TP030 Unknown type "float".',
    );
  });

  test('diagnosticsToJson matches SPEC 5.4', () {
    final json = diagnosticsToJson('p.yaml', [_d('TP100', 1, 2, 'x "y"')]);
    expect(json, endsWith('}\n'));
    expect(jsonDecode(json), {
      'file': 'p.yaml',
      'error_count': 0,
      'warning_count': 1,
      'diagnostics': [
        {
          'code': 'TP100',
          'severity': 'warning',
          'line': 1,
          'column': 2,
          'message': 'x "y"',
        },
      ],
    });
    expect(diagnosticsToJson('p', []), contains('"diagnostics": []'));
  });
}
