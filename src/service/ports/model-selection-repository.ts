export type ModelProvider = 'local' | 'deepseek';
export interface ModelSelectionRepository {
  get(): Promise<ModelProvider | undefined>;
  set(provider: ModelProvider): Promise<void>;
}
