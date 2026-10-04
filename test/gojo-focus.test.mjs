import test from 'node:test';
import assert from 'node:assert/strict';
import { scopeProjectThreads, buildPrompt } from '../src/core/gojo-context.mjs';

const projects = [{ key: 'be7ade8c-8537-5415-89b9-07df371d1c14', name: 'dexCode' }, { key: 'dexclient', name: 'dexClient' }, { key: 'dexplace', name: 'dex.place' }];
test('explicit focus excludes unrelated and unknown private threads without making the source fresh', () => {
  const snapshot = { capturedAt: '2026-10-04T10:00:00Z', sourceUpdatedAt: '2026-10-04T09:59:00Z', threads: [
    { projectKey: 'characterforge', sourceUpdatedAt: '2026-10-04T09:59:00Z', activity: 'outside focus' },
    { projectKey: 'dexcode', sourceUpdatedAt: '2026-10-04T08:00:00Z', activity: 'code repair' },
    { projectKey: 'dexclient', sourceUpdatedAt: '2026-10-04T08:01:00Z', activity: 'installer check' },
    { projectKey: 'dexplace', sourceUpdatedAt: '2026-10-04T08:02:00Z', activity: 'site update' },
    { projectKey: null, sourceUpdatedAt: '2026-10-04T09:58:00Z', activity: 'unknown work' },
  ] };
  const scoped = scopeProjectThreads(snapshot, projects);
  assert.deepEqual(scoped.threads.map(thread => thread.projectKey), ['dexcode', 'dexclient', 'dexplace']);
  assert.equal(scoped.sourceUpdatedAt, '2026-10-04T08:02:00Z');
  assert.equal(snapshot.threads.length, 5);
  assert.equal(scopeProjectThreads(snapshot, []).sourceUpdatedAt, null);
});
test('current project focus takes precedence over historical bot and CLI topics', () => {
  const prompt = buildPrompt({ mode: 'heartbeat', snapshot: { projects }, history: [{ role: 'assistant', content: 'CharacterForge was introduced earlier.' }] });
  assert.match(prompt, /Current relevant projects are only: dexCode, dexClient, dex\.place/);
  assert.match(prompt, /do not become relevant automatically/);
});
