import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * Parse argv into { home, provision, dryRun, noPoll, noCommands }.
 * --home <dir>        runtime home (state/, logs/, local.json). Default D:\Dex\Servers\devbot
 * --provision         full layout apply (renames, topics, permissions) instead of create-missing only
 * --provision-only    provision and exit
 * --dry-run           log outgoing Discord posts instead of sending them
 * --no-poll           do not start pollers (commands still work)
 */
export function parseArgs(argv = process.argv.slice(2)) {
  const args = { home: process.env.DEVBOT_HOME || 'D:\\Dex\\Servers\\devbot', provision: false, provisionOnly: false, dryRun: false, noPoll: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--home') args.home = argv[++i];
    else if (a === '--provision') args.provision = true;
    else if (a === '--provision-only') {
      args.provision = true;
      args.provisionOnly = true;
    } else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--no-poll') args.noPoll = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return args;
}

/**
 * Loads committed config (config/*.json) plus machine-local config (<home>/local.json, never
 * committed). local.json:
 * {
 *   "guildId": "...",                       // required: the one server this bot serves
 *   "ownerIds": ["..."],                    // optional extra owners besides the guild owner
 *   "localRepos": { "dexcode": "D:\\..." },  // optional: a checkout per project, for /worktree
 *   "deployStateFiles": { "dexplace": "D:\\Dex\\Servers\\dex.place\\state.json" },
 *   "githubCollaboratorPermission": "pull"  // what /access grants
 * }
 */
export function loadConfig(home) {
  const projectsFile = readJson(path.join(REPO_ROOT, 'config', 'projects.json'));
  const layout = readJson(path.join(REPO_ROOT, 'config', 'layout.json'));
  const localPath = path.join(home, 'local.json');
  let local = {};
  if (fs.existsSync(localPath)) local = readJson(localPath);

  const projects = projectsFile.projects;
  const keys = new Set();
  for (const p of projects) {
    if (!/^[a-z0-9]+$/.test(p.key)) throw new Error(`project key must be [a-z0-9]+: ${p.key}`);
    if (keys.has(p.key)) throw new Error(`duplicate project key ${p.key}`);
    if (!/^[\w.-]+\/[\w.-]+$/.test(p.repo)) throw new Error(`bad repo for ${p.key}: ${p.repo}`);
    keys.add(p.key);
  }

  return {
    home,
    projects,
    project(key) {
      return projects.find((p) => p.key === key) ?? null;
    },
    poll: projectsFile.poll,
    feed: projectsFile.feed,
    digest: projectsFile.digest,
    layout,
    local: {
      guildId: local.guildId ?? null,
      ownerIds: local.ownerIds ?? [],
      localRepos: local.localRepos ?? {},
      deployStateFiles: local.deployStateFiles ?? {},
      githubCollaboratorPermission: local.githubCollaboratorPermission ?? 'pull',
    },
  };
}
