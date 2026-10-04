export interface MessageRef {
  channelId: string;
  messageId: string;
}

/** Which buttons sit under a prompt message. */
export type PromptButtons = 'scores' | 'comment' | 'none';

export interface ScoreEvent {
  promptId: string;
  score: number;
  userId: string;
}

export interface CommentEvent {
  promptId: string;
  text: string;
  userId: string;
}

/**
 * Everything the pain logic needs from Discord. discord.js only appears in
 * the adapter that implements this, so the logic is tested with a fake.
 */
export interface DiscordGateway {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** post a prompt with 0–10 buttons */
  sendPrompt(promptId: string, text: string): Promise<MessageRef>;
  /** rewrite a prompt and swap its buttons */
  updatePrompt(
    ref: MessageRef,
    promptId: string,
    text: string,
    buttons: PromptButtons,
  ): Promise<void>;
  /** reply in the channel, threaded to the given message */
  reply(ref: MessageRef, text: string): Promise<void>;
  /** plain channel message, e.g. an error report */
  notice(text: string): Promise<void>;
  /** the returned string is shown only to the clicker */
  onScore(handler: (event: ScoreEvent) => Promise<string>): void;
  onComment(handler: (event: CommentEvent) => Promise<string>): void;
}
