import type { MemoryScope, MessageRef } from './conversation.js';

export interface MemoryEntry extends MemoryScope {
  id: string;
  content: string;
  kind: 'user_statement' | 'interaction' | 'inference';
  sourceMessages: MessageRef[];
  supersedes: string[];
  supersededBy?: string;
  createdAt: string;
}

export function validateMemoryEntry(entry: MemoryEntry, scope: MemoryScope): void {
  if (entry.userId !== scope.userId || entry.characterId !== scope.characterId) throw new Error('记忆归属不匹配。');
  if (!entry.id || !entry.content.trim() || !['user_statement', 'interaction', 'inference'].includes(entry.kind)) throw new Error('记忆内容格式不正确。');
  if (!entry.sourceMessages.length || entry.sourceMessages.some(source => !source.conversationId || !source.messageId)) throw new Error('记忆必须关联真实消息。');
  if (entry.supersedes.includes(entry.id)) throw new Error('记忆不能修正自身。');
}
