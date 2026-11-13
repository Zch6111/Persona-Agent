/** 只读观察 HTTP 适配：校验来源、本机 Host 和请求方法，再调用观察用例。 */
import type { IncomingMessage, ServerResponse } from 'node:http';

export async function handleInspectionRequest(
  request: IncomingMessage, response: ServerResponse, origins: ReadonlySet<string>, inspect?: () => Promise<unknown>,
): Promise<boolean> {
  if (request.url !== '/inspect' || !inspect) return false;
  const origin = request.headers.origin;
  let localHost = false;
  try { localHost = ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(`http://${request.headers.host}`).hostname); } catch {}
  if (!origin || !origins.has(origin) || !localHost) { response.writeHead(403); response.end('{}'); return true; }
  response.setHeader('Access-Control-Allow-Origin', origin); response.setHeader('Vary', 'Origin');
  if (request.method !== 'GET') { response.writeHead(405); response.end('{}'); return true; }
  try { response.end(JSON.stringify(await inspect())); }
  catch { response.writeHead(500); response.end(JSON.stringify({ error: '暂时无法读取运行状态。' })); }
  return true;
}
