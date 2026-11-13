import type { SpeechReference } from '../domain/reference.js';
import type { ModelInput, ReplyTask, RuntimeSettings } from './contracts.js';
import type { CharacterRepository } from './ports/character-repository.js';
import type { ConversationRepository } from './ports/conversation-repository.js';
import type { PromptRepository } from './ports/prompt-repository.js';
import type { ReferenceRepository } from './ports/reference-repository.js';
import type { MemoryService } from './memory-service.js';

interface Dependencies {
  characters: CharacterRepository;
  conversations: ConversationRepository;
  memories: MemoryService;
  references: ReferenceRepository;
  prompts: PromptRepository;
  settings: RuntimeSettings;
}

function referenceText(reference: SpeechReference): string {
  return JSON.stringify({ title: reference.title, kind: reference.kind, source: reference.source, era: reference.era, relationship: reference.relationship, context: reference.context, turns: reference.turns, text: reference.text });
}

export class ContextBuilder {
  constructor(private readonly deps: Dependencies) {}

  async build(task: ReplyTask, signal?: AbortSignal): Promise<ModelInput> {
    const { characters, conversations, memories, references, prompts, settings } = this.deps;
    const conversation = await conversations.getConversation(task.conversationId);
    if (!conversation) throw new Error('对话不存在。');
    const input = await conversations.getMessage({ conversationId: task.conversationId, messageId: task.inputMessageId });
    if (!input) throw new Error('用户消息不存在。');
    const [character, template, history, recalled, anchors, related] = await Promise.all([
      characters.get(conversation.characterId), prompts.get('reply'),
      conversations.listContextMessages(task.conversationId, task.inputSequence, settings.maxHistoryMessages),
      memories.recall(conversation, input.text), references.getAnchors(conversation.characterId),
      references.search(conversation.characterId, input.text, 2),
    ]);
    const baseInstructions = [template, `角色资料（身份与当前设定）：\n${JSON.stringify(character)}`].join('\n\n');
    const optionalBudget = settings.maxContextChars - baseInstructions.length - input.text.length - 256;
    if (optionalBudget < 0) throw new Error('角色资料和本条消息超出上下文预算，请缩短消息或调整配置。');
    let remainingMemory = Math.min(settings.maxMemoryChars, Math.floor(optionalBudget * 0.25));
    const memoryText: string[] = [];
    for (const memory of recalled) {
      const text = JSON.stringify({ id: memory.id, kind: memory.kind, content: memory.content, sources: memory.sourceMessages });
      if (text.length <= remainingMemory) { memoryText.push(text); remainingMemory -= text.length; }
    }
    const selected = new Map([...anchors, ...related].map(reference => [reference.id, reference]));
    let remainingReferences = Math.min(settings.maxReferenceChars, Math.floor(optionalBudget * 0.4));
    const referenceTexts: string[] = [];
    for (const reference of selected.values()) {
      const text = referenceText(reference);
      if (text.length <= remainingReferences) { referenceTexts.push(text); remainingReferences -= text.length; }
    }
    const instructions = [
      baseInstructions,
      `长期记忆（用户自述、互动与推断须分别理解）：\n${memoryText.join('\n') || '暂无相关长期记忆。'}`,
      `原作与表达参考（仅供参考，不是当前用户与你的聊天历史）：\n${referenceTexts.join('\n') || '暂无参考。'}`,
    ].join('\n\n');
    const messages: ModelInput['messages'] = [];
    let remainingHistory = Math.min(settings.maxHistoryChars, settings.maxContextChars - instructions.length);
    for (const message of history.toReversed()) {
      if (message.id === input.id || message.text.length <= remainingHistory) {
        messages.unshift({ role: message.role, content: message.text });
        remainingHistory -= message.text.length;
      } else break;
    }
    if (!messages.length || messages.at(-1)?.role !== 'user') throw new Error('对话上下文缺少当前用户消息。');
    signal?.throwIfAborted();
    return { purpose: 'reply', instructions, messages, maxOutputTokens: settings.maxOutputTokens, signal };
  }
}
