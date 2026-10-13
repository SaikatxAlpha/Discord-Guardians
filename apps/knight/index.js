// KNIGHT — The Guardian. Protection, enforcement and server security.
import { GatewayIntentBits, Events, Partials } from 'discord.js';
import { pathToFileURL } from 'node:url';
import { GuardianBot } from '../shared/botBase.js';
import { AutoModerator } from '../../features/moderation/automod.js';
import { knightHandlers } from '../../features/moderation/handlers.js';
import { enforce } from '../../features/moderation/enforce.js';
import { VoiceModerator } from '../../features/voice/voiceModeration.js';
import { knightCommands } from './commands.js';

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
  app.onShutdown = async () => {
    automod.stop();
    voiceMod.stopAll();
  };
  return app;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  createKnight()
    .start()
    .catch((err) => {
      console.error(`KNIGHT failed to start: ${err.message}`);
      process.exit(1);
    });
}
