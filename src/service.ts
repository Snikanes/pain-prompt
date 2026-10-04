import { randomBytes } from 'node:crypto';
import type { Logger } from 'pino';
import type { DiscordGateway, MessageRef } from './discord/gateway.js';
import type { Activity, IntervalsApi } from './intervals.js';
import { prune, type NoteTarget, type Prompt, type PromptKind, type State, type StateStore } from './state.js';
import { HOUR, MINUTE, addDays, hasZone, localDate, zonedToInstant } from './time.js';

export interface ServiceSettings {
  userId: string;
  timezone: string;
  area: string;
  postRunDelayMinutes: number;
  reminderMinutes: number;
  maxRunAgeHours: number;
  activityTypes: string[];
  promptDuring: boolean;
}

export interface ServiceDeps {
  settings: ServiceSettings;
  intervals: IntervalsApi;
  gateway: DiscordGateway;
  store: StateStore;
  logger?: Pick<Logger, 'info' | 'warn' | 'error' | 'debug'>;
  now?: () => Date;
}

/** Unanswered prompts lose their buttons after this long. */
export const PROMPT_TTL_MS = 20 * HOUR;

const NOOP = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };

/** The exact text written to Intervals.icu, kept stable so it is easy to parse later. */
export function scoreNote(kind: PromptKind, score: number): string {
  return `[pain] ${kind}=${score}/10`;
}

export function commentNote(kind: PromptKind, text: string): string {
  return `[pain] ${kind} comment: ${text}`;
}

/** When the run started, trusting the local wall-clock time if start_date has no zone. */
export function startInstant(a: Activity, timeZone: string): Date {
  return hasZone(a.startDate) ? new Date(a.startDate) : zonedToInstant(a.startDateLocal, timeZone);
}

function km(distance: number): string {
  return `${(distance / 1000).toFixed(1)} km`;
}

function newId(): string {
  return randomBytes(5).toString('hex');
}

/**
 * The pain-logging logic: decides when to ask, and where the answer goes.
 * Every state change runs through `exclusive`, so a button click arriving
 * mid-poll can't interleave with it and lose a write.
 */
export class PainService {
  private readonly s: ServiceSettings;
  private readonly log: Pick<Logger, 'info' | 'warn' | 'error' | 'debug'>;
  private readonly now: () => Date;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: ServiceDeps) {
    this.s = deps.settings;
    this.log = deps.logger ?? NOOP;
    this.now = deps.now ?? (() => new Date());
    deps.gateway.onScore((e) => this.handleScore(e.promptId, e.score, e.userId));
    deps.gateway.onComment((e) => this.handleComment(e.promptId, e.text, e.userId));
  }

  /** Morning check: ask now, attach to yesterday's/today's run or a calendar note. */
  morning(): Promise<void> {
    return this.exclusive(async (state) => {
      const now = this.now();
      const today = localDate(now, this.s.timezone);
      // If Intervals.icu is unreachable, still ask; the answer goes to a calendar note.
      const recent = await this.recentRuns(now).catch((err: unknown) => {
        this.log.warn({ err }, 'could not list runs for the morning prompt, using a calendar note');
        return [] as Activity[];
      });
      const runs = recent.filter(
        (a) => a.startDateLocal.slice(0, 10) >= addDays(today, -1) && startInstant(a, this.s.timezone) <= now,
      );
      const latest = runs.sort((a, b) => b.startDateLocal.localeCompare(a.startDateLocal))[0];
      const target: NoteTarget = latest
        ? {
            kind: 'activity',
            activityId: latest.id,
            activityName: `${latest.name} (${km(latest.distance)})`,
            activityDate: latest.startDateLocal.slice(0, 10),
          }
        : { kind: 'day', date: today };

      // A new morning supersedes yesterday's unanswered one.
      for (const p of state.prompts) {
        if (p.kind === 'morning' && p.status === 'open') await this.expire(p);
      }
      const prompt = this.newPrompt('morning', target, now);
      state.prompts.push(prompt);
      await this.send(prompt);
    });
  }

  /** Look for newly uploaded runs and schedule their prompts. */
  poll(): Promise<void> {
    return this.exclusive(async (state) => {
      const now = this.now();
      const runs = await this.recentRuns(now);
      const seen = new Set(state.seenActivityIds);
      for (const run of runs) {
        if (seen.has(run.id)) continue;
        state.seenActivityIds.push(run.id);
        seen.add(run.id);
        // First ever poll: just remember what already exists.
        if (!state.initialized) continue;

        const endedAt = startInstant(run, this.s.timezone).getTime() + run.elapsedTime * 1000;
        if (now.getTime() - endedAt > this.s.maxRunAgeHours * HOUR) {
          this.log.info({ activity: run.id }, 'old run uploaded late, not prompting');
          continue;
        }
        const target: NoteTarget = {
          kind: 'activity',
          activityId: run.id,
          activityName: `${run.name} (${km(run.distance)})`,
          activityDate: run.startDateLocal.slice(0, 10),
        };
        this.log.info({ activity: run.id, name: run.name }, 'new run found');
        if (this.s.promptDuring) state.prompts.push(this.newPrompt('during', target, now));
        if (this.s.postRunDelayMinutes > 0) {
          const due = new Date(Math.max(endedAt + this.s.postRunDelayMinutes * MINUTE, now.getTime()));
          state.prompts.push(this.newPrompt('after', target, due));
        }
      }
      state.initialized = true;
      // Anything due right now goes out in the same pass.
      await this.processDue(state, now);
    });
  }

  /** Send due prompts, one reminder for slow answers, expire stale ones. */
  tick(): Promise<void> {
    return this.exclusive(async (state) => {
      await this.processDue(state, this.now());
    });
  }

  handleScore(promptId: string, score: number, userId: string): Promise<string> {
    return this.exclusive(async (state) => {
      if (userId !== this.s.userId) return 'These prompts are not for you 🙂';
      const prompt = state.prompts.find((p) => p.id === promptId);
      if (!prompt) return 'That prompt is too old, nothing was saved.';
      if (prompt.status === 'answered') return `Already logged ${prompt.score}/10 for this one.`;
      if (prompt.status !== 'open') return 'That prompt has expired, nothing was saved.';

      // Write first: if Intervals.icu is down, the buttons stay so you can retry.
      await this.writeNote(prompt, scoreNote(prompt.kind, score));
      prompt.status = 'answered';
      prompt.score = score;
      prompt.answeredAt = this.now().toISOString();
      await this.refreshMessage(prompt);
      return `Logged ${score}/10 ${this.whereText(prompt)}.${adviceFor(score)}`;
    });
  }

  handleComment(promptId: string, text: string, userId: string): Promise<string> {
    return this.exclusive(async (state) => {
      if (userId !== this.s.userId) return 'These prompts are not for you 🙂';
      const prompt = state.prompts.find((p) => p.id === promptId);
      if (!prompt || prompt.status !== 'answered') return 'Pick a score first.';
      if (!text) return 'Empty comment, nothing saved.';
      await this.writeNote(prompt, commentNote(prompt.kind, text));
      return `Comment saved ${this.whereText(prompt)}.`;
    });
  }

  // ---------------------------------------------------------------------------

  private async processDue(state: State, now: Date): Promise<void> {
    for (const p of state.prompts) {
      if (p.status === 'scheduled' && new Date(p.dueAt) <= now) {
        if (now.getTime() - new Date(p.dueAt).getTime() > PROMPT_TTL_MS) {
          p.status = 'expired';
          continue;
        }
        await this.send(p);
      }
    }
    for (const p of state.prompts) {
      if (p.status !== 'open' || !p.sentAt) continue;
      const age = now.getTime() - new Date(p.sentAt).getTime();
      if (age > PROMPT_TTL_MS) {
        await this.expire(p);
      } else if (!p.reminded && this.s.reminderMinutes > 0 && age >= this.s.reminderMinutes * MINUTE) {
        p.reminded = true;
        await this.safely('reminder', () =>
          this.deps.gateway.reply(this.ref(p), `<@${this.s.userId}> Reminder: ${this.question(p)}`),
        );
      }
    }
  }

  private async send(prompt: Prompt): Promise<void> {
    try {
      const ref = await this.deps.gateway.sendPrompt(prompt.id, this.promptText(prompt));
      prompt.status = 'open';
      prompt.sentAt = this.now().toISOString();
      prompt.channelId = ref.channelId;
      prompt.messageId = ref.messageId;
    } catch (err) {
      // Stays 'scheduled' and is retried on the next tick.
      prompt.status = 'scheduled';
      this.log.error({ err, prompt: prompt.id }, 'could not send prompt, will retry');
    }
  }

  private async expire(p: Prompt): Promise<void> {
    p.status = 'expired';
    if (!p.messageId) return;
    await this.safely('expire', () =>
      this.deps.gateway.updatePrompt(this.ref(p), p.id, `${this.promptText(p, false)}\n*Expired, nothing logged.*`, 'none'),
    );
  }

  private async refreshMessage(p: Prompt): Promise<void> {
    if (!p.messageId) return;
    await this.safely('update message', () =>
      this.deps.gateway.updatePrompt(
        this.ref(p),
        p.id,
        `${this.promptText(p, false)}\n✅ **${p.score}/10** logged ${this.whereText(p)}.`,
        'comment',
      ),
    );
  }

  private async writeNote(p: Prompt, line: string): Promise<void> {
    if (p.target.kind === 'activity') {
      await this.deps.intervals.addActivityMessage(p.target.activityId, line);
      return;
    }
    // Rest day: one calendar note per prompt, comments appended to it.
    if (p.noteEventId && p.noteDescription !== undefined) {
      const description = `${p.noteDescription}\n${line}`;
      await this.deps.intervals.updateNote({
        id: p.noteEventId,
        date: p.target.date,
        name: 'Pain check',
        description,
      });
      p.noteDescription = description;
    } else {
      const note = await this.deps.intervals.createNote(p.target.date, 'Pain check', line);
      p.noteEventId = note.id;
      p.noteDescription = line;
    }
  }

  private question(p: Prompt): string {
    switch (p.kind) {
      case 'during':
        return `${this.s.area} pain **during** the run, 0–10?`;
      case 'after':
        return `${this.s.area} pain **right now**, ${hoursText(this.s.postRunDelayMinutes)} after the run, 0–10?`;
      case 'morning':
        return `${this.s.area} pain **this morning**, 0–10? Test it on the stairs or with a slow single-leg squat.`;
    }
  }

  private promptText(p: Prompt, mention = true): string {
    const who = mention ? `<@${this.s.userId}> ` : '';
    const icon = p.kind === 'morning' ? '☀️' : p.kind === 'during' ? '🏃' : '⏱️';
    const about =
      p.target.kind === 'activity'
        ? `**${p.target.activityName}**, ${p.target.activityDate}`
        : `no run since yesterday, saved as a calendar note for ${p.target.date}`;
    return `${who}${icon} ${capitalize(this.question(p))}\n-# ${about}`;
  }

  private whereText(p: Prompt): string {
    return p.target.kind === 'activity'
      ? `on ${p.target.activityName}`
      : `as a calendar note for ${p.target.date}`;
  }

  private newPrompt(kind: PromptKind, target: NoteTarget, dueAt: Date): Prompt {
    return { id: newId(), kind, target, status: 'scheduled', dueAt: dueAt.toISOString(), reminded: false };
  }

  private async recentRuns(now: Date): Promise<Activity[]> {
    const today = localDate(now, this.s.timezone);
    const all = await this.deps.intervals.listActivities(addDays(today, -1), today);
    return all.filter((a) => this.s.activityTypes.includes(a.type));
  }

  private ref(p: Prompt): MessageRef {
    return { channelId: p.channelId ?? '', messageId: p.messageId ?? '' };
  }

  private async safely(what: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.log.warn({ err }, `${what} failed`);
    }
  }

  /** Load state, run `fn`, save — one at a time. */
  private exclusive<T>(fn: (state: State) => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const state = await this.deps.store.load();
      try {
        return await fn(state);
      } finally {
        // Save even when fn throws, so sent prompts are never forgotten.
        await this.deps.store.save(prune(state, this.now()));
      }
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}

function adviceFor(score: number): string {
  if (score <= 2) return ' 👍 Within the plan.';
  if (score <= 4) return ' ⚠️ 3–4: add a rest day and repeat last week.';
  return ' 🛑 5+: stop running and get it checked.';
}

function hoursText(minutes: number): string {
  if (minutes % 60 === 0) return `${minutes / 60} h`;
  return `${minutes} min`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
