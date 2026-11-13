/** 观察业务模型：实际调用记录、记忆整理状态和只读快照。 */
import type { ModelInput } from '../inference/model.js';
import type { MemoryEntry } from '../memory/model.js';

export interface ModelTrace {
  id: string;
  purpose: ModelInput['purpose'];
  startedAt: string;
  finishedAt?: string;
  status: 'running' | 'completed' | 'failed';
  payload: Record<string, unknown>;
  response?: string;
}

export interface MemoryStatus {
  state: 'idle' | 'processing' | 'failed';
  updatedAt?: string;
  lastChanges: MemoryEntry[];
}

export interface InspectionSnapshot {
  requests: ModelTrace[];
  memory: MemoryStatus;
}

/** 每个进程仅保留最近的实际调用，重启不会伪装成历史调用。 */
export const RECENT_TRACE_LIMIT = 20;
