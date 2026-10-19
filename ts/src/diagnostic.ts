/** How serious a diagnostic is. */
export type Severity = 'error' | 'warning';

/** A problem found in a tracking plan, with a stable code such as `TP030`. */
export interface Diagnostic {
  /** Stable code, for example `TP030`. See SPEC.md section 6. */
  readonly code: string;
  /** Whether this is an error or a warning. */
  readonly severity: Severity;
  /** 1-based line. */
  readonly line: number;
  /** 1-based column, counted in UTF-16 code units. */
  readonly column: number;
  /** Human-readable message. Plan text in it is escaped. */
  readonly message: string;
}

/** Formats a diagnostic as one line of human-readable output. */
export function formatDiagnostic(d: Diagnostic, file: string): string {
  return `${file}:${d.line}:${d.column} ${d.severity} ${d.code} ${d.message}`;
}

// UTF-16 code unit order, never locale order (SPEC.md section 5.3).
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Sorts diagnostics as required by SPEC.md section 5.3. */
export function sortDiagnostics(diagnostics: Iterable<Diagnostic>): Diagnostic[] {
  const severityIndex = (s: Severity) => (s === 'error' ? 0 : 1);
  return [...diagnostics].sort(
    (a, b) =>
      a.line - b.line ||
      a.column - b.column ||
      severityIndex(a.severity) - severityIndex(b.severity) ||
      compareStrings(a.code, b.code) ||
      compareStrings(a.message, b.message),
  );
}

/** Whether a UTF-16 code unit is in the disallowed set of SPEC.md section 2.9. */
export function isDisallowedCharacter(unit: number): boolean {
  return (
    unit <= 0x08 ||
    (unit >= 0x0b && unit <= 0x1f) ||
    (unit >= 0x7f && unit <= 0x9f) ||
    unit === 0x2028 ||
    unit === 0x2029 ||
    (unit >= 0x202a && unit <= 0x202e) ||
    (unit >= 0x2066 && unit <= 0x2069) ||
    unit === 0xfeff
  );
}

function hex4(unit: number): string {
  return unit.toString(16).toUpperCase().padStart(4, '0');
}

/** Formats a code unit as `U+XXXX`. */
export function unicodeName(unit: number): string {
  return `U+${hex4(unit)}`;
}

/**
 * Escapes plan text for use inside a message (SPEC.md section 6.1).
 *
 * Tab, line feed, carriage return and disallowed characters become
 * `\u{XXXX}`, so a plan cannot inject terminal escape codes into logs.
 */
export function escapeForMessage(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    out +=
      unit === 0x09 || unit === 0x0a || unit === 0x0d || isDisallowedCharacter(unit)
        ? `\\u{${hex4(unit)}}`
        : text.charAt(i);
  }
  return out;
}

/** Formats diagnostics as the `--json` output of SPEC.md section 5.4. */
export function diagnosticsToJson(file: string, diagnostics: readonly Diagnostic[]): string {
  const errors = diagnostics.filter((d) => d.severity === 'error').length;
  const value = {
    file: escapeForMessage(file),
    error_count: errors,
    warning_count: diagnostics.length - errors,
    diagnostics: diagnostics.map((d) => ({
      code: d.code,
      severity: d.severity,
      line: d.line,
      column: d.column,
      message: d.message,
    })),
  };
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Formats the summary line, for example `1 error, 0 warnings.` */
export function summaryLine(diagnostics: readonly Diagnostic[]): string {
  const errors = diagnostics.filter((d) => d.severity === 'error').length;
  const warnings = diagnostics.length - errors;
  return (
    `${errors} ${errors === 1 ? 'error' : 'errors'}, ` +
    `${warnings} ${warnings === 1 ? 'warning' : 'warnings'}.`
  );
}
