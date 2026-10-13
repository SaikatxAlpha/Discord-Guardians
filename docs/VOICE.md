# Voice: wake word ALPHA

## How it works

1. You join a voice channel and run `/listen start`. AEGIS joins (not deafened) and posts a listening notice. Its status changes to "🎙️ Listening for ALPHA".
2. AEGIS subscribes **only** to the owner's and trusted users' audio streams. Discord tells the bot which user each audio stream belongs to, and that user ID is what authorises the command.
3. Each utterance (speech ending with about 0.9 s of silence, at most 15 s) is decoded from Opus to 16 kHz mono WAV in memory.
4. The WAV is sent to the speech-to-text provider. If the transcript starts with "ALPHA" (also matches alfa, "hey alpha", "um, alpha"), the rest is treated as the command.
   - Saying just "ALPHA" arms the next utterance for 8 seconds.
5. The command goes through the same ALPHA pipeline as typed commands. Confirmation rules are stricter for voice: medium-risk actions ask by default, and bans are always critical.
6. The result is posted in the alpha channel. With `TTS_ENABLED=true` and `/setup alpha speak:true`, AEGIS also speaks a short summary using the Windows speech engine; music is paused during speech.
7. To stop: say "ALPHA, stop listening", run `/listen stop`, or leave the voice channel.

## Speech-to-text provider

| Provider | Status |
|---|---|
| **Groq Whisper** (`whisper-large-v3-turbo`) | Integrated. Free plan, no payment method. Limits checked 2026-10-13: 20 requests/min, 2,000 requests/day, 7,200 audio-seconds/hour, 28,800/day. **Not yet live-tested**: no key was available in this environment. |
| `mock` | Scripted transcripts for tests and `npm run simulate`. **Does not recognise speech.** |
| `none` (default without a key) | Voice listening refuses to start and says why. Slash and typed ALPHA commands still work. |

Privacy: Groq says it does not retain inference data by default; you can enable Zero Data Retention in its console. Audio does leave your PC, so tell your members.

Quota: every owner utterance uses one request, including speech without the wake word, because the wake word is detected from the transcript. `STT_DAILY_LIMIT` (default 1,500) caps usage locally. When the cap is reached, or Groq returns 429, voice pauses and AEGIS posts a notice. It never switches to a paid service.

### Swapping the provider

Implement a class with `available()`, `status()` and `async transcribe(wav, { durationMs }) → { text, confidence, provider }`, and return it from `createSTT()` in [features/voice/stt.js](../features/voice/stt.js). Nothing else needs to change.

## Voice moderation (KNIGHT)

This feature is opt-in and you should announce it to members.

1. Enable it with `/modconfig voice enabled:true`.
2. Run `/voicemod start` in your voice channel. KNIGHT joins with its own connection, listening and muted.

It transcribes non-bot, non-exempt speakers (never the owner) and runs the profanity filter:

- **Confidence below `min_confidence`** (default 0.75): the transcript goes to `/reviews`. No action is taken.
- **Confident matches**: escalation points are added, with a 60 s debounce per user. The automatic action is capped at **warn**, or **timeout** if configured. It never kicks or bans.

Each speaker uses STT quota, so voice moderation of a busy channel can use up Groq's free daily allowance quickly.

## What has and has not been verified

- ✅ Tested offline:
  - wake-word detection
  - owner-only filtering, before any audio reaches STT
  - arming
  - noise, short and long clip rejection
  - STT errors, daily cap and circuit breaker
  - WAV/PCM conversion
  - Groq request format (mocked HTTP)
  - voice-moderation review, cap and debounce logic
  - Windows TTS synthesis (produced a real WAV on this PC)
- ✅ Installed and detected: `@discordjs/voice` 0.19.2 with DAVE end-to-end encryption (`@snazzah/davey`), the Opus codec (`opusscript`), native AES-GCM, and ffmpeg 6.1.1 with libopus.
- ⏳ **Needs live verification**: joining voice, receiving Opus from Discord, real Groq transcription and playing TTS into a channel. These need both bot tokens, a test server and a Groq key.
