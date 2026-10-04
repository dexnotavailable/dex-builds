import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { atomicJson, digest } from './gojo-store.mjs';
import { GOJO_SCHEMA, validateResponse } from './gojo-policy.mjs';

const uuid = (value) => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
const DISABLED = ['daemon_auto_start', 'shell_tool', 'unified_exec', 'code_mode_host', 'code_mode', 'code_mode_only', 'multi_agent', 'multi_agent_v2', 'apps', 'plugins', 'hooks', 'memories', 'browser_use', 'computer_use', 'view_image', 'workspace_dependencies', 'image_generation', 'goals', 'shell_snapshot'];

export function childEnvironment(source = process.env, temporary) {
  const env = {};
  for (const [key, value] of Object.entries(source)) {
    if (/^(?:DISCORD_TOKEN|GITHUB_TOKEN|GH_TOKEN|OPENAI_|ANTHROPIC_|CLAUDE_|CLAUDECODE|CODEX_(?!HOME$)|NODE_OPTIONS|NODE_EXTRA_CA_CERTS|NODE_TLS_REJECT_UNAUTHORIZED|AI_AGENT)/i.test(key) || /(?:TOKEN|SECRET|PASSWORD|API_KEY)/i.test(key)) continue;
    env[key] = value;
  }
  return { ...env, TEMP: temporary, TMP: temporary, PYTHONDONTWRITEBYTECODE: '1' };
}

export function cliArguments(provider, route, { directory, cwd, sessionId = null }) {
  if (sessionId && !uuid(sessionId)) throw new Error('CLI resume requires an exact session UUID');
  if (provider === 'codex') {
    const args = ['exec', '--json', '--strict-config', '--ignore-user-config', '--ignore-rules'];
    for (const feature of DISABLED) args.push('--disable', feature);
    args.push('--enable', 'skip_host_skill_discovery', '-c', 'project_doc_max_bytes=0', '-c', 'notify=[]', '-c', 'web_search="disabled"', '-c', 'approval_policy="never"', '-c', 'windows.sandbox="unelevated"', '-m', route.model, '-c', `model_reasoning_effort=${JSON.stringify(route.effort)}`, '-s', 'read-only', '--skip-git-repo-check', '-C', cwd);
    args.push('--output-schema', path.join(directory, 'schema.json'), '-o', path.join(directory, 'reply.json'));
    if (sessionId) args.push('resume', '-m', route.model, '-c', `model_reasoning_effort=${JSON.stringify(route.effort)}`, sessionId);
    args.push('-');
    return args;
  }
  if (provider !== 'claude') throw new Error('Unsupported generation provider');
  const args = ['-p', '--output-format', 'json', '--model', route.model, '--effort', route.effort, '--setting-sources', '', '--safe-mode', '--disable-slash-commands', '--no-chrome', '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--tools', '', '--strict-mcp-config', '--mcp-config', path.join(directory, 'empty-mcp.json'), '--settings', path.join(directory, 'claude-settings.json'), '--json-schema', JSON.stringify(GOJO_SCHEMA)];
  if (sessionId) args.push('--resume', sessionId);
  return args;
}

export function parseCli(provider, stdout, { code = 0, sessionId = null, lastMessage = '' } = {}) {
  if (code !== 0) throw Object.assign(new Error('Generation CLI failed'), { category: /usage|quota|rate.?limit/i.test(stdout) ? 'usage' : /login|auth|sign.in/i.test(stdout) ? 'auth' : 'provider' });
  if (provider === 'claude') {
    let data = JSON.parse(stdout);
    if (Array.isArray(data)) data = data.findLast((entry) => entry.type === 'result');
    if (data?.type !== 'result' || data.is_error || data.subtype !== 'success') throw Object.assign(new Error('Claude generation is unavailable'), { category: /login|auth|sign.in/i.test(data?.result ?? '') ? 'auth' : 'provider' });
    const models = Object.keys(data.modelUsage ?? {});
    const actual = data.session_id;
    if (!uuid(actual) || (sessionId && sessionId !== actual)) throw new Error('Claude returned a different or missing exact session');
    return { response: validateResponse(data.structured_output ?? JSON.parse(data.result)), sessionId: actual, observedModel: models.length === 1 ? models[0] : null, usage: data.usage ?? null };
  }
  let completed = false;
  let actual = sessionId;
  let text = lastMessage;
  let usage = null;
  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    const event = JSON.parse(line);
    if (event.type === 'thread.started') {
      if (sessionId && event.thread_id !== sessionId) throw new Error('Codex resumed a different exact session');
      actual = event.thread_id;
    }
    // Fail closed on any attempted tool use, even if it only proposed a plan.
    if (event.item && !['agent_message', 'reasoning', 'error'].includes(event.item.type)) throw Object.assign(new Error('Generation attempted a forbidden tool'), { category: 'policy' });
    if (event.type === 'item.completed' && event.item?.type === 'agent_message') text = event.item.text;
    if (event.type === 'turn.completed') { completed = true; usage = event.usage ?? null; }
    if (event.type === 'turn.failed') completed = false;
  }
  if (!completed || !uuid(actual) || !text) throw Object.assign(new Error('Codex did not finish a valid generation'), { category: 'provider' });
  return { response: validateResponse(JSON.parse(text)), sessionId: actual, observedModel: null, usage };
}

/** Reads only metadata from the exact owned CLI rollout; never another task's content. */
export function observeCodexSession(sessionId, knownFile = null, codexHome = process.env.CODEX_HOME || path.join(process.env.USERPROFILE ?? '', '.codex')) {
  const root = path.resolve(codexHome, 'sessions');
  const within = (file) => path.resolve(file).startsWith(`${root}${path.sep}`) && path.basename(file).includes(sessionId);
  let file = knownFile && within(knownFile) && fs.existsSync(knownFile) ? knownFile : null;
  if (!file) {
    for (const offset of [0, -1, 1]) {
      const day = new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10).split('-');
      const dir = path.join(root, ...day);
      try { file = fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl') && name.includes(sessionId)).map((name) => path.join(dir, name))[0] ?? null; } catch { /* previous-day sessions can be absent */ }
      if (file) break;
    }
  }
  if (!file) throw new Error('Exact Codex model evidence is unavailable');
  const handle = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(handle).size;
    const start = Math.max(0, size - 768_000);
    const bytes = Buffer.alloc(Math.min(size, 768_000));
    fs.readSync(handle, bytes, 0, bytes.length, start);
    const lines = bytes.toString('utf8').split('\n');
    if (start) lines.shift();
    const contexts = lines.flatMap((line) => { try { const row = JSON.parse(line); return row.type === 'turn_context' ? [row.payload] : []; } catch { return []; } });
    const latest = contexts.at(-1);
    if (!latest?.model) throw new Error('Codex turn context model evidence is missing');
    return { model: latest.model, effort: latest.effort ?? latest.reasoning_effort ?? latest.reasoning?.effort ?? null, file };
  } finally { fs.closeSync(handle); }
}

/** Prompt uses stdin, no shell interpolation, no inherited bot/account secrets. */
export function runGenerationProcess({ executable, args, cwd, prompt, temporary, timeoutSeconds, signal, spawnChild = spawn }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error('Generation cancelled'), { category: 'cancelled' }));
    const child = spawnChild(executable, args, { cwd, windowsHide: true, shell: false, env: childEnvironment(process.env, temporary), stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', stopped = null, closed = false;
    const stop = (category) => {
      if (closed || stopped) return;
      stopped = category;
      // ChildProcess ownership pins this live PID; never kill a persisted or discovered PID.
      if (process.platform === 'win32' && child.pid && child.exitCode === null) execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, () => { if (!closed) child.kill(); });
      else child.kill('SIGKILL');
    };
    const timer = setTimeout(() => stop('timeout'), timeoutSeconds * 1000);
    const abort = () => stop('cancelled');
    signal?.addEventListener('abort', abort, { once: true });
    const finish = () => { closed = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    child.stdout.on('data', (chunk) => { stdout += chunk; if (stdout.length > 2_000_000) stop('output-limit'); });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-20_000); });
    child.stdin.on('error', () => {});
    child.once('error', () => { finish(); reject(Object.assign(new Error('Generation executable is unavailable'), { category: 'provider' })); });
    child.once('close', (code) => { finish(); if (stopped) reject(Object.assign(new Error(`Generation ${stopped}`), { category: stopped })); else resolve({ stdout, stderr, code }); });
    child.stdin.end(prompt);
  });
}

export class GojoCli {
  constructor({ config, store, run = runGenerationProcess, observe = observeCodexSession, log }) { Object.assign(this, { config, store, run, observe, log }); }

  async generate(key, prompt, { signal } = {}) {
    const context = this.store.context(key);
    const routes = [['codex', this.config.codex], ['claude', this.config.claude]].filter(([, route]) => route?.enabled !== false);
    const attempts = [];
    for (const [provider, route] of routes) {
      signal?.throwIfAborted();
      const current = context.sessions[provider];
      if (current && (current.model !== route.model || current.effort !== route.effort)) throw new Error('Configured model changed for an existing Gojo context; explicitly migrate that session');
      const directory = path.join(this.store.root, 'generation', digest(key), randomUUID());
      const cwd = path.join(this.store.root, 'generation-workspace');
      const temporary = path.join(this.store.root, 'tmp');
      fs.mkdirSync(cwd, { recursive: true }); fs.mkdirSync(temporary, { recursive: true });
      atomicJson(path.join(directory, 'schema.json'), GOJO_SCHEMA);
      atomicJson(path.join(directory, 'empty-mcp.json'), { mcpServers: {} });
      atomicJson(path.join(directory, 'claude-settings.json'), { forceLoginMethod: 'claudeai', disableAllHooks: true, permissions: { defaultMode: 'dontAsk', allow: [], deny: ['Bash', 'PowerShell', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Agent', 'Task', 'WebFetch', 'WebSearch'] } });
      const args = cliArguments(provider, route, { directory, cwd, sessionId: current?.id ?? null });
      try {
        if (!route.executable || (process.platform === 'win32' && !route.executable.toLowerCase().endsWith('.exe'))) throw Object.assign(new Error('A verified native generation executable is required'), { category: 'provider' });
        const output = await this.run({ executable: route.executable, args, cwd, prompt, temporary, signal, timeoutSeconds: this.config.timeoutSeconds });
        let lastMessage = '';
        if (provider === 'codex' && fs.existsSync(path.join(directory, 'reply.json'))) lastMessage = fs.readFileSync(path.join(directory, 'reply.json'), 'utf8');
        const result = parseCli(provider, output.stdout, { code: output.code, sessionId: current?.id, lastMessage });
        const evidence = provider === 'codex' ? this.observe(result.sessionId, current?.rolloutFile) : { model: result.observedModel, effort: route.effort, file: null };
        if (evidence.model !== route.model || evidence.effort !== route.effort) throw Object.assign(new Error('Requested model/effort execution was not verified'), { category: 'model-mismatch' });
        context.sessions[provider] = { id: result.sessionId, model: evidence.model, effort: evidence.effort, rolloutFile: evidence.file, updatedAt: new Date().toISOString() };
        this.store.save();
        const receipt = { provider, model: evidence.model, effort: evidence.effort, modelEvidence: provider === 'codex' ? 'Exact native rollout turn_context' : 'Provider modelUsage', effortEvidence: provider === 'codex' ? 'Exact native rollout turn_context' : 'Requested --effort flag; provider result does not report actual effort', sessionId: result.sessionId, resumed: !!current, usage: result.usage, at: new Date().toISOString(), attempts };
        atomicJson(path.join(directory, 'receipt.json'), receipt);
        if (fs.existsSync(path.join(directory, 'reply.json'))) fs.unlinkSync(path.join(directory, 'reply.json'));
        return { ...result, receipt };
      } catch (error) {
        const category = error.category ?? 'invalid-result';
        attempts.push({ provider, model: route.model, effort: route.effort, category, at: new Date().toISOString() });
        atomicJson(path.join(directory, 'receipt.json'), { status: 'failed', ...attempts.at(-1) });
        this.log?.info(`generation ${provider}: ${category}`); // no prompt, IDs, private text or provider stderr in Discord log sink
        if (signal?.aborted || ['cancelled', 'policy', 'model-mismatch'].includes(category)) throw error;
      }
    }
    throw Object.assign(new Error('Configured generation routes are unavailable'), { category: 'unavailable', attempts });
  }
}
