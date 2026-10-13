// Welcome and leave messages (sent by AEGIS).
import { AttachmentBuilder } from 'discord.js';
import { renderWelcome, fetchAvatar, findBackground } from './renderer.js';
import { getGuildSettings } from '../../core/settings.js';
import { fetchTextChannel } from '../../core/discord/send.js';
import { safeText } from '../../core/discord/theme.js';
import { SERVER_NAME } from '../../config/defaults.js';

export function formatTemplate(template, { member, guild }) {
  const vars = {
    mention: `<@${member.id}>`,
    name: safeText(member.displayName ?? member.user?.username, 64),
    username: safeText(member.user?.username, 64),
    server: SERVER_NAME,
    guild: safeText(guild.name, 100),
    count: String(guild.memberCount ?? ''),
  };
  return String(template).replace(/\{(mention|name|username|server|guild|count)\}/g, (_, k) => vars[k]);
}

export async function buildWelcomeCard(member, { config, format = 'png', logger, fetchImpl } = {}) {
  const url = member.displayAvatarURL?.({ extension: 'png', size: 256, forceStatic: true }) ?? member.user?.displayAvatarURL?.({ extension: 'png', size: 256 });
  const avatar = await fetchAvatar(url, { fetchImpl });
  if (!avatar) logger?.warn('avatar download failed; using placeholder', { userId: member.id });
  return renderWelcome({ background: findBackground(config?.welcome?.background), avatar, displayName: member.displayName ?? member.user?.username }, format, logger);
}

export async function onMemberJoin(member, { db, config, logger }) {
  db.run('INSERT INTO member_events (guild_id, user_id, type, ts) VALUES (?, ?, ?, ?)', member.guild.id, member.id, 'join', Date.now());
  const settings = getGuildSettings(db, member.guild.id);
  if (!settings.welcome.enabled) return { sent: false, reason: 'disabled' };
  const channel = await fetchTextChannel(member.guild, settings.channels.welcome);
  if (!channel) {
    if (settings.channels.welcome) logger.warn('welcome channel invalid or inaccessible', { guildId: member.guild.id });
    return { sent: false, reason: 'no_channel' };
  }
  const content = formatTemplate(settings.welcome.message, { member, guild: member.guild });
  try {
    const card = await buildWelcomeCard(member, { config, format: settings.welcome.format, logger });
    const file = new AttachmentBuilder(card.buffer, { name: `welcome-${member.id}.${card.format}` });
    await channel.send({ content, files: [file], allowedMentions: { users: [member.id] } });
    return { sent: true, format: card.format, usedOriginal: card.usedOriginal };
  } catch (err) {
    logger.error('welcome card failed; sending text only', { err });
    await channel.send({ content, allowedMentions: { users: [member.id] } }).catch(() => null);
    return { sent: true, format: 'text' };
  }
}

export async function onMemberLeave(member, { db, logger }) {
  db.run('INSERT INTO member_events (guild_id, user_id, type, ts) VALUES (?, ?, ?, ?)', member.guild.id, member.id, 'leave', Date.now());
  const settings = getGuildSettings(db, member.guild.id);
  if (!settings.welcome.leaveEnabled) return;
  const channel = await fetchTextChannel(member.guild, settings.channels.leave ?? settings.channels.welcome);
  if (!channel) return;
  await channel.send({ content: formatTemplate(settings.welcome.leaveMessage, { member, guild: member.guild }), allowedMentions: { parse: [] } }).catch((err) => logger.warn('leave message failed', { err: err.message }));
}
