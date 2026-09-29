import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { RateLimitError } from '../core/github.mjs';
import { cid } from '../core/router.mjs';
import { gh } from '../core/gitfmt.mjs';
import { churn, hexColor, md, plural, safeText, shortSha, truncate } from '../core/format.mjs';
import { redactSecrets } from '../core/redact.mjs';

// PRs, issues and CI runs for every project, posted to the project's feed channel. Merged PRs
// also go to #launch-livestream with the project's ping role. State: activity[projectKey] =
// { seededAt, pulls: {n: record}, issues: {n: record}, runs: { seen: [id], last: {slot: conclusion} }, lastIssueCheck }.

const DAY = 86_400_000;
const KEEP_CLOSED_MS = 60 * DAY; // closed PRs/issues older than this leave state
const UNSEEN_HORIZON_MS = 30 * DAY; // an unseen item's merge/close older than this is history, not news
const MAX_RUN_IDS = 200;
const MAX_RUN_SLOTS = 200;
const ISSUE_OVERLAP_MS = 60_000;
const FAILED = new Set(['failure', 'timed_out', 'startup_failure']);
const RED = 0xef4444;
const GREEN = 0x22c55e;

const time = (iso) => Date.parse(iso ?? '') || 0;
const byTime = (field) => (a, b) => time(a[field]) - time(b[field]);

// Change or event time must be after seeding and inside the horizon to count for items the
// store has never seen, so pruned records never come back as fresh news.
function freshSince(seededAt, now) {
  const floor = Math.max(time(seededAt), now - UNSEEN_HORIZON_MS);
  return (iso) => time(iso) > floor;
}

function pruneClosed(records, now) {
  const floor = now - KEEP_CLOSED_MS;
  return Object.fromEntries(
    Object.entries(records).filter(([, r]) => r.state === 'open' || time(r.closedAt ?? r.mergedAt ?? r.updatedAt) >= floor),
  );
}

// ------------------------------------------------------------------ pull requests

export function pullRecord(pr) {
  return {
    state: pr.state,
    merged: !!pr.merged_at,
    draft: !!pr.draft,
    title: pr.title ?? '',
    updatedAt: pr.updated_at ?? null,
    mergedAt: pr.merged_at ?? null,
    openedAt: pr.created_at ?? null,
    closedAt: pr.closed_at ?? null,
  };
}

function pullChange(prev, cur) {
  if (cur.merged && !prev.merged) return 'merged';
  if (cur.state === 'closed' && prev.state === 'open') return 'closed';
  if (cur.state === 'open' && prev.state === 'closed') return 'reopened';
  if (cur.state === 'open' && prev.draft && !cur.draft) return 'ready';
  return null;
}

function unseenPull(cur, fresh) {
  if (fresh(cur.openedAt)) {
    if (cur.merged) return 'merged';
    return cur.state === 'open' ? 'opened' : 'closed';
  }
  if (cur.merged) return fresh(cur.mergedAt) ? 'merged' : null;
  if (cur.state === 'closed') return fresh(cur.closedAt) ? 'closed' : null;
  return null;
}

/**
 * Compare stored PR records with a fresh list (any order). Returns { events: [{ type, number }],
 * pulls } oldest change first; type is opened | ready | merged | closed | reopened.
 */
export function diffPulls(old, list, seededAt, now = Date.now()) {
  const pulls = { ...old };
  const events = [];
  const fresh = freshSince(seededAt, now);
  for (const pr of [...list].sort(byTime('updated_at'))) {
    const prev = old[pr.number];
    const cur = pullRecord(pr);
    pulls[pr.number] = cur;
    const type = prev ? pullChange(prev, cur) : unseenPull(cur, fresh);
    if (type) events.push({ type, number: pr.number });
  }
  return { events, pulls: pruneClosed(pulls, now) };
}

// ------------------------------------------------------------------ issues

export function issueRecord(issue) {
  return {
    state: issue.state,
    title: issue.title ?? '',
    updatedAt: issue.updated_at ?? null,
    openedAt: issue.created_at ?? null,
    closedAt: issue.closed_at ?? null,
  };
}

/** Same idea as diffPulls for issues. Events: opened | closed | reopened. */
export function diffIssues(old, list, seededAt, now = Date.now()) {
  const issues = { ...old };
  const events = [];
  const fresh = freshSince(seededAt, now);
  for (const issue of [...list].sort(byTime('updated_at'))) {
    const { number } = issue;
    const prev = old[number];
    const cur = issueRecord(issue);
    issues[number] = cur;
    if (prev) {
      if (prev.state === 'open' && cur.state === 'closed') events.push({ type: 'closed', number });
      else if (prev.state === 'closed' && cur.state === 'open') events.push({ type: 'reopened', number });
    } else if (fresh(cur.openedAt)) {
      events.push({ type: 'opened', number });
      if (cur.state === 'closed') events.push({ type: 'closed', number });
    } else if (cur.state === 'closed' && fresh(cur.closedAt)) {
      events.push({ type: 'closed', number });
    }
  }
  return { events, issues: pruneClosed(issues, now) };
}

// ------------------------------------------------------------------ CI runs

// A re-run keeps its id and bumps run_attempt, so the attempt is part of the identity.
const runId = (run) => (run.run_attempt > 1 ? `${run.id}.${run.run_attempt}` : String(run.id));
const runStart = (run) => run.run_started_at ?? run.created_at;

function remember(last, slot, conclusion) {
  delete last[slot]; // re-insert so the object stays ordered oldest -> newest use
  last[slot] = conclusion;
  const keys = Object.keys(last);
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_RUN_SLOTS))) delete last[key];
}

/**
 * Completed runs started after `seededAt` that are not in state.seen. Returns { events, runs }:
 * `failed` for failure/timed_out/startup_failure, `recovered` for a success after a failure of
 * the same workflow on the same branch. Other successes only update state.
 */
export function classifyRuns(state, runs, seededAt) {
  const seen = [...(state?.seen ?? [])];
  const known = new Set(seen);
  const last = { ...(state?.last ?? {}) };
  const events = [];
  const floor = time(seededAt);
  const done = runs
    .filter((r) => r.status === 'completed' && !known.has(runId(r)) && time(runStart(r)) > floor)
    .sort((a, b) => time(runStart(a)) - time(runStart(b)));
  for (const run of done) {
    seen.push(runId(run));
    const slot = `${run.workflow_id}:${run.head_branch}`;
    if (FAILED.has(run.conclusion)) {
      events.push({ type: 'failed', run });
      remember(last, slot, 'failure');
    } else if (run.conclusion === 'success') {
      if (last[slot] === 'failure') events.push({ type: 'recovered', run });
      remember(last, slot, 'success');
    }
  }
  return { events, runs: { seen: seen.slice(-MAX_RUN_IDS), last } };
}

// ------------------------------------------------------------------ messages

/** Inline-code a repo-derived name (branch, label) safely. */
function code(text) {
  return `\`${redactSecrets(String(text ?? '?')).replace(/`/g, 'ˋ')}\``;
}

function linkButton(label, url) {
  return new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(label).setURL(url);
}

function stamp(embed, iso) {
  if (time(iso)) embed.setTimestamp(new Date(iso));
  return embed;
}

function authorOf(user) {
  return user?.login ? { name: user.login, iconURL: user.avatar_url ?? undefined, url: user.html_url ?? undefined } : null;
}

/** Add a role ping to a payload; mentions only that role. No role id, no ping. */
export function withRolePing(payload, roleId) {
  if (!roleId) return payload;
  return { ...payload, content: `<@&${roleId}>`, allowedMentions: { roles: [roleId] } };
}

const PULL_HEAD = {
  opened: (pr) => `🔀 ${pr.draft ? 'draft ' : ''}PR #${pr.number} opened`,
  ready: (pr) => `👀 PR #${pr.number} ready for review`,
  merged: (pr) => `✅ PR #${pr.number} merged into ${redactSecrets(pr.base?.ref ?? '?')}`,
  closed: (pr) => `🚪 PR #${pr.number} closed`,
  reopened: (pr) => `♻️ PR #${pr.number} reopened`,
};

const PULL_TIME = { opened: 'created_at', merged: 'merged_at', closed: 'closed_at' };

export function pullMessage(project, type, pr) {
  const url = pr.html_url ?? gh.pull(project, pr.number);
  const embed = new EmbedBuilder()
    .setColor(hexColor(project.color))
    .setTitle(truncate(`${PULL_HEAD[type](pr)}: ${safeText(pr.title, 200)}`, 256))
    .setURL(url)
    .setFooter({ text: `${project.emoji} ${project.name}` });
  stamp(embed, pr[PULL_TIME[type] ?? 'updated_at']);
  const author = authorOf(pr.user);
  if (author) embed.setAuthor(author);
  if (type === 'opened') {
    const body = safeText(pr.body, 300);
    if (body.trim()) embed.setDescription(body);
  }
  embed.addFields({ name: 'branches', value: `${code(pr.head?.ref)} → ${code(pr.base?.ref)}`, inline: true });
  if (pr.changed_files != null) {
    embed.addFields({ name: 'changes', value: `${plural(pr.changed_files, 'file')} · ${churn(pr.additions, pr.deletions)}`, inline: true });
  }
  const row = new ActionRowBuilder().addComponents(linkButton('github ↗', url));
  if ((type === 'opened' || type === 'ready') && pr.base?.sha && pr.head?.sha) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(cid('feed', 'diff', project.key, pr.base.sha.slice(0, 12), pr.head.sha.slice(0, 12)))
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('📄')
        .setLabel('diff'),
    );
  }
  return { embeds: [embed], components: [row] };
}

function issueHead(type, issue) {
  if (type === 'opened') return `📝 issue #${issue.number} opened`;
  if (type === 'reopened') return `♻️ issue #${issue.number} reopened`;
  return issue.state_reason === 'not_planned' ? `🗑️ issue #${issue.number} closed as not planned` : `☑️ issue #${issue.number} closed`;
}

export function issueMessage(project, type, issue, { closedBy = null } = {}) {
  const url = issue.html_url ?? gh.issue(project, issue.number);
  const embed = new EmbedBuilder()
    .setColor(hexColor(project.color))
    .setTitle(truncate(`${issueHead(type, issue)}: ${safeText(issue.title, 200)}`, 256))
    .setURL(url)
    .setFooter({ text: `${project.emoji} ${project.name}` });
  stamp(embed, type === 'opened' ? issue.created_at : type === 'closed' ? issue.closed_at : issue.updated_at);
  const author = authorOf(issue.user);
  if (author) embed.setAuthor(author);
  if (type === 'opened') {
    const body = safeText(issue.body, 300);
    if (body.trim()) embed.setDescription(body);
    const labels = (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean);
    if (labels.length) embed.addFields({ name: 'labels', value: truncate(labels.map(code).join(' '), 1024), inline: true });
  } else if (type === 'closed' && closedBy) {
    embed.setDescription(`closed by **${md(closedBy)}**`);
  }
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(linkButton('github ↗', url))] };
}

const CONCLUSION = { failure: 'failed', timed_out: 'timed out', startup_failure: 'failed to start' };

export function runMessage(project, type, run) {
  const name = safeText(run.name ?? 'workflow', 100);
  const branch = safeText(run.head_branch ?? '?', 100);
  const failed = type === 'failed';
  const title = failed ? `❌ ${name} failed on ${branch}` : `✅ ${name} is green again on ${branch}`;
  const sha = run.head_sha ? `[\`${shortSha(run.head_sha)}\`](${gh.commit(project, run.head_sha)}) ` : '';
  const who = run.actor?.login ? ` — ${md(run.actor.login)}` : '';
  const detail = [failed ? CONCLUSION[run.conclusion] : null, run.event, run.run_number ? `run #${run.run_number}` : null, run.run_attempt > 1 ? `attempt ${run.run_attempt}` : null]
    .filter(Boolean)
    .join(' · ');
  const embed = new EmbedBuilder()
    .setColor(failed ? RED : GREEN)
    .setTitle(truncate(title, 256))
    .setDescription(truncate(`${sha}${safeText(run.display_title, 150)}${who}\n${detail}`.trim(), 4000))
    .setFooter({ text: `${project.emoji} ${project.name}` });
  if (run.html_url) embed.setURL(run.html_url);
  stamp(embed, run.updated_at ?? runStart(run));
  const components = run.html_url ? [new ActionRowBuilder().addComponents(linkButton('run ↗', run.html_url))] : [];
  return { embeds: [embed], components };
}

// ------------------------------------------------------------------ polling

async function post(ctx, log, key, payload) {
  try {
    await ctx.guildCtx.send(key, payload);
  } catch (err) {
    log.warn(`post to #${key} failed: ${err.message}`);
  }
}

/**
 * The pulls list endpoint leaves out changed_files/additions/deletions; one GET of the PR itself
 * adds them. Any failure only costs the "changes" field, never the post.
 */
export async function withChanges(ctx, project, pr, log) {
  try {
    const { changed_files, additions, deletions } = await ctx.github.get(`/repos/${project.repo}/pulls/${pr.number}`);
    return { ...pr, changed_files, additions, deletions };
  } catch (err) {
    log.debug(`${project.key} PR #${pr.number} details: ${err.message}`);
    return pr;
  }
}

const WITH_CHANGES = new Set(['opened', 'ready']);

async function pollPulls(ctx, project, st, log) {
  const list = await ctx.github.pulls(project.repo, { state: 'all', perPage: 30 });
  if (!st.pulls) {
    st.pulls = Object.fromEntries(list.map((pr) => [pr.number, pullRecord(pr)]));
    return;
  }
  const { events, pulls } = diffPulls(st.pulls, list, st.seededAt);
  st.pulls = pulls;
  const byNumber = new Map(list.map((pr) => [pr.number, pr]));
  for (const { type, number } of events) {
    const pr = WITH_CHANGES.has(type) ? await withChanges(ctx, project, byNumber.get(number), log) : byNumber.get(number);
    await post(ctx, log, project.feedChannel, pullMessage(project, type, pr));
    if (type === 'merged') {
      await post(ctx, log, 'launch-livestream', withRolePing(pullMessage(project, type, pr), ctx.guildCtx.roleId(project.pingRole)));
    }
  }
}

async function closedByOf(ctx, project, number, log) {
  try {
    return (await ctx.github.issue(project.repo, number))?.closed_by?.login ?? null;
  } catch (err) {
    log.debug(`${project.key} issue #${number} closed_by: ${err.message}`);
    return null;
  }
}

/** Bus payload for issue:closed / issue:reopened; closed also says who closed it and why (GitHub state_reason). */
export function issueEvent(project, type, issue, closedBy = null) {
  const ref = { project: project.key, number: issue.number, title: issue.title, url: issue.html_url };
  return type === 'closed' ? { ...ref, closedBy, reason: issue.state_reason ?? null } : ref;
}

function emit(ctx, log, event, payload) {
  try {
    ctx.bus.emit(event, payload);
  } catch (err) {
    log.warn(`bus ${event} listener failed: ${err.message}`);
  }
}

async function pollIssues(ctx, project, st, log) {
  const checkedAt = new Date().toISOString();
  const since = st.lastIssueCheck ? new Date(time(st.lastIssueCheck) - ISSUE_OVERLAP_MS).toISOString() : undefined;
  const list = await ctx.github.issues(project.repo, { state: 'all', since });
  if (!st.issues) {
    st.issues = Object.fromEntries(list.map((i) => [i.number, issueRecord(i)]));
    st.lastIssueCheck = checkedAt;
    return;
  }
  const { events, issues } = diffIssues(st.issues, list, st.seededAt);
  st.issues = issues;
  st.lastIssueCheck = checkedAt;
  const byNumber = new Map(list.map((i) => [i.number, i]));
  for (const { type, number } of events) {
    const issue = byNumber.get(number);
    if (type === 'closed') {
      const closedBy = await closedByOf(ctx, project, number, log);
      await post(ctx, log, project.feedChannel, issueMessage(project, type, issue, { closedBy }));
      emit(ctx, log, 'issue:closed', issueEvent(project, type, issue, closedBy));
    } else {
      await post(ctx, log, project.feedChannel, issueMessage(project, type, issue));
      if (type === 'reopened') emit(ctx, log, 'issue:reopened', issueEvent(project, type, issue));
    }
  }
}

async function pollRuns(ctx, project, st, log) {
  const runs = (await ctx.github.runs(project.repo, { perPage: 20 }))?.workflow_runs ?? [];
  if (!st.runs) {
    st.runs = classifyRuns({}, runs, null).runs;
    return;
  }
  const { events, runs: next } = classifyRuns(st.runs, runs, st.seededAt);
  st.runs = next;
  for (const { type, run } of events) await post(ctx, log, project.feedChannel, runMessage(project, type, run));
}

const PARTS = [
  ['pulls', pollPulls],
  ['issues', pollIssues],
  ['runs', pollRuns],
];

async function cycle(ctx, log, warned) {
  const all = ctx.state.get('activity');
  for (const project of ctx.config.projects) {
    const st = (all[project.key] ??= {});
    st.seededAt ??= new Date().toISOString();
    for (const [part, poll] of PARTS) {
      const key = `${project.key} ${part}`;
      try {
        await poll(ctx, project, st, log);
        warned.delete(key);
      } catch (err) {
        if (err instanceof RateLimitError) throw err;
        // A persistent failure (say, a token without Actions access) warns once, not every cycle.
        if (warned.get(key) !== err.message) log.warn(`${key}: ${err.message}`);
        else log.debug(`${key}: ${err.message}`);
        warned.set(key, err.message);
      } finally {
        ctx.state.save('activity');
      }
    }
  }
}

export default {
  name: 'activity',
  async start(ctx) {
    const log = ctx.log.child('activity');
    const warned = new Map();
    ctx.scheduler.every('activity', ctx.config.poll.activitySeconds, () => cycle(ctx, log, warned));
  },
};
