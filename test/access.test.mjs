import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import access, {
  LOGIN_RE,
  approvalDm,
  blockedNotice,
  buildAccessList,
  buildAccessStatus,
  buildRequestCard,
  buildRequestModal,
  denyCooldownLeft,
  describeGitHubError,
  grantTargets,
  latestRequestOf,
  mergeGrant,
  nextRequestId,
  parseLogin,
  pendingRequestOf,
  resultLine,
} from '../src/modules/access.mjs';

const { projects } = JSON.parse(fs.readFileSync(new URL('../config/projects.json', import.meta.url), 'utf8'));
const layout = JSON.parse(fs.readFileSync(new URL('../config/layout.json', import.meta.url), 'utf8'));
const PUBLIC = 'dexnotavailable/dex.place';

test('github logins are validated like github does', () => {
  for (const ok of ['octocat', 'a', 'dex-not-available', 'A1', 'x'.repeat(39)]) assert.ok(LOGIN_RE.test(ok), ok);
  for (const bad of ['', '-dex', 'dex-', 'x'.repeat(40), 'dex_code', 'dex code', 'dex/../x']) assert.ok(!LOGIN_RE.test(bad), bad);
  assert.equal(parseLogin(' @octocat '), 'octocat');
  assert.equal(parseLogin('https://github.com/octocat/'), 'octocat');
  assert.equal(parseLogin('octo cat'), null);
});

test('request ids are a short base36 counter kept in state', () => {
  const state = { seq: 0, requests: {} };
  const ids = [];
  for (let i = 0; i < 37; i += 1) {
    const id = nextRequestId(state);
    state.requests[id] = { id };
    ids.push(id);
  }
  assert.deepEqual(ids.slice(0, 3), ['1', '2', '3']);
  assert.equal(ids[35], '10');
  assert.equal(state.seq, 37);
  // a reset counter never reuses an existing id
  state.seq = 0;
  assert.equal(nextRequestId(state), '12'); // 1..37 are taken ('11' is 37)
});

test('pending, latest and deny cooldown lookups', () => {
  const now = Date.parse('2026-09-29T12:00:00Z');
  const state = {
    requests: {
      1: { id: '1', userId: 'u', status: 'approved', at: '2026-09-01T00:00:00Z' },
      2: { id: '2', userId: 'u', status: 'denied', at: '2026-09-29T10:00:00Z', decidedAt: '2026-09-29T11:00:00Z' },
      3: { id: '3', userId: 'v', status: 'pending', at: '2026-09-29T09:00:00Z' },
    },
  };
  assert.equal(pendingRequestOf(state, 'u'), null);
  assert.equal(pendingRequestOf(state, 'v').id, '3');
  assert.equal(latestRequestOf(state, 'u').id, '2');
  assert.equal(denyCooldownLeft(state, 'u', now), 11 * 3600_000);
  assert.equal(denyCooldownLeft(state, 'u', now + 12 * 3600_000), 0);
  assert.equal(denyCooldownLeft(state, 'v', now), 0);
});

const repoInfo = (ownerType) => ({
  'dexnotavailable/dexcode': { private: true, ownerType },
  'dexnotavailable/dexclient': { private: true, ownerType },
  [PUBLIC]: { private: false, ownerType },
});
const plan = (targets) => targets.map((t) => [t.project.key, t.permission, t.skip ?? null]);

test('grantTargets: read covers private org repos only, write pushes everywhere', () => {
  assert.deepEqual(plan(grantTargets(projects, 'r', repoInfo('Organization'), 'pull')), [
    ['dexcode', 'pull', null],
    ['dexclient', 'pull', null],
    ['dexplace', null, 'public'],
  ]);
  assert.deepEqual(grantTargets(projects, 'w', {}).map((t) => t.permission), ['push', 'push', 'push']);
  assert.deepEqual(grantTargets(projects, 'w', repoInfo('User')).map((t) => t.permission), ['push', 'push', 'push']);
});

test('grantTargets: read never invites where github would hand out write instead', () => {
  // personal-account repos ignore the permission and make every collaborator a writer
  assert.deepEqual(plan(grantTargets(projects, 'r', repoInfo('User'), 'pull')), [
    ['dexcode', null, 'personal'],
    ['dexclient', null, 'personal'],
    ['dexplace', null, 'public'],
  ]);
  // unless write is what the read tier was configured to give anyway
  assert.equal(grantTargets(projects, 'r', repoInfo('User'), 'push')[0].permission, 'push');
  // a failed lookup could be either, so it is skipped too
  assert.deepEqual(plan(grantTargets(projects, 'r', {}, 'triage'))[2], ['dexplace', null, 'unknown']);
});

test('describeGitHubError is short, hints at token scope and never leaks tokens', () => {
  const err = Object.assign(new Error('GitHub PUT /repos/x/y/collaborators/z: Must have admin rights'), { status: 403, body: { message: 'Must have admin rights to Repository.' } });
  assert.equal(describeGitHubError(err), "403 Must have admin rights to Repository. (gojo's github token needs admin on this repo)");
  const leaky = new Error(`bad credentials ghp_${'a1'.repeat(18)}`);
  assert.ok(!describeGitHubError(leaky).includes('ghp_'));
  assert.ok(describeGitHubError({ message: 'x'.repeat(500) }).length <= 180);
});

test('result lines read clearly', () => {
  assert.equal(resultLine({ name: 'dexCode', outcome: 'invited', permission: 'pull' }), '📨 **dexCode**: invitation sent (read)');
  assert.equal(resultLine({ name: 'dexClient', outcome: 'already', permission: 'push' }), '✅ **dexClient**: already a collaborator, now write');
  assert.equal(resultLine({ name: 'dex.place', outcome: 'public' }), '🌐 **dex.place**: public, nothing to grant');
  assert.match(resultLine({ name: 'dexCode', outcome: 'personal' }), /^⏭️ \*\*dexCode\*\*: skipped\. personal-account repo/);
  assert.equal(resultLine({ name: 'dex.place', outcome: 'not-collaborator', invitesCancelled: 1 }), "➖ **dex.place**: wasn't a collaborator, 1 pending invitation cancelled");
  assert.equal(resultLine({ name: 'dexCode', outcome: 'removed', invitesCancelled: 1 }), '🔒 **dexCode**: access removed, 1 pending invitation cancelled');
  assert.equal(resultLine({ name: 'dexCode', outcome: 'error', message: '422 nope' }), '❌ **dexCode**: 422 nope');
});

test('mergeGrant keeps repos for the same login and remembers a replaced one', () => {
  const prev = { github: 'Octo', permission: 'push', repos: ['o/a', 'o/c'] };
  const same = mergeGrant(prev, { github: 'octo', permission: 'pull', repos: ['o/a', 'o/b'], at: 't', by: 'owner', requestId: '2' });
  assert.deepEqual(same.repos, ['o/a', 'o/c', 'o/b']);
  assert.equal(same.replaced, undefined);
  const other = mergeGrant(prev, { github: 'someone', permission: 'pull', repos: ['o/a'], at: 't', by: 'owner', requestId: '3' });
  assert.deepEqual(other.repos, ['o/a']);
  assert.equal(other.replaced, 'Octo');
});

const pendingReq = {
  id: '7',
  userId: '42',
  github: 'octocat',
  note: 'reviewing *dexcode* ghp_' + 'b2'.repeat(18),
  status: 'pending',
  at: '2026-09-29T10:00:00Z',
  profile: { createdAt: '2026-09-20T00:00:00Z', publicRepos: 1, name: 'The Octocat' },
};

test('pending request card: who, note (escaped, redacted), approve/deny buttons', () => {
  const now = Date.parse('2026-09-29T12:00:00Z');
  const { embeds, components } = buildRequestCard(pendingReq, { now, grant: { github: 'octocat', permission: 'pull', repos: ['dexnotavailable/dexcode'], at: '2026-09-01T00:00:00Z' } });
  const e = embeds[0].toJSON();
  assert.equal(e.title, '🎟️ github access request #7');
  assert.ok(e.description.includes('<@42>'));
  const note = e.fields.find((f) => f.name === 'note').value;
  assert.ok(note.includes('\\*dexcode\\*'));
  assert.ok(!note.includes('ghp_'));
  assert.ok(e.fields.find((f) => f.name === 'github account').value.includes('new account'));
  assert.ok(e.fields.find((f) => f.name === 'already has').value.includes('read on dexcode'));
  assert.deepEqual(
    components[0].toJSON().components.map((c) => c.custom_id),
    ['access:approve:7:r', 'access:approve:7:w', 'access:deny:7'],
  );
});

test('decided request card has no buttons and lists the results', () => {
  const req = {
    ...pendingReq,
    status: 'approved',
    permission: 'pull',
    decidedAt: '2026-09-29T11:00:00Z',
    decidedBy: 'owner',
    results: [{ name: 'dexCode', outcome: 'invited', permission: 'pull' }],
    followUp: 'badge given · dm sent',
  };
  const { embeds, components } = buildRequestCard(req);
  const e = embeds[0].toJSON();
  assert.deepEqual(components, []);
  assert.ok(e.fields.find((f) => f.name === 'decision').value.startsWith('✅ approved (read) by <@owner>'));
  assert.ok(e.fields.find((f) => f.name === 'repos').value.includes('invitation sent'));
  assert.equal(e.fields.find((f) => f.name === 'follow-up').value, 'badge given · dm sent');
});

test('approval dm explains invitations and /clone', () => {
  const text = approvalDm({ github: 'octocat', results: [{ name: 'dexCode', outcome: 'invited', permission: 'pull' }, { name: 'dex.place', outcome: 'public' }], badge: true });
  assert.ok(text.includes('https://github.com/notifications'));
  assert.ok(text.includes('/clone'));
  assert.ok(text.includes('member of technical staff'));
  const already = approvalDm({ github: 'octocat', results: [{ name: 'dexCode', outcome: 'already', permission: 'pull' }] });
  assert.ok(!already.includes('notifications'));
});

test('blocked notice explains a read approval on personal-account repos', () => {
  const personal = blockedNotice([{ name: 'dexCode', outcome: 'personal' }, { name: 'dexClient', outcome: 'personal' }]);
  assert.match(personal, /^nothing was granted, the request stays pending:/);
  assert.match(personal, /approve write, or move the repos into a github org/);
  const failed = blockedNotice([{ name: 'dexCode', outcome: 'error', message: '403 nope' }]);
  assert.ok(failed.includes('403 nope'));
  assert.ok(!failed.includes('github org'));
});

test('access list and personal status fit their limits', () => {
  const state = { requests: {}, grants: {} };
  for (let i = 0; i < 80; i += 1) {
    state.requests[i] = { id: String(i), userId: `1${i}`, github: `user${i}`, status: 'pending', at: '2026-09-29T00:00:00Z' };
    state.grants[`2${i}`] = { github: `member${i}`, permission: 'pull', repos: ['o/dexcode', 'o/dexclient'], at: '2026-09-01T00:00:00Z' };
  }
  const e = buildAccessList(state).toJSON();
  for (const f of e.fields) assert.ok(f.value.length <= 1024);
  assert.ok(e.fields[0].value.includes('more'));
  assert.equal(e.fields[0].name, 'waiting (80)');

  const grant = { github: 'octocat', permission: 'pull', repos: ['o/dexcode', 'o/dexclient', 'o/x'], at: '2026-09-01T00:00:00Z' };
  const text = buildAccessStatus({ request: { id: '3', github: 'octocat', status: 'approved', permission: 'pull', decidedAt: '2026-09-02T00:00:00Z' }, grant, live: { 'o/dexcode': 'read', 'o/dexclient': 'none', 'o/x': null } });
  assert.ok(text.includes('dexcode: active (read)'));
  assert.ok(text.includes('dexclient: invitation not accepted yet'));
  assert.ok(text.includes("x: couldn't check"));
  assert.match(buildAccessStatus({}), /no request on file/);
});

test('request modal asks for a login (prefilled when valid) and an optional note', () => {
  const json = buildRequestModal('octocat').toJSON();
  assert.equal(json.custom_id, 'access:modal');
  const [github, note] = json.components.map((c) => c.component);
  assert.equal(github.custom_id, 'github');
  assert.equal(github.value, 'octocat');
  assert.equal(note.required, false);
  assert.equal(buildRequestModal('not valid!').toJSON().components[0].component.value, undefined);
});

// ------------------------------------------------------------------ handler flows with fakes

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

function fakeMember(roles = []) {
  const cache = new Set(roles);
  return {
    user: { bot: false },
    roles: {
      cache,
      add: async (ids) => ids.forEach((id) => cache.add(id)),
      remove: async (ids) => ids.forEach((id) => cache.delete(id)),
    },
  };
}

function fakeWorld({ addStatus = 201, addError = null, ownerType = 'Organization', ghUser = { login: 'Octocat', type: 'User', created_at: '2011-01-25T18:44:36Z', public_repos: 8 } } = {}) {
  const roleIds = Object.fromEntries(layout.roles.map((r) => [r.key, `role-${r.key}`]));
  const member = fakeMember([roleIds.waitlist]);
  const world = { member, roleIds, invites: [], dms: [], posts: [], edits: [] };
  const card = { id: 'card-1', edit: async (p) => world.edits.push(p) };
  world.ctx = {
    config: { projects, layout, local: { guildId: 'g', ownerIds: [], githubCollaboratorPermission: 'pull' }, project: (k) => projects.find((p) => p.key === k) ?? null },
    state: fakeState(),
    dryRun: false,
    log: { child: () => ({ info() {}, warn() {}, error() {} }) },
    client: { users: { fetch: async () => ({ send: async (p) => world.dms.push(p.content) }) } },
    github: {
      user: async (login) => (login.toLowerCase() === 'octocat' ? ghUser : null),
      repo: async (repo) => ({ private: repo !== PUBLIC, owner: { login: 'dexnotavailable', type: ownerType } }),
      addCollaborator: async (repo, login, permission) => {
        world.invites.push([repo, login, permission]);
        if (addError) throw addError;
        return { status: addStatus, data: {} };
      },
    },
    guildCtx: {
      ownerId: 'owner',
      channelId: () => null,
      roleId: (k) => roleIds[k] ?? null,
      role: () => null,
      channel: async () => ({ messages: { fetch: async (id) => (id === card.id ? card : Promise.reject(new Error('Unknown Message'))) } }),
      send: async (key, payload) => {
        world.posts.push({ key, payload });
        return card;
      },
    },
  };
  return world;
}

function fakeInteraction(userId, { options = {}, members = {} } = {}) {
  const calls = { reply: [], editReply: [], followUp: [], deferUpdate: 0, deferReply: 0 };
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  return {
    calls,
    gate,
    release: () => release(),
    holdDefer: false,
    user: { id: userId, username: userId, tag: userId, toString: () => `<@${userId}>` },
    guild: { members: { fetch: async (id) => members[id] ?? Promise.reject(new Error('Unknown Member')) } },
    options: {
      getSubcommand: () => options.sub,
      getString: (name) => options[name] ?? null,
      getUser: (name) => options[name],
      getBoolean: (name) => options[name] ?? null,
    },
    async reply(p) {
      calls.reply.push(p);
    },
    async deferReply() {
      calls.deferReply += 1;
    },
    async deferUpdate() {
      calls.deferUpdate += 1;
      if (this.holdDefer) await gate;
    },
    async editReply(p) {
      calls.editReply.push(p);
    },
    async followUp(p) {
      calls.followUp.push(p);
    },
  };
}

test('/access request posts one card, pings only the owner, and updates instead of duplicating', async () => {
  const world = fakeWorld();
  const first = fakeInteraction('42', { options: { sub: 'request', github: '@octocat', note: 'hi' } });
  await access.onCommand(first, world.ctx);
  const state = world.ctx.state.get('access');
  assert.deepEqual(Object.keys(state.requests), ['1']);
  assert.equal(state.requests['1'].github, 'Octocat'); // canonical casing from github
  assert.equal(world.posts.length, 1);
  assert.equal(world.posts[0].key, 'board-meeting');
  assert.deepEqual(world.posts[0].payload.allowedMentions, { users: ['owner'] });
  assert.match(first.calls.editReply[0], /sent to the board: request #1/);

  const again = fakeInteraction('42', { options: { sub: 'request', github: 'octocat' } });
  await access.onCommand(again, world.ctx);
  assert.deepEqual(Object.keys(state.requests), ['1']);
  assert.equal(world.posts.length, 1, 'no second card');
  assert.equal(world.edits.length, 1, 'existing card edited');
  assert.equal(state.requests['1'].note, 'hi', 'note kept when not re-sent');
  assert.match(again.calls.editReply[0], /updated your pending request #1/);
});

test('/access request rejects bad logins before deferring and unknown users after', async () => {
  const world = fakeWorld();
  const bad = fakeInteraction('42', { options: { sub: 'request', github: 'not a login' } });
  await assert.rejects(access.onCommand(bad, world.ctx), { name: 'UserError' });
  assert.equal(bad.calls.deferReply, 0);
  const unknown = fakeInteraction('42', { options: { sub: 'request', github: 'nobody-here' } });
  await assert.rejects(access.onCommand(unknown, world.ctx), /github has no user/);
  assert.equal(Object.keys(world.ctx.state.get('access').requests).length, 0);
});

async function requestAs(world, userId = '42') {
  await access.onCommand(fakeInteraction(userId, { options: { sub: 'request', github: 'octocat' } }), world.ctx);
  return world.ctx.state.get('access').requests['1'];
}

test('approve read invites to private repos, badges the member, dms them, and is idempotent', async () => {
  const world = fakeWorld();
  const req = await requestAs(world);

  const stranger = fakeInteraction('42');
  await access.components.approve(stranger, world.ctx, ['1', 'r']);
  assert.match(stranger.calls.reply[0].content, /board members only/);
  assert.equal(world.invites.length, 0);

  const owner = fakeInteraction('owner', { members: { 42: world.member } });
  await access.components.approve(owner, world.ctx, ['1', 'r']);
  assert.equal(owner.calls.deferUpdate, 1);
  assert.deepEqual(world.invites, [
    ['dexnotavailable/dexcode', 'Octocat', 'pull'],
    ['dexnotavailable/dexclient', 'Octocat', 'pull'],
  ]);
  assert.equal(req.status, 'approved');
  const grant = world.ctx.state.get('access').grants['42'];
  assert.deepEqual(grant.repos, ['dexnotavailable/dexcode', 'dexnotavailable/dexclient']);
  assert.equal(grant.permission, 'pull');
  assert.equal(grant.by, 'owner');
  assert.ok(world.member.roles.cache.has(world.roleIds.staff));
  assert.ok(!world.member.roles.cache.has(world.roleIds.waitlist));
  assert.equal(world.dms.length, 1);
  assert.ok(world.dms[0].includes('https://github.com/notifications'));
  const card = owner.calls.editReply.at(-1);
  assert.deepEqual(card.components, []);

  const again = fakeInteraction('owner', { members: { 42: world.member } });
  await access.components.approve(again, world.ctx, ['1', 'w']);
  assert.match(again.calls.reply[0].content, /already approved/);
  assert.equal(world.invites.length, 2, 'no second round of invites');
});

test('approve read on personal-account repos grants nothing and stays pending; write still works', async () => {
  const world = fakeWorld({ ownerType: 'User' });
  const req = await requestAs(world);
  const owner = fakeInteraction('owner', { members: { 42: world.member } });
  await access.components.approve(owner, world.ctx, ['1', 'r']);
  assert.equal(world.invites.length, 0, 'no invite that would silently be write');
  assert.equal(req.status, 'pending');
  assert.deepEqual(req.lastAttempt.results.map((r) => r.outcome), ['personal', 'personal', 'public']);
  assert.equal(owner.calls.editReply.at(-1).components.length, 1, 'buttons stay so write can be picked');
  assert.match(owner.calls.followUp[0].content, /approve write, or move the repos into a github org/);
  assert.equal(world.ctx.state.get('access').grants['42'], undefined);
  assert.ok(!world.member.roles.cache.has(world.roleIds.staff));
  assert.equal(world.dms.length, 0);

  const write = fakeInteraction('owner', { members: { 42: world.member } });
  await access.components.approve(write, world.ctx, ['1', 'w']);
  assert.deepEqual(world.invites.map((i) => i[2]), ['push', 'push', 'push']);
  assert.equal(req.status, 'approved');
  assert.equal(req.lastAttempt, undefined);
  assert.equal(world.ctx.state.get('access').grants['42'].permission, 'push');
});

test('/access status reads a not-yet-accepted invite as pending, not active', async () => {
  const world = fakeWorld();
  await requestAs(world);
  await access.components.approve(fakeInteraction('owner', { members: { 42: world.member } }), world.ctx, ['1', 'r']);
  // what github returns for a non-collaborator on a private repo, and for an accepted invite
  world.ctx.github.collaboratorPermission = async (repo) =>
    repo.endsWith('/dexcode') ? { permission: 'none', role_name: '' } : { permission: 'read', role_name: 'read' };
  const me = fakeInteraction('42', { options: { sub: 'status' } });
  await access.onCommand(me, world.ctx);
  const text = me.calls.editReply.at(-1);
  assert.ok(text.includes('dexcode: invitation not accepted yet'));
  assert.ok(text.includes('dexclient: active (read)'));
});

test('a double click while an approval runs is turned away', async () => {
  const world = fakeWorld();
  await requestAs(world);
  const first = fakeInteraction('owner', { members: { 42: world.member } });
  first.holdDefer = true;
  const running = access.components.approve(first, world.ctx, ['1', 'w']);
  const second = fakeInteraction('owner', { members: { 42: world.member } });
  await access.components.approve(second, world.ctx, ['1', 'w']);
  assert.match(second.calls.reply[0].content, /already being handled/);
  first.release();
  await running;
  assert.equal(world.invites.length, 3);
  assert.equal(world.ctx.state.get('access').grants['42'].permission, 'push');
});

test('an approval where every repo fails stays pending with the errors on the card', async () => {
  const error = Object.assign(new Error('GitHub PUT: Must have admin rights'), { status: 403, body: { message: 'Must have admin rights to Repository.' } });
  const world = fakeWorld({ addError: error });
  const req = await requestAs(world);
  const owner = fakeInteraction('owner', { members: { 42: world.member } });
  await access.components.approve(owner, world.ctx, ['1', 'r']);
  assert.equal(req.status, 'pending');
  assert.equal(req.lastAttempt.results.length, 3);
  assert.equal(owner.calls.editReply.at(-1).components.length, 1, 'buttons stay for a retry');
  assert.match(owner.calls.followUp[0].content, /nothing was granted/);
  assert.equal(world.ctx.state.get('access').grants['42'], undefined);
  assert.ok(!world.member.roles.cache.has(world.roleIds.staff));
});

test('deny marks the request, dms politely and starts the cooldown', async () => {
  const world = fakeWorld();
  const req = await requestAs(world);
  const owner = fakeInteraction('owner');
  await access.components.deny(owner, world.ctx, ['1']);
  assert.equal(req.status, 'denied');
  assert.equal(req.decidedBy, 'owner');
  assert.match(world.dms[0], /declined for now/);
  assert.deepEqual(owner.calls.editReply.at(-1).components, []);
  const retry = fakeInteraction('42', { options: { sub: 'request', github: 'octocat' } });
  await assert.rejects(access.onCommand(retry, world.ctx), /said no/);
  const twice = fakeInteraction('owner');
  await access.components.deny(twice, world.ctx, ['1']);
  assert.match(twice.calls.reply[0].content, /already denied/);
});

test('/access list and /access revoke are owner-only', async () => {
  const world = fakeWorld();
  for (const sub of ['list', 'revoke']) {
    const i = fakeInteraction('42', { options: { sub, member: { id: '43', bot: false } } });
    await access.onCommand(i, world.ctx);
    assert.match(i.calls.reply[0].content, /board members only/, sub);
    assert.equal(i.calls.deferReply, 0);
  }
});

test('/access revoke removes collaborators, cancels invitations and can take the badge', async () => {
  const world = fakeWorld();
  await requestAs(world);
  await access.components.approve(fakeInteraction('owner', { members: { 42: world.member } }), world.ctx, ['1', 'r']);
  const removed = [];
  const cancelled = [];
  const checked = [];
  Object.assign(world.ctx.github, {
    invitations: async (repo) => (repo.endsWith('/dexcode') ? [{ id: 9, invitee: { login: 'octocat' } }, { id: 10, invitee: { login: 'someone' } }] : []),
    deleteInvitation: async (repo, id) => cancelled.push([repo, id]),
    // the collaborator check: dexclient accepted its invite, dex.place was public and never granted
    request: async (method, path, opts) => {
      checked.push([method, path, opts.allow]);
      return { status: path.includes('/dexclient/') ? 204 : 404 };
    },
    removeCollaborator: async (repo, login) => {
      removed.push([repo, login]);
      return { status: 204 };
    },
  });
  const owner = fakeInteraction('owner', { options: { sub: 'revoke', member: { id: '42', bot: false, toString: () => '<@42>' }, keep_badge: false }, members: { 42: world.member } });
  await access.onCommand(owner, world.ctx);
  assert.equal(owner.calls.deferReply, 1);
  assert.deepEqual(checked[0], ['GET', '/repos/dexnotavailable/dexcode/collaborators/Octocat', [404]]);
  assert.deepEqual(removed, [['dexnotavailable/dexclient', 'Octocat']], 'only actual collaborators are removed');
  assert.deepEqual(cancelled, [['dexnotavailable/dexcode', 9]]);
  const state = world.ctx.state.get('access');
  assert.equal(state.grants['42'], undefined);
  assert.equal(state.requests['1'].status, 'revoked');
  assert.ok(!world.member.roles.cache.has(world.roleIds.staff));
  assert.ok(world.member.roles.cache.has(world.roleIds.waitlist));
  const reply = owner.calls.editReply.at(-1);
  assert.ok(reply.includes("dexCode**: wasn't a collaborator, 1 pending invitation cancelled"));
  assert.ok(reply.includes('dexClient**: access removed'));
  assert.ok(reply.includes("dex.place**: wasn't a collaborator"));
  assert.ok(world.posts.some((p) => p.key === 'board-meeting' && p.payload.content.startsWith('🔒')));
});
