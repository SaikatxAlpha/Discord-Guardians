// AEGIS music actions (shared by slash commands, typed ALPHA and voice).
import crypto from 'node:crypto';
import { ActionRowBuilder, StringSelectMenuBuilder } from 'discord.js';
import { searchTracks, resolveLink, describeTrack, musicErrorMessage, MusicError } from '../../features/music/providers.js';
import { guardianEmbed, safeText } from '../../core/discord/theme.js';
import { AUTH } from '../../core/auth.js';
import { formatDuration } from '../../core/time.js';

const pendingPicks = new Map(); // token -> { results, userId, guildId, voiceChannelId, textChannelId, expires }

export function takePick(token, userId) {
  const p = pendingPicks.get(token);
  if (!p || p.expires < Date.now()) {
    pendingPicks.delete(token);
    return { error: 'This choice has expired. Please search again.' };
  }
  if (p.userId !== userId) return { error: 'Only the person who searched can choose.' };
  pendingPicks.delete(token);
  return p;
}

function prunePicks() {
  const now = Date.now();
  for (const [k, v] of pendingPicks) if (v.expires < now) pendingPicks.delete(k);
}

async function voiceChannelOf(ctx) {
  const member = await ctx.guild.members.fetch(ctx.request.userId).catch(() => null);
  return member?.voice?.channelId ?? ctx.listener?.sessions.get(ctx.guild.id)?.channelId ?? null;
}

const stamp = (track, userId) => ({ ...track, requestedBy: userId, score: undefined, plays: undefined });

export async function enqueueTrack(ctx, track, voiceChannelId, textChannelId) {
  const gm = ctx.music.get(ctx.guild);
  const r = await gm.enqueue(stamp(track, ctx.request?.userId), { voiceChannelId, textChannelId });
  const where = track.page ? ` · <${track.page}>` : '';
  return {
    ok: true,
    verified: Boolean(r.started) || r.position > 0,
    message: r.started ? `Now playing **${safeText(describeTrack(track), 200)}**${where}` : `Queued at #${r.position}: **${safeText(describeTrack(track), 200)}**${where}`,
  };
}

/** DJ role: if configured, only the DJ role, admins, or whoever requested the current track may skip/stop. */
function djAllowed(ctx, gm) {
  const dj = ctx.settings.music.djRoleId;
  if (!dj) return true;
  if ((ctx.request.level ?? AUTH.MEMBER) >= AUTH.ADMIN) return true;
  if (gm?.queue.current?.requestedBy === ctx.request.userId) return true;
  const member = ctx.guild.members.cache.get(ctx.request.userId);
  return Boolean(member?.roles?.cache?.has(dj));
}

export function queueEmbed(gm) {
  const cur = gm?.queue.current;
  const lines = (gm?.queue.tracks ?? []).slice(0, 15).map((t, i) => `**${i + 1}.** ${safeText(describeTrack(t), 120)}`);
  const more = (gm?.queue.length ?? 0) > 15 ? `\n…and ${gm.queue.length - 15} more` : '';
  return guardianEmbed('aegis', {
    title: 'Music queue',
    description: `${cur ? `▶️ **${safeText(describeTrack(cur), 150)}**${gm.status === 'paused' ? ' (paused)' : ''}\n\n` : 'Nothing playing.\n\n'}${lines.join('\n') || '_Queue is empty._'}${more}`,
    footer: `AEGIS • ${gm?.queue.length ?? 0} queued • volume ${gm?.volume ?? '—'}% • loop ${gm?.loop ?? 'off'} • licensed sources: Audius, Jamendo, Internet Archive`,
  }).toJSON();
}

export const musicHandlers = {
  async 'music.play'(ctx, p) {
    prunePicks();
    const vc = await voiceChannelOf(ctx);
    if (!vc) return { ok: false, message: 'Join a voice channel first.' };
    const textChannelId = ctx.request.channelId ?? ctx.settings.channels.music;
    const query = p.query.trim();
    try {
      if (/^https?:\/\//i.test(query)) {
        const isAdmin = (ctx.request.level ?? AUTH.MEMBER) >= AUTH.ADMIN;
        const r = await resolveLink(query, { config: ctx.config, logger: ctx.logger, allowDirect: isAdmin });
        if (r.tracks.length === 1) {
          const res = await enqueueTrack(ctx, r.tracks[0], vc, textChannelId);
          return r.note ? { ...res, message: `${res.message}\nℹ️ ${r.note}` } : res;
        }
        const gm = ctx.music.get(ctx.guild);
        const out = await gm.enqueueMany(r.tracks.map((t) => stamp(t, ctx.request.userId)), { voiceChannelId: vc, textChannelId });
        return {
          ok: out.added > 0,
          verified: out.added > 0,
          message: `Added ${out.added} track(s) from **${safeText(r.playlist ?? 'playlist', 100)}**${out.skipped ? ` (${out.skipped} skipped: queue limit)` : ''}.${out.started ? ` Now playing **${safeText(describeTrack(out.started), 150)}**.` : ''}`,
        };
      }
      if (query.replace(/[^\p{L}\p{N}]/gu, '').length < 2) return { ok: false, message: 'Tell me what to play, e.g. "play lofi beats".' };
      const { results, weak, ambiguous, failed } = await searchTracks(query, { config: ctx.config, logger: ctx.logger });
      if (!results.length) {
        const down = failed.length ? ` (${failed.map((f) => f.provider).join(', ')} unavailable right now)` : '';
        const hint = weak.length ? ` Closest: ${weak.slice(0, 2).map((t) => `"${safeText(t.title, 60)}"`).join(', ')}.` : '';
        return {
          ok: false,
          message: `"${safeText(query, 80)}" is not available from a licensed source${down}.${hint} Mainstream label releases usually are not licensed for bots; try another title, an Audius/Jamendo link, or a playlist.`,
        };
      }
      if (ambiguous || (p.pick && results.length > 1)) {
        const token = crypto.randomBytes(6).toString('hex');
        pendingPicks.set(token, { results, userId: ctx.request.userId, guildId: ctx.guild.id, voiceChannelId: vc, textChannelId, expires: Date.now() + 120000 });
        const menu = new StringSelectMenuBuilder()
          .setCustomId(`music:pick:${token}`)
          .setPlaceholder('Choose the track')
          .addOptions(results.map((t, i) => ({ label: `${t.title}`.slice(0, 100), description: describeTrack(t).slice(0, 100), value: String(i) })));
        return { ok: true, message: `Several matches for "${safeText(query, 80)}" — choose one below.`, components: [new ActionRowBuilder().addComponents(menu).toJSON()] };
      }
      return await enqueueTrack(ctx, results[0], vc, textChannelId);
    } catch (err) {
      if (!(err instanceof MusicError)) ctx.logger?.warn('music.play failed', { err: err.message });
      return { ok: false, message: err instanceof MusicError ? musicErrorMessage(err) : err.message };
    }
  },
  async 'music.skip'(ctx) {
    const gm = ctx.music.peek(ctx.guild.id);
    if (!djAllowed(ctx, gm)) return { ok: false, message: 'Only the DJ role, admins or the person who requested this track can skip it.' };
    return gm?.skip() ? { ok: true, message: 'Skipped.' } : { ok: false, message: 'Nothing is playing.' };
  },
  async 'music.pause'(ctx) {
    return ctx.music.peek(ctx.guild.id)?.pause() ? { ok: true, message: 'Paused.' } : { ok: false, message: 'Nothing is playing.' };
  },
  async 'music.resume'(ctx) {
    return ctx.music.peek(ctx.guild.id)?.resume() ? { ok: true, message: 'Resumed.' } : { ok: false, message: 'Nothing is paused.' };
  },
  async 'music.stop'(ctx) {
    const gm = ctx.music.peek(ctx.guild.id);
    if (!gm) return { ok: false, message: 'No music session.' };
    if (!djAllowed(ctx, gm)) return { ok: false, message: 'Only the DJ role or admins can stop the music.' };
    await gm.stop();
    return { ok: true, message: 'Stopped and cleared the queue.' };
  },
  async 'music.queue'(ctx) {
    return { ok: true, message: 'Queue', embed: queueEmbed(ctx.music.peek(ctx.guild.id) ?? ctx.music.get(ctx.guild)) };
  },
  async 'music.nowplaying'(ctx) {
    const gm = ctx.music.peek(ctx.guild.id);
    const cur = gm?.queue.current;
    if (!cur) return { ok: false, message: 'Nothing is playing.' };
    const progress = cur.durationMs ? `${formatDuration(gm.position)} / ${formatDuration(cur.durationMs)}` : formatDuration(gm.position);
    return { ok: true, message: `Now playing: **${safeText(describeTrack(cur), 200)}** (${progress})\nLicence: ${safeText(cur.license ?? 'n/a', 120)}${cur.page ? ` · <${cur.page}>` : ''}` };
  },
  async 'music.volume'(ctx, p) {
    const gm = ctx.music.peek(ctx.guild.id) ?? ctx.music.get(ctx.guild);
    const target = p.percent ?? Math.max(0, Math.min(150, gm.volume + (p.change ?? 0)));
    const v = gm.setVolume(target);
    return { ok: true, message: `Volume set to ${v}%.` };
  },
  async 'music.shuffle'(ctx) {
    const gm = ctx.music.peek(ctx.guild.id);
    if (!gm || gm.queue.length < 2) return { ok: false, message: 'Need at least two queued tracks to shuffle.' };
    if (!djAllowed(ctx, gm)) return { ok: false, message: 'Only the DJ role or admins can shuffle.' };
    const n = await gm.shuffle();
    return { ok: true, message: `Shuffled ${n} tracks.` };
  },
  async 'music.loop'(ctx, p) {
    const gm = ctx.music.peek(ctx.guild.id) ?? ctx.music.get(ctx.guild);
    gm.setLoop(p.mode);
    return { ok: true, message: p.mode === 'off' ? 'Looping off.' : `Looping the ${p.mode}.` };
  },
};
