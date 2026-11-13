import { randomUUID } from 'node:crypto';
import type { Message } from '../domain/conversation.js';
import { validateMessageText } from '../domain/conversation.js';
import type { ReplyTask, RuntimeSettings } from './contracts.js';
import type { ContextBuilder } from './context-builder.js';
import type { ConversationRepository } from './ports/conversation-repository.js';
import type { LanguageModel } from './ports/language-model.js';

export class ChatService {
  constructor(private readonly deps: { conversations: ConversationRepository; context: ContextBuilder; model: LanguageModel; settings: RuntimeSettings }) {}

  isAvailable(): Promise<boolean> { return this.deps.model.isAvailable(); }

  acceptMessage(conversationId: string, id: string, text: string) {
    validateMessageText(text);
    if (!id || id.length > 200) throw new Error('消息 ID 不正确。');
    if (text.length > this.deps.settings.maxInputChars) throw new Error('消息过长，请分段发送。');
    return this.deps.conversations.acceptUserMessage({ conversationId, id, text, createdAt: new Date().toISOString() });
  }

  async generateReply(task: ReplyTask, signal?: AbortSignal): Promise<Message> {
    const { conversations, context, model } = this.deps;
    const current = await conversations.getTask(task.id);
    if (current?.status === 'completed' && current.replyMessageId) {
      const reply = await conversations.getMessage({ conversationId: task.conversationId, messageId: current.replyMessageId });
      if (reply) return reply;
    }
    await conversations.markTaskRunning(task.id);
    try {
      const input = await context.build(task, signal);
      const text = await model.generateText(input);
      validateMessageText(text);
      signal?.throwIfAborted();
      return await conversations.completeReply(task.id, { id: randomUUID(), text, createdAt: new Date().toISOString() });
    } catch (error) {
      if (!signal?.aborted) await conversations.failTask(task.id, '本次回复失败，请重试。');
      throw error;
    }
  }
}
