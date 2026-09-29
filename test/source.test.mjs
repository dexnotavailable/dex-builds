import test from 'node:test';
import assert from 'node:assert/strict';
import { OverwriteType, PermissionFlagsBits } from 'discord.js';
import { redactSecrets } from '../src/core/redact.mjs';
import {
  branchLine,
  branchLines,
  cleanPath,
  cleanRef,
  cloneCommands,
  code,
  commitListLines,
  formatBytes,
  isBinary,
  lineAnchor,
  numberLines,
  openToNonStaff,
  parseLines,
  rankPaths,
  redactKeepingLines,
  renderListing,
  reviewTarget,
  shellSafeRef,
  sliceLines,
  ttlCache,
} from '../src/modules/source.mjs';

const project = { key: 'dexclient', repo: 'dexnotavailable/dexclient', name: 'dexClient', emoji: '📦', color: '#22c55e' };
const isUserError = (err) => err?.name === 'UserError';

test('rankPaths: path prefix, then basename prefix, then substring; shorter first; dirs get a slash', () => {
  const entries = [
    { path: 'src', type: 'tree' },
    { path: 'src/index.ts', type: 'blob' },
    { path: 'src/core/index.ts', type: 'blob' },
    { path: 'docs/index.md', type: 'blob' },
    { path: 'lib/reindex.js', type: 'blob' },
    { path: 'index.html', type: 'blob' },
  ];
  assert.deepEqual(
    rankPaths(entries, 'index').map((c) => c.value),
    ['index.html', 'src/index.ts', 'docs/index.md', 'src/core/index.ts', 'lib/reindex.js'],
  );
  assert.deepEqual(rankPaths(entries, 'src'), [
    { name: 'src/', value: 'src' },
    { name: 'src/index.ts', value: 'src/index.ts' },
    { name: 'src/core/index.ts', value: 'src/core/index.ts' },
  ]);
  // leading ./ or / and backslashes are ignored, matching is case-insensitive
  assert.equal(rankPaths(entries, './SRC\\Index')[0].value, 'src/index.ts');
  assert.equal(rankPaths(entries, '/src/core')[0].value, 'src/core/index.ts');
});

test('rankPaths: caps at 25, skips long paths and secret-looking files', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ path: `f${i}.ts`, type: 'blob' }));
  assert.equal(rankPaths(many, '').length, 25);
  const entries = [
    { path: `${'a'.repeat(101)}.ts`, type: 'blob' },
    { path: 'app/.env.local', type: 'blob' },
    { path: 'config/secrets', type: 'tree' },
    { path: 'app/main.ts', type: 'blob' },
  ];
  assert.deepEqual(rankPaths(entries, '').map((c) => c.value), ['app/main.ts', 'config/secrets']);
  for (const c of rankPaths(many, '')) assert.ok(c.name.length <= 100 && c.value.length <= 100);
  // a 100-char directory keeps its name within the limit (no trailing slash)
  const dir = 'd'.repeat(100);
  assert.deepEqual(rankPaths([{ path: dir, type: 'tree' }], 'd'), [{ name: dir, value: dir }]);
});

test('parseLines accepts single lines, ranges, github anchors and open ends', () => {
  assert.equal(parseLines(''), null);
  assert.equal(parseLines(null), null);
  assert.deepEqual(parseLines('42'), { start: 42, end: 42 });
  assert.deepEqual(parseLines('120-180'), { start: 120, end: 180 });
  assert.deepEqual(parseLines(' 120 - 180 '), { start: 120, end: 180 });
  assert.deepEqual(parseLines('L10-L20'), { start: 10, end: 20 });
  assert.deepEqual(parseLines('180-120'), { start: 120, end: 180 });
  assert.deepEqual(parseLines('120-'), { start: 120, end: null });
  for (const bad of ['abc', '0', '5-0', '1-2-3', '-5', '12,14']) assert.throws(() => parseLines(bad), isUserError, bad);
});

test('lineAnchor matches github', () => {
  assert.equal(lineAnchor({ start: 42, end: 42 }), '#L42');
  assert.equal(lineAnchor({ start: 120, end: 180 }), '#L120-L180');
  assert.equal(lineAnchor({ start: 120, end: null }), '#L120');
});

test('isBinary looks for a NUL byte in the first 8 KB only', () => {
  assert.equal(isBinary(Buffer.from('plain text\nwith lines\n')), false);
  assert.equal(isBinary(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01])), true);
  assert.equal(isBinary(Buffer.alloc(0)), false);
  const late = Buffer.concat([Buffer.alloc(9000, 0x61), Buffer.from([0])]);
  assert.equal(isBinary(late), false);
});

test('renderListing puts folders first, shows sizes and marks secret-looking files', () => {
  const entries = [
    { name: 'README.md', path: 'README.md', type: 'file', size: 1536 },
    { name: 'src', path: 'src', type: 'dir', size: 0 },
    { name: '.env', path: '.env', type: 'file', size: 12 },
    { name: 'vendor', path: 'vendor', type: 'submodule', size: 0 },
    { name: 'assets', path: 'assets', type: 'dir', size: 0 },
    { name: 'my_file.ts', path: 'my_file.ts', type: 'file', size: 3 * 1024 * 1024 },
  ];
  const { text, shown, more } = renderListing(entries);
  assert.deepEqual(text.split('\n'), [
    '📁 assets/',
    '📁 src/',
    '🔒 .env · 12 B',
    '📄 my\\_file.ts · 3.0 MB',
    '📄 README.md · 1.5 KB',
    '📦 vendor · submodule',
  ]);
  assert.equal(shown, 6);
  assert.equal(more, 0);
  const big = Array.from({ length: 80 }, (_, i) => ({ name: `f${i}`, path: `f${i}`, type: 'file', size: 1 }));
  const capped = renderListing(big);
  assert.equal(capped.shown, 60);
  assert.equal(capped.more, 20);
});

test('formatBytes', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1023), '1023 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
});

test('cleanPath normalises and refuses parent segments', () => {
  assert.equal(cleanPath('/src//core/'), 'src/core');
  assert.equal(cleanPath('./src\\index.ts'), 'src/index.ts');
  assert.equal(cleanPath('/'), '');
  assert.equal(cleanPath('.github/workflows'), '.github/workflows');
  for (const bad of ['../x', 'src/../../user', 'a/..', 'a\u0001b']) assert.throws(() => cleanPath(bad), isUserError, bad);
});

test('cleanRef keeps branches and shas and rejects what could walk a URL', () => {
  assert.equal(cleanRef(''), '');
  assert.equal(cleanRef('  ow10/c35-integration '), 'ow10/c35-integration');
  assert.equal(cleanRef('1d1ae73'), '1d1ae73');
  assert.equal(cleanRef('main~3'), 'main~3');
  for (const bad of ['..', '.', 'a..b', 'main...dev', '-x', 'a b', 'a/.hidden', 'a//b', 'x@{1}', 'a:b', 'trailing/']) {
    assert.throws(() => cleanRef(bad), isUserError, bad);
  }
});

test('shellSafeRef only lets plain branch names into shell commands', () => {
  assert.equal(shellSafeRef('ow10/c35-integration'), true);
  assert.equal(shellSafeRef('release+1.2_x'), true);
  for (const bad of ['a;rm -rf ~', '$(id)', 'a|b', 'a`b`', '-f', "a'b"]) assert.equal(shellSafeRef(bad), false, bad);
});

test('sliceLines and numberLines', () => {
  const text = 'one\ntwo\nthree\nfour\n';
  assert.deepEqual(sliceLines(text, null), { lines: ['one', 'two', 'three', 'four'], start: 1, end: 4, total: 4 });
  assert.deepEqual(sliceLines(text, { start: 2, end: 3 }), { lines: ['two', 'three'], start: 2, end: 3, total: 4 });
  assert.deepEqual(sliceLines(text, { start: 3, end: null }), { lines: ['three', 'four'], start: 3, end: 4, total: 4 });
  assert.deepEqual(sliceLines(text, { start: 4, end: 99 }).lines, ['four']);
  assert.throws(() => sliceLines(text, { start: 5, end: 5 }), isUserError);
  assert.equal(sliceLines('', null).total, 0);
  assert.equal(numberLines(['a', 'b'], 9), ' 9  a\n10  b');
});

test('code() makes a safe inline span', () => {
  assert.equal(code('src/my_file.ts'), '`src/my_file.ts`');
  assert.equal(code('a`b'), "`a'b`");
});

test('commitListLines adds a relative date to each commit line', () => {
  const lines = commitListLines(project, [
    { sha: '1d1ae73475a0305e337028812af8bc2c8a84e19b', commit: { message: 'ship it', committer: { date: '2026-09-29T00:00:00Z' } }, author: { login: 'dex' } },
  ]);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[`1d1ae73`\]\(https:\/\/github\.com\/dexnotavailable\/dexclient\/commit\/1d1ae73[0-9a-f]+\) ship it — dex · <t:1790640000:R>$/);
});

test('branchLine and branchLines', () => {
  const branches = [
    { name: 'feature/x', sha: 'abcdef1234567', committedDate: '2026-09-29T00:00:00Z', headline: 'add **x**', author: 'dex' },
    { name: 'main', sha: '1234567abcdef', committedDate: '2026-09-28T00:00:00Z', headline: 'merge', author: null },
    { name: 'feature/y', sha: '7777777000000', committedDate: null, headline: '', author: null },
  ];
  assert.equal(branchLine(branches[0], 'main'), '`feature/x` · abcdef1 · <t:1790640000:R> · add \\*\\*x\\*\\* (dex)');
  assert.equal(branchLine(branches[1], 'main'), '⭐ `main` · 1234567 · <t:1790553600:R> · merge');
  assert.equal(branchLine(branches[2], 'main'), '`feature/y` · 7777777 · no date');
  assert.deepEqual(branchLines(branches, { defaultBranch: 'main', filter: 'FEATURE' }).matched, 2);
  const many = Array.from({ length: 30 }, (_, i) => ({ name: `b${i}`, sha: 'a'.repeat(40) }));
  const out = branchLines(many, { defaultBranch: 'main' });
  assert.equal(out.lines.length, 15);
  assert.equal(out.matched, 30);
});

test('cloneCommands covers clone, a review worktree and cleanup', () => {
  const text = cloneCommands({ key: 'dexplace', repo: 'dexnotavailable/dex.place' }, 'feature/x');
  assert.ok(text.includes('gh repo clone dexnotavailable/dex.place'));
  assert.ok(text.includes('git clone https://github.com/dexnotavailable/dex.place.git'));
  assert.ok(text.includes('cd dex.place'));
  assert.ok(text.includes('git fetch origin feature/x\ngit worktree add ../dexplace-review origin/feature/x'));
  assert.ok(text.includes('git worktree remove ../dexplace-review'));
  // an abbreviated sha can't be fetched by name, so a plain fetch comes first
  const bySha = cloneCommands(project, '1d1ae73');
  assert.ok(bySha.includes('git fetch origin\ngit worktree add --detach ../dexclient-review 1d1ae73'));
  assert.ok(!bySha.includes('git fetch origin 1d1ae73'));
  const noBranch = cloneCommands(project, null);
  assert.ok(noBranch.includes('git fetch origin\ngit worktree add --detach ../dexclient-review origin/HEAD'));
});

test('reviewTarget names what the detached review worktree checks out', () => {
  assert.equal(reviewTarget(null), 'origin/HEAD');
  assert.equal(reviewTarget('ow10/c35-integration'), 'origin/ow10/c35-integration');
  assert.equal(reviewTarget('1d1ae73'), '1d1ae73');
});

test('redactKeepingLines keeps line numbers true across a redacted PEM block', () => {
  const lines = [
    'line 1',
    'const key = "-----BEGIN RSA PRIVATE KEY-----',
    'MIIEpAIBAAKCAQEA0Zabcdef',
    '',
    'qwertyuiop',
    '-----END RSA PRIVATE KEY-----',
    '";',
    `token = "ghp_${'a'.repeat(36)}"`,
    'last',
  ];
  const text = lines.join('\n');
  assert.ok(redactSecrets(text).split('\n').length < lines.length); // why the helper exists
  const out = redactKeepingLines(text).split('\n');
  assert.deepEqual(out, ['line 1', 'const key = "[redacted]', '[redacted]', '', '[redacted]', '[redacted]', '";', 'token = "[redacted]"', 'last']);
  assert.deepEqual(sliceLines(out.join('\n'), { start: 8, end: 9 }).lines, ['token = "[redacted]"', 'last']);
  assert.equal(redactKeepingLines('nothing secret\nhere'), 'nothing secret\nhere');
});

test('openToNonStaff: any non-staff role or member overwrite that can view makes a channel open', () => {
  const VIEW = PermissionFlagsBits.ViewChannel;
  const roleIds = ['guild', 'staff', 'ceo', 'waitlist', 'gojo-role', 'other-bot-role'];
  const roles = new Map(roleIds.map((id) => [id, { id, tags: id === 'gojo-role' ? { botId: 'gojo' } : id === 'other-bot-role' ? { botId: 'x' } : null }]));
  const members = new Map([['alice', { id: 'alice', roles: { cache: new Map([['staff', {}]]) } }]]);
  const ctx = {
    guildCtx: { ownerId: 'dex', roleId: (key) => ({ staff: 'staff', ceo: 'ceo' })[key] ?? null },
    config: { local: { ownerIds: [] } },
  };
  const channel = (viewers, memberAllows = []) => ({
    isThread: () => false,
    permissionsFor: (role) => ({ has: (bit) => bit === VIEW && viewers.includes(role.id) }),
    permissionOverwrites: {
      cache: new Map(memberAllows.map((id) => [id, { id, type: OverwriteType.Member, allow: { has: (bit) => bit === VIEW } }])),
    },
  });
  const interaction = (ch) => ({ guild: { roles: { cache: roles }, members: { cache: members } }, client: { user: { id: 'gojo' } }, channel: ch });

  // staff-only channel: staff, ceo and gojo's own role/member overwrite can view
  assert.equal(openToNonStaff(interaction(channel(['staff', 'ceo', 'gojo-role'], ['gojo'])), ctx), false);
  // member overwrites for the owner (uncached) and a cached staff member are fine
  assert.equal(openToNonStaff(interaction(channel(['staff'], ['dex', 'alice'])), ctx), false);
  // @everyone, a non-staff role, another bot, or an uncached non-staff member makes it open
  assert.equal(openToNonStaff(interaction(channel(['guild'])), ctx), true);
  assert.equal(openToNonStaff(interaction(channel(['staff', 'waitlist'])), ctx), true);
  assert.equal(openToNonStaff(interaction(channel(['staff', 'other-bot-role'])), ctx), true);
  assert.equal(openToNonStaff(interaction(channel(['staff'], ['rando'])), ctx), true);
  // a thread is judged by its parent; an unknown channel counts as open
  const thread = { isThread: () => true, parent: channel(['staff']) };
  assert.equal(openToNonStaff(interaction(thread), ctx), false);
  assert.equal(openToNonStaff(interaction({ isThread: () => true, parent: null }), ctx), true);
  assert.equal(openToNonStaff(interaction(null), ctx), true);
});

test('ttlCache shares in-flight loads, expires, evicts least recently used and forgets failures', async () => {
  let clock = 0;
  const cache = ttlCache({ max: 2, ttlMs: 100, now: () => clock });
  let loads = 0;
  const load = (v) => () => {
    loads += 1;
    return v;
  };
  const [a1, a2] = await Promise.all([cache.get('a', load('A')), cache.get('a', load('A2'))]);
  assert.equal(a1, 'A');
  assert.equal(a2, 'A');
  assert.equal(loads, 1);

  await cache.get('b', load('B'));
  await cache.get('a', load('nope')); // touch a, so b is the oldest
  await cache.get('c', load('C'));
  assert.equal(cache.size, 2);
  assert.equal(await cache.get('b', load('B2')), 'B2'); // b was evicted

  clock = 1_000;
  assert.equal(await cache.get('c', load('C2')), 'C2'); // expired

  await assert.rejects(cache.get('x', () => Promise.reject(new Error('boom'))));
  await new Promise((r) => setImmediate(r));
  assert.equal(await cache.get('x', load('X')), 'X');
});
