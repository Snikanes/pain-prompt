/** Calendar date (YYYY-MM-DD) of an instant in the given timezone. */
export function localDate(at: Date, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/** Shift a YYYY-MM-DD date by whole days (pure calendar arithmetic). */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;

/** Offset (ms) of `timeZone` from UTC at the given instant. */
function tzOffsetMs(at: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(at));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(at / 1000) * 1000;
}

/**
 * Instant for a wall-clock time like "2026-10-04T08:13:30" in `timeZone`.
 * Independent of the server's own timezone setting.
 */
export function zonedToInstant(local: string, timeZone: string): Date {
  const naive = Date.parse(`${local.slice(0, 19)}Z`);
  let instant = naive - tzOffsetMs(naive, timeZone);
  // Second pass settles DST transitions.
  instant = naive - tzOffsetMs(instant, timeZone);
  return new Date(instant);
}

/** True when an ISO string carries its own zone (Z or ±hh:mm). */
export function hasZone(iso: string): boolean {
  return /(Z|[+-]\d{2}:?\d{2})$/.test(iso);
}
