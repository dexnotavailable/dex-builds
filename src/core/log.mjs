import fs from 'node:fs';
import path from 'node:path';
import { redactSecrets } from './redact.mjs';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MAX_BYTES = 5 * 1024 * 1024;

function describe(value) {
  if (value instanceof Error) {
    const extra = value.status ? ` (status ${value.status})` : '';
    return `${value.name}: ${value.message}${extra}${value.stack ? `\n${value.stack.split('\n').slice(1, 6).join('\n')}` : ''}`;
  }
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Line logger: console + size-rotated file, every line passed through redactSecrets.
 * `sink` (optional) receives warn/error lines so they can surface in #compute-bill.
 */
export function createLogger({ dir, file = 'devbot.log', level = 'info' } = {}) {
  const min = LEVELS[level] ?? LEVELS.info;
  let target = null;
  if (dir) {
    fs.mkdirSync(dir, { recursive: true });
    target = path.join(dir, file);
  }
  const logger = {
    sink: null,
    child(scope) {
      return {
        debug: (...a) => write('debug', scope, a),
        info: (...a) => write('info', scope, a),
        warn: (...a) => write('warn', scope, a),
        error: (...a) => write('error', scope, a),
      };
    },
    debug: (...a) => write('debug', 'core', a),
    info: (...a) => write('info', 'core', a),
    warn: (...a) => write('warn', 'core', a),
    error: (...a) => write('error', 'core', a),
  };

  function rotate() {
    try {
      const { size } = fs.statSync(target);
      if (size < MAX_BYTES) return;
      fs.rmSync(`${target}.1`, { force: true });
      fs.renameSync(target, `${target}.1`);
    } catch {
      // missing file or a locked rename: keep appending, try again next line
    }
  }

  function write(lvl, scope, args) {
    if (LEVELS[lvl] < min) return;
    const text = redactSecrets(args.map(describe).join(' '));
    const line = `${new Date().toISOString()} ${lvl.toUpperCase().padEnd(5)} [${scope}] ${text}`;
    (lvl === 'error' || lvl === 'warn' ? console.error : console.log)(line);
    if (target) {
      rotate();
      try {
        fs.appendFileSync(target, `${line}\n`);
      } catch {
        // disk trouble must never take the bot down
      }
    }
    if (logger.sink && LEVELS[lvl] >= LEVELS.warn) {
      try {
        logger.sink(lvl, scope, text);
      } catch {
        // the sink is best-effort
      }
    }
  }

  return logger;
}
