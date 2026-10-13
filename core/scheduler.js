// Persistent scheduler shared by both bot processes.
// - Jobs live in SQLite and survive restarts.
// - A job is claimed with a lease, so only one process runs it.
// - Each occurrence has a run key recorded in job_runs (primary key), so an
//   occurrence executes at most once even across crashes and restarts.
import crypto from 'node:crypto';
import { nextOccurrence } from './time.js';

export function createJob(db, { guildId = null, bot, type, payload = {}, schedule, tz = 'UTC', createdBy = null, uniqueKey = null, maxFailures = 3, now = Date.now() }) {
  const next = schedule.kind === 'once' ? schedule.at : nextOccurrence(schedule, now, tz);
  if (next == null) throw new Error('schedule has no future occurrence');
  return db.transaction(() => {
    if (uniqueKey) {
      const existing = db.get('SELECT * FROM jobs WHERE unique_key = ?', uniqueKey);
      if (existing) {
        // Re-registering on startup must not skip a pending run: only
        // recompute the next run when the schedule itself changed.
        const changed = existing.schedule !== JSON.stringify(schedule) || existing.status !== 'active';
        db.run(
          `UPDATE jobs SET schedule = ?, payload = ?, next_run_at = ?, status = 'active' WHERE id = ?`,
          JSON.stringify(schedule),
          JSON.stringify(payload),
          changed ? next : existing.next_run_at,
          existing.id,
        );
        return getJob(db, existing.id);
      }
    }
    const id = crypto.randomUUID();
    db.run(
      `INSERT INTO jobs (id, guild_id, bot, type, payload, schedule, next_run_at, status, unique_key, created_by, created_at, max_failures)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
      id,
      guildId,
      bot,
      type,
      JSON.stringify(payload),
      JSON.stringify(schedule),
      next,
      uniqueKey,
      createdBy,
      now,
      maxFailures,
    );
    return getJob(db, id);
  });
}

export function getJob(db, id) {
  const r = db.get('SELECT * FROM jobs WHERE id = ?', id);
  return r && { ...r, payload: JSON.parse(r.payload), schedule: JSON.parse(r.schedule) };
}

export function cancelJob(db, id) {
  return db.run(`UPDATE jobs SET status = 'cancelled' WHERE id = ? AND status = 'active'`, id).changes === 1;
}

export function disableJobByKey(db, uniqueKey) {
  db.run(`UPDATE jobs SET status = 'cancelled' WHERE unique_key = ?`, uniqueKey);
}

export function listJobs(db, guildId) {
  return db.all(`SELECT * FROM jobs WHERE guild_id = ? AND status = 'active' ORDER BY next_run_at`, guildId).map((r) => ({
    ...r,
    payload: JSON.parse(r.payload),
    schedule: JSON.parse(r.schedule),
  }));
}

export class Scheduler {
  /**
   * @param {object} o
   * @param {import('../database/db.js').Database} o.db
   * @param {string} o.bot 'knight' | 'aegis'
   * @param {Record<string,(job:object, run:{runKey:string})=>Promise<any>>} o.handlers
   */
  constructor({ db, bot, workerId = `${bot}:${process.pid}`, tz = 'UTC', handlers, logger, onFailure, leaseMs = 120000, intervalMs = 5000 }) {
    Object.assign(this, { db, bot, workerId, tz, handlers, logger, onFailure, leaseMs, intervalMs });
    this.timer = null;
    this.running = null;
    this.stopped = true;
  }

  start() {
    this.stopped = false;
    const loop = async () => {
      if (this.stopped) return;
      this.running = this.tick().catch((err) => this.logger?.error('scheduler tick failed', { err }));
      await this.running;
      if (!this.stopped) this.timer = setTimeout(loop, this.intervalMs);
    };
    this.timer = setTimeout(loop, 1000);
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
    this.db.run('UPDATE jobs SET lease_owner = NULL, lease_until = NULL WHERE lease_owner = ?', this.workerId);
  }

  claimDue(now) {
    return this.db.transaction(() => {
      const types = Object.keys(this.handlers);
      if (!types.length) return [];
      const due = this.db.all(
        `SELECT * FROM jobs WHERE status = 'active' AND bot IN (?, 'any') AND next_run_at <= ?
         AND (lease_until IS NULL OR lease_until < ?) ORDER BY next_run_at LIMIT 10`,
        this.bot,
        now,
        now,
      );
      const claimed = [];
      for (const j of due) {
        if (!types.includes(j.type)) continue;
        const res = this.db.run(
          `UPDATE jobs SET lease_owner = ?, lease_until = ? WHERE id = ? AND (lease_until IS NULL OR lease_until < ?)`,
          this.workerId,
          now + this.leaseMs,
          j.id,
          now,
        );
        if (res.changes === 1) claimed.push({ ...j, payload: JSON.parse(j.payload), schedule: JSON.parse(j.schedule) });
      }
      return claimed;
    });
  }

  async tick(now = Date.now()) {
    const jobs = this.claimDue(now);
    for (const job of jobs) await this.runJob(job, now);
    return jobs.length;
  }

  async runJob(job, now) {
    const runKey = String(job.next_run_at);
    // Record the occurrence first. If it already exists, a previous attempt
    // started it (possibly crashing mid-way): never run it twice.
    const inserted = this.db.run(
      `INSERT OR IGNORE INTO job_runs (job_id, run_key, status, worker, started_at) VALUES (?, ?, 'running', ?, ?)`,
      job.id,
      runKey,
      this.workerId,
      now,
    );
    if (inserted.changes !== 1) {
      this.logger?.warn('skipping already-started job occurrence', { jobId: job.id, type: job.type, runKey });
      this.advance(job, now, null);
      return;
    }
    try {
      await this.handlers[job.type](job, { runKey });
      this.db.run(`UPDATE job_runs SET status = 'done', finished_at = ? WHERE job_id = ? AND run_key = ?`, Date.now(), job.id, runKey);
      this.advance(job, now, null);
    } catch (err) {
      this.db.run(`UPDATE job_runs SET status = 'failed', finished_at = ?, error = ? WHERE job_id = ? AND run_key = ?`, Date.now(), String(err?.message || err), job.id, runKey);
      this.logger?.error('job failed', { jobId: job.id, type: job.type, err });
      this.advance(job, now, err);
    }
  }

  advance(job, now, err) {
    const failures = err ? job.failures + 1 : 0;
    let status = 'active';
    let next;
    if (err && failures < job.max_failures) {
      next = now + Math.min(30 * 60000, 30000 * 2 ** (failures - 1)); // exponential backoff retry
    } else {
      next = job.schedule.kind === 'once' ? null : nextOccurrence(job.schedule, Math.max(now, job.next_run_at), this.tz);
      if (next == null) status = err ? 'failed' : 'done';
      if (err) this.onFailure?.(job, err);
    }
    this.db.run(
      `UPDATE jobs SET next_run_at = ?, status = ?, last_run_at = ?, last_error = ?, failures = ?, lease_owner = NULL, lease_until = NULL WHERE id = ?`,
      next,
      status,
      now,
      err ? String(err.message || err).slice(0, 1000) : null,
      err && failures < job.max_failures ? failures : 0,
      job.id,
    );
  }
}
