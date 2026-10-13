# Music (AEGIS) — online, licensed, no local files needed

Commands:

- **Playback:** `/play <name | link | playlist>`, `/search`, `/skip`, `/pause`, `/resume`, `/stop`, `/nowplaying`, `/volume`, `/shuffle`, `/loop off|track|queue`
- **Queue:** `/queue show|remove|move`
- **Voice:** "ALPHA, play …", "skip", "pause", "resume", "show the queue", "volume forty", "louder", "shuffle", "loop this song", "stop music"
- **Per-server defaults:** `/setup music` (default volume, DJ role, "now playing" posts)

## Providers

All share one interface: search, resolve link, stream input, metadata. Audio is streamed by ffmpeg straight from the provider into the voice connection; **nothing is downloaded or kept on the host**.

| Provider | Key | What it plays | Terms basis |
|---|---|---|---|
| **Audius** (default, first) | none | Search, track links, playlists/albums | Audius API tracks are licensed to third-party apps under the **Audius Open Music License**, which covers public performance and streaming. Artists can opt out. Gated or purchase-only tracks are skipped automatically. Attribution (artist + link) is shown. |
| **Jamendo** | free `JAMENDO_CLIENT_ID` | Search, track/album/playlist links | Creative Commons music; API free for non-commercial use. *Implemented and unit-tested with mocked responses; not live-tested (no client id was available).* |
| **Internet Archive** | none | Search, `archive.org/details/…` links | Only items with an explicit Creative Commons or Public Domain licence |
| Internet radio | none | Station search (`MUSIC_ENABLE_RADIO=true`) | radio-browser.info directory; each station's terms apply |
| Direct links (admins) | — | https audio files, `.m3u` / `.pls` playlists, HLS streams | The admin is responsible for rights. Private/LAN addresses are blocked (also after DNS resolution). |
| Local folder | — | Optional `MUSIC_DIR` | Never required; skipped if absent |

### YouTube, Spotify, SoundCloud

Their links are accepted for **metadata only**. The title is read from their public oEmbed endpoint, then searched on the licensed providers above, and AEGIS says it did so. **Their audio is never extracted or streamed.**

- **YouTube:** the API Services developer policies prohibit separating or isolating a video's audio and prohibit background playback, so a YouTube Data API key does not grant permission to stream into Discord.
- **Spotify and SoundCloud:** neither licenses rebroadcasting through bots.

**What this means in practice:** most mainstream label releases (e.g. "Her" by JVKE) are not available from any free, licensed source. AEGIS says so instead of faking playback, and suggests the closest licensed matches. Independent artists on Audius and Jamendo, plus CC/public-domain recordings, play fully.

## Behaviour and limits

- **Per-server isolation:** one queue, player, connection, volume and loop mode per server. Stopping one server never affects another (tested).
- **No races:** queue changes and playback transitions run under a per-server mutex.
- **Ambiguous searches:** a select menu shows the top matches. `/search` always shows it. The menu is bound to the requester and expires after 2 min.
- **Errors are reported plainly:** not found, restricted/private, gated, invalid link, provider rate-limited, provider outage, and "too many streams" (`MUSIC_MAX_STREAMS`, global ffmpeg cap).
- **Failures:** a failing track is skipped, and 3 failures in a row stop playback.
- **Disconnects:** AEGIS waits ~20 s for Discord to reconnect. If it can't, it cleans up and saves the queue (including the interrupted track) for the next `/play`.
- **Cleanup:** every ffmpeg process is killed when a track ends, is skipped or stopped, or on shutdown. Verified: the process exits after stop.
- **Limits:** queue ≤ `MUSIC_MAX_QUEUE` (100). Playlists are truncated to fit. Idle disconnect after `MUSIC_IDLE_LEAVE_SECONDS`.

## Verification

- ✅ **Live (2026-10-13):** Audius search, then the stream URL decoded by ffmpeg into Discord-format PCM, then the ffmpeg process exited cleanly (`npm run verify:media`). Internet Archive live stream decode also passed.
- ✅ **Unit tests (mocked HTTP):** provider ranking, gated-track filtering, Audius track and playlist links, YouTube/Spotify metadata-only path, outages and rate limits, SSRF/DNS protection, `.m3u`/`.pls` parsing, Jamendo, volume/loop/shuffle, playlist bulk-add, two-server isolation, disconnect recovery.
- ⏳ **Needs a live voice channel:** actual audio in Discord. Do the manual test in [VOICE.md](VOICE.md).
