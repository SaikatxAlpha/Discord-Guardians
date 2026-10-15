# Music (AEGIS) — online, licensed, no local files needed

## Commands (Jockie-style)

| Command | What it does |
|---|---|
| `/play <name \| link \| playlist>` | **One command:** searches with your exact words and plays the best match that is *the song you asked for* in **your** voice channel, or queues it ("Queued at #N"). Never asks you to choose or repeat. |
| `/search <query>` | For browsing: ✅ playable results (title, artist, duration, source) and ℹ️ catalogue-only matches, with a pick menu. |
| `/queue` · `/nowplaying` | The queue, or the current track with a progress bar. |
| `/skip` · `/pause` · `/resume` | Playback control. |
| `/stop` | Stops and clears the queue. AEGIS stays in the channel until the idle timeout. |
| `/leave` | Stops, clears and disconnects now. |
| `/volume 0–100` · `/loop off\|track\|queue` · `/shuffle` | Per-server settings (saved). |
| `/remove <position>` · `/move <from> <to>` · `/clearqueue` | Edit upcoming tracks. The current song keeps playing. |

- **Voice (ALPHA):** "play …", "skip", "pause", "resume", "show the queue", "volume forty", "louder", "shuffle", "loop this song", "stop music", "leave the voice channel", "clear the queue", "remove track 3".
- **Per-server defaults:** `/setup music` (default volume, DJ role, "now playing" posts). With a DJ role set, skip/stop/remove of other people's tracks need the DJ role (or admin).

### How `/play` picks a track

1. **All enabled providers are searched in parallel**, using your exact words. Duplicates are merged: same provider ID, same Jamendo track found directly and through Openverse, same page URL, or same normalised title + artist. The merged copies are kept as fallbacks.
2. **Same recording only.**
   - Every meaningful word of the query must match the title or artist. One-letter typos, "lo-fi"/"lofi" and filler words ("from", "by", "song") are tolerated.
   - Most of the title must be what you asked for.
   - Covers, remixes, slowed/sped-up, live, karaoke and instrumental versions are only chosen if your query asks for them.
3. **Identity check against Apple's catalogue (metadata only).** If the catalogue knows songs with exactly that title, an upload with the same title only counts when its artist is credited there. For example, `/play Slow Motion` will not play an unrelated indie song that happens to be called "Slow Motion". There are two exceptions:
   - mood/genre requests ("chill lofi", "bollywood romantic")
   - classical works, where any performance of the piece is the piece
4. **Ranking:**
   - the catalogue-credited artist first
   - then an exact title
   - then the provider (Audius > Jamendo/Openverse > Archive) and popularity
5. **Automatic fallback.** If the stream fails or stalls, up to 2 other copies of the **same** recording are tried, from the same or another provider, and the reply says so.
6. **Not available.** You get one message. It names the recording (from the catalogue) and lists up to 3 clearly identified playable alternatives with artist and source. It also shows how to request one, e.g. `/play Slow Motion DJ Somebody`, and suggests `/search`. Nothing is played.

### Replies

- **"▶️ Now playing"** is sent only after the audio player is actually playing, meaning Discord-format audio is flowing.
- If a stream fails to start (dead link, wrong format, nothing within 20 s), the next copy or track is tried and the reply says why. AEGIS never claims playback that didn't start.
- Errors (not in voice, missing Connect/Speak permission, already playing in another channel, unavailable song) are shown **only to the requester**.

## Audio engine: works without FFmpeg

Some free hosts (e.g. Bot-Hosting.net) block `ffmpeg-static`'s install script. AEGIS picks its engine at start-up, and `/voice diagnostics`, `npm run check:config` and the start-up log show which one is active.

| Engine | When | Plays |
|---|---|---|
| **FFmpeg** | `FFMPEG_PATH`, a downloaded `ffmpeg-static`, or `ffmpeg` on PATH | Any format |
| **Built-in** (no FFmpeg) | Otherwise | **MP3** (decoded with mpg123 compiled to WebAssembly, resampled to 48 kHz stereo) and **Ogg/Opus**, **WebM/Opus** (passed straight through). This covers Audius, Jamendo/Openverse, most Internet Archive items and most radio. |

- With the built-in engine, AAC/FLAC/Vorbis sources are refused with a clear message ("needs FFmpeg"), and the next copy or track plays. Openverse results in formats this host can't decode are not offered at all.
- Audio is streamed chunk by chunk with backpressure. Nothing is written to disk.
- **Memory:** each built-in stream uses about 20–35 MB of RAM (measured). On 256 MB hosts keep `MUSIC_MAX_STREAMS=2` (the default) and use `npm run start:single`.

## Providers (audited 2026-10-15)

Every enabled provider is queried for every `/play` and `/search`. A provider that fails or times out is reported as "unreachable right now", and the others still answer.

| Provider | Cost / key | Catalogue | Full playable audio? | Terms basis |
|---|---|---|---|---|
| **Audius** (`audius`) | free, no key | Independent artists; some re-uploads. Gated, purchase-only and obvious YouTube rips ("y2mate"…) are skipped. | ✅ Full tracks (MP3), live-verified | **Audius Open Music License** for third-party apps |
| **Openverse** (`openverse`) — *new* | free, no key; anonymous 20 searches/min and **200/day**; free credentials raise it | Openly licensed audio. AEGIS uses Jamendo, Wikimedia Commons and ccMixter only; Freesound (sound effects/"previews") is excluded. Clips under 30 s are excluded. | ✅ Full tracks; Jamendo MP3 live-verified (190 s track → Opus) | Creative Commons licences (incl. NC/ND, fine for non-commercial unmodified playback); title, creator and licence are shown |
| **Jamendo** (`jamendo`) | free `JAMENDO_CLIENT_ID` | Creative Commons music | ✅ Full tracks (MP3) | Jamendo API, free for non-commercial use. *Mock-tested only (no client ID available). Jamendo's catalogue is also reachable through Openverse without a key.* |
| **Internet Archive** (`archive`) | free, no key | Items with an explicit CC / Public Domain licence | ✅ Full files (MP3 preferred; for albums the file matching the title is chosen) | Item licence. Uploader licence claims aren't verified by the Archive. |
| Internet radio (`radio`) | free, no key | Live stations (radio-browser.info), incl. Indian/Bollywood stations; opt-in `MUSIC_ENABLE_RADIO=true` | ✅ Live streams, not on-demand songs | Each station's terms apply |
| Direct links (admins) | — | https audio files, `.m3u` / `.pls`, HLS | ✅ | The admin is responsible for rights. Private/LAN addresses are blocked (also after DNS). |
| Local folder (`local`) | — | Optional `MUSIC_DIR` | ✅ | Never required |
| Apple catalogue (iTunes Search API) | free, no key | Broad commercial catalogue (`MUSIC_METADATA_COUNTRY=IN` ranks Indian releases first) | ❌ **Metadata only — never queued or played** (its 30-s previews are not used) | Identification only |

### Providers investigated for Indian / Bollywood coverage, and why they are not used

| Service | Full audio for a Discord bot? | Why not |
|---|---|---|
| JioSaavn, Gaana, Wynk, Hungama | No public API | Only unofficial, scraped endpoints exist; using them would breach their terms. |
| YouTube / YouTube Music | No | YouTube's developer policies forbid separating audio from video and background playback. |
| Spotify, Apple Music | No | No rebroadcast licence; streams are DRM-protected. |
| Deezer API | No | 30-second previews only. |
| SoundCloud API | No | Not open to new apps, and its terms forbid rebroadcasting. |
| Free Music Archive | No (API retired) | The CC catalogue is partly reachable through Openverse/Archive. |
| Pixabay Music | No | No music API, and the licence forbids standalone redistribution. |

**Conclusion:** no free, permitted source streams major-label Bollywood or other commercial releases, e.g. "Slow Motion (From "Bharat")" by Shreya Ghoshal & Nakash Aziz (T-Series). Better search can't create streaming rights. AEGIS says so clearly and offers clearly labelled playable alternatives. Openly licensed Indian-style music and live Indian radio are available.

### YouTube, Spotify and SoundCloud links

These links are accepted for **metadata only**. AEGIS reads the title from the public oEmbed endpoint, then applies the same strict "same recording" choice on the licensed providers. If nothing qualifies, it says the song isn't available. Their audio is never extracted or streamed.

## Behaviour and limits

- **Per-server isolation:** each server has its own queue, player, connection, volume and loop mode. One server's commands never affect another (tested).
- **No races:** queue changes and playback transitions run under a per-server mutex. Concurrent `/play` calls start exactly one track (tested).
- **Voice:** AEGIS joins the requester's channel and checks View Channel / Connect / Speak first. If it's already playing elsewhere in the server, it tells you where.
- **Failures:** a track that fails to start, or stalls for 20 s, falls back to another copy of the same song, or is skipped with a reason. Fallbacks don't count towards the "3 failures in a row stop the queue" rule.
- **Metadata-only results** (the Apple catalogue) can never enter the queue (enforced in the queue itself).
- **Disconnects:** AEGIS waits about 20 s for Discord to reconnect. If it can't, it cleans up and saves the queue for the next `/play`.
- **Cleanup:** streams, the WebAssembly decoder memory and any FFmpeg process are released when a track ends, is skipped, stopped or left, and on shutdown. `/leave` disconnects even when ALPHA voice listening shares the connection.
- **Limits:**
  - queue ≤ `MUSIC_MAX_QUEUE` (100); playlists are truncated to fit
  - concurrent streams ≤ `MUSIC_MAX_STREAMS` (default 2)
  - idle disconnect after `MUSIC_IDLE_LEAVE_SECONDS`
  - Openverse searches are cached for 10 min, to stay within its anonymous daily limit

## Verification (2026-10-15)

- ✅ **Live, no FFmpeg** (`npm run verify:media -- --builtin`, on Windows with FFmpeg disabled; the Linux host was not tested):
  - Audius → built-in MP3 decoder → 50 Opus packets, audio level rms 0.218, and the stream closed after stop.
  - Openverse → Jamendo full track (190 s, CC BY-NC-ND) → Opus packets.
  - An Internet Archive MP3 decoded.
- ⚠️ **Provider availability varies.**
  - Openverse sometimes needs 10–40 s for a query it hasn't seen recently (it then answers in under 1 s). AEGIS waits up to 12 s and otherwise reports it as unreachable.
  - The Archive returned one HTTP 500 during testing, and the retry passed.
- ✅ **Unit tests**, with mocked HTTP and a mocked voice player:
  - Playback: one-command playback; queueing with position; fallback to the same recording from another provider.
  - Selection: the identity rule (`/play Slow Motion`), its mood/classical exemptions, and unavailable songs with labelled alternatives.
  - Search hygiene: de-duplication, Openverse filtering (previews, clips, undecodable formats, rate limits), metadata-only guard.
  - Behaviour: "Now playing" only after audio starts; controls; per-server isolation.
- ⏳ **Not verified: audio audible in a real Discord voice channel.** This needs a live `/play` in your server; the steps are in [VOICE.md](VOICE.md).
