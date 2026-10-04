import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { StdioMcpClient, NativeMcpError, nativePayload, readBinding, OFFICIAL_SERVER, dispatchReceipt } from '../ops/codex-native-mcp.mjs';
import { processPending, resolveTarget, validateIngress, explicitReplies, brokerStatus } from '../ops/gojo-relay-broker.mjs';
import { writeReply, atomicRecord, boundedJson } from '../ops/gojo-reply.mjs';
import { bindNative } from '../ops/gojo-bind-native.mjs';

const NOW = Date.parse('2026-10-04T12:00:00Z');
const ORIGIN = '01a10540-e94a-7040-869b-3285c43cf8c5';
const TARGET = '01a10428-5deb-7933-84bf-4afe68e160d1';
const CLAUDE = '11111111-2222-3333-4444-555555555555';
const REPORT = 'r-0123456789abcdef01234567';
const FOLLOWUP = 'f-0123456789abcdef01234567';
const source = { guildId: '11111111111111111', channelId: '22222222222222222', messageId: '33333333333333333', userId: '44444444444444444', private: false, reporterName: 'reporter' };
const report = (id = REPORT, extra = {}) => ({ version: 1, type: 'report', id, project: 'dexcode', kind: 'bug', priority: 'normal', content: 'dexCode crashes when opening a file', createdAt: new Date(NOW).toISOString(), source: { ...source }, trust: 'untrusted-report-data', ...extra });
function fixture(t, { acceptance = false } = {}) {
  const parent = acceptance ? 'D:\\Dex\\Temp' : 'D:\\Dex\\Temp\\gojo-relay-tests'; fs.mkdirSync(parent, { recursive: true });
  const home = fs.mkdtempSync(path.join(parent, acceptance ? 'gojo-relay-acceptance-test-' : 'case-'));
  const root = path.join(home, 'gojo', 'relay'); const ledgerRoot = path.join(home, 'ledger');
  for (const dir of ['inbox', 'outbox']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.mkdirSync(path.join(ledgerRoot, 'current'), { recursive: true });
  atomicRecord(path.join(ledgerRoot, 'projects.json'), { projects: [{ project_id: 'be7ade8c-8537-5415-89b9-07df371d1c14', record_type: 'project', slug: 'dexcode', status: 'active', active_threads: [TARGET] }] });
  fs.writeFileSync(path.join(ledgerRoot, 'current', 'be7ade8c-8537-5415-89b9-07df371d1c14.md'), `# dexCode\n\n## Active threads\n\n- ${TARGET}\n\n## Lanes\n`);
  const ctx = { config: { home, local: { guildId: source.guildId }, gojo: { ledgerRoot, relay: { enabled: true } } }, log: { warn() {} }, dryRun: false };
  const enqueue = (value = report()) => atomicRecord(path.join(root, 'inbox', `${value.id}.json`), value);
  const events = () => fs.readdirSync(path.join(root, 'outbox')).filter((name) => name.endsWith('.json')).map((name) => boundedJson(path.join(root, 'outbox', name)));
  const state = (id = REPORT) => boundedJson(path.join(root, 'broker-state', 'messages', `${id}.json`), 100_000);
  t.after(() => { const resolved = path.resolve(home); if (!resolved.startsWith(path.resolve(parent) + path.sep)) throw new Error('Invalid fixture cleanup'); fs.rmSync(resolved, { recursive: true, force: true }); });
  return { home, root, ledgerRoot, ctx, enqueue, events, state };
}
class FakeNative {
  constructor() { this.binding = { originThreadId: ORIGIN }; this.sends = []; this.messages = new Map(); this.agentItems = []; this.baselineItems = []; this.echo = true; this.throws = false; this.updatedAt = NOW / 1000; this.rows = [{ id: TARGET, kind: 'codex', hostId: 'local', title: 'Review dexCode implementation status', status: 'active', updatedAt: this.updatedAt }]; this.calls = []; }
  async call(name, args) {
    this.calls.push({ name, args });
    if (name === 'list_threads') return { pinnedThreads: [], threads: this.rows };
    if (name === 'send_message_to_thread') {
      this.sends.push(args);
      if (this.echo) this.messages.set(args.threadId, [...(this.messages.get(args.threadId) ?? []), args.prompt]);
      this.afterSend?.(args);
      if (this.throws) throw new NativeMcpError('request-timeout');
      return this.response ?? { status: 'sent' };
    }
    if (name === 'read_thread') {
      const row = this.rows.find((value) => value.id === args.threadId);
      const title = row?.title ?? 'Gojo root relay';
      const agents = this.sends.some((send) => send.threadId === args.threadId) ? this.agentItems : this.baselineItems;
      return { thread: { id: args.threadId, title, status: { type: row?.status ?? 'active' }, updatedAt: row?.updatedAt ?? this.updatedAt, hostId: 'local' }, page: { hasMore: false, nextCursor: null }, turns: [{ id: 'turn', status: 'completed', startedAt: NOW, completedAt: NOW + 1000, items: [...(this.messages.get(args.threadId) ?? []).map((text) => ({ type: 'userMessage', content: [{ type: 'text', text }] })), ...agents.map((item, i) => ({ id: `agent-${i}`, ...item }))] }] };
    }
    throw new Error('Unexpected native tool');
  }
}
const run = (f, native, extra = {}) => processPending({ ctx: f.ctx, relayRoot: f.root, native, claudeCandidates: [], now: NOW, ...extra });

test('report reaches only the ledger-listed working native coordinator, persists proof and leaves bot memory alone', async (t) => {
  const f = fixture(t); const n = new FakeNative(); f.enqueue();
  const memory = path.join(f.home, 'gojo', 'memory.json'); fs.writeFileSync(memory, '{"owner":"bot"}');
  const result = await run(f, n);
  assert.equal(result.delivered, 1); assert.equal(n.sends.length, 1); assert.equal(n.sends[0].threadId, TARGET);
  assert.match(n.sends[0].prompt, new RegExp(`\\[GOJO_REPORT:${REPORT}\\]`));
  assert.equal(f.state().status, 'delivered'); assert.equal(f.events()[0].status, 'delivered');
  assert.equal(fs.readFileSync(memory, 'utf8'), '{"owner":"bot"}');
  await run(f, n); assert.equal(n.sends.length, 1); assert.equal(f.events().length, 1);
});
test('lost native acknowledgment is reconciled by the exact native user message without resending', async (t) => {
  const f = fixture(t); const n = new FakeNative(); n.throws = true; f.enqueue();
  const result = await run(f, n); assert.equal(result.delivered, 1);
  await run(f, n); assert.equal(n.sends.length, 1); assert.equal(f.state().status, 'delivered');
});
test('uncertain sends and marker-only echoes never claim delivery or repeat sends', async (t) => {
  const f = fixture(t); const n = new FakeNative(); n.echo = false; n.throws = true; f.enqueue();
  await run(f, n); assert.equal(f.state().status, 'uncertain'); assert.equal(f.events().length, 0);
  n.messages.set(TARGET, [`[GOJO_REPORT:${REPORT}]`]);
  await run(f, n); assert.equal(f.state().status, 'uncertain'); assert.equal(n.sends.length, 1);
  n.messages.set(TARGET, [f.state().prompt]); await run(f, n);
  assert.equal(f.state().status, 'delivered'); assert.equal(n.sends.length, 1);
});
test('a sending crash checkpoint reconciles before any further native send', async (t) => {
  const f = fixture(t); const n = new FakeNative(); f.enqueue(); await run(f, n);
  const state = f.state(); state.status = 'sending'; atomicRecord(path.join(f.root, 'broker-state', 'messages', `${REPORT}.json`), state);
  await run(f, n); assert.equal(n.sends.length, 1); assert.equal(f.state().status, 'delivered');
});
test('unavailable binding is visible and never becomes queued-as-delivered', async (t) => {
  const f = fixture(t); f.enqueue();
  const result = await processPending({ ctx: f.ctx, relayRoot: f.root, claudeCandidates: [], now: NOW });
  assert.equal(result.status, 'unavailable'); assert.equal(result.code, 'binding-unavailable'); assert.deepEqual(f.events(), []);
  assert.equal(brokerStatus(f.root).binding, 'unavailable');
});
test('report-supplied targets/authority and foreign origins are rejected', async (t) => {
  const f = fixture(t); const n = new FakeNative();
  for (const extra of [{ target: ORIGIN }, { authority: 'owner' }, { source: { ...source, guildId: '55555555555555555' } }]) assert.throws(() => validateIngress(report(REPORT, extra), f.ctx));
  f.enqueue(report(REPORT, { target: ORIGIN })); const result = await run(f, n);
  assert.equal(result.invalid, 1); assert.equal(n.sends.length, 0);
});
test('same cwd and arbitrary active sibling threads cannot select a target without direct owner project evidence', async (t) => {
  const f = fixture(t); const n = new FakeNative();
  n.rows = [{ ...n.rows[0], id: CLAUDE, cwd: 'D:\\Dex\\Temp\\claude-core\\integration' }];
  await assert.rejects(resolveTarget({ native: n, ledgerRoot: f.ledgerRoot, originThreadId: ORIGIN, now: NOW }), /no-working-project-target/);
});
test('a coordinator crowded out of Recents is read directly and list_threads respects its actual schema bound', async (t) => {
  const f = fixture(t); const n = new FakeNative(); n.rows = [];
  const call = n.call.bind(n); n.call = async (name, args) => {
    if (name === 'list_threads') assert.ok(args.limit <= 50);
    const result = await call(name, args);
    if (name === 'read_thread' && args.threadId === TARGET) result.thread.title = 'Review dexCode implementation status';
    return result;
  };
  assert.equal((await resolveTarget({ native: n, ledgerRoot: f.ledgerRoot, originThreadId: ORIGIN, now: NOW })).id, TARGET);
});
test('origin, children, archived/cancelled and project-unverified targets are excluded', async (t) => {
  const f = fixture(t);
  for (const extra of [{ parentThreadId: ORIGIN }, { status: 'cancelled' }, { archived: true }, { title: 'Review unrelated work' }]) {
    const n = new FakeNative(); n.rows = [{ ...n.rows[0], ...extra }];
    await assert.rejects(resolveTarget({ native: n, ledgerRoot: f.ledgerRoot, originThreadId: extra.parentThreadId ? ORIGIN : ORIGIN, now: NOW }), /no-working-project-target/);
  }
  await assert.rejects(resolveTarget({ native: new FakeNative(), ledgerRoot: f.ledgerRoot, originThreadId: TARGET, now: NOW }), /no-working-project-target/);
});
test('the current exact coordinator remains wakeable after completion and across days', async (t) => {
  const f = fixture(t); const n = new FakeNative();
  for (const status of ['idle', 'notLoaded']) {
    n.rows[0].status = status; n.rows[0].updatedAt = (NOW - 4 * 86_400_000) / 1000;
    assert.equal((await resolveTarget({ native: n, ledgerRoot: f.ledgerRoot, originThreadId: ORIGIN, now: NOW })).id, TARGET);
  }
});
test('a newer verified Claude coordinator produces one durable UI wake, never direct UI automation or premature delivery', async (t) => {
  const f = fixture(t); const n = new FakeNative(); f.enqueue();
  const candidate = { id: CLAUDE, title: 'dexCode canonical implementation coordinator', cwd: 'D:\\Dex\\Temp\\claude-core\\integration', pid: 123, procStart: '2026-10-04T11:00:00Z', status: 'active', updatedAt: NOW, identityVerified: true, projectVerified: true };
  n.rows[0].updatedAt = (NOW - 1000) / 1000;
  await run(f, n, { claudeCandidates: [candidate] });
  assert.equal(n.sends[0].threadId, ORIGIN); assert.equal(f.state().status, 'pending-ui'); assert.equal(f.events().length, 0);
  const pending = boundedJson(path.join(f.root, 'broker-state', 'pending-ui', `${REPORT}.json`)); assert.equal(pending.target.id, CLAUDE);
  await run(f, n, { claudeCandidates: [candidate] }); assert.equal(n.sends.length, 1);
  atomicRecord(path.join(f.root, 'broker-state', 'ui-receipts', `${REPORT}.json`), { version: 1, messageId: REPORT, reportId: REPORT, sessionId: CLAUDE, status: 'delivered', transcriptEchoVerified: true, at: new Date(NOW + 2000).toISOString() });
  await run(f, n, { claudeCandidates: [candidate] }); assert.equal(f.state().status, 'delivered'); assert.equal(f.events()[0].status, 'delivered'); assert.equal(n.sends.length, 1);
});
test('unverified Claude process identity and random subagents cannot overtake the authoritative coordinator', async (t) => {
  const f = fixture(t); const n = new FakeNative();
  const base = { id: CLAUDE, title: 'dexCode canonical implementation coordinator', status: 'active', updatedAt: NOW + 1000, projectVerified: true };
  for (const candidate of [{ ...base, identityVerified: false }, { ...base, identityVerified: true, title: 'dexCode worker implementation' }, { ...base, identityVerified: true, title: 'random task' }]) {
    const result = await resolveTarget({ native: n, ledgerRoot: f.ledgerRoot, originThreadId: ORIGIN, claudeCandidates: [candidate], now: NOW }); assert.equal(result.id, TARGET);
  }
});
test('reporter followups preserve correlation and reject another reporter or context', async (t) => {
  const f = fixture(t); const n = new FakeNative(); const original = report(); f.enqueue(original);
  const followup = { ...report(FOLLOWUP), type: 'followup', reportId: REPORT, content: 'The failing build is 9641.' }; f.enqueue(followup);
  await run(f, n); assert.equal(n.sends.length, 2); assert.match(n.sends[1].prompt, new RegExp(`\\[GOJO_REPORT:${REPORT}\\]`)); assert.equal(f.state(FOLLOWUP).reportId, REPORT);
  assert.throws(() => validateIngress({ ...followup, source: { ...source, userId: '55555555555555555' } }, f.ctx, original), /mismatch/);
});
test('missing followup priority inherits only the validated original, and a private followup forces all replies to reporter DM', async (t) => {
  const f = fixture(t); const n = new FakeNative(); f.enqueue();
  const followup = { ...report(FOLLOWUP), type: 'followup', reportId: REPORT, content: 'Private reproduction detail.', questionMessageId: '88888888888888888', source: { ...source, guildId: null, channelId: '66666666666666666', messageId: '77777777777777777', private: true } };
  assert.throws(() => validateIngress(followup, f.ctx, report()), /correlation/);
  atomicRecord(path.join(f.root, 'bot-state', 'index.json'), { version: 1, questions: { [followup.questionMessageId]: { reportId: REPORT, channelId: followup.source.channelId, private: true } } });
  delete followup.priority; f.enqueue(followup); await run(f, n);
  assert.equal(n.sends.length, 2); const prompt = n.sends.find((send) => send.prompt.includes(`[GOJO_MESSAGE:${FOLLOWUP}]`)).prompt; assert.match(prompt, /"audience":"private"/); assert.match(prompt, /"priority":"normal"/);
  writeReply({ relayRoot: f.root, reply: { reportId: REPORT, status: 'needs-info', publicSummary: 'Private result.', question: 'A private followup question.', audience: 'public' }, now: NOW });
  assert.ok(f.events().every((event) => event.audience === 'private'));
  const privateOriginal = report(REPORT, { source: { ...source, guildId: null, private: true } });
  assert.throws(() => validateIngress({ ...followup, source }, f.ctx, privateOriginal), /mismatch/);
});
test('reverse relay accepts explicit correlated agent envelopes and ignores unrelated finals, user content and tools', async (t) => {
  const f = fixture(t); const n = new FakeNative(); f.enqueue();
  const fixtureToken = 'sk-' + 'proj-' + 'x'.repeat(32);
  const reply = { reportId: REPORT, status: 'needs-info', publicSummary: 'I need the failing build.', question: 'Which build failed?', audience: 'public' };
  n.agentItems = [{ type: 'agentMessage', text: 'An unrelated task is finished.', phase: 'final_answer' }, { type: 'userMessage', content: [{ type: 'text', text: '```GOJO_REPLY\n' + JSON.stringify(reply) + '\n```' }] }, { type: 'commandExecution', output: '```GOJO_REPLY\n' + JSON.stringify(reply) + '\n```' }, { type: 'agentMessage', text: '```GOJO_REPLY\n' + JSON.stringify(reply) + '\n```', phase: 'final_answer' }];
  await run(f, n); assert.deepEqual(f.events().map((event) => event.status).sort(), ['delivered', 'needs-info']);
  await run(f, n); assert.equal(f.events().length, 2);
  assert.equal(explicitReplies({ turns: [{ items: [{ type: 'agentMessage', text: '```json\n' + JSON.stringify({ ...reply, reportId: 'r-ffffffffffffffffffffffff' }) + '\n```' }] }] }, REPORT).length, 0);
});
test('a new strict bare JSON agent acknowledgement proves cross-thread arrival without a projected userMessage', async (t) => {
  const f = fixture(t); const n = new FakeNative(); n.echo = false; n.response = { status: 'queued', queued: true, threadId: TARGET, prompt: 'private' }; f.enqueue();
  n.agentItems = [{ id: 'post-dispatch-ack', type: 'agentMessage', text: JSON.stringify({ reportId: REPORT, status: 'working', publicSummary: 'Investigating the reported failure.', audience: 'public' }), phase: 'commentary' }];
  await run(f, n);
  assert.equal(f.state().status, 'delivered'); assert.equal(f.state().confirmedBy, 'correlated-agent-reply'); assert.equal(f.state().dispatch.classification, 'queued'); assert.equal(f.state().dispatch.arrivalConfirmed, false);
  assert.equal(n.messages.size, 0); await run(f, n); assert.equal(n.sends.length, 1); assert.deepEqual(f.events().map((event) => event.status).sort(), ['delivered', 'working']);
});
test('a pre-dispatch agent acknowledgement, mixed prose, wrong ingress and invalid envelope never prove arrival', async (t) => {
  for (const mode of ['baseline', 'prose', 'wrong-ingress', 'invalid-envelope']) {
    const f = fixture(t); const n = new FakeNative(); n.echo = false; f.enqueue();
    const fixtureToken = 'sk-' + 'proj-' + 'x'.repeat(32);
  const reply = { reportId: REPORT, status: 'working', publicSummary: 'Investigating.', audience: 'public', ...(mode === 'wrong-ingress' ? { messageId: FOLLOWUP } : {}), ...(mode === 'invalid-envelope' ? { target: TARGET } : {}) };
    const item = { id: 'old-message', type: 'agentMessage', text: mode === 'prose' ? 'Unrelated text\n' + JSON.stringify(reply) : JSON.stringify(reply) };
    if (mode === 'baseline') n.baselineItems = [item]; n.agentItems = [item];
    await run(f, n); assert.equal(f.state().status, 'uncertain', mode); assert.equal(f.events().length, 0, mode); await run(f, n); assert.equal(n.sends.length, 1, mode);
  }
});
test('a late original-report reply cannot confirm delivery of a subsequent followup without messageId', async (t) => {
  const f = fixture(t); const n = new FakeNative(); f.enqueue(); await run(f, n);
  const followup = { ...report(FOLLOWUP), type: 'followup', reportId: REPORT, content: 'More reproduction detail.' }; f.enqueue(followup); n.echo = false;
  n.afterSend = () => { n.agentItems = [{ id: 'late-initial-response', type: 'agentMessage', text: JSON.stringify({ reportId: REPORT, status: 'working', publicSummary: 'Initial report is being investigated.', audience: 'public' }) }]; };
  await run(f, n); assert.equal(f.state(FOLLOWUP).status, 'uncertain'); assert.equal(n.sends.length, 2);
  n.agentItems = [{ id: 'explicit-followup-response', type: 'agentMessage', text: JSON.stringify({ reportId: REPORT, messageId: FOLLOWUP, status: 'working', publicSummary: 'The extra reproduction detail arrived.', audience: 'public' }) }];
  await run(f, n); assert.equal(f.state(FOLLOWUP).status, 'delivered'); assert.equal(n.sends.length, 2);
});
test('the root-owned pre-baseline setup checkpoint reconciles its exact acknowledgement once without resending', async (t) => {
  const f = fixture(t, { acceptance: true }); const n = new FakeNative(); n.echo = false; f.enqueue(); await run(f, n, { acceptanceMode: true });
  const checkpoint = f.state(); delete checkpoint.baselineMessageIds; delete checkpoint.dispatch; atomicRecord(path.join(f.root, 'broker-state', 'messages', `${REPORT}.json`), checkpoint);
  n.agentItems = [{ id: 'legacy-setup-ack', type: 'agentMessage', text: '```GOJO_REPLY\n' + JSON.stringify({ reportId: REPORT, status: 'working', publicSummary: 'Gojo native relay setup transport test reached this chat.', audience: 'public' }) + '\n```' }];
  await run(f, n, { acceptanceMode: true }); assert.equal(f.state().status, 'delivered'); assert.equal(f.state().acknowledgement.legacySetupMigration, true); assert.equal(n.sends.length, 1);
});
test('dispatch business receipts distinguish queued/rejected from arrival and never retain private fields or diagnostics', () => {
  const queued = dispatchReceipt({ status: 'queued', queued: true, success: true, threadId: TARGET, prompt: 'private prompt', error: null });
  assert.equal(queued.classification, 'queued'); assert.equal(queued.arrivalConfirmed, false); assert.doesNotMatch(JSON.stringify(queued), /private prompt|01a10428|threadId|prompt/);
  const rejected = dispatchReceipt({ status: 'sent', success: false, error: { message: 'private pipe credential', token: 'secret' } });
  assert.equal(rejected.classification, 'rejected'); assert.equal(rejected.errorPresent, true); assert.doesNotMatch(JSON.stringify(rejected), /credential|secret|token/);
  assert.equal(dispatchReceipt({ status: 'delivered' }).arrivalConfirmed, false);
});
test('private sources stay private, replies redact identifiers/secrets and deterministic dedup survives reload', (t) => {
  const f = fixture(t); f.enqueue(report(REPORT, { source: { ...source, guildId: null, private: true } }));
  const fixtureToken = 'sk-' + 'proj-' + 'x'.repeat(32);
  const reply = { reportId: REPORT, status: 'working', publicSummary: `Checking D:\\Dex\\Private\\file.txt and ${TARGET}; ${fixtureToken}`, audience: 'public' };
  const first = writeReply({ relayRoot: f.root, reply, now: NOW }); const second = writeReply({ relayRoot: f.root, reply, now: NOW + 1000 });
  assert.equal(first.created, true); assert.equal(second.created, false); assert.equal(first.eventId, second.eventId);
  const event = f.events()[0]; assert.equal(event.audience, 'private'); assert.doesNotMatch(event.summary, /file\.txt|01a10428|sk-proj-/); assert.equal(event.at, new Date(NOW).toISOString());
});
test('fixed requires actual supplied test/canonical/pushed commit evidence; unsupported claims remain working', (t) => {
  const f = fixture(t); f.enqueue(); const reply = { reportId: REPORT, status: 'fixed', publicSummary: 'The failing file-open case now passes.', audience: 'public' };
  assert.equal(writeReply({ relayRoot: f.root, reply, now: NOW }).status, 'working');
  const evidence = { tests: [{ command: 'node --test test/file-open.test.mjs', result: 'passed' }], commit: { sha: 'abcdef1234567', pushed: true }, canon: { path: 'docs/product-canon.md', updated: true } };
  assert.equal(writeReply({ relayRoot: f.root, reply: { ...reply, evidence }, now: NOW }).status, 'fixed');
  assert.throws(() => writeReply({ relayRoot: f.root, reply: { ...reply, threadId: CLAUDE }, now: NOW }), /fields/);
  assert.throws(() => writeReply({ relayRoot: f.root, reply: { ...reply, reportId: 'r-ffffffffffffffffffffffff' }, now: NOW }));
});
test('empty and dry-run scheduler polls never invoke native tools', async (t) => {
  const f = fixture(t); const n = new FakeNative(); assert.equal((await run(f, n)).status, 'empty');
  f.enqueue(); f.ctx.dryRun = true; assert.equal((await run(f, n)).status, 'skipped'); assert.equal(n.calls.length, 0);
});
test('fresh reports cannot be starved by prior delivered reports', async (t) => {
  const f = fixture(t); const n = new FakeNative();
  for (let i = 0; i < 5; i++) { f.enqueue(report(`r-${i.toString(16).padStart(24, '0')}`)); await run(f, n); }
  f.enqueue(report(REPORT, { priority: 'critical' })); await run(f, n); assert.equal(f.state().status, 'delivered'); assert.ok(n.sends.some((send) => send.prompt.includes(`[GOJO_REPORT:${REPORT}]`)));
});
test('more than 2000 retained delivered inbox files cannot hide a newly queued report', async (t) => {
  const f = fixture(t); const n = new FakeNative();
  const states = path.join(f.root, 'broker-state', 'messages'); fs.mkdirSync(states, { recursive: true });
  for (let i = 0; i < 2001; i++) {
    const id = `r-${i.toString(16).padStart(24, '0')}`;
    fs.writeFileSync(path.join(f.root, 'inbox', `${id}.json`), JSON.stringify(report(id)));
    fs.writeFileSync(path.join(states, `${id}.json`), JSON.stringify({ version: 1, messageId: id, reportId: id, status: 'delivered', target: { provider: 'codex', id: TARGET, hostId: 'local' }, originThreadId: ORIGIN, startedAt: new Date(NOW).toISOString(), prompt: 'old confirmed prompt', readCursor: null, lastCheckedAt: new Date(NOW).toISOString() }));
  }
  f.enqueue(); await run(f, n); assert.equal(f.state().status, 'delivered'); assert.ok(n.sends.some((send) => send.prompt.includes(`[GOJO_REPORT:${REPORT}]`)));
});
test('isolated acceptance mode requests only an acknowledgement and cannot run in the normal runtime', async (t) => {
  const normal = fixture(t); normal.enqueue(); const n = new FakeNative();
  await assert.rejects(run(normal, n, { acceptanceMode: true }), /isolated acceptance home/); assert.equal(n.sends.length, 0);
  const f = fixture(t, { acceptance: true }); f.enqueue(report(REPORT, { content: 'Clearly labelled setup transport test.' }));
  await run(f, n, { acceptanceMode: true }); assert.equal(f.state().status, 'delivered');
  assert.match(n.sends[0].prompt, /no bug or code change requested/); assert.match(n.sends[0].prompt, /Do not edit files, commit, push, update canon/); assert.doesNotMatch(n.sends[0].prompt, /reproduce\/test it, fix/);
  assert.throws(() => validateIngress(report(REPORT, { acceptanceMode: true }), f.ctx), /Invalid relay report/);
});
test('aborted scheduler work makes no sends and a native abort releases its pending STDIO request', async (t) => {
  const f = fixture(t); f.enqueue(); const n = new FakeNative(); const stopped = new AbortController(); stopped.abort();
  assert.equal((await run(f, n, { signal: stopped.signal })).status, 'aborted'); assert.equal(n.calls.length, 0);
  const fake = fakeSpawn({ respond: false }); const active = new AbortController();
  const client = new StdioMcpClient({ binding: { serverPath: OFFICIAL_SERVER, pipePath: '\\\\.\\pipe\\fixture-native', originThreadId: ORIGIN }, spawnImpl: fake.spawnImpl, signal: active.signal });
  const pending = client.initialize(); active.abort(); await assert.rejects(pending, (error) => error.code === 'request-aborted'); assert.equal(client.closed, true);
});
test('native payload rejects raw text and tool errors without exposing diagnostics', () => {
  assert.deepEqual(nativePayload({ content: [{ type: 'text', text: '{"status":"ok"}' }] }), { status: 'ok' });
  assert.throws(() => nativePayload({ isError: true, content: [{ type: 'text', text: 'secret pipe token details' }] }), (error) => error.code === 'tool-rejected' && !/secret/.test(error.message));
  assert.throws(() => nativePayload({ content: [{ type: 'text', text: 'unstructured success' }] }), /response-invalid/);
});
function fakeSpawn({ respond = true } = {}) {
  const writes = []; const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => { child.emit('exit'); };
  child.stdin = new Writable({ write(chunk, _encoding, callback) {
    const message = JSON.parse(chunk.toString()); writes.push(message);
    if (respond && message.id) queueMicrotask(() => {
      const result = message.method === 'tools/list' ? { tools: ['list_threads', 'read_thread', 'wait_threads', 'send_message_to_thread'].map((name) => ({ name })) } : message.method === 'tools/call' ? { content: [{ type: 'text', text: '{"ok":true}' }] } : { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'official-fixture', version: '1' } };
      child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n');
    }); callback();
  } });
  const calls = []; const spawnImpl = (...args) => { calls.push(args); return child; }; return { writes, calls, child, spawnImpl };
}
test('standard STDIO transport calls unchanged official server with only the genuine bound origin metadata', async () => {
  const fake = fakeSpawn(); const binding = { serverPath: OFFICIAL_SERVER, pipePath: '\\\\.\\pipe\\fixture-native', originThreadId: ORIGIN };
  const client = new StdioMcpClient({ binding, spawnImpl: fake.spawnImpl });
  try {
    await client.initialize(); assert.deepEqual(await client.call('read_thread', { threadId: TARGET }), { ok: true });
    const [binary, argv, options] = fake.calls[0]; assert.equal(binary, process.execPath); assert.deepEqual(argv, [OFFICIAL_SERVER]); assert.equal(options.shell, false); assert.equal(options.windowsHide, true);
    assert.equal(options.env.CODEX_APP_TOOLS_PIPE_PATH, binding.pipePath); assert.equal(options.env.CODEX_THREAD_ID, undefined);
    const request = fake.writes.find((value) => value.method === 'tools/call'); assert.deepEqual(request.params._meta, { threadId: ORIGIN }); assert.deepEqual(request.params.arguments, { threadId: TARGET });
    await assert.rejects(client.call('exec_command', { cmd: 'forbidden' }), /tool-not-allowed/);
  } finally { client.close(); }
});
test('STDIO timeout and output bounds fail closed with sanitized errors', async () => {
  const binding = { serverPath: OFFICIAL_SERVER, pipePath: '\\\\.\\pipe\\fixture-native', originThreadId: ORIGIN };
  const silent = fakeSpawn({ respond: false }); const timed = new StdioMcpClient({ binding, spawnImpl: silent.spawnImpl, timeoutMs: 100 });
  await assert.rejects(timed.initialize(), (error) => error.code === 'request-timeout'); assert.equal(timed.closed, true);
  const noisy = fakeSpawn({ respond: false }); const bounded = new StdioMcpClient({ binding, spawnImpl: noisy.spawnImpl, maxOutputBytes: 64 });
  const pending = bounded.initialize(); noisy.child.stdout.write('x'.repeat(100)); await assert.rejects(pending, (error) => error.code === 'output-bound-exceeded');
});
test('bind refuses absent executor evidence and malformed saved binding without capturing worker identity', async (t) => {
  const f = fixture(t); await assert.rejects(bindNative({ home: f.home, env: {} }), /executor-binding-unavailable/);
  assert.equal(fs.existsSync(path.join(f.root, 'native-binding.json')), false);
  atomicRecord(path.join(f.root, 'native-binding.json'), { pipePath: '\\\\.\\pipe\\fixture-native', originThreadId: ORIGIN, serverPath: OFFICIAL_SERVER, serverSha256: '0'.repeat(64), fabricatedTurn: 'forbidden' });
  assert.throws(() => readBinding(f.root), /binding-invalid/);
});
