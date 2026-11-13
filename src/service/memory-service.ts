import { randomUUID } from 'node:crypto';
import type { Conversation, MemoryScope } from '../domain/conversation.js';
import { validateMemoryEntry, type MemoryEntry } from '../domain/memory.js';
import type { MemoryCandidate, RuntimeSettings } from './contracts.js';
import type { ConversationRepository } from './ports/conversation-repository.js';
import type { MemoryRepository } from './ports/memory-repository.js';
import type { LanguageModel } from './ports/language-model.js';
import type { PromptRepository } from './ports/prompt-repository.js';
import type { InspectionService } from './inspection-service.js';

interface Dependencies {
  conversations: ConversationRepository;
  memories: MemoryRepository;
  model: LanguageModel;
  prompts: PromptRepository;
  settings: RuntimeSettings;
  inspection?: InspectionService;
}

function candidates(value: unknown): MemoryCandidate[] {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { memories?: unknown }).memories)) throw new Error('记忆提取结果格式不正确。');
  const rows: unknown[] = (value as { memories: unknown[] }).memories;
  if (rows.length > 20) throw new Error('单批记忆数量超出限制。');
  return rows.map(value => {
    const row = value as Partial<MemoryCandidate> | null;
    if (!row || typeof row.content !== 'string' || !row.content.trim() || row.content.length > 2000 || !['user_statement', 'interaction', 'inference'].includes(String(row.kind)) || !Array.isArray(row.sourceMessageIds) || !row.sourceMessageIds.length || !row.sourceMessageIds.every(id => typeof id === 'string' && id.length > 0) || !Array.isArray(row.supersedes) || !row.supersedes.every(id => typeof id === 'string')) throw new Error('候选记忆缺少有效内容或来源。');
    return row as MemoryCandidate;
  });
}

export class MemoryService {
  constructor(private readonly deps: Dependencies) {}

  recall(scope: MemoryScope, query: string): Promise<MemoryEntry[]> {
    return this.deps.memories.search(scope, query, 10);
  }

  async consolidate(conversationId: string, signal?: AbortSignal): Promise<void> {
    try { await this.process(conversationId, signal); }
    catch (error) { this.deps.inspection?.memoryFailed(); throw error; }
  }

  private async process(conversationId: string, signal?: AbortSignal): Promise<void> {
    const { conversations, memories, model, prompts, settings } = this.deps;
    const conversation = await conversations.getConversation(conversationId);
    if (!conversation) throw new Error('对话不存在。');
    const instructions = await prompts.get('memory');
    while (!signal?.aborted) {
      const checkpoint = await memories.getCheckpoint(conversationId);
      const readySequence = await conversations.getMemoryReadySequence(conversationId);
      const available = await conversations.listMessages(conversationId, { afterSequence: checkpoint, throughSequence: readySequence, limit: settings.memoryBatchSize });
      if (!available.length) return;
      const active = await memories.list(conversation);
      const messageBudget = settings.maxContextChars - instructions.length - 128;
      const batch: typeof available = [];
      const messageRows: { id: string; role: string; text: string; createdAt: string; replyToMessageId?: string }[] = [];
      for (const message of available) {
        const row = { id: message.id, role: message.role, text: message.text, createdAt: message.createdAt, replyToMessageId: message.replyToMessageId };
        if (JSON.stringify([...messageRows, row]).length > messageBudget) break;
        batch.push(message); messageRows.push(row);
      }
      if (!batch.length) throw new Error('单条历史消息超过记忆整理预算，请提高上下文预算后继续。');
      const revisions = await memories.search(conversation, batch.filter(message => message.role === 'user').map(message => message.text).join('\n'), 20);
      const revisionContext: { id: string; kind: string; content: string }[] = [];
      for (const memory of revisions) {
        const row = { id: memory.id, kind: memory.kind, content: memory.content };
        const candidate = JSON.stringify({ currentMemories: [...revisionContext, row], messages: messageRows });
        if (candidate.length + instructions.length <= settings.maxContextChars) revisionContext.push(row);
      }
      const inputText = JSON.stringify({ currentMemories: revisionContext, messages: messageRows });
      this.deps.inspection?.memoryStarted();
      const result = await model.generateStructured({ purpose: 'memory', instructions, messages: [{ role: 'user', content: inputText }], maxOutputTokens: 1800, signal });
      const allowedSources = new Set(batch.map(message => message.id));
      const allowedRevisions = new Set(active.map(memory => memory.id));
      const entries: MemoryEntry[] = candidates(result).map(candidate => {
        if (candidate.sourceMessageIds.some(id => !allowedSources.has(id))) throw new Error('记忆提取引用了本批以外的消息。');
        if (candidate.supersedes.some(id => !allowedRevisions.has(id))) throw new Error('记忆修正目标不存在。');
        return this.createEntry(conversation, candidate);
      });
      signal?.throwIfAborted();
      await memories.applyBatch(conversation, entries, { conversationId, throughSequence: batch.at(-1)!.sequence });
      this.deps.inspection?.memoryUpdated(entries);
    }
    signal?.throwIfAborted();
  }

  private createEntry(conversation: Conversation, candidate: MemoryCandidate): MemoryEntry {
    const entry: MemoryEntry = { id: randomUUID(), userId: conversation.userId, characterId: conversation.characterId, content: candidate.content, kind: candidate.kind, sourceMessages: [...new Set(candidate.sourceMessageIds)].map(messageId => ({ conversationId: conversation.id, messageId })), supersedes: [...new Set(candidate.supersedes)], createdAt: new Date().toISOString() };
    validateMemoryEntry(entry, conversation);
    return entry;
  }
}
