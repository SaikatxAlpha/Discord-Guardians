// KNIGHT — The Guardian. Protection, enforcement and server security.
import { GatewayIntentBits, Events, Partials } from 'discord.js';
import { pathToFileURL } from 'node:url';
import { GuardianBot } from '../shared/botBase.js';
import { AutoModerator } from '../../features/moderation/automod.js';
import { knightHandlers } from '../../features/moderation/handlers.js';
import { enforce } from '../../features/moderation/enforce.js';
import { VoiceModerator } from '../../features/voice/voiceModeration.js';
import { knightCommands } from './commands.js';
import { guardianEmbed } from '../../core/discord/theme.js';

export const KNIGHT_INTENTS = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMembers,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent,
  GatewayIntentBits.GuildModeration,
  GatewayIntentBits.GuildVoiceStates,
];

export function createKnight() {
  const app = new GuardianBot({ name: 'knight', intents: KNIGHT_INTENTS, partials: [Partials.GuildMember] });
  const automod = new AutoModerator({ db: app.db, config: app.config, logger: app.logger });
  const voiceMod = new VoiceModerator({
    db: app.db,
    stt: app.stt,
    logger: app.logger,
    config: app.config,
    enforce: (o) => enforce({ db: app.db, config: app.config, logger: app.logger, ...o }),
  });
  app.addHandlers(knightHandlers);
  app.addCommands(knightCommands(automod, voiceMod));

  app.client.on(Events.MessageCreate, (m) => automod.onMessage(m).catch((err) => app.logger.error('automod failed', { err })));
  app.client.on(Events.GuildMemberAdd, (m) => automod.onMemberJoin(m).catch((err) => app.logger.error('raid check failed', { err })));
  app.introMessage = () =>
    guardianEmbed('knight', {
      title: 'KNIGHT has arrived',
      description: [
        'I protect this server: automod (profanity, spam, raids), moderation commands, case history and security logs.',
        '',
        '**Safe by default:** automod starts in **simulation mode** — it only logs what it would do. Voice moderation is **off**.',
        '**Next steps (admins):**',
        '1. `/modconfig logs` — choose private security and case-log channels.',
        '2. Watch `/simulate` and the logs, then `/modconfig simulate enabled:false` when ready.',
        '3. Move my role above the roles I should moderate.',
        '',
        'Commands: `/warn` `/timeout` `/kick` `/ban` `/cases` `/modreport` `/knight-status`',
      ].join('\n'),
    });
  app.onShutdown = async () => {
    automod.stop();
    voiceMod.stopAll();
  };
  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createKnight()
    .start()
    .catch((err) => {
      console.error(`KNIGHT failed to start: ${err.message}`);
      process.exit(1);
    });
}
