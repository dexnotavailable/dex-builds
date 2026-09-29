import { setTimeout as sleep } from 'node:timers/promises';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { cid } from '../core/router.mjs';
import { requireStaff } from '../core/guild.mjs';
import { GitHubError, RateLimitError } from '../core/github.mjs';
import { addProjectOption, getProject, UserError } from '../core/projects.mjs';
import { redactSecrets } from '../core/redact.mjs';
import { hexColor, md, truncate } from '../core/format.mjs';

// #rlhf: feedback forum posts, optionally tracked as GitHub issues.
// State `feedback`: { threads: { threadId: { project, kind, title, status, issue, authorId, createdAt } },
//                     issues: { 'owner/repo#n': threadId } }
// status: open -> tracked (issue filed) -> shipped, or closed (issue closed on github as not planned).

export const KINDS = {
  bug: { emoji: '🐛', label: 'bug', form: 'bug report', placeholder: 'what happened, what you expected, how to make it happen again' },
  idea: { emoji: '💡', label: 'idea', form: 'idea', placeholder: 'what should exist, and why' },
  ux: { emoji: '🎨', label: 'ux', form: 'ux note', placeholder: 'what felt off, confusing or ugly' },
  perf: { emoji: '⚡', label: 'perf', form: 'perf report', placeholder: 'what was slow, how slow, on what machine' },
  praise: { emoji: '💖', label: 'praise', form: 'praise', placeholder: 'what worked. the reward model is listening' },
};
export const KIND_KEYS = Object.keys(KINDS);

export const ISSUE_BODY_MAX = 65536;
const MAX_TAGS = 5;
const FORUM = 'rlhf';

// ------------------------------------------------------------------ pure helpers

/**
 * Project and kind from a post's applied tag ids. `tagIds` is the layout map { tagKey: tagId }.
 * The project is null unless exactly one project tag is applied; the kind is the first kind tag.
 */
export function inferFromTags(appliedTagIds = [], tagIds = {}, projects = []) {
  const keyOf = new Map(Object.entries(tagIds ?? {}).map(([key, id]) => [id, key]));
  const keys = (appliedTagIds ?? []).map((id) => keyOf.get(id)).filter(Boolean);
  const matched = projects.filter((p) => keys.includes(p.forumTag ?? p.key));
  return {
    project: matched.length === 1 ? matched[0].key : null,
    kind: keys.find((k) => KIND_KEYS.includes(k)) ?? null,
  };
}

/**
 * Tag ids after adding `add` and removing `remove`, within Discord's 5-tag limit. When over the
 * limit, kind tags go first, then the oldest other tags; the tags being added always stay.
 */
export function nextTags(current = [], add = [], remove = [], kindTagIds = [], max = MAX_TAGS) {
  const adding = add.filter(Boolean);
  const dropped = new Set(remove.filter(Boolean));
  const tags = (current ?? []).filter((id) => !dropped.has(id));
  for (const id of adding) if (!tags.includes(id) && !dropped.has(id)) tags.push(id);
  const expendable = (id, kindsOnly) => !adding.includes(id) && (!kindsOnly || kindTagIds.includes(id));
  while (tags.length > max) {
    let i = tags.findIndex((id) => expendable(id, true));
    if (i === -1) i = tags.findIndex((id) => expendable(id, false));
    if (i === -1) break;
    tags.splice(i, 1);
  }
  return tags.slice(0, max);
}

export function sameTags(a = [], b = []) {
  return a.length === b.length && a.every((id) => b.includes(id));
}

/** The text of a post's starter message: its content, else the first embed's description. */
export function starterText(message) {
  if (!message) return '';
  const text = String(message.content ?? '').trim() || String(message.embeds?.[0]?.description ?? '').trim();
  const files = message.attachments?.size ?? 0;
  const note = files ? `_${files} attachment${files === 1 ? '' : 's'} on the Discord post._` : '';
  return [text, note].filter(Boolean).join('\n\n');
}

/**
 * Why a post's text could not be read, or null. Discord blanks other people's messages for bots
 * without the Message Content intent (REST fetches included), so an empty member post means hidden.
 */
export function unreadableReason(starter, botId) {
  if (!starter) return "couldn't load the post's first message";
  if (starterText(starter) || starter.author?.id === botId) return null;
  return 'discord hid the post text from GOJO (the message content intent is off: developer portal → bot → privileged gateway intents)';
}

/**
 * GitHub issue body: the redacted post text plus where it came from, within GitHub's limit.
 * `unreadable`: the post text exists but could not be read (see unreadableReason).
 */
export function issueBody({ text, reporter, url, unreadable = false }) {
  const footer = `\n\n---\nreported by ${reporter || 'someone'} in the dev Discord (${url})`;
  const empty = unreadable ? "(GOJO couldn't read the post text. it's in the Discord post linked below.)" : '(no description)';
  const main = redactSecrets(String(text ?? '').trim()) || empty;
  return truncate(main, ISSUE_BODY_MAX - footer.length) + footer;
}

/** The note posted in a post when its issue is closed on GitHub. `reason` is GitHub's state_reason. */
export function closedNote(issue, { closedBy = null, reason = null } = {}) {
  const by = closedBy ? ` by ${md(closedBy)}` : '';
  if (shipsOnClose(reason)) return `✅ ${issueLink(issue)} was closed on github${by}`;
  const why = reason === 'not_planned' ? 'not planned' : String(reason).replace(/_/g, ' ');
  return `🗑️ ${issueLink(issue)} was closed on github as ${why}${by}. no ship tag this time.`;
}

/** Only a plain or completed close counts as shipped; not_planned (or duplicate) does not. */
export function shipsOnClose(reason) {
  return !reason || reason === 'completed';
}

export function issueKey(repo, number) {
  return `${repo}#${number}`;
}

/** Masked link without an unfurl: [owner/repo#12](<url>) */
export function issueLink(issue) {
  return `[${issue.repo}#${issue.number}](<${issue.url}>)`;
}

export function postEmbed({ project, kind, details, where, authorId }) {
  const k = KINDS[kind];
  const body = redactSecrets(String(details ?? '').trim()) + (where ? `\n\n**where/when:** ${redactSecrets(where)}` : '');
  return new EmbedBuilder()
    .setColor(hexColor(project.color))
    .setAuthor({ name: `${k.emoji} ${k.label} · ${project.emoji} ${project.name}` })
    .setDescription(truncate(body, 4000))
    .addFields(
      { name: 'project', value: `${project.emoji} ${project.name}`, inline: true },
      { name: 'kind', value: `${k.emoji} ${k.label}`, inline: true },
      { name: 'reported by', value: `<@${authorId}>`, inline: true },
    )
    .setTimestamp(new Date());
}

export function postButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(cid('feedback', 'track')).setEmoji('📌').setLabel('track on github').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(cid('feedback', 'ship')).setEmoji('✅').setLabel('shipped').setStyle(ButtonStyle.Success),
  );
}

export function feedbackModal(project, kind) {
  const k = KINDS[kind];
  const input = (id, style, { required = true, max, placeholder } = {}) => {
    const t = new TextInputBuilder().setCustomId(id).setStyle(style).setRequired(required).setMaxLength(max);
    return placeholder ? t.setPlaceholder(placeholder) : t;
  };
  return new ModalBuilder()
    .setCustomId(cid('feedback', 'new', project.key, kind))
    .setTitle(truncate(`${k.emoji} ${k.form} · ${project.name}`, 45))
    .addLabelComponents(
      new LabelBuilder().setLabel('title').setDescription('one line. it becomes the post title.').setTextInputComponent(input('title', TextInputStyle.Short, { max: 100 })),
      new LabelBuilder().setLabel('details').setTextInputComponent(input('details', TextInputStyle.Paragraph, { max: 3000, placeholder: k.placeholder })),
      new LabelBuilder()
        .setLabel('where/when did it happen?')
        .setTextInputComponent(input('where', TextInputStyle.Short, { required: false, max: 200, placeholder: 'screen, command, version, time. optional' })),
    );
}

export function projectPicker(projects, threadId) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(cid('feedback', 'trackpick', threadId))
      .setPlaceholder('which repo?')
      .addOptions(projects.map((p) => ({ label: p.name, value: p.key, description: p.repo, emoji: { name: p.emoji } }))),
  );
}

export function introText(project) {
  const lines = ['logged for the next training run. staff can 📌 track it on github or mark it ✅ shipped.'];
  if (!project) lines.push('tag exactly one project (dexcode, dexclient, dex.place) so it lands in the right repo.');
  return lines.join('\n');
}

// ------------------------------------------------------------------ state + Discord plumbing

function store(ctx) {
  return ctx.state.get('feedback', { threads: {}, issues: {} });
}

function forumTags(ctx) {
  return ctx.guildCtx.ids.tags?.[FORUM] ?? {};
}

function tagId(ctx, key) {
  return ctx.guildCtx.tagId(FORUM, key);
}

function logger(ctx) {
  return ctx.log.child('feedback');
}

/** The state record for a post, created from its tags when the bot has not seen it before. */
function ensureRecord(ctx, thread) {
  const data = store(ctx);
  if (!data.threads[thread.id]) {
    const { project, kind } = inferFromTags(thread.appliedTags, forumTags(ctx), ctx.config.projects);
    const shippedId = tagId(ctx, 'shipped');
    data.threads[thread.id] = {
      project,
      kind,
      title: thread.name,
      status: shippedId && thread.appliedTags?.includes(shippedId) ? 'shipped' : 'open',
      issue: null,
      authorId: thread.ownerId ?? null,
      createdAt: new Date(thread.createdTimestamp ?? Date.now()).toISOString(),
    };
    ctx.state.save('feedback');
  }
  return data.threads[thread.id];
}

function isPost(ctx, channel) {
  const forumId = ctx.guildCtx.channelId(FORUM);
  return !!forumId && !!channel?.isThread?.() && channel.parentId === forumId;
}

async function fetchChannel(ctx, id) {
  if (!id) return null;
  return ctx.client.channels.cache.get(id) ?? (await ctx.client.channels.fetch(id).catch(() => null));
}

/** The #rlhf post an interaction happened in, or a UserError. */
async function postOf(interaction, ctx) {
  const channel = interaction.channel ?? (await fetchChannel(ctx, interaction.channelId));
  if (!isPost(ctx, channel)) {
    const forumId = ctx.guildCtx.channelId(FORUM);
    throw new UserError(`use this inside a post in ${forumId ? `<#${forumId}>` : '#rlhf'}.`);
  }
  return channel;
}

async function wake(thread) {
  if (thread.archived) await thread.setArchived(false, 'GOJO feedback update');
}

/** Post in a thread (mentions off). Logged instead in dry-run. */
async function say(ctx, thread, content, components) {
  if (ctx.dryRun) {
    logger(ctx).info(`[dry-run] -> #${thread.name}: ${content}`);
    return null;
  }
  await wake(thread);
  return thread.send({ content, components, allowedMentions: { parse: [] } });
}

/** Add/remove tags by layout key; missing tag ids are skipped and failures only logged. */
async function retag(ctx, thread, { add = [], remove = [] }) {
  const current = thread.appliedTags ?? [];
  const next = nextTags(
    current,
    add.map((k) => tagId(ctx, k)),
    remove.map((k) => tagId(ctx, k)),
    KIND_KEYS.map((k) => tagId(ctx, k)).filter(Boolean),
  );
  if (sameTags(next, current) || ctx.dryRun) return;
  try {
    await wake(thread);
    await thread.setAppliedTags(next, 'GOJO feedback');
  } catch (err) {
    logger(ctx).warn(`could not retag post ${thread.id}: ${err.message}`);
  }
}

async function reporterName(ctx, userId) {
  if (!userId) return 'someone';
  const user = await ctx.client.users.fetch(userId).catch(() => null);
  return user?.username ?? 'someone';
}

// ------------------------------------------------------------------ track / ship

const filing = new Set(); // thread ids with an issue being created right now

/** Create the GitHub issue for a post. Returns the text for the ephemeral reply. */
async function fileIssue(ctx, thread, record) {
  if (record.issue) return `already tracked: ${record.issue.url}`;
  // A project picker opened earlier can still land here after someone marked the post shipped.
  if (record.status === 'shipped') return 'this one already shipped. nothing left to track.';
  if (filing.has(thread.id)) return 'someone is filing this one right now. give it a second.';
  filing.add(thread.id);
  try {
    const project = getProject(ctx, record.project);
    const starter = await thread.fetchStarterMessage().catch(() => null);
    const unreadable = unreadableReason(starter, ctx.client.user?.id);
    const body = issueBody({ text: starterText(starter), reporter: await reporterName(ctx, record.authorId), url: thread.url, unreadable: !!unreadable });
    const created = await ctx.github.createIssue(project.repo, { title: truncate(redactSecrets(thread.name), 256), body });
    const issue = { repo: project.repo, number: created.number, url: created.html_url };
    const data = store(ctx);
    record.issue = issue;
    record.status = 'tracked';
    data.issues[issueKey(issue.repo, issue.number)] = thread.id;
    ctx.state.save('feedback', { immediate: true });
    await retag(ctx, thread, { add: [project.forumTag ?? project.key, 'tracked'] });
    await say(ctx, thread, `📌 tracked as ${issueLink(issue)}`).catch((err) => logger(ctx).warn(`post ${thread.id}: tracked note failed: ${err.message}`));
    const reply = `tracked as ${issue.repo}#${issue.number}: ${issue.url}`;
    return unreadable ? `${reply}\nheads up: ${unreadable}, so the issue only links the post. paste the details into it.` : reply;
  } finally {
    filing.delete(thread.id);
  }
}

/** Track flow after the interaction is deferred: file it, or ask which repo first. */
async function track(interaction, ctx, thread) {
  const record = ensureRecord(ctx, thread);
  if (record.issue) return interaction.editReply(`already tracked: ${record.issue.url}`);
  if (record.status === 'shipped') return interaction.editReply('this one already shipped. nothing left to track.');
  record.project ??= inferFromTags(thread.appliedTags, forumTags(ctx), ctx.config.projects).project;
  if (!record.project) {
    return interaction.editReply({ content: 'which repo does this belong to? (no single project tag on the post)', components: [projectPicker(ctx.config.projects, thread.id)] });
  }
  return interaction.editReply(await fileIssue(ctx, thread, record));
}

/** Mark a post shipped and close its open issue. Returns the text for the ephemeral reply. */
async function ship(ctx, thread, user) {
  const record = ensureRecord(ctx, thread);
  if (record.status === 'shipped') return 'already shipped.';
  record.status = 'shipped';
  ctx.state.save('feedback');
  await retag(ctx, thread, { add: ['shipped'] });
  await say(ctx, thread, `✅ shipped by <@${user.id}>`).catch((err) => logger(ctx).warn(`post ${thread.id}: shipped note failed: ${err.message}`));
  const issue = record.issue;
  if (!issue) return 'marked shipped.';
  try {
    const current = await ctx.github.issue(issue.repo, issue.number);
    if (current.state !== 'open') return `marked shipped. ${issue.repo}#${issue.number} was already closed.`;
    await ctx.github.commentIssue(issue.repo, issue.number, 'shipped (closed from the dev Discord)');
    await ctx.github.updateIssue(issue.repo, issue.number, { state: 'closed', state_reason: 'completed' });
    return `marked shipped and closed ${issue.repo}#${issue.number}.`;
  } catch (err) {
    logger(ctx).warn(`closing ${issueKey(issue.repo, issue.number)} failed: ${err.message}`);
    return `marked shipped here, but github wouldn't close ${issue.repo}#${issue.number}: ${truncate(err.message, 200)}`;
  }
}

// ------------------------------------------------------------------ GitHub -> Discord

/**
 * An issue linked to a post was closed on GitHub: the post counts as shipped, unless it was closed
 * as not planned (status 'closed', tags left alone).
 */
async function issueClosed(ctx, { repo, number, url, closedBy, reason = null }) {
  const data = store(ctx);
  const threadId = data.issues[issueKey(repo, number)];
  const record = threadId ? data.threads[threadId] : null;
  if (!record || record.status !== 'tracked') return;
  const shipped = shipsOnClose(reason);
  record.status = shipped ? 'shipped' : 'closed';
  ctx.state.save('feedback');
  const thread = await fetchChannel(ctx, threadId);
  if (!thread?.isThread()) return;
  if (shipped) await retag(ctx, thread, { add: ['shipped'] });
  const who = typeof closedBy === 'string' ? closedBy : closedBy?.login;
  await say(ctx, thread, closedNote({ repo, number, url: url ?? record.issue?.url }, { closedBy: who, reason }));
}

async function issueReopened(ctx, { repo, number, url }) {
  const data = store(ctx);
  const threadId = data.issues[issueKey(repo, number)];
  const record = threadId ? data.threads[threadId] : null;
  if (!record || (record.status !== 'shipped' && record.status !== 'closed')) return;
  record.status = 'tracked';
  ctx.state.save('feedback');
  const thread = await fetchChannel(ctx, threadId);
  if (!thread?.isThread()) return;
  await retag(ctx, thread, { remove: ['shipped'] });
  await say(ctx, thread, `↩️ ${issueLink({ repo, number, url: url ?? record.issue?.url })} was reopened on github. back on the list.`);
}

const syncWarned = new Set(); // issue keys whose sync failure was already logged

/**
 * Safety net for closes the bus did not deliver (bot down, or activity polled before this module
 * subscribed): check every tracked post's issue directly. One failing issue does not stop the
 * rest; only a rate limit ends the pass (the scheduler waits it out).
 */
async function syncTracked(ctx) {
  const data = store(ctx);
  for (const record of Object.values(data.threads)) {
    if (record.status !== 'tracked' || !record.issue) continue;
    const key = issueKey(record.issue.repo, record.issue.number);
    try {
      await syncOne(ctx, record.issue);
      syncWarned.delete(key);
    } catch (err) {
      if (err instanceof RateLimitError) throw err;
      if (syncWarned.has(key)) continue;
      syncWarned.add(key);
      logger(ctx).warn(`sync of ${key} failed (logged once until it recovers): ${err.message}`);
    }
  }
}

async function syncOne(ctx, { repo, number }) {
  let issue;
  try {
    issue = await ctx.github.issue(repo, number);
  } catch (err) {
    if (err instanceof GitHubError && [404, 410].includes(err.status)) return;
    throw err;
  }
  if (issue.state !== 'closed') return;
  await issueClosed(ctx, { repo, number, url: issue.html_url, closedBy: issue.closed_by?.login ?? null, reason: issue.state_reason ?? null });
}

function repoOf(ctx, projectKey) {
  return ctx.config.project(projectKey)?.repo ?? null;
}

// ------------------------------------------------------------------ handlers

async function onNew(interaction, ctx) {
  const project = getProject(ctx, interaction.options.getString('project', true));
  const kind = interaction.options.getString('kind', true);
  if (!KINDS[kind]) throw new UserError(`unknown kind "${kind}".`);
  if (!ctx.guildCtx.channelId(FORUM)) throw new UserError("the #rlhf forum isn't set up yet. ping the ceo.");
  await interaction.showModal(feedbackModal(project, kind));
}

/** A modal text input's trimmed value; '' when Discord left an optional one out. */
function fieldValue(interaction, id) {
  try {
    return String(interaction.fields.getTextInputValue(id) ?? '').trim();
  } catch {
    return '';
  }
}

async function onNewSubmit(interaction, ctx, [projectKey, kind]) {
  const project = getProject(ctx, projectKey);
  if (!KINDS[kind]) throw new UserError('that form is from an older GOJO. run /feedback new again.');
  const title = fieldValue(interaction, 'title');
  const details = fieldValue(interaction, 'details');
  const where = fieldValue(interaction, 'where');
  if (!title || !details) throw new UserError('a title and some details, please. whitespace is not feedback.');
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const forum = await ctx.guildCtx.channel(FORUM);
  if (forum?.type !== ChannelType.GuildForum) throw new UserError("the #rlhf forum isn't set up yet. ping the ceo.");
  const embed = postEmbed({ project, kind, details, where, authorId: interaction.user.id });
  if (ctx.dryRun) {
    logger(ctx).info(`[dry-run] -> #${FORUM} new post "${title}" (${project.key}/${kind})`);
    await interaction.editReply('dry run: the post was logged, not created.');
    return;
  }
  const thread = await forum.threads.create({
    name: truncate(title, 100),
    message: { embeds: [embed], components: [postButtons()], allowedMentions: { parse: [] } },
    appliedTags: [tagId(ctx, project.forumTag ?? project.key), tagId(ctx, kind)].filter(Boolean),
    reason: `feedback from ${interaction.user.username}`,
  });
  store(ctx).threads[thread.id] = {
    project: project.key,
    kind,
    title: thread.name,
    status: 'open',
    issue: null,
    authorId: interaction.user.id,
    createdAt: new Date().toISOString(),
  };
  ctx.state.save('feedback');
  await interaction.editReply(`posted in rlhf: ${thread.url}`);
}

async function onTrack(interaction, ctx) {
  if (!(await requireStaff(interaction, ctx))) return;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await track(interaction, ctx, await postOf(interaction, ctx));
}

async function onTrackPick(interaction, ctx, [threadId]) {
  if (!(await requireStaff(interaction, ctx))) return;
  const project = getProject(ctx, interaction.values?.[0]);
  await interaction.update({ content: `filing it under ${project.emoji} ${project.name}…`, components: [] });
  const thread = await fetchChannel(ctx, threadId);
  if (!isPost(ctx, thread)) throw new UserError('that post is gone.');
  const record = ensureRecord(ctx, thread);
  if (!record.issue) record.project = project.key;
  await interaction.editReply(await fileIssue(ctx, thread, record));
}

async function onShip(interaction, ctx) {
  if (!(await requireStaff(interaction, ctx))) return;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const thread = await postOf(interaction, ctx);
  await interaction.editReply(await ship(ctx, thread, interaction.user));
}

/** A member opened a post directly in #rlhf: record it and drop the track/ship buttons in. */
async function onThreadCreate(thread, newlyCreated, ctx) {
  if (!newlyCreated || !isPost(ctx, thread) || thread.ownerId === ctx.client.user?.id) return;
  if (store(ctx).threads[thread.id]) return;
  // The starter message can land a moment after the thread itself.
  await sleep(1500);
  const record = ensureRecord(ctx, thread);
  for (const wait of [0, 3000]) {
    if (wait) await sleep(wait);
    try {
      await say(ctx, thread, introText(record.project), [postButtons()]);
      return;
    } catch (err) {
      if (wait) logger(ctx).warn(`post ${thread.id}: intro failed: ${err.message}`);
    }
  }
}

let listeners = null;

export default {
  name: 'feedback',
  commands: (config) => [
    new SlashCommandBuilder()
      .setName('feedback')
      .setDescription('bugs, ideas and vibes for #rlhf')
      .addSubcommand((s) =>
        addProjectOption(s.setName('new').setDescription('post feedback to #rlhf (a short form)'), config).addStringOption((o) =>
          o
            .setName('kind')
            .setDescription('what kind of feedback')
            .setRequired(true)
            .addChoices(...KIND_KEYS.map((k) => ({ name: `${KINDS[k].emoji} ${KINDS[k].label}`, value: k }))),
        ),
      )
      .addSubcommand((s) => s.setName('track').setDescription('staff: turn this #rlhf post into a github issue'))
      .addSubcommand((s) => s.setName('ship').setDescription('staff: mark this #rlhf post shipped and close its issue')),
  ],

  async onCommand(interaction, ctx) {
    const sub = interaction.options.getSubcommand();
    if (sub === 'new') await onNew(interaction, ctx);
    else if (sub === 'track') await onTrack(interaction, ctx);
    else if (sub === 'ship') await onShip(interaction, ctx);
  },

  components: {
    new: onNewSubmit,
    track: onTrack,
    trackpick: onTrackPick,
    ship: onShip,
  },

  events: {
    threadCreate: onThreadCreate,
  },

  async start(ctx) {
    const log = logger(ctx);
    const onClosed = (e) => {
      const repo = repoOf(ctx, e?.project);
      if (repo) issueClosed(ctx, { ...e, repo }).catch((err) => log.error(`issue:closed ${e.project}#${e.number} failed`, err));
    };
    const onReopened = (e) => {
      const repo = repoOf(ctx, e?.project);
      if (repo) issueReopened(ctx, { ...e, repo }).catch((err) => log.error(`issue:reopened ${e.project}#${e.number} failed`, err));
    };
    ctx.bus.on('issue:closed', onClosed);
    ctx.bus.on('issue:reopened', onReopened);
    listeners = { onClosed, onReopened };
    ctx.scheduler.every('feedback-issues', 1800, () => syncTracked(ctx));
  },

  async stop(ctx) {
    if (!listeners) return;
    ctx.bus.off('issue:closed', listeners.onClosed);
    ctx.bus.off('issue:reopened', listeners.onReopened);
    listeners = null;
  },
};
