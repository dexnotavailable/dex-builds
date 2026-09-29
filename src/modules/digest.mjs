import { EmbedBuilder, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { requireStaff } from '../core/guild.mjs';
import { churn, md, plural, truncate } from '../core/format.mjs';
import { redactSecrets } from '../core/redact.mjs';

// The daily standup in #launch-livestream: the last 24 h of pushes, PRs, deploys and open
// feedback per project, built only from other modules' state (no GitHub calls). State: digest =
// { lastPostedDate: 'YYYY-MM-DD' in the configured timezone }.

const DAY = 86_400_000;
const WINDOW_HOURS = 3; // post any time in [hour, hour + 3); a later start skips the day
const SUNRISE = 0xfbbf24;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const QUIET = [
  'quiet day. the models are resting.',
  'no pushes. alignment is going great.',
  'nothing shipped. we are calling it a safety pause.',
  'zero commits. compute was busy thinking.',
  'quiet. the board is reviewing its options.',
];

const time = (iso) => Date.parse(iso ?? '') || 0;
const inWindow = (iso, { from, to }) => {
  const t = time(iso);
  return t > from && t <= to;
};

/** Wall-clock parts of `date` in `timeZone`: { date: 'YYYY-MM-DD', year, month, day, hour, weekday }. */
export function localParts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  });
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour),
    weekday: p.weekday.toLowerCase(),
  };
}

export function shouldPost(state, parts, hour) {
  return parts.hour >= hour && parts.hour < hour + WINDOW_HOURS && state?.lastPostedDate !== parts.date;
}

export function dayOfYear(parts) {
  return Math.round((Date.UTC(parts.year, parts.month - 1, parts.day) - Date.UTC(parts.year, 0, 1)) / DAY) + 1;
}

export function quietLine(parts) {
  return QUIET[dayOfYear(parts) % QUIET.length];
}

export function standupTitle(parts) {
  return `☀️ daily standup · ${parts.weekday}, ${parts.day} ${MONTHS[parts.month - 1]}`;
}

// pushlog `commits` is a count; tolerate a list too.
const commitCount = (c) => (Array.isArray(c) ? c.length : Number(c) || 0);

/**
 * Per-project push stats for pushlog entries inside window { from, to } (epoch ms):
 * { [project]: { pushes, commits, additions, deletions, authors: [..], topBranches: [{ name, commits }] } }.
 * Entries without commits (resets, renames, new branches at an existing sha) are not pushes here.
 */
export function summarise(entries, window) {
  const acc = {};
  for (const e of entries ?? []) {
    const n = commitCount(e?.commits);
    if (!n || !e.project || !inWindow(e.at, window)) continue;
    const s = (acc[e.project] ??= { pushes: 0, commits: 0, additions: 0, deletions: 0, authors: new Set(), branches: new Map() });
    s.pushes += 1;
    s.commits += n;
    s.additions += Number(e.additions) || 0;
    s.deletions += Number(e.deletions) || 0;
    for (const a of e.authors ?? []) if (a) s.authors.add(a);
    if (e.branch) s.branches.set(e.branch, (s.branches.get(e.branch) ?? 0) + n);
  }
  return Object.fromEntries(
    Object.entries(acc).map(([key, { authors, branches, ...s }]) => [
      key,
      {
        ...s,
        authors: [...authors],
        topBranches: [...branches]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .slice(0, 3)
          .map(([name, commits]) => ({ name, commits })),
      },
    ]),
  );
}

/** PRs opened / merged inside the window, from activity[project].pulls records. */
export function countPulls(pulls, window) {
  let opened = 0;
  let merged = 0;
  for (const pr of Object.values(pulls ?? {})) {
    if (inWindow(pr.openedAt, window)) opened += 1;
    if (inWindow(pr.mergedAt, window)) merged += 1;
  }
  return { opened, merged };
}

export function countDeploys(history, window) {
  return (history ?? []).filter((h) => inWindow(h.at, window)).length;
}

/** Open (not shipped) #rlhf posts per project, from feedback.threads. */
export function openFeedback(threads) {
  const out = {};
  for (const t of Object.values(threads ?? {})) {
    if (t?.project && (t.status === 'open' || t.status === 'tracked')) out[t.project] = (out[t.project] ?? 0) + 1;
  }
  return out;
}

function code(text) {
  return `\`${redactSecrets(String(text ?? '?')).replace(/`/g, 'ˋ')}\``;
}

function names(list, max = 3) {
  const shown = list.slice(0, max).map((n) => `**${md(redactSecrets(n))}**`);
  return list.length > max ? `${shown.join(', ')} +${list.length - max}` : shown.join(', ');
}

/** One field value for a project with activity, or null when it had none. */
export function projectLines({ push, pulls, deploys }) {
  const lines = [];
  if (push?.pushes) {
    lines.push(`${plural(push.pushes, 'push', 'pushes')} · ${plural(push.commits, 'commit')} · ${churn(push.additions, push.deletions)}`);
    if (push.authors.length) lines.push(`by ${names(push.authors)}`);
    if (push.topBranches.length) lines.push(push.topBranches.map((b) => `${code(b.name)} ${b.commits}`).join(' · '));
  }
  if (pulls.opened || pulls.merged) lines.push(`PRs: ${pulls.opened} opened · ${pulls.merged} merged`);
  if (deploys) lines.push(`🌐 ${plural(deploys, 'deploy')}`);
  return lines.length ? truncate(lines.join('\n'), 1024) : null;
}

// Read another module's namespace without creating it (get() would make exists() true).
function peek(ctx, ns) {
  return ctx.state.exists(ns) ? ctx.state.get(ns) : {};
}

/** The standup message for the 24 h before `now`: { embeds }. */
export function buildStandup(ctx, now = new Date()) {
  const window = { from: now.getTime() - DAY, to: now.getTime() };
  const parts = localParts(now, ctx.config.digest?.timezone);
  const pushes = summarise(peek(ctx, 'pushlog').entries, window);
  const activity = peek(ctx, 'activity');
  const deploys = peek(ctx, 'deploys');
  const feedback = openFeedback(peek(ctx, 'feedback').threads);

  const totals = { pushes: 0, commits: 0, merged: 0, deploys: 0 };
  const fields = [];
  for (const p of ctx.config.projects) {
    const stats = {
      push: pushes[p.key],
      pulls: countPulls(activity[p.key]?.pulls, window),
      deploys: countDeploys(deploys[p.key]?.history, window),
    };
    totals.pushes += stats.push?.pushes ?? 0;
    totals.commits += stats.push?.commits ?? 0;
    totals.merged += stats.pulls.merged;
    totals.deploys += stats.deploys;
    const value = projectLines(stats);
    if (value) fields.push({ name: `${p.emoji} ${p.name}`, value });
  }

  const description = [];
  if (!fields.length) description.push(`*${quietLine(parts)}*`);
  const open = ctx.config.projects.filter((p) => feedback[p.key]).map((p) => `${p.emoji} ${feedback[p.key]}`);
  if (open.length) {
    const rlhf = ctx.guildCtx?.channelId('rlhf');
    description.push(`open in ${rlhf ? `<#${rlhf}>` : '#rlhf'}: ${open.join(' · ')}`);
  }

  const embed = new EmbedBuilder()
    .setColor(SUNRISE)
    .setTitle(standupTitle(parts))
    .setFooter({
      text: `last 24 h · ${plural(totals.pushes, 'push', 'pushes')} · ${plural(totals.commits, 'commit')} · ${totals.merged} merged · ${plural(totals.deploys, 'deploy')}`,
    })
    .setTimestamp(now);
  if (description.length) embed.setDescription(description.join('\n'));
  if (fields.length) embed.addFields(fields);
  return { embeds: [embed] };
}

async function tick(ctx, log) {
  const { hour, timezone } = ctx.config.digest;
  const now = new Date();
  const parts = localParts(now, timezone);
  const state = ctx.state.get('digest', { lastPostedDate: null });
  if (!shouldPost(state, parts, hour)) return;
  try {
    const sent = await ctx.guildCtx.send('launch-livestream', buildStandup(ctx, now));
    // null outside dry-run = the channel is missing; try again next tick instead of losing the day
    if (sent == null && !ctx.dryRun) return;
    log.info(`standup posted for ${parts.date}`);
  } catch (err) {
    // Network trouble and 5xx retry next minute; a 4xx (missing access, bad payload) would fail
    // every minute until the window closes, so that day is skipped instead.
    if (!(err.status >= 400 && err.status < 500)) throw err;
    log.warn(`standup for ${parts.date} rejected by Discord (${err.message}); skipping today`);
  }
  state.lastPostedDate = parts.date;
  ctx.state.save('digest', { immediate: true });
}

export default {
  name: 'digest',
  commands: [new SlashCommandBuilder().setName('standup').setDescription("preview today's standup digest (staff)")],

  async onCommand(interaction, ctx) {
    if (!(await requireStaff(interaction, ctx))) return;
    await interaction.reply({ ...buildStandup(ctx), flags: MessageFlags.Ephemeral });
  },

  async start(ctx) {
    const log = ctx.log.child('digest');
    const { hour, timezone } = ctx.config.digest ?? {};
    try {
      localParts(new Date(), timezone);
    } catch (err) {
      log.error(`digest.timezone "${timezone}" is not usable (${err.message}); no standups`);
      return;
    }
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
      log.error(`digest.hour "${hour}" is not an hour 0-23; no standups`);
      return;
    }
    ctx.scheduler.every('digest', 60, () => tick(ctx, log), { runAtStart: true });
  },
};
