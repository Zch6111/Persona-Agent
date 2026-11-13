import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { Conversation } from '../src/application/conversation/model.js';
import type { MemoryEntry } from '../src/application/memory/model.js';
import type { ModelInput } from '../src/application/inference/model.js';
import type { RuntimeSettings } from '../src/application/conversation/model.js';
import { MemoryService } from '../src/application/memory/usecase.js';
import type { LanguageModel } from '../src/application/inference/usecase.js';
import { FilePromptRepository } from '../src/adapter/persona/db.js';
import { SqliteDatabase } from '../src/adapter/platform/database.js';
import { SqliteConversationRepository } from '../src/adapter/conversation/db.js';
import { SqliteMemoryRepository } from '../src/adapter/memory/db.js';
const settings: RuntimeSettings = {
  scope: { userId: 'reader', characterId: 'companion' },
  maxHistoryMessages: 20,
  maxContextChars: 20_000,
  maxHistoryChars: 8_000,
  maxMemoryChars: 4_000,
  maxReferenceChars: 4_000,
  maxInputChars: 4_000,
  maxOutputTokens: 1_000,
  memoryBatchSize: 2,
};

class Extractor implements LanguageModel {
  readonly inputs: ModelInput[] = [];
  constructor(private readonly outputs: unknown[]) {}
  async generateStructured(input: ModelInput): Promise<unknown> {
    this.inputs.push(input);
    if (!this.outputs.length) throw new Error('不应对已整理的消息再次调用提取模型。');
    return this.outputs.shift();
  }
  async generateText(): Promise<string> { throw new Error('记忆整理不生成聊天回复。'); }
  async isAvailable(): Promise<boolean> { return true; }
}

function repositories(database: SqliteDatabase) {
  return { conversations: new SqliteConversationRepository(database), memories: new SqliteMemoryRepository(database) };
}

function memoryService(database: SqliteDatabase, model: LanguageModel, overrides: Partial<RuntimeSettings> = {}) {
  return new MemoryService({
    ...repositories(database), model, settings: { ...settings, ...overrides },
    prompts: new FilePromptRepository(fileURLToPath(new URL('../assets/prompts/', import.meta.url))),
  });
}

function memory(conversation: Conversation, id: string, content: string, messageId: string): MemoryEntry {
  return { id, userId: conversation.userId, characterId: conversation.characterId, content, kind: 'user_statement', sourceMessages: [{ conversationId: conversation.id, messageId }], supersedes: [], createdAt: '2026-01-01T00:00:00Z' };
}

test('extracted inference retains its type and real-message provenance through persistence and recall', async () => {
  const db = new SqliteDatabase(':memory:');
  try {
    const { conversations, memories } = repositories(db);
    const conversation = await conversations.getOrCreate(settings.scope);
    await conversations.importMessages(conversation.id, [
      { id: 'm1', role: 'user', text: '我可能更喜欢安静的地方。', createdAt: '2026-01-01T00:00:00Z' },
      { id: 'm2', role: 'assistant', text: '那就找个安静的角落坐一会儿吧。', createdAt: '2026-01-01T00:00:01Z' },
    ]);
    const extractor = new Extractor([{ memories: [{ content: '用户可能偏好安静的场所，尚未明确确认。', kind: 'inference', sourceMessageIds: ['m1'], supersedes: [] }] }]);
    const service = memoryService(db, extractor);
    await service.consolidate(conversation.id);
    const recalled = await service.recall(settings.scope, '安静');
    assert.equal(recalled.length, 1);
    assert.equal(recalled[0]!.kind, 'inference');
    assert.deepEqual(recalled[0]!.sourceMessages, [{ conversationId: conversation.id, messageId: 'm1' }]);
    assert.equal(await memories.getCheckpoint(conversation.id), 2);
    assert.equal((await conversations.listMessages(conversation.id)).length, 2);
  } finally { db.close(); }
});

test('a source outside the extraction batch rejects the entire result without advancing progress', async () => {
  const db = new SqliteDatabase(':memory:');
  try {
    const { conversations, memories } = repositories(db);
    const conversation = await conversations.getOrCreate(settings.scope);
    await conversations.importMessages(conversation.id, [
      { id: 'm1', role: 'user', text: '我喜欢热茶。', createdAt: '2026-01-01T00:00:00Z' },
      { id: 'm2', role: 'assistant', text: '记住了。', createdAt: '2026-01-01T00:00:01Z' },
      { id: 'future-message', role: 'user', text: '我明天去海边。', createdAt: '2026-01-01T00:00:02Z' },
    ]);
    const extractor = new Extractor([{ memories: [
      { content: '用户说喜欢热茶。', kind: 'user_statement', sourceMessageIds: ['m1'], supersedes: [] },
      { content: '用户计划去海边。', kind: 'user_statement', sourceMessageIds: ['future-message'], supersedes: [] },
    ] }]);
    await assert.rejects(memoryService(db, extractor).consolidate(conversation.id), /本批以外/);
    assert.equal(await memories.getCheckpoint(conversation.id), 0);
    assert.deepEqual(await memories.list(settings.scope), []);
    assert.equal((await conversations.listMessages(conversation.id)).length, 3);
  } finally { db.close(); }
});

test('fabricated reference IDs cannot become memory sources', async () => {
  const db = new SqliteDatabase(':memory:');
  try {
    const { conversations, memories } = repositories(db);
    const conversation = await conversations.getOrCreate(settings.scope);
    await conversations.importMessages(conversation.id, [{ id: 'm1', role: 'user', text: '你好。', createdAt: '2026-01-01T00:00:00Z' }]);
    const extractor = new Extractor([{ memories: [{ content: '我们曾在原作场景共同冒险。', kind: 'interaction', sourceMessageIds: ['reference-scene-id'], supersedes: [] }] }]);
    await assert.rejects(memoryService(db, extractor).consolidate(conversation.id), /本批以外/);
    assert.deepEqual(await memories.list(settings.scope), []);
    assert.equal(await memories.getCheckpoint(conversation.id), 0);
  } finally { db.close(); }
});

test('revision can replace a memory of the same user and character while preserving its source', async () => {
  const db = new SqliteDatabase(':memory:');
  try {
    const { conversations, memories } = repositories(db);
    const conversation = await conversations.getOrCreate(settings.scope);
    await conversations.importMessages(conversation.id, [{ id: 'old-source', role: 'user', text: '我喜欢咖啡。', createdAt: '2026-01-01T00:00:00Z' }]);
    await memories.applyBatch(settings.scope, [memory(conversation, 'old-preference', '用户说喜欢咖啡。', 'old-source')], { conversationId: conversation.id, throughSequence: 1 });
    await conversations.importMessages(conversation.id, [{ id: 'new-source', role: 'user', text: '现在我不喝咖啡了，更喜欢热茶。', createdAt: '2026-01-02T00:00:00Z' }]);
    const extractor = new Extractor([{ memories: [{ content: '用户表示现在不喝咖啡，改为喜欢热茶。', kind: 'user_statement', sourceMessageIds: ['new-source'], supersedes: ['old-preference'] }] }]);
    await memoryService(db, extractor).consolidate(conversation.id);
    const active = await memories.list(settings.scope);
    assert.equal(active.length, 1);
    assert.deepEqual(active[0]!.supersedes, ['old-preference']);
    assert.deepEqual(active[0]!.sourceMessages, [{ conversationId: conversation.id, messageId: 'new-source' }]);
    assert.equal((await memories.search(settings.scope, '热茶', 10)).length, 1);
    assert.equal(await memories.getCheckpoint(conversation.id), 2);
  } finally { db.close(); }
});

test('an extraction cannot supersede another user or another character memory', async () => {
  const db = new SqliteDatabase(':memory:');
  try {
    const { conversations, memories } = repositories(db);
    const own = await conversations.getOrCreate(settings.scope);
    await conversations.importMessages(own.id, [{ id: 'own-source', role: 'user', text: '我喜欢热茶。', createdAt: '2026-01-01T00:00:00Z' }]);
    for (const [index, foreignScope] of [
      { userId: 'other-reader', characterId: settings.scope.characterId },
      { userId: settings.scope.userId, characterId: 'other-companion' },
    ].entries()) {
      const foreign = await conversations.getOrCreate(foreignScope);
      const sourceId = `foreign-source-${index}`;
      const memoryId = `foreign-memory-${index}`;
      await conversations.importMessages(foreign.id, [{ id: sourceId, role: 'user', text: '我喜欢咖啡。', createdAt: '2026-01-01T00:00:00Z' }]);
      await memories.applyBatch(foreignScope, [memory(foreign, memoryId, '用户说喜欢咖啡。', sourceId)], { conversationId: foreign.id, throughSequence: 1 });
      const extractor = new Extractor([{ memories: [{ content: '用户改为喜欢热茶。', kind: 'user_statement', sourceMessageIds: ['own-source'], supersedes: [memoryId] }] }]);
      await assert.rejects(memoryService(db, extractor).consolidate(own.id), /修正目标不存在/);
      assert.equal(await memories.getCheckpoint(own.id), 0);
      assert.equal((await memories.list(foreignScope))[0]!.id, memoryId);
    }
    assert.deepEqual(await memories.list(settings.scope), []);
  } finally { db.close(); }
});

test('restart resumes after the persisted checkpoint and does not extract old messages again', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'persona-memory-checkpoint-'));
  const file = join(directory, 'agent.sqlite');
  let db = new SqliteDatabase(file);
  try {
    const initial = repositories(db);
    const conversation = await initial.conversations.getOrCreate(settings.scope);
    await initial.conversations.importMessages(conversation.id, [{ id: 'm1', role: 'user', text: '我喜欢热茶。', createdAt: '2026-01-01T00:00:00Z' }]);
    await memoryService(db, new Extractor([{ memories: [{ content: '用户说喜欢热茶。', kind: 'user_statement', sourceMessageIds: ['m1'], supersedes: [] }] }])).consolidate(conversation.id);
    db.close();
    db = new SqliteDatabase(file);
    const reopened = repositories(db);
    const extractor = new Extractor([]);
    const service = memoryService(db, extractor);
    await service.consolidate(conversation.id);
    assert.equal(extractor.inputs.length, 0);
    assert.equal((await reopened.memories.list(settings.scope)).length, 1);
    assert.equal(await reopened.memories.getCheckpoint(conversation.id), 1);
    await reopened.conversations.importMessages(conversation.id, [{ id: 'm2', role: 'user', text: '今天只是打个招呼。', createdAt: '2026-01-02T00:00:00Z' }]);
    const next = new Extractor([{ memories: [] }]);
    await memoryService(db, next).consolidate(conversation.id);
    assert.equal(next.inputs.length, 1);
    const submitted = JSON.parse(next.inputs[0]!.messages[0]!.content) as { messages: { id: string }[] };
    assert.deepEqual(submitted.messages.map(message => message.id), ['m2']);
    assert.equal(await reopened.memories.getCheckpoint(conversation.id), 2);
    assert.equal((await reopened.memories.list(settings.scope)).length, 1);
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a message exceeding the memory context budget is preserved without advancing extraction progress', async () => {
  const db = new SqliteDatabase(':memory:');
  try {
    const { conversations, memories } = repositories(db);
    const conversation = await conversations.getOrCreate(settings.scope);
    const text = '这是一条需要完整保留的长消息。'.repeat(1_000);
    await conversations.importMessages(conversation.id, [{ id: 'large-message', role: 'user', text, createdAt: '2026-01-01T00:00:00Z' }]);
    const extractor = new Extractor([]);
    await assert.rejects(memoryService(db, extractor, { maxContextChars: 2_000 }).consolidate(conversation.id), /预算|上下文/);
    assert.equal(extractor.inputs.length, 0);
    assert.equal(await memories.getCheckpoint(conversation.id), 0);
    assert.equal((await conversations.getMessage({ conversationId: conversation.id, messageId: 'large-message' }))!.text, text);
  } finally { db.close(); }
});

test('memory extraction waits for pending replies before crossing their user message', async () => {
  const db = new SqliteDatabase(':memory:');
  try {
    const { conversations, memories } = repositories(db);
    const conversation = await conversations.getOrCreate(settings.scope);
    await conversations.importMessages(conversation.id, [{ id: 'past-message', role: 'user', text: '我喜欢热茶。', createdAt: '2026-01-01T00:00:00Z' }]);
    const pending = await conversations.acceptUserMessage({ conversationId: conversation.id, id: 'pending-message', text: '我明天去海边。', createdAt: '2026-01-02T00:00:00Z' });
    const first = new Extractor([{ memories: [] }]);
    await memoryService(db, first).consolidate(conversation.id);
    const submitted = JSON.parse(first.inputs[0]!.messages[0]!.content) as { messages: { id: string }[] };
    assert.deepEqual(submitted.messages.map(message => message.id), ['past-message']);
    assert.equal(await memories.getCheckpoint(conversation.id), 1);
    await conversations.failTask(pending.task.id, '本轮回复失败');
    await memoryService(db, new Extractor([{ memories: [] }])).consolidate(conversation.id);
    assert.equal(await memories.getCheckpoint(conversation.id), 2);
  } finally { db.close(); }
});

test('interleaved message storage retains reply links in memory extraction input', async () => {
  const db = new SqliteDatabase(':memory:');
  try {
    const { conversations } = repositories(db);
    const conversation = await conversations.getOrCreate(settings.scope);
    const first = await conversations.acceptUserMessage({ conversationId: conversation.id, id: 'u1', text: '我喜欢热茶。', createdAt: '2026-01-01T00:00:00Z' });
    const second = await conversations.acceptUserMessage({ conversationId: conversation.id, id: 'u2', text: '明天会下雨吗？', createdAt: '2026-01-01T00:00:01Z' });
    await conversations.markTaskRunning(first.task.id);
    await conversations.completeReply(first.task.id, { id: 'r1', text: '我会记得你的口味。', createdAt: '2026-01-01T00:00:02Z' });
    await conversations.markTaskRunning(second.task.id);
    await conversations.completeReply(second.task.id, { id: 'r2', text: '我现在查不到天气。', createdAt: '2026-01-01T00:00:03Z' });
    const extractor = new Extractor([{ memories: [] }]);
    await memoryService(db, extractor, { memoryBatchSize: 4 }).consolidate(conversation.id);
    const submitted = JSON.parse(extractor.inputs[0]!.messages[0]!.content) as { messages: { id: string; replyToMessageId?: string }[] };
    assert.equal(submitted.messages.find(message => message.id === 'r1')!.replyToMessageId, 'u1');
    assert.equal(submitted.messages.find(message => message.id === 'r2')!.replyToMessageId, 'u2');
  } finally { db.close(); }
});
