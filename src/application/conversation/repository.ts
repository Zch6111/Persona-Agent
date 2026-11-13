/** 对话存储契约：保持消息与任务的原子提交、幂等性、历史顺序及恢复语义。 */
import { type Conversation, type MemoryScope, type Message, type MessageRef, type ReplyTask } from './model.js';

export interface ConversationRepository {
  /** 获取或创建用户与角色范围内唯一的对话。 */
  getOrCreate(scope: MemoryScope): Promise<Conversation>;
  /** 按 ID 获取对话；不存在时返回 undefined。 */
  getConversation(id: string): Promise<Conversation | undefined>;
  /** 原子保存消息并创建回复任务；相同 ID 和正文返回原结果，冲突内容必须拒绝。 */
  acceptUserMessage(input: { conversationId: string; id: string; text: string; createdAt: string }): Promise<{ task: ReplyTask; message: Message; inserted: boolean }>;
  /** 原子保存回复并完成任务；重复提交已完成任务返回原回复，成功后才允许推送。 */
  completeReply(taskId: string, reply: { id: string; text: string; createdAt: string }): Promise<Message>;
  /** 仅允许 pending 任务进入 running，防止重复执行。 */
  markTaskRunning(taskId: string): Promise<void>;
  /** 保存可展示的失败原因，不覆盖已完成任务。 */
  failTask(taskId: string, error: string): Promise<void>;
  /** 查询当前持久化状态，生成前确认是否已经完成。 */
  getTask(taskId: string): Promise<ReplyTask | undefined>;
  /** 读取等待执行的任务，保持每个对话的输入顺序。 */
  listPendingTasks(): Promise<ReplyTask[]>;
  /** 将中断进程遗留的 running 任务恢复为 pending；必须持有实例锁。 */
  recoverRunningTasks(): Promise<void>;
  // No afterSequence: latest page, ascending. With afterSequence: next page, ascending.
  /** 读取保存顺序中的历史；无 afterSequence 时取最近一页，返回结果始终升序。 */
  listMessages(conversationId: string, options?: { afterSequence?: number; throughSequence?: number; limit?: number }): Promise<Message[]>;
  // Earlier user messages and their replies, paired before the selected input.
  /** 按用户消息与对应回复组成因果顺序，排除当前输入之后的用户消息。 */
  listContextMessages(conversationId: string, throughSequence: number, limit: number): Promise<Message[]>;
  /** 按对话和消息 ID 查询来源原文。 */
  getMessage(ref: MessageRef): Promise<Message | undefined>;
  /** 返回最后已保存消息的游标，用于建立历史回放快照。 */
  getLastSequence(conversationId: string): Promise<number>;
  /** 返回最早未完成任务输入之前的稳定游标；无待处理任务时取历史末尾。 */
  getMemoryReadySequence(conversationId: string): Promise<number>;
  /** 按给定顺序原子导入历史，不创建回复任务；完全相同的已有记录跳过。 */
  importMessages(conversationId: string, messages: { id: string; role: 'user' | 'assistant'; text: string; createdAt: string }[]): Promise<number>;
}
