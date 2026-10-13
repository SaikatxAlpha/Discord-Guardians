# Soul Society — 𓆩 𝐕𝐎𝐈𝐃𝐖𝐎𝐑𝐊𝐒 𓆪

Two independent Discord guardians sharing one ALPHA core, built to run free on a Windows PC.

| Guardian | Identity | Theme | Responsibilities |
|---|---|---|---|
| ⚔️ **KNIGHT** | The Guardian | violet | text & voice moderation, anti-spam/raid, escalation, cases, security logs, lockdown |
| 🛡️ **AEGIS** | The Ancient Guardian | cyan / black-silver | research, reports, channels/roles/permissions, music, schedules, events, aura economy, welcome cards, ALPHA voice |

**Budget: ₹0.** There's no local LLM, no model weights, no GPU inference, and no paid API. Hosted AI (Groq's free plan, no card) is optional. Everything core is deterministic Node.js.

## Quick start (PowerShell)

```powershell
cd "D:\VOID BOT"
npm ci                                  # install dependencies (~160 MB, no AI models)
Copy-Item .env.example .env; notepad .env   # set OWNER_ID, KNIGHT_TOKEN, AEGIS_TOKEN, DEV_GUILD_ID
npm run check:config                    # validates .env (never prints secrets)
npm run check:discord                   # verifies both tokens live + prints invite links
npm run register                        # registers slash commands for both bots
npm start                               # runs KNIGHT + AEGIS (Ctrl+C = clean shutdown)
```

Other commands:

```powershell
npm test                 # 97 automated tests (Discord-independent)
npm run lint             # ESLint static checks
npm run simulate         # end-to-end ALPHA demo on a MOCK guild (no Discord needed)
npm run render:welcome   # render sample welcome cards to data\samples\
npm run health           # health of both bots, queue, jobs, AI/STT usage
npm run backup           # consistent SQLite backup to data\backups\
npm start -- knight      # run only one guardian
```

Before the first live run, see [docs/SETUP.md](docs/SETUP.md) for creating the two Discord applications.

## Architecture

```
            ┌──────────── KNIGHT process ────────────┐   ┌──────────── AEGIS process ─────────────┐
 Discord ⇄  │ discord.js client (KNIGHT token)       │   │ discord.js client (AEGIS token)        │ ⇄ Discord
            │ automod · raid · voice moderation      │   │ welcome · XP · music · ALPHA voice     │
            │ ALPHA coordinator ─┐                   │   │ ALPHA coordinator ─┐                   │
            └────────────────────┼───────────────────┘   └────────────────────┼───────────────────┘
                                 ▼                                            ▼
                     ┌─────────────────────── shared SQLite (WAL) ──────────────────────────┐
                     │ tasks (IPC queue, leases, idempotency) · approvals · jobs/job_runs    │
                     │ ledger (append-only) · members · mod_cases · audit_log · settings     │
                     └───────────────────────────────────────────────────────────────────────┘
```

**ALPHA pipeline** ([core/coordinator.js](core/coordinator.js)): request → identity verification (Discord user ID, never the wake word) → intent resolution (deterministic [parser](core/intents/parser.js), hosted AI only as fallback) → structured plan validated against the [action registry](core/actions/registry.js) → per-action authority → target resolution & risk classification → confirmation (owner-bound, expiring buttons) → execution locally or on the other bot via the task queue → final-state verification → audit log → themed response.

**Concurrency and duplicates.** Task claims are atomic under SQLite's write lock. Tasks and rewards carry idempotency keys. Each scheduled occurrence is recorded in `job_runs` before it runs, so it executes at most once, even across crashes and restarts. Approvals change state through a single conditional `UPDATE`.

## Project layout

```
apps/        knight/ aegis/ shared/ (bot runtime) · launcher.js · register-commands.js
core/        coordinator, parser, action registry/validation/resolution, approvals, task queue,
             scheduler, auth, audit, settings, health, logger, Discord helpers
features/    welcome/ moderation/ voice/ music/ server/ progression/ intelligence/ events/
ai/          provider adapter (Groq), usage caps, circuit breaker
database/    node:sqlite wrapper + migrations
config/      env loading/validation, theme, defaults, quests, shop
assets/      fonts (OFL), welcome/ (put your original background here)
scripts/     check-config, check-discord, simulate, render-welcome, health, backup, windows/
tests/       node:test suites + MOCK Discord guild
docs/        SETUP, SECURITY, VOICE, AI, MUSIC, TROUBLESHOOTING, STATUS
```

## Documentation

- [docs/SETUP.md](docs/SETUP.md): Discord applications, intents, invites, first run
- [docs/SECURITY.md](docs/SECURITY.md): permissions, approvals, privacy, what ALPHA can never do
- [docs/VOICE.md](docs/VOICE.md): wake word, speech-to-text provider, privacy, limits
- [docs/AI.md](docs/AI.md): optional hosted AI (Groq free plan), verification and limits
- [docs/MUSIC.md](docs/MUSIC.md): lawful sources and why YouTube is not supported
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)
- [docs/STATUS.md](docs/STATUS.md): what is tested, what awaits live verification, what is blocked
