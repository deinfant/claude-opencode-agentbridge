import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';
const home = fileURLToPath(new URL('../', import.meta.url));

test('real stdio MCP: absent handshake acknowledgement holds messages; ready enables notifications and replies', { timeout: 20000 }, async t => {
  const dir = mkdtempSync(join(process.env.AGENTBRIDGE_TEST_TMP || tmpdir(), 'agentbridge-protocol-'));
  const socket = createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const env = { ...process.env, AGENTBRIDGE_STATE_DIR: dir, AGENTBRIDGE_PORT: String(port), AGENTBRIDGE_NO_AUTOSTART: '1' };
  // Own the broker directly. A finite check must never launch detached helpers.
  const broker = spawn(process.execPath, [join(home, 'broker.mjs')], { env, stdio: 'ignore', windowsHide: true });
  let brokerError;
  broker.on('error', error => { brokerError = error; });
  const transport = new StdioClientTransport({
    command: process.execPath, args: [join(home, 'claude.mjs')], stderr: 'ignore', env,
  });
  const client = new Client({ name: 'bridge-test', version: '1' }, { capabilities: {} });
  const notifications = [];
  client.setNotificationHandler(z.object({ method: z.literal('notifications/claude/channel'), params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()) }) }), n => { notifications.push(n.params); });
  t.after(async () => {
    try { await client.close(); }
    finally {
      if (broker.pid && broker.exitCode === null && broker.signalCode === null) {
        const exited = new Promise(resolve => {
          const timer = setTimeout(resolve, 1000);
          broker.once('exit', () => { clearTimeout(timer); resolve(); });
        });
        broker.kill('SIGKILL');
        await exited;
      }
      broker.unref();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  for (let i = 0; ; i++) {
    if (brokerError) throw brokerError;
    if (broker.exitCode !== null) throw new Error('Test broker exited before startup.');
    try {
      const token = readFileSync(join(dir, 'token'), 'utf8').trim();
      const health = await fetch(`http://127.0.0.1:${port}/health`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(500) });
      if (health.ok) break;
    } catch {}
    if (i === 50) throw new Error('Test broker did not start.');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await client.connect(transport);
  const tools = await client.listTools();
  assert.ok(tools.tools.some(t => t.name === 'send'));
  assert.deepEqual(client.getServerCapabilities().experimental['claude/channel'], {});
  const token = readFileSync(join(dir, 'token'), 'utf8').trim();
  const api = async (route, body, authenticated = true) => {
    const res = await fetch(`http://127.0.0.1:${port}${route}`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...(authenticated ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(2000) });
    return { status: res.status, data: await res.json() };
  };
  assert.equal((await api('/status', undefined, false)).status, 401);
  const message = (await api('/send', { from: 'opencode', text: 'test delivery' })).data;
  const waitFor = async predicate => { for (let i = 0; i < 60; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error('Timed out'); };
  await waitFor(() => notifications.some(n => n.meta.kind === 'handshake'));
  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.equal(notifications.filter(n => n.meta.id === message.id).length, 0);
  assert.equal((await api('/status')).data.peers.claude.ready, false);
  const invalid = await client.callTool({ name: 'ready', arguments: { code: 'invented' } });
  assert.equal(invalid.isError, true);
  const code = notifications.find(n => n.meta.kind === 'handshake').content.match(/code ([a-f0-9-]+)/)[1];
  await client.callTool({ name: 'ready', arguments: { code } });
  await waitFor(() => notifications.some(n => n.meta.id === message.id));
  const replyResult = await client.callTool({ name: 'send', arguments: { text: 'test reply', kind: 'reply', reply_to: message.id } });
  assert.ok(!replyResult.isError);
  const reply = JSON.parse(replyResult.content[0].text);
  assert.equal(reply.to, 'opencode');
  assert.equal(reply.thread_id, message.thread_id);
  assert.equal((await api('/inbox', { role: 'claude' })).data.length, 0);
  assert.equal((await api('/inbox', { role: 'opencode' })).data[0].text, 'test reply');
});
