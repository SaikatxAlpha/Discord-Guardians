// Render sample welcome cards locally (no Discord needed).
// Usage: npm run render:welcome -- [displayName] [avatarUrlOrPath]
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, loadEnv, getConfig } from '../config/env.js';
import { renderWelcomePng, renderWelcomeGif, renderWelcomeMp4, fetchAvatar, findBackground } from '../features/welcome/renderer.js';

loadEnv();
const cfg = getConfig();
const name = process.argv[2] ?? 'Kurosaki Ichigo';
const src = process.argv[3] ?? 'https://cdn.discordapp.com/embed/avatars/2.png';
const avatar = /^https:/.test(src) ? await fetchAvatar(src) : fs.existsSync(src) ? fs.readFileSync(src) : null;
const background = findBackground(cfg.welcome.background);
const out = path.join(ROOT, 'data', 'samples');
fs.mkdirSync(out, { recursive: true });

console.log(`background: ${background ?? 'NOT FOUND — using stand-in (add assets/welcome/background.png)'}`);
console.log(`avatar: ${avatar ? `${avatar.length} bytes` : 'unavailable — placeholder initial'}`);
for (const [fmt, fn] of [['png', renderWelcomePng], ['gif', renderWelcomeGif], ['mp4', renderWelcomeMp4]]) {
  const t = Date.now();
  const r = await fn({ background, avatar, displayName: name });
  if (!r) {
    console.log(`${fmt}: skipped (ffmpeg not available)`);
    continue;
  }
  const file = path.join(out, `welcome-sample.${fmt}`);
  fs.writeFileSync(file, r.buffer);
  console.log(`${fmt}: ${file} ${(r.buffer.length / 1024).toFixed(0)} KB in ${Date.now() - t} ms (original bg: ${r.usedOriginal})`);
}
