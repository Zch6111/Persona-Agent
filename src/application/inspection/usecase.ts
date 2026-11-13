/** 观察用例：记录实际请求生命周期、更新整理状态、聚合已提交的记忆及来源。 */
import { randomUUID } from 'node:crypto';
import type { ModelInput } from '../inference/model.js';
import type { MemoryEntry } from '../memory/model.js';
import type { Conversation } from '../conversation/model.js';
import type { ConversationRepository } from '../conversation/repository.js';
import type { MemoryRepository } from '../memory/repository.js';
import { RECENT_TRACE_LIMIT } from './model.js';
import type { ModelTrace } from './model.js';
import type { InspectionRepository } from './repository.js';

/** 非存储观察能力：在适配器发送最终请求体的位置采集。 */
export interface ModelTraceObserver {
  begin(purpose: ModelInput['purpose'], payload: Record<string, unknown>): { complete(text: string): void; fail(): void };
}

export class InspectionService implements ModelTraceObserver {
  constructor(private readonly repository: InspectionRepository) {}

  /** 只记录请求体，不接收包含 API 密钥的鉴权请求头。 */
  begin(purpose: ModelInput['purpose'], payload: Record<string, unknown>) {
    const trace: ModelTrace = { id: randomUUID(), purpose, startedAt: new Date().toISOString(), status: 'running', payload: structuredClone(payload) };
    this.repository.appendTrace(trace, RECENT_TRACE_LIMIT);
    return {
      complete: (text: string) => this.repository.updateTrace(trace.id, { status: 'completed', finishedAt: new Date().toISOString(), response: text }),
      fail: () => this.repository.updateTrace(trace.id, { status: 'failed', finishedAt: new Date().toISOString() }),
    };
  }

  /** 整理开始保留上次变更信息。 */
  memoryStarted() {
    this.repository.saveMemoryStatus({ ...this.repository.getMemoryStatus(), state: 'processing' });
  }
  /** 仅在批次成功提交之后记录变更。 */
  memoryUpdated(entries: MemoryEntry[]) {
    this.repository.saveMemoryStatus({ state: 'idle', updatedAt: new Date().toISOString(), lastChanges: entries });
  }
  memoryFailed() {
    this.repository.saveMemoryStatus({ ...this.repository.getMemoryStatus(), state: 'failed' });
  }
  snapshot() { return this.repository.snapshot(); }

  /** 聚合实际已提交的记忆及其消息来源，不修改聊天或整理进度。 */
  async inspect(conversation: Conversation, deps: { conversations: ConversationRepository; memories: MemoryRepository }) {
    const entries = await deps.memories.list(conversation);
    const checkpoint = await deps.memories.getCheckpoint(conversation.id);
    const lastSequence = await deps.conversations.getLastSequence(conversation.id);
    const snapshot = this.snapshot();
    const sources = await Promise.all(entries.flatMap(entry => entry.sourceMessages).map(ref => deps.conversations.getMessage(ref)));
    return { ...snapshot, memory: { ...snapshot.memory, checkpoint, lastSequence, pendingMessages: lastSequence - checkpoint, entries, sources: sources.filter(Boolean) } };
  }
}
