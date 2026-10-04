import fs from 'node:fs';
import path from 'node:path';
import { atomicJson, digest } from './gojo-store.mjs';
import { publicText, snowflake, isBotOrSelf, markGojoFeedback } from './gojo-policy.mjs';
import { redactSecrets } from './redact.mjs';

const reportId = (value) => typeof value === 'string' && /^r-[a-f0-9]{24}$/.test(value);
const eventId = (value) => typeof value === 'string' && /^e-[a-f0-9]{24}$/.test(value);
const eventStatuses = new Set(['delivered', 'working', 'needs-info', 'fixed', 'failed']);
const clean = (value, maximum = 5000) => redactSecrets(String(value ?? '')).slice(0, maximum);
function diagnosticText(message) {
  const embeds = message.gojoVisibleMetadata?.embeds ?? [];
  const readable = embeds.flatMap((embed) => [embed.title, embed.description, ...(embed.fields ?? []).map((field) => `${field.name}: ${field.value}`)]).filter(Boolean).join('\n');
  const attachments = (message.gojoVisibleMetadata?.attachments ?? []).map((item) => `Attachment: ${item.name} (${item.contentType || 'unknown type'}, ${item.size ?? 'unknown'} bytes; pixels not inspected)`).join('\n');
  return clean([message.content, readable, attachments].filter(Boolean).join('\n'));
}

/** Conservative signal detector, not an authority interpreter. */
export function detectDexcodeFailure(content, { projectChannel = false } = {}) {
  const text = String(content ?? '');
  if (!projectChannel && !/\bdex[ -]?code\b/i.test(text)) return null;
  if (/^\s*(?:<@!?\d+>\s*|gojo[, :]+)?(?:write|make|generate|imagine|pretend|roleplay|translate|rewrite)\b[^\n]{0,80}\b(?:meme|joke|story|quote|song|pretend)\b/i.test(text)) return null;
  const clauses = text.split(/(?:\bbut\b|[;\n]|(?<=[.!?])\s+)/i);
  for (let clause of clauses) {
    clause = clause.trim();
    if (!clause || /\b(?:fixed|resolved|no longer|used to|was fixed|now (?:works|passes|passing))\b/i.test(clause)) continue;
    if (/\b(?:no|not|never)\s+(?:more\s+|a\s+|any\s+)?(?:bugs?|regressions?|crash\w*|fail\w*|errors?)\b|\b(?:doesn['’]t|isn['’]t|didn['’]t|don['’]t|hasn['’]t|won['’]t)\s+(?:crash|fail|freeze|hang)\b/i.test(clause)) continue;
    const failureAt = clause.search(/\b(?:crash\w*|freez\w*|frozen|hang\w*|hung|unresponsive|fail\w*|broken|bug|regression|issue|won['’]t|can['’]t|doesn['’]t|AssertionError|TypeError|ERR_ASSERTION)\b/i);
    const speculativePrefix = failureAt < 0 ? clause : clause.slice(0, failureAt);
    if (/\b(?:what if|might|maybe|wish|imagine|hypothetically|would)\b/i.test(speculativePrefix) || /\bcould\b(?!\s+(?:not|you\s+(?:fix|check|investigate)))/i.test(speculativePrefix)) continue;
    const crash = /\b(?:crash(?:ed|es|ing)?|freezes?|freezing|frozen|hangs?|hung|unresponsive|data loss|lost (?:my |the )?(?:files|data|work))\b/i.test(clause);
    const failedTest = /\b(?:tests?|build|ci|assertion)\b[^\n]{0,100}\b(?:fail(?:ed|ing|ure|s)?|broken|error)\b|\b(?:failed|failing)\b[^\n]{0,30}\b(?:tests?|build|ci|assertion)\b|\b(?:AssertionError|TypeError|UnhandledPromiseRejection|ERR_ASSERTION)\b/i.test(clause);
    const broken = /\b(?:broken|won['’]t (?:start|launch|open|load|save|connect)|can['’]t (?:start|launch|open|load|save|connect)|doesn['’]t (?:start|launch|open|load|save|connect|work)|not working)\b/i.test(clause);
    const reportedBug = /\b(?:bug|regression|issue)\b/i.test(clause) && /\b(?:found|hit|seeing|repro|steps|when|after|fails?|broken|error|can['’]t|won['’]t|doesn['’]t)\b/i.test(clause);
    if (crash || failedTest || broken || reportedBug) return { kind: failedTest ? 'failed-test' : crash ? 'crash' : 'bug', priority: crash || /\b(?:security|data loss|lost (?:files|work|data))\b/i.test(clause) ? 'critical' : 'normal' };
  }
  return null;
}

function sourceOf(message) {
  return { guildId: message.guildId ?? null, channelId: message.channelId, messageId: message.id, userId: message.author.id, private: !message.guildId, reporterName: clean(message.author.username, 100) };
}

export class GojoRelay {
  constructor({ ctx, transport = null, now = () => Date.now() }) {
    Object.assign(this, { ctx, transport, now });
    this.config = ctx.config.gojo.relay ?? { enabled: true, channelKeys: ['ships-dexcode'], duplicateWindowSeconds: 900, reportsPerUserPerHour: 6, criticalReportsPerUserPerHour: 12 };
    this.root = path.join(ctx.config.home, 'gojo', 'relay');
    this.indexFile = path.join(this.root, 'bot-state', 'index.json');
    for (const folder of ['inbox', 'outbox', 'bot-state', 'bot-state/events']) fs.mkdirSync(path.join(this.root, folder), { recursive: true });
    try { this.index = JSON.parse(fs.readFileSync(this.indexFile, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Gojo relay state is unreadable; preserved for inspection');
      this.index = { version: 1, reports: {}, fingerprints: {}, questions: {}, messages: {} };
    }
    if (this.index.version !== 1) throw new Error('Unsupported Gojo relay state');
    this.polling = false;
    this.reconcileIndex();
  }

  save() { atomicJson(this.indexFile, this.index); }
  readReport(id) {
    if (!reportId(id)) return null;
    try { const value = JSON.parse(fs.readFileSync(path.join(this.root, 'inbox', `${id}.json`), 'utf8')); return value.version === 1 && value.id === id && value.type === 'report' && value.project === 'dexcode' ? value : null; } catch { return null; }
  }
  ensureIndexed(report) {
    if (!reportId(report?.id) || report.project !== 'dexcode' || !snowflake(report.source?.userId) || !snowflake(report.source?.channelId) || !snowflake(report.source?.messageId) || (report.source.guildId && report.source.guildId !== this.ctx.config.local.guildId)) return false;
    this.index.reports[report.id] ??= { userId: report.source.userId, channelId: report.source.channelId, createdAt: report.createdAt, status: 'queued' };
    this.index.messages[report.source.messageId] ??= report.id;
    const fingerprint = digest(`${report.source.userId}:${report.source.channelId}:${String(report.content).toLowerCase().replace(/\s+/g, ' ').trim()}`);
    this.index.fingerprints[fingerprint] ??= { reportId: report.id, at: report.createdAt };
    return true;
  }
  reconcileIndex() {
    for (const file of fs.readdirSync(path.join(this.root, 'inbox')).filter((name) => /^r-[a-f0-9]{24}\.json$/.test(name))) this.ensureIndexed(this.readReport(file.slice(0, -5)));
    this.save();
  }
  status() { return { enabled: this.config.enabled !== false, reports: Object.keys(this.index.reports).length, queued: Object.values(this.index.reports).filter((report) => report.status === 'queued').length, needsInfo: Object.values(this.index.reports).filter((report) => report.status === 'needs-info').length }; }

  scoped(message, isAddressed) {
    if (this.config.enabled === false || isBotOrSelf(message, this.ctx.client.user.id)) return false;
    if (!message.guildId) return true;
    if (message.guildId !== this.ctx.config.local.guildId) return false;
    return true; // Explicit product reports are accepted from every visible home-server channel.
  }

  async submitMessage(message, { addressed: isAddressed = false, projectHint = null, semanticTriage = false } = {}) {
    if (!this.scoped(message, isAddressed)) return null;
    const reference = message.reference?.messageId;
    const question = reference ? this.index.questions[reference] : null;
    const related = reference ? question ?? this.index.messages[reference] : null;
    if (related) {
      const id = typeof related === 'string' ? related : related.reportId;
      const original = this.readReport(id);
      const channelId = typeof related === 'string' ? original?.source.channelId : related.channelId;
      const privateSource = typeof related === 'string' ? original?.source.private : related.private;
      if (original && channelId === message.channelId && privateSource === !message.guildId && original.source.userId === message.author.id) return this.followup(original, message, question ? reference : null);
    }
    const projectIds = [...(this.config.channelKeys ?? ['ships-dexcode']).map((key) => this.ctx.guildCtx.channelId?.(key)), ...(this.config.channelIds ?? [])].filter(Boolean);
    const diagnostics = diagnosticText(message);
    let signal = detectDexcodeFailure(diagnostics, { projectChannel: projectHint === 'dexcode' || projectIds.includes(message.channelId) || projectIds.includes(message.channel?.parentId) });
    const clearlyNotAReport = /\b(?:what if|hypothetically|pretend|imagine|no longer|used to|(?:bug|issue|failure) (?:is )?(?:fixed|resolved)|no (?:more )?bugs?)\b|\b(?:make|write|generate)\b[^\n]{0,60}\b(?:meme|joke|story)\b|\btests? (?:all )?(?:pass|passed|passing)[.!\s]*$/i.test(message.content ?? '');
    if (!signal && semanticTriage && projectHint === 'dexcode' && !clearlyNotAReport && diagnostics.trim().length >= 8) signal = { kind: 'bug', priority: 'normal' };
    if (!signal) return null;
    const id = `r-${digest(`${message.guildId ?? 'dm'}:${message.channelId}:${message.id}`).slice(0, 24)}`;
    const existing = this.readReport(id);
    if (existing) { this.ensureIndexed(existing); this.save(); return { id, handled: true, duplicate: true }; }
    if (this.index.messages[message.id]) return { id, handled: true, duplicate: true };
    const content = diagnostics;
    const fingerprint = digest(`${message.author.id}:${message.channelId}:${content.toLowerCase().replace(/\s+/g, ' ').trim()}`);
    const previous = this.index.fingerprints[fingerprint];
    if (previous && this.now() - Date.parse(previous.at) < (this.config.duplicateWindowSeconds ?? 900) * 1000) { this.index.messages[message.id] = previous.reportId; this.save(); return { id: previous.reportId, handled: true, duplicate: true }; }
    const recent = Object.values(this.index.reports).filter((item) => item.userId === message.author.id && this.now() - Date.parse(item.createdAt) < 3_600_000);
    const limit = signal.priority === 'critical' ? this.config.criticalReportsPerUserPerHour ?? 12 : this.config.reportsPerUserPerHour ?? 6;
    const deferred = recent.length >= limit;
    const report = { version: 1, type: 'report', id, project: 'dexcode', kind: signal.kind, priority: signal.priority, content, createdAt: new Date(this.now()).toISOString(), source: sourceOf(message), trust: 'untrusted-report-data' };
    if (!this.ctx.dryRun) {
      atomicJson(path.join(this.root, 'inbox', `${id}.json`), report);
      this.index.reports[id] = { userId: message.author.id, channelId: message.channelId, createdAt: report.createdAt, status: 'queued' };
      this.index.messages[message.id] = id;
      this.index.fingerprints[fingerprint] = { reportId: id, at: report.createdAt };
      this.save();
      try { await this.transport?.enqueue?.(report); } catch { /* durable queue remains the delivery owner */ }
    }
    return { id, handled: true, report, deferred, reply: this.ctx.dryRun ? null : deferred ? '🌀 saved this failure too. there are several reports in the fix queue; I’ll bring back its own questions and updates here.' : '🌀 caught that dexCode failure. it’s saved in the fix queue; I’ll bring the working chat’s questions and updates back here.' };
  }

  async followup(original, message, questionMessageId = null) {
    const id = `f-${digest(`${original.id}:${message.id}`).slice(0, 24)}`;
    if (this.index.messages[message.id]) return { id, handled: true, duplicate: true };
    const item = { version: 1, type: 'followup', id, reportId: original.id, project: 'dexcode', priority: original.priority, kind: original.kind, content: clean(message.content), createdAt: new Date(this.now()).toISOString(), source: sourceOf(message), trust: 'untrusted-report-data', ...(questionMessageId ? { questionMessageId } : {}) };
    if (!this.ctx.dryRun) {
      atomicJson(path.join(this.root, 'inbox', `${id}.json`), item);
      this.index.messages[message.id] = original.id; this.save();
      this.index.reports[original.id].lastFollowupAt = item.createdAt; this.save();
      try { await this.transport?.enqueue?.(item); } catch { /* durable queue remains the delivery owner */ }
    }
    return { id, handled: true, followup: item, reply: this.ctx.dryRun ? null : '🌀 saved that extra detail for the same fix. I’ll pass back the next update here.' };
  }

  readEvents() {
    const dir = path.join(this.root, 'outbox');
    return fs.readdirSync(dir).filter((file) => /^e-[a-f0-9]{24}\.json$/.test(file)).filter((file) => {
      try {
        const receipt = JSON.parse(fs.readFileSync(path.join(this.root, 'bot-state', 'events', file), 'utf8'));
        return receipt.status !== 'ignored' && !(receipt.status === 'sent' && receipt.indexApplied === true);
      } catch { return true; }
    }).flatMap((file) => {
      try {
        const full = path.join(dir, file);
        if (fs.statSync(full).size > 16000) return [];
        const value = JSON.parse(fs.readFileSync(full, 'utf8'));
        if (value.version !== 1 || !eventId(value.eventId) || file !== `${value.eventId}.json` || !reportId(value.reportId) || !eventStatuses.has(value.status) || !['public', 'private'].includes(value.audience) || typeof value.summary !== 'string' || !Number.isFinite(Date.parse(value.at))) return [];
        return [value];
      } catch { return []; }
    }).sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || ({ delivered: 1, working: 2, 'needs-info': 3, failed: 4, fixed: 5 }[a.status] - { delivered: 1, working: 2, 'needs-info': 3, failed: 4, fixed: 5 }[b.status]) || a.eventId.localeCompare(b.eventId)).slice(0, 1000);
  }

  async poll() {
    if (this.polling || this.config.enabled === false || this.ctx.dryRun) return false;
    this.polling = true;
    try {
      for (const event of this.readEvents()) {
        const receiptFile = path.join(this.root, 'bot-state', 'events', `${event.eventId}.json`);
        let receipt;
        try { receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8')); } catch { /* first attempt */ }
        if (receipt?.status === 'ignored') continue;
        const report = this.readReport(event.reportId);
        if (!report || !snowflake(report.source.userId) || !snowflake(report.source.channelId) || (report.source.guildId && report.source.guildId !== this.ctx.config.local.guildId)) continue;
        this.ensureIndexed(report); this.save();
        const state = this.index.reports[report.id];
        if (!state) continue;
        if (state.status === 'fixed' && ['delivered', 'working', 'needs-info'].includes(event.status) && (!state.lastFollowupAt || Date.parse(event.at) < Date.parse(state.lastFollowupAt))) { atomicJson(receiptFile, { status: 'ignored', reason: 'closed-report' }); continue; }
        if (receipt?.status === 'sent') {
          if (!state.lastEventAt || Date.parse(event.at) >= Date.parse(state.lastEventAt)) this.acceptEvent(report.id, event, receipt.messageId, receipt.targetChannelId ?? report.source.channelId, receipt.audience === 'private');
          atomicJson(receiptFile, { ...receipt, indexApplied: true });
          continue;
        }
        if (state.lastEventAt && Date.parse(event.at) < Date.parse(state.lastEventAt)) { atomicJson(receiptFile, { status: 'ignored', reason: 'older-event' }); continue; }
        const privateReply = report.source.private || event.audience === 'private';
        let target;
        try {
          if (privateReply) target = await (await this.ctx.guildCtx.guild.members.fetch(report.source.userId)).createDM();
          else {
            target = await this.ctx.guildCtx.guild.channels.fetch(report.source.channelId);
            if (!target || target.guildId !== this.ctx.config.local.guildId || !target.messages) continue;
          }
        } catch { continue; }
        const label = { delivered: '🌀 handed to the dexCode working chat.', working: '🛠️ the fix is being worked on.', 'needs-info': '🔎 the working chat needs one detail:', fixed: '✅ fix update:', failed: '⚠️ the fix route hit a blocker:' }[event.status];
        const body = `${label}\n${clean(event.summary, 1200)}${event.question ? `\n${clean(event.question, 500)}` : ''}`;
        const content = (privateReply ? redactSecrets(body) : publicText(body)).slice(0, 1800);
        const nonce = digest(event.eventId).slice(0, 24);
        if (receipt?.status === 'sending' || receipt?.status === 'uncertain') {
          try {
            const history = await target.messages.fetch({ limit: 100 });
            const found = [...history.values()].find((item) => item.author.id === this.ctx.client.user.id && item.content === content && item.createdTimestamp >= Date.parse(receipt.startedAt) - 2000);
            if (found) { receipt = { ...receipt, status: 'sent', messageId: found.id }; atomicJson(receiptFile, receipt); this.acceptEvent(report.id, event, found.id, target.id, privateReply); atomicJson(receiptFile, { ...receipt, indexApplied: true }); }
          } catch { /* preserve unconfirmed send */ }
          continue;
        }
        receipt = { status: 'sending', startedAt: new Date(this.now()).toISOString(), nonce, targetChannelId: target.id, audience: privateReply ? 'private' : 'public' };
        atomicJson(receiptFile, receipt);
        try {
          const message = await target.send({ content, allowedMentions: { parse: [], repliedUser: false }, flags: 4, nonce, enforceNonce: true, ...(!privateReply ? { reply: { messageReference: report.source.messageId, failIfNotExists: false } } : {}) });
          markGojoFeedback(message, 'gojo-relay');
          atomicJson(receiptFile, { ...receipt, status: 'sent', messageId: message.id });
          this.acceptEvent(report.id, event, message.id, target.id, privateReply);
          atomicJson(receiptFile, { ...receipt, status: 'sent', messageId: message.id, indexApplied: true });
        } catch { atomicJson(receiptFile, { ...receipt, status: 'uncertain' }); }
      }
      return true;
    } finally { this.polling = false; }
  }

  acceptEvent(id, event, messageId, channelId, privateReply) {
    this.index.reports[id].status = event.status;
    this.index.reports[id].lastEventAt = event.at;
    this.index.questions[messageId] = { reportId: id, channelId, private: privateReply };
    this.save();
  }
}
