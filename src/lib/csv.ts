/**
 * Isomorphic RFC-4180 CSV helpers (Prompt B).
 *
 * Used by the Iiko bulk-mapping UI on the admin mapping screen: parse a pasted
 * / uploaded CSV by header name, and generate a downloadable template. No node
 * deps, so it's safe in a Client Component.
 */

/** Parse CSV text into a matrix of string fields (handles quoted fields + "" escapes). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      i += 1;
      continue;
    }
    if (ch === "\r") {
      rows.push(row);
      row = [];
      field = "";
      i += text[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    if (ch === "\n") {
      rows.push(row);
      row = [];
      field = "";
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => r.length > 0 && r.some((c) => c.trim() !== ""));
}

/** Serialise a matrix of fields into CSV text (quotes fields containing commas/quotes/newlines). */
export function toCsv(rows: string[][]): string {
  return rows
    .map((r) => r.map(quoteField).join(","))
    .join("\r\n");
}

function quoteField(s: string): string {
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** Trigger a client-side download of text as a named file. */
export function downloadTextFile(filename: string, text: string, mime = "text/csv;charset=utf-8") {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Find a column index by header name (case-insensitive, trimmed). */
export function colIndex(header: string[], name: string): number {
  return header.findIndex((h) => h.trim().toLowerCase() === name.toLowerCase());
}
