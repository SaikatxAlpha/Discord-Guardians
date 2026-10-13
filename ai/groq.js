// Groq adapter (OpenAI-compatible). Groq's free plan needs no payment method
// and is rate limited (see docs/AI.md). Verified 2026-10-13:
//   https://console.groq.com/docs/rate-limits  https://console.groq.com/docs/your-data
const BASE = 'https://api.groq.com/openai/v1';

export class GroqError extends Error {
  constructor(message, status, retryAfterMs) {
    super(message);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

async function request(path, { apiKey, body, timeoutMs, fetchImpl = fetch, json = true }) {
  const res = await fetchImpl(`${BASE}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, ...(json ? { 'Content-Type': 'application/json' } : {}) },
    body: json ? JSON.stringify(body) : body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const retry = Number(res.headers.get('retry-after'));
    const text = await res.text().catch(() => '');
    throw new GroqError(`Groq HTTP ${res.status}: ${text.slice(0, 200)}`, res.status, Number.isFinite(retry) ? retry * 1000 : undefined);
  }
  return res.json();
}

export async function groqChatJson({ apiKey, model, system, user, timeoutMs = 15000, fetchImpl }) {
  const data = await request('/chat/completions', {
    apiKey,
    timeoutMs,
    fetchImpl,
    body: {
      model,
      temperature: 0,
      max_tokens: 600,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    },
  });
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new GroqError('empty completion', 502);
  return JSON.parse(content);
}

export async function groqTranscribe({ apiKey, model, wav, language, timeoutMs = 20000, fetchImpl }) {
  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'utterance.wav');
  form.append('model', model);
  form.append('response_format', 'verbose_json');
  form.append('temperature', '0');
  if (language) form.append('language', language);
  return request('/audio/transcriptions', { apiKey, timeoutMs, fetchImpl, body: form, json: false });
}
