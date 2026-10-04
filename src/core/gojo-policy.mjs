import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { isOwner } from './guild.mjs';
import { redactSecrets } from './redact.mjs';

export const snowflake = (value) => typeof value === 'string' && /^\d{17,20}$/.test(value);
const trustedFeedback = new WeakMap();

/** Only an in-process trusted producer can tag an app-shaped Gojo output echo. */
export function markGojoFeedback(message, origin = 'app-feedback') {
  if (!message || typeof message !== 'object' || !['gojo-reply', 'gojo-heartbeat', 'gojo-relay', 'app-feedback'].includes(origin)) throw new Error('Invalid trusted Gojo feedback origin');
  trustedFeedback.set(message, { producer: 'gojo', origin });
  return message;
}
export const gojoFeedbackOrigin = (message) => message && typeof message === 'object' ? trustedFeedback.get(message) ?? null : null;
export function isBotOrSelf(message, botId) {
  return !!message && (message.author?.id === botId || !!message.author?.bot || !!message.webhookId || !!message.system || !!gojoFeedbackOrigin(message));
}
export const ACTIONS = ['send_message', 'send_dm', 'create_channel', 'edit_channel', 'create_thread', 'read_history', 'user_info', 'react', 'edit_message', 'delete_message', 'report_issue'];
const actionProperties = Object.fromEntries(['kind', 'channelId', 'userId', 'messageId', 'name', 'topic', 'content', 'emoji', 'channelType'].map((key) => [key, { type: 'string' }]));
actionProperties.kind = { type: 'string', enum: ACTIONS };
actionProperties.limit = { type: 'integer', minimum: 1, maximum: 50 };
export const GOJO_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    reply: { type: 'string', maxLength: 1800 },
    actions: { type: 'array', maxItems: 6, items: { type: 'object', additionalProperties: false, properties: actionProperties, required: Object.keys(actionProperties) } },
    coveredProjectIds: { type: 'array', maxItems: 8, items: { type: 'string' } },
    skip: { type: 'boolean' },
  }, required: ['reply', 'actions', 'coveredProjectIds', 'skip'],
};

export function validateResponse(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Gojo JSON response');
  if (Object.keys(value).some((key) => !GOJO_SCHEMA.required.includes(key)) || GOJO_SCHEMA.required.some((key) => !(key in value))) throw new Error('Invalid Gojo response fields');
  if (typeof value.reply !== 'string' || value.reply.length > 1800 || typeof value.skip !== 'boolean' || !Array.isArray(value.actions) || value.actions.length > 6 || !Array.isArray(value.coveredProjectIds) || value.coveredProjectIds.length > 8 || value.coveredProjectIds.some((id) => typeof id !== 'string')) throw new Error('Invalid Gojo response values');
  for (const action of value.actions) {
    if (!action || typeof action !== 'object' || Object.keys(action).some((key) => !(key in actionProperties)) || Object.keys(actionProperties).some((key) => !(key in action))) throw new Error('Invalid Gojo action fields');
    if (!ACTIONS.includes(action.kind) || Object.keys(actionProperties).some((key) => key !== 'limit' && typeof action[key] !== 'string') || !Number.isInteger(action.limit) || action.limit < 1 || action.limit > 50) throw new Error('Invalid Gojo action values');
    for (const field of ['channelId', 'userId', 'messageId']) if (action[field] && !snowflake(action[field])) throw new Error('Invalid Discord ID');
    for (const field of ['content', 'topic', 'name', 'emoji']) if (action[field].length > (field === 'content' ? 1800 : field === 'topic' ? 1024 : 100)) throw new Error('Oversized Discord action');
  }
  return value;
}

export function addressed(message, botId) {
  if (!message?.author || isBotOrSelf(message, botId)) return false;
  if (!message.guildId) return true;
  if (message.mentions?.users?.has(botId)) return true;
  if (message.reference && (message.referencedAuthorId === botId || message.mentions?.repliedUser?.id === botId)) return true;
  // A name addressed at the beginning or after punctuation, not a casual reference in prose.
  return /(?:^|[\n.!?]\s*)\s*(?:hey\s+|yo\s+|oi\s+)?(?:gojo(?:\s+satoru)?|satoru)[,!?:\s]+/i.test(message.content ?? '');
}

export const contextKey = (message) => message.guildId ? `public:${message.channelId}` : `dm:${message.author.id}`;

/** Public exports from a private chat must use text explicitly quoted in the latest owner instruction. */
export function explicitExport(instruction, content) {
  if (!/\b(?:post|send|say|announce|publish|tell|dm|message)\b/i.test(instruction ?? '')) return false;
  const quotes = [...String(instruction).matchAll(/"([^"\n]+)"|“([^”\n]+)”|```(?:[^\n]*\n)?([\s\S]*?)```/g)].map((match) => (match[1] ?? match[2] ?? match[3]).trim());
  return quotes.some((quote) => quote === content.trim());
}

export function requestedAction(kind, instruction) {
  // Quoted/transcribed instructions do not authorize side effects. Negation is fail-closed.
  const text = String(instruction ?? '').replace(/```[\s\S]*?```|"[^"\n]*"|“[^”\n]*”/g, ' [quoted text] ')
    .replace(/^\s*(?:<@!?\d+>\s*)?(?:(?:hey|yo|oi)\s+)?(?:gojo(?:\s+satoru)?|satoru)[,:!\s]*/i, '').trim();
  const verbs = { send_message: 'send|post|say|announce|publish', send_dm: 'dm|message|send', create_channel: 'create|make|add|new|set.up', edit_channel: 'rename|change|edit|set|update', create_thread: 'create|make|start|new|open', read_history: 'read|history|summari[sz]e|fetch|check|look', user_info: 'who|user|member|profile|info|lookup', react: 'react|reaction', edit_message: 'edit|change|update|correct', delete_message: 'delete|remove' }[kind];
  if (!verbs) return false;
  if (new RegExp(`\\b(?:don['’]t|shouldn['’]t|wouldn['’]t|do\\s+not|never|avoid|stop|without|no)\\b[^.!?\\n]{0,80}\\b(?:${verbs})\\b`, 'i').test(text)) return false;
  if (kind === 'read_history') return /\b(?:read|history|catch.?up|summari[sz]e|what.*(?:said|say|happened)|look|fetch|check)\b/i.test(text);
  if (kind === 'user_info') return /\b(?:who|user|member|profile|info|lookup|look.up)\b/i.test(text);
  const imperative = new RegExp(`(?:^|[,;.!?\\n]\\s*|\\b(?:please|can you|could you|would you|will you|i want you to|i need you to|go ahead and|and)\\s+)(?:${verbs})\\b`, 'i');
  if (!imperative.test(text)) return false;
  if (kind === 'send_dm') return /\b(?:dm|direct.?message|privately|inbox)\b/i.test(text) || /(?:^|\bplease\s+|\byou\s+)message\s+(?!me\b|my\b|the\b|a\b)\S+/i.test(text);
  if (kind === 'create_channel') return /\bchannel\b/i.test(text);
  if (kind === 'create_thread') return /\bthread\b/i.test(text);
  if (kind === 'edit_channel') return /\b(?:channel|topic)\b/i.test(text);
  if (kind === 'edit_message') return /\b(?:message|post|reply)\b/i.test(text);
  return true;
}

function cleanPayload(content) {
  if (typeof content !== 'string' || !content.trim() || content.length > 1800) throw new Error('Empty or oversized Discord content');
  const safe = redactSecrets(content);
  if (safe !== content) throw new Error('Secret-shaped content withheld');
  return { content: safe, allowedMentions: { parse: [], repliedUser: false }, flags: 4 };
}

export function publicText(text) {
  return redactSecrets(String(text ?? ''))
    .replace(/(?:[A-Z]:[\\/]|\\\\)[^\s)\]`]+/gi, '[local path]')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[local record]')
    .replace(/\b\d{17,20}\b/g, '[Discord ID]');
}

/** Controller, never the model, resolves IDs and checks owner + server boundaries. */
export async function executeAction(action, { ctx, message, privateContext, instruction }) {
  if (!message || !isOwner(ctx, message.author.id)) throw new Error('Discord actions are owner-only');
  if (!requestedAction(action.kind, instruction)) throw new Error('Action was not requested in the latest owner message');
  if (message.guildId && message.guildId !== ctx.config.local.guildId) throw new Error('Foreign server');
  if (ctx.dryRun) return { kind: action.kind, status: 'dry-run' };
  const guild = ctx.guildCtx.guild;
  if (!guild || guild.id !== ctx.config.local.guildId) throw new Error('Home server is unavailable');
  const channel = async () => {
    if (!snowflake(action.channelId)) throw new Error('A current-server channel ID is required');
    const target = await guild.channels.fetch(action.channelId);
    if (!target || target.guildId !== guild.id) throw new Error('Channel is outside the home server');
    const member = await guild.members.fetch(message.author.id);
    if (!target.permissionsFor(member)?.has(PermissionFlagsBits.ViewChannel)) throw new Error('Channel is not visible to the owner');
    return target;
  };
  if (privateContext && ['send_message', 'send_dm', 'create_thread', 'edit_message'].includes(action.kind) && action.content && (action.kind !== 'send_dm' || action.userId !== message.author.id) && !explicitExport(instruction, action.content)) throw new Error('Private conversation export needs exact quoted text in the latest owner instruction');
  if (privateContext && ['create_channel', 'edit_channel', 'create_thread'].includes(action.kind)) {
    if (action.name && !String(instruction).toLowerCase().includes(action.name.toLowerCase())) throw new Error('Channel/thread name must be supplied in the latest owner request');
    if (action.topic && !String(instruction).includes(action.topic)) throw new Error('Channel topic must be supplied in the latest owner request');
  }

  if (action.kind === 'user_info' || action.kind === 'send_dm') {
    if (!snowflake(action.userId)) throw new Error('A current-server user ID is required');
    const member = await guild.members.fetch(action.userId);
    if (!member || member.user.bot) throw new Error('Target must be a human home-server member');
    if (action.kind === 'user_info') return { kind: action.kind, user: { id: member.id, name: member.displayName, username: member.user.username, joinedAt: member.joinedAt?.toISOString(), roles: [...member.roles.cache.values()].map((role) => ({ id: role.id, name: role.name })) } };
    const sent = await member.send(cleanPayload(action.content));
    return { kind: action.kind, messageId: sent.id, userId: member.id };
  }
  if (action.kind === 'create_channel') {
    const type = { text: ChannelType.GuildText, voice: ChannelType.GuildVoice, category: ChannelType.GuildCategory }[action.channelType];
    if (type === undefined || !/^[a-z0-9][a-z0-9-]{0,99}$/.test(action.name)) throw new Error('Use a simple channel name and text/voice/category type');
    cleanPayload(action.name);
    if (action.topic) cleanPayload(action.topic);
    const created = await guild.channels.create({ name: action.name, type, ...(type === ChannelType.GuildText && action.topic ? { topic: action.topic } : {}), reason: 'Dex asked Gojo in Discord' });
    return { kind: action.kind, channelId: created.id };
  }
  const target = await channel();
  if (action.kind === 'edit_channel') {
    if (action.name && !/^[a-z0-9][a-z0-9-]{0,99}$/.test(action.name)) throw new Error('Invalid channel name');
    if (action.topic) cleanPayload(action.topic);
    if (!action.name && !action.topic) throw new Error('Channel edit is empty');
    await target.edit({ ...(action.name ? { name: action.name } : {}), ...(action.topic ? { topic: action.topic } : {}), reason: 'Dex asked Gojo in Discord' });
    return { kind: action.kind, channelId: target.id };
  }
  if (!target.isTextBased() || !target.messages) throw new Error('This action needs a text channel');
  if (action.kind === 'send_message') { const sent = await target.send(cleanPayload(action.content)); return { kind: action.kind, channelId: target.id, messageId: sent.id }; }
  if (action.kind === 'create_thread') {
    if (!action.name || !target.threads) throw new Error('Invalid thread title');
    cleanPayload(action.name);
    const thread = await target.threads.create({ name: action.name, autoArchiveDuration: 1440, reason: 'Dex asked Gojo in Discord' });
    if (action.content) await thread.send(cleanPayload(action.content));
    return { kind: action.kind, channelId: thread.id };
  }
  if (action.kind === 'read_history') {
    // DM histories and cross-channel/private histories are never admitted to a public session.
    if (!privateContext && target.id !== message.channelId) throw new Error('Other-channel history is available in an owner DM only');
    const history = await target.messages.fetch({ limit: action.limit });
    return { kind: action.kind, channelId: target.id, messages: [...history.values()].reverse().map((item) => ({ id: item.id, authorId: item.author.id, name: item.author.username, content: redactSecrets(item.content).slice(0, 1800), at: item.createdAt.toISOString() })) };
  }
  if (!snowflake(action.messageId)) throw new Error('A message ID is required');
  const selected = await target.messages.fetch(action.messageId);
  if (action.kind === 'react') { if (!action.emoji || redactSecrets(action.emoji) !== action.emoji) throw new Error('Invalid emoji'); await selected.react(action.emoji); }
  else {
    if (selected.author.id !== ctx.client.user.id) throw new Error('Gojo can edit or delete only its own messages');
    if (action.kind === 'edit_message') await selected.edit(cleanPayload(action.content));
    else if (action.kind === 'delete_message') {
      if (!/\b(?:delete|remove)\b/i.test(instruction) || !instruction.includes(action.messageId)) throw new Error('Deleting a message requires its exact ID in the owner instruction');
      await selected.delete();
    }
  }
  return { kind: action.kind, messageId: selected.id };
}
