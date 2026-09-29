import { AttachmentBuilder, escapeMarkdown } from 'discord.js';
import { redactSecrets } from './redact.mjs';

// Discord limits (https://discord.com/developers/docs/resources/message#embed-object-embed-limits)
export const LIMITS = {
  content: 2000,
  embedTitle: 256,
  embedDescription: 4096,
  fieldName: 256,
  fieldValue: 1024,
  footer: 2048,
  embedsTotal: 6000,
  customId: 100,
  // Non-boosted servers accept 10 MiB per upload for bots; keep a margin.
  attachmentBytes: 9 * 1024 * 1024,
  autocompleteChoices: 25,
  choiceName: 100,
};

export function truncate(text, max, marker = '…') {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - marker.length)) + marker;
}

export function shortSha(sha, n = 7) {
  return String(sha ?? '').slice(0, n);
}

export function firstLine(message) {
  return String(message ?? '').split(/\r?\n/, 1)[0].trim();
}

/** Commit body without its subject line and trailing trailers like Co-Authored-By. */
export function commitBody(message) {
  const lines = String(message ?? '').split(/\r?\n/).slice(1);
  const body = lines
    .filter((l) => !/^(co-authored-by|signed-off-by|change-id):/i.test(l.trim()))
    .join('\n')
    .trim();
  return body;
}

export function hexColor(hex, fallback = 0x5b8cff) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? ''));
  return m ? parseInt(m[1], 16) : fallback;
}

/** Discord timestamp markup. style: R (relative), f (date+time), t (time), D (date). */
export function ts(date, style = 'R') {
  const ms = date instanceof Date ? date.getTime() : new Date(date).getTime();
  if (!Number.isFinite(ms)) return 'unknown time';
  return `<t:${Math.floor(ms / 1000)}:${style}>`;
}

/** Markdown-safe text for commit subjects, branch names, titles. */
export function md(text) {
  return escapeMarkdown(String(text ?? ''));
}

/** Repo-derived text for display: secrets redacted, markdown escaped, length-capped. */
export function safeText(text, max = 1000) {
  return truncate(md(redactSecrets(String(text ?? ''))), max);
}

const LANG = {
  js: 'js', mjs: 'js', cjs: 'js', jsx: 'jsx', ts: 'ts', tsx: 'tsx', mts: 'ts', cts: 'ts',
  json: 'json', jsonc: 'json', md: 'md', css: 'css', scss: 'scss', html: 'html', htm: 'html',
  py: 'py', rs: 'rust', go: 'go', java: 'java', kt: 'kotlin', cs: 'cs', cpp: 'cpp', cc: 'cpp',
  c: 'c', h: 'c', hpp: 'cpp', sh: 'bash', bash: 'bash', ps1: 'powershell', psm1: 'powershell',
  yml: 'yaml', yaml: 'yaml', toml: 'toml', ini: 'ini', xml: 'xml', svg: 'xml', sql: 'sql',
  lua: 'lua', glsl: 'glsl', hlsl: 'hlsl', vue: 'vue', svelte: 'svelte', diff: 'diff', patch: 'diff',
};

export function codeLang(path) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(path ?? ''));
  return m ? LANG[m[1].toLowerCase()] ?? '' : '';
}

/** A fenced code block that cannot be broken out of by backticks in the content. */
export function codeBlock(text, lang = '') {
  const safe = String(text ?? '').replace(/```/g, '`​``');
  return `\`\`\`${lang}\n${safe}\n\`\`\``;
}

/** Text file attachment, redacted, capped at the upload limit. Returns { file, truncated }. */
export function textAttachment(name, text, { redact = true } = {}) {
  let body = redact ? redactSecrets(String(text ?? '')) : String(text ?? '');
  let truncated = false;
  const max = LIMITS.attachmentBytes;
  if (Buffer.byteLength(body, 'utf8') > max) {
    body = Buffer.from(body, 'utf8').subarray(0, max - 200).toString('utf8');
    body += '\n\n[... truncated by GOJO: file too large for a Discord upload ...]\n';
    truncated = true;
  }
  return { file: new AttachmentBuilder(Buffer.from(body, 'utf8'), { name }), truncated };
}

/** Human +adds/-dels summary. */
export function churn(additions, deletions) {
  return `+${Number(additions ?? 0).toLocaleString('en-US')} −${Number(deletions ?? 0).toLocaleString('en-US')}`;
}

export function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

/** Join lines until adding another would pass `max`; returns { text, dropped }. */
export function joinWithin(lines, max, sep = '\n') {
  const out = [];
  let len = 0;
  for (const line of lines) {
    const add = (out.length ? sep.length : 0) + line.length;
    if (len + add > max) break;
    out.push(line);
    len += add;
  }
  return { text: out.join(sep), dropped: lines.length - out.length };
}

/** Sanitised, length-safe file name for attachments. */
export function fileName(base, ext) {
  const clean =
    String(base ?? 'file')
      .replace(/[^A-Za-z0-9._-]+/g, '_')
      .replace(/\.{2,}/g, '.')
      .replace(/^[._]+|[._]+$/g, '')
      .slice(0, 80) || 'file';
  return ext ? `${clean}.${ext}` : clean;
}
