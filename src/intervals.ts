/** The slice of an Intervals.icu activity this bot cares about. */
export interface Activity {
  id: string;
  type: string;
  name: string;
  /** start as returned by the API (normally UTC with Z; may be empty) */
  startDate: string;
  /** athlete-local start, e.g. "2026-10-04T08:13:30" (no offset) */
  startDateLocal: string;
  /** seconds, including pauses */
  elapsedTime: number;
  /** metres */
  distance: number;
}

export interface CalendarNote {
  id: string;
  date: string;
  name: string;
  description: string;
}

/** Everything the bot needs from Intervals.icu. */
export interface IntervalsApi {
  /** activities whose local start date is within [oldest, newest] (YYYY-MM-DD) */
  listActivities(oldest: string, newest: string): Promise<Activity[]>;
  addActivityMessage(activityId: string, content: string): Promise<void>;
  createNote(date: string, name: string, description: string): Promise<CalendarNote>;
  updateNote(note: CalendarNote): Promise<void>;
}

export interface IntervalsClientOptions {
  apiKey: string;
  athleteId: string;
  baseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class IntervalsError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'IntervalsError';
  }
}

/** Thin REST client. Auth is HTTP Basic with the literal user "API_KEY". */
export class IntervalsClient implements IntervalsApi {
  private readonly fetchImpl: typeof fetch;
  private readonly auth: string;
  private readonly timeoutMs: number;

  constructor(private readonly opts: IntervalsClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.auth = `Basic ${Buffer.from(`API_KEY:${opts.apiKey}`).toString('base64')}`;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  async listActivities(oldest: string, newest: string): Promise<Activity[]> {
    const q = new URLSearchParams({ oldest, newest });
    const raw = await this.request<unknown[]>(
      'GET',
      `/athlete/${encodeURIComponent(this.opts.athleteId)}/activities?${q.toString()}`,
    );
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((a) => {
      const activity = toActivity(a);
      return activity ? [activity] : [];
    });
  }

  async addActivityMessage(activityId: string, content: string): Promise<void> {
    await this.request('POST', `/activity/${encodeURIComponent(activityId)}/messages`, {
      content,
    });
  }

  async createNote(date: string, name: string, description: string): Promise<CalendarNote> {
    const res = await this.request<{ id?: number | string }>(
      'POST',
      `/athlete/${encodeURIComponent(this.opts.athleteId)}/events`,
      noteBody(date, name, description),
    );
    if (res?.id === undefined) throw new IntervalsError('note created but no id returned');
    return { id: String(res.id), date, name, description };
  }

  async updateNote(note: CalendarNote): Promise<void> {
    await this.request(
      'PUT',
      `/athlete/${encodeURIComponent(this.opts.athleteId)}/events/${encodeURIComponent(note.id)}`,
      noteBody(note.date, note.name, note.description),
    );
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: this.auth,
      Accept: 'application/json',
      'User-Agent': 'pain-prompt/0.1',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await this.fetchImpl(`${this.opts.baseUrl}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new IntervalsError(
        `Intervals.icu ${method} ${path.split('?')[0]} failed: ${res.status} ${text.slice(0, 200)}`,
        res.status,
      );
    }
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
}

function noteBody(date: string, name: string, description: string): Record<string, string> {
  return {
    category: 'NOTE',
    name,
    description,
    start_date_local: `${date}T00:00:00`,
    color: 'blue',
  };
}

function toActivity(raw: unknown): Activity | null {
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as Record<string, unknown>;
  if (a.id === undefined || typeof a.type !== 'string') return null;
  if (typeof a.start_date_local !== 'string') return null;
  return {
    id: String(a.id),
    type: a.type,
    name: typeof a.name === 'string' ? a.name : a.type,
    startDate: typeof a.start_date === 'string' ? a.start_date : '',
    startDateLocal: a.start_date_local,
    elapsedTime: typeof a.elapsed_time === 'number' ? a.elapsed_time : Number(a.moving_time ?? 0),
    distance: typeof a.distance === 'number' ? a.distance : 0,
  };
}
