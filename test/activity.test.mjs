import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyRuns,
  diffIssues,
  diffPulls,
  issueEvent,
  issueMessage,
  pullMessage,
  pullRecord,
  runMessage,
  withChanges,
  withRolePing,
} from '../src/modules/activity.mjs';

const project = { key: 'dexclient', name: 'dexClient', repo: 'dexnotavailable/dexclient', emoji: '📦', color: '#22c55e', feedChannel: 'ships-dexclient', pingRole: 'ping-dexclient' };
const NOW = Date.parse('2026-09-29T12:00:00Z');
const SEEDED = '2026-09-29T00:00:00.000Z';
const iso = (hoursAgo) => new Date(NOW - hoursAgo * 3_600_000).toISOString();

function pr(number, fields = {}) {
  return {
    number,
    state: 'open',
    draft: false,
    title: `pr ${number}`,
    created_at: iso(2),
    updated_at: iso(1),
    merged_at: null,
    closed_at: null,
    html_url: `https://github.com/dexnotavailable/dexclient/pull/${number}`,
    user: { login: 'dexnotavailable', avatar_url: 'https://avatars.githubusercontent.com/u/1', html_url: 'https://github.com/dexnotavailable' },
    head: { ref: 'claude/feature', sha: 'a'.repeat(40) },
    base: { ref: 'main', sha: 'b'.repeat(40) },
    body: 'does a thing',
    ...fields,
  };
}

const stored = (...prs) => Object.fromEntries(prs.map((p) => [p.number, pullRecord(p)]));
const types = (events) => events.map((e) => `${e.type}#${e.number}`);

// ------------------------------------------------------------------ diffPulls

test('diffPulls: a new open PR created after seeding is "opened"', () => {
  const { events, pulls } = diffPulls({}, [pr(5)], SEEDED, NOW);
  assert.deepEqual(types(events), ['opened#5']);
  assert.equal(pulls[5].state, 'open');
  assert.equal(pulls[5].openedAt, iso(2));
});

test('diffPulls: an unseen PR from before seeding stays silent', () => {
  const old = pr(3, { created_at: '2026-09-20T00:00:00Z' });
  const { events, pulls } = diffPulls({}, [old], SEEDED, NOW);
  assert.deepEqual(events, []);
  assert.ok(pulls[3]);
});

test('diffPulls: draft -> ready, merge, close and reopen', () => {
  const before = stored(pr(1, { draft: true }), pr(2), pr(3), pr(4, { state: 'closed', closed_at: iso(5) }));
  const list = [
    pr(1, { draft: false }),
    pr(2, { state: 'closed', merged_at: iso(0.5), closed_at: iso(0.5) }),
    pr(3, { state: 'closed', closed_at: iso(0.4) }),
    pr(4, { state: 'open' }),
  ];
  const { events } = diffPulls(before, list, SEEDED, NOW);
  assert.deepEqual(types(events).sort(), ['closed#3', 'merged#2', 'ready#1', 'reopened#4']);
});

test('diffPulls: a PR merged while still marked draft is "merged"', () => {
  const before = stored(pr(1, { draft: true }));
  const { events } = diffPulls(before, [pr(1, { draft: true, state: 'closed', merged_at: iso(0.1), closed_at: iso(0.1) })], SEEDED, NOW);
  assert.deepEqual(types(events), ['merged#1']);
});

test('diffPulls: opened and merged between two polls posts only the merge', () => {
  const { events } = diffPulls({}, [pr(9, { state: 'closed', merged_at: iso(0.2), closed_at: iso(0.2) })], SEEDED, NOW);
  assert.deepEqual(types(events), ['merged#9']);
});

test('diffPulls: an unseen older PR merged after seeding is news, merged before is not', () => {
  const early = { created_at: '2026-09-01T00:00:00Z', state: 'closed' };
  const after = pr(7, { ...early, merged_at: iso(1), closed_at: iso(1) });
  const before = pr(8, { ...early, merged_at: '2026-09-28T00:00:00Z', closed_at: '2026-09-28T00:00:00Z' });
  const { events } = diffPulls({}, [after, before], SEEDED, NOW);
  assert.deepEqual(types(events), ['merged#7']);
});

test('diffPulls: nothing changed means no events', () => {
  const list = [pr(1), pr(2, { draft: true })];
  const { events } = diffPulls(stored(...list), list, SEEDED, NOW);
  assert.deepEqual(events, []);
});

test('diffPulls: events come oldest update first', () => {
  const list = [pr(2, { created_at: iso(1), updated_at: iso(0.1) }), pr(1, { created_at: iso(3), updated_at: iso(3) })];
  const { events } = diffPulls({}, list, SEEDED, NOW);
  assert.deepEqual(types(events), ['opened#1', 'opened#2']);
});

test('diffPulls: closed records older than 60 days leave state, open ones stay', () => {
  const old = {
    1: { state: 'closed', merged: true, closedAt: '2026-06-01T00:00:00Z', mergedAt: '2026-06-01T00:00:00Z' },
    2: { state: 'open', openedAt: '2026-01-01T00:00:00Z' },
    3: { state: 'closed', merged: false, closedAt: iso(24 * 10) },
  };
  const { pulls } = diffPulls(old, [], SEEDED, NOW);
  assert.deepEqual(Object.keys(pulls).sort(), ['2', '3']);
});

// ------------------------------------------------------------------ diffIssues

function issue(number, fields = {}) {
  return {
    number,
    state: 'open',
    state_reason: null,
    title: `issue ${number}`,
    created_at: iso(2),
    updated_at: iso(1),
    closed_at: null,
    html_url: `https://github.com/dexnotavailable/dexclient/issues/${number}`,
    user: { login: 'someone' },
    labels: [{ name: 'bug' }],
    body: 'it broke',
    ...fields,
  };
}

test('diffIssues: opened, closed and reopened against stored state', () => {
  const before = { 1: { state: 'open' }, 2: { state: 'closed' } };
  const list = [issue(1, { state: 'closed', closed_at: iso(0.5) }), issue(2), issue(3)];
  const { events, issues } = diffIssues(before, list, SEEDED, NOW);
  assert.deepEqual(types(events).sort(), ['closed#1', 'opened#3', 'reopened#2']);
  assert.equal(issues[1].state, 'closed');
});

test('diffIssues: created and closed between polls posts both', () => {
  const { events } = diffIssues({}, [issue(4, { state: 'closed', closed_at: iso(0.5) })], SEEDED, NOW);
  assert.deepEqual(types(events), ['opened#4', 'closed#4']);
});

test('diffIssues: an unseen old issue closed after seeding is "closed"; untouched old ones are silent', () => {
  const early = { created_at: '2026-08-01T00:00:00Z' };
  const list = [issue(5, { ...early, state: 'closed', closed_at: iso(1) }), issue(6, early), issue(7, { ...early, state: 'closed', closed_at: '2026-08-02T00:00:00Z' })];
  const { events } = diffIssues({}, list, SEEDED, NOW);
  assert.deepEqual(types(events), ['closed#5']);
});

test('diffIssues: unchanged issues stay quiet', () => {
  const { events } = diffIssues({ 1: { state: 'open' } }, [issue(1)], SEEDED, NOW);
  assert.deepEqual(events, []);
});

// ------------------------------------------------------------------ classifyRuns

let nextId = 100;
function run(fields = {}) {
  nextId += 1;
  return {
    id: nextId,
    name: 'Publish branch head',
    workflow_id: 365940020,
    head_branch: 'main',
    head_sha: 'c'.repeat(40),
    status: 'completed',
    conclusion: 'success',
    run_attempt: 1,
    run_number: nextId,
    event: 'push',
    display_title: 'fix: the thing',
    created_at: iso(1),
    run_started_at: iso(1),
    html_url: `https://github.com/dexnotavailable/dexclient/actions/runs/${nextId}`,
    ...fields,
  };
}

const runTypes = (events) => events.map((e) => `${e.type}:${e.run.head_branch}`);

test('classifyRuns: failures post, plain successes stay silent', () => {
  const runs = [run({ conclusion: 'failure' }), run({ head_branch: 'dev' }), run({ conclusion: 'timed_out', head_branch: 'x' })];
  const { events, runs: state } = classifyRuns({ seen: [], last: {} }, runs, SEEDED);
  assert.deepEqual(runTypes(events).sort(), ['failed:main', 'failed:x']);
  assert.equal(state.seen.length, 3);
  assert.equal(state.last['365940020:main'], 'failure');
  assert.equal(state.last['365940020:dev'], 'success');
});

test('classifyRuns: success after a failure on the same workflow and branch is "recovered"', () => {
  const failed = run({ conclusion: 'failure', run_started_at: iso(3), created_at: iso(3) });
  const first = classifyRuns({ seen: [], last: {} }, [failed], SEEDED);
  const other = run({ head_branch: 'dev' });
  const fixed = run({ run_started_at: iso(1), created_at: iso(1) });
  const second = classifyRuns(first.runs, [fixed, other, failed], SEEDED);
  assert.deepEqual(runTypes(second.events), ['recovered:main']);
  assert.equal(second.runs.last['365940020:main'], 'success');
  // a second green run is silent again
  const third = classifyRuns(second.runs, [run({ run_started_at: iso(0.5) }), fixed], SEEDED);
  assert.deepEqual(third.events, []);
});

test('classifyRuns: failure and fix in one batch are handled in time order', () => {
  const fix = run({ run_started_at: iso(1) });
  const fail = run({ conclusion: 'failure', run_started_at: iso(2) });
  const { events } = classifyRuns({ seen: [], last: {} }, [fix, fail], SEEDED);
  assert.deepEqual(events.map((e) => e.type), ['failed', 'recovered']);
});

test('classifyRuns: skips seen, unfinished and pre-seed runs; a re-run attempt is new', () => {
  const seenRun = run({ conclusion: 'failure' });
  const runs = [
    seenRun,
    run({ status: 'in_progress', conclusion: null }),
    run({ conclusion: 'failure', created_at: '2026-09-28T00:00:00Z', run_started_at: '2026-09-28T00:00:00Z' }),
    { ...seenRun, run_attempt: 2, run_started_at: iso(0.2) },
  ];
  const { events, runs: state } = classifyRuns({ seen: [String(seenRun.id)], last: {} }, runs, SEEDED);
  assert.equal(events.length, 1);
  assert.equal(events[0].run.run_attempt, 2);
  assert.ok(state.seen.includes(`${seenRun.id}.2`));
});

test('classifyRuns: seeding (no seededAt) records conclusions so a later fix reads as recovered', () => {
  const failing = run({ conclusion: 'failure', created_at: '2026-09-01T00:00:00Z', run_started_at: '2026-09-01T00:00:00Z' });
  const seeded = classifyRuns({}, [failing], null).runs;
  assert.equal(seeded.last['365940020:main'], 'failure');
  const { events } = classifyRuns(seeded, [run(), failing], SEEDED);
  assert.deepEqual(runTypes(events), ['recovered:main']);
});

test('classifyRuns: seen ids are capped at 200', () => {
  const seen = Array.from({ length: 200 }, (_, i) => `old${i}`);
  const { runs: state } = classifyRuns({ seen, last: {} }, [run(), run()], SEEDED);
  assert.equal(state.seen.length, 200);
  assert.equal(state.seen[0], 'old2');
});

test('classifyRuns: cancelled runs do not clear a failure', () => {
  const state = { seen: [], last: { '365940020:main': 'failure' } };
  const cancelled = run({ conclusion: 'cancelled', run_started_at: iso(2) });
  const green = run({ run_started_at: iso(1) });
  const { events } = classifyRuns(state, [cancelled, green], SEEDED);
  assert.deepEqual(events.map((e) => e.type), ['recovered']);
});

// ------------------------------------------------------------------ messages

test('pullMessage: opened has a feed diff button keyed by base/head sha prefixes', () => {
  const msg = pullMessage(project, 'opened', pr(12, { draft: true, changed_files: 3, additions: 10, deletions: 2 }));
  const embed = msg.embeds[0].toJSON();
  assert.match(embed.title, /^🔀 draft PR #12 opened: pr 12$/);
  assert.equal(embed.description, 'does a thing');
  assert.equal(embed.author.name, 'dexnotavailable');
  assert.ok(embed.fields.some((f) => f.name === 'branches' && f.value === '`claude/feature` → `main`'));
  assert.ok(embed.fields.some((f) => f.name === 'changes' && f.value.startsWith('3 files')));
  const buttons = msg.components[0].toJSON().components;
  assert.equal(buttons[0].url, 'https://github.com/dexnotavailable/dexclient/pull/12');
  assert.equal(buttons[1].custom_id, `feed:diff:dexclient:${'b'.repeat(12)}:${'a'.repeat(12)}`);
});

test('pullMessage: merged names the base and has only the link button; titles are redacted', () => {
  const secret = `ghp_${'A1'.repeat(18)}`;
  const msg = pullMessage(project, 'merged', pr(4, { title: `leak ${secret}`, state: 'closed', merged_at: iso(0.1) }));
  const embed = msg.embeds[0].toJSON();
  assert.match(embed.title, /^✅ PR #4 merged into main: leak \[redacted\]$/);
  assert.equal(msg.components[0].toJSON().components.length, 1);
  assert.equal(embed.description, undefined);
});

test('pullMessage: titles are capped at 256 chars', () => {
  const embed = pullMessage(project, 'closed', pr(1, { title: 'x'.repeat(400) })).embeds[0].toJSON();
  assert.ok(embed.title.length <= 256);
});

const quietLog = { debug() {} };

test('withChanges: adds the file/line counts the pulls list leaves out', async () => {
  const asked = [];
  const ctx = { github: { get: async (path) => (asked.push(path), { changed_files: 7, additions: 468, deletions: 1, state: 'closed' }) } };
  const listItem = pr(2, { changed_files: undefined });
  const full = await withChanges(ctx, project, listItem, quietLog);
  assert.deepEqual(asked, ['/repos/dexnotavailable/dexclient/pulls/2']);
  assert.equal(full.changed_files, 7);
  assert.equal(full.state, 'open'); // only the counts are taken from the second read
  const e = pullMessage(project, 'opened', full).embeds[0].toJSON();
  assert.ok(e.fields.some((f) => f.name === 'changes' && f.value === '7 files · +468 −1'));
});

test('withChanges: a failed lookup still posts, just without the changes field', async () => {
  const ctx = { github: { get: async () => { throw new Error('502'); } } };
  const listItem = pr(3);
  assert.equal(await withChanges(ctx, project, listItem, quietLog), listItem);
  const e = pullMessage(project, 'opened', listItem).embeds[0].toJSON();
  assert.ok(!e.fields.some((f) => f.name === 'changes'));
});

test('issueEvent: closed carries closedBy and the GitHub state_reason; reopened stays plain', () => {
  const closed = issue(8, { state: 'closed', state_reason: 'not_planned', closed_at: iso(0.1) });
  assert.deepEqual(issueEvent(project, 'closed', closed, 'dex'), {
    project: 'dexclient',
    number: 8,
    title: 'issue 8',
    url: 'https://github.com/dexnotavailable/dexclient/issues/8',
    closedBy: 'dex',
    reason: 'not_planned',
  });
  assert.equal(issueEvent(project, 'closed', issue(9, { state: 'closed' })).reason, null);
  assert.deepEqual(Object.keys(issueEvent(project, 'reopened', issue(8))), ['project', 'number', 'title', 'url']);
});

test('withRolePing pings exactly the role, or nothing without an id', () => {
  const payload = { embeds: [] };
  assert.deepEqual(withRolePing(payload, '42'), { embeds: [], content: '<@&42>', allowedMentions: { roles: ['42'] } });
  assert.equal(withRolePing(payload, null), payload);
});

test('issueMessage: opened shows labels, closed-as-not-planned says so', () => {
  const opened = issueMessage(project, 'opened', issue(3)).embeds[0].toJSON();
  assert.equal(opened.title, '📝 issue #3 opened: issue 3');
  assert.ok(opened.fields.some((f) => f.name === 'labels' && f.value === '`bug`'));
  const closed = issueMessage(project, 'closed', issue(3, { state: 'closed', state_reason: 'not_planned', closed_at: iso(0.1) }), { closedBy: 'dex' }).embeds[0].toJSON();
  assert.equal(closed.title, '🗑️ issue #3 closed as not planned: issue 3');
  assert.equal(closed.description, 'closed by **dex**');
});

test('runMessage: failure and recovery titles with a run link', () => {
  const failed = runMessage(project, 'failed', run({ conclusion: 'timed_out' }));
  const e = failed.embeds[0].toJSON();
  assert.equal(e.title, '❌ Publish branch head failed on main');
  assert.match(e.description, /timed out · push · run #\d+/);
  assert.equal(failed.components[0].toJSON().components[0].label, 'run ↗');
  const green = runMessage(project, 'recovered', run()).embeds[0].toJSON();
  assert.equal(green.title, '✅ Publish branch head is green again on main');
});
