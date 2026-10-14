# Setup

## 1. Requirements

- Windows 10/11, **Node.js 22.13+** (this PC has v22.21.0). SQLite is built into Node, so no database server is needed.
- About 160 MB for `node_modules`. This includes ffmpeg-static (about 80 MB, optional: used for MP4 welcome cards, Windows spoken replies and non-MP3/Opus music). Music works without it through the built-in WebAssembly MP3/Opus decoder. No AI models are downloaded.

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

- `KNIGHT_TOKEN`, `AEGIS_TOKEN`: one token per application.
- `DEV_GUILD_ID` (development only): your test server's ID (right-click the server icon → *Copy Server ID*). With this set, slash commands appear instantly in that server. Production registers commands globally and ignores it.
- `OWNER_ID` (optional): your user ID as the bot operator (enable Developer Mode in *Settings → Advanced*, then right-click your name → *Copy User ID*). You don't need it to control ALPHA in **your own** server: every server's owner automatically controls ALPHA there, and owners can trust others with `/setup trusted`.

For running 24/7 on a server instead of your PC, see [DEPLOYMENT.md](DEPLOYMENT.md).

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

### Welcome message on the card

`/setup welcome message:` is drawn **inside** the card, in a panel under the tagline. Real joins and `/welcome-test` use exactly the same card.

- **Placeholders:** `{mention}` (shown as @name on the card; it also pings the member in the post), `{name}`, `{username}`, `{server}`, `{count}`.
- **Line breaks:** type `\n`, because slash-command options can't contain real new lines.
- **Formatting:** `**bold**`, `*italic*`, `__underline__`, `~~strike~~`, `` `code` ``, `# heading`, `> quote`, `- bullet`, emoji and custom server emoji.

Example: `# Welcome, {mention}!\nYou are soul **#{count}** of {server} 💜\n- Read #rules\n- Grab your roles`

Long messages shrink (32 → 18 px) and wrap, up to 6 lines. Text beyond that is shortened with "…", and `/welcome-test` warns you when that happens.

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
