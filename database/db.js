// SQLite access built on Node's built-in node:sqlite (no native add-on to
// install). WAL mode lets the KNIGHT and AEGIS processes share one database.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from './migrations.js';

export class Database {
  constructor(file = ':memory:', { migrate = true } = {}) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.file = file;
    this.raw = new DatabaseSync(file);
    this.raw.exec('PRAGMA busy_timeout = 8000');
    if (file !== ':memory:') this.raw.exec('PRAGMA journal_mode = WAL');
    this.raw.exec('PRAGMA foreign_keys = ON');
    this.raw.exec('PRAGMA synchronous = NORMAL');
    this.statements = new Map();
    this.depth = 0;
    this.closed = false;
    if (migrate) runMigrations(this);
  }

  stmt(sql) {
    let s = this.statements.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.statements.set(sql, s);
    }
    return s;
  }

  /** All values are bound as parameters; SQL text is always static. */
  run(sql, ...params) {
    return this.stmt(sql).run(...params);
  }

  get(sql, ...params) {
    return this.stmt(sql).get(...params);
  }

  all(sql, ...params) {
    return this.stmt(sql).all(...params);
  }

  exec(sql) {
    this.raw.exec(sql);
  }

  /**
   * Run fn inside a write transaction. BEGIN IMMEDIATE takes the write lock
   * up front so concurrent processes serialise instead of failing mid-way.
   * Nested calls use savepoints.
   */
  transaction(fn) {
    if (this.depth > 0) {
      const sp = `sp_${this.depth}`;
      this.raw.exec(`SAVEPOINT ${sp}`);
      this.depth++;
      try {
        const out = fn();
        this.raw.exec(`RELEASE ${sp}`);
        return out;
      } catch (err) {
        this.raw.exec(`ROLLBACK TO ${sp}`);
        this.raw.exec(`RELEASE ${sp}`);
        throw err;
      } finally {
        this.depth--;
      }
    }
    this.raw.exec('BEGIN IMMEDIATE');
    this.depth++;
    try {
      const out = fn();
      if (out instanceof Promise) throw new Error('transaction callbacks must be synchronous');
      this.raw.exec('COMMIT');
      return out;
    } catch (err) {
      try {
        this.raw.exec('ROLLBACK');
      } catch {
        /* already rolled back */
      }
      throw err;
    } finally {
      this.depth--;
    }
  }

  /** Online, consistent copy of the database (safe while other processes write). */
  backupTo(target) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (fs.existsSync(target)) fs.rmSync(target);
    this.raw.prepare('VACUUM INTO ?').run(target);
    return target;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.statements.clear();
    this.raw.close();
  }
}

export function openDatabase(file, opts) {
  return new Database(file, opts);
}
