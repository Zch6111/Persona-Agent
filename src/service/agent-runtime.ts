import type { Conversation } from '../domain/conversation.js';
import type { ChatEvent, ReplyTask, RuntimeSettings } from './contracts.js';
import type { ChatService } from './chat-service.js';
import type { MemoryService } from './memory-service.js';
import type { ConversationRepository } from './ports/conversation-repository.js';

interface Dependencies {
  chat: ChatService;
  memory: MemoryService;
  conversations: ConversationRepository;
  settings: RuntimeSettings;
  pollIntervalMs?: number;
  onWarning?: (text: string) => void;
}

export class AgentRuntime {
  private conversation?: Conversation;
  private available = false;
  private started = false;
  private stopping = false;
  private readonly abort = new AbortController();
  private readonly listeners = new Set<(event: ChatEvent) => void>();
  private readonly queue: ReplyTask[] = [];
  private readonly queued = new Set<string>();
  private drainPromise?: Promise<void>;
  private activeTask?: ReplyTask;
  private readonly memoryJobs = new Map<string, Promise<void>>();
  private timer?: ReturnType<typeof setInterval>;
  private availabilityCheck?: Promise<void>;
  private switching = false;
  private changePromise?: Promise<void>;

  constructor(private readonly deps: Dependencies) {}
  get online(): boolean { return this.available && !this.stopping && !this.switching; }

  changeModel(operation: () => Promise<void>): Promise<void> {
    if (this.switching || this.stopping) return Promise.reject(new Error('正在切换或关闭模型，请稍后重试。'));
    this.switching = true;
    this.emit({ kind: 'availability', online: false });
    return this.changePromise = (async () => {
      try {
        await this.waitForIdle();
        await this.availabilityCheck;
        if (this.stopping) throw new Error('服务正在关闭。');
        await operation();
      } finally {
        this.switching = false;
        await this.refreshAvailability();
        this.emit({ kind: 'availability', online: this.online });
        this.kick();
      }
    })();
  }

  async getConversation(): Promise<Conversation> {
    return this.conversation ??= await this.deps.conversations.getOrCreate(this.deps.settings.scope);
  }

  subscribe(listener: (event: ChatEvent) => void): () => void {
    this.listeners.add(listener);
    if (this.activeTask) {
      try { listener({ kind: 'reply_started', conversationId: this.activeTask.conversationId, taskId: this.activeTask.id }); } catch { this.warn('一个聊天连接未能接收通知。'); }
    }
    return () => { this.listeners.delete(listener); };
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.getConversation();
    await this.deps.conversations.recoverRunningTasks();
    for (const task of await this.deps.conversations.listPendingTasks()) if (task.conversationId === this.conversation!.id) this.enqueue(task);
    await this.refreshAvailability();
    this.timer = setInterval(() => { void this.refreshAvailability(); }, this.deps.pollIntervalMs ?? 15_000);
    this.timer.unref();
  }

  async acceptMessage(conversationId: string, id: string, text: string): Promise<void> {
    if (!this.started || this.stopping) throw new Error('聊天服务尚未启动。');
    if (conversationId !== (await this.getConversation()).id) throw new Error('对话归属不匹配。');
    const accepted = await this.deps.chat.acceptMessage(conversationId, id, text);
    if (accepted.inserted) this.emit({ kind: 'message_saved', conversationId, message: accepted.message });
    if (accepted.task.status === 'completed' && accepted.task.replyMessageId) {
      const reply = await this.deps.conversations.getMessage({ conversationId, messageId: accepted.task.replyMessageId });
      if (reply) this.emit({ kind: 'message_saved', conversationId, message: reply });
    } else if (accepted.task.status === 'failed') {
      this.emit({ kind: 'reply_failed', conversationId, taskId: accepted.task.id, text: accepted.task.error ?? '本次回复失败，请重试。' });
    } else this.enqueue(accepted.task);
    this.kick();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    clearInterval(this.timer);
    this.available = false;
    this.emit({ kind: 'availability', online: false });
    this.abort.abort();
    await Promise.allSettled([this.drainPromise, this.changePromise, ...this.memoryJobs.values()].filter((job): job is Promise<void> => !!job));
    this.listeners.clear();
  }

  async waitForIdle(): Promise<void> {
    while (this.drainPromise || this.memoryJobs.size) {
      await Promise.allSettled([this.drainPromise, ...this.memoryJobs.values()].filter((job): job is Promise<void> => !!job));
    }
  }

  private emit(event: ChatEvent): void {
    for (const listener of this.listeners) {
      try { listener(event); } catch { this.warn('一个聊天连接未能接收通知。'); }
    }
  }
  private warn(text: string): void { try { this.deps.onWarning?.(text); } catch { /* Diagnostic callbacks cannot change saved business results. */ } }
  private enqueue(task: ReplyTask): void {
    if (this.queued.has(task.id)) return;
    this.queued.add(task.id);
    this.queue.push(task);
    this.queue.sort((a, b) => a.inputSequence - b.inputSequence);
  }
  private kick(): void {
    if (!this.online || this.drainPromise || !this.queue.length) return;
    this.drainPromise = this.drain().finally(() => { this.drainPromise = undefined; this.kick(); });
  }
  private async drain(): Promise<void> {
    while (this.online && this.queue.length) {
      const task = this.queue.shift()!;
      this.activeTask = task;
      this.emit({ kind: 'reply_started', conversationId: task.conversationId, taskId: task.id });
      try {
        const message = await this.deps.chat.generateReply(task, this.abort.signal);
        this.emit({ kind: 'message_saved', conversationId: task.conversationId, message });
        this.scheduleMemory(task.conversationId);
      } catch {
        if (!this.stopping) this.emit({ kind: 'reply_failed', conversationId: task.conversationId, taskId: task.id, text: '本次回复失败，请重试。' });
      } finally { this.activeTask = undefined; this.queued.delete(task.id); }
    }
  }
  private scheduleMemory(conversationId: string): void {
    if (!this.online || this.memoryJobs.has(conversationId)) return;
    const job = this.deps.memory.consolidate(conversationId, this.abort.signal)
      .catch(() => { if (!this.stopping) this.warn('记忆整理暂未完成，已保存的聊天会在之后继续整理。'); })
      .finally(() => { this.memoryJobs.delete(conversationId); });
    this.memoryJobs.set(conversationId, job);
  }
  refreshAvailability(): Promise<void> {
    if (this.stopping || this.switching) return Promise.resolve();
    if (this.availabilityCheck) return this.availabilityCheck;
    this.availabilityCheck = (async () => {
      const online = await this.deps.chat.isAvailable().catch(() => false);
      if (this.stopping || this.switching) return;
      if (online !== this.available) { this.available = online; this.emit({ kind: 'availability', online }); }
      this.kick();
      if (online && !this.queue.length && !this.drainPromise) this.scheduleMemory((await this.getConversation()).id);
    })().finally(() => { this.availabilityCheck = undefined; });
    return this.availabilityCheck;
  }
}
