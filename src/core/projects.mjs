// Shared slash-command plumbing for "which project" and "which ref" options.

/** Add the standard `project` string option (choices from config) to a builder. */
export function addProjectOption(builder, config, { required = true, description = 'which project' } = {}) {
  return builder.addStringOption((o) =>
    o
      .setName('project')
      .setDescription(description)
      .setRequired(required)
      .addChoices(...config.projects.map((p) => ({ name: `${p.emoji} ${p.name}`, value: p.key }))),
  );
}

/** Add an autocompleted `ref` option (branch name or commit sha). */
export function addRefOption(builder, { name = 'ref', required = false, description = 'branch or commit (default: the default branch)' } = {}) {
  return builder.addStringOption((o) => o.setName(name).setDescription(description).setRequired(required).setAutocomplete(true).setMaxLength(200));
}

export class UserError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UserError';
  }
}

export function getProject(ctx, key) {
  const project = ctx.config.project(key);
  if (!project) throw new UserError(`unknown project "${key}"`);
  return project;
}

// ------------------------------------------------------------------ branches / refs

const branchCache = new Map(); // projectKey -> { at, branches: [{ name, sha }], defaultBranch }

/** Branch list for a project, cached 30 s (the underlying GitHub call is ETag-cached too). */
export async function listBranches(ctx, project) {
  const hit = branchCache.get(project.key);
  if (hit && Date.now() - hit.at < 30_000) return hit;
  const [{ items }, repo] = await Promise.all([ctx.github.branches(project.repo), ctx.github.repo(project.repo)]);
  const value = {
    at: Date.now(),
    defaultBranch: repo.default_branch,
    branches: items.map((b) => ({ name: b.name, sha: b.commit.sha })),
  };
  branchCache.set(project.key, value);
  return value;
}

export async function defaultBranch(ctx, project) {
  return (await listBranches(ctx, project)).defaultBranch;
}

/**
 * Autocomplete for a ref option. Reads the `project` option of the same interaction; default
 * branch first, then branches containing the typed text (most recently pushed first when the
 * feed has seen them).
 */
export async function autocompleteRef(interaction, ctx) {
  const key = interaction.options.getString('project');
  const project = key ? ctx.config.project(key) : null;
  if (!project) return interaction.respond([]);
  const typed = String(interaction.options.getFocused() ?? '').toLowerCase();
  const { branches, defaultBranch: def } = await listBranches(ctx, project);
  const seen = ctx.state.get('heads')?.[project.key]?.pushedAt ?? {};
  const matches = branches
    .filter((b) => b.name.toLowerCase().includes(typed))
    .sort((a, b) => {
      if (a.name === def) return -1;
      if (b.name === def) return 1;
      return String(seen[b.name] ?? '').localeCompare(String(seen[a.name] ?? '')) || a.name.localeCompare(b.name);
    })
    .slice(0, 25)
    .map((b) => ({ name: b.name.length > 100 ? `${b.name.slice(0, 97)}...` : b.name, value: b.name.slice(0, 100) }));
  // Let a typed sha through as-is.
  if (/^[0-9a-f]{7,40}$/i.test(typed) && !matches.some((m) => m.value === typed)) matches.unshift({ name: `commit ${typed}`, value: typed });
  return interaction.respond(matches.slice(0, 25));
}

/** The ref to use: the given one, or the project's default branch. */
export async function resolveRef(ctx, project, ref) {
  const r = String(ref ?? '').trim();
  return r || defaultBranch(ctx, project);
}
