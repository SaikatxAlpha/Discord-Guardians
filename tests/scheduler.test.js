import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Scheduler, createJob, getJob } from '../core/scheduler.js';
import { enqueueTask, claimTask, completeTask, failTask, reapExpiredTasks, releaseWorkerLeases } from '../core/taskQueue.js';
import { openDatabase } from '../database/db.js';
import { memoryLogger } from '../core/logger.js';
import { fileDb, memDb } from './helpers.js';
import { MIGRATIONS } from '../database/migrations.js';

const TZ = 'Asia/Kolkata';

test('two processes (separate connections) never run the same scheduled occurrence twice', async () => {
  const { db, file } = fileDb();
  const db2 = openDatabase(file);
  const runs = [];
  const handler = (who) => async (job, { runKey }) => {
    runs.push({ who, job: job.id, runKey });
    await new Promise((r) => setTimeout(r, 20));
  };
  const now = Date.now();
  for (let i = 0; i < 5; i++) createJob(db, { bot: 'any', type: 'report', schedule: { kind: 'once', at: now - 1000 }, tz: TZ });
  const a = new Scheduler({ db, bot: 'knight', workerId: 'A', tz: TZ, handlers: { report: handler('A') }, logger: memoryLogger() });
  const b = new Scheduler({ db: db2, bot: 'aegis', workerId: 'B', tz: TZ, handlers: { report: handler('B') }, logger: memoryLogger() });
  await Promise.all([a.tick(), b.tick(), a.tick(), b.tick()]);
  assert.equal(runs.length, 5, JSON.stringify(runs));
  assert.equal(new Set(runs.map((r) => r.job)).size, 5);
  assert.equal(db.get(`SELECT COUNT(*) AS n FROM jobs WHERE status = 'done'`).n, 5);
  db2.close();
  db.close();
});

test('scheduled jobs survive a restart and a finished occurrence is never repeated', async () => {
  const { db, file } = fileDb();
  const runs = [];
  const at = Date.now() - 500;
  const job = createJob(db, { guildId: 'g', bot: 'aegis', type: 'daily', schedule: { kind: 'daily', time: '09:00' }, tz: TZ, uniqueKey: 'daily:g' });
  db.run('UPDATE jobs SET next_run_at = ? WHERE id = ?', at, job.id); // make it due now
  const s1 = new Scheduler({ db, bot: 'aegis', workerId: 'A1', tz: TZ, handlers: { daily: async (j, r) => runs.push(r.runKey) } });
  await s1.tick();
  assert.equal(runs.length, 1);
  const next = getJob(db, job.id).next_run_at;
  assert.ok(next > Date.now(), 'advanced to the next day');
  db.close();
  // "Restart": new process, same database; force the old occurrence due again.
  const db2 = openDatabase(file);
  db2.run('UPDATE jobs SET next_run_at = ? WHERE id = ?', at, job.id);
  const s2 = new Scheduler({ db: db2, bot: 'aegis', workerId: 'A2', tz: TZ, handlers: { daily: async (j, r) => runs.push(r.runKey) } });
  await s2.tick();
  assert.equal(runs.length, 1, 'occurrence recorded in job_runs is not executed again');
  // createJob with the same uniqueKey (e.g. on every startup) neither duplicates
  // the job nor skips a run that is already due.
  const due = Date.now() - 1000;
  db2.run('UPDATE jobs SET next_run_at = ? WHERE id = ?', due, job.id);
  createJob(db2, { guildId: 'g', bot: 'aegis', type: 'daily', schedule: { kind: 'daily', time: '09:00' }, tz: TZ, uniqueKey: 'daily:g' });
  assert.equal(db2.get('SELECT COUNT(*) AS n FROM jobs').n, 1);
  assert.equal(getJob(db2, job.id).next_run_at, due, 'pending run preserved');
  createJob(db2, { guildId: 'g', bot: 'aegis', type: 'daily', schedule: { kind: 'daily', time: '10:00' }, tz: TZ, uniqueKey: 'daily:g' });
  assert.ok(getJob(db2, job.id).next_run_at > Date.now(), 'changed schedule is recomputed');
  db2.close();
});

test('a crash mid-run does not cause a duplicate after the lease expires', async () => {
  const db = memDb();
  const job = createJob(db, { bot: 'aegis', type: 'send', schedule: { kind: 'once', at: Date.now() - 10 }, tz: TZ });
  // Simulate a worker that recorded the occurrence then died.
  db.run(`INSERT INTO job_runs (job_id, run_key, status, worker, started_at) VALUES (?, ?, 'running', 'dead', ?)`, job.id, String(job.next_run_at), Date.now());
  db.run('UPDATE jobs SET lease_owner = ?, lease_until = ? WHERE id = ?', 'dead', Date.now() - 1, job.id);
  let ran = 0;
  const s = new Scheduler({ db, bot: 'aegis', workerId: 'new', tz: TZ, handlers: { send: async () => ran++ }, logger: memoryLogger() });
  await s.tick();
  assert.equal(ran, 0);
  assert.equal(getJob(db, job.id).status, 'done');
});

test('failed jobs retry with backoff and report failure after max attempts', async () => {
  const db = memDb();
  const job = createJob(db, { bot: 'aegis', type: 'flaky', schedule: { kind: 'once', at: Date.now() - 10 }, tz: TZ, maxFailures: 2 });
  const failures = [];
  const s = new Scheduler({ db, bot: 'aegis', workerId: 'w', tz: TZ, handlers: { flaky: async () => { throw new Error('boom'); } }, logger: memoryLogger(), onFailure: (j, e) => failures.push(e.message) });
  await s.tick();
  let j = getJob(db, job.id);
  assert.equal(j.status, 'active');
  assert.equal(j.failures, 1);
  assert.ok(j.next_run_at > Date.now(), 'backoff scheduled');
  db.run('UPDATE jobs SET next_run_at = ? WHERE id = ?', Date.now() - 1, job.id);
  await s.tick();
  j = getJob(db, job.id);
  assert.equal(j.status, 'failed');
  assert.deepEqual(failures, ['boom']);
});

test('jobs only run in the process that owns them', async () => {
  const db = memDb();
  createJob(db, { bot: 'aegis', type: 'x', schedule: { kind: 'once', at: Date.now() - 10 }, tz: TZ });
  let ran = 0;
  await new Scheduler({ db, bot: 'knight', workerId: 'k', tz: TZ, handlers: { x: async () => ran++ } }).tick();
  assert.equal(ran, 0);
  await new Scheduler({ db, bot: 'aegis', workerId: 'a', tz: TZ, handlers: { x: async () => ran++ } }).tick();
  assert.equal(ran, 1);
});

test('task queue: atomic claim across connections, idempotency keys, lease recovery', () => {
  const { db, file } = fileDb();
  const db2 = openDatabase(file);
  const t1 = enqueueTask(db, { targetBot: 'knight', action: 'mod.warn', params: { a: 1 }, idempotencyKey: 'req1:0' });
  const dup = enqueueTask(db2, { targetBot: 'knight', action: 'mod.warn', params: { a: 1 }, idempotencyKey: 'req1:0' });
  assert.equal(dup.duplicate, true);
  assert.equal(dup.id, t1.id);
  const c1 = claimTask(db, 'knight', 'k1');
  const c2 = claimTask(db2, 'knight', 'k2');
  assert.ok(c1);
  assert.equal(c2, null, 'second worker cannot claim the same task');
  assert.equal(claimTask(db, 'aegis', 'a1'), null, 'tasks are routed by target bot');
  assert.equal(completeTask(db2, t1.id, 'k2', { ok: true }), false, 'only the lease owner can complete');
  assert.equal(completeTask(db, t1.id, 'k1', { ok: true }), true);

  // Lease expiry: non-retryable tasks fail instead of risking a double run.
  const t2 = enqueueTask(db, { targetBot: 'knight', action: 'mod.ban', params: {}, maxAttempts: 1 });
  claimTask(db, 'knight', 'k1', { leaseMs: -1 });
  reapExpiredTasks(db);
  assert.equal(db.get('SELECT status FROM tasks WHERE id = ?', t2.id).status, 'failed');
  // Retryable tasks go back to pending; release on shutdown does too.
  const t3 = enqueueTask(db, { targetBot: 'knight', action: 'mod.unban', params: {}, maxAttempts: 3 });
  claimTask(db, 'knight', 'k1', { leaseMs: -1 });
  reapExpiredTasks(db);
  assert.equal(db.get('SELECT status FROM tasks WHERE id = ?', t3.id).status, 'pending');
  claimTask(db, 'knight', 'k9');
  releaseWorkerLeases(db, 'k9');
  assert.equal(db.get('SELECT status FROM tasks WHERE id = ?', t3.id).status, 'pending');
  const c3 = claimTask(db, 'knight', 'k1');
  failTask(db, c3.id, 'k1', 'nope', { retryDelayMs: 0 });
  assert.equal(db.get('SELECT status FROM tasks WHERE id = ?', t3.id).status, 'failed', 'max attempts reached');
  db2.close();
  db.close();
});

test('migrations are idempotent across processes and backups are consistent copies', async () => {
  const { db, file, dir } = fileDb();
  const again = openDatabase(file);
  assert.equal(again.get('SELECT COUNT(*) AS n FROM schema_migrations').n, MIGRATIONS.length);
  db.run(`INSERT INTO kv (key, value, updated_at) VALUES ('x', '1', 0)`);
  const { runBackup } = await import('../core/health.js');
  const out = runBackup(db, `${dir}/backups`, 2);
  const copy = openDatabase(out, { migrate: false });
  assert.equal(copy.get(`SELECT value FROM kv WHERE key = 'x'`).value, '1');
  copy.close();
  again.close();
  db.close();
});
