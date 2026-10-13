// Structured JSON logging with secret redaction and size-based rotation.
import fs from 'node:fs';
import path from 'node:path';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MAX_LOG_BYTES = 5 * 1024 * 1024;

const SECRET_PATTERNS = [
  /[MNO][\w-]{23,27}\.[\w-]{6}\.[\w-]{27,40}/g, // Discord bot tokens
  /gsk_[A-Za-z0-9]{20,}/g, // Groq keys
  /(Bearer|Bot)\s+[A-Za-z0-9._-]{16,}/g,
];

export function redact(text) {
  let out = String(text);
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[REDACTED]');
  return out;
}

function serialize(value) {
  if (value instanceof Error) return { name: value.name, message: redact(value.message), code: value.code, stack: redact(value.stack || '') };
  return value;
}

export function createLogger(name, { dir, level = 'info', console: toConsole = true } = {}) {
  const min = LEVELS[level] ?? LEVELS.info;
  let stream = null;
  let file = null;
  if (dir) {
    fs.mkdirSync(dir, { recursive: true });
    file = path.join(dir, `${name.toLowerCase()}.log`);
    stream = fs.createWriteStream(file, { flags: 'a' });
  }

  function rotate() {
    try {
      if (file && fs.statSync(file).size > MAX_LOG_BYTES) {
        stream.end();
        fs.renameSync(file, `${file}.1`);
        stream = fs.createWriteStream(file, { flags: 'a' });
      }
    } catch {
      /* rotation is best effort */
    }
  }

  function write(lvl, msg, meta) {
    if (LEVELS[lvl] < min) return;
    const entry = { ts: new Date().toISOString(), level: lvl, bot: name, msg };
    if (meta && typeof meta === 'object') {
      for (const [k, v] of Object.entries(meta)) entry[k] = serialize(v);
    }
    const line = redact(JSON.stringify(entry));
    if (toConsole) (lvl === 'error' || lvl === 'warn' ? process.stderr : process.stdout).write(line + '\n');
    if (stream) {
      stream.write(line + '\n');
      rotate();
    }
  }

  return {
    debug: (m, meta) => write('debug', m, meta),
    info: (m, meta) => write('info', m, meta),
    warn: (m, meta) => write('warn', m, meta),
    error: (m, meta) => write('error', m, meta),
    child(sub) {
      return createLogger(`${name}:${sub}`, { level, console: toConsole });
    },
    close: () => new Promise((r) => (stream ? stream.end(r) : r())),
  };
}

/** Logger that records entries in memory; used by tests. */
export function memoryLogger() {
  const entries = [];
  const mk = (level) => (msg, meta) => entries.push({ level, msg, ...meta });
  const l = { entries, debug: mk('debug'), info: mk('info'), warn: mk('warn'), error: mk('error'), close: async () => {} };
  l.child = () => l;
  return l;
}
