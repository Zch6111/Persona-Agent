/** HTTP/WebSocket 服务承载：监听、路由、来源校验、健康检查与关闭。 */
import { handleInspectionRequest } from '../inspection/api.js';
import { handleModelSettingsRequest } from '../inference/api.js';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { ChatWebSocketController, type ChatHistory, type ChatRuntime } from '../conversation/api.js';

export interface ApiServerOptions {
  inspect?: () => Promise<unknown>;
  modelSettings?: { get(): unknown; set(provider: string): Promise<void> };
  runtime: ChatRuntime;
  history: ChatHistory;
  host?: string;
  port?: number;
  allowedOrigins: string[];
}

export function createApiServer(options: ApiServerOptions): { listen(): Promise<{ host: string; port: number }>; close(): Promise<void> } {
  const host = options.host ?? '127.0.0.1';
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) throw new Error('聊天服务只允许监听本机地址。');
  const origins = new Set(options.allowedOrigins);
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    if (await handleInspectionRequest(request, response, origins, options.inspect)) return;
    if (await handleModelSettingsRequest(request, response, origins, options.modelSettings)) return;
    if (request.url === '/health'  && request.method === 'GET') {
      response.writeHead(200); response.end(JSON.stringify({ service: 'gameAgent', online: options.runtime.online }));
    } else { response.writeHead(404); response.end(JSON.stringify({ error: 'Not found' })); }
  });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const controller = new ChatWebSocketController(options.runtime, options.history);
  sockets.on('connection', socket => controller.connect(socket));
  server.on('upgrade', (request, socket, head) => {
    const origin = request.headers.origin;
    let validHost = false;
    try { validHost = ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(`http://${request.headers.host}`).hostname); } catch { /* Rejected below. */ }
    if (request.url !== '/ws/chat' || !origin || !origins.has(origin) || !validHost) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    sockets.handleUpgrade(request, socket, head, websocket => sockets.emit('connection', websocket, request));
  });
  return {
    listen: () => new Promise((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once('error', onError);
      server.listen(options.port ?? 8000, host, () => {
        server.off('error', onError);
        const address = server.address();
        if (!address || typeof address === 'string') { reject(new Error('无法读取聊天监听地址。')); return; }
        resolve({ host, port: address.port });
      });
    }),
    close: async () => {
      for (const client of sockets.clients) client.terminate();
      await new Promise<void>(resolve => sockets.close(() => resolve()));
      if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}
