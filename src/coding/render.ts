// src/coding/render.ts
//
// A minimal terminal screen renderer. Claude Code's Ink TUI positions text with
// cursor-movement escapes (`\e[NG` cursor-to-column, `\e[NC` forward, `\e[NA/B`
// up/down) rather than literal spaces, so `stripAnsi` fuses words ("No, exit" →
// "No,exit"). This replays the load-bearing CSI moves into a 2D character grid
// and reads back the *visible* screen — the text a human actually sees — which
// is what the prompt detector/option parser should run on (Step 2).
//
// It is intentionally small: it handles the cursor/erase sequences an Ink TUI
// uses for layout and ignores the rest (colors, queries). It is NOT a conformant
// VT — just enough to recover readable layout for scraping.

const ESC = "\x1b";

export function renderScreen(raw: string): string[] {
  const grid: string[][] = [];
  let row = 0;
  let col = 0;

  const ensureRow = (r: number): string[] => {
    while (grid.length <= r) grid.push([]);
    return grid[r]!;
  };
  const put = (ch: string): void => {
    const line = ensureRow(row);
    while (line.length < col) line.push(" ");
    line[col] = ch;
    col += 1;
  };

  let i = 0;
  while (i < raw.length) {
    const ch = raw[i]!;
    if (ch === ESC) {
      if (raw[i + 1] === "[") {
        // CSI: ESC [ <private-prefix?> params final
        let j = i + 2;
        if (j < raw.length && /[<=>?]/.test(raw[j]!)) j++; // private-mode prefix (e.g. \e[>0q, \e[?25l)
        let params = "";
        while (j < raw.length && /[0-9;]/.test(raw[j]!)) params += raw[j++];
        const final = raw[j] ?? "";
        const first = parseInt(params.split(";")[0] ?? "", 10);
        const n1 = Number.isNaN(first) ? 1 : first; // default 1
        const n0 = Number.isNaN(first) ? 0 : first; // default 0
        switch (final) {
          case "A": row = Math.max(0, row - n1); break; // cursor up
          case "B": row = row + n1; break; // cursor down
          case "C": col = col + n1; break; // cursor forward
          case "D": col = Math.max(0, col - n1); break; // cursor back
          case "G": col = Math.max(0, n1 - 1); break; // cursor horizontal absolute
          case "H":
          case "f": {
            const parts = params.split(";");
            const r = parseInt(parts[0] ?? "", 10);
            const c = parseInt(parts[1] ?? "", 10);
            row = Math.max(0, (Number.isNaN(r) ? 1 : r) - 1);
            col = Math.max(0, (Number.isNaN(c) ? 1 : c) - 1);
            break;
          }
          case "K": {
            // erase in line: 0 = cursor→end (default), 1 = start→cursor, 2 = all
            const line = ensureRow(row);
            if (n0 === 1) for (let k = 0; k < col && k < line.length; k++) line[k] = " ";
            else if (n0 === 2) line.length = 0;
            else line.length = Math.min(line.length, col);
            break;
          }
          case "J":
            // erase in display: 2/3 = whole screen
            if (n0 === 2 || n0 === 3) { grid.length = 0; row = 0; col = 0; }
            break;
          // m (color), other CSI: ignore
        }
        i = j + 1;
        continue;
      }
      if (raw[i + 1] === "]") {
        // OSC: ESC ] ... (BEL | ESC \)
        let j = i + 2;
        while (j < raw.length && raw[j] !== "\x07" && !(raw[j] === ESC && raw[j + 1] === "\\")) j++;
        i = raw[j] === "\x07" ? j + 1 : j + 2;
        continue;
      }
      // other escape (charset select, keypad, etc.) — skip ESC + 1 byte
      i += 2;
      continue;
    }
    if (ch === "\r") { col = 0; i++; continue; }
    if (ch === "\n") { row += 1; col = 0; i++; continue; }
    if (ch === "\b") { col = Math.max(0, col - 1); i++; continue; }
    if (ch === "\x07") { i++; continue; } // bell
    put(ch);
    i++;
  }

  return grid.map((line) => line.join("").replace(/\s+$/u, ""));
}

/** The rendered screen joined back into a single string (for line-oriented scrapers). */
export function renderText(raw: string): string {
  return renderScreen(raw).join("\n");
}
