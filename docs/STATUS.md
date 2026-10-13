# Implementation status (2026-10-13)

## Evidence gathered in this environment

| Check | Result |
|---|---|
| `npm test` | **97 / 97 pass.** Discord-independent: real SQLite, real rendering, MOCK Discord guild, MOCK STT. |
| `npm run lint` | ESLint clean |
| `npm audit --omit=dev` | 0 vulnerabilities |
| `npm run simulate` | Full ALPHA pipeline on a MOCK guild:<br>• owner text commands, plus non-owner rejection<br>• compound commands<br>• voice via scripted MOCK transcripts<br>• approvals (approve, wrong-user, cancel)<br>• AEGIS→KNIGHT cross-process task<br>• automod in simulation mode |
| `npm run verify:media` | **Real**, all four passed:<br>• Windows TTS produced a WAV<br>• ffmpeg decoded a local library file to 48 kHz PCM<br>• a public-domain Internet Archive recording was found, streamed and decoded live<br>• Opus encode/decode round trip |
| Live public APIs | Hacker News, Wikipedia, Internet Archive and radio-browser responded. GDELT rate-limited one probe (429) and was reported as an unavailable source. |
| Discord login (invalid token) | Discord rejected it, AEGIS exited with code 1 and a clear message, and the token was not in the logs |
| Clean shutdown | Child process test: exit 0, leases released, heartbeat marked `stopped`, token redacted |
| Welcome card | Rendered PNG (343 KB), GIF (932 KB) and MP4 (108 KB), all well under Discord's limit. Tests check the background is preserved, the avatar sits in the centre, names render dynamically and are sanitised, and every fallback works. |

**No Discord bot tokens, test server or Groq key were available**, so nothing has been verified against the live Discord API or a live speech service. Mocked Discord operations are not proof of live API success.

## 1. Implemented and tested (offline)

- **Two guardian apps** with separate tokens, client IDs, themes, commands, intents and processes. The launcher restarts a crashed bot and shuts both down cleanly.
- **Shared ALPHA coordinator:**
  - owner/trusted authentication
  - per-action authority
  - deterministic parser for every example in the brief, plus compound commands and "that channel/member" references
  - structured action registry and validation
  - target resolution with refusal of ambiguous matches
  - risk classification
  - owner-bound, expiring, single-use approvals with target-drift protection
  - cross-bot SQLite task queue with leases and idempotency
  - request de-duplication and audit log
- **Persistent scheduler:** survives restarts, gives each occurrence a single run, retries with backoff and reports failures. Two processes never double-run a job.
- **Database:** SQLite via built-in `node:sqlite`, with migrations, indexes, parameterised queries, transactions, WAL for two processes, and online backups.
- **KNIGHT moderation:**
  - profanity detection with obfuscation handling, Scunthorpe-style false-positive protection, and review-only handling for quotes and code
  - flood, duplicate, mention and invite spam detection
  - raid and new-account alerts
  - points escalation
  - simulation mode (default)
  - permission, hierarchy, self, owner, protected-role and bot-loop checks
  - verified timeout/kick/ban
  - case history and moderation reports
- **AEGIS administration:**
  - channels (create, rename, delete; public, read-only or private)
  - permission templates with an @everyone exposure check, a no-self-lockout rule and a privilege-escalation guard
  - roles (create, assign, remove, delete, bulk) with hierarchy and privileged-role protection
  - announcements, scheduled messages and reminders
  - final-state verification and duplicate-name refusal
- **Progression:**
  - append-only ledger (enforced by triggers) with idempotent rewards
  - message XP and aura with cooldown, duplicate detection, minimum length, diminishing returns and a daily cap
  - voice minutes with an idle/mute/solo/AFK filter and daily cap
  - daily and weekly rewards with streaks
  - daily and weekly quests
  - shop with refunds, inventory, purchase history and transfers (caps, minimum membership, idempotency)
  - levels, level roles, leaderboards, seasons and admin grants
  - data persists across restarts (tested)
- **Research and reports:** sourced digest from free sources, keeping URLs and timestamps, merging corroborating stories and reporting failed sources. Optional AI synthesis is labelled as inference. Also activity analytics (counts only), activity and moderation reports, and scheduled daily research and reports.
- **Events:** creation, Discord scheduled event (best effort), join button, reminders, exactly-once rewards, recap.
- **Music logic:** per-guild queue, mutex, single player, skip on failure, halt on repeated failures, disconnect cleanup with persisted queue, local, Internet Archive and radio search, URL safety.
- **Voice pipeline logic:** owner-only capture filter, wake word, arming, noise rejection, STT adapter with caps and circuit breaker, Groq request format (mocked HTTP), voice-moderation review, cap and debounce.
- **Optional hosted AI:** Groq adapter, validated JSON plans, daily cap, circuit breaker, graceful absence.
- **Ops:** config validation (`check:config`), live token and intent checker (`check:discord`), health report, structured logs with redaction and rotation, Windows setup, start and autostart scripts.

## 2. Awaiting live Discord verification

These are implemented against the discord.js / @discordjs/voice APIs, but have only run against mocks:

- Login of both bots, presence, and slash command registration (`npm run register`) and execution
- Real channel, role and overwrite changes and their verification, moderation actions, DMs for warnings
- Welcome cards sent on real joins, leave messages, level-up messages and roles
- Approval buttons, select menus and the event join button in the Discord client
- Voice: joining channels, DAVE-encrypted audio receive, playback into a channel, TTS into a channel, disconnect recovery
- Discord Scheduled Events creation
- Rate-limit behaviour under load

Suggested first live test, in order:

1. `npm run check:discord`
2. `npm run register`
3. `npm start`
4. `/status`
5. `/setup …`
6. `/welcome-test`
7. `ALPHA, create a test channel`
8. `/simulate`, then automod in simulation mode
9. `/play` with a file in `data\music`
10. `/listen start` (needs a Groq key)

## 3. Partially implemented or limited

- **Original welcome background:** the renderer is built to use it, but **the file does not exist on this PC**. I searched the empty project folder, Downloads, Pictures, Desktop, Documents, OneDrive and D:\. A labelled stand-in is used until `assets\welcome\background.png` is provided. The layout can be aligned with `assets\welcome\layout.json`.
- **"that member"** resolves to the last member ALPHA acted on or referred to for you, kept for 30 minutes. ALPHA cannot infer someone it hasn't seen. In that case it asks you to name them.
- **Natural language** outside the deterministic grammar needs the optional Groq key. Without it, ALPHA answers with a clarification and examples.
- **Research quality** is a ranked headline digest. Free sources have gaps: Hacker News is tech-heavy, and GDELT allows at most one request per 5 s.
- **Raid response** alerts the security log, and can optionally time out new accounts during a raid (off by default). It does not change server verification levels.

## 4. Blocked by free-tier, licensing or technical limits

- **YouTube or Spotify playback** is not implemented. Their Terms of Service prohibit extracting or rebroadcasting audio, and no free compliant API exists. "Play Blinding Lights" works only if you own the file and put it in `data\music`. Otherwise AEGIS uses licensed Internet Archive recordings or opt-in radio.
- **Hands-free speech recognition** depends on a hosted STT key (Groq free plan, no card). Without one, voice listening refuses to start. It has **not** been tested with real speech here.
- **Voice moderation** consumes free STT quota per speaker. It suits small channels, not large always-on monitoring.
- **Google News RSS** is off by default: its feed terms limit use to personal, non-commercial feed readers.
