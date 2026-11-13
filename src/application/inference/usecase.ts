/** 模型用例与非存储能力接口：生成、可用性检测及模型选择恢复和切换。 */
import { type ModelInput, type ModelProvider } from './model.js';
import { type ModelSelectionRepository } from './repository.js';

export interface LanguageModel {
  /** 通过当前选中的来源生成文本。 */
  generateText(input: ModelInput): Promise<string>;
  /** 通过当前选中的来源生成结构化结果。 */
  generateStructured(input: ModelInput): Promise<unknown>;
  isAvailable(): Promise<boolean>;
}

export class ModelRouter implements LanguageModel {
  private provider: ModelProvider = 'local';
  constructor(private readonly models: { local: LanguageModel; deepseek?: LanguageModel }, private readonly selection: ModelSelectionRepository) {}
  /** 恢复持久化的模型选择，暂时离线不会静默切换其他来源。 */
  async initialize(): Promise<void> { this.provider = await this.selection.get() ?? 'local'; }
  /** 只返回来源与配置状态，不返回地址、鉴权信息或密钥。 */
  getSettings() { return { provider: this.provider, deepseekConfigured: !!this.models.deepseek }; }
  /** 目标可用后先持久化再启用；任何失败均保留当前选择。 */
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
  /** 通过当前选中的来源生成文本。 */
  generateText(input: ModelInput) { return this.current().generateText(input); }
  /** 通过当前选中的来源生成结构化结果。 */
  generateStructured(input: ModelInput) { return this.current().generateStructured(input); }
  /** 所选模型未配置时返回离线。 */
  async isAvailable() { return this.models[this.provider]?.isAvailable() ?? false; }
}
