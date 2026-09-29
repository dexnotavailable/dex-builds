import { EmbedBuilder } from 'discord.js';
import { isSecretPath, redactSecrets } from './redact.mjs';
import { churn, firstLine, hexColor, joinWithin, md, plural, shortSha, textAttachment, truncate, ts, fileName } from './format.mjs';

// Shared git presentation: commit lines, file lists and diff payloads, so the feed, /diff,
// /review and /source all look the same.

// Branch names and paths keep their '/' separators; everything else in a segment is escaped
// ('#' or '?' in a name would otherwise cut the URL short).
const segs = (s) => String(s).split('/').map(encodeURIComponent).join('/');

export const TOO_BIG_FOOTER = 'diff too large for discord. the full thing is on github.';

export const gh = {
  repo: (p) => `https://github.com/${p.repo}`,
  commit: (p, sha) => `https://github.com/${p.repo}/commit/${sha}`,
  compare: (p, base, head) => `https://github.com/${p.repo}/compare/${base}...${head}`,
  branch: (p, name) => `https://github.com/${p.repo}/tree/${segs(name)}`,
  blob: (p, ref, path) => `https://github.com/${p.repo}/blob/${segs(ref)}/${segs(path)}`,
  pull: (p, n) => `https://github.com/${p.repo}/pull/${n}`,
  issue: (p, n) => `https://github.com/${p.repo}/issues/${n}`,
};

/** Display name for a REST commit object (compare/commits endpoints). */
export function authorOf(c) {
  return c?.author?.login ?? c?.commit?.author?.name ?? 'someone';
}

export function avatarOf(c) {
  return c?.author?.avatar_url ?? null;
}

/** "[`abc1234`](url) subject — author" (+ " · <t:…:R>" with withDate) */
export function commitLine(project, c, { subjectMax = 90, withAuthor = true, withDate = false } = {}) {
  const subject = truncate(md(redactSecrets(firstLine(c.commit?.message))), subjectMax) || '(no message)';
  const who = withAuthor ? ` — ${md(authorOf(c))}` : '';
  const when = withDate && (c.commit?.committer?.date || c.commit?.author?.date) ? ` · ${ts(c.commit.committer?.date ?? c.commit.author.date)}` : '';
  return `[\`${shortSha(c.sha)}\`](${gh.commit(project, c.sha)}) ${subject}${who}${when}`;
}

/**
 * Newest-first commit lines fitted into `maxChars`. Returns { text, shown, more }.
 * `commits` may be oldest-first (compare API order); set `reverse` accordingly.
 */
export function commitLines(project, commits, { max = 10, maxChars = 3500, reverse = true, withAuthor = true, withDate = false } = {}) {
  const list = reverse ? [...commits].reverse() : [...commits];
  const lines = list.slice(0, max).map((c) => commitLine(project, c, { withAuthor, withDate }));
  const { text, dropped } = joinWithin(lines, maxChars);
  const shown = lines.length - dropped;
  return { text, shown, more: commits.length - shown };
}

const STATUS_ICON = { added: '🟢', modified: '🟡', removed: '🔴', renamed: '🔵', copied: '🔵', changed: '🟡', unchanged: '⚪' };

/** "🟡 `+12 −3` path" lines for compare/commit `files`. */
export function fileLines(files, { max = 15, maxChars = 1000 } = {}) {
  const sorted = [...(files ?? [])].sort((a, b) => (b.changes ?? 0) - (a.changes ?? 0));
  const lines = sorted.slice(0, max).map((f) => {
    const name = f.status === 'renamed' && f.previous_filename ? `${f.previous_filename} → ${f.filename}` : f.filename;
    return `${STATUS_ICON[f.status] ?? '⚪'} \`${churn(f.additions, f.deletions)}\` ${md(truncate(name, 120))}`;
  });
  const { text, dropped } = joinWithin(lines, maxChars);
  const shown = lines.length - dropped;
  return { text, shown, more: (files?.length ?? 0) - shown };
}

export function totals(files) {
  let additions = 0;
  let deletions = 0;
  for (const f of files ?? []) {
    additions += f.additions ?? 0;
    deletions += f.deletions ?? 0;
  }
  return { additions, deletions, count: files?.length ?? 0 };
}

/** Split a unified diff into per-file chunks: [{ path, text }]. */
export function splitDiff(diffText) {
  const chunks = [];
  const re = /^diff --git a\/(.+?) b\/(.+)$/gm;
  const starts = [];
  let m;
  while ((m = re.exec(diffText)) !== null) starts.push({ index: m.index, path: m[2] });
  for (let i = 0; i < starts.length; i += 1) {
    const end = i + 1 < starts.length ? starts[i + 1].index : diffText.length;
    chunks.push({ path: starts[i].path, text: diffText.slice(starts[i].index, end) });
  }
  if (!starts.length && diffText.trim()) chunks.push({ path: '', text: diffText });
  return chunks;
}

/** Drop per-file chunks whose path looks like a secret store. Returns { text, withheld: [paths] }. */
export function withholdSecretFiles(diffText) {
  const withheld = [];
  const kept = [];
  for (const chunk of splitDiff(diffText)) {
    if (chunk.path && isSecretPath(chunk.path)) withheld.push(chunk.path);
    else kept.push(chunk.text);
  }
  return { text: kept.join(''), withheld };
}

/**
 * Everything needed to show a change in Discord: a summary embed plus a .diff attachment.
 * `base` null means a single commit (`head`). Diff text is secret-filtered and redacted.
 * `diff: false` skips the attachment. When GitHub refuses the raw diff as too large (406), the
 * summary still goes out with a note instead of failing.
 */
export async function diffPayload(ctx, project, { base = null, head, title, diff = true } = {}) {
  const tooLarge = (err) => {
    if (err?.status === 406) return null;
    throw err;
  };
  let meta;
  let raw;
  if (base) {
    [meta, raw] = await Promise.all([
      ctx.github.compareNewest ? ctx.github.compareNewest(project.repo, base, head) : ctx.github.compare(project.repo, base, head),
      diff ? ctx.github.compareDiff(project.repo, base, head).catch(tooLarge) : '',
    ]);
  } else {
    [meta, raw] = await Promise.all([ctx.github.commit(project.repo, head), diff ? ctx.github.commitDiff(project.repo, head).catch(tooLarge) : '']);
  }
  const diffRefused = raw === null;
  const files = meta.files ?? [];
  const t = totals(files);
  const { text: diffText, withheld } = withholdSecretFiles(raw ?? '');
  const embed = new EmbedBuilder()
    .setColor(hexColor(project.color))
    .setAuthor({ name: `${project.emoji} ${project.name}` })
    .setTitle(truncate(title ?? (base ? `${shortSha(base)}…${shortSha(head)}` : `commit ${shortSha(head)}`), 256))
    .setURL(base ? gh.compare(project, base, head) : gh.commit(project, head));
  const parts = [];
  if (base) {
    const commits = meta.commits ?? [];
    const { text, more } = commitLines(project, commits, { max: 10, maxChars: 2500 });
    parts.push(`**${plural(meta.total_commits ?? commits.length, 'commit')}** · ${meta.status ?? ''}`.trim());
    if (text) parts.push(text + (more > 0 ? `\n…and ${more} more` : ''));
  } else {
    parts.push(commitLine(project, meta, { subjectMax: 200 }));
  }
  const fl = fileLines(files, { max: 12, maxChars: 1000 });
  embed.setDescription(truncate(parts.join('\n\n'), 4000));
  if (fl.text) embed.addFields({ name: `${plural(t.count, 'file')} · ${churn(t.additions, t.deletions)}`, value: fl.text + (fl.more > 0 ? `\n…and ${fl.more} more` : '') });
  if (withheld.length) embed.addFields({ name: 'withheld', value: truncate(`${withheld.length} secret-looking file(s) left out of the diff: ${withheld.map((p) => md(p)).join(', ')}`, 1000) });

  const payload = { embeds: [embed], files: [] };
  if (diffText.trim()) {
    const name = fileName(`${project.key}-${base ? `${shortSha(base)}-${shortSha(head)}` : shortSha(head)}`, 'diff');
    const { file, truncated } = textAttachment(name, diffText);
    payload.files.push(file);
    if (truncated) embed.setFooter({ text: 'diff truncated to fit Discord’s upload limit; the full one is on GitHub' });
  } else if (diffRefused) {
    embed.setFooter({ text: TOO_BIG_FOOTER });
  } else if (diff && !files.length) {
    embed.setFooter({ text: 'no file changes' });
  }
  return payload;
}
