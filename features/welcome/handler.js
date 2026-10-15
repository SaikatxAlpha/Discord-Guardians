// Welcome and leave messages (sent by AEGIS). Everything is per server.
//
// A welcome post is a normal Discord message: the configured text in the
// message content, with the server's own image (PNG/JPG/WebP/GIF) attached
// below it exactly as uploaded — same bytes, size and animation. Nothing is
// drawn onto the image. Uploaded images live in DATA_DIR/backgrounds/<guildId>.<ext>.
import fs from 'node:fs';
import path from 'node:path';
import { AttachmentBuilder } from 'discord.js';
import { loadImage } from '@napi-rs/canvas';
import { findBackground } from './renderer.js';
import { getGuildSettings } from '../../core/settings.js';
import { fetchTextChannel } from '../../core/discord/send.js';
import { safeText } from '../../core/discord/theme.js';

const MAX_BACKGROUND_BYTES = 8 * 1024 * 1024;
const IMAGE_EXTS = ['png', 'jpg', 'webp', 'gif'];
const MAX_CONTENT = 2000; // Discord message limit

export function displayNameOf(guild, settings) {
  return settings?.branding?.displayName || guild?.name || 'this server';
}

// Slash-command options cannot contain real line breaks, so templates use a
// literal "\n" (or "<br>") for them.
const lineBreaks = (t) => String(t ?? '').replace(/\\n|<br\s*\/?>/gi, '\n');
const PLACEHOLDER = /\{(mention|name|username|server|guild|count)\}/g;

/** Fill a welcome/leave template: {mention} pings, user-controlled values are markdown-escaped. */
export function formatTemplate(template, { member, guild, settings = null }) {
  const vars = {
    mention: `<@${member.id}>`,
    name: safeText(member.displayName ?? member.user?.username ?? '', 64),
    username: safeText(member.user?.username ?? '', 64),
    server: safeText(displayNameOf(guild, settings), 100),
    guild: safeText(guild.name ?? '', 100),
    count: String(guild.memberCount ?? ''),
  };
  return lineBreaks(template).replace(PLACEHOLDER, (_, k) => vars[k]);
}

/** Identify an image by its bytes (never trust the declared content type). */
export function imageTypeOf(buf) {
  if (!buf || buf.length < 12) return null;
  const ascii = (o, n) => buf.subarray(o, o + n).toString('latin1');
  if (buf.readUInt32BE(0) === 0x89504e47) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') return 'gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'webp';
  return null;
}

function backgroundDir(config) {
  return path.join(config.dataDir, 'backgrounds');
}

/** The server's welcome image: its upload, else the deployment default (WELCOME_BACKGROUND / assets/welcome), else none. */
export function backgroundFor(config, settings) {
  const file = settings?.welcome?.background;
  if (file && /^[\w.-]+$/.test(file)) {
    const p = path.join(backgroundDir(config), file);
    if (fs.existsSync(p)) return p;
  }
  return findBackground(config?.welcome?.background);
}

/** Validate and store an uploaded welcome image byte-for-byte (type from its bytes, size, decodable). */
export async function saveGuildBackground(config, guildId, attachment, { fetchImpl = fetch } = {}) {
  if (attachment.contentType && !/^image\//i.test(attachment.contentType)) throw new Error('Use a PNG, JPG, WebP or GIF image.');
  if (attachment.size > MAX_BACKGROUND_BYTES) throw new Error('The image must be 8 MB or smaller.');
  if (!/^https:\/\/(cdn|media)\.discordapp\.(com|net)\//.test(attachment.url)) throw new Error('Unexpected attachment source.');
  const res = await fetchImpl(attachment.url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Could not download the image (HTTP ${res.status}).`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BACKGROUND_BYTES) throw new Error('The image must be 8 MB or smaller.');
  const ext = imageTypeOf(buf);
  if (!ext) throw new Error('Use a PNG, JPG, WebP or GIF image.');
  const img = await loadImage(buf).catch(() => null);
  if (!img || img.width < 16 || img.height < 16) throw new Error('That image could not be read.');
  fs.mkdirSync(backgroundDir(config), { recursive: true });
  removeGuildBackground(config, guildId);
  const name = `${guildId}.${ext}`;
  fs.writeFileSync(path.join(backgroundDir(config), name), buf); // unchanged bytes: animation and size are kept
  return name;
}

export function removeGuildBackground(config, guildId) {
  for (const ext of IMAGE_EXTS) fs.rmSync(path.join(backgroundDir(config), `${guildId}.${ext}`), { force: true });
}

function clampContent(text) {
  if (text.length <= MAX_CONTENT) return text;
  const g = [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(text)].map((x) => x.segment);
  let out = '';
  for (const s of g) {
    if (out.length + s.length > MAX_CONTENT - 1) break;
    out += s;
  }
  return `${out}…`;
}

/**
 * Build the welcome post for a member from the server's saved settings.
 * Real joins AND /welcome-test both use this, so they always look the same:
 * the configured text as the message content, the server's image attached
 * unchanged below it. Only the joining member can be pinged.
 */
export function composeWelcome(member, { config, settings }) {
  const image = backgroundFor(config, settings);
  const files = image ? [new AttachmentBuilder(fs.readFileSync(image), { name: `welcome${path.extname(image).toLowerCase()}` })] : [];
  return { ...welcomeText(member, settings), files, image };
}

function welcomeText(member, settings) {
  const content = clampContent(formatTemplate(settings.welcome.message ?? '', { member, guild: member.guild, settings }).trim());
  return { content, allowedMentions: { parse: [], users: [member.id] } };
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
  let welcome;
  try {
    welcome = composeWelcome(member, { config, settings });
  } catch (err) {
    // An unreadable image file must not cost the member their welcome.
    logger.warn('welcome image unavailable; sending text only', { guildId: member.guild.id, err: err.message });
    welcome = { ...welcomeText(member, settings), files: [], image: null };
  }
  const send = (payload) => channel.send({ content: payload.content || null, files: payload.files, allowedMentions: payload.allowedMentions });
  try {
    await send(welcome);
    return { sent: true, withImage: welcome.files.length > 0 };
  } catch (err) {
    if (!welcome.files.length || !welcome.content) {
      logger.error('welcome message failed', { guildId: member.guild.id, err: err.message });
      return { sent: false, reason: 'send_failed' };
    }
    // e.g. missing "Attach Files" permission: still greet with the text.
    logger.warn('welcome image could not be sent; sending text only', { guildId: member.guild.id, err: err.message });
    await send({ ...welcome, files: [] }).catch((e) => logger.error('welcome message failed', { guildId: member.guild.id, err: e.message }));
    return { sent: true, withImage: false };
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
