/** Node 定时器适配；取消句柄由对话运行用例管理，定时器不阻止进程退出。 */
import type { TaskScheduler } from '../../application/conversation/usecase.js';

export class NodeTaskScheduler implements TaskScheduler {
  repeat(operation: () => void, intervalMs: number): () => void {
    const timer = setInterval(operation, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }
}
