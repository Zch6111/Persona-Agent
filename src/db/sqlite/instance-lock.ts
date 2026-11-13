import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

interface LockOwner { pid: number; token: string }

function readOwner(file: string): LockOwner | undefined {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as Partial<LockOwner>;
    if (Number.isInteger(value.pid) && Number(value.pid) > 0 && typeof value.token === 'string' && value.token) return value as LockOwner;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
  }
  throw new Error('数据库实例锁格式不正确，请确认旧服务已经关闭后移除锁文件。');
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    return true;
  }
}

/** Prevents application task recovery from racing another live application. */
export function acquireInstanceLock(databaseFile: string): () => void {
  if (databaseFile === ':memory:') return () => {};
  const file = `${databaseFile}.lock`;
  mkdirSync(dirname(file), { recursive: true });
  const owner: LockOwner = { pid: process.pid, token: randomUUID() };

  for (let attempt = 0; attempt < 5; attempt++) {
    let descriptor: number;
    try { descriptor = openSync(file, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const previous = readOwner(file);
      if (!previous) continue;
      if (isAlive(previous.pid)) throw new Error('这个数据库已有运行中的 agent，请先关闭原服务。');
      // A competing stale-lock takeover may already have replaced the owner.
      const current = readOwner(file);
      if (current?.pid !== previous.pid || current.token !== previous.token) continue;
      try { unlinkSync(file); }
      catch (removeError) { if ((removeError as NodeJS.ErrnoException).code !== 'ENOENT') throw removeError; }
      continue;
    }

    try { writeFileSync(descriptor, JSON.stringify(owner), 'utf8'); }
    catch (error) {
      closeSync(descriptor);
      unlinkSync(file);
      throw error;
    }
    closeSync(descriptor);
    const identity = statSync(file);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      let current: LockOwner | undefined;
      try {
        const status = statSync(file);
        if (status.dev !== identity.dev || status.ino !== identity.ino) return;
        current = readOwner(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      if (current?.pid !== owner.pid || current.token !== owner.token) return;
      try { unlinkSync(file); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    };
  }
  throw new Error('数据库实例锁正在变化，请稍后重新启动。');
}
