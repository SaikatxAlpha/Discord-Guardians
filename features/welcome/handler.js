// Welcome and leave messages (sent by AEGIS). Everything is per server:
// display name, tagline and an optional uploaded background stored under
// DATA_DIR/backgrounds/<guildId>.<ext>.
import fs from 'node:fs';
import path from 'node:path';
import { AttachmentBuilder } from 'discord.js';
import { loadImage } from '@napi-rs/canvas';
import { renderWelcome, fetchAvatar, findBackground } from './renderer.js';
import { getGuildSettings } from '../../core/settings.js';
import { fetchTextChannel } from '../../core/discord/send.js';
import { safeText } from '../../core/discord/theme.js';

const MAX_BACKGROUND_BYTES = 8 * 1024 * 1024;
const BG_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

export function displayNameOf(guild, settings) {
  return settings?.branding?.displayName || guild?.name || 'this server';
}

export function formatTemplate(template, { member, guild, settings = null }) {
  const vars = {
    mention: `<@${member.id}>`,
    name: safeText(member.displayName ?? member.user?.username, 64),
    username: safeText(member.user?.username, 64),
    server: safeText(displayNameOf(guild, settings), 100),
    guild: safeText(guild.name, 100),
    count: String(guild.memberCount ?? ''),
  };
  return String(template).replace(/\{(mention|name|username|server|guild|count)\}/g, (_, k) => vars[k]);
}

function backgroundDir(config) {
  return path.join(config.dataDir, 'backgrounds');
}

/** Background for a server: its upload, else the deployment default, else the built-in design. */
export function backgroundFor(config, settings) {
  const file = settings?.welcome?.background;
  if (file && /^[\w.-]+$/.test(file)) {
    const p = path.join(backgroundDir(config), file);
    if (fs.existsSync(p)) return p;
  }
  return findBackground(config?.welcome?.background);
}

/** Validate and store an uploaded background (image type, size, decodable). */
export async function saveGuildBackground(config, guildId, attachment, { fetchImpl = fetch } = {}) {
  const ext = BG_TYPES[(attachment.contentType ?? '').split(';')[0]];
  if (!ext) throw new Error('Use a PNG, JPG or WebP image.');
  if (attachment.size > MAX_BACKGROUND_BYTES) throw new Error('The image must be 8 MB or smaller.');
  if (!/^https:\/\/(cdn|media)\.discordapp\.(com|net)\//.test(attachment.url)) throw new Error('Unexpected attachment source.');
  const res = await fetchImpl(attachment.url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Could not download the image (HTTP ${res.status}).`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BACKGROUND_BYTES) throw new Error('The image must be 8 MB or smaller.');
  const img = await loadImage(buf).catch(() => null);
  if (!img || img.width < 400 || img.height < 160) throw new Error('That image could not be read or is too small (min 400×160).');
  fs.mkdirSync(backgroundDir(config), { recursive: true });
  removeGuildBackground(config, guildId);
  const name = `${guildId}.${ext}`;
  fs.writeFileSync(path.join(backgroundDir(config), name), buf);
  return name;
}

export function removeGuildBackground(config, guildId) {
  for (const ext of Object.values(BG_TYPES)) fs.rmSync(path.join(backgroundDir(config), `${guildId}.${ext}`), { force: true });
}

export async function buildWelcomeCard(member, { config, settings = null, format = 'png', logger, fetchImpl } = {}) {
  const s = settings ?? null;
  const url = member.displayAvatarURL?.({ extension: 'png', size: 256, forceStatic: true }) ?? member.user?.displayAvatarURL?.({ extension: 'png', size: 256 });
  const avatar = await fetchAvatar(url, { fetchImpl });
  if (!avatar) logger?.warn('avatar download failed; using placeholder', { guildId: member.guild?.id });
  return renderWelcome(
    {
      background: backgroundFor(config, s),
      avatar,
      displayName: member.displayName ?? member.user?.username,
      tagline: s?.welcome?.tagline,
      serverName: displayNameOf(member.guild, s),
    },
    format,
    logger,
  );
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
  const content = formatTemplate(settings.welcome.message, { member, guild: member.guild, settings });
  try {
    const card = await buildWelcomeCard(member, { config, settings, format: settings.welcome.format, logger });
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
  await channel.send({ content: formatTemplate(settings.welcome.leaveMessage, { member, guild: member.guild, settings }), allowedMentions: { parse: [] } }).catch((err) => logger.warn('leave message failed', { err: err.message }));
}
