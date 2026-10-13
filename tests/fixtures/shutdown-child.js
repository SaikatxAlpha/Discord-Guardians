// Child process used by system.test.js: boots a guardian WITHOUT connecting
// to Discord (login is stubbed), starts its background loops, holds a task
// lease, then waits for the launcher-style shutdown message.
import { GuardianBot } from '../../apps/shared/botBase.js';

const app = new GuardianBot({ name: 'knight', intents: [] });
app.client.login = async () => 'stubbed';
await app.start();
app.startLoops();
app.logger.info(`token check ${process.env.KNIGHT_TOKEN}`); // must be redacted in the log file
const now = Date.now();
app.db.run(
  `INSERT INTO tasks (id, target_bot, action, params, status, attempts, max_attempts, lease_owner, lease_until, created_at, updated_at)
   VALUES ('held', 'knight', 'mod.unban', '{}', 'claimed', 1, 3, ?, ?, ?, ?)`,
  app.workerId,
  now + 600000,
  now,
  now,
);
process.send({ type: 'ready', workerId: app.workerId });
