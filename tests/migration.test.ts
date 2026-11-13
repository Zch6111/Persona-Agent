import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { migrateCortico } from '../src/adapter/platform/migration.js';
import { SqliteDatabase } from '../src/adapter/platform/database.js';
import { SqliteConversationRepository } from '../src/adapter/conversation/db.js';
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'persona-migration-'));
  const source = join(root, 'legacy-bot');
  await mkdir(join(source, 'data/runs/run-a'), { recursive: true });
  await mkdir(join(source, 'data/runs/run-z'), { recursive: true });
  await mkdir(join(source, 'workspace/nested'), { recursive: true });
  await writeFile(join(source, 'workspace/CONSTITUTION.md'), '旧角色长期原则');
  await writeFile(join(source, 'workspace/nested/notes.md'), '旧文档');
  await writeFile(join(source, 'workspace/.env'), 'DO_NOT_COPY');
  await writeFile(join(source, 'workspace/secret.md'), 'DO_NOT_COPY');
  await writeFile(join(source, 'data/runs/run-a/events.jsonl'), [
    JSON.stringify({ type: 'terminal.self', cursor: 20, ts: '2026-01-01T00:00:02Z', meta: { from: '角色', body: '我记住了。' } }),
    JSON.stringify({ type: 'provider.response', cursor: 21, ts: '2026-01-01T00:00:03Z', meta: { from: '角色', body: '内部内容' } }),
    '{invalid-json',
    JSON.stringify({ type: 'terminal.message', cursor: 22, ts: '2026-01-01T00:00:04Z', text: '不得从text猜正文' }),
  ].join('\n'));
  await writeFile(join(source, 'data/runs/run-z/events.jsonl'), JSON.stringify({
    type: 'terminal.message', cursor: 10, ts: '2026-01-01T00:00:01Z',
    text: '旧协议装饰过的行', meta: { from: '用户', body: '我喜欢热茶。' },
  }) + '\n');
  return { root, source, database: join(root, 'new/agent.sqlite'), archiveDir: join(root, 'archive') };
}

test('migration preview reads chat events without creating a database or archive', async () => {
  const item = await fixture();
  try {
    const report = await migrateCortico(item);
    assert.equal(report.dryRun, true);
    assert.equal(report.messagesFound, 2);
    assert.equal(report.messagesImported, 0);
    assert.equal(report.malformedLines, 1);
    assert.equal(report.invalidChatEvents, 1);
    assert.equal(report.archiveFilesFound, 2);
    await assert.rejects(access(item.database));
    await assert.rejects(access(item.archiveDir));
  } finally { await rm(item.root, { recursive: true, force: true }); }
});

test('migration uses cursor order and exact chat bodies, and repeated application is idempotent', async () => {
  const item = await fixture();
  try {
    const first = await migrateCortico({ ...item, apply: true });
    assert.equal(first.messagesImported, 2);
    const second = await migrateCortico({ ...item, apply: true });
    assert.equal(second.messagesImported, 0);
    const db = new SqliteDatabase(item.database);
    try {
      const repo = new SqliteConversationRepository(db);
      const conversation = await repo.getOrCreate({ userId: 'local-user', characterId: 'dania' });
      const messages = await repo.listMessages(conversation.id, { afterSequence: 0, limit: 100 });
      assert.deepEqual(messages.map(message => [message.role, message.text]), [['user', '我喜欢热茶。'], ['assistant', '我记住了。']]);
      assert.equal(new Set(messages.map(message => message.id)).size, 2);
      assert.deepEqual(await repo.listPendingTasks(), []);
    } finally { db.close(); }
    assert.equal(await readFile(join(item.archiveDir, 'CONSTITUTION.md'), 'utf8'), '旧角色长期原则');
    assert.equal(await readFile(join(item.archiveDir, 'nested/notes.md'), 'utf8'), '旧文档');
    await assert.rejects(access(join(item.archiveDir, '.env')));
    await assert.rejects(access(join(item.archiveDir, 'secret.md')));
    assert.equal(await readFile(join(item.source, 'workspace/CONSTITUTION.md'), 'utf8'), '旧角色长期原则');
  } finally { await rm(item.root, { recursive: true, force: true }); }
});

test('migration cannot write into the original deployment', async () => {
  const item = await fixture();
  try {
    await assert.rejects(migrateCortico({ ...item, database: join(item.source, 'new.sqlite'), apply: true }), /目标必须/);
    await assert.rejects(migrateCortico({ ...item, archiveDir: join(item.source, 'archive'), apply: true }), /目标必须/);
  } finally { await rm(item.root, { recursive: true, force: true }); }
});

test('migration rejects conflicting old event identities instead of dropping a changed message', async () => {
  const item = await fixture();
  try {
    await writeFile(join(item.source, 'data/runs/run-z/events.jsonl'), [
      JSON.stringify({ type: 'terminal.message', cursor: 10, ts: '2026-01-01T00:00:01Z', meta: { from: '用户', body: '甲' } }),
      JSON.stringify({ type: 'terminal.message', cursor: 10, ts: '2026-01-01T00:00:01Z', meta: { from: '用户', body: '乙' } }),
    ].join('\n'));
    await assert.rejects(migrateCortico({ ...item, apply: true }), /标识冲突/);
    await assert.rejects(access(item.database));
  } finally { await rm(item.root, { recursive: true, force: true }); }
});

test('migration refuses to append old history after new backend chat has begun', async () => {
  const item = await fixture();
  try {
    await mkdir(join(item.root, 'new'), { recursive: true });
    const db = new SqliteDatabase(item.database);
    try {
      const repo = new SqliteConversationRepository(db);
      const conversation = await repo.getOrCreate({ userId: 'local-user', characterId: 'dania' });
      await repo.acceptUserMessage({ conversationId: conversation.id, id: 'new-message', text: '新对话', createdAt: '2026-01-02T00:00:00Z' });
    } finally { db.close(); }
    await assert.rejects(migrateCortico({ ...item, apply: true }), /开始聊天前迁移/);
  } finally { await rm(item.root, { recursive: true, force: true }); }
});
