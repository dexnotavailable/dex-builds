import {
  ChannelType,
  ForumLayoutType,
  GuildDefaultMessageNotifications,
  OverwriteType,
  PermissionFlagsBits,
  SortOrderType,
} from 'discord.js';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../core/config.mjs';
import { hexColor } from '../core/format.mjs';

// Server layout as code (config/layout.json).
//
// ensure (every start): find everything by stored id, else adopt by name, else create. Items that
// already exist are left exactly as Dex has them, so manual renames/permission tweaks survive a
// restart. Missing forum tags are added because features depend on them.
// apply (--provision or /admin provision): additionally re-applies names, topics, colours,
// permissions, ordering and guild settings from the layout.

const TYPE = {
  text: ChannelType.GuildText,
  voice: ChannelType.GuildVoice,
  forum: ChannelType.GuildForum,
};

function perms(names, where) {
  let bits = 0n;
  for (const name of names ?? []) {
    const bit = PermissionFlagsBits[name];
    if (bit === undefined) throw new Error(`unknown permission "${name}" in ${where}`);
    bits |= bit;
  }
  return bits;
}

function sameName(a, b) {
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

/** Discord permission overwrites for a preset. Keys: everyone, bot, or any layout role key. */
function overwritesFor(ctx, presetName, where) {
  const preset = ctx.config.layout.presets[presetName];
  if (!preset) throw new Error(`unknown preset "${presetName}" in ${where}`);
  const guild = ctx.guildCtx.guild;
  const out = [];
  for (const [key, rule] of Object.entries(preset)) {
    let id;
    let type = OverwriteType.Role;
    if (key === 'everyone') id = guild.roles.everyone.id;
    else if (key === 'bot') {
      id = ctx.client.user.id;
      type = OverwriteType.Member;
    } else {
      id = ctx.guildCtx.roleId(key);
      if (!id) throw new Error(`preset ${presetName} references role "${key}" which does not exist`);
    }
    out.push({ id, type, allow: perms(rule.allow, `${presetName}.${key}`), deny: perms(rule.deny, `${presetName}.${key}`) });
  }
  return out;
}

/** Existing overwrites equal to the wanted set? (so apply does not churn the audit log) */
function overwritesMatch(channel, wanted) {
  const current = channel.permissionOverwrites.cache;
  if (current.size !== wanted.length) return false;
  for (const w of wanted) {
    const c = current.get(w.id);
    if (!c || c.allow.bitfield !== w.allow || c.deny.bitfield !== w.deny) return false;
  }
  return true;
}

function tagEmoji(tag) {
  return tag.emoji ? { id: null, name: tag.emoji } : null;
}

export async function provisionLayout(ctx, { apply = false } = {}) {
  const log = ctx.log.child('provision');
  const guild = ctx.guildCtx.guild;
  if (!guild) throw new Error('guild not available');
  const layout = ctx.config.layout;
  const ids = ctx.guildCtx.ids;
  ids.channels ??= {};
  ids.roles ??= {};
  ids.tags ??= {};
  const created = [];
  const updated = [];
  const reason = apply ? 'GOJO layout apply' : 'GOJO layout ensure';

  await guild.roles.fetch();
  await guild.channels.fetch();

  // ------------------------------------------------------------------ roles
  for (const spec of layout.roles) {
    let role = ids.roles[spec.key] ? guild.roles.cache.get(ids.roles[spec.key]) : null;
    if (!role) role = guild.roles.cache.find((r) => !r.managed && sameName(r.name, spec.name)) ?? null;
    const color = hexColor(spec.color, 0);
    const wanted = { name: spec.name, colors: { primaryColor: color }, hoist: !!spec.hoist, mentionable: !!spec.mentionable };
    if (!role) {
      role = await guild.roles.create({ ...wanted, permissions: [], reason });
      created.push(`role ${spec.name}`);
    } else if (apply) {
      const differs = role.name !== wanted.name || (role.colors?.primaryColor ?? role.color) !== color || role.hoist !== wanted.hoist || role.mentionable !== wanted.mentionable;
      if (differs) {
        await role.edit({ ...wanted, reason });
        updated.push(`role ${spec.name}`);
      }
    }
    ids.roles[spec.key] = role.id;
  }

  // Owner badge (idempotent).
  for (const spec of layout.roles.filter((r) => r.grantToOwner)) {
    const owner = await guild.members.fetch(guild.ownerId).catch(() => null);
    if (owner && !owner.roles.cache.has(ids.roles[spec.key])) {
      await owner.roles.add(ids.roles[spec.key], reason);
      updated.push(`gave ${spec.name} to the owner`);
    }
  }

  if (apply) {
    // Keep layout order (top -> bottom) directly under the bot's own role.
    const me = await guild.members.fetchMe();
    const top = me.roles.highest.position;
    if (top <= 1) {
      // The bot's own role sits at the bottom, so it cannot reorder anything; ties sort by id
      // (creation order), which matches the layout order anyway. Only the owner can lift it.
      log.warn("GOJO's role is at the bottom of the role list; drag it to the top in Server Settings > Roles so badges can be ordered");
    }
    const positions = [];
    let pos = top - 1;
    for (const spec of layout.roles) {
      const role = guild.roles.cache.get(ids.roles[spec.key]);
      if (!role || pos < 1) continue;
      if (role.position !== pos) positions.push({ role: role.id, position: pos });
      pos -= 1;
    }
    if (positions.length) {
      await guild.roles.setPositions(positions);
      updated.push('role order');
    }
    // @everyone base permissions
    const everyone = guild.roles.everyone;
    const deny = perms(layout.guild.everyoneDeny, 'guild.everyoneDeny');
    if ((everyone.permissions.bitfield & deny) !== 0n) {
      await everyone.setPermissions(everyone.permissions.bitfield & ~deny, reason);
      updated.push('@everyone permissions');
    }
  }
  ctx.state.save('layout', { immediate: true });

  // ------------------------------------------------------------------ categories + channels
  const categoryOrder = [];
  for (const [ci, cat] of layout.categories.entries()) {
    let category = ids.channels[cat.key] ? guild.channels.cache.get(ids.channels[cat.key]) : null;
    if (category && category.type !== ChannelType.GuildCategory) category = null;
    if (!category) {
      const names = [cat.name, ...(cat.adopt ?? [])];
      category =
        guild.channels.cache.find((c) => c.type === ChannelType.GuildCategory && names.some((n) => sameName(c.name, n)) && !Object.values(ids.channels).includes(c.id)) ?? null;
    }
    const catOverwrites = overwritesFor(ctx, cat.preset ?? 'open', `category ${cat.key}`);
    if (!category) {
      category = await guild.channels.create({ name: cat.name, type: ChannelType.GuildCategory, permissionOverwrites: catOverwrites, reason });
      created.push(`category ${cat.name}`);
    } else if (apply || !ids.channels[cat.key]) {
      // First adoption renames too, so "Text Channels" becomes the layout's category.
      if (category.name !== cat.name) {
        await category.setName(cat.name, reason);
        updated.push(`category ${cat.name}`);
      }
      if (!overwritesMatch(category, catOverwrites)) {
        await category.permissionOverwrites.set(catOverwrites, reason);
        updated.push(`category ${cat.name} permissions`);
      }
    }
    ids.channels[cat.key] = category.id;
    categoryOrder.push({ channel: category.id, position: ci });

    const channelOrder = [];
    for (const [chi, spec] of cat.channels.entries()) {
      const type = TYPE[spec.type];
      if (type === undefined) throw new Error(`channel ${spec.key}: unknown type ${spec.type}`);
      let channel = ids.channels[spec.key] ? guild.channels.cache.get(ids.channels[spec.key]) : null;
      if (channel && channel.type !== type) channel = null;
      const adopting = !channel;
      if (!channel) {
        const names = [spec.name, ...(spec.adopt ?? [])];
        channel =
          guild.channels.cache.find((c) => c.type === type && names.some((n) => sameName(c.name, n)) && !Object.values(ids.channels).includes(c.id)) ?? null;
      }
      const overwrites = overwritesFor(ctx, spec.preset ?? cat.preset ?? 'open', `channel ${spec.key}`);
      if (!channel) {
        const options = {
          name: spec.name,
          type,
          parent: category.id,
          permissionOverwrites: overwrites,
          reason,
        };
        if (spec.topic && type !== ChannelType.GuildVoice) options.topic = spec.topic;
        if (type === ChannelType.GuildForum) {
          options.availableTags = (spec.tags ?? []).map((t) => ({ name: t.name, emoji: tagEmoji(t), moderated: !!t.moderated }));
          if (spec.defaultReaction) options.defaultReactionEmoji = { id: null, name: spec.defaultReaction };
          options.defaultSortOrder = SortOrderType.LatestActivity;
          options.defaultForumLayout = ForumLayoutType.ListView;
        }
        channel = await guild.channels.create(options);
        created.push(`#${spec.name}`);
      } else if (apply || adopting) {
        const edit = {};
        if (channel.name !== spec.name) edit.name = spec.name;
        if (channel.parentId !== category.id) edit.parent = category.id;
        if (spec.topic && type !== ChannelType.GuildVoice && channel.topic !== spec.topic) edit.topic = spec.topic;
        if (type === ChannelType.GuildForum && spec.defaultReaction && channel.defaultReactionEmoji?.name !== spec.defaultReaction) {
          edit.defaultReactionEmoji = { id: null, name: spec.defaultReaction };
        }
        if (Object.keys(edit).length) {
          await channel.edit({ ...edit, lockPermissions: false, reason });
          updated.push(`#${spec.name}`);
        }
        if (!overwritesMatch(channel, overwrites)) {
          await channel.permissionOverwrites.set(overwrites, reason);
          updated.push(`#${spec.name} permissions`);
        }
      }
      ids.channels[spec.key] = channel.id;
      channelOrder.push({ channel: channel.id, position: chi, parent: category.id });

      // Forum tags: always make sure every layout tag exists (features depend on them);
      // apply also refreshes emoji/moderated on existing ones.
      if (type === ChannelType.GuildForum && spec.tags?.length) {
        const current = channel.availableTags ?? [];
        const next = current.map((t) => ({ id: t.id, name: t.name, emoji: t.emoji, moderated: t.moderated }));
        let changed = false;
        for (const tag of spec.tags) {
          const existing = next.find((t) => sameName(t.name, tag.name));
          if (!existing) {
            next.push({ name: tag.name, emoji: tagEmoji(tag), moderated: !!tag.moderated });
            changed = true;
          } else if (apply && (existing.moderated !== !!tag.moderated || (existing.emoji?.name ?? null) !== (tag.emoji ?? null))) {
            existing.moderated = !!tag.moderated;
            existing.emoji = tagEmoji(tag);
            changed = true;
          }
        }
        if (changed) {
          if (next.length > 20) throw new Error(`forum ${spec.key} would have ${next.length} tags (max 20)`);
          channel = await channel.setAvailableTags(next, reason);
          updated.push(`#${spec.name} tags`);
        }
        ids.tags[spec.key] = {};
        for (const tag of spec.tags) {
          const t = channel.availableTags.find((x) => sameName(x.name, tag.name));
          if (t) ids.tags[spec.key][tag.key] = t.id;
        }
      }
    }
    if (apply || created.length) {
      const moves = channelOrder.filter((o) => {
        const ch = guild.channels.cache.get(o.channel);
        return ch && (ch.position !== o.position || ch.parentId !== o.parent);
      });
      if (moves.length) {
        // Parents were already set by create/edit; Discord rejects batches that carry several parent_ids.
        for (const o of moves) {
          const ch = guild.channels.cache.get(o.channel);
          if (ch && ch.parentId !== o.parent) await ch.setParent(o.parent, { lockPermissions: false, reason });
        }
        await guild.channels.setPositions(moves.map((o) => ({ channel: o.channel, position: o.position })));
        updated.push(`order in ${cat.name}`);
      }
    }
  }
  if (apply || created.length) {
    const moves = categoryOrder.filter((o) => guild.channels.cache.get(o.channel)?.position !== o.position);
    if (moves.length) {
      await guild.channels.setPositions(moves);
      updated.push('category order');
    }
  }
  ctx.state.save('layout', { immediate: true });

  // ------------------------------------------------------------------ guild settings (apply only)
  if (apply) {
    const g = layout.guild;
    const edit = {};
    const sys = ids.channels[g.systemChannel];
    const afk = ids.channels[g.afkChannel];
    if (sys && guild.systemChannelId !== sys) edit.systemChannel = sys;
    if (afk && guild.afkChannelId !== afk) edit.afkChannel = afk;
    if (g.afkTimeoutSeconds && guild.afkTimeout !== g.afkTimeoutSeconds) edit.afkTimeout = g.afkTimeoutSeconds;
    if (g.defaultNotifications === 'only_mentions' && guild.defaultMessageNotifications !== GuildDefaultMessageNotifications.OnlyMentions) {
      edit.defaultMessageNotifications = GuildDefaultMessageNotifications.OnlyMentions;
    }
    // The icon is only set when the server has none, so a hand-picked icon is never replaced.
    if (g.icon && !guild.icon) {
      const file = path.join(REPO_ROOT, g.icon);
      if (fs.existsSync(file)) edit.icon = fs.readFileSync(file);
    }
    if (Object.keys(edit).length) {
      await guild.edit({ ...edit, reason });
      updated.push(`guild settings (${Object.keys(edit).join(', ')})`);
    }
  }

  const summary = `${created.length} created, ${updated.length} updated` + (created.length || updated.length ? `: ${[...created, ...updated].join('; ')}` : '');
  log.info(summary);
  return { created, updated, summary };
}

export default {
  name: 'provision',
};
