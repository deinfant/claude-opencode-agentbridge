import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';

export const home = fileURLToPath(new URL('.', import.meta.url));
// Both adapters must launch in the same working project, or use the same
// AGENTBRIDGE_PROJECT override. The checkout can live anywhere on the machine.
export const project = resolve(process.env.AGENTBRIDGE_PROJECT || process.cwd());
export const stateDir = process.env.AGENTBRIDGE_STATE_DIR || join(project, '.agentbridge', '.state');
export const port = Number(process.env.AGENTBRIDGE_PORT || 49173);
export const baseUrl = `http://127.0.0.1:${port}`;
// OpenCode runs plugins under Bun; spawning process.execPath there would launch
// Bun/OpenCode instead of Node. Node itself retains its exact executable path.
export const nodeExecutable = process.env.AGENTBRIDGE_NODE || (process.versions.bun ? 'node' : process.execPath);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('AGENTBRIDGE_PORT must be an integer between 1 and 65535.');
mkdirSync(stateDir, { recursive: true });
const tokenPath = join(stateDir, 'token');
try { writeFileSync(tokenPath, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }); }
catch (error) { if (error.code !== 'EEXIST') throw error; }
export const token = readFileSync(tokenPath, 'utf8').trim();

export async function request(route, body) {
  let response;
  try {
    response = await fetch(baseUrl + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(4000),
    });
  } catch (error) { error.bridgeConnectionFailure = true; throw error; }
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Bridge HTTP ${response.status}`);
  return result;
}

export async function ensureBroker() {
  try {
    const health = await request('/health');
    if (health.project !== project) throw new Error('This port belongs to another project bridge.');
    return;
  } catch (error) {
    // A live but incompatible service must not be replaced or mistaken for our broker.
    if (!error.bridgeConnectionFailure) throw error;
  }
  if (process.env.AGENTBRIDGE_NO_AUTOSTART === '1') throw new Error('Test broker is unavailable; automatic background startup is disabled.');
  const child = spawn(nodeExecutable, [join(home, 'broker.mjs')], {
    detached: true, stdio: 'ignore', windowsHide: true, cwd: project, env: process.env,
  });
  let spawnError;
  child.on('error', error => { spawnError = error; });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    if (spawnError) throw spawnError;
    try {
      const health = await request('/health');
      if (health.project !== project) throw new Error('Unexpected project bridge.');
      return;
    } catch (error) {
      if (i === 39) throw error;
    }
  }
}

// The broker can exit when both apps close. Reconnect lazily without touching
// either app's interactive process or starting a new AI session.
export async function bridgeRequest(route, body) {
  try { return await request(route, body); }
  catch (error) {
    if (!error.bridgeConnectionFailure) throw error;
    await ensureBroker();
    return request(route, body);
  }
}
