import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { MessageFlags } from 'discord.js';
import { GitHubError } from '../src/core/github.mjs';
import review, {
  VERDICTS,
  TOO_BIG_FOOTER,
  parsePullRef,
  planReview,
  containedHead,
  pinRef,
  threadName,
  verdictSummary,
  withVerdicts,
  reviewButtons,
  prChoices,
  pruneReviews,
} from '../src/modules/review.mjs';

const projects = JSON.parse(fs.readFileSync(new URL('../config/projects.json', import.meta.url), 'utf8')).projects;
const MASTER = 'a'.repeat(40);
const FEATURE = 'b'.repeat(40);
const branches = [
  { name: 'master', sha: MASTER },
  { name: 'ow10/c35-integration', sha: FEATURE },
  { name: 'fresh', sha: MASTER },
];

test('parsePullRef reads #12 and 12, not shas or branches', () => {
  assert.equal(parsePullRef('#12'), 12);
  assert.equal(parsePullRef(' 12 '), 12);
  assert.equal(parsePullRef('123456'), 123456);
  assert.equal(parsePullRef('1234567'), null); // seven digits: a sha prefix
  assert.equal(parsePullRef('main'), null);
  assert.equal(parsePullRef('#'), null);
  assert.equal(parsePullRef(''), null);
});

test('planReview: a branch is compared against the pinned default branch', () => {
  const plan = planReview({ ref: 'ow10/c35-integration', defaultBranch: 'master', branches });
  assert.deepEqual(plan, { base: MASTER, head: FEATURE, label: 'ow10/c35-integration (bbbbbbb) vs master' });
});

test('planReview: the default branch itself is a single-commit review', () => {
  assert.deepEqual(planReview({ ref: 'master', defaultBranch: 'master', branches }), { base: null, head: MASTER, label: 'master (aaaaaaa)' });
});

test('planReview: a branch sitting on the default head is a single-commit review', () => {
  assert.deepEqual(planReview({ ref: 'fresh', defaultBranch: 'master', branches }), { base: null, head: MASTER, label: 'fresh (aaaaaaa)' });
});

test('planReview: a sha prefix of the default head is a single-commit review', () => {
  assert.deepEqual(planReview({ ref: 'AAAAAAA', defaultBranch: 'master', branches }), { base: null, head: MASTER, label: 'commit aaaaaaa' });
});

test('planReview: another sha is compared against the default branch', () => {
  const sha = 'c'.repeat(40);
  assert.deepEqual(planReview({ ref: sha, defaultBranch: 'master', branches }), { base: MASTER, head: sha, label: 'ccccccc vs master' });
});

test('planReview: an explicit base wins, even for the default branch', () => {
  assert.deepEqual(planReview({ ref: 'master', base: 'ow10/c35-integration', defaultBranch: 'master', branches }), {
    base: FEATURE,
    head: MASTER,
    label: 'master (aaaaaaa) vs ow10/c35-integration',
  });
  const sha = 'd'.repeat(40);
  assert.equal(planReview({ ref: 'ow10/c35-integration', base: sha, defaultBranch: 'master', branches }).label, 'ow10/c35-integration (bbbbbbb) vs ddddddd');
});

test('planReview: unknown refs pass through for GitHub to judge', () => {
  assert.deepEqual(planReview({ ref: 'v1.2.0', defaultBranch: 'master', branches }), { base: MASTER, head: 'v1.2.0', label: 'v1.2.0 vs master' });
});

test('planReview: a head the default branch already contains is a single-commit review', () => {
  const sha = 'e'.repeat(40);
  assert.deepEqual(planReview({ ref: 'eeeeeee', defaultBranch: 'master', branches, containedSha: sha }), { base: null, head: sha, label: 'commit eeeeeee' });
  assert.deepEqual(planReview({ ref: 'ow10/c35-integration', defaultBranch: 'master', branches, containedSha: FEATURE }), {
    base: null,
    head: FEATURE,
    label: 'ow10/c35-integration (bbbbbbb)',
  });
  assert.equal(planReview({ ref: 'v1.2.0', defaultBranch: 'master', branches, containedSha: sha }).label, 'v1.2.0 (eeeeeee)');
});

test('containedHead reads behind/identical compares (real GitHub shapes) and ignores the rest', () => {
  const sha = 'a600b08b5c1bbba1540e827c844716ad4e17921a';
  assert.equal(containedHead({ status: 'behind', ahead_by: 0, behind_by: 3, total_commits: 0, merge_base_commit: { sha } }), sha);
  assert.equal(containedHead({ status: 'identical', ahead_by: 0, behind_by: 0, merge_base_commit: { sha } }), sha);
  assert.equal(containedHead({ status: 'ahead', ahead_by: 2, merge_base_commit: { sha } }), null);
  assert.equal(containedHead({ status: 'diverged', ahead_by: 1, behind_by: 4, merge_base_commit: { sha } }), null);
  assert.equal(containedHead(null), null);
});

test('pinRef pins branch names only', () => {
  assert.equal(pinRef(branches, 'master'), MASTER);
  assert.equal(pinRef(branches, 'nope'), 'nope');
});

test('threadName stays within 100 chars', () => {
  assert.equal(threadName('PR #2: fix'), 'review: PR #2: fix');
  const long = threadName(`PR #2: ${'x'.repeat(200)}`);
  assert.equal(long.length, 100);
  assert.ok(long.startsWith('review: PR #2: '));
});

test('verdictSummary groups by verdict, ok first', () => {
  assert.equal(verdictSummary({}), 'none yet');
  assert.equal(verdictSummary({ c: 'changes', a: 'ok', b: 'ok' }), '✅ <@a> <@b> · 🔧 <@c>');
  assert.equal(verdictSummary({ c: 'changes' }), '🔧 <@c>');
  assert.equal(verdictSummary({ x: 'bogus' }), 'none yet');
});

test('withVerdicts replaces the verdicts field in place and keeps the rest', () => {
  const embeds = [
    { title: 'review', fields: [{ name: '3 files', value: 'a' }, { name: 'verdicts', value: 'none yet' }, { name: 'withheld', value: 'b' }] },
    { title: 'second' },
  ];
  const [first, second] = withVerdicts(embeds, { u1: 'ok' });
  assert.deepEqual(
    first.toJSON().fields.map((f) => [f.name, f.value]),
    [['3 files', 'a'], ['verdicts', '✅ <@u1>'], ['withheld', 'b']],
  );
  assert.equal(first.toJSON().title, 'review');
  assert.equal(second, embeds[1]);
});

test('withVerdicts appends the field when it is missing', () => {
  const [first] = withVerdicts([{ title: 'review' }], { u1: 'changes' });
  assert.deepEqual(first.toJSON().fields, [{ name: 'verdicts', value: '🔧 <@u1>' }]);
  assert.deepEqual(withVerdicts([], {}), []);
});

test('reviewButtons: two verdict buttons and a link', () => {
  const row = reviewButtons('https://github.com/dexnotavailable/dexcode/compare/a...b').toJSON();
  assert.deepEqual(
    row.components.map((c) => c.custom_id ?? c.url),
    ['review:verdict:ok', 'review:verdict:changes', 'https://github.com/dexnotavailable/dexcode/compare/a...b'],
  );
});

test('prChoices filters open PRs by number or title and redacts titles', () => {
  const pulls = [
    { number: 12, title: 'fix installer' },
    { number: 3, title: 'leak ghp_abcdefghijklmnopqrstuvwxyz0123456789 oops' },
    { number: 120, title: 'docs' },
  ];
  assert.deepEqual(prChoices(pulls, '#'), [
    { name: '#12 fix installer', value: '#12' },
    { name: '#3 leak [redacted] oops', value: '#3' },
    { name: '#120 docs', value: '#120' },
  ]);
  assert.deepEqual(prChoices(pulls, '#12').map((c) => c.value), ['#12', '#120']);
  assert.deepEqual(prChoices(pulls, '#INSTALL').map((c) => c.value), ['#12']);
  assert.equal(prChoices([{ number: 1, title: 'y'.repeat(300) }], '#')[0].name.length, 100);
});

test('pruneReviews drops the oldest records past the cap', () => {
  const reviews = { a: { createdAt: '2026-01-03' }, b: { createdAt: '2026-01-01' }, c: { createdAt: '2026-01-02' } };
  pruneReviews(reviews, 2);
  assert.deepEqual(Object.keys(reviews).sort(), ['a', 'c']);
});

test('the /review command builds with required options first', () => {
  const [cmd] = review.commands({ projects });
  const json = cmd.toJSON();
  assert.equal(json.name, 'review');
  assert.deepEqual(
    json.options.map((o) => [o.name, !!o.required, !!o.autocomplete]),
    [['project', true, false], ['ref', true, true], ['base', false, true], ['note', false, false]],
  );
});

// ------------------------------------------------------------------ verdict handler with fakes

function fakeCtx() {
  const data = new Map();
  return {
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
    guildCtx: { ownerId: 'owner', roleId: (k) => (k === 'staff' ? 'staff-role' : null), role: () => null },
    client: { channels: { fetch: async () => null } },
    log: { child: () => ({ info() {}, warn() {}, error() {} }) },
    dryRun: false,
  };
}

function click(userId, { staff = true, message, thread }) {
  const calls = { updates: [], replies: [] };
  const interaction = {
    user: { id: userId },
    member: { user: { id: userId }, roles: staff ? ['staff-role'] : [] },
    message,
    update: async (p) => {
      calls.updates.push(p);
      message.embeds = p.embeds.map((e) => e.toJSON());
    },
    reply: async (p) => calls.replies.push(p),
  };
  message.thread = thread;
  return { interaction, calls };
}

test('verdict buttons record one vote per staff member and note it in the thread', async () => {
  const ctx = fakeCtx();
  const sent = [];
  const thread = { send: async (p) => sent.push(p) };
  const message = { id: 'm1', embeds: [{ title: 'review', fields: [{ name: 'verdicts', value: 'none yet' }] }] };
  const verdict = review.components.verdict;

  let { interaction, calls } = click('u1', { message, thread });
  await verdict(interaction, ctx, ['ok']);
  assert.equal(calls.updates.length, 1);
  assert.equal(message.embeds[0].fields[0].value, '✅ <@u1>');
  assert.deepEqual(sent.at(-1), { content: '<@u1> ✅ looks good', allowedMentions: { parse: [] } });

  ({ interaction, calls } = click('u1', { message, thread }));
  await verdict(interaction, ctx, ['ok']);
  assert.equal(calls.updates.length, 0);
  assert.match(calls.replies[0].content, /already counted/);
  assert.equal(sent.length, 1);

  ({ interaction } = click('u1', { message, thread }));
  await verdict(interaction, ctx, ['changes']);
  ({ interaction } = click('u2', { message, thread }));
  await verdict(interaction, ctx, ['ok']);
  assert.equal(message.embeds[0].fields[0].value, '✅ <@u2> · 🔧 <@u1>');
  assert.deepEqual(ctx.state.get('reviews').m1.verdicts, { u1: 'changes', u2: 'ok' });
  assert.equal(sent.length, 3);

  ({ interaction, calls } = click('u3', { message, thread, staff: false }));
  await verdict(interaction, ctx, ['ok']);
  assert.match(calls.replies[0].content, /member of technical staff/);
  assert.equal(ctx.state.get('reviews').m1.verdicts.u3, undefined);
});

test('module shape', () => {
  assert.equal(review.name, 'review');
  assert.equal(typeof review.onCommand, 'function');
  assert.equal(typeof review.onAutocomplete, 'function');
  assert.deepEqual(Object.keys(review.components), ['verdict']);
  assert.deepEqual(Object.keys(VERDICTS), ['ok', 'changes']);
});

// ------------------------------------------------------------------ /review with fakes

const MERGED = 'a600b08b5c1bbba1540e827c844716ad4e17921a';

function reviewCtx() {
  const ctx = fakeCtx();
  const posts = [];
  const threads = [];
  const calls = [];
  ctx.github = {
    calls,
    branches: async () => ({ items: [{ name: 'master', commit: { sha: MASTER } }, { name: 'feature', commit: { sha: FEATURE } }] }),
    repo: async () => ({ default_branch: 'master' }),
    compare: async (repo, base, head) => {
      calls.push(['compare', base, head]);
      // a600b08 is an old commit master already contains: GitHub says "behind", nothing to show.
      if (head === 'a600b08') return { status: 'behind', ahead_by: 0, behind_by: 3, total_commits: 0, commits: [], files: [], merge_base_commit: { sha: MERGED } };
      return {
        status: 'ahead',
        ahead_by: 1,
        total_commits: 1,
        commits: [{ sha: head, commit: { message: 'feat: things' }, author: { login: 'dex' } }],
        files: [{ filename: 'src/a.js', status: 'modified', additions: 2, deletions: 1, changes: 3 }],
        merge_base_commit: { sha: base },
      };
    },
    compareDiff: async (repo, base, head) => {
      calls.push(['compareDiff', base, head]);
      return 'diff --git a/src/a.js b/src/a.js\n+x\n';
    },
    commit: async (repo, sha) => {
      calls.push(['commit', sha]);
      return { sha, commit: { message: 'fix: old thing' }, author: { login: 'dex' }, files: [{ filename: 'src/b.js', status: 'modified', additions: 1, deletions: 1, changes: 2 }] };
    },
    commitDiff: async (repo, sha) => {
      calls.push(['commitDiff', sha]);
      return 'diff --git a/src/b.js b/src/b.js\n-y\n+z\n';
    },
    pulls: async () => {
      calls.push(['pulls']);
      return [{ number: 2, title: 'proof pass' }, { number: 7, title: 'updater retry' }];
    },
    get: async (path) => {
      if (path.endsWith('/pulls/2')) return { number: 2, title: 'proof pass', html_url: 'https://github.com/x/pull/2', base: { sha: MASTER }, head: { sha: FEATURE } };
      const err = new Error('Not Found');
      err.name = 'GitHubError';
      throw err;
    },
    async pull(repo, n) {
      return this.get(`/repos/${repo}/pulls/${n}`);
    },
  };
  ctx.guildCtx.send = async (key, payload) => {
    const thread = { name: null, sent: [], send: async (p) => thread.sent.push(p) };
    const message = {
      id: `msg${posts.length + 1}`,
      url: `https://discord.com/channels/g/c/msg${posts.length + 1}`,
      startThread: async (opts) => {
        thread.name = opts.name;
        threads.push(thread);
        return thread;
      },
    };
    posts.push({ key, payload, message });
    return message;
  };
  return { ctx, posts, threads };
}

function command(values, userId = 'u1') {
  const replies = [];
  return {
    replies,
    interaction: {
      commandName: 'review',
      user: { id: userId },
      member: { user: { id: userId }, roles: ['staff-role'] },
      options: { getString: (name) => values[name] ?? null },
      deferReply: async (p) => replies.push({ defer: p }),
      editReply: async (p) => replies.push({ edit: p }),
      reply: async (p) => replies.push({ reply: p }),
    },
  };
}

test('/review posts to red-team pinging only the staff role, with a thread and state', async () => {
  const { ctx, posts, threads } = reviewCtx();
  const { interaction, replies } = command({ project: 'dexcode', ref: 'feature', note: 'look at the updater' });
  await review.onCommand(interaction, ctx);

  assert.equal(posts.length, 1);
  const { key, payload } = posts[0];
  assert.equal(key, 'red-team');
  assert.equal(payload.content, '<@&staff-role> review requested by <@u1>');
  assert.deepEqual(payload.allowedMentions, { roles: ['staff-role'] });
  const embed = payload.embeds[0].toJSON();
  assert.equal(embed.title, 'feature (bbbbbbb) vs master');
  assert.deepEqual(embed.fields.at(-1), { name: 'verdicts', value: 'none yet' });
  assert.equal(payload.files.length, 1);
  const buttons = payload.components[0].toJSON().components;
  assert.equal(buttons[2].url, `https://github.com/dexnotavailable/dexcode/compare/${MASTER}...${FEATURE}`);

  assert.equal(threads[0].name, 'review: feature (bbbbbbb) vs master');
  assert.match(threads[0].sent[0].content, /^\*\*note from <@u1>:\*\* look at the updater/);
  assert.deepEqual(threads[0].sent[0].allowedMentions, { parse: [] });

  const record = ctx.state.get('reviews').msg1;
  assert.deepEqual(
    { project: record.project, base: record.base, head: record.head, requestedBy: record.requestedBy, verdicts: record.verdicts, pr: record.pr },
    { project: 'dexcode', base: MASTER, head: FEATURE, requestedBy: 'u1', verdicts: {}, pr: null },
  );
  assert.deepEqual(replies[0].defer, { flags: MessageFlags.Ephemeral });
  assert.equal(replies.at(-1).edit, 'review is up in red-team: https://discord.com/channels/g/c/msg1');
});

test('/review #2 reviews the pull request range', async () => {
  const { ctx, posts, threads } = reviewCtx();
  const { interaction } = command({ project: 'dexcode', ref: '#2' });
  await review.onCommand(interaction, ctx);
  const embed = posts[0].payload.embeds[0].toJSON();
  assert.equal(embed.title, 'PR #2: proof pass');
  assert.equal(posts[0].payload.components[0].toJSON().components[2].url, 'https://github.com/x/pull/2');
  assert.equal(threads[0].name, 'review: PR #2: proof pass');
  assert.equal(threads[0].sent.length, 1); // just the how-to
  assert.equal(ctx.state.get('reviews').msg1.pr, 2);
});

test('/review refuses non-staff before touching github', async () => {
  const { ctx, posts } = reviewCtx();
  const { interaction, replies } = command({ project: 'dexcode', ref: 'feature' });
  interaction.member.roles = [];
  await review.onCommand(interaction, ctx);
  assert.equal(posts.length, 0);
  assert.match(replies[0].reply.content, /member of technical staff/);
});

test('/review of a commit the default branch already has reviews that commit alone', async () => {
  const { ctx, posts } = reviewCtx();
  const { interaction } = command({ project: 'dexcode', ref: 'a600b08' });
  await review.onCommand(interaction, ctx);
  const embed = posts[0].payload.embeds[0].toJSON();
  assert.equal(embed.title, 'commit a600b08');
  assert.equal(posts[0].payload.files.length, 1);
  assert.equal(posts[0].payload.components[0].toJSON().components[2].url, `https://github.com/dexnotavailable/dexcode/commit/${MERGED}`);
  assert.deepEqual(ctx.github.calls, [['compare', MASTER, 'a600b08'], ['commit', MERGED], ['commitDiff', MERGED]]);
  const record = ctx.state.get('reviews').msg1;
  assert.deepEqual([record.base, record.head], [null, MERGED]);
});

test('/review still posts the summary when github says the diff is too large (406)', async () => {
  const { ctx, posts, threads } = reviewCtx();
  ctx.github.compareDiff = async () => {
    throw new GitHubError('GitHub GET /repos/x/compare: Sorry, the diff exceeded the maximum number of files', { status: 406 });
  };
  const { interaction, replies } = command({ project: 'dexcode', ref: 'feature' });
  await review.onCommand(interaction, ctx);
  const { payload } = posts[0];
  assert.equal(payload.files.length, 0);
  const embed = payload.embeds[0].toJSON();
  assert.equal(embed.title, 'feature (bbbbbbb) vs master');
  assert.equal(embed.footer.text, TOO_BIG_FOOTER);
  assert.match(embed.fields[0].name, /^1 file/);
  assert.deepEqual(embed.fields.at(-1), { name: 'verdicts', value: 'none yet' });
  assert.equal(threads.length, 1);
  assert.match(replies.at(-1).edit, /^review is up in red-team: \S+\nsummary only: the diff is too large for discord\.$/);
});

test('/review turns an unknown ref into a user error', async () => {
  const { ctx, posts } = reviewCtx();
  ctx.github.compare = async () => {
    throw new GitHubError('GitHub GET /repos/x/compare: Not Found', { status: 404 });
  };
  const { interaction } = command({ project: 'dexcode', ref: 'nope' });
  await assert.rejects(review.onCommand(interaction, ctx), (err) => err.name === 'UserError' && /can't find that in dexCode/.test(err.message));
  assert.equal(posts.length, 0);
});

// ------------------------------------------------------------------ autocomplete with fakes

function typing(values, focused, { staff = true } = {}) {
  const responses = [];
  return {
    responses,
    interaction: {
      member: { user: { id: 'u1' }, roles: staff ? ['staff-role'] : [] },
      options: {
        getString: (name) => values[name] ?? null,
        getFocused: (full) => (full ? focused : focused.value),
      },
      respond: async (choices) => responses.push(choices),
    },
  };
}

test('autocomplete shows nothing to non-staff and never asks github', async () => {
  const { ctx } = reviewCtx();
  const { interaction, responses } = typing({ project: 'dexclient' }, { name: 'ref', value: '#' }, { staff: false });
  await review.onAutocomplete(interaction, ctx);
  assert.deepEqual(responses, [[]]);
  assert.deepEqual(ctx.github.calls, []);
});

test('autocomplete: "#" lists open PRs, anything else lists branches, for ref and base alike', async () => {
  const { ctx } = reviewCtx();
  let { interaction, responses } = typing({ project: 'dexclient' }, { name: 'ref', value: '#7' });
  await review.onAutocomplete(interaction, ctx);
  assert.deepEqual(responses, [[{ name: '#7 updater retry', value: '#7' }]]);

  ({ interaction, responses } = typing({ project: 'dexclient', ref: 'feature' }, { name: 'base', value: 'mas' }));
  await review.onAutocomplete(interaction, ctx);
  assert.deepEqual(responses, [[{ name: 'master', value: 'master' }]]);

  ({ interaction, responses } = typing({}, { name: 'ref', value: 'x' }));
  await review.onAutocomplete(interaction, ctx);
  assert.deepEqual(responses, [[]]);
});
