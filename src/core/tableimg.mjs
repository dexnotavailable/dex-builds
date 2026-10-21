import { createCanvas } from '@napi-rs/canvas';

// Draws a markdown table as a PNG, because Discord has no tables. The font stacks fall back to the
// Windows emoji and symbol fonts (color emoji such as ✅ need them); other systems use Noto.
// Laid out at a logical width of `maxWidth` and rendered at `scale`x so it stays sharp when a
// reader clicks the image open (Discord shows it smaller in the feed).

const SANS = '"Segoe UI", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Sans", "Noto Color Emoji", Arial, sans-serif';
const MONO = 'Consolas, "Cascadia Mono", "Segoe UI Emoji", "Noto Color Emoji", monospace';

const THEME = {
  card: '#1a1b1e',
  band: '#1f2024',
  line: '#2b2d31',
  text: '#dbdee1',
  head: '#ffffff',
  muted: '#949ba4',
  good: '#57f287',
  warn: '#fbbf24',
  bad: '#f87171',
};

const SIZE = { font: 22, padX: 16, padY: 11, line: 30, margin: 12, radius: 14 };

/** Inline markdown of one cell -> styled runs: [{ text, bold, italic, code }]. Links keep their text. */
export function parseRuns(text) {
  const s = String(text ?? '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<\/?[a-zA-Z][^>]*>/g, '');
  const runs = [];
  for (const part of s.split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*|~~[^~]+~~)/)) {
    if (!part) continue;
    if (part.startsWith('**')) runs.push({ text: part.slice(2, -2), bold: true });
    else if (part.startsWith('`')) runs.push({ text: part.slice(1, -1), code: true });
    else if (part.startsWith('~~')) runs.push({ text: part.slice(2, -2) });
    else if (part.startsWith('*')) runs.push({ text: part.slice(1, -1), italic: true });
    else runs.push({ text: part });
  }
  return runs;
}

/** Colour for a whole cell when it reads as a status: ✅ done, ▶ in progress, ○ not started, missed. */
export function tone(text) {
  const t = String(text ?? '').replace(/[*`_~]/g, '').trim();
  if (/^(✅|done\b|met\b|pass(ed)?\b)/i.test(t)) return THEME.good;
  if (/^(▶|in progress\b|started\b)/i.test(t)) return THEME.warn;
  if (/^(○|not started\b)/i.test(t)) return THEME.muted;
  if (/^(❌|missed\b|fail(ed)?\b)/i.test(t)) return THEME.bad;
  return null;
}

function mix(a, b, t) {
  const p = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const [ar, ag, ab] = p(a);
  const [br, bg, bb] = p(b);
  const h = (x, y) => Math.round(x * t + y * (1 - t)).toString(16).padStart(2, '0');
  return `#${h(ar, br)}${h(ag, bg)}${h(ab, bb)}`;
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/**
 * Render { header, align, rows } to a PNG Buffer. Returns { png, width, height } (logical pixels).
 * opts: accent (header colour), maxWidth (logical px the columns share to start with), maxRatio
 * (tallest height/width before a wider canvas is tried), scale (pixel ratio).
 */
export function renderTable(table, { accent = '#f59e0b', maxWidth = 860, maxRatio = 0.8, scale = 2 } = {}) {
  const { font: FS, padX, padY, line: LH, margin: M, radius } = SIZE;
  const probe = createCanvas(8, 8).getContext('2d');
  const fontOf = (run, bold) => `${run.italic ? 'italic ' : ''}${run.bold || bold ? 'bold ' : ''}${run.code ? FS - 2 : FS}px ${run.code ? MONO : SANS}`;

  // cells -> word tokens with measured widths (runs of spaces collapse to one)
  const tokens = (text, bold) =>
    parseRuns(text).flatMap((run) =>
      run.text
        .split(/(\s+)/)
        .filter((t) => t !== '')
        .map((t) => {
          const space = /^\s+$/.test(t);
          const word = space ? ' ' : t;
          probe.font = fontOf(run, bold);
          return { run, text: word, space, w: probe.measureText(word).width, bold };
        }),
    );

  const cols = table.header.length;
  const grid = [table.header.map((c) => tokens(c, true)), ...table.rows.map((r) => r.map((c) => tokens(c, false)))];

  const nat = new Array(cols).fill(0);
  const min = new Array(cols).fill(0);
  for (const row of grid) {
    row.forEach((cell, c) => {
      nat[c] = Math.max(nat[c], cell.reduce((n, t) => n + t.w, 0));
      min[c] = Math.max(min[c], ...cell.filter((t) => !t.space).map((t) => t.w), 0);
    });
  }

  const pad = padX * 2;
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const at = (cap) => nat.map((n, c) => Math.max(min[c], Math.min(n, cap)) + pad);

  // greedy word wrap per cell
  const wrap = (cell, avail) => {
    const lines = [[]];
    let used = 0;
    for (const t of cell) {
      if (t.space) {
        if (lines[lines.length - 1].length) {
          lines[lines.length - 1].push(t);
          used += t.w;
        }
        continue;
      }
      if (used + t.w > avail + 0.5 && lines[lines.length - 1].length) {
        const last = lines[lines.length - 1];
        while (last.length && last[last.length - 1].space) last.pop();
        lines.push([]);
        used = 0;
      }
      lines[lines.length - 1].push(t);
      used += t.w;
    }
    const last = lines[lines.length - 1];
    while (last.length && last[last.length - 1].space) last.pop();
    return lines;
  };

  // Columns share `width`: natural width when it fits, otherwise the widest columns are capped at one
  // shared width (never below their longest word), so short columns like a status stay on one line.
  const plan = (width) => {
    let widths = nat.map((n) => n + pad);
    if (sum(widths) > width) {
      let lo = 0;
      let hi = Math.max(...nat);
      for (let n = 0; n < 24; n += 1) {
        const mid = (lo + hi) / 2;
        if (sum(at(mid)) > width) hi = mid;
        else lo = mid;
      }
      widths = at(lo);
    }
    const laid = grid.map((row) => {
      const cells = row.map((cell, c) => wrap(cell, widths[c] - pad));
      return { cells, h: Math.max(...cells.map((l) => l.length), 1) * LH + padY * 2 };
    });
    return { widths, laid, tableW: Math.ceil(sum(widths)), tableH: Math.ceil(sum(laid.map((r) => r.h))) };
  };

  // Discord shrinks tall images to fit the feed, so a wide table gets a wider canvas (fewer wrapped
  // lines) until it is no taller than `maxRatio` of its width; the widest try is the fallback.
  let chosen = plan(maxWidth);
  for (const extra of [140, 290, 440]) {
    if (chosen.tableH <= chosen.tableW * maxRatio) break;
    chosen = plan(maxWidth + extra);
  }
  const { widths, laid, tableW, tableH } = chosen;

  const W = tableW + M * 2;
  const H = tableH + M * 2;
  const canvas = createCanvas(Math.ceil(W * scale), Math.ceil(H * scale));
  const g = canvas.getContext('2d');
  g.scale(scale, scale);
  g.textBaseline = 'alphabetic';

  // card
  roundRect(g, M, M, tableW, tableH, radius);
  g.fillStyle = THEME.card;
  g.fill();
  g.save();
  g.clip();

  let y = M;
  laid.forEach((row, r) => {
    const head = r === 0;
    if (head) {
      g.fillStyle = mix(accent, THEME.card, 0.22);
      g.fillRect(M, y, tableW, row.h);
    } else if (r % 2 === 0) {
      g.fillStyle = THEME.band;
      g.fillRect(M, y, tableW, row.h);
    }
    let x = M;
    row.cells.forEach((lines, c) => {
      const inner = widths[c] - pad;
      const tint = head ? THEME.head : tone(grid[r][c].map((t) => t.text).join('')) ?? THEME.text;
      lines.forEach((words, l) => {
        const lw = words.reduce((n, t) => n + t.w, 0);
        const align = table.align[c] ?? 'left';
        let tx = x + padX + (align === 'center' ? (inner - lw) / 2 : align === 'right' ? inner - lw : 0);
        const base = y + padY + l * LH + (LH - FS) / 2 + FS * 0.8;
        for (const t of words) {
          g.font = fontOf(t.run, t.bold);
          g.fillStyle = t.run.code ? mix(tint, THEME.card, 0.9) : tint;
          g.fillText(t.text, tx, base);
          tx += t.w;
        }
      });
      x += widths[c];
    });
    y += row.h;
    if (!head && r < laid.length - 1) {
      g.fillStyle = THEME.line;
      g.fillRect(M, y - 0.5, tableW, 1);
    }
    if (head) {
      g.fillStyle = accent;
      g.fillRect(M, y - 2, tableW, 2);
    }
  });
  g.restore();

  roundRect(g, M + 0.5, M + 0.5, tableW - 1, tableH - 1, radius);
  g.strokeStyle = THEME.line;
  g.lineWidth = 1;
  g.stroke();

  return { png: canvas.toBuffer('image/png'), width: W, height: H };
}
