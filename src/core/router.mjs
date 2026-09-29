import { MessageFlags, Routes } from 'discord.js';
import { truncate } from './format.mjs';

/**
 * Module contract (every file in src/modules exports one default object):
 *
 *   {
 *     name: 'feed',                                   // also the customId prefix
 *     commands: [builders] | (config) => [builders],  // optional, registered per guild
 *     async onCommand(interaction, ctx) {},           // chat-input commands owned by this module
 *     async onAutocomplete(interaction, ctx) {},      // autocomplete for its commands
 *     components: { action: async (interaction, ctx, args) => {} },  // buttons, selects, modals
 *     events: { guildMemberAdd: async (member, ctx) => {} },          // extra gateway events
 *     async start(ctx) {},                            // after the guild is ready + provisioned
 *     async stop(ctx) {},
 *   }
 *
 * customId format: `${module.name}:${action}:${arg1}:${arg2}...` (max 100 chars). Args must not
 * contain ':'. Use ids(module, action, ...args) to build one safely.
 */
export function cid(moduleName, action, ...args) {
  const id = [moduleName, action, ...args.map((a) => String(a))].join(':');
  if (id.length > 100) throw new Error(`customId too long (${id.length}): ${id}`);
  for (const a of args) if (String(a).includes(':')) throw new Error(`customId arg contains ':' (${a})`);
  return id;
}

export class Router {
  constructor(ctx) {
    this.ctx = ctx;
    this.modules = [];
    this.byCommand = new Map();
    this.byName = new Map();
  }

  use(mod) {
    if (!mod?.name) throw new Error('module without a name');
    if (this.byName.has(mod.name)) throw new Error(`duplicate module ${mod.name}`);
    this.modules.push(mod);
    this.byName.set(mod.name, mod);
    const commands = typeof mod.commands === 'function' ? mod.commands(this.ctx.config) : mod.commands ?? [];
    for (const cmd of commands) {
      const json = typeof cmd.toJSON === 'function' ? cmd.toJSON() : cmd;
      if (this.byCommand.has(json.name)) throw new Error(`command /${json.name} registered twice`);
      this.byCommand.set(json.name, { mod, json });
    }
    return this;
  }

  commandJSON() {
    return [...this.byCommand.values()].map((c) => c.json);
  }

  /** Bulk-overwrite this guild's commands so removed commands disappear too. */
  async registerCommands() {
    const { client, config, log } = this.ctx;
    const body = this.commandJSON();
    await client.rest.put(Routes.applicationGuildCommands(client.application.id, config.local.guildId), { body });
    log.info(`registered ${body.length} guild commands: ${body.map((c) => `/${c.name}`).join(' ')}`);
  }

  async handle(interaction) {
    const { log } = this.ctx;
    try {
      if (interaction.guildId !== this.ctx.config.local.guildId) {
        if (interaction.isRepliable()) {
          await interaction.reply({ content: 'this bot only works in its home server.', flags: MessageFlags.Ephemeral });
        }
        return;
      }
      if (interaction.isChatInputCommand()) {
        const entry = this.byCommand.get(interaction.commandName);
        if (!entry?.mod.onCommand) return;
        await entry.mod.onCommand(interaction, this.ctx);
      } else if (interaction.isAutocomplete()) {
        const entry = this.byCommand.get(interaction.commandName);
        if (!entry?.mod.onAutocomplete) return interaction.respond([]);
        await entry.mod.onAutocomplete(interaction, this.ctx);
      } else if (interaction.isButton() || interaction.isAnySelectMenu() || interaction.isModalSubmit()) {
        const [modName, action, ...args] = interaction.customId.split(':');
        const handler = this.byName.get(modName)?.components?.[action];
        if (!handler) {
          await interaction.reply({ content: 'that button is from an older GOJO. try the command again.', flags: MessageFlags.Ephemeral });
          return;
        }
        await handler(interaction, this.ctx, args);
      }
    } catch (err) {
      const userError = err?.name === 'UserError';
      if (userError) log.info(`interaction ${describe(interaction)}: ${err.message}`);
      else log.error(`interaction ${describe(interaction)} failed`, err);
      if (interaction.isAutocomplete()) {
        try {
          if (!interaction.responded) await interaction.respond([]);
        } catch {
          /* too late */
        }
        return;
      }
      const content = userError ? truncate(err.message, 1900) : `GOJO tripped on that one: ${truncate(err.message ?? String(err), 300)}`;
      try {
        // deferReply sets interaction.ephemeral to a boolean; deferUpdate leaves it null, and there an
        // editReply would overwrite the clicked message, so that case gets a follow-up instead.
        const deferredReply = interaction.deferred && !interaction.replied && typeof interaction.ephemeral === 'boolean';
        if (deferredReply) {
          // A handler may already have deleted its "thinking…" reply (10008 Unknown Message on edit).
          await interaction
            .editReply({ content, embeds: [], components: [], files: [] })
            .catch(() => interaction.followUp({ content, flags: MessageFlags.Ephemeral }));
        } else if (interaction.deferred || interaction.replied) await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
        else await interaction.reply({ content, flags: MessageFlags.Ephemeral });
      } catch (replyErr) {
        // 10062 = the 3 s window (or 15 min for deferred) passed before anyone answered
        if (replyErr?.code === 10062) log.warn(`interaction ${describe(interaction)} expired before GOJO could answer`);
        else log.warn(`could not tell the user about the failure of ${describe(interaction)}: ${replyErr?.message ?? replyErr}`);
      }
    }
  }

  async startAll() {
    for (const mod of this.modules) {
      if (!mod.start) continue;
      try {
        await mod.start(this.ctx);
        this.ctx.log.info(`module ${mod.name} started`);
      } catch (err) {
        this.ctx.log.error(`module ${mod.name} failed to start`, err);
      }
    }
  }

  async stopAll() {
    for (const mod of [...this.modules].reverse()) {
      try {
        await mod.stop?.(this.ctx);
      } catch (err) {
        this.ctx.log.warn(`module ${mod.name} stop failed`, err);
      }
    }
  }

  /** Wire module `events` maps onto the client. */
  bindEvents(client) {
    for (const mod of this.modules) {
      for (const [event, fn] of Object.entries(mod.events ?? {})) {
        client.on(event, async (...args) => {
          try {
            await fn(...args, this.ctx);
          } catch (err) {
            this.ctx.log.error(`module ${mod.name} event ${event} failed`, err);
          }
        });
      }
    }
  }
}

function describe(interaction) {
  if (interaction.isChatInputCommand?.()) return `/${interaction.commandName} by ${interaction.user?.username}`;
  return `${interaction.customId ?? interaction.type} by ${interaction.user?.username}`;
}
