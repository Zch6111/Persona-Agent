/** 读取配置和环境变量；项目根目录固定，重构不改变资料及数据库位置。 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type RuntimeSettings } from '../../application/conversation/model.js';

export const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));

export interface AgentConfig {
  root: string;
  host: string;
  port: number;
  allowedOrigins: string[];
  database: string;
  model: { baseUrl: string; model: string; apiKey?: string; timeoutMs: number; temperature: number };
  deepseek?: { apiKey?: string; model: string; baseUrl?: string };
  settings: RuntimeSettings;
}

async function readJson(file: string, optional = false): Promise<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('配置必须为对象。');
    return value as Record<string, unknown>;
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

export async function loadConfig(root = projectRoot, env = process.env): Promise<AgentConfig> {
  const base = await readJson(resolve(root, 'config.json'));
  const local = await readJson(resolve(root, 'config.local.json'), true);
  const values = { ...base, ...local };
  const model = { ...(base.model as Record<string, unknown>), ...(local.model as Record<string, unknown>) };
  const context = { ...(base.context as Record<string, unknown>), ...(local.context as Record<string, unknown>) };
  const scope = values.scope as RuntimeSettings['scope'];
  if (!scope || typeof scope.userId !== 'string' || !scope.userId || typeof scope.characterId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(scope.characterId)) throw new Error('用户和角色配置不正确。');
  const host = env.AGENT_HOST ?? values.host;
  if (!['127.0.0.1', 'localhost', '::1'].includes(String(host))) throw new Error('首版后端仅允许监听本机地址。');
  const port = Number(env.AGENT_PORT ?? values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('端口配置不正确。');
  const allowedOrigins = values.allowedOrigins;
  if (!Array.isArray(allowedOrigins) || !allowedOrigins.length || !allowedOrigins.every(origin => typeof origin === 'string' && new URL(origin).origin === origin)) throw new Error('前端来源配置不正确。');
  const settings = { ...context, scope } as unknown as RuntimeSettings;
  for (const key of ['maxContextChars', 'maxHistoryMessages', 'maxHistoryChars', 'maxMemoryChars', 'maxReferenceChars', 'maxInputChars', 'maxOutputTokens', 'memoryBatchSize'] as const) {
    if (!Number.isInteger(settings[key]) || settings[key] < 1) throw new Error(`配置 ${key} 必须是正整数。`);
  }
  if (settings.maxInputChars > settings.maxContextChars) throw new Error('单条消息预算不能大于总上下文预算。');
  const baseUrl = String(env.AGENT_MODEL_BASE_URL ?? model.baseUrl ?? '');
  const url = new URL(baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('模型地址不正确。');
  const modelName = String(env.AGENT_MODEL ?? model.model ?? '');
  if (!modelName.trim()) throw new Error('需要配置模型名称。');
  const timeoutMs = Number(model.timeoutMs);
  const temperature = Number(model.temperature);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || !Number.isFinite(temperature) || temperature < 0 || temperature > 2) throw new Error('模型超时或温度配置不正确。');
  const remote = values.deepseek as { apiKey?: string; model?: string; baseUrl?: string } | undefined;
  return { deepseek: { apiKey: env.DEEPSEEK_API_KEY || remote?.apiKey, model: env.DEEPSEEK_MODEL || remote?.model || 'deepseek-flash', baseUrl: env.DEEPSEEK_BASE_URL || remote?.baseUrl || 'https://api.deepseek.com' }, root, host: String(host), port, allowedOrigins, database: resolve(root, String(env.AGENT_DATABASE ?? values.database)), model: { baseUrl, model: modelName, timeoutMs, temperature, ...(env.AGENT_API_KEY ? { apiKey: env.AGENT_API_KEY } : {}) }, settings };
}
