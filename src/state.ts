import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export type PromptKind = 'during' | 'after' | 'morning';

/** Where an answer is written in Intervals.icu. */
export type NoteTarget =
  | { kind: 'activity'; activityId: string; activityName: string; activityDate: string }
  | { kind: 'day'; date: string };

export type PromptStatus = 'scheduled' | 'open' | 'answered' | 'expired';

export interface Prompt {
  id: string;
  kind: PromptKind;
  target: NoteTarget;
  status: PromptStatus;
  /** when the prompt should be (or was due to be) sent */
  dueAt: string;
  sentAt?: string;
  channelId?: string;
  messageId?: string;
  reminded: boolean;
  score?: number;
  answeredAt?: string;
  /** calendar note created for a day target, so a comment can be appended */
  noteEventId?: string;
  noteDescription?: string;
}

export interface State {
  version: 1;
  /** false until the first poll has recorded the existing activities */
  initialized: boolean;
  seenActivityIds: string[];
  prompts: Prompt[];
}

export function emptyState(): State {
  return { version: 1, initialized: false, seenActivityIds: [], prompts: [] };
}

export interface StateStore {
  load(): Promise<State>;
  save(state: State): Promise<void>;
}

/**
 * State as one small JSON file. Written to a temp file and renamed, so a
 * crash or power cut mid-write never leaves a half-written file behind
 * (rename is atomic on the same filesystem on Linux and macOS).
 */
export class JsonFileStore implements StateStore {
  constructor(private readonly path: string) {}

  async load(): Promise<State> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return emptyState();
      throw e;
    }
    const parsed = JSON.parse(text) as Partial<State>;
    return {
      ...emptyState(),
      ...parsed,
      version: 1,
    };
  }

  async save(state: State): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await rename(tmp, this.path);
  }
}

export class MemoryStore implements StateStore {
  state: State = emptyState();
  async load(): Promise<State> {
    return structuredClone(this.state);
  }
  async save(state: State): Promise<void> {
    this.state = structuredClone(state);
  }
}

const KEEP_SEEN = 500;
const KEEP_CLOSED_MS = 14 * 24 * 60 * 60 * 1000;

/** Drop old bookkeeping so the file stays small over months of use. */
export function prune(state: State, now: Date): State {
  const cutoff = now.getTime() - KEEP_CLOSED_MS;
  return {
    ...state,
    seenActivityIds: state.seenActivityIds.slice(-KEEP_SEEN),
    prompts: state.prompts.filter(
      (p) =>
        p.status === 'open' ||
        p.status === 'scheduled' ||
        new Date(p.answeredAt ?? p.sentAt ?? p.dueAt).getTime() >= cutoff,
    ),
  };
}
