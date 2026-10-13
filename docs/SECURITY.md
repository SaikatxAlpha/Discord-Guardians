# Security and permissions

## Identity

- **Authority is decided per server.** In each server, ALPHA natural-language and voice control is limited to that **server's owner**, plus the users and roles that server trusts (`/setup trusted`).
- The bot operator (`OWNER_ID`) has **no** special power in other people's servers unless `OPERATOR_GLOBAL_ACCESS=true` is set deliberately. The same applies to `TRUSTED_USER_IDS`.
- Identity is the Discord user ID that Discord attaches to the interaction, message or voice stream.
- "ALPHA" (or your `WAKE_WORD`) is only an activation phrase, not authentication. In voice, AEGIS captures only the streams of users allowed to use ALPHA in that server, so other members are never transcribed. One person's voice cannot act on behalf of another.
- Slash commands use Discord permissions mapped to authority levels: Member, Moderator (Timeout/Kick/Ban), Admin (Manage Server/Administrator), Trusted, Owner. Each action in [core/actions/registry.js](../core/actions/registry.js) declares the minimum level.
- Every user is limited to 8 commands per 10 seconds. Speech-to-text has deployment-wide and per-server daily caps. Music has a global cap on concurrent streams.

## Multi-server isolation

Settings, music queues, voice sessions, moderation cases, economy and usage counters are all keyed by server ID. No server ID, channel ID, role ID or user ID is hard-coded in production code (a test enforces this).

When a bot joins a server, it creates that server's settings with safe defaults: moderation in simulation mode, voice moderation off. It posts its setup guide once.

## What ALPHA can do

Only the structured actions in the registry are possible. There is no action for:

- shell commands
- JavaScript evaluation
- filesystem access
- raw SQL

Unknown keys in parameters are dropped. Values are type-checked. Settings can only be written to known paths, with the same type as their default value.

Optional hosted-AI output gets the same treatment as typed input. It's parsed as JSON, validated against the registry, and sent through authorisation and approval. An AI model cannot grant itself permission or confirm anything.

## Confirmation (approvals)

| Risk | Examples | Confirmation |
|---|---|---|
| low | create a public channel, research, music, reports | none |
| medium | timeout, assign a role, private channel | from **voice** by default (`/setup alpha confirm_medium_voice`) |
| high | kick, ban, lockdown, moderator-template role, @everyone ping | from text/voice ALPHA (slash commands are explicit) |
| critical | delete a channel or role, bulk role changes, opening a channel to @everyone, assigning a role with privileged permissions, **any ban requested by voice** | always, from any source |

Each approval:

- shows the exact operation and the resolved targets (names and IDs)
- is bound to the requester's ID, so other people's clicks are refused
- expires after `APPROVAL_TTL_SECONDS` (default 120)
- can be decided only once, which rejects duplicate or stale clicks
- re-resolves its targets at approval time, and aborts if they changed (for example, a channel was replaced by a new one with the same name)

All outcomes are written to `audit_log`.

## Moderation safeguards

These checks run before every real action ([core/discord/safety.js](../core/discord/safety.js)):

- the bot has the required permission
- the target's top role is below the bot's top role, and below the requester's (unless the requester is the owner)
- no self-moderation
- the server owner and `OWNER_ID` are protected
- protected roles are honoured
- no automatic moderation of bots, which prevents bot-to-bot loops
- administrators can't be timed out

Every attempt is recorded as a case (`mod_cases`) with its rule, points, evidence and result, including refusals and simulations. Discord-visible results are re-checked after acting: the timeout is active, the member is gone, or the ban exists.

- **Automod defaults to simulation.**
- **Quoted text and code blocks** are flagged for review, not punished.
- **Voice moderation** is off by default. Uncertain transcripts go to `/reviews`, and automatic action is capped at warn (or timeout if configured). It never kicks or bans from speech recognition.

## Uncertain input never triggers destructive actions

- **Low-confidence voice transcripts:**
  - very low: AEGIS asks you to repeat and does nothing
  - uncertain: any state-changing action needs a button confirmation
- **Typo-tolerant name matching** is never used to choose the target of high-risk actions (ban, kick, deletions, lockdown), which need an exact name, mention or ID. Voice commands never use it at all; partial-name matches add a warning and require confirmation from voice.
- **Ambiguous names** ("gaming" matching two channels) are refused with a list of candidates.

## Network and uploads

- Admin-supplied music links must be https. They are refused if their hostname resolves to a private or loopback address (SSRF protection), and they can't contain credentials.
- Welcome backgrounds must be PNG/JPG/WebP, at most 8 MB, decodable and at least 400×160, downloaded only from Discord's CDN. They are stored as `<guildId>.<ext>` under `DATA_DIR/backgrounds`.

## Channels, roles and permissions

- Names are resolved to exact IDs. Ambiguous matches ask for clarification instead of guessing.
- Non-owners can't grant permissions they don't hold in that channel (no privilege escalation).
- Only the owner can grant roles that carry Administrator. Roles with privileged permissions make an assignment critical.
- Hiding a channel from @everyone first keeps AEGIS's own access, so the bot never locks itself out.
- Integration-managed roles and roles above the bot are refused.
- Every channel, role or overwrite change is verified by re-fetching the final state.
- Announcements never ping unless `ping_everyone` is set explicitly and the bot is allowed to mention everyone.

## Secrets and data

- Tokens and keys come only from `.env`, which is gitignored along with `data/`.
- Logs pass through a redactor for Discord tokens, Groq keys and Bearer headers. A test confirms that a token printed by a running bot appears only as `[REDACTED]`.
- `npm run check:config` reports whether each secret is present, never its value.

Data handling:

- **Raw audio** is never written to disk. It stays in memory for one utterance, goes to the STT provider, then is discarded.
- **Analytics** store counts only, never message content.
- **Moderation evidence** stores up to 300 characters of the offending message in the private case log.
- The bots read only what Discord delivers to them in the server. They don't access DMs, personal files or credentials.
