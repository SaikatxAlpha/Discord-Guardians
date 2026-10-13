# Original Soul Society welcome background

Put your **original** welcome artwork here as `background.png` (or `.jpg` / `.jpeg` / `.webp`).

- It is drawn **as-is** (cover-fitted to 1200×500) — the bot never repaints or replaces it.
- It must **not** contain a baked-in avatar, username or member count; those are rendered dynamically.
- Until the file exists, a clearly labelled procedural stand-in in the same violet/cyan palette is used.

When this project was set up, no Soul Society background existed anywhere on the PC
(the project folder was empty, and Downloads, Pictures, Desktop, Documents, OneDrive and D:\ were searched),
so the stand-in is currently active.

## Aligning with your artwork (optional)

If your artwork has its own frame or empty space for the avatar, create `layout.json` here
(all values are fractions of the card width/height):

```json
{ "avatarX": 0.5, "avatarY": 0.4, "avatarRadius": 0.2, "nameY": 0.745, "taglineY": 0.86, "showServerName": true }
```

Preview with `npm run render:welcome` (writes to `data/samples/`) or `/welcome-test` in Discord.
