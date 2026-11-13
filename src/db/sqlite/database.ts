import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Owns SQLite connections and schema versions; repositories own SQL operations. */
export class SqliteDatabase {
  readonly connection: DatabaseSync;

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.connection = new DatabaseSync(file);
    this.connection.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    if (file !== ':memory:') this.connection.exec('PRAGMA journal_mode = WAL;');
    const row = this.connection.prepare('PRAGMA user_version').get() as { user_version: number };
    if (row.user_version > 1) {
      this.connection.close();
      throw new Error('数据库版本高于当前程序支持的版本。');
    }
    if (row.user_version === 0) this.migrate();
  }

  transaction<T>(operation: () => T): T {
    this.connection.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.connection.exec('COMMIT');
      return result;
    } catch (error) {
      this.connection.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void { this.connection.close(); }

  private migrate(): void {
    this.transaction(() => this.connection.exec(`
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        character_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (user_id, character_id)
      );
      CREATE TABLE messages (
        conversation_id TEXT NOT NULL REFERENCES conversations(id),
        id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        sequence INTEGER NOT NULL CHECK (sequence > 0),
        reply_to_message_id TEXT,
        PRIMARY KEY (conversation_id, id),
        UNIQUE (conversation_id, sequence),
        UNIQUE (conversation_id, reply_to_message_id),
        FOREIGN KEY (conversation_id, reply_to_message_id) REFERENCES messages(conversation_id, id)
      );
      CREATE TABLE reply_tasks (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        input_message_id TEXT NOT NULL,
        input_sequence INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed')),
        reply_message_id TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (conversation_id, input_message_id),
        FOREIGN KEY (conversation_id, input_message_id) REFERENCES messages(conversation_id, id),
        FOREIGN KEY (conversation_id, reply_message_id) REFERENCES messages(conversation_id, id)
      );
      CREATE INDEX reply_tasks_pending ON reply_tasks(status, created_at, input_sequence);
      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        character_id TEXT NOT NULL,
        content TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('user_statement', 'interaction', 'inference')),
        supersedes_json TEXT NOT NULL,
        superseded_by TEXT REFERENCES memories(id),
        created_at TEXT NOT NULL
      );
      CREATE INDEX memories_scope ON memories(user_id, character_id, superseded_by);
      CREATE TABLE memory_sources (
        memory_id TEXT NOT NULL REFERENCES memories(id),
        conversation_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        PRIMARY KEY (memory_id, conversation_id, message_id),
        FOREIGN KEY (conversation_id, message_id) REFERENCES messages(conversation_id, id)
      );
      CREATE TABLE memory_checkpoints (
        conversation_id TEXT PRIMARY KEY REFERENCES conversations(id),
        through_sequence INTEGER NOT NULL CHECK (through_sequence >= 0)
      );
      PRAGMA user_version = 1;
    `));
  }
}
