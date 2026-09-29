// Token lookup shared by supervisor.mjs and dev.mjs. Values come back through stdout pipes only.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OPS = path.dirname(fileURLToPath(import.meta.url));

/** A Windows Credential Manager generic credential, or null. */
export function readCred(target) {
  try {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(OPS, 'read-cred.ps1'), '-Target', target],
      { encoding: 'utf8', windowsHide: true, timeout: 30_000, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return out.trim() || null;
  } catch {
    return null;
  }
}

export function githubToken() {
  const stored = readCred('DEX_GITHUB_DEVBOT');
  if (stored) return { token: stored, source: 'wincred DEX_GITHUB_DEVBOT' };
  try {
    const out = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', windowsHide: true, timeout: 30_000, stdio: ['ignore', 'pipe', 'ignore'] });
    if (out.trim()) return { token: out.trim(), source: 'gh auth token' };
  } catch {
    /* fall through */
  }
  return { token: null, source: 'none' };
}

