/** 依赖装配：创建外部实现并注入内部业务，统一管理资源启动和关闭。 */
import { resolve } from 'node:path';
import { SqliteDatabase, acquireInstanceLock } from './database.js';
import { SqliteConversationRepository } from '../conversation/db.js';
import { SqliteMemoryRepository } from '../memory/db.js';
import { JsonCharacterRepository, JsonReferenceRepository, FilePromptRepository } from '../persona/db.js';
import { CompatibleLanguageModel } from '../inference/api.js';
import { createApiServer } from './server.js';
import { ChatService, ContextBuilder, HistoryService, AgentRuntime } from '../../application/conversation/usecase.js';
import { MemoryService } from '../../application/memory/usecase.js';
import { type AgentConfig } from './config.js';
import { type LanguageModel, ModelRouter } from '../../application/inference/usecase.js';
import { FileModelSelectionRepository } from '../inference/db.js';
import { InspectionService } from '../../application/inspection/usecase.js';
import { InMemoryInspectionRepository } from '../inspection/db.js';
import { PersonaService } from '../../application/persona/usecase.js';
import { NodeTaskScheduler } from './scheduler.js';

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
    const persona = new PersonaService({ characters, references, prompts });
    const inspection = new InspectionService(new InMemoryInspectionRepository());
    const localModel = overrides.model ?? new CompatibleLanguageModel({ ...config.model, observer: inspection });
    const remoteModel = overrides.remoteModel ?? (config.deepseek?.apiKey ? new CompatibleLanguageModel({ ...config.model, baseUrl: config.deepseek.baseUrl ?? 'https://api.deepseek.com', model: config.deepseek.model, apiKey: config.deepseek.apiKey, observer: inspection }) : undefined);
    const model = new ModelRouter({ local: localModel, deepseek: remoteModel }, new FileModelSelectionRepository(`${config.database}.model.json`));
    const memory = new MemoryService({ conversations, memories, model, prompts: { get: name => persona.getPrompt(name) }, settings: config.settings, inspection });
    const context = new ContextBuilder({ persona, conversations, memories: memory, settings: config.settings });
    const chat = new ChatService({ conversations, context, model, settings: config.settings });
    const history = new HistoryService(conversations);
    const runtime = new AgentRuntime({ chat, memory, conversations, settings: config.settings, scheduler: new NodeTaskScheduler(), onWarning: overrides.onWarning });
    const server = createApiServer({ runtime, history, host: config.host, port: config.port, allowedOrigins: config.allowedOrigins,
      inspect: async () => inspection.inspect(await runtime.getConversation(), { conversations, memories }), modelSettings: {
      get: () => model.getSettings(),
      set: value => runtime.changeModel(() => model.select(value)),
    } });
    let closed = false;
    return {
      runtime, history, conversations, memories,
      async start() {
        try {
          await model.initialize();
          await persona.validateAssets(config.settings.scope.characterId);
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
