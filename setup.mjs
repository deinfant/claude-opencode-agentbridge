import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Setup is finite: no broker, MCP process, or AI application is started here.
const target = process.argv[2];
if (!target) {
  console.error('Usage: node setup.mjs <existing-project-directory>');
  process.exit(1);
}
const project = resolve(target);
if (!existsSync(project)) throw new Error('The project directory must already exist.');
const home = fileURLToPath(new URL('.', import.meta.url));
const configPath = join(project, '.mcp.json');
const original = existsSync(configPath) ? readFileSync(configPath, 'utf8') : null;
const config = original === null ? {} : JSON.parse(original);
const server = {
  command: process.execPath,
  args: [join(home, 'claude.mjs')],
  env: { AGENTBRIDGE_PROJECT: project, AGENTBRIDGE_NODE: process.execPath },
};
if (process.env.AGENTBRIDGE_PORT) server.env.AGENTBRIDGE_PORT = process.env.AGENTBRIDGE_PORT;
if (config.mcpServers?.agentbridge && config.mcpServers.agentbridge.args?.[0] !== server.args[0]) {
  throw new Error('An unrelated agentbridge MCP entry already exists; choose a different project or update it manually.');
}
const wrapperPath = join(project, '.opencode', 'plugins', 'agentbridge.js');
const wrapper = `// Managed by claude-opencode-agentbridge setup.mjs\nprocess.env.AGENTBRIDGE_NODE ||= ${JSON.stringify(process.execPath)};\n${process.env.AGENTBRIDGE_PORT ? `process.env.AGENTBRIDGE_PORT ||= ${JSON.stringify(process.env.AGENTBRIDGE_PORT)};\n` : ''}export { default } from ${JSON.stringify(pathToFileURL(join(home, 'opencode-plugin.js')).href)};\n`;
if (existsSync(wrapperPath)) {
  const existing = readFileSync(wrapperPath, 'utf8');
  if (!existing.includes('Managed by claude-opencode-agentbridge setup.mjs')) {
    throw new Error('An existing OpenCode agentbridge plugin needs manual review; setup will not overwrite it.');
  }
}
if (original !== null && !existsSync(configPath + '.agentbridge-backup')) {
  writeFileSync(configPath + '.agentbridge-backup', original, { flag: 'wx' });
}
config.mcpServers ||= {};
config.mcpServers.agentbridge = server;
writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
mkdirSync(join(project, '.opencode', 'plugins'), { recursive: true });
writeFileSync(wrapperPath, wrapper);
console.log(`Configured Claude Code and OpenCode for ${project}`);
console.log('Restart OpenCode. Start Claude with: claude --dangerously-load-development-channels server:agentbridge');
console.log('Approve the project MCP/channel prompts, then ask OpenCode to call agentbridge_connect in your chosen main session.');
