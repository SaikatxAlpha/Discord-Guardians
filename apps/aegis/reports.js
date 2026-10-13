// Keep scheduled report jobs in sync with guild settings.
import { createJob, disableJobByKey } from '../../core/scheduler.js';
import { getGuildSettings } from '../../core/settings.js';

export function syncReportJobs(app, guildId) {
  const s = getGuildSettings(app.db, guildId);
  const tz = app.config.timezone;
  const dailyKey = `report:daily:${guildId}`;
  const weeklyKey = `report:weekly:${guildId}`;
  if (s.reports.dailyEnabled && s.channels.reports) {
    createJob(app.db, { guildId, bot: 'aegis', type: 'report.activity', payload: { period: 'today' }, schedule: { kind: 'daily', time: s.reports.dailyTime }, tz, uniqueKey: dailyKey });
  } else disableJobByKey(app.db, dailyKey);
  if (s.reports.weeklyEnabled && s.channels.reports) {
    createJob(app.db, { guildId, bot: 'aegis', type: 'report.activity', payload: { period: 'week' }, schedule: { kind: 'weekly', weekday: s.reports.weeklyDay, time: s.reports.weeklyTime }, tz, uniqueKey: weeklyKey });
  } else disableJobByKey(app.db, weeklyKey);
}
