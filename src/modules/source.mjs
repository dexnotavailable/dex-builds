import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  OverwriteType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { isStaff, requireStaff } from '../core/guild.mjs';
import { addProjectOption, addRefOption, autocompleteRef, defaultBranch, getProject, listBranches, resolveRef, UserError } from '../core/projects.mjs';
import { commitLine, diffPayload, gh } from '../core/gitfmt.mjs';
import { LIMITS, codeBlock, codeLang, fileName, hexColor, joinWithin, md, plural, safeText, shortSha, textAttachment, truncate, ts } from '../core/format.mjs';
import { isSecretPath, redactSecrets } from '../core/redact.mjs';

// Read-only views of the GitHub repos: /source, /diff, /commits, /branches (staff) and /clone
// (everyone; it only prints commands).

const AUTOCOMPLETE_BUDGET_MS = 2_200; // Discord drops autocomplete answers after 3 s
const INLINE_MAX = 1_800; // longer text goes out as an attachment with a preview
const PREVIEW_LINES = 25;
const LISTING_MAX = 60;

// ------------------------------------------------------------------ pure helpers

/** Small LRU with a TTL. `get(key, load)` shares one in-flight promise per key and forgets failures. */
export function ttlCache({ max, ttlMs, now = Date.now }) {
  const map = new Map();
  return {
    get(key, load) {
      const hit = map.get(key);
      if (hit && now() - hit.at < ttlMs) {
        map.delete(key);
        map.set(key, hit);
        return hit.promise;
      }
      const entry = { at: now(), promise: null };
      entry.promise = Promise.resolve().then(load);
      entry.promise.catch(() => {
        if (map.get(key) === entry) map.delete(key);
      });
      map.delete(key);
      map.set(key, entry);
      while (map.size > max) map.delete(map.keys().next().value);
      return entry.promise;
    },
    get size() {
      return map.size;
    },
  };
}

/** Resolves to the promise's value, or undefined when `ms` passes first. */
function within(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Repo-relative path from user input: slashes normalised, no `.`/`..` segments (they would walk the API URL). */
export function cleanPath(input) {
  const raw = String(input ?? '').trim().replace(/\\/g, '/');
  if (/[\u0000-\u001f]/.test(raw)) throw new UserError('that path has control characters in it.');
  const segs = raw.split('/').filter(Boolean);
  if (segs.some((s) => s === '..')) throw new UserError("paths are relative to the repo root and can't use `..`.");
  return segs.filter((s) => s !== '.').join('/');
}

/** A branch, tag or sha from user input, or '' when empty. Rejects what git would reject and what could walk a URL. */
export function cleanRef(input) {
  const ref = String(input ?? '').trim();
  if (!ref) return '';
  const bad =
    ref.length > 200 ||
    /[\s\u0000-\u001f\\:?*[]/.test(ref) ||
    ref.includes('..') ||
    ref.includes('@{') ||
    ref.startsWith('-') ||
    ref.split('/').some((seg) => !seg || seg.startsWith('.'));
  if (bad) throw new UserError(`${code(truncate(ref, 80))} isn't a ref git would accept. for a range, use the \`base\` option.`);
  return ref;
}

/** Branch names that are safe to paste into a shell command. */
export function shellSafeRef(ref) {
  return /^[\w.+/-]+$/.test(ref) && !ref.startsWith('-');
}

const isFullSha = (ref) => /^[0-9a-f]{40}$/i.test(ref);
const looksLikeSha = (ref) => /^[0-9a-f]{7,40}$/i.test(ref);
const displayRef = (ref) => (isFullSha(ref) ? shortSha(ref) : ref);

// redactSecrets turns a whole multi-line PEM block into one marker, which would shift every line
// number after it. Blanking the block line by line first keeps `lines` and #L anchors honest.
const PEM_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;

/** redactSecrets that keeps the line count, so line N of the output is line N of the file. */
export function redactKeepingLines(text) {
  return redactSecrets(String(text ?? '').replace(PEM_BLOCK, (block) => block.replace(/[^\n]+/g, '[redacted]')));
}

/** Inline code span. Markdown escapes would show up literally inside backticks, so only backticks are swapped. */
export function code(text) {
  return `\`${truncate(String(text ?? ''), 200).replace(/`/g, "'")}\``;
}

/** GitHub's #L anchor for a parsed `lines` range. */
export function lineAnchor(range) {
  return range.end && range.end !== range.start ? `#L${range.start}-L${range.end}` : `#L${range.start}`;
}

/**
 * `lines` option: "42", "120-180", "L120-L180" or "120-" (to the end). Blank -> null.
 * Returns { start, end } with end null for open ranges; a reversed range is swapped.
 */
export function parseLines(input) {
  const text = String(input ?? '').trim();
  if (!text) return null;
  const m = /^L?(\d+)(?:\s*(?:-|–|:|\.\.)\s*(?:L?(\d+))?)?$/i.exec(text);
  const open = m && m[2] === undefined && /[-–:.]\s*$/.test(text);
  if (!m || Number(m[1]) < 1 || (m[2] !== undefined && Number(m[2]) < 1)) {
    throw new UserError('`lines` should look like `42`, `120-180` or `120-` (to the end).');
  }
  const a = Number(m[1]);
  if (open) return { start: a, end: null };
  const b = m[2] === undefined ? a : Number(m[2]);
  return { start: Math.min(a, b), end: Math.max(a, b) };
}

/** Git's own heuristic: a NUL byte in the first 8 KB means binary. */
export function isBinary(buffer) {
  return buffer.subarray(0, 8192).includes(0);
}

export function formatBytes(n) {
  const bytes = Number(n ?? 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const basename = (p) => String(p).slice(String(p).lastIndexOf('/') + 1);

/**
 * Autocomplete ranking for tree entries ({ path, type: 'tree'|'blob' }): full-path prefix, then
 * basename prefix, then substring; shorter paths first. Directories get a trailing '/'. Secret-looking
 * files are left out (they can't be shown anyway) and so are paths over 100 chars.
 */
export function rankPaths(entries, typed, max = 25) {
  const q = String(typed ?? '').trim().replace(/\\/g, '/').replace(/^\.?\/+/, '').toLowerCase();
  const scored = [];
  for (const e of entries) {
    if (e.path.length > 100) continue;
    const dir = e.type === 'tree';
    if (!dir && isSecretPath(e.path)) continue;
    const lower = e.path.toLowerCase();
    let rank;
    if (lower.startsWith(q)) rank = 0;
    else if (basename(lower).startsWith(q)) rank = 1;
    else if (lower.includes(q)) rank = 2;
    else continue;
    scored.push({ e, dir, rank });
  }
  scored.sort((a, b) => a.rank - b.rank || a.e.path.length - b.e.path.length || a.e.path.localeCompare(b.e.path));
  return scored.slice(0, max).map(({ e, dir }) => ({ name: dir && e.path.length < 100 ? `${e.path}/` : e.path, value: e.path }));
}

/** Directory listing from the contents API: folders first, then files with sizes. Returns { text, shown, more }. */
export function renderListing(entries, { max = LISTING_MAX, maxChars = 3_800 } = {}) {
  const order = (e) => (e.type === 'dir' ? 0 : 1);
  const sorted = [...entries].sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name));
  const lines = sorted.slice(0, max).map((e) => {
    const name = md(e.name);
    if (e.type === 'dir') return `📁 ${name}/`;
    if (e.type === 'submodule') return `📦 ${name} · submodule`;
    if (e.type === 'symlink') return `🔗 ${name}`;
    return `${isSecretPath(e.path ?? e.name) ? '🔒' : '📄'} ${name} · ${formatBytes(e.size)}`;
  });
  const { text, dropped } = joinWithin(lines, maxChars);
  const shown = lines.length - dropped;
  return { text, shown, more: entries.length - shown };
}

/** Lines of `text` (a trailing newline does not count as a line) cut to `range`. Throws when the range starts past the end. */
export function sliceLines(text, range) {
  const lines = text === '' ? [] : text.split('\n');
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  const total = lines.length;
  if (!range) return { lines, start: 1, end: total, total };
  if (range.start > total) throw new UserError(`that file only has ${plural(total, 'line')}.`);
  const end = Math.min(range.end ?? total, total);
  return { lines: lines.slice(range.start - 1, end), start: range.start, end, total };
}

export function numberLines(lines, start) {
  const width = String(start + lines.length - 1).length;
  return lines.map((l, i) => `${String(start + i).padStart(width)}  ${l}`).join('\n');
}

/** "[`abc1234`](url) subject — author · <t:…:R>" lines, newest first as the commits API returns them. */
export function commitListLines(project, commits) {
  return commits.map((c) => `${commitLine(project, c, { subjectMax: 72 })} · ${ts(c.commit?.committer?.date ?? c.commit?.author?.date)}`);
}

/** "`branch` · sha7 · <t:…:R> · headline (author)"; the default branch gets a ⭐. */
export function branchLine(b, defaultBranchName) {
  const name = `\`${truncate(b.name, 70).replace(/`/g, "'")}\``;
  const parts = [`${b.name === defaultBranchName ? '⭐ ' : ''}${name}`, shortSha(b.sha) || '???????', b.committedDate ? ts(b.committedDate) : 'no date'];
  const tail = `${b.headline ? safeText(b.headline, 70) : ''}${b.author ? ` (${md(b.author)})` : ''}`.trim();
  if (tail) parts.push(tail);
  return parts.join(' · ');
}

/** Branch lines (already newest first) matching `filter`. Returns { lines, matched }. */
export function branchLines(branches, { defaultBranch: def, filter = '', max = 15 } = {}) {
  const q = String(filter ?? '').trim().toLowerCase();
  const matched = q ? branches.filter((b) => b.name.toLowerCase().includes(q)) : branches;
  return { lines: matched.slice(0, max).map((b) => branchLine(b, def)), matched: matched.length };
}

/** What the review worktree checks out (always detached): origin/HEAD, a sha as-is, or origin/<branch>. */
export function reviewTarget(branch) {
  if (!branch) return 'origin/HEAD';
  return looksLikeSha(branch) ? branch : `origin/${branch}`;
}

/**
 * Shell commands to clone a project and check a branch out as a separate review worktree.
 * `branch` null means "whatever the remote's default is". Callers validate with shellSafeRef first.
 */
export function cloneCommands(project, branch) {
  const dir = project.repo.split('/')[1];
  const review = `../${project.key}-review`;
  const target = reviewTarget(branch);
  const lines = [
    '# clone it (either works)',
    `gh repo clone ${project.repo}`,
    `git clone https://github.com/${project.repo}.git`,
    `cd ${dir}`,
    '',
    '# review a branch without touching your main checkout',
  ];
  // git can't fetch an abbreviated sha by name; a plain fetch brings every branch's commits.
  if (!branch || looksLikeSha(branch)) lines.push('git fetch origin', `git worktree add --detach ${review} ${target}`);
  else lines.push(`git fetch origin ${branch}`, `git worktree add ${review} ${target}`);
  lines.push('', '# done reviewing', `git worktree remove ${review}`);
  return lines.join('\n');
}

// ------------------------------------------------------------------ GitHub-backed helpers

const trees = ttlCache({ max: 6, ttlMs: 10 * 60_000 }); // `${repo}@${sha}` -> [{ path, type }]
const refShas = ttlCache({ max: 50, ttlMs: 10 * 60_000 }); // `${repo}@${tag or short sha}` -> sha

async function commitSha(ctx, project, ref) {
  const { branches, defaultBranch: def } = await listBranches(ctx, project);
  const name = cleanRef(ref) || def;
  const branch = branches.find((b) => b.name === name);
  if (branch) return branch.sha;
  if (isFullSha(name)) return name.toLowerCase();
  return refShas.get(`${project.repo}@${name}`, async () => (await ctx.github.commit(project.repo, name)).sha);
}

async function treeFor(ctx, project, ref) {
  const sha = await commitSha(ctx, project, ref);
  return trees.get(`${project.repo}@${sha}`, async () => {
    const res = await ctx.github.tree(project.repo, sha);
    return (res.tree ?? []).filter((e) => e.type === 'blob' || e.type === 'tree').map((e) => ({ path: e.path, type: e.type }));
  });
}

async function repoIsPrivate(ctx, project) {
  try {
    return !!(await ctx.github.repo(project.repo)).private;
  } catch {
    return true;
  }
}

/** GitHub 404/422 on a user-supplied ref or path becomes a readable UserError. */
async function orNotFound(promise, message) {
  try {
    return await promise;
  } catch (err) {
    if (err?.status === 404 || err?.status === 422) throw new UserError(message);
    throw err;
  }
}

/**
 * True when someone without the staff badge can read the interaction's channel (a thread counts as
 * its parent): any role but staff, ceo and this bot's own (@everyone included), or a member
 * overwrite for a non-staff member. Unknown channels count as open.
 */
export function openToNonStaff(interaction, ctx) {
  const { guild, client } = interaction;
  const channel = interaction.channel?.isThread?.() ? interaction.channel.parent : interaction.channel;
  if (!guild || !channel?.permissionsFor) return true;
  const view = PermissionFlagsBits.ViewChannel;
  const trusted = new Set([ctx.guildCtx.roleId('staff'), ctx.guildCtx.roleId('ceo')]);
  for (const role of guild.roles.cache.values()) {
    if (trusted.has(role.id) || role.tags?.botId === client.user.id) continue;
    if (channel.permissionsFor(role)?.has(view)) return true;
  }
  for (const ow of channel.permissionOverwrites?.cache.values() ?? []) {
    if (ow.type !== OverwriteType.Member || ow.id === client.user.id || !ow.allow.has(view)) continue;
    if (!isStaff(ctx, guild.members.cache.get(ow.id) ?? { id: ow.id })) return true;
  }
  return false;
}

/**
 * `public: true` must not put private source in front of people without the staff badge. Channels
 * they can read (#water-cooler, #rlhf …) only get public posts of public repos.
 */
async function assertCanPostPublicly(interaction, ctx, project) {
  if (!openToNonStaff(interaction, ctx)) return;
  if ((await within(repoIsPrivate(ctx, project), 1_500)) === false) return;
  const redTeam = ctx.guildCtx.channelId('red-team');
  throw new UserError(
    `people without the staff badge can read this channel and ${project.name} is private, so this one stays ephemeral. post it in ${redTeam ? `<#${redTeam}>` : 'a staff channel'} or drop \`public\`.`,
  );
}

/** deferReply, build, editReply. On failure the placeholder goes away so the router's ephemeral error is the only trace. */
async function replyDeferred(interaction, { ephemeral = true } = {}, build) {
  await interaction.deferReply(ephemeral ? { flags: MessageFlags.Ephemeral } : {});
  try {
    await interaction.editReply(await build());
  } catch (err) {
    await interaction.deleteReply().catch(() => {});
    throw err;
  }
}

function projectEmbed(project) {
  return new EmbedBuilder().setColor(hexColor(project.color)).setAuthor({ name: `${project.emoji} ${project.name}` });
}

/** A one-button row linking out, or nothing when the URL is too long for a button. */
function linkRow(url, label = 'github ↗') {
  if (!url || url.length > 512) return [];
  return [new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(label).setURL(url))];
}

const treeUrl = (project, ref, path) => (path ? `${gh.branch(project, ref)}/${encodeURI(path)}` : gh.branch(project, ref));

// ------------------------------------------------------------------ /source

function listingPayload(project, ref, path, entries) {
  const { text, more } = renderListing(entries);
  const dirs = entries.filter((e) => e.type === 'dir').length;
  const url = treeUrl(project, ref, path);
  const embed = projectEmbed(project)
    .setTitle(truncate(`${path || '/'} @ ${displayRef(ref)}`, 256))
    .setURL(url)
    .setDescription(text || '*empty folder*')
    .setFooter({ text: `${plural(dirs, 'folder')} · ${plural(entries.length - dirs, 'file')}${more > 0 ? ` · ${more} more on github` : ''}` });
  return { embeds: [embed], components: linkRow(url) };
}

async function filePayload(ctx, project, ref, path, data, range) {
  const where = code(path);
  // Before the submodule/symlink replies too: even a link target is not shown for a secret-looking name.
  if ([path, data.path, data.target].some(isSecretPath)) {
    throw new UserError(`${where} looks like it holds secrets, so it stays on github. not even ephemerally.`);
  }
  if (data.type === 'submodule') {
    return { content: `${where} is a submodule: ${safeText(data.submodule_git_url ?? '?', 300)} at ${code(shortSha(data.sha))}.` };
  }
  if (data.type === 'symlink') return { content: `${where} is a symlink to ${code(data.target ?? '?')}.` };

  const size = data.size ?? 0;
  const url = gh.blob(project, ref, path) + (range ? lineAnchor(range) : '');
  const embed = projectEmbed(project).setTitle(truncate(`${path} @ ${displayRef(ref)}`, 256)).setURL(url);
  const components = linkRow(url);

  let buf;
  if (size === 0) buf = Buffer.alloc(0);
  else if (data.encoding === 'base64' && data.content) buf = Buffer.from(data.content, 'base64');
  else buf = await ctx.github.raw(project.repo, path, ref); // over 1 MB the contents API leaves `content` empty

  if (isBinary(buf)) {
    if (buf.length > LIMITS.attachmentBytes) {
      embed.setDescription(`binary file, ${formatBytes(buf.length)}: too big for discord. it's on github.`);
      return { embeds: [embed], components };
    }
    embed.setDescription(`binary file, ${formatBytes(buf.length)}. attached as-is.`);
    return { embeds: [embed], components, files: [new AttachmentBuilder(buf, { name: fileName(basename(path)) })] };
  }

  // Text of any size: a `lines` slice of a huge file is still small, and textAttachment cuts the rest.
  let raw = buf.toString('utf8').replace(/\r\n/g, '\n');
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); // BOM
  const text = redactKeepingLines(raw);
  const view = sliceLines(text, range);
  const plain = view.lines.join('\n');
  const body = range ? numberLines(view.lines, view.start) : plain;
  const lang = codeLang(path);
  const files = [];
  const notes = [`${plural(view.total, 'line')} · ${formatBytes(size)}`];
  if (range) notes.push(view.start === view.end ? `line ${view.start}` : `lines ${view.start}–${view.end}`);

  if (body.length <= INLINE_MAX) {
    embed.setDescription(body ? codeBlock(body, lang) : '*empty file*');
  } else {
    const head = view.lines.slice(0, PREVIEW_LINES).map((l) => truncate(l, 200));
    const { text: preview } = joinWithin(range ? numberLines(head, view.start).split('\n') : head, INLINE_MAX);
    embed.setDescription(codeBlock(preview, lang));
    const { file, truncated } = textAttachment(fileName(basename(path)), `${plain}\n`);
    files.push(file);
    notes.push(`${range ? 'selection' : 'full file'} attached${truncated ? ' (cut at the upload limit)' : ''}`);
  }
  if (text !== raw) notes.push('secrets redacted');
  embed.setFooter({ text: notes.join(' · ') });
  return { embeds: [embed], components, files };
}

async function runSource(interaction, ctx) {
  if (!(await requireStaff(interaction, ctx))) return;
  const project = getProject(ctx, interaction.options.getString('project', true));
  const path = cleanPath(interaction.options.getString('path', true));
  const refIn = cleanRef(interaction.options.getString('ref'));
  const range = parseLines(interaction.options.getString('lines'));
  const pub = interaction.options.getBoolean('public') ?? false;
  if (pub) await assertCanPostPublicly(interaction, ctx, project);
  await replyDeferred(interaction, { ephemeral: !pub }, async () => {
    const ref = await resolveRef(ctx, project, refIn);
    const data = await ctx.github.contents(project.repo, path, ref);
    if (!data) throw new UserError(`nothing at ${code(path || '/')} on ${code(ref)}. check the path and the ref.`);
    if (Array.isArray(data)) return listingPayload(project, ref, path, data);
    return filePayload(ctx, project, ref, path, data, range);
  });
}

// ------------------------------------------------------------------ /diff /commits /branches /clone

async function runDiff(interaction, ctx) {
  if (!(await requireStaff(interaction, ctx))) return;
  const project = getProject(ctx, interaction.options.getString('project', true));
  const refIn = cleanRef(interaction.options.getString('ref'));
  const base = cleanRef(interaction.options.getString('base')) || null;
  const pub = interaction.options.getBoolean('public') ?? false;
  if (pub) await assertCanPostPublicly(interaction, ctx, project);
  await replyDeferred(interaction, { ephemeral: !pub }, async () => {
    const head = await resolveRef(ctx, project, refIn);
    let title;
    if (base) title = `${displayRef(base)}...${displayRef(head)}`;
    else if (!looksLikeSha(head)) title = `tip of ${head}`;
    const missing = base ? `couldn't compare ${code(base)}...${code(head)}. check both refs.` : `couldn't find ${code(head)} on github.`;
    return orNotFound(diffPayload(ctx, project, { base, head, title }), missing);
  });
}

async function runCommits(interaction, ctx) {
  if (!(await requireStaff(interaction, ctx))) return;
  const project = getProject(ctx, interaction.options.getString('project', true));
  const refIn = cleanRef(interaction.options.getString('ref'));
  const count = interaction.options.getInteger('count') ?? 10;
  const path = cleanPath(interaction.options.getString('path') ?? '');
  await replyDeferred(interaction, {}, async () => {
    const ref = await resolveRef(ctx, project, refIn);
    const list = await orNotFound(
      ctx.github.commits(project.repo, { sha: ref, perPage: count, path: path || undefined }),
      `couldn't find ${code(ref)} on github.`,
    );
    const scope = path ? ` touching ${code(path)}` : '';
    if (!list.length) return { content: `no commits on ${code(ref)}${scope}.` };
    const { text, dropped } = joinWithin(commitListLines(project, list), 4_000);
    const embed = projectEmbed(project)
      .setTitle(truncate(`${displayRef(ref)}${path ? ` · ${path}` : ''}`, 256))
      .setURL(gh.branch(project, ref))
      .setDescription(text)
      .setFooter({ text: `newest ${plural(list.length - dropped, 'commit')}${path ? ` touching ${truncate(path, 80)}` : ''}` });
    return { embeds: [embed], components: linkRow(gh.branch(project, ref), 'branch ↗') };
  });
}

async function runBranches(interaction, ctx) {
  if (!(await requireStaff(interaction, ctx))) return;
  const project = getProject(ctx, interaction.options.getString('project', true));
  const filter = interaction.options.getString('filter') ?? '';
  await replyDeferred(interaction, {}, async () => {
    const [{ totalCount, branches }, def] = await Promise.all([ctx.github.branchesByDate(project.repo), defaultBranch(ctx, project)]);
    const { lines, matched } = branchLines(branches, { defaultBranch: def, filter });
    if (!lines.length) return { content: `no branches match ${code(filter)}.` };
    const { text, dropped } = joinWithin(lines, 4_000);
    const footer = [plural(totalCount, 'branch', 'branches')];
    if (filter.trim()) footer.push(`${matched} match "${truncate(filter.trim(), 40)}"`);
    if (lines.length - dropped < matched) footer.push(`newest ${lines.length - dropped} shown`);
    const embed = projectEmbed(project).setTitle('branches, most recent first').setURL(`${gh.repo(project)}/branches/all`).setDescription(text).setFooter({ text: footer.join(' · ') });
    return { embeds: [embed], components: linkRow(`${gh.repo(project)}/branches/all`, 'all branches ↗') };
  });
}

async function runClone(interaction, ctx) {
  const project = getProject(ctx, interaction.options.getString('project', true));
  const branchIn = cleanRef(interaction.options.getString('branch'));
  if (branchIn && !shellSafeRef(branchIn)) throw new UserError("that branch name has characters i won't put in a shell command. check it out by hand.");
  await replyDeferred(interaction, {}, async () => {
    let repo = null;
    try {
      repo = await ctx.github.repo(project.repo);
    } catch (err) {
      ctx.log.child('source').warn(`/clone: repo lookup for ${project.repo} failed: ${err.message}`);
    }
    const def = repo?.default_branch && shellSafeRef(repo.default_branch) ? repo.default_branch : null;
    const branch = branchIn || def;
    let access;
    if (repo?.private === false) access = 'public repo, no access needed.';
    else if (repo?.private) access = 'private repo: you need github access first. `/access request` gets you in line.';
    else access = "if it's private you need github access first: `/access request`.";
    const content = [
      `**${project.emoji} ${project.name}** · \`${project.repo}\``,
      codeBlock(cloneCommands(project, branch), 'bash'),
      access,
      `the review worktree is its own folder at \`${reviewTarget(branch)}\`, detached, so none of your branches move and your main checkout stays untouched. \`git worktree remove\` cleans it up.`,
    ].join('\n');
    return { content: truncate(content, LIMITS.content) };
  });
}

// ------------------------------------------------------------------ autocomplete

async function autocompletePath(interaction, ctx, typed) {
  const project = ctx.config.project(interaction.options.getString('project') ?? '');
  if (!project) return interaction.respond([]);
  const ref = interaction.options.getString('ref') ?? '';
  // A slow tree keeps loading into the cache for the next keystroke.
  const entries = await within(treeFor(ctx, project, ref).catch(() => null), AUTOCOMPLETE_BUDGET_MS);
  return interaction.respond(entries ? rankPaths(entries, typed) : []);
}

async function autocompleteRefWithin(interaction, ctx) {
  const project = ctx.config.project(interaction.options.getString('project') ?? '');
  if (!project) return interaction.respond([]);
  // Warm the branch list inside the budget; autocompleteRef then answers from its cache.
  const ready = await within(listBranches(ctx, project).then(() => true, () => false), AUTOCOMPLETE_BUDGET_MS);
  if (!ready) return interaction.respond([]);
  return autocompleteRef(interaction, ctx);
}

// ------------------------------------------------------------------ module

const RUN = { source: runSource, diff: runDiff, commits: runCommits, branches: runBranches, clone: runClone };

export default {
  name: 'source',

  // Keep each project's default-branch tree warm so the first /source path keystroke answers
  // from cache (dexcode's recursive tree takes longer than the 3 s autocomplete window cold).
  async start(ctx) {
    ctx.scheduler.every(
      'source:warm-trees',
      540,
      async () => {
        for (const project of ctx.config.projects) await treeFor(ctx, project, '').catch((err) => ctx.log.child('source').warn(`tree warm-up for ${project.key} failed: ${err.message}`));
      },
      { pausable: false },
    );
  },

  commands: (config) => [
    addRefOption(
      addProjectOption(new SlashCommandBuilder().setName('source').setDescription('a file or folder from a project, at any branch or commit (staff)'), config).addStringOption((o) =>
        o.setName('path').setDescription('file or folder, e.g. src/index.ts').setRequired(true).setAutocomplete(true).setMaxLength(400),
      ),
    )
      .addStringOption((o) => o.setName('lines').setDescription('only these lines, e.g. 120-180 or 42').setMaxLength(20))
      .addBooleanOption((o) => o.setName('public').setDescription('post it in this channel instead of just to you (default: no)')),

    addRefOption(
      addRefOption(addProjectOption(new SlashCommandBuilder().setName('diff').setDescription('a commit, or a range base...ref, as a summary plus a .diff file (staff)'), config)),
      { name: 'base', description: 'compare from here (base...ref); empty = just the commit ref points at' },
    ).addBooleanOption((o) => o.setName('public').setDescription('post it in this channel instead of just to you (default: no)')),

    addRefOption(addProjectOption(new SlashCommandBuilder().setName('commits').setDescription('recent commits on a branch or commit (staff)'), config))
      .addIntegerOption((o) => o.setName('count').setDescription('how many (1-25, default 10)').setMinValue(1).setMaxValue(25))
      .addStringOption((o) => o.setName('path').setDescription('only commits touching this file or folder').setAutocomplete(true).setMaxLength(400)),

    addProjectOption(new SlashCommandBuilder().setName('branches').setDescription('branches by last activity (staff)'), config).addStringOption((o) =>
      o.setName('filter').setDescription('only branches whose name contains this').setMaxLength(100),
    ),

    addRefOption(addProjectOption(new SlashCommandBuilder().setName('clone').setDescription('how to clone a project and check a branch out as a review worktree'), config), {
      name: 'branch',
      description: 'branch to check out as a review worktree (default: the default branch)',
    }),
  ],

  async onCommand(interaction, ctx) {
    await RUN[interaction.commandName]?.(interaction, ctx);
  },

  async onAutocomplete(interaction, ctx) {
    // Paths and branch names of private repos are private too.
    if (!isStaff(ctx, interaction.member)) return interaction.respond([]);
    const focused = interaction.options.getFocused(true);
    if (focused.name === 'path') return autocompletePath(interaction, ctx, focused.value);
    return autocompleteRefWithin(interaction, ctx);
  },
};
