// Environment loading and validation. Secrets are only ever read from the
// environment (.env is gitignored) and are never logged.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let loaded = false;
export function loadEnv(file = path.join(ROOT, '.env')) {
  if (loaded) return;
  loaded = true;
  if (fs.existsSync(file)) process.loadEnvFile(file);
}

const SNOWFLAKE = /^\d{17,20}$/;
const TOKEN = /^[\w-]{20,}\.[\w-]{4,}\.[\w-]{20,}$/;

const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);
const int = (v, d) => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : d;
};
const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v));

/** Derive the application (client) ID from a bot token's first segment. */
export function clientIdFromToken(token) {
  if (!token || !token.includes('.')) return null;
  try {
    const id = Buffer.from(token.split('.')[0], 'base64').toString('utf8');
    return SNOWFLAKE.test(id) ? id : null;
  } catch {
    return null;
  }
}

export function getConfig(env = process.env) {
  const resolvePath = (p, d) => path.resolve(ROOT, p || d);
  const groqKey = env.GROQ_API_KEY || '';
  return {
    root: ROOT,
    ownerId: env.OWNER_ID || '',
    trustedUserIds: list(env.TRUSTED_USER_IDS),
    devGuildId: env.DEV_GUILD_ID || '',
    timezone: env.TIMEZONE || 'Asia/Kolkata',
    knight: {
      token: env.KNIGHT_TOKEN || '',
      clientId: env.KNIGHT_CLIENT_ID || clientIdFromToken(env.KNIGHT_TOKEN),
    },
    aegis: {
      token: env.AEGIS_TOKEN || '',
      clientId: env.AEGIS_CLIENT_ID || clientIdFromToken(env.AEGIS_TOKEN),
    },
    dbPath: resolvePath(env.DB_PATH, 'data/soul-society.db'),
    logDir: resolvePath(env.LOG_DIR, 'data/logs'),
    logLevel: env.LOG_LEVEL || 'info',
    backupDir: resolvePath(env.BACKUP_DIR, 'data/backups'),
    backupKeep: int(env.BACKUP_KEEP, 7),
    approvalTtlMs: int(env.APPROVAL_TTL_SECONDS, 120) * 1000,
    ai: {
      provider: (env.AI_PROVIDER || (groqKey ? 'groq' : 'none')).toLowerCase(),
      apiKey: groqKey,
      model: env.AI_MODEL || 'llama-3.1-8b-instant',
      dailyLimit: int(env.AI_DAILY_LIMIT, 300),
      timeoutMs: int(env.AI_TIMEOUT_MS, 15000),
    },
    stt: {
      provider: (env.STT_PROVIDER || (groqKey ? 'groq' : 'none')).toLowerCase(),
      apiKey: groqKey,
      model: env.STT_MODEL || 'whisper-large-v3-turbo',
      language: env.STT_LANGUAGE || 'en',
      dailyLimit: int(env.STT_DAILY_LIMIT, 1500),
      timeoutMs: int(env.STT_TIMEOUT_MS, 20000),
    },
    tts: { enabled: bool(env.TTS_ENABLED, false) },
    music: {
      localDir: env.MUSIC_DIR ? path.resolve(ROOT, env.MUSIC_DIR) : path.join(ROOT, 'data', 'music'),
      enableArchive: bool(env.MUSIC_ENABLE_ARCHIVE, true),
      enableRadio: bool(env.MUSIC_ENABLE_RADIO, false),
      idleLeaveMs: int(env.MUSIC_IDLE_LEAVE_SECONDS, 300) * 1000,
    },
    research: {
      userAgent: env.RESEARCH_USER_AGENT || 'SoulSocietyBot/1.0 (Discord community bot; contact: server owner)',
      rssFeeds: list(env.RESEARCH_RSS_FEEDS),
      enableGoogleNews: bool(env.RESEARCH_ENABLE_GOOGLE_NEWS, false),
    },
    welcome: {
      background: env.WELCOME_BACKGROUND ? path.resolve(ROOT, env.WELCOME_BACKGROUND) : '',
    },
  };
}

/**
 * Validate configuration. Never includes secret values in messages.
 * @param {ReturnType<typeof getConfig>} cfg
 * @param {{bots?: ('knight'|'aegis')[]}} opts
 */
export function validateConfig(cfg, { bots = [] } = {}) {
  const errors = [];
  const warnings = [];
  if (!cfg.ownerId) errors.push('OWNER_ID is not set (your Discord user ID). ALPHA commands will be refused.');
  else if (!SNOWFLAKE.test(cfg.ownerId)) errors.push('OWNER_ID is not a valid Discord snowflake ID.');
  for (const id of cfg.trustedUserIds) if (!SNOWFLAKE.test(id)) errors.push(`TRUSTED_USER_IDS contains an invalid ID.`);
  if (cfg.devGuildId && !SNOWFLAKE.test(cfg.devGuildId)) errors.push('DEV_GUILD_ID is not a valid snowflake.');
  for (const bot of bots) {
    const b = cfg[bot];
    const NAME = bot.toUpperCase();
    if (!b.token) errors.push(`${NAME}_TOKEN is not set.`);
    else if (!TOKEN.test(b.token)) errors.push(`${NAME}_TOKEN does not look like a Discord bot token.`);
    if (b.token && !b.clientId) errors.push(`${NAME}_CLIENT_ID could not be derived; set it explicitly.`);
  }
  if (cfg.knight.token && cfg.knight.token === cfg.aegis.token) {
    errors.push('KNIGHT_TOKEN and AEGIS_TOKEN must belong to two different Discord applications.');
  }
  if (!['none', 'groq'].includes(cfg.ai.provider)) errors.push(`AI_PROVIDER must be "none" or "groq".`);
  if (!['none', 'groq', 'mock'].includes(cfg.stt.provider)) errors.push(`STT_PROVIDER must be "none", "groq" or "mock".`);
  if (cfg.ai.provider === 'groq' && !cfg.ai.apiKey) errors.push('AI_PROVIDER=groq requires GROQ_API_KEY.');
  if (cfg.stt.provider === 'groq' && !cfg.stt.apiKey) errors.push('STT_PROVIDER=groq requires GROQ_API_KEY.');
  if (cfg.stt.provider === 'none') warnings.push('No speech-to-text provider: voice listening is disabled (slash and text ALPHA commands still work).');
  if (cfg.stt.provider === 'mock') warnings.push('STT_PROVIDER=mock: voice transcription is SIMULATED, not real.');
  if (cfg.ai.provider === 'none') warnings.push('Hosted AI disabled: deterministic intent parsing only.');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: cfg.timezone });
  } catch {
    errors.push(`TIMEZONE "${cfg.timezone}" is not a valid IANA time zone.`);
  }
  return { errors, warnings };
}
