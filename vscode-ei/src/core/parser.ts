import { ParseResult, Unit } from "./types";

// Port of the ei CLI parser. Free prose, structural conventions only:
// - '#' starts a comment line (kept in output).
// - An indented line belongs to the open block above it.
// - A trailing '\' continues a statement on the next line.
// - A top-level line that ends with ':' opens a block.
// - '@target <lang>' overrides the surveyed target (legacy compatibility).
export function parse(text: string): ParseResult {
  const lines = text.split(/\r?\n/);
  const units: Unit[] = [];
  let explicitTarget: string | undefined;

  let stmt = "";
  let stmtStart = 0;
  let stmtEnd = 0;
  let open = false;

  const flush = () => {
    if (!stmt) return;
    units.push({ kind: "statement", text: stmt, startLine: stmtStart, endLine: stmtEnd });
    stmt = "";
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const target = /^@target\s+([a-z]+)/.exec(line);
    if (target) { explicitTarget = target[1]; continue; }
    if (/^#/.test(line)) {
      flush();
      open = false;
      units.push({ kind: "comment", text: line, startLine: i, endLine: i });
      continue;
    }
    if (!line.trim()) continue;
    if (/^\s/.test(line)) {
      // indented: body of the open block
      if (!stmt) { stmtStart = i; }
      stmt += (stmt ? "\n" : "") + line;
      stmtEnd = i;
      continue;
    }
    // top-level line
    if (!open) { flush(); stmtStart = i; }
    open = false;
    stmtEnd = i;
    if (line.endsWith("\\")) {
      stmt += line.slice(0, -1).trimEnd() + " ";
      open = true;
      continue;
    }
    stmt += line;
    // a line ending in ':' opens a block; it stays open until the next
    // top-level line arrives (which flushes above)
  }
  flush();
  return { units, explicitTarget, lineCount: lines.length };
}

// The preamble is at most the first paragraph (structural rule).
export function clampPreamble(text: string, preambleEnd: number): number {
  if (preambleEnd <= 0) return 0;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) return Math.min(preambleEnd, i); // i = 0-based blank -> lines before it = i (1-based count)
  }
  return Math.min(preambleEnd, lines.length);
}
