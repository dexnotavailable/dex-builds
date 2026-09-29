import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags, ThreadAutoArchiveDuration } from 'discord.js';
import { RateLimitError } from '../core/github.mjs';
import { requireStaff } from '../core/guild.mjs';
import { getProject, UserError } from '../core/projects.mjs';
import { cid } from '../core/router.mjs';
import { authorOf, avatarOf, commitLines, diffPayload, fileLines, gh, totals } from '../core/gitfmt.mjs';
import { LIMITS, churn, commitBody, fileName, hexColor, joinWithin, md, plural, shortSha, textAttachment, truncate } from '../core/format.mjs';
import { redactSecrets } from '../core/redact.mjs';

// The commit feed: every push to every branch of every project, one post per push in the
// project's ships channel, with diff / files / discuss buttons.

const HOUR_MS = 3_600_000;
const PUSHLOG_DAYS = 8;
const GITHUB_FILE_CAP = 300; // compare and commit responses list at most this many files
const LATEST_FALLBACK = 5; // commits shown when a compare is impossible (rewritten or unrelated history)
const SHA_RE = /^[0-9a-f]{7,40}$/i;
const THREAD_ALREADY_EXISTS = 160004; // Discord error code
const GONE = 'that commit is gone from github (force-pushed away, probably). try `/diff` on the branch.';

// ------------------------------------------------------------------ branch diffing (pure)

function globRe(pattern) {
  const src = String(pattern)
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${src}$`);
}

/** Whether a branch name matches any ignore pattern ('*' matches anything, slashes included). */
export function matchesAny(name, patterns = []) {
  return patterns.some((p) => globRe(p).test(name));
}

// `__proto__` cannot round-trip through a plain-object state map, so it would re-announce forever.
function watched(name, patterns) {
  return name !== '__proto__' && !matchesAny(name, patterns);
}

function shaOf(branch) {
  return branch.commit?.sha ?? branch.sha;
}

/** Old {name: sha} vs the current GitHub branch list -> { created, updated, deleted }. */
export function diffBranches(oldMap = {}, newItems = [], ignorePatterns = []) {
  const current = new Map();
  for (const b of newItems) if (watched(b.name, ignorePatterns)) current.set(b.name, shaOf(b));
  const created = [];
  const updated = [];
  for (const [name, sha] of current) {
    if (!Object.hasOwn(oldMap, name)) created.push({ name, sha });
    else if (oldMap[name] !== sha) updated.push({ name, from: oldMap[name], to: sha });
  }
  const deleted = Object.keys(oldMap)
    .filter((name) => !current.has(name) && watched(name, ignorePatterns))
    .sort();
  return { created, updated, deleted };
}

/** A created branch sitting exactly where a just-deleted one was is a rename, not new work. */
export function pairRenames({ created, deleted }, oldMap) {
  const left = [...deleted];
  const renamed = [];
  const stillCreated = [];
  for (const c of created) {
    const i = left.findIndex((name) => oldMap[name] === c.sha);
    if (i === -1) stillCreated.push(c);
    else renamed.push({ from: left.splice(i, 1)[0], to: c.name, sha: c.sha });
  }
  return { renamed, created: stillCreated, deleted: left };
}

/**
 * An already-announced, unchanged branch at `sha` (default branch preferred), so a fresh
 * `git checkout -b x && git push` does not repost commits the channel has already seen.
 */
export function knownTwin(sha, name, oldMap, current, defaultBranch) {
  const twins = Object.keys(oldMap).filter((n) => n !== name && oldMap[n] === sha && current.get(n) === sha);
  if (twins.includes(defaultBranch)) return defaultBranch;
  return twins.sort()[0] ?? null;
}

// ------------------------------------------------------------------ push ordering (pure)

function dateMs(value) {
  const ms = Date.parse(value ?? '');
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Oldest push first (by newest commit date). Past `cap`, the oldest pushes are folded into one
 * catch-up message posted before the full ones, so the newest activity always gets a full post.
 */
export function planPosts(pushes, cap) {
  const sorted = [...pushes].sort((a, b) => dateMs(a.date) - dateMs(b.date));
  const cut = Math.max(0, sorted.length - Math.max(0, cap));
  return { catchUp: sorted.slice(0, cut), full: sorted.slice(cut) };
}

/** Pushlog entries newer than `days`. */
export function prunePushlog(entries, now = Date.now(), days = PUSHLOG_DAYS) {
  const oldest = now - days * 86_400_000;
  return (entries ?? []).filter((e) => dateMs(e.at) >= oldest);
}

export function distinctAuthors(commits) {
  return [...new Set((commits ?? []).map(authorOf))];
}

export function commitDate(c) {
  return c?.commit?.committer?.date ?? c?.commit?.author?.date ?? null;
}

// ------------------------------------------------------------------ message builders (pure)

const code = (text) => `\`${String(text ?? '').replace(/`/g, 'ˋ')}\``;
const branchLabel = (name, max = 100) => md(truncate(name, max));

export function pushIcon(push) {
  if (push.kind === 'force' || push.kind === 'rewritten') return '⚠️';
  if (push.kind === 'created') return '🌱';
  return push.isDefault ? '🚀' : '•';
}

/** Compare URL for a range, commit URL for a single commit or when there is no base. */
export function pushUrl(project, push) {
  const single = (push.commits?.length ?? 0) === 1 && (push.total ?? 1) === 1;
  if (!push.base || single) return gh.commit(project, push.head);
  return gh.compare(project, push.base, push.head);
}

export function pushTitle(push) {
  const total = push.total ?? push.commits?.length ?? 0;
  const branch = branchLabel(push.branch, 150);
  let prefix = '';
  let core = `${plural(total, 'new commit')} → ${branch}`;
  let suffix = '';
  if (push.kind === 'rewritten') {
    prefix = '⚠️ ';
    core = `history rewritten → ${branch}`;
  } else if (push.kind === 'created' && !push.base) {
    prefix = '🌱 ';
    core = `new branch → ${branch}`;
  } else if (push.kind === 'force') {
    prefix = '⚠️ ';
    suffix = ` (force-push, ${push.dropped ?? 0} dropped)`;
  } else if (push.kind === 'created') {
    prefix = '🌱 ';
    suffix = ' (new branch)';
  } else if (push.isDefault) {
    prefix = '🚀 ';
  }
  return truncate(prefix + core, LIMITS.embedTitle - suffix.length) + suffix;
}

function contextLine(push) {
  const shown = push.commits?.length ?? 0;
  if (push.kind === 'rewritten') {
    return `old head ${code(shortSha(push.from))} no longer exists on github, so here are the latest ${plural(shown, 'commit')}.`;
  }
  if (push.kind === 'force') return `previous head ${code(shortSha(push.from))}`;
  if (push.kind === 'created' && !push.base) {
    const unrelated = push.unrelatedTo ? ` · no shared history with **${branchLabel(push.unrelatedTo)}**` : '';
    return `latest ${plural(shown, 'commit')}${unrelated}`;
  }
  if (push.kind === 'created' && push.def) return `branched off **${branchLabel(push.def)}** at ${code(shortSha(push.base))}`;
  return '';
}

/** Commit body as a quote block: trailers dropped, secrets redacted, capped at 600 chars. */
export function bodyQuote(message, max = 600) {
  const body = truncate(redactSecrets(commitBody(message)).replace(/\n{3,}/g, '\n\n'), max);
  if (!body) return '';
  return body
    .split('\n')
    .map((line) => `> ${md(line)}`)
    .join('\n');
}

function pushDescription(project, push, maxCommits) {
  const commits = push.commits ?? [];
  const known = push.total ?? commits.length;
  const context = contextLine(push);
  const quote = known === 1 && commits.length === 1 ? bodyQuote(commits[0].commit?.message) : '';
  const budget = 4000 - context.length - quote.length - 40;
  const withAuthor = distinctAuthors(commits).length > 1;
  const { text, shown } = commitLines(project, commits, { max: maxCommits, maxChars: Math.max(500, budget), withAuthor });
  const more = Math.max(0, known - shown);
  const list = [text, more > 0 ? `…and ${more} more` : ''].filter(Boolean).join('\n');
  return truncate([context, list, quote].filter(Boolean).join('\n\n'), 4000);
}

function filesField(files) {
  if (!files?.length) return null;
  const t = totals(files);
  const capped = files.length >= GITHUB_FILE_CAP;
  const fl = fileLines(files, { max: 8, maxChars: 1000 });
  const count = capped ? `${GITHUB_FILE_CAP}+ files` : plural(t.count, 'file');
  const more = fl.more > 0 ? `\n…and ${fl.more}${capped ? '+' : ''} more` : '';
  return { name: truncate(`${count} · ${churn(t.additions, t.deletions)}`, LIMITS.fieldName), value: truncate(fl.text + more, LIMITS.fieldValue) };
}

function pushButtons(project, push, url) {
  const base12 = push.base ? shortSha(push.base, 12) : '-';
  const head12 = shortSha(push.head, 12);
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(cid('feed', 'diff', project.key, base12, head12)).setLabel('diff').setEmoji('📄').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(cid('feed', 'files', project.key, base12, head12)).setLabel('files').setEmoji('📂').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(cid('feed', 'thread')).setLabel('discuss').setEmoji('💬').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(url).setLabel('github ↗'),
  );
}

/**
 * One push as a feed post. `push`: { kind: push|force|created|rewritten, branch, base, head,
 * from?, commits (oldest first), total (null when unknown), dropped?, files, isDefault, def?,
 * unrelatedTo? }.
 */
export function buildPushMessage(project, push, { maxCommits = 10 } = {}) {
  const commits = push.commits ?? [];
  const newest = commits.at(-1) ?? null;
  const url = pushUrl(project, push);
  const embed = new EmbedBuilder()
    .setColor(hexColor(project.color))
    .setTitle(pushTitle(push))
    .setURL(url)
    .setFooter({ text: truncate(`${project.name} · ${push.branch}`, 200) });
  if (newest) {
    const avatar = avatarOf(newest);
    embed.setAuthor({ name: truncate(redactSecrets(authorOf(newest)), 80), ...(avatar ? { iconURL: avatar } : {}) });
    const when = dateMs(commitDate(newest));
    if (when) embed.setTimestamp(new Date(when));
  }
  const description = pushDescription(project, push, maxCommits);
  if (description) embed.setDescription(description);
  const field = filesField(push.files);
  if (field) embed.addFields(field);
  return { embeds: [embed], components: [pushButtons(project, push, url)] };
}

function catchUpLine(project, push) {
  const parts = [];
  if (push.kind === 'rewritten') parts.push('history rewritten');
  else parts.push(plural(push.total ?? push.commits?.length ?? 0, 'commit'));
  if (push.kind === 'force') parts.push(`force-push, ${push.dropped ?? 0} dropped`);
  if (push.kind === 'created') parts.push('new branch');
  // 12-char shas keep the links short so more pushes fit in one message
  const url = pushUrl(project, { ...push, base: push.base && shortSha(push.base, 12), head: shortSha(push.head, 12) });
  return `${pushIcon(push)} **${branchLabel(push.branch, 80)}** → [${code(shortSha(push.head))}](${url}) (${parts.join(', ')})`;
}

/** Pushes past the per-cycle cap, as one compact message. */
export function buildCatchUpMessage(project, pushes) {
  const header = `📚 catch-up · ${plural(pushes.length, 'older push', 'older pushes')} on ${project.name}, squashed into one message:`;
  const { text, dropped } = joinWithin(
    pushes.map((p) => catchUpLine(project, p)),
    LIMITS.content - header.length - 40,
  );
  const content = [header, text, dropped > 0 ? `…and ${dropped} more` : ''].filter(Boolean).join('\n');
  return { content, flags: MessageFlags.SuppressEmbeds };
}

export function seedLine(project, count, defaultBranch, sha) {
  const at = sha ? ` at ${code(shortSha(sha))}` : ' (no commits yet)';
  return `👀 now watching **${md(project.name)}** · ${plural(count, 'branch', 'branches')} · default ${code(truncate(defaultBranch ?? 'none', 100))}${at}`;
}

export function resetLine(project, branch, sha, behindBy) {
  return `⏪ **${branchLabel(branch)}** was reset to [${code(shortSha(sha))}](${gh.commit(project, sha)}) (${plural(behindBy ?? 0, 'commit')} dropped)`;
}

export function newBranchLine(project, name, sha, other, behindBy = 0) {
  const where = behindBy > 0 ? `${plural(behindBy, 'commit')} behind ${branchLabel(other)}` : `same as ${branchLabel(other)}`;
  return `🌱 new branch **${branchLabel(name)}** at [${code(shortSha(sha))}](${gh.commit(project, sha)}) (${where})`;
}

export function renameLine(project, { from, to, sha }) {
  return `🔀 **${branchLabel(from)}** → **${branchLabel(to)}** (renamed, still at [${code(shortSha(sha))}](${gh.commit(project, sha)}))`;
}

export function defaultBranchLine(from, to) {
  return `🏷️ default branch is now **${branchLabel(to)}** (was ${branchLabel(from)})`;
}

export function deletedLine(names, max = 1800) {
  const head = '🗑️ deleted: ';
  const { text, dropped } = joinWithin(
    names.map((n) => branchLabel(n, 80)),
    max - head.length - 20,
    ', ',
  );
  return head + text + (dropped > 0 ? ` …and ${dropped} more` : '');
}

/** Compact lines grouped into as few messages as fit Discord's content limit. */
export function packLines(items, max = 1900) {
  const groups = [];
  let group = [];
  let len = 0;
  for (const item of items) {
    const text = truncate(item.text, max);
    const add = (group.length ? 1 : 0) + text.length;
    if (group.length && len + add > max) {
      groups.push(group);
      group = [];
      len = 0;
    }
    len += (group.length ? 1 : 0) + text.length;
    group.push({ ...item, text });
  }
  if (group.length) groups.push(group);
  return groups;
}

/** Every changed file for the 📂 button; spills into a .txt when the embed cannot hold them. */
export function buildFilesReply(project, { base, head }, files) {
  if (!files?.length) return { content: 'no file changes in that range.', embeds: [], files: [] };
  const t = totals(files);
  const capped = files.length >= GITHUB_FILE_CAP;
  const label = base ? `${shortSha(base)}…${shortSha(head)}` : shortSha(head);
  const fl = fileLines(files, { max: files.length, maxChars: 4000 });
  const embed = new EmbedBuilder()
    .setColor(hexColor(project.color))
    .setAuthor({ name: truncate(`${project.emoji} ${project.name} · ${label}`, LIMITS.embedTitle) })
    .setTitle(`${capped ? `${GITHUB_FILE_CAP}+ files` : plural(t.count, 'file')} · ${churn(t.additions, t.deletions)}`)
    .setURL(base ? gh.compare(project, base, head) : gh.commit(project, head))
    .setDescription(fl.text + (fl.more > 0 ? `\n…and ${fl.more} more in the attached list` : ''));
  if (capped) embed.setFooter({ text: `github stops listing at ${GITHUB_FILE_CAP} files; the rest is only on github` });
  const payload = { embeds: [embed], files: [] };
  if (fl.more > 0) {
    const list = files.map((f) => {
      const name = f.status === 'renamed' && f.previous_filename ? `${f.previous_filename} -> ${f.filename}` : f.filename;
      return `${String(f.status ?? '').padEnd(9)} +${f.additions ?? 0} -${f.deletions ?? 0}\t${name}`;
    });
    payload.files.push(textAttachment(fileName(`${project.key}-${label}-files`, 'txt'), `${list.join('\n')}\n`).file);
  }
  return payload;
}

/** "{branch} · {sha7}" from a feed post: branch from the footer, sha from the diff button. */
export function threadName(message) {
  const embed = message?.embeds?.[0];
  const footer = String(embed?.footer?.text ?? '');
  const cut = footer.indexOf(' · ');
  const branch = (cut >= 0 ? footer.slice(cut + 3) : '') || String(embed?.title ?? '').trim() || 'push';
  let head = null;
  for (const row of message?.components ?? []) {
    for (const c of row.components ?? []) {
      const id = c.customId ?? c.data?.custom_id ?? c.custom_id ?? '';
      if (id.startsWith('feed:diff:')) head = id.split(':')[4] ?? null;
    }
  }
  const sha = head ? ` · ${shortSha(head)}` : '';
  return truncate(branch, 100 - sha.length) + sha;
}

/** customId args [key, base|'-', head] -> { key, base, head }. */
export function parseRangeArgs([key, base, head] = []) {
  if (!key || !SHA_RE.test(head ?? '') || (base !== '-' && !SHA_RE.test(base ?? ''))) {
    throw new UserError('that button lost track of its commits. try `/diff` instead.');
  }
  return { key, base: base === '-' ? null : base, head };
}

export function pushlogEntry(project, event, at) {
  return {
    project,
    branch: event.branch,
    commits: event.commits ?? 0,
    authors: event.authors ?? [],
    additions: event.additions ?? 0,
    deletions: event.deletions ?? 0,
    at,
    forced: Boolean(event.forced),
    created: Boolean(event.created),
  };
}

function pushEvent(push) {
  const t = totals(push.files);
  return {
    branch: push.branch,
    base: push.base ?? null,
    head: push.head,
    commits: push.total ?? push.commits?.length ?? 0,
    authors: push.authors ?? distinctAuthors(push.commits),
    additions: t.additions,
    deletions: t.deletions,
    forced: push.kind === 'force' || push.kind === 'rewritten',
    created: push.kind === 'created',
  };
}

// ------------------------------------------------------------------ polling

const lastWarned = new Map();

function warnThrottled(log, key, message) {
  const now = Date.now();
  if (now - (lastWarned.get(key) ?? 0) < HOUR_MS) return;
  lastWarned.set(key, now);
  log.warn(message);
}

function isRateLimit(err) {
  return err instanceof RateLimitError || err?.name === 'RateLimitError';
}

// Compare answers 404/422 when a sha no longer exists or the histories share no ancestor.
function isMissing(err) {
  return err?.status === 404 || err?.status === 422;
}

function feedConfig(ctx) {
  const f = ctx.config.feed ?? {};
  return {
    maxCommitsPerPost: f.maxCommitsPerPost ?? 10,
    maxPushesPerCycle: f.maxPushesPerCycle ?? 12,
    ignoreBranches: f.ignoreBranches ?? [],
  };
}

function makePush(fields) {
  return { ...fields, date: commitDate(fields.commits.at(-1)) };
}

async function pushFromCompare(ctx, project, cmp, fields) {
  let commits = cmp.commits ?? [];
  const seen = [...commits];
  const total = Math.max(cmp.total_commits ?? 0, cmp.ahead_by ?? 0, commits.length);
  if (total > commits.length) {
    // Compare pages oldest-first, so a big push's newest commits need their own call.
    const recent = await ctx.github.commits(project.repo, { sha: fields.head, perPage: feedConfig(ctx).maxCommitsPerPost });
    commits = [...recent].reverse();
    seen.push(...recent);
  }
  return makePush({ ...fields, commits, total, files: cmp.files ?? [], authors: distinctAuthors(seen) });
}

async function latestCommitsPush(ctx, project, fields) {
  const recent = await ctx.github.commits(project.repo, { sha: fields.head, perPage: LATEST_FALLBACK });
  const commits = [...(recent ?? [])].reverse();
  return makePush({ ...fields, base: null, commits, total: null, files: [], authors: distinctAuthors(commits) });
}

async function describeUpdate(ctx, project, { name, from, to }, def) {
  const isDefault = name === def;
  let cmp;
  try {
    cmp = await ctx.github.compare(project.repo, from, to);
  } catch (err) {
    if (!isMissing(err)) throw err;
    return { push: await latestCommitsPush(ctx, project, { kind: 'rewritten', branch: name, from, head: to, isDefault }) };
  }
  const fields = { branch: name, from, head: to, isDefault };
  switch (cmp.status) {
    case 'ahead':
      return { push: await pushFromCompare(ctx, project, cmp, { ...fields, kind: 'push', base: from }) };
    case 'diverged':
      return {
        push: await pushFromCompare(ctx, project, cmp, { ...fields, kind: 'force', base: cmp.merge_base_commit?.sha ?? from, dropped: cmp.behind_by ?? 0 }),
      };
    case 'behind':
      return { line: resetLine(project, name, to, cmp.behind_by), event: { base: from, commits: 0, forced: true } };
    default:
      return { silent: true };
  }
}

async function describeCreated(ctx, project, { name, sha }, def, defSha) {
  const fields = { kind: 'created', branch: name, head: sha, isDefault: name === def };
  if (!defSha || name === def) return { push: await latestCommitsPush(ctx, project, fields) };
  let cmp;
  try {
    cmp = await ctx.github.compare(project.repo, defSha, sha);
  } catch (err) {
    if (!isMissing(err)) throw err;
    return { push: await latestCommitsPush(ctx, project, { ...fields, unrelatedTo: def }) };
  }
  if (!cmp.ahead_by) return { line: newBranchLine(project, name, sha, def, cmp.behind_by ?? 0), event: { base: null, commits: 0, created: true } };
  return { push: await pushFromCompare(ctx, project, cmp, { ...fields, base: cmp.merge_base_commit?.sha ?? defSha, def }) };
}

/** One branch's GitHub lookups; other errors skip the branch so it is retried next cycle. */
async function guarded(log, project, branch, fn) {
  try {
    return await fn();
  } catch (err) {
    if (isRateLimit(err)) throw err;
    warnThrottled(log, `${project.key}:branch`, `${project.name}: skipped ${branch} this cycle: ${err.message}`);
    return null;
  }
}

function record(ctx, project, event, log) {
  const pushlog = ctx.state.get('pushlog', { entries: [] });
  pushlog.entries.push(pushlogEntry(project.key, event, new Date().toISOString()));
  pushlog.entries = prunePushlog(pushlog.entries);
  const { branch, base, head, commits } = event;
  try {
    ctx.bus.emit('push', { project: project.key, branch, base, head, commits, forced: Boolean(event.forced), created: Boolean(event.created) });
  } catch (err) {
    log.warn(`a push listener failed for ${project.key}/${branch}`, err);
  }
}

function stateOps(ctx, project, head, log) {
  const move = (branch, sha, event) => {
    head.branches[branch] = sha;
    head.pushedAt[branch] = new Date().toISOString();
    if (event) record(ctx, project, { branch, head: sha, ...event }, log);
  };
  const remove = (branch) => {
    delete head.branches[branch];
    delete head.pushedAt[branch];
  };
  return { move, remove, push: (p) => move(p.branch, p.head, pushEvent(p)) };
}

function warnNoChannel(project, log) {
  warnThrottled(log, `${project.key}:channel`, `${project.name}: #${project.feedChannel} is missing; holding its pushes until the layout is re-applied`);
}

/** Post, then advance state. A failed post leaves state alone so the next cycle retries it. */
async function post(ctx, project, payload, onPosted, log) {
  let sent;
  try {
    sent = await ctx.guildCtx.send(project.feedChannel, payload);
  } catch (err) {
    warnThrottled(log, `${project.key}:post`, `${project.name}: posting to #${project.feedChannel} failed, retrying next cycle: ${err.message}`);
    return false;
  }
  // send() answers null in dry-run (fine to advance) or when the channel is gone (keep it pending)
  if (sent == null && !ctx.dryRun) {
    warnNoChannel(project, log);
    return false;
  }
  onPosted();
  ctx.state.save('heads', { immediate: true });
  ctx.state.save('pushlog');
  return true;
}

async function seedProject(ctx, project, items, def, patterns, log) {
  const now = new Date().toISOString();
  const branches = {};
  for (const { name, sha } of diffBranches({}, items, patterns).created) branches[name] = sha;
  ctx.state.get('heads', {})[project.key] = { defaultBranch: def, branches, pushedAt: {}, seededAt: now, lastCheckedAt: now };
  ctx.state.save('heads', { immediate: true });
  const content = seedLine(project, Object.keys(branches).length, def, branches[def]);
  try {
    await ctx.guildCtx.send(project.feedChannel, { content, flags: MessageFlags.SuppressEmbeds });
  } catch (err) {
    warnThrottled(log, `${project.key}:post`, `${project.name}: could not post the watch notice to #${project.feedChannel}: ${err.message}`);
  }
}

export async function pollProject(ctx, project, log) {
  // Without a channel nothing can post, so skip the GitHub work and leave every branch pending.
  if (!ctx.dryRun && !(await ctx.guildCtx.channel(project.feedChannel))) {
    warnNoChannel(project, log);
    return;
  }
  const cfg = feedConfig(ctx);
  const [{ items }, repo] = await Promise.all([ctx.github.branches(project.repo), ctx.github.repo(project.repo)]);
  const def = repo?.default_branch ?? null;
  const head = ctx.state.get('heads', {})[project.key];
  if (!head) return seedProject(ctx, project, items, def, cfg.ignoreBranches, log);

  head.branches ??= {};
  head.pushedAt ??= {};
  head.lastCheckedAt = new Date().toISOString();
  for (const name of Object.keys(head.branches)) if (!watched(name, cfg.ignoreBranches)) delete head.branches[name];
  // Diffing against state (not just GitHub's `changed` flag) also retries posts that failed earlier.
  const diff = diffBranches(head.branches, items, cfg.ignoreBranches);
  const defaultMoved = Boolean(def && head.defaultBranch && def !== head.defaultBranch);
  if (def && !head.defaultBranch) head.defaultBranch = def;
  if (!defaultMoved && !diff.created.length && !diff.updated.length && !diff.deleted.length) {
    ctx.state.save('heads');
    return;
  }
  if (!items.length) {
    warnThrottled(log, `${project.key}:empty`, `${project.name}: github listed no branches; not announcing ${diff.deleted.length} deletions`);
    return;
  }

  const ops = stateOps(ctx, project, head, log);
  const current = new Map(items.map((b) => [b.name, shaOf(b)]));
  const { renamed, created, deleted } = pairRenames(diff, head.branches);
  const pushes = [];
  const lines = [];
  const route = (result, name, sha) => {
    if (!result) return;
    if (result.push) pushes.push(result.push);
    else if (result.line) lines.push({ text: result.line, apply: () => ops.move(name, sha, result.event) });
    else ops.move(name, sha, null);
  };

  if (defaultMoved) lines.push({ text: defaultBranchLine(head.defaultBranch, def), apply: () => (head.defaultBranch = def) });
  for (const r of renamed) {
    lines.push({
      text: renameLine(project, r),
      apply: () => {
        ops.remove(r.from);
        ops.move(r.to, r.sha, { base: null, commits: 0, created: true });
      },
    });
  }
  for (const u of diff.updated) route(await guarded(log, project, u.name, () => describeUpdate(ctx, project, u, def)), u.name, u.to);
  for (const c of created) {
    const twin = knownTwin(c.sha, c.name, head.branches, current, def);
    const result = twin
      ? { line: newBranchLine(project, c.name, c.sha, twin), event: { base: null, commits: 0, created: true } }
      : await guarded(log, project, c.name, () => describeCreated(ctx, project, c, def, current.get(def)));
    route(result, c.name, c.sha);
  }
  if (deleted.length) lines.push({ text: deletedLine(deleted), apply: () => deleted.forEach(ops.remove) });

  const { catchUp, full } = planPosts(pushes, cfg.maxPushesPerCycle);
  if (catchUp.length) await post(ctx, project, buildCatchUpMessage(project, catchUp), () => catchUp.forEach(ops.push), log);
  for (const p of full) await post(ctx, project, buildPushMessage(project, p, { maxCommits: cfg.maxCommitsPerPost }), () => ops.push(p), log);
  for (const group of packLines(lines)) {
    const payload = { content: group.map((l) => l.text).join('\n'), flags: MessageFlags.SuppressEmbeds };
    await post(ctx, project, payload, () => group.forEach((l) => l.apply()), log);
  }
  ctx.state.save('heads');
}

/** One feed cycle. Per-project failures are logged (hourly at most); rate limits reach the scheduler. */
export async function pollAll(ctx, log) {
  for (const project of ctx.config.projects) {
    try {
      await pollProject(ctx, project, log);
    } catch (err) {
      if (isRateLimit(err)) throw err;
      warnThrottled(log, `${project.key}:poll`, `${project.name}: feed check failed: ${err.message}`);
    }
  }
}

// ------------------------------------------------------------------ buttons

async function onDiff(interaction, ctx, args) {
  if (!(await requireStaff(interaction, ctx))) return;
  const range = parseRangeArgs(args);
  const project = getProject(ctx, range.key);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  let payload;
  try {
    payload = await diffPayload(ctx, project, { base: range.base, head: range.head });
  } catch (err) {
    if (!isMissing(err)) throw err;
    await interaction.editReply({ content: GONE });
    return;
  }
  await interaction.editReply(payload);
}

async function onFiles(interaction, ctx, args) {
  if (!(await requireStaff(interaction, ctx))) return;
  const range = parseRangeArgs(args);
  const project = getProject(ctx, range.key);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  let meta;
  try {
    meta = range.base ? await ctx.github.compare(project.repo, range.base, range.head) : await ctx.github.commit(project.repo, range.head);
  } catch (err) {
    if (!isMissing(err)) throw err;
    await interaction.editReply({ content: GONE });
    return;
  }
  await interaction.editReply(buildFilesReply(project, range, meta.files ?? []));
}

async function onThread(interaction, ctx) {
  if (!(await requireStaff(interaction, ctx))) return;
  // startThread can queue behind Discord's per-channel rate limit, past the 3 s answer window
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const message = interaction.message;
  // A thread started from a message shares the message's id.
  const existing = () => interaction.editReply({ content: `there's already a thread: <#${message.id}>` });
  if (message.hasThread) return existing();
  let thread;
  try {
    thread = await message.startThread({
      name: threadName(message),
      autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
      reason: `feed discussion opened by ${interaction.user.username}`,
    });
  } catch (err) {
    if (err?.code === THREAD_ALREADY_EXISTS) return existing();
    throw err;
  }
  await interaction.editReply({ content: `thread's open: <#${thread.id}>` });
  try {
    await thread.members.add(interaction.user.id);
  } catch {
    // they can still open it from the link
  }
}

export default {
  name: 'feed',
  components: { diff: onDiff, files: onFiles, thread: onThread },
  async start(ctx) {
    const log = ctx.log.child('feed');
    const pushlog = ctx.state.get('pushlog', { entries: [] });
    pushlog.entries = prunePushlog(pushlog.entries);
    ctx.state.save('pushlog');
    ctx.scheduler.every('feed:commits', ctx.config.poll?.commitsSeconds ?? 60, () => pollAll(ctx, log));
  },
};
