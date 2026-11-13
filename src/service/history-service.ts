import type { ConversationRepository } from './ports/conversation-repository.js';

export class HistoryService {
  constructor(private readonly conversations: ConversationRepository) {}
  getCursor(conversationId: string): Promise<number> { return this.conversations.getLastSequence(conversationId); }
  readPage(conversationId: string, options: { afterSequence: number; throughSequence?: number; limit?: number }) {
    return this.conversations.listMessages(conversationId, { ...options, limit: options.limit ?? 200 });
  }
}
