// Prints line coverage per file from coverage/lcov.info and exits with 1 if
// a parser, validator or generator file is below 90%.
//
// Usage: dart run coverage:test_with_coverage && dart run tool/coverage_report.dart
import 'dart:io';

const _threshold = 90.0;

// Files that the brief requires to reach the threshold.
const _gated = {
  'source.dart',
  'names.dart',
  'validator.dart',
  'diagnostic.dart',
  'text.dart',
  'dart_generator.dart',
  'docs_generator.dart',
};

void main() {
  final lcov = File('coverage/lcov.info');
  if (!lcov.existsSync()) {
    stderr.writeln(
      'coverage/lcov.info not found. Run '
      '`dart run coverage:test_with_coverage` first.',
    );
    exitCode = 2;
    return;
  }
  final hits = <String, ({int found, int hit})>{};
  String? file;
  var found = 0;
  var hit = 0;
  for (final line in lcov.readAsLinesSync()) {
    if (line.startsWith('SF:')) {
      file = line.substring(3).split(RegExp(r'[/\\]')).last;
      found = 0;
      hit = 0;
    } else if (line.startsWith('DA:')) {
      found++;
      if (!line.endsWith(',0')) hit++;
    } else if (line == 'end_of_record' && file != null) {
      hits[file] = (found: found, hit: hit);
    }
  }

  var failed = false;
  var totalFound = 0;
  var totalHit = 0;
  for (final MapEntry(:key, :value)
      in (hits.entries.toList()..sort((a, b) => a.key.compareTo(b.key)))) {
    final percent = value.found == 0 ? 100.0 : 100 * value.hit / value.found;
    final gated = _gated.contains(key);
    final low = gated && percent < _threshold;
    failed |= low;
    totalFound += value.found;
    totalHit += value.hit;
    stdout.writeln(
      '${key.padRight(22)} ${percent.toStringAsFixed(1).padLeft(6)}%  '
      '(${value.hit}/${value.found})${gated ? '' : '  not gated'}'
      '${low ? '  BELOW ${_threshold.toStringAsFixed(0)}%' : ''}',
    );
  }
  stdout.writeln(
    '${'total'.padRight(22)} '
    '${(100 * totalHit / totalFound).toStringAsFixed(1).padLeft(6)}%',
  );
  if (failed) exitCode = 1;
}
