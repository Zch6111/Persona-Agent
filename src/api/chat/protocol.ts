import type { Message } from '../../domain/conversation.js';
import type { ChatEvent } from '../../service/contracts.js';

export type ClientFrame = { type: 'hello'; name: string } | { type: 'msg'; id: string; text: string };
export type ServerFrame =
  | { type: 'msg'; id: string; role: 'user' | 'assistant'; text: string; ts: string; seq: number }
  | { type: 'history'; messages: ReturnType<typeof messageFrame>[] }
  | { type: 'presence'; online: boolean }
  | { type: 'typing'; active: boolean }
  | { type: 'error'; text: string };

export function parseFrame(raw: string): ClientFrame {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('消息不是有效的 JSON。'); }
  if (!value || typeof value !== 'object') throw new Error('消息格式不正确。');
  const frame = value as Record<string, unknown>;
  if (frame.type === 'hello' && typeof frame.name === 'string' && frame.name.trim() && frame.name.length <= 120) return { type: 'hello', name: frame.name };
  if (frame.type === 'msg' && typeof frame.id === 'string' && frame.id.trim() && frame.id.length <= 200 && typeof frame.text === 'string' && frame.text.trim() && frame.text.length <= 32_000) {
    return { type: 'msg', id: frame.id, text: frame.text };
  }
  throw new Error('消息格式不正确或消息过长。');
}

export function messageFrame(message: Message): { type: 'msg'; id: string; role: 'user' | 'assistant'; text: string; ts: string; seq: number } {
  return { type: 'msg', id: message.id, role: message.role, text: message.text, ts: message.createdAt, seq: message.sequence };
}

export function encodeEvent(event: ChatEvent): ServerFrame {
  switch (event.kind) {
    case 'message_saved': return messageFrame(event.message);
    case 'reply_started': return { type: 'typing', active: true };
    case 'reply_failed': return { type: 'error', text: event.text };
    case 'availability': return { type: 'presence', online: event.online };
  }
}
