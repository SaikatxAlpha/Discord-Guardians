# Deploying KNIGHT + AEGIS (24/7, without your PC)

The bots run as **one Docker container**. It has three parts:

- **Launcher:** `apps/launcher.js` supervises both bot processes and restarts a crashed one.
- **Database:** both bots share one SQLite database on a persistent volume.
- **Health check:** Docker restarts the container after crashes and host reboots (`restart: unless-stopped`).

Nothing is deployed until you complete the steps below on a real host and the remote health check reports **healthy**. Creating these files does not put the bots online.

## 1. Choosing a host (₹0 budget) — checked 2026-10-13

A Discord voice bot needs a process that **never sleeps**, **outbound UDP** for voice, about **512 MB–1 GB RAM**, and **persistent disk** for SQLite. No "serverless" or sleeping web tier works.

| Option | Cost | Card needed? | Fit | Limits / caveats |
|---|---|---|---|---|
| **Oracle Cloud Always Free VM** (Ubuntu, Ampere A1 ARM) | ₹0 within limits | **Yes** — identity verification only, not charged unless you upgrade; no prepaid/virtual cards | ✅ **Recommended** | ARM limit cut to **2 OCPU / 12 GB** from 18 Aug 2026. Free-only accounts' VMs can be **reclaimed if idle**: CPU 95th percentile, network and memory all under 20% over 7 days. Sign-ups are sometimes rejected and A1 capacity can be scarce. Generous outbound traffic. |
| Google Cloud `e2-micro` (us-west1/us-central1/us-east1) | ₹0 within limits | **Yes** (billing account) | ⚠️ Works for moderation/text | **Only 1 GB/month outbound** free. Music streaming (~40–50 MB/hour) and voice uploads exceed this quickly, and overage is billed. 1 GB RAM. |
| Northflank Developer Sandbox | ₹0 | **Yes** (anti-abuse verification) | ⚠️ Unverified | 2 always-on free services. Free-tier CPU/RAM, persistent volumes and UDP for voice are **not documented**; test before relying on it. |
| Render / Koyeb / Railway / Fly.io free tiers | — | — | ❌ | Render free web services sleep after 15 min, and free background workers were retired. Koyeb now needs a card with a $29 hold, and its free instance scales to zero. Railway gives only trial credit. Fly.io has no free tier for new users. |
| An always-on device you own (old laptop, Raspberry Pi 4/5, Android + Termux) | ₹0 | No | ✅ if it stays on | Independent of your Windows PC; uses home internet and power. Docker works on Pi OS / Ubuntu. |

**There is no verified free host that runs 24/7 without a card.** The realistic ₹0 path is the Oracle Always Free VM.

To reduce Oracle's idle-reclamation risk, you can upgrade the account to Pay-As-You-Go. Oracle says Always-Free usage stays at ₹0 after upgrading, and the old 4 OCPU / 24 GB allowance returns. The trade-off is that a paid account will bill anything beyond the free limits, so only create Always-Free-eligible shapes.

## 2. One-time Discord settings

For **both** applications (Developer Portal → *Bot*):

- **Privileged Gateway Intents:** enable Server Members and Message Content.
- **Public Bot:** on, if other servers should be able to invite the bots.

Invite links with the right permissions are printed by `npm run check:discord`.

## 3. Deploy on an Ubuntu VM (Oracle / any Linux VPS)

```bash
# On the VM (SSH)
sudo apt-get update && sudo apt-get install -y git
git clone https://github.com/SaikatxAlpha/Discord-Guardians.git soul-society
cd soul-society
bash scripts/deploy/setup-ubuntu.sh        # installs Docker (log out/in once, then re-run)
bash scripts/deploy/setup-ubuntu.sh        # creates .env.production from the template
nano .env.production                       # paste KNIGHT_TOKEN, AEGIS_TOKEN, optional GROQ_API_KEY …
bash scripts/deploy/setup-ubuntu.sh        # builds, checks, registers commands, starts, waits for healthy
```

The setup script:

1. Builds the image.
2. Runs `scripts/check-production.js --live`, which checks the tokens, intents, Groq and Audius without printing secrets.
3. Registers slash commands **globally**.
4. Starts the container and waits for Docker's health check to report `healthy`.

The Git repository must be **public**, or you need a deploy key/token for `git clone`.

### Environment variables (`.env.production`)

| Variable | Required | Purpose |
|---|---|---|
| `KNIGHT_TOKEN`, `AEGIS_TOKEN` | **yes** | Bot tokens (two different applications) |
| `APP_ENV=production`, `COMMAND_SCOPE=global` | yes (preset) | Global commands; `DEV_GUILD_ID` ignored |
| `GROQ_API_KEY` | optional | Voice transcription (and AI fallback). Without it voice listening is disabled, everything else works |
| `JAMENDO_CLIENT_ID` | optional | Adds Jamendo (Creative Commons) to music search — free at devportal.jamendo.com |
| `OWNER_ID` | optional | Bot operator. Has no power in other servers unless `OPERATOR_GLOBAL_ACCESS=true` |
| `STT_LANGUAGE`, `STT_MODEL`, `STT_DAILY_LIMIT`, `STT_GUILD_DAILY_LIMIT` | optional | Voice defaults and quotas |
| `MUSIC_PROVIDERS`, `MUSIC_MAX_STREAMS` | optional | Music sources and global ffmpeg cap |
| `HEALTH_PORT` | optional | HTTP `/health` endpoint for hosts that need a port |
| `DATA_DIR=/app/data` | preset | Database, backups, uploaded welcome backgrounds (the volume) |

Never commit `.env.production`. It is ignored by Git and excluded from the image by `.dockerignore`. On a PaaS, put these values in its secret manager.

## 4. Operating

```bash
docker compose ps                         # STATUS should show (healthy)
docker compose logs -f --tail=100 guardians
docker compose exec guardians node scripts/healthcheck.js
docker compose exec guardians node scripts/health.js       # queue, jobs, STT/AI usage
docker compose exec guardians node scripts/backup.js       # extra backup (daily one is automatic)
# Update to the latest code (data volume is kept):
git pull && docker compose up -d --build
# Re-register commands after changing them:
docker compose run --rm guardians node apps/register-commands.js
```

**Persistence:** the named volume `guardians-data` holds `/app/data`. It survives `docker compose down`, `up --build` and image updates. Only `docker compose down -v` deletes it, so don't use `-v`.

To copy a backup off the VM:

```bash
docker compose cp guardians:/app/data/backups ./backups
```

**Moving your existing local data to the server** (optional):

1. Stop the bots on your PC.
2. Copy `data\soul-society.db` to the VM, e.g. `scp data/soul-society.db ubuntu@VM:~/`.
3. On the VM, run the commands below:

```bash
docker compose stop
docker compose cp ~/soul-society.db guardians:/app/data/soul-society.db
docker compose start
```

**Don't run the bots in two places.** Stop `npm start` on your PC once the server is live. Two copies with the same tokens would both answer every event.

**Development vs production commands:** if you previously registered commands only in your dev server, clear them so they aren't listed twice:

```bash
# On your PC, with DEV_GUILD_ID in .env
npm run register -- --clear-guild
```

## 5. Verify the deployment (required before calling it "online")

1. `docker compose ps` shows **healthy**.
2. `/status` in Discord shows both guardians online.
3. Invite the bots to a **second** server, check that a setup guide appears there, and run `/settings view`.
4. Reboot the VM (`sudo reboot`). After it comes back, `docker compose ps` should be healthy again without manual action.
5. Optional: `docker compose down && docker compose up -d`, then confirm aura balances and settings are unchanged (persistence).

## 6. Troubleshooting (deployment)

| Symptom | Cause / fix |
|---|---|
| `unhealthy` right after start | Startup takes up to 90 s. Then check `docker compose logs`. Usually a token or intent problem; `check-production --live` names it. |
| `Used disallowed intents` | Enable both privileged intents for that application. |
| Music never starts, voice joins fail | Outbound **UDP** blocked by the host. On Oracle, the default egress rules allow it; check VCN egress rules and any `ufw` rules. |
| Container restarts repeatedly | `docker compose logs`. The launcher stops restarting a bot after 6 quick crashes. |
| `npm ci` fails on ARM during build | Make sure the VM is 64-bit (`uname -m` → `aarch64`/`x86_64`). All native packages ship ARM64 and x64 builds. |
| Out of memory on 1 GB VMs | Lower `MUSIC_MAX_STREAMS`, or use a VM with ≥ 2 GB. |
| Commands missing in a new server | Global commands can take a few minutes. Re-invite with the `applications.commands` scope. |
