# GOJO SATORU · the dev bot for the sam altman office

This `devbot` branch of `dex-builds` holds the Discord bot for the dex dev server. It is an orphan branch that shares no history with `main`, so the `heads/` files that dexClient reads stay untouched. GOJO:

- posts **every push to every branch** of dexcode, dexclient and dex.place into per-project channels, with diff, file-list and discussion-thread buttons
- posts PRs, issues, failed CI runs, dex.place deploys and a daily standup
- lets trusted reviewers read source, diffs, branches and Dex's live local worktrees from Discord
- turns feedback into forum posts and GitHub issues, and handles GitHub repo-access requests with a one-click owner approval
- keeps the server layout as code (`config/layout.json`)

It runs on Dex's PC as the scheduled task `\Dex\Dex Devbot`.

## Commands

| Command | Who | What |
|---|---|---|
| `/help` | everyone | this list, in Discord |
| `/status` | everyone (staff see more) | feeds, last pushes, deploys, open PRs, bot health |
| `/feedback new` | everyone | a form that becomes a post in `#rlhf` |
| `/feedback track` · `/feedback ship` | staff | in an `#rlhf` post: make a GitHub issue / mark shipped |
| `/access request` · `/access status` | everyone | ask for GitHub access; Dex approves in `#board-meeting` |
| `/access revoke` · `/access list` | owner | remove someone's GitHub access / see who has it |
| `/source` | staff | a file or folder at any branch/commit (autocompleted paths) |
| `/diff` | staff | a commit or a range as a summary plus a `.diff` file |
| `/commits` · `/branches` | staff | recent commits on a ref / branches by last activity |
| `/worktree list` · `/worktree diff` | staff | Dex's local worktrees and their uncommitted tracked changes (secrets withheld) |
| `/review` | staff | a review request in `#red-team` with the diff, a thread and verdict buttons |
| `/clone` | everyone | how to clone a project and check a branch out as a worktree |
| `/standup` | staff | preview today's standup digest |
| `/hire` · `/fire` | owner | give or take the `member of technical staff` badge |
| `/admin …` | owner | restart, re-apply layout, pause/resume feeds, poll now, resync commands |

"Staff" means the `member of technical staff` role; the owner counts as staff everywhere.

## Running it

Runtime home `D:\Dex\Servers\devbot`:

| Path | What |
|---|---|
| `repo\` | clone of this branch; the supervisor fast-forwards it before every start |
| `local.json` | machine config: guild id, local repo paths, deploy state files. Never committed |
| `state\` | JSON state (`layout`, `heads`, `activity`, …) |
| `logs\` | `devbot.log`, `supervisor.log`, `bot.stderr.log` |

Tokens are never stored in files:

- Discord: Windows Credential Manager generic credential `DEX_DISCORD_DEVBOT`
- GitHub: `DEX_GITHUB_DEVBOT` in Credential Manager if present, otherwise `gh auth token`

The GitHub token needs admin on the three repos for `/access` (inviting and removing collaborators). The repo owner's `gh` login has that. A fine-grained token needs Administration: write. On repos owned by a personal account, GitHub ignores the permission level: **every collaborator can push**. `/access` says so on its card. For true read-only reviewers, move the repos into a GitHub organization; `/source`, `/diff` and `/worktree` stay read-only regardless.

Discord: the app has the Server Members and Message Content intents enabled in the Developer Portal. Members drive onboarding, and Message Content lets `/feedback track` read member-written `#rlhf` posts. Turn off **Public Bot** in the portal; the bot also leaves any server that isn't its home.

```powershell
# install / update the scheduled task and start it
powershell -NoProfile -ExecutionPolicy Bypass -File D:\Dex\Servers\devbot\repo\ops\install-task.ps1 -StartNow
# foreground dev run with real tokens (extra args go to src/index.mjs)
node ops/dev.mjs --no-poll
node ops/dev.mjs --provision-only      # re-apply config/layout.json and exit
node ops/dev-interact.mjs --as staff "/source project:dexclient path:package.json"   # drive a handler without Discord clicks
npm test
```

Updating: push to `devbot`, then `/admin restart` in Discord (or restart the task). The supervisor pulls, reinstalls dependencies when `package-lock.json` changed, and starts the new code.

## Architecture

```
src/index.mjs            entry point for the real bot
src/app.mjs              createApp(): config, client, ctx, provisioning, command registration, module start
src/core/                shared plumbing (no Discord features live here)
  config.mjs             config/projects.json + config/layout.json + <home>/local.json
  state.mjs              StateStore: one JSON file per namespace, atomic debounced writes
  github.mjs             REST + GraphQL client, ETag cache, pagination, RateLimitError
  guild.mjs              GuildContext (layout keys -> channels/roles/tags), isOwner/isStaff/requireStaff/requireOwner
  router.mjs             module contract, command registration, interaction routing, cid()
  scheduler.mjs          non-overlapping interval jobs, rate-limit aware, pausable
  projects.mjs           project/ref slash options, ref autocomplete, UserError
  gitfmt.mjs             commit lines, file lists, diff payloads (shared look)
  format.mjs             Discord limits, truncation, code blocks, attachments
  redact.mjs             redactSecrets(), isSecretPath()
  log.mjs                redacting logger; warn/error also reach #compute-bill
src/modules/             one feature per file, each exporting the module object
ops/                     supervisor, launcher, task installer, credential reader, dev runner, handler harness
config/                  projects.json (what to watch), layout.json (server layout)
test/                    node:test unit tests for the pure parts
```

### Module contract

```js
export default {
  name: 'feed',                                  // also the customId prefix
  commands: (config) => [SlashCommandBuilder…], // or a plain array; registered as guild commands
  async onCommand(interaction, ctx) {},
  async onAutocomplete(interaction, ctx) {},
  components: { diff: async (interaction, ctx, args) => {} }, // customId `feed:diff:<args…>`
  events: { guildMemberAdd: async (member, ctx) => {} },     // extra gateway events (ctx is last)
  async start(ctx) {},                           // after ready + provisioning; schedule jobs here
  async stop(ctx) {},
};
```

`ctx` = `{ args, config, client, state, github, flags, log, dryRun, startedAt, guildCtx, bus, scheduler, router, restart(), shutdown() }`.

- Build customIds with `cid(module, action, ...args)`. The limit is 100 chars, and args must not contain `:`.
- Throw `UserError` for user mistakes. The router shows its message as-is. Other errors show as "GOJO tripped".
- Every reply that reveals private source (file contents, diffs, commit lists, worktrees) must check `requireStaff` in the handler itself. A button in a staff-only channel is not an access check.
- Anything that changes GitHub or roles, apart from a user's own opt-in ping roles, must check `requireOwner`, or `requireStaff` where noted.
- Mentions are off by default (`allowedMentions: { parse: [] }`). A ping must name exactly the role or user it targets.
- Repo text on its way to Discord goes through `redactSecrets` (`safeText`, `textAttachment` and `diffPayload` already do this). Files that `isSecretPath` flags are never posted.
- Use `MessageFlags.Ephemeral`, not `ephemeral: true`. Role colours use `colors`, not `color`.
- Pollers use `ctx.scheduler.every(name, seconds, fn)` and skip while `ctx.flags.paused`.
- On the first run a poller seeds its state without posting, so nothing backfills history.

### State namespaces (`<home>/state/<ns>.json`)

| ns | owner | shape |
|---|---|---|
| `layout` | provision | `{ channels: {key: id}, roles: {key: id}, tags: {forumKey: {tagKey: id}} }` |
| `flags` | index/admin | `{ paused }` |
| `heads` | feed | `{ [project]: { defaultBranch, branches: {name: sha}, pushedAt: {name: iso}, seededAt, lastCheckedAt } }` |
| `pushlog` | feed | `{ entries: [{ project, branch, commits (count; 0 for resets/renames/same-as branches), authors: [], additions, deletions, at, forced, created }] }` (last 8 days) |
| `activity` | activity | `{ [project]: { seededAt, pulls: {n: {...}}, issues: {n: {...}}, runs: {...}, lastIssueCheck } }` |
| `deploys` | deploys | `{ [project]: { lastSha, lastDeployedAt, lastFailedAt, seen: [sha], history: [{ sha, at }] } }` |
| `digest` | digest | `{ lastPostedDate }` |
| `onboarding` | onboarding | `{ guideMessageId, panelMessageId, joins: {userId: cardMessageId}, joinWatermark }` |
| `access` | access | `{ seq, requests: {id: { status: pending\|approved\|denied\|revoked, github, readTier, … }}, grants: {userId: {...}} }` |
| `feedback` | feedback | `{ threads: {threadId: { project, kind, title, status: 'open'\|'tracked'\|'shipped'\|'closed', issue: {repo, number, url} \| null, authorId, createdAt }}, issues: {'owner/repo#n': threadId} }` |
| `reviews` | review | `{ [messageId]: {...} }` |

### Bus events

| Event | Emitter | Payload |
|---|---|---|
| `issue:closed` | activity | `{ project, number, title, url, closedBy, reason }` (reason = GitHub state_reason: completed, not_planned or null) |
| `issue:reopened` | activity | `{ project, number, title, url }` |
| `push` | feed | `{ project, branch, base, head, commits, forced, created }` |
