// Explicit correlated replies only. This never reads or writes Gojo's conversation store.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { publicText } from '../src/core/gojo-policy.mjs';
import { relayPath } from './gojo-bind-native.mjs';

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
export const validReportId = (id) => typeof id === 'string' && /^r-[a-f0-9]{24}$/.test(id);
export function boundedJson(file, limit = 65_536) {
  if (fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size > limit) throw new Error('Relay record exceeds its boundary');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
export function atomicRecord(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(value, null, 2)); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(temporary, file);
  } finally { if (fd !== undefined) fs.closeSync(fd); if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
function immutableRecord(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(value, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    try { fs.linkSync(temporary, file); return true; } catch (error) { if (error.code === 'EEXIST') return false; throw error; }
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
export function readOriginal(relayRoot, id) {
  if (!validReportId(id)) throw new Error('Invalid report correlation');
  const report = boundedJson(path.join(relayRoot, 'inbox', `${id}.json`), 20_000);
  if (report.version !== 1 || report.type !== 'report' || report.id !== id || report.project !== 'dexcode' || typeof report.source?.private !== 'boolean') throw new Error('Original report is unavailable');
  return report;
}
export function normalizeReply(reply, report) {
  if (!reply || typeof reply !== 'object' || Array.isArray(reply)
    || reply.reportId !== report.id || !['delivered', 'working', 'needs-info', 'fixed', 'failed'].includes(reply.status)
    || !['public', 'private'].includes(reply.audience)) throw new Error('Invalid scoped reply envelope');
  const keys = new Set(['version', 'reportId', 'messageId', 'status', 'publicSummary', 'summary', 'question', 'audience', 'evidence']);
  if (Object.keys(reply).some((key) => !keys.has(key))) throw new Error('Invalid scoped reply fields');
  if ((reply.version != null && reply.version !== 1) || (reply.messageId != null && !/^[rf]-[a-f0-9]{24}$/.test(reply.messageId))) throw new Error('Invalid reply ingress correlation');
  const summary = reply.publicSummary ?? reply.summary;
  if (typeof summary !== 'string' || !summary.trim() || summary.length > 1800 || (reply.question != null && (typeof reply.question !== 'string' || reply.question.length > 1000))) throw new Error('Invalid reply text');
  if (reply.status === 'needs-info' && !reply.question?.trim()) throw new Error('A question is required');
  let status = reply.status;
  let safeSummary = publicText(summary).slice(0, 1600);
  let evidence;
  if (status === 'fixed') {
    const value = reply.evidence;
    const tested = Array.isArray(value?.tests) && value.tests.length > 0 && value.tests.length <= 20
      && value.tests.every((test) => typeof test.command === 'string' && test.command.trim() && test.command.length <= 1000 && test.result === 'passed');
    const committed = /^[a-f0-9]{7,40}$/i.test(value?.commit?.sha ?? '') && value.commit.pushed === true;
    const canon = typeof value?.canon?.path === 'string' && value.canon.path.trim() && value.canon.updated === true;
    if (!tested || !committed || !canon) { status = 'working'; safeSummary = 'A fix was reported; test results, canonical documentation and pushed commit evidence are still pending.'; }
    else {
      evidence = { tests: value.tests.map((test) => ({ command: publicText(test.command), result: 'passed' })), commit: { sha: value.commit.sha, pushed: true }, canon: { path: publicText(value.canon.path), updated: true } };
      safeSummary = `${safeSummary}\nCode fix verified and pushed; installation/release acceptance is separate.`.slice(0, 1800);
    }
  }
  return { reportId: report.id, status, summary: safeSummary, ...(reply.question ? { question: publicText(reply.question).slice(0, 1000) } : {}), audience: report.source.private ? 'private' : reply.audience, ...(evidence ? { evidence } : {}) };
}
export function writeReply({ relayRoot, reply, now = Date.now() }) {
  let report = readOriginal(relayRoot, reply?.reportId);
  try {
    const privacy = boundedJson(path.join(relayRoot, 'broker-state', 'report-privacy', `${report.id}.json`));
    if (privacy.version !== 1 || privacy.reportId !== report.id || privacy.forcePrivate !== true) throw new Error('Invalid report privacy state');
    report = { ...report, source: { ...report.source, private: true } };
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const event = normalizeReply(reply, report);
  const eventId = `e-${hash(event)}`;
  const file = path.join(relayRoot, 'outbox', `${eventId}.json`);
  const value = { version: 1, eventId, ...event, at: new Date(now).toISOString() };
  if (Buffer.byteLength(JSON.stringify(value, null, 2)) > 16_000) throw new Error('Reply event exceeds its boundary');
  const created = immutableRecord(file, value);
  return { eventId, status: event.status, created };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const flag = (name) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
    const file = flag('--file');
    if (!file || !/^D:[\\/]/i.test(file)) throw new Error();
    const result = writeReply({ relayRoot: relayPath(flag('--home') ?? 'D:\\Dex\\Servers\\devbot'), reply: boundedJson(file) });
    console.log(JSON.stringify({ status: result.status, created: result.created }));
  } catch { console.error(JSON.stringify({ status: 'failed', code: 'invalid-or-unavailable-reply' })); process.exitCode = 1; }
}
