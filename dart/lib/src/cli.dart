import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:args/args.dart';
import 'package:path/path.dart' as p;

import 'dart_generator.dart';
import 'diagnostic.dart';
import 'docs_generator.dart';
import 'sample_plan.dart';
import 'validator.dart';
import 'version.dart';

/// Exit code: success.
const exitOk = 0;

/// Exit code: the plan has errors, or `check` found an outdated file.
const exitInvalid = 1;

/// Exit code: the tool itself failed (usage, IO).
const exitToolFailure = 2;

const _defaultPlan = 'tracking_plan.yaml';
const _defaultDocs = 'TRACKING_PLAN.md';

/// Largest plan file the CLI reads (SPEC.md section 9).
const maxPlanBytes = 1024 * 1024;

// Escapes text that comes from arguments or the plan before printing it.
String _e(String text) => escapeForMessage(text);

const _commands = {
  'init': 'Create a sample tracking_plan.yaml.',
  'validate': 'Validate the tracking plan.',
  'generate': 'Generate the Dart file.',
  'check': 'Exit with 1 if the generated Dart file is missing or out of date.',
  'docs': 'Generate the Markdown event catalog.',
};

/// A failure that stops the CLI with exit code 2.
final class ToolException implements Exception {
  /// Creates an exception with a user-facing [message].
  ToolException(this.message);

  /// User-facing message.
  final String message;

  @override
  String toString() => message;
}

ArgParser _parser(String command) {
  final parser = ArgParser()
    ..addFlag('help', abbr: 'h', negatable: false, help: 'Show this help.')
    ..addOption(
      'plan',
      defaultsTo: _defaultPlan,
      help: 'Path to the tracking plan.',
    );
  if (command != 'init') {
    parser.addFlag(
      'allow-outside',
      negatable: false,
      help: 'Allow absolute output paths and paths with "..".',
    );
  }
  if (command == 'validate') {
    parser.addFlag(
      'json',
      negatable: false,
      help: 'Print machine-readable output.',
    );
  }
  if (command == 'generate' || command == 'check' || command == 'docs') {
    parser.addOption('out', help: 'Override the output path.');
  }
  return parser;
}

String _usage() {
  final buffer = StringBuffer()
    ..writeln('Generates type-safe Dart analytics code from a tracking plan.')
    ..writeln()
    ..writeln('Usage: dart run trackplan <command> [options]')
    ..writeln()
    ..writeln('Commands:');
  for (final MapEntry(:key, :value) in _commands.entries) {
    buffer.writeln('  ${key.padRight(10)}$value');
  }
  buffer
    ..writeln()
    ..writeln('Run "dart run trackplan <command> --help" for command options.')
    ..writeln('Global options: --help, --version');
  return buffer.toString();
}

/// Runs the CLI and returns the exit code.
///
/// Paths are resolved against [cwd]. Output goes to [out], diagnostics and
/// errors to [err].
int runCli(
  List<String> arguments, {
  required String cwd,
  required StringSink out,
  required StringSink err,
}) {
  if (arguments.isEmpty ||
      arguments.first == '--help' ||
      arguments.first == '-h') {
    out.write(_usage());
    return arguments.isEmpty ? exitToolFailure : exitOk;
  }
  if (arguments.first == '--version') {
    out.writeln('trackplan $packageVersion');
    return exitOk;
  }
  final command = arguments.first;
  if (!_commands.containsKey(command)) {
    err
      ..writeln('Unknown command "${_e(command)}".')
      ..writeln()
      ..write(_usage());
    return exitToolFailure;
  }

  final parser = _parser(command);
  final ArgResults options;
  try {
    options = parser.parse(arguments.skip(1));
  } on FormatException catch (e) {
    err
      ..writeln(_e(e.message))
      ..writeln()
      ..writeln('Usage: dart run trackplan $command [options]')
      ..writeln(parser.usage);
    return exitToolFailure;
  }
  if (options.flag('help')) {
    out
      ..writeln(_commands[command])
      ..writeln()
      ..writeln('Usage: dart run trackplan $command [options]')
      ..writeln(parser.usage);
    return exitOk;
  }
  if (options.rest.isNotEmpty) {
    err.writeln('Unexpected argument "${_e(options.rest.first)}".');
    return exitToolFailure;
  }

  try {
    return switch (command) {
      'init' => _init(options, cwd, out),
      'validate' => _validate(options, cwd, out),
      _ => _generateCommand(command, options, cwd, out, err),
    };
  } on ToolException catch (e) {
    err.writeln(e.message);
    return exitToolFailure;
  } on FileSystemException catch (e) {
    err.writeln(
      'File error: ${_e(e.message)}${e.path == null ? '' : ' (${_e(e.path!)})'}',
    );
    return exitToolFailure;
  } on StackOverflowError {
    err.writeln('The plan is nested too deeply to be read.');
    return exitToolFailure;
  }
}

bool _sameBytes(List<int> a, List<int> b) {
  if (a.length != b.length) return false;
  for (var i = 0; i < a.length; i++) {
    if (a[i] != b[i]) return false;
  }
  return true;
}

String _resolve(String cwd, String path) =>
    p.normalize(p.isAbsolute(path) ? path : p.join(cwd, path));

/// Reads at most [limit] + 1 bytes, so special files such as `/dev/zero`
/// cannot exhaust memory.
List<int> _readLimited(String path, int limit) {
  final file = File(path).openSync();
  try {
    return file.readSync(limit + 1);
  } finally {
    file.closeSync();
  }
}

List<int> _readPlan(String cwd, String planPath) {
  final path = _resolve(cwd, planPath);
  final type = FileSystemEntity.typeSync(path);
  if (type == FileSystemEntityType.notFound) {
    throw ToolException('Cannot read ${_e(planPath)}: file not found.');
  }
  if (type == FileSystemEntityType.directory) {
    throw ToolException('Cannot read ${_e(planPath)}: it is a directory.');
  }
  final bytes = _readLimited(path, maxPlanBytes);
  if (bytes.length > maxPlanBytes) {
    throw ToolException('Cannot read ${_e(planPath)}: it is larger than 1 MB.');
  }
  return bytes;
}

/// Throws unless [target], with symlinks resolved, is inside [cwd].
void _ensureInside(String cwd, String target, String shownPath) {
  final realCwd = Directory(cwd).resolveSymbolicLinksSync();
  var existing = target;
  while (FileSystemEntity.typeSync(existing) == FileSystemEntityType.notFound) {
    existing = p.dirname(existing);
  }
  final realExisting = File(existing).resolveSymbolicLinksSync();
  final rest = p.relative(target, from: existing);
  final resolved = rest == '.'
      ? realExisting
      : p.normalize(p.join(realExisting, rest));
  if (!p.isWithin(realCwd, resolved)) {
    throw ToolException(
      'Refusing to use ${_e(shownPath)}: it resolves to ${_e(resolved)}, '
      'outside the current directory. Use --allow-outside if this is intended.',
    );
  }
}

int _init(ArgResults options, String cwd, StringSink out) {
  final planPath = options.option('plan')!;
  final file = File(_resolve(cwd, planPath));
  if (FileSystemEntity.typeSync(file.path, followLinks: false) !=
      FileSystemEntityType.notFound) {
    throw ToolException(
      '${_e(planPath)} already exists. Delete it first or choose another path '
      'with --plan.',
    );
  }
  // exclusive also guards against a file created since the check above.
  file.createSync(exclusive: true);
  file.writeAsStringSync(samplePlan, flush: true);
  out.writeln('Created ${_e(planPath)}.');
  return exitOk;
}

int _validate(ArgResults options, String cwd, StringSink out) {
  final planPath = options.option('plan')!;
  final result = validatePlan(
    _readPlan(cwd, planPath),
    allowOutside: options.flag('allow-outside'),
  );
  if (options.flag('json')) {
    out.write(diagnosticsToJson(planPath, result.diagnostics));
  } else {
    for (final diagnostic in result.diagnostics) {
      out.writeln(diagnostic.format(_e(planPath)));
    }
    out.writeln(summaryLine(result.diagnostics));
  }
  return result.hasErrors ? exitInvalid : exitOk;
}

int _generateCommand(
  String command,
  ArgResults options,
  String cwd,
  StringSink out,
  StringSink err,
) {
  final planPath = options.option('plan')!;
  final allowOutside = options.flag('allow-outside');
  final isDocs = command == 'docs';
  final outOption = options.option('out');
  if (outOption != null) _checkOutOption(outOption, isDocs, allowOutside);
  final result = validatePlan(
    _readPlan(cwd, planPath),
    allowOutside: allowOutside,
  );
  for (final diagnostic in result.diagnostics) {
    err.writeln(diagnostic.format(_e(planPath)));
  }
  final plan = result.plan;
  if (plan == null) {
    err.writeln(summaryLine(result.diagnostics));
    return exitInvalid;
  }

  final target = outOption ?? (isDocs ? _defaultDocs : plan.dartOutput);
  final content = isDocs
      ? generateDocs(plan, planPath)
      : generateDart(plan, planPath);

  if (command == 'check') {
    final path = _resolve(cwd, target);
    if (!allowOutside) _ensureInside(cwd, path, target);
    if (FileSystemEntity.typeSync(path) != FileSystemEntityType.file) {
      err.writeln(
        '${_e(target)} does not exist. Run `dart run trackplan generate`.',
      );
      return exitInvalid;
    }
    final expected = utf8.encode(content);
    // Compare lengths first so a huge or special file is never read whole.
    if (File(path).lengthSync() != expected.length ||
        !_sameBytes(_readLimited(path, expected.length), expected)) {
      err.writeln(
        '${_e(target)} is out of date. Run `dart run trackplan generate`.',
      );
      return exitInvalid;
    }
    out.writeln('${_e(target)} is up to date.');
    return exitOk;
  }

  writeGeneratedFile(
    cwd: cwd,
    path: target,
    content: content,
    isGenerated: isDocs
        ? (line) => line.startsWith(docsHeaderPrefix)
        : (line) => line == dartHeaderLine,
    allowOutside: allowOutside,
  );
  out.writeln('Wrote ${_e(target)}.');
  return exitOk;
}

void _checkOutOption(String path, bool isDocs, bool allowOutside) {
  if (outputPathProblem(path, allowOutside: allowOutside) != null) {
    throw ToolException(
      'Invalid --out "${_e(path)}": it must be relative and stay inside the '
      'project (use --allow-outside to write elsewhere).',
    );
  }
  if (!isDocs && !path.endsWith('.dart')) {
    throw ToolException('Invalid --out "${_e(path)}": it must end with .dart.');
  }
}

/// Writes [content] to [path] atomically (SPEC.md sections 2.4 and 9).
///
/// Refuses to write outside [cwd] after resolving symlinks, unless
/// [allowOutside] is true, and refuses to overwrite a file whose first line
/// does not satisfy [isGenerated].
void writeGeneratedFile({
  required String cwd,
  required String path,
  required String content,
  required bool Function(String firstLine) isGenerated,
  required bool allowOutside,
}) {
  final target = _resolve(cwd, path);
  if (!allowOutside) _ensureInside(cwd, target, path);

  final type = FileSystemEntity.typeSync(target);
  if (type == FileSystemEntityType.directory) {
    throw ToolException('Refusing to write ${_e(path)}: it is a directory.');
  }
  if (type != FileSystemEntityType.notFound) {
    // Only the start of the file is needed; it may be large or not UTF-8.
    final start = _readLimited(target, 4096);
    var firstLine = utf8.decode(start, allowMalformed: true).split('\n').first;
    if (firstLine.endsWith('\r')) {
      firstLine = firstLine.substring(0, firstLine.length - 1);
    }
    if (!isGenerated(firstLine)) {
      throw ToolException(
        'Refusing to overwrite ${_e(path)}: it was not generated by trackplan. '
        'Delete it or choose another output path.',
      );
    }
  }

  final directory = Directory(p.dirname(target))..createSync(recursive: true);
  // A random name created exclusively: a planted symlink or file with a
  // predictable name could otherwise redirect the write.
  final random = Random.secure();
  final suffix = List.generate(
    8,
    (_) => random.nextInt(256).toRadixString(16).padLeft(2, '0'),
  ).join();
  final temp = File(
    p.join(directory.path, '.${p.basename(target)}.$suffix.trackplan.tmp'),
  )..createSync(exclusive: true);
  try {
    temp.writeAsStringSync(content, flush: true);
    temp.renameSync(target);
  } on FileSystemException {
    if (temp.existsSync()) temp.deleteSync();
    rethrow;
  }
}
