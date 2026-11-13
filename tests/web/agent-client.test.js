import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import { createAgentClient, resolveAgentUrl } from '../../src/adapter/web/agent-client.js';

async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for chat state');
    await delay(5);
  }
}

async function setup(t, onFrame = () => {}) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const connections = [];
  const received = [];
  server.on('connection', socket => {
    connections.push(socket);
    socket.on('message', raw => {
      const frame = JSON.parse(raw.toString());
      received.push(frame);
      onFrame(socket, frame);
    });
  });
  const messages = [];
  const statuses = [];
  const typing = [];
  const errors = [];
  const client = createAgentClient({
    url: `ws://127.0.0.1:${server.address().port}/ws/chat`,
    retryMs: 20,
    maxRetryMs: 40,
    onMessage: message => messages.push(message),
    onStatus: status => statuses.push(status),
    onTyping: active => typing.push(active),
    onError: text => errors.push(text),
  });
  t.after(async () => {
    client.stop();
    for (const socket of server.clients) socket.terminate();
    await new Promise(resolve => server.close(resolve));
  });
  client.start();
  await until(() => received.some(frame => frame.type === 'hello'));
  return { server, client, connections, received, messages, statuses, typing, errors };
}

test('blank configuration stays idle without a WebSocket implementation', () => {
  const original = globalThis.WebSocket;
  globalThis.WebSocket = undefined;
  try {
    const statuses = [];
    const client = createAgentClient({ url: '', onStatus: state => statuses.push(state) });
    client.start();
    assert.equal(client.status, 'idle');
    assert.equal(client.sendMessage('hello'), false);
    client.stop();
    assert.deepEqual(statuses, ['idle', 'idle']);
  } finally {
    globalThis.WebSocket = original;
  }
});

test('runtime URLs support independent endpoints and same-origin secure paths', () => {
  const page = 'https://example.test/chat/';
  assert.equal(resolveAgentUrl('  ', page), '');
  assert.equal(resolveAgentUrl('/ws/chat', page), 'wss://example.test/ws/chat');
  assert.equal(resolveAgentUrl('ws://127.0.0.1:8000/chat', page), 'ws://127.0.0.1:8000/chat');
  assert.throws(() => resolveAgentUrl(undefined, page));
  assert.throws(() => resolveAgentUrl('file:///chat', page));
});

test('a minimal agent can reply without presence or user-message echo', async t => {
  const reply = '当前环境已经恢复，继续上次的对话。原文保留。';
  const session = await setup(t, (socket, frame) => {
    if (frame.type === 'msg') socket.send(JSON.stringify({ type: 'msg', id: 'reply-1', role: 'assistant', text: reply }));
  });
  assert.equal(session.client.status, 'online');
  assert.equal(session.received[0].name, '你');
  assert.equal(session.client.sendMessage('  hello  '), true);
  assert.equal(session.messages[0].role, 'user');
  assert.equal(session.messages[0].text, 'hello');
  await until(() => session.messages.length === 2);
  assert.equal(session.messages[1].text, reply);
  assert.equal(session.messages[1].role, 'assistant');
  assert.equal(session.typing.at(-1), false);
  assert.equal(session.received[1].id, session.messages[0].id);
});

test('echoes, history batches and reconnect replay keep stable message identity', async t => {
  const historical = { id: 'history-1', role: 'assistant', text: 'earlier reply', ts: '2026-10-08T06:00:00.000Z' };
  const session = await setup(t, (socket, frame) => {
    if (frame.type === 'hello') socket.send(JSON.stringify({ type: 'history', messages: [historical, historical] }));
    if (frame.type === 'msg') socket.send(JSON.stringify({ ...frame, role: 'user', ts: new Date().toISOString() }));
  });
  await until(() => session.messages.length === 1);
  assert.equal(session.messages[0].history, true);
  session.client.sendMessage('one message');
  await until(() => session.received.some(frame => frame.type === 'msg'));
  session.connections[0].close(1012, 'restart');
  await until(() => session.received.filter(frame => frame.type === 'hello').length === 2);
  session.connections[1].send(JSON.stringify({ type: 'msg', id: 'after-reconnect', role: 'assistant', text: 'back online' }));
  await until(() => session.messages.length === 3);
  assert.deepEqual(session.messages.map(message => message.text), ['earlier reply', 'one message', 'back online']);
  assert.ok(session.statuses.includes('offline'));
  assert.equal(session.client.status, 'online');
  session.client.stop();
  await delay(80);
  assert.equal(session.connections.length, 2);
  assert.equal(session.client.sendMessage('after stop'), false);
});

test('presence gates sending, typing and explicit errors recover on the same connection', async t => {
  const session = await setup(t);
  const socket = session.connections[0];
  socket.send(JSON.stringify({ type: 'presence', online: false }));
  await until(() => session.client.status === 'offline');
  assert.equal(session.client.sendMessage('not available'), false);
  assert.equal(session.typing.at(-1), false);
  socket.send(JSON.stringify({ type: 'presence', online: true }));
  await until(() => session.client.status === 'online');
  assert.equal(session.client.sendMessage('try again'), true);
  assert.equal(session.typing.at(-1), true);
  socket.send(JSON.stringify({ type: 'typing', active: false }));
  await until(() => session.typing.at(-1) === false);
  socket.send(JSON.stringify({ type: 'typing', active: true }));
  await until(() => session.typing.at(-1) === true);
  socket.send(JSON.stringify({ type: 'error', text: 'Please retry' }));
  await until(() => session.errors.length === 1);
  assert.equal(session.typing.at(-1), false);
  assert.equal(session.client.status, 'online');
  assert.equal(session.client.sendMessage('retry'), true);
});

test('invalid frames cannot break subsequent messages and legacy envelopes still render', async t => {
  const session = await setup(t);
  const socket = session.connections[0];
  for (const raw of ['not JSON', 'null', '[]', '{"type":"msg","text":{}}', '{"type":"msg","role":"system","text":"hidden"}', '{"type":"presence","online":"false"}']) socket.send(raw);
  const message = { type: 'msg', from: 'agent', text: 'valid reply', ts: '2026-10-08T06:00:00.000Z', history: true };
  socket.send(JSON.stringify(message));
  socket.send(JSON.stringify(message));
  socket.send(JSON.stringify({ type: 'msg', from: '你', text: 'past user message' }));
  await until(() => session.messages.length === 2);
  assert.deepEqual(session.messages.map(message => message.role), ['assistant', 'user']);
  assert.equal(session.client.status, 'online');
  assert.deepEqual(session.errors, []);
});
