import { request } from './common.mjs';
// Finite terminal commands never launch a persistent child process.
// The interactive Claude/OpenCode adapters own broker startup instead.
const [command, ...args] = process.argv.slice(2);
try {
  if (command === 'status') console.log(JSON.stringify(await request('/status'), null, 2));
  else if (command === 'pause' || command === 'resume') console.log(JSON.stringify(await request('/pause', { paused: command === 'pause' }), null, 2));
  else if (command === 'send' && ['claude', 'opencode'].includes(args[0])) console.log(JSON.stringify(await request('/send', { from: args[0], text: args.slice(1).join(' '), kind: 'request' }), null, 2));
  else if (command === 'inbox' && ['claude', 'opencode'].includes(args[0])) console.log(JSON.stringify(await request('/inbox', { role: args[0] }), null, 2));
  else { console.error('Usage: node cli.mjs status|pause|resume|send <from-agent> <text>|inbox <recipient>'); process.exitCode = 1; }
} catch (error) {
  console.error(error.bridgeConnectionFailure ? 'Bridge is offline. Open a bridge-enabled Claude or OpenCode session first.' : error.message);
  process.exitCode = 1;
}
