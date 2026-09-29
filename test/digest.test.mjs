import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildStandup,
  countDeploys,
  countPulls,
  dayOfYear,
  localParts,
  openFeedback,
  projectLines,
  quietLine,
  shouldPost,
  standupTitle,
  summarise,
} from '../src/modules/digest.mjs';

const TZ = 'Asia/Ho_Chi_Minh'; // UTC+7, no DST
const NOW = new Date('2026-09-29T03:30:00Z'); // 10:30 local, tuesday
const window = { from: NOW.getTime() - 86_400_000, to: NOW.getTime() };
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

// ------------------------------------------------------------------ time

test('localParts: wall-clock date and hour in the configured zone', () => {
  assert.deepEqual(localParts(NOW, TZ), { date: '2026-09-29', year: 2026, month: 9, day: 29, hour: 10, weekday: 'tue' });
});

test('localParts: local midnight is hour 0 and already the next day', () => {
  const p = localParts(new Date('2026-09-28T17:05:00Z'), TZ);
  assert.equal(p.date, '2026-09-29');
  assert.equal(p.hour, 0);
});

test('localParts: DST zones follow the offset change', () => {
  // Europe/Berlin is UTC+2 in summer and UTC+1 after the last Sunday of October.
  assert.equal(localParts(new Date('2026-10-24T08:00:00Z'), 'Europe/Berlin').hour, 10);
  assert.equal(localParts(new Date('2026-10-26T08:00:00Z'), 'Europe/Berlin').hour, 9);
});

test('shouldPost: only inside [hour, hour + 3) and once per local date', () => {
  const at = (hour, date = '2026-09-29') => ({ date, hour });
  assert.equal(shouldPost({}, at(9), 10), false);
  assert.equal(shouldPost({}, at(10), 10), true);
  assert.equal(shouldPost({ lastPostedDate: '2026-09-28' }, at(12), 10), true);
  assert.equal(shouldPost({ lastPostedDate: '2026-09-29' }, at(11), 10), false);
  assert.equal(shouldPost({}, at(13), 10), false);
  assert.equal(shouldPost(undefined, at(10), 10), true);
});

test('dayOfYear and quietLine are deterministic per date', () => {
  assert.equal(dayOfYear({ year: 2026, month: 1, day: 1 }), 1);
  assert.equal(dayOfYear({ year: 2026, month: 12, day: 31 }), 365);
  assert.equal(dayOfYear({ year: 2028, month: 12, day: 31 }), 366);
  const p = localParts(NOW, TZ);
  assert.equal(quietLine(p), quietLine({ ...p }));
  assert.notEqual(quietLine(p), quietLine({ ...p, day: 30 }));
});

test('standupTitle: weekday, day and short month, lowercase', () => {
  assert.equal(standupTitle(localParts(NOW, TZ)), '☀️ daily standup · tue, 29 sep');
});

// ------------------------------------------------------------------ counting

const entries = [
  { project: 'dexcode', branch: 'main', commits: 5, authors: ['dex', 'claude'], additions: 100, deletions: 10, at: hoursAgo(1) },
  { project: 'dexcode', branch: 'ow10/c35', commits: 7, authors: ['dex'], additions: 50, deletions: 5, at: hoursAgo(2) },
  { project: 'dexcode', branch: 'main', commits: 3, authors: ['dex'], additions: 1, deletions: 1, at: hoursAgo(3) },
  { project: 'dexcode', branch: 'fix/a', commits: 1, authors: [], additions: 0, deletions: 0, at: hoursAgo(4) },
  { project: 'dexcode', branch: 'fix/b', commits: 1, authors: [], additions: 0, deletions: 0, at: hoursAgo(5) },
  { project: 'dexcode', branch: 'new-branch', commits: 0, authors: [], additions: 0, deletions: 0, at: hoursAgo(5), created: true },
  { project: 'dexclient', branch: 'main', commits: [{}, {}], authors: ['dex'], additions: 2, deletions: 0, at: hoursAgo(6) },
  { project: 'dexclient', branch: 'main', commits: 9, authors: ['old'], additions: 9, deletions: 9, at: hoursAgo(30) },
];

test('summarise: pushes, commits, churn, distinct authors and top 3 branches inside the window', () => {
  const s = summarise(entries, window);
  assert.deepEqual(Object.keys(s).sort(), ['dexclient', 'dexcode']);
  assert.equal(s.dexcode.pushes, 5);
  assert.equal(s.dexcode.commits, 17);
  assert.equal(s.dexcode.additions, 151);
  assert.equal(s.dexcode.deletions, 16);
  assert.deepEqual(s.dexcode.authors.sort(), ['claude', 'dex']);
  assert.deepEqual(s.dexcode.topBranches, [
    { name: 'main', commits: 8 },
    { name: 'ow10/c35', commits: 7 },
    { name: 'fix/a', commits: 1 },
  ]);
  // commits given as a list count too; the 30 h old push is outside the window
  assert.equal(s.dexclient.commits, 2);
  assert.equal(s.dexclient.pushes, 1);
  assert.deepEqual(s.dexclient.authors, ['dex']);
});

test('summarise: resets, renames and same-sha branches (0 commits) are not pushes', () => {
  const quiet = [
    { project: 'dexcode', branch: 'main', commits: 0, authors: [], additions: 0, deletions: 0, at: hoursAgo(1), forced: true },
    { project: 'dexcode', branch: 'renamed', commits: 0, authors: [], additions: 0, deletions: 0, at: hoursAgo(2), created: true },
  ];
  assert.deepEqual(summarise(quiet, window), {});
  const s = summarise([...quiet, entries[0]], window);
  assert.equal(s.dexcode.pushes, 1);
  assert.deepEqual(s.dexcode.topBranches, [{ name: 'main', commits: 5 }]);
});

test('summarise: nothing in the window gives an empty object', () => {
  assert.deepEqual(summarise([], window), {});
  assert.deepEqual(summarise(undefined, window), {});
});

test('countPulls, countDeploys and openFeedback', () => {
  const pulls = {
    1: { openedAt: hoursAgo(2), mergedAt: null },
    2: { openedAt: hoursAgo(50), mergedAt: hoursAgo(1) },
    3: { openedAt: hoursAgo(3), mergedAt: hoursAgo(2) },
    4: { openedAt: hoursAgo(100), mergedAt: hoursAgo(90) },
  };
  assert.deepEqual(countPulls(pulls, window), { opened: 2, merged: 2 });
  assert.deepEqual(countPulls(undefined, window), { opened: 0, merged: 0 });
  assert.equal(countDeploys([{ at: hoursAgo(1) }, { at: hoursAgo(23) }, { at: hoursAgo(25) }], window), 2);
  assert.deepEqual(
    openFeedback({ a: { project: 'dexcode', status: 'open' }, b: { project: 'dexcode', status: 'tracked' }, c: { project: 'dexplace', status: 'shipped' }, d: { project: null, status: 'open' } }),
    { dexcode: 2 },
  );
});

test('projectLines: null for a quiet project, compact lines otherwise', () => {
  assert.equal(projectLines({ push: undefined, pulls: { opened: 0, merged: 0 }, deploys: 0 }), null);
  const text = projectLines({
    push: { pushes: 1, commits: 1, additions: 3, deletions: 0, authors: ['a', 'b', 'c', 'd'], topBranches: [{ name: 'we`ird', commits: 1 }] },
    pulls: { opened: 1, merged: 0 },
    deploys: 2,
  });
  assert.equal(text, ['1 push · 1 commit · +3 −0', 'by **a**, **b**, **c** +1', '`weˋird` 1', 'PRs: 1 opened · 0 merged', '🌐 2 deploys'].join('\n'));
});

// ------------------------------------------------------------------ buildStandup

const projects = [
  { key: 'dexcode', name: 'dexCode', emoji: '🧠' },
  { key: 'dexclient', name: 'dexClient', emoji: '📦' },
  { key: 'dexplace', name: 'dex.place', emoji: '🌐' },
];

function fakeCtx(data, rlhfId = '555') {
  return {
    config: { projects, digest: { hour: 10, timezone: TZ } },
    state: { exists: (ns) => ns in data, get: (ns) => data[ns] },
    guildCtx: { channelId: (key) => (key === 'rlhf' ? rlhfId : null) },
  };
}

test('buildStandup: one field per active project, feedback backlog and totals', () => {
  const ctx = fakeCtx({
    pushlog: { entries },
    activity: { dexclient: { pulls: { 3: { openedAt: hoursAgo(3), mergedAt: hoursAgo(2) } } } },
    deploys: { dexplace: { history: [{ sha: 'x', at: hoursAgo(1) }] } },
    feedback: { threads: { t1: { project: 'dexcode', status: 'open' }, t2: { project: 'dexplace', status: 'tracked' } } },
  });
  const e = buildStandup(ctx, NOW).embeds[0].toJSON();
  assert.equal(e.title, '☀️ daily standup · tue, 29 sep');
  assert.deepEqual(e.fields.map((f) => f.name), ['🧠 dexCode', '📦 dexClient', '🌐 dex.place']);
  assert.match(e.fields[1].value, /PRs: 1 opened · 1 merged/);
  assert.equal(e.fields[2].value, '🌐 1 deploy');
  assert.equal(e.description, 'open in <#555>: 🧠 1 · 🌐 1');
  assert.equal(e.footer.text, 'last 24 h · 6 pushes · 19 commits · 1 merged · 1 deploy');
  assert.equal(e.timestamp, NOW.toISOString());
});

test('buildStandup: a quiet day says so and reads no missing namespaces into existence', () => {
  const data = {};
  const e = buildStandup(fakeCtx(data, null), NOW).embeds[0].toJSON();
  assert.equal(e.fields, undefined);
  assert.equal(e.description, `*${quietLine(localParts(NOW, TZ))}*`);
  assert.match(e.footer.text, /^last 24 h · 0 pushes · 0 commits · 0 merged · 0 deploys$/);
  assert.deepEqual(data, {});
});

test('buildStandup: feedback without a known #rlhf id falls back to plain text', () => {
  const ctx = fakeCtx({ feedback: { threads: { t: { project: 'dexclient', status: 'open' } } } }, null);
  const e = buildStandup(ctx, NOW).embeds[0].toJSON();
  assert.match(e.description, /\nopen in #rlhf: 📦 1$/);
});
