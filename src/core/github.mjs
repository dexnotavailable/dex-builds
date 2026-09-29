// Minimal GitHub REST client: token auth, ETag caching (304s are free against the rate limit),
// Link-header pagination and explicit rate-limit errors the scheduler can wait out.

const API = 'https://api.github.com';

export class GitHubError extends Error {
  constructor(message, { status, body, path } = {}) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.body = body;
    this.path = path;
  }
}

export class RateLimitError extends GitHubError {
  constructor(message, { resetAt, ...rest } = {}) {
    super(message, rest);
    this.name = 'RateLimitError';
    this.resetAt = resetAt; // epoch ms
  }
}

// new URL() resolves '.' and '..' segments, so a user-supplied path or ref made of them would
// walk to a different API endpoint with the bot's token. Refuse them outright.
function checkSegment(seg) {
  if (seg === '.' || seg === '..') throw new GitHubError(`refusing path segment "${seg}"`, { status: 400 });
  return seg;
}

function encodePath(p) {
  return String(p)
    .split('/')
    .filter((seg) => seg.length > 0)
    .map((seg) => encodeURIComponent(checkSegment(seg)))
    .join('/');
}

function encodeRef(ref) {
  return encodeURIComponent(checkSegment(String(ref)));
}

export class GitHub {
  constructor({ token, log, userAgent = 'dex-devbot', fetchImpl = globalThis.fetch } = {}) {
    if (!token) throw new Error('GitHub token missing (GITHUB_TOKEN)');
    this.token = token;
    this.log = log;
    this.userAgent = userAgent;
    this.fetch = fetchImpl;
    this.etags = new Map(); // url -> { etag, data }
    this.rate = { remaining: null, resetAt: null };
  }

  /**
   * Low-level request. Returns { status, data, headers, notModified }.
   * opts: query, body, accept, conditional (use/refresh the ETag cache), text (return body as text),
   * buffer (return body as Buffer), allow (extra ok statuses, e.g. [404]).
   */
  async request(method, path, opts = {}) {
    const url = new URL(path.startsWith('http') ? path : `${API}${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    const key = url.toString();
    const headers = {
      Authorization: `Bearer ${this.token}`,
      Accept: opts.accept ?? 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': this.userAgent,
    };
    const cached = opts.conditional ? this.etags.get(key) : undefined;
    if (cached) headers['If-None-Match'] = cached.etag;
    let body;
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }

    let res;
    try {
      res = await this.fetch(key, { method, headers, body, signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000) });
    } catch (err) {
      throw new GitHubError(`GitHub ${method} ${url.pathname} failed: ${err.message}`, { path: url.pathname });
    }

    const remaining = res.headers.get('x-ratelimit-remaining');
    const reset = res.headers.get('x-ratelimit-reset');
    if (remaining !== null) this.rate.remaining = Number(remaining);
    if (reset !== null) this.rate.resetAt = Number(reset) * 1000;

    if (res.status === 304 && cached) {
      // A 304 may omit the Link header, so pagination reads the cached one.
      return { status: 304, data: cached.data, headers: res.headers, link: cached.link, notModified: true };
    }

    if (res.status === 403 || res.status === 429) {
      const retryAfter = res.headers.get('retry-after');
      if (remaining === '0' || retryAfter) {
        const resetAt = retryAfter ? Date.now() + Number(retryAfter) * 1000 : this.rate.resetAt ?? Date.now() + 60_000;
        throw new RateLimitError(`GitHub rate limited until ${new Date(resetAt).toISOString()}`, {
          status: res.status,
          resetAt,
          path: url.pathname,
        });
      }
    }

    const ok = res.ok || (opts.allow ?? []).includes(res.status);
    let data;
    if (opts.buffer && res.ok) data = Buffer.from(await res.arrayBuffer());
    else if (opts.text && res.ok) data = await res.text();
    else {
      const raw = await res.text();
      try {
        data = raw ? JSON.parse(raw) : null;
      } catch {
        data = raw;
      }
    }
    if (!ok) {
      const msg = data && typeof data === 'object' && data.message ? data.message : `HTTP ${res.status}`;
      throw new GitHubError(`GitHub ${method} ${url.pathname}: ${msg}`, { status: res.status, body: data, path: url.pathname });
    }
    const etag = res.headers.get('etag');
    const link = res.headers.get('link') ?? '';
    if (opts.conditional && etag && res.status === 200) this.etags.set(key, { etag, data, link });
    return { status: res.status, data, headers: res.headers, link, notModified: false };
  }

  async get(path, opts = {}) {
    return (await this.request('GET', path, opts)).data;
  }

  /**
   * GET every page of a list endpoint. With conditional=true each page is ETag-cached and the
   * result carries `changed: false` when every page answered 304.
   */
  async paginate(path, { query = {}, conditional = false, maxPages = 20 } = {}) {
    const items = [];
    let changed = false;
    let next = `${API}${path}`;
    let first = true;
    let pages = 0;
    while (next && pages < maxPages) {
      const res = await this.request('GET', next, { query: first ? { per_page: 100, ...query } : {}, conditional });
      first = false;
      pages += 1;
      if (!res.notModified) changed = true;
      if (Array.isArray(res.data)) items.push(...res.data);
      else if (res.data && Array.isArray(res.data.items)) items.push(...res.data.items);
      const m = (res.link ?? '').match(/<([^>]+)>;\s*rel="next"/);
      next = m ? m[1] : null;
    }
    if (next) this.log?.warn(`paginate ${path}: stopped at ${maxPages} pages`);
    return { items, changed };
  }

  // ---------------------------------------------------------------- repo helpers

  repo(repo) {
    return this.get(`/repos/${repo}`, { conditional: true });
  }

  branches(repo) {
    return this.paginate(`/repos/${repo}/branches`, { conditional: true });
  }

  /** compare base...head (JSON: status, ahead_by, behind_by, commits[], files[], merge_base_commit). */
  /**
   * compare base...head. Commits come oldest first, 100 per page; `page` picks a later page (the
   * newest commits of a big range are on page ceil(total_commits / 100)).
   */
  compare(repo, base, head, { page } = {}) {
    return this.get(`/repos/${repo}/compare/${encodeRef(base)}...${encodeRef(head)}`, {
      query: { per_page: 100, page },
    });
  }

  /**
   * compare, but when the range holds more commits than the first page, `commits` becomes the
   * newest `keep` commits of head (oldest first, like compare). Compare pages stop at 250 commits
   * while total_commits keeps counting, so the commits API is the reliable source of the newest.
   */
  async compareNewest(repo, base, head, { keep = 20 } = {}) {
    const first = await this.compare(repo, base, head);
    const shown = first.commits?.length ?? 0;
    const total = first.total_commits ?? shown;
    if (total <= shown) return first;
    const newest = await this.commits(repo, { sha: head, perPage: Math.min(keep, total) }).catch(() => null);
    return newest?.length ? { ...first, commits: [...newest].reverse() } : first;
  }

  compareDiff(repo, base, head) {
    return this.get(`/repos/${repo}/compare/${encodeRef(base)}...${encodeRef(head)}`, {
      accept: 'application/vnd.github.diff',
      text: true,
      timeoutMs: 60_000,
    });
  }

  commit(repo, ref) {
    return this.get(`/repos/${repo}/commits/${encodeRef(ref)}`);
  }

  commitDiff(repo, ref) {
    return this.get(`/repos/${repo}/commits/${encodeRef(ref)}`, {
      accept: 'application/vnd.github.diff',
      text: true,
      timeoutMs: 60_000,
    });
  }

  commits(repo, { sha, since, until, perPage = 30, path } = {}) {
    return this.get(`/repos/${repo}/commits`, { query: { sha, since, until, per_page: perPage, path } });
  }

  /** Contents API: a file object (base64 content up to 1 MB) or an array for a directory. 404 -> null. */
  async contents(repo, path, ref) {
    const res = await this.request('GET', `/repos/${repo}/contents/${encodePath(path)}`, {
      query: { ref },
      allow: [404],
    });
    return res.status === 404 ? null : res.data;
  }

  /** Raw file bytes (works past the 1 MB contents limit, up to 100 MB). */
  raw(repo, path, ref) {
    return this.get(`/repos/${repo}/contents/${encodePath(path)}`, {
      query: { ref },
      accept: 'application/vnd.github.raw',
      buffer: true,
      timeoutMs: 60_000,
    });
  }

  tree(repo, ref) {
    return this.get(`/repos/${repo}/git/trees/${encodeRef(ref)}`, { query: { recursive: 1 }, timeoutMs: 60_000 });
  }

  pulls(repo, { state = 'all', perPage = 30 } = {}) {
    return this.get(`/repos/${repo}/pulls`, { query: { state, sort: 'updated', direction: 'desc', per_page: perPage } });
  }

  /** Issues only (pull requests filtered out). */
  async issues(repo, { state = 'all', since, perPage = 50 } = {}) {
    const list = await this.get(`/repos/${repo}/issues`, {
      query: { state, since, sort: 'updated', direction: 'desc', per_page: perPage },
    });
    return list.filter((i) => !i.pull_request);
  }

  issue(repo, number) {
    return this.get(`/repos/${repo}/issues/${number}`);
  }

  createIssue(repo, { title, body, labels }) {
    return this.request('POST', `/repos/${repo}/issues`, { body: { title, body, labels } }).then((r) => r.data);
  }

  commentIssue(repo, number, body) {
    return this.request('POST', `/repos/${repo}/issues/${number}/comments`, { body: { body } }).then((r) => r.data);
  }

  updateIssue(repo, number, fields) {
    return this.request('PATCH', `/repos/${repo}/issues/${number}`, { body: fields }).then((r) => r.data);
  }

  /** GraphQL query; throws GitHubError when the response carries errors. */
  async graphql(query, variables = {}) {
    const res = await this.request('POST', `${API}/graphql`, { body: { query, variables } });
    if (res.data?.errors?.length) {
      throw new GitHubError(`GitHub GraphQL: ${res.data.errors.map((e) => e.message).join('; ')}`, { status: 200, body: res.data });
    }
    return res.data.data;
  }

  /**
   * Every branch, newest-first by head commit date: [{ name, sha, committedDate, headline, author }].
   * GraphQL, 100 refs per call. GitHub's own TAG_COMMIT_DATE ordering is unreliable for branches,
   * so the sort happens here.
   */
  async branchesByDate(repo, { maxPages = 10 } = {}) {
    const [owner, name] = repo.split('/');
    const branches = [];
    let after = null;
    let totalCount = 0;
    for (let page = 0; page < maxPages; page += 1) {
      const data = await this.graphql(
        `query($owner:String!,$name:String!,$after:String){repository(owner:$owner,name:$name){refs(refPrefix:"refs/heads/",first:100,after:$after){totalCount pageInfo{hasNextPage endCursor} nodes{name target{... on Commit{oid committedDate messageHeadline author{name user{login}}}}}}}}`,
        { owner, name, after },
      );
      const refs = data.repository.refs;
      totalCount = refs.totalCount;
      for (const n of refs.nodes) {
        branches.push({
          name: n.name,
          sha: n.target?.oid ?? null,
          committedDate: n.target?.committedDate ?? null,
          headline: n.target?.messageHeadline ?? '',
          author: n.target?.author?.user?.login ?? n.target?.author?.name ?? null,
        });
      }
      if (!refs.pageInfo.hasNextPage) break;
      after = refs.pageInfo.endCursor;
    }
    branches.sort((a, b) => String(b.committedDate ?? '').localeCompare(String(a.committedDate ?? '')));
    return { totalCount, branches };
  }

  runs(repo, { perPage = 20 } = {}) {
    return this.get(`/repos/${repo}/actions/runs`, { query: { per_page: perPage } });
  }

  /** GitHub user or null when the login does not exist. */
  async user(login) {
    const res = await this.request('GET', `/users/${encodeURIComponent(login)}`, { allow: [404] });
    return res.status === 404 ? null : res.data;
  }

  /**
   * Invite (or update) a collaborator. permission: pull | triage | push | maintain | admin.
   * On repos owned by a personal account GitHub ignores `permission`: every collaborator can push.
   */
  addCollaborator(repo, login, permission = 'pull') {
    return this.request('PUT', `/repos/${repo}/collaborators/${encodeURIComponent(login)}`, {
      body: { permission },
    });
  }

  /** One pull request (the list endpoint leaves out changed_files/additions/deletions). */
  pull(repo, number) {
    return this.get(`/repos/${repo}/pulls/${Number(number)}`);
  }

  /** True when `login` is a collaborator (GET answers 204, or 404 when not). */
  async isCollaborator(repo, login) {
    const res = await this.request('GET', `/repos/${repo}/collaborators/${encodeURIComponent(login)}`, { allow: [404] });
    return res.status !== 404;
  }

  // DELETE answers 204 whether or not the person was a collaborator; use isCollaborator first.
  removeCollaborator(repo, login) {
    return this.request('DELETE', `/repos/${repo}/collaborators/${encodeURIComponent(login)}`, { allow: [404] });
  }

  /** Pending invitations for a repo (to cancel one on revoke). */
  invitations(repo) {
    return this.get(`/repos/${repo}/invitations`, { query: { per_page: 100 } });
  }

  deleteInvitation(repo, id) {
    return this.request('DELETE', `/repos/${repo}/invitations/${id}`, { allow: [404] });
  }

  async collaboratorPermission(repo, login) {
    const res = await this.request('GET', `/repos/${repo}/collaborators/${encodeURIComponent(login)}/permission`, {
      allow: [404],
    });
    return res.status === 404 ? null : res.data;
  }
}
