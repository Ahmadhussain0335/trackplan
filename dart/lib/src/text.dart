/// Splits free text into lines for comments and docs (SPEC.md section 7.6).
///
/// CRLF becomes LF, trailing spaces and tabs are removed from each line, and
/// leading and trailing blank lines are dropped.
List<String> textLines(String text) {
  final lines = text
      .replaceAll('\r\n', '\n')
      .split('\n')
      .map(_trimRightSpaceAndTab)
      .toList();
  while (lines.isNotEmpty && lines.first.isEmpty) {
    lines.removeAt(0);
  }
  while (lines.isNotEmpty && lines.last.isEmpty) {
    lines.removeLast();
  }
  return lines;
}

// A loop, not a regex: `[ \t]+$` backtracks quadratically on long runs.
String _trimRightSpaceAndTab(String line) {
  var end = line.length;
  while (end > 0) {
    final unit = line.codeUnitAt(end - 1);
    if (unit != 0x20 && unit != 0x09) break;
    end--;
  }
  return line.substring(0, end);
}

/// Joins the lines of [text] with spaces, for single-line fields such as
/// `owner` (SPEC.md section 2.9).
String oneLine(String text) => textLines(text).join(' ');

/// The plan file's base name as used in generated headers (SPEC.md 7.1).
///
/// Both `/` and `\` count as separators, independent of the platform.
String headerFileName(String planPath) {
  final base = planPath.split(RegExp(r'[/\\]')).last;
  return base.replaceAll(RegExp(r'[^A-Za-z0-9._ -]'), '_');
}
