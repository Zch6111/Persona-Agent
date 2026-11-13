/** 记忆用例：仅整理稳定的真实消息，召回并校验候选，原子保存记忆和进度。 */
import { randomUUID } from 'node:crypto';
import { type Conversation, type MemoryScope, type RuntimeSettings } from '../conversation/model.js';
import { validateMemoryEntry, validateMemoryCandidates, type MemoryEntry, type MemoryCandidate } from './model.js';
import { type ConversationRepository } from '../conversation/repository.js';
import { type MemoryRepository } from './repository.js';
import { type LanguageModel } from '../inference/usecase.js';
import { type PromptRepository } from '../persona/repository.js';
import { type InspectionService } from '../inspection/usecase.js';

interface Dependencies {
  conversations: ConversationRepository;
  memories: MemoryRepository;
  model: LanguageModel;
  prompts: PromptRepository;
  settings: RuntimeSettings;
  inspection?: InspectionService;
}

export class MemoryService {
  constructor(private readonly deps: Dependencies) {}

  /** 按当前输入召回最多十条相关记忆，不把原作参考当成用户经历。 */
  recall(scope: MemoryScope, query: string): Promise<MemoryEntry[]> {
    return this.deps.memories.search(scope, query, 10);
  }

  /** 从上次检查点继续整理；失败不推进进度，也不回滚已保存的聊天。 */
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
      const entries: MemoryEntry[] = validateMemoryCandidates(result).map(candidate => {
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
