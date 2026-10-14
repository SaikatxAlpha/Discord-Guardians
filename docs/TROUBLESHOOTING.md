# Troubleshooting

Logs are in `data\logs\knight.log` and `data\logs\aegis.log` (JSON lines, secrets redacted). Run `npm run health` for live status.

| Symptom | Fix |
|---|---|
| `Configuration invalid` / launcher exits | Run `npm run check:config`; it lists exactly what is missing (never prints secrets). |
| `Used disallowed intents` / bot exits on login | Enable **Server Members** and **Message Content** intents for that application (Developer Portal → Bot). `npm run check:discord` shows the intent status. |
| `An invalid token was provided` | Reset the token in the Developer Portal, update `.env`. Make sure KNIGHT and AEGIS tokens are from **different** applications. |
| Slash commands don't appear | Development: set `DEV_GUILD_ID` and run `npm run register` (instant, that server only). Production (`APP_ENV=production`) registers globally; new servers may take a few minutes. Re-invite with the `applications.commands` scope (link from `npm run check:discord`). |
| "Missing permissions" / "role is at or above mine" | Server Settings → Roles: drag KNIGHT/AEGIS **above** the roles they manage. Check channel-specific overrides. |
| Automod "does nothing" | It starts in simulation mode. Check the mod log for `[SIMULATION]` cases, then `/modconfig simulate enabled:false`. Moderators and exempt roles are skipped by design. |
| ALPHA ignores my typed message | It must start with the wake word, come from the server owner or a user/role added with `/setup trusted`, and be in the configured alpha channel (if set). `/setup alpha text_prefix:true`. |
| `/listen start` refuses | No STT provider. Set `GROQ_API_KEY` (free) and restart. |
| Voice: STT unavailable notice | Daily cap or Groq 429; it resumes automatically. Raise `STT_DAILY_LIMIT` carefully (Groq free: 2,000/day). |
| Music: "… is not available from a licensed source" | Most mainstream label songs are not licensed for bots on any free source. Try another title, `/search`, an Audius/Jamendo link or playlist. YouTube/Spotify links are matched by title only. See [MUSIC.md](MUSIC.md). |
| Music silent or "needs FFmpeg" | `npm run check:config` shows the audio engine. Without FFmpeg only MP3 and Opus sources play (Audius, Jamendo, most Archive items); others are refused with a clear message. Set `FFMPEG_PATH` to a static ffmpeg binary to play everything. `npm run verify:media -- --builtin` tests the no-FFmpeg path live. |
| "I don't have permission to connect/speak" | Give AEGIS **View Channel**, **Connect** and **Speak** in that voice channel (or its category). |
| Bot restarts / out of memory on a 256 MB host | Start with `npm run start:single` (both bots in one process, ≈ 110 MB less) and set `MUSIC_MAX_STREAMS=2`. |
| Welcome card shows the built-in design | Upload a background per server with `/setup welcome background:`, or set `WELCOME_BACKGROUND` (or `assets/welcome/background.png`) as the default for all servers. |
| Welcome GIF/MP4 not sent | Falls back to PNG automatically if rendering fails or exceeds 9.5 MB; check the AEGIS log. |
| Scheduled report didn't post | `/schedule list` shows failures; the reports channel must be set (`/setup channel purpose:reports`). Failed jobs retry with backoff and post a failure notice to the alpha channel. |
| `database is locked` | Both processes share the DB with WAL and an 8 s busy timeout; this should be transient. Make sure only one launcher is running. |
| Restore a backup | Stop the bots, copy a file from `data\backups\` over `data\soul-society.db`, delete `soul-society.db-wal` and `-shm`, start again. |
| `ExperimentalWarning: SQLite` | Harmless (built-in `node:sqlite`); the npm scripts hide it. |
| Commands listed twice in my dev server | Old guild-scoped copies plus new global ones. Run `npm run register -- --clear-guild`. |
| Voice: "please repeat" often | Low transcription confidence. Speak closer to the mic, reduce music volume while talking, set `/voice settings language:` correctly, and add names with `/voice settings add_word:`. Check `/voice diagnostics`. |
| Voice: commands cut in half | Raise `VOICE_SILENCE_MS` (e.g. 1500) if you pause mid-sentence. |
| Voice: "daily voice-command limit" | Per-server cap (`/voice settings daily_limit`) or deployment cap (`STT_DAILY_LIMIT`). Resets at 00:00 UTC. |
| Music: "Too many servers are streaming" | Global `MUSIC_MAX_STREAMS` reached; raise it if the host has CPU/RAM to spare. |
| Deployment problems | See [DEPLOYMENT.md](DEPLOYMENT.md#6-troubleshooting-deployment). |
