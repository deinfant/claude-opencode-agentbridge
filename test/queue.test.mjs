import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Queue } from '../queue.mjs';

const tempRoot = process.env.AGENTBRIDGE_TEST_TMP || tmpdir();
function fixture(t) {
  const dir = mkdtempSync(join(tempRoot, 'agentbridge-queue-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let time = 100000;
  const file = join(dir, 'queue.json');
  const queue = new Queue(file, () => time);
  return { queue, file, advance: ms => { time += ms; } };
}

test('offline and unconfirmed channels keep durable messages; acknowledgement survives restart', t => {
  const { queue: q, file } = fixture(t);
  const m = q.send({ from: 'opencode', text: 'Review game.ServerScriptService.Combat' });
  assert.deepEqual(q.claim({ role: 'claude', consumer: 'c' }), []);
  q.heartbeat({ role: 'claude', consumer: 'c', ready: false });
  assert.deepEqual(q.claim({ role: 'claude', consumer: 'c' }), []);
  assert.equal(new Queue(file).inbox({ role: 'claude' })[0].id, m.id);
  q.heartbeat({ role: 'claude', consumer: 'c', ready: true });
  assert.equal(q.claim({ role: 'claude', consumer: 'c' })[0].id, m.id);
  q.ack({ role: 'claude', consumer: 'c', ids: [m.id] });
  assert.equal(new Queue(file).inbox({ role: 'claude' }).length, 0);
});

test('exclusive receiver, leases, and recovery when a peer exits', t => {
  const { queue: q, advance } = fixture(t);
  const m = q.send({ from: 'claude', text: 'handoff' });
  q.heartbeat({ role: 'opencode', consumer: 'a', ready: true });
  assert.equal(q.heartbeat({ role: 'opencode', consumer: 'b', ready: true }).active, false);
  q.claim({ role: 'opencode', consumer: 'a' });
  advance(16000);
  q.heartbeat({ role: 'opencode', consumer: 'b', ready: true });
  assert.deepEqual(q.claim({ role: 'opencode', consumer: 'b' }), []);
  advance(30000);
  q.heartbeat({ role: 'opencode', consumer: 'b', ready: true });
  assert.equal(q.claim({ role: 'opencode', consumer: 'b' })[0].id, m.id);
});

test('pause, inbox-only messages, deduplication and thread wake limit', t => {
  const { queue: q } = fixture(t);
  q.heartbeat({ role: 'claude', consumer: 'c', ready: true });
  const first = q.send({ from: 'opencode', text: 'start', dedupe_key: 'test' });
  assert.equal(q.send({ from: 'opencode', text: 'retry', dedupe_key: 'test' }).id, first.id);
  q.send({ from: 'opencode', text: 'FYI', kind: 'info' });
  q.send({ from: 'opencode', text: 'Thanks', kind: 'ack' });
  q.pause({ paused: true });
  assert.deepEqual(q.claim({ role: 'claude', consumer: 'c' }), []);
  q.pause({ paused: false });
  assert.deepEqual(q.claim({ role: 'claude', consumer: 'c' }).map(m => m.id), [first.id]);
  let parent = first;
  for (let i = 1; i < 13; i++) {
    parent = q.send({ from: parent.to, text: 'reply', kind: 'reply', reply_to: parent.id });
    assert.equal(parent.thread_id, first.thread_id);
    assert.equal(parent.wake, i < 12);
  }
  assert.match(parent.held_reason, /12 automatic wakes/);
});
