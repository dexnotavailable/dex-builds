// Explicit setup handshake in an isolated store; never a fictitious repair.
import fs from 'node:fs';
import path from 'node:path';
import { readCred, githubToken } from './secrets.mjs';
import { createApp } from '../src/app.mjs';
import { digest, atomicJson } from '../src/core/gojo-store.mjs';
import { GojoRelay } from '../src/core/gojo-relay.mjs';
import { processPending, brokerStatus } from './gojo-relay-broker.mjs';

const RUNTIME = 'D:\\Dex\\Servers\\devbot';
const HOME = 'D:\\Dex\\Temp\\gojo-relay-acceptance-20261004';
const ROOT = path.join(HOME, 'gojo', 'relay');
const REPORT = `r-${digest('gojo-native-relay-acceptance-20261004').slice(0, 24)}`;
const argv = process.argv.slice(2);
const action = argv.includes('--prepare') ? 'prepare' : argv.includes('--dispatch') ? 'dispatch' : argv.includes('--publish') ? 'publish' : argv.includes('--poll') ? 'poll' : 'status';
fs.mkdirSync(path.join(ROOT, 'inbox'), { recursive: true });
const reportFile = path.join(ROOT, 'inbox', `${REPORT}.json`);
if (action === 'prepare') {
  if (!fs.existsSync(path.join(ROOT, 'native-binding.json'))) fs.copyFileSync(path.join(RUNTIME, 'gojo', 'relay', 'native-binding.json'), path.join(ROOT, 'native-binding.json'));
  process.env.DISCORD_TOKEN = readCred('DEX_DISCORD_DEVBOT');
  const gh = githubToken(); if (gh.token) process.env.GITHUB_TOKEN = gh.token;
  const app = createApp({ home: RUNTIME, noLogSink: true }, { logFile: 'gojo-relay-probe.log', exit: () => {} });
  try {
    await app.boot({ live: false });
    const channel = await app.ctx.guildCtx.channel('water-cooler');
    const memory = JSON.parse(fs.readFileSync(path.join(RUNTIME, 'gojo', 'memory.json'), 'utf8'));
    const owner = await app.ctx.guildCtx.guild.members.fetch(app.ctx.guildCtx.ownerId);
    if (!fs.existsSync(reportFile)) atomicJson(reportFile, { version: 1, id: REPORT, type: 'report', project: 'dexcode', kind: 'bug', priority: 'normal',
      content: 'Clearly labelled Gojo setup transport test. No actual bug or code change is requested. Verify reception and a correlated return acknowledgement only.',
      createdAt: new Date().toISOString(), trust: 'untrusted-report-data', source: { guildId: app.ctx.config.local.guildId, channelId: channel.id,
        messageId: memory.heartbeat.posts[0].messageId, userId: owner.id, private: false, reporterName: 'Gojo setup acceptance test' } });
    const publicConfig = { home: HOME, local: { guildId: app.ctx.config.local.guildId, localRepos: app.ctx.config.local.localRepos }, gojo: { ledgerRoot: app.ctx.config.gojo.ledgerRoot, relay: { enabled: true, projectRoots: ['D:\\Dex\\Temp\\claude-core\\integration'] } } };
    atomicJson(path.join(HOME, 'probe-config.json'), publicConfig);
    console.log(JSON.stringify({ action, fixturePrepared: true, isolatedStore: true, noDiscordSend: true }));
  } finally { await app.shutdown(0, 'relay fixture prepared'); delete process.env.DISCORD_TOKEN; delete process.env.GITHUB_TOKEN; }
} else if (action === 'dispatch' || action === 'poll') {
  const config = JSON.parse(fs.readFileSync(path.join(HOME, 'probe-config.json'), 'utf8'));
  const result = await processPending({ ctx: { config, dryRun: false, log: { warn: () => {} } }, relayRoot: ROOT, acceptanceMode: true });
  atomicJson(path.join(HOME, 'last-native-probe.json'), { at: new Date().toISOString(), action, result, status: brokerStatus(ROOT), setupOnly: true });
  console.log(JSON.stringify({ action, ...result, setupOnly: true }));
} else if (action === 'publish') {
  process.env.DISCORD_TOKEN = readCred('DEX_DISCORD_DEVBOT');
  const gh = githubToken(); if (gh.token) process.env.GITHUB_TOKEN = gh.token;
  const app = createApp({ home: RUNTIME, noLogSink: true }, { logFile: 'gojo-relay-probe.log', exit: () => {} });
  try {
    await app.boot({ live: false });
    const ctx = { ...app.ctx, config: { ...app.ctx.config, home: HOME } };
    const relay = new GojoRelay({ ctx });
    const returned = relay.readEvents().filter(event => event.status === 'working' && /setup transport test reached this chat/i.test(event.summary));
    if (!returned.length) throw new Error('The actual destination acknowledgement is not available yet');
    await relay.poll();
    const channel = await app.ctx.guildCtx.channel('water-cooler');
    const receipts = [];
    for (const event of returned) {
      const receipt = JSON.parse(fs.readFileSync(path.join(ROOT, 'bot-state', 'events', `${event.eventId}.json`), 'utf8'));
      if (receipt.status !== 'sent') throw new Error('Reverse reply was not sent');
      const message = await channel.messages.fetch(receipt.messageId);
      if (message.author.id !== app.client.user.id || !message.content.includes(event.summary)) throw new Error('Reverse Discord readback mismatch');
      receipts.push({ status: event.status, readbackVerified: true, content: message.content });
    }
    atomicJson(path.join(HOME, 'reverse-discord-readback.json'), { at: new Date().toISOString(), setupOnly: true, receipts });
    console.log(JSON.stringify({ action, reverseReplyVerified: true, count: receipts.length, setupOnly: true }));
  } finally { await app.shutdown(0, 'relay return readback complete'); delete process.env.DISCORD_TOKEN; delete process.env.GITHUB_TOKEN; }
} else console.log(JSON.stringify({ action, ...brokerStatus(ROOT), isolatedStore: true }));
