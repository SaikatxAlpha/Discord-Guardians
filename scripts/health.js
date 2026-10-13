// Print system health from the shared database (works while bots run).
import { loadEnv, getConfig } from '../config/env.js';
import { openDatabase } from '../database/db.js';
import { healthReport } from '../core/health.js';
import { createAI } from '../ai/index.js';
import { createSTT } from '../features/voice/stt.js';

loadEnv();
const config = getConfig();
const db = openDatabase(config.dbPath);
const report = healthReport(db, { ai: createAI({ config, db }), stt: createSTT({ config, db }) });
console.log(JSON.stringify(report, null, 2));
db.close();
process.exit(report.ok ? 0 : 1);
