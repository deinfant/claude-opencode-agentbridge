import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { home, nodeExecutable } from '../common.mjs';

// All children belong to this finite check. The plugin must connect to this
// prestarted, isolated broker instead of launching its detached production one.
const children = [];
let dir;
let logs = '';
let spawnError;
function cleanup() {
  for (const child of [...children].reverse()) {
    if (child.exitCode === null) child.kill('SIGKILL');
    child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy();
    child.unref();
  }
}
const deadline = Date.now() + 20000;
const watchdog = setTimeout(() => {
  console.error('[bridge check] Deadline reached. Stopping BOTH test processes.');
  cleanup();
  process.exit(1);
}, 20000);
async function freePort() {
  const socket = createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}
function start(command, args, env) {
  const child = spawn(command, args, { cwd: dir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env });
  children.push(child);
  child.on('error', error => { spawnError = error; });
  child.stdout.on('data', chunk => { logs += chunk.toString(); });
  child.stderr.on('data', chunk => { logs += chunk.toString(); });
  return child;
}
async function waitFor(label, check) {
  console.log(`[bridge check] ${label}`);
  let lastProgress = Date.now();
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    for (const child of children) if (child.exitCode !== null) throw new Error(`Test process exited (${child.exitCode}): ${logs}`);
    try { if (await check()) return; } catch {}
    if (Date.now() - lastProgress > 2000) { console.log(`[bridge check] Still waiting: ${label}`); lastProgress = Date.now(); }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Test deadline reached');
}
try {
  console.log('[bridge check] Hard deadline: 20 seconds, including helper cleanup.');
  dir = mkdtempSync(join(process.env.AGENTBRIDGE_TEST_TMP || tmpdir(), 'agentbridge-smoke-'));
  const port = await freePort();
  const bridgePort = await freePort();
  const password = randomUUID();
  const env = {
    ...process.env, AGENTBRIDGE_PROJECT: dir, AGENTBRIDGE_STATE_DIR: dir, AGENTBRIDGE_PORT: String(bridgePort),
    // An isolated test must fail rather than spawn an untracked background process.
    AGENTBRIDGE_NO_AUTOSTART: '1',
    OPENCODE_SERVER_USERNAME: 'bridge-test', OPENCODE_SERVER_PASSWORD: password,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugin: [new URL('../opencode-plugin.js', import.meta.url).href] }),
    XDG_CONFIG_HOME: dir, OPENCODE_CONFIG_DIR: dir,
    OPENCODE_DISABLE_EXTERNAL_SKILLS: '1', OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
  };
  start(nodeExecutable, [join(home, 'broker.mjs')], env);
  await waitFor('Starting isolated test broker...', async () => {
    const token = readFileSync(join(dir, 'token'), 'utf8').trim();
    const response = await fetch(`http://127.0.0.1:${bridgePort}/health`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(500) });
    return response.ok;
  });
  // Run from an isolated project, with only the explicitly configured bridge.
  start(process.env.AGENTBRIDGE_OPENCODE || 'opencode', ['serve', '--hostname', '127.0.0.1', '--port', String(port), '--print-logs'], env);
  const api = async (route, options = {}, timeout = 8000) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      ...options, headers: { authorization: `Basic ${Buffer.from('bridge-test:' + password).toString('base64')}`, 'x-opencode-directory': dir },
      signal: AbortSignal.timeout(Math.max(1, Math.min(timeout, deadline - Date.now()))),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`OpenCode HTTP ${response.status}: ${text}`);
    return text ? JSON.parse(text) : undefined;
  };
  await waitFor('Starting temporary OpenCode server...', async () => Boolean(await api('/global/health', {}, 500)));
  console.log('[bridge check] Checking plugin tools...');
  const ids = await api('/experimental/tool/ids');
  for (const id of ['agentbridge_connect', 'agentbridge_send', 'agentbridge_status', 'agentbridge_inbox', 'agentbridge_received', 'agentbridge_pause']) {
    assert.ok(ids.includes(id), `OpenCode did not expose ${id}. Logs: ${logs}`);
  }
  console.log('[bridge check] PASS. Stopping temporary OpenCode AND its test broker.');
  await api('/instance/dispose', { method: 'POST' }, 1000).catch(() => {});
} finally {
  cleanup();
  await Promise.all(children.map(child => new Promise(resolve => {
    if (child.exitCode !== null || !child.pid) return resolve();
    const timer = setTimeout(resolve, 1000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  })));
  if (dir) rmSync(dir, { recursive: true, force: true });
  clearTimeout(watchdog);
}
console.log('[bridge check] Finished; both test processes stopped.');
process.exit(0);
