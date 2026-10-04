// Bounded acceptance through the actual app/controller and Discord server.
// --preview generates with no outgoing message; --post posts one real ledger update.
import path from 'node:path';
import fs from 'node:fs';
import { readCred, githubToken } from './secrets.mjs';
import { createApp } from '../src/app.mjs';
import { createGojoController } from '../src/modules/gojo.mjs';
import { atomicJson, GojoStore } from '../src/core/gojo-store.mjs';
import { PermissionFlagsBits, GatewayIntentBits } from 'discord.js';

const argv = process.argv.slice(2);
const option = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : fallback; };
const home = option('--home', 'D:\\Dex\\Servers\\devbot');
const output = option('--receipt', 'D:\\Dex\\Automation\\reports\\gojo-ledger-20261004\\live-probe.json');
const mode = argv.includes('--observe-preview') ? 'observe-preview' : argv.includes('--chat-preview') ? 'chat-preview' : argv.includes('--post') ? 'post' : argv.includes('--preview') ? 'preview' : 'status';
if (mode === 'post' && argv.includes('--preview')) throw new Error('Choose --post or --preview');
if (!/^D:[\\/]/i.test(path.resolve(output))) throw new Error('Receipt must be D-backed');
if (mode === 'post' && fs.existsSync(path.join(home, 'repo', 'src', 'modules', 'gojo.mjs'))) {
  let supervisorPid = 0;
  try { supervisorPid = Number(fs.readFileSync(path.join(home, 'supervisor.pid'), 'utf8')); } catch { /* stopped */ }
  if (supervisorPid > 0) {
    let alive = false;
    try { process.kill(supervisorPid, 0); alive = true; } catch { /* stopped */ }
    if (alive) throw new Error('Stop the exact Gojo runtime before a manual live post; persistent memory has one writer');
  }
}
const token = readCred('DEX_DISCORD_DEVBOT');
if (!token) throw new Error('Existing Discord credential unavailable');
process.env.DISCORD_TOKEN = token;
const gh = githubToken();
if (gh.token) process.env.GITHUB_TOKEN = gh.token;
const app = createApp({ home, dryRun: ['preview', 'chat-preview', 'observe-preview'].includes(mode), noLogSink: true }, { logFile: 'gojo-probe.log', exit: () => {} });
let controller;
try {
  await app.boot({ live: false });
  const isolated = ['preview', 'chat-preview', 'observe-preview'].includes(mode);
  controller = createGojoController(app.ctx, isolated ? { store: new GojoStore(path.join(path.dirname(output), 'preview-store')) } : {});
  const channel = await app.ctx.guildCtx.channel(app.ctx.config.gojo.channel);
  if (!channel) throw new Error('Configured Gojo channel unavailable');
  const before = controller.status();
  const member = await app.ctx.guildCtx.guild.members.fetchMe();
  const permissions = Object.fromEntries(['ManageChannels', 'ReadMessageHistory', 'SendMessages', 'AddReactions'].map(name => [name, member.permissions.has(PermissionFlagsBits[name])]));
  const gateway = Object.fromEntries(['GuildMessages', 'DirectMessages', 'MessageContent'].map(name => [name, app.client.options.intents.has(GatewayIntentBits[name])]));
  let result;
  if (mode === 'chat-preview' || mode === 'observe-preview') {
    const owner = await app.ctx.guildCtx.guild.members.fetch(app.ctx.guildCtx.ownerId);
    const id = ((BigInt(Date.now()) - 1420070400000n) << 22n).toString();
    // Synthetic setup event, clearly labelled in its durable private transcript.
    // No user account is impersonated on Discord, and no DM is sent.
    const observe = mode === 'observe-preview';
    const message = { id, author: { id: owner.id, username: owner.user.username, bot: false }, guildId: observe ? app.ctx.config.local.guildId : null,
      channelId: observe ? channel.id : id, createdTimestamp: Date.now(), channel: { sendTyping: async () => {} },
      content: observe ? 'brb, grabbing a coffee. lovely weather today.' : 'gojo, setup acceptance test: summarize the latest observed working Codex and Claude project threads from the supplied local snapshot. Do not send, post, create, edit, delete, react or DM anything. Do not read Discord message history or look up Discord users.',
      reply: async () => { throw new Error('Chat preview must not send to Discord'); } };
    const handled = await controller.onMessage(message);
    const context = controller.store.context(observe ? `public:${channel.id}` : `dm:${owner.id}`);
    const answer = context.recent.findLast(row => row.role === 'assistant');
    const decision = context.recent.findLast(row => row.role === 'decision');
    result = { handled, syntheticOwnerEvent: true, noDiscordSend: true, unaddressedMessage: observe, decision: decision?.decision ?? (answer ? 'reply' : null), answer: answer?.content ?? null, receipt: answer?.receipt ?? decision?.receipt ?? null };
    if (!handled || (!answer?.content && decision?.decision !== 'skip') || context.recent.some(row => row.messageId === id && row.role === 'action-attempt')) throw new Error('Conversation preview did not complete as a reply-or-skip request');
  } else result = mode === 'status' ? null : await controller.heartbeat({ force: true });
  let readback = null;
  if (mode === 'post' && result?.messageId) {
    const message = await channel.messages.fetch(result.messageId);
    const recorded = controller.store.data.heartbeat.posts?.find(p => p.messageId === message.id);
    readback = { authorIsBot: message.author.id === app.client.user.id, matchesDurablePost: message.content === recorded?.content, content: message.content, at: message.createdAt.toISOString() };
    if (!readback.authorIsBot || !readback.matchesDurablePost) throw new Error('Discord readback did not match durable post');
  }
  const receipt = { at: new Date().toISOString(), mode, before, after: controller.status(), result, readback,
    channel: channel.name, model: app.ctx.config.gojo.codex.model, effort: app.ctx.config.gojo.codex.effort,
    heartbeatSeconds: app.ctx.config.gojo.heartbeatSeconds, enabled: app.ctx.config.gojo.enabled, paused: !!app.ctx.flags.paused, permissions, gateway };
  atomicJson(output, receipt);
  console.log(JSON.stringify({ mode, channel: channel.name, result: result === false ? 'quiet-or-unavailable' : mode === 'status' ? 'connected' : 'success', readbackVerified: !!readback, receipt: output }));
} finally {
  await controller?.stop();
  await app.shutdown(0, 'bounded Gojo probe complete');
  delete process.env.DISCORD_TOKEN;
  delete process.env.GITHUB_TOKEN;
}
