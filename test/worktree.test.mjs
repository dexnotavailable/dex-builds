import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkRelPath,
  folderName,
  limitConcurrency,
  parseBranchHeader,
  parseNumstat,
  parseStatusPorcelain,
  parseWorktreePorcelain,
  patchStatuses,
  sortWorktrees,
  statusSummary,
  worktreeBlock,
  worktreeId,
  worktreeLabel,
} from '../src/modules/worktree.mjs';

const isUserError = (err) => err?.name === 'UserError';

const PORCELAIN = [
  'worktree D:/Dex/Projects/dexClient',
  'HEAD 097d37f8da572fd960298be3a6b8d09fdef06c94',
  'branch refs/heads/main',
  '',
  'worktree D:/Dex/Temp/claude-client-release',
  'HEAD 1d1ae73475a0305e337028812af8bc2c8a84e19b',
  'detached',
  '',
  'worktree D:/Dex/Temp/locked-one',
  'HEAD 5678abc5678abc5678abc5678abc5678abc5678c',
  'branch refs/heads/feature/locked',
  'locked reason here',
  '',
  'worktree D:/Dex/Temp/gone',
  'HEAD 1233def1234def1234def1234def1234def1234b',
  'detached',
  'prunable gitdir file points to non-existent location',
  '',
].join('\r\n');

test('parseWorktreePorcelain reads every record and flags the main checkout', () => {
  const list = parseWorktreePorcelain(PORCELAIN);
  assert.equal(list.length, 4);
  assert.deepEqual(list[0], {
    path: 'D:/Dex/Projects/dexClient',
    head: '097d37f8da572fd960298be3a6b8d09fdef06c94',
    branch: 'main',
    detached: false,
    bare: false,
    locked: false,
    prunable: false,
    main: true,
  });
  assert.equal(list[1].detached, true);
  assert.equal(list[1].branch, null);
  assert.equal(list[1].main, false);
  assert.equal(list[2].branch, 'feature/locked');
  assert.equal(list[2].locked, true);
  assert.equal(list[3].prunable, true);
  const bare = parseWorktreePorcelain('worktree /srv/repo.git\nbare\n\nworktree /srv/wt\nHEAD abc\nbranch refs/heads/x\n');
  assert.equal(bare[0].bare, true);
  assert.equal(bare[1].branch, 'x');
  assert.deepEqual(parseWorktreePorcelain(''), []);
});

test('parseBranchHeader handles upstreams, counts, gone, detached and unborn branches', () => {
  assert.deepEqual(parseBranchHeader('main...origin/main [ahead 2, behind 81]'), {
    branch: 'main',
    upstream: 'origin/main',
    ahead: 2,
    behind: 81,
    gone: false,
    detached: false,
  });
  assert.deepEqual(parseBranchHeader('feature/x...origin/feature/x [gone]'), {
    branch: 'feature/x',
    upstream: 'origin/feature/x',
    ahead: 0,
    behind: 0,
    gone: true,
    detached: false,
  });
  assert.equal(parseBranchHeader('local-only').branch, 'local-only');
  assert.equal(parseBranchHeader('local-only').upstream, null);
  assert.equal(parseBranchHeader('HEAD (no branch)').detached, true);
  assert.equal(parseBranchHeader('No commits yet on devbot').branch, 'devbot');
});

test('parseStatusPorcelain counts staged, modified, conflicts and untracked (-z records)', () => {
  const out = [
    '## main...origin/main [ahead 1]',
    ' M src/a.ts',
    'M  src/b.ts',
    'MM src/c.ts',
    'A  src/new.ts',
    'R  src/renamed.ts',
    'src/original.ts',
    'UU src/conflict.ts',
    'AA both-added.ts',
    '?? notes.txt',
    '?? scratch/',
    '',
  ].join('\0');
  const s = parseStatusPorcelain(out);
  assert.equal(s.branch, 'main');
  assert.equal(s.ahead, 1);
  assert.equal(s.behind, 0);
  assert.equal(s.staged, 4); // M_, MM, A_, R_
  assert.equal(s.modified, 2); // _M, MM
  assert.equal(s.conflicts, 2);
  assert.deepEqual(s.untracked, ['notes.txt', 'scratch/']);
  const clean = parseStatusPorcelain('## HEAD (no branch)\0');
  assert.equal(clean.detached, true);
  assert.equal(statusSummary(clean), 'clean');
});

test('statusSummary words the counts and upstream state', () => {
  const base = { staged: 0, modified: 0, conflicts: 0, untracked: [], ahead: 0, behind: 0, gone: false };
  assert.equal(statusSummary(null), 'status unavailable');
  assert.equal(statusSummary(base), 'clean');
  assert.equal(statusSummary({ ...base, behind: 81 }), 'clean · 81 behind');
  assert.equal(
    statusSummary({ ...base, conflicts: 1, staged: 2, modified: 3, untracked: ['a', 'b'], ahead: 4, gone: true }),
    '1 conflict · 2 staged · 3 modified · 2 untracked · 4 ahead · upstream gone',
  );
});

test('parseNumstat reads counts, binary files and -z renames', () => {
  const out = ['9\t1\tledger/CASES.md', '-\t-\tassets/logo.png', '3\t1\t', 'old/name.ts', 'new/name.ts', '0\t12\tgone.ts', ''].join('\0');
  assert.deepEqual(parseNumstat(out), [
    { filename: 'ledger/CASES.md', previous_filename: null, additions: 9, deletions: 1, changes: 10, status: 'modified', binary: false },
    { filename: 'assets/logo.png', previous_filename: null, additions: 0, deletions: 0, changes: 0, status: 'modified', binary: true },
    { filename: 'new/name.ts', previous_filename: 'old/name.ts', additions: 3, deletions: 1, changes: 4, status: 'renamed', binary: false },
    { filename: 'gone.ts', previous_filename: null, additions: 0, deletions: 12, changes: 12, status: 'modified', binary: false },
  ]);
  assert.deepEqual(parseNumstat(''), []);
});

test('patchStatuses finds added and deleted files from diff headers only', () => {
  const patch = [
    'diff --git a/new.ts b/new.ts',
    'new file mode 100644',
    'index 0000000..1111111',
    '--- /dev/null',
    '+++ b/new.ts',
    '@@ -0,0 +1 @@',
    '+new file mode in content does not count',
    'diff --git a/gone.ts b/gone.ts',
    'deleted file mode 100644',
    'index 2222222..0000000',
    'diff --git a/kept.ts b/kept.ts',
    'index 3333333..4444444 100644',
    '@@ -1 +1 @@',
    '-a',
    '+b',
    '',
  ].join('\n');
  const map = patchStatuses(patch);
  assert.equal(map.get('new.ts'), 'added');
  assert.equal(map.get('gone.ts'), 'removed');
  assert.equal(map.has('kept.ts'), false);
});

test('worktreeId is a stable 10-hex id per path', () => {
  const a = worktreeId('D:/Dex/Temp/claude-core/client-graph');
  assert.match(a, /^[0-9a-f]{10}$/);
  assert.equal(a, worktreeId('D:/Dex/Temp/claude-core/client-graph'));
  assert.notEqual(a, worktreeId('D:/Dex/Temp/claude-core/client-ink'));
});

test('folderName and worktreeLabel never expose the full path', () => {
  assert.equal(folderName('D:/Dex/Temp/claude-core/client-graph'), 'client-graph');
  assert.equal(folderName('C:\\Users\\dex\\repo\\'), 'repo');
  assert.equal(worktreeLabel({ branch: 'main', head: 'abc' }), 'main');
  assert.equal(worktreeLabel({ branch: null, head: '1d1ae73475a0305e' }), 'detached at 1d1ae73');
  const block = worktreeBlock(
    { path: 'D:/Dex/Temp/claude-core/client_graph', head: 'f6e5d7da5e5a043d', branch: 'claude-core/client_graph', main: false },
    { log: { at: 1790640000, subject: 'wire the graph' }, status: { staged: 1, modified: 0, conflicts: 0, untracked: [], ahead: 0, behind: 0, gone: false } },
  );
  assert.equal(block, '**claude-core/client\\_graph** · `client_graph` · 1 staged\n`f6e5d7d` <t:1790640000:R> wire the graph');
  assert.ok(!block.includes('D:/Dex'));
  assert.match(worktreeBlock({ path: '/x/main', head: null, branch: 'main', main: true }), /^🏠 \*\*main\*\* · `main` · status unavailable\n`\?{7}` no commits yet$/);
});

test('sortWorktrees keeps the main checkout first, then newest commits', () => {
  const items = [
    { wt: { path: 'a', main: false }, log: { at: 10 } },
    { wt: { path: 'b', main: false }, log: null },
    { wt: { path: 'main', main: true }, log: { at: 1 } },
    { wt: { path: 'c', main: false }, log: { at: 30 } },
  ];
  assert.deepEqual(sortWorktrees(items).map((i) => i.wt.path), ['main', 'c', 'a', 'b']);
});

test('checkRelPath refuses absolute paths and parent segments', () => {
  assert.equal(checkRelPath(''), '');
  assert.equal(checkRelPath(null), '');
  assert.equal(checkRelPath('./src//core\\x.ts'), 'src/core/x.ts');
  assert.equal(checkRelPath(':(top)weird'), ':(top)weird'); // passed after -- with literal pathspecs
  for (const bad of ['/etc/passwd', '\\\\server\\share', 'C:\\Windows', 'c:relative', '../other', 'src/../../x', 'a\u0000b']) {
    assert.throws(() => checkRelPath(bad), isUserError, bad);
  }
});

test('limitConcurrency never runs more than the limit and keeps results and errors per task', async () => {
  const run = limitConcurrency(2);
  let active = 0;
  let peak = 0;
  const task = (v, ms) => async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, ms));
    active -= 1;
    if (v === 'bad') throw new Error('bad');
    return v;
  };
  const results = await Promise.allSettled([run(task(1, 20)), run(task(2, 5)), run(task('bad', 5)), run(task(4, 10)), run(task(5, 1))]);
  assert.equal(peak, 2);
  assert.deepEqual(
    results.map((r) => (r.status === 'fulfilled' ? r.value : r.reason.message)),
    [1, 2, 'bad', 4, 5],
  );
  assert.equal(active, 0);
});
