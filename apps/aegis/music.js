// AEGIS music actions (shared by slash commands, typed ALPHA and voice).
import crypto from 'node:crypto';
import { ActionRowBuilder, StringSelectMenuBuilder } from 'discord.js';
import { searchTracks, choosePlayable, resolveLink, describeTrack, musicErrorMessage, MusicError, formatMs } from '../../features/music/providers.js';
import { voicePermissionProblem } from '../../features/music/discordAdapter.js';
import { guardianEmbed, safeText, STATUS_COLORS } from '../../core/discord/theme.js';
import { AUTH } from '../../core/auth.js';
import { formatDuration } from '../../core/time.js';

const pendingPicks = new Map(); // token -> { results, userId, guildId, voiceChannelId, textChannelId, expires }
const PICK_TTL_MS = 120000;

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

/**
 * Where should music play for this request? The requester's current voice
 * channel (or the ALPHA listening channel for voice commands), after checking
 * AEGIS can connect and speak there and is not busy in another channel.
 * @returns {Promise<{channelId:string}|{error:string}>}
 */
export async function targetVoiceChannel(ctx) {
  const member = await ctx.guild.members.fetch(ctx.request.userId).catch(() => null);
  const channelId = member?.voice?.channelId ?? (ctx.request.source === 'voice' ? ctx.listener?.sessions.get(ctx.guild.id)?.channelId : null);
  if (!channelId) return { error: 'Join a voice channel first, then ask again.' };
  const channel = ctx.guild.channels.cache.get(channelId) ?? (await ctx.guild.channels.fetch(channelId).catch(() => null));
  const problem = voicePermissionProblem(channel, ctx.guild.members.me);
  if (problem) return { error: problem };
  const gm = ctx.music.peek(ctx.guild.id);
  if (gm?.connection && gm.voiceChannelId && gm.voiceChannelId !== channelId && gm.queue.current) {
    return { error: `I'm already playing in <#${gm.voiceChannelId}>. Join that channel to add songs, or use /leave first.` };
  }
  return { channelId };
}

const stamp = (track, userId) => ({ ...track, requestedBy: userId, score: undefined, plays: undefined, mirrors: undefined });

function startFailureMessage(errors) {
  const e = errors.at(-1);
  if (!e) return 'Playback did not start.';
  const why = e.error instanceof MusicError ? e.error.message : `the audio stream failed (${safeText(e.error?.message ?? 'unknown error', 160)})`;
  return `Couldn't play **${safeText(describeTrack(e.track), 150)}**: ${why}`;
}

/**
 * Add a track and report honestly: "Now playing" only after audio started,
 * "Queued" when something else is playing, otherwise the real error.
 */
export async function enqueueTrack(ctx, track, voiceChannelId, textChannelId) {
  const gm = ctx.music.get(ctx.guild);
  const r = await gm.enqueue(stamp(track, ctx.request?.userId), { voiceChannelId, textChannelId });
  const where = track.page ? ` · <${track.page}>` : '';
  if (r.started) {
    const fallback = r.started.id !== track.id && r.started.fallbackFor ? ' — another upload of the same song, because the top match could not be streamed' : '';
    const skippedNote = r.errors?.length ? `\n⚠️ ${startFailureMessage(r.errors)}` : '';
    return { ok: true, verified: true, message: `▶️ Now playing **${safeText(describeTrack(r.started), 200)}** (${formatMs(r.started.durationMs)})${r.started.id === track.id ? where : ''}${fallback}${skippedNote}` };
  }
  if (r.errors?.length) return { ok: false, message: startFailureMessage(r.errors) };
  return { ok: true, verified: true, message: `➕ Queued at #${r.position}: **${safeText(describeTrack(track), 200)}** (${formatMs(track.durationMs)})${where}` };
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
  const lines = (gm?.queue.tracks ?? []).slice(0, 15).map((t, i) => `**${i + 1}.** ${safeText(describeTrack(t), 110)} · ${formatMs(t.durationMs)}`);
  const more = (gm?.queue.length ?? 0) > 15 ? `\n…and ${gm.queue.length - 15} more` : '';
  const now = cur ? `▶️ **${safeText(describeTrack(cur), 150)}** · ${formatDuration(gm.position)} / ${formatMs(cur.durationMs)}${gm.status === 'paused' ? ' (paused)' : ''}\n\n` : 'Nothing playing.\n\n';
  return guardianEmbed('aegis', {
    title: 'Music queue',
    description: `${now}${lines.join('\n') || '_No upcoming tracks._'}${more}`,
    footer: `AEGIS • ${gm?.queue.length ?? 0} upcoming • volume ${gm?.volume ?? '—'}% • loop ${gm?.loop ?? 'off'}`,
  }).toJSON();
}

function pickMenu(token, results) {
  return new ActionRowBuilder()
    .addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`music:pick:${token}`)
        .setPlaceholder('Choose a track to play')
        .addOptions(results.map((t, i) => ({ label: `${t.title}`.slice(0, 100), description: `${t.artist ?? 'Unknown'} · ${formatMs(t.durationMs)} · ${describeTrack(t).split(' · ').pop()}`.slice(0, 100), value: String(i) }))),
    )
    .toJSON();
}

/**
 * One concise message when no permitted source can stream the requested
 * recording. Nothing is played; playable alternatives are named with their
 * artist and source so the user can ask for one explicitly.
 */
export function unavailableMessage(query, { alternatives = [], failed = [], identity = null }) {
  const down = failed.length ? ` (${failed.map((f) => f.provider).join(', ')} unreachable right now)` : '';
  const what = identity ? `**${safeText(identity.title, 80)}** by ${safeText(identity.artist ?? 'unknown', 120)}` : `"${safeText(query, 80)}"`;
  const label = (t) => `"${safeText(t.title, 50)}" by ${safeText(t.artist ?? 'unknown', 40)} (${describeTrack(t).split(' · ').pop()})`;
  const ex = alternatives[0];
  const alt = ex ? ` Playable alternatives: ${alternatives.slice(0, 3).map(label).join(', ')} — to play one, include its artist, e.g. \`/play ${safeText(ex.title, 50)} ${safeText(ex.artist ?? '', 40)}\`.` : '';
  return `🚫 ${what} isn't available from any source AEGIS may legally stream${down}, so nothing was played.${alt} Browse with \`/search ${safeText(query, 80)}\`.`;
}

/** Fallback uploads of the same recording, tried automatically if the first stream fails. */
const MAX_FALLBACKS = 2;

export const musicHandlers = {
  async 'music.play'(ctx, p) {
    prunePicks();
    const target = await targetVoiceChannel(ctx);
    if (target.error) return { ok: false, message: target.error };
    const vc = target.channelId;
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
        const startNote = out.started ? ` ▶️ Now playing **${safeText(describeTrack(out.started), 150)}**.` : out.errors.length && !out.playing ? `\n⚠️ ${startFailureMessage(out.errors)}` : '';
        return {
          ok: out.added > 0 && (Boolean(out.playing) || !out.errors.length),
          verified: Boolean(out.playing),
          message: `Added ${out.added} track(s) from **${safeText(r.playlist ?? 'playlist', 100)}**${out.skipped ? ` (${out.skipped} skipped: queue limit)` : ''}.${startNote}`,
        };
      }
      // One-command playback: search with the user's exact query and play the
      // best match that is the requested recording. Never ask again or show a
      // picker (that is what /search is for), never substitute another song.
      const found = await searchTracks(query, { config: ctx.config, logger: ctx.logger, fetchImpl: ctx.fetchImpl, withMetadata: true, limit: 12 });
      const choice = choosePlayable(query, found);
      if (!choice.tracks.length) return { ok: false, message: unavailableMessage(query, { failed: found.failed, identity: choice.identity, alternatives: choice.alternatives }) };
      const [best] = choice.tracks;
      return await enqueueTrack(ctx, { ...best, alternates: best.alternates.slice(0, MAX_FALLBACKS).map((t) => stamp(t, ctx.request.userId)) }, vc, textChannelId);
    } catch (err) {
      if (!(err instanceof MusicError)) ctx.logger?.warn('music.play failed', { guildId: ctx.guild.id, err: err.message });
      return { ok: false, message: err instanceof MusicError ? musicErrorMessage(err) : `Something went wrong: ${safeText(err.message, 200)}` };
    }
  },

  /** /search: playable results (selectable) and metadata-only results (listed, never played). */
  async 'music.search'(ctx, p) {
    prunePicks();
    const found = await searchTracks(p.query, { config: ctx.config, logger: ctx.logger, fetchImpl: ctx.fetchImpl, withMetadata: true, limit: 8 });
    const playable = found.results.length ? found.results : found.weak.filter((t) => t.score >= 30).slice(0, 5);
    const lines = playable.map((t, i) => `✅ **${i + 1}.** ${safeText(t.title, 80)} — ${safeText(t.artist ?? 'Unknown', 50)} · ${formatMs(t.durationMs)} · ${describeTrack(t).split(' · ').pop()}`);
    const metaLines = found.metadata.slice(0, 4).map((t) => `ℹ️ ${safeText(t.title, 80)} — ${safeText(t.artist ?? 'Unknown', 50)} · ${formatMs(t.durationMs)} · ${t.page ? `[metadata only](<${t.page}>)` : 'metadata only'}`);
    const down = found.failed.length ? `\n⚠️ Unavailable right now: ${found.failed.map((f) => f.provider).join(', ')}` : '';
    const embed = guardianEmbed('aegis', {
      title: `Search: ${safeText(p.query, 80)}`,
      color: playable.length ? undefined : STATUS_COLORS.warn,
      fields: [
        { name: 'Playable (licensed streams)', value: lines.join('\n') || 'No playable matches.' },
        ...(metaLines.length ? [{ name: 'Catalogue matches — metadata only, cannot be streamed by bots', value: metaLines.join('\n') }] : []),
      ],
      footer: 'AEGIS • ✅ plays in voice · ℹ️ information only',
    }).toJSON();
    if (down) embed.description = down.trim();
    const components = [];
    if (playable.length) {
      const token = crypto.randomBytes(6).toString('hex');
      pendingPicks.set(token, { results: playable, userId: ctx.request.userId, guildId: ctx.guild.id, voiceChannelId: null, textChannelId: ctx.request.channelId, expires: Date.now() + PICK_TTL_MS });
      components.push(pickMenu(token, playable));
    }
    return { ok: true, message: playable.length ? 'Pick a track to play (you must be in a voice channel).' : 'Nothing playable found.', embed, components };
  },

  async 'music.skip'(ctx) {
    const gm = ctx.music.peek(ctx.guild.id);
    if (!djAllowed(ctx, gm)) return { ok: false, message: 'Only the DJ role, admins or the person who requested this track can skip it.' };
    const cur = gm?.queue.current;
    return gm?.skip() ? { ok: true, message: `⏭️ Skipped **${safeText(cur?.title ?? 'track', 100)}**.` } : { ok: false, message: 'Nothing is playing.' };
  },
  async 'music.pause'(ctx) {
    return ctx.music.peek(ctx.guild.id)?.pause() ? { ok: true, message: '⏸️ Paused.' } : { ok: false, message: 'Nothing is playing.' };
  },
  async 'music.resume'(ctx) {
    return ctx.music.peek(ctx.guild.id)?.resume() ? { ok: true, message: '▶️ Resumed.' } : { ok: false, message: 'Nothing is paused.' };
  },
  async 'music.stop'(ctx) {
    const gm = ctx.music.peek(ctx.guild.id);
    if (!gm?.queue.current && !gm?.queue.length) return { ok: false, message: 'Nothing is playing.' };
    if (!djAllowed(ctx, gm)) return { ok: false, message: 'Only the DJ role or admins can stop the music.' };
    await gm.stop();
    return { ok: true, message: '⏹️ Stopped and cleared the queue. Use /leave to disconnect me.' };
  },
  async 'music.leave'(ctx) {
    const gm = ctx.music.peek(ctx.guild.id);
    if (gm && !djAllowed(ctx, gm)) return { ok: false, message: 'Only the DJ role or admins can make me leave while music is playing.' };
    ctx.listener?.stop(ctx.guild.id, { silent: true });
    const wasConnected = gm ? await gm.leave() : false;
    const hubLeft = ctx.hub?.leave(ctx.guild.id) ?? false;
    return wasConnected || hubLeft ? { ok: true, message: '👋 Left the voice channel and cleared the queue.' } : { ok: false, message: "I'm not in a voice channel." };
  },
  async 'music.clear'(ctx) {
    const gm = ctx.music.peek(ctx.guild.id);
    if (!gm?.queue.length) return { ok: false, message: 'The queue is already empty.' };
    if (!djAllowed(ctx, gm)) return { ok: false, message: 'Only the DJ role or admins can clear the queue.' };
    const n = await gm.clearQueue();
    return { ok: true, message: `🧹 Cleared ${n} upcoming track(s). The current song keeps playing.` };
  },
  async 'music.remove'(ctx, p) {
    const gm = ctx.music.peek(ctx.guild.id);
    if (!gm?.queue.length) return { ok: false, message: 'The queue is empty.' };
    const target = gm.queue.tracks[p.position - 1];
    if (target && target.requestedBy !== ctx.request.userId && !djAllowed(ctx, gm)) return { ok: false, message: 'You can only remove your own tracks (or ask a DJ/admin).' };
    try {
      const t = await gm.removeAt(p.position);
      return { ok: true, message: `🗑️ Removed **${safeText(t.title, 100)}**.` };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  },
  async 'music.move'(ctx, p) {
    const gm = ctx.music.peek(ctx.guild.id);
    if (!gm?.queue.length) return { ok: false, message: 'The queue is empty.' };
    if (!djAllowed(ctx, gm)) return { ok: false, message: 'Only the DJ role or admins can reorder the queue.' };
    try {
      const t = await gm.moveTrack(p.from, p.to);
      return { ok: true, message: `↕️ Moved **${safeText(t.title, 100)}** to #${p.to}.` };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  },
  async 'music.queue'(ctx) {
    return { ok: true, message: 'Queue', embed: queueEmbed(ctx.music.peek(ctx.guild.id) ?? ctx.music.get(ctx.guild)) };
  },
  async 'music.nowplaying'(ctx) {
    const gm = ctx.music.peek(ctx.guild.id);
    const cur = gm?.queue.current;
    if (!cur || gm.status === 'idle') return { ok: false, message: 'Nothing is playing.' };
    const pos = gm.position;
    const total = cur.durationMs;
    const bar = total ? (() => {
      const filled = Math.min(14, Math.round((pos / total) * 14));
      return `${'▬'.repeat(filled)}🔘${'▬'.repeat(14 - filled)}`;
    })() : '🔴 live';
    return { ok: true, message: `${gm.status === 'paused' ? '⏸️' : '▶️'} **${safeText(describeTrack(cur), 200)}**\n${bar} ${formatDuration(pos)} / ${formatMs(total)}\nRequested by <@${cur.requestedBy ?? 'unknown'}> · ${safeText(cur.license ?? 'n/a', 120)}${cur.page ? ` · <${cur.page}>` : ''}` };
  },
  async 'music.volume'(ctx, p) {
    const gm = ctx.music.peek(ctx.guild.id) ?? ctx.music.get(ctx.guild);
    const target = p.percent ?? Math.max(0, Math.min(100, gm.volume + (p.change ?? 0)));
    const v = gm.setVolume(target);
    return { ok: true, message: `🔊 Volume set to ${v}%${gm.status === 'playing' ? '' : ' (applies to the next track)'}.` };
  },
  async 'music.shuffle'(ctx) {
    const gm = ctx.music.peek(ctx.guild.id);
    if (!gm || gm.queue.length < 2) return { ok: false, message: 'Need at least two queued tracks to shuffle.' };
    if (!djAllowed(ctx, gm)) return { ok: false, message: 'Only the DJ role or admins can shuffle.' };
    const n = await gm.shuffle();
    return { ok: true, message: `🔀 Shuffled ${n} tracks.` };
  },
  async 'music.loop'(ctx, p) {
    const gm = ctx.music.peek(ctx.guild.id) ?? ctx.music.get(ctx.guild);
    gm.setLoop(p.mode);
    return { ok: true, message: p.mode === 'off' ? '➡️ Looping off.' : `🔁 Looping the ${p.mode}.` };
  },
};
