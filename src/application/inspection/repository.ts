/** 观察存储契约；同步操作保证调用开始、完成和快照之间的顺序。 */
import type { ModelTrace, MemoryStatus, InspectionSnapshot } from './model.js';

export interface InspectionRepository {
  appendTrace(trace: ModelTrace, limit: number): void;
  updateTrace(id: string, result: Partial<Pick<ModelTrace, 'status' | 'finishedAt' | 'response'>>): void;
  getMemoryStatus(): MemoryStatus;
  saveMemoryStatus(status: MemoryStatus): void;
  snapshot(): InspectionSnapshot;
}
