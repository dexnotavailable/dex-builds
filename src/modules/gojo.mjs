import { PermissionFlagsBits } from 'discord.js';
import { isOwner } from '../core/guild.mjs';
import { GojoStore, digest } from '../core/gojo-store.mjs';
import { GojoCli } from '../core/gojo-cli.mjs';
import { addressed, contextKey, executeAction, publicText, validateResponse, snowflake, explicitExport, isBotOrSelf, markGojoFeedback, gojoFeedbackOrigin } from '../core/gojo-policy.mjs';
import { buildPrompt, collectSnapshot, pendingProjects, visibleMessageMetadata } from '../core/gojo-context.mjs';
import { redactSecrets } from '../core/redact.mjs';
import { GojoRelay } from '../core/gojo-relay.mjs';

const controllers = new WeakMap();
const allowedMentions = { parse: [], repliedUser: false };

export function createGojoController(ctx, { store = new GojoStore(ctx.config.home), cli = null, snapshot = collectSnapshot, relay = null, now = () => Date.now() } = {}) {
  const config = ctx.config.gojo;
  const log = ctx.log.child('gojo');
  cli ??= new GojoCli({ config, store, log });
  relay ??= new GojoRelay({ ctx, now });
  let tail = Promise.resolve(), queued = 0, active = null, stopped = false;
  let relayWork = null, relayAbort = null;
  const pending = new Map();
  const recoveryQueued = new Set();

  function enqueue(kind, work) {
    if (stopped) return Promise.resolve(false);
    queued += 1;
    const promise = tail.then(async () => {
      queued -= 1;
      if (stopped) return false;
      const abort = new AbortController();
      active = { kind, abort };
      try { return await work(abort.signal); }
      finally { active = null; }
    });
    tail = promise.catch(() => {});
    return promise;
  }

  async function serverData(userId, { privateContext = false, currentChannelId = null } = {}) {
    const guild = ctx.guildCtx.guild;
    if (!guild) return {};
    const owner = isOwner(ctx, userId);
    const member = await guild.members.fetch(userId);
    const everyone = guild.roles?.everyone;
    const channels = [...guild.channels.cache.values()].filter((channel) => channel.permissionsFor(member)?.has(PermissionFlagsBits.ViewChannel) && (channel.id === currentChannelId || (privateContext && owner) || (everyone && channel.permissionsFor(everyone)?.has(PermissionFlagsBits.ViewChannel)))).slice(0, 100).map((channel) => ({ id: channel.id, name: channel.name, type: channel.type }));
    const users = owner ? [...guild.members.cache.values()].filter((entry) => !entry.user.bot).slice(0, 100).map((entry) => ({ id: entry.id, name: entry.displayName, username: entry.user.username })) : [{ id: member.id, name: member.displayName }];
    return { owner, channels, users };
  }

  async function sendReply(message, text) {
    const content = message.guildId ? publicText(text) : redactSecrets(text);
    if (!content.trim()) return null;
    if (ctx.dryRun) return { id: 'dry-run', content };
    const sent = await message.reply({ content: content.slice(0, 1800), allowedMentions, flags: 4 });
    markGojoFeedback(sent, 'gojo-reply');
    const context = store.context(contextKey(message));
    context.lastReplyByUser ??= {};
    context.lastReplyByUser[message.author.id] = new Date(now()).toISOString();
    store.save();
    return sent;
  }

  function scheduleContext(key, immediate = false) {
    const group = pending.get(key);
    if (!group || group.running || group.scheduled) return;
    if (group.timer && !immediate) return;
    if (group.timer) clearTimeout(group.timer);
    const launch = () => {
      group.timer = null; group.scheduled = true;
      enqueue('message', async (signal) => {
        group.scheduled = false; group.running = true;
        const requiresIndividualTurn = (entry) => entry.conversation.addressed || entry.conversation.explicitReply || entry.conversation.relayStatus;
        let count = requiresIndividualTurn(group.entries[0]) ? 1 : config.messagesPerBatch ?? 8;
        if (count > 1) {
          const boundary = group.entries.findIndex((entry, index) => index > 0 && requiresIndividualTurn(entry));
          if (boundary > 0) count = Math.min(count, boundary);
        }
        const batch = group.entries.splice(0, count);
        let result = false;
        try { result = await processMessages(batch, signal); }
        finally {
          group.running = false;
          for (const entry of batch) entry.resolve(result);
          if (group.entries.length) scheduleContext(key, true);
          else pending.delete(key);
        }
        return result;
      }).catch(() => {});
    };
    if (immediate) launch();
    else group.timer = setTimeout(launch, config.chatterDebounceMs ?? 1200);
  }

  async function onMessage(message) {
    if (!config?.enabled || stopped || !snowflake(message?.id) || !snowflake(message?.author?.id)) return false;
    if (message.guildId && message.guildId !== ctx.config.local.guildId) return false;
    if (config.ignoreChannelIds?.includes(message.channelId)) return false;
    if (message.partial) { try { await message.fetch(); } catch { return false; } }
    if (message.reference && !message.mentions?.repliedUser && !message.referencedAuthorId) {
      try { message.referencedAuthorId = (await message.fetchReference()).author.id; } catch { /* deleted references do not grant addressing */ }
    }
    // DMs stay limited to home-server members. Every visible home-channel message is captured.
    if (!message.guildId) { try { await ctx.guildCtx.guild.members.fetch(message.author.id); } catch { return false; } }
    // First persisted snapshot must contain both the dedup key and its human brain payload.
    if (!store.beginMessage(message.id, { deferSave: true })) return false;
    const key = contextKey(message);
    const context = store.context(key);
    const isAddressed = addressed(message, ctx.client.user.id);
    const lastInteraction = Math.max(Date.parse(context.lastHumanByUser?.[message.author.id] ?? '') || 0, Date.parse(context.lastReplyByUser?.[message.author.id] ?? '') || 0);
    const idleSeconds = lastInteraction ? Math.max(0, (now() - lastInteraction) / 1000) : null;
    const instruction = redactSecrets(String(message.content ?? '')).slice(0, 6000);
    message.gojoVisibleMetadata = visibleMessageMetadata(message);
    const bot = isBotOrSelf(message, ctx.client.user.id);
    const producerOrigin = gojoFeedbackOrigin(message);
    const captured = { role: bot ? message.author.id === ctx.client.user.id || producerOrigin ? 'assistant' : 'bot' : 'user', userId: message.author.id, name: message.author.username, messageId: message.id, content: instruction, visible: message.gojoVisibleMetadata, ...(producerOrigin ? { producerOrigin } : {}) };
    if (bot) { store.data.messages[message.id].status = 'observed-bot'; store.record(key, captured); return false; }
    context.lastHumanByUser ??= {};
    context.lastHumanByUser[message.author.id] = new Date(now()).toISOString();
    context.projectHintsByUser ??= {};
    if (!message.reference && idleSeconds !== null && idleSeconds >= (config.conversationIdleSeconds ?? 900)) delete context.projectHintsByUser[message.author.id];
    if (/\b(?:dexclient|dex\.place|characterforge|blender|minecraft)\b/i.test(instruction) && !/\bdex[ -]?code\b/i.test(instruction)) delete context.projectHintsByUser[message.author.id];
    if (/\bdex[ -]?code\b/i.test(instruction)) context.projectHintsByUser[message.author.id] = 'dexcode';
    context.pendingForBrain ??= [];
    context.pendingForBrain.push({ messageId: message.id, channelId: message.channelId, guildId: message.guildId ?? null, userId: message.author.id, content: instruction, capturedAt: new Date(now()).toISOString() });
    store.record(key, captured); // atomically persists dedup + pending before relay/model work
    let report = null;
    try {
      report = await relay.submitMessage(message, { addressed: isAddressed, projectHint: context.projectHintsByUser[message.author.id] });
    } catch { log.info('relay report enqueue unavailable'); }
    if ((isAddressed || report?.handled) && active?.kind === 'heartbeat') active.abort.abort();
    const conversation = { idleSeconds, explicitReply: !!message.reference, addressed: isAddressed, newConversationSuggested: !message.reference && idleSeconds !== null && idleSeconds >= (config.conversationIdleSeconds ?? 900), relayStatus: report?.handled ? report.duplicate ? 'duplicate' : 'queued' : null, relayDeferred: !!report?.deferred, relayReplySuggestion: report?.reply ?? null };
    if (stopped) { store.finishMessage(message.id, 'cancelled-before-generation'); return false; }
    return new Promise((resolve) => {
      let group = pending.get(key);
      if (!group) { group = { entries: [], timer: null, scheduled: false, running: false }; pending.set(key, group); }
      group.entries.push({ message, instruction, conversation, resolve });
      scheduleContext(key, isAddressed || !!report?.handled);
    });
  }

  async function processMessages(batch, signal) {
      const { message, instruction, conversation } = batch.at(-1);
      const key = contextKey(message), privateContext = !message.guildId, owner = isOwner(ctx, message.author.id);
      const typing = setInterval(() => { if (!ctx.dryRun && !signal.aborted) message.channel.sendTyping?.().catch(() => {}); }, 8000);
      try {
        await message.channel.sendTyping?.().catch(() => {});
        const data = await snapshot(ctx, { privateContext: privateContext && owner });
        // No private threads even if an injected collector accidentally returns them publicly.
        if (!privateContext || !owner) delete data.privateThreads;
        let server;
        try { server = await serverData(message.author.id, { privateContext, currentChannelId: message.channelId }); } catch { server = { owner: false, channels: [], users: [] }; }
        const freshMessages = batch.map((entry) => ({ content: entry.instruction, visible: entry.message.gojoVisibleMetadata ?? visibleMessageMetadata(entry.message), userId: entry.message.author.id, name: entry.message.author.username, messageId: entry.message.id, ...entry.conversation }));
        const prompt = buildPrompt({ mode: privateContext ? 'dm' : 'public', snapshot: data, history: store.context(key).recent, message: { content: instruction, userId: message.author.id, owner, ...conversation, freshMessages }, server });
        const result = await cli.generate(key, prompt, { signal });
        const response = validateResponse(result.response);
        const processed = new Set(batch.map((entry) => entry.message.id));
        const context = store.context(key);
        context.pendingForBrain = (context.pendingForBrain ?? []).filter((entry) => !processed.has(entry.messageId));
        store.record(key, { role: 'decision', decision: 'generated', messageIds: [...processed], receipt: result.receipt });
        signal.throwIfAborted();
        if (response.skip) {
          if (response.actions.length) throw new Error('Skipped conversation attempted actions');
          store.record(key, { role: 'decision', decision: 'skip', messageIds: batch.map((entry) => entry.message.id), receipt: result.receipt });
          for (const entry of batch) store.finishMessage(entry.message.id, 'ignored-by-model');
          return true;
        }
        const actionResults = [];
        if (response.actions.length) {
          for (const [index, action] of response.actions.entries()) {
            signal.throwIfAborted();
            // Persist before each mutation. A crash consumes the message; no action is replayed.
            store.record(key, { role: 'action-attempt', messageId: message.id, index, kind: action.kind });
            try {
              if (conversation.recovered && action.kind !== 'report_issue') throw new Error('Recovered messages cannot replay Discord actions; send a fresh owner request');
              if (action.kind === 'report_issue') {
                const source = action.messageId ? batch.find((entry) => entry.message.id === action.messageId) : batch.at(-1);
                if (!source || action.name !== 'dexcode' || (action.content && action.content !== source.instruction)) throw new Error('Issue triage must use an original fresh message and dexCode project');
                const captured = await relay.submitMessage(source.message, { projectHint: 'dexcode', addressed: source.conversation.addressed, semanticTriage: true });
                if (!captured?.handled) throw new Error('The latest message does not contain a factual failure signal');
                actionResults.push({ kind: 'report_issue', status: captured.duplicate ? 'already-queued' : captured.rateLimited ? 'rate-limited' : 'queued', project: 'dexcode' });
                continue;
              }
              let options = { ctx, message, privateContext, instruction };
              // A requested project update sent from a DM is composed entirely in the target
              // public context. It never receives the private chat history or thread snapshot.
              if (privateContext && owner && action.kind === 'send_message' && !explicitExport(instruction, action.content) && /\b(?:project|build|product)\b.*\b(?:update|status|news|catch.?up)\b|\b(?:update|status|news|catch.?up)\b.*\b(?:project|build|product)\b/i.test(instruction)) {
                const publicSnapshot = await snapshot(ctx, { privateContext: false });
                delete publicSnapshot.privateThreads;
                const publishPrompt = buildPrompt({ mode: 'heartbeat', snapshot: publicSnapshot, message: { content: 'Write the requested public project update from the supplied public project records only.' }, requestedProjects: publicSnapshot.projects.slice(0, 4) });
                const published = await cli.generate(`public:${action.channelId}`, publishPrompt, { signal });
                if (published.response.actions.length || !published.response.reply.trim()) throw new Error('Public update did not return safe text');
                action.content = publicText(published.response.reply);
                options = { ...options, privateContext: false };
              }
              actionResults.push(await executeAction(action, options));
            } catch (error) { actionResults.push({ kind: action.kind, status: 'denied-or-failed', reason: redactSecrets(error.message).slice(0, 200) }); }
          }
          store.record(key, { role: 'action-results', messageId: message.id, results: actionResults });
          const finalPrompt = buildPrompt({ mode: privateContext ? 'dm' : 'public', snapshot: data, history: store.context(key).recent, message: { content: instruction, userId: message.author.id, owner }, server, actionResults });
          const final = await cli.generate(key, finalPrompt, { signal });
          if (final.response.actions.length) throw new Error('Final action-result generation attempted extra actions');
          if (final.response.skip) {
            store.record(key, { role: 'decision', decision: 'skip-after-actions', messageIds: batch.map((entry) => entry.message.id), receipt: final.receipt });
            for (const entry of batch) store.finishMessage(entry.message.id, 'done');
            return true;
          }
          response.reply = final.response.reply;
        }
        signal.throwIfAborted();
        if (!response.reply.trim()) throw new Error('Addressed conversation returned no reply');
        const sent = await sendReply(message, response.reply);
        store.record(key, { role: 'assistant', content: response.reply, messageId: sent?.id, receipt: result.receipt });
        for (const entry of batch) store.finishMessage(entry.message.id, 'done');
        return true;
      } catch (error) {
        for (const entry of batch) store.finishMessage(entry.message.id, signal.aborted ? 'cancelled' : 'failed');
        log.info(`addressed generation: ${signal.aborted ? 'cancelled' : error.category ?? 'failed'}`);
        const context = store.context(key);
        if (!signal.aborted && !stopped && (conversation.addressed || conversation.explicitReply) && (!context.lastFailureNoticeAt || now() - Date.parse(context.lastFailureNoticeAt) >= 60_000)) {
          context.lastFailureNoticeAt = new Date(now()).toISOString(); store.save();
          await sendReply(message, 'my domain is temporarily out of service. the configured model route could not finish; your message is saved for this chat.');
        }
        return false;
      } finally { clearInterval(typing); }
  }

  async function recoverPending() {
    if (stopped || ctx.dryRun) return false;
    for (const [key, context] of Object.entries(store.data.contexts)) {
      for (const record of [...(context.pendingForBrain ?? [])]) {
        if (stopped) return false;
        if (record.userId === ctx.client.user.id) { context.pendingForBrain = context.pendingForBrain.filter((item) => item.messageId !== record.messageId); store.finishMessage(record.messageId, 'observed-self'); continue; }
        if (recoveryQueued.has(record.messageId) || [...pending.values()].some((group) => group.entries.some((entry) => entry.message.id === record.messageId))) continue;
        recoveryQueued.add(record.messageId);
        try {
          const channel = record.guildId ? await ctx.guildCtx.guild.channels.fetch(record.channelId) : await (await ctx.guildCtx.guild.members.fetch(record.userId)).createDM();
          if (!channel || (record.guildId && channel.guildId !== ctx.config.local.guildId)) continue;
          const message = await channel.messages.fetch(record.messageId);
          if (!message || message.author.id !== record.userId || contextKey(message) !== key) continue;
          if (isBotOrSelf(message, ctx.client.user.id)) { context.pendingForBrain = context.pendingForBrain.filter((item) => item.messageId !== record.messageId); store.finishMessage(record.messageId, 'observed-bot'); continue; }
          const instruction = redactSecrets(String(message.content ?? '')).slice(0, 6000);
          const conversation = { idleSeconds: Math.max(0, (now() - Date.parse(record.capturedAt)) / 1000), explicitReply: !!message.reference, addressed: addressed(message, ctx.client.user.id), newConversationSuggested: !message.reference, recovered: true, relayStatus: relay.index.messages[message.id] ? 'queued' : null };
          let group = pending.get(key);
          if (!group) { group = { entries: [], timer: null, scheduled: false, running: false }; pending.set(key, group); }
          group.entries.push({ message, instruction, conversation, resolve: () => recoveryQueued.delete(record.messageId) });
          scheduleContext(key, true);
        } catch { recoveryQueued.delete(record.messageId); /* missing/deleted originals stay recorded; never fabricate permission */ }
      }
    }
    return true;
  }

  async function relayPoll() {
    if (stopped || ctx.dryRun || config.relay?.enabled === false) return false;
    if (relayWork) return relayWork;
    relayAbort = new AbortController();
    const signal = relayAbort.signal;
    relayWork = (async () => {
      try {
        const { processPending } = await import('../../ops/gojo-relay-broker.mjs');
        await processPending({ ctx, relayRoot: relay.root, signal });
      } catch { if (!signal.aborted) log.info('relay broker unavailable; queued reports preserved'); }
      if (signal.aborted) return false;
      return relay.poll();
    })();
    try { return await relayWork; }
    finally { relayWork = null; relayAbort = null; }
  }

  function acknowledge(outbox, messageId) {
    const heartbeat = store.data.heartbeat;
    for (const project of outbox.projects) heartbeat.projects[project.key] = { hash: project.hash, summary: outbox.content, postedAt: outbox.startedAt, messageId };
    heartbeat.posts ??= [];
    heartbeat.posts.push({ messageId, at: outbox.startedAt, content: outbox.content, nonce: outbox.nonce, projectKeys: outbox.projects.map((project) => project.key), receipt: outbox.receipt ?? null });
    heartbeat.posts = heartbeat.posts.slice(-200);
    heartbeat.outbox = null;
    store.save();
    store.record(`heartbeat:${outbox.channelId}`, { role: 'assistant', content: outbox.content, messageId });
  }

  async function reconcile(channel) {
    const outbox = store.data.heartbeat.outbox;
    if (!outbox) return true;
    if (outbox.channelId !== channel.id) throw new Error('Gojo outbox belongs to a different channel');
    let before;
    for (let page = 0; page < 5; page += 1) {
      const messages = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
      const items = [...messages.values()];
      const found = items.find((message) => message.author.id === ctx.client.user.id && message.content === outbox.content && message.createdTimestamp >= Date.parse(outbox.startedAt) - 2000);
      if (found) { acknowledge(outbox, found.id); return true; }
      if (!items.length || Math.min(...items.map((message) => message.createdTimestamp)) < Date.parse(outbox.startedAt) - 2000) break;
      before = items.at(-1).id;
    }
    if (outbox.status === 'prepared') return true;
    // Network uncertainty is preserved. Blind re-sends after Discord's nonce window would duplicate.
    outbox.status = 'uncertain'; store.save();
    return false;
  }

  async function transmitOutbox(channel, signal) {
    const outbox = store.data.heartbeat.outbox;
    signal.throwIfAborted();
    outbox.status = 'sending'; store.save();
    try {
      const sent = await channel.send({ content: outbox.content, allowedMentions, flags: 4, nonce: outbox.nonce, enforceNonce: true });
      markGojoFeedback(sent, 'gojo-heartbeat');
      acknowledge(outbox, sent.id);
      log.info('water-cooler project update posted');
      return { messageId: sent.id, receipt: outbox.receipt ?? null, projectKeys: outbox.projects.map((project) => project.key) };
    } catch {
      outbox.status = 'uncertain'; store.save();
      log.info('water-cooler send unconfirmed; reconcile before retry');
      return false;
    }
  }

  async function heartbeat({ force = false } = {}) {
    if (!config?.enabled || stopped || (!force && ctx.flags.paused)) return false;
    if (!force && config.quietHours) {
      const { start, end, timezone = 'Asia/Bangkok' } = config.quietHours;
      const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', hourCycle: 'h23' }).format(new Date(now())));
      if (start < end ? hour >= start && hour < end : hour >= start || hour < end) return false;
    }
    const lastPost = store.data.heartbeat.posts?.at(-1);
    if (!force && lastPost && now() - Date.parse(lastPost.at) < config.heartbeatSeconds * 1000) return false;
    return enqueue('heartbeat', async (signal) => {
      const channel = await ctx.guildCtx.channel(config.channel);
      if (!channel || channel.guildId !== ctx.config.local.guildId || !channel.messages) return false;
      if (!ctx.dryRun && !(await reconcile(channel))) { log.info('heartbeat awaiting outbox reconciliation'); return false; }
      if (!ctx.dryRun && store.data.heartbeat.outbox?.status === 'prepared') return transmitOutbox(channel, signal);
      const data = await snapshot(ctx, { privateContext: false });
      delete data.privateThreads;
      const pending = pendingProjects(data.projects, store.data.heartbeat.projects, config.projectsPerPost);
      if (!pending.length) { store.data.heartbeat.lastCheckedAt = new Date(now()).toISOString(); store.save(); return false; }
      const key = `heartbeat:${channel.id}`;
      // Reconcile recent bot-authored posts for tone/continuity; member conversation stays untrusted.
      const recent = ctx.dryRun ? [] : [...(await channel.messages.fetch({ limit: 50 })).values()].filter((message) => message.author.id === ctx.client.user.id).slice(0, 12).reverse().map((message) => ({ role: 'assistant', content: publicText(message.content).slice(0, 1800), at: message.createdAt.toISOString() }));
      const prompt = buildPrompt({ mode: 'heartbeat', snapshot: data, history: recent, requestedProjects: pending });
      let result;
      try { result = await cli.generate(key, prompt, { signal }); }
      catch (error) { log.info(`heartbeat generation: ${signal.aborted ? 'cancelled' : error.category ?? 'failed'}`); return false; }
      const response = validateResponse(result.response);
      signal.throwIfAborted();
      if (response.actions.length) throw new Error('Heartbeat cannot perform Discord actions');
      if (response.skip || !response.reply.trim()) return false;
      const covered = pending.filter((project) => response.coveredProjectIds.includes(project.key));
      if (!covered.length || response.coveredProjectIds.some((id) => !pending.some((project) => project.key === id))) throw new Error('Heartbeat coverage did not match requested projects');
      const content = publicText(response.reply);
      if (ctx.dryRun) return { preview: content, receipt: result.receipt, projectKeys: covered.map((project) => project.key) };
      const outbox = { status: 'prepared', channelId: channel.id, nonce: digest(`${now()}:${content}`).slice(0, 24), content, projects: covered.map(({ key, hash }) => ({ key, hash })), startedAt: new Date(now()).toISOString(), receipt: result.receipt };
      store.data.heartbeat.outbox = outbox; store.save();
      return transmitOutbox(channel, signal);
    });
  }

  return { onMessage, heartbeat, recoverPending, relayPoll, relay, status: () => ({ enabled: !!config?.enabled, queued, pendingMessages: [...pending.values()].reduce((count, group) => count + group.entries.length, 0), durablePendingMessages: Object.values(store.data.contexts).reduce((count, context) => count + (context.pendingForBrain?.length ?? 0), 0), active: active?.kind ?? null, uncertainOutbox: store.data.heartbeat.outbox?.status ?? null, coveredProjects: Object.keys(store.data.heartbeat.projects).length, relay: relay.status() }), stop: async () => { stopped = true; for (const group of pending.values()) { if (group.timer) clearTimeout(group.timer); for (const entry of group.entries) entry.resolve(false); } pending.clear(); active?.abort.abort(); relayAbort?.abort(); await tail; if (relayWork) await relayWork.catch(() => {}); }, store };
}

export default {
  name: 'gojo',
  events: { async messageCreate(message, ctx) {
    if (!ctx.config.gojo?.enabled) return;
    let controller = controllers.get(ctx);
    if (!controller) { controller = createGojoController(ctx); controllers.set(ctx, controller); }
    await controller.onMessage(message);
  } },
  async start(ctx) {
    if (!ctx.config.gojo?.enabled) return;
    const controller = controllers.get(ctx) ?? createGojoController(ctx);
    controllers.set(ctx, controller);
    controller.recoverPending().catch(() => ctx.log.info('gojo pending recovery unavailable; captured messages preserved'));
    ctx.scheduler.every('gojo-hourly', ctx.config.gojo.heartbeatSeconds, () => controller.heartbeat(), { runAtStart: true });
    ctx.scheduler.every('gojo-relay', 5, () => controller.relayPoll(), { runAtStart: true, pausable: false });
  },
  async stop(ctx) { await controllers.get(ctx)?.stop(); },
};
