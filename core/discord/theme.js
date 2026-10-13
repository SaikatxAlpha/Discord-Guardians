// Themed embeds so KNIGHT (violet) and AEGIS (cyan) are visually distinct.
import { EmbedBuilder } from 'discord.js';
import { THEME, SERVER_NAME, PROJECT_NAME } from '../../config/defaults.js';

export function guardianEmbed(bot, { title, description, fields, color, footer, thumbnail, image, timestamp = true } = {}) {
  const t = THEME[bot] ?? THEME.aegis;
  const e = new EmbedBuilder().setColor(color ?? t.color).setFooter({ text: footer ?? `${t.name} • ${t.title}` });
  if (title) e.setTitle(`${t.emoji} ${title}`.slice(0, 256));
  if (description) e.setDescription(String(description).slice(0, 4096));
  if (fields?.length) e.addFields(fields.slice(0, 25).map((f) => ({ name: String(f.name).slice(0, 256), value: String(f.value || '—').slice(0, 1024), inline: Boolean(f.inline) })));
  if (thumbnail) e.setThumbnail(thumbnail);
  if (image) e.setImage(image);
  if (timestamp) e.setTimestamp(new Date());
  return e;
}

export const STATUS_COLORS = { ok: 0x22c55e, warn: 0xf59e0b, error: 0xef4444, pending: 0xa855f7 };

export { PROJECT_NAME, SERVER_NAME };

/** Neutralise mentions and markdown in user-provided text echoed back to Discord. */
export function safeText(s, max = 1000) {
  return String(s ?? '')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, '')
    .replace(/@(everyone|here)/gi, '@\u200B$1')
    .replace(/<@[!&]?(\d+)>/g, '<@\u200B$1>')
    .replace(/([*_`~|>\\])/g, '\\$1')
    .slice(0, max);
}
