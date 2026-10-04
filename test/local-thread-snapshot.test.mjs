import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { codexTailStatus, collectLocalThreads, writeSnapshot, isBotGenerationCwd, projectForCwd } from '../ops/local-thread-snapshot.mjs';

test('bot-native contexts are excluded from sibling thread discovery; project mapping does not expose paths', () => {
  assert.equal(isBotGenerationCwd('D:\\Dex\\Servers\\devbot\\gojo\\generation-workspace'), true);
  assert.equal(isBotGenerationCwd('D:\\Dex\\Temp\\probe\\gojo\\generation-workspace'), true);
  assert.equal(isBotGenerationCwd('D:\\Dex\\Temp\\claude-core\\integration'), false);
  assert.equal(projectForCwd('D:\\Dex\\Temp\\claude-core\\integration'), 'dexcode');
  assert.equal(projectForCwd('D:\\Dex\\Projects\\dex.place'), 'dexplace');
  assert.equal(projectForCwd('D:\\Dex\\GameDev\\Projects\\CharacterForge'), 'characterforge');
  assert.equal(projectForCwd('C:\\Users\\sanic\\Documents\\ChatGPT\\dexcode 2'), null);
});

test('activity-only tails do not fabricate a running thread or copy user/tool text', () => {
  const result = codexTailStatus([
    { timestamp: '2026-10-04T00:00:00Z', type: 'response_item', payload: { type: 'message', role: 'user', content: 'private user prompt' } },
    { timestamp: '2026-10-04T00:00:01Z', type: 'response_item', payload: { type: 'function_call', arguments: 'private tool text' } },
    { timestamp: '2026-10-04T00:00:02Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Testing the installer.' }] } },
  ]);
  assert.equal(result.state, 'unknown');
  assert.equal(result.activity, 'Testing the installer.');
  assert.equal(result.sourceUpdatedAt, '2026-10-04T00:00:02Z');
  assert.doesNotMatch(JSON.stringify(result), /private/);
});
test('completion marker wins over previous running marker and local identifiers are withheld', () => {
  const result = codexTailStatus([
    { timestamp: '2026-10-04T00:00:00Z', type: 'event_msg', payload: { type: 'task_started' } },
    { timestamp: '2026-10-04T00:01:00Z', type: 'event_msg', payload: { type: 'agent_message', message: 'Checking D:\\Dex\\Private\\data.txt for thread 01a10428-5deb-7933-84bf-4afe68e160d1' } },
    { timestamp: '2026-10-04T00:02:00Z', type: 'event_msg', payload: { type: 'task_complete' } },
  ]);
  assert.equal(result.state, 'complete');
  assert.equal(result.sourceUpdatedAt, '2026-10-04T00:02:00Z');
  assert.doesNotMatch(result.activity, /data\.txt|01a10428/);
});
test('missing inventories remain unavailable and persisted snapshot does not invent freshness', async () => {
  const parent = 'D:\\Dex\\Temp\\gojo-snapshot-tests';
  fs.mkdirSync(parent, { recursive: true });
  const dir = fs.mkdtempSync(path.join(parent, 'case-'));
  try {
    const snapshot = await collectLocalThreads({ codexHome: path.join(dir, 'codex'), claudeHome: path.join(dir, 'claude'), now: Date.parse('2026-10-04T00:00:00Z') });
    assert.equal(snapshot.sourceUpdatedAt, null);
    assert.equal(snapshot.threads.length, 0);
    assert.equal(snapshot.notes.length, 2);
    const file = path.join(dir, 'snapshot.json');
    writeSnapshot(file, snapshot);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), snapshot);
    assert.throws(() => writeSnapshot('C:\\Temp\\snapshot.json', snapshot), /D-backed/);
  } finally {
    if (!path.resolve(dir).startsWith(path.resolve(parent) + path.sep)) throw new Error('invalid fixture cleanup target');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
