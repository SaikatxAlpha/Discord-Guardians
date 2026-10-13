// Live Discord credential check: verifies each token with the Discord API,
// reports privileged-intent status, guild membership and invite links.
import { REST, Routes, PermissionsBitField, OAuth2Scopes } from 'discord.js';
import { loadEnv, getConfig } from '../config/env.js';

loadEnv();
const cfg = getConfig();

const PERMS = {
  knight: ['ViewChannel', 'SendMessages', 'EmbedLinks', 'ReadMessageHistory', 'ManageMessages', 'ModerateMembers', 'KickMembers', 'BanMembers', 'ManageRoles', 'ManageChannels', 'Connect', 'ViewAuditLog'],
  aegis: ['ViewChannel', 'SendMessages', 'EmbedLinks', 'AttachFiles', 'ReadMessageHistory', 'ManageChannels', 'ManageRoles', 'ManageEvents', 'MentionEveryone', 'Connect', 'Speak', 'UseApplicationCommands'],
};
const FLAGS = { members: [1 << 14, 1 << 15], content: [1 << 18, 1 << 19] };
const has = (flags, [a, b]) => (flags & a) !== 0 || (flags & b) !== 0;

let failed = false;
for (const bot of ['knight', 'aegis']) {
  const b = cfg[bot];
  const NAME = bot.toUpperCase();
  if (!b.token) {
    console.log(`${NAME}: no token configured — skipped.`);
    failed = true;
    continue;
  }
  const rest = new REST({ version: '10' }).setToken(b.token);
  try {
    const me = await rest.get(Routes.user());
    const appInfo = await rest.get(Routes.currentApplication());
    const guilds = await rest.get(Routes.userGuilds());
    console.log(`\n${NAME}: token valid → ${me.username} (id ${me.id})`);
    console.log(`  Server Members intent: ${has(appInfo.flags ?? 0, FLAGS.members) ? 'ENABLED' : 'DISABLED — enable it in the Developer Portal (Bot tab)'}`);
    console.log(`  Message Content intent: ${has(appInfo.flags ?? 0, FLAGS.content) ? 'ENABLED' : 'DISABLED — enable it in the Developer Portal (Bot tab)'}`);
    console.log(`  In ${guilds.length} server(s): ${guilds.map((g) => g.name).join(', ') || '—'}`);
    if (cfg.devGuildId && !guilds.some((g) => g.id === cfg.devGuildId)) console.log(`  ⚠ not a member of DEV_GUILD_ID ${cfg.devGuildId}`);
    const perms = new PermissionsBitField(PERMS[bot]).bitfield;
    console.log(`  Invite: https://discord.com/oauth2/authorize?client_id=${me.id}&scope=${[OAuth2Scopes.Bot, OAuth2Scopes.ApplicationsCommands].join('%20')}&permissions=${perms}`);
  } catch (err) {
    failed = true;
    console.log(`\n${NAME}: FAILED — ${err.status === 401 ? 'token rejected by Discord (reset it in the Developer Portal)' : err.message}`);
  }
}
process.exit(failed ? 1 : 0);
