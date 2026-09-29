import { ChannelType, MessageFlags } from 'discord.js';

/**
 * The one guild this bot serves, addressed by layout keys instead of IDs. The provisioner
 * writes key -> id maps into state namespace `layout`: { channels, roles, tags: { forumKey: { tagKey: id } } }.
 */
export class GuildContext {
  constructor({ client, guildId, state, log, dryRun = false }) {
    this.client = client;
    this.guildId = guildId;
    this.state = state;
    this.log = log;
    this.dryRun = dryRun;
    this.warnedAt = new Map(); // layout key -> last "missing channel" warning (ms)
  }

  warnOnce(key, message) {
    const last = this.warnedAt.get(key) ?? 0;
    if (Date.now() - last < 3_600_000) return;
    this.warnedAt.set(key, Date.now());
    this.log.warn(message);
  }

  get guild() {
    return this.client.guilds.cache.get(this.guildId) ?? null;
  }

  get ids() {
    return this.state.get('layout', { channels: {}, roles: {}, tags: {} });
  }

  get ownerId() {
    return this.guild?.ownerId ?? null;
  }

  channelId(key) {
    return this.ids.channels[key] ?? null;
  }

  roleId(key) {
    return this.ids.roles[key] ?? null;
  }

  tagId(forumKey, tagKey) {
    return this.ids.tags?.[forumKey]?.[tagKey] ?? null;
  }

  /** Channel object for a layout key, or null (logged) when it is missing. */
  async channel(key) {
    const id = this.channelId(key);
    if (!id) {
      this.warnOnce(`${key}:missing`, `no channel for layout key "${key}" (run provisioning)`);
      return null;
    }
    const cached = this.client.channels.cache.get(id);
    if (cached) return cached;
    try {
      return await this.client.channels.fetch(id);
    } catch (err) {
      this.warnOnce(`${key}:fetch`, `channel "${key}" (${id}) could not be fetched: ${err.message}`);
      return null;
    }
  }

  role(key) {
    const id = this.roleId(key);
    return id ? this.guild?.roles.cache.get(id) ?? null : null;
  }

  /**
   * Post to a layout channel. Mentions are off unless the payload sets allowedMentions.
   * In dry-run the payload is logged and a fake message-like object is returned.
   */
  async send(key, payload) {
    const body = typeof payload === 'string' ? { content: payload } : payload;
    if (this.dryRun) {
      this.log.info(`[dry-run] -> #${key}`, summarise(body));
      return null;
    }
    const channel = await this.channel(key);
    if (!channel) return null;
    if (channel.type === ChannelType.GuildForum) throw new Error(`"${key}" is a forum; create a thread instead`);
    return channel.send({ allowedMentions: { parse: [] }, ...body });
  }
}

function summarise(body) {
  const parts = [];
  if (body.content) parts.push(`content=${JSON.stringify(body.content).slice(0, 300)}`);
  for (const e of body.embeds ?? []) {
    const d = typeof e.toJSON === 'function' ? e.toJSON() : e;
    parts.push(`embed[title=${JSON.stringify(d.title ?? '')} desc=${JSON.stringify((d.description ?? '').slice(0, 300))}]`);
  }
  if (body.components?.length) parts.push(`components=${body.components.length}`);
  if (body.files?.length) parts.push(`files=${body.files.length}`);
  return parts.join(' ');
}

/** Owner = the guild owner or anyone listed in local.json ownerIds. */
export function isOwner(ctx, userId) {
  return userId === ctx.guildCtx.ownerId || ctx.config.local.ownerIds.includes(userId);
}

/** Staff = owner or a holder of the `staff` role. `member` may be a GuildMember or API member. */
export function isStaff(ctx, member) {
  if (!member) return false;
  const userId = member.user?.id ?? member.id;
  if (isOwner(ctx, userId)) return true;
  const staffId = ctx.guildCtx.roleId('staff');
  if (!staffId) return false;
  const roles = member.roles?.cache ? [...member.roles.cache.keys()] : member.roles ?? [];
  return roles.includes(staffId);
}

/** Reply ephemerally and return false unless the interaction user is staff. */
export async function requireStaff(interaction, ctx) {
  if (isStaff(ctx, interaction.member)) return true;
  const name = ctx.guildCtx.role('staff')?.name ?? 'member of technical staff';
  await interaction.reply({
    content: `that one needs the **${name}** badge. ask the ceo, or use \`/access\` to request it.`,
    flags: MessageFlags.Ephemeral,
  });
  return false;
}

export async function requireOwner(interaction, ctx) {
  if (isOwner(ctx, interaction.user.id)) return true;
  await interaction.reply({ content: 'board members only. (the board is one guy.)', flags: MessageFlags.Ephemeral });
  return false;
}
