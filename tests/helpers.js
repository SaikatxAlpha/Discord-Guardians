// Shared test utilities.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getConfig } from '../config/env.js';
import { openDatabase } from '../database/db.js';
import { memoryLogger } from '../core/logger.js';
import { AlphaCoordinator } from '../core/coordinator.js';
import { knightHandlers } from '../features/moderation/handlers.js';
import { serverHandlers } from '../features/server/handlers.js';
import { systemHandlers } from '../apps/shared/systemHandlers.js';

export function testConfig(overrides = {}) {
  const base = getConfig({ TIMEZONE: 'Asia/Kolkata', AI_PROVIDER: 'none', STT_PROVIDER: 'none' });
  return { ...base, ownerId: '111111111111111111', approvalTtlMs: 60000, ...overrides };
}

export function tempDir(prefix = 'soul-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function memDb() {
  return openDatabase(':memory:');
}

export function fileDb(dir = tempDir()) {
  const file = path.join(dir, 'test.db');
  return { db: openDatabase(file), file, dir };
}

/** Coordinator wired to a mock guild. */
export function coordinatorFor({ db, config, guild, bot = 'aegis', handlers, crossBotTimeoutMs = 3000, ai = null }) {
  const h = handlers ?? new Map(Object.entries({ ...systemHandlers({}), ...(bot === 'knight' ? knightHandlers : serverHandlers) }));
  return new AlphaCoordinator({
    db,
    config,
    bot,
    logger: memoryLogger(),
    ai,
    handlers: h,
    getGuild: async (id) => (id === guild.id ? guild : null),
    crossBotTimeoutMs,
  });
}

let n = 0;
export const rid = () => `test:${Date.now()}:${++n}`;
