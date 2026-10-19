import 'package:yaml/yaml.dart';

import 'diagnostic.dart';
import 'model.dart';
import 'names.dart';
import 'source.dart';

/// Default output path of the Dart target.
const defaultDartOutput = 'lib/analytics/analytics.g.dart';

/// Default output path of the TypeScript target.
const defaultTypescriptOutput = 'src/analytics/analytics.ts';

/// Default generated class name.
const defaultClassName = 'Analytics';

/// The result of validating a plan.
final class ValidationResult {
  /// Creates a result.
  const ValidationResult(this.diagnostics, this.plan);

  /// Diagnostics sorted as in SPEC.md section 5.3.
  final List<Diagnostic> diagnostics;

  /// The validated plan, or `null` when there are errors.
  final TrackingPlan? plan;

  /// Whether any diagnostic is an error.
  bool get hasErrors => diagnostics.any((d) => d.isError);
}

/// Validates the plan in [bytes] (SPEC.md sections 2 to 6).
///
/// When [allowOutside] is true, absolute output paths and `..` segments are
/// accepted.
///
/// Throws [StackOverflowError] for plans nested so deeply that the YAML
/// parser runs out of stack; the CLI reports this as a tool failure.
ValidationResult validatePlan(List<int> bytes, {bool allowOutside = false}) {
  final loaded = loadPlan(bytes);
  final fatal = loaded.fatal;
  if (fatal != null) return ValidationResult([fatal], null);
  return _Validator(allowOutside).run(loaded.root!);
}

/// Returns why [path] is not an acceptable output path, or `null` if it is.
///
/// Checks the text only; see SPEC.md section 2.4.
String? outputPathProblem(String path, {required bool allowOutside}) {
  if (path.isEmpty) return 'empty';
  final drive = RegExp(r'^[A-Za-z]:').hasMatch(path);
  // ':' elsewhere could address an NTFS alternate data stream.
  if ((drive ? path.substring(2) : path).contains(':')) return 'colon';
  final segments = path.split(RegExp(r'[/\\]'));
  if (segments.any(_isGitSegment)) return '.git';
  if (allowOutside) return null;
  if (path.startsWith('/') || path.startsWith(r'\') || drive) {
    return 'absolute';
  }
  if (segments.contains('..')) return '..';
  return null;
}

// Windows ignores trailing dots and spaces and accepts the 8.3 name GIT~1.
bool _isGitSegment(String segment) {
  var end = segment.length;
  while (end > 0 &&
      (segment.codeUnitAt(end - 1) == 0x2E ||
          segment.codeUnitAt(end - 1) == 0x20)) {
    end--;
  }
  final name = segment.substring(0, end).toLowerCase();
  return name == '.git' || RegExp(r'^git~[0-9]+$').hasMatch(name);
}

// Zero-width characters that some file systems ignore, so `.g\u{200C}it`
// could act as `.git`.
bool _isInvisible(int unit) =>
    (unit >= 0x200B && unit <= 0x200D) || unit == 0x2060;

typedef _Entry = ({String key, YamlNode keyNode, YamlNode value});

const _rootKeys = ['version', 'meta', 'targets', 'settings', 'enums', 'events'];
const _metaKeys = ['name', 'description'];
const _targetsKeys = ['dart', 'typescript'];
const _dartKeys = ['output', 'class_name'];
const _typescriptKeys = ['output', 'class_name', 'runtime_checks'];
const _settingsKeys = ['warn_provider_limits'];
const _enumKeys = ['description', 'values'];
const _eventKeys = ['description', 'owner', 'tags', 'deprecated', 'params'];
const _paramKeys = [
  'type',
  'description',
  'required',
  'min',
  'max',
  'max_length',
  'enum',
];

const _typeAliases = {
  'float': 'double',
  'number': 'double',
  'decimal': 'double',
  'integer': 'int',
  'long': 'int',
  'boolean': 'bool',
  'str': 'string',
  'text': 'string',
  'list': 'list<string>',
  'array': 'list<string>',
  'string[]': 'list<string>',
  'list<String>': 'list<string>',
  'List<String>': 'list<string>',
};

const _allowedOptions = {
  ParamType.string: {'max_length'},
  ParamType.int_: {'min', 'max'},
  ParamType.double_: {'min', 'max'},
  ParamType.bool_: <String>{},
  ParamType.enum_: {'enum'},
  ParamType.stringList: <String>{},
};

// Firebase Analytics limits, from the official documentation (checked
// 2026-10-19):
// https://firebase.google.com/docs/reference/android/com/google/firebase/analytics/FirebaseAnalytics#logEvent(java.lang.String,android.os.Bundle)
// https://firebase.google.com/docs/reference/android/com/google/firebase/analytics/FirebaseAnalytics.Event
// https://support.google.com/analytics/answer/9267744
const _firebaseMaxNameLength = 40;
const _firebaseMaxParams = 25;
const _firebaseMaxStringLength = 100;
const _firebaseMaxEvents = 500;
const _firebaseReservedPrefixes = ['firebase_', 'google_', 'ga_'];
const _firebaseReservedEvents = {
  'ad_activeview', 'ad_click', 'ad_exposure', 'ad_query', 'ad_reward', //
  'adunit_exposure', 'app_background', 'app_clear_data', 'app_exception',
  'app_remove', 'app_store_refund', 'app_store_subscription_cancel',
  'app_store_subscription_convert', 'app_store_subscription_renew',
  'app_update', 'app_upgrade', 'dynamic_link_app_open',
  'dynamic_link_app_update', 'dynamic_link_first_open', 'error', 'first_open',
  'first_visit', 'notification_dismiss', 'notification_foreground',
  'notification_open', 'notification_receive', 'os_update', 'session_start',
  'session_start_with_rollout', 'user_engagement',
};

final _decimalPattern = RegExp(r'^-?(0|[1-9][0-9]*)(\.[0-9]+)?$');
final _classNamePattern = RegExp(r'^[A-Z][A-Za-z0-9]*$');
final _maxSafeInteger = BigInt.from(9007199254740991);

String _q(String text) => '"${escapeForMessage(text)}"';

final class _Validator {
  _Validator(this.allowOutside);

  final bool allowOutside;
  final _diagnostics = <Diagnostic>[];

  String dartClassName = defaultClassName;
  String typescriptClassName = defaultClassName;

  // Class names the enum type names are compared with (TP022); an invalid
  // class_name is not compared with anything.
  String? dartClassForCheck = defaultClassName;
  String? typescriptClassForCheck = defaultClassName;
  String dartOutput = defaultDartOutput;
  String typescriptOutput = defaultTypescriptOutput;
  bool runtimeChecks = false;
  bool firebase = false;
  String? metaName;
  String? metaDescription;

  final _definedEnums = <String>{};
  List<String>? _sortedEnumNames;
  final _usedEnums = <String>{};
  final _enumKeyPos = <String, Pos>{};
  final _enumDefs = <String, EnumDef>{};
  final _events = <EventDef>[];

  void _error(String code, Pos pos, String message) => _diagnostics.add(
    Diagnostic(code, Severity.error, pos.line, pos.column, message),
  );

  void _warning(String code, Pos pos, String message) => _diagnostics.add(
    Diagnostic(code, Severity.warning, pos.line, pos.column, message),
  );

  ValidationResult run(YamlMap root) {
    final known = _known(_entries(root), _rootKeys, 'the plan');
    const rootPos = (line: 1, column: 1);

    final version = known['version'];
    if (version == null) {
      _error('TP010', rootPos, 'Missing required key "version" in the plan.');
    } else {
      _checkVersion(version);
    }

    final meta = known['meta'];
    if (meta != null) _checkMeta(meta);
    final targets = known['targets'];
    if (targets != null) _checkTargets(targets);
    final settings = known['settings'];
    if (settings != null) _checkSettings(settings);
    final enums = known['enums'];
    if (enums != null) _checkEnums(enums);

    final events = known['events'];
    if (events == null) {
      _error('TP010', rootPos, 'Missing required key "events" in the plan.');
    } else {
      _checkEvents(events);
    }

    final hasErrors = _diagnostics.any((d) => d.isError);
    if (!hasErrors) {
      for (final name in _definedEnums) {
        if (!_usedEnums.contains(name)) {
          _warning(
            'TP101',
            _enumKeyPos[name]!,
            'Enum ${_q(name)} is not used by any param.',
          );
        }
      }
    }

    final diagnostics = sortDiagnostics(_diagnostics);
    if (hasErrors) return ValidationResult(diagnostics, null);

    final enumList = _enumDefs.values.toList()
      ..sort((a, b) => a.name.compareTo(b.name));
    _events.sort((a, b) => a.name.compareTo(b.name));
    return ValidationResult(
      diagnostics,
      TrackingPlan(
        name: metaName,
        description: metaDescription,
        dartClassName: dartClassName,
        dartOutput: dartOutput,
        typescriptClassName: typescriptClassName,
        typescriptOutput: typescriptOutput,
        typescriptRuntimeChecks: runtimeChecks,
        enums: List.unmodifiable(enumList),
        events: List.unmodifiable(_events),
      ),
    );
  }

  // ---------------------------------------------------------------- helpers

  List<_Entry> _entries(YamlMap map) {
    final entries = <_Entry>[];
    for (final MapEntry(:key, :value) in map.nodes.entries) {
      final keyNode = key as YamlScalar;
      if (scalarKind(keyNode) != ScalarKind.string) {
        _error(
          'TP012',
          posOf(keyNode),
          'Keys must be strings, got ${typeWord(keyNode)}. Quote the key.',
        );
        continue;
      }
      entries.add((key: scalarString(keyNode), keyNode: keyNode, value: value));
    }
    return entries;
  }

  Map<String, _Entry> _known(
    List<_Entry> entries,
    List<String> allowed,
    String context,
  ) {
    final known = <String, _Entry>{};
    for (final entry in entries) {
      if (allowed.contains(entry.key)) {
        known[entry.key] = entry;
        continue;
      }
      final suggestion = suggest(entry.key, allowed);
      _error(
        'TP011',
        posOf(entry.keyNode),
        'Unknown key ${_q(entry.key)} in $context.'
            '${suggestion == null ? '' : ' Did you mean "$suggestion"?'}',
      );
    }
    return known;
  }

  Pos _valuePos(_Entry entry) =>
      hasOwnPosition(entry.value) ? posOf(entry.value) : posOf(entry.keyNode);

  Pos _itemPos(YamlNode item, _Entry list) =>
      hasOwnPosition(item) ? posOf(item) : posOf(list.keyNode);

  void _typeError(String expected, _Entry entry) => _error(
    'TP012',
    _valuePos(entry),
    'Expected $expected for ${_q(entry.key)}, got ${typeWord(entry.value)}.',
  );

  /// Entries of a mapping value, or `null` after reporting a type error.
  List<_Entry>? _mapping(_Entry entry, {bool nullAsEmpty = false}) {
    final value = entry.value;
    if (value is YamlMap) return _entries(value);
    if (nullAsEmpty && isNullScalar(value)) return const [];
    _typeError('a mapping', entry);
    return null;
  }

  String? _string(_Entry entry) {
    final value = entry.value;
    if (value is YamlScalar && scalarKind(value) == ScalarKind.string) {
      return scalarString(value);
    }
    _typeError('a string', entry);
    return null;
  }

  bool? _bool(_Entry entry) {
    final value = entry.value;
    if (value is YamlScalar && scalarKind(value) == ScalarKind.boolean) {
      return value.value as bool;
    }
    _typeError('a boolean', entry);
    return null;
  }

  YamlList? _list(_Entry entry) {
    final value = entry.value;
    if (value is YamlList) return value;
    _typeError('a list', entry);
    return null;
  }

  /// Checks a free-text value (SPEC.md section 2.9).
  String? _freeText(_Entry entry, {bool nonEmpty = false}) {
    final value = entry.value;
    if (value is! YamlScalar || scalarKind(value) != ScalarKind.string) {
      _typeError(nonEmpty ? 'a non-empty string' : 'a string', entry);
      return null;
    }
    final text = scalarString(value);
    if (nonEmpty && isBlank(text)) {
      _typeError('a non-empty string', entry);
      return null;
    }
    if (!_checkTextCharacters(text, entry.key, _valuePos(entry))) return null;
    return text;
  }

  bool _checkTextCharacters(String text, String key, Pos pos) {
    for (final unit in text.codeUnits) {
      if (isDisallowedCharacter(unit)) {
        _error(
          'TP024',
          pos,
          '${_q(key)} contains the disallowed character ${unicodeName(unit)}.',
        );
        return false;
      }
    }
    return true;
  }

  /// Checks a name; returns whether it is valid (SPEC.md section 4.1).
  bool _checkName(String name, Pos pos, String kind) {
    if (!matchesNamePattern(name)) {
      _error(
        'TP020',
        pos,
        'Invalid $kind name ${_q(name)}: use lowercase snake_case starting '
            'with a letter.',
      );
      return false;
    }
    if (name.length > maxNameLength) {
      _error(
        'TP020',
        pos,
        'Invalid $kind name ${_q(name)}: longer than $maxNameLength characters.',
      );
      return false;
    }
    return true;
  }

  /// Reports TP021 if [identifier] was already produced by another name.
  void _checkCollision(
    Map<String, ({String name, int line})> seen,
    String identifier,
    String name,
    Pos pos,
    String kind,
  ) {
    final earlier = seen[identifier];
    if (earlier == null) {
      seen[identifier] = (name: name, line: pos.line);
      return;
    }
    _error(
      'TP021',
      pos,
      '$kind ${_q(name)} generates the same identifier "$identifier" as '
          '${_q(earlier.name)} (line ${earlier.line}).',
    );
  }

  /// Checks a number (SPEC.md section 2.8) and returns its source text.
  String? _number(
    _Entry entry, {
    required String expected,
    required bool integerOnly,
    bool atLeastOne = false,
  }) {
    final value = entry.value;
    if (value is! YamlScalar ||
        (scalarKind(value) != ScalarKind.integer &&
            scalarKind(value) != ScalarKind.number)) {
      _typeError(expected, entry);
      return null;
    }
    final text = value.span.text;
    String? reason;
    if (!_decimalPattern.hasMatch(text)) {
      reason = 'expected a decimal number';
    } else if (integerOnly && text.contains('.')) {
      reason = 'expected an integer';
    } else if (atLeastOne && BigInt.parse(text) < BigInt.one) {
      reason = 'expected an integer of at least 1';
    } else if (!text.contains('.') &&
        BigInt.parse(text).abs() > _maxSafeInteger) {
      reason = 'out of range';
    }
    if (reason != null) {
      _error(
        'TP037',
        _valuePos(entry),
        'Invalid number ${escapeForMessage(text)} for ${_q(entry.key)}: '
            '$reason.',
      );
      return null;
    }
    return text;
  }

  // ------------------------------------------------------------------ root

  void _checkVersion(_Entry entry) {
    final value = entry.value;
    if (value is! YamlScalar ||
        (scalarKind(value) != ScalarKind.integer &&
            scalarKind(value) != ScalarKind.number)) {
      _typeError('an integer', entry);
      return;
    }
    final text = value.span.text;
    if (text != '1') {
      _error(
        'TP013',
        _valuePos(entry),
        'Unsupported version ${escapeForMessage(text)}. '
            'The only supported version is 1.',
      );
    }
  }

  void _checkMeta(_Entry entry) {
    final entries = _mapping(entry, nullAsEmpty: true);
    if (entries == null) return;
    final known = _known(entries, _metaKeys, 'meta');
    final name = known['name'];
    if (name != null) metaName = _blankToNull(_freeText(name));
    final description = known['description'];
    if (description != null) {
      metaDescription = _blankToNull(_freeText(description));
    }
  }

  void _checkTargets(_Entry entry) {
    final entries = _mapping(entry, nullAsEmpty: true);
    if (entries == null) return;
    final known = _known(entries, _targetsKeys, 'targets');

    final dart = known['dart'];
    if (dart != null) {
      final dartEntries = _mapping(dart, nullAsEmpty: true);
      if (dartEntries != null) {
        final k = _known(dartEntries, _dartKeys, 'targets.dart');
        final output = k['output'];
        if (output != null) {
          dartOutput = _checkOutput(output, const ['.dart'], '.dart') ?? '';
        }
        final className = k['class_name'];
        if (className != null) {
          dartClassForCheck = _checkClassName(className);
          dartClassName = dartClassForCheck ?? defaultClassName;
        }
      }
    }

    final ts = known['typescript'];
    if (ts != null) {
      final tsEntries = _mapping(ts, nullAsEmpty: true);
      if (tsEntries != null) {
        final k = _known(tsEntries, _typescriptKeys, 'targets.typescript');
        final output = k['output'];
        if (output != null) {
          typescriptOutput =
              _checkOutput(output, const [
                '.ts',
                '.mts',
                '.cts',
              ], '.ts, .mts or .cts') ??
              '';
        }
        final className = k['class_name'];
        if (className != null) {
          typescriptClassForCheck = _checkClassName(className);
          typescriptClassName = typescriptClassForCheck ?? defaultClassName;
        }
        final checks = k['runtime_checks'];
        if (checks != null) runtimeChecks = _bool(checks) ?? false;
      }
    }
  }

  String? _checkOutput(_Entry entry, List<String> extensions, String names) {
    final path = _string(entry);
    if (path == null) return null;
    for (final unit in path.codeUnits) {
      if (unit == 0x09 ||
          unit == 0x0A ||
          isDisallowedCharacter(unit) ||
          _isInvisible(unit)) {
        _error(
          'TP024',
          _valuePos(entry),
          '${_q(entry.key)} contains the disallowed character '
              '${unicodeName(unit)}.',
        );
        return null;
      }
    }
    var ok = true;
    if (outputPathProblem(path, allowOutside: allowOutside) != null) {
      _error(
        'TP050',
        _valuePos(entry),
        'Output path ${_q(path)} must be relative and stay inside the '
            'project.',
      );
      ok = false;
    }
    if (!extensions.any(path.endsWith)) {
      _error(
        'TP052',
        _valuePos(entry),
        'Output path ${_q(path)} must end with $names.',
      );
      ok = false;
    }
    return ok ? path : null;
  }

  String? _checkClassName(_Entry entry) {
    final name = _string(entry);
    if (name == null) return null;
    if (!_classNamePattern.hasMatch(name)) {
      _error(
        'TP023',
        _valuePos(entry),
        'Invalid class name ${_q(name)}: use PascalCase starting with A-Z.',
      );
      return null;
    }
    if (reservedTypeNames.contains(name)) {
      _error('TP023', _valuePos(entry), 'Class name ${_q(name)} is reserved.');
      return null;
    }
    return name;
  }

  void _checkSettings(_Entry entry) {
    final entries = _mapping(entry, nullAsEmpty: true);
    if (entries == null) return;
    final known = _known(entries, _settingsKeys, 'settings');
    final providers = known['warn_provider_limits'];
    if (providers == null) return;
    final list = _list(providers);
    if (list == null) return;
    for (final item in list.nodes) {
      if (item is! YamlScalar || scalarKind(item) != ScalarKind.string) {
        _error(
          'TP012',
          _itemPos(item, providers),
          'Expected a string for ${_q(providers.key)}, got ${typeWord(item)}.',
        );
        continue;
      }
      final provider = scalarString(item);
      if (provider == 'firebase') {
        firebase = true;
      } else {
        _error(
          'TP051',
          _itemPos(item, providers),
          'Unknown provider ${_q(provider)}. Supported providers: firebase.',
        );
      }
    }
  }

  // ----------------------------------------------------------------- enums

  void _checkEnums(_Entry entry) {
    final entries = _mapping(entry, nullAsEmpty: true);
    if (entries == null) return;
    final typeNames = <String, ({String name, int line})>{};
    for (final e in entries) {
      final keyPos = posOf(e.keyNode);
      _definedEnums.add(e.key);
      _enumKeyPos[e.key] = keyPos;
      final validName = _checkName(e.key, keyPos, 'enum');
      String? typeName;
      if (validName) {
        typeName = pascalCase(e.key);
        _checkCollision(typeNames, typeName, e.key, keyPos, 'Enum');
        if (reservedTypeNames.contains(typeName) ||
            typeName == dartClassForCheck ||
            typeName == typescriptClassForCheck) {
          _error(
            'TP022',
            keyPos,
            'Enum ${_q(e.key)} generates the type name "$typeName", which is '
                'reserved.',
          );
        }
      }

      final body = _mapping(e);
      if (body == null) continue;
      final known = _known(body, _enumKeys, 'enum ${_q(e.key)}');
      final description = known['description'];
      final descriptionText = description == null
          ? null
          : _freeText(description);
      final valuesEntry = known['values'];
      if (valuesEntry == null) {
        _error(
          'TP010',
          keyPos,
          'Missing required key "values" in enum ${_q(e.key)}.',
        );
        continue;
      }
      final values = _checkEnumValues(e.key, valuesEntry);
      if (values != null && typeName != null) {
        _enumDefs[e.key] = EnumDef(
          name: e.key,
          typeName: typeName,
          description: _blankToNull(descriptionText),
          values: List.unmodifiable(values),
        );
      }
    }
  }

  List<EnumValueDef>? _checkEnumValues(String enumName, _Entry entry) {
    final list = _list(entry);
    if (list == null) return null;
    if (list.nodes.isEmpty) {
      _error(
        'TP034',
        posOf(entry.keyNode),
        'Enum ${_q(enumName)} has no values.',
      );
      return null;
    }
    final values = <EnumValueDef>[];
    final seen = <String>{};
    final identifiers = <String, ({String name, int line})>{};
    var ok = true;
    for (final item in list.nodes) {
      final pos = _itemPos(item, entry);
      if (item is! YamlScalar || scalarKind(item) != ScalarKind.string) {
        _error(
          'TP012',
          pos,
          'Expected a string for ${_q(entry.key)}, got ${typeWord(item)}.',
        );
        ok = false;
        continue;
      }
      final value = scalarString(item);
      final validName = _checkName(value, pos, 'enum value');
      if (!seen.add(value)) {
        _error(
          'TP035',
          pos,
          'Duplicate value ${_q(value)} in enum ${_q(enumName)}.',
        );
        ok = false;
        continue;
      }
      if (!validName) {
        ok = false;
        continue;
      }
      final identifier = identifierFor(value, IdentifierKind.enumValue);
      final before = _diagnostics.length;
      _checkCollision(identifiers, identifier, value, pos, 'Enum value');
      if (_diagnostics.length != before) ok = false;
      values.add(EnumValueDef(value, identifier));
    }
    return ok ? values : null;
  }

  // ---------------------------------------------------------------- events

  void _checkEvents(_Entry entry) {
    final entries = _mapping(entry, nullAsEmpty: true);
    if (entries == null) return;
    final count = _rawLength(entry.value);
    if (count == 0) {
      _error(
        'TP014',
        posOf(entry.keyNode),
        '"events" must contain at least one event.',
      );
      return;
    }
    if (firebase && count > _firebaseMaxEvents) {
      _warning(
        'TP118',
        posOf(entry.keyNode),
        'Firebase: the plan has $count events; the limit is '
            '$_firebaseMaxEvents distinct events per app.',
      );
    }
    final identifiers = <String, ({String name, int line})>{};
    for (final e in entries) {
      final keyPos = posOf(e.keyNode);
      final validName = _checkName(e.key, keyPos, 'event');
      String? identifier;
      if (validName) {
        identifier = identifierFor(e.key, IdentifierKind.method);
        _checkCollision(identifiers, identifier, e.key, keyPos, 'Event');
        if (firebase) _checkFirebaseEventName(e.key, keyPos);
      }
      final event = _checkEvent(e, validName);
      if (event != null && identifier != null) {
        _events.add(
          EventDef(
            name: e.key,
            identifier: identifier,
            description: event.description,
            owner: event.owner,
            tags: event.tags,
            deprecated: event.deprecated,
            params: event.params,
          ),
        );
      }
    }
  }

  void _checkFirebaseEventName(String name, Pos pos) {
    if (name.length > _firebaseMaxNameLength) {
      _warning(
        'TP110',
        pos,
        'Firebase: event name ${_q(name)} is longer than '
            '$_firebaseMaxNameLength characters.',
      );
    }
    for (final prefix in _firebaseReservedPrefixes) {
      if (name.startsWith(prefix)) {
        _warning(
          'TP111',
          pos,
          'Firebase: event name ${_q(name)} uses the reserved prefix '
              '"$prefix".',
        );
      }
    }
    if (_firebaseReservedEvents.contains(name)) {
      _warning(
        'TP112',
        pos,
        'Firebase: event name ${_q(name)} is reserved and will be dropped.',
      );
    }
  }

  ({
    String? description,
    String? owner,
    List<String> tags,
    String? deprecated,
    List<ParamDef> params,
  })?
  _checkEvent(_Entry e, bool validName) {
    final body = _mapping(e, nullAsEmpty: true);
    if (body == null) return null;
    final context = 'event ${_q(e.key)}';
    final known = _known(body, _eventKeys, context);
    var ok = true;

    String? description;
    final descriptionEntry = known['description'];
    if (descriptionEntry != null) {
      final text = _freeText(descriptionEntry);
      if (text == null) {
        ok = false;
      } else {
        description = _blankToNull(text);
      }
    }
    if (description == null && (descriptionEntry == null || ok)) {
      _warning(
        'TP100',
        posOf(e.keyNode),
        'Event ${_q(e.key)} has no description.',
      );
    }

    String? owner;
    final ownerEntry = known['owner'];
    if (ownerEntry != null) {
      final text = _freeText(ownerEntry);
      if (text == null) ok = false;
      owner = _blankToNull(text);
    }

    final tags = <String>[];
    final tagsEntry = known['tags'];
    if (tagsEntry != null) {
      final list = _list(tagsEntry);
      if (list == null) {
        ok = false;
      } else {
        for (final item in list.nodes) {
          final pos = _itemPos(item, tagsEntry);
          if (item is! YamlScalar || scalarKind(item) != ScalarKind.string) {
            _error(
              'TP012',
              pos,
              'Expected a string for ${_q(tagsEntry.key)}, got '
                  '${typeWord(item)}.',
            );
            ok = false;
            continue;
          }
          final tag = scalarString(item);
          if (isBlank(tag)) {
            _error(
              'TP012',
              pos,
              'Expected a non-empty string for ${_q(tagsEntry.key)}, got an '
                  'empty string.',
            );
            ok = false;
            continue;
          }
          if (_checkTextCharacters(tag, tagsEntry.key, pos)) {
            tags.add(tag);
          } else {
            ok = false;
          }
        }
      }
    }

    String? deprecated;
    final deprecatedEntry = known['deprecated'];
    if (deprecatedEntry != null) {
      deprecated = _freeText(deprecatedEntry, nonEmpty: true);
      if (deprecated == null) ok = false;
    }

    final params = <ParamDef>[];
    final paramsEntry = known['params'];
    if (paramsEntry != null) {
      final checked = _checkParams(e.key, paramsEntry, validName);
      if (checked == null) {
        ok = false;
      } else {
        params.addAll(checked);
      }
    }

    if (!ok) return null;
    return (
      description: description,
      owner: owner,
      tags: List.unmodifiable(tags),
      deprecated: deprecated,
      params: List.unmodifiable(params),
    );
  }

  List<ParamDef>? _checkParams(
    String eventName,
    _Entry entry,
    bool validEventName,
  ) {
    final entries = _mapping(entry, nullAsEmpty: true);
    if (entries == null) return null;
    final count = _rawLength(entry.value);
    if (firebase && validEventName && count > _firebaseMaxParams) {
      _warning(
        'TP113',
        posOf(entry.keyNode),
        'Firebase: event ${_q(eventName)} has $count params; the '
            'limit is $_firebaseMaxParams.',
      );
    }
    final identifiers = <String, ({String name, int line})>{};
    final params = <ParamDef>[];
    var ok = true;
    for (final p in entries) {
      final keyPos = posOf(p.keyNode);
      final validName = _checkName(p.key, keyPos, 'param');
      String? identifier;
      if (validName) {
        identifier = identifierFor(p.key, IdentifierKind.param);
        final before = _diagnostics.length;
        _checkCollision(identifiers, identifier, p.key, keyPos, 'Param');
        if (_diagnostics.length != before) ok = false;
        if (firebase) _checkFirebaseParamName(p.key, keyPos);
      } else {
        ok = false;
      }
      final param = _checkParam(eventName, p, identifier ?? '');
      if (param == null) {
        ok = false;
      } else {
        params.add(param);
      }
    }
    return ok ? params : null;
  }

  void _checkFirebaseParamName(String name, Pos pos) {
    if (name.length > _firebaseMaxNameLength) {
      _warning(
        'TP114',
        pos,
        'Firebase: param name ${_q(name)} is longer than '
            '$_firebaseMaxNameLength characters.',
      );
    }
    for (final prefix in _firebaseReservedPrefixes) {
      if (name.startsWith(prefix)) {
        _warning(
          'TP115',
          pos,
          'Firebase: param name ${_q(name)} uses the reserved prefix '
              '"$prefix".',
        );
      }
    }
  }

  ParamDef? _checkParam(String eventName, _Entry p, String identifier) {
    final body = _mapping(p);
    if (body == null) return null;
    final context = 'param ${_q(p.key)} of event ${_q(eventName)}';
    final known = _known(body, _paramKeys, context);
    var ok = true;

    String? description;
    final descriptionEntry = known['description'];
    if (descriptionEntry != null) {
      final text = _freeText(descriptionEntry);
      if (text == null) ok = false;
      description = _blankToNull(text);
    }

    var required = true;
    final requiredEntry = known['required'];
    if (requiredEntry != null) {
      final value = _bool(requiredEntry);
      if (value == null) ok = false;
      required = value ?? true;
    }

    final typeEntry = known['type'];
    if (typeEntry == null) {
      _error(
        'TP010',
        posOf(p.keyNode),
        'Missing required key "type" in $context.',
      );
      return null;
    }
    final typeName = _string(typeEntry);
    if (typeName == null) return null;
    final type = ParamType.fromPlanName(typeName);
    if (type == null) {
      final suggestion =
          _typeAliases[typeName] ??
          suggest(typeName, ParamType.values.map((t) => t.planName));
      _error(
        'TP030',
        _valuePos(typeEntry),
        'Unknown type ${_q(typeName)}.'
            '${suggestion == null ? ' Supported types: string, int, double, bool, enum, list<string>.' : ' Did you mean "$suggestion"?'}',
      );
      return null;
    }

    for (final option in const ['min', 'max', 'max_length', 'enum']) {
      final optionEntry = known[option];
      if (optionEntry != null && !_allowedOptions[type]!.contains(option)) {
        _error(
          'TP033',
          posOf(optionEntry.keyNode),
          'Option "$option" is not allowed for type ${type.planName}.',
        );
        ok = false;
      }
    }

    EnumDef? enumDef;
    if (type == ParamType.enum_) {
      final enumEntry = known['enum'];
      if (enumEntry == null) {
        _error(
          'TP031',
          _valuePos(typeEntry),
          'Param ${_q(p.key)} has type enum but no "enum" key.',
        );
        ok = false;
      } else {
        final name = _string(enumEntry);
        if (name == null) {
          ok = false;
        } else if (!_definedEnums.contains(name)) {
          final suggestion = suggest(
            name,
            _sortedEnumNames ??= _definedEnums.toList()..sort(),
          );
          _error(
            'TP032',
            _valuePos(enumEntry),
            'Unknown enum ${_q(name)}.'
                '${suggestion == null ? '' : ' Did you mean ${_q(suggestion)}?'}',
          );
          ok = false;
        } else {
          _usedEnums.add(name);
          enumDef = _enumDefs[name];
        }
      }
    }

    String? min;
    String? max;
    if (type == ParamType.int_ || type == ParamType.double_) {
      final integerOnly = type == ParamType.int_;
      final minEntry = known['min'];
      final maxEntry = known['max'];
      if (minEntry != null) {
        min = _number(minEntry, expected: 'a number', integerOnly: integerOnly);
        if (min == null) ok = false;
      }
      if (maxEntry != null) {
        max = _number(maxEntry, expected: 'a number', integerOnly: integerOnly);
        if (max == null) ok = false;
      }
      if (min != null && max != null && double.parse(min) > double.parse(max)) {
        _error(
          'TP036',
          _valuePos(minEntry!),
          '"min" ($min) is greater than "max" ($max).',
        );
        ok = false;
      }
    }

    int? maxLength;
    final maxLengthEntry = known['max_length'];
    if (type == ParamType.string && maxLengthEntry != null) {
      final text = _number(
        maxLengthEntry,
        expected: 'an integer',
        integerOnly: true,
        atLeastOne: true,
      );
      if (text == null) {
        ok = false;
      } else {
        maxLength = int.parse(text);
        if (firebase &&
            identifier.isNotEmpty &&
            maxLength > _firebaseMaxStringLength) {
          _warning(
            'TP116',
            _valuePos(maxLengthEntry),
            'Firebase: string values are limited to $_firebaseMaxStringLength '
                'characters, but "max_length" is $maxLength.',
          );
        }
      }
    }

    if (firebase &&
        identifier.isNotEmpty &&
        (type == ParamType.bool_ || type == ParamType.stringList)) {
      _warning(
        'TP117',
        _valuePos(typeEntry),
        'Firebase: type ${type.planName} is not supported for event params; '
            'the adapter must convert it.',
      );
    }

    if (!ok || identifier.isEmpty) return null;
    return ParamDef(
      name: p.key,
      identifier: identifier,
      type: type,
      description: description,
      required: required,
      min: min,
      max: max,
      maxLength: maxLength,
      enumDef: enumDef,
    );
  }

  /// Number of entries in a mapping, including entries whose keys are not
  /// strings (SPEC.md section 5.2, rule 8).
  static int _rawLength(YamlNode node) => node is YamlMap ? node.length : 0;

  static String? _blankToNull(String? text) =>
      text == null || isBlank(text) ? null : text;
}
