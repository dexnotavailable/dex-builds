import fs from 'node:fs';
import path from 'node:path';

/**
 * Tiny persistent store: one JSON file per namespace under <home>/state.
 * `get(ns)` returns a live object; mutate it, then call `save(ns)`. Writes are debounced and
 * atomic (temp file + rename) so a crash never leaves a half-written file behind.
 */
export class StateStore {
  constructor(dir, log) {
    this.dir = dir;
    this.log = log;
    this.data = new Map();
    this.timers = new Map();
    fs.mkdirSync(dir, { recursive: true });
  }

  file(ns) {
    if (!/^[a-z0-9-]+$/.test(ns)) throw new Error(`bad state namespace: ${ns}`);
    return path.join(this.dir, `${ns}.json`);
  }

  /** Live object for `ns`, loaded from disk on first use; `defaults` fills missing top-level keys. */
  get(ns, defaults = {}) {
    if (!this.data.has(ns)) {
      let value = {};
      try {
        value = JSON.parse(fs.readFileSync(this.file(ns), 'utf8'));
      } catch (err) {
        if (err.code !== 'ENOENT') {
          // Keep the unreadable file for inspection instead of silently overwriting it.
          const aside = `${this.file(ns)}.corrupt-${Date.now()}`;
          try {
            fs.renameSync(this.file(ns), aside);
          } catch {
            /* ignore */
          }
          this.log?.warn(`state ${ns} was unreadable (${err.message}); moved to ${aside}`);
        }
      }
      this.data.set(ns, value);
    }
    const value = this.data.get(ns);
    for (const [key, def] of Object.entries(defaults)) {
      if (!(key in value)) value[key] = structuredClone(def);
    }
    return value;
  }

  /** Whether a namespace file exists on disk (used to tell a first run from a restart). */
  exists(ns) {
    return this.data.has(ns) || fs.existsSync(this.file(ns));
  }

  save(ns, { immediate = false } = {}) {
    if (immediate) return this.writeNow(ns);
    if (this.timers.has(ns)) return;
    this.timers.set(
      ns,
      setTimeout(() => {
        this.timers.delete(ns);
        this.writeNow(ns);
      }, 500),
    );
  }

  writeNow(ns) {
    const timer = this.timers.get(ns);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(ns);
    }
    const value = this.data.get(ns);
    if (value === undefined) return;
    const file = this.file(ns);
    const tmp = `${file}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
      fs.renameSync(tmp, file);
    } catch (err) {
      this.log?.error(`state ${ns} write failed`, err);
    }
  }

  flush() {
    for (const ns of [...this.timers.keys()]) this.writeNow(ns);
  }
}
