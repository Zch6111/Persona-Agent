import type { SpeechReference } from '../../domain/reference.js';
export interface ReferenceRepository {
  getAnchors(characterId: string): Promise<SpeechReference[]>;
  search(characterId: string, query: string, limit: number): Promise<SpeechReference[]>;
}
