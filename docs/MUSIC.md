# Music (AEGIS)

Commands: `/play` `/queue show|remove|move` `/skip` `/pause` `/resume` `/stop` `/nowplaying`, plus voice: "ALPHA, play …", "skip", "pause", "resume", "show the queue", "stop music".

## Sources (lawful only)

| Source | How it works | Notes |
|---|---|---|
| **Your library** | Audio files in `MUSIC_DIR` (default `data\music`), named `Artist - Title.mp3` (mp3, ogg, opus, flac, wav, m4a, webm, aac; subfolders allowed). Searched by title and artist. | Preferred when matches tie. You are responsible for having the rights to play your files to the server. |
| **Internet Archive** | Searches audio items that carry an explicit `licenseurl` (Creative Commons or Public Domain Mark). Unlicensed uploads are excluded. | On by default (`MUSIC_ENABLE_ARCHIVE`). Free, no key. |
| **Internet radio** | radio-browser.info station directory (https streams only). | Off by default (`MUSIC_ENABLE_RADIO=true` to enable). Rebroadcasting a station to a server may be subject to the station's terms. |
| **Direct URL** (admins) | An https audio file URL. | Private network addresses, plain http, YouTube and Spotify URLs are refused. |

### Why not YouTube or Spotify?

YouTube's Terms of Service prohibit downloading or re-streaming content outside YouTube's own player, and its official API gives search results, not audio streams. Spotify's terms likewise forbid rebroadcasting. Tools like yt-dlp/ytdl work by circumventing this, so they are **not** included.

So "ALPHA, play Blinding Lights" plays that song **if you have the file in your music folder** (e.g. `data\music\The Weeknd - Blinding Lights.mp3`). Otherwise AEGIS says no lawful source has it, or offers Creative Commons or public-domain matches.

## Behaviour

- **One player per server:** there's exactly one `GuildMusic` per guild. Queue operations and playback changes are serialised by a mutex, so simultaneous `/play` requests can't race.
- **Ambiguous searches:** when the top results are close, a select menu offers the choices. It's bound to the person who searched and expires after 2 minutes.
- **Failures:** a track that fails to open, or a stream error, skips to the next track and posts a notice. Three failures in a row stop playback.
- **Disconnects:** AEGIS waits up to about 20 s for Discord to reconnect. If it doesn't, AEGIS cleans up and saves the queue, including the interrupted track, to `music_state` for the next `/play`.
- **Idle:** AEGIS leaves after `MUSIC_IDLE_LEAVE_SECONDS` (default 300) with an empty queue.
- **Cleanup:** ffmpeg processes and the voice connection are released on stop, idle, disconnect and shutdown.

## Verification status

- ✅ Offline tests: queue operations, race-free concurrent enqueue, single instance per guild, skip-on-failure, halt after repeated failures, disconnect cleanup and persistence, pause/resume/stop, local search by title and artist, licence filtering, URL safety. Uses a MOCK voice player.
- ✅ Live check from this PC: the Internet Archive and radio-browser APIs responded (2026-10-13).
- ⏳ **Needs live verification:** actual audio playback into a Discord voice channel. This needs the AEGIS token and a test server.
