/** 进程内观察仓库；所有写入和快照均复制，避免调用方修改已记录的请求。 */
import type { InspectionRepository } from '../../application/inspection/repository.js';
import type { InspectionSnapshot, ModelTrace, MemoryStatus } from '../../application/inspection/model.js';

export class InMemoryInspectionRepository implements InspectionRepository {
  private requests: ModelTrace[] = [];
  private memory: MemoryStatus = { state: 'idle', updatedAt: undefined, lastChanges: [] };

  appendTrace(trace: ModelTrace, limit: number): void {
    this.requests.push(structuredClone(trace));
    if (this.requests.length > limit) this.requests.splice(0, this.requests.length - limit);
  }
  updateTrace(id: string, result: Partial<Pick<ModelTrace, 'status' | 'finishedAt' | 'response'>>): void {
    const trace = this.requests.find(item => item.id === id);
    if (trace) Object.assign(trace, result);
  }
  getMemoryStatus(): MemoryStatus { return structuredClone(this.memory); }
  saveMemoryStatus(status: MemoryStatus): void { this.memory = structuredClone(status); }
  snapshot(): InspectionSnapshot { return structuredClone({ requests: this.requests, memory: this.memory }); }
}
