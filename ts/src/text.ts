// A loop, not a regex: /[ \t]+$/ backtracks quadratically on long runs.
function trimRightSpaceAndTab(line: string): string {
  let end = line.length;
  while (end > 0) {
    const unit = line.charCodeAt(end - 1);
    if (unit !== 0x20 && unit !== 0x09) break;
    end--;
  }
  return line.slice(0, end);
}

/**
 * Splits free text into lines for comments and docs (SPEC.md section 7.6).
 *
 * CRLF becomes LF, trailing spaces and tabs are removed from each line, and
 * leading and trailing blank lines are dropped.
 */
export function textLines(text: string): string[] {
  const lines = text.replaceAll('\r\n', '\n').split('\n').map(trimRightSpaceAndTab);
  while (lines.length > 0 && lines[0] === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Joins the lines of free text with spaces, for single-line fields such as `owner`. */
export function oneLine(text: string): string {
  return textLines(text).join(' ');
}

/**
 * The plan file's base name as used in generated headers (SPEC.md 7.1).
 * Both `/` and `\` count as separators, independent of the platform.
 */
export function headerFileName(planPath: string): string {
  const base = planPath.split(/[/\\]/).pop() ?? '';
  return base.replace(/[^A-Za-z0-9._ -]/g, '_');
}

/** Whether text is empty or only spaces, tabs and line breaks (SPEC.md 2.2.1). */
export function isBlank(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit !== 0x20 && unit !== 0x09 && unit !== 0x0a && unit !== 0x0d) return false;
  }
  return true;
}
