// ============================================================================
// CSV HELPERS (Batch H — Studio learner export)
// ----------------------------------------------------------------------------
// Small pure helpers for building RFC 4180 CSV output plus spreadsheet
// formula-injection protection. No I/O, no framework imports — safe to unit
// test and reuse from any route handler.
// ============================================================================

/**
 * Escape one CSV cell (RFC 4180 §2.5–2.7) with a formula-injection guard.
 *
 * - A cell containing `"`, `,` or a line break is wrapped in double quotes
 *   and every embedded `"` is doubled.
 * - A cell whose FIRST character is `=`, `+`, `-`, `@`, TAB or CR is
 *   prefixed with a single quote `'`, so spreadsheet apps treat it as text
 *   instead of a formula. The quote is part of the value (standard
 *   mitigation, also used by Google Sheets / Excel guidance).
 */
export function toCsvCell(value: string | number | boolean | null | undefined): string {
  const raw = value === null || value === undefined ? "" : String(value);
  const guarded =
    raw.length > 0 && /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return /["\n\r,]/.test(guarded) ? `"${guarded.replaceAll('"', '""')}"` : guarded;
}

/** Join already-escaped cells with commas and terminate with CRLF (RFC 4180 §2.1). */
export function toCsvRow(cells: Array<string | number | boolean | null | undefined>): string {
  return `${cells.map(toCsvCell).join(",")}\r\n`;
}

/** Build a complete CSV document: header row first, then one row per record. */
export function buildCsv(
  headers: string[],
  rows: Array<Array<string | number | boolean | null | undefined>>,
): string {
  return [toCsvRow(headers), ...rows.map(toCsvRow)].join("");
}
