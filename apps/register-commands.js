// Register slash commands for KNIGHT and AEGIS.
// With DEV_GUILD_ID set, commands are registered to that guild (instant);
// otherwise globally (can take up to an hour to appear).
// Usage: npm run register [-- knight|aegis] [-- --dry-run]
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
  const only = args.filter((a) => ['knight', 'aegis'].includes(a));
  const bots = only.length ? only : ['knight', 'aegis'];
  const cfg = getConfig();
  const payloads = commandPayloads();
  if (dry) {
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
    const route = cfg.devGuildId ? Routes.applicationGuildCommands(cfg[b].clientId, cfg.devGuildId) : Routes.applicationCommands(cfg[b].clientId);
    try {
      const res = await rest.put(route, { body: payloads[b] });
      console.log(`${b.toUpperCase()}: registered ${res.length} commands ${cfg.devGuildId ? `in guild ${cfg.devGuildId}` : 'globally'}.`);
    } catch (err) {
      console.error(`${b.toUpperCase()}: registration failed — ${err.message}${err.code === 50001 ? ' (is the bot in DEV_GUILD_ID with applications.commands scope?)' : ''}`);
      process.exitCode = 1;
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
