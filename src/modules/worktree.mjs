import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { ActionRowBuilder, EmbedBuilder, MessageFlags, SlashCommandBuilder, StringSelectMenuBuilder } from 'discord.js';
import { cid } from '../core/router.mjs';
import { isStaff, requireStaff } from '../core/guild.mjs';
import { addProjectOption, getProject, UserError } from '../core/projects.mjs';
import { fileLines, splitDiff, totals, withholdSecretFiles } from '../core/gitfmt.mjs';
import { churn, fileName, hexColor, joinWithin, md, plural, safeText, shortSha, textAttachment, truncate, ts } from '../core/format.mjs';
import { isSecretPath } from '../core/redact.mjs';

// Dex's live local worktrees, uncommitted work included. Repos come only from
// config.local.localRepos; users pick a worktree by an opaque id and never pass a filesystem path.

const AUTOCOMPLETE_BUDGET_MS = 2_000;
const STATUS_TIMEOUT_MS = 15_000;
const DIFF_TIMEOUT_MS = 30_000;
const MAX_BUFFER = 64 * 1024 * 1024;
const MAX_LISTED = 25;
const MAX_UNTRACKED = 20;

// ------------------------------------------------------------------ pure helpers

/** Queue that runs at most `max` async tasks at once: `run(() => promise)`. */
export function limitConcurrency(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || !queue.length) return;
    active += 1;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        active -= 1;
        next();
      });
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
}

/** `git worktree list --porcelain` -> [{ path, head, branch, detached, bare, locked, prunable, main }]. */
export function parseWorktreePorcelain(text) {
  const out = [];
  let cur = null;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice(9), head: null, branch: null, detached: false, bare: false, locked: false, prunable: false, main: out.length === 0 };
      out.push(cur);
      continue;
    }
    if (!cur || !line) continue;
    const sp = line.indexOf(' ');
    const key = sp === -1 ? line : line.slice(0, sp);
    const value = sp === -1 ? '' : line.slice(sp + 1);
    if (key === 'HEAD') cur.head = value;
    else if (key === 'branch') cur.branch = value.replace(/^refs\/heads\//, '');
    else if (key === 'detached') cur.detached = true;
    else if (key === 'bare') cur.bare = true;
    else if (key === 'locked') cur.locked = true;
    else if (key === 'prunable') cur.prunable = true;
  }
  return out;
}

/** The "## …" header of `git status --branch`: branch, upstream, ahead/behind, gone, detached. */
export function parseBranchHeader(header) {
  const out = { branch: null, upstream: null, ahead: 0, behind: 0, gone: false, detached: false };
  let rest = String(header ?? '').trim();
  const bracket = /\s\[([^\]]*)\]$/.exec(rest);
  if (bracket) {
    rest = rest.slice(0, bracket.index);
    for (const part of bracket[1].split(',')) {
      const m = /^\s*(ahead|behind)\s+(\d+)/.exec(part);
      if (m) out[m[1]] = Number(m[2]);
      else if (part.trim() === 'gone') out.gone = true;
    }
  }
  if (rest.startsWith('HEAD (no branch)')) {
    out.detached = true;
    return out;
  }
  rest = rest.replace(/^(No commits yet on|Initial commit on) /, '');
  const dots = rest.indexOf('...');
  if (dots === -1) out.branch = rest || null;
  else {
    out.branch = rest.slice(0, dots);
    out.upstream = rest.slice(dots + 3);
  }
  return out;
}

const CONFLICT = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

/**
 * `git status --porcelain=v1 --branch -z` -> { branch, upstream, ahead, behind, gone, detached,
 * staged, modified, conflicts, untracked: [paths] }. A file can count as staged and modified.
 */
export function parseStatusPorcelain(text) {
  const s = { ...parseBranchHeader(''), staged: 0, modified: 0, conflicts: 0, untracked: [] };
  const records = String(text ?? '').split('\0');
  for (let i = 0; i < records.length; i += 1) {
    const rec = records[i];
    if (!rec) continue;
    if (rec.startsWith('## ')) {
      Object.assign(s, parseBranchHeader(rec.slice(3)));
      continue;
    }
    const xy = rec.slice(0, 2);
    if (xy === '??') {
      s.untracked.push(rec.slice(3));
      continue;
    }
    if (xy === '!!') continue;
    if (/[RC]/.test(xy)) i += 1; // with -z the rename source follows as its own record
    if (CONFLICT.has(xy)) s.conflicts += 1;
    else {
      if (xy[0] !== ' ') s.staged += 1;
      if (xy[1] !== ' ') s.modified += 1;
    }
  }
  return s;
}

/**
 * `git diff --numstat -z` -> gitfmt-style files [{ filename, previous_filename, additions,
 * deletions, changes, status, binary }]. Renames come as "a\td\t\0old\0new\0".
 */
export function parseNumstat(text) {
  const recs = String(text ?? '').split('\0');
  const files = [];
  for (let i = 0; i < recs.length; i += 1) {
    const m = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/.exec(recs[i]);
    if (!m) continue;
    let filename = m[3];
    let previous = null;
    if (filename === '') {
      previous = recs[i + 1] ?? '';
      filename = recs[i + 2] ?? '';
      i += 2;
    }
    const binary = m[1] === '-';
    const additions = binary ? 0 : Number(m[1]);
    const deletions = binary ? 0 : Number(m[2]);
    files.push({ filename, previous_filename: previous, additions, deletions, changes: additions + deletions, status: previous ? 'renamed' : 'modified', binary });
  }
  return files;
}

/** path -> 'added' | 'removed' from the per-file headers of a unified diff. */
export function patchStatuses(diffText) {
  const out = new Map();
  for (const chunk of splitDiff(String(diffText ?? ''))) {
    const header = chunk.text.split('\n@@', 1)[0];
    if (/^new file mode/m.test(header)) out.set(chunk.path, 'added');
    else if (/^deleted file mode/m.test(header)) out.set(chunk.path, 'removed');
  }
  return out;
}

/** Short stable id for a worktree path (autocomplete value); resolved back by re-listing, never used as a path. */
export function worktreeId(fullPath) {
  return createHash('sha1').update(String(fullPath)).digest('hex').slice(0, 10);
}

/** Last path segment only; full local paths never go to Discord. */
export function folderName(fullPath) {
  return String(fullPath ?? '').split(/[\\/]/).filter(Boolean).pop() ?? '?';
}

export function worktreeLabel(wt) {
  return wt.branch ?? `detached at ${shortSha(wt.head) || '???????'}`;
}

/** Optional `path` option for /worktree diff: repo-relative, no absolute paths, no `..`. */
export function checkRelPath(input) {
  const p = String(input ?? '').trim();
  if (!p) return '';
  if (/^[\\/]/.test(p) || /^[A-Za-z]:/.test(p) || /[\u0000-\u001f]/.test(p)) {
    throw new UserError('`path` is relative to the repo root, like `src/app.ts`.');
  }
  const segs = p.split(/[\\/]+/);
  if (segs.includes('..')) throw new UserError("no `..` in `path`. it stays inside the repo.");
  return segs.filter((s) => s && s !== '.').join('/');
}

/** "3 modified · 1 staged · 2 untracked · 1 conflict · 2 ahead · 1 behind" or "clean". */
export function statusSummary(s) {
  if (!s) return 'status unavailable';
  const parts = [];
  if (s.conflicts) parts.push(plural(s.conflicts, 'conflict'));
  if (s.staged) parts.push(`${s.staged} staged`);
  if (s.modified) parts.push(`${s.modified} modified`);
  if (s.untracked.length) parts.push(`${s.untracked.length} untracked`);
  if (!parts.length) parts.push('clean');
  if (s.ahead) parts.push(`${s.ahead} ahead`);
  if (s.behind) parts.push(`${s.behind} behind`);
  if (s.gone) parts.push('upstream gone');
  return parts.join(' · ');
}

/** Two lines per worktree for /worktree list. `log` is { at: epoch s, subject } or null. */
export function worktreeBlock(wt, { log = null, status = null } = {}) {
  const title = `${wt.main ? '🏠 ' : ''}**${md(worktreeLabel(wt))}** · \`${folderName(wt.path).replace(/`/g, "'")}\` · ${statusSummary(status)}`;
  const commit = log ? `${ts(log.at * 1000)} ${safeText(log.subject, 70) || '(no message)'}` : 'no commits yet';
  return `${title}\n\`${shortSha(wt.head) || '???????'}\` ${commit}`;
}

/** Main checkout first, then the most recently committed. */
export function sortWorktrees(items) {
  return [...items].sort((a, b) => Number(b.wt.main) - Number(a.wt.main) || (b.log?.at ?? 0) - (a.log?.at ?? 0));
}

// ------------------------------------------------------------------ git

const gitSlot = limitConcurrency(4);

/** The bot's own environment minus its tokens; git never needs them. */
function gitEnv() {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  delete env.DISCORD_TOKEN;
  delete env.GITHUB_TOKEN;
  return env;
}

/**
 * git with an args array (never a shell), no optional locks (Dex is working in these trees) and
 * literal pathspecs. Resolves stdout.
 */
function git(cwd, args, timeout = STATUS_TIMEOUT_MS) {
  return gitSlot(
    () =>
      new Promise((resolve, reject) => {
        execFile(
          'git',
          ['--no-optional-locks', '--literal-pathspecs', '-c', 'core.quotepath=false', ...args],
          { cwd, windowsHide: true, timeout, maxBuffer: MAX_BUFFER, encoding: 'utf8', env: gitEnv() },
          (err, stdout) => (err ? reject(err) : resolve(stdout)),
        );
      }),
  );
}

const tooBig = (err) => err?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';

/** Run git work; failures are logged in full and shown to the user without local paths. */
async function readGit(ctx, what, fn) {
  try {
    return await fn();
  } catch (err) {
    if (err?.name === 'UserError') throw err;
    ctx.log.child('worktree').warn(`${what}: ${err.killed ? 'timed out' : err.message}`);
    if (err.killed) throw new UserError(`git took too long on ${what}. try again, or narrow it with \`path\`.`);
    throw new UserError(`git couldn't read ${what}. dex's machine may be mid-something; try again in a bit.`);
  }
}

function repoPathFor(ctx, project) {
  const repo = ctx.config.local.localRepos?.[project.key];
  if (!repo) throw new UserError(`${project.name} has no local checkout configured, so there are no worktrees to show.`);
  return repo;
}

const lastLists = new Map(); // repo path -> worktrees, the autocomplete fallback while git is busy

/** Usable worktrees of a repo: no bare entries, nothing prunable, directory still on disk. */
async function listWorktrees(repo) {
  const list = parseWorktreePorcelain(await git(repo, ['worktree', 'list', '--porcelain'])).filter(
    (w) => !w.bare && !w.prunable && fs.existsSync(w.path),
  );
  lastLists.set(repo, list);
  return list;
}

async function lastCommit(wt) {
  try {
    const out = (await git(wt.path, ['log', '-1', '--format=%ct%x09%s'])).trim();
    const tab = out.indexOf('\t');
    return tab === -1 ? null : { at: Number(out.slice(0, tab)), subject: out.slice(tab + 1) };
  } catch {
    return null; // no commits yet, or a broken worktree
  }
}

function statusArgs(pathspec) {
  return ['status', '--porcelain=v1', '--branch', '-z', '--untracked-files=normal', ...pathspec];
}

async function statusOf(wt) {
  try {
    return parseStatusPorcelain(await git(wt.path, statusArgs([])));
  } catch {
    return null;
  }
}

/** deferReply, build, editReply; on failure the placeholder goes so the router's error is the only trace. */
async function replyDeferred(interaction, build) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    await interaction.editReply(await build());
  } catch (err) {
    await interaction.deleteReply().catch(() => {});
    throw err;
  }
}

function within(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ------------------------------------------------------------------ /worktree list

async function listPayload(ctx, project) {
  const repo = repoPathFor(ctx, project);
  const all = await readGit(ctx, `${project.name}'s worktrees`, () => listWorktrees(repo));
  if (!all.length) return { content: `no worktrees for ${project.name} on dex's machine right now.` };

  // Commit times are cheap and pick the 25 most recent; status is the slow part.
  const withLogs = await Promise.all(all.map(async (wt) => ({ wt, log: await lastCommit(wt) })));
  const shown = sortWorktrees(withLogs).slice(0, MAX_LISTED);
  await Promise.all(shown.map(async (item) => (item.status = await statusOf(item.wt))));

  const { text, dropped } = joinWithin(shown.map((item) => worktreeBlock(item.wt, item)), 3_900, '\n\n');
  const hidden = all.length - (shown.length - dropped);
  const footer = [`${plural(all.length, 'worktree')} on dex's machine`, 'uncommitted work included'];
  if (hidden > 0) footer.push(`${hidden} older not shown`);
  const embed = new EmbedBuilder()
    .setColor(hexColor(project.color))
    .setAuthor({ name: `${project.emoji} ${project.name}` })
    .setTitle('local worktrees, live')
    .setDescription(text)
    .setFooter({ text: footer.join(' · ') })
    .setTimestamp(new Date());

  const menu = new StringSelectMenuBuilder()
    .setCustomId(cid('worktree', 'pick', project.key))
    .setPlaceholder('diff one of these')
    .addOptions(
      shown.slice(0, 25).map((item) => ({
        label: truncate(`${worktreeLabel(item.wt)} · ${folderName(item.wt.path)}`, 100),
        value: worktreeId(item.wt.path),
        description: truncate(statusSummary(item.status), 100),
      })),
    );
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(menu)] };
}

// ------------------------------------------------------------------ /worktree diff

function checkId(value) {
  const id = String(value ?? '').trim();
  if (!/^[0-9a-f]{10}$/.test(id)) throw new UserError('pick a worktree from the list.');
  return id;
}

async function diffWorktree(ctx, project, id, relPath) {
  const repo = repoPathFor(ctx, project);
  const list = await readGit(ctx, `${project.name}'s worktrees`, () => listWorktrees(repo));
  const wt = list.find((w) => worktreeId(w.path) === id);
  if (!wt) throw new UserError("that worktree isn't there anymore (or the pick is stale). run `/worktree list` again.");
  if (!wt.head || /^0+$/.test(wt.head)) throw new UserError('that worktree has no commits yet, so there is nothing to diff against.');

  const folder = folderName(wt.path);
  const pathspec = relPath ? ['--', relPath] : [];
  // Explicit prefixes: a mnemonicPrefix/noprefix config would otherwise break per-file secret filtering.
  const diffArgs = ['diff', 'HEAD', '--no-color', '--no-ext-diff', '--no-textconv', '--submodule=short', '--src-prefix=a/', '--dst-prefix=b/'];
  const [statusOut, numstatOut, patch] = await readGit(ctx, `${worktreeLabel(wt)} · ${folder}`, () =>
    Promise.all([
      git(wt.path, statusArgs(pathspec), STATUS_TIMEOUT_MS),
      git(wt.path, [...diffArgs, '--numstat', '-z', ...pathspec], DIFF_TIMEOUT_MS),
      git(wt.path, [...diffArgs, ...pathspec], DIFF_TIMEOUT_MS).catch((err) => (tooBig(err) ? null : Promise.reject(err))),
    ]),
  );

  const status = parseStatusPorcelain(statusOut);
  const files = parseNumstat(numstatOut);
  const statuses = patchStatuses(patch ?? '');
  for (const f of files) f.status = statuses.get(f.filename) ?? f.status;
  const untracked = status.untracked.filter((p) => !isSecretPath(p.replace(/\/$/, '')));
  const hiddenUntracked = status.untracked.length - untracked.length;
  const where = relPath ? ` under \`${relPath.replace(/`/g, "'")}\`` : '';

  if (!files.length && !status.untracked.length) {
    return { content: `nothing uncommitted in **${md(worktreeLabel(wt))}** · \`${folder}\`${where}. clean tree.` };
  }

  const t = totals(files);
  const sync = [status.ahead ? `${status.ahead} ahead` : '', status.behind ? `${status.behind} behind` : '', status.gone ? 'upstream gone' : ''].filter(Boolean);
  const embed = new EmbedBuilder()
    .setColor(hexColor(project.color))
    .setAuthor({ name: `${project.emoji} ${project.name} · dex's machine` })
    .setTitle(truncate(`${worktreeLabel(wt)} · ${folder}`, 256))
    .setDescription(
      [`head \`${shortSha(wt.head)}\`${sync.length ? ` · ${sync.join(' · ')}` : ''}`, `uncommitted tracked changes vs HEAD, staged and unstaged${where ? `,${where}` : ''}.`].join('\n'),
    );
  if (files.length) {
    const fl = fileLines(files, { max: 15, maxChars: 1_000 });
    embed.addFields({ name: `${plural(t.count, 'file')} · ${churn(t.additions, t.deletions)}`, value: fl.text + (fl.more > 0 ? `\n…and ${fl.more} more` : '') || '—' });
  }
  if (untracked.length || hiddenUntracked) {
    const names = untracked.slice(0, MAX_UNTRACKED).map((p) => `\`${truncate(p, 120).replace(/`/g, "'")}\``);
    const { text, dropped } = joinWithin(names, 900, ', ');
    const extra = untracked.length - (names.length - dropped);
    const notes = [text, extra > 0 ? `…and ${extra} more` : '', hiddenUntracked ? `${hiddenUntracked} secret-looking name(s) not listed` : ''].filter(Boolean);
    embed.addFields({ name: `untracked · ${status.untracked.length} (listed, not attached)`, value: truncate(notes.join('\n'), 1_024) });
  }

  const payload = { embeds: [embed], files: [] };
  const footer = [];
  if (patch === null) footer.push('diff is over 64 MB, not attached');
  else {
    const { text: diffText, withheld } = withholdSecretFiles(patch);
    if (withheld.length) {
      embed.addFields({ name: 'withheld', value: truncate(`${withheld.length} secret-looking file(s) left out of the diff: ${withheld.map((p) => md(p)).join(', ')}`, 1_024) });
    }
    if (diffText.trim()) {
      const { file, truncated } = textAttachment(fileName(`${project.key}-${folder}-uncommitted`, 'diff'), diffText);
      payload.files.push(file);
      if (truncated) footer.push('diff cut at the upload limit');
    }
  }
  footer.push('live from the worktree, not pushed anywhere');
  embed.setFooter({ text: footer.join(' · ') });
  return payload;
}

// ------------------------------------------------------------------ autocomplete

async function autocompleteWorktree(interaction, ctx, typed) {
  const project = ctx.config.project(interaction.options.getString('project') ?? '');
  const repo = project ? ctx.config.local.localRepos?.[project.key] : null;
  if (!repo) return interaction.respond([]);
  const list = (await within(listWorktrees(repo).catch(() => null), AUTOCOMPLETE_BUDGET_MS)) ?? lastLists.get(repo) ?? [];
  const q = String(typed ?? '').toLowerCase();
  const choices = list
    .map((wt) => ({ name: truncate(`${worktreeLabel(wt)} · ${folderName(wt.path)}`, 100), value: worktreeId(wt.path) }))
    .filter((c) => c.name.toLowerCase().includes(q))
    .slice(0, 25);
  return interaction.respond(choices);
}

// ------------------------------------------------------------------ module

export default {
  name: 'worktree',

  commands: (config) => [
    new SlashCommandBuilder()
      .setName('worktree')
      .setDescription("dex's live local worktrees, uncommitted work included (staff)")
      .addSubcommand((s) => addProjectOption(s.setName('list').setDescription('every worktree: branch, last commit, uncommitted changes'), config))
      .addSubcommand((s) =>
        addProjectOption(s.setName('diff').setDescription("one worktree's uncommitted tracked changes as a .diff"), config)
          .addStringOption((o) => o.setName('worktree').setDescription('which worktree').setRequired(true).setAutocomplete(true).setMaxLength(20))
          .addStringOption((o) => o.setName('path').setDescription('only this file or folder, relative to the repo root').setMaxLength(300)),
      ),
  ],

  async onCommand(interaction, ctx) {
    if (!(await requireStaff(interaction, ctx))) return;
    const project = getProject(ctx, interaction.options.getString('project', true));
    repoPathFor(ctx, project); // config mistakes answer instantly, before the "thinking…" placeholder
    if (interaction.options.getSubcommand() === 'list') {
      await replyDeferred(interaction, () => listPayload(ctx, project));
      return;
    }
    const id = checkId(interaction.options.getString('worktree', true));
    const relPath = checkRelPath(interaction.options.getString('path'));
    await replyDeferred(interaction, () => diffWorktree(ctx, project, id, relPath));
  },

  async onAutocomplete(interaction, ctx) {
    const focused = interaction.options.getFocused(true);
    if (!isStaff(ctx, interaction.member) || focused.name !== 'worktree') return interaction.respond([]);
    return autocompleteWorktree(interaction, ctx, focused.value);
  },

  components: {
    // The select menu under /worktree list; value is a worktree id, re-resolved by listing.
    async pick(interaction, ctx, [projectKey]) {
      if (!(await requireStaff(interaction, ctx))) return;
      const project = getProject(ctx, projectKey);
      const id = checkId(interaction.values?.[0]);
      await replyDeferred(interaction, () => diffWorktree(ctx, project, id, ''));
    },
  },
};
