import type { WebSocket } from 'ws';
import { ChatConnection, type ChatHistory, type ChatRuntime } from './connection.js';
import { parseFrame } from './protocol.js';

export class ChatWebSocketController {
  constructor(private readonly runtime: ChatRuntime, private readonly history: ChatHistory) {}

  connect(socket: WebSocket): void {
    const connection = new ChatConnection(socket, this.runtime, this.history);
    let queue = Promise.resolve();
    socket.on('message', (data, binary) => {
      queue = queue.then(async () => {
        if (binary) throw new Error('聊天仅支持文本消息。');
        const frame = parseFrame(data.toString());
        if (frame.type === 'hello') await connection.hello();
        else await connection.accept(frame.id, frame.text);
      }).catch(() => connection.error('消息处理失败，请检查消息格式或稍后重试。'));
    });
    socket.on('error', () => connection.dispose());
    socket.on('close', () => connection.dispose());
  }
}
