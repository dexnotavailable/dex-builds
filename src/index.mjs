import { parseArgs } from './core/config.mjs';
import { createApp } from './app.mjs';

// Entry point for the real bot (run by ops/supervisor.mjs). See src/app.mjs for the wiring.

const args = parseArgs();
let app;
try {
  app = createApp(args);
} catch (err) {
  console.error(err.message);
  process.exit(err.exitCode ?? 1);
}
const { log, shutdown, boot } = app;

process.on('SIGINT', () => shutdown(0, 'SIGINT'));
process.on('SIGTERM', () => shutdown(0, 'SIGTERM'));
process.on('unhandledRejection', (err) => log.error('unhandled rejection', err));
process.on('uncaughtException', (err) => {
  log.error('uncaught exception', err);
  shutdown(1, 'uncaught exception');
});

try {
  await boot({ provision: args.provision, provisionOnly: args.provisionOnly, noPoll: args.noPoll });
  if (args.provisionOnly) await shutdown(0, 'provision-only');
} catch (err) {
  log.error('startup failed', err);
  await shutdown(1, 'startup failure');
}
