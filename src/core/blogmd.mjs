import { codeBlock, md } from './format.mjs';

// Turns a dex.place blog post (markdown with a small frontmatter, see dex.place content/README.md)
// into the ordered Discord messages that carry the whole post. Pure: no Discord, no network.
//
// Discord always draws attachments *under* a message's text, so a post is cut into parts and the
// parts are sent in order:
//   { kind: 'text',  content, button? }            a message of text (<= LIMIT characters)
//   { kind: 'media', src, alt }                    an image or video, sent alone so it sits where it was written
//   { kind: 'table', header, align, rows, alt }    a table, drawn as an image (Discord has no tables)
//   { kind: 'file',  name, text, alt }             a code block too long for a message, sent as a file

/** Stay well under Discord's 2000 characters so emoji and newlines never tip a message over. */
export const LIMIT = 1900;

const CODE_LIMIT = 1700;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const KEYCAPS = ['0️⃣', '1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
const BULLETS = ['🔹', '▫️', '▪️'];
const INDENT = '\u2003\u2003'; // em spaces survive Discord's whitespace trimming; plain spaces may not

const CALLOUTS = {
  NOTE: { emoji: 'ℹ️', label: 'Note' },
  TIP: { emoji: '💡', label: 'Tip' },
  IMPORTANT: { emoji: '❗', label: 'Important' },
  WARNING: { emoji: '⚠️', label: 'Warning' },
  CAUTION: { emoji: '🛑', label: 'Caution' },
};

// First match wins; a heading that already starts with an emoji keeps its own.
const HEADING_EMOJI = [
  [/tl;?dr|summary|in short|at a glance/i, '⚡'],
  [/wrong|fail|problem|\bbugs?\b|broke|issue|mistake/i, '⚠️'],
  [/limit|caveat|risk|unknown|not yet/i, '🚧'],
  [/\bnext\b|to-?do|upcoming|future|coming|\bplans?\b/i, '🚀'],
  [/stage|status|roadmap|progress|milestone/i, '🗺️'],
  [/judge|critic|calibrat|verdict|review|blind/i, '⚖️'],
  [/result|finding|benchmark|score/i, '📊'],
  [/measur|metric|count|size|height|\btall\b|proportion/i, '📏'],
  [/triangle|polygon|mesh|topolog|geometry/i, '🔺'],
  [/skin|\brig\b|bone|skeleton|weight/i, '🦴'],
  [/learn|lesson|takeaway|conclusion/i, '💡'],
  [/reference|research|librar|source|dataset|reading/i, '📚'],
  [/approach|method|\bhow\b|pipeline|process|design/i, '🧭'],
  [/\bwhat\b.*\b(is|was|are)\b|overview|about|intro|background|\bwhy\b/i, '🔍'],
  [/made|built|build|create|produced/i, '🛠️'],
];

const EMOJI_START = /^\p{Extended_Pictographic}/u;

// ------------------------------------------------------------------ frontmatter

/** `---` fenced `key: value` lines, like the site's own parser. Throws when the fence is missing. */
export function parseFrontmatter(raw) {
  const m = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(String(raw ?? ''));
  if (!m) throw new Error('missing --- frontmatter ---');
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim()) continue;
    const at = line.indexOf(':');
    if (at < 1) throw new Error(`bad frontmatter line "${line}"`);
    meta[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return { meta, body: String(raw).slice(m[0].length) };
}

// ------------------------------------------------------------------ block parser

const FENCE = /^\s*(`{3,}|~{3,})\s*([^\s`]*)\s*(.*)$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const IMG_TAG = /<img\b[^>]*>/gi;
const MD_IMAGE = /!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;

function attr(tag, name) {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag);
  return m ? decodeEntities(m[1] ?? m[2]) : '';
}

function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

function isTableStart(lines, i) {
  return i + 1 < lines.length && lines[i].includes('|') && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('-') && splitRow(lines[i]).length === splitRow(lines[i + 1]).length;
}

function startsBlock(lines, i) {
  const line = lines[i];
  return FENCE.test(line) || HEADING.test(line) || HR.test(line) || ITEM.test(line) || /^\s{0,3}>/.test(line) || /^\s*<img\b/i.test(line) || /^\s*!\[[^\]]*\]\([^)]*\)\s*$/.test(line) || isTableStart(lines, i);
}

/** Pull images out of a paragraph: returns the remaining text and the images in reading order. */
function takeImages(text) {
  const images = [];
  let rest = text.replace(/\[\s*(!\[[^\]]*\]\([^)]*\))\s*\]\([^)]*\)/g, '$1'); // linked image -> image
  rest = rest.replace(IMG_TAG, (tag) => {
    images.push({ type: 'image', src: attr(tag, 'src'), alt: attr(tag, 'alt') });
    return '';
  });
  rest = rest.replace(MD_IMAGE, (_m, alt, src) => {
    images.push({ type: 'image', src, alt });
    return '';
  });
  return { text: rest.replace(/[ \t]+\n/g, '\n').trim(), images: images.filter((im) => im.src) };
}

/** Markdown body -> blocks. HTML comments are dropped, like on the site. */
export function parseBlocks(body) {
  const lines = String(body ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/<!--[\s\S]*?-->/g, '')
    .split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const [, marker, lang, rest] = fence;
      const body = [];
      i += 1;
      while (i < lines.length && !(lines[i].trim().startsWith(marker[0].repeat(marker.length)) && /^[`~]+\s*$/.test(lines[i].trim()))) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1; // closing fence (or end of file)
      blocks.push({ type: 'code', lang: lang.toLowerCase(), title: /title="([^"]*)"/.exec(rest)?.[1] ?? '', text: body.join('\n') });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] });
      i += 1;
      continue;
    }

    if (HR.test(line)) {
      blocks.push({ type: 'hr' });
      i += 1;
      continue;
    }

    if (isTableStart(lines, i)) {
      const header = splitRow(line);
      const align = splitRow(lines[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : 'left'));
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        const cells = splitRow(lines[i]);
        while (cells.length < header.length) cells.push('');
        rows.push(cells.slice(0, header.length));
        i += 1;
      }
      blocks.push({ type: 'table', header, align, rows });
      continue;
    }

    if (/^\s{0,3}>/.test(line)) {
      const quote = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) {
        quote.push(lines[i].replace(/^\s{0,3}>\s?/, ''));
        i += 1;
      }
      blocks.push({ type: 'quote', lines: quote });
      continue;
    }

    if (ITEM.test(line)) {
      const items = [];
      const indents = [];
      while (i < lines.length) {
        const m = ITEM.exec(lines[i]);
        if (m) {
          const indent = m[1].replace(/\t/g, '    ').length;
          while (indents.length && indent < indents[indents.length - 1]) indents.pop();
          if (!indents.length || indent > indents[indents.length - 1]) indents.push(indent);
          let text = m[3];
          const task = /^\[( |x|X)\]\s+/.exec(text);
          if (task) text = text.slice(task[0].length);
          items.push({ depth: indents.length - 1, ordered: /^\d/.test(m[2]), number: parseInt(m[2], 10), text, checked: task ? task[1] !== ' ' : null });
          i += 1;
        } else if (lines[i].trim() && /^\s{2,}\S/.test(lines[i]) && items.length) {
          items[items.length - 1].text += ` ${lines[i].trim()}`; // wrapped item text
          i += 1;
        } else if (!lines[i].trim() && i + 1 < lines.length && ITEM.test(lines[i + 1])) {
          i += 1; // a loose list: one blank line between items
        } else break;
      }
      blocks.push({ type: 'list', items });
      continue;
    }

    // paragraph (possibly made of image tags only)
    const chunk = [line];
    i += 1;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines, i)) {
      chunk.push(lines[i]);
      i += 1;
    }
    const joined = chunk.reduce((acc, l, n) => (n === 0 ? l.trim() : `${acc}${/( {2}|\\)$/.test(chunk[n - 1]) ? '\n' : ' '}${l.trim()}`), '');
    const { text, images } = takeImages(joined);
    if (text) blocks.push({ type: 'paragraph', text });
    blocks.push(...images);
  }
  return blocks;
}

// ------------------------------------------------------------------ inline markdown -> Discord

/** Run `fn` on the parts of `s` that are not inside `code spans`. */
function outsideCode(s, fn) {
  return s
    .split(/(`[^`\n]*`)/)
    .map((part, n) => (n % 2 ? part : fn(part)))
    .join('');
}

function discordUrl(href, pageUrl, siteBase) {
  let url;
  try {
    url = href.startsWith('/') ? new URL(href, siteBase) : new URL(href, pageUrl);
  } catch {
    return null;
  }
  if (!/^(https?|mailto):$/.test(url.protocol)) return null;
  return url.href.replace(/\(/g, '%28').replace(/\)/g, '%29');
}

/**
 * Inline markdown/HTML -> what Discord renders. Bold, italic, strike and `code` already match.
 * Links become masked links with absolute URLs; in-page anchors keep just their text.
 */
export function inline(text, { pageUrl = 'https://dex.place/', siteBase = 'https://dex.place' } = {}) {
  let s = String(text ?? '');
  s = outsideCode(s, (part) =>
    part
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<kbd>(.*?)<\/kbd>/gi, '`$1`')
      .replace(/<(strong|b)>(.*?)<\/\1>/gi, '**$2**')
      .replace(/<(em|i)>(.*?)<\/\1>/gi, '*$2*')
      .replace(/<(s|del|strike)>(.*?)<\/\1>/gi, '~~$2~~')
      .replace(/<code>(.*?)<\/code>/gi, '`$1`')
      .replace(/<a\b[^>]*\bhref="([^"]*)"[^>]*>(.*?)<\/a>/gi, '[$2]($1)')
      .replace(/<\/?[a-zA-Z][^>]*>/g, ''),
  );
  s = outsideCode(s, (part) =>
    // the URL may hold one level of balanced parentheses, like .../a_(b)
    part.replace(/\[([^\]]+)\]\(\s*<?((?:[^()\s>]|\([^()\s]*\))+)>?(?:\s+"[^"]*")?\s*\)/g, (_m, label, href) => {
      const url = href.startsWith('#') ? null : discordUrl(href, pageUrl, siteBase);
      return url ? `[${label}](${url})` : label;
    }),
  );
  return outsideCode(s, decodeEntities).trim();
}

const plainCaption = (s) => /^(\*(?!\*)([^*\n]+)\*|_([^_\n]+)_)$/.exec(s.trim());

// ------------------------------------------------------------------ rendering blocks to units

export function headingEmoji(text, level) {
  if (EMOJI_START.test(text)) return '';
  for (const [re, emoji] of HEADING_EMOJI) if (re.test(text)) return emoji;
  return level <= 2 ? '🔹' : '▫️';
}

function listLines(items, ictx) {
  const counters = [];
  return items.map((item) => {
    counters.length = item.depth + 1;
    let marker;
    if (item.checked !== null) marker = item.checked ? '☑️' : '⬜';
    else if (item.ordered) {
      counters[item.depth] = (counters[item.depth] ?? item.number - 1) + 1;
      const n = counters[item.depth];
      marker = item.depth === 0 && n < KEYCAPS.length ? KEYCAPS[n] : `**${n}.**`;
    } else marker = BULLETS[Math.min(item.depth, BULLETS.length - 1)];
    return `${INDENT.repeat(item.depth)}${marker} ${inline(item.text, ictx)}`;
  });
}

function quoteText(lines, ictx) {
  const first = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$/.exec(lines[0] ?? '');
  const out = [];
  if (first) {
    const callout = CALLOUTS[first[1]];
    const body = [first[2], ...lines.slice(1)].filter((l, n) => n > 0 || l.trim());
    const labelled = /^\*\*[^*]+\*\*/.test(body[0] ?? '');
    const emoji = /^\*\*\s*tl;?dr/i.test(body[0] ?? '') ? '⚡' : callout.emoji;
    if (labelled) out.push(`> ${emoji} ${inline(body[0], ictx)}`, ...body.slice(1).map((l) => `> ${inline(l, ictx)}`.trimEnd()));
    else out.push(`> ${emoji} **${callout.label}**`, ...body.map((l) => `> ${inline(l, ictx)}`.trimEnd()));
  } else out.push(...lines.map((l) => `> ${inline(l, ictx)}`.trimEnd()));
  return out;
}

/** Cut text that is too long for one message at sentence, then word, boundaries. */
export function splitText(text, max = LIMIT) {
  if (text.length <= max) return [text];
  const pieces = [];
  let rest = text;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = Math.max(window.lastIndexOf('\n'), ...[...window.matchAll(/[.!?…]\s/g)].map((m) => m.index + 1));
    if (cut < max * 0.4) cut = window.lastIndexOf(' ');
    if (cut < max * 0.4) cut = max;
    pieces.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) pieces.push(rest);
  return pieces;
}

function tableAlt(block) {
  const row = (cells) => cells.map((c) => inline(c).replace(/[*_`~]/g, '')).join(' | ');
  const text = `Table. ${row(block.header)}. ${block.rows.map(row).join('. ')}`;
  return text.length > 1000 ? `${text.slice(0, 997)}...` : text;
}

function fileExt(lang) {
  return /^[a-z0-9]{1,8}$/.test(lang) ? lang : 'txt';
}

// ------------------------------------------------------------------ public: plan a whole post

export function readMinutes(body) {
  const words = String(body ?? '').replace(/<!--[\s\S]*?-->/g, ' ').split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 200));
}

function prettyDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? '');
  return m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}` : null;
}

/**
 * Plan the Discord messages for one post.
 * `post` = { slug, raw }; opts = { siteBase, label }. Returns { slug, title, date, url, placeholder, parts }.
 */
export function planPost(post, { siteBase = 'https://dex.place', label = 'read it on dex.place' } = {}) {
  const { meta, body } = parseFrontmatter(post.raw);
  const url = `${siteBase.replace(/\/$/, '')}/blog/${post.slug}/`;
  const ictx = { pageUrl: url, siteBase };

  // header: title, date and reading time, summary, link button
  const title = md(meta.title ?? post.slug);
  const date = prettyDate(meta.date);
  const header = [`# 📰 ${title}`, `-# ${[date ? `📅 ${date}` : null, `⏱️ ${readMinutes(body)} min read`].filter(Boolean).join(' · ')}`];
  if (meta.summary) header.push(`> ${md(meta.summary)}`);
  const parts = [{ kind: 'text', content: header.join('\n'), button: { label, url } }];

  const items = []; // { unit: {...} } | { part }
  let prev = null;
  let fileN = 0;
  for (const block of parseBlocks(body)) {
    if (block.type === 'heading') {
      const level = block.level <= 2 ? 2 : block.level === 3 ? 3 : 4;
      const text = inline(block.text, ictx);
      if (level === 4) items.push({ unit: { text: `**${text}**`, heading: true } });
      else {
        const emoji = headingEmoji(block.text, level);
        items.push({ unit: { text: `${'#'.repeat(level)} ${emoji ? `${emoji} ` : ''}${text}`, heading: true, section: level === 2 } });
      }
    } else if (block.type === 'paragraph') {
      const text = inline(block.text, ictx);
      const cap = (prev === 'image' || prev === 'table') && !text.includes('\n') && plainCaption(text);
      if (cap) items.push({ unit: { text: `-# ${prev === 'image' ? '🖼️' : '🗒️'} ${text}`, caption: true } });
      else for (const piece of splitText(text)) items.push({ unit: { text: piece } });
    } else if (block.type === 'list') {
      const lines = listLines(block.items, ictx);
      let group = [];
      for (const line of lines) {
        if (group.length && group.join('\n').length + line.length + 1 > LIMIT) {
          items.push({ unit: { text: group.join('\n') } });
          group = [];
        }
        group.push(line);
      }
      if (group.length) items.push({ unit: { text: group.join('\n') } });
    } else if (block.type === 'quote') {
      let group = [];
      for (const line of quoteText(block.lines, ictx)) {
        for (const piece of splitText(line, LIMIT - 10)) {
          const text = piece.startsWith('>') ? piece : `> ${piece}`;
          if (group.length && group.join('\n').length + text.length + 1 > LIMIT) {
            items.push({ unit: { text: group.join('\n') } });
            group = [];
          }
          group.push(text);
        }
      }
      if (group.length) items.push({ unit: { text: group.join('\n') } });
    } else if (block.type === 'code') {
      const cap = block.title ? `**${md(block.title)}**\n` : '';
      if (block.text.length + cap.length <= CODE_LIMIT) items.push({ unit: { text: `${cap}${codeBlock(block.text, block.lang)}` } });
      else {
        fileN += 1;
        items.push({ part: { kind: 'file', name: `${post.slug}-code-${fileN}.${fileExt(block.lang)}`, text: block.text, alt: block.title || `Code block ${fileN}` } });
        items.push({ unit: { text: `-# 📎 ${block.title ? md(block.title) : 'code block'} is attached above because it is too long for a message` } });
      }
    } else if (block.type === 'table') {
      items.push({ part: { kind: 'table', header: block.header, align: block.align, rows: block.rows, alt: tableAlt(block) } });
    } else if (block.type === 'image') {
      items.push({ part: { kind: 'media', src: block.src, alt: block.alt } });
    } else if (block.type === 'hr') {
      items.push({ part: { kind: 'break' } });
    }
    prev = block.type;
  }

  // pack units into messages; attachments and rules end the message being built
  let buf = [];
  const size = () => buf.reduce((n, u) => n + u.text.length, 0) + Math.max(0, buf.length - 1) * 2;
  const flush = () => {
    if (buf.length) parts.push({ kind: 'text', content: buf.map((u) => u.text).join('\n\n') });
    buf = [];
  };
  for (const item of items) {
    if (item.part) {
      flush();
      if (item.part.kind !== 'break') parts.push(item.part);
      continue;
    }
    const unit = item.unit;
    if (unit.section && buf.some((u) => !u.caption)) flush();
    if (buf.length && size() + 2 + unit.text.length > LIMIT) {
      const keep = [];
      while (buf.length && buf[buf.length - 1].heading) keep.unshift(buf.pop()); // a heading never ends a message
      flush();
      buf = keep;
    }
    buf.push(unit);
  }
  flush();

  parts.push({ kind: 'text', content: `-# 🔗 [${label}](${url})` });
  return { slug: post.slug, title: meta.title ?? post.slug, date: meta.date ?? null, url, placeholder: meta.placeholder === 'true', parts };
}
