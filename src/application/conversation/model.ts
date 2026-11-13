/** 对话业务模型：消息归属、顺序、回复关联、任务状态、业务事件和上下文预算。 */

export interface MemoryScope { userId: string; characterId: string }
export interface Conversation extends MemoryScope { id: string; createdAt: string }
export interface MessageRef { conversationId: string; messageId: string }
export interface Message {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;
  sequence: number;
  replyToMessageId?: string;
}

export function validateMessageText(text: string): void {
  if (typeof text !== 'string' || !text.trim()) throw new Error('消息不能为空。');
}

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

export type ChatEvent =
  | { kind: 'reply_started'; conversationId: string; taskId: string }
  | { kind: 'message_saved'; conversationId: string; message: Message }
  | { kind: 'reply_failed'; conversationId: string; taskId: string; text: string }
  | { kind: 'availability'; online: boolean };

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
