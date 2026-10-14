# Implementation status

## Welcome cards + Jockie-style music (2026-10-14)

**Root causes fixed**
- **Welcome message missing from the card:** the saved `/setup welcome message` was only sent as chat text and never passed to the renderer. `/welcome-test` didn't use it at all. Now one function, `composeWelcome`, builds the post for both real joins and `/welcome-test`. The message is drawn inside the card in a neon panel below the tagline, so it can't overlap the avatar, name or tagline. The panel supports:
  - line breaks (`\n`), Unicode, emoji (bundled Noto Emoji font) and Discord custom emoji
  - `**bold**`, `*italic*`, `__underline__`, `~~strike~~`, `` `code` ``, headings, quotes and bullets
  - adaptive font size (32→18 px), wrapping, and an ellipsis when text is too long
- **Music silent on Bot-Hosting.net:** FFmpeg is missing on that host and the old code required it. A built-in WebAssembly MP3 decoder plus Opus passthrough now plays Audius, Jamendo and most Archive and radio streams without FFmpeg. FFmpeg is used automatically when present (`FFMPEG_PATH`, `ffmpeg-static` or PATH).
- **"Now playing" was sent before audio started:** it's now sent only after the player reaches the *playing* state. Streams that fail, stay silent or stall for 20 s are skipped, and the reply says why.
- **Failure counter:** tracks that started and then kept dying never halted the queue. Fixed: only a track that finishes cleanly resets the counter.

**Evidence (this PC)**

| Check | Result |
|---|---|
| `npm test` | **137 / 137 pass**. New tests cover welcome text on the card, layout, shared composition, rich text and emoji; the audio engine (MP3 decode accuracy, resampler, sniffing, FFmpeg detection); honest "Now playing"; stall timeout; clear/remove/move; permission errors; metadata-only search. |
| `npm run lint` | clean |
| `npm run verify:media -- --builtin` | **Live, FFmpeg disabled:** Audius licensed track → built-in decoder → 50 Opus packets, rms 0.218, stream closed after stop. Archive MP3 stream decoded. |
| `npm run verify:media` | Same checks with FFmpeg 6.1.1: pass |
| Memory (measured, before Discord login) | KNIGHT ≈ 78 MB + AEGIS ≈ 102 MB as separate processes, ≈ 103 MB both in `npm run start:single`. Each built-in music stream adds ≈ 20–35 MB. |
| Real audio in a Discord voice channel | **Not verified.** Needs a live `/play` on the deployed bot. |

---

## Earlier: production-readiness upgrade (2026-10-13/14)

## Evidence from this environment

| Check | Result |
|---|---|
| `npm test` | **119 / 119 pass.** Real SQLite, real audio DSP and rendering; MOCK Discord guild, MOCK STT, mocked HTTP for providers. |
| `npm run lint` | clean |
| `npm run check:config` / `check:discord` | valid; both tokens live, Server Members + Message Content intents enabled, each bot in 1 server |
| `npm run check:production -- --live` | 0 failures. Discord ✔, Groq key ✔ (`whisper-large-v3-turbo` available), Audius ✔, schema v2, `.env`/`data` not tracked. Warnings are only development defaults. |
| `npm run smoke:login` | **Both bots logged in to Discord with the new code** (KNIGHT 14 commands, AEGIS 37) using a throw-away DB and no event handlers. Voice deps ok: Opus, DAVE, ffmpeg. |
| `npm run verify:media` | **Live:** Audius search, stream decoded by ffmpeg, ffmpeg process exits after stop. Also an Internet Archive stream, Windows TTS and an Opus round trip. |
| `npm run benchmark:stt -- --heldout` | **Live Groq**, 80 requests:<br>• old pipeline: 16.5% WER, wake word 10/20, correct command 9/20<br>• new pipeline + prompt (turbo): 2.9% WER, wake word 20/20, correct command 20/20<br>• `whisper-large-v3`: same accuracy, slower<br>Synthetic speech, not a real mic. See [VOICE.md](VOICE.md). |
| `npm run simulate` | Full ALPHA flow on a MOCK guild, including per-server voice policy and approvals |
| Live database | Backed up first (`data/backups/pre-production-upgrade-2026-10-13.db`), then migrated to schema v2 (adds a table and a column; existing data untouched) |

## Implemented and tested

**Online music.** Provider architecture with:

- **Providers:** Audius (no key), Jamendo (optional free id), Internet Archive (CC/PD), radio (opt-in), admin direct links and `.m3u`/`.pls` playlists, optional local folder.
- **Metadata-only links:** YouTube, Spotify and SoundCloud links resolve to a title, then the closest licensed match. Their audio is never used.
- **Playback controls:** play, search, pause, resume, skip, stop, queue (show/remove/move), now playing with progress, volume, shuffle, loop, playlists.
- **Reliability and isolation:**
  - per-server isolation and a per-server mutex
  - a global stream cap
  - clear errors (not found, restricted, invalid link, rate limited, outage)
  - recovery from disconnects, with the queue persisted
  - verified ffmpeg cleanup

**Voice accuracy.** Root causes fixed:

- wake word dropped at the start of an utterance (domain prompt and lead-in padding)
- pauses removed (gap restoration)
- aliasing (FIR filter)
- split commands dropped, and stale-stream loss

Plus:

- **Quality gates:** confidence (repeat / confirm), hallucination and no-speech filtering, speech detection before spending quota.
- **Wake word:** configurable and strict.
- **Language:** configurable per server, plus vocabulary hints.
- **Reliability:** bounded retries (5xx/timeouts), 429 circuit breaker, global and per-server daily caps.
- **Diagnostics:** `/voice diagnostics`, with no audio or transcripts.

**Multi-server.**

- ALPHA authority is per server (server owner and `/setup trusted` users/roles). The operator has no power elsewhere unless `OPERATOR_GLOBAL_ACCESS=true`.
- First-run initialisation with safe defaults and a one-time setup guide per bot; existing servers are not spammed.
- `/settings view|reset`, `/setup trusted|music|branding|welcome (tagline, uploaded background)`.
- Per-server branding replaces the hard-coded server name.
- Per-user rate limit.
- No hard-coded IDs (enforced by a test).
- Global command registration in production, and `--clear-guild`.

**Deployment.**

- Dockerfile (amd64/arm64), `docker-compose.yml` (init, restart policy, health check, named volume, log rotation, memory limit) and `.dockerignore`.
- `.env.production.example`, `scripts/healthcheck.js`, an optional HTTP `/health`, `check:production`, `smoke:login`, a VM setup script, CI that builds the image and tests volume persistence, and [DEPLOYMENT.md](DEPLOYMENT.md).

**Preserved.** All earlier features and tests are kept:

- KNIGHT's simulation default and safeguards
- voice moderation stays off unless enabled
- Windows `npm start`, `check:config`, `check:discord`, `register`

## Requires manual testing or external action

1. **Restart your bots on the new code.** Your current `npm start` session is running the old code. Stop it (Ctrl+C), then run `npm start`.
2. **Live voice in a channel:** follow the manual procedure in [VOICE.md](VOICE.md#manual-end-to-end-test-needs-a-real-voice-channel). Accuracy with your real microphone has not been measured.
3. **Live music playback in a voice channel:** the stream is verified up to Discord-format PCM; audio heard in Discord has not been confirmed.
4. **Container build:** Docker isn't installed on this PC. The image build and the volume-persistence check are automated in GitHub Actions (`.github/workflows/ci.yml`) and run when you push. Until then, "containers build successfully" is **unverified**.
5. **Remote deployment:** needs a host account (e.g. Oracle Cloud Always Free; card verification required) and the steps in DEPLOYMENT.md. **The bots are not deployed and not 24/7 yet.**
6. **Second-server test:** invite both bots to another server and check the setup guide, `/settings view` and `/play`.
7. **Jamendo:** needs a free `JAMENDO_CLIENT_ID`; tested only with mocked responses.

## Limitations (by terms or technology)

- **Mainstream label music** (e.g. "Her" by JVKE) isn't available from any free licensed source. YouTube's developer policies forbid separating audio or background play, and Spotify/SoundCloud don't license rebroadcasting.
- **No free 24/7 host without a card** was found (checked 2026-10-13). Oracle Always Free is ₹0 within limits but needs card verification and can reclaim idle VMs. Google's `e2-micro` has only 1 GB/month free egress.
- **Speech recognition can still make mistakes** (accents, noise, names). The confirmation gates exist for this.
- **Windows TTS** (spoken replies) works only on Windows hosts and is disabled in the Linux container.
