#!/usr/bin/env node
// Run the bot once in the foreground with real tokens, for development:
//   node ops/dev.mjs --provision-only
//   node ops/dev.mjs --dry-run
//   node ops/dev.mjs --home D:\Dex\Temp\devbot-home --no-poll
// Extra arguments go straight to src/index.mjs. Default home: D:\Dex\Servers\devbot.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { githubToken, readCred } from './secrets.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (!args.includes('--home')) args.push('--home', process.env.DEVBOT_HOME || 'D:\\Dex\\Servers\\devbot');
const discord = readCred('DEX_DISCORD_DEVBOT');
const gh = githubToken();
if (!discord || !gh.token) {
  console.error(`missing token(s): discord=${discord ? 'ok' : 'missing'} github=${gh.token ? 'ok' : 'missing'}`);
  process.exit(2);
}
const child = spawn(process.execPath, [path.join(REPO, 'src', 'index.mjs'), ...args], {
  cwd: REPO,
  env: { ...process.env, DISCORD_TOKEN: discord, GITHUB_TOKEN: gh.token },
  stdio: 'inherit',
});
child.on('exit', (code) => process.exit(code ?? 1));
process.on('SIGINT', () => child.kill());
