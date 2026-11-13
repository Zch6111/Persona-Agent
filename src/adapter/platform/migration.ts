/** 旧数据导入：默认预览，保留原文和顺序，支持幂等导入与文档归档。 */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { projectRoot } from './config.js';
import { SqliteDatabase, acquireInstanceLock } from './database.js';
import { SqliteConversationRepository } from '../conversation/db.js';

interface LegacyMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;
  cursor: number;
  run: string;
  line: number;
}

export interface MigrationOptions {
  source: string;
  database: string;
  apply?: boolean;
  archiveDir?: string;
  userId?: string;
  characterId?: string;
}

export interface MigrationReport {
  dryRun: boolean;
  source: string;
  database: string;
  eventFiles: number;
  messagesFound: number;
  messagesImported: number;
  malformedLines: number;
  invalidChatEvents: number;
  archiveFilesFound: number;
  archiveFilesCopied: number;
}

function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return !path || (!path.startsWith('..') && !isAbsolute(path));
}

async function destinationPath(input: string): Promise<string> {
  const path = resolve(input);
  try { return await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return join(await destinationPath(dirname(path)), basename(path));
  }
}

async function readLegacyMessages(source: string): Promise<{
  messages: LegacyMessage[];
  eventFiles: number;
  malformedLines: number;
  invalidChatEvents: number;
}> {
  const runs = join(source, 'data', 'runs');
  const entries = await readdir(runs, { withFileTypes: true });
  const messages: LegacyMessage[] = [];
  let eventFiles = 0;
  let malformedLines = 0;
  let invalidChatEvents = 0;
  for (const run of entries.filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(runs, run.name, 'events.jsonl');
    let content: string;
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) continue;
      content = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    eventFiles += 1;
    const lines = content.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      if (!line.trim()) continue;
      let value: unknown;
      try { value = JSON.parse(line); } catch { malformedLines += 1; continue; }
      if (!value || typeof value !== 'object' || Array.isArray(value)) { malformedLines += 1; continue; }
      const event = value as Record<string, unknown>;
      if (event.type !== 'terminal.message' && event.type !== 'terminal.self') continue;
      const meta = event.meta as Record<string, unknown> | undefined;
      if (!Number.isSafeInteger(event.cursor) || Number(event.cursor) < 0 || typeof event.ts !== 'string' || !Number.isFinite(Date.parse(event.ts)) || !meta || typeof meta.from !== 'string' || typeof meta.body !== 'string' || !meta.body.trim()) {
        invalidChatEvents += 1;
        continue;
      }
      const identity = JSON.stringify([basename(source), run.name, event.cursor]);
      messages.push({
        id: `cortico-${createHash('sha256').update(identity).digest('hex')}`,
        role: event.type === 'terminal.message' ? 'user' : 'assistant',
        text: meta.body,
        createdAt: event.ts,
        cursor: Number(event.cursor),
        run: run.name,
        line: index,
      });
    }
  }
  messages.sort((a, b) => a.cursor - b.cursor || a.run.localeCompare(b.run) || a.line - b.line);
  const seen = new Map<string, LegacyMessage>();
  for (const message of messages) {
    const previous = seen.get(message.id);
    if (previous && (previous.text !== message.text || previous.role !== message.role || previous.createdAt !== message.createdAt)) {
      throw new Error('旧事件中存在标识冲突，已停止迁移。');
    }
    seen.set(message.id, message);
  }
  return { messages: [...seen.values()], eventFiles, malformedLines, invalidChatEvents };
}

async function findArchiveFiles(workspace: string, prefix = ''): Promise<string[]> {
  let entries;
  try { entries = await readdir(join(workspace, prefix), { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.') || /(?:secret|credential|token|password|api[-_]?key|密钥|口令)/i.test(entry.name)) continue;
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...await findArchiveFiles(workspace, path));
    else if (entry.isFile() && /\.(md|txt)$/i.test(entry.name)) files.push(path);
  }
  return files.sort();
}

export async function migrateCortico(options: MigrationOptions): Promise<MigrationReport> {
  const source = await realpath(resolve(options.source));
  if (!(await lstat(source)).isDirectory()) throw new Error('迁移来源必须是部署目录。');
  const database = await destinationPath(options.database);
  const archiveDir = options.archiveDir ? await destinationPath(options.archiveDir) : undefined;
  if (isWithin(source, database) || (archiveDir && isWithin(source, archiveDir))) {
    throw new Error('目标必须位于旧部署目录之外，避免改动来源。');
  }
  const scan = await readLegacyMessages(source);
  const archiveFiles = archiveDir ? await findArchiveFiles(join(source, 'workspace')) : [];
  const report: MigrationReport = {
    dryRun: !options.apply,
    source,
    database,
    eventFiles: scan.eventFiles,
    messagesFound: scan.messages.length,
    messagesImported: 0,
    malformedLines: scan.malformedLines,
    invalidChatEvents: scan.invalidChatEvents,
    archiveFilesFound: archiveFiles.length,
    archiveFilesCopied: 0,
  };
  if (!options.apply) return report;

  await mkdir(dirname(database), { recursive: true });
  const releaseLock = acquireInstanceLock(database);
  let db: SqliteDatabase;
  try { db = new SqliteDatabase(database); } catch (error) { releaseLock(); throw error; }
  try {
    const conversations = new SqliteConversationRepository(db);
    const conversation = await conversations.getOrCreate({ userId: options.userId ?? 'local-user', characterId: options.characterId ?? 'dania' });
    const existing = await conversations.getLastSequence(conversation.id);
    const existingMessages = existing > 0 ? await conversations.listMessages(conversation.id, { afterSequence: 0, limit: existing }) : [];
    const knownIds = new Set(existingMessages.map(message => message.id));
    const missing = scan.messages.filter(message => !knownIds.has(message.id));
    if (missing.length && existingMessages.some(message => !message.id.startsWith('cortico-'))) {
      throw new Error('请在新后端开始聊天前迁移旧记录，或使用单独的数据库。');
    }
    const lastExistingSourceIndex = scan.messages.reduce((last, message, index) => knownIds.has(message.id) ? index : last, -1);
    if (scan.messages.some((message, index) => index < lastExistingSourceIndex && !knownIds.has(message.id))) {
      throw new Error('新增旧记录位于已导入历史之前，请使用单独的数据库保持消息顺序。');
    }
    report.messagesImported = await conversations.importMessages(conversation.id, scan.messages.map(({ id, role, text, createdAt }) => ({ id, role, text, createdAt })));
  } finally { try { db.close(); } finally { releaseLock(); } }

  if (archiveDir) {
    for (const path of archiveFiles) {
      const target = join(archiveDir, path);
      await mkdir(dirname(target), { recursive: true });
      try {
        await copyFile(join(source, 'workspace', path), target, constants.COPYFILE_EXCL);
        report.archiveFilesCopied += 1;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
  }
  return report;
}

function parseArgs(args: string[]): MigrationOptions {
  const options: MigrationOptions = {
    source: resolve(projectRoot, '../Cortico/deployments/mybot'),
    database: resolve(projectRoot, 'var/agent.sqlite'),
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--apply') { options.apply = true; continue; }
    if (arg === '--dry-run') { options.apply = false; continue; }
    if (!['--source', '--database', '--archive-dir', '--user-id', '--character-id'].includes(arg ?? '')) throw new Error(`未知选项：${arg}`);
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(`${arg} 缺少值。`);
    if (arg === '--source') options.source = value;
    if (arg === '--database') options.database = value;
    if (arg === '--archive-dir') options.archiveDir = value;
    if (arg === '--user-id') options.userId = value;
    if (arg === '--character-id') options.characterId = value;
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const report = await migrateCortico(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify(report, null, 2));
    if (report.dryRun) console.log('预览完成；添加 --apply 后才会保存。');
  } catch (error) {
    console.error(error instanceof Error ? error.message : '迁移失败。');
    process.exitCode = 1;
  }
}
