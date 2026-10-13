# Troubleshooting

Logs are in `data\logs\knight.log` and `data\logs\aegis.log` (JSON lines, secrets redacted). Run `npm run health` for live status.

| Symptom | Fix |
|---|---|
| `Configuration invalid` / launcher exits | Run `npm run check:config`; it lists exactly what is missing (never prints secrets). |
| `Used disallowed intents` / bot exits on login | Enable **Server Members** and **Message Content** intents for that application (Developer Portal → Bot). `npm run check:discord` shows the intent status. |
| `An invalid token was provided` | Reset the token in the Developer Portal, update `.env`. Make sure KNIGHT and AEGIS tokens are from **different** applications. |
| Slash commands don't appear | Set `DEV_GUILD_ID` and run `npm run register` (global registration can take up to an hour). Re-invite with the `applications.commands` scope using the link from `npm run check:discord`. |
| "Missing permissions" / "role is at or above mine" | Server Settings → Roles: drag KNIGHT/AEGIS **above** the roles they manage. Check channel-specific overrides. |
| Automod "does nothing" | It starts in simulation mode. Check the mod log for `[SIMULATION]` cases, then `/modconfig simulate enabled:false`. Moderators and exempt roles are skipped by design. |
| ALPHA ignores my typed message | It must start with "ALPHA", come from `OWNER_ID`, and be in the configured alpha channel (if set). `/setup alpha text_prefix:true`. |
| `/listen start` refuses | No STT provider. Set `GROQ_API_KEY` (free) and restart. |
| Voice: STT unavailable notice | Daily cap or Groq 429; it resumes automatically. Raise `STT_DAILY_LIMIT` carefully (Groq free: 2,000/day). |
| Music: "No lawful source has …" | Add the file to `data\music` as `Artist - Title.mp3`. See [MUSIC.md](MUSIC.md). |
| Music/TTS silent, ffmpeg errors | `npm run check:config` shows the ffmpeg path. Reinstall with `npm ci` (ffmpeg-static is an optional dependency). |
| Welcome card shows "stand-in background" | Put your original art at `assets\welcome\background.png`. |
| Welcome GIF/MP4 not sent | Falls back to PNG automatically if rendering fails or exceeds 9.5 MB; check the AEGIS log. |
| Scheduled report didn't post | `/schedule list` shows failures; the reports channel must be set (`/setup channel purpose:reports`). Failed jobs retry with backoff and post a failure notice to the alpha channel. |
| `database is locked` | Both processes share the DB with WAL and an 8 s busy timeout; this should be transient. Make sure only one launcher is running. |
| Restore a backup | Stop the bots, copy a file from `data\backups\` over `data\soul-society.db`, delete `soul-society.db-wal` and `-shm`, start again. |
| `ExperimentalWarning: SQLite` | Harmless (built-in `node:sqlite`); the npm scripts hide it. |
