/** SQLite 记忆仓库：来源外键、归属校验、修正关系、关键词检索和检查点事务。 */
import { type MemoryScope } from '../../application/conversation/model.js';
import { validateMemoryEntry, type MemoryEntry, type MemoryCheckpoint } from '../../application/memory/model.js';
import { type MemoryRepository } from '../../application/memory/repository.js';
import { scoreText, searchTerms } from '../platform/search.js';
import { type SqliteDatabase } from '../platform/database.js';

type Row = Record<string, unknown>;
function equivalent(left: MemoryEntry, right: MemoryEntry): boolean {
  const normalized = (entry: MemoryEntry) => JSON.stringify({
    id: entry.id, userId: entry.userId, characterId: entry.characterId, content: entry.content,
    kind: entry.kind, createdAt: entry.createdAt, supersedes: [...new Set(entry.supersedes)].sort(),
    sources: [...new Set(entry.sourceMessages.map(source => JSON.stringify([source.conversationId, source.messageId])))].sort(),
  });
  return normalized(left) === normalized(right);
}

export class SqliteMemoryRepository implements MemoryRepository {
  constructor(private readonly database: SqliteDatabase) {}
  private get db() { return this.database.connection; }

  async search(scope: MemoryScope, query: string, limit: number): Promise<MemoryEntry[]> {
    const entries = await this.list(scope);
    const terms = searchTerms(query);
    if (!terms.length) return query.trim() ? [] : entries.slice(0, limit);
    return entries.map(entry => ({ entry, score: scoreText(entry.content, terms) }))
      .filter(item => item.score > 0)
      .sort((left, right) => right.score - left.score || right.entry.createdAt.localeCompare(left.entry.createdAt))
      .slice(0, limit).map(item => item.entry);
  }

  async list(scope: MemoryScope): Promise<MemoryEntry[]> {
    return this.db.prepare('SELECT * FROM memories WHERE user_id = ? AND character_id = ? AND superseded_by IS NULL ORDER BY created_at DESC, id').all(scope.userId, scope.characterId).map(row => this.toEntry(row));
  }

  async getCheckpoint(conversationId: string): Promise<number> {
    return this.checkpoint(conversationId);
  }

  async applyBatch(scope: MemoryScope, entries: MemoryEntry[], checkpoint: MemoryCheckpoint): Promise<void> {
    this.database.transaction(() => {
      const owner = this.db.prepare('SELECT user_id, character_id FROM conversations WHERE id = ?').get(checkpoint.conversationId);
      if (!owner || owner.user_id !== scope.userId || owner.character_id !== scope.characterId) throw new Error('记忆整理进度的对话归属不匹配。');
      const latest = Number(this.db.prepare('SELECT COALESCE(MAX(sequence), 0) AS sequence FROM messages WHERE conversation_id = ?').get(checkpoint.conversationId)!.sequence);
      if (!Number.isInteger(checkpoint.throughSequence) || checkpoint.throughSequence < this.checkpoint(checkpoint.conversationId) || checkpoint.throughSequence > latest) throw new Error('记忆整理进度不正确。');
      const newIds = new Set(entries.map(entry => entry.id));
      if (newIds.size !== entries.length) throw new Error('记忆 ID 重复。');
      for (const entry of entries) {
        validateMemoryEntry(entry, scope);
        const existing = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(entry.id);
        if (existing && !equivalent(this.toEntry(existing), entry)) throw new Error('记忆 ID 已用于其他内容。');
        for (const source of entry.sourceMessages) {
          const row = this.db.prepare(`SELECT c.user_id, c.character_id FROM messages m
            JOIN conversations c ON c.id = m.conversation_id
            WHERE m.conversation_id = ? AND m.id = ?`).get(source.conversationId, source.messageId);
          if (!row || row.user_id !== scope.userId || row.character_id !== scope.characterId) throw new Error('记忆来源消息不存在或不属于当前用户与角色。');
        }
        for (const previousId of entry.supersedes) {
          if (newIds.has(previousId)) throw new Error('记忆修正必须引用此前保存的记忆。');
          const previous = this.db.prepare('SELECT user_id, character_id, superseded_by FROM memories WHERE id = ?').get(previousId);
          if (!previous || previous.user_id !== scope.userId || previous.character_id !== scope.characterId || (previous.superseded_by && previous.superseded_by !== entry.id)) throw new Error('待修正的记忆不存在、归属不匹配或已被修正。');
        }
        if (!existing) {
          this.db.prepare('INSERT INTO memories (id, user_id, character_id, content, kind, supersedes_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(entry.id, entry.userId, entry.characterId, entry.content, entry.kind, JSON.stringify(entry.supersedes), entry.createdAt);
          const insertSource = this.db.prepare('INSERT INTO memory_sources (memory_id, conversation_id, message_id) VALUES (?, ?, ?)');
          const seen = new Set<string>();
          for (const source of entry.sourceMessages) {
            const key = JSON.stringify([source.conversationId, source.messageId]);
            if (!seen.has(key)) insertSource.run(entry.id, source.conversationId, source.messageId);
            seen.add(key);
          }
        }
        for (const previousId of entry.supersedes) this.db.prepare('UPDATE memories SET superseded_by = ? WHERE id = ?').run(entry.id, previousId);
      }
      this.db.prepare('INSERT INTO memory_checkpoints (conversation_id, through_sequence) VALUES (?, ?) ON CONFLICT (conversation_id) DO UPDATE SET through_sequence = excluded.through_sequence').run(checkpoint.conversationId, checkpoint.throughSequence);
    });
  }

  private checkpoint(conversationId: string): number {
    const row = this.db.prepare('SELECT through_sequence FROM memory_checkpoints WHERE conversation_id = ?').get(conversationId);
    return Number(row?.through_sequence ?? 0);
  }

  private toEntry(row: Row): MemoryEntry {
    const sourceMessages = this.db.prepare('SELECT conversation_id, message_id FROM memory_sources WHERE memory_id = ? ORDER BY conversation_id, message_id').all(String(row.id)).map(source => ({ conversationId: String(source.conversation_id), messageId: String(source.message_id) }));
    return { id: String(row.id), userId: String(row.user_id), characterId: String(row.character_id), content: String(row.content), kind: row.kind as MemoryEntry['kind'], supersedes: JSON.parse(String(row.supersedes_json)) as string[], sourceMessages, createdAt: String(row.created_at), ...(row.superseded_by ? { supersededBy: String(row.superseded_by) } : {}) };
  }
}
