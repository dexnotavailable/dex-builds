import fs from 'node:fs/promises';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { commitLine, commitLines, gh } from '../core/gitfmt.mjs';
import { hexColor, plural, safeText, shortSha, truncate, ts } from '../core/format.mjs';

// Live deploy announcements from local deploy state files (local.json deployStateFiles), e.g.
// dex.place's ops/deploy.mjs state.json. State: deploys[projectKey] =
// { lastSha, lastDeployedAt, lastFailedAt, seen: [sha], history: [{ sha, at }] }.

const MAX_SEEN = 30;
const MAX_HISTORY = 20;
const RED = 0xef4444;
const SHA = /^[0-9a-f]{7,40}$/i;

// Absolute Windows paths: drive-letter (D:\x, D:/x) or UNC / extended (\\server\x, \\?\D:\x).
const ABS_PATH = /(?:\\\\|\b[A-Za-z]:[\\/])[^\s'"`<>|]*/g;

const time = (iso) => Date.parse(iso ?? '') || 0;
const isSha = (v) => typeof v === 'string' && SHA.test(v);
const shaOrNull = (v) => (isSha(v) ? v.toLowerCase() : null);
// Build names come from a local file but land inside inline code in a title.
const buildName = (v, sha) => (typeof v === 'string' && v.trim() ? v.replace(/[`\s]/g, '').slice(0, 40) : shortSha(sha, 12));

/**
 * Deployer errors are raw fs/git/npm messages that often carry absolute local paths
 * ("EBUSY: … rmdir 'D:\Dex\Servers\…\node_modules\x'"). Full local paths never go to Discord,
 * so each one shrinks to its last segment.
 */
export function scrubPaths(text) {
  return String(text ?? '').replace(ABS_PATH, (p) => {
    const last = p.split(/[\\/]/).filter((s) => s && s !== '?' && !/^[A-Za-z]:$/.test(s)).pop();
    return last ? `…/${last}` : '…';
  });
}

/**
 * Parse a deploy state file ({ schema, sha, build, deployedAt, previousSha, previousBuild, heldSha,
 * history: [{ sha, build, deployedAt }], rolledBackAt?, lastFailedSha?, lastFailedAt?, lastFailedReason? }).
 * Returns a normalised object, or null when the text is not a usable state (missing, partial, garbage).
 */
export function readDeployState(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object' || !isSha(data.sha) || !time(data.deployedAt)) return null;
  const sha = data.sha.toLowerCase();
  const history = (Array.isArray(data.history) ? data.history : [])
    .filter((h) => h && isSha(h.sha) && time(h.deployedAt))
    .map((h) => ({ sha: h.sha.toLowerCase(), build: buildName(h.build, h.sha), deployedAt: h.deployedAt }));
  return {
    sha,
    build: buildName(data.build, sha),
    deployedAt: data.deployedAt,
    previousSha: shaOrNull(data.previousSha),
    previousBuild: typeof data.previousBuild === 'string' ? buildName(data.previousBuild, data.previousSha) : null,
    heldSha: shaOrNull(data.heldSha),
    rolledBackAt: time(data.rolledBackAt) ? data.rolledBackAt : null,
    history,
    lastFailedSha: shaOrNull(data.lastFailedSha),
    lastFailedAt: time(data.lastFailedAt) ? data.lastFailedAt : null,
    lastFailedReason: typeof data.lastFailedReason === 'string' ? data.lastFailedReason : null,
  };
}

/** Newest-first { sha, at } list without duplicates, capped. */
function mergeHistory(...lists) {
  const byKey = new Map();
  for (const entry of lists.flat()) byKey.set(`${entry.sha}@${entry.at}`, entry);
  return [...byKey.values()].sort((a, b) => time(b.at) - time(a.at)).slice(0, MAX_HISTORY);
}

const fileHistory = (file, since = 0) =>
  file.history.filter((h) => time(h.deployedAt) > since).map((h) => ({ sha: h.sha, at: h.deployedAt }));

/**
 * What a freshly read file means against stored state. Returns { kind, failed, from, next }:
 * kind seed (first read, silent) | none | deploy | rollback; `from` is the last announced sha;
 * `failed` is true when the file records a deploy failure newer than anything announced and
 * newer than the build that is live now (a later successful deploy supersedes it).
 */
export function classifyDeploy(state, file) {
  if (!state?.lastSha) {
    const current = { sha: file.sha, at: file.deployedAt };
    return {
      kind: 'seed',
      failed: false,
      from: null,
      next: {
        lastSha: file.sha,
        lastDeployedAt: file.deployedAt,
        lastFailedAt: file.lastFailedAt,
        seen: [...new Set([file.sha, ...file.history.map((h) => h.sha)])].slice(0, MAX_SEEN),
        history: mergeHistory([current], fileHistory(file)),
      },
    };
  }
  const failed =
    !!file.lastFailedAt && time(file.lastFailedAt) > Math.max(time(state.lastFailedAt), time(state.lastDeployedAt), time(file.deployedAt));
  const base = failed ? { ...state, lastFailedAt: file.lastFailedAt } : state;
  if (file.sha === state.lastSha) return { kind: 'none', failed, from: state.lastSha, next: base };
  const seen = state.seen ?? [];
  // The deployer's --rollback stamps rolledBackAt = deployedAt and later deploys keep the old stamp,
  // so once the field exists it decides (a --force redeploy of an old sha is not a rollback).
  // Files that never had a rollback fall back to "this sha was live before".
  const rollback = file.rolledBackAt ? file.rolledBackAt === file.deployedAt : seen.includes(file.sha);
  return {
    kind: rollback ? 'rollback' : 'deploy',
    failed,
    from: state.lastSha,
    next: {
      ...base,
      lastSha: file.sha,
      lastDeployedAt: file.deployedAt,
      seen: [file.sha, ...seen.filter((s) => s !== file.sha)].slice(0, MAX_SEEN),
      // deploys the bot missed while it was down still count for the standup
      history: mergeHistory([{ sha: file.sha, at: file.deployedAt }], fileHistory(file, time(state.lastDeployedAt)), state.history ?? []),
    },
  };
}

// ------------------------------------------------------------------ messages

function linkButton(label, url) {
  return new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(label).setURL(url);
}

function siteLabel(site) {
  try {
    return `open ${new URL(site).host}`;
  } catch {
    return 'open site';
  }
}

/** Add a role ping to a payload; mentions only that role. No role id, no ping. */
export function withRolePing(payload, roleId) {
  if (!roleId) return payload;
  return { ...payload, content: `<@&${roleId}>`, allowedMentions: { roles: [roleId] } };
}

/**
 * The #launch-livestream embed for a deploy or rollback. `commit` is the REST commit for the live
 * sha, `compare` the compare between the last announced sha and it (reversed for a rollback);
 * either may be null when GitHub was unavailable.
 */
export function deployMessage(project, file, { kind, from = null, commit = null, compare = null }) {
  const rollback = kind === 'rollback';
  const title = rollback ? `⏪ ${project.name} rolled back to build \`${file.build}\`` : `🌐 ${project.name} is live · build \`${file.build}\``;
  const parts = [commit ? commitLine(project, commit, { subjectMax: 200 }) : `[\`${shortSha(file.sha, 12)}\`](${gh.commit(project, file.sha)})`];
  const commits = compare?.commits ?? [];
  if (from && commits.length) {
    const total = compare.total_commits ?? commits.length;
    const { text, shown } = commitLines(project, commits, { max: 8, maxChars: 2500 });
    const head = rollback ? `**${plural(total, 'commit')} pulled from live**` : `**${plural(total, 'commit')} since \`${shortSha(from, 12)}\`**`;
    parts.push(`${head}\n${text}${total > shown ? `\n…and ${total - shown} more` : ''}`);
  }
  const embed = new EmbedBuilder()
    .setColor(hexColor(project.color))
    .setTitle(truncate(title, 256))
    .setDescription(truncate(parts.join('\n\n'), 4000))
    .addFields({ name: 'live since', value: `${ts(file.deployedAt, 'f')} · ${ts(file.deployedAt, 'R')}`, inline: true });
  if (time(file.deployedAt)) embed.setTimestamp(new Date(file.deployedAt));
  if (file.heldSha) {
    embed.addFields({ name: 'held', value: `\`${shortSha(file.heldSha, 12)}\` stays off live until a newer commit lands`, inline: true });
  }
  const buttons = [];
  if (project.site) buttons.push(linkButton(siteLabel(project.site), project.site));
  let url = gh.commit(project, file.sha);
  if (from && from !== file.sha) url = rollback ? gh.compare(project, file.sha, from) : gh.compare(project, from, file.sha);
  buttons.push(linkButton('github ↗', url));
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(buttons)] };
}

export function failureMessage(project, file) {
  const build = file.lastFailedSha ? ` · build \`${shortSha(file.lastFailedSha, 12)}\`` : '';
  const reason = safeText(scrubPaths(file.lastFailedReason), 300);
  const embed = new EmbedBuilder()
    .setColor(RED)
    .setTitle(truncate(`🧯 ${project.name} deploy failed${build}`, 256))
    .setDescription(truncate(`${reason ? `${reason}\n\n` : ''}live stays on \`${file.build}\`.`, 4000));
  if (time(file.lastFailedAt)) embed.setTimestamp(new Date(file.lastFailedAt));
  const components = file.lastFailedSha
    ? [new ActionRowBuilder().addComponents(linkButton('github ↗', gh.commit(project, file.lastFailedSha)))]
    : [];
  return { embeds: [embed], components };
}

// ------------------------------------------------------------------ polling

async function readFileState(path, log, key) {
  let text;
  try {
    text = await fs.readFile(path, 'utf8');
  } catch (err) {
    log.debug(`${key}: deploy state ${path} unreadable (${err.code ?? err.message})`);
    return null;
  }
  const file = readDeployState(text);
  if (!file) log.debug(`${key}: deploy state ${path} is partial or not a deploy state`);
  return file;
}

async function announce(ctx, project, file, { kind, from }, log) {
  const [commit, compare] = await Promise.allSettled([
    ctx.github.commit(project.repo, file.sha),
    from && from !== file.sha
      ? kind === 'rollback'
        ? ctx.github.compareNewest(project.repo, file.sha, from)
        : ctx.github.compareNewest(project.repo, from, file.sha)
      : Promise.resolve(null),
  ]);
  // A deploy notice without commit details beats a late one, so GitHub trouble only degrades it.
  for (const r of [commit, compare]) if (r.status === 'rejected') log.warn(`${project.key} deploy details: ${r.reason?.message}`);
  const payload = deployMessage(project, file, {
    kind,
    from,
    commit: commit.status === 'fulfilled' ? commit.value : null,
    compare: compare.status === 'fulfilled' ? compare.value : null,
  });
  await ctx.guildCtx.send('launch-livestream', withRolePing(payload, ctx.guildCtx.roleId(project.pingRole)));
}

async function checkProject(ctx, key, path, log) {
  const project = ctx.config.project(key);
  if (!project) {
    log.debug(`deployStateFiles has unknown project "${key}"`);
    return;
  }
  const file = await readFileState(path, log, key);
  if (!file) return;
  const all = ctx.state.get('deploys');
  const result = classifyDeploy(all[key], file);
  if (result.kind === 'none' && !result.failed) return;
  all[key] = result.next;
  ctx.state.save('deploys');
  if (result.kind === 'seed') {
    log.info(`${key}: seeded at build ${file.build}`);
    return;
  }
  if (result.kind !== 'none') {
    log.info(`${key}: ${result.kind} to build ${file.build}`);
    await announce(ctx, project, file, result, log);
  }
  if (result.failed) {
    // the unscrubbed reason stays in the local log only
    log.info(`${key}: deploy of ${shortSha(file.lastFailedSha, 12) || '?'} failed: ${file.lastFailedReason ?? 'no reason recorded'}`);
    await ctx.guildCtx.send('launch-livestream', failureMessage(project, file));
  }
}

async function cycle(ctx, log) {
  for (const [key, path] of Object.entries(ctx.config.local.deployStateFiles)) {
    try {
      await checkProject(ctx, key, path, log);
    } catch (err) {
      log.warn(`${key} deploy check failed: ${err.message}`);
    }
  }
}

export default {
  name: 'deploys',
  async start(ctx) {
    if (!Object.keys(ctx.config.local.deployStateFiles ?? {}).length) return;
    const log = ctx.log.child('deploys');
    ctx.scheduler.every('deploys', ctx.config.poll.deploySeconds, () => cycle(ctx, log));
  },
};
