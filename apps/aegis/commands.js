// AEGIS slash commands.
import { SlashCommandBuilder, PermissionFlagsBits, ChannelType, MessageFlags, AttachmentBuilder } from 'discord.js';
import { parseWhen } from '../../core/intents/parser.js';
import { parseDuration } from '../../core/time.js';
import { getGuildSettings, setGuildSetting } from '../../core/settings.js';
import { authLevel, AUTH, canUseAlpha } from '../../core/auth.js';
import { audit } from '../../core/audit.js';
import { guardianEmbed, safeText, STATUS_COLORS } from '../../core/discord/theme.js';
import { listJobs, cancelJob } from '../../core/scheduler.js';
import {
  getProfile, claimDaily, claimWeekly, leaderboard, listQuests, listShop, purchaseItem, refundPurchase, inventoryOf, transferAura, addShopItem, endSeason, EconomyError,
} from '../../features/progression/economy.js';
import { renderRankCard } from '../../features/progression/rankCard.js';
import { fetchAvatar } from '../../features/welcome/renderer.js';
import { buildWelcomeCard, saveGuildBackground, removeGuildBackground, displayNameOf } from '../../features/welcome/handler.js';
import { joinEvent } from '../../features/events/events.js';
import { checkRoleManageable } from '../../core/discord/safety.js';
import { syncReportJobs } from './reports.js';
import { configCommands } from './configCommands.js';

const P = PermissionFlagsBits;
const eph = { flags: MessageFlags.Ephemeral };
const ch = (c) => (c ? `<#${c.id}>` : undefined);

function isAdmin(i, app) {
  return authLevel({ userId: i.user.id, config: app.config, member: i.member, guild: i.guild, settings: getGuildSettings(app.db, i.guildId) }) >= AUTH.ADMIN;
}

/** ALPHA access in THIS server: its owner and the users/roles it trusts. */
function alphaAllowed(i, app) {
  return canUseAlpha(i.user.id, app.config, { member: i.member, guild: i.guild, settings: getGuildSettings(app.db, i.guildId) });
}
const ALPHA_DENIED = "ALPHA only accepts instructions from this server's owner or the users/roles trusted with /setup trusted.";

function whenFrom(text, app) {
  return parseWhen(text.startsWith('in ') || text.startsWith('at ') || /^(tomorrow|tonight|every|daily|on |next )/i.test(text) ? text : `at ${text}`, Date.now(), app.config.timezone);
}

function profileAvatar(user) {
  return fetchAvatar(user.displayAvatarURL({ extension: 'png', size: 256, forceStatic: true }));
}

export function aegisCommands({ listener, music }) {
  return [
    // ---------------------------------------------------------------- ALPHA
    {
      data: new SlashCommandBuilder().setName('alpha').setDescription('Give ALPHA a natural-language instruction (server owner / trusted)')
        .addStringOption((o) => o.setName('command').setDescription('e.g. create a gaming channel and give the Gaming role access to it').setRequired(true).setMaxLength(500)),
      async execute(i, app) {
        if (!alphaAllowed(i, app)) return i.reply({ content: ALPHA_DENIED, ...eph });
        await i.deferReply();
        const res = await app.coordinator.handleText({ requestId: `ix:${i.id}`, guildId: i.guildId, channelId: i.channelId, userId: i.user.id, member: i.member, source: 'text', text: i.options.getString('command') });
        return app.replyWithResponse(i, res);
      },
    },
    {
      data: new SlashCommandBuilder().setName('listen').setDescription('ALPHA voice listening (server owner / trusted)')
        .addSubcommand((s) => s.setName('start').setDescription('Join your voice channel and listen for "ALPHA"'))
        .addSubcommand((s) => s.setName('stop').setDescription('Stop listening'))
        .addSubcommand((s) => s.setName('status').setDescription('Is ALPHA listening?')),
      async execute(i, app) {
        if (!alphaAllowed(i, app)) return i.reply({ content: ALPHA_DENIED, ...eph });
        const sub = i.options.getSubcommand();
        if (sub === 'status') {
          const s = listener.sessions.get(i.guildId);
          return i.reply({ content: s ? `🎙️ Listening in <#${s.channelId}> since <t:${Math.floor(s.startedAt / 1000)}:R> (STT: ${app.stt.name}). Use /voice diagnostics for details.` : `Not listening. STT provider: ${app.stt.name}.`, ...eph });
        }
        if (sub === 'stop') {
          const musicActive = Boolean(music.peek(i.guildId)?.queue.current);
          return i.reply({ content: listener.stop(i.guildId, { musicActive }) ? '🔇 Stopped listening. Audio capture is off.' : 'I was not listening.', ...eph });
        }
        const vc = i.member.voice?.channelId;
        if (!vc) return i.reply({ content: 'Join a voice channel first.', ...eph });
        await i.deferReply();
        try {
          const textChannelId = getGuildSettings(app.db, i.guildId).channels.alpha ?? i.channelId;
          await listener.start(i.guild, vc, { textChannelId });
          return i.editReply({
            embeds: [guardianEmbed('aegis', {
              title: `🎙️ ${app.config.voice.wakeWord} is listening`,
              description: `In <#${vc}>. Only people allowed to use ${app.config.voice.wakeWord} here (the server owner and trusted users/roles) are transcribed — everyone else's audio is ignored.\nAudio is processed in memory and sent to **${app.stt.name}** for transcription; nothing is recorded to disk.\nSay **"${app.config.voice.wakeWord}, stop listening"** or use \`/listen stop\`.`,
            })],
          });
        } catch (err) {
          return i.editReply(`Could not start listening: ${err.message}`);
        }
      },
    },
    {
      data: new SlashCommandBuilder().setName('status').setDescription('Soul Society guardian system status'),
      execute: (i, app) => app.runSteps(i, [{ action: 'system.status', params: {} }], { ephemeral: true }),
    },

    // ---------------------------------------------------------------- music
    {
      data: new SlashCommandBuilder().setName('play').setDescription('Play music (Audius, Jamendo, Internet Archive) by name, link or playlist')
        .addStringOption((o) => o.setName('query').setDescription('Song / artist, an Audius/Jamendo/Archive link or playlist, or a YouTube/Spotify link to match').setRequired(true).setMaxLength(300)),
      execute: (i, app) => app.runSteps(i, [{ action: 'music.play', params: { query: i.options.getString('query') } }]),
    },
    {
      data: new SlashCommandBuilder().setName('search').setDescription('Search licensed music and pick a result')
        .addStringOption((o) => o.setName('query').setDescription('Song or artist').setRequired(true).setMaxLength(200)),
      execute: (i, app) => app.runSteps(i, [{ action: 'music.play', params: { query: i.options.getString('query'), pick: true } }]),
    },
    {
      data: new SlashCommandBuilder().setName('volume').setDescription('Set playback volume').addIntegerOption((o) => o.setName('percent').setDescription('0–150').setRequired(true).setMinValue(0).setMaxValue(150)),
      execute: (i, app) => app.runSteps(i, [{ action: 'music.volume', params: { percent: i.options.getInteger('percent') } }]),
    },
    { data: new SlashCommandBuilder().setName('shuffle').setDescription('Shuffle the queue'), execute: (i, app) => app.runSteps(i, [{ action: 'music.shuffle', params: {} }]) },
    {
      data: new SlashCommandBuilder().setName('loop').setDescription('Loop the current track or the whole queue')
        .addStringOption((o) => o.setName('mode').setDescription('Mode').setRequired(true).addChoices({ name: 'off', value: 'off' }, { name: 'track', value: 'track' }, { name: 'queue', value: 'queue' })),
      execute: (i, app) => app.runSteps(i, [{ action: 'music.loop', params: { mode: i.options.getString('mode') } }]),
    },
    { data: new SlashCommandBuilder().setName('skip').setDescription('Skip the current track'), execute: (i, app) => app.runSteps(i, [{ action: 'music.skip', params: {} }]) },
    { data: new SlashCommandBuilder().setName('pause').setDescription('Pause playback'), execute: (i, app) => app.runSteps(i, [{ action: 'music.pause', params: {} }]) },
    { data: new SlashCommandBuilder().setName('resume').setDescription('Resume playback'), execute: (i, app) => app.runSteps(i, [{ action: 'music.resume', params: {} }]) },
    { data: new SlashCommandBuilder().setName('stop').setDescription('Stop music and clear the queue'), execute: (i, app) => app.runSteps(i, [{ action: 'music.stop', params: {} }]) },
    { data: new SlashCommandBuilder().setName('nowplaying').setDescription('Show the current track'), execute: (i, app) => app.runSteps(i, [{ action: 'music.nowplaying', params: {} }]) },
    {
      data: new SlashCommandBuilder().setName('queue').setDescription('Show or edit the music queue')
        .addSubcommand((s) => s.setName('show').setDescription('Show the queue'))
        .addSubcommand((s) => s.setName('remove').setDescription('Remove a track').addIntegerOption((o) => o.setName('position').setDescription('Position').setRequired(true).setMinValue(1)))
        .addSubcommand((s) => s.setName('move').setDescription('Move a track')
          .addIntegerOption((o) => o.setName('from').setDescription('From').setRequired(true).setMinValue(1))
          .addIntegerOption((o) => o.setName('to').setDescription('To').setRequired(true).setMinValue(1))),
      async execute(i, app) {
        const sub = i.options.getSubcommand();
        if (sub === 'show') return app.runSteps(i, [{ action: 'music.queue', params: {} }]);
        const gm = music.peek(i.guildId);
        if (!gm) return i.reply({ content: 'No music session.', ...eph });
        try {
          const t = await gm.lock.run(async () => (sub === 'remove' ? gm.queue.remove(i.options.getInteger('position')) : gm.queue.move(i.options.getInteger('from'), i.options.getInteger('to'))));
          gm.persist();
          return i.reply({ content: `${sub === 'remove' ? 'Removed' : 'Moved'}: **${safeText(t.title, 100)}**` });
        } catch (err) {
          return i.reply({ content: err.message, ...eph });
        }
      },
    },

    // ---------------------------------------------------------------- progression
    {
      data: new SlashCommandBuilder().setName('balance').setDescription('Aura balance').addUserOption((o) => o.setName('member').setDescription('Member')),
      async execute(i, app) {
        const u = i.options.getUser('member') ?? i.user;
        const p = getProfile(app.db, i.guildId, u.id);
        return i.reply({ embeds: [guardianEmbed('aegis', { title: `${u.username}'s aura`, description: `✦ **${p.aura}** aura · season: ${p.season_aura}\nLevel ${p.level} · rank #${p.rank} · 🔥 ${p.streak}-day streak${p.title ? `\nTitle: **${p.title}**` : ''}` })] });
      },
    },
    {
      data: new SlashCommandBuilder().setName('daily').setDescription('Claim your daily aura'),
      async execute(i, app) {
        const r = claimDaily(app.db, { guildId: i.guildId, userId: i.user.id, settings: getGuildSettings(app.db, i.guildId), tz: app.config.timezone });
        if (!r.claimed) return i.reply({ content: 'You already claimed today\'s reward. Come back tomorrow!', ...eph });
        return i.reply({ embeds: [guardianEmbed('aegis', { title: 'Daily reward', description: `+${r.amount} aura${r.bonus ? ` (incl. ${r.bonus} streak bonus)` : ''}\n🔥 Streak: ${r.streak} · Balance: ${r.balance}${r.quests.length ? `\nQuest complete: ${r.quests.map((q) => q.name).join(', ')}` : ''}` })] });
      },
    },
    {
      data: new SlashCommandBuilder().setName('weekly').setDescription('Claim your weekly aura'),
      async execute(i, app) {
        const r = claimWeekly(app.db, { guildId: i.guildId, userId: i.user.id, settings: getGuildSettings(app.db, i.guildId), tz: app.config.timezone });
        return i.reply(r.claimed ? { content: `+${r.amount} aura! Balance: ${r.balance}` } : { content: 'Already claimed this week.', ...eph });
      },
    },
    {
      data: new SlashCommandBuilder().setName('rank').setDescription('Show a rank card').addUserOption((o) => o.setName('member').setDescription('Member')),
      async execute(i, app) {
        await i.deferReply();
        const u = i.options.getUser('member') ?? i.user;
        const m = await i.guild.members.fetch(u.id).catch(() => null);
        const p = getProfile(app.db, i.guildId, u.id);
        const cyan = Boolean(app.db.get(`SELECT 1 FROM inventory WHERE guild_id = ? AND user_id = ? AND item_id = 'aura_frame'`, i.guildId, u.id));
        const png = await renderRankCard({ displayName: m?.displayName ?? u.username, avatar: await profileAvatar(u), level: p.level, into: p.into, needed: p.needed, rank: p.rank, aura: p.aura, xp: p.xp, streak: p.streak, title: p.title, cyanFrame: cyan, serverName: displayNameOf(i.guild, getGuildSettings(app.db, i.guildId)) });
        return i.editReply({ files: [new AttachmentBuilder(png, { name: 'rank.png' })] });
      },
    },
    {
      data: new SlashCommandBuilder().setName('leaderboard').setDescription('Top souls')
        .addStringOption((o) => o.setName('by').setDescription('Ranking').addChoices({ name: 'aura', value: 'aura' }, { name: 'xp', value: 'xp' }, { name: 'season', value: 'season' })),
      async execute(i, app) {
        const by = i.options.getString('by') ?? 'aura';
        const rows = leaderboard(app.db, i.guildId, by);
        const medal = ['🥇', '🥈', '🥉'];
        const lines = rows.map((r, n) => `${medal[n] ?? `**${n + 1}.**`} <@${r.user_id}> — ${by === 'xp' ? `lvl ${r.level} (${r.xp} xp)` : by === 'season' ? `${r.season_aura} season aura` : `${r.aura} aura`}`);
        return i.reply({ embeds: [guardianEmbed('aegis', { title: `Leaderboard — ${by}`, description: lines.join('\n') || 'No souls ranked yet.' })], allowedMentions: { parse: [] } });
      },
    },
    {
      data: new SlashCommandBuilder().setName('quests').setDescription('Your daily and weekly quests'),
      async execute(i, app) {
        const qs = listQuests(app.db, { guildId: i.guildId, userId: i.user.id, tz: app.config.timezone });
        const fmt = (q) => `${q.completed ? '✅' : '▫️'} **${q.name}** — ${q.description} (${q.progress}/${q.goal}) · +${q.aura} aura`;
        return i.reply({
          embeds: [guardianEmbed('aegis', { title: 'Quests', fields: [{ name: 'Daily', value: qs.filter((q) => q.scope === 'daily').map(fmt).join('\n') }, { name: 'Weekly', value: qs.filter((q) => q.scope === 'weekly').map(fmt).join('\n') }] })],
          ...eph,
        });
      },
    },
    {
      data: new SlashCommandBuilder().setName('shop').setDescription('Aura shop'),
      async execute(i, app) {
        const items = listShop(app.db, i.guildId);
        return i.reply({ embeds: [guardianEmbed('aegis', { title: 'Aura shop', description: items.map((it) => `\`${it.id}\` **${it.name}** — ${it.price} aura${it.stock != null ? ` (${it.stock} left)` : ''}\n   ${it.description ?? ''}`).join('\n') + '\n\nBuy with `/buy item:<id>`' })] });
      },
    },
    {
      data: new SlashCommandBuilder().setName('buy').setDescription('Buy a shop item').addStringOption((o) => o.setName('item').setDescription('Item ID').setRequired(true).setAutocomplete(true)),
      async autocomplete(i, app) {
        const q = i.options.getFocused().toLowerCase();
        return i.respond(listShop(app.db, i.guildId).filter((x) => x.id.includes(q) || x.name.toLowerCase().includes(q)).slice(0, 25).map((x) => ({ name: `${x.name} — ${x.price}`.slice(0, 100), value: x.id })));
      },
      async execute(i, app) {
        try {
          const r = purchaseItem(app.db, { guildId: i.guildId, userId: i.user.id, itemId: i.options.getString('item'), purchaseId: i.id });
          if (r.item.kind === 'role' && r.item.role_id) {
            const role = await i.guild.roles.fetch(r.item.role_id).catch(() => null);
            const chk = role ? checkRoleManageable({ role, botMember: i.guild.members.me, actor: null, guild: i.guild, config: app.config }) : { ok: false, reason: 'Role no longer exists.' };
            const ok = chk.ok && (await i.member.roles.add(role, 'Aura shop purchase').then(() => true, () => false));
            if (!ok) {
              refundPurchase(app.db, { guildId: i.guildId, userId: i.user.id, purchaseRowId: r.purchaseRowId, reason: chk.reason ?? 'role delivery failed' });
              return i.reply({ content: `Could not deliver the role (${chk.reason ?? 'Discord refused'}). You were refunded.`, ...eph });
            }
          }
          return i.reply({ content: `✨ Bought **${r.item.name}**! Balance: ${r.balance} aura.` });
        } catch (err) {
          if (err instanceof EconomyError) return i.reply({ content: err.message, ...eph });
          throw err;
        }
      },
    },
    {
      data: new SlashCommandBuilder().setName('inventory').setDescription('Your items and purchase history'),
      async execute(i, app) {
        const inv = inventoryOf(app.db, i.guildId, i.user.id);
        return i.reply({
          embeds: [guardianEmbed('aegis', {
            title: 'Inventory',
            fields: [
              { name: 'Items', value: inv.items.map((x) => `• ${x.name ?? x.item_id}${x.quantity > 1 ? ` ×${x.quantity}` : ''}`).join('\n') || 'Empty' },
              { name: 'Recent purchases', value: inv.purchases.map((p) => `<t:${Math.floor(p.created_at / 1000)}:d> ${p.item_id} — ${p.price} (${p.status})`).join('\n') || 'None' },
            ],
          })],
          ...eph,
        });
      },
    },
    {
      data: new SlashCommandBuilder().setName('pay').setDescription('Send aura to a member')
        .addUserOption((o) => o.setName('member').setDescription('Recipient').setRequired(true))
        .addIntegerOption((o) => o.setName('amount').setDescription('Amount').setRequired(true).setMinValue(1).setMaxValue(100000)),
      async execute(i, app) {
        const to = i.options.getUser('member');
        try {
          const r = transferAura(app.db, { guildId: i.guildId, fromId: i.user.id, toId: to.id, toIsBot: to.bot, amount: i.options.getInteger('amount'), transferId: i.id, settings: getGuildSettings(app.db, i.guildId), fromJoinedAt: i.member.joinedTimestamp, tz: app.config.timezone });
          return i.reply({ content: `Sent ${i.options.getInteger('amount')} aura to <@${to.id}>. Your balance: ${r.balance}.`, allowedMentions: { parse: [] } });
        } catch (err) {
          if (err instanceof EconomyError) return i.reply({ content: err.message, ...eph });
          throw err;
        }
      },
    },
    {
      data: new SlashCommandBuilder().setName('economy').setDescription('Economy administration').setDefaultMemberPermissions(P.ManageGuild)
        .addSubcommand((s) => s.setName('grant').setDescription('Grant or revoke aura')
          .addUserOption((o) => o.setName('member').setDescription('Member').setRequired(true))
          .addIntegerOption((o) => o.setName('amount').setDescription('Negative to revoke').setRequired(true).setMinValue(-100000).setMaxValue(100000))
          .addStringOption((o) => o.setName('reason').setDescription('Reason (recorded in the ledger)').setRequired(true).setMaxLength(200)))
        .addSubcommand((s) => s.setName('shop-add').setDescription('Add or update a shop item')
          .addStringOption((o) => o.setName('id').setDescription('Short id').setRequired(true).setMaxLength(32))
          .addStringOption((o) => o.setName('name').setDescription('Name').setRequired(true).setMaxLength(80))
          .addIntegerOption((o) => o.setName('price').setDescription('Price').setRequired(true).setMinValue(0))
          .addStringOption((o) => o.setName('kind').setDescription('Kind').setRequired(true).addChoices({ name: 'title', value: 'title' }, { name: 'role', value: 'role' }, { name: 'cosmetic', value: 'cosmetic' }))
          .addRoleOption((o) => o.setName('role').setDescription('Role to give (kind=role)'))
          .addStringOption((o) => o.setName('title').setDescription('Title text (kind=title)').setMaxLength(40))
          .addIntegerOption((o) => o.setName('stock').setDescription('Limited stock').setMinValue(1)))
        .addSubcommand((s) => s.setName('season-end').setDescription('Archive season standings and start the next season'))
        .addSubcommand((s) => s.setName('level-role').setDescription('Unlock a role at a level').addIntegerOption((o) => o.setName('level').setDescription('Level').setRequired(true).setMinValue(1)).addRoleOption((o) => o.setName('role').setDescription('Role (omit to clear)'))),
      async execute(i, app) {
        if (!isAdmin(i, app)) return i.reply({ content: 'Admins only.', ...eph });
        const sub = i.options.getSubcommand();
        if (sub === 'grant') return app.runSteps(i, [{ action: 'economy.grant', params: { member: `<@${i.options.getUser('member').id}>`, amount: i.options.getInteger('amount'), reason: i.options.getString('reason') } }]);
        if (sub === 'shop-add') {
          const role = i.options.getRole('role');
          if (role) {
            const chk = checkRoleManageable({ role, botMember: i.guild.members.me, actor: i.member, guild: i.guild, config: app.config });
            if (!chk.ok) return i.reply({ content: chk.reason, ...eph });
            if (role.permissions.has('Administrator') || role.permissions.has('ManageGuild')) return i.reply({ content: 'Privileged roles cannot be sold in the shop.', ...eph });
          }
          addShopItem(app.db, i.guildId, { id: i.options.getString('id').toLowerCase(), name: i.options.getString('name'), price: i.options.getInteger('price'), kind: i.options.getString('kind'), roleId: role?.id, title: i.options.getString('title'), stock: i.options.getInteger('stock') });
          audit(app.db, { guildId: i.guildId, actorId: i.user.id, bot: 'aegis', action: 'shop.update', target: i.options.getString('id'), outcome: 'success' });
          return i.reply({ content: 'Shop item saved.', ...eph });
        }
        if (sub === 'season-end') {
          const s = getGuildSettings(app.db, i.guildId);
          const top = endSeason(app.db, i.guildId, s.progression.season);
          setGuildSetting(app.db, i.guildId, 'progression.season', s.progression.season + 1);
          audit(app.db, { guildId: i.guildId, actorId: i.user.id, bot: 'aegis', action: 'season.end', target: String(s.progression.season), outcome: 'success' });
          return i.reply({ embeds: [guardianEmbed('aegis', { title: `Season ${s.progression.season} complete`, description: top.map((r, n) => `**${n + 1}.** <@${r.user_id}> — ${r.season_aura}`).join('\n') || 'No standings.' })], allowedMentions: { parse: [] } });
        }
        if (sub === 'level-role') {
          const s = getGuildSettings(app.db, i.guildId);
          const map = { ...s.progression.levelRoles };
          const role = i.options.getRole('role');
          if (role) {
            const chk = checkRoleManageable({ role, botMember: i.guild.members.me, actor: i.member, guild: i.guild, config: app.config });
            if (!chk.ok) return i.reply({ content: chk.reason, ...eph });
            map[String(i.options.getInteger('level'))] = role.id;
          } else delete map[String(i.options.getInteger('level'))];
          setGuildSetting(app.db, i.guildId, 'progression.levelRoles', map);
          return i.reply({ content: 'Level rewards updated.', ...eph });
        }
      },
    },

    // ---------------------------------------------------------------- intelligence
    {
      data: new SlashCommandBuilder().setName('research').setDescription('Research the public web (sourced)')
        .addStringOption((o) => o.setName('query').setDescription('Topic').setRequired(true).setMaxLength(200))
        .addStringOption((o) => o.setName('timeframe').setDescription('Timeframe').addChoices({ name: 'today', value: 'today' }, { name: 'this week', value: 'week' }, { name: 'any time', value: 'any' }))
        .addChannelOption((o) => o.setName('post_in').setDescription('Post the summary in this channel').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)),
      execute: (i, app) => app.runSteps(i, [{ action: 'research.run', params: { query: i.options.getString('query'), timeframe: i.options.getString('timeframe') ?? 'today', channel: ch(i.options.getChannel('post_in')) } }]),
    },
    {
      data: new SlashCommandBuilder().setName('report').setDescription('Server activity report').setDefaultMemberPermissions(P.ModerateMembers)
        .addStringOption((o) => o.setName('period').setDescription('Period').addChoices({ name: 'today', value: 'today' }, { name: 'last 7 days', value: 'week' })),
      execute: (i, app) => app.runSteps(i, [{ action: 'report.activity', params: { period: i.options.getString('period') ?? 'today' } }]),
    },
    {
      data: new SlashCommandBuilder().setName('schedule').setDescription('Scheduled messages').setDefaultMemberPermissions(P.ManageGuild)
        .addSubcommand((s) => s.setName('message').setDescription('Schedule a message')
          .addChannelOption((o) => o.setName('channel').setDescription('Channel').setRequired(true).addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
          .addStringOption((o) => o.setName('when').setDescription('in 2 hours · tomorrow 9am · 18:30 · every day at 9am').setRequired(true))
          .addStringOption((o) => o.setName('text').setDescription('Message').setRequired(true).setMaxLength(1900)))
        .addSubcommand((s) => s.setName('list').setDescription('List scheduled jobs'))
        .addSubcommand((s) => s.setName('cancel').setDescription('Cancel a job').addStringOption((o) => o.setName('id').setDescription('Job ID prefix').setRequired(true))),
      async execute(i, app) {
        const sub = i.options.getSubcommand();
        if (sub === 'list') {
          const jobs = listJobs(app.db, i.guildId);
          return i.reply({ embeds: [guardianEmbed('aegis', { title: 'Scheduled jobs', description: jobs.map((j) => `\`${j.id.slice(0, 8)}\` **${j.type}** next <t:${Math.floor(j.next_run_at / 1000)}:R>${j.schedule.kind !== 'once' ? ` (${j.schedule.kind}${j.schedule.time ? ` ${j.schedule.time}` : ''})` : ''}${j.failures ? ` ⚠️ ${j.failures} failures` : ''}`).join('\n') || 'None.' })], ...eph });
        }
        if (sub === 'cancel') {
          const prefix = i.options.getString('id').trim();
          const job = listJobs(app.db, i.guildId).find((j) => j.id.startsWith(prefix));
          if (!job || !isAdmin(i, app)) return i.reply({ content: 'No such job (or not allowed).', ...eph });
          cancelJob(app.db, job.id);
          audit(app.db, { guildId: i.guildId, actorId: i.user.id, bot: 'aegis', action: 'job.cancel', target: job.id, outcome: 'success' });
          return i.reply({ content: `Cancelled ${job.type} ${job.id.slice(0, 8)}.`, ...eph });
        }
        const w = whenFrom(i.options.getString('when'), app);
        if (!w) return i.reply({ content: 'I could not understand that time.', ...eph });
        return app.runSteps(i, [{ action: 'schedule.message', params: { channel: ch(i.options.getChannel('channel')), message: i.options.getString('text'), ...(w.at ? { at: w.at } : { dailyTime: w.dailyTime }) } }], { ephemeral: true });
      },
    },
    {
      data: new SlashCommandBuilder().setName('remind').setDescription('Set a reminder')
        .addStringOption((o) => o.setName('when').setDescription('in 20 minutes · tomorrow 9am · 18:30').setRequired(true))
        .addStringOption((o) => o.setName('text').setDescription('What to remind you about').setRequired(true).setMaxLength(500)),
      async execute(i, app) {
        const w = whenFrom(i.options.getString('when'), app);
        if (!w?.at) return i.reply({ content: 'I could not understand that time.', ...eph });
        return app.runSteps(i, [{ action: 'reminder.create', params: { message: i.options.getString('text'), at: w.at } }], { ephemeral: true });
      },
    },
    {
      data: new SlashCommandBuilder().setName('event').setDescription('Community events')
        .addSubcommand((s) => s.setName('create').setDescription('Create an event (admins)')
          .addStringOption((o) => o.setName('name').setDescription('Name').setRequired(true).setMaxLength(100))
          .addStringOption((o) => o.setName('when').setDescription('tomorrow 9pm · saturday 8pm · in 3 hours').setRequired(true))
          .addStringOption((o) => o.setName('duration').setDescription('e.g. 2h (default 1h)'))
          .addIntegerOption((o) => o.setName('reward').setDescription('Aura per participant').setMinValue(0).setMaxValue(10000))
          .addStringOption((o) => o.setName('description').setDescription('Description').setMaxLength(1000))
          .addChannelOption((o) => o.setName('channel').setDescription('Announcement channel').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)))
        .addSubcommand((s) => s.setName('list').setDescription('Upcoming events')),
      async execute(i, app) {
        if (i.options.getSubcommand() === 'list') {
          const rows = app.db.all(`SELECT * FROM events WHERE guild_id = ? AND status IN ('scheduled','live') ORDER BY starts_at LIMIT 10`, i.guildId);
          return i.reply({ embeds: [guardianEmbed('aegis', { title: 'Upcoming events', description: rows.map((e) => `**${safeText(e.name)}** <t:${Math.floor(e.starts_at / 1000)}:F> · ${e.reward} aura · \`${e.id}\``).join('\n') || 'None.' })], ...eph });
        }
        const w = whenFrom(i.options.getString('when'), app);
        if (!w?.at) return i.reply({ content: 'I could not understand the start time.', ...eph });
        const dur = i.options.getString('duration') ? parseDuration(i.options.getString('duration')) : 3600000;
        return app.runSteps(i, [{ action: 'event.create', params: { name: i.options.getString('name'), startsAt: w.at, durationMs: dur, reward: i.options.getInteger('reward') ?? 100, description: i.options.getString('description'), channel: ch(i.options.getChannel('channel')) } }]);
      },
    },

    // ---------------------------------------------------------------- administration
    {
      data: new SlashCommandBuilder().setName('channel').setDescription('Channel automation').setDefaultMemberPermissions(P.ManageChannels)
        .addSubcommand((s) => s.setName('create').setDescription('Create a channel')
          .addStringOption((o) => o.setName('name').setDescription('Name').setRequired(true).setMaxLength(90))
          .addStringOption((o) => o.setName('type').setDescription('Type').addChoices(...['text', 'voice', 'announcement', 'category', 'forum'].map((v) => ({ name: v, value: v }))))
          .addStringOption((o) => o.setName('template').setDescription('Access').addChoices({ name: 'public', value: 'public' }, { name: 'read-only', value: 'readonly' }, { name: 'private', value: 'private' }))
          .addChannelOption((o) => o.setName('category').setDescription('Parent category').addChannelTypes(ChannelType.GuildCategory)))
        .addSubcommand((s) => s.setName('rename').setDescription('Rename a channel')
          .addChannelOption((o) => o.setName('channel').setDescription('Channel').setRequired(true))
          .addStringOption((o) => o.setName('name').setDescription('New name').setRequired(true).setMaxLength(90)))
        .addSubcommand((s) => s.setName('delete').setDescription('Delete a channel (asks for confirmation)').addChannelOption((o) => o.setName('channel').setDescription('Channel').setRequired(true)))
        .addSubcommand((s) => s.setName('permit').setDescription('Apply a permission template')
          .addChannelOption((o) => o.setName('channel').setDescription('Channel').setRequired(true))
          .addMentionableOption((o) => o.setName('target').setDescription('Role or member').setRequired(true))
          .addStringOption((o) => o.setName('template').setDescription('Template').setRequired(true).addChoices(...['access', 'view', 'readonly', 'deny', 'mute', 'manage'].map((v) => ({ name: v, value: v }))))),
      async execute(i, app) {
        const sub = i.options.getSubcommand();
        if (sub === 'create') return app.runSteps(i, [{ action: 'channel.create', params: { name: i.options.getString('name'), type: i.options.getString('type') ?? 'text', template: i.options.getString('template') ?? 'public', category: ch(i.options.getChannel('category')) } }]);
        if (sub === 'rename') return app.runSteps(i, [{ action: 'channel.rename', params: { channel: ch(i.options.getChannel('channel')), name: i.options.getString('name') } }]);
        if (sub === 'delete') return app.runSteps(i, [{ action: 'channel.delete', params: { channel: ch(i.options.getChannel('channel')) } }]);
        const opt = i.options.get('target', true);
        const target = opt.role ? (opt.role.id === i.guildId ? '@everyone' : `<@&${opt.role.id}>`) : `<@${opt.user.id}>`;
        return app.runSteps(i, [{ action: 'channel.permit', params: { channel: ch(i.options.getChannel('channel')), target, template: i.options.getString('template') } }]);
      },
    },
    {
      data: new SlashCommandBuilder().setName('role').setDescription('Role automation').setDefaultMemberPermissions(P.ManageRoles)
        .addSubcommand((s) => s.setName('create').setDescription('Create a role')
          .addStringOption((o) => o.setName('name').setDescription('Name').setRequired(true).setMaxLength(100))
          .addStringOption((o) => o.setName('template').setDescription('Permissions').addChoices({ name: 'none', value: 'none' }, { name: 'basic member', value: 'basic' }, { name: 'moderator (confirm)', value: 'moderator' }))
          .addStringOption((o) => o.setName('color').setDescription('#hex colour'))
          .addBooleanOption((o) => o.setName('hoist').setDescription('Show separately')))
        .addSubcommand((s) => s.setName('give').setDescription('Give a role').addRoleOption((o) => o.setName('role').setDescription('Role').setRequired(true)).addUserOption((o) => o.setName('member').setDescription('Member').setRequired(true)))
        .addSubcommand((s) => s.setName('take').setDescription('Remove a role').addRoleOption((o) => o.setName('role').setDescription('Role').setRequired(true)).addUserOption((o) => o.setName('member').setDescription('Member').setRequired(true)))
        .addSubcommand((s) => s.setName('delete').setDescription('Delete a role (asks for confirmation)').addRoleOption((o) => o.setName('role').setDescription('Role').setRequired(true))),
      async execute(i, app) {
        const sub = i.options.getSubcommand();
        const role = i.options.getRole('role');
        const user = i.options.getUser('member');
        if (sub === 'create') return app.runSteps(i, [{ action: 'role.create', params: { name: i.options.getString('name'), template: i.options.getString('template') ?? 'none', color: i.options.getString('color'), hoist: i.options.getBoolean('hoist') ?? false } }]);
        if (sub === 'give') return app.runSteps(i, [{ action: 'role.assign', params: { role: `<@&${role.id}>`, member: `<@${user.id}>` } }]);
        if (sub === 'take') return app.runSteps(i, [{ action: 'role.remove', params: { role: `<@&${role.id}>`, member: `<@${user.id}>` } }]);
        return app.runSteps(i, [{ action: 'role.delete', params: { role: `<@&${role.id}>` } }]);
      },
    },
    {
      data: new SlashCommandBuilder().setName('announce').setDescription('Send an announcement').setDefaultMemberPermissions(P.ManageGuild)
        .addChannelOption((o) => o.setName('channel').setDescription('Channel').setRequired(true).addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
        .addStringOption((o) => o.setName('message').setDescription('Message').setRequired(true).setMaxLength(1900))
        .addBooleanOption((o) => o.setName('ping_everyone').setDescription('Mention @everyone')),
      execute: (i, app) => app.runSteps(i, [{ action: 'announce.send', params: { channel: ch(i.options.getChannel('channel')), message: i.options.getString('message'), pingEveryone: i.options.getBoolean('ping_everyone') ?? false } }]),
    },
    {
      data: new SlashCommandBuilder().setName('setup').setDescription('Configure Soul Society channels and features').setDefaultMemberPermissions(P.ManageGuild)
        .addSubcommand((s) => s.setName('view').setDescription('Show configuration'))
        .addSubcommand((s) => s.setName('channel').setDescription('Assign a channel role')
          .addStringOption((o) => o.setName('purpose').setDescription('Purpose').setRequired(true).addChoices(...['welcome', 'leave', 'research', 'reports', 'announcements', 'alpha', 'music', 'securityLog', 'modLog'].map((v) => ({ name: v, value: v }))))
          .addChannelOption((o) => o.setName('channel').setDescription('Channel (omit to clear)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)))
        .addSubcommand((s) => s.setName('welcome').setDescription('Welcome settings')
          .addBooleanOption((o) => o.setName('enabled').setDescription('Send welcome cards'))
          .addStringOption((o) => o.setName('format').setDescription('Card format').addChoices({ name: 'static PNG', value: 'png' }, { name: 'animated GIF', value: 'gif' }, { name: 'MP4 video', value: 'mp4' }))
          .addStringOption((o) => o.setName('message').setDescription('Template: {mention} {name} {server} {count}').setMaxLength(500))
          .addStringOption((o) => o.setName('leave_message').setDescription('Template: {name} {server}').setMaxLength(500))
          .addStringOption((o) => o.setName('tagline').setDescription('Card tagline, e.g. HAS ENTERED SOUL SOCIETY').setMaxLength(40))
          .addAttachmentOption((o) => o.setName('background').setDescription('Custom card background (PNG/JPG/WebP, ≤ 8 MB, 1200×500 recommended)'))
          .addBooleanOption((o) => o.setName('reset_background').setDescription('Use the default background again')))
        .addSubcommand((s) => s.setName('trusted').setDescription('Who may use ALPHA here (besides the server owner)')
          .addStringOption((o) => o.setName('action').setDescription('Action').setRequired(true).addChoices({ name: 'add', value: 'add' }, { name: 'remove', value: 'remove' }, { name: 'list', value: 'list' }))
          .addUserOption((o) => o.setName('user').setDescription('Trusted user'))
          .addRoleOption((o) => o.setName('role').setDescription('Trusted role')))
        .addSubcommand((s) => s.setName('music').setDescription('Music defaults')
          .addIntegerOption((o) => o.setName('volume').setDescription('Default volume 0–150').setMinValue(0).setMaxValue(150))
          .addRoleOption((o) => o.setName('dj_role').setDescription('Only this role (and admins/requesters) can skip/stop/shuffle'))
          .addBooleanOption((o) => o.setName('clear_dj_role').setDescription('Remove the DJ role restriction'))
          .addBooleanOption((o) => o.setName('announce_tracks').setDescription('Post "Now playing" messages')))
        .addSubcommand((s) => s.setName('branding').setDescription('Name shown on welcome cards and messages')
          .addStringOption((o) => o.setName('name').setDescription('Display name (empty = this server\'s name)').setMaxLength(60)))
        .addSubcommand((s) => s.setName('reports').setDescription('Scheduled activity reports')
          .addBooleanOption((o) => o.setName('daily').setDescription('Daily report'))
          .addStringOption((o) => o.setName('daily_time').setDescription('HH:MM'))
          .addBooleanOption((o) => o.setName('weekly').setDescription('Weekly report (Sunday)')))
        .addSubcommand((s) => s.setName('alpha').setDescription('ALPHA behaviour')
          .addBooleanOption((o) => o.setName('speak').setDescription('Speak results in voice (Windows TTS)'))
          .addBooleanOption((o) => o.setName('confirm_medium_voice').setDescription('Confirm medium-risk voice commands'))
          .addBooleanOption((o) => o.setName('text_prefix').setDescription('Accept typed "ALPHA, ..." messages'))),
      async execute(i, app) {
        if (!isAdmin(i, app)) return i.reply({ content: 'Admins only.', ...eph });
        const sub = i.options.getSubcommand();
        const set = (path, v) => {
          setGuildSetting(app.db, i.guildId, path, v);
          audit(app.db, { guildId: i.guildId, actorId: i.user.id, bot: 'aegis', action: 'settings.update', target: path, params: { value: v }, outcome: 'success' });
        };
        const s = getGuildSettings(app.db, i.guildId);
        if (sub === 'view') {
          return i.reply({
            embeds: [guardianEmbed('aegis', {
              title: 'Soul Society configuration',
              fields: [
                { name: 'Channels', value: Object.entries(s.channels).map(([k, v]) => `${k}: ${v ? `<#${v}>` : '—'}`).join('\n') },
                { name: 'Welcome', value: `${s.welcome.enabled ? 'on' : 'off'} · ${s.welcome.format}\n${safeText(s.welcome.message, 200)}` },
                { name: 'Reports', value: `daily ${s.reports.dailyEnabled ? `at ${s.reports.dailyTime}` : 'off'} · weekly ${s.reports.weeklyEnabled ? 'on' : 'off'}`, inline: true },
                { name: 'ALPHA', value: `speak ${s.alpha.speakResponses ? 'on' : 'off'} · confirm medium voice ${s.alpha.confirmMediumFromVoice ? 'on' : 'off'} · text prefix ${s.alpha.textPrefixEnabled ? 'on' : 'off'}`, inline: true },
                { name: 'Moderation', value: s.moderation.simulate ? '🧪 simulation (configure via KNIGHT /modconfig)' : '⚔️ enforcing', inline: true },
              ],
            })],
            ...eph,
          });
        }
        if (sub === 'channel') set(`channels.${i.options.getString('purpose')}`, i.options.getChannel('channel')?.id ?? null);
        if (sub === 'welcome') {
          const e = i.options.getBoolean('enabled');
          const f = i.options.getString('format');
          const m = i.options.getString('message');
          const l = i.options.getString('leave_message');
          if (e != null) set('welcome.enabled', e);
          if (f) set('welcome.format', f);
          if (m) set('welcome.message', m);
          if (l) set('welcome.leaveMessage', l);
          const tg = i.options.getString('tagline');
          if (tg) set('welcome.tagline', tg.toUpperCase());
          if (i.options.getBoolean('reset_background')) {
            removeGuildBackground(app.config, i.guildId);
            set('welcome.background', null);
          }
          const att = i.options.getAttachment('background');
          if (att) {
            await i.deferReply(eph);
            try {
              const file = await saveGuildBackground(app.config, i.guildId, att);
              set('welcome.background', file);
            } catch (err) {
              return i.editReply(`Background not saved: ${err.message}`);
            }
            return i.editReply('✅ Saved. Preview it with /welcome-test.');
          }
        }
        if (sub === 'trusted') {
          const action = i.options.getString('action');
          const user = i.options.getUser('user');
          const role = i.options.getRole('role');
          if (action === 'list') {
            return i.reply({ content: `ALPHA access here: the server owner${s.alpha.trustedUserIds.length ? `, ${s.alpha.trustedUserIds.map((u) => `<@${u}>`).join(', ')}` : ''}${s.alpha.trustedRoleIds.length ? `, roles ${s.alpha.trustedRoleIds.map((r) => `<@&${r}>`).join(', ')}` : ''}.`, allowedMentions: { parse: [] }, ...eph });
          }
          if (!user && !role) return i.reply({ content: 'Choose a user or a role.', ...eph });
          if (user?.bot) return i.reply({ content: 'Bots cannot be trusted with ALPHA.', ...eph });
          const edit = (key, id) => {
            const set2 = new Set(s.alpha[key]);
            action === 'add' ? set2.add(id) : set2.delete(id);
            if (set2.size > 25) throw new Error('At most 25 trusted entries.');
            set(`alpha.${key}`, [...set2]);
          };
          try {
            if (user) edit('trustedUserIds', user.id);
            if (role) edit('trustedRoleIds', role.id);
          } catch (err) {
            return i.reply({ content: err.message, ...eph });
          }
        }
        if (sub === 'music') {
          const v = i.options.getInteger('volume');
          const dj = i.options.getRole('dj_role');
          const at = i.options.getBoolean('announce_tracks');
          if (v != null) set('music.volume', v);
          if (dj) set('music.djRoleId', dj.id);
          if (i.options.getBoolean('clear_dj_role')) set('music.djRoleId', null);
          if (at != null) set('music.announceTracks', at);
        }
        if (sub === 'branding') {
          const n = i.options.getString('name')?.trim();
          set('branding.displayName', n ? n : null);
        }
        if (sub === 'reports') {
          const d = i.options.getBoolean('daily');
          const t = i.options.getString('daily_time');
          const w = i.options.getBoolean('weekly');
          if (t && !/^\d{1,2}:\d{2}$/.test(t)) return i.reply({ content: 'Time must be HH:MM.', ...eph });
          if (d != null) set('reports.dailyEnabled', d);
          if (t) set('reports.dailyTime', t);
          if (w != null) set('reports.weeklyEnabled', w);
          syncReportJobs(app, i.guildId);
        }
        if (sub === 'alpha') {
          const sp = i.options.getBoolean('speak');
          const cm = i.options.getBoolean('confirm_medium_voice');
          const tp = i.options.getBoolean('text_prefix');
          if (sp != null) set('alpha.speakResponses', sp);
          if (cm != null) set('alpha.confirmMediumFromVoice', cm);
          if (tp != null) set('alpha.textPrefixEnabled', tp);
        }
        return i.reply({ content: '✅ Saved.', ...eph });
      },
    },
    {
      data: new SlashCommandBuilder().setName('welcome-test').setDescription('Preview the welcome card').setDefaultMemberPermissions(P.ManageGuild)
        .addUserOption((o) => o.setName('member').setDescription('Member to preview'))
        .addStringOption((o) => o.setName('format').setDescription('Format').addChoices({ name: 'png', value: 'png' }, { name: 'gif', value: 'gif' }, { name: 'mp4', value: 'mp4' })),
      async execute(i, app) {
        await i.deferReply();
        const user = i.options.getUser('member') ?? i.user;
        const member = await i.guild.members.fetch(user.id);
        const card = await buildWelcomeCard(member, { config: app.config, settings: getGuildSettings(app.db, i.guildId), format: i.options.getString('format') ?? 'png', logger: app.logger });
        return i.editReply({
          content: card.usedOriginal ? '' : '⚠️ No background image configured — showing the built-in design. Upload one with `/setup welcome background:`.',
          files: [new AttachmentBuilder(card.buffer, { name: `welcome.${card.format}` })],
        });
      },
    },
    ...configCommands({ listener, music }),
  ];
}

export async function onEventJoinButton(i, app) {
  const eventId = i.customId.split(':')[2];
  const r = joinEvent(app.db, eventId, i.user.id);
  const msg = !r.ok ? (r.reason === 'closed' ? 'This event has ended.' : 'Event not found.') : r.already ? 'You are already registered.' : `You joined **${safeText(r.event.name)}**! Rewards are given when it ends.`;
  return i.reply({ content: msg, ...eph });
}

export function errorEmbed(text) {
  return guardianEmbed('aegis', { title: 'Error', color: STATUS_COLORS.error, description: text });
}
