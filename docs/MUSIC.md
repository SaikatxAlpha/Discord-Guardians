# Music (AEGIS) — online, licensed, no local files needed

## Commands (Jockie-style)

| Command | What it does |
|---|---|
| `/play <name \| link \| playlist>` | **One command:** searches with your exact words and plays the best match that is *the song you asked for* in **your** voice channel, or queues it ("Queued at #N"). Never asks you to choose or repeat. |
| `/search <query>` | For browsing: ✅ playable results (title, artist, duration, source) and ℹ️ catalogue-only matches, with a pick menu. |

### How `/play` picks a track

- **Same recording only.** Every meaningful word of the query must match the title or artist. One-letter typos, "lo-fi"/"lofi" and filler words ("from", "by", "song") are tolerated. Most of the title must be what you asked for.
- **No unrequested versions.** Covers, remixes, slowed/sped-up, live, karaoke and instrumental versions are only chosen if your query asks for them.
- **Ranking.** Exact title first, then the artist the catalogue credits, then the provider and popularity.
- **Automatic fallback.** If the best upload's stream fails, up to 2 other uploads of the same song are tried, and the reply says so. A different song is never substituted.
- **Not available.** If no permitted source has the recording, you get one message, for example: "🚫 **Slow Motion (From "Bharat")** by Shreya Ghoshal & Nakash Aziz isn't available from any source AEGIS may legally stream, so nothing was played. Browse with `/search …`". It lists a few playable alternatives when there are any. Nothing is played.
| `/queue` · `/nowplaying` | The queue, or the current track with a progress bar. |
| `/skip` · `/pause` · `/resume` | Playback control. |
| `/stop` | Stops and clears the queue. AEGIS stays in the channel until the idle timeout. |
| `/leave` | Stops, clears and disconnects now. |
| `/volume 0–100` · `/loop off\|track\|queue` · `/shuffle` | Per-server settings (saved). |
| `/remove <position>` · `/move <from> <to>` · `/clearqueue` | Edit upcoming tracks. The current song keeps playing. |

- **Voice (ALPHA):** "play …", "skip", "pause", "resume", "show the queue", "volume forty", "louder", "shuffle", "loop this song", "stop music", "leave the voice channel", "clear the queue", "remove track 3".
- **Per-server defaults:** `/setup music` (default volume, DJ role, "now playing" posts). With a DJ role set, skip/stop/remove of other people's tracks need the DJ role (or admin).

### Replies

- **"▶️ Now playing"** is sent only after the audio player is actually playing, meaning Discord-format audio is flowing.
- If a stream fails to start (dead link, wrong format, nothing within 20 s), the track is skipped and the reply says why. AEGIS never claims playback that didn't start.
- Errors (not in voice, missing Connect/Speak permission, already playing in another channel, nothing found) are shown **only to the requester**.

## Audio engine: works without FFmpeg

Some free hosts (e.g. Bot-Hosting.net) block `ffmpeg-static`'s install script. AEGIS picks its engine at start-up, and `/voice diagnostics`, `npm run check:config` and the start-up log show which one is active.

| Engine | When | Plays |
|---|---|---|
| **FFmpeg** | `FFMPEG_PATH`, a downloaded `ffmpeg-static`, or `ffmpeg` on PATH | Any format |
| **Built-in** (no FFmpeg) | Otherwise | **MP3** (decoded with mpg123 compiled to WebAssembly, resampled to 48 kHz stereo) and **Ogg/Opus**, **WebM/Opus** (passed straight through). This covers Audius, Jamendo, most Internet Archive items and most radio. |

- With the built-in engine, AAC/FLAC/Vorbis sources are refused with a clear message ("needs FFmpeg"), and the next track plays.
- Audio is streamed chunk by chunk with backpressure. Nothing is written to disk.
- Each built-in stream uses about 20–35 MB of RAM (measured). On 256 MB hosts use `MUSIC_MAX_STREAMS=2` and `npm run start:single`.

## Providers

All providers share one interface: search, resolve link, stream input, metadata.

| Provider | Key | What it plays | Terms basis |
|---|---|---|---|
| **Audius** (default, first) | none | Search, track links, playlists/albums | **Audius Open Music License** for third-party apps (covers streaming). Gated/purchase-only tracks and obvious YouTube rips ("y2mate", "yt1s"…) are skipped. Attribution (artist + link) is shown. |
| **Jamendo** | free `JAMENDO_CLIENT_ID` | Search, track/album/playlist links | Creative Commons; API free for non-commercial use. *Unit-tested with mocked responses; not live-tested (no client id available).* |
| **Internet Archive** | none | Search, `archive.org/details/…` links | Only items with an explicit CC or Public Domain licence |
| Internet radio | none | Station search (`MUSIC_ENABLE_RADIO=true`) | radio-browser.info directory; each station's terms apply |
| Direct links (admins) | — | https audio files, `.m3u` / `.pls`, HLS | The admin is responsible for rights. Private/LAN addresses are blocked (also after DNS). |
| Local folder | — | Optional `MUSIC_DIR` | Never required |
| Apple catalogue (iTunes Search API) | none | **Nothing — metadata only** | Used to tell users a song exists but is not legally streamable (`MUSIC_METADATA_CATALOG`). |

### YouTube, Spotify, SoundCloud and mainstream releases

Links from these services are accepted for **metadata only**:
- AEGIS reads the title from their public oEmbed endpoint.
- It searches the licensed providers above for that title, and says it did so.
- **Their audio is never extracted or streamed.**

Why:
- **YouTube's** developer policies prohibit isolating audio and background playback.
- **Spotify** and **SoundCloud** don't license rebroadcasting through bots.

Most mainstream label releases (e.g. "Her" by JVKE) are not available from any free, licensed source. For those, AEGIS says something like: "I found **her** by JVKE in the Apple Music catalogue, but it is not available from a source bots may stream". It then suggests playable alternatives. It never plays an unrelated track pretending it's the requested one.

## Behaviour and limits

- **Per-server isolation:** each server has its own queue, player, connection, volume and loop mode. One server's commands never affect another (tested).
- **No races:** queue changes and playback transitions run under a per-server mutex. Concurrent `/play` calls start exactly one track (tested).
- **Voice:** AEGIS joins the requester's channel and checks View Channel / Connect / Speak first. If it's already playing elsewhere in the server, it tells you where.
- **Failures:**
  - A track that fails to start, or stalls for 20 s, is skipped with a reason.
  - 3 failures in a row stop the queue.
  - A track that finishes normally resets the failure count.
- **Disconnects:** AEGIS waits about 20 s for Discord to reconnect. If it can't, it cleans up and saves the queue for the next `/play`.
- **Cleanup:**
  - Streams, the WebAssembly decoder memory and any FFmpeg process are released when a track ends, is skipped, stopped or left, and on shutdown.
  - `/leave` disconnects even when ALPHA voice listening shares the connection.
- **Limits:** queue ≤ `MUSIC_MAX_QUEUE` (100); playlists are truncated to fit; concurrent streams ≤ `MUSIC_MAX_STREAMS`; idle disconnect after `MUSIC_IDLE_LEAVE_SECONDS`.

## Verification (2026-10-14)

- ✅ **Live, no FFmpeg** (`npm run verify:media -- --builtin`): verified on Windows with FFmpeg disabled; the Linux host itself was not tested.
  - An Audius search returned a licensed track.
  - Its real MP3 stream went through the built-in decoder into @discordjs/voice: 50 Opus packets (1 s) produced, audio level rms 0.218 (not silence).
  - The stream closed after stop.
  - An Internet Archive MP3 stream also decoded.
- ✅ **Live, with FFmpeg** (`npm run verify:media`): the same Audius and Archive checks passed.
- ✅ **Unit tests**, with mocked HTTP and a mocked voice player:
  - "Now playing" only after playback starts; silent or stalled streams are skipped and reported.
  - Queue and controls: clear/remove/move, volume 0–100, loop, shuffle, playlists, stop vs leave.
  - Voice and isolation: Connect/Speak permission errors, two-server isolation, disconnect recovery.
  - Search and providers: provider ranking, gated/ripped filtering, metadata-only catalogue results, SSRF protection.
  - Built-in engine: MP3 decode accuracy (440 Hz tone), resampler, format detection, FFmpeg detection.
- ⏳ **Not verified here: audio audible in a real Discord voice channel.** This needs a live `/play` in your server; the steps are in [VOICE.md](VOICE.md).
