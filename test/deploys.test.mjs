import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyDeploy, deployMessage, failureMessage, readDeployState, scrubPaths, withRolePing } from '../src/modules/deploys.mjs';

const project = { key: 'dexplace', name: 'dex.place', repo: 'dexnotavailable/dex.place', emoji: '🌐', color: '#f59e0b', site: 'https://dex.place', pingRole: 'ping-dexplace' };
const sha = (c) => c.repeat(40);
const A = sha('a');
const B = sha('b');
const C = sha('c');
const D = sha('d');

function fileText(fields = {}) {
  return JSON.stringify({
    schema: 1,
    sha: C,
    build: C.slice(0, 12),
    deployedAt: '2026-09-29T05:11:07.770Z',
    previousSha: B,
    previousBuild: B.slice(0, 12),
    heldSha: null,
    history: [
      { sha: C, build: C.slice(0, 12), deployedAt: '2026-09-29T05:11:07.770Z' },
      { sha: B, build: B.slice(0, 12), deployedAt: '2026-09-29T01:37:25.980Z' },
      { sha: A, build: A.slice(0, 12), deployedAt: '2026-09-28T19:49:17.897Z' },
    ],
    ...fields,
  });
}

// ------------------------------------------------------------------ readDeployState

test('readDeployState: the dex.place schema parses', () => {
  const s = readDeployState(fileText());
  assert.equal(s.sha, C);
  assert.equal(s.build, C.slice(0, 12));
  assert.equal(s.previousSha, B);
  assert.equal(s.heldSha, null);
  assert.equal(s.history.length, 3);
  assert.equal(s.lastFailedAt, null);
});

test('readDeployState: missing, partial or wrong files give null', () => {
  assert.equal(readDeployState(''), null);
  assert.equal(readDeployState(fileText().slice(0, 80)), null);
  assert.equal(readDeployState('null'), null);
  assert.equal(readDeployState('[]'), null);
  assert.equal(readDeployState(fileText({ sha: 'not-a-sha' })), null);
  assert.equal(readDeployState(fileText({ deployedAt: 'yesterday' })), null);
});

test('readDeployState: bad history entries are dropped and names sanitised', () => {
  const s = readDeployState(fileText({ build: 'x`y z', history: [null, { sha: 'zz' }, { sha: A, deployedAt: '2026-09-28T00:00:00Z' }], heldSha: 42 }));
  assert.equal(s.build, 'xyz');
  assert.deepEqual(s.history, [{ sha: A, build: A.slice(0, 12), deployedAt: '2026-09-28T00:00:00Z' }]);
  assert.equal(s.heldSha, null);
});

test('readDeployState: failure fields are kept', () => {
  const s = readDeployState(fileText({ lastFailedSha: D, lastFailedAt: '2026-09-29T06:00:00Z', lastFailedReason: 'build exited 1' }));
  assert.equal(s.lastFailedSha, D);
  assert.equal(s.lastFailedReason, 'build exited 1');
});

// ------------------------------------------------------------------ classifyDeploy

const file = (fields) => readDeployState(fileText(fields));

test('classifyDeploy: first read seeds from the file history', () => {
  const r = classifyDeploy(undefined, file());
  assert.equal(r.kind, 'seed');
  assert.equal(r.next.lastSha, C);
  assert.deepEqual(r.next.seen, [C, B, A]);
  assert.deepEqual(r.next.history.map((h) => h.sha), [C, B, A]);
});

test('classifyDeploy: same sha is nothing new', () => {
  const state = classifyDeploy(undefined, file()).next;
  const r = classifyDeploy(state, file());
  assert.equal(r.kind, 'none');
  assert.equal(r.failed, false);
  assert.equal(r.next, state);
});

test('classifyDeploy: a new sha is a deploy from the last announced sha', () => {
  const state = classifyDeploy(undefined, file()).next;
  const next = file({ sha: D, build: D.slice(0, 12), deployedAt: '2026-09-29T08:00:00Z', previousSha: C, history: [{ sha: D, deployedAt: '2026-09-29T08:00:00Z' }, ...JSON.parse(fileText()).history] });
  const r = classifyDeploy(state, next);
  assert.equal(r.kind, 'deploy');
  assert.equal(r.from, C);
  assert.equal(r.next.lastSha, D);
  assert.equal(r.next.seen[0], D);
  assert.deepEqual(r.next.history[0], { sha: D, at: '2026-09-29T08:00:00Z' });
  assert.equal(r.next.history.length, 4);
});

test('classifyDeploy: deploys missed while the bot was down still land in history', () => {
  const state = classifyDeploy(undefined, file()).next;
  const E = sha('e');
  const history = [
    { sha: E, deployedAt: '2026-09-29T09:00:00Z' },
    { sha: D, deployedAt: '2026-09-29T08:00:00Z' },
    ...JSON.parse(fileText()).history,
  ];
  const r = classifyDeploy(state, file({ sha: E, deployedAt: '2026-09-29T09:00:00Z', previousSha: D, history }));
  assert.equal(r.kind, 'deploy');
  assert.equal(r.from, C);
  assert.deepEqual(r.next.history.slice(0, 3).map((h) => h.sha), [E, D, C]);
});

test('classifyDeploy: going back to a sha that was live before is a rollback', () => {
  const state = classifyDeploy(undefined, file()).next;
  const r = classifyDeploy(state, file({ sha: B, deployedAt: '2026-09-29T07:00:00Z', previousSha: C, heldSha: C }));
  assert.equal(r.kind, 'rollback');
  assert.equal(r.from, C);
  assert.deepEqual(r.next.seen.slice(0, 2), [B, C]);
  assert.deepEqual(r.next.history[0], { sha: B, at: '2026-09-29T07:00:00Z' });
});

test('classifyDeploy: the deployer rollback stamp marks a rollback even for an unseen sha', () => {
  const state = { lastSha: C, lastDeployedAt: '2026-09-29T05:11:07.770Z', seen: [C], history: [] };
  const at = '2026-09-29T07:00:00Z';
  const r = classifyDeploy(state, file({ sha: D, deployedAt: at, rolledBackAt: at }));
  assert.equal(r.kind, 'rollback');
});

test('classifyDeploy: a rollback stamp from earlier does not turn a redeploy of an old sha into a rollback', () => {
  const state = classifyDeploy(undefined, file()).next; // B was live before
  const r = classifyDeploy(state, file({ sha: B, deployedAt: '2026-09-29T09:00:00Z', rolledBackAt: '2026-09-29T06:00:00Z' }));
  assert.equal(r.kind, 'deploy');
  assert.equal(classifyDeploy(state, file({ sha: B, deployedAt: '2026-09-29T09:00:00Z' })).kind, 'rollback');
});

test('classifyDeploy: a failure newer than anything announced is reported once', () => {
  const state = classifyDeploy(undefined, file()).next;
  const failing = file({ lastFailedSha: D, lastFailedAt: '2026-09-29T06:00:00Z', lastFailedReason: 'nope' });
  const r = classifyDeploy(state, failing);
  assert.equal(r.kind, 'none');
  assert.equal(r.failed, true);
  assert.equal(r.next.lastFailedAt, '2026-09-29T06:00:00Z');
  assert.equal(classifyDeploy(r.next, failing).failed, false);
});

test('classifyDeploy: a failure older than the seeded deploy is not news', () => {
  const r = classifyDeploy(undefined, file({ lastFailedAt: '2026-09-28T00:00:00Z' }));
  assert.equal(r.failed, false);
  const again = classifyDeploy({ ...r.next, lastFailedAt: undefined }, file({ lastFailedAt: '2026-09-28T00:00:00Z' }));
  assert.equal(again.failed, false);
});

test('classifyDeploy: a failure superseded by a later deploy is not news', () => {
  const state = classifyDeploy(undefined, file()).next;
  const r = classifyDeploy(state, file({ sha: D, deployedAt: '2026-09-29T08:00:00Z', lastFailedSha: sha('e'), lastFailedAt: '2026-09-29T06:00:00Z' }));
  assert.equal(r.kind, 'deploy');
  assert.equal(r.failed, false);
});

test('classifyDeploy: seen and history are capped', () => {
  const seen = Array.from({ length: 30 }, (_, i) => `s${i}`);
  const history = Array.from({ length: 20 }, (_, i) => ({ sha: `h${i}`, at: new Date(Date.parse('2026-09-01T00:00:00Z') + i * 1000).toISOString() }));
  const state = { lastSha: C, lastDeployedAt: '2026-09-29T05:11:07.770Z', seen, history };
  const r = classifyDeploy(state, file({ sha: D, deployedAt: '2026-09-29T08:00:00Z', history: [] }));
  assert.equal(r.next.seen.length, 30);
  assert.equal(r.next.history.length, 20);
  assert.equal(r.next.history[0].sha, D);
});

// ------------------------------------------------------------------ messages

const commit = (s, message) => ({ sha: s, commit: { message, author: { name: 'dex' } }, author: { login: 'dexnotavailable' } });

test('deployMessage: deploy lists commits since the last announced build and links the site', () => {
  const f = file({ sha: D, build: D.slice(0, 12), deployedAt: '2026-09-29T08:00:00Z' });
  const msg = deployMessage(project, f, {
    kind: 'deploy',
    from: C,
    commit: commit(D, 'feat: shiny\n\nbody'),
    compare: { total_commits: 2, commits: [commit(sha('1'), 'one'), commit(D, 'feat: shiny')] },
  });
  const e = msg.embeds[0].toJSON();
  assert.equal(e.title, `🌐 dex.place is live · build \`${D.slice(0, 12)}\``);
  assert.match(e.description, /feat: shiny/);
  assert.match(e.description, new RegExp(`\\*\\*2 commits since \`${C.slice(0, 12)}\`\\*\\*`));
  const buttons = msg.components[0].toJSON().components;
  assert.deepEqual(buttons.map((b) => b.label), ['open dex.place', 'github ↗']);
  assert.equal(buttons[1].url, `https://github.com/dexnotavailable/dex.place/compare/${C}...${D}`);
});

test('deployMessage: rollback says so, lists pulled commits and mentions the held sha', () => {
  const f = file({ sha: B, build: B.slice(0, 12), heldSha: C });
  const msg = deployMessage(project, f, { kind: 'rollback', from: C, commit: null, compare: { commits: [commit(C, 'broke it')] } });
  const e = msg.embeds[0].toJSON();
  assert.equal(e.title, `⏪ dex.place rolled back to build \`${B.slice(0, 12)}\``);
  assert.match(e.description, /1 commit pulled from live/);
  assert.ok(e.fields.some((x) => x.name === 'held' && x.value.includes(C.slice(0, 12))));
  assert.equal(msg.components[0].toJSON().components[1].url, `https://github.com/dexnotavailable/dex.place/compare/${B}...${C}`);
});

test('deployMessage: works without GitHub details and without a site', () => {
  const msg = deployMessage({ ...project, site: undefined }, file(), { kind: 'deploy', from: B });
  const e = msg.embeds[0].toJSON();
  assert.match(e.description, new RegExp(C.slice(0, 12)));
  const buttons = msg.components[0].toJSON().components;
  assert.deepEqual(buttons.map((b) => b.label), ['github ↗']);
});

test('deployMessage: more commits than shown are counted', () => {
  const commits = Array.from({ length: 12 }, (_, i) => commit(sha(String(i % 10)), `c${i}`));
  const msg = deployMessage(project, file(), { kind: 'deploy', from: B, compare: { total_commits: 40, commits } });
  assert.match(msg.embeds[0].toJSON().description, /…and 32 more/);
});

test('failureMessage: names the failed build, redacts the reason and says what is live', () => {
  const f = file({ lastFailedSha: D, lastFailedAt: '2026-09-29T06:00:00Z', lastFailedReason: `npm ci failed token=${'a1'.repeat(15)}` });
  const e = failureMessage(project, f).embeds[0].toJSON();
  assert.equal(e.title, `🧯 dex.place deploy failed · build \`${D.slice(0, 12)}\``);
  assert.match(e.description, /\[redacted\]/);
  assert.match(e.description, new RegExp(`live stays on \`${C.slice(0, 12)}\``));
});

test('scrubPaths: absolute local paths shrink to their last segment', () => {
  assert.equal(
    scrubPaths(String.raw`EBUSY: resource busy or locked, rmdir 'D:\Dex\Servers\dex.place\builds\9243cba8483c\node_modules\esbuild'`),
    "EBUSY: resource busy or locked, rmdir '…/esbuild'",
  );
  assert.equal(scrubPaths("fatal: could not create work tree dir 'D:/Dex/Servers/dex.place/builds/abc': Permission denied"), "fatal: could not create work tree dir '…/abc': Permission denied");
  assert.equal(scrubPaths(String.raw`open \\nas\share\state.json failed`), 'open …/state.json failed');
  assert.equal(scrubPaths(String.raw`lstat \\?\C:\Users\dex\x.log`), 'lstat …/x.log');
  assert.equal(scrubPaths(String.raw`cd C:\ then`), 'cd … then');
  // URLs, URL paths and plain text stay as they are
  assert.equal(scrubPaths('smoke: GET /api/health failed: https://dex.place/x 502'), 'smoke: GET /api/health failed: https://dex.place/x 502');
  assert.equal(scrubPaths(null), '');
});

test('failureMessage: local paths in the reason never reach Discord', () => {
  const f = file({ lastFailedSha: D, lastFailedAt: '2026-09-29T06:00:00Z', lastFailedReason: String.raw`EPERM: operation not permitted, unlink 'D:\Dex\Servers\dex.place\builds\x\dist\index.html'` });
  const e = failureMessage(project, f).embeds[0].toJSON();
  assert.doesNotMatch(e.description, /D:|Dex|Servers/);
  assert.match(e.description, /unlink '…\/index\.html'/);
});

test('withRolePing pings exactly one role', () => {
  assert.deepEqual(withRolePing({}, '7'), { content: '<@&7>', allowedMentions: { roles: ['7'] } });
  assert.deepEqual(withRolePing({ a: 1 }, null), { a: 1 });
});
