import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { MessageFlags } from 'discord.js';
import { GitHubError, RateLimitError } from '../src/core/github.mjs';
import feedback, {
  KINDS,
  KIND_KEYS,
  ISSUE_BODY_MAX,
  inferFromTags,
  nextTags,
  sameTags,
  starterText,
  unreadableReason,
  issueBody,
  closedNote,
  shipsOnClose,
  issueKey,
  issueLink,
  postEmbed,
  postButtons,
  feedbackModal,
  projectPicker,
  introText,
} from '../src/modules/feedback.mjs';

const projects = JSON.parse(fs.readFileSync(new URL('../config/projects.json', import.meta.url), 'utf8')).projects;
const TAGS = {
  dexcode: 't-code',
  dexclient: 't-client',
  dexplace: 't-place',
  bug: 't-bug',
  idea: 't-idea',
  ux: 't-ux',
  perf: 't-perf',
  praise: 't-praise',
  tracked: 't-tracked',
  shipped: 't-shipped',
};
const KIND_IDS = KIND_KEYS.map((k) => TAGS[k]);
const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';

// ------------------------------------------------------------------ pure helpers

test('inferFromTags: one project tag -> that project; none or several -> null', () => {
  assert.deepEqual(inferFromTags(['t-client', 't-bug'], TAGS, projects), { project: 'dexclient', kind: 'bug' });
  assert.deepEqual(inferFromTags(['t-place'], TAGS, projects), { project: 'dexplace', kind: null });
  assert.deepEqual(inferFromTags(['t-code', 't-client', 't-idea'], TAGS, projects), { project: null, kind: 'idea' });
  assert.deepEqual(inferFromTags([], TAGS, projects), { project: null, kind: null });
  assert.deepEqual(inferFromTags(['unknown'], {}, projects), { project: null, kind: null });
});

test('inferFromTags: the first applied kind tag wins', () => {
  assert.equal(inferFromTags(['t-perf', 't-bug'], TAGS, projects).kind, 'perf');
});

test('nextTags adds and removes without duplicates', () => {
  assert.deepEqual(nextTags(['t-code', 't-bug'], ['t-tracked'], [], KIND_IDS), ['t-code', 't-bug', 't-tracked']);
  assert.deepEqual(nextTags(['t-code', 't-tracked'], ['t-tracked'], [], KIND_IDS), ['t-code', 't-tracked']);
  assert.deepEqual(nextTags(['t-code', 't-shipped'], [], ['t-shipped'], KIND_IDS), ['t-code']);
  assert.deepEqual(nextTags(['t-code'], [null, 't-tracked'], [null], KIND_IDS), ['t-code', 't-tracked']);
  assert.deepEqual(nextTags(undefined, ['t-shipped'], [], KIND_IDS), ['t-shipped']);
});

test('nextTags keeps to 5 tags, dropping kind tags first', () => {
  const current = ['t-code', 't-bug', 't-idea', 't-ux', 't-tracked'];
  assert.deepEqual(nextTags(current, ['t-shipped'], [], KIND_IDS), ['t-code', 't-idea', 't-ux', 't-tracked', 't-shipped']);
  const full = ['t-code', 't-client', 't-place', 't-tracked', 't-bug'];
  assert.deepEqual(nextTags(full, ['t-shipped'], [], KIND_IDS), ['t-code', 't-client', 't-place', 't-tracked', 't-shipped']);
});

test('nextTags drops the oldest non-kind tag when no kind tag is left, never an added one', () => {
  const current = ['t-code', 't-client', 't-place', 't-tracked', 'x-other'];
  assert.deepEqual(nextTags(current, ['t-shipped'], [], KIND_IDS), ['t-client', 't-place', 't-tracked', 'x-other', 't-shipped']);
  assert.deepEqual(nextTags([], ['a', 'b', 'c', 'd', 'e', 'f'], [], KIND_IDS), ['a', 'b', 'c', 'd', 'e']);
});

test('sameTags ignores order', () => {
  assert.equal(sameTags(['a', 'b'], ['b', 'a']), true);
  assert.equal(sameTags(['a'], ['a', 'b']), false);
});

test('starterText prefers content, then the first embed description, and notes attachments', () => {
  assert.equal(starterText(null), '');
  assert.equal(starterText({ content: ' it broke ', embeds: [{ description: 'no' }] }), 'it broke');
  assert.equal(starterText({ content: '', embeds: [{ description: 'from the form' }] }), 'from the form');
  assert.equal(starterText({ content: '', embeds: [], attachments: { size: 2 } }), '_2 attachments on the Discord post._');
  assert.equal(starterText({ content: 'see pic', attachments: { size: 1 } }), 'see pic\n\n_1 attachment on the Discord post._');
});

test('issueBody redacts, adds the footer and stays within GitHub limits', () => {
  const url = 'https://discord.com/channels/1/2';
  const body = issueBody({ text: `crash with ${TOKEN}`, reporter: 'kai', url });
  assert.equal(body, `crash with [redacted]\n\n---\nreported by kai in the dev Discord (${url})`);
  assert.equal(issueBody({ text: '  ', reporter: '', url }), `(no description)\n\n---\nreported by someone in the dev Discord (${url})`);
  const huge = issueBody({ text: 'x'.repeat(100_000), reporter: 'kai', url });
  assert.equal(huge.length, ISSUE_BODY_MAX);
  assert.ok(huge.endsWith(`reported by kai in the dev Discord (${url})`));
});

test('unreadableReason spots member posts Discord blanked (no Message Content intent)', () => {
  const hidden = { content: '', embeds: [], attachments: { size: 0 }, author: { id: 'member' } };
  assert.match(unreadableReason(hidden, 'bot'), /message content intent is off/);
  assert.match(unreadableReason(null, 'bot'), /couldn't load/);
  assert.equal(unreadableReason({ ...hidden, author: { id: 'bot' } }, 'bot'), null);
  assert.equal(unreadableReason({ ...hidden, content: 'it broke' }, 'bot'), null);
  assert.equal(unreadableReason({ ...hidden, attachments: { size: 1 } }, 'bot'), null);
});

test('issueBody says the text was unreadable instead of "(no description)"', () => {
  const url = 'https://discord.com/channels/1/2';
  assert.equal(
    issueBody({ text: '', reporter: 'kai', url, unreadable: true }),
    `(GOJO couldn't read the post text. it's in the Discord post linked below.)\n\n---\nreported by kai in the dev Discord (${url})`,
  );
  assert.ok(issueBody({ text: 'real text', reporter: 'kai', url, unreadable: true }).startsWith('real text\n\n---'));
});

test('closedNote and shipsOnClose: only a completed (or reasonless) close ships', () => {
  const issue = { repo: 'o/r', number: 3, url: 'https://github.com/o/r/issues/3' };
  assert.equal(shipsOnClose(null), true);
  assert.equal(shipsOnClose('completed'), true);
  assert.equal(shipsOnClose('not_planned'), false);
  assert.equal(shipsOnClose('duplicate'), false);
  assert.equal(closedNote(issue, { closedBy: 'dex', reason: 'completed' }), '✅ [o/r#3](<https://github.com/o/r/issues/3>) was closed on github by dex');
  assert.equal(closedNote(issue), '✅ [o/r#3](<https://github.com/o/r/issues/3>) was closed on github');
  assert.equal(
    closedNote(issue, { closedBy: 'dex', reason: 'not_planned' }),
    '🗑️ [o/r#3](<https://github.com/o/r/issues/3>) was closed on github as not planned by dex. no ship tag this time.',
  );
  assert.match(closedNote(issue, { reason: 'duplicate' }), /closed on github as duplicate\./);
  assert.match(closedNote(issue, { closedBy: 'under_score' }), /by under\\_score$/);
});

test('issueKey and issueLink', () => {
  assert.equal(issueKey('dexnotavailable/dexclient', 7), 'dexnotavailable/dexclient#7');
  assert.equal(issueLink({ repo: 'o/r', number: 7, url: 'https://github.com/o/r/issues/7' }), '[o/r#7](<https://github.com/o/r/issues/7>)');
});

test('postEmbed shows details, where, project, kind and the reporter', () => {
  const project = projects.find((p) => p.key === 'dexclient');
  const json = postEmbed({ project, kind: 'bug', details: `updater loops ${TOKEN}`, where: 'v0.4.0 on launch', authorId: 'u1' }).toJSON();
  assert.equal(json.description, 'updater loops [redacted]\n\n**where/when:** v0.4.0 on launch');
  assert.equal(json.author.name, '🐛 bug · 📦 dexClient');
  assert.deepEqual(
    json.fields.map((f) => [f.name, f.value]),
    [['project', '📦 dexClient'], ['kind', '🐛 bug'], ['reported by', '<@u1>']],
  );
  assert.equal(postEmbed({ project, kind: 'idea', details: 'dark mode', where: '', authorId: 'u1' }).toJSON().description, 'dark mode');
});

test('buttons, modal and picker build valid components', () => {
  assert.deepEqual(postButtons().toJSON().components.map((c) => c.custom_id), ['feedback:track', 'feedback:ship']);
  const project = projects.find((p) => p.key === 'dexplace');
  for (const kind of KIND_KEYS) {
    const modal = feedbackModal(project, kind).toJSON();
    assert.equal(modal.custom_id, `feedback:new:dexplace:${kind}`);
    assert.ok(modal.title.length <= 45);
    const inputs = modal.components.map((l) => l.component);
    assert.deepEqual(inputs.map((i) => [i.custom_id, i.required, i.max_length]), [['title', true, 100], ['details', true, 3000], ['where', false, 200]]);
  }
  const picker = projectPicker(projects, '1234567890123456789').toJSON().components[0];
  assert.equal(picker.custom_id, 'feedback:trackpick:1234567890123456789');
  assert.deepEqual(picker.options.map((o) => o.value), ['dexcode', 'dexclient', 'dexplace']);
});

test('introText asks for a project tag only when it is missing', () => {
  assert.doesNotMatch(introText('dexcode'), /tag exactly one project/);
  assert.match(introText(null), /tag exactly one project/);
});

test('the /feedback command builds', () => {
  const json = feedback.commands({ projects })[0].toJSON();
  assert.deepEqual(json.options.map((o) => o.name), ['new', 'track', 'ship']);
  const kind = json.options[0].options.find((o) => o.name === 'kind');
  assert.deepEqual(kind.choices.map((c) => c.value), KIND_KEYS);
  assert.deepEqual(Object.keys(KINDS), ['bug', 'idea', 'ux', 'perf', 'praise']);
});

// ------------------------------------------------------------------ flows with fakes

const flush = () => new Promise((r) => setTimeout(r, 5));

function fakeThread(id, { tags = [], archived = false, ownerId = 'member', starter = null } = {}) {
  return {
    id,
    name: 'updater loops forever',
    parentId: 'forum',
    ownerId,
    archived,
    appliedTags: tags,
    url: `https://discord.com/channels/g/${id}`,
    createdTimestamp: Date.parse('2026-09-29T00:00:00Z'),
    sent: [],
    isThread: () => true,
    async setArchived(v) {
      this.archived = v;
    },
    async setAppliedTags(t) {
      this.appliedTags = t;
    },
    async send(p) {
      this.sent.push(p);
      return p;
    },
    fetchStarterMessage: async () => starter,
  };
}

function fakeCtx(threads = []) {
  const data = new Map();
  const channels = new Map(threads.map((t) => [t.id, t]));
  const github = {
    calls: [],
    issues: new Map(),
    async createIssue(repo, fields) {
      this.calls.push(['create', repo, fields]);
      return { number: 41, html_url: `https://github.com/${repo}/issues/41` };
    },
    async issue(repo, n) {
      this.calls.push(['get', repo, n]);
      return this.issues.get(`${repo}#${n}`) ?? { state: 'open', html_url: `https://github.com/${repo}/issues/${n}` };
    },
    async commentIssue(repo, n, body) {
      this.calls.push(['comment', repo, n, body]);
    },
    async updateIssue(repo, n, fields) {
      this.calls.push(['update', repo, n, fields]);
    },
  };
  const jobs = [];
  const warnings = [];
  return {
    jobs,
    warnings,
    config: { projects, local: { ownerIds: [] }, project: (k) => projects.find((p) => p.key === k) ?? null },
    state: {
      get(ns, defaults = {}) {
        if (!data.has(ns)) data.set(ns, {});
        const v = data.get(ns);
        for (const [k, d] of Object.entries(defaults)) if (!(k in v)) v[k] = structuredClone(d);
        return v;
      },
      save() {},
    },
    guildCtx: {
      ownerId: 'owner',
      ids: { tags: { rlhf: TAGS } },
      tagId: (forum, key) => (forum === 'rlhf' ? TAGS[key] ?? null : null),
      channelId: (key) => (key === 'rlhf' ? 'forum' : null),
      roleId: (key) => (key === 'staff' ? 'staff-role' : null),
      role: () => null,
    },
    client: {
      user: { id: 'bot' },
      channels: { cache: channels, fetch: async (id) => channels.get(id) ?? null },
      users: { fetch: async (id) => ({ id, username: `user-${id}` }) },
    },
    github,
    bus: new EventEmitter(),
    scheduler: { every: (name, seconds, fn) => jobs.push({ name, seconds, fn }) },
    log: { child: () => ({ info() {}, warn: (m) => warnings.push(m), error() {} }) },
    dryRun: false,
  };
}

function press(thread, { userId = 'staffer', staff = true, values } = {}) {
  const replies = [];
  return {
    replies,
    interaction: {
      user: { id: userId, username: userId },
      member: { user: { id: userId }, roles: staff ? ['staff-role'] : [] },
      channel: thread,
      channelId: thread?.id ?? 'elsewhere',
      values,
      options: { getSubcommand: () => 'track' },
      deferReply: async (p) => replies.push({ defer: p }),
      editReply: async (p) => replies.push({ edit: p }),
      reply: async (p) => replies.push({ reply: p }),
      update: async (p) => replies.push({ update: p }),
    },
  };
}

test('track asks for the repo when the post has no project tag, then files the issue once', async () => {
  const starter = { content: `it loops. token ${TOKEN}`, embeds: [], attachments: { size: 0 } };
  const thread = fakeThread('p1', { tags: ['t-bug'], starter });
  const ctx = fakeCtx([thread]);

  let { interaction, replies } = press(thread);
  await feedback.components.track(interaction, ctx, []);
  assert.deepEqual(replies[0].defer, { flags: MessageFlags.Ephemeral });
  const picker = replies[1].edit.components[0].toJSON().components[0];
  assert.equal(picker.custom_id, 'feedback:trackpick:p1');
  assert.equal(ctx.github.calls.length, 0);

  ({ interaction, replies } = press(null, { values: ['dexclient'] }));
  await feedback.components.trackpick(interaction, ctx, ['p1']);
  const [, repo, fields] = ctx.github.calls.find((c) => c[0] === 'create');
  assert.equal(repo, 'dexnotavailable/dexclient');
  assert.equal(fields.title, 'updater loops forever');
  assert.equal(fields.labels, undefined);
  assert.equal(fields.body, `it loops. token [redacted]\n\n---\nreported by user-member in the dev Discord (${thread.url})`);
  assert.match(replies.at(-1).edit, /^tracked as dexnotavailable\/dexclient#41/);

  const data = ctx.state.get('feedback');
  assert.deepEqual(data.threads.p1.issue, { repo: 'dexnotavailable/dexclient', number: 41, url: 'https://github.com/dexnotavailable/dexclient/issues/41' });
  assert.equal(data.threads.p1.status, 'tracked');
  assert.equal(data.issues['dexnotavailable/dexclient#41'], 'p1');
  assert.deepEqual(thread.appliedTags, ['t-bug', 't-client', 't-tracked']);
  assert.equal(thread.sent.at(-1).content, '📌 tracked as [dexnotavailable/dexclient#41](<https://github.com/dexnotavailable/dexclient/issues/41>)');

  ({ interaction, replies } = press(thread));
  await feedback.components.track(interaction, ctx, []);
  assert.match(replies.at(-1).edit, /^already tracked/);
  assert.equal(ctx.github.calls.filter((c) => c[0] === 'create').length, 1);
});

test('track and ship are staff only and only inside #rlhf posts', async () => {
  const thread = fakeThread('p2', { tags: ['t-code'] });
  const ctx = fakeCtx([thread]);
  let { interaction, replies } = press(thread, { staff: false });
  await feedback.components.ship(interaction, ctx, []);
  assert.match(replies[0].reply.content, /member of technical staff/);
  assert.equal(ctx.state.get('feedback', { threads: {} }).threads.p2, undefined);

  const elsewhere = { ...fakeThread('x'), parentId: 'some-other-channel' };
  ({ interaction } = press(elsewhere));
  await assert.rejects(feedback.components.track(interaction, ctx, []), (err) => err.name === 'UserError' && /inside a post/.test(err.message));
});

test('ship tags the post, closes its open issue once, and the later github close is ignored', async () => {
  const thread = fakeThread('p3', { tags: ['t-code', 't-tracked'], archived: true });
  const ctx = fakeCtx([thread]);
  const data = ctx.state.get('feedback', { threads: {}, issues: {} });
  data.threads.p3 = { project: 'dexcode', kind: 'bug', title: thread.name, status: 'tracked', issue: { repo: 'dexnotavailable/dexcode', number: 9, url: 'u9' }, authorId: 'm', createdAt: 'x' };
  data.issues['dexnotavailable/dexcode#9'] = 'p3';
  await feedback.start(ctx);

  let { interaction, replies } = press(thread);
  await feedback.components.ship(interaction, ctx, []);
  assert.equal(replies.at(-1).edit, 'marked shipped and closed dexnotavailable/dexcode#9.');
  assert.equal(thread.archived, false);
  assert.deepEqual(thread.appliedTags, ['t-code', 't-tracked', 't-shipped']);
  assert.equal(thread.sent.at(-1).content, '✅ shipped by <@staffer>');
  assert.deepEqual(
    ctx.github.calls.filter((c) => c[0] !== 'get'),
    [
      ['comment', 'dexnotavailable/dexcode', 9, 'shipped (closed from the dev Discord)'],
      ['update', 'dexnotavailable/dexcode', 9, { state: 'closed', state_reason: 'completed' }],
    ],
  );

  ({ interaction, replies } = press(thread));
  await feedback.components.ship(interaction, ctx, []);
  assert.equal(replies.at(-1).edit, 'already shipped.');

  ctx.bus.emit('issue:closed', { project: 'dexcode', number: 9, title: 't', url: 'u9', closedBy: 'dex' });
  await flush();
  assert.equal(thread.sent.length, 1);
  await feedback.stop(ctx);
});

test('issue:closed and issue:reopened from github update the post once each', async () => {
  const thread = fakeThread('p4', { tags: ['t-place', 't-idea', 't-tracked'], archived: true });
  const ctx = fakeCtx([thread]);
  const data = ctx.state.get('feedback', { threads: {}, issues: {} });
  data.threads.p4 = { project: 'dexplace', kind: 'idea', title: thread.name, status: 'tracked', issue: { repo: 'dexnotavailable/dex.place', number: 3, url: 'u3' }, authorId: 'm', createdAt: 'x' };
  data.issues['dexnotavailable/dex.place#3'] = 'p4';
  await feedback.start(ctx);

  const closed = { project: 'dexplace', number: 3, title: 't', url: 'https://github.com/dexnotavailable/dex.place/issues/3', closedBy: 'dex' };
  ctx.bus.emit('issue:closed', closed);
  ctx.bus.emit('issue:closed', closed);
  await flush();
  assert.equal(data.threads.p4.status, 'shipped');
  assert.equal(thread.archived, false);
  assert.deepEqual(thread.appliedTags, ['t-place', 't-idea', 't-tracked', 't-shipped']);
  assert.equal(thread.sent.length, 1);
  assert.equal(thread.sent[0].content, '✅ [dexnotavailable/dex.place#3](<https://github.com/dexnotavailable/dex.place/issues/3>) was closed on github by dex');

  ctx.bus.emit('issue:reopened', { project: 'dexplace', number: 3, title: 't', url: closed.url });
  await flush();
  assert.equal(data.threads.p4.status, 'tracked');
  assert.deepEqual(thread.appliedTags, ['t-place', 't-idea', 't-tracked']);
  assert.match(thread.sent[1].content, /was reopened on github/);

  ctx.bus.emit('issue:closed', { project: 'dexcode', number: 3 }); // same number, other repo
  await flush();
  assert.equal(thread.sent.length, 2);

  await feedback.stop(ctx);
  assert.equal(ctx.bus.listenerCount('issue:closed'), 0);
  assert.equal(ctx.bus.listenerCount('issue:reopened'), 0);
});

test('the sync job catches closes the bus missed', async () => {
  const thread = fakeThread('p5', { tags: ['t-code', 't-tracked'] });
  const ctx = fakeCtx([thread]);
  const data = ctx.state.get('feedback', { threads: {}, issues: {} });
  data.threads.p5 = { project: 'dexcode', kind: null, title: thread.name, status: 'tracked', issue: { repo: 'dexnotavailable/dexcode', number: 5, url: 'u5' }, authorId: 'm', createdAt: 'x' };
  data.threads.p6 = { project: 'dexcode', kind: null, title: 'open one', status: 'open', issue: null, authorId: 'm', createdAt: 'x' };
  data.issues['dexnotavailable/dexcode#5'] = 'p5';
  ctx.github.issues.set('dexnotavailable/dexcode#5', { state: 'closed', html_url: 'https://github.com/dexnotavailable/dexcode/issues/5', closed_by: { login: 'kai' } });
  await feedback.start(ctx);
  const job = ctx.jobs.find((j) => j.name === 'feedback-issues');
  await job.fn();
  await job.fn();
  assert.equal(data.threads.p5.status, 'shipped');
  assert.equal(thread.sent.length, 1);
  assert.match(thread.sent[0].content, /was closed on github by kai$/);
  assert.deepEqual(ctx.github.calls, [['get', 'dexnotavailable/dexcode', 5]]);
  await feedback.stop(ctx);
});

test('a member post in #rlhf gets recorded and one intro message with the buttons', async () => {
  const thread = fakeThread('p7', { tags: ['t-client', 't-ux'] });
  const ctx = fakeCtx([thread]);
  await feedback.events.threadCreate(thread, true, ctx);
  const record = ctx.state.get('feedback').threads.p7;
  assert.deepEqual(
    { project: record.project, kind: record.kind, status: record.status, issue: record.issue, authorId: record.authorId },
    { project: 'dexclient', kind: 'ux', status: 'open', issue: null, authorId: 'member' },
  );
  assert.equal(thread.sent.length, 1);
  assert.deepEqual(thread.sent[0].allowedMentions, { parse: [] });
  assert.equal(thread.sent[0].components[0].toJSON().components[0].custom_id, 'feedback:track');

  await feedback.events.threadCreate(thread, true, ctx); // replayed event
  const own = fakeThread('p8', { ownerId: 'bot' });
  await feedback.events.threadCreate(own, true, ctx);
  await feedback.events.threadCreate({ ...fakeThread('p9'), parentId: 'elsewhere' }, true, ctx);
  assert.equal(thread.sent.length, 1);
  assert.equal(ctx.state.get('feedback').threads.p8, undefined);
  assert.equal(ctx.state.get('feedback').threads.p9, undefined);
});

test('/feedback new submit creates a tagged forum post and records it', async () => {
  const created = [];
  const ctx = fakeCtx();
  const forum = {
    type: 15, // ChannelType.GuildForum
    threads: {
      create: async (opts) => {
        created.push(opts);
        return { id: 'p10', name: opts.name, url: 'https://discord.com/channels/g/p10' };
      },
    },
  };
  ctx.guildCtx.channel = async (key) => (key === 'rlhf' ? forum : null);
  const values = { title: '  installer hangs ', details: 'at 99%', where: '' };
  const replies = [];
  const interaction = {
    user: { id: 'u1', username: 'kai' },
    fields: { getTextInputValue: (id) => values[id] },
    deferReply: async (p) => replies.push({ defer: p }),
    editReply: async (p) => replies.push({ edit: p }),
  };
  await feedback.components.new(interaction, ctx, ['dexclient', 'bug']);
  assert.equal(created.length, 1);
  assert.equal(created[0].name, 'installer hangs');
  assert.deepEqual(created[0].appliedTags, ['t-client', 't-bug']);
  assert.deepEqual(created[0].message.allowedMentions, { parse: [] });
  assert.equal(created[0].message.embeds[0].toJSON().description, 'at 99%');
  assert.equal(created[0].message.components[0].toJSON().components[1].custom_id, 'feedback:ship');
  const record = ctx.state.get('feedback').threads.p10;
  assert.deepEqual(
    { project: record.project, kind: record.kind, title: record.title, status: record.status, issue: record.issue, authorId: record.authorId },
    { project: 'dexclient', kind: 'bug', title: 'installer hangs', status: 'open', issue: null, authorId: 'u1' },
  );
  assert.equal(replies.at(-1).edit, 'posted in rlhf: https://discord.com/channels/g/p10');
});

test('tracking a member post Discord blanked says so in the issue and the reply', async () => {
  const starter = { content: '', embeds: [], attachments: { size: 0 }, author: { id: 'member' } };
  const thread = fakeThread('p11', { tags: ['t-client', 't-bug'], starter });
  const ctx = fakeCtx([thread]);
  const { interaction, replies } = press(thread);
  await feedback.components.track(interaction, ctx, []);
  const [, , fields] = ctx.github.calls.find((c) => c[0] === 'create');
  assert.match(fields.body, /^\(GOJO couldn't read the post text/);
  assert.match(replies.at(-1).edit, /^tracked as dexnotavailable\/dexclient#41: \S+\nheads up: discord hid the post text/);
});

test('a project picker used after the post shipped files nothing', async () => {
  const thread = fakeThread('p12', { tags: ['t-bug'], starter: { content: 'x', embeds: [] } });
  const ctx = fakeCtx([thread]);
  let { interaction, replies } = press(thread);
  await feedback.components.track(interaction, ctx, []);
  assert.equal(replies[1].edit.components[0].toJSON().components[0].custom_id, 'feedback:trackpick:p12');

  ({ interaction } = press(thread));
  await feedback.components.ship(interaction, ctx, []);
  ({ interaction, replies } = press(null, { values: ['dexclient'] }));
  await feedback.components.trackpick(interaction, ctx, ['p12']);
  assert.equal(replies.at(-1).edit, 'this one already shipped. nothing left to track.');
  assert.equal(ctx.github.calls.filter((c) => c[0] === 'create').length, 0);
  assert.equal(ctx.state.get('feedback').threads.p12.status, 'shipped');
  assert.deepEqual(thread.appliedTags, ['t-bug', 't-shipped']);
});

test('closed as not planned: status closed, tags untouched, a note; a reopen puts it back on the list', async () => {
  const thread = fakeThread('p13', { tags: ['t-code', 't-idea', 't-tracked'] });
  const ctx = fakeCtx([thread]);
  const data = ctx.state.get('feedback', { threads: {}, issues: {} });
  data.threads.p13 = { project: 'dexcode', kind: 'idea', title: thread.name, status: 'tracked', issue: { repo: 'dexnotavailable/dexcode', number: 13, url: 'u13' }, authorId: 'm', createdAt: 'x' };
  data.issues['dexnotavailable/dexcode#13'] = 'p13';
  await feedback.start(ctx);

  const url = 'https://github.com/dexnotavailable/dexcode/issues/13';
  ctx.bus.emit('issue:closed', { project: 'dexcode', number: 13, title: 't', url, closedBy: 'dex', reason: 'not_planned' });
  await flush();
  assert.equal(data.threads.p13.status, 'closed');
  assert.deepEqual(thread.appliedTags, ['t-code', 't-idea', 't-tracked']);
  assert.equal(thread.sent.length, 1);
  assert.match(thread.sent[0].content, /^🗑️ .+ was closed on github as not planned by dex\./);

  ctx.bus.emit('issue:reopened', { project: 'dexcode', number: 13, title: 't', url });
  await flush();
  assert.equal(data.threads.p13.status, 'tracked');
  assert.deepEqual(thread.appliedTags, ['t-code', 't-idea', 't-tracked']);
  assert.match(thread.sent[1].content, /was reopened on github/);
  await feedback.stop(ctx);
});

test('the sync job skips a failing issue, keeps going, logs it once, and only stops for rate limits', async () => {
  const [a, b] = [fakeThread('p14', { tags: ['t-code'] }), fakeThread('p15', { tags: ['t-code'] })];
  const ctx = fakeCtx([a, b]);
  const data = ctx.state.get('feedback', { threads: {}, issues: {} });
  data.threads.p14 = { project: 'dexcode', kind: null, title: a.name, status: 'tracked', issue: { repo: 'dexnotavailable/dexcode', number: 14, url: 'u14' }, authorId: 'm', createdAt: 'x' };
  data.threads.p15 = { project: 'dexcode', kind: null, title: b.name, status: 'tracked', issue: { repo: 'dexnotavailable/dexcode', number: 15, url: 'u15' }, authorId: 'm', createdAt: 'x' };
  data.issues['dexnotavailable/dexcode#14'] = 'p14';
  data.issues['dexnotavailable/dexcode#15'] = 'p15';
  let failWith = new GitHubError('GitHub GET /repos/dexnotavailable/dexcode/issues/14: HTTP 500', { status: 500 });
  const issue = ctx.github.issue.bind(ctx.github);
  ctx.github.issue = async (repo, n) => {
    if (n === 14) throw failWith;
    return issue(repo, n);
  };
  ctx.github.issues.set('dexnotavailable/dexcode#15', { state: 'closed', state_reason: 'not_planned', html_url: 'u15', closed_by: { login: 'kai' } });
  await feedback.start(ctx);
  const job = ctx.jobs.find((j) => j.name === 'feedback-issues');

  await job.fn();
  await job.fn();
  assert.equal(data.threads.p14.status, 'tracked');
  assert.equal(data.threads.p15.status, 'closed');
  assert.match(b.sent[0].content, /as not planned by kai/);
  assert.equal(ctx.warnings.filter((w) => w.includes('dexcode#14')).length, 1);

  failWith = new RateLimitError('GitHub rate limited', { status: 403, resetAt: Date.now() + 60_000 });
  await assert.rejects(job.fn(), RateLimitError);
  await feedback.stop(ctx);
});
