import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { cid } from '../core/router.mjs';
import { requireOwner } from '../core/guild.mjs';
import { UserError } from '../core/projects.mjs';
import { joinWithin, md, plural, safeText, truncate, ts } from '../core/format.mjs';
import { redactSecrets } from '../core/redact.mjs';
import { fetchMessage, forgetJoin, markJoinCard, roleName, setRoles } from './onboarding.mjs';

// GitHub repo access with one-click owner approval. State `access`:
// { seq, requests: {id: { id, userId, github, note, status, at, messageId, ... }}, grants: {userId: { github, permission, repos, at, by }} }.

export const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const NOTE_MAX = 300;
const DENY_COOLDOWN_MS = 12 * 3600_000;
const NEW_ACCOUNT_MS = 30 * 86_400_000;
const NOTIFICATIONS_URL = 'https://github.com/notifications';
const DEFAULTS = { seq: 0, requests: {}, grants: {} };
const COLOR = { pending: 0xf5c542, approved: 0x22c55e, denied: 0x8a8f98, revoked: 0x8a8f98 };
const PERMISSION_LABEL = { pull: 'read', triage: 'triage', push: 'write', maintain: 'maintain', admin: 'admin' };
const READ_TIER_NOTE = 'github only has read-only collaborators on org-owned repos, so read skips personal-account ones';

// Request ids with an approve/deny in progress, so a double click cannot run the grant twice.
const inFlight = new Set();

function st(ctx) {
  return ctx.state.get('access', DEFAULTS);
}

// ------------------------------------------------------------------ pure helpers

/** GitHub login from what someone typed (`@login`, a profile URL or the bare login), or null. */
export function parseLogin(raw) {
  const login = String(raw ?? '')
    .trim()
    .replace(/^https?:\/\/(www\.)?github\.com\//i, '')
    .replace(/^@/, '')
    .replace(/\/+$/, '');
  return LOGIN_RE.test(login) ? login : null;
}

export function permissionLabel(permission) {
  return PERMISSION_LABEL[permission] ?? permission;
}

function repoShort(repo) {
  return String(repo).split('/').pop();
}

export function nextRequestId(state) {
  let id;
  do {
    state.seq = (state.seq ?? 0) + 1;
    id = state.seq.toString(36);
  } while (state.requests[id]);
  return id;
}

export function pendingRequestOf(state, userId) {
  return Object.values(state.requests).find((r) => r.userId === userId && r.status === 'pending') ?? null;
}

export function latestRequestOf(state, userId) {
  const mine = Object.values(state.requests).filter((r) => r.userId === userId);
  return mine.sort((a, b) => String(b.at).localeCompare(String(a.at)))[0] ?? null;
}

/** Milliseconds until someone whose last request was denied may ask again (0 = now). */
export function denyCooldownLeft(state, userId, now = Date.now()) {
  const last = latestRequestOf(state, userId);
  if (last?.status !== 'denied' || !last.decidedAt) return 0;
  return Math.max(0, Date.parse(last.decidedAt) + DENY_COOLDOWN_MS - now);
}

/**
 * What an approval does per project. write ('w') = push on every repo. read ('r') = `readPermission`
 * on private repos, but only where GitHub honours it: on a repo owned by a personal account every
 * collaborator gets write whatever permission is sent, so read skips those instead of quietly
 * granting push. `repoInfo`: { [repo]: { private, ownerType } }; a missing entry (lookup failed)
 * is skipped for the same reason. Returns [{ project, permission, skip? }].
 */
export function grantTargets(projects, level, repoInfo, readPermission = 'pull') {
  return projects.map((p) => {
    if (level === 'w') return { project: p, permission: 'push' };
    const info = repoInfo[p.repo];
    if (!info) return { project: p, permission: null, skip: 'unknown' };
    if (info.private === false) return { project: p, permission: null, skip: 'public' };
    if (info.ownerType !== 'Organization' && readPermission !== 'push') return { project: p, permission: null, skip: 'personal' };
    return { project: p, permission: readPermission };
  });
}

/** Short, token-free description of a GitHub failure for cards and replies. */
export function describeGitHubError(err) {
  const status = err?.status;
  const message = err?.body?.message ?? err?.message ?? String(err);
  let text = status ? `${status} ${message}` : message;
  if (status === 403 || status === 404) text += " (gojo's github token needs admin on this repo)";
  return truncate(redactSecrets(text), 180);
}

const OUTCOME = {
  invited: (r) => `📨 **${md(r.name)}**: invitation sent (${permissionLabel(r.permission)})`,
  already: (r) => `✅ **${md(r.name)}**: already a collaborator, now ${permissionLabel(r.permission)}`,
  public: (r) => `🌐 **${md(r.name)}**: public, nothing to grant`,
  personal: (r) => `⏭️ **${md(r.name)}**: skipped. personal-account repo, and github makes every collaborator there a writer`,
  removed: (r) => `🔒 **${md(r.name)}**: access removed`,
  'not-collaborator': (r) => `➖ **${md(r.name)}**: wasn't a collaborator`,
  error: (r) => `❌ **${md(r.name)}**: ${md(r.message ?? 'failed')}`,
};

export function resultLine(r) {
  const line = (OUTCOME[r.outcome] ?? OUTCOME.error)(r);
  return r.invitesCancelled ? `${line}, ${plural(r.invitesCancelled, 'pending invitation')} cancelled` : line;
}

function resultLines(results, max = 1024) {
  return truncate(results.map(resultLine).join('\n'), max) || 'nothing to do';
}

export function grantSummary(grant) {
  const repos = grant.repos?.length ? grant.repos.map(repoShort).join(', ') : 'nothing private';
  return `\`${grant.github}\` · ${permissionLabel(grant.permission)} on ${repos} · since ${ts(grant.at, 'D')}`;
}

/**
 * The grant after an approval. Repos from an earlier grant for the same login are kept (a read
 * approval does not touch public repos); a different login replaces it and is remembered.
 */
export function mergeGrant(prev, { github, permission, repos, at, by, requestId }) {
  const same = prev && prev.github.toLowerCase() === github.toLowerCase();
  const grant = { github, permission, repos: [...new Set([...(same ? prev.repos : []), ...repos])], at, by, requestId };
  if (prev && !same) grant.replaced = prev.github;
  return grant;
}

export function buildRequestCard(req, { grant = null, now = Date.now() } = {}) {
  const url = `https://github.com/${req.github}`;
  const profile = req.profile ?? {};
  const embed = new EmbedBuilder()
    .setColor(COLOR[req.status] ?? COLOR.pending)
    .setTitle(`🎟️ github access request #${req.id}`)
    .setURL(url)
    .setDescription(`<@${req.userId}> wants in as **[${md(req.github)}](${url})**${profile.name ? ` (${safeText(profile.name, 80)})` : ''}`)
    .setFooter({ text: `request ${req.id} · ${req.status}` });
  const account = [];
  if (profile.createdAt) account.push(`created ${ts(profile.createdAt, 'D')}`);
  account.push(plural(profile.publicRepos ?? 0, 'public repo'));
  if (profile.createdAt && now - Date.parse(profile.createdAt) < NEW_ACCOUNT_MS) account.push('⚠️ new account');
  embed.addFields({ name: 'github account', value: account.join(' · ') });
  if (req.note) embed.addFields({ name: 'note', value: safeText(req.note, 1000) });
  if (grant && req.status === 'pending') embed.addFields({ name: 'already has', value: truncate(grantSummary(grant), 1024) });
  // readTier false = every private repo is owned by a personal account, where GitHub makes each
  // collaborator a writer; offering "read" there would only ever fail.
  const readTier = req.readTier !== false;
  if (req.status === 'pending') {
    embed.addFields({
      name: 'options',
      value: readTier
        ? `read: read-only on the private repos. ${READ_TIER_NOTE} · write: push to every repo`
        : 'approve makes them a collaborator on every repo. these repos belong to a personal github account, and github gives every collaborator there push access (read-only needs an org). /source, /diff and /worktree stay read-only either way.',
    });
    if (req.lastAttempt) embed.addFields({ name: `last attempt ${ts(req.lastAttempt.at)}`, value: resultLines(req.lastAttempt.results) });
  } else {
    const icon = { approved: '✅', denied: '🙅', revoked: '🔒' }[req.status] ?? '•';
    const level = req.permission ? ` (${permissionLabel(req.permission)})` : '';
    embed.addFields({ name: 'decision', value: `${icon} ${req.status}${level} by <@${req.decidedBy}> ${ts(req.decidedAt)}` });
    if (req.results?.length) embed.addFields({ name: 'repos', value: resultLines(req.results) });
    if (req.followUp) embed.addFields({ name: 'follow-up', value: truncate(req.followUp, 1024) });
  }
  const components =
    req.status === 'pending'
      ? [
          new ActionRowBuilder().addComponents(
            ...(readTier
              ? [
                  new ButtonBuilder().setCustomId(cid('access', 'approve', req.id, 'r')).setLabel('✅ approve read').setStyle(ButtonStyle.Success),
                  new ButtonBuilder().setCustomId(cid('access', 'approve', req.id, 'w')).setLabel('✍️ approve write').setStyle(ButtonStyle.Primary),
                ]
              : [new ButtonBuilder().setCustomId(cid('access', 'approve', req.id, 'w')).setLabel('✅ approve (collaborator, can push)').setStyle(ButtonStyle.Success)]),
            new ButtonBuilder().setCustomId(cid('access', 'deny', req.id)).setLabel('🙅 deny').setStyle(ButtonStyle.Secondary),
          ),
        ]
      : [];
  return { embeds: [embed], components };
}

export function approvalDm({ github, results, badge = false, staffName = 'member of technical staff' }) {
  const lines = [`✅ approved: github access for \`${github}\`.`, ...results.map(resultLine)];
  if (results.some((r) => r.outcome === 'invited')) {
    lines.push(`github sends one invitation per new repo. accept them at ${NOTIFICATIONS_URL} (they expire after 7 days).`);
  }
  lines.push('then `/clone` in the server shows how to clone a project and check a branch out as a worktree.');
  if (badge) lines.push(`you also got the **${md(staffName)}** badge, so the ship feeds, source and review are open.`);
  return truncate(lines.join('\n'), 2000);
}

/** Owner-facing note for an approval that granted nothing, so the request stays pending. */
export function blockedNotice(blocked) {
  const lines = ['nothing was granted, the request stays pending:', resultLines(blocked, 1500)];
  if (blocked.some((r) => r.outcome === 'personal')) lines.push(`${READ_TIER_NOTE}. approve write, or move the repos into a github org.`);
  return truncate(lines.join('\n'), 2000);
}

export function denialDm(github) {
  return `your github access request for \`${github}\` was declined for now. the board is one guy and he said not yet. you can still hang around and post feedback in #rlhf; ask dex directly if you think that's wrong.`;
}

export function buildAccessList(state, { now = Date.now() } = {}) {
  const pending = Object.values(state.requests)
    .filter((r) => r.status === 'pending')
    .sort((a, b) => String(a.at).localeCompare(String(b.at)))
    .map((r) => `#${r.id} <@${r.userId}> \`${r.github}\` ${ts(r.at)}`);
  const granted = Object.entries(state.grants).map(([userId, g]) => `<@${userId}> ${grantSummary(g)}`);
  const field = (lines) => {
    const { text, dropped } = joinWithin(lines, 980);
    return (text || 'nobody') + (dropped ? `\n…and ${dropped} more` : '');
  };
  return new EmbedBuilder()
    .setColor(COLOR.pending)
    .setTitle('🎟️ github access')
    .addFields(
      { name: `waiting (${pending.length})`, value: field(pending) },
      { name: `has access (${granted.length})`, value: field(granted) },
    )
    .setTimestamp(now);
}

/** `live`: { [repo]: 'read' | 'write' | 'none' | … | null (check failed) } from the collaborator API. */
export function buildAccessStatus({ request, grant, live = {} }) {
  const lines = [];
  if (request) {
    const when = request.status === 'pending' ? `since ${ts(request.at)}` : ts(request.decidedAt ?? request.at);
    const level = request.permission ? ` (${permissionLabel(request.permission)})` : '';
    lines.push(`request #${request.id} for \`${request.github}\`: **${request.status}**${level} ${when}`);
  }
  if (grant) {
    lines.push(`access as \`${grant.github}\` (${permissionLabel(grant.permission)}):`);
    if (!grant.repos.length) lines.push('• nothing private to grant; the public repos are open anyway');
    for (const repo of grant.repos) {
      const role = live[repo];
      if (role === undefined || role === null) lines.push(`• ${repoShort(repo)}: couldn't check right now`);
      else if (role === 'none') lines.push(`• ${repoShort(repo)}: invitation not accepted yet → ${NOTIFICATIONS_URL}`);
      else lines.push(`• ${repoShort(repo)}: active (${role})`);
    }
  }
  if (!lines.length) return 'no request on file. `/access request github:<you>` or the 🎟️ button in #front-desk.';
  return truncate(lines.join('\n'), 1900);
}

export function buildRequestModal(prefill = '') {
  const github = new TextInputBuilder().setCustomId('github').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(1).setMaxLength(39).setPlaceholder('octocat');
  if (prefill && LOGIN_RE.test(prefill)) github.setValue(prefill);
  const note = new TextInputBuilder()
    .setCustomId('note')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(NOTE_MAX)
    .setPlaceholder('who you are, what you want to look at');
  return new ModalBuilder()
    .setCustomId(cid('access', 'modal'))
    .setTitle('request github access')
    .addLabelComponents(
      new LabelBuilder().setLabel('github username').setDescription('the account that gets the repo invitations').setTextInputComponent(github),
      new LabelBuilder().setLabel('note (optional)').setTextInputComponent(note),
    );
}

// ------------------------------------------------------------------ discord helpers

async function dm(ctx, userId, content) {
  try {
    const user = await ctx.client.users.fetch(userId);
    await user.send({ content, allowedMentions: { parse: [] } });
    return true;
  } catch {
    return false;
  }
}

async function editCard(ctx, req) {
  const msg = await fetchMessage(ctx, 'board-meeting', req.messageId);
  if (msg) await msg.edit(buildRequestCard(req, { grant: st(ctx).grants[req.userId] }));
  return !!msg;
}

/** GitHub's collaborator check: 204 = collaborator, 404 = not (pending invitees are not). */
async function isCollaborator(ctx, repo, login) {
  const res = await ctx.github.request('GET', `/repos/${repo}/collaborators/${encodeURIComponent(login)}`, { allow: [404] });
  return res.status !== 404;
}

function ownerPing(ctx) {
  const ownerId = ctx.guildCtx.ownerId;
  return ownerId ? { content: `<@${ownerId}>`, allowedMentions: { users: [ownerId] } } : {};
}

// ------------------------------------------------------------------ request

/**
 * Whether a read-only grant is possible anywhere: true when some private project repo is
 * org-owned (GitHub honours `pull` only there). Unknown (lookup failed) counts as available so
 * the owner still sees both buttons and gets the per-repo explanation on click.
 */
async function readTierAvailable(ctx) {
  try {
    const repos = await Promise.all(ctx.config.projects.map((p) => ctx.github.repo(p.repo)));
    return repos.some((r) => r.private && r.owner?.type === 'Organization');
  } catch {
    return true;
  }
}

async function submitRequest(interaction, ctx, rawLogin, rawNote) {
  const login = parseLogin(rawLogin);
  if (!login) throw new UserError("that's not a valid github username (letters, digits and single hyphens, up to 39).");
  const state = st(ctx);
  const userId = interaction.user.id;
  const wait = denyCooldownLeft(state, userId);
  if (wait) throw new UserError(`the board said no to your last request. you can ask again ${ts(Date.now() + wait)}.`);

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const user = await ctx.github.user(login);
  if (!user) throw new UserError(`github has no user called \`${login}\`. typo?`);
  if (user.type !== 'User') {
    const type = String(user.type).toLowerCase();
    throw new UserError(`\`${user.login}\` is ${/^[aeiou]/.test(type) ? 'an' : 'a'} ${type}, not a person. use your own account.`);
  }

  let req = pendingRequestOf(state, userId);
  if (req && inFlight.has(req.id)) throw new UserError('the board is deciding on your request right now. check `/access status` in a minute.');
  const updating = !!req;
  if (!req) {
    req = { id: nextRequestId(state), userId, status: 'pending' };
    state.requests[req.id] = req;
  }
  const note = truncate(String(rawNote ?? '').trim(), NOTE_MAX);
  Object.assign(req, {
    userTag: interaction.user.tag,
    github: user.login,
    profile: { createdAt: user.created_at ?? null, publicRepos: user.public_repos ?? 0, name: user.name ?? null },
    note: note || req.note || '',
    at: new Date().toISOString(),
  });
  delete req.lastAttempt;
  req.readTier = await readTierAvailable(ctx);
  ctx.state.save('access', { immediate: true });

  const onCard = updating && (await editCard(ctx, req));
  if (!onCard) {
    const msg = await ctx.guildCtx.send('board-meeting', { ...buildRequestCard(req, { grant: state.grants[userId] }), ...ownerPing(ctx) });
    if (msg) {
      req.messageId = msg.id;
      ctx.state.save('access', { immediate: true });
    }
  }
  const grant = state.grants[userId];
  const had = grant ? ` (you already have ${permissionLabel(grant.permission)} as \`${grant.github}\`; this asks again.)` : '';
  await interaction.editReply(
    updating
      ? `updated your pending request #${req.id}: github \`${user.login}\`. still waiting on the board.${had}`
      : `sent to the board: request #${req.id} for github \`${user.login}\`. you'll get a dm when the ceo decides.${had}`,
  );
}

// ------------------------------------------------------------------ approve / deny

/**
 * Claim a request for deciding. Synchronous from check to mark, so two clicks handled in the same
 * tick cannot both pass. Returns null when claimed, else the reason to show the clicker.
 */
function claim(id, req) {
  if (!req) throw new UserError(`request #${id} is gone.`);
  if (inFlight.has(id)) return `request #${id} is already being handled.`;
  if (req.status !== 'pending') return `request #${id} is already ${req.status}.`;
  inFlight.add(id);
  return null;
}

async function approve(interaction, ctx, [id, level]) {
  if (!(await requireOwner(interaction, ctx))) return;
  if (level !== 'r' && level !== 'w') throw new UserError('unknown access level. use the buttons on a fresh card.');
  const req = st(ctx).requests[id];
  const busy = claim(id, req);
  if (busy) return interaction.reply({ content: busy, flags: MessageFlags.Ephemeral });
  try {
    await interaction.deferUpdate();
    await grantRequest(interaction, ctx, req, level);
  } finally {
    inFlight.delete(id);
  }
}

async function grantRequest(interaction, ctx, req, level) {
  const state = st(ctx);
  const readPermission = ctx.config.local.githubCollaboratorPermission || 'pull';
  const repoInfo = {};
  const lookupErrors = {};
  if (level === 'r') {
    for (const p of ctx.config.projects) {
      try {
        const r = await ctx.github.repo(p.repo);
        repoInfo[p.repo] = { private: !!r.private, ownerType: r.owner?.type ?? null };
      } catch (err) {
        lookupErrors[p.repo] = describeGitHubError(err);
      }
    }
  }
  const results = [];
  for (const { project, permission, skip } of grantTargets(ctx.config.projects, level, repoInfo, readPermission)) {
    const base = { repo: project.repo, name: project.name, permission };
    if (skip === 'unknown') {
      results.push({ ...base, outcome: 'error', message: `couldn't look the repo up, skipped: ${lookupErrors[project.repo]}` });
      continue;
    }
    if (skip) {
      results.push({ ...base, outcome: skip });
      continue;
    }
    try {
      const res = await ctx.github.addCollaborator(project.repo, req.github, permission);
      results.push({ ...base, outcome: res.status === 201 ? 'invited' : 'already' });
    } catch (err) {
      results.push({ ...base, outcome: 'error', message: describeGitHubError(err) });
    }
  }
  const granted = results.filter((r) => r.outcome === 'invited' || r.outcome === 'already');
  const blocked = results.filter((r) => r.outcome === 'error' || r.outcome === 'personal');
  const now = new Date().toISOString();

  if (blocked.length && !granted.length) {
    // Nothing went through: keep the request pending so approve can be pressed again.
    req.lastAttempt = { at: now, results };
    ctx.state.save('access', { immediate: true });
    await interaction.editReply(buildRequestCard(req, { grant: state.grants[req.userId] }));
    await interaction.followUp({ content: blockedNotice(blocked), flags: MessageFlags.Ephemeral });
    return;
  }

  const permission = level === 'w' ? 'push' : readPermission;
  const grant = mergeGrant(state.grants[req.userId], { github: req.github, permission, repos: granted.map((r) => r.repo), at: now, by: interaction.user.id, requestId: req.id });
  state.grants[req.userId] = grant;
  Object.assign(req, { status: 'approved', permission, results, decidedAt: now, decidedBy: interaction.user.id });
  delete req.lastAttempt;
  ctx.state.save('access', { immediate: true });

  const notes = [];
  let badge = false;
  const member = await interaction.guild.members.fetch(req.userId).catch(() => null);
  if (!member) notes.push('not in the server anymore, no badge');
  else {
    try {
      badge = (await setRoles(ctx, member, { add: ['staff'], remove: ['waitlist'] }, `github access #${req.id} approved by ${interaction.user.username}`)).added > 0;
      notes.push(badge ? 'badge given' : 'already had the badge');
      if (badge) await markJoinCard(ctx, req.userId, `🪪 badge via github access #${req.id}, approved by ${interaction.user} ${ts(now)}`).catch(() => {});
      forgetJoin(ctx, req.userId);
    } catch (err) {
      notes.push(`badge failed: ${err.message}`);
    }
  }
  const sent = await dm(ctx, req.userId, approvalDm({ github: req.github, results, badge, staffName: roleName(ctx, 'staff') }));
  notes.push(sent ? 'dm sent' : 'dm failed (closed dms)');
  if (grant.replaced) notes.push(`\`${grant.replaced}\` (their old login) keeps its access until \`/access revoke github:${grant.replaced}\``);
  req.followUp = notes.join(' · ');
  ctx.state.save('access');
  await interaction.editReply(buildRequestCard(req));
}

async function deny(interaction, ctx, [id]) {
  if (!(await requireOwner(interaction, ctx))) return;
  const req = st(ctx).requests[id];
  const busy = claim(id, req);
  if (busy) return interaction.reply({ content: busy, flags: MessageFlags.Ephemeral });
  try {
    await interaction.deferUpdate();
    Object.assign(req, { status: 'denied', decidedAt: new Date().toISOString(), decidedBy: interaction.user.id });
    delete req.lastAttempt;
    ctx.state.save('access', { immediate: true });
    const sent = await dm(ctx, req.userId, denialDm(req.github));
    req.followUp = sent ? 'dm sent' : 'dm failed (closed dms)';
    ctx.state.save('access');
    await interaction.editReply(buildRequestCard(req));
  } finally {
    inFlight.delete(id);
  }
}

// ------------------------------------------------------------------ status / list / revoke

async function statusCommand(interaction, ctx) {
  const state = st(ctx);
  const request = latestRequestOf(state, interaction.user.id);
  const grant = state.grants[interaction.user.id] ?? null;
  if (!grant) {
    await interaction.reply({ content: buildAccessStatus({ request, grant }), flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const live = {};
  for (const repo of grant.repos) {
    // A non-collaborator on a private repo comes back as { permission: 'none', role_name: '' }.
    live[repo] = await ctx.github.collaboratorPermission(repo, grant.github).then(
      (p) => (p ? p.role_name || p.permission || 'none' : 'none'),
      () => null,
    );
  }
  await interaction.editReply(buildAccessStatus({ request, grant, live }));
}

async function listCommand(interaction, ctx) {
  if (!(await requireOwner(interaction, ctx))) return;
  await interaction.reply({ embeds: [buildAccessList(st(ctx))], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
}

async function revokeCommand(interaction, ctx) {
  if (!(await requireOwner(interaction, ctx))) return;
  const user = interaction.options.getUser('member', true);
  const keepBadge = interaction.options.getBoolean('keep_badge') ?? true;
  const typed = interaction.options.getString('github');
  const state = st(ctx);
  const grant = state.grants[user.id] ?? null;
  const login = typed ? parseLogin(typed) : grant?.github ?? pendingRequestOf(state, user.id)?.github ?? null;
  if (typed && !login) throw new UserError("that's not a valid github username.");
  if (!login) throw new UserError(`no github login on file for ${user}. pass \`github:\` to revoke a specific account.`);

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const results = [];
  for (const project of ctx.config.projects) {
    const r = { repo: project.repo, name: project.name, invitesCancelled: 0 };
    try {
      const invites = await ctx.github.invitations(project.repo);
      for (const inv of invites.filter((i) => i.invitee?.login?.toLowerCase() === login.toLowerCase())) {
        await ctx.github.deleteInvitation(project.repo, inv.id);
        r.invitesCancelled += 1;
      }
      // DELETE answers 204 whether or not they were a collaborator, so ask first.
      const wasCollaborator = await isCollaborator(ctx, project.repo, login);
      if (wasCollaborator) await ctx.github.removeCollaborator(project.repo, login);
      r.outcome = wasCollaborator ? 'removed' : 'not-collaborator';
    } catch (err) {
      r.outcome = 'error';
      r.message = describeGitHubError(err);
    }
    results.push(r);
  }

  const failed = results.filter((r) => r.outcome === 'error').map((r) => r.repo);
  const now = new Date().toISOString();
  if (grant && grant.github.toLowerCase() === login.toLowerCase()) {
    if (failed.length) grant.repos = grant.repos.filter((repo) => failed.includes(repo));
    else delete state.grants[user.id];
  }
  for (const req of Object.values(state.requests)) {
    if (req.userId !== user.id || req.status !== 'approved' || req.github.toLowerCase() !== login.toLowerCase()) continue;
    Object.assign(req, { status: 'revoked', decidedAt: now, decidedBy: interaction.user.id, followUp: `revoked by ${interaction.user}` });
    await editCard(ctx, req).catch(() => {});
  }
  ctx.state.save('access', { immediate: true });

  let badge = 'badge kept';
  if (!keepBadge) {
    const member = await interaction.guild.members.fetch(user.id).catch(() => null);
    if (!member) badge = 'not in the server, no badge to take';
    else {
      badge = await setRoles(ctx, member, { add: ['waitlist'], remove: ['staff'] }, `access revoked by ${interaction.user.username}`).then(
        () => 'badge removed, back on the waitlist',
        (err) => `badge change failed: ${err.message}`,
      );
    }
  }
  await ctx.guildCtx.send('board-meeting', { content: `🔒 github access for ${user} (\`${login}\`) revoked by ${interaction.user}. ${badge}.` });
  await interaction.editReply(
    truncate(`revoked \`${login}\` for ${user}:\n${resultLines(results, 1500)}\n${badge}.${failed.length ? ' press it again once the errors are sorted.' : ''}`, 1990),
  );
}

// ------------------------------------------------------------------ module

export default {
  name: 'access',

  commands: () => [
    new SlashCommandBuilder()
      .setName('access')
      .setDescription('github access to the private repos')
      .addSubcommand((s) =>
        s
          .setName('request')
          .setDescription('ask the board for github access')
          .addStringOption((o) => o.setName('github').setDescription('your github username').setRequired(true).setMaxLength(100))
          .addStringOption((o) => o.setName('note').setDescription('who you are, what you want to look at').setMaxLength(NOTE_MAX)),
      )
      .addSubcommand((s) => s.setName('status').setDescription('where your access request stands'))
      .addSubcommand((s) => s.setName('list').setDescription('who has access and who is waiting (owner)'))
      .addSubcommand((s) =>
        s
          .setName('revoke')
          .setDescription("remove someone's github access (owner)")
          .addUserOption((o) => o.setName('member').setDescription('whose access to remove').setRequired(true))
          .addBooleanOption((o) => o.setName('keep_badge').setDescription('keep their member of technical staff badge (default: yes)'))
          .addStringOption((o) => o.setName('github').setDescription('a specific github login (default: the one on file)').setMaxLength(100)),
      ),
  ],

  async onCommand(interaction, ctx) {
    const sub = interaction.options.getSubcommand();
    if (sub === 'request') return submitRequest(interaction, ctx, interaction.options.getString('github', true), interaction.options.getString('note'));
    if (sub === 'status') return statusCommand(interaction, ctx);
    if (sub === 'list') return listCommand(interaction, ctx);
    if (sub === 'revoke') return revokeCommand(interaction, ctx);
  },

  components: {
    /** The 🎟️ button in #front-desk. */
    async open(interaction, ctx) {
      const state = st(ctx);
      const prefill = pendingRequestOf(state, interaction.user.id)?.github ?? state.grants[interaction.user.id]?.github ?? '';
      await interaction.showModal(buildRequestModal(prefill));
    },
    async modal(interaction, ctx) {
      await submitRequest(interaction, ctx, interaction.fields.getTextInputValue('github'), interaction.fields.getTextInputValue('note'));
    },
    approve,
    deny,
  },
};
