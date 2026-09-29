import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import status, { HELP_SECTIONS, buildHelpEmbed, buildStatusEmbed, jobLines, latestPush, openPulls, projectStatus } from '../src/modules/status.mjs';
import { pollReport, pollTargets } from '../src/modules/admin.mjs';

const { projects } = JSON.parse(fs.readFileSync(new URL('../config/projects.json', import.meta.url), 'utf8'));
const [dexcode, dexclient, dexplace] = projects;

const heads = {
  dexcode: {
    defaultBranch: 'master',
    branches: { master: 'a'.repeat(40), 'ow10/c35-integration': 'b'.repeat(40), 'feat/secret-sauce': 'c'.repeat(40) },
    pushedAt: { master: '2026-09-28T10:00:00Z', 'ow10/c35-integration': '2026-09-29T09:00:00Z' },
    seededAt: '2026-09-20T00:00:00Z',
  },
  dexclient: { defaultBranch: 'main', branches: { main: 'd'.repeat(40) }, pushedAt: {}, seededAt: '2026-09-20T00:00:00Z' },
};
const activity = {
  dexcode: { pulls: { 12: { state: 'open', title: 'secret refactor' }, 15: { state: 'open', draft: true, title: 'wip' }, 3: { state: 'closed' } } },
  dexclient: { pulls: {} },
};
const deploys = { dexplace: { lastSha: 'e'.repeat(40), lastDeployedAt: '2026-09-29T08:00:00Z', seen: [], history: [] } };
const jobs = [
  { name: 'feed', lastRun: new Date('2026-09-29T11:59:00Z'), lastError: null, running: false },
  { name: 'activity', lastRun: null, lastError: 'GitHub GET /repos/x/compare/feat/secret-sauce: 500', running: false },
  { name: 'deploys', lastRun: null, lastError: null, running: true },
  { name: 'digest', lastRun: null, lastError: null, running: false },
];
const base = { projects, heads, activity, deploys, jobs, rate: { remaining: 4321, resetAt: Date.parse('2026-09-29T13:00:00Z') }, startedAt: new Date('2026-09-29T06:00:00Z'), now: Date.parse('2026-09-29T12:00:00Z') };

function allText(embed) {
  return JSON.stringify(embed.toJSON());
}

test('latestPush and openPulls read feed/activity state', () => {
  assert.deepEqual(latestPush(heads.dexcode.pushedAt), { branch: 'ow10/c35-integration', at: '2026-09-29T09:00:00Z' });
  assert.equal(latestPush({}), null);
  assert.equal(latestPush(undefined), null);
  assert.deepEqual(openPulls(activity.dexcode.pulls), { numbers: [12, 15], drafts: 1 });
  assert.deepEqual(openPulls(undefined), { numbers: [], drafts: 0 });
});

test('staff status shows default branch, head sha, last pushed branch, PR links and deploy sha', () => {
  const text = projectStatus(dexcode, { head: heads.dexcode, act: activity.dexcode, staff: true });
  assert.ok(text.includes('`master` @ [`aaaaaaa`](https://github.com/dexnotavailable/dexcode/commit/'));
  assert.ok(text.includes('3 branches tracked · last push `ow10/c35-integration` <t:'));
  assert.ok(text.includes('2 open prs (1 draft): [#12](https://github.com/dexnotavailable/dexcode/pull/12) [#15]'));
  const deploy = projectStatus(dexplace, { deploy: deploys.dexplace, staff: true });
  assert.ok(deploy.includes('feed not seeded yet'));
  assert.ok(deploy.includes('prs not seeded yet'));
  assert.ok(deploy.includes('deployed [`eeeeeee`]'));
});

test('non-staff status is counts and times only', () => {
  const embed = buildStatusEmbed({ ...base, staff: false });
  const text = allText(embed);
  for (const secret of ['master', 'ow10', 'secret-sauce', 'aaaaaaa', 'eeeeeee', 'secret refactor', '#12', '/repos/']) {
    assert.ok(!text.includes(secret), `leaked ${secret}`);
  }
  assert.ok(text.includes('3 branches tracked'));
  assert.ok(text.includes('2 open prs'));
  assert.ok(text.includes('failing'));
  assert.match(embed.toJSON().footer.text, /counts only/);
});

test('status embed reports health, pollers and limits', () => {
  const e = buildStatusEmbed({ ...base, staff: true }).toJSON();
  assert.equal(e.fields.length, projects.length + 2);
  assert.equal(e.description, 'something is on fire. details below.');
  const gojo = e.fields.find((f) => f.name === 'gojo').value;
  assert.ok(gojo.includes('feeds live'));
  assert.ok(gojo.includes('4,321 calls left'));
  const pollers = e.fields.find((f) => f.name === 'pollers').value.split('\n');
  assert.ok(pollers[0].startsWith('✅ `feed` <t:'));
  assert.ok(pollers[1].startsWith('❌ `activity` GitHub GET'));
  assert.equal(pollers[2], '⏳ `deploys` running');
  assert.equal(pollers[3], '· `digest` not run yet');
  for (const f of e.fields) assert.ok(f.value.length <= 1024);
  assert.equal(e.footer, undefined);

  const paused = buildStatusEmbed({ ...base, jobs: [], paused: true, rate: {} }).toJSON();
  assert.match(paused.description, /paused/);
  assert.ok(paused.fields.find((f) => f.name === 'gojo').value.includes('**paused**'));
  assert.ok(paused.fields.find((f) => f.name === 'gojo').value.includes('no calls yet'));
  assert.match(jobLines([]), /no pollers/);
});

test('status survives huge state without breaking field limits', () => {
  const branches = {};
  const pushedAt = {};
  const pulls = {};
  for (let i = 0; i < 500; i += 1) {
    branches[`branch-${'x'.repeat(200)}-${i}`] = 'f'.repeat(40);
    pushedAt[`branch-${'x'.repeat(200)}-${i}`] = new Date(Date.UTC(2026, 8, 1) + i * 60_000).toISOString();
    pulls[i + 1] = { state: 'open' };
  }
  const e = buildStatusEmbed({ ...base, heads: { dexcode: { defaultBranch: 'master', branches, pushedAt } }, activity: { dexcode: { pulls } }, staff: true }).toJSON();
  for (const f of e.fields) assert.ok(f.value.length <= 1024, f.name);
});

test('help lists every command once, grouped, within embed limits', () => {
  const channelIds = { rlhf: '1', 'red-team': '2' };
  const e = buildHelpEmbed({ mention: (k) => `<#${channelIds[k]}>`, staffName: 'member of technical staff' }).toJSON();
  const required = ['/help', '/status', '/feedback new', '/feedback track', '/feedback ship', '/access request', '/access status', '/clone', '/standup', '/source', '/diff', '/commits', '/branches', '/worktree list', '/worktree diff', '/review', '/hire', '/fire', '/admin'];
  const listed = HELP_SECTIONS.flatMap((s) => s.commands.map(([cmd]) => cmd));
  for (const cmd of required) assert.equal(listed.filter((c) => c === cmd).length, 1, cmd);
  assert.deepEqual(e.fields.map((f) => f.name), ['everyone', 'member of technical staff', 'the board (owner)']);
  const text = JSON.stringify(e);
  assert.ok(text.includes('<#1>') && text.includes('<#2>'));
  assert.ok(!/\{[a-z-]+\}/.test(text), 'no unfilled placeholders');
  assert.ok(e.description.length <= 4096);
  for (const f of e.fields) assert.ok(f.value.length <= 1024 && f.name.length <= 256);
  const size = e.title.length + e.description.length + e.fields.reduce((n, f) => n + f.name.length + f.value.length, 0);
  assert.ok(size <= 6000);
  // /help lines stay one short line each
  for (const s of HELP_SECTIONS) for (const [, what] of s.commands) assert.ok(what.length <= 70, what);
});

test('status module registers /status and /help plus the help button', () => {
  assert.deepEqual(status.commands().map((c) => c.toJSON().name), ['status', 'help']);
  assert.equal(typeof status.components.help, 'function');
});

test('admin poll helpers pick the pollers and report each run', () => {
  const names = pollTargets([{ name: 'feed' }, { name: 'feed-dexcode' }, { name: 'activity' }, { name: 'deploys' }, { name: 'digest' }, { name: 'feedback-issues' }]);
  assert.deepEqual(names, ['feed', 'feed-dexcode', 'activity', 'deploys']);
  const report = pollReport(
    [
      { name: 'feed', ran: true, ms: 1234 },
      { name: 'activity', ran: false, ms: 0 },
      { name: 'deploys', ran: true, ms: 10, error: `boom ghp_${'c3'.repeat(18)}` },
    ],
    { paused: true },
  );
  const lines = report.split('\n');
  assert.equal(lines[0], '✅ `feed` ran in 1.2s');
  assert.equal(lines[1], '⏳ `activity` was already running');
  assert.equal(lines[2], '❌ `deploys`: boom [redacted]');
  assert.match(lines[3], /paused/);
  assert.match(pollReport([]), /no pollers/);
});
