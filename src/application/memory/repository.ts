/** 记忆存储契约：范围隔离、来源完整性、检索与批次原子提交。 */
import { type MemoryEntry, type MemoryCheckpoint } from './model.js';
import { type MemoryScope } from '../conversation/model.js';

export interface MemoryRepository {
  /** 在用户与角色范围内检索有效记忆，返回相关结果。 */
  search(scope: MemoryScope, query: string, limit: number): Promise<MemoryEntry[]>;
  /** 列出未被替代的有效记忆，保留各条来源与修正关系。 */
  list(scope: MemoryScope): Promise<MemoryEntry[]>;
  /** 查询已成功整理到的消息游标，初始为零。 */
  getCheckpoint(conversationId: string): Promise<number>;
  /** 原子提交新增记忆、旧记忆修正关系与进度；任意来源或归属无效时全部回滚。 */
  applyBatch(scope: MemoryScope, entries: MemoryEntry[], checkpoint: MemoryCheckpoint): Promise<void>;
}
