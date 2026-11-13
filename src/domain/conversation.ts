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
