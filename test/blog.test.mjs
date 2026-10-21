import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import blog, { repoPathForMedia, repostBlog } from '../src/modules/blog.mjs';
import { LIMIT, headingEmoji, inline, parseBlocks, parseFrontmatter, planPost, readMinutes, splitText } from '../src/core/blogmd.mjs';
import { parseRuns, renderTable, tone } from '../src/core/tableimg.mjs';
import { StateStore } from '../src/core/state.mjs';

const POST = `---
title: A *test* post
summary: Short summary here.
date: 2026-10-01
---
<!-- tldr:start -->

> [!NOTE]
> **TL;DR** — things went **well** · 4%

| Stage | Work | Status |
|---|:---:|---:|
| S0 | Foundations: research | ✅ done |
| S1 | Judge | ▶ in progress |

*As of today.*

<!-- tldr:end -->

Intro paragraph that wraps
over two source lines.

## What this is

1. First step
2. Second step
   - nested bullet
3. Third step

<img src="/blog/test-post/fig.png" width="10" height="10" alt="A figure of things" loading="lazy">

*Figure 1. The things.*

### Another bit

Some [link](/docs/x/) and [anchor](#here) and \`code | pipe\`.

\`\`\`powershell title="Check it"
Get-Thing
\`\`\`

## Next

- [ ] todo
- [x] done
`;

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

// ------------------------------------------------------------------ frontmatter and blocks

test('parseFrontmatter reads key: value lines, survives a BOM, and refuses a missing fence', () => {
  const { meta, body } = parseFrontmatter('﻿---\ntitle: Hi: there\ndate: 2026-10-01\n---\nBody');
  assert.deepEqual(meta, { title: 'Hi: there', date: '2026-10-01' });
  assert.equal(body, 'Body');
  assert.throws(() => parseFrontmatter('no fence here'), /frontmatter/);
  assert.throws(() => parseFrontmatter('---\nnot a pair\n---\n'), /bad frontmatter/);
});

test('parseBlocks finds headings, tables, lists, quotes, code, images and drops HTML comments', () => {
  const blocks = parseBlocks(parseFrontmatter(POST).body);
  const types = blocks.map((b) => b.type);
  assert.deepEqual(types, ['quote', 'table', 'paragraph', 'paragraph', 'heading', 'list', 'image', 'paragraph', 'heading', 'paragraph', 'code', 'heading', 'list']);
  const table = blocks[1];
  assert.deepEqual(table.header, ['Stage', 'Work', 'Status']);
  assert.deepEqual(table.align, ['left', 'center', 'right']);
  assert.equal(table.rows.length, 2);
  assert.equal(blocks[3].text, 'Intro paragraph that wraps over two source lines.'); // a soft wrap is a space
  const list = blocks[5].items;
  assert.deepEqual(list.map((i) => i.depth), [0, 0, 1, 0]);
  assert.equal(list[0].ordered, true);
  assert.equal(list[2].ordered, false);
  assert.equal(blocks[6].src, '/blog/test-post/fig.png');
  assert.equal(blocks[6].alt, 'A figure of things');
  assert.equal(blocks[10].title, 'Check it');
  assert.equal(blocks[10].lang, 'powershell');
  assert.deepEqual(blocks[12].items.map((i) => i.checked), [false, true]);
  assert.ok(!JSON.stringify(blocks).includes('tldr'));
});

test('parseBlocks: escaped pipes stay in the cell, images inside paragraphs are pulled out, linked images too', () => {
  const [table] = parseBlocks('| a | b |\n|---|---|\n| x \\| y | z |');
  assert.deepEqual(table.rows[0], ['x | y', 'z']);
  const blocks = parseBlocks('Before ![alt text](/a.png) after\n\n[![linked](/b.webp)](https://example.com)');
  assert.deepEqual(blocks.map((b) => b.type), ['paragraph', 'image', 'image']);
  assert.equal(blocks[0].text, 'Before  after');
  assert.equal(blocks[2].src, '/b.webp');
});

// ------------------------------------------------------------------ inline

test('inline: relative links become absolute, anchors keep their text, code spans are left alone', () => {
  const ictx = { pageUrl: 'https://dex.place/blog/p/', siteBase: 'https://dex.place' };
  assert.equal(inline('see [docs](/docs/x/) and [same](other/) and [here](#top)', ictx), 'see [docs](https://dex.place/docs/x/) and [same](https://dex.place/blog/p/other/) and here');
  assert.equal(inline('`[not](/a)` and **bold**', ictx), '`[not](/a)` and **bold**');
  assert.equal(inline('press <kbd>E</kbd><br>now &amp; &lt;then&gt;', ictx), 'press `E`\nnow & <then>');
  assert.equal(inline('[bad](javascript:alert(1))', ictx), 'bad');
  assert.equal(inline('[p](https://x.test/a_(b))', ictx), '[p](https://x.test/a_%28b%29)');
});

test('headingEmoji picks by keyword, keeps an existing emoji and falls back by level', () => {
  assert.equal(headingEmoji('What went wrong so far', 2), '⚠️');
  assert.equal(headingEmoji('Next', 2), '🚀');
  assert.equal(headingEmoji('The judge', 2), '⚖️');
  assert.equal(headingEmoji('🎉 Party', 2), '');
  assert.equal(headingEmoji('Something plain', 2), '🔹');
  assert.equal(headingEmoji('Something plain', 3), '▫️');
});

test('splitText cuts at sentences under the limit and loses nothing', () => {
  const text = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} is here.`).join(' ');
  const pieces = splitText(text, 300);
  assert.ok(pieces.length > 1);
  assert.ok(pieces.every((p) => p.length <= 300));
  assert.equal(pieces.join(' ').replace(/\s+/g, ' '), text);
  assert.deepEqual(splitText('short'), ['short']);
  assert.ok(splitText('x'.repeat(500), 100).every((p) => p.length <= 100));
});

// ------------------------------------------------------------------ plan

test('planPost: header, callout, table as image, figure in its own message with a small caption', () => {
  const plan = planPost({ slug: 'test-post', raw: POST });
  assert.equal(plan.title, 'A *test* post');
  assert.equal(plan.url, 'https://dex.place/blog/test-post/');
  assert.equal(plan.placeholder, false);
  const [head, ...rest] = plan.parts;
  assert.match(head.content, /^# 📰 A \\\*test\\\* post\n-# 📅 Oct 1, 2026 · ⏱️ 1 min read\n> Short summary here\.$/);
  assert.deepEqual(head.button, { label: 'read it on dex.place', url: 'https://dex.place/blog/test-post/' });
  assert.equal(rest[0].content, '> ⚡ **TL;DR** — things went **well** · 4%');
  assert.equal(rest[1].kind, 'table');
  assert.match(rest[1].alt, /^Table\. Stage \| Work \| Status\./);
  // the table caption rides at the top of the next text message, as small text
  assert.match(rest[2].content, /^-# 🗒️ \*As of today\.\*\n\nIntro paragraph that wraps over two source lines\.$/);
  assert.match(rest[3].content, /^## 🔍 What this is\n\n1️⃣ First step\n2️⃣ Second step\n  ▫️ nested bullet\n3️⃣ Third step$/);
  assert.deepEqual(rest[4], { kind: 'media', src: '/blog/test-post/fig.png', alt: 'A figure of things' });
  assert.match(rest[5].content, /^-# 🖼️ \*Figure 1\. The things\.\*\n\n### ▫️ Another bit\n\nSome \[link\]\(https:\/\/dex\.place\/docs\/x\/\) and anchor and `code \| pipe`\.\n\n\*\*Check it\*\*\n```powershell\nGet-Thing\n```$/);
  assert.match(rest[6].content, /^## 🚀 Next\n\n⬜ todo\n☑️ done$/);
  assert.equal(rest[7].content, '-# 🔗 [read it on dex.place](https://dex.place/blog/test-post/)');
  assert.equal(rest.length, 8);
});

test('planPost: no table syntax or raw HTML ever reaches a text message', () => {
  const plan = planPost({ slug: 'test-post', raw: POST });
  for (const p of plan.parts.filter((x) => x.kind === 'text')) {
    assert.ok(!/\|---|<img|<!--|\[!NOTE\]/.test(p.content), p.content);
  }
});

test('planPost: every text message fits Discord, a heading never ends one, sections start fresh', () => {
  const para = (n) => `Paragraph ${n}. ${'word '.repeat(60)}end.`;
  const body = Array.from({ length: 40 }, (_, i) => (i % 8 === 0 ? `## Section ${i / 8}\n\n${para(i)}` : i % 8 === 7 ? `### Sub ${i}\n\n${para(i)}` : para(i))).join('\n\n');
  const plan = planPost({ slug: 'long', raw: `---\ntitle: Long\n---\n${body}\n\n## Dangling heading\n\n| a | b |\n|---|---|\n| 1 | 2 |\n` });
  const texts = plan.parts.filter((p) => p.kind === 'text');
  assert.ok(texts.length > 6);
  for (const t of texts) {
    assert.ok(t.content.length <= LIMIT, `${t.content.length} chars`);
    assert.ok(t.content.length > 0);
  }
  // a heading never ends a message that is followed by more text (one before an image is fine)
  plan.parts.forEach((p, i) => {
    if (i > 0 && p.kind === 'text' && plan.parts[i + 1]?.kind === 'text') assert.ok(!p.content.split('\n').pop().startsWith('#'), `heading ends message ${i}`);
  });
  // the heading just before a table stays as its own short message, directly ahead of the image
  const at = plan.parts.findIndex((p) => p.kind === 'table');
  assert.match(plan.parts[at - 1].content, /^## [^\n]*Dangling heading$/);
});

test('planPost: one giant paragraph is split, a huge code block becomes a file, long lists continue', () => {
  const giant = Array.from({ length: 400 }, (_, i) => `Sentence ${i} goes here.`).join(' ');
  const code = Array.from({ length: 300 }, (_, i) => `line ${i} of the code`).join('\n');
  const list = Array.from({ length: 80 }, (_, i) => `- item ${i} ${'x'.repeat(40)}`).join('\n');
  const plan = planPost({ slug: 's', raw: `---\ntitle: T\n---\n${giant}\n\n\`\`\`js\n${code}\n\`\`\`\n\n${list}\n` });
  assert.ok(plan.parts.filter((p) => p.kind === 'text').every((p) => p.content.length <= LIMIT));
  const file = plan.parts.find((p) => p.kind === 'file');
  assert.equal(file.name, 's-code-1.js');
  assert.equal(file.text, code);
  const bullets = plan.parts.filter((p) => p.kind === 'text').flatMap((p) => p.content.split('\n')).filter((l) => l.startsWith('🔹 item'));
  assert.equal(bullets.length, 80);
});

test('planPost: placeholder flag, no date, no summary and a thematic break', () => {
  const plan = planPost({ slug: 'p', raw: '---\ntitle: P\nplaceholder: true\n---\nText\n\n---\n\nMore' });
  assert.equal(plan.placeholder, true);
  assert.equal(plan.date, null);
  assert.match(plan.parts[0].content, /^# 📰 P\n-# ⏱️ 1 min read$/);
  assert.deepEqual(plan.parts.filter((p) => p.kind === 'text').map((p) => p.content).slice(1, -1), ['Text', 'More']);
});

test('readMinutes rounds 200 words a minute and never says zero', () => {
  assert.equal(readMinutes('word '.repeat(10)), 1);
  assert.equal(readMinutes('word '.repeat(1000)), 5);
  assert.equal(readMinutes('<!-- ' + 'hidden '.repeat(500) + '--> one'), 1);
});

// ------------------------------------------------------------------ table image

test('renderTable returns a real PNG, wraps long cells, and a wide table gets a wider canvas', () => {
  const small = renderTable({ header: ['A', 'B'], align: ['left', 'left'], rows: [['1', '2']] });
  assert.deepEqual([...small.png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  assert.ok(small.width > 50 && small.height > 50);
  const cell = 'a fairly long sentence that has to wrap across several lines when the column is narrow '.repeat(3);
  const wideHead = ['one', 'two', 'three', 'four', 'five', 'six'];
  const rows = Array.from({ length: 8 }, () => wideHead.map(() => cell));
  const wide = renderTable({ header: wideHead, align: wideHead.map(() => 'left'), rows });
  assert.ok(wide.width > 860 + 100, `width ${wide.width}`);
  assert.ok(wide.png.length < 9 * 1024 * 1024);
});

test('table cells: inline styles parse, links keep their text, status words get a colour', () => {
  assert.deepEqual(parseRuns('a **b** `c` *d* [e](http://x)'), [{ text: 'a ' }, { text: 'b', bold: true }, { text: ' ' }, { text: 'c', code: true }, { text: ' ' }, { text: 'd', italic: true }, { text: ' e' }]);
  assert.equal(tone('✅ done'), '#57f287');
  assert.equal(tone('▶ in progress, 60%'), '#fbbf24');
  assert.equal(tone('○ not started'), '#949ba4');
  assert.equal(tone('missed'), '#f87171');
  assert.equal(tone('front view'), null);
});

// ------------------------------------------------------------------ media paths

test('repoPathForMedia maps site URLs into public/ and refuses anything off-site', () => {
  const site = 'https://dex.place';
  assert.equal(repoPathForMedia('/blog/p/a.webp', 'p', site), 'public/blog/p/a.webp');
  assert.equal(repoPathForMedia('a.webp', 'p', site), 'public/blog/p/a.webp');
  assert.equal(repoPathForMedia('./img/a.webp', 'p', site), 'public/blog/p/img/a.webp');
  assert.equal(repoPathForMedia('https://dex.place/x/a.png?v=2', 'p', site), 'public/x/a.png');
  assert.equal(repoPathForMedia('https://evil.test/a.png', 'p', site), null);
  assert.equal(repoPathForMedia('http://169.254.169.254/latest', 'p', site), null);
  assert.equal(repoPathForMedia('../../../etc/passwd', 'p', site), 'public/etc/passwd'); // resolved inside the site, never outside public/
});

// ------------------------------------------------------------------ the module, end to end

function fakeCtx({ files, commitAt, failSends = [] }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'blogtest-'));
  const sent = [];
  const deleted = [];
  const logs = [];
  const note = (level) => (msg) => logs.push(`${level}: ${msg}`);
  const log = { info: note('info'), warn: note('warn'), error: note('error'), debug: note('debug'), child: () => log };
  let sends = 0;
  const jobs = {};
  const ctx = {
    dryRun: false,
    log,
    config: {
      blog: { project: 'dexplace', path: 'content/blog', ref: 'main', channel: 'water-cooler', settleMinutes: 10 },
      poll: { blogSeconds: 300 },
      project: (key) => (key === 'dexplace' ? { key, repo: 'o/dex.place', site: 'https://dex.place', color: '#f59e0b' } : null),
    },
    state: new StateStore(path.join(home, 'state'), log),
    scheduler: { every: (name, secs, fn) => (jobs[name] = fn) },
    github: {
      contents: async (repo, p) => {
        if (p === 'content/blog') return Object.entries(files).map(([name, f]) => ({ type: 'file', name, path: `content/blog/${name}`, sha: f.sha }));
        const name = p.split('/').pop();
        return files[name] ? { type: 'file', name, path: p, sha: files[name].sha } : null;
      },
      raw: async (repo, p) => {
        if (p.startsWith('public/')) {
          if (p.includes('missing')) throw new Error('404');
          return PNG;
        }
        return Buffer.from(files[p.split('/').pop()].text);
      },
      commits: async () => [{ commit: { committer: { date: commitAt() } } }],
    },
    guildCtx: {
      send: async (key, payload) => {
        sends += 1;
        if (failSends.includes(sends)) throw new Error('discord said no');
        assert.equal(key, 'water-cooler');
        sent.push(payload);
        return { id: `m${sent.length}` };
      },
      channel: async () => ({ messages: { delete: async (id) => deleted.push(id) } }),
    },
  };
  return { ctx, sent, deleted, logs, run: () => jobs.blog(), start: () => blog.start(ctx) };
}

const post = (title, extra = '') => `---\ntitle: ${title}\ndate: 2026-10-01\n---\n\nHello there.\n\n<img src="/blog/x/a.png" alt="pic">\n\n*Caption.*\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nBye.${extra}\n`;
const old = () => new Date(Date.now() - 3_600_000).toISOString();

test('module: posts settled real posts in order, skips placeholders, never posts twice', async () => {
  const files = {
    'zzz-second.md': { sha: 's2', text: post('Second').replace('2026-10-01', '2026-10-02') },
    'aaa-first.md': { sha: 's1', text: post('First') },
    'first-post.md': { sha: 's3', text: '---\ntitle: Placeholder\nplaceholder: true\n---\nPlaceholder.' },
  };
  const t = fakeCtx({ files, commitAt: old });
  await t.start();
  await t.run();
  const texts = t.sent.filter((p) => p.content).map((p) => p.content);
  assert.ok(texts[0].startsWith('# 📰 First'));
  assert.ok(texts.findIndex((c) => c.startsWith('# 📰 Second')) > texts.findIndex((c) => c.startsWith('# 📰 First')));
  assert.ok(!texts.some((c) => c.includes('Placeholder')));
  // every message carries the no-link-preview flag and no pings
  assert.ok(t.sent.every((p) => p.flags !== undefined));
  // figure and table are attachments in messages of their own
  const attached = t.sent.filter((p) => p.files);
  assert.equal(attached.length, 4);
  assert.ok(attached.every((p) => !p.content));
  assert.equal(attached[0].files[0].description, 'pic');
  assert.equal(attached[1].files[0].name, 'table-1.png');
  const state = t.ctx.state.get('blog');
  assert.equal(state.posts['aaa-first'].done, true);
  assert.equal(state.posts['aaa-first'].sent.length, state.posts['aaa-first'].total);
  assert.equal(state.skipped['first-post'], 's3');
  const count = t.sent.length;
  await t.run();
  assert.equal(t.sent.length, count);
});

test('module: a post that changed minutes ago waits, then goes out once it has settled', async () => {
  let at = new Date().toISOString();
  const t = fakeCtx({ files: { 'fresh.md': { sha: 'a', text: post('Fresh') } }, commitAt: () => at });
  await t.start();
  await t.run();
  assert.equal(t.sent.length, 0);
  at = old();
  await t.run();
  assert.ok(t.sent.length > 0);
});

test('module: a failed send resumes where it stopped and does not repeat earlier messages', async () => {
  const t = fakeCtx({ files: { 'p.md': { sha: 'a', text: post('Resumable') } }, commitAt: old, failSends: [3] });
  await t.start();
  await t.run();
  const after = t.ctx.state.get('blog').posts.p;
  assert.equal(after.done, false);
  assert.equal(after.sent.length, 2);
  assert.equal(after.failures, 1);
  assert.ok(t.logs.some((l) => l.startsWith('error:') && l.includes('message 3')));
  await t.run();
  const done = t.ctx.state.get('blog').posts.p;
  assert.equal(done.done, true);
  assert.equal(new Set(done.sent).size, done.total);
  assert.equal(t.sent.filter((p) => p.content?.startsWith('# 📰')).length, 1);
});

test('module: it gives up after repeated failures instead of hammering Discord', async () => {
  const t = fakeCtx({ files: { 'p.md': { sha: 'a', text: post('Broken') } }, commitAt: old, failSends: [1, 2, 3, 4, 5, 6, 7, 8] });
  await t.start();
  for (let i = 0; i < 6; i += 1) await t.run();
  assert.equal(t.ctx.state.get('blog').posts.p.failures, 3);
});

test('module: an edit after posting is noted once and not posted again', async () => {
  const t = fakeCtx({ files: { 'p.md': { sha: 'a', text: post('Edited') } }, commitAt: old });
  await t.start();
  await t.run();
  const count = t.sent.length;
  t.ctx.github.contents = async () => [{ type: 'file', name: 'p.md', path: 'content/blog/p.md', sha: 'b' }];
  await t.run();
  await t.run();
  assert.equal(t.sent.length, count);
  assert.equal(t.logs.filter((l) => l.includes('changed on the site after it was posted')).length, 1);
});

test('module: a picture that cannot be loaded falls back to a link instead of failing the post', async () => {
  const text = post('Missing pic').replace('/blog/x/a.png', '/blog/x/missing.png').replace('alt="pic"', 'alt="a missing one"');
  const t = fakeCtx({ files: { 'p.md': { sha: 'a', text } }, commitAt: old });
  await t.start();
  await t.run();
  assert.equal(t.ctx.state.get('blog').posts.p.done, true);
  assert.ok(t.sent.some((p) => p.content === '🖼️ [a missing one](https://dex.place/blog/x/missing.png)'));
});

test('repostBlog deletes the old copy, posts the new one, and refuses unknown, placeholder or odd names', async () => {
  const files = { 'p.md': { sha: 'a', text: post('Again') }, 'ph.md': { sha: 'c', text: '---\ntitle: P\nplaceholder: true\n---\nx' } };
  const t = fakeCtx({ files, commitAt: old });
  await t.start();
  await t.run();
  const first = [...t.ctx.state.get('blog').posts.p.sent];
  const result = await repostBlog(t.ctx, 'p.md');
  assert.equal(result.slug, 'p');
  assert.deepEqual(t.deleted, first);
  assert.equal(t.ctx.state.get('blog').posts.p.done, true);
  await assert.rejects(() => repostBlog(t.ctx, 'nope'), /no post called/);
  await assert.rejects(() => repostBlog(t.ctx, 'ph'), /placeholder/);
  await assert.rejects(() => repostBlog(t.ctx, '../x'), /lowercase/);
});

test('module: dry-run sends nothing to state and does not touch the channel', async () => {
  const t = fakeCtx({ files: { 'p.md': { sha: 'a', text: post('Dry') } }, commitAt: old });
  t.ctx.dryRun = true;
  t.ctx.guildCtx.send = async () => null;
  await t.start();
  await t.run();
  assert.equal(fs.existsSync(path.join(t.ctx.state.dir, 'blog.json')), false);
});
