import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { requireOwner } from '../core/guild.mjs';
import { codeBlock, truncate } from '../core/format.mjs';
import { redactSecrets } from '../core/redact.mjs';
import { provisionLayout } from './provision.mjs';
import { refreshFrontDesk } from './onboarding.mjs';

// /admin: owner controls. Hidden from non-admins by default permissions; still owner-checked.

// `feed`, `feed-dexcode`, `activity`… but not `feedback-issues`.
const POLLERS = /^(feed|activity|deploys)(?![a-z])/i;

/** Scheduler jobs that /admin poll kicks. */
export function pollTargets(jobs) {
  return jobs.filter((j) => POLLERS.test(j.name)).map((j) => j.name);
}

/** results: [{ name, ran, ms, error }] */
export function pollReport(results, { paused = false } = {}) {
  if (!results.length) return 'no pollers are scheduled. gojo was probably started with --no-poll.';
  const lines = results.map((r) => {
    if (r.error) return `❌ \`${r.name}\`: ${truncate(redactSecrets(r.error), 200)}`;
    if (!r.ran) return `⏳ \`${r.name}\` was already running`;
    return `✅ \`${r.name}\` ran in ${(r.ms / 1000).toFixed(1)}s`;
  });
  if (paused) lines.push('feeds are paused, but a manual poll runs anyway, so anything new got posted. `/admin resume` to go back to normal.');
  return truncate(lines.join('\n'), 1990);
}

async function restart(interaction, ctx) {
  await interaction.reply({ content: 'brb. pulling the latest devbot and coming back.', flags: MessageFlags.Ephemeral });
  ctx.log.child('admin').info(`restart requested by ${interaction.user.username}`);
  await ctx.restart('admin restart');
}

async function provision(interaction, ctx) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const report = await provisionLayout(ctx, { apply: true });
  // Recreated channels get new ids, so the guide's channel links are refreshed too.
  const desk = await refreshFrontDesk(ctx).then(
    () => 'front desk refreshed.',
    (err) => `front desk refresh failed: ${err.message}`,
  );
  await interaction.editReply(truncate(`layout applied. ${desk}\n${codeBlock(truncate(report.summary, 1700))}`, 1990));
}

async function setPaused(interaction, ctx, paused) {
  const already = ctx.flags.paused === paused;
  ctx.flags.paused = paused;
  ctx.state.save('flags', { immediate: true });
  const content = paused
    ? `${already ? 'already paused.' : 'paused.'} the feed, activity and deploy pollers and the daily standup skip their runs until \`/admin resume\`. commands keep working.`
    : `${already ? 'already live.' : 'resumed.'} pollers run again from their next tick.`;
  await interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

async function poll(interaction, ctx) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const results = await Promise.all(
    pollTargets(ctx.scheduler.status()).map(async (name) => {
      const started = Date.now();
      try {
        const ran = await ctx.scheduler.kick(name);
        return { name, ran, ms: Date.now() - started };
      } catch (err) {
        return { name, ran: true, ms: Date.now() - started, error: err.message ?? String(err) };
      }
    }),
  );
  await interaction.editReply(pollReport(results, { paused: ctx.flags.paused }));
}

async function resync(interaction, ctx) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await ctx.router.registerCommands();
  const count = ctx.router.commandJSON().length;
  await interaction.editReply(`resynced ${count} commands. if one looks stale, ctrl+r your discord client.`);
}

const SUBCOMMANDS = {
  restart,
  provision,
  pause: (interaction, ctx) => setPaused(interaction, ctx, true),
  resume: (interaction, ctx) => setPaused(interaction, ctx, false),
  poll,
  resync,
};

export default {
  name: 'admin',

  commands: () => [
    new SlashCommandBuilder()
      .setName('admin')
      .setDescription('owner controls for gojo')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addSubcommand((s) => s.setName('restart').setDescription('pull the latest devbot and restart gojo'))
      .addSubcommand((s) => s.setName('provision').setDescription('re-apply the server layout: names, topics, permissions, order'))
      .addSubcommand((s) => s.setName('pause').setDescription('pause the feed, activity and deploy pollers and the standup'))
      .addSubcommand((s) => s.setName('resume').setDescription('resume the pollers'))
      .addSubcommand((s) => s.setName('poll').setDescription('run the feed, activity and deploy pollers now'))
      .addSubcommand((s) => s.setName('resync').setDescription('re-register the slash commands')),
  ],

  async onCommand(interaction, ctx) {
    // Every subcommand goes through this one owner check.
    if (!(await requireOwner(interaction, ctx))) return;
    const handler = SUBCOMMANDS[interaction.options.getSubcommand()];
    if (handler) await handler(interaction, ctx);
  },
};
