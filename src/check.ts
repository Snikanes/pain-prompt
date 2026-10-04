import { loadConfig, loadDotEnv } from './config.js';
import { IntervalsClient } from './intervals.js';
import { startInstant } from './service.js';
import { addDays, localDate } from './time.js';

/**
 * `npm run check`: validates the config and talks to Intervals.icu
 * (read-only), printing the runs the bot would see right now.
 */
async function check(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();
  console.log(`config ok · timezone ${config.timezone} · morning "${config.morningCron}"`);
  const client = new IntervalsClient(config.intervals);
  const today = localDate(new Date(), config.timezone);
  const all = await client.listActivities(addDays(today, -6), today);
  const runs = all.filter((a) => config.activityTypes.includes(a.type));
  console.log(`intervals.icu ok · ${all.length} activities in the last 7 days, ${runs.length} counted as runs`);
  for (const r of runs) {
    console.log(
      `  ${r.id}  ${r.startDateLocal}  (start ${startInstant(r, config.timezone).toISOString()}, raw start_date "${r.startDate}")  ${r.name}  ${(r.distance / 1000).toFixed(1)} km`,
    );
  }
}

check().catch((err: unknown) => {
  console.error(`check failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
