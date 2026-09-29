import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  ThreadAutoArchiveDuration,
} from 'discord.js';
import { cid } from '../core/router.mjs';
import { isStaff, requireStaff } from '../core/guild.mjs';
import { GitHubError } from '../core/github.mjs';
import { addProjectOption, addRefOption, autocompleteRef, getProject, listBranches, UserError } from '../core/projects.mjs';
import { diffPayload, gh, TOO_BIG_FOOTER } from '../core/gitfmt.mjs';
import { redactSecrets } from '../core/redact.mjs';
import { shortSha, truncate } from '../core/format.mjs';

// /review: a review request in #red-team with the diff, a discussion thread and verdict buttons.
// State `reviews`: { [messageId]: { project, base, head, label, pr, requestedBy, verdicts: {userId: verdict}, createdAt } }

export const VERDICTS = {
  ok: { emoji: '✅', label: 'looks good' },
  changes: { emoji: '🔧', label: 'needs changes' },
};

const MAX_REVIEWS = 500;
const HOW_TO = 'comment on the diff here, then vote on the post: ✅ looks good or 🔧 needs changes. one vote each; the last click counts.';
export { TOO_BIG_FOOTER };
const AUTOCOMPLETE_BUDGET_MS = 2_200; // Discord drops autocomplete answers after 3 s

const SHA_RE = /^[0-9a-f]{7,40}$/i;

/** "#12" or "12" -> 12; anything else (branch, sha) -> null. Seven+ digits read as a sha, not a PR. */
export function parsePullRef(ref) {
  const m = /^#?(\d{1,6})$/.exec(String(ref ?? '').trim());
  return m ? Number(m[1]) : null;
}

/**
 * What to diff for a non-PR ref. Branch names are pinned to their current sha so the review keeps
 * pointing at what was asked for. Without a base the default branch is the base, unless the head
 * is the default branch's own commit, in which case that single commit is reviewed (base null).
 * `containedSha`: the head's full sha when a compare showed the default branch already contains it
 * (nothing to compare against), so that commit is reviewed on its own too.
 * `branches`: [{ name, sha }].
 */
export function planReview({ ref, base = null, defaultBranch, branches = [], containedSha = null }) {
  const shaOf = (name) => branches.find((b) => b.name === name)?.sha ?? null;
  const head = String(ref ?? '').trim() || defaultBranch;
  const headSha = shaOf(head);
  const headPin = headSha ?? head;
  const headLabel = headSha ? `${head} (${shortSha(headSha)})` : refLabel(head);

  if (base) return { base: pinRef(branches, base), head: headPin, label: `${headLabel} vs ${refLabel(base)}` };

  const defSha = shaOf(defaultBranch);
  const sameAsDefault =
    containedSha !== null ||
    head === defaultBranch ||
    (defSha !== null && (headSha !== null ? headSha === defSha : SHA_RE.test(head) && defSha.toLowerCase().startsWith(head.toLowerCase())));
  if (sameAsDefault) {
    const sha = containedSha ?? headSha ?? defSha ?? head;
    return { base: null, head: sha, label: headSha || !SHA_RE.test(head) ? `${head} (${shortSha(sha)})` : `commit ${shortSha(sha)}` };
  }
  return { base: defSha ?? defaultBranch, head: headPin, label: `${headLabel} vs ${defaultBranch}` };
}

/**
 * The head's full sha when a three-dot compare against the default branch found nothing new
 * (status behind or identical, ahead_by 0): the merge base is then the head itself. Else null.
 */
export function containedHead(cmp) {
  return cmp?.ahead_by === 0 ? cmp.merge_base_commit?.sha ?? null : null;
}

/** A branch name's current sha; anything else (a sha, a tag) as given. */
export function pinRef(branches, ref) {
  return branches.find((b) => b.name === ref)?.sha ?? ref;
}

function refLabel(ref) {
  return SHA_RE.test(ref) ? shortSha(ref) : ref;
}

export function threadName(label) {
  return truncate(`review: ${label}`, 100);
}

/** "✅ <@a> <@b> · 🔧 <@c>" (mentions inside embeds never ping), or "none yet". */
export function verdictSummary(verdicts = {}) {
  const parts = [];
  for (const [key, v] of Object.entries(VERDICTS)) {
    const users = Object.entries(verdicts)
      .filter(([, verdict]) => verdict === key)
      .map(([userId]) => `<@${userId}>`);
    if (users.length) parts.push(`${v.emoji} ${users.join(' ')}`);
  }
  return parts.length ? truncate(parts.join(' · '), 1000) : 'none yet';
}

/** The message's embeds with the first one's "verdicts" field set from `verdicts`. */
export function withVerdicts(embeds, verdicts) {
  const [first, ...rest] = embeds ?? [];
  if (!first) return [];
  const embed = EmbedBuilder.from(first);
  const field = { name: 'verdicts', value: verdictSummary(verdicts) };
  const i = (embed.data.fields ?? []).findIndex((f) => f.name === 'verdicts');
  if (i === -1) embed.addFields(field);
  else embed.spliceFields(i, 1, field);
  return [embed, ...rest];
}

export function reviewButtons(url) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(cid('review', 'verdict', 'ok')).setEmoji(VERDICTS.ok.emoji).setLabel(VERDICTS.ok.label).setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(cid('review', 'verdict', 'changes')).setEmoji(VERDICTS.changes.emoji).setLabel(VERDICTS.changes.label).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setLabel('github ↗').setStyle(ButtonStyle.Link).setURL(url),
  );
}

/** Autocomplete choices for "#…": open PRs whose number or title matches. */
export function prChoices(pulls, typed) {
  const q = String(typed ?? '').replace(/^#/, '').trim().toLowerCase();
  return (pulls ?? [])
    .map((p) => ({ number: p.number, title: redactSecrets(String(p.title ?? '')) }))
    .filter((p) => !q || String(p.number).startsWith(q) || p.title.toLowerCase().includes(q))
    .slice(0, 25)
    .map((p) => ({ name: truncate(`#${p.number} ${p.title}`, 100), value: `#${p.number}` }));
}

/** Drop the oldest records once there are more than `max`. */
export function pruneReviews(reviews, max = MAX_REVIEWS) {
  const ids = Object.keys(reviews);
  if (ids.length <= max) return;
  ids.sort((a, b) => String(reviews[a].createdAt ?? '').localeCompare(String(reviews[b].createdAt ?? '')));
  for (const id of ids.slice(0, ids.length - max)) delete reviews[id];
}

// ------------------------------------------------------------------ GitHub plumbing

function notFound(err) {
  return err instanceof GitHubError && (err.status === 404 || err.status === 422);
}

/** A GitHub "no such ref" as a UserError; anything else unchanged. */
function refError(err, project) {
  if (notFound(err)) return new UserError(`github can't find that in ${project.name}. check the ref and base (branch names are case-sensitive).`);
  return err;
}

/** Resolves to the promise's value, or undefined when `ms` passes first. */
function within(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const pullCache = new Map(); // repo -> { at, pulls }

async function openPulls(ctx, project) {
  const hit = pullCache.get(project.repo);
  if (hit && Date.now() - hit.at < 60_000) return hit.pulls;
  const pulls = await ctx.github.pulls(project.repo, { state: 'open', perPage: 50 });
  pullCache.set(project.repo, { at: Date.now(), pulls });
  return pulls;
}

async function resolveTarget(ctx, project, ref, base) {
  const prNumber = parsePullRef(ref);
  if (prNumber) {
    let pr;
    try {
      pr = await ctx.github.pull(project.repo, prNumber);
    } catch (err) {
      if (notFound(err)) throw new UserError(`${project.name} has no PR #${prNumber}.`);
      throw err;
    }
    // An explicit base narrows a PR review, e.g. to what changed since the last round.
    const pinnedBase = base ? pinRef((await listBranches(ctx, project)).branches, base) : pr.base.sha;
    const label = `PR #${prNumber}: ${redactSecrets(pr.title ?? '')}${base ? ` (since ${refLabel(base)})` : ''}`;
    return { base: pinnedBase, head: pr.head.sha, label, pr: prNumber, url: base ? gh.compare(project, pinnedBase, pr.head.sha) : pr.html_url };
  }
  const { defaultBranch, branches } = await listBranches(ctx, project);
  let plan = planReview({ ref, base, defaultBranch, branches });
  if (!base && plan.base) {
    // A commit or branch the default branch already has would compare to nothing.
    const cmp = await ctx.github.compare(project.repo, plan.base, plan.head).catch((err) => {
      throw refError(err, project);
    });
    const containedSha = containedHead(cmp);
    if (containedSha) plan = planReview({ ref, defaultBranch, branches, containedSha });
  }
  return { ...plan, pr: null, url: plan.base ? gh.compare(project, plan.base, plan.head) : gh.commit(project, plan.head) };
}

/**
 * The diff payload. gitfmt.diffPayload already falls back to the summary alone when GitHub
 * answers 406 (a diff too large to render) and says so in the footer. Returns { payload, tooBig }.
 */
async function buildPayload(ctx, project, target) {
  const opts = { base: target.base, head: target.head, title: target.label };
  const payload = await diffPayload(ctx, project, opts).catch((err) => {
    throw refError(err, project);
  });
  const footer = payload.embeds[0]?.toJSON?.().footer?.text;
  return { payload, tooBig: !payload.files.length && footer === TOO_BIG_FOOTER };
}

async function reviewThread(ctx, messageId) {
  try {
    const channel = await ctx.client.channels.fetch(messageId);
    return channel?.isThread() ? channel : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ handlers

async function onReview(interaction, ctx) {
  if (!(await requireStaff(interaction, ctx))) return;
  const project = getProject(ctx, interaction.options.getString('project', true));
  const ref = interaction.options.getString('ref', true).trim();
  const base = interaction.options.getString('base')?.trim() || null;
  const note = interaction.options.getString('note')?.trim() || '';
  if (!ref) throw new UserError('give me a branch, a commit or a PR number.');
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const target = await resolveTarget(ctx, project, ref, base);
  const { payload, tooBig } = await buildPayload(ctx, project, target);
  const [embed] = payload.embeds;
  embed.addFields({ name: 'verdicts', value: verdictSummary({}) });

  const staffId = ctx.guildCtx.roleId('staff');
  const requester = `<@${interaction.user.id}>`;
  const message = await ctx.guildCtx.send('red-team', {
    content: staffId ? `<@&${staffId}> review requested by ${requester}` : `review requested by ${requester}`,
    allowedMentions: staffId ? { roles: [staffId] } : { parse: [] },
    embeds: payload.embeds,
    files: payload.files,
    components: [reviewButtons(target.url)],
  });
  if (!message) {
    await interaction.editReply(ctx.dryRun ? 'dry run: the review was logged, not posted.' : "couldn't reach #red-team. an owner needs to re-run the layout (`/admin`).");
    return;
  }

  const reviews = ctx.state.get('reviews');
  reviews[message.id] = {
    project: project.key,
    base: target.base,
    head: target.head,
    label: target.label,
    pr: target.pr,
    requestedBy: interaction.user.id,
    verdicts: {},
    createdAt: new Date().toISOString(),
  };
  pruneReviews(reviews);
  ctx.state.save('reviews');

  try {
    const thread = await message.startThread({ name: threadName(target.label), autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek });
    const lines = note ? [`**note from ${requester}:** ${truncate(note, 1500)}`, HOW_TO] : [HOW_TO];
    await thread.send({ content: lines.join('\n\n'), allowedMentions: { parse: [] } });
  } catch (err) {
    ctx.log.child('review').warn(`review ${message.id}: thread setup failed: ${err.message}`);
  }
  await interaction.editReply(`review is up in red-team: ${message.url}${tooBig ? '\nsummary only: the diff is too large for discord.' : ''}`);
}

async function onVerdict(interaction, ctx, [kind]) {
  if (!(await requireStaff(interaction, ctx))) return;
  const verdict = VERDICTS[kind];
  if (!verdict) throw new UserError('that button is from an older GOJO. ask for a fresh /review.');
  const reviews = ctx.state.get('reviews');
  const messageId = interaction.message.id;
  const record = (reviews[messageId] ??= { project: null, base: null, head: null, requestedBy: null, verdicts: {}, createdAt: new Date().toISOString() });
  record.verdicts ??= {};
  const userId = interaction.user.id;
  if (record.verdicts[userId] === kind) {
    await interaction.reply({ content: `already counted: ${verdict.emoji} ${verdict.label}. click the other button to change it.`, flags: MessageFlags.Ephemeral });
    return;
  }
  record.verdicts[userId] = kind;
  ctx.state.save('reviews');
  await interaction.update({ embeds: withVerdicts(interaction.message.embeds, record.verdicts) });

  const thread = interaction.message.thread ?? (await reviewThread(ctx, messageId));
  if (!thread || ctx.dryRun) return;
  try {
    await thread.send({ content: `<@${userId}> ${verdict.emoji} ${verdict.label}`, allowedMentions: { parse: [] } });
  } catch (err) {
    ctx.log.child('review').warn(`review ${messageId}: verdict note failed: ${err.message}`);
  }
}

export default {
  name: 'review',
  commands: (config) => [
    addRefOption(
      addRefOption(addProjectOption(new SlashCommandBuilder().setName('review').setDescription('ask for a code review in #red-team (staff)'), config), {
        name: 'ref',
        required: true,
        description: 'branch, commit, or PR number (#12)',
      }),
      { name: 'base', description: 'compare against this (default: the default branch, or the PR base)' },
    ).addStringOption((o) => o.setName('note').setDescription('what reviewers should look at').setMaxLength(1500)),
  ],

  async onCommand(interaction, ctx) {
    if (interaction.commandName === 'review') await onReview(interaction, ctx);
  },

  async onAutocomplete(interaction, ctx) {
    // Branch names and PR titles of private repos are private too.
    if (!isStaff(ctx, interaction.member)) return interaction.respond([]);
    const project = ctx.config.project(interaction.options.getString('project') ?? '');
    if (!project) return interaction.respond([]);
    // Slow lists keep loading into their caches for the next keystroke.
    const focused = interaction.options.getFocused(true);
    if (focused.name === 'ref' && String(focused.value ?? '').startsWith('#')) {
      const pulls = await within(openPulls(ctx, project).catch(() => null), AUTOCOMPLETE_BUDGET_MS);
      return interaction.respond(pulls ? prChoices(pulls, focused.value) : []);
    }
    const ready = await within(listBranches(ctx, project).then(() => true, () => false), AUTOCOMPLETE_BUDGET_MS);
    return ready ? autocompleteRef(interaction, ctx) : interaction.respond([]);
  },

  components: {
    verdict: onVerdict,
  },
};
