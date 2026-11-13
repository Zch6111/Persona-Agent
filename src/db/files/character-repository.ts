import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validateCharacter, type CharacterProfile } from '../../domain/character.js';
import type { CharacterRepository } from '../../service/ports/character-repository.js';

export class JsonCharacterRepository implements CharacterRepository {
  constructor(private readonly directory: string) {}

  async get(characterId: string): Promise<CharacterProfile> {
    if (!/^[\w-]+$/.test(characterId)) throw new Error('角色 ID 格式不正确。');
    const profile = validateCharacter(JSON.parse(await readFile(join(this.directory, `${characterId}.json`), 'utf8')));
    if (profile.id !== characterId) throw new Error('角色资料 ID 与文件不匹配。');
    return profile;
  }
}
