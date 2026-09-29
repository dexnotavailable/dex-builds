import { RateLimitError } from './github.mjs';

/**
 * Non-overlapping interval loops. Each job waits `seconds` after its previous run finished.
 * A RateLimitError pauses that job until GitHub's reset time; other errors are logged and the
 * job keeps its normal cadence. `ctx.flags.paused` skips runs of jobs marked pausable.
 */
export class Scheduler {
  constructor({ log, flags }) {
    this.log = log;
    this.flags = flags;
    this.jobs = new Map();
    this.stopped = false;
  }

  every(name, seconds, fn, { runAtStart = true, pausable = true } = {}) {
    if (this.jobs.has(name)) throw new Error(`job ${name} already scheduled`);
    const job = { name, seconds, fn, pausable, timer: null, running: false, lastRun: null, lastError: null, wake: null };
    this.jobs.set(name, job);
    const loop = async () => {
      if (this.stopped) return;
      if (job.running) {
        // a kick() is mid-run; check back shortly instead of overlapping it
        job.timer = setTimeout(loop, 5_000);
        return;
      }
      let delay = seconds * 1000;
      if (!(pausable && this.flags.paused)) {
        job.running = true;
        try {
          await fn();
          job.lastRun = new Date();
          job.lastError = null;
        } catch (err) {
          job.lastError = err;
          if (err instanceof RateLimitError) {
            delay = Math.max(delay, (err.resetAt ?? Date.now() + 60_000) - Date.now() + 5_000);
            this.log.warn(`job ${name}: ${err.message}; next run in ${Math.round(delay / 1000)}s`);
          } else {
            this.log.error(`job ${name} failed`, err);
          }
        } finally {
          job.running = false;
        }
      }
      if (!this.stopped) job.timer = setTimeout(loop, delay);
    };
    job.timer = setTimeout(loop, runAtStart ? 1_000 : seconds * 1000);
    return job;
  }

  /** Run a job now (e.g. after an admin command) unless it is already running. */
  async kick(name) {
    const job = this.jobs.get(name);
    if (!job || job.running) return false;
    job.running = true;
    try {
      await job.fn();
      job.lastRun = new Date();
      job.lastError = null;
    } catch (err) {
      job.lastError = err;
      throw err;
    } finally {
      job.running = false;
    }
    return true;
  }

  status() {
    return [...this.jobs.values()].map((j) => ({
      name: j.name,
      seconds: j.seconds,
      running: j.running,
      lastRun: j.lastRun,
      lastError: j.lastError ? j.lastError.message : null,
    }));
  }

  stopAll() {
    this.stopped = true;
    for (const job of this.jobs.values()) clearTimeout(job.timer);
  }
}
