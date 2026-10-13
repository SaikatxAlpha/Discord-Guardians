// Manual database backup (safe while the bots are running).
import { loadEnv, getConfig } from '../config/env.js';
import { openDatabase } from '../database/db.js';
import { runBackup } from '../core/health.js';

loadEnv();
const config = getConfig();
const db = openDatabase(config.dbPath);
console.log(`Backup written: ${runBackup(db, config.backupDir, config.backupKeep)}`);
db.close();
