// Validate .env without printing any secret values.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, loadEnv, getConfig, validateConfig } from '../config/env.js';
import { findBackground, ffmpegPath } from '../features/welcome/renderer.js';

loadEnv();
const cfg = getConfig();
const { errors, warnings } = validateConfig(cfg, { bots: ['knight', 'aegis'] });
const mark = (ok) => (ok ? 'OK  ' : 'MISSING');
console.log('Soul Society configuration check (secrets are never printed)\n');
console.log(`.env file ............ ${mark(fs.existsSync(path.join(ROOT, '.env')))}`);
console.log(`OWNER_ID ............. ${mark(Boolean(cfg.ownerId))}`);
console.log(`KNIGHT_TOKEN ......... ${mark(Boolean(cfg.knight.token))}  client id: ${cfg.knight.clientId ?? '—'}`);
console.log(`AEGIS_TOKEN .......... ${mark(Boolean(cfg.aegis.token))}  client id: ${cfg.aegis.clientId ?? '—'}`);
console.log(`DEV_GUILD_ID ......... ${cfg.devGuildId || '(global command registration)'}`);
console.log(`Hosted AI ............ ${cfg.ai.provider}${cfg.ai.provider !== 'none' ? ` (${cfg.ai.model}, ${cfg.ai.dailyLimit}/day cap)` : ''}`);
console.log(`Speech-to-text ....... ${cfg.stt.provider}${cfg.stt.provider === 'groq' ? ` (${cfg.stt.model}, ${cfg.stt.dailyLimit}/day cap)` : ''}`);
console.log(`Windows TTS .......... ${cfg.tts.enabled ? 'enabled' : 'disabled'}`);
console.log(`Welcome background ... ${findBackground(cfg.welcome.background) ?? 'NOT FOUND (stand-in will be used) → assets/welcome/background.png'}`);
console.log(`ffmpeg ............... ${ffmpegPath() ?? 'NOT FOUND (music, TTS and MP4 cards disabled)'}`);
console.log(`Music folder ......... ${cfg.music.localDir} ${fs.existsSync(cfg.music.localDir) ? '' : '(does not exist yet)'}`);
console.log(`Database ............. ${cfg.dbPath}`);
console.log(`Time zone ............ ${cfg.timezone}\n`);
for (const w of warnings) console.log(`warning: ${w}`);
for (const e of errors) console.log(`ERROR:   ${e}`);
console.log(errors.length ? '\nConfiguration has errors.' : '\nConfiguration is valid.');
process.exit(errors.length ? 1 : 0);
