import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function resolveNativeExecutable(provider, override = null, environment = process.env) {
  if (override) return override; // An explicit machine route is never silently substituted.
  const local = environment.LOCALAPPDATA ?? path.join(environment.USERPROFILE ?? 'C:\\Users\\sanic', 'AppData', 'Local');
  const roaming = environment.APPDATA ?? path.join(environment.USERPROFILE ?? 'C:\\Users\\sanic', 'AppData', 'Roaming');
  const roots = provider === 'codex' ? [path.join(local, 'OpenAI', 'Codex', 'bin'), path.join(local, 'Programs', 'OpenAI', 'Codex', 'bin')] : [path.join(roaming, 'Claude', 'claude-code')];
  const candidates = [];
  const scan = (directory, depth) => {
    try {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true }).slice(0, 100)) {
        const file = path.join(directory, entry.name);
        if (entry.isFile() && entry.name.toLowerCase() === `${provider}.exe`) candidates.push({ file, changedAt: fs.statSync(file).mtimeMs });
        else if (entry.isDirectory() && depth > 0) scan(file, depth - 1);
      }
    } catch { /* A missing installed app is an unavailable route. */ }
  };
  for (const root of roots) scan(root, provider === 'codex' ? 1 : 2);
  return candidates.sort((a, b) => b.changedAt - a.changedAt)[0]?.file ?? null;
}

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
  const gojo = local.gojo ?? {};
  for (const [field, fallback, minimum, maximum] of [['heartbeatSeconds', 3600, 60, 86400], ['timeoutSeconds', 600, 30, 1800], ['projectsPerPost', 3, 1, 8], ['messagesPerBatch', 8, 1, 20], ['chatterDebounceMs', 1200, 0, 5000], ['conversationIdleSeconds', 900, 60, 86400]]) {
    const value = gojo[field] ?? fallback;
    if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`gojo.${field} must be an integer ${minimum}..${maximum}`);
  }
  if (gojo.quietHours) {
    for (const field of ['start', 'end']) if (!Number.isInteger(gojo.quietHours[field]) || gojo.quietHours[field] < 0 || gojo.quietHours[field] > 23) throw new Error(`gojo.quietHours.${field} must be 0..23`);
    new Intl.DateTimeFormat('en-US', { timeZone: gojo.quietHours.timezone ?? 'Asia/Bangkok' }).format();
  }
  if (gojo.relay?.projectRoots !== undefined && (!Array.isArray(gojo.relay.projectRoots) || gojo.relay.projectRoots.some((root) => typeof root !== 'string' || !/^D:[\\/]/i.test(root) || !path.win32.isAbsolute(root) || /[\r\n\0]/.test(root)))) throw new Error('gojo.relay.projectRoots must be an array of absolute D-backed directories');

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
    gojo: {
      enabled: local.gojo?.enabled ?? true,
      channel: local.gojo?.channel ?? 'water-cooler',
      heartbeatSeconds: local.gojo?.heartbeatSeconds ?? 3600,
      timeoutSeconds: local.gojo?.timeoutSeconds ?? 600,
      projectsPerPost: local.gojo?.projectsPerPost ?? 3,
      ledgerRoot: local.gojo?.ledgerRoot ?? 'D:\\Dex\\Automation\\ProjectLedger',
      threadSnapshotFile: local.gojo?.threadSnapshotFile ?? path.join(home, 'gojo-thread-snapshot.json'),
      publicProjectIds: local.gojo?.publicProjectIds ?? [],
      ignoreProjectIds: local.gojo?.ignoreProjectIds ?? [],
      ignoreChannelIds: local.gojo?.ignoreChannelIds ?? [],
      quietHours: local.gojo?.quietHours ?? null,
      messagesPerBatch: local.gojo?.messagesPerBatch ?? 8,
      chatterDebounceMs: local.gojo?.chatterDebounceMs ?? 1200,
      conversationIdleSeconds: local.gojo?.conversationIdleSeconds ?? 900,
      relay: {
        enabled: local.gojo?.relay?.enabled ?? true,
        channelKeys: local.gojo?.relay?.channelKeys ?? ['ships-dexcode'],
        channelIds: local.gojo?.relay?.channelIds ?? [],
        duplicateWindowSeconds: local.gojo?.relay?.duplicateWindowSeconds ?? 900,
        reportsPerUserPerHour: local.gojo?.relay?.reportsPerUserPerHour ?? 6,
        criticalReportsPerUserPerHour: local.gojo?.relay?.criticalReportsPerUserPerHour ?? 12,
        projectRoots: local.gojo?.relay?.projectRoots ?? [],
      },
      codex: {
        enabled: true,
        executable: resolveNativeExecutable('codex', local.gojo?.codex?.executable),
        model: 'gpt-6.1-sol', effort: 'xhigh',
      },
      claude: {
        enabled: local.gojo?.claude?.enabled ?? true,
        executable: resolveNativeExecutable('claude', local.gojo?.claude?.executable),
        model: 'claude-sonnet-5-5', effort: 'medium',
      },
    },
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
