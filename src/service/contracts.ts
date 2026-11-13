import type { Message, MemoryScope } from '../domain/conversation.js';

export interface ReplyTask {
  id: string;
  conversationId: string;
  inputMessageId: string;
  inputSequence: number;
  status: 'pending' | 'running' | 'completed' | 'failed';
  replyMessageId?: string;
  error?: string;
  createdAt: string;
}
export interface ModelInput {
  purpose: 'reply' | 'memory';
  instructions: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  maxOutputTokens: number;
  signal?: AbortSignal;
}
export type ChatEvent =
  | { kind: 'reply_started'; conversationId: string; taskId: string }
  | { kind: 'message_saved'; conversationId: string; message: Message }
  | { kind: 'reply_failed'; conversationId: string; taskId: string; text: string }
  | { kind: 'availability'; online: boolean };
export interface MemoryCheckpoint { conversationId: string; throughSequence: number }
export interface MemoryCandidate {
  content: string;
  kind: 'user_statement' | 'interaction' | 'inference';
  sourceMessageIds: string[];
  supersedes: string[];
}
export interface RuntimeSettings {
  scope: MemoryScope;
  maxHistoryMessages: number;
  maxContextChars: number;
  maxHistoryChars: number;
  maxMemoryChars: number;
  maxReferenceChars: number;
  maxInputChars: number;
  maxOutputTokens: number;
  memoryBatchSize: number;
}
