/** 资料读取契约：角色、参考和提示词的来源与存储形式由 adapter 决定。 */
import { type CharacterProfile, type SpeechReference, type PromptPurpose } from './model.js';

export interface CharacterRepository { get(characterId: string): Promise<CharacterProfile> }

export interface ReferenceRepository {
  getAnchors(characterId: string): Promise<SpeechReference[]>;
  search(characterId: string, query: string, limit: number): Promise<SpeechReference[]>;
}

export interface PromptRepository { get(name: PromptPurpose): Promise<string> }
