// Versioned schema migrations. Each migration runs once inside a transaction.

export const MIGRATIONS = [
  {
    version: 1,
    name: 'initial schema',
    sql: `
CREATE TABLE guild_settings (
  guild_id TEXT PRIMARY KEY,
  data TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL
);

CREATE TABLE kv (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  guild_id TEXT,
  actor_id TEXT,
  bot TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  params TEXT,
  outcome TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX idx_audit_guild_ts ON audit_log(guild_id, ts);
CREATE INDEX idx_audit_action ON audit_log(action, ts);

-- Cross-process task queue (the IPC channel between KNIGHT and AEGIS).
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT UNIQUE,
  guild_id TEXT,
  target_bot TEXT NOT NULL,
  action TEXT NOT NULL,
  params TEXT NOT NULL,
  context TEXT NOT NULL DEFAULT '{}',
  requested_by TEXT,
  source TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 1,
  not_before INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_until INTEGER,
  result TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_tasks_claim ON tasks(target_bot, status, not_before, created_at);

CREATE TABLE processed_requests (
  id TEXT PRIMARY KEY,
  bot TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  guild_id TEXT,
  owner_id TEXT NOT NULL,
  bot TEXT NOT NULL,
  plan TEXT NOT NULL,
  context TEXT NOT NULL DEFAULT '{}',
  summary TEXT NOT NULL,
  risk TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  decided_at INTEGER,
  decided_by TEXT,
  channel_id TEXT,
  message_id TEXT,
  outcome TEXT
);
CREATE INDEX idx_approvals_status ON approvals(status, expires_at);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  guild_id TEXT,
  bot TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  schedule TEXT NOT NULL,
  next_run_at INTEGER,
  status TEXT NOT NULL DEFAULT 'active',
  lease_owner TEXT,
  lease_until INTEGER,
  last_run_at INTEGER,
  last_error TEXT,
  failures INTEGER NOT NULL DEFAULT 0,
  max_failures INTEGER NOT NULL DEFAULT 3,
  unique_key TEXT UNIQUE,
  created_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_jobs_due ON jobs(status, bot, next_run_at);

-- One row per scheduled occurrence: guarantees an occurrence runs at most once.
CREATE TABLE job_runs (
  job_id TEXT NOT NULL,
  run_key TEXT NOT NULL,
  status TEXT NOT NULL,
  worker TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  error TEXT,
  PRIMARY KEY (job_id, run_key)
);

CREATE TABLE mod_cases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  moderator_id TEXT,
  bot TEXT NOT NULL,
  action TEXT NOT NULL,
  reason TEXT,
  rule TEXT,
  points INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  evidence TEXT,
  simulated INTEGER NOT NULL DEFAULT 0,
  result TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_cases_user ON mod_cases(guild_id, user_id, created_at);
CREATE INDEX idx_cases_guild ON mod_cases(guild_id, created_at);

CREATE TABLE voice_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  channel_id TEXT,
  transcript TEXT NOT NULL,
  confidence REAL,
  matched TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  reviewed_by TEXT,
  created_at INTEGER NOT NULL
);

-- Append-only ledger for aura and xp. UPDATE/DELETE are blocked by triggers.
CREATE TABLE ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  currency TEXT NOT NULL CHECK (currency IN ('aura','xp')),
  amount INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  kind TEXT NOT NULL,
  reason TEXT NOT NULL,
  idempotency_key TEXT UNIQUE,
  actor_id TEXT,
  season INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_ledger_user ON ledger(guild_id, user_id, currency, created_at);
CREATE INDEX idx_ledger_guild ON ledger(guild_id, created_at);
CREATE TRIGGER ledger_no_update BEFORE UPDATE ON ledger BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;
CREATE TRIGGER ledger_no_delete BEFORE DELETE ON ledger BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;

CREATE TABLE members (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  aura INTEGER NOT NULL DEFAULT 0,
  xp INTEGER NOT NULL DEFAULT 0,
  level INTEGER NOT NULL DEFAULT 0,
  season_aura INTEGER NOT NULL DEFAULT 0,
  streak INTEGER NOT NULL DEFAULT 0,
  last_daily TEXT,
  last_weekly TEXT,
  last_reward_at INTEGER NOT NULL DEFAULT 0,
  hour_window_start INTEGER NOT NULL DEFAULT 0,
  hour_window_count INTEGER NOT NULL DEFAULT 0,
  recent_hashes TEXT NOT NULL DEFAULT '[]',
  title TEXT,
  PRIMARY KEY (guild_id, user_id)
);
CREATE INDEX idx_members_aura ON members(guild_id, aura DESC);
CREATE INDEX idx_members_xp ON members(guild_id, xp DESC);
CREATE INDEX idx_members_season ON members(guild_id, season_aura DESC);

CREATE TABLE daily_counters (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,
  metric TEXT NOT NULL,
  value INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, user_id, day, metric)
);

CREATE TABLE quest_progress (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  quest_id TEXT NOT NULL,
  period TEXT NOT NULL,
  progress INTEGER NOT NULL DEFAULT 0,
  completed_at INTEGER,
  PRIMARY KEY (guild_id, user_id, quest_id, period)
);

CREATE TABLE shop_items (
  guild_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  price INTEGER NOT NULL CHECK (price >= 0),
  kind TEXT NOT NULL,
  role_id TEXT,
  title TEXT,
  stock INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (guild_id, id)
);

CREATE TABLE inventory (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 0,
  acquired_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id, item_id)
);

CREATE TABLE purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  price INTEGER NOT NULL,
  ledger_id INTEGER NOT NULL REFERENCES ledger(id),
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE season_results (
  guild_id TEXT NOT NULL,
  season INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  rank INTEGER NOT NULL,
  aura INTEGER NOT NULL,
  PRIMARY KEY (guild_id, season, user_id)
);

-- Analytics
CREATE TABLE activity (
  guild_id TEXT NOT NULL,
  day TEXT NOT NULL,
  user_id TEXT NOT NULL,
  messages INTEGER NOT NULL DEFAULT 0,
  voice_minutes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, day, user_id)
);
CREATE TABLE channel_activity (
  guild_id TEXT NOT NULL,
  day TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  messages INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, day, channel_id)
);
CREATE TABLE member_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX idx_member_events ON member_events(guild_id, ts);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  channel_id TEXT,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  reward INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'scheduled',
  discord_event_id TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE event_participants (
  event_id TEXT NOT NULL REFERENCES events(id),
  user_id TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (event_id, user_id)
);

CREATE TABLE research_reports (
  id TEXT PRIMARY KEY,
  guild_id TEXT,
  query TEXT NOT NULL,
  summary TEXT NOT NULL,
  sources TEXT NOT NULL,
  ai_used INTEGER NOT NULL DEFAULT 0,
  retrieved_at INTEGER NOT NULL,
  channel_id TEXT,
  message_id TEXT
);

CREATE TABLE music_state (
  guild_id TEXT PRIMARY KEY,
  voice_channel_id TEXT,
  text_channel_id TEXT,
  queue TEXT NOT NULL DEFAULT '[]',
  now_playing TEXT,
  updated_at INTEGER NOT NULL
);

-- Conversational references such as "that channel" / "that member".
CREATE TABLE alpha_context (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id, key)
);

CREATE TABLE provider_usage (
  day TEXT NOT NULL,
  provider TEXT NOT NULL,
  kind TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  units INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, provider, kind)
);

CREATE TABLE heartbeats (
  bot TEXT PRIMARY KEY,
  pid INTEGER,
  started_at INTEGER,
  last_seen INTEGER,
  status TEXT,
  info TEXT
);
`,
  },
  {
    version: 2,
    name: 'per-guild usage limits and voice/music state',
    sql: `
-- Per-server usage counters (STT requests etc.) so one server cannot exhaust a shared quota.
CREATE TABLE guild_usage (
  day TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, guild_id, kind)
);
ALTER TABLE music_state ADD COLUMN settings TEXT NOT NULL DEFAULT '{}';
`,
  },
];

export function runMigrations(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)`);
  const applied = new Set(db.all('SELECT version FROM schema_migrations').map((r) => r.version));
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    db.transaction(() => {
      // Re-check inside the write lock: the other bot process may have migrated.
      if (db.get('SELECT 1 FROM schema_migrations WHERE version = ?', m.version)) return;
      db.exec(m.sql);
      db.run('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', m.version, m.name, Date.now());
    });
  }
}
