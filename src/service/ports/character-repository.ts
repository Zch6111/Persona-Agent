import type { CharacterProfile } from '../../domain/character.js';
export interface CharacterRepository { get(characterId: string): Promise<CharacterProfile> }
