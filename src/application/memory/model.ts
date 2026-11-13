/** 记忆业务模型：归属、来源、候选格式、修正关系及整理进度。 */
import { type MemoryScope, type MessageRef } from '../conversation/model.js';

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

export interface MemoryCheckpoint { conversationId: string; throughSequence: number }

export interface MemoryCandidate {
  content: string;
  kind: 'user_statement' | 'interaction' | 'inference';
  sourceMessageIds: string[];
  supersedes: string[];
}

/** 校验模型提取结果的业务格式，来源真实性在用例与仓库中继续校验。 */
export function validateMemoryCandidates(value: unknown): MemoryCandidate[] {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { memories?: unknown }).memories)) throw new Error('记忆提取结果格式不正确。');
  const rows: unknown[] = (value as { memories: unknown[] }).memories;
  if (rows.length > 20) throw new Error('单批记忆数量超出限制。');
  return rows.map(value => {
    const row = value as Partial<MemoryCandidate> | null;
    if (!row || typeof row.content !== 'string' || !row.content.trim() || row.content.length > 2000 || !['user_statement', 'interaction', 'inference'].includes(String(row.kind)) || !Array.isArray(row.sourceMessageIds) || !row.sourceMessageIds.length || !row.sourceMessageIds.every(id => typeof id === 'string' && id.length > 0) || !Array.isArray(row.supersedes) || !row.supersedes.every(id => typeof id === 'string')) throw new Error('候选记忆缺少有效内容或来源。');
    return row as MemoryCandidate;
  });
}

