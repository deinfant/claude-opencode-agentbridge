import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createReceiver } from '../opencode-receiver.mjs';
import { Queue } from '../queue.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(process.env.AGENTBRIDGE_TEST_TMP || tmpdir(), 'agentbridge-receiver-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let time = 100000, status = 'busy', prompts = [], statusCalls = 0, ackFailures = 0;
  const q = new Queue(join(dir, 'queue.json'), () => time);
  const client = { session: {
    get: async () => ({ data: { id: 'main', agent: 'build', model: { providerID: 'openai', modelID: 'test' } } }),
    status: async () => { statusCalls++; return { data: status === 'absent' ? {} : { main: { type: status } } }; },
    promptAsync: async input => { prompts.push(input); return { data: undefined }; },
  } };
  const request = async (route, body) => {
    if (route === '/ack' && ackFailures > 0) { ackFailures--; throw new Error('temporary ack failure'); }
    return q[route.slice(1)](body);
  };
  const receiver = createReceiver(client, { request, now: () => time, bindingPath: join(dir, 'binding.json') });
  return { q, client, receiver, prompts, advance: ms => { time += ms; }, setStatus: s => { status = s; }, failAck: () => { ackFailures++; }, calls: () => statusCalls };
}

test('busy/retry turns are never cancelled; only idle main session gets delivery with its agent/model', async t => {
  const f = fixture(t);
  const m = f.q.send({ from: 'claude', text: 'Ready to review' });
  await f.receiver.connect('main');
  f.advance(4000);
  await f.receiver.tick();
  f.setStatus('retry'); await f.receiver.tick();
  assert.equal(f.prompts.length, 0);
  assert.equal(f.q.inbox({ role: 'opencode' }).length, 1);
  f.setStatus('absent'); await f.receiver.tick();
  assert.equal(f.prompts.length, 1);
  assert.equal(f.prompts[0].path.id, 'main');
  assert.equal(f.prompts[0].body.agent, 'build');
  assert.deepEqual(f.prompts[0].body.model, { providerID: 'openai', modelID: 'test' });
  assert.match(f.prompts[0].body.parts[0].text, new RegExp(m.id));
  assert.equal(f.q.inbox({ role: 'opencode' }).length, 0);
});

test('race to busy after claim releases the lease without prompting', async t => {
  const f = fixture(t);
  f.q.send({ from: 'claude', text: 'queued' });
  await f.receiver.connect('main'); f.advance(4000);
  let calls = 0;
  f.client.session.status = async () => ({ data: { main: { type: ++calls === 1 ? 'idle' : 'busy' } } });
  await f.receiver.tick();
  assert.equal(f.prompts.length, 0);
  assert.equal(f.q.inbox({ role: 'opencode' })[0].lease, undefined);
});

test('an ack failure retries acknowledgement rather than reinjecting the message', async t => {
  const f = fixture(t);
  f.q.send({ from: 'claude', text: 'queued' });
  await f.receiver.connect('main'); f.advance(4000); f.setStatus('idle'); f.failAck();
  await f.receiver.tick();
  assert.equal(f.prompts.length, 1);
  assert.equal(f.q.inbox({ role: 'opencode' }).length, 1);
  await f.receiver.tick();
  assert.equal(f.prompts.length, 1);
  assert.equal(f.q.inbox({ role: 'opencode' }).length, 0);
});

test('subagents cannot bind the receiver', async t => {
  const f = fixture(t);
  f.client.session.get = async () => ({ data: { id: 'child', parentID: 'main' } });
  await assert.rejects(f.receiver.connect('child'), /main OpenCode session/);
});
