import { beforeEach, describe, expect, it } from 'vitest';
import { FakeGateway } from '../src/discord/fake.js';
import type { Activity, CalendarNote, IntervalsApi } from '../src/intervals.js';
import { PainService, PROMPT_TTL_MS, type ServiceSettings } from '../src/service.js';
import { MemoryStore } from '../src/state.js';
import { HOUR, MINUTE } from '../src/time.js';

class FakeIntervals implements IntervalsApi {
  activities: Activity[] = [];
  messages: { activityId: string; content: string }[] = [];
  notes: CalendarNote[] = [];
  failWrites = false;
  async listActivities(oldest: string, newest: string): Promise<Activity[]> {
    return this.activities.filter(
      (a) => a.startDateLocal.slice(0, 10) >= oldest && a.startDateLocal.slice(0, 10) <= newest,
    );
  }
  async addActivityMessage(activityId: string, content: string): Promise<void> {
    if (this.failWrites) throw new Error('intervals down');
    this.messages.push({ activityId, content });
  }
  async createNote(date: string, name: string, description: string): Promise<CalendarNote> {
    if (this.failWrites) throw new Error('intervals down');
    const note = { id: `n${this.notes.length + 1}`, date, name, description };
    this.notes.push(note);
    return note;
  }
  async updateNote(note: CalendarNote): Promise<void> {
    const i = this.notes.findIndex((n) => n.id === note.id);
    this.notes[i] = note;
  }
}

const settings: ServiceSettings = {
  userId: 'me',
  timezone: 'Europe/Oslo',
  area: 'Groin',
  postRunDelayMinutes: 240,
  reminderMinutes: 45,
  maxRunAgeHours: 12,
  activityTypes: ['Run'],
  promptDuring: true,
};

/** A run starting at the given UTC time (Oslo is UTC+2 in October). */
function run(id: string, startUtc: string, minutes = 33, type = 'Run'): Activity {
  const start = new Date(startUtc);
  const local = new Date(start.getTime() + 2 * HOUR).toISOString().slice(0, 19);
  return {
    id,
    type,
    name: 'Oslo Running',
    startDate: start.toISOString(),
    startDateLocal: local,
    elapsedTime: minutes * 60,
    distance: 5014,
  };
}

let clock: Date;
let intervals: FakeIntervals;
let gateway: FakeGateway;
let store: MemoryStore;
let service: PainService;

function at(iso: string): void {
  clock = new Date(iso);
}
function advance(ms: number): void {
  clock = new Date(clock.getTime() + ms);
}

beforeEach(() => {
  at('2026-10-05T05:10:00Z'); // 07:10 Oslo
  intervals = new FakeIntervals();
  gateway = new FakeGateway();
  store = new MemoryStore();
  service = new PainService({ settings, intervals, gateway, store, now: () => clock });
});

describe('morning prompt', () => {
  it('attaches to yesterday’s run', async () => {
    intervals.activities = [run('i1', '2026-10-04T06:13:30Z')];
    await service.morning();
    const p = gateway.prompts()[0]!;
    expect(p.text).toContain('<@me>');
    expect(p.text).toContain('this morning');
    expect(p.text).toContain('Oslo Running (5.0 km)');

    expect(await gateway.click(p.promptId!, 1)).toContain('Logged 1/10');
    expect(intervals.messages).toEqual([{ activityId: 'i1', content: '[pain] morning=1/10' }]);
    expect(gateway.prompts()[0]!.buttons).toBe('comment');
  });

  it('uses a calendar note on a rest day, and appends comments to it', async () => {
    intervals.activities = [run('old', '2026-10-02T06:00:00Z')];
    await service.morning();
    const p = gateway.prompts()[0]!;
    expect(p.text).toContain('calendar note for 2026-10-05');

    await gateway.click(p.promptId!, 0);
    await gateway.comment(p.promptId!, 'stairs fine');
    expect(intervals.messages).toHaveLength(0);
    expect(intervals.notes).toEqual([
      { id: 'n1', date: '2026-10-05', name: 'Pain check', description: '[pain] morning=0/10\n[pain] morning comment: stairs fine' },
    ]);
  });

  it('still asks when Intervals.icu is unreachable', async () => {
    intervals.listActivities = async () => {
      throw new Error('down');
    };
    await service.morning();
    expect(gateway.prompts()[0]!.text).toContain('calendar note');
  });

  it('expires yesterday’s unanswered morning prompt', async () => {
    await service.morning();
    advance(24 * HOUR - MINUTE);
    await service.morning();
    const [first, second] = gateway.prompts();
    expect(first!.buttons).toBe('none');
    expect(first!.text).toContain('Expired');
    expect(second!.buttons).toBe('scores');
  });
});

describe('run detection', () => {
  it('does not prompt for runs that existed before the first poll', async () => {
    intervals.activities = [run('i1', '2026-10-05T04:00:00Z')];
    await service.poll();
    expect(gateway.prompts()).toHaveLength(0);
    expect(store.state.initialized).toBe(true);
  });

  it('asks "during" at once and "after" 4h after the run ended', async () => {
    await service.poll(); // initialise
    at('2026-10-05T16:00:00Z');
    intervals.activities = [run('i2', '2026-10-05T15:20:00Z', 33)]; // ended 15:53Z
    await service.poll();
    expect(gateway.prompts().map((m) => m.text)).toEqual([expect.stringContaining('**during** the run')]);

    at('2026-10-05T19:52:00Z');
    await service.tick();
    expect(gateway.prompts()).toHaveLength(1);
    at('2026-10-05T19:53:00Z');
    await service.tick();
    expect(gateway.prompts()).toHaveLength(2);
    expect(gateway.prompts()[1]!.text).toContain('4 h after the run');

    // both answers land on the run
    await gateway.click(gateway.prompts()[0]!.promptId!, 1);
    await gateway.click(gateway.prompts()[1]!.promptId!, 2);
    expect(intervals.messages.map((m) => m.content)).toEqual(['[pain] during=1/10', '[pain] after=2/10']);
  });

  it('works out timing from the local start when start_date has no zone', async () => {
    await service.poll();
    at('2026-10-05T16:00:00Z');
    intervals.activities = [{ ...run('z', '2026-10-05T15:20:00Z', 33), startDate: '' }];
    await service.poll();
    at('2026-10-05T19:52:00Z');
    await service.tick();
    expect(gateway.prompts()).toHaveLength(1);
    at('2026-10-05T19:53:00Z');
    await service.tick();
    expect(gateway.prompts()).toHaveLength(2);
  });

  it('ignores other sports and runs only once per activity', async () => {
    await service.poll();
    at('2026-10-05T16:00:00Z');
    intervals.activities = [run('r', '2026-10-05T15:20:00Z'), run('b', '2026-10-05T15:00:00Z', 30, 'Ride')];
    await service.poll();
    await service.poll();
    expect(gateway.prompts()).toHaveLength(1);
  });

  it('skips runs uploaded long after they ended', async () => {
    await service.poll();
    at('2026-10-05T20:00:00Z');
    intervals.activities = [run('late', '2026-10-05T05:00:00Z')];
    await service.poll();
    expect(gateway.prompts()).toHaveLength(0);
  });
});

describe('reminders, retries and guards', () => {
  it('reminds once, then expires after the TTL', async () => {
    await service.morning();
    advance(44 * MINUTE);
    await service.tick();
    expect(gateway.messages.filter((m) => m.replyTo)).toHaveLength(0);
    advance(MINUTE);
    await service.tick();
    advance(10 * MINUTE);
    await service.tick();
    const reminders = gateway.messages.filter((m) => m.replyTo);
    expect(reminders).toHaveLength(1);
    expect(reminders[0]!.text).toContain('Reminder');

    advance(PROMPT_TTL_MS);
    await service.tick();
    expect(gateway.prompts()[0]!.buttons).toBe('none');
    expect(await gateway.click(gateway.prompts()[0]!.promptId!, 1)).toContain('expired');
  });

  it('keeps the prompt open when Intervals.icu fails, so a retry works', async () => {
    intervals.activities = [run('i1', '2026-10-04T06:13:30Z')];
    await service.morning();
    const id = gateway.prompts()[0]!.promptId!;
    intervals.failWrites = true;
    await expect(gateway.click(id, 2)).rejects.toThrow('intervals down');
    expect(gateway.prompts()[0]!.buttons).toBe('scores');
    intervals.failWrites = false;
    expect(await gateway.click(id, 2)).toContain('Logged 2/10');
    expect(await gateway.click(id, 3)).toContain('Already logged 2/10');
    expect(intervals.messages).toHaveLength(1);
  });

  it('retries a prompt Discord failed to send', async () => {
    gateway.failSends = true;
    await service.morning();
    expect(store.state.prompts[0]!.status).toBe('scheduled');
    gateway.failSends = false;
    await service.tick();
    expect(gateway.prompts()).toHaveLength(1);
  });

  it('ignores clicks from other users', async () => {
    await service.morning();
    expect(await gateway.click(gateway.prompts()[0]!.promptId!, 1, 'someone-else')).toContain('not for you');
    expect(intervals.notes).toHaveLength(0);
  });

  it('gives advice that matches the pain rules', async () => {
    await service.morning();
    expect(await gateway.click(gateway.prompts()[0]!.promptId!, 4)).toContain('repeat last week');
  });
});
