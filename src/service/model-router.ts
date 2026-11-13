import type { LanguageModel } from './ports/language-model.js';
import type { ModelSelectionRepository, ModelProvider } from './ports/model-selection-repository.js';
import type { ModelInput } from './contracts.js';

export class ModelRouter implements LanguageModel {
  private provider: ModelProvider = 'local';
  constructor(private readonly models: { local: LanguageModel; deepseek?: LanguageModel }, private readonly selection: ModelSelectionRepository) {}
  async initialize(): Promise<void> { this.provider = await this.selection.get() ?? 'local'; }
  getSettings() { return { provider: this.provider, deepseekConfigured: !!this.models.deepseek }; }
  async select(value: string): Promise<void> {
    if (value !== 'local' && value !== 'deepseek') throw new Error('不支持的模型来源。');
    const model = this.models[value];
    if (!model) throw new Error('请先配置 API 密钥。');
    if (!await model.isAvailable()) throw new Error('目标模型暂不可用，请检查模型服务或 API 配置。');
    await this.selection.set(value);
    this.provider = value;
  }
  private current(): LanguageModel {
    const model = this.models[this.provider];
    if (!model) throw new Error('所选模型尚未配置，请切换模型来源。');
    return model;
  }
  generateText(input: ModelInput) { return this.current().generateText(input); }
  generateStructured(input: ModelInput) { return this.current().generateStructured(input); }
  async isAvailable() { return this.models[this.provider]?.isAvailable() ?? false; }
}
