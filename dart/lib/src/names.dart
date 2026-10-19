/// Maximum length of an event, param, enum or enum value name.
const maxNameLength = 64;

final _namePattern = RegExp(r'^[a-z][a-z0-9]*(_[a-z0-9]+)*$');

/// Whether [name] matches the name pattern of SPEC.md section 4.1
/// (length is checked separately).
bool matchesNamePattern(String name) => _namePattern.hasMatch(name);

String _capitalize(String part) =>
    part.isEmpty ? part : part[0].toUpperCase() + part.substring(1);

/// Converts a snake_case name to camelCase (SPEC.md section 4.2).
String camelCase(String name) {
  final parts = name.split('_');
  return parts.first + parts.skip(1).map(_capitalize).join();
}

/// Converts a snake_case name to PascalCase (SPEC.md section 4.2).
String pascalCase(String name) => name.split('_').map(_capitalize).join();

/// Words renamed in every identifier (SPEC.md section 4.4).
const reservedWords = {
  'assert', 'await', 'bool', 'break', 'case', 'catch', 'class', 'const', //
  'continue', 'debugger', 'default', 'delete', 'do', 'double', 'dynamic',
  'else', 'enum', 'export', 'extends', 'false', 'final', 'finally', 'for',
  'function', 'if', 'implements', 'import', 'in', 'instanceof', 'int',
  'interface', 'is', 'let', 'new', 'null', 'num', 'package', 'private',
  'protected', 'public', 'rethrow', 'return', 'static', 'super', 'switch',
  'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with',
  'yield',
};

/// Additional words renamed in method names (SPEC.md section 4.4).
const reservedMethodNames = {
  'constructor', 'hashCode', 'hasOwnProperty', 'isPrototypeOf', //
  'noSuchMethod', 'propertyIsEnumerable', 'runtimeType', 'toLocaleString',
  'toString', 'valueOf',
};

/// Additional words renamed in Dart enum constants (SPEC.md section 4.4).
const reservedEnumValueNames = {
  'hashCode', 'index', 'noSuchMethod', 'runtimeType', 'toString', 'value', //
  'values',
};

/// Type names that enums and `class_name` must not use (SPEC.md section 4.5).
const reservedTypeNames = {
  'AnalyticsAdapter', 'AnalyticsParams', 'AnalyticsValue', //
  'DebugAnalyticsAdapter', 'RecordingAnalyticsAdapter', 'Array', 'Boolean',
  'Date', 'Deprecated', 'Enum', 'Error', 'Function', 'Iterable', 'JSON', 'List',
  'Map',
  'MapEntry',
  'Never',
  'Null',
  'Number',
  'Object',
  'Promise',
  'RangeError',
  'Readonly', 'Record', 'Set', 'String', 'Symbol', 'Type',
};

/// The kind of generated identifier, which decides the rename list.
enum IdentifierKind {
  /// A method on the generated class.
  method,

  /// A named argument or params property.
  param,

  /// A Dart enum constant.
  enumValue,
}

/// The generated camelCase identifier for [name], with `_` appended when it
/// is a reserved word.
String identifierFor(String name, IdentifierKind kind) {
  final id = camelCase(name);
  final reserved =
      reservedWords.contains(id) ||
      (kind == IdentifierKind.method && reservedMethodNames.contains(id)) ||
      (kind == IdentifierKind.enumValue && reservedEnumValueNames.contains(id));
  return reserved ? '${id}_' : id;
}

/// Levenshtein distance on UTF-16 code units.
int editDistance(String a, String b) {
  var previous = List<int>.generate(b.length + 1, (i) => i);
  for (var i = 1; i <= a.length; i++) {
    final current = List<int>.filled(b.length + 1, 0);
    current[0] = i;
    for (var j = 1; j <= b.length; j++) {
      final cost = a.codeUnitAt(i - 1) == b.codeUnitAt(j - 1) ? 0 : 1;
      current[j] = [
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + cost,
      ].reduce((x, y) => x < y ? x : y);
    }
    previous = current;
  }
  return previous[b.length];
}

/// The suggestion for [written] among [candidates] (SPEC.md section 6.3.1),
/// or `null`. [candidates] must be in tie-break order.
String? suggest(String written, Iterable<String> candidates) {
  String? best;
  var bestDistance = 3;
  for (final candidate in candidates) {
    // Cheap bound that also keeps long inputs from being compared in full.
    if ((written.length - candidate.length).abs() > 2) continue;
    final distance = editDistance(written, candidate);
    if (distance <= 2 && distance < written.length && distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}
