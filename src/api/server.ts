import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { ChatWebSocketController } from './chat/controller.js';
import type { ChatHistory, ChatRuntime } from './chat/connection.js';

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
    if (request.url === '/inspect' && options.inspect) {
      const origin = request.headers.origin;
      let localHost = false;
      try { localHost = ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(`http://${request.headers.host}`).hostname); } catch {}
      if (!origin || !origins.has(origin) || !localHost) { response.writeHead(403); response.end('{}'); return; }
      response.setHeader('Access-Control-Allow-Origin', origin); response.setHeader('Vary', 'Origin');
      if (request.method !== 'GET') { response.writeHead(405); response.end('{}'); return; }
      try { response.end(JSON.stringify(await options.inspect())); }
      catch { response.writeHead(500); response.end(JSON.stringify({ error: '暂时无法读取运行状态。' })); }
      return;
    }
    if (request.url === '/settings/model' && options.modelSettings) {
      const origin = request.headers.origin;
      if (!origin || !origins.has(origin)) { response.writeHead(403); response.end('{}'); return; }
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Vary', 'Origin');
      if (request.method === 'GET') { response.end(JSON.stringify(options.modelSettings.get())); return; }
      if (request.method === 'POST') {
        try {
          let body = '';
          for await (const chunk of request) { body += chunk; if (body.length > 1024) throw new Error('请求过大。'); }
          await options.modelSettings.set(JSON.parse(body).provider);
          response.end(JSON.stringify(options.modelSettings.get()));
        } catch (error) { response.writeHead(400); response.end(JSON.stringify({ error: error instanceof Error ? error.message : '切换失败。' })); }
        return;
      }
      response.writeHead(405); response.end('{}'); return;
    }
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
