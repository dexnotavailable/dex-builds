import { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { planPost } from '../core/blogmd.mjs';
import { renderTable } from '../core/tableimg.mjs';
import { LIMITS, fileName, truncate } from '../core/format.mjs';
import { UserError } from '../core/projects.mjs';
import { redactSecrets } from '../core/redact.mjs';

// Blog posts from the website repo, posted in full to a channel (config/projects.json "blog"): the
// text in paragraphs with Discord headings, tables drawn as images, pictures sent as attachments in
// their own messages (Discord puts attachments under a message's text, so this keeps them where the
// author wrote them). See src/core/blogmd.mjs for how a post becomes messages.
//
// A post goes out once it has sat unchanged on the branch for `settleMinutes` (authors often push
// a quick "update" right after the first version), and never if it is marked `placeholder: true`.
// Posts already sent are not touched again when the file changes; `/admin blog` re-posts one.
//
// State `blog`: { posts: { [slug]: { blob, title, total, sent: [messageId], done, failures, postedAt } },
//                 skipped: { [slug]: blob }, noted: { [slug]: blob } }
// `sent` grows as messages go out, so a crash or a failed send resumes where it stopped instead of
// posting the start of the post twice.

const MAX_FAILURES = 3;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;
const VIDEO_EXT = /\.(mp4|webm|mov)$/i;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

let sending = false;

// ------------------------------------------------------------------ media

/** Where a post's image lives in the website repo (`public/...`), or null for anything off-site. */
export function repoPathForMedia(src, slug, siteBase) {
  try {
    const url = new URL(src, `${siteBase.replace(/\/$/, '')}/blog/${slug}/`);
    if (url.origin !== new URL(siteBase).origin) return null;
    return `public${decodeURIComponent(url.pathname)}`;
  } catch {
    return null;
  }
}

async function svgToPng(buffer) {
  const image = await loadImage(buffer);
  const k = Math.min(2, 2400 / Math.max(image.width, image.height, 1));
  const canvas = createCanvas(Math.max(1, Math.round(image.width * k)), Math.max(1, Math.round(image.height * k)));
  canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toBuffer('image/png');
}

/** A picture or video part -> payload. Anything that cannot be attached becomes a link line. */
async function mediaPayload(ctx, project, cfg, slug, part) {
  const site = project.site ?? 'https://dex.place';
  const repoPath = repoPathForMedia(part.src, slug, site);
  const label = part.alt ? truncate(part.alt.replace(/\s+/g, ' '), 120) : part.src.split('/').pop();
  const link = () => {
    let href = part.src;
    try {
      href = new URL(part.src, `${site.replace(/\/$/, '')}/blog/${slug}/`).href;
    } catch {
      /* keep the raw src */
    }
    return { content: `🖼️ [${label}](${href})` };
  };
  const base = repoPath?.split('/').pop() ?? '';
  const isSvg = /\.svg$/i.test(base);
  if (!repoPath || !(IMAGE_EXT.test(base) || VIDEO_EXT.test(base) || isSvg)) return link();
  let buffer;
  try {
    buffer = await ctx.github.raw(project.repo, repoPath, cfg.ref);
    if (isSvg) buffer = await svgToPng(buffer);
  } catch (err) {
    ctx.log.child('blog').warn(`${slug}: could not load ${part.src}: ${err.message}`);
    return link();
  }
  if (buffer.length > LIMITS.attachmentBytes) return link();
  const name = fileName(base.replace(/\.svg$/i, ''), isSvg ? 'png' : undefined);
  return { files: [new AttachmentBuilder(buffer, { name, description: truncate(part.alt ?? '', 1000) || undefined })] };
}

// ------------------------------------------------------------------ parts -> payloads

function linkRow(button) {
  return new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(button.label).setURL(button.url));
}

async function partPayload(ctx, project, cfg, post, part, index) {
  if (part.kind === 'text') {
    const payload = { content: truncate(redactSecrets(part.content), 2000) };
    if (part.button) payload.components = [linkRow(part.button)];
    return payload;
  }
  if (part.kind === 'table') {
    const { png } = renderTable(part, { accent: project.color });
    const nth = post.parts.slice(0, index).filter((p) => p.kind === 'table').length; // index is 1-based
    return { files: [new AttachmentBuilder(png, { name: `table-${nth}.png`, description: part.alt })] };
  }
  if (part.kind === 'file') {
    return { files: [new AttachmentBuilder(Buffer.from(redactSecrets(part.text), 'utf8'), { name: fileName(part.name), description: truncate(part.alt, 1000) })] };
  }
  return mediaPayload(ctx, project, cfg, post.slug, part);
}

// ------------------------------------------------------------------ posting

async function deleteMessages(ctx, cfg, ids) {
  const channel = ctx.dryRun ? null : await ctx.guildCtx.channel(cfg.channel);
  if (!channel) return;
  for (const id of ids ?? []) if (id) await channel.messages.delete(id).catch(() => {});
}

/**
 * Send every message of a post that has not gone out yet. Returns true when the whole post is
 * out. A send that fails is counted; after MAX_FAILURES the post waits for `/admin blog`.
 */
async function sendPost(ctx, project, cfg, { slug, blob, post }, log) {
  const store = ctx.state.get('blog', { posts: {}, skipped: {}, noted: {} });
  const save = () => {
    if (!ctx.dryRun) ctx.state.save('blog', { immediate: true });
  };
  let rec = store.posts[slug];
  if (rec && !rec.done && rec.blob !== blob) {
    // the file changed while it was half sent: take the half back and start clean
    await deleteMessages(ctx, cfg, rec.sent);
    rec = null;
  }
  if (!rec) rec = store.posts[slug] = { blob, title: post.title, total: post.parts.length, sent: [], done: false, failures: 0, startedAt: new Date().toISOString() };
  rec.total = post.parts.length;
  if (rec.sent.length === 0) log.info(`${slug}: posting ${post.parts.length} messages to #${cfg.channel}`);
  else log.info(`${slug}: resuming at message ${rec.sent.length + 1} of ${post.parts.length}`);
  save();

  for (let i = rec.sent.length; i < post.parts.length; i += 1) {
    try {
      const payload = await partPayload(ctx, project, cfg, post, post.parts[i], i + 1);
      const message = await ctx.guildCtx.send(cfg.channel, { ...payload, flags: MessageFlags.SuppressEmbeds });
      if (!message && !ctx.dryRun) throw new Error(`channel "${cfg.channel}" is not available`);
      rec.sent.push(message?.id ?? null);
      save();
    } catch (err) {
      rec.failures += 1;
      save();
      log.error(`${slug}: message ${i + 1} of ${post.parts.length} failed (attempt ${rec.failures} of ${MAX_FAILURES}): ${err.message}`);
      return false;
    }
  }
  rec.done = true;
  rec.failures = 0;
  rec.postedAt = new Date().toISOString();
  save();
  log.info(`${slug}: posted in ${rec.sent.length} messages`);
  return true;
}

function loadConfig(ctx) {
  const cfg = ctx.config.blog;
  const project = cfg && ctx.config.project(cfg.project);
  if (!cfg || !project) return null;
  return { cfg, project };
}

async function readPost(ctx, project, cfg, file) {
  const raw = (await ctx.github.raw(project.repo, file.path, cfg.ref)).toString('utf8');
  return planPost({ slug: file.name.slice(0, -3), raw }, { siteBase: project.site ?? 'https://dex.place' });
}

async function cycle(ctx, log) {
  const loaded = loadConfig(ctx);
  if (!loaded || sending) return;
  const { cfg, project } = loaded;
  const listing = await ctx.github.contents(project.repo, cfg.path, cfg.ref);
  const files = (Array.isArray(listing) ? listing : [])
    .filter((f) => f.type === 'file' && /^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.test(f.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  const store = ctx.state.get('blog', { posts: {}, skipped: {}, noted: {} });
  const ready = [];
  for (const file of files) {
    const slug = file.name.slice(0, -3);
    const rec = store.posts[slug];
    if (rec?.done) {
      if (rec.blob !== file.sha && store.noted[slug] !== file.sha) {
        store.noted[slug] = file.sha;
        ctx.state.save('blog');
        log.info(`${slug}: changed on the site after it was posted; /admin blog post:${slug} posts the new version`);
      }
      continue;
    }
    if (rec && rec.blob === file.sha && rec.failures >= MAX_FAILURES) continue;
    if (store.skipped[slug] === file.sha) continue;
    let post;
    try {
      post = await readPost(ctx, project, cfg, file);
    } catch (err) {
      log.warn(`${slug}: cannot read post: ${err.message}`);
      store.skipped[slug] = file.sha;
      ctx.state.save('blog');
      continue;
    }
    if (post.placeholder) {
      store.skipped[slug] = file.sha;
      ctx.state.save('blog');
      continue;
    }
    const [last] = await ctx.github.commits(project.repo, { sha: cfg.ref, path: file.path, perPage: 1 });
    const changedAt = Date.parse(last?.commit?.committer?.date ?? '');
    if (!changedAt || Date.now() - changedAt < (cfg.settleMinutes ?? 10) * 60_000) {
      log.debug(`${slug}: changed too recently, waiting for it to settle`);
      continue;
    }
    ready.push({ slug, blob: file.sha, post });
  }
  ready.sort((a, b) => (a.post.date ?? '').localeCompare(b.post.date ?? '') || a.slug.localeCompare(b.slug));
  sending = true;
  try {
    for (const item of ready) if (!(await sendPost(ctx, project, cfg, item, log))) break;
  } finally {
    sending = false;
  }
}

/**
 * /admin blog: post one post now, replacing what was sent before. No settle wait, and it clears a
 * post that gave up after repeated failures. Returns { slug, messages }.
 */
export async function repostBlog(ctx, slugInput) {
  const loaded = loadConfig(ctx);
  if (!loaded) throw new UserError('no blog feed is configured.');
  const { cfg, project } = loaded;
  const slug = String(slugInput ?? '').trim().replace(/\.md$/i, '');
  if (!SLUG.test(slug)) throw new UserError('a post name is lowercase letters, digits and dashes, like `my-first-post`.');
  if (sending) throw new UserError('a post is being sent right now. try again in a minute.');
  const file = await ctx.github.contents(project.repo, `${cfg.path}/${slug}.md`, cfg.ref);
  if (!file || Array.isArray(file)) throw new UserError(`there is no post called \`${slug}\` in ${project.repo}.`);
  const post = await readPost(ctx, project, cfg, { name: `${slug}.md`, path: file.path });
  if (post.placeholder) throw new UserError(`\`${slug}\` is marked as a placeholder, so it is not posted.`);
  const log = ctx.log.child('blog');
  const store = ctx.state.get('blog', { posts: {}, skipped: {}, noted: {} });
  sending = true;
  try {
    await deleteMessages(ctx, cfg, store.posts[slug]?.sent);
    delete store.posts[slug];
    delete store.skipped[slug];
    const ok = await sendPost(ctx, project, cfg, { slug, blob: file.sha, post }, log);
    if (!ok) throw new UserError(`posting \`${slug}\` stopped part way. the details are in #compute-bill; running this again starts it over.`);
  } finally {
    sending = false;
  }
  return { slug, messages: store.posts[slug].sent.length };
}

export default {
  name: 'blog',
  async start(ctx) {
    if (!loadConfig(ctx)) return;
    const log = ctx.log.child('blog');
    ctx.scheduler.every('blog', ctx.config.poll.blogSeconds ?? 300, () => cycle(ctx, log));
  },
};
