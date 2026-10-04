import type {
  CommentEvent,
  DiscordGateway,
  MessageRef,
  PromptButtons,
  ScoreEvent,
} from './gateway.js';

export interface FakeMessage extends MessageRef {
  promptId?: string;
  text: string;
  buttons: PromptButtons;
  replyTo?: string;
}

/** In-memory Discord for tests: records messages, lets tests click buttons. */
export class FakeGateway implements DiscordGateway {
  readonly messages: FakeMessage[] = [];
  readonly notices: string[] = [];
  failSends = false;
  private nextId = 1;
  private scoreHandler?: (event: ScoreEvent) => Promise<string>;
  private commentHandler?: (event: CommentEvent) => Promise<string>;

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  async sendPrompt(promptId: string, text: string): Promise<MessageRef> {
    if (this.failSends) throw new Error('discord down');
    const ref = { channelId: 'chan', messageId: `m${this.nextId++}` };
    this.messages.push({ ...ref, promptId, text, buttons: 'scores' });
    return ref;
  }

  async updatePrompt(ref: MessageRef, promptId: string, text: string, buttons: PromptButtons): Promise<void> {
    const m = this.messages.find((x) => x.messageId === ref.messageId);
    if (!m) throw new Error('unknown message');
    Object.assign(m, { promptId, text, buttons });
  }

  async reply(ref: MessageRef, text: string): Promise<void> {
    this.messages.push({
      channelId: ref.channelId,
      messageId: `m${this.nextId++}`,
      text,
      buttons: 'none',
      replyTo: ref.messageId,
    });
  }

  async notice(text: string): Promise<void> {
    this.notices.push(text);
  }

  onScore(handler: (event: ScoreEvent) => Promise<string>): void {
    this.scoreHandler = handler;
  }

  onComment(handler: (event: CommentEvent) => Promise<string>): void {
    this.commentHandler = handler;
  }

  prompts(): FakeMessage[] {
    return this.messages.filter((m) => m.promptId !== undefined);
  }

  last(): FakeMessage {
    const m = this.messages.at(-1);
    if (!m) throw new Error('no messages');
    return m;
  }

  async click(promptId: string, score: number, userId = 'me'): Promise<string> {
    if (!this.scoreHandler) throw new Error('no score handler');
    return this.scoreHandler({ promptId, score, userId });
  }

  async comment(promptId: string, text: string, userId = 'me'): Promise<string> {
    if (!this.commentHandler) throw new Error('no comment handler');
    return this.commentHandler({ promptId, text, userId });
  }
}
