import { z } from 'zod';

/**
 * Load a `.env` file into `process.env`, if there is one. Real environment
 * variables (e.g. from a systemd `EnvironmentFile`) always win.
 */
export function loadDotEnv(path = '.env'): boolean {
  try {
    process.loadEnvFile(path);
    return true;
  } catch {
    return false;
  }
}

const bool = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true');

const envSchema = z.object({
  DISCORD_BOT_TOKEN: z.string().min(1),
  DISCORD_CHANNEL_ID: z.string().min(1),
  /** your own Discord user id: mentioned in prompts, and the only one allowed to answer */
  DISCORD_USER_ID: z.string().min(1),

  INTERVALS_API_KEY: z.string().min(1),
  INTERVALS_ATHLETE_ID: z.string().min(1),
  INTERVALS_BASE_URL: z.string().url().default('https://intervals.icu/api/v1'),

  /** body part named in the prompts */
  PAIN_AREA: z.string().min(1).default('Groin'),
  PAIN_TZ: z.string().min(1).default('Europe/Oslo'),
  /** cron for the morning check, evaluated in PAIN_TZ */
  PAIN_MORNING_CRON: z.string().min(1).default('10 7 * * *'),
  /** how often to look for newly uploaded runs */
  PAIN_POLL_MINUTES: z.coerce.number().int().min(1).max(120).default(10),
  /** follow-up prompt this long after the run ended */
  PAIN_POST_RUN_DELAY_MINUTES: z.coerce.number().int().min(0).max(24 * 60).default(240),
  /** one reminder if a prompt is still unanswered after this long (0 = never) */
  PAIN_REMINDER_MINUTES: z.coerce.number().int().min(0).max(24 * 60).default(45),
  /** runs that ended longer ago than this when first seen are logged silently, not prompted */
  PAIN_MAX_RUN_AGE_HOURS: z.coerce.number().positive().max(72).default(12),
  /** Intervals.icu activity types that count as runs */
  PAIN_ACTIVITY_TYPES: z.string().default('Run,TrailRun,VirtualRun'),
  /** prompt "during" right away when a run is found */
  PAIN_PROMPT_DURING: bool.default('true'),
  /** ask for RPE and feel when a run is found (skipped if the watch already set them) */
  PAIN_PROMPT_EFFORT: bool.default('true'),

  PAIN_STATE_PATH: z.string().min(1).default('./data/state.json'),
  PAIN_LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug']).default('info'),
});

export interface Config {
  discord: { botToken: string; channelId: string; userId: string };
  intervals: { apiKey: string; athleteId: string; baseUrl: string };
  area: string;
  timezone: string;
  morningCron: string;
  pollMinutes: number;
  postRunDelayMinutes: number;
  reminderMinutes: number;
  maxRunAgeHours: number;
  activityTypes: string[];
  promptDuring: boolean;
  promptEffort: boolean;
  statePath: string;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const e = parsed.data;
  // Fail at boot, not at 07:10, on a bad timezone.
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: e.PAIN_TZ });
  } catch {
    throw new Error(`Invalid environment configuration:\n  PAIN_TZ: unknown timezone "${e.PAIN_TZ}"`);
  }
  return {
    discord: {
      botToken: e.DISCORD_BOT_TOKEN,
      channelId: e.DISCORD_CHANNEL_ID,
      userId: e.DISCORD_USER_ID,
    },
    intervals: {
      apiKey: e.INTERVALS_API_KEY,
      athleteId: e.INTERVALS_ATHLETE_ID,
      baseUrl: e.INTERVALS_BASE_URL.replace(/\/+$/, ''),
    },
    area: e.PAIN_AREA,
    timezone: e.PAIN_TZ,
    morningCron: e.PAIN_MORNING_CRON,
    pollMinutes: e.PAIN_POLL_MINUTES,
    postRunDelayMinutes: e.PAIN_POST_RUN_DELAY_MINUTES,
    reminderMinutes: e.PAIN_REMINDER_MINUTES,
    maxRunAgeHours: e.PAIN_MAX_RUN_AGE_HOURS,
    activityTypes: e.PAIN_ACTIVITY_TYPES.split(',')
      .map((t) => t.trim())
      .filter(Boolean),
    promptDuring: e.PAIN_PROMPT_DURING,
    promptEffort: e.PAIN_PROMPT_EFFORT,
    statePath: e.PAIN_STATE_PATH,
    logLevel: e.PAIN_LOG_LEVEL,
  };
}
