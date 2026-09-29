import { EventEmitter } from 'node:events';
import test from 'node:test';
import assert from 'node:assert/strict';
import { RateLimitError, GitHubError } from '../src/core/github.mjs';
import feed, {
  buildCatchUpMessage,
  buildFilesReply,
  buildPushMessage,
  deletedLine,
  diffBranches,
  knownTwin,
  matchesAny,
  packLines,
  pairRenames,
  parseRangeArgs,
  planPosts,
  pollAll,
  pollProject,
  prunePushlog,
  pushlogEntry,
  threadName,
} from '../src/modules/feed.mjs';

const PROJECT = {
  key: 'dexclient',
  name: 'dexClient',
  repo: 'dexnotavailable/dexclient',
  emoji: '📦',
  color: '#22c55e',
  feedChannel: 'ships-dexclient',
};

// distinct 7- and 12-char prefixes, like real shas
const sha = (i) => `${(i + 1).toString(16).padStart(7, '0')}${'a'.repeat(33)}`;
const branch = (name, i) => ({ name, commit: { sha: sha(i) } });

function commit(i, { subject, body = '', login = 'dex', minute = i } = {}) {
  const date = new Date(Date.UTC(2026, 8, 1, 0, minute)).toISOString();
  return {
    sha: sha(i),
    commit: {
      message: (subject ?? `commit number ${i}`) + (body ? `\n\n${body}` : ''),
      author: { name: login, date },
      committer: { name: login, date },
    },
    author: { login, avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4' },
  };
}

function file(i, extra = {}) {
  return { filename: `src/dir/file-${i}.mjs`, status: 'modified', additions: i, deletions: 1, changes: i + 1, ...extra };
}

function push(fields = {}) {
  const commits = fields.commits ?? [commit(1)];
  return {
    kind: 'push',
    branch: 'main',
    base: sha(0),
    head: commits.at(-1).sha,
    commits,
    total: commits.length,
    files: [file(1)],
    isDefault: true,
    date: commits.at(-1).commit?.committer?.date ?? null,
    ...fields,
  };
}

// ------------------------------------------------------------------ limit checks

function assertEmbed(e) {
  const json = typeof e.toJSON === 'function' ? e.toJSON() : e;
  let total = 0;
  const count = (text, max, what) => {
    const s = text ?? '';
    assert.ok(s.length <= max, `${what} is ${s.length} chars (max ${max})`);
    total += s.length;
  };
  count(json.title, 256, 'title');
  count(json.description, 4096, 'description');
  count(json.footer?.text, 2048, 'footer');
  count(json.author?.name, 256, 'author');
  for (const f of json.fields ?? []) {
    assert.ok(f.value.length > 0, 'empty field value');
    count(f.name, 256, 'field name');
    count(f.value, 1024, 'field value');
  }
  assert.ok(total <= 6000, `embed total is ${total} chars`);
  return json;
}

function assertPayload(payload) {
  if (payload.content) assert.ok(payload.content.length <= 2000, `content is ${payload.content.length} chars`);
  const embeds = (payload.embeds ?? []).map(assertEmbed);
  const rows = (payload.components ?? []).map((r) => r.toJSON());
  for (const row of rows) {
    assert.ok(row.components.length <= 5);
    for (const c of row.components) {
      if (c.custom_id) assert.ok(c.custom_id.length <= 100, `customId ${c.custom_id.length} chars`);
      if (c.url) assert.ok(c.url.length <= 512);
      assert.ok(c.label.length <= 80);
    }
  }
  return { embeds, rows };
}

// ------------------------------------------------------------------ diffBranches

test('diffBranches finds created, updated and deleted branches', () => {
  const old = { main: sha(1), 'feat/a': sha(2), gone: sha(3) };
  const items = [branch('main', 1), branch('feat/a', 9), branch('feat/new', 4)];
  const diff = diffBranches(old, items);
  assert.deepEqual(diff.created, [{ name: 'feat/new', sha: sha(4) }]);
  assert.deepEqual(diff.updated, [{ name: 'feat/a', from: sha(2), to: sha(9) }]);
  assert.deepEqual(diff.deleted, ['gone']);
});

test('diffBranches honours * ignore patterns on every side', () => {
  const patterns = ['dependabot/*', 'wip-*', 'exact'];
  assert.ok(matchesAny('dependabot/npm/discord.js-14', patterns));
  assert.ok(matchesAny('wip-thing', patterns));
  assert.ok(matchesAny('exact', patterns));
  assert.ok(!matchesAny('exactly', patterns));
  assert.ok(!matchesAny('feat/dependabot', patterns));
  assert.ok(matchesAny('a.b', ['a.b']) && !matchesAny('axb', ['a.b']), 'dots are literal');

  const old = { main: sha(1), 'wip-old': sha(2), exact: sha(3) };
  const items = [branch('main', 1), branch('dependabot/npm/x', 5), branch('wip-new', 6)];
  const diff = diffBranches(old, items, patterns);
  assert.deepEqual(diff, { created: [], updated: [], deleted: [] });
});

test('diffBranches ignores names that cannot live in a plain-object map', () => {
  const diff = diffBranches({ main: sha(1) }, [branch('main', 1), branch('__proto__', 2), branch('constructor', 3)]);
  assert.deepEqual(diff.created, [{ name: 'constructor', sha: sha(3) }]);
});

test('pairRenames and knownTwin avoid reposting known commits', () => {
  const old = { main: sha(1), 'feat/old-name': sha(2), dead: sha(3) };
  const items = [branch('main', 1), branch('feat/new-name', 2), branch('copy-of-main', 1)];
  const diff = diffBranches(old, items);
  const { renamed, created, deleted } = pairRenames(diff, old);
  assert.deepEqual(renamed, [{ from: 'feat/old-name', to: 'feat/new-name', sha: sha(2) }]);
  assert.deepEqual(created, [{ name: 'copy-of-main', sha: sha(1) }]);
  assert.deepEqual(deleted, ['dead']);

  const current = new Map(items.map((b) => [b.name, b.commit.sha]));
  assert.equal(knownTwin(sha(1), 'copy-of-main', old, current, 'main'), 'main');
  assert.equal(knownTwin(sha(7), 'x', old, current, 'main'), null);
  // a branch that moved this cycle is not a twin: its new commits were never posted
  const moved = new Map([...current, ['main', sha(8)]]);
  assert.equal(knownTwin(sha(1), 'copy-of-main', old, moved, 'main'), null);
});

// ------------------------------------------------------------------ ordering / cap

test('planPosts orders oldest first and folds the oldest overflow into catch-up', () => {
  const at = (m) => new Date(Date.UTC(2026, 8, 1, 0, m)).toISOString();
  const pushes = [
    { branch: 'c', date: at(30) },
    { branch: 'a', date: at(10) },
    { branch: 'e', date: at(50) },
    { branch: 'b', date: at(20) },
    { branch: 'd', date: at(40) },
  ];
  const all = planPosts(pushes, 12);
  assert.deepEqual(all.catchUp, []);
  assert.deepEqual(all.full.map((p) => p.branch), ['a', 'b', 'c', 'd', 'e']);

  const capped = planPosts(pushes, 2);
  assert.deepEqual(capped.catchUp.map((p) => p.branch), ['a', 'b', 'c']);
  assert.deepEqual(capped.full.map((p) => p.branch), ['d', 'e']);

  const none = planPosts(pushes, 0);
  assert.equal(none.full.length, 0);
  assert.equal(none.catchUp.length, 5);

  // undated pushes sort first and never break the sort
  assert.deepEqual(planPosts([{ branch: 'x', date: at(5) }, { branch: 'y', date: null }], 5).full.map((p) => p.branch), ['y', 'x']);
});

test('buildCatchUpMessage stays inside the content limit', () => {
  const pushes = Array.from({ length: 200 }, (_, i) =>
    push({ branch: `feature/${'x'.repeat(140)}-${i}`, kind: i % 3 === 0 ? 'force' : i % 3 === 1 ? 'created' : 'push', dropped: 2 }),
  );
  const msg = buildCatchUpMessage(PROJECT, pushes);
  assertPayload(msg);
  assert.match(msg.content, /^📚 catch-up · 200 older pushes on dexClient/);
  assert.match(msg.content, /…and \d+ more$/);
  assert.match(msg.content, /force-push, 2 dropped/);
});

// ------------------------------------------------------------------ push messages

test('buildPushMessage: one commit with a body', () => {
  const body = `explains why.\n\nCo-Authored-By: someone <a@b.c>\ntoken = ghp_${'A1'.repeat(20)}\n${'long body line. '.repeat(80)}`;
  const c = commit(1, { subject: 'fix: the launcher', body });
  const p = push({ commits: [c], files: [file(1), file(2, { status: 'added' })] });
  const { embeds, rows } = assertPayload(buildPushMessage(PROJECT, p, { maxCommits: 10 }));
  const e = embeds[0];
  assert.equal(e.title, '🚀 1 new commit → main');
  assert.equal(e.url, `https://github.com/${PROJECT.repo}/commit/${c.sha}`);
  assert.equal(e.author.name, 'dex');
  assert.equal(e.author.icon_url, c.author.avatar_url);
  assert.equal(e.footer.text, 'dexClient · main');
  assert.equal(e.color, 0x22c55e);
  assert.equal(e.timestamp, c.commit.committer.date);
  assert.match(e.description, /fix: the launcher/);
  assert.match(e.description, /\n> explains why\./);
  assert.ok(!/Co-Authored-By/i.test(e.description), 'trailers dropped');
  assert.ok(!e.description.includes('ghp_'), 'secrets redacted');
  assert.equal(e.fields.length, 1);
  assert.match(e.fields[0].name, /^2 files · \+3 −2$/);

  const ids = rows[0].components.map((b) => b.custom_id ?? b.url);
  assert.deepEqual(ids, [
    `feed:diff:dexclient:${sha(0).slice(0, 12)}:${c.sha.slice(0, 12)}`,
    `feed:files:dexclient:${sha(0).slice(0, 12)}:${c.sha.slice(0, 12)}`,
    'feed:thread',
    e.url,
  ]);
});

test('buildPushMessage: 50 commits with 300-char subjects', () => {
  const commits = Array.from({ length: 50 }, (_, i) => commit(i + 1, { subject: `${'s'.repeat(299)}${i}`, login: i % 2 ? 'friend' : 'dex' }));
  const files = Array.from({ length: 40 }, (_, i) => file(i, { filename: `${'deep/'.repeat(40)}file-${i}.mjs` }));
  const p = push({ branch: 'feat/x', isDefault: false, commits, total: 50, files });
  const { embeds } = assertPayload(buildPushMessage(PROJECT, p, { maxCommits: 10 }));
  const e = embeds[0];
  assert.equal(e.title, '50 new commits → feat/x');
  assert.equal(e.url, `https://github.com/${PROJECT.repo}/compare/${sha(0)}...${commits.at(-1).sha}`);
  assert.equal(e.author.name, 'friend', 'newest commit author');
  const lines = e.description.split('\n');
  assert.equal(lines.filter((l) => l.startsWith('[`')).length, 10);
  assert.ok(lines[0].includes(commits.at(-1).sha.slice(0, 7)), 'newest first');
  assert.equal(lines.at(-1), '…and 40 more');
  assert.ok(!e.description.includes('\n> '), 'no body quote for multi-commit pushes');
  assert.match(e.fields[0].name, /^40 files/);
  assert.match(e.fields[0].value, /…and \d+ more$/);
});

test('buildPushMessage: "and N more" counts total_commits beyond the commits returned', () => {
  const commits = Array.from({ length: 10 }, (_, i) => commit(i + 1));
  const p = push({ commits, total: 237, files: Array.from({ length: 300 }, (_, i) => file(i)) });
  const { embeds } = assertPayload(buildPushMessage(PROJECT, p, { maxCommits: 10 }));
  assert.equal(embeds[0].title, '🚀 237 new commits → main');
  assert.match(embeds[0].description, /…and 227 more$/);
  assert.match(embeds[0].fields[0].name, /^300\+ files/);
});

test('buildPushMessage: 150-char branch names respect every limit', () => {
  const name = `feature/${'very-long-branch-name-'.repeat(7)}`.slice(0, 150);
  assert.equal(name.length, 150);
  const kinds = [
    { kind: 'push' },
    { kind: 'force', dropped: 3, from: sha(40) },
    { kind: 'created', def: 'main' },
    { kind: 'created', base: null, unrelatedTo: 'main' },
    { kind: 'rewritten', base: null, from: sha(41), total: null },
  ];
  for (const k of kinds) {
    const p = push({ branch: name, isDefault: false, commits: [commit(1), commit(2)], ...k });
    const { embeds, rows } = assertPayload(buildPushMessage(PROJECT, p));
    assert.ok(embeds[0].footer.text.startsWith('dexClient · feature/'));
    assert.equal(rows[0].components.length, 4);
    const name100 = threadName({ embeds, components: rows });
    assert.ok(name100.length <= 100, `thread name ${name100.length}`);
  }
});

test('buildPushMessage: force-push, new branch and rewritten variants', () => {
  const commits = [commit(1), commit(2)];
  const force = assertPayload(buildPushMessage(PROJECT, push({ kind: 'force', dropped: 3, from: sha(40), commits, total: 2 }))).embeds[0];
  assert.equal(force.title, '⚠️ 2 new commits → main (force-push, 3 dropped)');
  assert.match(force.description, new RegExp(`^previous head \`${sha(40).slice(0, 7)}\``));

  const created = assertPayload(
    buildPushMessage(PROJECT, push({ kind: 'created', branch: 'feat/y', isDefault: false, def: 'main', commits, total: 2 })),
  ).embeds[0];
  assert.equal(created.title, '🌱 2 new commits → feat/y (new branch)');
  assert.match(created.description, /^branched off \*\*main\*\* at `0000001`/);

  const rewritten = buildPushMessage(PROJECT, push({ kind: 'rewritten', base: null, from: sha(41), commits, total: null }));
  const { embeds, rows } = assertPayload(rewritten);
  assert.equal(embeds[0].title, '⚠️ history rewritten → main');
  assert.equal(embeds[0].url, `https://github.com/${PROJECT.repo}/commit/${commits[1].sha}`);
  assert.equal(rows[0].components[0].custom_id, `feed:diff:dexclient:-:${commits[1].sha.slice(0, 12)}`);
  assert.match(embeds[0].description, /latest 2 commits/);

  // a long title keeps its force-push suffix
  const long = assertPayload(buildPushMessage(PROJECT, push({ kind: 'force', dropped: 9, branch: 'b'.repeat(250), commits }))).embeds[0];
  assert.ok(long.title.endsWith('(force-push, 9 dropped)'));
  assert.ok(long.title.length <= 256);
});

test('buildPushMessage survives a push without files or commit metadata', () => {
  const bare = { sha: sha(5), commit: { message: '' } };
  const { embeds } = assertPayload(buildPushMessage(PROJECT, push({ commits: [bare], files: [] })));
  assert.equal(embeds[0].fields, undefined);
  assert.equal(embeds[0].timestamp, undefined);
  assert.equal(embeds[0].author.name, 'someone');
});

// ------------------------------------------------------------------ compact lines, files, threads

test('deletedLine and packLines stay inside Discord limits', () => {
  const names = Array.from({ length: 500 }, (_, i) => `feature/branch-number-${i}`);
  const line = deletedLine(names);
  assert.ok(line.length <= 1800);
  assert.match(line, /^🗑️ deleted: feature\/branch-number-0, /);
  assert.match(line, /…and \d+ more$/);
  assert.equal(deletedLine(['a', 'b_c']), '🗑️ deleted: a, b\\_c');

  const groups = packLines(Array.from({ length: 100 }, (_, i) => ({ text: `line ${i} ${'x'.repeat(100)}`, apply: i })));
  assert.ok(groups.length > 1);
  assert.equal(groups.flat().length, 100, 'nothing dropped');
  for (const g of groups) assert.ok(g.map((l) => l.text).join('\n').length <= 1900);
  assert.equal(packLines([{ text: 'y'.repeat(5000) }])[0][0].text.length, 1900);
});

test('buildFilesReply lists everything and attaches overflow', () => {
  const small = assertPayload(buildFilesReply(PROJECT, { base: sha(1), head: sha(2) }, [file(1), file(2)]));
  assert.match(small.embeds[0].title, /^2 files · /);
  assert.equal(buildFilesReply(PROJECT, { base: null, head: sha(2) }, [file(1)]).files.length, 0);

  const many = Array.from({ length: 300 }, (_, i) => file(i, { filename: `packages/some/long/path/component-${i}.tsx` }));
  const big = buildFilesReply(PROJECT, { base: null, head: sha(2) }, many);
  const { embeds } = assertPayload(big);
  assert.equal(big.files.length, 1);
  assert.match(embeds[0].title, /^300\+ files/);
  assert.match(embeds[0].description, /in the attached list$/);
  assert.match(big.files[0].name, /^dexclient-0000003-files\.txt$/);
  assert.equal(big.files[0].attachment.toString('utf8').trim().split('\n').length, 300);

  assert.equal(buildFilesReply(PROJECT, { base: null, head: sha(2) }, []).content, 'no file changes in that range.');
});

test('threadName reads branch from the footer and sha from the diff button', () => {
  const p = push({ branch: 'feat/thread', isDefault: false, commits: [commit(3)] });
  const { embeds, rows } = assertPayload(buildPushMessage(PROJECT, p));
  assert.equal(threadName({ embeds, components: rows }), `feat/thread · ${sha(3).slice(0, 7)}`);
  // discord.js message objects expose customId instead of custom_id
  const live = { embeds, components: [{ components: rows[0].components.map((c) => ({ customId: c.custom_id })) }] };
  assert.equal(threadName(live), `feat/thread · ${sha(3).slice(0, 7)}`);
  assert.equal(threadName({ embeds: [], components: [] }), 'push');
});

test('parseRangeArgs accepts button args and rejects junk', () => {
  assert.deepEqual(parseRangeArgs(['dexcode', '-', 'abcdef123456']), { key: 'dexcode', base: null, head: 'abcdef123456' });
  assert.deepEqual(parseRangeArgs(['dexcode', 'abcdef1', 'abcdef123456']), { key: 'dexcode', base: 'abcdef1', head: 'abcdef123456' });
  assert.throws(() => parseRangeArgs(['dexcode', '-', 'main']), { name: 'UserError' });
  assert.throws(() => parseRangeArgs(['dexcode', '../x', 'abcdef1']), { name: 'UserError' });
  assert.throws(() => parseRangeArgs([]), { name: 'UserError' });
});

// ------------------------------------------------------------------ pushlog

test('prunePushlog keeps the last 8 days', () => {
  const now = Date.UTC(2026, 8, 29);
  const day = 86_400_000;
  const entries = [
    { at: new Date(now - 9 * day).toISOString(), branch: 'old' },
    { at: new Date(now - 8 * day + 1000).toISOString(), branch: 'edge' },
    { at: new Date(now - day).toISOString(), branch: 'recent' },
    { at: 'not a date', branch: 'junk' },
  ];
  assert.deepEqual(prunePushlog(entries, now).map((e) => e.branch), ['edge', 'recent']);
  assert.deepEqual(prunePushlog(undefined, now), []);
  const entry = pushlogEntry('dexcode', { branch: 'main', commits: 2, authors: ['dex'], additions: 5, deletions: 1, forced: 0 }, 'x');
  assert.deepEqual(entry, { project: 'dexcode', branch: 'main', commits: 2, authors: ['dex'], additions: 5, deletions: 1, at: 'x', forced: false, created: false });
});

// ------------------------------------------------------------------ poller with fakes (no network)

function fakeCtx({ projects = [PROJECT], branches, compares = {}, commitsFor = {}, send, ignore = [], dryRun = false, missing = new Set() }) {
  const data = {};
  const sent = [];
  const warns = [];
  const events = [];
  const bus = new EventEmitter();
  bus.on('push', (e) => events.push(e));
  const log = { warn: (...a) => warns.push(a.join(' ')), info() {}, error() {}, debug() {}, child: () => log };
  const github = {
    branches: async (repo) => {
      const v = branches[repo];
      if (v instanceof Error) throw v;
      return { items: v, changed: true };
    },
    repo: async () => ({ default_branch: 'main' }),
    compare: async (repo, base, head) => {
      const v = compares[`${base}...${head}`];
      if (v instanceof Error) throw v;
      if (!v) throw new GitHubError('Not Found', { status: 404 });
      return v;
    },
    commits: async (repo, { sha: s }) => commitsFor[s] ?? [],
  };
  return {
    sent,
    warns,
    events,
    data,
    log,
    dryRun,
    missing,
    config: {
      projects,
      project: (k) => projects.find((p) => p.key === k) ?? null,
      feed: { maxCommitsPerPost: 10, maxPushesPerCycle: 12, ignoreBranches: ignore },
      poll: { commitsSeconds: 60 },
      local: { ownerIds: [] },
    },
    state: {
      get(ns, defaults = {}) {
        data[ns] ??= {};
        for (const [k, v] of Object.entries(defaults)) if (!(k in data[ns])) data[ns][k] = structuredClone(v);
        return data[ns];
      },
      save() {},
    },
    github,
    guildCtx: {
      ownerId: 'owner-id',
      roleId: (key) => (key === 'staff' ? 'staff-role' : null),
      role: (key) => (key === 'staff' ? { name: 'member of technical staff' } : null),
      async channel(key) {
        return missing.has(key) ? null : { id: key };
      },
      async send(key, payload) {
        if (send) return send(key, payload);
        if (missing.has(key)) return null;
        sent.push({ key, payload });
        return {};
      },
    },
    bus,
  };
}

const kinds = (sent) => sent.map((s) => s.payload.embeds?.[0]?.toJSON().title ?? s.payload.content);

test('first poll seeds silently, then a push is posted exactly once', async () => {
  const repo = PROJECT.repo;
  const ctx = fakeCtx({ branches: { [repo]: [branch('main', 1), branch('feat/a', 2), branch('dependabot/x', 3)] }, ignore: ['dependabot/*'] });
  await pollProject(ctx, PROJECT, ctx.log);
  assert.equal(ctx.sent.length, 1);
  assert.equal(ctx.sent[0].payload.content, `👀 now watching **dexClient** · 2 branches · default \`main\` at \`${sha(1).slice(0, 7)}\``);
  const head = ctx.data.heads.dexclient;
  assert.deepEqual(head.branches, { main: sha(1), 'feat/a': sha(2) });
  assert.deepEqual(head.pushedAt, {});
  assert.ok(head.seededAt && head.lastCheckedAt);

  // nothing changed: nothing posted
  await pollProject(ctx, PROJECT, ctx.log);
  assert.equal(ctx.sent.length, 1);

  const c = [commit(7, { minute: 1 }), commit(8, { minute: 2 })];
  ctx.github.compare = async (r, base, h) => {
    assert.equal(`${base}...${h}`, `${sha(1)}...${sha(8)}`);
    return { status: 'ahead', ahead_by: 2, behind_by: 0, total_commits: 2, commits: c, files: [file(1)], merge_base_commit: { sha: sha(1) } };
  };
  const items = [branch('main', 8), branch('feat/a', 2)];
  ctx.github.branches = async () => ({ items, changed: true });
  await pollProject(ctx, PROJECT, ctx.log);
  assert.deepEqual(kinds(ctx.sent).slice(1), ['🚀 2 new commits → main']);
  assert.equal(head.branches.main, sha(8));
  assert.ok(head.pushedAt.main);
  assert.equal(ctx.data.pushlog.entries.length, 1);
  assert.deepEqual(ctx.data.pushlog.entries[0].authors, ['dex']);
  assert.deepEqual(ctx.events, [{ project: 'dexclient', branch: 'main', base: sha(1), head: sha(8), commits: 2, forced: false, created: false }]);

  // same branch list again (ETag hit): no duplicate
  ctx.github.branches = async () => ({ items, changed: false });
  await pollProject(ctx, PROJECT, ctx.log);
  assert.equal(ctx.sent.length, 2);
});

test('a failed post leaves the branch unadvanced and is retried; a dry-run null send still advances', async () => {
  const project = { ...PROJECT, key: 'retrytest' };
  const repo = project.repo;
  let fail = true;
  const sent = [];
  const ctx = fakeCtx({
    projects: [project],
    branches: { [repo]: [branch('main', 1)] },
    dryRun: true,
    send: async (key, payload) => {
      if (fail && payload.embeds) throw new Error('Missing Permissions');
      sent.push(payload);
      return null;
    },
  });
  await pollProject(ctx, project, ctx.log); // seed
  ctx.github.branches = async () => ({ items: [branch('main', 2)], changed: true });
  ctx.github.compare = async () => ({ status: 'ahead', ahead_by: 1, total_commits: 1, commits: [commit(2)], files: [] });
  await pollProject(ctx, project, ctx.log);
  assert.equal(ctx.data.heads.retrytest.branches.main, sha(1), 'not advanced after a failed post');
  assert.equal(ctx.warns.length, 1);
  assert.equal(ctx.events.length, 0);

  fail = false;
  ctx.github.branches = async () => ({ items: [branch('main', 2)], changed: false }); // cached list, pending retry
  await pollProject(ctx, project, ctx.log);
  assert.equal(ctx.data.heads.retrytest.branches.main, sha(2), 'advanced after a dry-run send returned null');
  assert.equal(sent.filter((p) => p.embeds).length, 1);
  await pollProject(ctx, project, ctx.log);
  assert.equal(sent.filter((p) => p.embeds).length, 1, 'no duplicate');
});

test('a missing feed channel holds pushes until it is back, without GitHub calls', async () => {
  const project = { ...PROJECT, key: 'channeltest' };
  const ctx = fakeCtx({ projects: [project], branches: { [project.repo]: [branch('main', 1)] } });
  await pollProject(ctx, project, ctx.log); // seed

  // the channel vanishes (stale layout id during a reorg): no GitHub work, nothing advances
  ctx.missing.add(project.feedChannel);
  let calls = 0;
  ctx.github.branches = async () => {
    calls += 1;
    return { items: [branch('main', 2)], changed: true };
  };
  ctx.github.compare = async () => {
    calls += 1;
    return { status: 'ahead', ahead_by: 1, total_commits: 1, commits: [commit(2)], files: [] };
  };
  await pollProject(ctx, project, ctx.log);
  await pollProject(ctx, project, ctx.log);
  assert.equal(calls, 0);
  assert.equal(ctx.data.heads.channeltest.branches.main, sha(1));
  assert.equal(ctx.warns.filter((w) => w.includes('is missing')).length, 1, 'warned once per hour');

  // it disappears between the check and the post: still held
  ctx.guildCtx.channel = async () => ({ id: project.feedChannel });
  await pollProject(ctx, project, ctx.log);
  assert.equal(ctx.data.heads.channeltest.branches.main, sha(1), 'a null send outside dry-run is not a delivery');
  assert.equal(ctx.events.length, 0);

  // back again: the held push posts once
  ctx.missing.clear();
  await pollProject(ctx, project, ctx.log);
  assert.equal(ctx.data.heads.channeltest.branches.main, sha(2));
  assert.deepEqual(kinds(ctx.sent).slice(1), ['🚀 1 new commit → main']);
});

test('a project whose channel is missing is not seeded until it exists', async () => {
  const project = { ...PROJECT, key: 'noseedtest' };
  const ctx = fakeCtx({ projects: [project], branches: { [project.repo]: [branch('main', 1)] }, missing: new Set([project.feedChannel]) });
  await pollProject(ctx, project, ctx.log);
  assert.equal(ctx.data.heads?.noseedtest, undefined);
  ctx.missing.clear();
  await pollProject(ctx, project, ctx.log);
  assert.ok(ctx.data.heads.noseedtest);
  assert.match(ctx.sent[0].payload.content, /^👀 now watching/);
});

test('force-push, reset, rewritten, new branch, rename and delete in one cycle', async () => {
  const repo = PROJECT.repo;
  const ctx = fakeCtx({
    branches: {
      [repo]: [branch('main', 1), branch('forced', 2), branch('reset', 3), branch('rewritten', 4), branch('old-name', 5), branch('dead', 6)],
    },
  });
  await pollProject(ctx, PROJECT, ctx.log);
  ctx.sent.length = 0;

  ctx.github.branches = async () => ({
    items: [
      branch('main', 1),
      branch('forced', 20),
      branch('reset', 30),
      branch('rewritten', 40),
      branch('new-name', 5),
      branch('fresh', 50),
      branch('copy', 1),
    ],
    changed: true,
  });
  const compares = {
    [`${sha(2)}...${sha(20)}`]: { status: 'diverged', ahead_by: 1, behind_by: 4, total_commits: 1, commits: [commit(20)], files: [], merge_base_commit: { sha: sha(0) } },
    [`${sha(3)}...${sha(30)}`]: { status: 'behind', ahead_by: 0, behind_by: 2, total_commits: 0, commits: [], files: [] },
    [`${sha(1)}...${sha(50)}`]: { status: 'ahead', ahead_by: 1, behind_by: 0, total_commits: 1, commits: [commit(50)], files: [], merge_base_commit: { sha: sha(1) } },
  };
  ctx.github.compare = async (r, base, head) => {
    const v = compares[`${base}...${head}`];
    if (!v) throw new GitHubError('No common ancestor', { status: 404 });
    return v;
  };
  ctx.github.commits = async (r, { sha: s, perPage }) => {
    assert.equal(s, sha(40));
    assert.equal(perPage, 5);
    return [commit(40), commit(39)];
  };
  await pollProject(ctx, PROJECT, ctx.log);

  const posted = kinds(ctx.sent);
  assert.ok(posted.includes('⚠️ 1 new commit → forced (force-push, 4 dropped)'));
  assert.ok(posted.includes('⚠️ history rewritten → rewritten'));
  assert.ok(posted.includes('🌱 1 new commit → fresh (new branch)'));
  const compact = posted.at(-1);
  assert.match(compact, /🔀 \*\*old-name\*\* → \*\*new-name\*\*/);
  assert.match(compact, /⏪ \*\*reset\*\* was reset to .* \(2 commits dropped\)/);
  assert.match(compact, /🌱 new branch \*\*copy\*\* at .* \(same as main\)/);
  assert.match(compact, /🗑️ deleted: dead$/);

  assert.deepEqual(ctx.data.heads.dexclient.branches, {
    main: sha(1),
    forced: sha(20),
    reset: sha(30),
    rewritten: sha(40),
    'new-name': sha(5),
    fresh: sha(50),
    copy: sha(1),
  });
  const byBranch = Object.fromEntries(ctx.events.map((e) => [e.branch, e]));
  assert.equal(byBranch.forced.base, sha(0));
  assert.equal(byBranch.forced.forced, true);
  assert.equal(byBranch.fresh.created, true);
  assert.equal(byBranch.reset.commits, 0);
  assert.equal(byBranch.rewritten.base, null);
  assert.equal(byBranch.dead, undefined);
  // compact events carry real booleans, as README documents for the `push` bus event
  assert.deepEqual([byBranch.reset.forced, byBranch.reset.created], [true, false]);
  assert.deepEqual([byBranch['new-name'].forced, byBranch['new-name'].created], [false, true]);
  assert.deepEqual([byBranch.copy.forced, byBranch.copy.created], [false, true]);
});

test('pushes past the cap become one catch-up message posted first', async () => {
  const repo = PROJECT.repo;
  const names = ['a', 'b', 'c', 'd', 'e'];
  const ctx = fakeCtx({ branches: { [repo]: names.map((n, i) => branch(n, i + 1)) } });
  ctx.config.feed.maxPushesPerCycle = 2;
  await pollProject(ctx, PROJECT, ctx.log);
  ctx.sent.length = 0;
  // newest commit date: c oldest ... a newest
  const minutes = { a: 50, b: 40, c: 10, d: 20, e: 30 };
  ctx.github.branches = async () => ({ items: names.map((n, i) => branch(n, i + 100)), changed: true });
  ctx.github.compare = async (r, base, head) => {
    const i = parseInt(head.slice(0, 7), 16) - 1 - 100;
    const n = names[i];
    return { status: 'ahead', ahead_by: 1, total_commits: 1, commits: [commit(i + 100, { minute: minutes[n] })], files: [] };
  };
  await pollProject(ctx, PROJECT, ctx.log);
  const posted = kinds(ctx.sent);
  assert.equal(posted.length, 3);
  assert.match(posted[0], /^📚 catch-up · 3 older pushes/);
  assert.ok(posted[0].indexOf('**c**') < posted[0].indexOf('**d**') && posted[0].indexOf('**d**') < posted[0].indexOf('**e**'));
  assert.deepEqual(posted.slice(1), ['1 new commit → b', '1 new commit → a']);
  assert.equal(ctx.events.length, 5);
  assert.equal(ctx.data.pushlog.entries.length, 5);
});

test('big pushes fetch their newest commits separately', async () => {
  const repo = PROJECT.repo;
  const ctx = fakeCtx({ branches: { [repo]: [branch('main', 1)] } });
  await pollProject(ctx, PROJECT, ctx.log);
  ctx.github.branches = async () => ({ items: [branch('main', 500)], changed: true });
  const oldest = Array.from({ length: 100 }, (_, i) => commit(i + 2));
  ctx.github.compare = async () => ({ status: 'ahead', ahead_by: 237, total_commits: 237, commits: oldest, files: [] });
  ctx.github.commits = async (r, { sha: s, perPage }) => {
    assert.equal(s, sha(500));
    assert.equal(perPage, 10);
    return Array.from({ length: 10 }, (_, i) => commit(500 - i, { login: 'newest' }));
  };
  await pollProject(ctx, PROJECT, ctx.log);
  const e = ctx.sent.at(-1).payload.embeds[0].toJSON();
  assert.equal(e.title, '🚀 237 new commits → main');
  assert.equal(e.author.name, 'newest');
  assert.ok(e.description.startsWith(`[\`${sha(500).slice(0, 7)}\`]`));
  assert.match(e.description, /…and 227 more$/);
  assert.deepEqual(ctx.data.pushlog.entries[0].authors, ['dex', 'newest']);
});

test('pollAll: per-project errors are contained and warned hourly; rate limits propagate', async () => {
  const broken = { ...PROJECT, key: 'brokentest', repo: 'dexnotavailable/broken' };
  const fine = { ...PROJECT, key: 'finetest' };
  const ctx = fakeCtx({
    projects: [broken, fine],
    branches: { [broken.repo]: new GitHubError('Not Found', { status: 404 }), [fine.repo]: [branch('main', 1)] },
  });
  await pollAll(ctx, ctx.log);
  await pollAll(ctx, ctx.log);
  assert.ok(ctx.data.heads.finetest, 'the healthy project still seeded');
  assert.equal(ctx.warns.filter((w) => w.includes('feed check failed')).length, 1, 'warned once per hour');

  const limited = fakeCtx({ projects: [fine], branches: { [fine.repo]: new RateLimitError('rate limited', { resetAt: Date.now() + 1000 }) } });
  await assert.rejects(pollAll(limited, limited.log), { name: 'RateLimitError' });
});

test('an empty branch list never announces mass deletion', async () => {
  const project = { ...PROJECT, key: 'emptytest' };
  const ctx = fakeCtx({ projects: [project], branches: { [project.repo]: [branch('main', 1), branch('x', 2)] } });
  await pollProject(ctx, project, ctx.log);
  ctx.github.branches = async () => ({ items: [], changed: true });
  await pollProject(ctx, project, ctx.log);
  assert.equal(ctx.sent.length, 1);
  assert.deepEqual(Object.keys(ctx.data.heads.emptytest.branches), ['main', 'x']);
});

// ------------------------------------------------------------------ buttons with fakes (no network)

const STAFF = { user: { id: 'staff-id' }, roles: ['staff-role'] };
const GUEST = { user: { id: 'guest-id' }, roles: [] };

function fakeInteraction({ member = STAFF, message = null, calls = [] } = {}) {
  return {
    calls,
    member,
    message,
    user: { id: member.user.id, username: 'tester' },
    deferred: false,
    replied: false,
    async reply(p) {
      calls.push(['reply', p]);
      this.replied = true;
    },
    async deferReply(p) {
      calls.push(['deferReply', p]);
      this.deferred = true;
    },
    async editReply(p) {
      calls.push(['editReply', p]);
    },
  };
}

function feedPost(calls, { hasThread = false, startError = null } = {}) {
  const { embeds, rows } = assertPayload(buildPushMessage(PROJECT, push({ branch: 'feat/talk', isDefault: false, commits: [commit(3)] })));
  return {
    id: 'msg-1',
    hasThread,
    embeds,
    components: rows,
    async startThread(opts) {
      calls.push(['startThread', opts]);
      if (startError) throw startError;
      return { id: 'thread-1', members: { add: async (id) => calls.push(['addMember', id]) } };
    },
  };
}

const EPHEMERAL = 64;
const steps = (calls) => calls.map(([name]) => name);

test('discuss button acknowledges before creating the thread', async () => {
  const ctx = fakeCtx({ branches: {} });
  const calls = [];
  const i = fakeInteraction({ message: feedPost(calls), calls });
  await feed.components.thread(i, ctx, []);
  assert.deepEqual(steps(calls), ['deferReply', 'startThread', 'editReply', 'addMember']);
  assert.equal(calls[0][1].flags, EPHEMERAL);
  assert.equal(calls[1][1].name, `feat/talk · ${sha(3).slice(0, 7)}`);
  assert.equal(calls[1][1].autoArchiveDuration, 10080);
  assert.equal(calls[2][1].content, "thread's open: <#thread-1>");
  assert.equal(calls[3][1], 'staff-id');
});

test('discuss button links an existing thread, including one created in a race', async () => {
  const ctx = fakeCtx({ branches: {} });
  const calls = [];
  await feed.components.thread(fakeInteraction({ message: feedPost(calls, { hasThread: true }), calls }), ctx, []);
  assert.deepEqual(steps(calls), ['deferReply', 'editReply']);
  assert.equal(calls[1][1].content, "there's already a thread: <#msg-1>");

  const raced = [];
  const err = Object.assign(new Error('A thread has already been created for this message'), { code: 160004 });
  await feed.components.thread(fakeInteraction({ message: feedPost(raced, { startError: err }), calls: raced }), ctx, []);
  assert.deepEqual(steps(raced), ['deferReply', 'startThread', 'editReply']);
  assert.equal(raced[2][1].content, "there's already a thread: <#msg-1>");
});

test('feed buttons refuse non-staff before touching anything', async () => {
  const ctx = fakeCtx({ branches: {} });
  ctx.github.compare = async () => assert.fail('no GitHub call for non-staff');
  for (const action of ['thread', 'files', 'diff']) {
    const calls = [];
    const i = fakeInteraction({ member: GUEST, message: feedPost(calls), calls });
    await feed.components[action](i, ctx, ['dexclient', sha(1).slice(0, 12), sha(2).slice(0, 12)]);
    assert.deepEqual(steps(calls), ['reply'], action);
    assert.equal(calls[0][1].flags, EPHEMERAL);
    assert.match(calls[0][1].content, /member of technical staff/);
  }
});

test('files button lists the range, and says so when the commit is gone', async () => {
  const ctx = fakeCtx({ branches: {} });
  const base = sha(1).slice(0, 12);
  const head = sha(2).slice(0, 12);
  ctx.github.compare = async (repo, b, h) => {
    assert.deepEqual([repo, b, h], [PROJECT.repo, base, head]);
    return { files: [file(1), file(2)] };
  };
  const calls = [];
  await feed.components.files(fakeInteraction({ calls }), ctx, ['dexclient', base, head]);
  assert.deepEqual(steps(calls), ['deferReply', 'editReply']);
  assert.match(calls[1][1].embeds[0].toJSON().title, /^2 files · /);

  ctx.github.commit = async () => {
    throw new GitHubError('No commit found for SHA', { status: 422 });
  };
  const gone = [];
  await feed.components.files(fakeInteraction({ calls: gone }), ctx, ['dexclient', '-', head]);
  assert.match(gone[1][1].content, /that commit is gone from github/);

  await assert.rejects(feed.components.files(fakeInteraction(), ctx, ['nope', '-', head]), { name: 'UserError' });
  await assert.rejects(feed.components.files(fakeInteraction(), ctx, ['dexclient', '-', 'main']), { name: 'UserError' });
});

test('diff button answers with the summary and the .diff file', async () => {
  const ctx = fakeCtx({ branches: {} });
  const head = sha(2).slice(0, 12);
  ctx.github.commit = async () => commit(2);
  ctx.github.commitDiff = async () => 'diff --git a/x.mjs b/x.mjs\n--- a/x.mjs\n+++ b/x.mjs\n@@ -1 +1 @@\n-a\n+b\n';
  const calls = [];
  await feed.components.diff(fakeInteraction({ calls }), ctx, ['dexclient', '-', head]);
  assert.deepEqual(steps(calls), ['deferReply', 'editReply']);
  assert.equal(calls[1][1].files.length, 1);
  assert.match(calls[1][1].files[0].name, /\.diff$/);

  ctx.github.commit = async () => {
    throw new GitHubError('Not Found', { status: 404 });
  };
  const gone = [];
  await feed.components.diff(fakeInteraction({ calls: gone }), ctx, ['dexclient', '-', head]);
  assert.match(gone[1][1].content, /that commit is gone from github/);
});
