// MOCK Discord guild for tests and the offline simulator.
// It implements the subset of the discord.js API the handlers use, enforces
// basic permission/hierarchy rules like Discord does, and supports failure
// injection. A passing test against this mock is NOT proof that the live
// Discord API behaves the same way.
import { Collection, PermissionsBitField, ChannelType } from 'discord.js';

let seq = 100000000000000000n;
export const snowflake = () => String(++seq);

class DiscordAPIError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

const ALL = PermissionsBitField.All;

export class MockRole {
  constructor(guild, { id = snowflake(), name, position = 1, permissions = [], managed = false, color = 0 }) {
    Object.assign(this, { guild, id, name, position, managed, color, hoist: false, mentionable: false });
    this.permissions = new PermissionsBitField(permissions);
  }
  get members() {
    return this.guild.members.cache.filter((m) => m.roles.cache.has(this.id));
  }
  async delete() {
    this.guild.maybeFail('role.delete');
    this.guild.roles.cache.delete(this.id);
    for (const m of this.guild.members.cache.values()) m.roles.cache.delete(this.id);
  }
}

export class MockMember {
  constructor(guild, { id = snowflake(), username, displayName, bot = false, roles = [], createdTimestamp = Date.now() - 365 * 86400000, joinedTimestamp = Date.now() - 30 * 86400000 }) {
    this.guild = guild;
    this.id = id;
    this.user = { id, username, globalName: displayName ?? username, bot, createdTimestamp, tag: username, displayAvatarURL: () => 'https://cdn.discordapp.com/embed/avatars/0.png' };
    this.displayName = displayName ?? username;
    this.nickname = null;
    this.joinedTimestamp = joinedTimestamp;
    this.communicationDisabledUntilTimestamp = null;
    this.voice = { channelId: null };
    this.dms = [];
    const self = this;
    this.roles = {
      cache: new Collection(roles.map((r) => [r.id, r])),
      get highest() {
        return [...this.cache.values()].reduce((a, b) => (b.position > a.position ? b : a), guild.roles.everyone);
      },
      async add(role) {
        guild.maybeFail('member.roles.add');
        guild.assertCanManageRole(role);
        this.cache.set(role.id, role);
        return self;
      },
      async remove(role) {
        guild.maybeFail('member.roles.remove');
        guild.assertCanManageRole(role);
        this.cache.delete(role.id);
        return self;
      },
    };
  }
  get permissions() {
    if (this.id === this.guild.ownerId) return new PermissionsBitField(ALL);
    let bits = this.guild.roles.everyone.permissions.bitfield;
    for (const r of this.roles.cache.values()) bits |= r.permissions.bitfield;
    return new PermissionsBitField(bits);
  }
  displayAvatarURL() {
    return 'https://cdn.discordapp.com/embed/avatars/0.png';
  }
  async send(payload) {
    this.dms.push(payload);
    return { id: snowflake() };
  }
  async timeout(ms) {
    this.guild.maybeFail('member.timeout');
    this.guild.assertHierarchy(this, 'ModerateMembers');
    if (this.permissions.has('Administrator')) throw new DiscordAPIError('Missing Permissions', 50013);
    this.communicationDisabledUntilTimestamp = ms == null ? null : Date.now() + ms;
    return this;
  }
  async kick() {
    this.guild.maybeFail('member.kick');
    this.guild.assertHierarchy(this, 'KickMembers');
    this.guild.members.cache.delete(this.id);
  }
}

export class MockChannel {
  constructor(guild, { id = snowflake(), name, type = ChannelType.GuildText, parentId = null, permissionOverwrites = [] }) {
    Object.assign(this, { guild, id, name, type, parentId, messages: [], deletable: true, topic: null });
    const ch = this;
    this.permissionOverwrites = {
      cache: new Collection(),
      async edit(target, overwrite) {
        guild.maybeFail('channel.permissionOverwrites.edit');
        const me = guild.members.me;
        if (!ch.permissionsFor(me).has('ManageRoles')) throw new DiscordAPIError('Missing Permissions', 50013);
        const id = typeof target === 'string' ? target : target.id;
        const cur = this.cache.get(id) ?? { id, allow: new PermissionsBitField(), deny: new PermissionsBitField() };
        for (const [perm, v] of Object.entries(overwrite)) {
          if (v === true) {
            cur.allow.add(perm);
            cur.deny.remove(perm);
          } else if (v === false) {
            cur.deny.add(perm);
            cur.allow.remove(perm);
          } else {
            cur.allow.remove(perm);
            cur.deny.remove(perm);
          }
        }
        this.cache.set(id, cur);
        return ch;
      },
    };
    for (const o of permissionOverwrites) {
      this.permissionOverwrites.cache.set(o.id, { id: o.id, allow: new PermissionsBitField(o.allow ?? []), deny: new PermissionsBitField(o.deny ?? []) });
    }
  }
  permissionsFor(member) {
    const base = member.permissions;
    if (base.has('Administrator')) return new PermissionsBitField(ALL);
    let bits = base.bitfield;
    const apply = (ow) => {
      if (!ow) return;
      bits &= ~ow.deny.bitfield;
      bits |= ow.allow.bitfield;
    };
    apply(this.permissionOverwrites.cache.get(this.guild.id));
    for (const r of member.roles?.cache?.values() ?? []) apply(this.permissionOverwrites.cache.get(r.id));
    apply(this.permissionOverwrites.cache.get(member.id));
    return new PermissionsBitField(bits);
  }
  async send(payload) {
    this.guild.maybeFail('channel.send');
    const msg = { id: snowflake(), channelId: this.id, ...(typeof payload === 'string' ? { content: payload } : payload) };
    this.messages.push(msg);
    return msg;
  }
  async sendTyping() {}
  async setName(name) {
    this.guild.maybeFail('channel.setName');
    this.name = name;
    return this;
  }
  async delete() {
    this.guild.maybeFail('channel.delete');
    this.guild.channels.cache.delete(this.id);
  }
}

export class MockGuild {
  constructor({ id = snowflake(), name = 'MOCK 𓆩 VOIDWORKS 𓆪', ownerId = snowflake(), botPermissions = ['Administrator'] } = {}) {
    this.mock = true;
    this.id = id;
    this.name = name;
    this.ownerId = ownerId;
    this.failures = new Map();
    this.afkChannelId = null;
    const guild = this;
    const everyone = new MockRole(this, { id, name: '@everyone', position: 0, permissions: ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'Connect', 'Speak'] });
    this.roles = {
      cache: new Collection([[everyone.id, everyone]]),
      everyone,
      async fetch(rid) {
        guild.maybeFail('roles.fetch');
        const r = this.cache.get(rid);
        if (!r) throw new DiscordAPIError('Unknown Role', 10011);
        return r;
      },
      async create(o) {
        guild.maybeFail('roles.create');
        const me = guild.members.me;
        if (!me.permissions.has('ManageRoles')) throw new DiscordAPIError('Missing Permissions', 50013);
        const perms = new PermissionsBitField(o.permissions ?? []);
        if (!me.permissions.has('Administrator') && (perms.bitfield & ~me.permissions.bitfield) !== 0n) throw new DiscordAPIError('Missing Permissions', 50013);
        const role = new MockRole(guild, { name: o.name, position: 1, permissions: perms.bitfield, color: o.color });
        for (const r of this.cache.values()) if (r.id !== guild.id && r.position >= 1) r.position++;
        this.cache.set(role.id, role);
        return role;
      },
    };
    this.channels = {
      cache: new Collection(),
      async fetch(cid) {
        guild.maybeFail('channels.fetch');
        const c = this.cache.get(cid);
        if (!c) throw new DiscordAPIError('Unknown Channel', 10003);
        return c;
      },
      async create(o) {
        guild.maybeFail('channels.create');
        if (!guild.members.me.permissions.has('ManageChannels')) throw new DiscordAPIError('Missing Permissions', 50013);
        if (o.type === ChannelType.GuildAnnouncement && !guild.community) throw new DiscordAPIError('Invalid Form Body', 50035);
        const c = new MockChannel(guild, { name: o.name, type: o.type ?? ChannelType.GuildText, parentId: o.parent ?? null, permissionOverwrites: o.permissionOverwrites ?? [] });
        this.cache.set(c.id, c);
        return c;
      },
    };
    this.members = {
      cache: new Collection(),
      me: null,
      async fetchMe() {
        return this.me;
      },
      async fetch(arg) {
        guild.maybeFail('members.fetch');
        if (arg === undefined) return this.cache;
        if (typeof arg === 'string' || (arg && arg.user)) {
          const id = typeof arg === 'string' ? arg : arg.user;
          const m = this.cache.get(id);
          if (!m) throw new DiscordAPIError('Unknown Member', 10007);
          return m;
        }
        if (arg?.query) {
          const q = arg.query.toLowerCase();
          return this.cache.filter((m) => m.displayName.toLowerCase().startsWith(q) || m.user.username.toLowerCase().startsWith(q));
        }
        return this.cache;
      },
      async ban(id) {
        guild.maybeFail('members.ban');
        const m = this.cache.get(id);
        if (m) guild.assertHierarchy(m, 'BanMembers');
        guild.bans.cache.set(id, { user: m?.user ?? { id, username: id } });
        this.cache.delete(id);
      },
    };
    this.bans = {
      cache: new Collection(),
      async fetch(arg) {
        const id = typeof arg === 'string' ? arg : arg.user;
        const b = this.cache.get(id);
        if (!b) throw new DiscordAPIError('Unknown Ban', 10026);
        return b;
      },
      async remove(id) {
        if (!this.cache.delete(id)) throw new DiscordAPIError('Unknown Ban', 10026);
      },
    };
    this.scheduledEvents = {
      created: [],
      async create(o) {
        const e = { id: snowflake(), ...o };
        this.created.push(e);
        return e;
      },
    };
    // The bot itself, with a role near the top.
    const botRole = new MockRole(this, { name: 'Guardian', position: 50, permissions: botPermissions });
    this.roles.cache.set(botRole.id, botRole);
    this.members.me = this.addMember({ username: 'GUARDIAN-BOT', bot: true, roles: [botRole] });
    this.owner = this.addMember({ id: ownerId, username: 'owner' });
  }

  get memberCount() {
    return this.members.cache.size;
  }

  addRole(o) {
    const r = new MockRole(this, o);
    this.roles.cache.set(r.id, r);
    return r;
  }

  addMember(o) {
    const m = new MockMember(this, o);
    this.members.cache.set(m.id, m);
    return m;
  }

  addChannel(o) {
    const c = new MockChannel(this, o);
    this.channels.cache.set(c.id, c);
    return c;
  }

  /** Make the next call to `op` throw `err` (or a 50013 by default). */
  failNext(op, err = new DiscordAPIError('Missing Permissions', 50013)) {
    this.failures.set(op, err);
  }

  maybeFail(op) {
    const err = this.failures.get(op);
    if (err) {
      this.failures.delete(op);
      throw err;
    }
  }

  assertHierarchy(target, perm) {
    const me = this.members.me;
    if (!me.permissions.has(perm)) throw new DiscordAPIError('Missing Permissions', 50013);
    if (target.id === this.ownerId || target.roles.highest.position >= me.roles.highest.position) throw new DiscordAPIError('Missing Permissions', 50013);
  }

  assertCanManageRole(role) {
    const me = this.members.me;
    if (!me.permissions.has('ManageRoles') || role.position >= me.roles.highest.position) throw new DiscordAPIError('Missing Permissions', 50013);
  }
}

/** A small populated guild for scenarios. */
export function buildMockGuild(opts = {}) {
  const g = new MockGuild(opts);
  const gaming = g.addRole({ name: 'Gaming', position: 5 });
  const research = g.addRole({ name: 'Research', position: 6 });
  const mods = g.addRole({ name: 'Moderators', position: 20, permissions: ['ModerateMembers', 'KickMembers', 'ManageMessages'] });
  const admins = g.addRole({ name: 'Admins', position: 60, permissions: ['Administrator'] });
  const general = g.addChannel({ name: 'general' });
  const researchCh = g.addChannel({ name: '🔬│research' });
  const staff = g.addChannel({ name: 'staff' });
  const alpha = g.addChannel({ name: 'alpha-console' });
  const voice = g.addChannel({ name: 'Lounge', type: ChannelType.GuildVoice });
  const john = g.addMember({ username: 'john', displayName: 'John' });
  const bob = g.addMember({ username: 'bob_the_builder', displayName: 'Bob' });
  const mod = g.addMember({ username: 'modkai', displayName: 'Kai', roles: [mods] });
  const boss = g.addMember({ username: 'bigadmin', displayName: 'Boss', roles: [admins] });
  const otherBot = g.addMember({ username: 'OtherBot', bot: true });
  return { guild: g, roles: { gaming, research, mods, admins }, channels: { general, research: researchCh, staff, alpha, voice }, members: { john, bob, mod, boss, otherBot } };
}
