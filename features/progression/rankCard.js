// Rank card in the Soul Society guardian theme.
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { registerFonts, sanitizeDisplayName, findBackground } from '../welcome/renderer.js';
import { SERVER_NAME } from '../../config/defaults.js';

const W = 1000;
const H = 300;

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * @param {{displayName:string, avatar?:Buffer|null, level:number, into:number, needed:number, rank:number, aura:number, xp:number, streak:number, title?:string|null, cyanFrame?:boolean}} p
 */
export async function renderRankCard(p) {
  const serverName = p.serverName ?? SERVER_NAME;
  registerFonts();
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  const bgPath = findBackground();
  if (bgPath) {
    try {
      const img = await loadImage(bgPath);
      const s = Math.max(W / img.width, H / img.height);
      ctx.drawImage(img, (W - img.width * s) / 2, (H - img.height * s) / 2, img.width * s, img.height * s);
    } catch {
      /* fall through to gradient */
    }
  }
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, bgPath ? 'rgba(7,2,15,0.78)' : '#0b0418');
  g.addColorStop(1, bgPath ? 'rgba(10,20,40,0.78)' : '#071a24');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = p.cyanFrame ? '#22d3ee' : '#a855f7';
  ctx.shadowColor = ctx.strokeStyle;
  ctx.shadowBlur = 18;
  ctx.lineWidth = 3;
  roundRect(ctx, 10, 10, W - 20, H - 20, 22);
  ctx.stroke();
  ctx.shadowBlur = 0;

  // Avatar
  const cx = 150;
  const cy = H / 2;
  const R = 95;
  ctx.save();
  ctx.shadowColor = '#a855f7';
  ctx.shadowBlur = 25;
  ctx.lineWidth = 6;
  const ring = ctx.createLinearGradient(cx - R, cy - R, cx + R, cy + R);
  ring.addColorStop(0, '#a855f7');
  ring.addColorStop(1, '#22d3ee');
  ctx.strokeStyle = ring;
  ctx.beginPath();
  ctx.arc(cx, cy, R + 6, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.clip();
  let drawn = false;
  if (p.avatar) {
    try {
      ctx.drawImage(await loadImage(p.avatar), cx - R, cy - R, R * 2, R * 2);
      drawn = true;
    } catch {
      drawn = false;
    }
  }
  if (!drawn) {
    ctx.fillStyle = '#4c1d95';
    ctx.fillRect(cx - R, cy - R, R * 2, R * 2);
  }
  ctx.restore();

  const name = sanitizeDisplayName(p.displayName, 24);
  ctx.fillStyle = '#f8fafc';
  ctx.font = 'bold 46px Rajdhani, "Segoe UI", "Segoe UI Emoji", sans-serif';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(name, 290, 95);
  if (p.title) {
    ctx.font = '700 22px Cinzel, serif';
    ctx.fillStyle = '#67e8f9';
    ctx.fillText(p.title.toUpperCase(), 292, 128);
  }
  ctx.textAlign = 'right';
  ctx.font = '900 30px Cinzel, serif';
  ctx.fillStyle = '#c084fc';
  ctx.fillText(`RANK #${p.rank}`, W - 50, 70);
  ctx.fillStyle = '#67e8f9';
  ctx.fillText(`LEVEL ${p.level}`, W - 50, 112);
  ctx.textAlign = 'left';

  // XP bar
  const bx = 290;
  const by = 175;
  const bw = W - bx - 50;
  const bh = 30;
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  roundRect(ctx, bx, by, bw, bh, 15);
  ctx.fill();
  const frac = Math.max(0.02, Math.min(1, p.into / p.needed));
  const xg = ctx.createLinearGradient(bx, 0, bx + bw, 0);
  xg.addColorStop(0, '#7c3aed');
  xg.addColorStop(1, '#22d3ee');
  ctx.fillStyle = xg;
  ctx.shadowColor = '#22d3ee';
  ctx.shadowBlur = 12;
  roundRect(ctx, bx, by, bw * frac, bh, 15);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.font = '600 22px Rajdhani, "Segoe UI", sans-serif';
  ctx.fillStyle = '#e2e8f0';
  ctx.fillText(`${p.into} / ${p.needed} XP`, bx, by + 60);
  ctx.textAlign = 'right';
  ctx.fillText(`✦ ${p.aura} aura   🔥 ${p.streak}-day streak`, bx + bw, by + 60);
  ctx.textAlign = 'center';
  ctx.font = '600 16px "Segoe UI Historic", "Segoe UI Symbol", "Segoe UI", sans-serif';
  ctx.fillStyle = 'rgba(226,232,240,0.6)';
  ctx.fillText(sanitizeDisplayName(serverName, 48), W / 2 + 120, H - 24);
  return canvas.encode('png');
}
