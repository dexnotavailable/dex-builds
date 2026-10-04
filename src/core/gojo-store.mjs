import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { redactSecrets } from './redact.mjs';

export const digest = (value) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');

export function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

/** Private durable memory is never used as an input to a public context. */
export class GojoStore {
  constructor(home) {
    this.root = path.join(home, 'gojo');
    this.file = path.join(this.root, 'memory.json');
    fs.mkdirSync(this.root, { recursive: true });
    try { this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')); }
    catch (error) {
      // A corrupt memory must be investigated, not discarded and backfilled into Discord.
      if (error.code !== 'ENOENT') throw new Error('Gojo memory is unreadable; preserved for inspection');
      this.data = { version: 1, contexts: {}, messages: {}, heartbeat: { projects: {}, outbox: null, lastCheckedAt: null } };
    }
    if (this.data.version !== 1) throw new Error('Unsupported Gojo memory version');
  }

  save() { atomicJson(this.file, this.data); }

  context(key) {
    if (!/^(?:public|heartbeat):\d{17,20}$|^dm:\d{17,20}$/.test(key)) throw new Error('Invalid Gojo context');
    return this.data.contexts[key] ??= { sessions: {}, recent: [], updatedAt: null };
  }

  record(key, entry) {
    const context = this.context(key);
    const safe = JSON.parse(redactSecrets(JSON.stringify({ at: new Date().toISOString(), ...entry })));
    const file = path.join(this.root, 'transcripts', `${digest(key)}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(safe)}\n`, { mode: 0o600 });
    context.recent.push(safe);
    context.recent = context.recent.slice(-24);
    context.updatedAt = safe.at;
    // Per-user transcripts are private local records, never a model/public context input.
    if (entry.userId && /^\d{17,20}$/.test(entry.userId)) {
      const userFile = path.join(this.root, 'users', `${digest(entry.userId)}.jsonl`);
      fs.mkdirSync(path.dirname(userFile), { recursive: true });
      fs.appendFileSync(userFile, `${JSON.stringify({ context: key, ...safe })}\n`, { mode: 0o600 });
    }
    this.save();
  }

  beginMessage(id, { deferSave = false } = {}) {
    if (this.data.messages[id]) return false;
    this.data.messages[id] = { status: 'processing', at: new Date().toISOString() };
    // Keep durable recent dedup keys; old gateway events are rejected separately by age.
    const keys = Object.keys(this.data.messages);
    for (const key of keys.slice(0, Math.max(0, keys.length - 5000))) delete this.data.messages[key];
    if (!deferSave) this.save();
    return true;
  }

  finishMessage(id, status) {
    this.data.messages[id] = { status, at: new Date().toISOString() };
    this.save();
  }
}
