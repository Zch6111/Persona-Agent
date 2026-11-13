import { randomUUID } from 'node:crypto';
import type { ModelInput } from './contracts.js';
import type { MemoryEntry } from '../domain/memory.js';

export interface ModelTraceObserver {
  begin(purpose: ModelInput['purpose'], payload: Record<string, unknown>): { complete(text: string): void; fail(): void };
}
interface ModelTrace {
  id: string; purpose: ModelInput['purpose']; startedAt: string; finishedAt?: string;
  status: 'running' | 'completed' | 'failed'; payload: Record<string, unknown>; response?: string;
}

export class InspectionService implements ModelTraceObserver {
  private requests: ModelTrace[] = [];
  private memory = { state: 'idle' as 'idle' | 'processing' | 'failed', updatedAt: undefined as string | undefined, lastChanges: [] as MemoryEntry[] };
  begin(purpose: ModelInput['purpose'], payload: Record<string, unknown>) {
    const trace: ModelTrace = { id: randomUUID(), purpose, startedAt: new Date().toISOString(), status: 'running', payload: structuredClone(payload) };
    this.requests.push(trace);
    if (this.requests.length > 20) this.requests.shift();
    return {
      complete: (text: string) => { trace.status = 'completed'; trace.finishedAt = new Date().toISOString(); trace.response = text; },
      fail: () => { trace.status = 'failed'; trace.finishedAt = new Date().toISOString(); },
    };
  }
  memoryStarted() { this.memory.state = 'processing'; }
  memoryUpdated(entries: MemoryEntry[]) { this.memory = { state: 'idle', updatedAt: new Date().toISOString(), lastChanges: structuredClone(entries) }; }
  memoryFailed() { this.memory.state = 'failed'; }
  snapshot() { return structuredClone({ requests: this.requests, memory: this.memory }); }
}
