# Setup

## 1. Requirements

- Windows 10/11, **Node.js 22.13+** (this PC has v22.21.0). SQLite is built into Node, so no database server is needed.
- About 160 MB for `node_modules`. This includes ffmpeg (about 80 MB, used for music, spoken replies and MP4 welcome cards). No AI models are downloaded.

```powershell
cd "D:\VOID BOT"
npm ci
```

## 2. Create two Discord applications

KNIGHT and AEGIS are **separate applications** with separate tokens, names and avatars.

For **each** bot, at https://discord.com/developers/applications:

1. **New Application.** Name it `KNIGHT` (then do the same for `AEGIS`).
2. **General Information:** set the avatar (KNIGHT violet, AEGIS cyan/black-silver) and a description.
3. **Bot:**
   - Click **Reset Token** and copy the token into `.env` (`KNIGHT_TOKEN=` / `AEGIS_TOKEN=`).
   - Turn **Public Bot** off.
   - Under *Privileged Gateway Intents*, enable **Server Members Intent** and **Message Content Intent**. Presence is not needed.
4. Invite the bot. `npm run check:discord` prints a ready-made invite link with the right permissions for each bot.

Permissions requested by the invite links:

| KNIGHT | AEGIS |
|---|---|
| View Channels, Send Messages, Embed Links, Read History, Manage Messages, Timeout Members, Kick, Ban, Manage Roles, Manage Channels, Connect, View Audit Log | View Channels, Send Messages, Embed Links, Attach Files, Read History, Manage Channels, Manage Roles, Manage Events, Mention Everyone, Connect, Speak, Use Application Commands |

**Role order matters.** In *Server Settings → Roles*, drag the KNIGHT and AEGIS roles **above** every role they should moderate or assign. Keep them **below** your admin/owner roles. Neither bot needs Administrator, and they work without it.

## 3. Configure `.env`

```powershell
Copy-Item .env.example .env
notepad .env
```

Minimum settings:

- `OWNER_ID`: your user ID. In Discord, enable Developer Mode (*Settings → Advanced*), then right-click your name → *Copy User ID*.
- `KNIGHT_TOKEN`, `AEGIS_TOKEN`: one token per application.
- `DEV_GUILD_ID`: your server's ID (right-click the server icon → *Copy Server ID*). With this set, slash commands appear instantly in that server.

Optional settings:

- `GROQ_API_KEY`: enables ALPHA voice transcription and the AI fallback interpreter. See [AI.md](AI.md).

Then run:

```powershell
npm run check:config
npm run check:discord
npm run register
```

## 4. Original welcome background

Copy your original Soul Society artwork to `assets\welcome\background.png`. Preview it with `npm run render:welcome` or `/welcome-test`. See [assets/welcome/README.md](../assets/welcome/README.md).

## 5. First run and server configuration

```powershell
npm start
```

In Discord, as the owner:

1. Assign AEGIS's channels:
   - `/setup channel purpose:welcome channel:#welcome`
   - Repeat for `research`, `reports`, `announcements`, `alpha` (where ALPHA posts results and approvals) and `music`.
2. Assign KNIGHT's log channels with `/modconfig logs security_log:#security mod_log:#mod-cases`. Make these channels private.
3. KNIGHT starts in **simulation mode**: automod logs what it *would* do and takes no action. Watch the mod log for a while, then switch to enforcement with `/modconfig simulate enabled:false`.
4. Test ALPHA by typing `ALPHA, help` in the alpha channel, or use `/alpha command:help`.
5. Optional voice: join a voice channel, then `/listen start` (requires `GROQ_API_KEY`).

## 6. Run automatically (optional)

```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows\install-autostart.ps1
```

This creates a per-user Scheduled Task that runs `npm start` at logon. Remove it with `Unregister-ScheduledTask -TaskName SoulSociety -Confirm:$false`.
