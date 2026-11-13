/** 角色资料用例：统一读取角色、提示词，并选择有出处的固定与相关参考。 */
import { validateCharacter } from './model.js';
import type { PromptPurpose } from './model.js';
import type { CharacterRepository, ReferenceRepository, PromptRepository } from './repository.js';

export class PersonaService {
  constructor(private readonly deps: { characters: CharacterRepository; references: ReferenceRepository; prompts: PromptRepository }) {}

  /** 每次读取最新资料并验证身份，不缓存，保留资料热更新能力。 */
  async getCharacter(characterId: string) {
    const profile = validateCharacter(await this.deps.characters.get(characterId));
    if (profile.id !== characterId) throw new Error('角色资料 ID 与请求不匹配。');
    return profile;
  }

  /** 固定表达锚点优先，相关片段按当前输入检索。 */
  async selectReferences(characterId: string, query: string, limit = 2) {
    const [anchors, related] = await Promise.all([
      this.deps.references.getAnchors(characterId), this.deps.references.search(characterId, query, limit),
    ]);
    return [...new Map([...anchors, ...related].map(reference => [reference.id, reference])).values()];
  }

  /** 获取指定用途的模板，具体文件格式与路径由仓库实现决定。 */
  getPrompt(purpose: PromptPurpose) { return this.deps.prompts.get(purpose); }

  /** 启动时预检固定资料，尽早报告缺失或无效的文件。 */
  async validateAssets(characterId: string): Promise<void> {
    await this.getCharacter(characterId);
    await this.deps.references.getAnchors(characterId);
    await this.getPrompt('reply');
    await this.getPrompt('memory');
  }
}
