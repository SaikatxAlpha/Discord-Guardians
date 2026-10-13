# Voice assistant (wake word: ALPHA)

## Pipeline

```
Discord voice (one Opus stream PER USER — never a mix)
  → speaker policy: only this server's owner and trusted users/roles are captured
  → per-packet Opus decode (opusscript, in memory) + packet arrival times
  → pauses restored as silence → 48 kHz stereo → 16 kHz mono (anti-alias FIR)
  → level normalisation, 200 ms lead / 300 ms tail padding, speech detection
  → Groq Whisper (language + short domain prompt, temperature 0, verbose_json)
  → quality gate (no-speech / hallucination / confidence)
  → wake word (strict match) → command parser → ALPHA coordinator
  → confirmation when uncertain or risky → execution → result in the alpha channel
```

Audio is never written to disk. Each utterance's buffers are released after transcription.

**Cloud STT sends the captured audio of authorised speakers to Groq for processing.** Groq states it does not retain inference data by default; Zero Data Retention can be enabled in the Groq console. Words added with `/voice settings add_word` are also sent, inside the prompt.

## What was causing mis-recognition (found and fixed 2026-10-13)

1. **The wake word was being dropped (the main cause).** Without a prompt, Whisper often omits a leading "Alpha": "Alpha, resume the music" came back as "Resume the music". The command was then ignored, or the next sentence was mis-joined. **Fix:** a short domain prompt (`buildSttPrompt`) with example commands, plus lead-in silence padding.
2. **Pauses were removed.** Discord clients stop sending packets while you pause. The old capture concatenated packets back-to-back, gluing words together. **Fix:** a pause is detected from packet arrival times (≥ 80 ms gap) and restored as silence, capped at 1.5 s.
3. **Aliasing.** Downsampling 48 kHz to 16 kHz by averaging 3 samples let 8–16 kHz content fold into the speech band. **Fix:** a 63-tap windowed-sinc low-pass filter before decimation. A test shows a 12 kHz tone is now removed, and it was not before.
4. **Second half of split commands lost.**
   - Speaking again while the previous segment was being transcribed was dropped as "busy". **Fix:** each speaker's segments are queued in order.
   - Speaking again just after a segment ended could reuse a dead stream. **Fix:** stale subscriptions are discarded.
   - "ALPHA, play" … pause … "Her by JVKE" is now joined into one command.
5. **Uncertain transcripts executed blindly.** Now:
   - confidence < `VOICE_REPEAT_BELOW` (0.45): "please repeat", nothing done
   - confidence < `VOICE_CONFIRM_BELOW` (0.7): anything that changes the server needs a button confirmation
   - Whisper's silence hallucinations ("Thank you.") and no-speech segments are ignored

## Measured effect (live Groq, `npm run benchmark:stt`)

The benchmark uses synthetic Windows-TTS speech passed through an emulated Discord transport (Opus packets, nothing sent during pauses), clean and with 15 dB noise. This is **not** a real microphone, so treat the numbers as a comparison between configurations.

**Held-out set** (`--heldout`): 10 commands that are **not** in the prompt, with no custom vocabulary, 20 clips per configuration.

| Configuration | Word error rate | Wake word detected | Correct command | Median latency |
|---|---|---|---|---|
| Old pipeline, turbo, no prompt | 16.5% | 10/20 | 9/20 | 234 ms |
| New pipeline, turbo, no prompt | 15.9% | 10/20 | 8/20 | 250 ms |
| **New pipeline, turbo, prompt (default)** | **2.9%** | **20/20** | **20/20** | 253 ms |
| New pipeline, large-v3, prompt | 2.9% | 20/20 | 20/20 | 297 ms |

The remaining 2.9% is "twenty" being written as "20", which the parser handles.

**Model choice:** `whisper-large-v3` is listed by Groq at 10.3% WER versus 12% for turbo. In this test it matched turbo, was ~45 ms slower and costs ~2.8× more on paid plans, so **turbo stays the default** (`STT_MODEL` switches it). No model guarantees perfect recognition. Accents, background noise, music in the room and unusual names still cause errors, and the confirmation gates exist for those.

## Safety rules

- **"ALPHA" is only an activation word.** The Discord user ID of the audio stream decides who is speaking. Only that server's owner and its trusted users/roles (`/setup trusted`) are transcribed at all; other members' audio is never sent anywhere.
- **Wake-word fuzziness is minimal:** the known spellings (Alpha, Alfa, Alpa), or one edit for words of 5+ letters with the same first letter. "Alphabet", "Albert" and "Elpha" do not activate.
- **No fuzzy targets for risky actions.** Bans, kicks and deletions need an exact name, mention or ID. Voice commands never use typo-tolerant name matches ("ban Bobb" is refused rather than guessed).
- **Confirmation:** bans requested by voice are always confirmed. Medium-risk voice actions (timeouts, role changes) are confirmed by default. Approvals are bound to the speaker and expire.
- **Failures:** STT errors (rate limit, daily cap, outage) pause voice commands with a notice. They never crash the bot or affect other commands.

## Configuration

| Where | Setting |
|---|---|
| `.env` | `STT_MODEL`, `STT_LANGUAGE` (ISO code or `auto`), `STT_DAILY_LIMIT` (deployment), `STT_GUILD_DAILY_LIMIT` (per server), `STT_TIMEOUT_MS`, `STT_MAX_RETRIES` (5xx/timeouts only), `WAKE_WORD`, `VOICE_SILENCE_MS`, `VOICE_REPEAT_BELOW`, `VOICE_CONFIRM_BELOW` |
| `/voice settings` | per-server language, echo of heard commands, vocabulary words (artist/game names), daily limit |
| `/voice diagnostics` | STT status and quota, listening state, connection state, and for the last 20 utterances: outcome counts, capture/STT/total ms, confidence, restored pauses, decode errors (no transcripts, no audio) |
| `/setup trusted` | who besides the server owner may use ALPHA |

Groq free-plan limits (from Groq's docs, 2026-10-13): 20 requests/min, 2,000 requests/day, 7,200 audio-seconds/hour, 28,800/day. Each request is billed as at least 10 s. Clips with no detected speech are never sent.

## Manual end-to-end test (needs a real voice channel)

Live Discord voice cannot be exercised in automated tests. After deploying:

1. `/voice diagnostics`: the STT row should be ✅ available.
2. Join a voice channel, then run `/listen start`.
3. Say "ALPHA, show the queue". Expect a 🎙️ echo with a confidence %, then the queue.
4. Say "ALPHA, play lofi beats". Expect playback from Audius.
5. Say "ALPHA, play" … pause 1 s … "lofi beats". It should still play (split command joined).
6. Say "ALPHA, create a test channel". Execute or confirm depending on the confidence shown.
7. Say "ALPHA, ban <name>". It **must** ask for confirmation, and nothing may happen until you click Approve.
8. Have a **non-trusted** member say "ALPHA, skip". Nothing should happen, and `/voice diagnostics` must show no new utterance from them.
9. Mumble or cough. Expect either nothing or "please repeat".
10. `/voice diagnostics` again: check the median STT ms and confidence.
11. Say "ALPHA, stop listening", or leave the channel. The bot should stop capturing.

## KNIGHT voice moderation (opt-in)

`/modconfig voice enabled:true`, then `/voicemod start`. KNIGHT transcribes non-exempt members using the same quota and per-server language.

- **Uncertain transcripts** go to `/reviews`.
- **Automatic action** is capped at warn, or timeout if configured; it never kicks or bans.
- **Announce it to your members.** It sends their audio to the STT provider.
