import { EmbedBuilder, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { isStaff } from '../core/guild.mjs';
import { md, plural, shortSha, truncate, ts } from '../core/format.mjs';
import { gh } from '../core/gitfmt.mjs';
import { redactSecrets } from '../core/redact.mjs';

// /status (feeds, pushes, PRs, deploys, bot health; staff see names and shas) and /help.
// Everything comes from state and in-memory counters, so neither command calls GitHub.

const BLUE = 0x5b8cff;
const RED = 0xef4444;
const GREY = 0x8a8f98;
const STAFF_NAME = 'member of technical staff';

function time(value) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

/** Branch name as inline code: redacted, backtick-safe, length-capped. */
function refCode(name) {
  return `\`${truncate(redactSecrets(String(name)).replace(/`/g, "'"), 60)}\``;
}

/** The most recently pushed branch: { branch, at } or null. */
export function latestPush(pushedAt = {}) {
  let best = null;
  for (const [branch, at] of Object.entries(pushedAt ?? {})) {
    if (time(at) && (!best || time(at) > time(best.at))) best = { branch, at };
  }
  return best;
}

/** Open PR numbers (ascending) and how many of them are drafts, from activity `pulls`. */
export function openPulls(pulls = {}) {
  const open = Object.entries(pulls ?? {}).filter(([, p]) => p?.state === 'open');
  return {
    numbers: open.map(([n]) => Number(n)).sort((a, b) => a - b),
    drafts: open.filter(([, p]) => p.draft).length,
  };
}

export function projectStatus(project, { head, act, deploy, staff = false }) {
  const lines = [];
  if (!head?.branches) lines.push('feed not seeded yet');
  else {
    const def = head.defaultBranch;
    const sha = def ? head.branches[def] : null;
    const updatedAt = def ? head.pushedAt?.[def] : null;
    const updated = updatedAt ? ` · updated ${ts(updatedAt)}` : '';
    if (staff) lines.push(`${def ? refCode(def) : 'default branch'}${sha ? ` @ [\`${shortSha(sha)}\`](${gh.commit(project, sha)})` : ''}${updated}`);
    else lines.push(`default branch${updated || ' · no pushes seen yet'}`);
    const last = latestPush(head.pushedAt);
    const tracked = `${plural(Object.keys(head.branches).length, 'branch', 'branches')} tracked`;
    lines.push(last ? `${tracked} · last push ${staff ? `${refCode(last.branch)} ` : ''}${ts(last.at)}` : tracked);
  }
  if (!act?.pulls) lines.push('prs not seeded yet');
  else {
    const { numbers, drafts } = openPulls(act.pulls);
    if (!numbers.length) lines.push('no open prs');
    else {
      const shown = numbers.slice(-8);
      const links = staff ? `: ${numbers.length > shown.length ? '… ' : ''}${shown.map((n) => `[#${n}](${gh.pull(project, n)})`).join(' ')}` : '';
      lines.push(`${plural(numbers.length, 'open pr')}${drafts ? ` (${drafts} draft)` : ''}${links}`);
    }
  }
  if (deploy?.lastDeployedAt) {
    const sha = staff && deploy.lastSha ? `[\`${shortSha(deploy.lastSha)}\`](${gh.commit(project, deploy.lastSha)}) ` : '';
    lines.push(`deployed ${sha}${ts(deploy.lastDeployedAt)}`);
  }
  return truncate(lines.join('\n'), 1024);
}

/** One line per scheduler job. Error text is staff-only (it can name branches or paths). */
export function jobLines(jobs, { staff = false } = {}) {
  if (!jobs.length) return 'no pollers running (started with --no-poll?)';
  const lines = jobs.map((j) => {
    const name = `\`${j.name}\``;
    if (j.lastError) return `❌ ${name} ${staff ? md(truncate(redactSecrets(j.lastError), 120)) : 'failing'}`;
    if (j.running) return `⏳ ${name} running`;
    if (j.lastRun) return `✅ ${name} ${ts(j.lastRun)}`;
    return `· ${name} not run yet`;
  });
  return truncate(lines.join('\n'), 1024);
}

export function buildStatusEmbed({
  projects,
  heads = {},
  activity = {},
  deploys = {},
  jobs = [],
  rate = {},
  startedAt,
  paused = false,
  staff = false,
  staffName = STAFF_NAME,
  now = Date.now(),
}) {
  const failing = jobs.some((j) => j.lastError);
  const description = paused
    ? 'feeds are paused by the board. commands still work.'
    : failing
      ? 'something is on fire. details below.'
      : 'all systems nominal. the compute bill disagrees.';
  const embed = new EmbedBuilder()
    .setColor(paused ? GREY : failing ? RED : BLUE)
    .setTitle('📊 status')
    .setDescription(description)
    .setTimestamp(now);
  for (const p of projects) {
    embed.addFields({ name: `${p.emoji} ${p.name}`, value: projectStatus(p, { head: heads[p.key], act: activity[p.key], deploy: deploys[p.key], staff }) });
  }
  const github =
    rate?.remaining != null
      ? `github: ${Number(rate.remaining).toLocaleString('en-US')} calls left${rate.resetAt ? `, resets ${ts(rate.resetAt)}` : ''}`
      : 'github: no calls yet';
  embed.addFields(
    { name: 'gojo', value: `up since ${ts(startedAt)} · feeds ${paused ? '**paused**' : 'live'}\n${github}` },
    { name: 'pollers', value: jobLines(jobs, { staff }) },
  );
  if (!staff) embed.setFooter({ text: `counts only. branch names and shas are for ${staffName}.` });
  return embed;
}

// ------------------------------------------------------------------ help

// {key} is a channel mention by layout key; {staff} is the staff role name.
export const HELP_SECTIONS = [
  {
    title: 'everyone',
    commands: [
      ['/help', 'this list'],
      ['/status', "what shipped, what's open, whether gojo is alive"],
      ['/feedback new', 'file a bug, idea or vibe into {rlhf}'],
      ['/access request', 'ask for github access to the private repos'],
      ['/access status', 'where your access request stands'],
      ['/clone', 'how to clone a project and check a branch out as a worktree'],
    ],
  },
  {
    title: '{staff}',
    commands: [
      ['/source', 'a file or folder at any branch or commit'],
      ['/diff', 'a commit or range: summary plus a .diff file'],
      ['/commits', 'recent commits on a branch'],
      ['/branches', 'branches by last activity'],
      ['/worktree list', "dex's local worktrees"],
      ['/worktree diff', 'uncommitted tracked changes in one (secrets withheld)'],
      ['/review', 'post a review request in {red-team}'],
      ['/standup', "preview today's standup"],
      ['/feedback track', 'in an {rlhf} post: open a github issue for it'],
      ['/feedback ship', 'in an {rlhf} post: mark it shipped'],
    ],
  },
  {
    title: 'the board (owner)',
    commands: [
      ['/hire', 'give someone the {staff} badge'],
      ['/fire', 'take it back'],
      ['/access list', 'who has github access and who is waiting'],
      ['/access revoke', "remove someone's github access"],
      ['/admin', 'restart, provision, pause, resume, poll, resync'],
    ],
  },
];

function fill(text, { mention, staffName }) {
  return text.replace(/\{([a-z-]+)\}/g, (_, key) => (key === 'staff' ? staffName : mention(key)));
}

export function buildHelpEmbed({ mention = (key) => `#${key}`, staffName = STAFF_NAME } = {}) {
  const names = { mention, staffName: md(staffName) };
  return new EmbedBuilder()
    .setColor(BLUE)
    .setTitle('📖 gojo commands')
    .setDescription(
      `throughout heaven and earth, these are the only commands that matter.\nstaff commands need the **${names.staffName}** badge. owner commands need you to be the board.`,
    )
    .addFields(
      HELP_SECTIONS.map((s) => ({
        name: truncate(fill(s.title, { ...names, staffName }), 256),
        value: truncate(s.commands.map(([cmd, what]) => `\`${cmd}\` ${fill(what, names)}`).join('\n'), 1024),
      })),
    );
}

// ------------------------------------------------------------------ module

function staffName(ctx) {
  return ctx.guildCtx.role('staff')?.name ?? STAFF_NAME;
}

async function replyHelp(interaction, ctx) {
  const mention = (key) => {
    const id = ctx.guildCtx.channelId(key);
    return id ? `<#${id}>` : `#${key}`;
  };
  await interaction.reply({ embeds: [buildHelpEmbed({ mention, staffName: staffName(ctx) })], flags: MessageFlags.Ephemeral });
}

async function replyStatus(interaction, ctx) {
  const embed = buildStatusEmbed({
    projects: ctx.config.projects,
    heads: ctx.state.get('heads'),
    activity: ctx.state.get('activity'),
    deploys: ctx.state.get('deploys'),
    jobs: ctx.scheduler.status(),
    rate: ctx.github.rate,
    startedAt: ctx.startedAt,
    paused: !!ctx.flags.paused,
    staff: isStaff(ctx, interaction.member),
    staffName: staffName(ctx),
  });
  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

export default {
  name: 'status',

  commands: () => [
    new SlashCommandBuilder().setName('status').setDescription("what's shipping, what's open and whether gojo is alive"),
    new SlashCommandBuilder().setName('help').setDescription('every gojo command, grouped by who can use it'),
  ],

  async onCommand(interaction, ctx) {
    if (interaction.commandName === 'status') return replyStatus(interaction, ctx);
    if (interaction.commandName === 'help') return replyHelp(interaction, ctx);
  },

  components: {
    /** The 📖 button in #front-desk. */
    help: (interaction, ctx) => replyHelp(interaction, ctx),
  },
};
