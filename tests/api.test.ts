import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { WebSocket } from 'ws';
import { CompatibleLanguageModel } from '../src/adapter/inference/api.js';
import { createApiServer } from '../src/adapter/platform/server.js';
import type { ChatHistory, ChatRuntime } from '../src/adapter/conversation/api.js';
import type { Message } from '../src/application/conversation/model.js';
import type { ChatEvent } from '../src/application/conversation/model.js';
import type { ModelInput } from '../src/application/inference/model.js';
const origin = 'http://127.0.0.1:4173';
const modelInput: ModelInput = { purpose: 'reply', instructions: 'reply as character', messages: [{ role: 'user', content: '你好' }], maxOutputTokens: 32 };

async function modelServer(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert(address && typeof address !== 'string');
  return { url: `http://127.0.0.1:${address.port}`, close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

class Runtime implements ChatRuntime {
  online = true;
  listeners = new Set<(event: ChatEvent) => void>();
  accepted: { conversationId: string; id: string; text: string }[] = [];
  async getConversation() { return { id: 'conversation', userId: 'local', characterId: 'dania', createdAt: '2026-01-01T00:00:00Z' }; }
  async acceptMessage(conversationId: string, id: string, text: string) { this.accepted.push({ conversationId, id, text }); }
  subscribe(listener: (event: ChatEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  emit(event: ChatEvent) { for (const listener of this.listeners) listener(event); }
}

function message(sequence: number, role: Message['role'] = 'assistant'): Message {
  return { id: `message-${sequence}`, conversationId: 'conversation', role, text: `正文${sequence}`, createdAt: '2026-01-01T00:00:00Z', sequence };
}

async function client(url: string) {
  const socket = new WebSocket(url, { origin });
  const frames: Record<string, unknown>[] = [];
  const waiters = new Set<() => void>();
  socket.on('message', data => { frames.push(JSON.parse(data.toString()) as Record<string, unknown>); for (const check of waiters) check(); });
  await once(socket, 'open');
  return {
    socket, frames,
    wait(predicate: (frame: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { waiters.delete(check); reject(new Error('frame timeout')); }, 2_000);
        const check = () => {
          const found = frames.find(predicate);
          if (found) { clearTimeout(timer); waiters.delete(check); resolve(found); }
        };
        waiters.add(check); check();
      });
    },
    async close() { const closed = once(socket, 'close'); socket.close(); await closed; },
  };
}

test('model adapter preserves reply text and translates structured requests without leaking transport objects', async t => {
  const received: Record<string, unknown>[] = [];
  const server = await modelServer((request, response) => {
    if (request.url === '/v1/models') { response.end(JSON.stringify({ data: [{ id: 'test-model' }] })); return; }
    assert.equal(request.url, '/v1/chat/completions');
    let raw = ''; request.on('data', chunk => { raw += chunk; }); request.on('end', () => {
      const body = JSON.parse(raw) as Record<string, unknown>; received.push(body);
      response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: body.response_format ? '{"memories":[]}' : '  原样回复。\n' } }] }));
    });
  });
  t.after(server.close);
  const model = new CompatibleLanguageModel({ baseUrl: `${server.url}/v1/chat/completions`, model: 'test-model' });
  assert.equal(await model.isAvailable(), true);
  assert.equal(await model.generateText(modelInput), '  原样回复。\n');
  assert.deepEqual(await model.generateStructured({ ...modelInput, purpose: 'memory' }), { memories: [] });
  assert.deepEqual(received[0]?.messages, [{ role: 'system', content: modelInput.instructions }, ...modelInput.messages]);
  assert.deepEqual(received[1]?.response_format, { type: 'json_object' });
  assert.equal(await new CompatibleLanguageModel({ baseUrl: `${server.url}/v1`, model: 'missing' }).isAvailable(), false);
});

test('model adapter bounds response body time and sanitizes HTTP failures', async t => {
  const server = await modelServer((request, response) => {
    if (request.url === '/slow/chat/completions') { response.writeHead(200, { 'Content-Type': 'application/json' }); response.flushHeaders(); return; }
    assert.equal(request.url, '/chat/completions');
    response.writeHead(401); response.end('secret-api-key transport debugging');
  });
  t.after(server.close);
  await assert.rejects(new CompatibleLanguageModel({ baseUrl: `${server.url}/slow`, model: 'model', timeoutMs: 40 }).generateText(modelInput), /超时/);
  await assert.rejects(new CompatibleLanguageModel({ baseUrl: server.url, model: 'model', apiKey: 'secret-api-key' }).generateText(modelInput), error => error instanceof Error && error.message.includes('401') && !error.message.includes('secret'));
});

test('model adapter rejects empty, malformed and truncated responses and honors caller cancellation', async t => {
  let content: unknown = '';
  let finishReason = 'stop';
  const server = await modelServer((_request, response) => { response.end(JSON.stringify({ choices: [{ finish_reason: finishReason, message: { content } }] })); });
  t.after(server.close);
  const model = new CompatibleLanguageModel({ baseUrl: server.url, model: 'model' });
  await assert.rejects(model.generateText(modelInput), /空回复/);
  content = 'not JSON'; await assert.rejects(model.generateStructured(modelInput), /结构化/);
  finishReason = 'length'; await assert.rejects(model.generateText(modelInput), /长度/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(model.generateText({ ...modelInput, signal: controller.signal }), /取消/);
});

test('chat replays a bounded history snapshot and joins concurrent live messages without duplicate IDs', async t => {
  const runtime = new Runtime();
  let resolveCursor!: (cursor: number) => void;
  const cursor = new Promise<number>(resolve => { resolveCursor = resolve; });
  let subscribed!: () => void;
  const subscription = new Promise<void>(resolve => { subscribed = resolve; });
  const originalSubscribe = runtime.subscribe.bind(runtime);
  runtime.subscribe = listener => { const unsubscribe = originalSubscribe(listener); subscribed(); return unsubscribe; };
  const history: ChatHistory = { getCursor: () => cursor, readPage: async () => [message(1, 'user')] };
  const api = createApiServer({ runtime, history, port: 0, allowedOrigins: [origin] });
  const address = await api.listen(); t.after(() => api.close());
  const peer = await client(`ws://${address.host}:${address.port}/ws/chat`);
  peer.socket.send(JSON.stringify({ type: 'hello', name: 'not-an-identity' }));
  await subscription;
  runtime.emit({ kind: 'message_saved', conversationId: 'conversation', message: message(1, 'user') });
  runtime.emit({ kind: 'reply_started', conversationId: 'conversation', taskId: 'task' });
  runtime.emit({ kind: 'message_saved', conversationId: 'conversation', message: message(2) });
  resolveCursor(1);
  await peer.wait(frame => frame.type === 'typing' && frame.active === false);
  const historyFrame = peer.frames.find(frame => frame.type === 'history');
  assert(historyFrame); assert.deepEqual((historyFrame.messages as { id: string }[]).map(item => item.id), ['message-1']);
  assert.deepEqual(peer.frames.filter(frame => frame.type === 'msg').map(frame => frame.id), ['message-2']);
  peer.socket.send(JSON.stringify({ type: 'msg', id: 'client-id', text: '你好' }));
  await new Promise<void>(resolve => setTimeout(resolve, 20));
  assert.deepEqual(runtime.accepted, [{ conversationId: 'conversation', id: 'client-id', text: '你好' }]);
  peer.socket.send('{broken'); await peer.wait(frame => frame.type === 'error');
  assert.equal(peer.socket.readyState, WebSocket.OPEN);
  await peer.close(); assert.equal(runtime.listeners.size, 0);
});

test('chat rejects foreign browser origins and stays bound to loopback', async t => {
  const runtime = new Runtime();
  const history: ChatHistory = { getCursor: async () => 0, readPage: async () => [] };
  const api = createApiServer({ runtime, history, port: 0, allowedOrigins: [origin] });
  const address = await api.listen(); t.after(() => api.close());
  const socket = new WebSocket(`ws://${address.host}:${address.port}/ws/chat`, { origin: 'https://untrusted.example' });
  await assert.rejects(once(socket, 'open'), /403/);
  const response = await fetch(`http://${address.host}:${address.port}/health`);
  assert.deepEqual(await response.json(), { service: 'gameAgent', online: true });
  assert.throws(() => createApiServer({ runtime, history, host: '0.0.0.0', allowedOrigins: [origin] }), /本机/);
});
