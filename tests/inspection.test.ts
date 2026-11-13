import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApplication } from '../src/bootstrap.js';
import { loadConfig } from '../src/config.js';

test('inspection shows exact transmitted payloads and committed sourced memories without credentials', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-inspection-'));
  const transmitted: unknown[] = [];
  const server = createServer((request, response) => {
    if (request.url === '/models') { response.end(JSON.stringify({ data: [{ id: 'inspection-model' }] })); return; }
    let body = ''; request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const payload = JSON.parse(body); transmitted.push(payload);
      let text = '好的，我记住了。';
      if (payload.response_format) {
        const input = JSON.parse(payload.messages[1].content);
        const source = input.messages.find((message: { role: string }) => message.role === 'user');
        text = JSON.stringify({ memories: source ? [{ content: '用户表示喜欢桂花茶。', kind: 'user_statement', sourceMessageIds: [source.id], supersedes: [] }] : [] });
      }
      response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: text } }] }));
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); });
  const config = await loadConfig(undefined, {});
  config.database = join(directory, 'agent.sqlite'); config.port = 0;
  const modelAddress = server.address(); assert(modelAddress && typeof modelAddress !== 'string');
  config.model = { ...config.model, baseUrl: `http://127.0.0.1:${modelAddress.port}`, model: 'inspection-model', apiKey: 'test-secret-not-exposed' };
  const app = createApplication(config); t.after(() => app.close());
  const address = await app.start();
  const conversation = await app.runtime.getConversation();
  await app.runtime.acceptMessage(conversation.id, 'inspection-source', '我喜欢喝桂花茶。');
  await app.runtime.waitForIdle();
  const url = `http://${address.host}:${address.port}/inspect`;
  const denied = await fetch(url, { headers: { Origin: 'https://foreign.example' } }); assert.equal(denied.status, 403);
  const response = await fetch(url, { headers: { Origin: 'http://127.0.0.1:4173' } });
  const snapshot = await response.json();
  assert.deepEqual(snapshot.requests.map((request: { payload: unknown }) => request.payload), transmitted);
  assert.deepEqual(snapshot.requests.map((request: { purpose: string }) => request.purpose), ['reply', 'memory']);
  assert(snapshot.requests.every((request: { status: string }) => request.status === 'completed'));
  assert.equal(snapshot.memory.state, 'idle'); assert.equal(snapshot.memory.pendingMessages, 0);
  assert.equal(snapshot.memory.entries[0].sourceMessages[0].messageId, 'inspection-source');
  assert(snapshot.memory.sources.some((source: { id: string; text: string }) => source.id === 'inspection-source' && source.text === '我喜欢喝桂花茶。'));
  assert(!JSON.stringify(snapshot).includes('test-secret-not-exposed'));
});
