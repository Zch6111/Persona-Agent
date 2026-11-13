/** 对话用例：消息接收、上下文组装、回复生成、历史查询、串行调度与中断恢复。 */
import { randomUUID } from 'node:crypto';
import { type Message, validateMessageText, type ReplyTask, type RuntimeSettings, type Conversation, type ChatEvent } from './model.js';
import { type ConversationRepository } from './repository.js';
import { type LanguageModel } from '../inference/usecase.js';
import { type SpeechReference } from '../persona/model.js';
import { type ModelInput } from '../inference/model.js';
import type { PersonaService } from '../persona/usecase.js';
import { type MemoryService } from '../memory/usecase.js';

export class ChatService {
  constructor(private readonly deps: { conversations: ConversationRepository; context: ContextBuilder; model: LanguageModel; settings: RuntimeSettings }) {}

  /** 通过内部模型能力接口检查当前来源，不负责网络协议。 */
  isAvailable(): Promise<boolean> { return this.deps.model.isAvailable(); }

  /** 校验消息后原子接收；运行协调器负责入队和通知。 */
  acceptMessage(conversationId: string, id: string, text: string) {
    validateMessageText(text);
    if (!id || id.length > 200) throw new Error('消息 ID 不正确。');
    if (text.length > this.deps.settings.maxInputChars) throw new Error('消息过长，请分段发送。');
    return this.deps.conversations.acceptUserMessage({ conversationId, id, text, createdAt: new Date().toISOString() });
  }

  /** 重用已完成回复，或构建上下文并生成；取消时保留任务以供重启恢复。 */
  async generateReply(task: ReplyTask, signal?: AbortSignal): Promise<Message> {
    const { conversations, context, model } = this.deps;
    const current = await conversations.getTask(task.id);
    if (current?.status === 'completed' && current.replyMessageId) {
      const reply = await conversations.getMessage({ conversationId: task.conversationId, messageId: current.replyMessageId });
      if (reply) return reply;
    }
    await conversations.markTaskRunning(task.id);
    try {
      const input = await context.build(task, signal);
      const text = await model.generateText(input);
      validateMessageText(text);
      signal?.throwIfAborted();
      return await conversations.completeReply(task.id, { id: randomUUID(), text, createdAt: new Date().toISOString() });
    } catch (error) {
      if (!signal?.aborted) await conversations.failTask(task.id, '本次回复失败，请重试。');
      throw error;
    }
  }
}

interface ContextDependencies {
  persona: PersonaService;
  conversations: ConversationRepository;
  memories: MemoryService;
  settings: RuntimeSettings;
}

function referenceText(reference: SpeechReference): string {
  return JSON.stringify({ title: reference.title, kind: reference.kind, source: reference.source, era: reference.era, relationship: reference.relationship, context: reference.context, turns: reference.turns, text: reference.text });
}

export class ContextBuilder {
  constructor(private readonly deps: ContextDependencies) {}

  /** 保留角色与当前输入，在预算内选择记忆、参考及按因果顺序组织的历史。 */
  async build(task: ReplyTask, signal?: AbortSignal): Promise<ModelInput> {
    const { persona, conversations, memories, settings } = this.deps;
    const conversation = await conversations.getConversation(task.conversationId);
    if (!conversation) throw new Error('对话不存在。');
    const input = await conversations.getMessage({ conversationId: task.conversationId, messageId: task.inputMessageId });
    if (!input) throw new Error('用户消息不存在。');
    const [character, template, history, recalled, references] = await Promise.all([
      persona.getCharacter(conversation.characterId), persona.getPrompt('reply'),
      conversations.listContextMessages(task.conversationId, task.inputSequence, settings.maxHistoryMessages),
      memories.recall(conversation, input.text), persona.selectReferences(conversation.characterId, input.text),
    ]);
    const baseInstructions = [template, `角色资料（身份与当前设定）：\n${JSON.stringify(character)}`].join('\n\n');
    const optionalBudget = settings.maxContextChars - baseInstructions.length - input.text.length - 256;
    if (optionalBudget < 0) throw new Error('角色资料和本条消息超出上下文预算，请缩短消息或调整配置。');
    let remainingMemory = Math.min(settings.maxMemoryChars, Math.floor(optionalBudget * 0.25));
    const memoryText: string[] = [];
    for (const memory of recalled) {
      const text = JSON.stringify({ id: memory.id, kind: memory.kind, content: memory.content, sources: memory.sourceMessages });
      if (text.length <= remainingMemory) { memoryText.push(text); remainingMemory -= text.length; }
    }
    let remainingReferences = Math.min(settings.maxReferenceChars, Math.floor(optionalBudget * 0.4));
    const referenceTexts: string[] = [];
    for (const reference of references) {
      const text = referenceText(reference);
      if (text.length <= remainingReferences) { referenceTexts.push(text); remainingReferences -= text.length; }
    }
    const instructions = [
      baseInstructions,
      `长期记忆（用户自述、互动与推断须分别理解）：\n${memoryText.join('\n') || '暂无相关长期记忆。'}`,
      `原作与表达参考（仅供参考，不是当前用户与你的聊天历史）：\n${referenceTexts.join('\n') || '暂无参考。'}`,
    ].join('\n\n');
    const messages: ModelInput['messages'] = [];
    let remainingHistory = Math.min(settings.maxHistoryChars, settings.maxContextChars - instructions.length);
    for (const message of history.toReversed()) {
      if (message.id === input.id || message.text.length <= remainingHistory) {
        messages.unshift({ role: message.role, content: message.text });
        remainingHistory -= message.text.length;
      } else break;
    }
    if (!messages.length || messages.at(-1)?.role !== 'user') throw new Error('对话上下文缺少当前用户消息。');
    signal?.throwIfAborted();
    return { purpose: 'reply', instructions, messages, maxOutputTokens: settings.maxOutputTokens, signal };
  }
}

export class HistoryService {
  constructor(private readonly conversations: ConversationRepository) {}
  /** 获取历史快照的末尾位置，供协议适配器无缝衔接实时消息。 */
  getCursor(conversationId: string): Promise<number> { return this.conversations.getLastSequence(conversationId); }
  /** 按给定快照与游标读取下一页，默认最多 200 条。 */
  readPage(conversationId: string, options: { afterSequence: number; throughSequence?: number; limit?: number }) {
    return this.conversations.listMessages(conversationId, { ...options, limit: options.limit ?? 200 });
  }
}

/** 定时调度能力由外部注入，内部只决定何时检查模型和继续任务。 */
export interface TaskScheduler {
  repeat(operation: () => void, intervalMs: number): () => void;
}

interface RuntimeDependencies {
  chat: ChatService;
  memory: MemoryService;
  conversations: ConversationRepository;
  settings: RuntimeSettings;
  scheduler: TaskScheduler;
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
  private cancelPoll?: () => void;
  private availabilityCheck?: Promise<void>;
  private switching = false;
  private changePromise?: Promise<void>;

  constructor(private readonly deps: RuntimeDependencies) {}
  get online(): boolean { return this.available && !this.stopping && !this.switching; }

  /** 暂停新回复，等待回复和记忆任务结束后切换，最后重新探测并恢复调度。 */
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

  /** 在当前运行期复用同一个用户与角色对话。 */
  async getConversation(): Promise<Conversation> {
    return this.conversation ??= await this.deps.conversations.getOrCreate(this.deps.settings.scope);
  }

  /** 订阅业务事件；新订阅者同时获知当前正在生成的任务。 */
  subscribe(listener: (event: ChatEvent) => void): () => void {
    this.listeners.add(listener);
    if (this.activeTask) {
      try { listener({ kind: 'reply_started', conversationId: this.activeTask.conversationId, taskId: this.activeTask.id }); } catch { this.warn('一个聊天连接未能接收通知。'); }
    }
    return () => { this.listeners.delete(listener); };
  }

  /** 恢复中断任务，检测模型可用性，并注册外部轮询。 */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.getConversation();
    await this.deps.conversations.recoverRunningTasks();
    for (const task of await this.deps.conversations.listPendingTasks()) if (task.conversationId === this.conversation!.id) this.enqueue(task);
    await this.refreshAvailability();
    this.cancelPoll = this.deps.scheduler.repeat(() => { void this.refreshAvailability(); }, this.deps.pollIntervalMs ?? 15_000);
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

  /** 取消轮询与生成，等待在途任务结束，然后清理订阅。 */
  async stop(): Promise<void> {
    this.stopping = true;
    this.cancelPoll?.();
    this.available = false;
    this.emit({ kind: 'availability', online: false });
    this.abort.abort();
    await Promise.allSettled([this.drainPromise, this.changePromise, ...this.memoryJobs.values()].filter((job): job is Promise<void> => !!job));
    this.listeners.clear();
  }

  /** 等待当前回复队列执行和后台记忆整理全部结束。 */
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
  /** 合并并发探测，模型恢复后继续回复与尚未完成的记忆整理。 */
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
