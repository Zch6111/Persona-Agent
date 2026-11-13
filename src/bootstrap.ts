import { resolve } from 'node:path';
import { SqliteDatabase } from './db/sqlite/database.js';
import { acquireInstanceLock } from './db/sqlite/instance-lock.js';
import { SqliteConversationRepository } from './db/sqlite/conversation-repository.js';
import { SqliteMemoryRepository } from './db/sqlite/memory-repository.js';
import { JsonCharacterRepository } from './db/files/character-repository.js';
import { JsonReferenceRepository } from './db/files/reference-repository.js';
import { FilePromptRepository } from './db/files/prompt-repository.js';
import { CompatibleLanguageModel } from './api/models/compatible-language-model.js';
import { createApiServer } from './api/server.js';
import { ChatService } from './service/chat-service.js';
import { ContextBuilder } from './service/context-builder.js';
import { MemoryService } from './service/memory-service.js';
import { HistoryService } from './service/history-service.js';
import { AgentRuntime } from './service/agent-runtime.js';
import type { AgentConfig } from './config.js';
import type { LanguageModel } from './service/ports/language-model.js';
import { ModelRouter } from './service/model-router.js';
import { FileModelSelectionRepository } from './db/files/model-selection-repository.js';
import { InspectionService } from './service/inspection-service.js';

export function createApplication(config: AgentConfig, overrides: { model?: LanguageModel; remoteModel?: LanguageModel; onWarning?: (text: string) => void } = {}) {
  const releaseLock = acquireInstanceLock(config.database);
  let database: SqliteDatabase;
  try { database = new SqliteDatabase(config.database); } catch (error) { releaseLock(); throw error; }
  try {
    const conversations = new SqliteConversationRepository(database);
    const memories = new SqliteMemoryRepository(database);
    const characters = new JsonCharacterRepository(resolve(config.root, 'assets/characters'));
    const references = new JsonReferenceRepository(resolve(config.root, 'assets/references'));
    const prompts = new FilePromptRepository(resolve(config.root, 'assets/prompts'));
    const inspection = new InspectionService();
    const localModel = overrides.model ?? new CompatibleLanguageModel({ ...config.model, observer: inspection });
    const remoteModel = overrides.remoteModel ?? (config.deepseek?.apiKey ? new CompatibleLanguageModel({ ...config.model, baseUrl: config.deepseek.baseUrl ?? 'https://api.deepseek.com', model: config.deepseek.model, apiKey: config.deepseek.apiKey, observer: inspection }) : undefined);
    const model = new ModelRouter({ local: localModel, deepseek: remoteModel }, new FileModelSelectionRepository(`${config.database}.model.json`));
    const memory = new MemoryService({ conversations, memories, model, prompts, settings: config.settings, inspection });
    const context = new ContextBuilder({ characters, conversations, memories: memory, references, prompts, settings: config.settings });
    const chat = new ChatService({ conversations, context, model, settings: config.settings });
    const history = new HistoryService(conversations);
    const runtime = new AgentRuntime({ chat, memory, conversations, settings: config.settings, onWarning: overrides.onWarning });
    const server = createApiServer({ runtime, history, host: config.host, port: config.port, allowedOrigins: config.allowedOrigins, inspect: async () => {
      const conversation = await runtime.getConversation();
      const entries = await memories.list(conversation);
      const checkpoint = await memories.getCheckpoint(conversation.id);
      const lastSequence = await conversations.getLastSequence(conversation.id);
      const snapshot = inspection.snapshot();
      const sources = await Promise.all(entries.flatMap(entry => entry.sourceMessages).map(ref => conversations.getMessage(ref)));
      return { ...snapshot, memory: { ...snapshot.memory, checkpoint, lastSequence, pendingMessages: lastSequence - checkpoint, entries, sources: sources.filter(Boolean) } };
    }, modelSettings: {
      get: () => model.getSettings(),
      set: value => runtime.changeModel(() => model.select(value)),
    } });
    let closed = false;
    return {
      runtime, history, conversations, memories,
      async start() {
        try {
          await model.initialize();
          await characters.get(config.settings.scope.characterId);
          await references.getAnchors(config.settings.scope.characterId);
          await prompts.get('reply');
          await prompts.get('memory');
          const address = await server.listen();
          await runtime.start();
          return address;
        } catch (error) { await this.close(); throw error; }
      },
      async close() {
        if (closed) return;
        closed = true;
        try { await runtime.stop(); } finally {
          try { await server.close(); } finally {
            try { database.close(); } finally { releaseLock(); }
          }
        }
      },
    };
  } catch (error) {
    try { database.close(); } finally { releaseLock(); }
    throw error;
  }
}
