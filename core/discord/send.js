// Safe channel messaging: tolerates missing/invalid channel IDs and never
// pings anyone unless explicitly allowed.

export const NO_MENTIONS = { parse: [] };

export async function fetchTextChannel(guild, channelId) {
  if (!channelId) return null;
  const ch = guild.channels.cache.get(channelId) ?? (await guild.channels.fetch(channelId).catch(() => null));
  if (!ch || typeof ch.send !== 'function') return null;
  return ch;
}

/** @returns {Promise<object|null>} sent message or null */
export async function sendToChannel(guild, channelId, payload, logger) {
  const ch = await fetchTextChannel(guild, channelId);
  if (!ch) {
    if (channelId) logger?.warn('configured channel unavailable', { guildId: guild.id, channelId });
    return null;
  }
  try {
    return await ch.send({ allowedMentions: NO_MENTIONS, ...(typeof payload === 'string' ? { content: payload } : payload) });
  } catch (err) {
    logger?.warn('send failed', { guildId: guild.id, channelId, err: err.message, code: err.code });
    return null;
  }
}
