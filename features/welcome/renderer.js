// Soul Society welcome card renderer.
//
// The ORIGINAL artwork is loaded from assets/welcome/background.(png|jpg|jpeg|webp)
// (or WELCOME_BACKGROUND) and drawn cover-fitted without repainting it. Only
// the dynamic layers are drawn on top: spirit particles, the glowing avatar
// frame, the member's real avatar and display name, and the tagline. If the
// original file is missing, the built-in procedural design in the same
// palette is used. Servers can upload their own background (/setup welcome).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas';
import gifenc from 'gifenc';
import { ROOT } from '../../config/env.js';
import { SERVER_NAME } from '../../config/defaults.js';
import { layoutMessage, drawMessage } from './richText.js';
import { detectFfmpeg } from '../music/audioEngine.js';

export const CARD_W = 1200;
export const CARD_H = 500;
export const TAGLINE = 'HAS ENTERED SOUL SOCIETY';
export const DISCORD_FILE_LIMIT = 9.5 * 1024 * 1024;

const { GIFEncoder, quantize, applyPalette } = gifenc;

const VIOLET = '#a855f7';
const VIOLET_DEEP = '#6d28d9';
const CYAN = '#22d3ee';

const DEFAULT_LAYOUT = { avatarX: 0.5, avatarY: 0.4, avatarRadius: 0.2, nameY: 0.745, taglineY: 0.86, showServerName: true };

let fontsReady = false;
export function registerFonts() {
  if (fontsReady) return;
  fontsReady = true;
  const dir = path.join(ROOT, 'assets', 'fonts');
  const fonts = [
    ['Cinzel-Black.ttf', 'Cinzel'],
    ['Cinzel-Bold.ttf', 'Cinzel'],
    ['Rajdhani-Bold.ttf', 'Rajdhani'],
    ['Rajdhani-SemiBold.ttf', 'Rajdhani'],
    // Bundled so names like "𓆩 𝐕𝐎𝐈𝐃𝐖𝐎𝐑𝐊𝐒 𓆪" render on Linux hosts too.
    ['NotoSansEgyptianHieroglyphs-Regular.ttf', 'Noto Sans Egyptian Hieroglyphs'],
    ['NotoSansMath-Regular.ttf', 'Noto Sans Math'],
    // Monochrome emoji so emoji in welcome messages render on hosts without an emoji font.
    ['NotoEmoji.ttf', 'Noto Emoji'],
  ];
  for (const [file, family] of fonts) {
    const p = path.join(dir, file);
    if (fs.existsSync(p)) GlobalFonts.registerFromPath(p, family);
  }
}

// Fallback chain covers CJK, symbols, hieroglyphs (𓆩 𓆪) and emoji on Windows.
const NAME_FONT = (px) => `bold ${px}px Rajdhani, "Segoe UI", "Segoe UI Symbol", "Segoe UI Historic", "Noto Sans Math", "Noto Sans Egyptian Hieroglyphs", "Yu Gothic UI", "Microsoft YaHei UI", "Malgun Gothic", "Nirmala UI", "Noto Sans CJK SC", "Segoe UI Emoji", "Noto Color Emoji", "DejaVu Sans", sans-serif`;
const TITLE_FONT = (px) => `900 ${px}px Cinzel, "Segoe UI", "DejaVu Serif", serif`;
const MESSAGE_FONT = (style, px) =>
  `${style.italic ? 'italic ' : ''}${style.bold ? 700 : 600} ${px}px ${style.code ? '"Cascadia Mono", "DejaVu Sans Mono", monospace, ' : ''}Rajdhani, "Segoe UI", "Segoe UI Symbol", "Noto Sans Math", "Noto Sans Egyptian Hieroglyphs", "Yu Gothic UI", "Microsoft YaHei UI", "Nirmala UI", "Segoe UI Emoji", "Noto Color Emoji", "Noto Emoji", "DejaVu Sans", sans-serif`;
const MESSAGE_COLORS = { text: '#ede9fe', bold: '#ffffff', code: '#a5f3fc', glow: '#a855f7' };
const SMALL_FONT = (px) => `600 ${px}px "Segoe UI Historic", "Segoe UI Symbol", "Cambria Math", "Noto Sans Math", "Noto Sans Egyptian Hieroglyphs", "Segoe UI", "Noto Color Emoji", "DejaVu Sans", sans-serif`;

export function findBackground(explicit) {
  const candidates = [explicit, ...['png', 'jpg', 'jpeg', 'webp'].map((e) => path.join(ROOT, 'assets', 'welcome', `background.${e}`))].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

export function loadLayout() {
  const p = path.join(ROOT, 'assets', 'welcome', 'layout.json');
  if (!fs.existsSync(p)) return { ...DEFAULT_LAYOUT };
  try {
    const custom = JSON.parse(fs.readFileSync(p, 'utf8'));
    const out = { ...DEFAULT_LAYOUT };
    for (const k of Object.keys(DEFAULT_LAYOUT)) if (typeof custom[k] === typeof DEFAULT_LAYOUT[k]) out[k] = custom[k];
    return out;
  } catch {
    return { ...DEFAULT_LAYOUT };
  }
}

/** Remove control/bidi/zero-width characters and clamp length (by grapheme). */
export function sanitizeDisplayName(name, max = 32) {
  let s = String(name ?? '')
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex -- stripping control characters is the point
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const graphemes = [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(s)].map((g) => g.segment);
  if (graphemes.length > max) s = graphemes.slice(0, max - 1).join('') + '…';
  return s || 'New Soul';
}

/** Download an avatar with timeout and size limit. Returns Buffer or null. */
export async function fetchAvatar(url, { timeoutMs = 8000, maxBytes = 5 * 1024 * 1024, fetchImpl = fetch } = {}) {
  if (!url || !/^https:\/\//.test(url)) return null;
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > 0 && buf.length <= maxBytes ? buf : null;
  } catch {
    return null;
  }
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function drawCover(ctx, img, w, h) {
  const scale = Math.max(w / img.width, h / img.height);
  const dw = img.width * scale;
  const dh = img.height * scale;
  ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

/** Procedural stand-in used ONLY when the original background file is missing. */
export function drawFallbackBackground(ctx, w, h) {
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, '#07020f');
  g.addColorStop(0.5, '#160a2e');
  g.addColorStop(1, '#050210');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  const rand = mulberry32(7);
  const nebula = [
    [0.18, 0.3, 0.45, 'rgba(109,40,217,0.45)'],
    [0.82, 0.7, 0.5, 'rgba(34,211,238,0.22)'],
    [0.55, 0.15, 0.35, 'rgba(168,85,247,0.30)'],
    [0.35, 0.85, 0.4, 'rgba(76,29,149,0.40)'],
  ];
  for (const [x, y, r, c] of nebula) {
    const rg = ctx.createRadialGradient(x * w, y * h, 0, x * w, y * h, r * w);
    rg.addColorStop(0, c);
    rg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = rg;
    ctx.fillRect(0, 0, w, h);
  }
  // Distant spirit-gate silhouette.
  ctx.save();
  ctx.globalAlpha = 0.35;
  ctx.fillStyle = '#0d0420';
  const gx = w * 0.5;
  const gy = h * 0.98;
  ctx.fillRect(gx - w * 0.33, gy - h * 0.62, w * 0.04, h * 0.62);
  ctx.fillRect(gx + w * 0.29, gy - h * 0.62, w * 0.04, h * 0.62);
  ctx.beginPath();
  ctx.moveTo(gx - w * 0.4, gy - h * 0.66);
  ctx.quadraticCurveTo(gx, gy - h * 0.74, gx + w * 0.4, gy - h * 0.66);
  ctx.lineTo(gx + w * 0.4, gy - h * 0.6);
  ctx.quadraticCurveTo(gx, gy - h * 0.68, gx - w * 0.4, gy - h * 0.6);
  ctx.fill();
  ctx.fillRect(gx - w * 0.36, gy - h * 0.53, w * 0.72, h * 0.03);
  ctx.restore();
  for (let i = 0; i < 160; i++) {
    ctx.fillStyle = `rgba(255,255,255,${0.15 + rand() * 0.5})`;
    ctx.fillRect(rand() * w, rand() * h, rand() < 0.9 ? 1 : 2, rand() < 0.9 ? 1 : 2);
  }
  ctx.save();
  ctx.globalAlpha = 0.5;
  ctx.font = SMALL_FONT(Math.round(h * 0.028));
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.textAlign = 'right';
  ctx.restore();
}

// h is the hero height the layout refers to; fullH (>= h) also covers the message panel area.
function drawAtmosphere(ctx, w, h, layout, fullH = h) {
  // Readability vignette that keeps the original art visible.
  const v = ctx.createRadialGradient(w / 2, h / 2, h * 0.3, w / 2, h / 2, w * 0.75);
  v.addColorStop(0, 'rgba(5,2,16,0)');
  v.addColorStop(1, 'rgba(5,2,16,0.72)');
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, w, fullH);
  const band = ctx.createLinearGradient(0, h * 0.62, 0, h);
  band.addColorStop(0, 'rgba(8,3,20,0)');
  band.addColorStop(1, 'rgba(8,3,20,0.75)');
  ctx.fillStyle = band;
  ctx.fillRect(0, h * 0.62, w, fullH - h * 0.62);
  // Spirit glow behind the avatar.
  const ax = layout.avatarX * w;
  const ay = layout.avatarY * h;
  const glow = ctx.createRadialGradient(ax, ay, 0, ax, ay, h * 0.42);
  glow.addColorStop(0, 'rgba(168,85,247,0.35)');
  glow.addColorStop(0.5, 'rgba(34,211,238,0.10)');
  glow.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, fullH);
}

function makeParticles(seed, count) {
  const rand = mulberry32(seed);
  return Array.from({ length: count }, () => ({
    x: rand(),
    y: rand(),
    r: 0.6 + rand() * 2.4,
    speed: 0.15 + rand() * 0.5,
    phase: rand(),
    drift: (rand() - 0.5) * 0.04,
    cyan: rand() < 0.4,
  }));
}

function drawParticles(ctx, w, h, particles, t) {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const p of particles) {
    const y = (((p.y - t * p.speed) % 1) + 1) % 1;
    const x = p.x + Math.sin((t + p.phase) * Math.PI * 2) * p.drift;
    const tw = 0.45 + 0.55 * Math.abs(Math.sin((t * 2 + p.phase) * Math.PI));
    const r = p.r * (w / 1200);
    const g = ctx.createRadialGradient(x * w, y * h, 0, x * w, y * h, r * 4);
    const c = p.cyan ? '34,211,238' : '168,85,247';
    g.addColorStop(0, `rgba(${c},${0.9 * tw})`);
    g.addColorStop(1, `rgba(${c},0)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x * w, y * h, r * 4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawFrame(ctx, cx, cy, R, t, scale) {
  ctx.save();
  // Outer neon ring with glow.
  const ring = ctx.createLinearGradient(cx - R, cy - R, cx + R, cy + R);
  ring.addColorStop(0, VIOLET);
  ring.addColorStop(0.5, '#e9d5ff');
  ring.addColorStop(1, CYAN);
  ctx.shadowColor = VIOLET;
  ctx.shadowBlur = 30 * scale * (0.85 + 0.15 * Math.sin(t * Math.PI * 2));
  ctx.lineWidth = 7 * scale;
  ctx.strokeStyle = ring;
  ctx.beginPath();
  ctx.arc(cx, cy, R + 8 * scale, 0, Math.PI * 2);
  ctx.stroke();
  ctx.shadowColor = CYAN;
  ctx.shadowBlur = 18 * scale;
  ctx.lineWidth = 2 * scale;
  ctx.strokeStyle = 'rgba(34,211,238,0.85)';
  ctx.beginPath();
  ctx.arc(cx, cy, R + 20 * scale, 0, Math.PI * 2);
  ctx.stroke();
  // Rotating spirit arcs.
  ctx.shadowBlur = 14 * scale;
  const rot = t * Math.PI * 2;
  for (let i = 0; i < 3; i++) {
    const a = rot + (i * Math.PI * 2) / 3;
    ctx.strokeStyle = i % 2 ? CYAN : VIOLET;
    ctx.shadowColor = ctx.strokeStyle;
    ctx.lineWidth = 3.5 * scale;
    ctx.beginPath();
    ctx.arc(cx, cy, R + 34 * scale, a, a + 0.9);
    ctx.stroke();
  }
  for (let i = 0; i < 4; i++) {
    const a = -rot * 0.6 + (i * Math.PI) / 2;
    ctx.fillStyle = '#e0f2fe';
    ctx.shadowColor = CYAN;
    ctx.beginPath();
    ctx.arc(cx + Math.cos(a) * (R + 34 * scale), cy + Math.sin(a) * (R + 34 * scale), 3 * scale, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawAvatar(ctx, cx, cy, R, avatarImg, name) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  if (avatarImg) {
    ctx.drawImage(avatarImg, cx - R, cy - R, R * 2, R * 2);
  } else {
    const g = ctx.createLinearGradient(cx - R, cy - R, cx + R, cy + R);
    g.addColorStop(0, VIOLET_DEEP);
    g.addColorStop(1, '#0e7490');
    ctx.fillStyle = g;
    ctx.fillRect(cx - R, cy - R, R * 2, R * 2);
    ctx.fillStyle = '#f5f3ff';
    ctx.font = NAME_FONT(Math.round(R));
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText([...name][0]?.toUpperCase() ?? '?', cx, cy + R * 0.05);
  }
  ctx.restore();
}

function spacedText(ctx, text, x, y, spacing) {
  const chars = [...text];
  const widths = chars.map((c) => ctx.measureText(c).width);
  const total = widths.reduce((a, b) => a + b, 0) + spacing * (chars.length - 1);
  let cx = x - total / 2;
  ctx.textAlign = 'left';
  chars.forEach((c, i) => {
    ctx.fillText(c, cx, y);
    cx += widths[i] + spacing;
  });
  return total;
}

function drawTexts(ctx, w, h, layout, name, scale, { tagline = TAGLINE, serverName = SERVER_NAME } = {}) {
  ctx.save();
  ctx.textBaseline = 'middle';
  // Display name: shrink to fit.
  let px = Math.round(70 * scale);
  ctx.font = NAME_FONT(px);
  while (ctx.measureText(name).width > w * 0.82 && px > 24 * scale) {
    px -= 2;
    ctx.font = NAME_FONT(px);
  }
  ctx.textAlign = 'center';
  ctx.shadowColor = CYAN;
  ctx.shadowBlur = 22 * scale;
  ctx.fillStyle = '#f8fafc';
  ctx.fillText(name, w / 2, layout.nameY * h);
  ctx.shadowBlur = 0;

  // Tagline with letter spacing and violet→cyan gradient.
  ctx.font = TITLE_FONT(Math.round(30 * scale));
  const ty = layout.taglineY * h;
  const tg = ctx.createLinearGradient(w * 0.25, 0, w * 0.75, 0);
  tg.addColorStop(0, '#c084fc');
  tg.addColorStop(0.5, '#f5f3ff');
  tg.addColorStop(1, '#67e8f9');
  ctx.fillStyle = tg;
  ctx.shadowColor = VIOLET;
  ctx.shadowBlur = 16 * scale;
  // Long taglines shrink to fit.
  let tpx = Math.round(30 * scale);
  while (tpx > 14 * scale && ctx.measureText(tagline).width + tagline.length * 6 * scale > w * 0.7) {
    tpx -= 2;
    ctx.font = TITLE_FONT(tpx);
  }
  const tw = spacedText(ctx, tagline, w / 2, ty, 6 * scale);
  ctx.shadowBlur = 10 * scale;
  // Neon rules either side of the tagline.
  for (const dir of [-1, 1]) {
    const x0 = w / 2 + dir * (tw / 2 + 18 * scale);
    const x1 = x0 + dir * 120 * scale;
    const lg = ctx.createLinearGradient(x0, 0, x1, 0);
    lg.addColorStop(0, dir < 0 ? VIOLET : CYAN);
    lg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.strokeStyle = lg;
    ctx.shadowColor = dir < 0 ? VIOLET : CYAN;
    ctx.lineWidth = 2 * scale;
    ctx.beginPath();
    ctx.moveTo(x0, ty);
    ctx.lineTo(x1, ty);
    ctx.stroke();
  }
  if (layout.showServerName) {
    ctx.shadowColor = VIOLET;
    ctx.shadowBlur = 12 * scale;
    ctx.font = SMALL_FONT(Math.round(22 * scale));
    ctx.fillStyle = 'rgba(237,233,254,0.92)';
    ctx.textAlign = 'center';
    ctx.fillText(serverName, w / 2, 34 * scale);
  }
  ctx.restore();
}

function roundedRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Neon glass panel that holds the welcome message under the hero section. */
function drawMessagePanel(ctx, panel, scale) {
  ctx.save();
  roundedRect(ctx, panel.x, panel.y, panel.w, panel.h, 22 * scale);
  ctx.fillStyle = 'rgba(10, 4, 26, 0.72)';
  ctx.fill();
  const border = ctx.createLinearGradient(panel.x, 0, panel.x + panel.w, 0);
  border.addColorStop(0, VIOLET);
  border.addColorStop(0.5, '#e9d5ff');
  border.addColorStop(1, CYAN);
  ctx.strokeStyle = border;
  ctx.lineWidth = 2.5 * scale;
  ctx.shadowColor = VIOLET;
  ctx.shadowBlur = 18 * scale;
  ctx.stroke();
  ctx.restore();
}

/**
 * Prepare reusable layers (background and foreground) for one member.
 * @param {{background?:string|null, avatar?:Buffer|null, displayName:string, width?:number}} opts
 */
export async function prepareCard({ background = findBackground(), avatar = null, displayName, width = CARD_W, tagline = TAGLINE, serverName = SERVER_NAME, message = '', emojiImages = new Map() } = {}) {
  registerFonts();
  const w = width;
  const heroH = Math.round((width * CARD_H) / CARD_W); // the original card area; layout fractions refer to it
  const scale = w / CARD_W;
  const layout = loadLayout();
  const name = sanitizeDisplayName(displayName);

  // The configured welcome message gets its own panel below the tagline, and
  // the card grows to fit it, so it can never overlap the avatar/name/tagline.
  let messageLayout = null;
  let panel = null;
  if (message && String(message).trim()) {
    const measure = createCanvas(4, 4).getContext('2d');
    const pad = 26 * scale;
    const textWidth = w * 0.84 - pad * 2;
    messageLayout = layoutMessage(measure, message, {
      maxWidth: textWidth,
      maxLines: 6,
      sizes: [32, 30, 28, 26, 24, 22, 20, 18].map((px) => Math.round(px * scale)),
      fontFor: MESSAGE_FONT,
    });
    if (messageLayout) {
      const top = Math.round(layout.taglineY * heroH + 34 * scale);
      panel = { x: Math.round(w * 0.08), y: top, w: Math.round(w * 0.84), h: Math.round(messageLayout.height + pad * 2 - messageLayout.lineHeight * 0.15), pad };
    }
  }
  const h = panel ? Math.max(heroH, panel.y + panel.h + Math.round(28 * scale)) : heroH;

  const base = createCanvas(w, h);
  const bctx = base.getContext('2d');
  let usedOriginal = false;
  if (background) {
    try {
      drawCover(bctx, await loadImage(background), w, h);
      usedOriginal = true;
    } catch {
      drawFallbackBackground(bctx, w, h);
    }
  } else drawFallbackBackground(bctx, w, h);
  drawAtmosphere(bctx, w, heroH, layout, h);

  let avatarImg = null;
  if (avatar) {
    try {
      avatarImg = await loadImage(avatar);
    } catch {
      avatarImg = null;
    }
  }
  const R = layout.avatarRadius * heroH;
  const cx = layout.avatarX * w;
  const cy = layout.avatarY * heroH;
  const fg = createCanvas(w, h);
  const fctx = fg.getContext('2d');
  drawAvatar(fctx, cx, cy, R, avatarImg, name);
  drawTexts(fctx, w, heroH, layout, name, scale, { tagline: sanitizeDisplayName(tagline, 40).toUpperCase(), serverName: sanitizeDisplayName(serverName, 48) });
  if (panel) {
    const loaded = new Map();
    for (const [id, buf] of emojiImages) {
      try {
        loaded.set(id, await loadImage(buf));
      } catch {
        /* fall back to :name: text */
      }
    }
    drawMessagePanel(fctx, panel, scale);
    drawMessage(fctx, messageLayout, { x: panel.x + panel.pad, y: panel.y + panel.pad - messageLayout.lineHeight * 0.15, width: panel.w - panel.pad * 2 }, { fontFor: MESSAGE_FONT, colors: MESSAGE_COLORS, emojiImages: loaded, scale });
  }

  return {
    w, h, heroH, scale, base, fg, cx, cy, R, name, usedOriginal, avatarUsed: Boolean(avatarImg),
    particles: makeParticles(name.length * 97 + 13, Math.round(70 * scale + 20)),
    message: messageLayout ? { lines: messageLayout.plain, fontSize: messageLayout.fontSize, truncated: messageLayout.truncated, panel, taglineY: Math.round(layout.taglineY * heroH) } : null,
  };
}

function composeFrame(ctx, card, t) {
  ctx.drawImage(card.base, 0, 0);
  drawParticles(ctx, card.w, card.h, card.particles, t);
  drawFrame(ctx, card.cx, card.cy, card.R, t, card.scale);
  ctx.drawImage(card.fg, 0, 0);
}

/** Static PNG (the reliable default). */
export async function renderWelcomePng(opts) {
  const card = await prepareCard(opts);
  const canvas = createCanvas(card.w, card.h);
  composeFrame(canvas.getContext('2d'), card, 0.12);
  return { buffer: await canvas.encode('png'), format: 'png', usedOriginal: card.usedOriginal, avatarUsed: card.avatarUsed, name: card.name, message: card.message, width: card.w, height: card.h };
}

/** Animated GIF: drifting particles, pulsing glow and rotating spirit arcs. */
export async function renderWelcomeGif(opts, { frames = 24, delayMs = 70, width = 720 } = {}) {
  const card = await prepareCard({ ...opts, width });
  const canvas = createCanvas(card.w, card.h);
  const ctx = canvas.getContext('2d');
  const gif = GIFEncoder();
  let palette = null;
  for (let i = 0; i < frames; i++) {
    composeFrame(ctx, card, i / frames);
    const { data } = ctx.getImageData(0, 0, card.w, card.h);
    if (!palette) palette = quantize(data, 256);
    gif.writeFrame(applyPalette(data, palette), card.w, card.h, { palette: i === 0 ? palette : undefined, delay: delayMs, repeat: 0 });
  }
  gif.finish();
  return { buffer: Buffer.from(gif.bytes()), format: 'gif', usedOriginal: card.usedOriginal, avatarUsed: card.avatarUsed, name: card.name, message: card.message, width: card.w, height: card.h };
}

/** FFmpeg command for MP4 cards (FFMPEG_PATH, ffmpeg-static or system PATH), or null. */
export function ffmpegPath() {
  const info = detectFfmpeg();
  return info.available ? info.command : null;
}

/** MP4 (H.264) via ffmpeg-static; returns null if ffmpeg is unavailable. */
export async function renderWelcomeMp4(opts, { seconds = 3, fps = 24, width = 960 } = {}) {
  const bin = ffmpegPath();
  if (!bin) return null;
  const card = await prepareCard({ ...opts, width: width - (width % 2) });
  const h = card.h - (card.h % 2);
  const canvas = createCanvas(card.w, card.h);
  const ctx = canvas.getContext('2d');
  const total = seconds * fps;
  const proc = spawn(bin, [
    '-hide_banner', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${card.w}x${card.h}`, '-r', String(fps), '-i', 'pipe:0',
    '-vf', `crop=${card.w}:${h}:0:0`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', '23', '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', 'pipe:1',
  ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const chunks = [];
  let stderr = '';
  proc.stdout.on('data', (c) => chunks.push(c));
  proc.stderr.on('data', (c) => (stderr += c));
  const done = new Promise((resolve, reject) => {
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(0, 300)}`))));
  });
  for (let i = 0; i < total; i++) {
    composeFrame(ctx, card, i / total);
    const { data } = ctx.getImageData(0, 0, card.w, card.h);
    if (!proc.stdin.write(Buffer.from(data.buffer, data.byteOffset, data.byteLength))) await new Promise((r) => proc.stdin.once('drain', r));
  }
  proc.stdin.end();
  await done;
  return { buffer: Buffer.concat(chunks), format: 'mp4', usedOriginal: card.usedOriginal, avatarUsed: card.avatarUsed, name: card.name, message: card.message, width: card.w, height: h };
}

/**
 * Render in the requested format with a guaranteed static fallback.
 * @param {'png'|'gif'|'mp4'} format
 */
export async function renderWelcome(opts, format = 'png', logger) {
  if (format === 'mp4' || format === 'gif') {
    try {
      const anim = format === 'mp4' ? await renderWelcomeMp4(opts) : await renderWelcomeGif(opts);
      if (anim && anim.buffer.length > 0 && anim.buffer.length <= DISCORD_FILE_LIMIT) return anim;
      logger?.warn('animated welcome unavailable or too large; using static card', { format, bytes: anim?.buffer.length });
    } catch (err) {
      logger?.warn('animated welcome failed; using static card', { format, err: err.message });
    }
  }
  return renderWelcomePng(opts);
}
