export interface CharacterProfile {
  id: string;
  name: string;
  version: number;
  background: string;
  speakingStyle: string;
  relationship: string;
}

export function validateCharacter(value: unknown): CharacterProfile {
  const item = value as Partial<CharacterProfile> | null;
  if (!item || !['id', 'name', 'background', 'speakingStyle', 'relationship'].every(key => typeof (item as Record<string, unknown>)[key] === 'string') || !item.id?.trim() || !item.name?.trim() || !Number.isInteger(item.version) || Number(item.version) < 1) {
    throw new Error('角色资料格式不正确。');
  }
  return item as CharacterProfile;
}
