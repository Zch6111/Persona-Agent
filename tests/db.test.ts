import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteDatabase } from '../src/db/sqlite/database.js';
import { SqliteConversationRepository } from '../src/db/sqlite/conversation-repository.js';
import { SqliteMemoryRepository } from '../src/db/sqlite/memory-repository.js';
import { JsonReferenceRepository } from '../src/db/files/reference-repository.js';
import { JsonCharacterRepository } from '../src/db/files/character-repository.js';
import { FilePromptRepository } from '../src/db/files/prompt-repository.js';
import type { MemoryEntry } from '../src/domain/memory.js';

const scope = { userId: 'user-a', characterId: 'dania' };
const now = '2026-11-07T00:00:00.000Z';

test('accepted messages and replies persist atomically, deduplicate and survive reopening', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'game-agent-db-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'chat.sqlite');
  let database = new SqliteDatabase(file);
  let conversations = new SqliteConversationRepository(database);
  const owner = await conversations.getOrCreate(scope);
  assert.equal((await conversations.getOrCreate(scope)).id, owner.id);
  const input = { conversationId: owner.id, id: 'input-1', text: '我喜欢无糖饮料', createdAt: now };
  const accepted = await conversations.acceptUserMessage(input);
  assert.equal(accepted.inserted, true);
  const duplicate = await conversations.acceptUserMessage({ ...input, createdAt: '2026-11-08T00:00:00.000Z' });
  assert.equal(duplicate.inserted, false);
  assert.equal(duplicate.task.id, accepted.task.id);
  await assert.rejects(conversations.acceptUserMessage({ ...input, text: '别的内容' }), /ID/);
  await assert.rejects(conversations.completeReply(accepted.task.id, { id: 'output-1', text: '记住了', createdAt: now }), /尚未开始/);
  await conversations.markTaskRunning(accepted.task.id);
  const reply = await conversations.completeReply(accepted.task.id, { id: 'output-1', text: '记住了', createdAt: now });
  assert.equal(reply.replyToMessageId, 'input-1');
  assert.equal((await conversations.completeReply(accepted.task.id, { id: 'unused', text: '另一个回复', createdAt: now })).id, 'output-1');
  assert.equal((await conversations.listMessages(owner.id)).length, 2);
  database.close();
  database = new SqliteDatabase(file);
  t.after(() => database.close());
  conversations = new SqliteConversationRepository(database);
  assert.equal((await conversations.getOrCreate(scope)).id, owner.id);
  assert.equal((await conversations.getTask(accepted.task.id))?.status, 'completed');
  assert.deepEqual((await conversations.listMessages(owner.id)).map(message => message.id), ['input-1', 'output-1']);
});

test('context pairs an earlier reply before a queued input without including later inputs', async t => {
  const database = new SqliteDatabase(':memory:');
  t.after(() => database.close());
  const repository = new SqliteConversationRepository(database);
  const owner = await repository.getOrCreate(scope);
  const first = await repository.acceptUserMessage({ conversationId: owner.id, id: 'one', text: '第一句', createdAt: now });
  const second = await repository.acceptUserMessage({ conversationId: owner.id, id: 'two', text: '第二句', createdAt: '2020-01-01T00:00:00.000Z' });
  await repository.acceptUserMessage({ conversationId: owner.id, id: 'three', text: '第三句', createdAt: now });
  assert.deepEqual((await repository.listPendingTasks()).map(item => item.inputMessageId), ['one', 'two', 'three']);
  await repository.markTaskRunning(first.task.id);
  await repository.completeReply(first.task.id, { id: 'reply-one', text: '回复第一句', createdAt: now });
  assert.deepEqual((await repository.listMessages(owner.id)).map(item => item.id), ['one', 'two', 'three', 'reply-one']);
  assert.deepEqual((await repository.listContextMessages(owner.id, second.message.sequence, 20)).map(item => item.id), ['one', 'reply-one', 'two']);
  assert.deepEqual((await repository.listContextMessages(owner.id, second.message.sequence, 2)).map(item => item.id), ['reply-one', 'two']);
  await repository.markTaskRunning(second.task.id);
  await repository.recoverRunningTasks();
  assert.equal((await repository.getTask(second.task.id))?.status, 'pending');
  assert.deepEqual((await repository.listMessages(owner.id, { afterSequence: 1, throughSequence: 3, limit: 1 })).map(item => item.id), ['two']);
});

test('message imports are atomic and create no pending replies', async t => {
  const database = new SqliteDatabase(':memory:');
  t.after(() => database.close());
  const repository = new SqliteConversationRepository(database);
  const owner = await repository.getOrCreate(scope);
  const items = [
    { id: 'old-user', role: 'user' as const, text: '以前的对话', createdAt: now },
    { id: 'old-assistant', role: 'assistant' as const, text: '以前的回应', createdAt: now },
  ];
  assert.equal(await repository.importMessages(owner.id, items), 2);
  assert.equal(await repository.importMessages(owner.id, items), 0);
  await assert.rejects(repository.importMessages(owner.id, [
    { ...items[0]!, id: 'must-rollback' }, { ...items[0]!, text: '冲突内容' },
  ]), /冲突/);
  assert.equal(await repository.getLastSequence(owner.id), 2);
  assert.deepEqual(await repository.listPendingTasks(), []);
});

test('memory-ready cursor stops before inputs awaiting a reply', async t => {
  const database = new SqliteDatabase(':memory:');
  t.after(() => database.close());
  const repository = new SqliteConversationRepository(database);
  const owner = await repository.getOrCreate(scope);
  const first = await repository.acceptUserMessage({ conversationId: owner.id, id: 'one', text: '第一句', createdAt: now });
  const second = await repository.acceptUserMessage({ conversationId: owner.id, id: 'two', text: '第二句', createdAt: now });
  await repository.markTaskRunning(first.task.id);
  assert.equal(await repository.getMemoryReadySequence(owner.id), 0);
  await repository.completeReply(first.task.id, { id: 'reply-one', text: '第一句回复', createdAt: now });
  assert.equal(await repository.getMemoryReadySequence(owner.id), 1);
  await repository.markTaskRunning(second.task.id);
  await repository.completeReply(second.task.id, { id: 'reply-two', text: '第二句回复', createdAt: now });
  assert.equal(await repository.getMemoryReadySequence(owner.id), 4);
  const third = await repository.acceptUserMessage({ conversationId: owner.id, id: 'three', text: '失败的消息', createdAt: now });
  await repository.failTask(third.task.id, '本次回复失败');
  assert.equal(await repository.getMemoryReadySequence(owner.id), 5);
});

test('memory batches enforce sources and scope, supersede old facts, and advance checkpoints atomically', async t => {
  const database = new SqliteDatabase(':memory:');
  t.after(() => database.close());
  const conversations = new SqliteConversationRepository(database);
  const memories = new SqliteMemoryRepository(database);
  const owner = await conversations.getOrCreate(scope);
  await conversations.importMessages(owner.id, [
    { id: 'first', role: 'user', text: '我喜欢甜饮料', createdAt: now },
    { id: 'second', role: 'user', text: '现在只喝无糖饮料', createdAt: now },
  ]);
  const entry: MemoryEntry = { id: 'memory-one', ...scope, content: '用户喜欢甜饮料', kind: 'user_statement', sourceMessages: [{ conversationId: owner.id, messageId: 'first' }], supersedes: [], createdAt: now };
  await memories.applyBatch(scope, [entry], { conversationId: owner.id, throughSequence: 1 });
  await memories.applyBatch(scope, [entry], { conversationId: owner.id, throughSequence: 1 });
  assert.equal((await memories.list(scope)).length, 1);
  const corrected: MemoryEntry = { ...entry, id: 'memory-two', content: '用户现在只喝无糖饮料', sourceMessages: [{ conversationId: owner.id, messageId: 'second' }], supersedes: ['memory-one'] };
  await memories.applyBatch(scope, [corrected], { conversationId: owner.id, throughSequence: 2 });
  assert.deepEqual((await memories.list(scope)).map(item => item.id), ['memory-two']);
  assert.equal((await memories.search(scope, '无糖饮料', 10))[0]?.id, 'memory-two');
  assert.deepEqual(await memories.search(scope, '火星旅行', 10), []);
  assert.deepEqual(await memories.list({ ...scope, userId: 'someone-else' }), []);
  assert.equal(await memories.getCheckpoint(owner.id), 2);
  const otherScope = { userId: 'user-b', characterId: 'dania' };
  const other = await conversations.getOrCreate(otherScope);
  await conversations.importMessages(other.id, [{ id: 'private', role: 'user', text: '私人信息', createdAt: now }]);
  await assert.rejects(memories.applyBatch(scope, [{ ...entry, id: 'bad-source', sourceMessages: [{ conversationId: other.id, messageId: 'private' }] }], { conversationId: owner.id, throughSequence: 2 }), /来源/);
  await assert.rejects(memories.applyBatch(scope, [{ ...entry, id: 'unknown-source', sourceMessages: [{ conversationId: owner.id, messageId: 'missing' }] }], { conversationId: owner.id, throughSequence: 2 }), /来源/);
  await assert.rejects(memories.applyBatch(otherScope, [{ ...entry, ...otherScope, id: 'wrong-scope', sourceMessages: [{ conversationId: other.id, messageId: 'private' }], supersedes: ['memory-two'] }], { conversationId: other.id, throughSequence: 1 }), /待修正/);
  assert.equal((await memories.list(otherScope)).length, 0);
  assert.equal(await memories.getCheckpoint(other.id), 0);
  await assert.rejects(memories.applyBatch(scope, [], { conversationId: owner.id, throughSequence: 1 }), /进度/);
});

test('file repositories load role assets and preserve complete reference scenes and source metadata', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'game-agent-assets-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'characters'));
  await mkdir(join(directory, 'references'));
  await mkdir(join(directory, 'prompts'));
  await writeFile(join(directory, 'characters', 'dania.json'), JSON.stringify({ id: 'dania', name: '角色甲', version: 1, background: '背景', speakingStyle: '语言习惯', relationship: '关系' }));
  await writeFile(join(directory, 'prompts', 'reply.md'), '直接回复');
  await writeFile(join(directory, 'references', 'dania.json'), JSON.stringify({
    version: 1, targetSpeaker: '角色甲', sources: [{ id: 'source-a', title: '出处', origin: 'user', url: 'https://example.test/source' }],
    excerpts: [
      { id: 'anchor', sourceId: 'source-a', title: '招呼', kind: 'dialogue', anchor: true, turns: [{ speaker: '角色甲', text: '好久不见。' }] },
      { id: 'drink', sourceId: 'source-a', title: '饮料', kind: 'dialogue', era: '初识', relationship: '朋友', context: '一起选饮料', turns: [{ speaker: '访客', text: '无糖饮料怎么样？' }, { speaker: '角色甲', text: '听你的。' }] },
    ],
  }));
  const characters = new JsonCharacterRepository(join(directory, 'characters'));
  assert.equal((await characters.get('dania')).name, '角色甲');
  await assert.rejects(characters.get('../outside'), /ID/);
  assert.equal(await new FilePromptRepository(join(directory, 'prompts')).get('reply'), '直接回复');
  const references = new JsonReferenceRepository(join(directory, 'references'));
  assert.deepEqual((await references.getAnchors('dania')).map(item => item.id), ['anchor']);
  const found = await references.search('dania', '无糖饮料', 2);
  assert.equal(found[0]?.source.url, 'https://example.test/source');
  assert.equal(found[0]?.turns?.length, 2);
  assert.equal(found[0]?.era, '初识');
  assert.deepEqual(await references.search('dania', '不存在的话题', 2), []);
  assert.equal((await references.search('dania', '', 10)).some(item => item.anchor), false);
});
