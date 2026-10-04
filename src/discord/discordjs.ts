import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type Interaction,
  type SendableChannels,
} from 'discord.js';
import type { Logger } from 'pino';
import type {
  CommentEvent,
  DiscordGateway,
  MessageRef,
  PromptButtons,
  ScoreEvent,
} from './gateway.js';

export interface DiscordJsConfig {
  botToken: string;
  channelId: string;
}

const PREFIX = 'pp';

/** Custom ids carry everything needed, so buttons keep working across restarts. */
export const ids = {
  score: (promptId: string, score: number) => `${PREFIX}:score:${promptId}:${score}`,
  comment: (promptId: string) => `${PREFIX}:comment:${promptId}`,
  modal: (promptId: string) => `${PREFIX}:modal:${promptId}`,
};

export type ParsedId =
  | { type: 'score'; promptId: string; score: number }
  | { type: 'comment'; promptId: string }
  | { type: 'modal'; promptId: string };

export function parseCustomId(customId: string): ParsedId | null {
  const parts = customId.split(':');
  if (parts[0] !== PREFIX || !parts[2]) return null;
  const promptId = parts[2];
  if (parts[1] === 'score') {
    const score = Number(parts[3]);
    if (!Number.isInteger(score) || score < 0 || score > 10) return null;
    return { type: 'score', promptId, score };
  }
  if (parts[1] === 'comment') return { type: 'comment', promptId };
  if (parts[1] === 'modal') return { type: 'modal', promptId };
  return null;
}

/** Green for 0–2 (fine), blue for 3–4 (repeat the week), red for 5+ (stop). */
function styleFor(score: number): ButtonStyle {
  if (score <= 2) return ButtonStyle.Success;
  if (score <= 4) return ButtonStyle.Primary;
  return ButtonStyle.Danger;
}

export function buildRows(promptId: string, buttons: PromptButtons): ActionRowBuilder<ButtonBuilder>[] {
  if (buttons === 'none') return [];
  if (buttons === 'comment') {
    return [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(ids.comment(promptId))
          .setLabel('Add comment')
          .setStyle(ButtonStyle.Secondary),
      ),
    ];
  }
  // Discord allows five buttons per row: 0–4, 5–9, 10.
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let start = 0; start <= 10; start += 5) {
    const row = new ActionRowBuilder<ButtonBuilder>();
    for (let s = start; s <= Math.min(start + 4, 10); s++) {
      row.addComponents(
        new ButtonBuilder().setCustomId(ids.score(promptId, s)).setLabel(String(s)).setStyle(styleFor(s)),
      );
    }
    rows.push(row);
  }
  return rows;
}

/**
 * The one place discord.js appears. Only the Guilds intent is needed:
 * button clicks and modal submits arrive as interactions, which need no
 * message or privileged intents.
 */
export class DiscordJsGateway implements DiscordGateway {
  private readonly client: Client;
  private scoreHandler?: (event: ScoreEvent) => Promise<string>;
  private commentHandler?: (event: CommentEvent) => Promise<string>;

  constructor(
    private readonly cfg: DiscordJsConfig,
    private readonly logger: Pick<Logger, 'info' | 'warn' | 'error'>,
  ) {
    this.client = new Client({ intents: [GatewayIntentBits.Guilds] });
  }

  async start(): Promise<void> {
    this.client.on(Events.InteractionCreate, (interaction) => {
      this.handleInteraction(interaction).catch((err: unknown) => {
        this.logger.error({ err }, 'interaction handling failed');
      });
    });
    this.client.on(Events.Error, (err) => this.logger.error({ err }, 'discord client error'));
    this.client.on(Events.ShardDisconnect, () => this.logger.warn('discord gateway disconnected'));

    const ready = new Promise<void>((resolve) => {
      this.client.once(Events.ClientReady, (c) => {
        this.logger.info({ user: c.user.tag }, 'discord ready');
        resolve();
      });
    });
    await this.client.login(this.cfg.botToken);
    await ready;
    // Fail fast on a wrong channel id or missing permissions.
    await this.textChannel();
  }

  async stop(): Promise<void> {
    await this.client.destroy();
  }

  async sendPrompt(promptId: string, text: string): Promise<MessageRef> {
    const channel = await this.textChannel();
    const message = await channel.send({ content: text, components: buildRows(promptId, 'scores') });
    return { channelId: message.channelId, messageId: message.id };
  }

  async updatePrompt(
    ref: MessageRef,
    promptId: string,
    text: string,
    buttons: PromptButtons,
  ): Promise<void> {
    const channel = await this.client.channels.fetch(ref.channelId);
    if (!channel || !channel.isTextBased()) throw new Error(`channel ${ref.channelId} not readable`);
    const message = await channel.messages.fetch(ref.messageId);
    await message.edit({
      content: text,
      components: buildRows(promptId, buttons),
      // Don't re-ping on edits.
      allowedMentions: { parse: [] },
    });
  }

  async reply(ref: MessageRef, text: string): Promise<void> {
    const channel = await this.textChannel();
    await channel.send({
      content: text,
      reply: { messageReference: ref.messageId, failIfNotExists: false },
    });
  }

  async notice(text: string): Promise<void> {
    const channel = await this.textChannel();
    await channel.send({ content: text });
  }

  onScore(handler: (event: ScoreEvent) => Promise<string>): void {
    this.scoreHandler = handler;
  }

  onComment(handler: (event: CommentEvent) => Promise<string>): void {
    this.commentHandler = handler;
  }

  private async handleInteraction(interaction: Interaction): Promise<void> {
    if (interaction.isButton()) {
      const parsed = parseCustomId(interaction.customId);
      if (!parsed) return;
      if (parsed.type === 'comment') {
        // A modal must be shown as the first response — no deferring.
        const input = new TextInputBuilder()
          .setCustomId('comment')
          .setLabel('Comment')
          .setStyle(TextInputStyle.Paragraph)
          .setMaxLength(500)
          .setRequired(true)
          .setPlaceholder('e.g. a bit stiff on the stairs, fine after a few minutes');
        const modal = new ModalBuilder()
          .setCustomId(ids.modal(parsed.promptId))
          .setTitle('Pain comment')
          .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
        await interaction.showModal(modal);
        return;
      }
      if (parsed.type !== 'score' || !this.scoreHandler) return;
      // Writing to Intervals.icu can outlast Discord's 3-second window.
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const text = await this.safe(() =>
        this.scoreHandler!({ promptId: parsed.promptId, score: parsed.score, userId: interaction.user.id }),
      );
      await interaction.editReply({ content: text });
      return;
    }

    if (interaction.isModalSubmit()) {
      const parsed = parseCustomId(interaction.customId);
      if (!parsed || parsed.type !== 'modal' || !this.commentHandler) return;
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const comment = interaction.fields.getTextInputValue('comment').trim();
      const text = await this.safe(() =>
        this.commentHandler!({ promptId: parsed.promptId, text: comment, userId: interaction.user.id }),
      );
      await interaction.editReply({ content: text });
    }
  }

  private async safe(fn: () => Promise<string>): Promise<string> {
    try {
      return await fn();
    } catch (err) {
      this.logger.error({ err }, 'handler failed');
      return '⚠️ Something went wrong, nothing was saved. Try again in a minute.';
    }
  }

  private async textChannel(): Promise<SendableChannels> {
    const channel = await this.client.channels.fetch(this.cfg.channelId);
    if (!channel || !channel.isSendable()) {
      throw new Error(`Discord channel ${this.cfg.channelId} is not a text channel the bot can post in`);
    }
    return channel;
  }
}
