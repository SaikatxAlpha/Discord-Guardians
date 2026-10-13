// Environment loading and validation. Secrets are only ever read from the
// environment (.env locally, the host's secret manager in production) and
// are never logged. Per-server settings live in the database, not here.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let loaded = false;
/**
 * Load .env for local development. Skipped when SOUL_SOCIETY_NO_DOTENV=1
 * (tests, containers that inject real environment variables).
 */
export function loadEnv(file = path.join(ROOT, '.env')) {
  if (loaded) return;
  loaded = true;
  if (process.env.SOUL_SOCIETY_NO_DOTENV === '1') return;
  if (fs.existsSync(file)) process.loadEnvFile(file);
}

const SNOWFLAKE = /^\d{17,20}$/;
const TOKEN = /^[\w-]{20,}\.[\w-]{4,}\.[\w-]{20,}$/;
export const GROQ_STT_MODELS = ['whisper-large-v3-turbo', 'whisper-large-v3'];
export const MUSIC_PROVIDER_IDS = ['audius', 'jamendo', 'archive', 'radio', 'local'];

const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);
const int = (v, d) => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : d;
};
const num = (v, d) => {
  const n = Number.parseFloat(v ?? '');
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
  const production = (env.APP_ENV || env.NODE_ENV || '').toLowerCase() === 'production';
  const dataDir = path.resolve(ROOT, env.DATA_DIR || 'data');
  const resolvePath = (p, d) => path.resolve(ROOT, p || d);
  const groqKey = env.GROQ_API_KEY || '';
  // In production DEV_GUILD_ID is ignored unless COMMAND_SCOPE=guild is set explicitly.
  const devGuildId = env.DEV_GUILD_ID || '';
  const commandScope = (env.COMMAND_SCOPE || (production || !devGuildId ? 'global' : 'guild')).toLowerCase();
  const sttLanguage = (env.STT_LANGUAGE || 'en').toLowerCase();
  return {
    root: ROOT,
    production,
    // Bot operator. Has ALPHA authority in a server only where they own it or
    // are trusted there, unless OPERATOR_GLOBAL_ACCESS=true.
    ownerId: env.OWNER_ID || '',
    trustedUserIds: list(env.TRUSTED_USER_IDS),
    operatorGlobalAccess: bool(env.OPERATOR_GLOBAL_ACCESS, false),
    devGuildId,
    commandScope,
    timezone: env.TIMEZONE || 'Asia/Kolkata',
    knight: {
      token: env.KNIGHT_TOKEN || '',
      clientId: env.KNIGHT_CLIENT_ID || clientIdFromToken(env.KNIGHT_TOKEN),
    },
    aegis: {
      token: env.AEGIS_TOKEN || '',
      clientId: env.AEGIS_CLIENT_ID || clientIdFromToken(env.AEGIS_TOKEN),
    },
    dataDir,
    dbPath: resolvePath(env.DB_PATH, path.join(dataDir, 'soul-society.db')),
    logDir: resolvePath(env.LOG_DIR, path.join(dataDir, 'logs')),
    logToFile: bool(env.LOG_TO_FILE, true),
    logLevel: env.LOG_LEVEL || 'info',
    backupDir: resolvePath(env.BACKUP_DIR, path.join(dataDir, 'backups')),
    backupKeep: int(env.BACKUP_KEEP, 7),
    approvalTtlMs: int(env.APPROVAL_TTL_SECONDS, 120) * 1000,
    healthPort: int(env.HEALTH_PORT, 0),
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
      // ISO-639-1 code, or "auto" to let Whisper detect the language.
      language: sttLanguage === 'auto' ? '' : sttLanguage,
      prompt: env.STT_PROMPT || '',
      dailyLimit: int(env.STT_DAILY_LIMIT, 1500),
      guildDailyLimit: int(env.STT_GUILD_DAILY_LIMIT, 400),
      timeoutMs: int(env.STT_TIMEOUT_MS, 15000),
      maxRetries: int(env.STT_MAX_RETRIES, 1),
    },
    voice: {
      wakeWord: (env.WAKE_WORD || 'ALPHA').trim(),
      silenceMs: int(env.VOICE_SILENCE_MS, 1100),
      maxUtteranceMs: int(env.VOICE_MAX_UTTERANCE_MS, 15000),
      // Below repeatBelow: ask the speaker to repeat. Below confirmBelow: ask
      // for confirmation before executing anything.
      repeatBelow: num(env.VOICE_REPEAT_BELOW, 0.45),
      confirmBelow: num(env.VOICE_CONFIRM_BELOW, 0.7),
      diagnostics: bool(env.VOICE_DIAGNOSTICS, false),
    },
    tts: { enabled: bool(env.TTS_ENABLED, false) },
    music: {
      providers: list(env.MUSIC_PROVIDERS || 'audius,jamendo,archive,radio,local').map((p) => p.toLowerCase()),
      audiusAppName: env.AUDIUS_APP_NAME || 'SoulSocietyGuardians',
      jamendoClientId: env.JAMENDO_CLIENT_ID || '',
      youtubeApiKey: env.YOUTUBE_API_KEY || '',
      localDir: env.MUSIC_DIR ? path.resolve(ROOT, env.MUSIC_DIR) : path.join(dataDir, 'music'),
      enableArchive: bool(env.MUSIC_ENABLE_ARCHIVE, true),
      enableRadio: bool(env.MUSIC_ENABLE_RADIO, false),
      idleLeaveMs: int(env.MUSIC_IDLE_LEAVE_SECONDS, 300) * 1000,
      maxQueue: int(env.MUSIC_MAX_QUEUE, 100),
      maxStreams: int(env.MUSIC_MAX_STREAMS, 8),
      defaultVolume: int(env.MUSIC_DEFAULT_VOLUME, 70),
    },
    research: {
      userAgent: env.RESEARCH_USER_AGENT || 'SoulSocietyBot/1.0 (Discord community bot)',
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
  if (!cfg.ownerId) warnings.push('OWNER_ID (bot operator) is not set. Each server\'s owner and its trusted users/roles still control ALPHA there.');
  else if (!SNOWFLAKE.test(cfg.ownerId)) errors.push('OWNER_ID is not a valid Discord snowflake ID.');
  for (const id of cfg.trustedUserIds) if (!SNOWFLAKE.test(id)) errors.push(`TRUSTED_USER_IDS contains an invalid ID.`);
  if (cfg.devGuildId && !SNOWFLAKE.test(cfg.devGuildId)) errors.push('DEV_GUILD_ID is not a valid snowflake.');
  if (!['global', 'guild'].includes(cfg.commandScope)) errors.push('COMMAND_SCOPE must be "global" or "guild".');
  if (cfg.commandScope === 'guild' && !cfg.devGuildId) errors.push('COMMAND_SCOPE=guild requires DEV_GUILD_ID.');
  if (cfg.production && cfg.commandScope === 'guild') warnings.push('Production with COMMAND_SCOPE=guild: slash commands will only exist in DEV_GUILD_ID.');
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
  if (cfg.stt.provider === 'groq' && !GROQ_STT_MODELS.includes(cfg.stt.model)) errors.push(`STT_MODEL must be one of: ${GROQ_STT_MODELS.join(', ')}.`);
  if (cfg.stt.language && !/^[a-z]{2}$/.test(cfg.stt.language)) errors.push('STT_LANGUAGE must be an ISO-639-1 code (e.g. en, hi) or "auto".');
  if (cfg.stt.provider === 'none') warnings.push('No speech-to-text provider: voice listening is disabled (slash and text ALPHA commands still work).');
  if (cfg.stt.provider === 'mock') warnings.push('STT_PROVIDER=mock: voice transcription is SIMULATED, not real.');
  if (cfg.production && cfg.stt.provider === 'mock') errors.push('STT_PROVIDER=mock is not allowed in production.');
  if (cfg.ai.provider === 'none') warnings.push('Hosted AI disabled: deterministic intent parsing only.');
  if (!/^[\p{L}\p{N}]{2,20}$/u.test(cfg.voice.wakeWord)) errors.push('WAKE_WORD must be a single word of 2–20 letters/digits.');
  if (!(cfg.voice.repeatBelow >= 0 && cfg.voice.repeatBelow <= cfg.voice.confirmBelow && cfg.voice.confirmBelow <= 1)) errors.push('Require 0 ≤ VOICE_REPEAT_BELOW ≤ VOICE_CONFIRM_BELOW ≤ 1.');
  for (const p of cfg.music.providers) if (!MUSIC_PROVIDER_IDS.includes(p)) errors.push(`MUSIC_PROVIDERS contains unknown provider "${p}".`);
  if (cfg.music.providers.includes('jamendo') && !cfg.music.jamendoClientId) warnings.push('Jamendo music is disabled until JAMENDO_CLIENT_ID is set (free).');
  if (cfg.healthPort && (cfg.healthPort < 1 || cfg.healthPort > 65535)) errors.push('HEALTH_PORT must be a valid TCP port.');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: cfg.timezone });
  } catch {
    errors.push(`TIMEZONE "${cfg.timezone}" is not a valid IANA time zone.`);
  }
  return { errors, warnings };
}
