#!/usr/bin/env node
// Keeps GOJO running. Before every start it fast-forwards this checkout to origin/devbot (only
// when the working tree is clean), reinstalls dependencies when package-lock.json changed, and
// reads the tokens: Discord from Windows Credential Manager (DEX_DISCORD_DEVBOT), GitHub from
// Credential Manager (DEX_GITHUB_DEVBOT, optional) or else the gh CLI keyring. Tokens only ever
// travel through stdout pipes and the child's environment, never a command line or a log.
//
// Bot exit codes: 75 = restart now (after /admin restart or an update), 2 = config error (wait
// 5 min), anything else = crash (backoff 5 s doubling to 5 min, reset after 10 min healthy).
//
// usage: node ops/supervisor.mjs [--home D:\Dex\Servers\devbot] [--no-pull] [--once]

import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { githubToken, readCred } from './secrets.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : def;
};
const HOME = opt('--home', process.env.DEVBOT_HOME || 'D:\\Dex\\Servers\\devbot');
const PULL = !argv.includes('--no-pull');
const ONCE = argv.includes('--once');
const BRANCH = 'devbot';
const RESTART = 75;
const CONFIG_ERROR = 2;

const LOGS = path.join(HOME, 'logs');
const STATE = path.join(HOME, 'state');
fs.mkdirSync(LOGS, { recursive: true });
fs.mkdirSync(STATE, { recursive: true });
const LOG = path.join(LOGS, 'supervisor.log');

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG, `${line}\n`);
  } catch {
    /* ignore */
  }
}

// ------------------------------------------------------------------ single instance
const PIDFILE = path.join(HOME, 'supervisor.pid');
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}
try {
  const old = Number(fs.readFileSync(PIDFILE, 'utf8'));
  if (old && old !== process.pid && alive(old)) {
    log(`another supervisor (pid ${old}) is running; exiting`);
    process.exit(0);
  }
} catch {
  /* no pid file */
}
fs.writeFileSync(PIDFILE, String(process.pid));
const cleanup = () => {
  try {
    if (Number(fs.readFileSync(PIDFILE, 'utf8')) === process.pid) fs.rmSync(PIDFILE);
  } catch {
    /* ignore */
  }
};
process.on('exit', cleanup);

// ------------------------------------------------------------------ helpers
function git(...args) {
  return spawnSync('git', ['-C', REPO, ...args], { encoding: 'utf8', windowsHide: true, timeout: 120_000 });
}

function update() {
  if (!PULL) return;
  const status = git('status', '--porcelain', '--untracked-files=no');
  if (status.status !== 0) return log(`git status failed: ${status.stderr.trim()}`);
  if (status.stdout.trim()) return log('local changes in the checkout; skipping pull');
  const fetch = git('fetch', '--quiet', 'origin', BRANCH);
  if (fetch.status !== 0) return log(`git fetch failed (offline?): ${fetch.stderr.trim()}`);
  const before = git('rev-parse', 'HEAD').stdout.trim();
  const merge = git('merge', '--ff-only', '--quiet', `origin/${BRANCH}`);
  if (merge.status !== 0) return log(`fast-forward failed: ${merge.stderr.trim()}`);
  const after = git('rev-parse', 'HEAD').stdout.trim();
  if (before !== after) log(`updated ${before.slice(0, 7)} -> ${after.slice(0, 7)}`);
}

function lockHash() {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(path.join(REPO, 'package-lock.json'))).digest('hex');
  } catch {
    return null;
  }
}

function installIfNeeded() {
  const marker = path.join(STATE, 'installed-lock.sha256');
  const want = lockHash();
  let have = null;
  try {
    have = fs.readFileSync(marker, 'utf8').trim();
  } catch {
    /* never installed */
  }
  if (want && have === want && fs.existsSync(path.join(REPO, 'node_modules', 'discord.js'))) return true;
  log('installing dependencies (npm ci)');
  // npm is a .cmd shim on Windows, which needs a shell; the arguments are fixed strings.
  const res = spawnSync('npm ci --omit=dev --no-audit --no-fund', { cwd: REPO, shell: true, encoding: 'utf8', windowsHide: true, timeout: 600_000 });
  if (res.status !== 0) {
    log(`npm ci failed: ${(res.stderr || res.stdout || '').trim().split('\n').slice(-5).join(' | ')}`);
    return false;
  }
  if (want) fs.writeFileSync(marker, want);
  return true;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ main loop
let child = null;
let stopping = false;
function stop() {
  stopping = true;
  if (child) child.kill();
  setTimeout(() => process.exit(0), 3_000).unref();
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

let backoff = 5_000;
log(`supervisor ${process.pid} starting; repo ${REPO}, home ${HOME}, pull ${PULL}`);
while (!stopping) {
  update();
  if (!installIfNeeded()) {
    await sleep(60_000);
    continue;
  }
  const discord = readCred('DEX_DISCORD_DEVBOT');
  const gh = githubToken();
  if (!discord || !gh.token) {
    log(`missing token(s): discord=${discord ? 'ok' : 'MISSING (wincred DEX_DISCORD_DEVBOT)'} github=${gh.token ? 'ok' : 'MISSING (gh auth login or wincred DEX_GITHUB_DEVBOT)'}; retrying in 5 min`);
    await sleep(300_000);
    continue;
  }
  const errLog = fs.openSync(path.join(LOGS, 'bot.stderr.log'), 'a');
  const started = Date.now();
  log(`starting bot (github token from ${gh.source})`);
  child = spawn(process.execPath, [path.join(REPO, 'src', 'index.mjs'), '--home', HOME], {
    cwd: REPO,
    env: { ...process.env, DISCORD_TOKEN: discord, GITHUB_TOKEN: gh.token, DEVBOT_HOME: HOME },
    stdio: ['ignore', 'ignore', errLog],
    windowsHide: true,
  });
  const code = await new Promise((resolve) => {
    child.on('exit', (c, signal) => resolve(c ?? (signal ? 1 : 0)));
    child.on('error', (err) => {
      log(`spawn failed: ${err.message}`);
      resolve(1);
    });
  });
  child = null;
  fs.closeSync(errLog);
  const upMs = Date.now() - started;
  log(`bot exited with ${code} after ${Math.round(upMs / 1000)} s`);
  if (stopping || ONCE) break;
  if (code === RESTART) {
    backoff = 5_000;
    continue;
  }
  if (code === 0) {
    log('bot exited cleanly (shutdown requested); supervisor stopping too');
    break;
  }
  if (code === CONFIG_ERROR) {
    await sleep(300_000);
    continue;
  }
  if (upMs > 600_000) backoff = 5_000;
  log(`restarting in ${Math.round(backoff / 1000)} s`);
  await sleep(backoff);
  backoff = Math.min(backoff * 2, 300_000);
}
cleanup();
