// Thin standard MCP STDIO client. The unchanged bundled app-tools server owns IPC.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

export const OFFICIAL_SERVER = 'C:\\Users\\sanic\\.codex\\plugins\\cache\\openai-bundled\\codex-app-tools\\0.1.5\\server.mjs';
const TOOLS = new Set(['list_threads', 'read_thread', 'wait_threads', 'send_message_to_thread']);
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
export class NativeMcpError extends Error {
  constructor(code) { super(`Native app-tools ${code}`); this.code = code; }
}
export function serverHash(serverPath) {
  if (!/^[A-Z]:[\\/]Users[\\/][^\\/]+[\\/]\.codex[\\/]plugins[\\/]cache[\\/]openai-bundled[\\/]codex-app-tools[\\/][^\\/]+[\\/]server\.mjs$/i.test(serverPath)) throw new NativeMcpError('server-path-invalid');
  try {
    if (fs.lstatSync(serverPath).isSymbolicLink()) throw new Error();
    return createHash('sha256').update(fs.readFileSync(serverPath)).digest('hex');
  } catch { throw new NativeMcpError('server-unavailable'); }
}
export function readBinding(relayRoot) {
  const file = path.join(relayRoot, 'native-binding.json');
  let binding;
  try {
    if (fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size > 16_384) throw new Error();
    binding = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { throw new NativeMcpError('binding-unavailable'); }
  if (Object.keys(binding ?? {}).sort().join(',') !== 'originThreadId,pipePath,serverPath,serverSha256'
    || !UUID.test(binding.originThreadId ?? '') || !/^\\\\\.\\pipe\\[^\r\n]+$/.test(binding.pipePath ?? '')
    || !/^[a-f0-9]{64}$/.test(binding.serverSha256 ?? '')) throw new NativeMcpError('binding-invalid');
  if (serverHash(binding.serverPath) !== binding.serverSha256) throw new NativeMcpError('server-changed-rebind-required');
  return binding;
}
export function nativePayload(result) {
  if (result?.isError) throw new NativeMcpError('tool-rejected');
  if (result?.structuredContent && typeof result.structuredContent === 'object') return result.structuredContent;
  for (const content of result?.content ?? []) {
    if (content.type !== 'text') continue;
    try { return JSON.parse(content.text); } catch { /* no transcript-text fallback */ }
  }
  throw new NativeMcpError('response-invalid');
}
// Business response projection only: never retain response text, IDs or diagnostics.
export function dispatchReceipt(result) {
  const statuses = new Set(['queued', 'accepted', 'sent', 'delivered', 'pending', 'scheduled', 'started', 'failed', 'error', 'rejected', 'unavailable', 'blocked']);
  const modes = new Set(['queued', 'immediate', 'delivered', 'pending', 'steering', 'followup', 'injected']);
  const receipt = { classification: 'unclassified', arrivalConfirmed: false, fields: {} };
  const value = result && typeof result === 'object' && !Array.isArray(result) ? result : {};
  for (const key of ['status', 'deliveryMode', 'queued', 'accepted', 'delivered', 'sent', 'success', 'ok', 'error', 'errors']) {
    if (!Object.hasOwn(value, key)) continue;
    receipt.fields[key] = value[key] === null ? 'null' : Array.isArray(value[key]) ? 'array' : typeof value[key];
    if (['queued', 'accepted', 'delivered', 'sent', 'success', 'ok'].includes(key) && typeof value[key] === 'boolean') receipt[key] = value[key];
  }
  const status = typeof value.status === 'string' ? value.status : value.status?.type;
  if (status != null) receipt.businessStatus = statuses.has(status) ? status : 'other';
  if (value.deliveryMode != null) receipt.deliveryMode = modes.has(value.deliveryMode) ? value.deliveryMode : 'other';
  receipt.errorPresent = !!value.error || (Array.isArray(value.errors) && value.errors.length > 0);
  if (receipt.errorPresent || value.success === false || value.ok === false || ['failed', 'error', 'rejected', 'unavailable', 'blocked'].includes(status)) receipt.classification = 'rejected';
  else if (value.queued === true || ['queued', 'pending', 'scheduled'].includes(status) || ['queued', 'pending'].includes(value.deliveryMode)) receipt.classification = 'queued';
  else if (value.accepted === true || value.sent === true || value.delivered === true || value.success === true || value.ok === true || ['accepted', 'sent', 'delivered', 'started'].includes(status)) receipt.classification = 'accepted';
  return receipt;
}
export class StdioMcpClient {
  constructor({ binding, timeoutMs = 15_000, maxOutputBytes = 4_194_304, spawnImpl = spawn, signal = null }) {
    if (!UUID.test(binding?.originThreadId ?? '')) throw new NativeMcpError('binding-invalid');
    this.binding = binding;
    this.timeoutMs = Math.min(Math.max(timeoutMs, 100), 60_000);
    this.maxOutputBytes = maxOutputBytes;
    this.pending = new Map(); this.sequence = 0; this.buffer = ''; this.closed = false;
    // Only the official server gets the exact previously captured executor locator.
    const env = {};
    for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP']) if (process.env[key]) env[key] = process.env[key];
    env.CODEX_APP_TOOLS_PIPE_PATH = binding.pipePath;
    try {
      this.child = spawnImpl(process.execPath, [binding.serverPath], { env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch { throw new NativeMcpError('transport-unavailable'); }
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this.receive(chunk));
    this.child.stderr.on('data', () => {}); // Drain, never persist server/pipe diagnostics.
    this.child.on('error', () => this.fail('transport-unavailable'));
    this.child.on('exit', () => this.fail('transport-closed'));
    this.child.stdin.on('error', () => this.fail('transport-closed'));
    this.signal = signal; this.abort = () => this.fail('request-aborted');
    signal?.addEventListener('abort', this.abort, { once: true });
    if (signal?.aborted) this.abort();
  }
  receive(chunk) {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > this.maxOutputBytes) return this.fail('output-bound-exceeded');
    while (this.buffer.includes('\n')) {
      const end = this.buffer.indexOf('\n');
      const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { return this.fail('protocol-invalid'); }
      if (message.jsonrpc !== '2.0') return this.fail('protocol-invalid');
      const pending = this.pending.get(message.id);
      if (!pending) continue; // MCP notifications are not app-tool responses.
      clearTimeout(pending.timer); this.pending.delete(message.id);
      if (message.error) pending.reject(new NativeMcpError('request-rejected'));
      else pending.resolve(message.result);
    }
  }
  fail(code) {
    if (this.closed) return;
    this.closed = true;
    this.signal?.removeEventListener('abort', this.abort);
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new NativeMcpError(code)); }
    this.pending.clear(); this.buffer = ''; this.child?.kill();
  }
  request(method, params = {}) {
    if (this.closed) return Promise.reject(new NativeMcpError('transport-closed'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail('request-timeout'), this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const line = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      if (Buffer.byteLength(line) > 65_536) return this.fail('input-bound-exceeded');
      this.child.stdin.write(`${line}\n`, (error) => { if (error) this.fail('transport-closed'); });
    });
  }
  async initialize() {
    await this.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'gojo-relay', version: '1.0.0' } });
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const result = await this.request('tools/list');
    this.toolNames = new Set((result?.tools ?? []).map((tool) => tool.name));
    for (const name of TOOLS) if (!this.toolNames.has(name)) throw new NativeMcpError('required-tool-unavailable');
    return this;
  }
  async call(name, args = {}) {
    if (!TOOLS.has(name) || !this.toolNames?.has(name)) throw new NativeMcpError('tool-not-allowed');
    // Origin is captured from the real executor once. No fabricated turn/call metadata.
    return nativePayload(await this.request('tools/call', { name, arguments: args, _meta: { threadId: this.binding.originThreadId } }));
  }
  close() { this.fail('transport-closed'); }
}
export async function openBoundNative(relayRoot, options = {}) {
  const client = new StdioMcpClient({ ...options, binding: readBinding(relayRoot) });
  try { return await client.initialize(); } catch (error) { client.close(); throw error; }
}
