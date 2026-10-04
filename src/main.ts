import { Cron } from 'croner';
import { pino } from 'pino';
import { loadConfig, loadDotEnv } from './config.js';
import { DiscordJsGateway } from './discord/discordjs.js';
import { IntervalsClient } from './intervals.js';
import { PainService } from './service.js';
import { JsonFileStore } from './state.js';
import { MINUTE } from './time.js';

async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();
  const logger = pino({ level: config.logLevel });

  const gateway = new DiscordJsGateway(
    { botToken: config.discord.botToken, channelId: config.discord.channelId },
    logger,
  );
  const service = new PainService({
    settings: {
      userId: config.discord.userId,
      timezone: config.timezone,
      area: config.area,
      postRunDelayMinutes: config.postRunDelayMinutes,
      reminderMinutes: config.reminderMinutes,
      maxRunAgeHours: config.maxRunAgeHours,
      activityTypes: config.activityTypes,
      promptDuring: config.promptDuring,
    },
    intervals: new IntervalsClient(config.intervals),
    gateway,
    store: new JsonFileStore(config.statePath),
    logger,
  });

  await gateway.start();

  // Each job logs its own failure; one bad call must never stop the bot.
  const guard = (name: string, fn: () => Promise<void>) => () => {
    fn().catch((err: unknown) => logger.error({ err }, `${name} failed`));
  };
  const poll = guard('poll', () => service.poll());
  const tick = guard('tick', () => service.tick());
  const morning = guard('morning prompt', () => service.morning());

  const morningJob = new Cron(config.morningCron, { timezone: config.timezone, protect: true }, morning);
  const pollTimer = setInterval(poll, config.pollMinutes * MINUTE);
  const tickTimer = setInterval(tick, MINUTE);
  poll();

  // `kill -USR1 <pid>` (or `systemctl kill -s USR1 pain-prompt`) sends a morning prompt now.
  process.on('SIGUSR1', () => {
    logger.info('morning prompt requested by signal');
    morning();
  });

  logger.info(
    {
      morning: config.morningCron,
      next: morningJob.nextRun()?.toISOString(),
      timezone: config.timezone,
      pollMinutes: config.pollMinutes,
      postRunDelayMinutes: config.postRunDelayMinutes,
    },
    'pain-prompt running',
  );

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    morningJob.stop();
    clearInterval(pollTimer);
    clearInterval(tickTimer);
    await gateway.stop().catch(() => undefined);
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
