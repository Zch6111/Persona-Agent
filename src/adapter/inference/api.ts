/** 模型协议适配：Chat Completions、可用性探测、超时取消及实际请求观察。 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { type LanguageModel } from '../../application/inference/usecase.js';
import { type ModelInput } from '../../application/inference/model.js';
import { type ModelTraceObserver } from '../../application/inspection/usecase.js';

export interface CompatibleLanguageModelOptions {
  baseUrl: string;
  model: string;
  apiKey?: string;
  timeoutMs?: number;
  temperature?: number;
  contextWindow?: number;
  observer?: ModelTraceObserver;
}

export class CompatibleLanguageModel implements LanguageModel {
  private readonly completionsUrl: URL;
  private readonly modelsUrl: URL;

  constructor(private readonly options: CompatibleLanguageModelOptions) {
    const base = new URL(options.baseUrl);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new Error('模型地址格式不正确。');
    if (!options.model.trim()) throw new Error('请配置模型名称。');
    base.search = '';
    base.hash = '';
    const prefix = base.pathname.replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
    this.completionsUrl = new URL(base);
    this.completionsUrl.pathname = `${prefix}/chat/completions`;
    this.modelsUrl = new URL(base);
    this.modelsUrl.pathname = `${prefix}/models`;
  }

  async generateText(input: ModelInput): Promise<string> {
    return this.generate(input, false);
  }

  async generateStructured(input: ModelInput): Promise<unknown> {
    const text = await this.generate(input, true);
    try { return JSON.parse(text); } catch { throw new Error('模型未返回有效的结构化内容。'); }
  }

  async isAvailable(): Promise<boolean> {
    const signal = AbortSignal.timeout(Math.min(this.options.timeoutMs ?? 120_000, 5_000));
    try {
      const response = await fetch(this.modelsUrl, { headers: this.headers(), signal });
      if (!response.ok) { await response.body?.cancel(); return false; }
      const payload: unknown = await response.json();
      if (!payload || typeof payload !== 'object' || !Array.isArray((payload as { data?: unknown }).data)) return false;
      return (payload as { data: unknown[] }).data.some(item => !!item && typeof item === 'object' && (item as { id?: unknown }).id === this.options.model);
    } catch { return false; }
  }

  private headers(): Record<string, string> {
    return { 'Content-Type': 'application/json', ...(this.options.apiKey ? { Authorization: `Bearer ${this.options.apiKey}` } : {}) };
  }

  private async generate(input: ModelInput, structured: boolean): Promise<string> {
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 120_000);
    const signal = input.signal ? AbortSignal.any([timeout, input.signal]) : timeout;
    const body = {
      model: this.options.model,
      messages: [{ role: 'system', content: input.instructions }, ...input.messages],
      max_tokens: input.maxOutputTokens, stream: false,
      ...(this.options.temperature === undefined ? {} : { temperature: this.options.temperature }),
      ...(structured ? { response_format: { type: 'json_object' } } : {}),
    };
    const trace = this.options.observer?.begin(input.purpose, body);
    try {
      const response = await fetch(this.completionsUrl, {
        method: 'POST', headers: this.headers(), signal,
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new ModelRequestError(`模型请求失败（HTTP ${response.status}）。`);
      }
      const payload = await response.json() as { choices?: { finish_reason?: string; message?: { content?: unknown } }[] };
      const choice = payload?.choices?.[0];
      if (choice?.finish_reason === 'length') throw new ModelRequestError('模型回复超过输出长度，请调整模型配置后重试。');
      const content = choice?.message?.content;
      if (typeof content !== 'string' || !content.trim()) throw new ModelRequestError('模型返回了空回复。');
      trace?.complete(content);
      return content;
    } catch (error) {
      trace?.fail();
      if (input.signal?.aborted) throw new Error('模型请求已取消。');
      if (timeout.aborted) throw new Error('模型响应超时，请稍后重试。');
      if (error instanceof ModelRequestError) throw new Error(error.message);
      throw new Error('无法连接模型或读取模型回复，请检查服务配置。');
    }
  }
}

class ModelRequestError extends Error {}

/** 前端模型设置接口；实际切换通过装配注入的用例执行。 */
export interface ModelSettingsEndpoint { get(): unknown; set(provider: string): Promise<void> }

export async function handleModelSettingsRequest(
  request: IncomingMessage, response: ServerResponse, origins: ReadonlySet<string>, settings?: ModelSettingsEndpoint,
): Promise<boolean> {
  if (request.url !== '/settings/model' || !settings) return false;
  const origin = request.headers.origin;
  if (!origin || !origins.has(origin)) { response.writeHead(403); response.end('{}'); return true; }
  response.setHeader('Access-Control-Allow-Origin', origin);
  response.setHeader('Vary', 'Origin');
  if (request.method === 'GET') { response.end(JSON.stringify(settings.get())); return true; }
  if (request.method === 'POST') {
    try {
      let body = '';
      for await (const chunk of request) { body += chunk; if (body.length > 1024) throw new Error('请求过大。'); }
      await settings.set(JSON.parse(body).provider);
      response.end(JSON.stringify(settings.get()));
    } catch (error) { response.writeHead(400); response.end(JSON.stringify({ error: error instanceof Error ? error.message : '切换失败。' })); }
    return true;
  }
  response.writeHead(405); response.end('{}'); return true;
}
