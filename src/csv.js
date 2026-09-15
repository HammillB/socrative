/**
 * A minimal RFC-4180 CSV reader and column-picker.
 *
 * Shared by the command-line importer and the Rooms screen's browser-side
 * roster upload, so "what counts as a Student ID column" is defined in
 * exactly one place rather than two copies that could quietly drift apart.
 */

/** Handles quoted fields and embedded commas. */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (ch !== "\r") field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }

  const header = rows.shift().map((h) => h.replace(/^﻿/, "").trim());
  return rows
    .filter((r) => r.some((cell) => cell.trim() !== ""))
    .map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? "").trim()])));
}

/** Find a column by any of several likely spellings. */
export function pickColumn(row, ...names) {
  for (const name of names) {
    const key = Object.keys(row).find((k) => k.toLowerCase() === name.toLowerCase());
    if (key && row[key] !== "") return row[key];
  }
  return null;
}
