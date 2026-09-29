import test from 'node:test';
import assert from 'node:assert/strict';
import { isSecretPath, redactSecrets } from '../src/core/redact.mjs';
import { codeBlock, commitBody, fileName, joinWithin, truncate, ts } from '../src/core/format.mjs';
import { commitLine, fileLines, splitDiff, withholdSecretFiles } from '../src/core/gitfmt.mjs';
import { cid } from '../src/core/router.mjs';
import { parseArgs } from '../src/core/config.mjs';
import { StateStore } from '../src/core/state.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const project = { key: 'dexclient', repo: 'dexnotavailable/dexclient', name: 'dexClient', emoji: '📦', color: '#22c55e' };

test('redactSecrets hides known token shapes and keeps ordinary code', () => {
  const gh = `ghp_${'a1'.repeat(18)}`;
  const discordToken = ['MTU1NDQ2MTM4NzExNDI4MzA0OQ', 'GygqLh', 'x'.repeat(38)].join('.');
  assert.equal(redactSecrets(`token ${gh} end`), 'token [redacted] end');
  assert.equal(redactSecrets(discordToken), '[redacted]');
  assert.equal(redactSecrets('sk-ant-' + 'z9'.repeat(20)), '[redacted]');
  assert.equal(redactSecrets('api_key: "abcd1234efgh5678ijkl9012"'), 'api_key: "[redacted]"');
  assert.equal(redactSecrets('const token = await getToken()'), 'const token = await getToken()');
  assert.equal(redactSecrets('password: string;'), 'password: string;');
  assert.match(redactSecrets('-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----'), /^\[redacted\]$/);
  assert.equal(redactSecrets(''), '');
  assert.equal(redactSecrets(undefined), undefined);
});

test('isSecretPath flags secret stores but not design tokens or tokenizers', () => {
  for (const p of ['.env', 'app/.env.local', 'auth.json', 'certs/server.pem', 'id_rsa', 'config/secrets.json', 'bot_token', 'ops/github-token.txt', '.npmrc']) {
    assert.equal(isSecretPath(p), true, p);
  }
  for (const p of ['src/tokens.css', 'src/tokenizer.ts', 'packages/ui/design-tokens.json', 'src/auth/token.ts', 'README.md']) {
    assert.equal(isSecretPath(p), false, p);
  }
});

test('format helpers respect limits', () => {
  assert.equal(truncate('abcdef', 4), 'abc…');
  assert.equal(truncate('abc', 4), 'abc');
  assert.equal(commitBody('subject\n\nbody line\nCo-Authored-By: x <y>'), 'body line');
  assert.ok(!codeBlock('a ``` b').slice(3, -3).includes('```'));
  assert.equal(fileName('../../etc/passwd', 'diff'), 'etc_passwd.diff');
  assert.deepEqual(joinWithin(['aa', 'bb', 'cc'], 5), { text: 'aa\nbb', dropped: 1 });
  assert.equal(ts('2026-09-29T00:00:00Z', 'R'), '<t:1790640000:R>');
  assert.equal(ts('nope'), 'unknown time');
});

test('commitLine escapes markdown and redacts', () => {
  const line = commitLine(project, {
    sha: '1d1ae73475a0305e337028812af8bc2c8a84e19b',
    commit: { message: `fix **bold** ghp_${'a1'.repeat(18)}\n\nbody` },
    author: { login: 'dex' },
  });
  assert.match(line, /^\[`1d1ae73`\]\(https:\/\/github\.com\/dexnotavailable\/dexclient\/commit\/1d1ae73/);
  assert.ok(line.includes('\\*\\*bold\\*\\*'));
  assert.ok(line.includes('[redacted]'));
  assert.ok(line.endsWith('— dex'));
});

test('fileLines sorts by churn and reports overflow', () => {
  const files = Array.from({ length: 30 }, (_, i) => ({ filename: `f${i}.js`, status: 'modified', additions: i, deletions: 0, changes: i }));
  const { text, shown, more } = fileLines(files, { max: 5 });
  assert.equal(shown, 5);
  assert.equal(more, 25);
  assert.ok(text.split('\n')[0].includes('f29.js'));
});

test('splitDiff and withholdSecretFiles drop secret files only', () => {
  const diff = [
    'diff --git a/src/a.js b/src/a.js',
    '--- a/src/a.js',
    '+++ b/src/a.js',
    '@@ -1 +1 @@',
    '-a',
    '+b',
    'diff --git a/.env b/.env',
    '--- a/.env',
    '+++ b/.env',
    '@@ -1 +1 @@',
    '+SECRET=1',
    '',
  ].join('\n');
  assert.deepEqual(
    splitDiff(diff).map((c) => c.path),
    ['src/a.js', '.env'],
  );
  const { text, withheld } = withholdSecretFiles(diff);
  assert.deepEqual(withheld, ['.env']);
  assert.ok(text.includes('src/a.js'));
  assert.ok(!text.includes('SECRET'));
});

test('cid builds bounded custom ids', () => {
  assert.equal(cid('feed', 'diff', 'dexcode', 'abc', 'def'), 'feed:diff:dexcode:abc:def');
  assert.throws(() => cid('feed', 'x', 'a:b'));
  assert.throws(() => cid('feed', 'x', 'y'.repeat(100)));
});

test('parseArgs', () => {
  const a = parseArgs(['--home', 'X', '--provision-only', '--dry-run']);
  assert.equal(a.home, 'X');
  assert.equal(a.provision, true);
  assert.equal(a.provisionOnly, true);
  assert.equal(a.dryRun, true);
  assert.throws(() => parseArgs(['--nope']));
});

test('StateStore persists atomically and quarantines corrupt files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devbot-state-'));
  try {
    const s = new StateStore(dir);
    const heads = s.get('heads', { a: {} });
    heads.a.main = 'abc';
    s.save('heads', { immediate: true });
    const again = new StateStore(dir).get('heads');
    assert.deepEqual(again, { a: { main: 'abc' } });
    fs.writeFileSync(path.join(dir, 'broken.json'), '{nope');
    const fresh = new StateStore(dir).get('broken', { x: 1 });
    assert.deepEqual(fresh, { x: 1 });
    assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('broken.json.corrupt-')));
    assert.throws(() => s.get('../evil'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
