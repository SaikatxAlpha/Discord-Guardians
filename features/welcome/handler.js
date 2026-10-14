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
import { escapeRich, parseMessage } from './richText.js';

const MAX_BACKGROUND_BYTES = 8 * 1024 * 1024;
const BG_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

export function displayNameOf(guild, settings) {
  return settings?.branding?.displayName || guild?.name || 'this server';
}

// Slash-command options cannot contain real line breaks, so templates use a
// literal "\n" (or "<br>") for them.
const lineBreaks = (t) => String(t ?? '').replace(/\\n|<br\s*\/?>/gi, '\n');
const PLACEHOLDER = /\{(mention|name|username|server|guild|count)\}/g;

/**
 * Fill a welcome/leave template.
 * - mode 'text' (default): a Discord message; {mention} pings, values are markdown-escaped.
 * - mode 'image': text drawn on the card; mentions become readable "@name" / "#channel".
 */
export function formatTemplate(template, { member, guild, settings = null, mode = 'text' }) {
  const raw = {
    name: member.displayName ?? member.user?.username ?? '',
    username: member.user?.username ?? '',
    server: displayNameOf(guild, settings),
    guild: guild.name ?? '',
    count: String(guild.memberCount ?? ''),
  };
  if (mode === 'image') {
    const vars = { ...Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, escapeRich(v)])), mention: `@${escapeRich(raw.name)}` };
    return lineBreaks(template)
      .replace(PLACEHOLDER, (_, k) => vars[k])
      .replace(/<@!?(\d{17,20})>/g, (_, id) => `@${escapeRich(guild.members?.cache?.get(id)?.displayName ?? 'member')}`)
      .replace(/<@&(\d{17,20})>/g, (_, id) => `@${escapeRich(guild.roles?.cache?.get(id)?.name ?? 'role')}`)
      .replace(/<#(\d{17,20})>/g, (_, id) => `#${escapeRich(guild.channels?.cache?.get(id)?.name ?? 'channel')}`);
  }
  const vars = {
    mention: `<@${member.id}>`,
    name: safeText(raw.name, 64),
    username: safeText(raw.username, 64),
    server: safeText(raw.server, 100),
    guild: safeText(raw.guild, 100),
    count: raw.count,
  };
  return lineBreaks(template).replace(PLACEHOLDER, (_, k) => vars[k]);
}

/** Download the custom emoji used in the message (bounded) so the card can draw them. */
export async function fetchMessageEmoji(text, { fetchImpl, max = 8 } = {}) {
  const wanted = new Map();
  for (const line of parseMessage(text)) for (const r of line.runs) if (r.emoji && wanted.size < max) wanted.set(r.emoji.id, r.emoji);
  const out = new Map();
  await Promise.all(
    [...wanted.keys()].map(async (id) => {
      const buf = await fetchAvatar(`https://cdn.discordapp.com/emojis/${id}.png?size=64`, { fetchImpl, timeoutMs: 5000, maxBytes: 512 * 1024 });
      if (buf) out.set(id, buf);
    }),
  );
  return out;
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

export async function buildWelcomeCard(member, { config, settings = null, format = 'png', logger, fetchImpl, message = '' } = {}) {
  const s = settings ?? null;
  const emojiImages = message ? await fetchMessageEmoji(message, { fetchImpl }) : new Map();
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
      message,
      emojiImages,
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
  const welcome = await composeWelcome(member, { config, settings, logger });
  try {
    await channel.send({ content: welcome.content, files: welcome.files, allowedMentions: { users: [member.id] } });
    return { sent: true, format: welcome.format, usedOriginal: welcome.card?.usedOriginal ?? false, message: welcome.card?.message ?? null };
  } catch (err) {
    logger.error('welcome message failed', { guildId: member.guild.id, err: err.message });
    return { sent: false, reason: 'send_failed' };
  }
}

/**
 * Build the complete welcome post for a member from the server's saved
 * settings. Real joins AND /welcome-test both use this, so they always match.
 * The configured message is drawn inside the card; the text content only
 * carries the ping (when the template uses {mention}). If the card cannot be
 * rendered, the full message is sent as text instead.
 */
export async function composeWelcome(member, { config, settings, format = settings.welcome.format, logger, fetchImpl } = {}) {
  const template = settings.welcome.message ?? '';
  const textMessage = formatTemplate(template, { member, guild: member.guild, settings });
  try {
    const card = await buildWelcomeCard(member, {
      config,
      settings,
      format,
      logger,
      fetchImpl,
      message: formatTemplate(template, { member, guild: member.guild, settings, mode: 'image' }),
    });
    return {
      content: template.includes('{mention}') ? `<@${member.id}>` : '',
      files: [new AttachmentBuilder(card.buffer, { name: `welcome-${member.id}.${card.format}` })],
      format: card.format,
      card,
      textMessage,
    };
  } catch (err) {
    logger?.error('welcome card failed; using text only', { guildId: member.guild?.id, err: err.message });
    return { content: textMessage, files: [], format: 'text', card: null, textMessage };
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
