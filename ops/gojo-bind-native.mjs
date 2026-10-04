import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OFFICIAL_SERVER, serverHash, openBoundNative, StdioMcpClient, NativeMcpError } from './codex-native-mcp.mjs';

export function relayPath(home) {
  if (typeof home !== 'string' || !/^D:[\\/]/i.test(home)) throw new Error('Relay home must be D-backed');
  return path.join(path.resolve(home), 'gojo', 'relay');
}
export async function bindNative({ home, serverPath = OFFICIAL_SERVER, env = process.env }) {
  const root = relayPath(home);
  const binding = { pipePath: env.CODEX_APP_TOOLS_PIPE_PATH, originThreadId: env.CODEX_THREAD_ID, serverPath, serverSha256: serverHash(serverPath) };
  if (!/^\\\\\.\\pipe\\[^\r\n]+$/.test(binding.pipePath ?? '') || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(binding.originThreadId ?? '')) throw new NativeMcpError('executor-binding-unavailable');
  const client = new StdioMcpClient({ binding });
  try {
    await client.initialize();
    const result = await client.call('read_thread', { threadId: binding.originThreadId, turnLimit: 1, includeOutputs: false, maxOutputCharsPerItem: 100 });
    if (result.thread?.id !== binding.originThreadId) throw new NativeMcpError('origin-unverified');
    fs.mkdirSync(root, { recursive: true });
    const file = path.join(root, 'native-binding.json');
    const temporary = `${file}.${process.pid}.tmp`;
    try { fs.writeFileSync(temporary, JSON.stringify(binding), { mode: 0o600, flag: 'wx' }); fs.renameSync(temporary, file); }
    finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    return { status: 'bound', originVerified: true, officialServerVerified: true };
  } finally { client.close(); }
}
export async function probeNative({ home }) {
  const client = await openBoundNative(relayPath(home));
  try {
    const result = await client.call('read_thread', { threadId: client.binding.originThreadId, turnLimit: 1, includeOutputs: false, maxOutputCharsPerItem: 100 });
    if (result.thread?.id !== client.binding.originThreadId) throw new NativeMcpError('origin-unverified');
    return { status: 'available', originVerified: true, officialServerVerified: true };
  } finally { client.close(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const flag = (name) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
    const args = { home: flag('--home'), ...(flag('--server') ? { serverPath: flag('--server') } : {}) };
    if (process.argv.includes('--bind') === process.argv.includes('--probe')) throw new Error();
    console.log(JSON.stringify(process.argv.includes('--bind') ? await bindNative(args) : await probeNative(args)));
  } catch (error) { console.error(JSON.stringify({ status: 'unavailable', code: error instanceof NativeMcpError ? error.code : 'invalid-bind-request' })); process.exitCode = 1; }
}
