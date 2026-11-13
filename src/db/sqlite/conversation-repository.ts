import { randomUUID } from 'node:crypto';
import type { Conversation, MemoryScope, Message, MessageRef } from '../../domain/conversation.js';
import { validateMessageText } from '../../domain/conversation.js';
import type { ReplyTask } from '../../service/contracts.js';
import type { ConversationRepository } from '../../service/ports/conversation-repository.js';
import type { SqliteDatabase } from './database.js';

type Row = Record<string, unknown>;
function conversation(row: Row): Conversation {
  return { id: String(row.id), userId: String(row.user_id), characterId: String(row.character_id), createdAt: String(row.created_at) };
}
function message(row: Row): Message {
  return { id: String(row.id), conversationId: String(row.conversation_id), role: row.role as Message['role'], text: String(row.text), createdAt: String(row.created_at), sequence: Number(row.sequence), ...(row.reply_to_message_id ? { replyToMessageId: String(row.reply_to_message_id) } : {}) };
}
function task(row: Row): ReplyTask {
  return { id: String(row.id), conversationId: String(row.conversation_id), inputMessageId: String(row.input_message_id), inputSequence: Number(row.input_sequence), status: row.status as ReplyTask['status'], createdAt: String(row.created_at), ...(row.reply_message_id ? { replyMessageId: String(row.reply_message_id) } : {}), ...(row.error ? { error: String(row.error) } : {}) };
}

export class SqliteConversationRepository implements ConversationRepository {
  constructor(private readonly database: SqliteDatabase) {}
  private get db() { return this.database.connection; }

  async getOrCreate(scope: MemoryScope): Promise<Conversation> {
    if (!scope.userId.trim() || !scope.characterId.trim()) throw new Error('对话归属不能为空。');
    this.db.prepare('INSERT INTO conversations (id, user_id, character_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, character_id) DO NOTHING').run(randomUUID(), scope.userId, scope.characterId, new Date().toISOString());
    return conversation(this.db.prepare('SELECT * FROM conversations WHERE user_id = ? AND character_id = ?').get(scope.userId, scope.characterId)!);
  }

  async getConversation(id: string): Promise<Conversation | undefined> {
    const row = this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
    return row ? conversation(row) : undefined;
  }

  async acceptUserMessage(input: { conversationId: string; id: string; text: string; createdAt: string }): Promise<{ task: ReplyTask; message: Message; inserted: boolean }> {
    validateMessageText(input.text);
    if (!input.id.trim()) throw new Error('消息 ID 不能为空。');
    return this.database.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM messages WHERE conversation_id = ? AND id = ?').get(input.conversationId, input.id);
      if (existing) {
        if (existing.role !== 'user' || existing.text !== input.text) throw new Error('消息 ID 已用于其他内容。');
        const existingTask = this.db.prepare('SELECT * FROM reply_tasks WHERE conversation_id = ? AND input_message_id = ?').get(input.conversationId, input.id);
        if (!existingTask) throw new Error('该消息属于导入历史，不能重新生成回复。');
        return { task: task(existingTask), message: message(existing), inserted: false };
      }
      const sequence = this.lastSequence(input.conversationId) + 1;
      const id = randomUUID();
      this.insertMessage(input.conversationId, { ...input, role: 'user' }, sequence);
      this.db.prepare('INSERT INTO reply_tasks (id, conversation_id, input_message_id, input_sequence, status, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, input.conversationId, input.id, sequence, 'pending', input.createdAt);
      return {
        task: { id, conversationId: input.conversationId, inputMessageId: input.id, inputSequence: sequence, status: 'pending', createdAt: input.createdAt },
        message: { id: input.id, conversationId: input.conversationId, role: 'user', text: input.text, createdAt: input.createdAt, sequence },
        inserted: true,
      };
    });
  }

  async completeReply(taskId: string, reply: { id: string; text: string; createdAt: string }): Promise<Message> {
    validateMessageText(reply.text);
    if (!reply.id.trim()) throw new Error('消息 ID 不能为空。');
    return this.database.transaction(() => {
      const row = this.db.prepare('SELECT * FROM reply_tasks WHERE id = ?').get(taskId);
      if (!row) throw new Error('回复任务不存在。');
      const current = task(row);
      if (current.status === 'completed') {
        const saved = this.db.prepare('SELECT * FROM messages WHERE conversation_id = ? AND id = ?').get(current.conversationId, current.replyMessageId!);
        return message(saved!);
      }
      if (current.status !== 'running') throw new Error('回复任务尚未开始或已经失败。');
      const sequence = this.lastSequence(current.conversationId) + 1;
      this.insertMessage(current.conversationId, { ...reply, role: 'assistant', replyToMessageId: current.inputMessageId }, sequence);
      this.db.prepare('UPDATE reply_tasks SET status = ?, reply_message_id = ?, error = NULL WHERE id = ?').run('completed', reply.id, taskId);
      return { ...reply, conversationId: current.conversationId, role: 'assistant', sequence, replyToMessageId: current.inputMessageId };
    });
  }

  async markTaskRunning(taskId: string): Promise<void> {
    const result = this.db.prepare('UPDATE reply_tasks SET status = ?, error = NULL WHERE id = ? AND status = ?').run('running', taskId, 'pending');
    if (!result.changes) throw new Error('回复任务不可开始。');
  }

  async failTask(taskId: string, error: string): Promise<void> {
    this.db.prepare('UPDATE reply_tasks SET status = ?, error = ? WHERE id = ? AND status IN (?, ?)').run('failed', error, taskId, 'pending', 'running');
  }

  async getTask(taskId: string): Promise<ReplyTask | undefined> {
    const row = this.db.prepare('SELECT * FROM reply_tasks WHERE id = ?').get(taskId);
    return row ? task(row) : undefined;
  }

  async listPendingTasks(): Promise<ReplyTask[]> {
    return this.db.prepare("SELECT * FROM reply_tasks WHERE status = 'pending' ORDER BY conversation_id, input_sequence").all().map(task);
  }

  async recoverRunningTasks(): Promise<void> {
    this.db.prepare("UPDATE reply_tasks SET status = 'pending', error = NULL WHERE status = 'running'").run();
  }

  async listMessages(conversationId: string, options: { afterSequence?: number; throughSequence?: number; limit?: number } = {}): Promise<Message[]> {
    const limit = options.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1) throw new Error('历史消息条数不正确。');
    const through = options.throughSequence ?? Number.MAX_SAFE_INTEGER;
    if (options.afterSequence !== undefined) {
      return this.db.prepare('SELECT * FROM messages WHERE conversation_id = ? AND sequence > ? AND sequence <= ? ORDER BY sequence LIMIT ?').all(conversationId, options.afterSequence, through, limit).map(message);
    }
    return this.db.prepare('SELECT * FROM (SELECT * FROM messages WHERE conversation_id = ? AND sequence <= ? ORDER BY sequence DESC LIMIT ?) ORDER BY sequence').all(conversationId, through, limit).map(message);
  }

  async getMessage(ref: MessageRef): Promise<Message | undefined> {
    const row = this.db.prepare('SELECT * FROM messages WHERE conversation_id = ? AND id = ?').get(ref.conversationId, ref.messageId);
    return row ? message(row) : undefined;
  }

  async listContextMessages(conversationId: string, throughSequence: number, limit: number): Promise<Message[]> {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('上下文消息条数不正确。');
    return this.db.prepare(`
      SELECT * FROM (
        SELECT m.*, COALESCE(input.sequence, m.sequence) AS logical_sequence,
          CASE WHEN m.reply_to_message_id IS NULL THEN 0 ELSE 1 END AS is_reply
        FROM messages m
        LEFT JOIN messages input ON input.conversation_id = m.conversation_id AND input.id = m.reply_to_message_id
        WHERE m.conversation_id = ? AND COALESCE(input.sequence, m.sequence) <= ?
        ORDER BY logical_sequence DESC, is_reply DESC, m.sequence DESC LIMIT ?
      ) ORDER BY logical_sequence, is_reply, sequence
    `).all(conversationId, throughSequence, limit).map(message);
  }

  async getLastSequence(conversationId: string): Promise<number> { return this.lastSequence(conversationId); }

  async getMemoryReadySequence(conversationId: string): Promise<number> {
    const row = this.db.prepare("SELECT MIN(input_sequence) AS sequence FROM reply_tasks WHERE conversation_id = ? AND status IN ('pending', 'running')").get(conversationId)!;
    return row.sequence === null ? this.lastSequence(conversationId) : Number(row.sequence) - 1;
  }

  async importMessages(conversationId: string, messages: { id: string; role: 'user' | 'assistant'; text: string; createdAt: string }[]): Promise<number> {
    return this.database.transaction(() => {
      let sequence = this.lastSequence(conversationId);
      let inserted = 0;
      for (const item of messages) {
        validateMessageText(item.text);
        if (!item.id.trim() || !['user', 'assistant'].includes(item.role)) throw new Error('导入消息格式不正确。');
        const existing = this.db.prepare('SELECT * FROM messages WHERE conversation_id = ? AND id = ?').get(conversationId, item.id);
        if (existing) {
          if (existing.text !== item.text || existing.role !== item.role || existing.created_at !== item.createdAt) throw new Error('导入消息 ID 冲突。');
          continue;
        }
        this.insertMessage(conversationId, item, ++sequence);
        inserted++;
      }
      return inserted;
    });
  }

  private lastSequence(conversationId: string): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(sequence), 0) AS sequence FROM messages WHERE conversation_id = ?').get(conversationId)!;
    return Number(row.sequence);
  }

  private insertMessage(conversationId: string, item: { id: string; role: 'user' | 'assistant'; text: string; createdAt: string; replyToMessageId?: string }, sequence: number): void {
    this.db.prepare('INSERT INTO messages (conversation_id, id, role, text, created_at, sequence, reply_to_message_id) VALUES (?, ?, ?, ?, ?, ?, ?)').run(conversationId, item.id, item.role, item.text, item.createdAt, sequence, item.replyToMessageId ?? null);
  }
}
