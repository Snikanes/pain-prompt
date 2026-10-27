import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildRows, ids, parseCustomId } from '../src/discord/discordjs.js';
import { IntervalsClient } from '../src/intervals.js';
import { JsonFileStore, emptyState } from '../src/state.js';
import { addDays, localDate } from '../src/time.js';

const baseEnv = {
  DISCORD_BOT_TOKEN: 't',
  DISCORD_CHANNEL_ID: 'c',
  DISCORD_USER_ID: 'u',
  INTERVALS_API_KEY: 'k',
  INTERVALS_ATHLETE_ID: 'i1',
};

describe('config', () => {
  it('applies defaults', () => {
    const c = loadConfig(baseEnv);
    expect(c.morningCron).toBe('10 7 * * *');
    expect(c.timezone).toBe('Europe/Oslo');
    expect(c.postRunDelayMinutes).toBe(240);
    expect(c.activityTypes).toEqual(['Run', 'TrailRun', 'VirtualRun']);
  });
  it('rejects missing values and bad timezones', () => {
    expect(() => loadConfig({})).toThrow('DISCORD_BOT_TOKEN');
    expect(() => loadConfig({ ...baseEnv, PAIN_TZ: 'Mars/Base' })).toThrow('unknown timezone');
  });
});

describe('time', () => {
  it('uses the configured timezone, not the server’s', () => {
    expect(localDate(new Date('2026-10-04T22:30:00Z'), 'Europe/Oslo')).toBe('2026-10-05');
    expect(localDate(new Date('2026-10-04T22:30:00Z'), 'UTC')).toBe('2026-10-04');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
});

describe('discord custom ids', () => {
  it('round-trips', () => {
    expect(parseCustomId(ids.score('abc', 7))).toEqual({ type: 'score', promptId: 'abc', score: 7 });
    expect(parseCustomId(ids.comment('abc'))).toEqual({ type: 'comment', promptId: 'abc' });
    expect(parseCustomId(ids.effort('abc', 'feel', 5))).toEqual({ type: 'effort', promptId: 'abc', field: 'feel', value: 5 });
    expect(parseCustomId('pp:effort:abc:feel:6')).toBeNull();
    expect(parseCustomId('pp:effort:abc:rpe:0')).toBeNull();
    expect(parseCustomId('pp:score:abc:11')).toBeNull();
    expect(parseCustomId('other:thing')).toBeNull();
  });
  it('lays out 0–10 in rows of at most five', () => {
    const rows = buildRows('p', 'scores').map((r) => r.components.length);
    expect(rows).toEqual([5, 5, 1]);
    expect(buildRows('p', 'none')).toEqual([]);
    expect(buildRows('p', { effort: ['rpe', 'feel'] }).map((r) => r.components.length)).toEqual([5, 5, 5]);
    expect(buildRows('p', { effort: ['feel'] }).map((r) => r.components.length)).toEqual([5]);
  });
});

describe('state file', () => {
  it('starts empty and round-trips', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pain-'));
    const store = new JsonFileStore(join(dir, 'nested', 'state.json'));
    expect(await store.load()).toEqual(emptyState());
    await store.save({ ...emptyState(), initialized: true, seenActivityIds: ['a'] });
    expect((await store.load()).seenActivityIds).toEqual(['a']);
    expect(await readFile(join(dir, 'nested', 'state.json'), 'utf8')).toContain('"initialized": true');
  });
});

describe('intervals client', () => {
  it('sends basic auth and maps activities', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify([
          { id: 'i9', type: 'Run', name: 'Easy', start_date: '2026-10-04T06:13:30Z', start_date_local: '2026-10-04T08:13:30', elapsed_time: 2038, distance: 5014, icu_rpe: 6, feel: null },
          { id: 'broken' },
        ]),
      );
    }) as unknown as typeof fetch;
    const client = new IntervalsClient({ apiKey: 'secret', athleteId: 'i1', baseUrl: 'https://x/api/v1', fetchImpl });
    const acts = await client.listActivities('2026-10-03', '2026-10-04');
    expect(acts).toHaveLength(1);
    expect(acts[0]!.elapsedTime).toBe(2038);
    expect(acts[0]!.rpe).toBe(6);
    expect(acts[0]!.feel).toBeUndefined();
    expect(calls[0]!.url).toBe('https://x/api/v1/athlete/i1/activities?oldest=2026-10-03&newest=2026-10-04');
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from('API_KEY:secret').toString('base64')}`,
    );
  });
  it('updates RPE and feel with a PUT on the activity', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response('{}');
    }) as unknown as typeof fetch;
    const client = new IntervalsClient({ apiKey: 'k', athleteId: 'i1', baseUrl: 'https://x', fetchImpl });
    await client.updateActivity('i9', { icu_rpe: 7 });
    expect(calls[0]!.url).toBe('https://x/activity/i9');
    expect(calls[0]!.init.method).toBe('PUT');
    expect(calls[0]!.init.body).toBe('{"icu_rpe":7}');
  });
  it('throws on HTTP errors', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 403 })) as unknown as typeof fetch;
    const client = new IntervalsClient({ apiKey: 'k', athleteId: 'i1', baseUrl: 'https://x', fetchImpl });
    await expect(client.addActivityMessage('a', 'hi')).rejects.toThrow('403');
  });
});

describe('zoned times', async () => {
  const { zonedToInstant, hasZone } = await import('../src/time.js');
  it('converts Oslo wall-clock to UTC across DST', () => {
    expect(zonedToInstant('2026-10-04T08:13:30', 'Europe/Oslo').toISOString()).toBe('2026-10-04T06:13:30.000Z');
    expect(zonedToInstant('2026-12-01T08:00:00', 'Europe/Oslo').toISOString()).toBe('2026-12-01T07:00:00.000Z');
  });
  it('detects explicit zones', () => {
    expect(hasZone('2026-10-04T06:13:30Z')).toBe(true);
    expect(hasZone('2026-10-04T08:13:30+02:00')).toBe(true);
    expect(hasZone('2026-10-04T08:13:30')).toBe(false);
  });
});
