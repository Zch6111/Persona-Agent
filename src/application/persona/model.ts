/** 角色业务模型：角色身份、关系、表达特征及带出处的原作参考。 */

export interface CharacterProfile {
  id: string;
  name: string;
  version: number;
  background: string;
  speakingStyle: string;
  relationship: string;
}

/** 提示词的业务用途，与 JSON/Markdown 等存储格式无关。 */
export type PromptPurpose = 'reply' | 'memory';

export function validateCharacter(value: unknown): CharacterProfile {
  const item = value as Partial<CharacterProfile> | null;
  if (!item || !['id', 'name', 'background', 'speakingStyle', 'relationship'].every(key => typeof (item as Record<string, unknown>)[key] === 'string') || !item.id?.trim() || !item.name?.trim() || !Number.isInteger(item.version) || Number(item.version) < 1) {
    throw new Error('角色资料格式不正确。');
  }
  return item as CharacterProfile;
}

export interface SpeechReference {
  id: string;
  characterId: string;
  kind: 'dialogue' | 'voice' | 'story' | 'summary' | 'example';
  title: string;
  source: { id: string; title: string; origin: string; url?: string };
  text?: string;
  turns?: { speaker: string; text: string }[];
  context?: string;
  era?: string;
  relationship?: string;
  tags?: string[];
  anchor: boolean;
}
