#!/usr/bin/env node
// Handler test harness: drives the real module handlers with stand-in interactions, against
// the live guild and GitHub, without anyone clicking in Discord. Side effects are real (a
// /review really posts to #red-team); replies are printed, and with --echo also posted to
// #compute-bill so they can be looked at.
//
//   node ops/dev-interact.mjs "/source project:dexclient path:package.json"
//   node ops/dev-interact.mjs --as staff "/diff project:dexcode ref:ow10/c35-integration"
//   node ops/dev-interact.mjs --as waitlist "/source project:dexclient path:README.md"
//   node ops/dev-interact.mjs --autocomplete path "/source project:dexclient path:pack"
//   node ops/dev-interact.mjs --button feed:diff:dexclient:-:1d1ae73475a0 --message ships-dexclient:<messageId>
//   node ops/dev-interact.mjs --modal access:modal --field github=octocat --field note=hi
//   node ops/dev-interact.mjs --select feedback:trackpick:<threadId> --values dexclient --channel <threadId>
//
// Identities (--as): owner (default, the real guild owner), staff and waitlist (synthetic
// members holding those roles; they cannot receive DMs or role changes). --channel takes a
// layout key or a channel/thread id (default water-cooler). Tokens come from ops/secrets.mjs.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Collection, InteractionType, MessageFlags } from 'discord.js';
import { githubToken, readCred } from './secrets.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Re-exec with tokens in the environment (never on a command line).
if (!process.env.DISCORD_TOKEN) {
  const discord = readCred('DEX_DISCORD_DEVBOT');
  const gh = githubToken();
  if (!discord || !gh.token) {
    console.error('missing tokens');
    process.exit(2);
  }
  const res = spawnSync(process.execPath, process.argv.slice(1), { stdio: 'inherit', env: { ...process.env, DISCORD_TOKEN: discord, GITHUB_TOKEN: gh.token } });
  process.exit(res.status ?? 1);
}

const { createApp } = await import('../src/app.mjs');

// ------------------------------------------------------------------ args
const argv = process.argv.slice(2);
const opts = { as: 'owner', channel: 'water-cooler', echo: false, fields: {}, values: [], home: process.env.DEVBOT_HOME || 'D:\\Dex\\Servers\\devbot' };
let commandLine = null;
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a === '--as') opts.as = argv[++i];
  else if (a === '--channel') opts.channel = argv[++i];
  else if (a === '--echo') opts.echo = true;
  else if (a === '--home') opts.home = argv[++i];
  else if (a === '--button') opts.button = argv[++i];
  else if (a === '--select') opts.select = argv[++i];
  else if (a === '--values') opts.values = argv[++i].split(',');
  else if (a === '--modal') opts.modal = argv[++i];
  else if (a === '--field') {
    const [k, ...v] = argv[++i].split('=');
    opts.fields[k] = v.join('=');
  } else if (a === '--message') opts.message = argv[++i];
  else if (a === '--autocomplete') opts.focused = argv[++i];
  else if (a === '--wait') opts.wait = Number(argv[++i]);
  else if (a === '--repeat') opts.repeat = Number(argv[++i]);
  else if (!a.startsWith('--')) commandLine = a;
  else throw new Error(`unknown flag ${a}`);
}

const app = createApp({ home: opts.home, noLogSink: true }, { logFile: 'harness.log', exit: () => {} });
const { ctx, client } = app;
await app.boot({ live: false });
const guild = ctx.guildCtx.guild;

// ------------------------------------------------------------------ identity
async function identity(kind) {
  if (kind === 'owner') return guild.members.fetch(guild.ownerId);
  const roleId = ctx.guildCtx.roleId(kind);
  if (!roleId) throw new Error(`no role for ${kind}`);
  const id = kind === 'staff' ? '100000000000000001' : '100000000000000002';
  const user = { id, username: `harness-${kind}`, tag: `harness-${kind}`, globalName: `harness ${kind}`, bot: false, displayAvatarURL: () => null, send: async () => { throw new Error('synthetic user: no DMs'); }, toString: () => `<@${id}>` };
  const roles = new Collection([[roleId, guild.roles.cache.get(roleId)]]);
  return {
    id,
    user,
    guild,
    displayName: user.globalName,
    roles: { cache: roles, highest: guild.roles.cache.get(roleId), add: async () => { throw new Error('synthetic member'); }, remove: async () => { throw new Error('synthetic member'); } },
    permissions: { has: () => false },
    toString: () => `<@${id}>`,
  };
}
const member = await identity(opts.as);
const user = member.user;

async function resolveChannel(ref) {
  const id = ctx.guildCtx.channelId(ref) ?? ref;
  return client.channels.fetch(id);
}
const channel = await resolveChannel(opts.channel);

// ------------------------------------------------------------------ command parsing
function parseCommand(line) {
  const tokens = [];
  const re = /(\S+?):(?:"([^"]*)"|(\S+))|(\S+)/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    if (m[4]) tokens.push({ word: m[4] });
    else tokens.push({ key: m[1], value: m[2] ?? m[3] });
  }
  const first = tokens.shift();
  if (!first?.word?.startsWith('/')) throw new Error('command must start with /name');
  const name = first.word.slice(1);
  const entry = ctx.router.byCommand.get(name);
  if (!entry) throw new Error(`no command /${name}`);
  let optionDefs = entry.json.options ?? [];
  let subcommand = null;
  let group = null;
  while (tokens[0]?.word) {
    const w = tokens.shift().word;
    const def = optionDefs.find((o) => o.name === w && (o.type === 1 || o.type === 2));
    if (!def) throw new Error(`/${name}: unknown subcommand ${w}`);
    if (def.type === 2) group = w;
    else subcommand = w;
    optionDefs = def.options ?? [];
  }
  const values = {};
  for (const t of tokens) {
    const def = optionDefs.find((o) => o.name === t.key);
    if (!def) throw new Error(`/${name}: unknown option ${t.key}`);
    values[t.key] = { def, raw: t.value };
  }
  return { name, subcommand, group, values, optionDefs };
}

async function optionValue(def, raw) {
  switch (def.type) {
    case 4:
    case 10:
      return Number(raw);
    case 5:
      return raw === 'true';
    case 6: {
      const id = raw === 'owner' ? guild.ownerId : raw.replace(/[<@!>]/g, '');
      return { user: await client.users.fetch(id), member: await guild.members.fetch(id).catch(() => null) };
    }
    case 7:
      return resolveChannel(raw);
    case 8:
      return guild.roles.cache.get(ctx.guildCtx.roleId(raw) ?? raw);
    default:
      return raw;
  }
}

async function makeOptions(parsed) {
  const resolved = {};
  for (const [k, { def, raw }] of Object.entries(parsed.values)) resolved[k] = await optionValue(def, raw);
  const need = (name, required, v) => {
    if (required && v === undefined) throw new Error(`required option ${name} missing`);
    return v ?? null;
  };
  return {
    getString: (n, r) => need(n, r, resolved[n]),
    getInteger: (n, r) => need(n, r, resolved[n]),
    getNumber: (n, r) => need(n, r, resolved[n]),
    getBoolean: (n, r) => need(n, r, resolved[n]),
    getUser: (n, r) => need(n, r, resolved[n]?.user),
    getMember: (n) => resolved[n]?.member ?? null,
    getChannel: (n, r) => need(n, r, resolved[n]),
    getRole: (n, r) => need(n, r, resolved[n]),
    getSubcommand: (r = true) => need('subcommand', r, parsed.subcommand ?? undefined),
    getSubcommandGroup: (r = false) => need('group', r, parsed.group ?? undefined),
    getFocused: (full = false) => {
      const v = parsed.values[opts.focused]?.raw ?? '';
      return full ? { name: opts.focused, value: v, type: 3, focused: true } : v;
    },
    get data() {
      return Object.entries(parsed.values).map(([name, { def, raw }]) => ({ name, type: def.type, value: raw }));
    },
  };
}

// ------------------------------------------------------------------ response capture
function describePayload(p) {
  if (typeof p === 'string') return { content: p };
  const out = {};
  if (p?.content) out.content = p.content;
  if (p?.flags !== undefined) out.ephemeral = (Number(p.flags) & Number(MessageFlags.Ephemeral)) !== 0;
  if (p?.embeds?.length) {
    out.embeds = p.embeds.map((e) => {
      const d = typeof e.toJSON === 'function' ? e.toJSON() : e;
      return { title: d.title, url: d.url, author: d.author?.name, description: d.description, fields: d.fields?.map((f) => `${f.name} :: ${f.value}`), footer: d.footer?.text };
    });
  }
  if (p?.components?.length) {
    out.components = p.components.map((row) => {
      const r = typeof row.toJSON === 'function' ? row.toJSON() : row;
      return (r.components ?? []).map((c) => c.custom_id ?? c.url ?? c.label);
    });
  }
  if (p?.files?.length) out.files = p.files.map((f) => `${f.name ?? f.attachment?.name ?? 'file'} (${Buffer.isBuffer(f.attachment) ? f.attachment.length : '?'} bytes)`);
  return out;
}

const log = [];
let lastEcho = null;
async function capture(kind, payload) {
  const d = payload === undefined ? {} : describePayload(payload);
  log.push({ kind, at: Date.now(), ...d });
  console.log(`\n--- ${kind} ---\n${JSON.stringify(d, null, 2)}`);
  if (opts.echo && payload && typeof payload === 'object' && (payload.content || payload.embeds?.length || payload.files?.length)) {
    const { flags, ephemeral, fetchReply, withResponse, ...rest } = payload;
    const header = `🧪 harness ${kind} · ${commandLine ?? opts.button ?? opts.modal ?? opts.select} · as ${opts.as}`;
    lastEcho = await ctx.guildCtx.send('compute-bill', { ...rest, content: `${header}\n${rest.content ?? ''}`.slice(0, 2000) });
    return lastEcho;
  }
  return null;
}

function fakeMessage(real) {
  return real ?? { id: '0', url: 'https://discord.com/channels/harness', edit: async (p) => capture('message.edit', p), delete: async () => {} };
}

function baseInteraction(kind) {
  const it = {
    id: String(Date.now()),
    type: kind,
    client,
    guild,
    guildId: guild.id,
    channel,
    channelId: channel.id,
    user,
    member,
    replied: false,
    deferred: false,
    responded: false,
    createdTimestamp: Date.now(),
    inGuild: () => true,
    inCachedGuild: () => true,
    isRepliable: () => kind !== InteractionType.ApplicationCommandAutocomplete,
    isChatInputCommand: () => false,
    isAutocomplete: () => false,
    isButton: () => false,
    isAnySelectMenu: () => false,
    isStringSelectMenu: () => false,
    isModalSubmit: () => false,
    isMessageComponent: () => false,
    async reply(p) {
      if (this.replied || this.deferred) throw new Error('InteractionAlreadyReplied');
      this.replied = true;
      const m = await capture('reply', p);
      return fakeMessage(m);
    },
    async deferReply(p) {
      if (this.replied || this.deferred) throw new Error('InteractionAlreadyReplied');
      this.deferred = true;
      this.ephemeral = !!(Number(p?.flags ?? 0) & Number(MessageFlags.Ephemeral)); // as discord.js does
      log.push({ kind: 'deferReply', at: Date.now(), ephemeral: !!(p?.flags || p?.ephemeral) });
      console.log(`\n--- deferReply ${JSON.stringify(p ?? {})} ---`);
    },
    async editReply(p) {
      if (!this.replied && !this.deferred) throw new Error('InteractionNotReplied');
      // Discord answers 10008 Unknown Message when the original reply was deleted
      if (this.replyDeleted) throw Object.assign(new Error('Unknown Message'), { code: 10008 });
      this.replied = true;
      return fakeMessage(await capture('editReply', p));
    },
    async followUp(p) {
      if (!this.replied && !this.deferred) throw new Error('InteractionNotReplied');
      return fakeMessage(await capture('followUp', p));
    },
    async deleteReply() {
      this.replyDeleted = true;
      log.push({ kind: 'deleteReply', at: Date.now() });
    },
    async fetchReply() {
      return fakeMessage(lastEcho);
    },
    async showModal(modal) {
      const d = typeof modal.toJSON === 'function' ? modal.toJSON() : modal;
      log.push({ kind: 'showModal', at: Date.now(), customId: d.custom_id });
      console.log(`\n--- showModal ---\n${JSON.stringify({ custom_id: d.custom_id, title: d.title, inputs: (d.components ?? []).map((r) => (r.components ?? [r.component]).map((c) => c?.custom_id)) }, null, 2)}`);
      this.replied = true;
    },
  };
  return it;
}

// ------------------------------------------------------------------ run
let interaction;
if (opts.focused) {
  const parsed = parseCommand(commandLine);
  interaction = baseInteraction(InteractionType.ApplicationCommandAutocomplete);
  Object.assign(interaction, {
    commandName: parsed.name,
    options: await makeOptions(parsed),
    isAutocomplete: () => true,
    async respond(choices) {
      this.responded = true;
      log.push({ kind: 'respond', at: Date.now(), choices });
      console.log(`\n--- autocomplete (${choices.length}) ---\n${choices.map((c) => `${c.name}  =>  ${c.value}`).join('\n')}`);
    },
  });
} else if (commandLine) {
  const parsed = parseCommand(commandLine);
  interaction = baseInteraction(InteractionType.ApplicationCommand);
  Object.assign(interaction, { commandName: parsed.name, options: await makeOptions(parsed), isChatInputCommand: () => true });
} else if (opts.button || opts.select) {
  interaction = baseInteraction(InteractionType.MessageComponent);
  let message = null;
  if (opts.message) {
    const [chRef, msgId] = opts.message.split(':');
    const ch = await resolveChannel(chRef);
    message = await ch.messages.fetch(msgId);
    interaction.channel = ch;
    interaction.channelId = ch.id;
  }
  Object.assign(interaction, {
    customId: opts.button ?? opts.select,
    message,
    values: opts.values,
    isMessageComponent: () => true,
    isButton: () => !!opts.button,
    isAnySelectMenu: () => !!opts.select,
    isStringSelectMenu: () => !!opts.select,
    async update(p) {
      this.replied = true;
      await capture('update', p);
      if (message && p) await message.edit(p);
    },
    async deferUpdate() {
      this.deferred = true;
      log.push({ kind: 'deferUpdate', at: Date.now() });
      console.log('\n--- deferUpdate ---');
    },
  });
  // After deferUpdate, editReply edits the source message.
  const baseEdit = interaction.editReply;
  interaction.editReply = async function (p) {
    if (this.deferred && !this.replied && message && log.some((l) => l.kind === 'deferUpdate')) {
      await capture('editReply(message)', p);
      return message.edit(p);
    }
    return baseEdit.call(this, p);
  };
} else if (opts.modal) {
  interaction = baseInteraction(InteractionType.ModalSubmit);
  const fields = new Collection(Object.entries(opts.fields).map(([k, v]) => [k, { customId: k, value: v, type: 4 }]));
  Object.assign(interaction, {
    customId: opts.modal,
    isModalSubmit: () => true,
    fields: { fields, getTextInputValue: (k) => opts.fields[k] ?? '', getField: (k) => fields.get(k) },
    message: null,
  });
} else {
  console.error('nothing to run: pass a /command, --button, --select or --modal');
  process.exit(2);
}

// --repeat N runs an autocomplete N times in this process (warm caches after the first).
for (let r = 1; r < (opts.repeat ?? 1) && opts.focused; r += 1) {
  const t0 = Date.now();
  const respond = async (choices) => {
    console.log(`\n--- autocomplete pass ${r} (${choices.length} in ${Date.now() - t0} ms) ---`);
    console.log(choices.slice(0, 8).map((c) => c.name).join('\n'));
  };
  await ctx.router.handle({ ...interaction, responded: false, respond });
}
const started = Date.now();
await ctx.router.handle(interaction);
if (opts.wait) await new Promise((r) => setTimeout(r, opts.wait));
console.log(`\n=== done in ${Date.now() - started} ms; ${log.length} response events: ${log.map((l) => l.kind).join(', ')}`);
const firstAck = log[0]?.kind;
if (log[0]?.at) console.log(`first response after ${log[0].at - started} ms (Discord allows 3000)`);
if (interaction.isRepliable() && !['reply', 'deferReply', 'showModal', 'update', 'deferUpdate'].includes(firstAck)) {
  console.log('!!! handler never acknowledged the interaction');
}
ctx.state.flush();
await client.destroy();
process.exit(0);
