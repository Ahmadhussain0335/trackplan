import 'dart:convert';

import 'package:yaml/yaml.dart';

import 'diagnostic.dart';

/// 1-based source position.
typedef Pos = ({int line, int column});

/// Position of the start of [node].
Pos posOf(YamlNode node) =>
    (line: node.span.start.line + 1, column: node.span.start.column + 1);

/// The result of loading a plan: either a root mapping or one fatal diagnostic.
final class LoadResult {
  LoadResult._(this.root, this.fatal);

  /// The root mapping, when loading succeeded.
  final YamlMap? root;

  /// The fatal diagnostic (TP001–TP008), when loading failed.
  final Diagnostic? fatal;
}

/// Decodes [bytes] and runs the fatal checks of SPEC.md section 5.2, rule 1.
LoadResult loadPlan(List<int> bytes) {
  final String text;
  try {
    text = utf8.decode(bytes);
  } on FormatException {
    return _fail('TP006', 1, 1, 'The file is not valid UTF-8.');
  }
  final source = text.startsWith('\u{FEFF}') ? text.substring(1) : text;

  final lineEnding = _checkLineEndings(source);
  if (lineEnding != null) return LoadResult._(null, lineEnding);

  final rawCharacter = _checkRawCharacters(source);
  if (rawCharacter != null) return LoadResult._(null, rawCharacter);

  final tab = _checkLeadingTabs(source);
  if (tab != null) return LoadResult._(null, tab);

  final directive = _checkDirectives(source);
  if (directive != null) return LoadResult._(null, directive);

  return _load(source);
}

LoadResult _fail(String code, int line, int column, String message) =>
    LoadResult._(null, Diagnostic(code, Severity.error, line, column, message));

Pos _offsetToPos(String source, int offset) {
  var line = 1;
  var lineStart = 0;
  for (var i = 0; i < offset; i++) {
    if (source.codeUnitAt(i) == 0x0A) {
      line++;
      lineStart = i + 1;
    }
  }
  return (line: line, column: offset - lineStart + 1);
}

Diagnostic? _checkLineEndings(String source) {
  for (var i = 0; i < source.length; i++) {
    if (source.codeUnitAt(i) == 0x0D &&
        (i + 1 >= source.length || source.codeUnitAt(i + 1) != 0x0A)) {
      final pos = _offsetToPos(source, i);
      return Diagnostic(
        'TP005',
        Severity.error,
        pos.line,
        pos.column,
        'Unsupported line ending: use LF or CRLF.',
      );
    }
  }
  return null;
}

Diagnostic? _checkRawCharacters(String source) {
  for (var i = 0; i < source.length; i++) {
    final unit = source.codeUnitAt(i);
    // A CR here is always part of CRLF, because lone CRs were rejected first.
    if (unit == 0x0D || !isDisallowedCharacter(unit)) continue;
    final pos = _offsetToPos(source, i);
    return Diagnostic(
      'TP007',
      Severity.error,
      pos.line,
      pos.column,
      'The file contains the disallowed character ${unicodeName(unit)}.',
    );
  }
  return null;
}

Diagnostic? _checkLeadingTabs(String source) {
  var line = 1;
  var lineStart = true;
  for (var i = 0; i < source.length; i++) {
    final unit = source.codeUnitAt(i);
    if (lineStart && unit == 0x09) {
      return Diagnostic(
        'TP008',
        Severity.error,
        line,
        1,
        'Tab at the start of a line: indent with spaces.',
      );
    }
    lineStart = unit == 0x0A;
    if (lineStart) line++;
  }
  return null;
}

Diagnostic? _checkDirectives(String source) {
  var line = 1;
  var lineStart = true;
  for (var i = 0; i < source.length; i++) {
    final unit = source.codeUnitAt(i);
    if (lineStart && unit == 0x25 /* % */ ) {
      return Diagnostic(
        'TP003',
        Severity.error,
        line,
        1,
        'YAML directives are not supported in tracking plans.',
      );
    }
    lineStart = unit == 0x0A;
    if (lineStart) line++;
  }
  return null;
}

// package:yaml throws these when a core tag does not fit its node. Tags are
// TP003, so the tag is blanked out and the text is loaded again.
bool _isTagError(String message) =>
    message == 'Invalid tag for sequence.' ||
    message == 'Invalid tag for mapping.' ||
    message == 'Invalid null scalar.' ||
    message == 'Invalid bool scalar.' ||
    message == 'Invalid int scalar.' ||
    message == 'Invalid float scalar.' ||
    message == 'Undefined tag handle.' ||
    message.startsWith('Undefined tag: ');

const _maxTagRetries = 20;

LoadResult _load(String source) {
  var text = source;
  final blankedTags = <int>[];
  YamlNode root;
  while (true) {
    try {
      root = loadYamlNode(text);
      break;
    } on YamlException catch (e) {
      final span = e.span;
      if (e.message == 'Duplicate mapping key.' && span != null) {
        return _fail(
          'TP002',
          span.start.line + 1,
          span.start.column + 1,
          'Duplicate key "${escapeForMessage(_keyText(span.text))}".',
        );
      }
      if (_isTagError(e.message) && span != null) {
        final range = _tagRange(text, span.start.offset);
        if (range != null && blankedTags.length >= _maxTagRetries) {
          // Each retry parses the whole file again; stop early on hostile
          // input (SPEC.md section 5.2, rule 1).
          final pos = _offsetToPos(text, blankedTags.first);
          return _fail(
            'TP003',
            pos.line,
            pos.column,
            'YAML tags are not supported in tracking plans.',
          );
        }
        if (range != null) {
          blankedTags.add(range.start);
          text = text.replaceRange(
            range.start,
            range.end,
            ' ' * (range.end - range.start),
          );
          continue;
        }
      }
      return _fail(
        'TP001',
        span == null ? 1 : span.start.line + 1,
        span == null ? 1 : span.start.column + 1,
        'Invalid YAML: ${escapeForMessage(e.message)}',
      );
    }
  }

  final feature = _findUnsupportedFeature(root, text, blankedTags);
  if (feature != null) return LoadResult._(null, feature);

  if (root is! YamlMap) {
    return _fail('TP004', 1, 1, 'The tracking plan must be a YAML mapping.');
  }
  return LoadResult._(root, null);
}

String _keyText(String spanText) {
  try {
    final value = loadYaml(spanText);
    if (value is String) return value;
  } on YamlException {
    // Fall back to the source text.
  }
  return spanText;
}

({int start, int end})? _tagRange(String text, int offset) {
  var i = offset;
  if (i < text.length && text.codeUnitAt(i) == 0x26 /* & */ ) {
    while (i < text.length && !_isSpace(text.codeUnitAt(i))) {
      i++;
    }
    while (i < text.length && _isSpace(text.codeUnitAt(i))) {
      i++;
    }
  }
  if (i >= text.length || text.codeUnitAt(i) != 0x21 /* ! */ ) return null;
  final start = i;
  while (i < text.length && !_isSpace(text.codeUnitAt(i))) {
    i++;
  }
  return (start: start, end: i);
}

bool _isSpace(int unit) =>
    unit == 0x20 || unit == 0x09 || unit == 0x0A || unit == 0x0D;

final class _Feature {
  _Feature(this.offset, this.name, this.pos);

  final int offset;
  final String name;
  final Pos pos;
}

Diagnostic? _findUnsupportedFeature(
  YamlNode root,
  String text,
  List<int> blankedTags,
) {
  final features = <_Feature>[];
  // Each blanked tag belongs to the node that starts after it.
  final nodeAfterTag = <int, int>{};
  for (final start in blankedTags) {
    var i = start;
    while (i < text.length && _isSpace(text.codeUnitAt(i))) {
      i++;
    }
    nodeAfterTag[i] = start;
  }

  void inspect(YamlNode node, Pos? owner) {
    final ownerPos = owner ?? (line: 1, column: 1);
    // Read one character: span.text would copy the node's whole subtree.
    final start = node.span.start.offset;
    final first = start < text.length ? text.codeUnitAt(start) : 0;
    if (first == 0x26 /* & */ ) {
      features.add(_Feature(start, 'anchors', ownerPos));
    } else if (first == 0x2A /* * */ ) {
      features.add(_Feature(start, 'aliases', ownerPos));
    } else if (first == 0x21 /* ! */ ) {
      features.add(_Feature(start, 'tags', ownerPos));
    }
    final tagStart = nodeAfterTag[start];
    if (tagStart != null) features.add(_Feature(tagStart, 'tags', ownerPos));
  }

  void walk(YamlNode node, Pos? owner) {
    if (node is YamlMap) {
      for (final entry in node.nodes.entries) {
        final key = entry.key as YamlNode;
        final value = entry.value;
        if (key is YamlMap || key is YamlList) {
          features.add(
            _Feature(
              key.span.start.offset,
              'complex keys',
              owner ?? (line: 1, column: 1),
            ),
          );
          continue;
        }
        if (key is YamlScalar &&
            key.style == ScalarStyle.PLAIN &&
            key.value == '<<') {
          features.add(
            _Feature(
              key.span.start.offset,
              'merge keys',
              owner ?? (line: 1, column: 1),
            ),
          );
        }
        inspect(key, owner);
        final keyPos = posOf(key);
        // An alias reuses its anchor's span, which lies before the key. Its
        // anchor always comes earlier in the document, so in practice the
        // "anchors" message wins; this branch still stops the alias from
        // being inspected as if it were at the anchor's position.
        if (value.span.start.offset < key.span.start.offset) {
          features.add(_Feature(key.span.end.offset, 'aliases', keyPos));
          continue;
        }
        inspect(value, keyPos);
        walk(value, keyPos);
      }
    } else if (node is YamlList) {
      for (final item in node.nodes) {
        if (item.span.start.offset < node.span.start.offset) {
          features.add(
            _Feature(
              node.span.start.offset,
              'aliases',
              owner ?? (line: 1, column: 1),
            ),
          );
          continue;
        }
        inspect(item, owner);
        walk(item, owner);
      }
    }
  }

  inspect(root, null);
  walk(root, null);
  if (features.isEmpty) return null;
  features.sort((a, b) => a.offset.compareTo(b.offset));
  final first = features.first;
  return Diagnostic(
    'TP003',
    Severity.error,
    first.pos.line,
    first.pos.column,
    'YAML ${first.name} are not supported in tracking plans.',
  );
}

/// The YAML 1.2 core schema type of a scalar, decided from its source text
/// (SPEC.md section 2.2.1).
enum ScalarKind {
  /// Empty, `~` or `null`.
  nullValue('null'),

  /// `true` or `false`.
  boolean('a boolean'),

  /// Decimal, octal or hex integer.
  integer('an integer'),

  /// Float, infinity or NaN.
  number('a number'),

  /// Anything else, including all quoted and block scalars.
  string('a string');

  const ScalarKind(this.word);

  /// The type word used in messages.
  final String word;
}

final _nullPattern = RegExp(r'^(|~|null|Null|NULL)$');
final _boolPattern = RegExp(r'^(true|True|TRUE|false|False|FALSE)$');
final _intPattern = RegExp(r'^([-+]?[0-9]+|0o[0-7]+|0x[0-9a-fA-F]+)$');
final _floatPattern = RegExp(
  r'^([-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?|[-+]?\.(inf|Inf|INF)|\.(nan|NaN|NAN))$',
);

/// Classifies [scalar] by its source text.
ScalarKind scalarKind(YamlScalar scalar) {
  if (scalar.style != ScalarStyle.PLAIN) return ScalarKind.string;
  final text = scalar.span.text;
  if (_nullPattern.hasMatch(text)) return ScalarKind.nullValue;
  if (_boolPattern.hasMatch(text)) return ScalarKind.boolean;
  if (_intPattern.hasMatch(text)) return ScalarKind.integer;
  if (_floatPattern.hasMatch(text)) return ScalarKind.number;
  return ScalarKind.string;
}

/// The string value of a scalar that [scalarKind] classified as a string.
String scalarString(YamlScalar scalar) {
  final value = scalar.value;
  return value is String ? value : scalar.span.text;
}

/// Whether [text] is empty or only spaces, tabs and line breaks.
bool isBlank(String text) {
  for (final unit in text.codeUnits) {
    if (!_isSpace(unit)) return false;
  }
  return true;
}

/// The type word for [node] in messages (SPEC.md section 6.1).
String typeWord(YamlNode node) {
  if (node is YamlMap) return 'a mapping';
  if (node is YamlList) return 'a list';
  final scalar = node as YamlScalar;
  final kind = scalarKind(scalar);
  if (kind == ScalarKind.string && isBlank(scalarString(scalar))) {
    return 'an empty string';
  }
  return kind.word;
}

/// Whether [node] is null (an empty value, `~` or `null`).
bool isNullScalar(YamlNode node) =>
    node is YamlScalar && scalarKind(node) == ScalarKind.nullValue;

/// Whether diagnostics about [node] can point at the node itself rather than
/// its key (SPEC.md section 5.1).
bool hasOwnPosition(YamlNode node) =>
    node is YamlScalar &&
    !isNullScalar(node) &&
    (node.style == ScalarStyle.PLAIN ||
        node.style == ScalarStyle.SINGLE_QUOTED ||
        node.style == ScalarStyle.DOUBLE_QUOTED) &&
    !node.span.text.contains('\n');
