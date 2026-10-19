import 'dart:convert';

/// How serious a [Diagnostic] is.
enum Severity {
  /// The plan cannot be used to generate code.
  error,

  /// The plan works, but something should be fixed.
  warning,
}

/// A problem found in a tracking plan, with a stable code such as `TP030`.
final class Diagnostic {
  /// Creates a diagnostic. [line] and [column] are 1-based.
  const Diagnostic(
    this.code,
    this.severity,
    this.line,
    this.column,
    this.message,
  );

  /// Stable code, for example `TP030`. See SPEC.md section 6.
  final String code;

  /// Whether this is an error or a warning.
  final Severity severity;

  /// 1-based line.
  final int line;

  /// 1-based column, counted in UTF-16 code units.
  final int column;

  /// Human-readable message. Plan text in it is escaped with [escapeForMessage].
  final String message;

  /// Whether this is an error.
  bool get isError => severity == Severity.error;

  /// Formats this diagnostic as one line of human-readable output.
  String format(String file) =>
      '$file:$line:$column ${severity.name} $code $message';

  @override
  String toString() => format('<plan>');
}

/// Sorts diagnostics as required by SPEC.md section 5.3.
List<Diagnostic> sortDiagnostics(Iterable<Diagnostic> diagnostics) {
  final list = diagnostics.toList();
  list.sort((a, b) {
    var c = a.line.compareTo(b.line);
    if (c != 0) return c;
    c = a.column.compareTo(b.column);
    if (c != 0) return c;
    c = a.severity.index.compareTo(b.severity.index);
    if (c != 0) return c;
    c = a.code.compareTo(b.code);
    if (c != 0) return c;
    return a.message.compareTo(b.message);
  });
  return list;
}

/// Whether [codeUnit] is in the disallowed set of SPEC.md section 2.9.
bool isDisallowedCharacter(int codeUnit) =>
    codeUnit <= 0x08 ||
    (codeUnit >= 0x0B && codeUnit <= 0x1F) ||
    (codeUnit >= 0x7F && codeUnit <= 0x9F) ||
    codeUnit == 0x2028 ||
    codeUnit == 0x2029 ||
    (codeUnit >= 0x202A && codeUnit <= 0x202E) ||
    (codeUnit >= 0x2066 && codeUnit <= 0x2069) ||
    codeUnit == 0xFEFF;

/// Formats [codeUnit] as `U+XXXX`.
String unicodeName(int codeUnit) =>
    'U+${codeUnit.toRadixString(16).toUpperCase().padLeft(4, '0')}';

/// Escapes plan text for use inside a message (SPEC.md section 6.1).
///
/// Tab, line feed, carriage return and disallowed characters become
/// `\u{XXXX}`, so a plan cannot inject terminal escape codes into logs.
String escapeForMessage(String text) {
  final buffer = StringBuffer();
  for (final unit in text.codeUnits) {
    if (unit == 0x09 ||
        unit == 0x0A ||
        unit == 0x0D ||
        isDisallowedCharacter(unit)) {
      buffer.write(
        '\\u{${unit.toRadixString(16).toUpperCase().padLeft(4, '0')}}',
      );
    } else {
      buffer.writeCharCode(unit);
    }
  }
  return buffer.toString();
}

/// Formats diagnostics as the `--json` output of SPEC.md section 5.4.
String diagnosticsToJson(String file, List<Diagnostic> diagnostics) {
  final errors = diagnostics.where((d) => d.isError).length;
  final value = <String, Object>{
    'file': file,
    'error_count': errors,
    'warning_count': diagnostics.length - errors,
    'diagnostics': [
      for (final d in diagnostics)
        {
          'code': d.code,
          'severity': d.severity.name,
          'line': d.line,
          'column': d.column,
          'message': d.message,
        },
    ],
  };
  return '${const JsonEncoder.withIndent('  ').convert(value)}\n';
}

/// Formats the summary line, for example `1 error, 0 warnings.`
String summaryLine(List<Diagnostic> diagnostics) {
  final errors = diagnostics.where((d) => d.isError).length;
  final warnings = diagnostics.length - errors;
  return '$errors ${errors == 1 ? 'error' : 'errors'}, '
      '$warnings ${warnings == 1 ? 'warning' : 'warnings'}.';
}
