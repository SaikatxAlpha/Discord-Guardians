// Runtime shared by KNIGHT and AEGIS: Discord client, ALPHA coordinator,
// interaction routing, approval buttons, cross-bot task worker, scheduler,
// heartbeats and graceful shutdown.
import { Client, Events, MessageFlags } from 'discord.js';
import { loadEnv, getConfig, validateConfig } from '../../config/env.js';
import { THEME } from '../../config/defaults.js';
import { createLogger } from '../../core/logger.js';
import { openDatabase } from '../../database/db.js';
import { AlphaCoordinator, humanError } from '../../core/coordinator.js';
import { createAI } from '../../ai/index.js';
import { createSTT } from '../../features/voice/stt.js';
import { claimTask, completeTask, failTask, reapExpiredTasks, releaseWorkerLeases } from '../../core/taskQueue.js';
import { expireApprovals, setApprovalMessage } from '../../core/approvals.js';
import { Scheduler, createJob } from '../../core/scheduler.js';
import { heartbeat, runBackup } from '../../core/health.js';
import { getGuildSettings } from '../../core/settings.js';
import { renderResponse, approvalButtons } from './render.js';
import { systemHandlers } from './systemHandlers.js';
import { guardianEmbed, STATUS_COLORS } from '../../core/discord/theme.js';
import { sendToChannel } from '../../core/discord/send.js';

export class GuardianBot {
  /**
   * @param {object} o
   * @param {'knight'|'aegis'} o.name
   * @param {number[]} o.intents
   */
  constructor({ name, intents, partials = [] }) {
    loadEnv();
    this.name = name;
    this.theme = THEME[name];
    this.config = getConfig();
    this.logger = createLogger(name.toUpperCase(), { dir: this.config.logDir, level: this.config.logLevel });
    const { errors, warnings } = validateConfig(this.config, { bots: [name] });
    for (const w of warnings) this.logger.warn(w);
    if (errors.length) {
      for (const e of errors) this.logger.error(`config: ${e}`);
      throw new Error(`Configuration invalid for ${name.toUpperCase()} (see messages above; run "npm run check:config").`);
    }
    this.db = openDatabase(this.config.dbPath);
    this.ai = createAI({ config: this.config, db: this.db, logger: this.logger });
    this.stt = createSTT({ config: this.config, db: this.db, logger: this.logger });
    this.workerId = `${name}:${process.pid}:${Date.now().toString(36)}`;
    this.startedAt = Date.now();
    this.client = new Client({ intents, partials, allowedMentions: { parse: [] } });
    this.handlers = new Map(Object.entries(systemHandlers({ ai: this.ai, stt: this.stt })));
    this.commands = new Map();
    this.buttons = new Map(); // customId prefix -> handler(interaction)
    this.jobHandlers = {
      'system.backup': async () => {
        const file = runBackup(this.db, this.config.backupDir, this.config.backupKeep);
        this.logger.info('database backup written', { file });
      },
    };
    this.extraContext = () => ({});
    this.timers = [];
    this.shuttingDown = false;

    this.coordinator = new AlphaCoordinator({
      db: this.db,
      config: this.config,
      bot: name,
      logger: this.logger,
      ai: this.ai,
      handlers: this.handlers,
      getGuild: (id) => this.getGuild(id),
      makeContext: (guild, req) => ({ client: this.client, ai: this.ai, stt: this.stt, app: this, ...this.extraContext(guild, req) }),
    });
    this.buttons.set('alpha:approve', (i) => this.onApproval(i, true));
    this.buttons.set('alpha:reject', (i) => this.onApproval(i, false));
  }

  addHandlers(obj) {
    for (const [k, fn] of Object.entries(obj)) this.handlers.set(k, fn);
  }

  addCommands(list) {
    for (const c of list) this.commands.set(c.data.name, c);
  }

  async getGuild(id) {
    if (!id) return null;
    return this.client.guilds.cache.get(id) ?? (await this.client.guilds.fetch(id).catch(() => null));
  }

  /** Request object for the coordinator from an interaction. */
  requestFrom(interaction, extra = {}) {
    return {
      requestId: `ix:${interaction.id}`,
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      userId: interaction.user.id,
      member: interaction.member,
      source: 'slash',
      ...extra,
    };
  }

  /** Run structured steps for a slash command and reply with the rendered result. */
  async runSteps(interaction, steps, { ephemeral = false } = {}) {
    if (!interaction.deferred && !interaction.replied) await interaction.deferReply(ephemeral ? { flags: MessageFlags.Ephemeral } : {});
    const res = await this.coordinator.handleSteps(this.requestFrom(interaction), steps);
    return this.replyWithResponse(interaction, res);
  }

  async replyWithResponse(interaction, res) {
    const payload = renderResponse(this.name, res);
    const msg = await interaction.editReply({ ...payload, allowedMentions: { parse: [] } });
    if (res.status === 'awaiting_approval') setApprovalMessage(this.db, res.approval.id, msg.channelId, msg.id);
    return res;
  }

  /** Post a coordinator response into a channel (voice / text ALPHA). */
  async postResponse(guild, channelId, res) {
    const payload = renderResponse(this.name, res);
    const msg = await sendToChannel(guild, channelId, payload, this.logger);
    if (msg && res.status === 'awaiting_approval') setApprovalMessage(this.db, res.approval.id, msg.channelId, msg.id);
    return msg;
  }

  async onApproval(interaction, approve) {
    const approvalId = interaction.customId.split(':')[2];
    await interaction.deferUpdate();
    const res = await this.coordinator.decide({ approvalId, userId: interaction.user.id, approve });
    if (res.status === 'rejected' && res.reason === 'unauthorized') {
      await interaction.followUp({ content: res.message, flags: MessageFlags.Ephemeral });
      return;
    }
    const payload = renderResponse(this.name, res);
    await interaction.editReply({ ...payload, components: res.status === 'rejected' ? [approvalButtons(approvalId, true)] : payload.components });
  }

  async onInteraction(interaction) {
    try {
      if (interaction.isChatInputCommand() || interaction.isAutocomplete()) {
        const cmd = this.commands.get(interaction.commandName);
        if (!cmd) return;
        if (interaction.isAutocomplete()) return cmd.autocomplete?.(interaction, this);
        if (!interaction.inGuild()) return interaction.reply({ content: 'Soul Society commands work inside the server.', flags: MessageFlags.Ephemeral });
        await cmd.execute(interaction, this);
      } else if (interaction.isButton() || interaction.isStringSelectMenu()) {
        const prefix = interaction.customId.split(':').slice(0, 2).join(':');
        const handler = this.buttons.get(prefix);
        if (handler) await handler(interaction, this);
      }
    } catch (err) {
      this.logger.error('interaction failed', { command: interaction.commandName ?? interaction.customId, err });
      const content = `Something went wrong: ${humanError(err)}`;
      if (interaction.isRepliable?.()) {
        if (interaction.deferred || interaction.replied) await interaction.editReply({ content, embeds: [], components: [] }).catch(() => null);
        else await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => null);
      }
    }
  }

  // ------------------------------------------------------------ cross-bot worker

  async workOnce() {
    const task = claimTask(this.db, this.name, this.workerId);
    if (!task) return false;
    const guild = await this.getGuild(task.guild_id);
    try {
      const handler = this.handlers.get(task.action);
      if (!handler) throw new Error(`${this.name} cannot perform ${task.action}`);
      if (!guild) throw new Error('guild unavailable');
      const req = { ...task.context, guildId: task.guild_id };
      const settings = getGuildSettings(this.db, guild.id);
      const result = await handler({ db: this.db, config: this.config, logger: this.logger, bot: this.name, guild, settings, request: req, client: this.client, ai: this.ai, stt: this.stt, app: this, ...this.extraContext(guild, req) }, task.params);
      completeTask(this.db, task.id, this.workerId, result);
      this.logger.info('cross-bot task done', { taskId: task.id, action: task.action, ok: result?.ok });
    } catch (err) {
      failTask(this.db, task.id, this.workerId, humanError(err));
      this.logger.warn('cross-bot task failed', { taskId: task.id, action: task.action, err: err.message });
    }
    return true;
  }

  startLoops() {
    const every = (ms, fn) => {
      const t = setInterval(() => {
        if (!this.shuttingDown) Promise.resolve(fn()).catch((err) => this.logger.error('background loop error', { err }));
      }, ms);
      this.timers.push(t);
    };
    let working = false;
    every(500, async () => {
      if (working) return;
      working = true;
      try {
        while (!this.shuttingDown && (await this.workOnce()));
      } finally {
        working = false;
      }
    });
    every(30000, () => reapExpiredTasks(this.db));
    every(10000, () => this.expireApprovalMessages());
    every(15000, () => this.beat());
    this.scheduler = new Scheduler({
      db: this.db,
      bot: this.name,
      workerId: this.workerId,
      tz: this.config.timezone,
      handlers: this.jobHandlers,
      logger: this.logger,
      onFailure: (job, err) => this.notifyJobFailure(job, err),
    });
    this.scheduler.start();
    createJob(this.db, { bot: 'any', type: 'system.backup', schedule: { kind: 'daily', time: '04:00' }, tz: this.config.timezone, uniqueKey: 'system:backup' });
  }

  async expireApprovalMessages() {
    for (const a of expireApprovals(this.db)) {
      if (a.bot !== this.name || !a.channel_id || !a.message_id) continue;
      const ch = await this.client.channels.fetch(a.channel_id).catch(() => null);
      const msg = await ch?.messages?.fetch(a.message_id).catch(() => null);
      await msg?.edit({ embeds: [guardianEmbed(this.name, { title: 'Approval expired', color: STATUS_COLORS.warn, description: `${a.summary}\n\nNothing was changed.` })], components: [approvalButtons(a.id, true)] }).catch(() => null);
    }
  }

  async notifyJobFailure(job, err) {
    if (!job.guild_id) return;
    const guild = await this.getGuild(job.guild_id);
    if (!guild) return;
    const s = getGuildSettings(this.db, guild.id);
    await sendToChannel(guild, s.channels.alpha ?? s.channels.reports, { embeds: [guardianEmbed(this.name, { title: 'Scheduled task failed', color: STATUS_COLORS.error, description: `Job **${job.type}** (${job.id.slice(0, 8)}) failed after retries: ${String(err.message ?? err).slice(0, 500)}` })] }, this.logger);
  }

  beat(status = 'online') {
    heartbeat(this.db, this.name, { status, startedAt: this.startedAt, info: { guilds: this.client.guilds?.cache.size ?? 0, ping: this.client.ws?.ping ?? null, user: this.client.user?.tag ?? null } });
  }

  async start() {
    this.client.on(Events.InteractionCreate, (i) => this.onInteraction(i));
    this.client.on(Events.Error, (err) => this.logger.error('discord client error', { err }));
    this.client.on(Events.ShardDisconnect, () => this.logger.warn('gateway disconnected'));
    this.client.on(Events.ShardResume, () => this.logger.info('gateway resumed'));
    this.client.once(Events.ClientReady, async (c) => {
      this.logger.info(`${this.theme.name} online`, { user: c.user.tag, guilds: c.guilds.cache.size });
      c.user.setPresence({ activities: [{ name: this.theme.presence, type: 4, state: this.theme.presence }], status: 'online' });
      this.beat();
      this.startLoops();
      await this.onReady?.(c);
    });
    process.on('unhandledRejection', (err) => this.logger.error('unhandled rejection', { err }));
    process.on('uncaughtException', (err) => {
      this.logger.error('uncaught exception — exiting for restart', { err });
      this.shutdown(1);
    });
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, () => this.shutdown(0));
    process.on('message', (m) => m?.type === 'shutdown' && this.shutdown(0));
    this.beat('starting');
    try {
      await this.client.login(this.config[this.name].token);
    } catch (err) {
      this.logger.error('Discord login failed', { err: err.message, code: err.code });
      this.beat('stopped');
      await this.client.destroy().catch(() => null);
      this.db.close();
      await this.logger.close();
      throw err;
    }
  }

  async shutdown(code = 0) {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.logger.info('shutting down…');
    const force = setTimeout(() => process.exit(code || 1), 10000);
    force.unref();
    try {
      for (const t of this.timers) clearInterval(t);
      await this.scheduler?.stop();
      await this.onShutdown?.();
      releaseWorkerLeases(this.db, this.workerId);
      this.beat('stopped');
      await this.client.destroy();
    } catch (err) {
      this.logger.error('error during shutdown', { err });
    } finally {
      this.db.close();
      this.logger.info('shutdown complete');
      await this.logger.close();
      process.exit(code);
    }
  }
}
