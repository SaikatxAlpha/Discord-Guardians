# Optional hosted AI

## Default: no AI

Without `GROQ_API_KEY`, everything runs on deterministic logic:

- The [intent parser](../core/intents/parser.js) covers channels, roles and permissions, moderation, music, research, reports, schedules, reminders, events, economy grants, help and status, including compound instructions and "that channel" / "that member" references.
- Slash commands cover every feature.
- Research produces a sourced, ranked digest without AI.

No local LLM, model weights or GPU are used at any point.

## Provider: Groq (free plan)

Verified on 2026-10-13 from Groq's own docs:

- **No payment method required.** The free plan is active on sign-up and limited by rate limits, not credits. ([rate limits](https://console.groq.com/docs/rate-limits))
- **Chat models** (e.g. `llama-3.1-8b-instant`, `openai/gpt-oss-20b`): about 30 requests/min, 1,000 requests/day, 8K tokens/min, 200K tokens/day.
- **Whisper**: 20 requests/min, 2,000 requests/day, 28,800 audio-seconds/day.
- **Data:** "By default, Groq does not retain customer data for inference requests". Zero Data Retention can be enabled in the console. ([your data](https://console.groq.com/docs/your-data))

These are third-party terms and can change. Re-check them before relying on them.

Rejected alternatives:

- **Gemini's free tier** uses prompts to improve Google's products, so it's a worse privacy fit.
- **Deepgram and AssemblyAI** offer time-limited credits (trials).
- **Ollama and other local models** are excluded by the budget and disk rules.

## How it is used

1. **Fallback interpreter.** It's called only when the deterministic parser can't understand an ALPHA instruction. The model receives the action catalogue (names and parameter types only, with no server data) and must answer with JSON steps. [`sanitizePlan`](../ai/index.js) rejects unknown actions and invalid parameters. Valid steps still go through authorisation, risk classification and confirmation.
2. **Research synthesis.** It's optional and only runs over the retrieved items. The output is labelled *"AI synthesis — inference from the items above; verify before relying on it"*, shown next to the sourced links.
3. **Speech-to-text.** Whisper, for ALPHA voice; see [VOICE.md](VOICE.md).

## Limits and failure handling

- `AI_DAILY_LIMIT` (default 300) and `STT_DAILY_LIMIT` (default 1,500) are enforced locally in `provider_usage`, below Groq's own limits.
- On a 429 response or repeated errors, a circuit breaker pauses the provider. It honours `retry-after`, with a minimum of 5 minutes for chat and 2 for STT.
- When AI is unavailable, deterministic parsing continues, and the bot never switches to a paid provider.
- `/status` and `npm run health` show today's usage and breaker state.

## Changing provider

Add a class with `available()`, `status()`, `planCommand(text)` and `summarize(query, items)` in `ai/`, and return it from `createAI()`. Keep `sanitizePlan` on its output.
