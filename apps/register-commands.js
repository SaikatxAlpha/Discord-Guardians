// Register slash commands for KNIGHT and AEGIS.
//   COMMAND_SCOPE=global (default in production, or when DEV_GUILD_ID is unset):
//     commands work in every server the bots are invited to (Discord may take
//     a few minutes to show changes).
//   COMMAND_SCOPE=guild (development default when DEV_GUILD_ID is set):
//     commands appear instantly, but only in DEV_GUILD_ID.
// Usage: npm run register [-- knight|aegis] [-- --dry-run] [-- --clear-guild]
//   --clear-guild removes guild-scoped copies from DEV_GUILD_ID (do this after
//   switching to global so commands are not listed twice there).
import { pathToFileURL } from 'node:url';
import { REST, Routes } from 'discord.js';
import { loadEnv, getConfig, validateConfig } from '../config/env.js';
import { knightCommands } from './knight/commands.js';
import { aegisCommands } from './aegis/commands.js';

export function commandPayloads() {
  return {
    knight: knightCommands(null, null).map((c) => c.data.toJSON()),
    aegis: aegisCommands({ listener: null, music: null }).map((c) => c.data.toJSON()),
  };
}

async function main() {
  loadEnv();
  const args = process.argv.slice(2);
  const dry = args.includes('--dry-run');
  const clearGuild = args.includes('--clear-guild');
  const only = args.filter((a) => ['knight', 'aegis'].includes(a));
  const bots = only.length ? only : ['knight', 'aegis'];
  const cfg = getConfig();
  const payloads = commandPayloads();
  if (dry) {
    console.log(`Scope: ${cfg.commandScope}${cfg.commandScope === 'guild' ? ` (DEV_GUILD_ID ${cfg.devGuildId})` : ''}`);
    for (const b of bots) console.log(`${b.toUpperCase()}: ${payloads[b].length} commands — ${payloads[b].map((c) => `/${c.name}`).join(' ')}`);
    return;
  }
  const { errors } = validateConfig(cfg, { bots });
  if (errors.length) {
    for (const e of errors) console.error(`config error: ${e}`);
    process.exit(1);
  }
  for (const b of bots) {
    const rest = new REST({ version: '10' }).setToken(cfg[b].token);
    try {
      if (clearGuild) {
        if (!cfg.devGuildId) throw new Error('--clear-guild needs DEV_GUILD_ID');
        await rest.put(Routes.applicationGuildCommands(cfg[b].clientId, cfg.devGuildId), { body: [] });
        console.log(`${b.toUpperCase()}: cleared guild-scoped commands in DEV_GUILD_ID.`);
        continue;
      }
      const guildScoped = cfg.commandScope === 'guild';
      const route = guildScoped ? Routes.applicationGuildCommands(cfg[b].clientId, cfg.devGuildId) : Routes.applicationCommands(cfg[b].clientId);
      const res = await rest.put(route, { body: payloads[b] });
      console.log(`${b.toUpperCase()}: registered ${res.length} commands ${guildScoped ? 'in DEV_GUILD_ID only (development)' : 'globally (all servers)'}.`);
    } catch (err) {
      console.error(`${b.toUpperCase()}: registration failed — ${err.message}${err.code === 50001 ? ' (is the bot in DEV_GUILD_ID with the applications.commands scope?)' : ''}`);
      process.exitCode = 1;
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
