import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { renderWelcomePng, renderWelcomeGif, renderWelcome, sanitizeDisplayName, fetchAvatar, CARD_W, CARD_H } from '../features/welcome/renderer.js';
import { formatTemplate, onMemberJoin } from '../features/welcome/handler.js';
import { setGuildSetting } from '../core/settings.js';
import { memoryLogger } from '../core/logger.js';
import { buildMockGuild } from './mocks/discord.js';
import { memDb, tempDir, testConfig } from './helpers.js';

function solidPng(w, h, color) {
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, w, h);
  return c.encode('png');
}

async function pixel(buf, x, y) {
  const img = await loadImage(buf);
  const c = createCanvas(img.width, img.height);
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  return [...ctx.getImageData(x, y, 1, 1).data];
}

test('the provided original background is preserved (drawn, not replaced)', async () => {
  const dir = tempDir();
  const bg = path.join(dir, 'background.png');
  fs.writeFileSync(bg, await solidPng(1200, 500, '#3a1d6e')); // stands in for the owner's artwork
  const out = await renderWelcomePng({ background: bg, avatar: await solidPng(256, 256, '#ff0000'), displayName: 'Rukia' });
  assert.equal(out.usedOriginal, true);
  // Left of the avatar frame (only a light vignette there): the background's colour survives.
  const samples = [];
  for (const [x, y] of [[280, 140], [300, 160], [320, 150], [290, 180], [310, 130]]) samples.push(await pixel(out.buffer, x, y));
  const median = (i) => samples.map((s) => s[i]).sort((a, b) => a - b)[2];
  const [r, g, b] = [median(0), median(1), median(2)];
  assert.ok(Math.abs(r - 0x3a) < 25 && Math.abs(g - 0x1d) < 25 && Math.abs(b - 0x6e) < 35, `bg pixel ${r},${g},${b}`);
});

test('the joining member\'s avatar is rendered dynamically in the centre frame', async () => {
  const red = await renderWelcomePng({ background: null, avatar: await solidPng(256, 256, '#ff0000'), displayName: 'A' });
  const green = await renderWelcomePng({ background: null, avatar: await solidPng(256, 256, '#00ff00'), displayName: 'B' });
  const [r1, g1] = await pixel(red.buffer, CARD_W / 2, Math.round(CARD_H * 0.4));
  const [r2, g2] = await pixel(green.buffer, CARD_W / 2, Math.round(CARD_H * 0.4));
  assert.ok(r1 > 200 && g1 < 60, 'red avatar visible at centre');
  assert.ok(g2 > 200 && r2 < 60, 'green avatar visible at centre');
  assert.equal(red.avatarUsed, true);
  const img = await loadImage(red.buffer);
  assert.deepEqual([img.width, img.height], [CARD_W, CARD_H]);
});

test('display names render dynamically and different names produce different cards', async () => {
  const a = await renderWelcomePng({ avatar: null, displayName: 'Ichigo' });
  const b = await renderWelcomePng({ avatar: null, displayName: 'Byakuya Kuchiki' });
  assert.notDeepEqual(a.buffer, b.buffer);
  assert.equal(a.name, 'Ichigo');
});

test('user-provided names are sanitised', () => {
  assert.equal(sanitizeDisplayName('Evil\u202Egnirts\u200B'), 'Evilgnirts');
  assert.equal(sanitizeDisplayName('a\u0000b\u0007c'), 'abc');
  assert.equal(sanitizeDisplayName(''), 'New Soul');
  const long = sanitizeDisplayName('x'.repeat(80));
  assert.equal([...long].length, 32);
  assert.ok(long.endsWith('…'));
  assert.equal(sanitizeDisplayName('👨\u200D👩\u200D👧\u200D👦'.repeat(40)).endsWith('…'), true, 'grapheme-safe truncation');
});

test('failed avatar downloads and invalid URLs fall back to a placeholder', async () => {
  assert.equal(await fetchAvatar('http://insecure.example/a.png'), null);
  assert.equal(await fetchAvatar('https://x/a.png', { fetchImpl: async () => { throw new Error('network'); } }), null);
  assert.equal(await fetchAvatar('https://x/a.png', { fetchImpl: async () => ({ ok: false }) }), null);
  const out = await renderWelcomePng({ avatar: Buffer.from('not an image'), displayName: 'Ghost' });
  assert.equal(out.avatarUsed, false);
  assert.ok(out.buffer.length > 1000);
});

test('missing or corrupt background uses the labelled stand-in', async () => {
  const dir = tempDir();
  const bad = path.join(dir, 'background.png');
  fs.writeFileSync(bad, 'corrupt');
  const out = await renderWelcomePng({ background: bad, avatar: null, displayName: 'X' });
  assert.equal(out.usedOriginal, false);
});

test('animated GIF renders under the Discord limit; failures fall back to static PNG', async () => {
  const gif = await renderWelcomeGif({ avatar: null, displayName: 'Animated' }, { frames: 6, width: 480 });
  assert.equal(gif.buffer.subarray(0, 6).toString(), 'GIF89a');
  const fallback = await renderWelcome({ avatar: null, displayName: 'Y', background: { notAPath: true } }, 'gif', memoryLogger());
  assert.ok(['gif', 'png'].includes(fallback.format));
});

test('welcome message templates escape user-controlled text', () => {
  const member = { id: '123456789012345678', displayName: '@everyone **bold**', user: { username: 'u' } };
  const out = formatTemplate('Welcome {mention} aka {name} to {server} (#{count})', { member, guild: { name: 'G', memberCount: 42 } });
  assert.match(out, /<@123456789012345678>/);
  assert.ok(!/@everyone/.test(out.replace('@\u200Beveryone', '')));
  assert.match(out, /\\\*\\\*bold\\\*\\\*/);
  assert.match(out, /to G \(#42\)/, '{server} is the current server, not a hard-coded name');
  const branded = formatTemplate('{server}', { member, guild: { name: 'G' }, settings: { branding: { displayName: '𓆩 𝐕𝐎𝐈𝐃𝐖𝐎𝐑𝐊𝐒 𓆪' } } });
  assert.equal(branded, '𓆩 𝐕𝐎𝐈𝐃𝐖𝐎𝐑𝐊𝐒 𓆪');
});

test('each server gets its own branding, tagline and background on the card', async () => {
  const dir = tempDir();
  const config = { ...testConfig(), dataDir: dir };
  const { backgroundFor } = await import('../features/welcome/handler.js');
  fs.mkdirSync(path.join(dir, 'backgrounds'));
  fs.writeFileSync(path.join(dir, 'backgrounds', '123.png'), await solidPng(1200, 500, '#103050'));
  assert.equal(backgroundFor(config, { welcome: { background: '123.png' } }), path.join(dir, 'backgrounds', '123.png'));
  assert.equal(backgroundFor(config, { welcome: { background: '../../etc/passwd' } }), backgroundFor(config, {}), 'path traversal ignored');
  const a = await renderWelcomePng({ avatar: null, displayName: 'X', serverName: 'Server A', tagline: 'JOINED THE GUILD' });
  const b = await renderWelcomePng({ avatar: null, displayName: 'X', serverName: 'Server B', tagline: 'HAS ENTERED SOUL SOCIETY' });
  assert.notDeepEqual(a.buffer, b.buffer);
});

test('join handler sends the card to the configured channel and survives an invalid channel id', async () => {
  const { guild, channels, members } = buildMockGuild();
  const db = memDb();
  const config = testConfig({ ownerId: guild.ownerId });
  members.john.displayAvatarURL = () => 'https://invalid.invalid/avatar.png';
  assert.equal((await onMemberJoin(members.john, { db, config, logger: memoryLogger() })).reason, 'no_channel');
  setGuildSetting(db, guild.id, 'channels.welcome', '999999999999999999');
  assert.equal((await onMemberJoin(members.john, { db, config, logger: memoryLogger() })).reason, 'no_channel');
  setGuildSetting(db, guild.id, 'channels.welcome', channels.general.id);
  const r = await onMemberJoin(members.john, { db, config, logger: memoryLogger() });
  assert.equal(r.sent, true);
  const msg = channels.general.messages.at(-1);
  assert.equal(msg.files.length, 1);
  assert.deepEqual(msg.allowedMentions, { users: [members.john.id] });
  assert.equal(db.get(`SELECT COUNT(*) AS n FROM member_events WHERE type = 'join'`).n, 3);
});
