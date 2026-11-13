import { WebSocket } from 'ws';
import type { Conversation, Message } from '../../domain/conversation.js';
import type { ChatEvent } from '../../service/contracts.js';
import { encodeEvent, messageFrame, type ServerFrame } from './protocol.js';

export interface ChatRuntime {
  readonly online: boolean;
  getConversation(): Promise<Conversation>;
  acceptMessage(conversationId: string, id: string, text: string): Promise<void>;
  subscribe(listener: (event: ChatEvent) => void): () => void;
}

export interface ChatHistory {
  getCursor(conversationId: string): Promise<number>;
  readPage(conversationId: string, options: { afterSequence: number; throughSequence?: number; limit?: number }): Promise<Message[]>;
}

export class ChatConnection {
  private conversationId?: string;
  private unsubscribe?: () => void;
  private replaying = false;
  private buffered: ChatEvent[] = [];
  private lastSequence = 0;
  private disposed = false;

  constructor(private readonly socket: WebSocket, private readonly runtime: ChatRuntime, private readonly history: ChatHistory) {
    this.send({ type: 'presence', online: false });
  }

  async hello(): Promise<void> {
    if (this.disposed) return;
    if (this.conversationId && !this.replaying) { this.send({ type: 'presence', online: this.runtime.online }); return; }
    const conversation = await this.runtime.getConversation();
    if (this.disposed) return;
    this.conversationId = conversation.id;
    this.replaying = true;
    this.unsubscribe = this.runtime.subscribe(event => this.onEvent(event));
    try {
      const throughSequence = await this.history.getCursor(conversation.id);
      while (!this.disposed && this.lastSequence < throughSequence) {
        const messages = await this.history.readPage(conversation.id, { afterSequence: this.lastSequence, throughSequence, limit: 200 });
        if (!messages.length) break;
        this.send({ type: 'history', messages: messages.map(messageFrame) });
        this.lastSequence = messages.at(-1)!.sequence;
      }
      if (this.disposed) return;
      const events = this.buffered;
      this.buffered = [];
      const messages = events.filter((event): event is Extract<ChatEvent, { kind: 'message_saved' }> => event.kind === 'message_saved').sort((a, b) => a.message.sequence - b.message.sequence);
      for (const event of messages) this.sendMessage(event.message);
      let typing: boolean | undefined;
      for (const event of events) {
        if (event.kind === 'reply_started') typing = true;
        if (event.kind === 'message_saved' && event.message.role === 'assistant') typing = false;
        if (event.kind === 'reply_failed') { typing = false; this.send(encodeEvent(event)); }
      }
      this.replaying = false;
      this.send({ type: 'presence', online: this.runtime.online });
      if (typing !== undefined) this.send({ type: 'typing', active: typing });
    } catch (error) {
      this.unsubscribe?.(); this.unsubscribe = undefined;
      this.conversationId = undefined; this.replaying = false; this.buffered = []; this.lastSequence = 0;
      throw error;
    }
  }

  async accept(id: string, text: string): Promise<void> {
    if (!this.conversationId || this.replaying) throw new Error('请先完成聊天连接。');
    await this.runtime.acceptMessage(this.conversationId, id, text);
  }

  error(text: string): void { this.send({ type: 'error', text }); }

  dispose(): void {
    this.disposed = true; this.unsubscribe?.(); this.unsubscribe = undefined; this.buffered = [];
  }

  private onEvent(event: ChatEvent): void {
    if (this.disposed || (event.kind !== 'availability' && event.conversationId !== this.conversationId)) return;
    if (this.replaying) { this.buffered.push(event); return; }
    if (event.kind === 'message_saved') this.sendMessage(event.message);
    else this.send(encodeEvent(event));
  }

  private sendMessage(message: Message): void {
    if (message.sequence <= this.lastSequence) return;
    this.send(messageFrame(message)); this.lastSequence = message.sequence;
  }

  private send(frame: ServerFrame): void {
    if (this.disposed || this.socket.readyState !== WebSocket.OPEN) return;
    try { this.socket.send(JSON.stringify(frame), () => {}); } catch { this.dispose(); }
  }
}
