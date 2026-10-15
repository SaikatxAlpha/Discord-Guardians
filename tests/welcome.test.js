import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { renderWelcomePng, renderWelcomeGif, renderWelcome, sanitizeDisplayName, fetchAvatar, CARD_W, CARD_H } from '../features/welcome/renderer.js';
import gifenc from 'gifenc';
import { formatTemplate, onMemberJoin, composeWelcome, saveGuildBackground, removeGuildBackground, imageTypeOf } from '../features/welcome/handler.js';
import { aegisCommands } from '../apps/aegis/commands.js';
import { parseInline, parseMessage, escapeRich } from '../features/welcome/richText.js';

const { GIFEncoder, quantize, applyPalette } = gifenc;
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

test('rich text: Discord-style bold/italic/underline/strike/code, custom emoji, unmatched markers stay literal', () => {
  const runs = parseInline('Hi **bold** _it_ __u__ ~~s~~ `c` <:pog:123456789012345678> 2*3 a_b');
  const pick = (text) => runs.find((r) => r.text === text);
  assert.equal(pick('bold').bold, true);
  assert.equal(pick('it').italic, true);
  assert.equal(pick('u').underline, true);
  assert.equal(pick('s').strike, true);
  assert.equal(pick('c').code, true);
  assert.deepEqual(runs.find((r) => r.emoji).emoji, { animated: false, name: 'pog', id: '123456789012345678' });
  assert.ok(runs.at(-1).text.endsWith('2*3 a_b'), 'single unmatched markers are literal');
  assert.deepEqual(parseInline(escapeRich('**not bold**')).map((r) => [r.text, r.bold]), [['**not bold**', false]]);
  const lines = parseMessage('# Title\n> quoted\n- item\n\n\n\nend');
  assert.deepEqual(lines.map((l) => l.runs.map((r) => r.text).join('')), ['Title', 'quoted', '• item', '', 'end'], 'blank-line runs collapsed');
  assert.equal(lines[0].runs[0].bold, true, 'headings are bold');
});

test('message layout adapts: short text large, long text smaller and wrapped, huge text truncated — never overlapping', async () => {
  const short = await renderWelcomePng({ displayName: 'A', message: 'Welcome!' });
  const medium = await renderWelcomePng({ displayName: 'A', message: 'Please read the rules, pick your roles in the roles channel, introduce yourself to everyone and have a great time in the community. '.repeat(4) });
  const huge = await renderWelcomePng({ displayName: 'A', message: 'lorem ipsum dolor sit amet '.repeat(60) });
  const unbroken = await renderWelcomePng({ displayName: 'A', message: 'x'.repeat(300) });
  assert.equal(short.message.fontSize, 32);
  assert.ok(medium.message.fontSize < 32 && medium.message.lines.length > 1);
  assert.equal(huge.message.truncated, true);
  assert.ok(huge.message.lines.length <= 6 && huge.message.lines.at(-1).endsWith('…'), 'shortened text ends with an ellipsis');
  assert.ok(unbroken.message.lines.length > 1, 'very long words are broken instead of overflowing');
  for (const r of [short, medium, huge, unbroken]) {
    assert.ok(r.message.panel.y > r.message.taglineY);
    assert.ok(r.message.panel.y + r.message.panel.h <= r.height);
  }
  const none = await renderWelcomePng({ displayName: 'A', message: '' });
  assert.equal(none.message, null);
  assert.equal(none.height, CARD_H, 'no message → classic card size');
  const gif = await renderWelcomeGif({ displayName: 'A', message: 'Animated **hello**' }, { frames: 3, width: 480 });
  assert.deepEqual(gif.message.lines, ['Animated hello']);
});

// ------------------------------------------------------------------ welcome post: normal text + the original image below it

/** A small 3-frame animated GIF (stands in for a server's uploaded animation). */
function animatedGif() {
  const enc = GIFEncoder();
  const w = 64;
  const h = 32;
  for (const shade of [40, 140, 240]) {
    const data = new Uint8ClampedArray(w * h * 4).map((_, k) => (k % 4 === 3 ? 255 : shade));
    const palette = quantize(data, 16);
    enc.writeFrame(applyPalette(data, palette), w, h, { palette, delay: 100, repeat: 0 });
  }
  enc.finish();
  return Buffer.from(enc.bytes());
}
/** Frames in a GIF: one graphic-control extension block (21 F9 04) per frame. */
function gifFrames(buf) {
  const marker = Buffer.from([0x21, 0xf9, 0x04]);
  let n = 0;
  for (let at = buf.indexOf(marker); at !== -1; at = buf.indexOf(marker, at + 3)) n++;
  return n;
}

/** Store an upload exactly as /setup welcome background: does (MOCK Discord CDN download). */
async function upload(config, guildId, bytes, contentType) {
  const fetchImpl = async () => ({ ok: true, status: 200, arrayBuffer: async () => bytes });
  return saveGuildBackground(config, guildId, { contentType, size: bytes.length, url: 'https://cdn.discordapp.com/attachments/1/2/bg' }, { fetchImpl });
}

function welcomeEnv() {
  const env = buildMockGuild();
  const db = memDb();
  const config = { ...testConfig({ ownerId: env.guild.ownerId }), dataDir: tempDir() };
  setGuildSetting(db, env.guild.id, 'channels.welcome', env.channels.general.id);
  return { ...env, db, config };
}

const VOIDWORKS_TEMPLATE = '🎉 Welcome to {server}, {mention}!\\n𓆩 Where Shadows Unite, Legends Awaken. 💜 𓆪';

test('a real join sends the configured text as normal message content with the uploaded image unchanged below it', async () => {
  const { guild, channels, members, db, config } = welcomeEnv();
  const png = await solidPng(900, 300, '#5b21b6');
  setGuildSetting(db, guild.id, 'welcome.background', await upload(config, guild.id, png, 'image/png'));
  setGuildSetting(db, guild.id, 'welcome.message', VOIDWORKS_TEMPLATE);
  const r = await onMemberJoin(members.john, { db, config, logger: memoryLogger() });
  assert.deepEqual(r, { sent: true, withImage: true });
  const msg = channels.general.messages.at(-1);
  assert.equal(msg.content, `🎉 Welcome to ${guild.name}, <@${members.john.id}>!\n𓆩 Where Shadows Unite, Legends Awaken. 💜 𓆪`);
  assert.equal(msg.files.length, 1, 'one message: text above, image attached below');
  assert.equal(msg.files[0].name, 'welcome.png');
  assert.ok(Buffer.compare(msg.files[0].attachment, png) === 0, 'byte-identical: nothing drawn on the image');
  const img = await loadImage(msg.files[0].attachment);
  assert.deepEqual([img.width, img.height], [900, 300], 'original dimensions kept');
  assert.deepEqual(msg.allowedMentions, { parse: [], users: [members.john.id] }, 'only the new member can be pinged');
});

test('animated GIF welcome images stay animated (stored and sent byte-for-byte)', async () => {
  const { guild, channels, members, db, config } = welcomeEnv();
  const gif = animatedGif();
  assert.equal(gifFrames(gif), 3);
  const name = await upload(config, guild.id, gif, 'image/gif');
  assert.equal(name, `${guild.id}.gif`);
  setGuildSetting(db, guild.id, 'welcome.background', name);
  await onMemberJoin(members.bob, { db, config, logger: memoryLogger() });
  const sent = channels.general.messages.at(-1).files[0];
  assert.equal(sent.name, 'welcome.gif');
  assert.ok(Buffer.compare(sent.attachment, gif) === 0);
  assert.equal(gifFrames(sent.attachment), 3, 'all frames present');
  assert.equal(imageTypeOf(sent.attachment), 'gif');
});

test('/welcome-test sends exactly the same message as a real join (same builder, same saved settings)', async () => {
  const { guild, channels, members, db, config } = welcomeEnv();
  const gif = animatedGif();
  setGuildSetting(db, guild.id, 'welcome.background', await upload(config, guild.id, gif, 'image/gif'));
  setGuildSetting(db, guild.id, 'welcome.message', VOIDWORKS_TEMPLATE);
  await onMemberJoin(members.john, { db, config, logger: memoryLogger() });
  const real = channels.general.messages.at(-1);

  const cmd = aegisCommands({ listener: null, music: null }).find((c) => c.data.name === 'welcome-test');
  const replies = [];
  const i = {
    guild,
    guildId: guild.id,
    user: members.john.user,
    options: { getUser: () => null },
    deferReply: async () => {},
    editReply: async (p) => replies.push(p),
    followUp: async (p) => replies.push(p),
  };
  await cmd.execute(i, { config, db, logger: memoryLogger() });
  const preview = replies[0];
  assert.equal(preview.content, real.content, 'identical text');
  assert.equal(preview.files.length, 1);
  assert.equal(preview.files[0].name, real.files[0].name);
  assert.ok(Buffer.compare(preview.files[0].attachment, real.files[0].attachment) === 0, 'identical image');
  assert.deepEqual(preview.allowedMentions, { parse: [] }, 'the preview pings nobody');
  assert.equal(replies.length, 1, 'no extra notes when everything is configured');
  assert.doesNotMatch(JSON.stringify(replies), /shortened|too long|truncat/i, 'no image-text warnings any more');
});

test('/welcome-test points out missing settings privately, without changing the preview', async () => {
  const { guild, members, db, config } = welcomeEnv();
  setGuildSetting(db, guild.id, 'welcome.enabled', false);
  const cmd = aegisCommands({ listener: null, music: null }).find((c) => c.data.name === 'welcome-test');
  const replies = [];
  const i = { guild, guildId: guild.id, user: members.john.user, options: { getUser: () => null }, deferReply: async () => {}, editReply: async (p) => replies.push(p), followUp: async (p) => replies.push(p) };
  await cmd.execute(i, { config, db, logger: memoryLogger() });
  assert.equal(replies[0].files.length, 0, 'no image configured: text only');
  assert.match(replies[0].content, /Welcome to/);
  assert.match(replies[1].content, /disabled/);
  assert.match(replies[1].content, /No welcome image/);
  assert.ok(replies[1].flags, 'notes are ephemeral');
});

test('welcome text is never truncated to fit an image and cannot mass-mention', async () => {
  const { guild, channels, members, db, config } = welcomeEnv();
  const long = `@everyone @here <@&${guild.id}> ${'Read the rules and grab your roles. '.repeat(25)}{mention}`;
  setGuildSetting(db, guild.id, 'welcome.message', long);
  await onMemberJoin(members.john, { db, config, logger: memoryLogger() });
  const msg = channels.general.messages.at(-1);
  assert.ok(msg.content.endsWith(`<@${members.john.id}>`), 'the full text is sent (well under the 2000-character limit)');
  assert.deepEqual(msg.allowedMentions, { parse: [], users: [members.john.id] }, '@everyone, @here and roles are not pinged');
  const huge = composeWelcome(members.john, { config, settings: { welcome: { message: 'x'.repeat(5000) }, channels: {} } });
  assert.ok(huge.content.length <= 2000 && huge.content.endsWith('…'), 'Discord limit respected');
});

test('welcome image uploads: PNG/JPG/WebP/GIF identified by their bytes; other files refused; reset removes it', async () => {
  const { guild, config } = welcomeEnv();
  await assert.rejects(upload(config, guild.id, Buffer.from('not really an image at all'), 'image/png'), /PNG, JPG, WebP or GIF/);
  await assert.rejects(upload(config, guild.id, animatedGif(), 'application/zip'), /PNG, JPG, WebP or GIF/);
  const name = await upload(config, guild.id, animatedGif(), 'image/png'); // a GIF mislabelled as PNG keeps its real type
  assert.equal(name, `${guild.id}.gif`);
  removeGuildBackground(config, guild.id);
  assert.equal(fs.existsSync(path.join(config.dataDir, 'backgrounds', name)), false);
});

test('join handler: disabled, invalid channel, and a failed image upload still greets with the text', async () => {
  const { guild, channels, members, db, config } = welcomeEnv();
  setGuildSetting(db, guild.id, 'welcome.enabled', false);
  assert.equal((await onMemberJoin(members.john, { db, config, logger: memoryLogger() })).reason, 'disabled');
  setGuildSetting(db, guild.id, 'welcome.enabled', true);
  setGuildSetting(db, guild.id, 'channels.welcome', '999999999999999999');
  assert.equal((await onMemberJoin(members.john, { db, config, logger: memoryLogger() })).reason, 'no_channel');
  setGuildSetting(db, guild.id, 'channels.welcome', channels.general.id);
  setGuildSetting(db, guild.id, 'welcome.background', await upload(config, guild.id, await solidPng(100, 50, '#000'), 'image/png'));
  const realSend = channels.general.send.bind(channels.general);
  let calls = 0;
  channels.general.send = async (p) => {
    calls++;
    if (p.files?.length) throw new Error('Missing Permissions (Attach Files)');
    return realSend(p);
  };
  const r = await onMemberJoin(members.john, { db, config, logger: memoryLogger() });
  assert.deepEqual(r, { sent: true, withImage: false });
  assert.equal(calls, 2);
  assert.match(channels.general.messages.at(-1).content, /Welcome to/);
  assert.equal(db.get(`SELECT COUNT(*) AS n FROM member_events WHERE type = 'join'`).n, 3);
});
