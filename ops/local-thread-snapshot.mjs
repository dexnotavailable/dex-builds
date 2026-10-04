// Read-only, bounded view of local CLI activity. Private input for owner conversations;
// no user prompts, tool arguments, secrets, auth files or full transcripts are read.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { redactSecrets } from '../src/core/redact.mjs';

const LIMIT_BYTES = 512 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
function tail(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - LIMIT_BYTES);
    const b = Buffer.alloc(Math.min(size, LIMIT_BYTES));
    fs.readSync(fd, b, 0, b.length, start);
    const lines = b.toString('utf8').split('\n');
    if (start) lines.shift();
    return lines.flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  } catch { return []; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function clean(value, max = 600) {
  return redactSecrets(String(value ?? ''))
    .replace(/[A-Za-z]:[\\/][^\s"<>]+/g, '[local path]')
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, '[thread]')
    .slice(0, max);
}
function textContent(content) {
  if (typeof content === 'string') return content;
  return (Array.isArray(content) ? content : []).filter(c => ['text', 'output_text'].includes(c.type)).map(c => c.text ?? '').join('\n');
}
export function codexTailStatus(records) {
  let state = 'unknown';
  let at = null;
  let activity = '';
  for (const r of records) {
    const p = r.payload ?? {};
    if (r.type === 'event_msg') {
      if (p.type === 'task_started') state = 'running';
      else if (['task_complete', 'turn_aborted'].includes(p.type)) state = p.type === 'task_complete' ? 'complete' : 'cancelled';
      else if (p.type === 'agent_message') activity = clean(p.message);
      if (['task_started', 'task_complete', 'turn_aborted', 'agent_message'].includes(p.type)) at = r.timestamp ?? at;
    } else if (r.type === 'response_item' && p.type === 'message' && p.role === 'assistant') {
      activity = clean(textContent(p.content)) || activity;
      at = r.timestamp ?? at;
    }
  }
  return { state, sourceUpdatedAt: at, activity };
}
function processes() {
  if (process.platform !== 'win32') return null;
  try {
    const raw = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | Where-Object { $_.Name -match "^(claude|codex|node)\\.exe$" } | Select-Object ProcessId,@{n="startedAt";e={$_.CreationDate.ToUniversalTime().ToString("o")}} | ConvertTo-Json -Compress'],
      { encoding: 'utf8', windowsHide: true, timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] });
    const values = JSON.parse(raw || '[]');
    return new Map((Array.isArray(values) ? values : [values]).map(p => [Number(p.ProcessId), p.startedAt]));
  } catch { return null; }
}
function timestamp(value) {
  if (typeof value === 'string' && /^\d{16,20}$/.test(value)) {
    try { return new Date(Number((BigInt(value) - 116444736000000000n) / 10000n)).toISOString(); } catch { return null; }
  }
  const n = typeof value === 'number' ? (value < 1e11 ? value * 1000 : value) : Date.parse(value);
  return Number.isFinite(n) ? new Date(n).toISOString() : null;
}
export function projectForCwd(cwd, projectRoots = {}) {
  const value = String(cwd ?? '').replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
  for (const [key, configured] of Object.entries(projectRoots)) {
    for (const root of (Array.isArray(configured) ? configured : [configured])) {
      const prefix = String(root).replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
      if (prefix && (value === prefix || value.startsWith(prefix + '/'))) return key;
    }
  }
  // Chat/workspace scaffold names are not authoritative project associations.
  if (!/^d:\//.test(value)) return null;
  if (/(?:^|\/)dex\.place(?:\/|$)/.test(value)) return 'dexplace';
  if (/(?:^|\/)characterforge(?:\/|$)/.test(value)) return 'characterforge';
  if (/(?:dexclient|dex-client|client-integration|claude-client)/.test(value)) return 'dexclient';
  if (/(?:dexcode|dexshell|claude-core\/(?:integration|native)|gamegrinder)/.test(value)) return 'dexcode';
  return null;
}
// Native session persistence is shared with the desktop inventory. Bot chats are
// private per-context memories, never sibling development threads to inspect.
export function isBotGenerationCwd(cwd) {
  return /(?:^|\/)gojo\/generation-workspace(?:\/|$)/i.test(String(cwd ?? '').replace(/\\/g, '/'));
}
function ledgerThreadProjects(ledgerRoot) {
  try {
    const file = path.join(ledgerRoot, 'projects.json');
    if (fs.statSync(file).size > LIMIT_BYTES) return new Map();
    const rows = JSON.parse(fs.readFileSync(file, 'utf8')).projects ?? [];
    const projects = new Map(rows.map(row => [row.project_id, row]));
    const result = new Map();
    for (const row of rows) {
      const owner = row.record_type === 'lane' ? projects.get(row.parent_project_id) : row;
      const key = { dexcode: 'dexcode', 'dex-client': 'dexplace', 'character-forge': 'characterforge' }[owner?.slug];
      if (!key) continue;
      for (const ref of row.active_threads ?? []) {
        if (typeof ref !== 'string') continue;
        const id = ref.replace(/^(?:codex|claude):/, '');
        if (/^[a-f0-9-]{36}$/i.test(id)) result.set(id, key);
      }
    }
    return result;
  } catch { return new Map(); }
}
export async function collectLocalThreads({ codexHome = path.join(process.env.USERPROFILE ?? '', '.codex'), claudeHome = path.join(process.env.USERPROFILE ?? '', '.claude'), ledgerRoot = 'D:\\Dex\\Automation\\ProjectLedger', now = Date.now(), maxThreads = 32, projectRoots = {} } = {}) {
  const threads = [];
  const notes = [];
  const threadProjects = ledgerThreadProjects(ledgerRoot);
  const dbFile = path.join(codexHome, 'state_5.sqlite');
  if (fs.existsSync(dbFile)) {
    let db;
    try {
      const { DatabaseSync } = await import('node:sqlite');
      db = new DatabaseSync(dbFile, { readOnly: true });
      const rows = db.prepare("SELECT id,title,cwd,model,reasoning_effort,source,rollout_path,updated_at_ms FROM threads WHERE archived=0 AND source IN ('cli','exec','vscode','appServer') ORDER BY updated_at_ms DESC LIMIT 64").all();
      for (const row of rows) {
        if (isBotGenerationCwd(row.cwd)) continue;
        if (now - Number(row.updated_at_ms) > DAY_MS) continue;
        const resolved = path.resolve(row.rollout_path ?? '');
        const sessionRoots = [path.join(codexHome, 'sessions'), path.join(codexHome, 'archived_sessions')];
        if (!sessionRoots.some(root => resolved.startsWith(path.resolve(root) + path.sep))) continue;
        const status = codexTailStatus(tail(resolved));
        const at = timestamp(status.sourceUpdatedAt) ?? timestamp(Number(row.updated_at_ms));
        threads.push({ provider: 'codex', id: row.id, title: clean(row.title, 120), projectKey: threadProjects.get(row.id) ?? projectForCwd(row.cwd, projectRoots), model: row.model, effort: row.reasoning_effort,
          ...status, sourceUpdatedAt: at, staleAfter: at ? new Date(Date.parse(at) + 15 * 60 * 1000).toISOString() : null,
          evidence: 'persisted rollout events; running means last observed, not a live Desktop connection' });
      }
    } catch (err) { notes.push(`codex snapshot unavailable (${err.code ?? 'read error'})`); }
    finally { db?.close(); }
  } else notes.push('codex state database unavailable');
  const sessionRoot = path.join(claudeHome, 'sessions');
  const pidMap = processes();
  try {
    const entries = fs.readdirSync(sessionRoot).filter(n => n.endsWith('.json')).slice(0, 256);
    for (const name of entries) {
      const file = path.join(sessionRoot, name);
      if (fs.statSync(file).size > 64 * 1024) continue;
      let record;
      try { record = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
      const at = timestamp(record.statusUpdatedAt ?? record.updatedAt ?? record.startedAt);
      if (!at || now - Date.parse(at) > DAY_MS) continue;
      let alive = false;
      try { process.kill(Number(record.pid), 0); alive = true; } catch { /* gone */ }
      if (!alive) continue;
      const identityAt = timestamp(record.procStart);
      const actualAt = pidMap?.get(Number(record.pid));
      if (actualAt && identityAt && Math.abs(Date.parse(actualAt) - Date.parse(identityAt)) > 3000) continue;
      const identityVerified = !!(actualAt && identityAt);
      const state = identityVerified ? ({ active: 'running', running: 'running', busy: 'running', idle: 'waiting', blocked: 'waiting', waiting: 'waiting' }[record.status] ?? 'unknown') : 'unknown';
      const cwd = String(record.cwd ?? '');
      if (isBotGenerationCwd(cwd)) continue;
      if (!/^[a-f0-9-]{36}$/i.test(String(record.sessionId ?? ''))) continue;
      const projectDir = cwd.replace(/[^A-Za-z0-9]/g, '-');
      const transcript = path.join(claudeHome, 'projects', projectDir, `${record.sessionId}.jsonl`);
      const last = tail(transcript).filter(r => r.type === 'assistant').at(-1);
      threads.push({ provider: 'claude', id: record.sessionId, title: clean(record.name ?? path.basename(cwd), 120), projectKey: threadProjects.get(record.sessionId) ?? projectForCwd(cwd, projectRoots), state,
        activity: clean(textContent(last?.message?.content)), sourceUpdatedAt: at,
        staleAfter: new Date(Date.parse(at) + 15 * 60 * 1000).toISOString(),
        evidence: identityVerified ? 'live process identity and CLI session status; last assistant text is historical' : 'unverified process start identity; status unknown' });
    }
  } catch { notes.push('claude session inventory unavailable'); }
  threads.sort((a, b) => String(b.sourceUpdatedAt ?? '').localeCompare(String(a.sourceUpdatedAt ?? '')));
  return { capturedAt: new Date(now).toISOString(), sourceUpdatedAt: threads[0]?.sourceUpdatedAt ?? null, threads: threads.slice(0, maxThreads), notes };
}
export function writeSnapshot(file, snapshot) {
  if (!/^D:[\\/]/i.test(path.resolve(file))) throw new Error('snapshot output must be D-backed');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeFileSync(fd, JSON.stringify(snapshot, null, 2)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--output');
  if (i < 0 || !process.argv[i + 1]) throw new Error('usage: node ops/local-thread-snapshot.mjs --output D:\\...\\gojo-thread-snapshot.json');
  const snapshot = await collectLocalThreads();
  writeSnapshot(process.argv[i + 1], snapshot);
  console.log(JSON.stringify({ codex: snapshot.threads.filter(t => t.provider === 'codex').length, claude: snapshot.threads.filter(t => t.provider === 'claude').length, notes: snapshot.notes }));
}
