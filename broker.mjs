import { createServer } from 'node:http';
import { join } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { Queue } from './queue.mjs';
import { port, token, project, stateDir } from './common.mjs';

const queue = new Queue(join(stateDir, 'queue.json'));
let lastActivity = Date.now();
const server = createServer(async (req, res) => {
  const respond = (status, result) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(result)); };
  const supplied = Buffer.from(req.headers.authorization || '');
  const expected = Buffer.from(`Bearer ${token}`);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return respond(401, { error: 'Unauthorized' });
  lastActivity = Date.now();
  try {
    if (req.method === 'GET' && req.url === '/health') return respond(200, { project, protocol: 1 });
    if (req.method === 'GET' && req.url === '/status') return respond(200, queue.status());
    if (req.method !== 'POST') return respond(404, { error: 'Unknown route' });
    const chunks = [];
    let bytes = 0;
    for await (const chunk of req) { bytes += chunk.length; if (bytes > 100000) return respond(413, { error: 'Request too large' }); chunks.push(chunk); }
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const method = { '/heartbeat': 'heartbeat', '/send': 'send', '/claim': 'claim', '/ack': 'ack', '/release': 'release', '/inbox': 'inbox', '/pause': 'pause' }[req.url];
    if (!method) return respond(404, { error: 'Unknown route' });
    const role = body.role || body.from;
    if (method !== 'pause' && !['opencode', 'claude'].includes(role)) throw new Error('Invalid agent role');
    if (['heartbeat', 'claim', 'release', 'ack'].includes(method) && typeof body.consumer !== 'string') throw new Error('consumer is required');
    if (['ack', 'release'].includes(method) && !Array.isArray(body.ids)) throw new Error('ids must be an array');
    respond(200, queue[method](body));
  } catch (error) { respond(400, { error: error.message }); }
});
server.on('error', error => { if (error.code === 'EADDRINUSE') process.exit(0); throw error; });
server.listen(port, '127.0.0.1');
const idleTimer = setInterval(() => {
  if (Date.now() - lastActivity > 60000 && !queue.active('opencode') && !queue.active('claude')) {
    clearInterval(idleTimer);
    server.close(() => process.exit(0));
  }
}, 5000);
idleTimer.unref();
