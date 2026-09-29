import { EventEmitter } from 'node:events';
import path from 'node:path';
import { ActivityType, Client, Events, GatewayIntentBits } from 'discord.js';
import { loadConfig } from './core/config.mjs';
import { createLogger } from './core/log.mjs';
import { StateStore } from './core/state.mjs';
import { GitHub } from './core/github.mjs';
import { GuildContext } from './core/guild.mjs';
import { Router } from './core/router.mjs';
import { Scheduler } from './core/scheduler.mjs';
import { codeBlock, truncate } from './core/format.mjs';
import { modules } from './modules/index.mjs';
import { provisionLayout } from './modules/provision.mjs';

// Exit code the supervisor (ops/supervisor.mjs) reads as "pull updates and restart now".
export const RESTART_EXIT_CODE = 75;

/**
 * Builds the bot: config, logger, state, GitHub, Discord client, ctx and router. Nothing
 * connects until boot(). Used by src/index.mjs (the real bot) and ops/dev-interact.mjs
 * (the handler test harness), so both run exactly the same wiring.
 */
export function createApp(args, { logFile = 'devbot.log', exit = (code) => process.exit(code) } = {}) {
  const logRoot = createLogger({ dir: path.join(args.home, 'logs'), file: logFile, level: process.env.DEVBOT_LOG_LEVEL || 'info' });
  const log = logRoot.child('main');
  const config = loadConfig(args.home);
  if (!config.local.guildId) throw Object.assign(new Error(`no guildId in ${path.join(args.home, 'local.json')}`), { exitCode: 2 });
  if (!process.env.DISCORD_TOKEN) {
    throw Object.assign(new Error('DISCORD_TOKEN is not set (start through ops/supervisor.mjs or ops/dev.mjs, which read Windows Credential Manager)'), { exitCode: 2 });
  }

  const state = new StateStore(path.join(args.home, 'state'), logRoot.child('state'));
  const github = new GitHub({ token: process.env.GITHUB_TOKEN, log: logRoot.child('github') });
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
    allowedMentions: { parse: [] },
  });
  const flags = state.get('flags', { paused: false });

  const ctx = {
    args,
    config,
    client,
    state,
    github,
    flags,
    log: logRoot,
    dryRun: !!args.dryRun,
    startedAt: new Date(),
    guildCtx: new GuildContext({ client, guildId: config.local.guildId, state, log: logRoot.child('guild'), dryRun: !!args.dryRun }),
    // Cross-module events, e.g. activity emits 'issue:closed' that feedback listens to.
    bus: new EventEmitter(),
    scheduler: null,
    router: null,
    restart: (reason) => shutdown(RESTART_EXIT_CODE, reason),
    shutdown: (reason) => shutdown(0, reason),
  };
  ctx.scheduler = new Scheduler({ log: logRoot.child('scheduler'), flags });
  ctx.router = new Router(ctx);
  for (const mod of modules) ctx.router.use(mod);

  // ---------------------------------------------------------------- #compute-bill log sink
  const pendingLogs = [];
  let sinkTimer = null;
  logRoot.sink = (lvl, scope, text) => {
    if (ctx.dryRun || args.noLogSink || scope === 'guild') return; // guild-scope warnings are about posting itself
    const line = `${lvl === 'error' ? '🟥' : '🟨'} [${scope}] ${text.split('\n')[0]}`;
    if (pendingLogs.length < 30 && !pendingLogs.includes(line)) pendingLogs.push(line);
    if (!sinkTimer) sinkTimer = setTimeout(flushLogSink, 15_000);
  };
  async function flushLogSink() {
    if (sinkTimer) clearTimeout(sinkTimer);
    sinkTimer = null;
    if (!pendingLogs.length || !client.isReady()) return;
    const lines = pendingLogs.splice(0);
    try {
      await ctx.guildCtx.send('compute-bill', { content: truncate(codeBlock(lines.join('\n')), 1990) });
    } catch {
      // never recurse into the logger from here
    }
  }

  // ---------------------------------------------------------------- lifecycle
  let shuttingDown = false;
  async function shutdown(code, reason) {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`shutting down (${reason ?? 'signal'}), exit ${code}`);
    ctx.scheduler.stopAll();
    await ctx.router.stopAll();
    await flushLogSink();
    state.flush();
    try {
      await client.destroy();
    } catch {
      /* ignore */
    }
    exit(code);
  }

  async function leaveForeignGuilds() {
    for (const guild of client.guilds.cache.values()) {
      if (guild.id === config.local.guildId) continue;
      log.warn(`leaving unexpected guild ${guild.name} (${guild.id}); this bot is private`);
      try {
        await guild.leave();
      } catch (err) {
        log.error(`could not leave ${guild.id}`, err);
      }
    }
  }

  /**
   * Connect and get ready. opts: provision (full layout apply), provisionOnly, noPoll,
   * live (false = harness mode: no interaction handling, no gateway event modules, no
   * command registration, no presence, no module start).
   */
  async function boot({ provision = false, provisionOnly = false, noPoll = false, live = true } = {}) {
    client.on(Events.Error, (err) => log.error('discord client error', err));
    client.on(Events.ShardDisconnect, (event) => log.warn(`gateway disconnected (code ${event?.code})`));
    if (live) {
      client.on(Events.GuildCreate, () => leaveForeignGuilds());
      client.on(Events.InteractionCreate, (interaction) => ctx.router.handle(interaction));
      ctx.router.bindEvents(client);
    }
    const ready = new Promise((resolve) => client.once(Events.ClientReady, resolve));
    await client.login(process.env.DISCORD_TOKEN);
    await ready;
    log.info(`logged in as ${client.user.tag}${live ? '' : ' (harness mode)'}`);
    if (live) await leaveForeignGuilds();
    const guild = client.guilds.cache.get(config.local.guildId);
    if (!guild) throw new Error(`bot is not in guild ${config.local.guildId}`);
    await guild.members.fetch(); // owner + roles for permission checks and onboarding
    await client.application.fetch();

    const report = await provisionLayout(ctx, { apply: provision });
    log.info(`layout ${provision ? 'applied' : 'ensured'}: ${report.summary}`);
    if (provisionOnly || !live) return report;

    await ctx.router.registerCommands();
    client.user.setPresence({
      activities: [{ type: ActivityType.Watching, name: config.projects.map((p) => p.name).join(', ') }],
      status: 'online',
    });
    if (!noPoll) await ctx.router.startAll();
    else log.info('--no-poll: modules not started');
    log.info('ready');
    return report;
  }

  return { ctx, client, log, logRoot, boot, shutdown };
}
