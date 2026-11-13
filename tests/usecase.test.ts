import assert from 'node:assert/strict';
import { mkdtemp, rm, cp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { loadConfig, projectRoot } from '../src/adapter/platform/config.js';
import { SqliteDatabase } from '../src/adapter/platform/database.js';
import { SqliteConversationRepository } from '../src/adapter/conversation/db.js';
import { SqliteMemoryRepository } from '../src/adapter/memory/db.js';
import { JsonCharacterRepository, JsonReferenceRepository, FilePromptRepository } from '../src/adapter/persona/db.js';
import { FileModelSelectionRepository } from '../src/adapter/inference/db.js';
import { InMemoryInspectionRepository } from '../src/adapter/inspection/db.js';
import { ChatService, ContextBuilder, HistoryService, AgentRuntime } from '../src/application/conversation/usecase.js';
import { MemoryService } from '../src/application/memory/usecase.js';
import { PersonaService } from '../src/application/persona/usecase.js';
import { ModelRouter, type LanguageModel } from '../src/application/inference/usecase.js';
import type { ModelInput } from '../src/application/inference/model.js';
import { InspectionService } from '../src/application/inspection/usecase.js';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

class ScriptModel implements LanguageModel {
  available = true;
  replies: ModelInput[] = [];
  onReply = async (_input: ModelInput): Promise<string> => `回复${this.replies.length}`;
  onMemory = async (_input: ModelInput): Promise<unknown> => ({ memories: [] });
  async generateText(input: ModelInput) { this.replies.push(structuredClone({ ...input, signal: undefined })); return this.onReply(input); }
  generateStructured(input: ModelInput) { return this.onMemory(input); }
  async isAvailable() { return this.available; }
}

async function directory(t: TestContext) {
  const path = await mkdtemp(join(tmpdir(), 'persona-usecases-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

/** Real repositories and usecases; only model output and timer triggering are controlled. */
async function harness(path: string, local = new ScriptModel(), remote = new ScriptModel()) {
  const config = await loadConfig(projectRoot, {});
  const database = new SqliteDatabase(join(path, 'agent.sqlite'));
  const conversations = new SqliteConversationRepository(database);
  const memories = new SqliteMemoryRepository(database);
  const persona = new PersonaService({
    characters: new JsonCharacterRepository(join(projectRoot, 'assets/characters')),
    references: new JsonReferenceRepository(join(projectRoot, 'assets/references')),
    prompts: new FilePromptRepository(join(projectRoot, 'assets/prompts')),
  });
  const model = new ModelRouter({ local, deepseek: remote }, new FileModelSelectionRepository(join(path, 'selection.json')));
  await model.initialize();
  const inspection = new InspectionService(new InMemoryInspectionRepository());
  const memory = new MemoryService({ conversations, memories, model, prompts: { get: name => persona.getPrompt(name) }, settings: config.settings, inspection });
  const context = new ContextBuilder({ persona, conversations, memories: memory, settings: config.settings });
  const chat = new ChatService({ conversations, context, model, settings: config.settings });
  const history = new HistoryService(conversations);
  let poll: (() => void) | undefined;
  const runtime = new AgentRuntime({ chat, memory, conversations, settings: config.settings, scheduler: {
    repeat(operation) { poll = operation; return () => { poll = undefined; }; },
  } });
  await persona.validateAssets(config.settings.scope.characterId);
  await runtime.start();
  let closed = false;
  return { local, remote, model, runtime, conversations, memories, inspection, history,
    get polling() { return !!poll; },
    async close() { if (!closed) { closed = true; await runtime.stop(); database.close(); } },
  };
}

test('refactored usecases serialize queued replies, preserve causal context, deduplicate and restore history', async t => {
  const path = await directory(t);
  const app = await harness(path); t.after(() => app.close());
  const conversation = await app.runtime.getConversation();
  const started = deferred(); const release = deferred();
  app.local.onReply = async () => { if (app.local.replies.length === 1) { started.resolve(); await release.promise; } return `回复${app.local.replies.length}`; };
  await app.runtime.acceptMessage(conversation.id, 'first', '排队请求甲');
  await started.promise;
  await app.runtime.acceptMessage(conversation.id, 'second', '未来排队请求乙');
  release.resolve();
  await app.runtime.waitForIdle();
  assert.deepEqual(app.local.replies[0]!.messages.map(item => item.content), ['排队请求甲']);
  assert.deepEqual(app.local.replies[1]!.messages.map(item => item.content), ['排队请求甲', '回复1', '未来排队请求乙']);
  assert(app.local.replies[0]!.instructions.includes('达妮娅'));
  assert(app.local.replies[0]!.instructions.includes('原作与表达参考'));
  await app.runtime.acceptMessage(conversation.id, 'first', '排队请求甲');
  await app.runtime.waitForIdle();
  assert.equal(app.local.replies.length, 2);
  const history = await app.history.readPage(conversation.id, { afterSequence: 0 });
  assert.equal(history.length, 4);
  assert.deepEqual(history.map(item => item.sequence), [1, 2, 3, 4]);
  assert.equal(app.polling, true);
  await app.close(); assert.equal(app.polling, false);
  const restarted = await harness(path); t.after(() => restarted.close());
  await restarted.runtime.waitForIdle();
  assert.deepEqual(await restarted.history.readPage(conversation.id, { afterSequence: 0 }), history);
  assert.equal(restarted.local.replies.length, 0);
});

test('switching waits for current reply, persists selection and keeps sourced memory across restart', async t => {
  const path = await directory(t);
  const app = await harness(path); t.after(() => app.close());
  const conversation = await app.runtime.getConversation();
  const started = deferred(); const release = deferred();
  app.local.onReply = async () => { started.resolve(); await release.promise; return '记住了。'; };
  app.local.onMemory = async input => {
    const messages = JSON.parse(input.messages[0]!.content).messages as { id: string; role: string }[];
    return { memories: [{ content: '用户喜欢桂花茶。', kind: 'user_statement', sourceMessageIds: [messages.find(item => item.role === 'user')!.id], supersedes: [] }] };
  };
  app.remote.onMemory = app.local.onMemory;
  await app.runtime.acceptMessage(conversation.id, 'tea', '我喜欢桂花茶。');
  await started.promise;
  const switching = app.runtime.changeModel(() => app.model.select('deepseek'));
  assert.equal(app.runtime.online, false);
  assert.equal(app.model.getSettings().provider, 'local');
  release.resolve(); await switching; await app.runtime.waitForIdle();
  assert.equal(app.model.getSettings().provider, 'deepseek');
  assert.equal(app.runtime.online, true);
  await app.runtime.refreshAvailability(); await app.runtime.waitForIdle();
  assert.equal((await app.memories.list(conversation))[0]!.sourceMessages[0]!.messageId, 'tea');
  const observed = await app.inspection.inspect(conversation, app);
  assert.equal(observed.memory.pendingMessages, 0);
  assert(observed.memory.sources.some(source => source?.id === 'tea'));
  await app.close();
  const restarted = await harness(path); t.after(() => restarted.close());
  await restarted.runtime.waitForIdle();
  assert.equal(restarted.model.getSettings().provider, 'deepseek');
  assert.equal((await restarted.runtime.getConversation()).id, conversation.id);
  assert.equal((await restarted.memories.list(conversation)).length, 1);
  restarted.local.available = false;
  await assert.rejects(() => restarted.runtime.changeModel(() => restarted.model.select('local')), /不可用/);
  assert.equal(restarted.model.getSettings().provider, 'deepseek');
  await restarted.runtime.acceptMessage(conversation.id, 'next', '我喜欢喝什么茶？');
  await restarted.runtime.waitForIdle();
  assert.equal(restarted.remote.replies.length, 1);
  assert(restarted.remote.replies[0]!.instructions.includes('用户喜欢桂花茶'));
});

test('switching cannot replace the provider while an existing memory batch is in flight', async t => {
  const path = await directory(t);
  const app = await harness(path); t.after(() => app.close());
  const started = deferred(); const release = deferred();
  app.local.onMemory = async () => { started.resolve(); await release.promise; return { memories: [] }; };
  const conversation = await app.runtime.getConversation();
  await app.runtime.acceptMessage(conversation.id, 'before-switch', '先整理这条消息');
  await started.promise;
  assert.equal(app.inspection.snapshot().memory.state, 'processing');
  const switching = app.runtime.changeModel(() => app.model.select('deepseek'));
  assert.equal(app.model.getSettings().provider, 'local');
  assert.equal(app.runtime.online, false);
  release.resolve(); await switching; await app.runtime.waitForIdle();
  assert.equal(app.model.getSettings().provider, 'deepseek');
  assert.equal(app.inspection.snapshot().memory.state, 'idle');
  assert.equal(await app.memories.getCheckpoint(conversation.id), 2);
});

test('interrupted generation recovers its task without duplicating saved user messages', async t => {
  const path = await directory(t);
  const app = await harness(path); t.after(() => app.close());
  const conversation = await app.runtime.getConversation();
  const started = deferred();
  app.local.onReply = input => new Promise((_resolve, reject) => {
    input.signal!.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
    started.resolve();
  });
  await app.runtime.acceptMessage(conversation.id, 'interrupted', '中断后继续');
  await started.promise; await app.close();
  const restarted = await harness(path); t.after(() => restarted.close());
  await restarted.runtime.waitForIdle();
  const messages = await restarted.history.readPage(conversation.id, { afterSequence: 0 });
  assert.equal(messages.length, 2);
  assert.equal(messages[0]!.id, 'interrupted');
  assert.equal(messages[1]!.replyToMessageId, 'interrupted');
  assert.equal(restarted.local.replies.length, 1);
});

test('inspection keeps only 20 actual calls, isolates snapshots, tracks failures and resets per process', () => {
  const inspection = new InspectionService(new InMemoryInspectionRepository());
  const payload = { model: 'example', messages: [{ content: 'original' }] };
  const first = inspection.begin('reply', payload); payload.messages[0]!.content = 'mutated'; first.complete('answer');
  assert.equal((inspection.snapshot().requests[0]!.payload.messages as { content: string }[])[0]!.content, 'original');
  const snapshot = inspection.snapshot(); snapshot.requests.length = 0;
  assert.equal(inspection.snapshot().requests.length, 1);
  for (let index = 0; index < 20; index++) inspection.begin('memory', { index }).fail();
  assert.equal(inspection.snapshot().requests.length, 20);
  assert(inspection.snapshot().requests.every(item => item.status === 'failed'));
  inspection.memoryStarted(); assert.equal(inspection.snapshot().memory.state, 'processing');
  inspection.memoryFailed(); assert.equal(inspection.snapshot().memory.state, 'failed');
  inspection.memoryUpdated([]); assert.equal(inspection.snapshot().memory.state, 'idle');
  assert.deepEqual(new InspectionService(new InMemoryInspectionRepository()).snapshot().requests, []);
});

test('persona usecase reloads edited role data and prompts without changing stable identity', async t => {
  const path = await directory(t);
  await cp(join(projectRoot, 'assets'), path, { recursive: true });
  const persona = new PersonaService({ characters: new JsonCharacterRepository(join(path, 'characters')), references: new JsonReferenceRepository(join(path, 'references')), prompts: new FilePromptRepository(join(path, 'prompts')) });
  const before = await persona.getCharacter('dania');
  const file = join(path, 'characters/dania.json');
  const raw = JSON.parse(await readFile(file, 'utf8')); raw.background = '更新后的背景';
  await writeFile(file, JSON.stringify(raw));
  await writeFile(join(path, 'prompts/reply.md'), '新的回复模板');
  assert.equal((await persona.getCharacter('dania')).background, '更新后的背景');
  assert.equal((await persona.getCharacter('dania')).id, before.id);
  assert.equal(await persona.getPrompt('reply'), '新的回复模板');
  assert((await persona.selectReferences('dania', '你好')).length > 0);
});
