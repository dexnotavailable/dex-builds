import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { MessageType } from 'discord.js';
import onboarding, {
  GUIDE_TITLE,
  PANEL_TITLE,
  buildGuideEmbed,
  buildJoinCard,
  buildPanel,
  buildWelcomeDm,
  frontDeskKind,
  missedArrivals,
  planFrontDesk,
  refreshFrontDesk,
  resolveCardEmbed,
} from '../src/modules/onboarding.mjs';

const { projects } = JSON.parse(fs.readFileSync(new URL('../config/projects.json', import.meta.url), 'utf8'));
const layout = JSON.parse(fs.readFileSync(new URL('../config/layout.json', import.meta.url), 'utf8'));
const CHANNEL_KEYS = ['front-desk', 'water-cooler', 'vague-tweets', 'launch-livestream', 'ships-dexcode', 'ships-dexclient', 'ships-dexplace', 'rlhf', 'red-team', 'board-meeting'];
const channelIds = Object.fromEntries(CHANNEL_KEYS.map((k, i) => [k, String(100 + i)]));
const names = {
  mention: (key) => (channelIds[key] ? `<#${channelIds[key]}>` : `#${key}`),
  roleName: (key) => layout.roles.find((r) => r.key === key)?.name ?? key,
  projects,
};

function embedSize(e) {
  return (e.title?.length ?? 0) + (e.description?.length ?? 0) + (e.footer?.text?.length ?? 0) + (e.fields ?? []).reduce((n, f) => n + f.name.length + f.value.length, 0);
}

function assertEmbedLimits(e) {
  assert.ok((e.title ?? '').length <= 256);
  assert.ok((e.description ?? '').length <= 4096);
  for (const f of e.fields ?? []) {
    assert.ok(f.name.length <= 256, f.name);
    assert.ok(f.value.length > 0 && f.value.length <= 1024, f.name);
  }
  assert.ok(embedSize(e) <= 6000);
}

test('guide embed covers channels, access, commands and house rules within limits', () => {
  const e = buildGuideEmbed(names).toJSON();
  assert.equal(e.title, GUIDE_TITLE);
  assertEmbedLimits(e);
  const text = JSON.stringify(e);
  for (const key of ['water-cooler', 'vague-tweets', 'launch-livestream', 'ships-dexcode', 'ships-dexclient', 'ships-dexplace', 'rlhf', 'red-team']) {
    assert.ok(text.includes(`<#${channelIds[key]}>`), key);
  }
  for (const cmd of ['/feedback new', '/source', '/diff', '/review', '/worktree', '/status', '/help', '/access request']) assert.ok(text.includes(cmd), cmd);
  assert.ok(text.includes('on the waitlist') && text.includes('member of technical staff'));
  assert.ok(text.includes('dexCode, dexClient and dex.place get built, reviewed and roasted here'));
  assert.equal(e.fields.find((f) => f.name === 'house rules').value.split('\n').length, 3);
});

test('role panel has one ping toggle per project plus access and help buttons', () => {
  const { embeds, components } = buildPanel(names);
  assert.equal(embeds[0].toJSON().title, PANEL_TITLE);
  const rows = components.map((r) => r.toJSON());
  assert.ok(rows.length <= 5);
  const buttons = rows.flatMap((r) => r.components);
  for (const r of rows) assert.ok(r.components.length <= 5);
  for (const p of projects) {
    const b = buttons.find((x) => x.custom_id === `onboarding:ping:${p.key}`);
    assert.ok(b, p.key);
    assert.equal(b.label, `${p.emoji} ${p.name}`);
  }
  assert.ok(buttons.some((b) => b.custom_id === 'access:open'));
  assert.ok(buttons.some((b) => b.custom_id === 'status:help'));
});

test('frontDeskKind recognises only the bot’s guide, panel and pin notices', () => {
  const guide = { id: '1', author: { id: 'bot' }, embeds: [{ title: GUIDE_TITLE }] };
  const panel = { id: '2', author: { id: 'bot' }, embeds: [{ title: 'renamed' }], components: [{ components: [{ customId: 'onboarding:ping:dexcode' }] }] };
  const notice = { id: '3', author: { id: 'bot' }, type: MessageType.ChannelPinnedMessage };
  assert.equal(frontDeskKind(guide, 'bot'), 'guide');
  assert.equal(frontDeskKind(panel, 'bot'), 'panel');
  assert.equal(frontDeskKind(notice, 'bot'), 'notice');
  assert.equal(frontDeskKind({ ...guide, author: { id: 'someone' } }, 'bot'), null);
  assert.equal(frontDeskKind({ id: '4', author: { id: 'bot' }, embeds: [{ title: 'other' }] }, 'bot'), null);
});

const msg = (id, kind, author = 'bot') =>
  kind === 'guide'
    ? { id, author: { id: author }, embeds: [{ title: GUIDE_TITLE }] }
    : kind === 'panel'
      ? { id, author: { id: author }, embeds: [{ title: PANEL_TITLE }] }
      : { id, author: { id: author }, type: MessageType.ChannelPinnedMessage };

test('planFrontDesk keeps stored ids, adopts the oldest copy and drops duplicates', () => {
  const messages = [msg('10', 'guide'), msg('20', 'panel'), msg('30', 'guide'), msg('40', 'panel'), msg('50', 'notice'), msg('60', 'guide', 'human')];
  assert.deepEqual(planFrontDesk(messages, 'bot', { guideMessageId: '30', panelMessageId: '40' }), { guideId: '30', panelId: '40', remove: ['10', '20', '50'] });
  // state lost: adopt the oldest guide; the oldest panel sits below it and survives
  assert.deepEqual(planFrontDesk(messages, 'bot', {}), { guideId: '10', panelId: '20', remove: ['30', '40', '50'] });
  // stored ids that no longer exist fall back to adoption
  assert.equal(planFrontDesk(messages, 'bot', { guideMessageId: '999' }).guideId, '10');
});

test('planFrontDesk reposts a panel that would sit above the guide', () => {
  assert.deepEqual(planFrontDesk([msg('10', 'panel'), msg('20', 'guide')], 'bot', {}), { guideId: '20', panelId: null, remove: ['10'] });
  assert.deepEqual(planFrontDesk([msg('10', 'panel')], 'bot', {}), { guideId: null, panelId: null, remove: ['10'] });
  assert.deepEqual(planFrontDesk([], 'bot', {}), { guideId: null, panelId: null, remove: [] });
});

// ------------------------------------------------------------------ fakes

function fakeState(initial = {}) {
  const data = new Map(Object.entries(structuredClone(initial)));
  return {
    data,
    get(ns, defaults = {}) {
      if (!data.has(ns)) data.set(ns, {});
      const value = data.get(ns);
      for (const [k, d] of Object.entries(defaults)) if (!(k in value)) value[k] = structuredClone(d);
      return value;
    },
    save() {},
  };
}

function fakeChannel(botId) {
  let seq = 1000n;
  const all = new Map();
  const toJSON = (x) => (typeof x?.toJSON === 'function' ? x.toJSON() : x);
  function make(payload, { author = botId, type = MessageType.Default } = {}) {
    const m = {
      id: String((seq += 1n)),
      author: { id: author },
      type,
      pinned: false,
      embeds: (payload.embeds ?? []).map(toJSON),
      components: (payload.components ?? []).map(toJSON),
      edits: 0,
      async edit(p) {
        m.embeds = (p.embeds ?? []).map(toJSON);
        m.components = (p.components ?? []).map(toJSON);
        m.edits += 1;
        return m;
      },
      async pin() {
        m.pinned = true;
        make({}, { type: MessageType.ChannelPinnedMessage });
        return m;
      },
      async delete() {
        all.delete(m.id);
      },
    };
    all.set(m.id, m);
    return m;
  }
  return {
    all,
    make,
    sends: 0,
    messages: {
      async fetch(arg) {
        if (typeof arg === 'string') {
          const m = all.get(arg);
          if (!m) throw new Error('Unknown Message');
          return m;
        }
        const newest = [...all.values()].sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1)).slice(0, arg?.limit ?? 50);
        return new Map(newest.map((m) => [m.id, m]));
      },
    },
    async send(payload) {
      this.sends += 1;
      return make(payload);
    },
  };
}

function fakeCtx({ channel, state = fakeState(), dryRun = false }) {
  const roleIds = Object.fromEntries(layout.roles.map((r) => [r.key, `role-${r.key}`]));
  return {
    config: { projects, layout, local: { guildId: 'g', ownerIds: [] }, project: (k) => projects.find((p) => p.key === k) ?? null },
    state,
    dryRun,
    log: { child: () => ({ info() {}, warn() {}, error() {} }) },
    client: { user: { id: 'bot' } },
    guildCtx: {
      ownerId: 'owner',
      channelId: (k) => channelIds[k] ?? null,
      roleId: (k) => roleIds[k] ?? null,
      role: () => null,
      channel: async () => channel,
    },
  };
}

function botKinds(channel) {
  return [...channel.all.values()].map((m) => frontDeskKind(m, 'bot')).filter(Boolean).sort();
}

test('refreshFrontDesk leaves exactly one pinned guide and one panel across restarts', async () => {
  const channel = fakeChannel('bot');
  channel.make({ content: 'hi' }, { author: 'human' });
  const state = fakeState();
  const ctx = fakeCtx({ channel, state });

  await refreshFrontDesk(ctx);
  assert.deepEqual(botKinds(channel), ['guide', 'panel']);
  const { guideMessageId, panelMessageId } = state.get('onboarding');
  assert.ok(channel.all.get(guideMessageId).pinned);
  assert.ok(BigInt(panelMessageId) > BigInt(guideMessageId));

  // restart: edits in place, posts nothing new
  const sends = channel.sends;
  await refreshFrontDesk(ctx);
  assert.equal(channel.sends, sends);
  assert.equal(channel.all.get(guideMessageId).edits, 1);
  assert.deepEqual(botKinds(channel), ['guide', 'panel']);

  // lost state file: adopts the existing messages instead of duplicating them
  state.data.delete('onboarding');
  await refreshFrontDesk(ctx);
  assert.equal(channel.sends, sends);
  assert.equal(state.get('onboarding').guideMessageId, guideMessageId);

  // guide deleted by hand: a new pinned guide, and the panel is reposted under it
  channel.all.delete(guideMessageId);
  await refreshFrontDesk(ctx);
  assert.deepEqual(botKinds(channel), ['guide', 'panel']);
  const now = state.get('onboarding');
  assert.notEqual(now.guideMessageId, guideMessageId);
  assert.ok(channel.all.get(now.guideMessageId).pinned);
  assert.ok(BigInt(now.panelMessageId) > BigInt(now.guideMessageId));
  assert.ok([...channel.all.values()].some((m) => m.author.id === 'human'), 'human messages are left alone');
});

test('refreshFrontDesk only logs in dry-run', async () => {
  const channel = fakeChannel('bot');
  await refreshFrontDesk(fakeCtx({ channel, dryRun: true }));
  assert.equal(channel.all.size, 0);
});

test('join card shows who, account age and owner-only buttons', () => {
  const now = Date.parse('2026-09-29T12:00:00Z');
  const fresh = buildJoinCard({ userId: '42', tag: 'new_guy', createdAt: new Date(now - 2 * 86_400_000), now });
  const e = fresh.embeds[0].toJSON();
  assert.ok(e.description.includes('<@42>'));
  assert.ok(e.description.includes('new\\_guy'));
  assert.ok(e.description.includes('fresh account'));
  const ids = fresh.components[0].toJSON().components.map((c) => c.custom_id);
  assert.deepEqual(ids, ['onboarding:hire:42', 'onboarding:dismiss:42']);
  const old = buildJoinCard({ userId: '42', tag: 'x', createdAt: new Date(now - 400 * 86_400_000), joinedAt: new Date(now - 3600_000), missed: true, now });
  const d = old.embeds[0].toJSON().description;
  assert.ok(!d.includes('fresh account'));
  assert.ok(d.includes('while gojo was offline'));
});

test('resolveCardEmbed replaces the decision field and keeps the rest', () => {
  const base = { title: 'card', fields: [{ name: 'note', value: 'x' }] };
  const once = resolveCardEmbed(base, 'dismissed').toJSON();
  const twice = resolveCardEmbed(once, 'hired').toJSON();
  assert.deepEqual(twice.fields, [
    { name: 'note', value: 'x' },
    { name: 'decision', value: 'hired' },
  ]);
  assert.equal(twice.title, 'card');
});

test('welcome dm names what the badge unlocks and fits a message', () => {
  const text = buildWelcomeDm(names);
  assert.ok(text.length < 2000);
  assert.ok(text.includes('member of technical staff'));
  assert.ok(text.includes(`<#${channelIds['red-team']}>`));
  assert.ok(text.includes('/access request'));
});

test('missedArrivals finds humans who joined while offline and have no role yet', () => {
  const members = [
    { id: 'a', bot: false, joinedAt: 200, roles: [] },
    { id: 'b', bot: false, joinedAt: 50, roles: [] },
    { id: 'c', bot: true, joinedAt: 200, roles: [] },
    { id: 'd', bot: false, joinedAt: 200, roles: ['staff'] },
    { id: 'e', bot: false, joinedAt: 200, roles: ['waitlist'] },
    { id: 'owner', bot: false, joinedAt: 200, roles: [] },
    { id: 'f', bot: false, joinedAt: 200, roles: [] },
  ];
  const out = missedArrivals(members, { since: 100, roleIds: ['staff', 'waitlist'], ownerIds: ['owner'], carded: { f: 'card' } });
  assert.deepEqual(out.map((m) => m.id), ['a']);
});

test('module registers /hire and /fire hidden behind Manage Roles', () => {
  const cmds = onboarding.commands().map((c) => c.toJSON());
  assert.deepEqual(cmds.map((c) => c.name), ['hire', 'fire']);
  for (const c of cmds) assert.equal(c.default_member_permissions, String(1n << 28n));
  assert.deepEqual(Object.keys(onboarding.components).sort(), ['dismiss', 'hire', 'ping']);
});

test('hire button is owner-only and never touches roles for others', async () => {
  const ctx = fakeCtx({ channel: fakeChannel('bot') });
  const replies = [];
  let deferred = false;
  const interaction = {
    user: { id: 'intruder' },
    guild: { members: { fetch: async () => assert.fail('must not fetch members') } },
    reply: async (p) => replies.push(p),
    deferUpdate: async () => {
      deferred = true;
    },
  };
  await onboarding.components.hire(interaction, ctx, ['42']);
  assert.equal(deferred, false);
  assert.equal(replies.length, 1);
  assert.match(replies[0].content, /board members only/);
});
