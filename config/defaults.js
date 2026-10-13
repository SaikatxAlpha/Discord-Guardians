// Identity, theme and per-guild default settings. Guild overrides are stored
// in SQLite (guild_settings) and deep-merged over these defaults.

export const SERVER_NAME = '𓆩 𝐕𝐎𝐈𝐃𝐖𝐎𝐑𝐊𝐒 𓆪';
export const PROJECT_NAME = 'Soul Society';
export const WAKE_WORD = 'ALPHA';

export const THEME = {
  knight: {
    name: 'KNIGHT',
    title: 'The Guardian',
    color: 0x8b5cf6,
    accent: '#a855f7',
    secondary: '#6d28d9',
    emoji: '⚔️',
    presence: 'Guarding Soul Society',
  },
  aegis: {
    name: 'AEGIS',
    title: 'The Ancient Guardian',
    color: 0x22d3ee,
    accent: '#22d3ee',
    secondary: '#1e3a8a',
    emoji: '🛡️',
    presence: 'Watching over Soul Society',
  },
  welcome: {
    violet: '#a855f7',
    cyan: '#22d3ee',
    deep: '#0b0418',
  },
};

export const DEFAULT_GUILD_SETTINGS = {
  channels: {
    welcome: null,
    leave: null,
    research: null,
    reports: null,
    announcements: null,
    alpha: null, // where ALPHA posts status, approvals and results
    securityLog: null, // KNIGHT private security log
    modLog: null, // KNIGHT moderation case log
    music: null,
  },
  welcome: {
    enabled: true,
    format: 'png', // png | gif | mp4 (gif/mp4 fall back to png on failure)
    message: 'Welcome to **{server}**, {mention}! You are soul #{count}.',
    leaveEnabled: true,
    leaveMessage: '**{name}** has departed Soul Society.',
  },
  alpha: {
    textPrefixEnabled: true, // owner can type "ALPHA, ..." in the alpha channel
    autoExecuteLowRisk: true,
    confirmMediumFromVoice: true,
    speakResponses: false,
  },
  moderation: {
    enabled: true,
    simulate: true, // SAFE DEFAULT: log what would happen, take no action
    exemptRoleIds: [],
    protectedRoleIds: [],
    exemptChannelIds: [],
    exemptModerators: true,
    deleteSevereMessages: true,
    profanity: {
      enabled: true,
      extraWords: [],
      allowWords: [],
    },
    spam: {
      enabled: true,
      floodCount: 6,
      floodWindowMs: 8000,
      duplicateCount: 3,
      duplicateWindowMs: 30000,
      mentionLimit: 5,
      blockInvites: false,
    },
    raid: {
      enabled: true,
      joinCount: 8,
      joinWindowMs: 30000,
      newAccountDays: 3,
      autoTimeoutNewAccountsDuringRaid: false,
    },
    // Points accumulate per violation within decayHours; the highest
    // threshold reached is applied. Ban is intentionally not automatic.
    escalation: {
      decayHours: 24,
      points: { mild: 1, spam: 2, severe: 3, voice: 1 },
      steps: [
        { points: 1, action: 'warn' },
        { points: 3, action: 'timeout', durationMs: 10 * 60 * 1000 },
        { points: 5, action: 'timeout', durationMs: 60 * 60 * 1000 },
        { points: 8, action: 'kick' },
      ],
    },
    voice: {
      enabled: false, // privacy: off unless the owner explicitly enables it
      minConfidence: 0.75,
      debounceMs: 60000,
      maxAutoAction: 'warn', // warn | timeout ; never kick/ban from voice
    },
  },
  progression: {
    enabled: true,
    messageXp: [15, 25],
    messageAura: 2,
    messageCooldownMs: 60000,
    minMessageLength: 5,
    hourlyFullRewards: 20,
    dailyMessageAuraCap: 120,
    voiceXpPerMinute: 4,
    voiceAuraPerMinute: 1,
    dailyVoiceMinuteCap: 120,
    dailyReward: 100,
    weeklyReward: 500,
    streakBonus: 10,
    streakBonusCap: 100,
    transfer: { enabled: true, dailyCap: 1000, minMemberDays: 3 },
    levelRoles: {}, // { "5": "roleId" }
    season: 1,
  },
  reports: {
    dailyEnabled: false,
    dailyTime: '21:00',
    weeklyEnabled: false,
    weeklyDay: 0, // Sunday
    weeklyTime: '20:00',
  },
  research: {
    scheduledTopics: [], // [{ query, time: '09:00' }]
  },
};

export const QUESTS = {
  daily: [
    { id: 'd_messages', name: 'Voice of the Soul', description: 'Send 15 rewarded messages', metric: 'messages', goal: 15, aura: 40, xp: 60 },
    { id: 'd_voice', name: 'Spirit Resonance', description: 'Spend 20 active minutes in voice', metric: 'voice_minutes', goal: 20, aura: 50, xp: 80 },
    { id: 'd_daily', name: 'Daily Devotion', description: 'Claim your daily reward', metric: 'daily_claims', goal: 1, aura: 15, xp: 20 },
  ],
  weekly: [
    { id: 'w_messages', name: 'Chronicler', description: 'Send 120 rewarded messages', metric: 'messages', goal: 120, aura: 250, xp: 400 },
    { id: 'w_voice', name: 'Echo of the Void', description: 'Spend 180 active minutes in voice', metric: 'voice_minutes', goal: 180, aura: 300, xp: 500 },
    { id: 'w_event', name: 'Gathering of Souls', description: 'Take part in a community event', metric: 'events', goal: 1, aura: 200, xp: 300 },
  ],
};

export const DEFAULT_SHOP = [
  { id: 'title_wanderer', name: 'Title: Void Wanderer', description: 'Display title on your rank card', price: 300, kind: 'title', title: 'Void Wanderer' },
  { id: 'title_reaper', name: 'Title: Soul Reaper', description: 'Display title on your rank card', price: 1200, kind: 'title', title: 'Soul Reaper' },
  { id: 'title_captain', name: 'Title: Captain of the 13 Courts', description: 'Prestige title', price: 5000, kind: 'title', title: 'Captain' },
  { id: 'aura_frame', name: 'Cyan Aura Frame', description: 'Cosmetic: cyan frame on your rank card', price: 800, kind: 'cosmetic' },
];
