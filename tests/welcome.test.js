import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { renderWelcomePng, renderWelcomeGif, renderWelcome, sanitizeDisplayName, fetchAvatar, CARD_W, CARD_H } from '../features/welcome/renderer.js';
import { formatTemplate, onMemberJoin, composeWelcome, fetchMessageEmoji } from '../features/welcome/handler.js';
import { parseInline, parseMessage, escapeRich } from '../features/welcome/richText.js';
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

// ------------------------------------------------------------------ the configured welcome message on the card

const noNetwork = async () => {
  throw new Error('no network in tests');
};

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

test('image-mode templates: line breaks, readable mentions, member names cannot inject formatting', () => {
  const { guild, members, channels } = buildMockGuild();
  const john = members.john;
  john.displayName = '**Evil** _name_';
  const out = formatTemplate('Hey {mention}!\\nRead <#' + channels.general.id + '>, then say hi to <@' + members.bob.id + '>.<br>Soul #{count} of {server}', { member: john, guild, settings: null, mode: 'image' });
  const lines = parseMessage(out).map((l) => l.runs.map((r) => r.text).join(''));
  assert.deepEqual(lines, [`Hey @**Evil** _name_!`, 'Read #general, then say hi to @Bob.', `Soul #${guild.memberCount} of ${guild.name}`]);
  assert.ok(parseMessage(out)[0].runs.every((r) => !r.bold && !r.italic), "a member's name never becomes markup");
  assert.match(formatTemplate('a\\nb', { member: john, guild }), /^a\nb$/, 'text mode supports \\n too');
});

test('the saved welcome message reaches the renderer and is drawn inside the card, below the tagline', async () => {
  const { guild, channels, members } = buildMockGuild();
  const db = memDb();
  const config = testConfig({ ownerId: guild.ownerId });
  members.john.displayAvatarURL = () => 'https://invalid.invalid/avatar.png';
  setGuildSetting(db, guild.id, 'channels.welcome', channels.general.id);
  setGuildSetting(db, guild.id, 'welcome.message', 'Hey {mention} 👋\\nWelcome to **{server}** — enjoy 💜');
  const r = await onMemberJoin(members.john, { db, config, logger: memoryLogger() });
  assert.equal(r.sent, true);
  assert.deepEqual(r.message.lines, ['Hey @John 👋', `Welcome to ${guild.name} — enjoy 💜`]);
  const msg = channels.general.messages.at(-1);
  assert.equal(msg.content, `<@${members.john.id}>`, 'the text only carries the ping; the message is on the card');
  const png = msg.files[0].attachment;
  const img = await loadImage(png);
  assert.ok(img.height > CARD_H, 'the card grows to make room for the message');
  assert.ok(r.message.panel.y > r.message.taglineY, 'message panel starts below the tagline');
  assert.ok(r.message.panel.y + r.message.panel.h <= img.height, 'panel fits inside the image');

  // Different message text → different pixels in the panel, identical hero section.
  setGuildSetting(db, guild.id, 'welcome.message', 'Something completely different');
  await onMemberJoin(members.john, { db, config, logger: memoryLogger() });
  const other = channels.general.messages.at(-1);
  assert.equal(other.content, '', 'no {mention} in the template → no ping');
  const crop = async (buf, x, y, w, h) => {
    const im = await loadImage(buf);
    const c = createCanvas(w, h);
    c.getContext('2d').drawImage(im, -x, -y);
    return Buffer.from(c.getContext('2d').getImageData(0, 0, w, h).data);
  };
  const avatar = [CARD_W / 2 - 60, CARD_H * 0.4 - 60, 120, 120];
  assert.ok((await crop(png, ...avatar)).equals(await crop(other.files[0].attachment, ...avatar)), 'avatar untouched by the message');
  const panelRow = [r.message.panel.x + 30, r.message.panel.y + 20, r.message.panel.w - 60, 40];
  assert.ok(!(await crop(png, ...panelRow)).equals(await crop(other.files[0].attachment, ...panelRow)), 'message text drawn in the panel');
});

test('/welcome-test and real joins use the same composition and saved settings', async () => {
  const { guild, channels, members } = buildMockGuild();
  const db = memDb();
  const config = testConfig({ ownerId: guild.ownerId });
  members.bob.displayAvatarURL = () => 'https://invalid.invalid/avatar.png';
  setGuildSetting(db, guild.id, 'channels.welcome', channels.general.id);
  setGuildSetting(db, guild.id, 'welcome.message', '**Welcome**, {name}!');
  setGuildSetting(db, guild.id, 'welcome.tagline', 'JOINED THE ORDER');
  const { getGuildSettings } = await import('../core/settings.js');
  const preview = await composeWelcome(members.bob, { config, settings: getGuildSettings(db, guild.id), logger: memoryLogger(), fetchImpl: noNetwork });
  await onMemberJoin(members.bob, { db, config, logger: memoryLogger() });
  const real = channels.general.messages.at(-1);
  assert.deepEqual(preview.card.message.lines, ['Welcome, Bob!']);
  assert.ok(Buffer.compare(preview.files[0].attachment, real.files[0].attachment) === 0, 'byte-identical card');
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

test('custom emoji in the message are fetched (bounded, from the Discord CDN only) and drawn', async () => {
  const seen = [];
  const emojiPng = await solidPng(64, 64, '#00ff00');
  const fetchImpl = async (url) => {
    seen.push(url);
    return { ok: true, arrayBuffer: async () => emojiPng };
  };
  const ids = Array.from({ length: 12 }, (_, i) => `<:e${i}:${String(100000000000000000n + BigInt(i))}>`).join(' ');
  const images = await fetchMessageEmoji(`hi ${ids}`, { fetchImpl });
  assert.equal(images.size, 8, 'at most 8 emoji downloads');
  assert.ok(seen.every((u) => u.startsWith('https://cdn.discordapp.com/emojis/')));
  const withImg = await renderWelcomePng({ displayName: 'A', message: '<:e0:100000000000000000>', emojiImages: images });
  const without = await renderWelcomePng({ displayName: 'A', message: '<:e0:100000000000000000>' });
  assert.notDeepEqual(withImg.buffer, without.buffer, 'emoji image drawn (fallback is :name: text)');
});
