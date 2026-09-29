import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  MessageType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { cid } from '../core/router.mjs';
import { isOwner, isStaff, requireOwner } from '../core/guild.mjs';
import { UserError } from '../core/projects.mjs';
import { hexColor, md, truncate, ts } from '../core/format.mjs';

// #front-desk (pinned guide + role panel), join cards in #board-meeting, and the staff badge
// (/hire, /fire). State `onboarding`: { guideMessageId, panelMessageId, joins: {userId: cardId}, joinWatermark }.

export const GUIDE_TITLE = 'welcome to the sam altman office';
export const PANEL_TITLE = '🔔 early access programs';
const STAFF_COLOR = 0x5b8cff;
const WAITLIST_COLOR = 0x8a8f98;
const FRESH_ACCOUNT_DAYS = 7;
const DEFAULTS = { guideMessageId: null, panelMessageId: null, joins: {}, joinWatermark: null };

function st(ctx) {
  return ctx.state.get('onboarding', DEFAULTS);
}

function logger(ctx) {
  return ctx.log.child('onboarding');
}

/** Live role name, falling back to the layout name. */
export function roleName(ctx, key) {
  return ctx.guildCtx.role(key)?.name ?? ctx.config.layout.roles.find((r) => r.key === key)?.name ?? key;
}

function channelMention(ctx, key) {
  const id = ctx.guildCtx.channelId(key);
  return id ? `<#${id}>` : `#${key}`;
}

function names(ctx) {
  return { mention: (key) => channelMention(ctx, key), roleName: (key) => roleName(ctx, key), projects: ctx.config.projects };
}

function listJoin(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

// ------------------------------------------------------------------ builders (pure)

export function buildGuideEmbed({ mention, roleName: role, projects }) {
  const projectLines = projects.map((p) => `${p.emoji} **${md(p.name)}**${p.blurb ? `: ${md(p.blurb)}` : ''}`);
  const where = [
    `${mention('water-cooler')} general chat`,
    `${mention('vague-tweets')} memes, links and cryptic agi posts`,
    `${mention('launch-livestream')} deploys, merged prs and the daily standup`,
    `${projects.map((p) => mention(p.feedChannel)).join(' ')} every push to every branch, one channel per project`,
    `${mention('rlhf')} the feedback forum: one post per bug, idea or vibe`,
    `${mention('red-team')} code review, one thread per request`,
  ];
  const access = [
    `new people start **${md(role('waitlist'))}**, which covers this channel, the water cooler, vague tweets, ${mention('rlhf')} and voice.`,
    `the ceo hands out the **${md(role('staff'))}** badge. it unlocks the ship feeds, ${mention('launch-livestream')}, ${mention('red-team')}, source, diffs and worktrees.`,
    'the private repos need github access on top: `/access request`, or the 🎟️ button below.',
  ];
  const commands = [
    `\`/feedback new\` file a bug or idea into ${mention('rlhf')}`,
    '`/source` read any file at any branch or commit',
    '`/diff` a commit or range, with a .diff file',
    `\`/review\` ask ${mention('red-team')} to review a branch or commit`,
    "`/worktree` what dex has uncommitted right now",
    "`/status` what shipped, what's open, whether gojo is alive",
    '`/help` everything else',
  ];
  const rules = ['1. ship it. then ship the fix.', '2. the weights (source) do not leave the building.', '3. be kind to humans, merciless to code.'];
  return new EmbedBuilder()
    .setColor(STAFF_COLOR)
    .setTitle(GUIDE_TITLE)
    .setDescription(`${listJoin(projects.map((p) => md(p.name)))} get built, reviewed and roasted here.\n\n${projectLines.join('\n')}`)
    .addFields(
      { name: 'where things are', value: truncate(where.join('\n'), 1024) },
      { name: 'how access works', value: truncate(access.join('\n'), 1024) },
      { name: 'useful commands', value: truncate(commands.join('\n'), 1024) },
      { name: 'house rules', value: rules.join('\n') },
    )
    .setFooter({ text: 'gojo keeps this message current. /help lists every command.' });
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

export function buildPanel({ roleName: role, projects }) {
  const embed = new EmbedBuilder()
    .setColor(STAFF_COLOR)
    .setTitle(PANEL_TITLE)
    .setDescription(
      [
        'get pinged when a project ships. press again to opt out.',
        ...projects.map((p) => `${p.emoji} **${md(p.name)}** → ${md(role(p.pingRole))}`),
        '',
        '🎟️ ask for github access to the private repos · 📖 every command',
      ].join('\n'),
    );
  const pings = projects.map((p) =>
    new ButtonBuilder().setCustomId(cid('onboarding', 'ping', p.key)).setLabel(truncate(`${p.emoji} ${p.name}`, 80)).setStyle(ButtonStyle.Secondary),
  );
  const rows = chunk(pings, 5).map((buttons) => new ActionRowBuilder().addComponents(buttons));
  rows.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(cid('access', 'open')).setLabel('🎟️ request github access').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(cid('status', 'help')).setLabel('📖 commands').setStyle(ButtonStyle.Secondary),
    ),
  );
  return { embeds: [embed], components: rows.slice(-5) };
}

/** 'guide' | 'panel' | 'notice' (a pin notice) for one of the bot's #front-desk messages, else null. */
export function frontDeskKind(message, botId) {
  if (message?.author?.id !== botId) return null;
  if (message.type === MessageType.ChannelPinnedMessage) return 'notice';
  const title = message.embeds?.[0]?.title;
  if (title === GUIDE_TITLE) return 'guide';
  const ids = (message.components ?? []).flatMap((row) => row.components ?? []).map((c) => String(c.customId ?? c.custom_id ?? ''));
  if (title === PANEL_TITLE || ids.some((id) => id.startsWith('onboarding:ping:'))) return 'panel';
  return null;
}

function olderFirst(a, b) {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * Which bot messages in #front-desk to keep as the guide and the panel, and which to delete.
 * Stored ids win, else the oldest copy (so a lost state file adopts instead of duplicating).
 * The panel must sit under the guide; if it is older (or the guide is missing) it is reposted.
 */
export function planFrontDesk(messages, botId, stored = {}) {
  const found = { guide: [], panel: [], notice: [] };
  for (const m of messages) {
    const kind = frontDeskKind(m, botId);
    if (kind) found[kind].push(m.id);
  }
  const pick = (ids, want) => (want && ids.includes(want) ? want : [...ids].sort(olderFirst)[0] ?? null);
  const guideId = pick(found.guide, stored.guideMessageId);
  let panelId = pick(found.panel, stored.panelMessageId);
  const remove = [...found.guide.filter((id) => id !== guideId), ...found.panel.filter((id) => id !== panelId), ...found.notice];
  if (panelId && (!guideId || olderFirst(panelId, guideId) < 0)) {
    remove.push(panelId);
    panelId = null;
  }
  return { guideId, panelId, remove };
}

export function buildJoinCard({ userId, tag, createdAt, joinedAt = null, missed = false, now = Date.now() }) {
  const lines = [`<@${userId}> · ${md(tag)}`, `account created ${ts(createdAt, 'R')} (${ts(createdAt, 'D')})`];
  if (now - new Date(createdAt).getTime() < FRESH_ACCOUNT_DAYS * 86_400_000) lines.push('⚠️ fresh account');
  if (missed && joinedAt) lines.push(`joined ${ts(joinedAt, 'R')} while gojo was offline`);
  const embed = new EmbedBuilder()
    .setColor(WAITLIST_COLOR)
    .setTitle('📥 new arrival')
    .setDescription(lines.join('\n'))
    .setFooter({ text: `user ${userId} · on the waitlist until someone decides` });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(cid('onboarding', 'hire', userId)).setLabel('🪪 hire').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(cid('onboarding', 'dismiss', userId)).setLabel('🙅 not now').setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [row] };
}

/** A card embed with its `decision` field set to `line` (replacing an earlier decision). */
export function resolveCardEmbed(embed, line) {
  const builder = embed ? EmbedBuilder.from(embed) : new EmbedBuilder();
  const fields = (builder.data.fields ?? []).filter((f) => f.name !== 'decision');
  return builder.setFields(...fields, { name: 'decision', value: truncate(line, 1024) });
}

export function buildWelcomeDm({ mention, roleName: role, projects }) {
  return [
    `you're in: **${md(role('staff'))}** at the sam altman office.`,
    'you can now see:',
    `• ${projects.map((p) => mention(p.feedChannel)).join(' ')} every push, every branch`,
    `• ${mention('launch-livestream')} deploys, merged prs and the standup`,
    `• ${mention('red-team')} code review`,
    'and use `/source`, `/diff`, `/commits`, `/branches`, `/worktree` and `/review`.',
    'the private repos need github access too: `/access request` (skip it if you already asked).',
  ].join('\n');
}

/**
 * Humans who joined after `since` and hold neither the staff nor the waitlist role and have no
 * card yet: arrivals the bot missed while it was down. `members`: [{ id, bot, joinedAt, roles }].
 */
export function missedArrivals(members, { since, roleIds, ownerIds = [], carded = {} }) {
  return members.filter(
    (m) =>
      !m.bot &&
      !ownerIds.includes(m.id) &&
      !carded[m.id] &&
      Number(m.joinedAt ?? 0) > since &&
      !roleIds.some((id) => id && m.roles.includes(id)),
  );
}

// ------------------------------------------------------------------ discord helpers

/** A message in a layout channel by id, or null (missing, deleted, dry-run). */
export async function fetchMessage(ctx, key, id) {
  if (!id || ctx.dryRun) return null;
  const channel = await ctx.guildCtx.channel(key);
  if (!channel) return null;
  return channel.messages.fetch(id).catch(() => null);
}

/**
 * Add/remove layout roles (by key) on a member, touching only what differs. A missing-permission
 * error from Discord becomes a UserError the owner can act on.
 */
export async function setRoles(ctx, member, { add = [], remove = [] }, reason) {
  const toAdd = add.map((k) => ctx.guildCtx.roleId(k)).filter((id) => id && !member.roles.cache.has(id));
  const toRemove = remove.map((k) => ctx.guildCtx.roleId(k)).filter((id) => id && member.roles.cache.has(id));
  try {
    if (toAdd.length) await member.roles.add(toAdd, reason);
    if (toRemove.length) await member.roles.remove(toRemove, reason);
  } catch (err) {
    if (err?.code === 50013) throw new UserError("gojo can't hand out that role. drag gojo's role above the badges in server settings > roles.");
    throw err;
  }
  return { added: toAdd.length, removed: toRemove.length };
}

/** Mark someone's join card with a decision line and drop its buttons. Best effort. */
export async function markJoinCard(ctx, userId, line) {
  const msg = await fetchMessage(ctx, 'board-meeting', st(ctx).joins[userId]);
  if (!msg) return false;
  await msg.edit({ embeds: [resolveCardEmbed(msg.embeds[0], line)], components: [] });
  return true;
}

export function forgetJoin(ctx, userId) {
  const state = st(ctx);
  if (!(userId in state.joins)) return;
  delete state.joins[userId];
  ctx.state.save('onboarding');
}

function ownerPing(ctx) {
  const ownerId = ctx.guildCtx.ownerId;
  return ownerId ? { content: `<@${ownerId}>`, allowedMentions: { users: [ownerId] } } : {};
}

// ------------------------------------------------------------------ #front-desk

/** Make #front-desk hold exactly one pinned guide and one role panel, edited to current copy. */
export async function refreshFrontDesk(ctx) {
  const log = logger(ctx);
  const guide = { embeds: [buildGuideEmbed(names(ctx))], components: [] };
  const panel = buildPanel(names(ctx));
  if (ctx.dryRun) {
    log.info(`[dry-run] #front-desk: guide "${GUIDE_TITLE}" + panel with ${panel.components.length} button rows`);
    return;
  }
  const channel = await ctx.guildCtx.channel('front-desk');
  if (!channel) return;
  const state = st(ctx);
  const found = new Map(await channel.messages.fetch({ limit: 50 }));
  for (const id of [state.guideMessageId, state.panelMessageId]) {
    if (!id || found.has(id)) continue;
    const m = await channel.messages.fetch(id).catch(() => null);
    if (m) found.set(m.id, m);
  }
  const plan = planFrontDesk([...found.values()], ctx.client.user.id, state);
  for (const id of plan.remove) await found.get(id).delete().catch((err) => log.warn(`could not delete old front-desk message ${id}: ${err.message}`));

  const guideMsg = plan.guideId ? await found.get(plan.guideId).edit(guide) : await channel.send({ allowedMentions: { parse: [] }, ...guide });
  state.guideMessageId = guideMsg.id;
  ctx.state.save('onboarding', { immediate: true });
  if (!guideMsg.pinned) {
    try {
      await guideMsg.pin('front desk guide');
      await dropPinNotices(ctx, channel);
    } catch (err) {
      log.warn(`could not pin the front-desk guide (gojo needs Pin Messages in #front-desk): ${err.message}`);
    }
  }
  const panelMsg = plan.panelId ? await found.get(plan.panelId).edit(panel) : await channel.send({ allowedMentions: { parse: [] }, ...panel });
  state.panelMessageId = panelMsg.id;
  ctx.state.save('onboarding', { immediate: true });
  log.info(`front desk ready (guide ${plan.guideId ? 'edited' : 'posted'}, panel ${plan.panelId ? 'edited' : 'posted'})`);
}

async function dropPinNotices(ctx, channel) {
  const recent = await channel.messages.fetch({ limit: 5 });
  for (const m of recent.values()) {
    if (frontDeskKind(m, ctx.client.user.id) === 'notice') await m.delete().catch(() => {});
  }
}

// ------------------------------------------------------------------ arrivals

async function admit(ctx, member, { missed = false } = {}) {
  const log = logger(ctx);
  const state = st(ctx);
  if (ctx.dryRun) log.info(`[dry-run] would put ${member.user.tag} on the waitlist`);
  else {
    await setRoles(ctx, member, { add: ['waitlist'] }, 'new arrival').catch((err) => log.warn(`waitlist role for ${member.user.tag} failed: ${err.message}`));
  }
  const card = buildJoinCard({ userId: member.id, tag: member.user.tag, createdAt: member.user.createdAt, joinedAt: member.joinedAt, missed });
  const msg = await ctx.guildCtx.send('board-meeting', { ...card, ...ownerPing(ctx) });
  if (msg) state.joins[member.id] = msg.id;
  state.joinWatermark = Math.max(state.joinWatermark ?? 0, member.joinedTimestamp ?? Date.now());
  ctx.state.save('onboarding');
}

/** Card anyone who joined while the bot was down. The first run only sets the watermark. */
async function sweepArrivals(ctx) {
  const guild = ctx.guildCtx.guild;
  if (!guild) return;
  const state = st(ctx);
  const now = Date.now();
  if (state.joinWatermark == null) {
    state.joinWatermark = now;
    ctx.state.save('onboarding');
    return;
  }
  const members = [...guild.members.cache.values()];
  const missed = missedArrivals(
    members.map((m) => ({ id: m.id, bot: m.user.bot, joinedAt: m.joinedTimestamp, roles: [...m.roles.cache.keys()] })),
    {
      since: state.joinWatermark,
      roleIds: [ctx.guildCtx.roleId('staff'), ctx.guildCtx.roleId('waitlist')],
      ownerIds: [guild.ownerId, ...ctx.config.local.ownerIds],
      carded: state.joins,
    },
  );
  for (const { id } of missed) await admit(ctx, guild.members.cache.get(id), { missed: true });
  state.joinWatermark = Math.max(state.joinWatermark, now);
  ctx.state.save('onboarding');
  if (missed.length) logger(ctx).info(`carded ${missed.length} arrival(s) from while gojo was offline`);
}

// ------------------------------------------------------------------ hire / fire

/** Staff badge on, waitlist off, welcome DM. Returns { member, wasStaff }. */
async function hireMember(ctx, guild, userId, by) {
  if (!ctx.guildCtx.roleId('staff')) throw new UserError('the staff role is missing. run `/admin provision` first.');
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) throw new UserError('they already left the office.');
  if (member.user.bot) throw new UserError("bots don't get badges.");
  const wasStaff = member.roles.cache.has(ctx.guildCtx.roleId('staff'));
  await setRoles(ctx, member, { add: ['staff'], remove: ['waitlist'] }, `hired by ${by.username}`);
  if (!wasStaff) await member.send({ content: buildWelcomeDm(names(ctx)) }).catch(() => {});
  return { member, wasStaff };
}

function hiredLine(by, wasStaff) {
  return wasStaff ? `🪪 already had the badge (checked by ${by} ${ts(Date.now())})` : `🪪 hired by ${by} ${ts(Date.now())}`;
}

async function hireCommand(interaction, ctx) {
  if (!(await requireOwner(interaction, ctx))) return;
  const user = interaction.options.getUser('member', true);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const { wasStaff } = await hireMember(ctx, interaction.guild, user.id, interaction.user);
  await markJoinCard(ctx, user.id, hiredLine(interaction.user, wasStaff)).catch((err) => logger(ctx).warn(`join card for ${user.id}: ${err.message}`));
  forgetJoin(ctx, user.id);
  await interaction.editReply(
    wasStaff
      ? `${user} already had the **${md(roleName(ctx, 'staff'))}** badge. nothing changed.`
      : `hired ${user}: **${md(roleName(ctx, 'staff'))}**, off the waitlist, welcome dm sent (if their dms are open). github access is separate: \`/access\`.`,
  );
}

async function fireCommand(interaction, ctx) {
  if (!(await requireOwner(interaction, ctx))) return;
  const user = interaction.options.getUser('member', true);
  if (user.bot) throw new UserError("bots don't hold badges.");
  if (isOwner(ctx, user.id)) throw new UserError("can't fire the ceo. the board tried that once; he was back by monday.");
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const member = await interaction.guild.members.fetch(user.id).catch(() => null);
  if (!member) throw new UserError(`${user} isn't in the office anymore.`);
  const wasStaff = member.roles.cache.has(ctx.guildCtx.roleId('staff'));
  await setRoles(ctx, member, { add: ['waitlist'], remove: ['staff'] }, `fired by ${interaction.user.username}`);
  await ctx.guildCtx.send('board-meeting', {
    content: `🔥 ${user} (${md(user.tag)}) fired by ${interaction.user}. badge returned, back on the waitlist. reinstatement pending.`,
  });
  const grant = ctx.state.get('access').grants?.[user.id];
  const github = grant
    ? `they still have github access as \`${grant.github}\`: \`/access revoke\` removes it.`
    : 'github access is separate: `/access revoke` if they had any.';
  await interaction.editReply(`${wasStaff ? 'fired' : "they weren't staff, but they're on the waitlist now:"} ${user}. ${github}`);
}

// ------------------------------------------------------------------ module

export default {
  name: 'onboarding',

  commands: () => [
    new SlashCommandBuilder()
      .setName('hire')
      .setDescription('give someone the member of technical staff badge (owner)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
      .addUserOption((o) => o.setName('member').setDescription('who gets the badge').setRequired(true)),
    new SlashCommandBuilder()
      .setName('fire')
      .setDescription('take the member of technical staff badge back (owner)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
      .addUserOption((o) => o.setName('member').setDescription('who loses the badge').setRequired(true)),
  ],

  async onCommand(interaction, ctx) {
    if (interaction.commandName === 'hire') return hireCommand(interaction, ctx);
    if (interaction.commandName === 'fire') return fireCommand(interaction, ctx);
  },

  components: {
    /** Toggle a project's early-access ping role for the clicker. */
    async ping(interaction, ctx, [projectKey]) {
      const project = ctx.config.project(projectKey);
      if (!project) throw new UserError('that project is gone. the panel refreshes on the next restart.');
      if (!ctx.guildCtx.roleId(project.pingRole)) throw new UserError('that ping role does not exist yet. the ceo needs to run `/admin provision`.');
      const member = await interaction.guild.members.fetch(interaction.user.id);
      const had = member.roles.cache.has(ctx.guildCtx.roleId(project.pingRole));
      await setRoles(ctx, member, had ? { remove: [project.pingRole] } : { add: [project.pingRole] }, 'early access toggle');
      const name = md(roleName(ctx, project.pingRole));
      const later = isStaff(ctx, member) ? '' : ` (pings land in staff channels, so they start once you're **${md(roleName(ctx, 'staff'))}**)`;
      await interaction.reply({
        content: had ? `🔕 left **${name}**. no more ${md(project.name)} pings.` : `🔔 joined **${name}**. you'll get pinged when ${md(project.name)} ships${later}.`,
        flags: MessageFlags.Ephemeral,
      });
    },

    async hire(interaction, ctx, [userId]) {
      if (!(await requireOwner(interaction, ctx))) return;
      await interaction.deferUpdate();
      const { member, wasStaff } = await hireMember(ctx, interaction.guild, userId, interaction.user);
      await interaction.editReply({ embeds: [resolveCardEmbed(interaction.message.embeds[0], hiredLine(interaction.user, wasStaff))], components: [] });
      forgetJoin(ctx, userId);
      await interaction.followUp({
        content: wasStaff ? `${member} already had the badge.` : `hired ${member}. welcome dm sent (if their dms are open). github access is separate: \`/access\`.`,
        flags: MessageFlags.Ephemeral,
      });
    },

    async dismiss(interaction, ctx) {
      if (!(await requireOwner(interaction, ctx))) return;
      const line = `🙅 not now, per ${interaction.user} ${ts(Date.now())}. still on the waitlist; \`/hire\` works any time.`;
      await interaction.update({ embeds: [resolveCardEmbed(interaction.message.embeds[0], line)], components: [] });
    },
  },

  events: {
    async guildMemberAdd(member, ctx) {
      if (member.guild.id !== ctx.config.local.guildId || member.user.bot) return;
      await admit(ctx, member);
    },

    async guildMemberRemove(member, ctx) {
      if (member.guild.id !== ctx.config.local.guildId) return;
      const tag = member.user?.tag ?? member.id;
      const grant = ctx.state.get('access').grants?.[member.id];
      const extra = grant ? ` they still have github access as \`${grant.github}\`: \`/access revoke\` with their id (${member.id}) removes it.` : '';
      await ctx.guildCtx.send('board-meeting', { content: `👋 ${md(tag)} left the office.${extra}` });
      if (st(ctx).joins[member.id]) {
        await markJoinCard(ctx, member.id, `👋 left ${ts(Date.now())} before a decision.`).catch(() => {});
        forgetJoin(ctx, member.id);
      }
    },
  },

  async start(ctx) {
    try {
      await refreshFrontDesk(ctx);
    } catch (err) {
      logger(ctx).error('front desk refresh failed', err);
    }
    try {
      await sweepArrivals(ctx);
    } catch (err) {
      logger(ctx).error('arrival sweep failed', err);
    }
  },
};
