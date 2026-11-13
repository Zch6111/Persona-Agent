/** 模型选择存储契约；仅持久化来源选择，不包含网络调用或密钥。 */
import { type ModelProvider } from './model.js';

export interface ModelSelectionRepository {
  get(): Promise<ModelProvider | undefined>;
  set(provider: ModelProvider): Promise<void>;
}
