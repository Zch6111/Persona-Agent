import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { WebSocket } from 'ws';
import { createApplication } from '../src/bootstrap.js';
import { loadConfig, projectRoot } from '../src/config.js';
import type { ModelInput } from '../src/service/contracts.js';
import type { LanguageModel } from '../src/service/ports/language-model.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

class ScriptModel implements LanguageModel {
  available = true;
  replyInputs: ModelInput[] = [];
  memoryInputs: ModelInput[] = [];
  reply: (input: ModelInput, number: number) => Promise<string> = async (_input, number) => `回复${number}`;
  extract: (input: ModelInput) => Promise<unknown> = async () => ({ memories: [] });
  async generateText(input: ModelInput): Promise<string> {
    this.replyInputs.push({ ...input, messages: input.messages.map(message => ({ ...message })) });
    return this.reply(input, this.replyInputs.length);
  }
  async generateStructured(input: ModelInput): Promise<unknown> { this.memoryInputs.push(input); return this.extract(input); }
  async isAvailable(): Promise<boolean> { return this.available; }
}

test('API switching shares character context and memory, persists selection, and refuses an unavailable target', { timeout: 10_000 }, async t => {
  const config = await configuration(t);
  const local = new ScriptModel(); const remote = new ScriptModel();
  remote.extract = async input => {
    const messages = JSON.parse(input.messages[0]!.content).messages as { id: string; text: string; role: string }[];
    const source = messages.find(item => item.role === 'user' && item.text.includes('桂花茶'));
    return { memories: source ? [{ content: '用户表示喜欢桂花茶。', kind: 'user_statement', sourceMessageIds: [source.id], supersedes: [] }] : [] };
  };
  const app = createApplication(config, { model: local, remoteModel: remote }); t.after(() => app.close());
  const address = await app.start();
  const endpoint = `http://${address.host}:${address.port}/settings/model`;
  const settings = async (provider?: string) => {
    const response = await fetch(endpoint, { method: provider ? 'POST' : 'GET', headers: { Origin: 'http://127.0.0.1:4173' }, ...(provider ? { body: JSON.stringify({ provider }) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await settings('deepseek')).body.provider, 'deepseek');
  const conversation = await app.runtime.getConversation();
  await app.runtime.acceptMessage(conversation.id, 'remote-message', '我喜欢桂花茶。');
  await app.runtime.waitForIdle();
  assert.equal(local.replyInputs.length, 0);
  assert.equal(remote.replyInputs.length, 1);
  assert(remote.replyInputs[0]!.instructions.includes('达妮娅'));
  assert(remote.replyInputs[0]!.instructions.includes('原作与表达参考'));
  assert.equal((await app.memories.list(config.settings.scope)).length, 1);
  local.available = false;
  assert.equal((await settings('local')).status, 400);
  assert.equal((await settings()).body.provider, 'deepseek');
  await app.close();
  const restarted = createApplication(config, { model: local, remoteModel: remote }); t.after(() => restarted.close());
  const next = await restarted.start();
  const saved = await fetch(`http://${next.host}:${next.port}/settings/model`, { headers: { Origin: 'http://127.0.0.1:4173' } }).then(response => response.json());
  assert.equal(saved.provider, 'deepseek');
  assert.equal(restarted.runtime.online, true);
  assert.equal((await restarted.memories.list(config.settings.scope)).length, 1);
  await restarted.runtime.acceptMessage(conversation.id, 'remote-recall', '我喜欢喝什么茶？');
  await restarted.runtime.waitForIdle();
  assert(remote.replyInputs.at(-1)!.instructions.includes('用户表示喜欢桂花茶'));
});

async function configuration(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'game-agent-integration-'));
  const config = await loadConfig(projectRoot, {});
  config.database = join(directory, 'agent.sqlite'); config.port = 0;
  t.after(() => rm(directory, { recursive: true, force: true }));
  return config;
}

async function connect(host: string, port: number) {
  const socket = new WebSocket(`ws://${host}:${port}/ws/chat`, { origin: 'http://127.0.0.1:4173' });
  const frames: Record<string, unknown>[] = [];
  const checks = new Set<() => void>();
  socket.on('message', data => { frames.push(JSON.parse(data.toString()) as Record<string, unknown>); for (const check of checks) check(); });
  await once(socket, 'open');
  const wait = (predicate: (frame: Record<string, unknown>) => boolean) => new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => { checks.delete(check); reject(new Error('Timed out waiting for WebSocket frame')); }, 3_000);
    const check = () => {
      const found = frames.find(predicate);
      if (found) { checks.delete(check); clearTimeout(timer); resolve(found); }
    };
    checks.add(check); check();
  });
  socket.send(JSON.stringify({ type: 'hello', name: '显示名' }));
  await wait(frame => frame.type === 'presence' && frame.online === true);
  return {
    frames, socket, wait,
    send(id: string, text: string) { socket.send(JSON.stringify({ type: 'msg', id, text })); },
    async close() { if (socket.readyState === WebSocket.CLOSED) return; const closed = once(socket, 'close'); socket.close(); await closed; },
  };
}

test('application persists WebSocket chat, serializes queued contexts, and restores the same history after restart', { timeout: 10_000 }, async t => {
  const config = await configuration(t);
  const model = new ScriptModel();
  const firstStarted = deferred<void>(); const releaseFirst = deferred<void>();
  model.reply = async (_input, number) => { if (number === 1) { firstStarted.resolve(); await releaseFirst.promise; } return `回复${number}`; };
  const app = createApplication(config, { model }); t.after(() => app.close());
  const address = await app.start();
  const peer = await connect(address.host, address.port);
  peer.send('user-message-1', '排队请求甲');
  await firstStarted.promise;
  peer.send('user-message-2', '未来排队请求乙');
  await peer.wait(frame => frame.type === 'msg' && frame.id === 'user-message-2');
  const reconnectedDuringReply = await connect(address.host, address.port);
  await reconnectedDuringReply.wait(frame => frame.type === 'typing' && frame.active === true);
  await reconnectedDuringReply.close();
  releaseFirst.resolve();
  await peer.wait(frame => frame.type === 'msg' && frame.text === '回复2');
  await app.runtime.waitForIdle();
  assert.deepEqual(model.replyInputs[0]?.messages.map(item => [item.role, item.content]), [['user', '排队请求甲']]);
  assert.deepEqual(model.replyInputs[1]?.messages.map(item => [item.role, item.content]), [['user', '排队请求甲'], ['assistant', '回复1'], ['user', '未来排队请求乙']]);
  const conversation = await app.runtime.getConversation();
  const stored = await app.history.readPage(conversation.id, { afterSequence: 0, limit: 100 });
  assert.equal(stored.length, 4);
  assert.deepEqual(stored.map(message => message.sequence), [1, 2, 3, 4]);
  assert.deepEqual(stored.filter(message => message.role === 'user').map(message => message.id), ['user-message-1', 'user-message-2']);
  await peer.close(); await app.close();

  const restartedModel = new ScriptModel();
  const restarted = createApplication(config, { model: restartedModel }); t.after(() => restarted.close());
  const restartedAddress = await restarted.start();
  const restoredPeer = await connect(restartedAddress.host, restartedAddress.port);
  const history = restoredPeer.frames.filter(frame => frame.type === 'history').flatMap(frame => frame.messages as Record<string, unknown>[]);
  assert.deepEqual(history.map(message => message.id), stored.map(message => message.id));
  assert.deepEqual(history.map(message => message.text), stored.map(message => message.text));
  await restarted.runtime.waitForIdle();
  assert.equal(restartedModel.replyInputs.length, 0);
  await restoredPeer.close();
});

test('broken event and diagnostic subscribers cannot change persisted reply results', { timeout: 10_000 }, async t => {
  const config = await configuration(t);
  const app = createApplication(config, { model: new ScriptModel(), onWarning: () => { throw new Error('diagnostic unavailable'); } });
  t.after(() => app.close());
  await app.start();
  app.runtime.subscribe(() => { throw new Error('connection unavailable'); });
  const conversation = await app.runtime.getConversation();
  await app.runtime.acceptMessage(conversation.id, 'durable-with-broken-listener', '保存结果不依赖连接是否正常');
  await app.runtime.waitForIdle();
  const messages = await app.history.readPage(conversation.id, { afterSequence: 0 });
  assert.deepEqual(messages.map(message => message.role), ['user', 'assistant']);
});

test('memory extraction retains real message provenance and resumes after its persisted checkpoint', { timeout: 10_000 }, async t => {
  const config = await configuration(t);
  const model = new ScriptModel();
  model.extract = async input => {
    const value = JSON.parse(input.messages[0]!.content) as { messages: { id: string; role: string; text: string }[] };
    const source = value.messages.find(message => message.role === 'user' && message.text.includes('桂花茶'));
    return { memories: source ? [{ content: '用户喜欢喝桂花茶。', kind: 'user_statement', sourceMessageIds: [source.id], supersedes: [] }] : [] };
  };
  const app = createApplication(config, { model }); t.after(() => app.close());
  await app.start(); const conversation = await app.runtime.getConversation();
  await app.runtime.acceptMessage(conversation.id, 'real-preference-message', '我喜欢喝桂花茶。');
  await app.runtime.waitForIdle();
  const memories = await app.memories.list(config.settings.scope);
  assert.equal(memories.length, 1);
  assert.equal(memories[0]?.kind, 'user_statement');
  assert.deepEqual(memories[0]?.sourceMessages, [{ conversationId: conversation.id, messageId: 'real-preference-message' }]);
  assert.equal(await app.memories.getCheckpoint(conversation.id), await app.history.getCursor(conversation.id));
  assert(model.memoryInputs.length > 0);
  for (const input of model.memoryInputs) {
    const value = JSON.parse(input.messages[0]!.content) as { messages: { id: string }[] };
    for (const message of value.messages) assert(await app.conversations.getMessage({ conversationId: conversation.id, messageId: message.id }));
    assert.equal('references' in value, false);
  }
  await app.close();

  const nextModel = new ScriptModel(); const next = createApplication(config, { model: nextModel }); t.after(() => next.close());
  await next.start(); await next.runtime.waitForIdle();
  assert.equal(nextModel.memoryInputs.length, 0);
  assert.equal((await next.memories.list(config.settings.scope)).length, 1);
  await next.runtime.acceptMessage(conversation.id, 'recall-preference', '我喜欢喝什么茶？');
  await next.runtime.waitForIdle();
  assert(nextModel.replyInputs[0]?.instructions.includes('用户喜欢喝桂花茶。'));
  assert(nextModel.replyInputs[0]?.instructions.includes('real-preference-message'));
});

test('shutdown leaves interrupted accepted work recoverable by a new application', { timeout: 10_000 }, async t => {
  const config = await configuration(t);
  const started = deferred<void>();
  const model = new ScriptModel();
  model.reply = input => new Promise((_resolve, reject) => {
    started.resolve();
    if (input.signal?.aborted) reject(new Error('aborted'));
    else input.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  const app = createApplication(config, { model }); t.after(() => app.close());
  await app.start(); const conversation = await app.runtime.getConversation();
  await app.runtime.acceptMessage(conversation.id, 'interrupted-input', '关闭之前已经接收的消息');
  await started.promise;
  assert.equal(await app.history.getCursor(conversation.id), 1);
  await app.close();

  const replacementModel = new ScriptModel();
  const replacement = createApplication(config, { model: replacementModel }); t.after(() => replacement.close());
  await replacement.start(); await replacement.runtime.waitForIdle();
  const messages = await replacement.history.readPage(conversation.id, { afterSequence: 0 });
  assert.deepEqual(messages.map(message => message.role), ['user', 'assistant']);
  assert.equal(messages[0]?.id, 'interrupted-input');
  assert.equal(replacementModel.replyInputs.length, 1);
  assert.equal((await replacement.conversations.listPendingTasks()).length, 0);
});

test('background memory does not consume future queued inputs while an earlier reply is in flight', { timeout: 10_000 }, async t => {
  const config = await configuration(t);
  const model = new ScriptModel();
  const firstStarted = deferred<void>(); const releaseFirst = deferred<void>();
  const secondStarted = deferred<void>(); const releaseSecond = deferred<void>();
  const memoryObserved = deferred<ModelInput>();
  model.reply = async (_input, number) => {
    if (number === 1) { firstStarted.resolve(); await releaseFirst.promise; }
    if (number === 2) { secondStarted.resolve(); await releaseSecond.promise; }
    return `回复${number}`;
  };
  model.extract = async input => { memoryObserved.resolve(input); return { memories: [] }; };
  const app = createApplication(config, { model });
  t.after(async () => { releaseFirst.resolve(); releaseSecond.resolve(); await app.close(); });
  await app.start(); const conversation = await app.runtime.getConversation();
  await app.runtime.acceptMessage(conversation.id, 'earlier-input', '当前请求不涉及未来偏好');
  await firstStarted.promise;
  await app.runtime.acceptMessage(conversation.id, 'later-input', '未来偏好只属于第二个请求');
  releaseFirst.resolve();
  await secondStarted.promise;
  const extraction = await memoryObserved.promise;
  const payload = JSON.parse(extraction.messages[0]!.content) as { messages: { id: string; text: string }[] };
  assert(payload.messages.length > 0);
  assert(payload.messages.every(message => message.id !== 'later-input'));
  assert(model.replyInputs[0]?.messages.every(message => !message.content.includes('未来偏好只属于第二个请求')));
  releaseSecond.resolve(); await app.runtime.waitForIdle();
  assert.equal(await app.memories.getCheckpoint(conversation.id), await app.history.getCursor(conversation.id));
});
