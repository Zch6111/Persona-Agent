import type { MemoryEntry } from '../../domain/memory.js';
import type { MemoryScope } from '../../domain/conversation.js';
import type { MemoryCheckpoint } from '../contracts.js';
export interface MemoryRepository {
  search(scope: MemoryScope, query: string, limit: number): Promise<MemoryEntry[]>;
  list(scope: MemoryScope): Promise<MemoryEntry[]>;
  getCheckpoint(conversationId: string): Promise<number>;
  applyBatch(scope: MemoryScope, entries: MemoryEntry[], checkpoint: MemoryCheckpoint): Promise<void>;
}
