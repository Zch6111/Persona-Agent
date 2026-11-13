import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import test from 'node:test';
import type { WebSocket } from 'ws';
import { ChatWebSocketController, parseFrame, type ChatRuntime, type ChatHistory } from '../src/adapter/conversation/api.js';
import { CompatibleLanguageModel, handleModelSettingsRequest } from '../src/adapter/inference/api.js';
import { handleInspectionRequest } from '../src/adapter/inspection/api.js';
import { InMemoryInspectionRepository } from '../src/adapter/inspection/db.js';
import { InspectionService } from '../src/application/inspection/usecase.js';
import type { ChatEvent, Message } from '../src/application/conversation/model.js';

const origin = 'http://127.0.0.1:4173';
const origins = new Set([origin]);

function request(url: string, method = 'GET', body = '', headers = { origin, host: '127.0.0.1:8000' }) {
  return Object.assign(Readable.from(body ? [body] : []), { url, method, headers }) as unknown as IncomingMessage;
}
function response() {
  const result = { statusCode: 200, body: '', headers: new Map<string, string>(),
    setHeader(name: string, value: string) { this.headers.set(name, value); },
    writeHead(status: number) { this.statusCode = status; },
    end(body: string) { this.body = body; },
  };
  return { result, stream: result as unknown as ServerResponse };
}

test('inspection HTTP adapter preserves host/origin restrictions, method checks and failure responses', async () => {
  let calls = 0;
  const inspect = async () => { calls++; return { requests: [] }; };
  for (const headers of [{ origin: 'https://foreign.example', host: '127.0.0.1:8000' }, { origin, host: 'foreign.example' }, { origin: '', host: '127.0.0.1:8000' }]) {
    const res = response();
    assert.equal(await handleInspectionRequest(request('/inspect', 'GET', '', headers), res.stream, origins, inspect), true);
    assert.equal(res.result.statusCode, 403);
  }
  assert.equal(calls, 0);
  const denied = response(); await handleInspectionRequest(request('/inspect', 'POST'), denied.stream, origins, inspect);
  assert.equal(denied.result.statusCode, 405);
  const ok = response(); await handleInspectionRequest(request('/inspect'), ok.stream, origins, inspect);
  assert.deepEqual(JSON.parse(ok.result.body), { requests: [] });
  assert.equal(ok.result.headers.get('Access-Control-Allow-Origin'), origin);
  const failed = response(); await handleInspectionRequest(request('/inspect'), failed.stream, origins, async () => { throw new Error('internal'); });
  assert.equal(failed.result.statusCode, 500); assert(!failed.result.body.includes('internal'));
  assert.equal(await handleInspectionRequest(request('/other'), response().stream, origins, inspect), false);
});

test('model settings HTTP adapter retains selection on rejected, malformed and oversized requests', async () => {
  let provider = 'local';
  const settings = { get: () => ({ provider }), async set(value: string) { if (value !== 'deepseek') throw new Error('不支持的来源'); provider = value; } };
  for (const body of ['{', JSON.stringify({ provider: 'unknown' }), 'x'.repeat(1025)]) {
    const res = response(); await handleModelSettingsRequest(request('/settings/model', 'POST', body), res.stream, origins, settings);
    assert.equal(res.result.statusCode, 400); assert.equal(provider, 'local');
  }
  const forbidden = response(); await handleModelSettingsRequest(request('/settings/model', 'POST', '{"provider":"deepseek"}', { origin: '', host: 'localhost' }), forbidden.stream, origins, settings);
  assert.equal(forbidden.result.statusCode, 403); assert.equal(provider, 'local');
  const success = response(); await handleModelSettingsRequest(request('/settings/model', 'POST', '{"provider":"deepseek"}'), success.stream, origins, settings);
  assert.deepEqual(JSON.parse(success.result.body), { provider: 'deepseek' });
  const read = response(); await handleModelSettingsRequest(request('/settings/model'), read.stream, origins, settings);
  assert.equal(JSON.parse(read.result.body).provider, 'deepseek');
});

test('model adapter sends the exact prompt and structured options, records actual payload and hides credentials', async t => {
  const transmitted: { url: string; body?: unknown; headers?: HeadersInit }[] = [];
  t.mock.method(globalThis, 'fetch', async (input: URL | string, options?: RequestInit) => {
    const url = String(input);
    const body = options?.body ? JSON.parse(String(options.body)) : undefined;
    transmitted.push({ url, body, headers: options?.headers });
    if (url.endsWith('/models')) return Response.json({ data: [{ id: 'roleplay' }] });
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: body.response_format ? '{"memories":[]}' : '你好' } }] });
  });
  const inspection = new InspectionService(new InMemoryInspectionRepository());
  const model = new CompatibleLanguageModel({ baseUrl: 'http://models.example/v1/chat/completions?ignored=1', model: 'roleplay', apiKey: 'private-test-key', temperature: 0.7, observer: inspection });
  assert.equal(await model.isAvailable(), true);
  const input = { purpose: 'reply' as const, instructions: '角色设定', messages: [{ role: 'user' as const, content: '用户原文' }], maxOutputTokens: 120 };
  assert.equal(await model.generateText(input), '你好');
  assert.deepEqual(await model.generateStructured({ ...input, purpose: 'memory' }), { memories: [] });
  assert.equal(transmitted[0]!.url, 'http://models.example/v1/models');
  assert.equal(transmitted[1]!.url, 'http://models.example/v1/chat/completions');
  assert.deepEqual(inspection.snapshot().requests.map(item => item.payload), transmitted.slice(1).map(item => item.body));
  assert.equal(new Headers(transmitted[1]!.headers).get('Authorization'), 'Bearer private-test-key');
  assert(!JSON.stringify(inspection.snapshot()).includes('private-test-key'));
});

test('model adapter rejects truncated, empty, malformed, failed and cancelled responses', async t => {
  let payload: unknown = { choices: [{ finish_reason: 'length', message: { content: 'partial' } }] };
  let status = 200;
  t.mock.method(globalThis, 'fetch', async (_input: unknown, options?: RequestInit) => {
    if (options?.signal?.aborted) throw new Error('aborted');
    return Response.json(payload, { status });
  });
  const inspection = new InspectionService(new InMemoryInspectionRepository());
  const model = new CompatibleLanguageModel({ baseUrl: 'http://models.example/v1', model: 'test', observer: inspection });
  const input = { purpose: 'reply' as const, instructions: '', messages: [], maxOutputTokens: 10 };
  await assert.rejects(() => model.generateText(input), /输出长度/);
  payload = { choices: [{ message: { content: '' } }] }; await assert.rejects(() => model.generateText(input), /空回复/);
  payload = { choices: [{ message: { content: 'not json' } }] }; await assert.rejects(() => model.generateStructured(input), /结构化/);
  status = 503; await assert.rejects(() => model.generateText(input), /HTTP 503/);
  await assert.rejects(() => model.generateText({ ...input, signal: AbortSignal.abort() }), /取消/);
  assert.equal(inspection.snapshot().requests.at(-1)!.status, 'failed');
});

test('WebSocket connection subscribes before replay, buffers live messages, deduplicates and unsubscribes', async () => {
  let listener: ((event: ChatEvent) => void) | undefined;
  let subscribed = false;
  const messages: Message[] = [1, 2, 3].map(sequence => ({ id: `m${sequence}`, conversationId: 'c', role: sequence === 2 ? 'assistant' : 'user', text: `消息${sequence}`, createdAt: '2026-01-01T00:00:00Z', sequence }));
  const runtime: ChatRuntime = { online: true, async getConversation() { return { id: 'c', userId: 'u', characterId: 'dania', createdAt: '' }; }, async acceptMessage() {}, subscribe(callback) { subscribed = true; listener = callback; return () => { subscribed = false; listener = undefined; }; } };
  const history: ChatHistory = { async getCursor() { assert.equal(subscribed, true); return 2; }, async readPage() { listener!({ kind: 'message_saved', conversationId: 'c', message: messages[2]! }); return messages.slice(0, 2); } };
  const frames: Record<string, unknown>[] = [];
  const socket = Object.assign(new EventEmitter(), { readyState: 1, send(value: string, callback: () => void) { frames.push(JSON.parse(value)); callback(); } });
  new ChatWebSocketController(runtime, history).connect(socket as unknown as WebSocket);
  socket.emit('message', Buffer.from('{"type":"hello","name":"你"}'), false);
  // The controller processes frames on its promise queue.
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(frames.filter(item => item.type === 'history').length, 1);
  assert.deepEqual(frames.filter(item => item.type === 'msg').map(item => item.id), ['m3']);
  listener!({ kind: 'message_saved', conversationId: 'c', message: messages[2]! });
  assert.equal(frames.filter(item => item.type === 'msg').length, 1);
  socket.emit('message', Buffer.from('invalid'), false);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert(frames.some(item => item.type === 'error'));
  socket.emit('close'); assert.equal(subscribed, false);
  assert.throws(() => parseFrame('{"type":"msg","id":"","text":"x"}'));
});
