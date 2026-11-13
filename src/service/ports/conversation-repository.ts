import type { Conversation, MemoryScope, Message, MessageRef } from '../../domain/conversation.js';
import type { ReplyTask } from '../contracts.js';

export interface ConversationRepository {
  getOrCreate(scope: MemoryScope): Promise<Conversation>;
  getConversation(id: string): Promise<Conversation | undefined>;
  acceptUserMessage(input: { conversationId: string; id: string; text: string; createdAt: string }): Promise<{ task: ReplyTask; message: Message; inserted: boolean }>;
  completeReply(taskId: string, reply: { id: string; text: string; createdAt: string }): Promise<Message>;
  markTaskRunning(taskId: string): Promise<void>;
  failTask(taskId: string, error: string): Promise<void>;
  getTask(taskId: string): Promise<ReplyTask | undefined>;
  listPendingTasks(): Promise<ReplyTask[]>;
  recoverRunningTasks(): Promise<void>;
  // No afterSequence: latest page, ascending. With afterSequence: next page, ascending.
  listMessages(conversationId: string, options?: { afterSequence?: number; throughSequence?: number; limit?: number }): Promise<Message[]>;
  // Earlier user messages and their replies, paired before the selected input.
  listContextMessages(conversationId: string, throughSequence: number, limit: number): Promise<Message[]>;
  getMessage(ref: MessageRef): Promise<Message | undefined>;
  getLastSequence(conversationId: string): Promise<number>;
  getMemoryReadySequence(conversationId: string): Promise<number>;
  importMessages(conversationId: string, messages: { id: string; role: 'user' | 'assistant'; text: string; createdAt: string }[]): Promise<number>;
}
