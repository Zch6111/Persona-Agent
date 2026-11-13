import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { acquireInstanceLock } from '../src/adapter/platform/database.js';
test('instance lock refuses a live owner, releases once and can be acquired again', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'game-agent-lock-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'nested', 'agent.sqlite');
  const release = acquireInstanceLock(file);
  assert.throws(() => acquireInstanceLock(file), /运行中/);
  release();
  release();
  const releaseAgain = acquireInstanceLock(file);
  t.after(releaseAgain);
  assert.throws(() => acquireInstanceLock(file), /运行中/);
});

test('instance lock takes over a dead process and never releases a replacement owner', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'game-agent-stale-lock-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'agent.sqlite');
  const child = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  assert.equal(child.status, 0);
  await writeFile(`${file}.lock`, JSON.stringify({ pid: child.pid, token: 'dead-process' }));
  const release = acquireInstanceLock(file);
  const owner = JSON.parse(await readFile(`${file}.lock`, 'utf8')) as { pid: number; token: string };
  assert.equal(owner.pid, process.pid);
  assert.notEqual(owner.token, 'dead-process');
  const replacement = { pid: process.pid, token: 'replacement-owner' };
  await writeFile(`${file}.lock`, JSON.stringify(replacement));
  release();
  assert.deepEqual(JSON.parse(await readFile(`${file}.lock`, 'utf8')), replacement);
});

test('in-memory databases do not create an instance lock', () => {
  const first = acquireInstanceLock(':memory:');
  const second = acquireInstanceLock(':memory:');
  first();
  second();
});
