/** 文件资料仓库：按使用重新读取 JSON 角色与参考、Markdown 提示词。 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validateCharacter, type CharacterProfile, type SpeechReference } from '../../application/persona/model.js';
import { type CharacterRepository, type ReferenceRepository, type PromptRepository } from '../../application/persona/repository.js';
import { scoreText, searchTerms } from '../platform/search.js';

export class JsonCharacterRepository implements CharacterRepository {
  constructor(private readonly directory: string) {}

  async get(characterId: string): Promise<CharacterProfile> {
    if (!/^[\w-]+$/.test(characterId)) throw new Error('角色 ID 格式不正确。');
    const profile = validateCharacter(JSON.parse(await readFile(join(this.directory, `${characterId}.json`), 'utf8')));
    if (profile.id !== characterId) throw new Error('角色资料 ID 与文件不匹配。');
    return profile;
  }
}

type ObjectValue = Record<string, unknown>;
const kinds: SpeechReference['kind'][] = ['dialogue', 'voice', 'story', 'summary', 'example'];
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('参考语料格式不正确。');
  return value as ObjectValue;
}
function string(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`参考语料缺少 ${field}。`);
  return value;
}

export class JsonReferenceRepository implements ReferenceRepository {
  constructor(private readonly directory: string) {}

  async getAnchors(characterId: string): Promise<SpeechReference[]> {
    return (await this.load(characterId)).filter(entry => entry.anchor);
  }

  async search(characterId: string, query: string, limit: number): Promise<SpeechReference[]> {
    const entries = (await this.load(characterId)).filter(entry => !entry.anchor);
    const terms = searchTerms(query);
    if (!terms.length) return query.trim() ? [] : entries.slice(0, limit);
    return entries.map(entry => ({ entry, score: scoreText([entry.title, entry.context, entry.era, entry.relationship, ...(entry.tags ?? []), entry.text, ...(entry.turns ?? []).map(turn => turn.text)].filter(Boolean).join('\n'), terms) }))
      .filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id))
      .slice(0, limit).map(item => item.entry);
  }

  private async load(characterId: string): Promise<SpeechReference[]> {
    if (!/^[\w-]+$/.test(characterId)) throw new Error('角色 ID 格式不正确。');
    const data = object(JSON.parse(await readFile(join(this.directory, `${characterId}.json`), 'utf8')));
    if (!Array.isArray(data.sources) || !Array.isArray(data.excerpts)) throw new Error('参考语料缺少 sources 或 excerpts。');
    const sources = new Map<string, SpeechReference['source']>();
    for (const raw of data.sources) {
      const value = object(raw);
      const id = string(value.id, 'source.id');
      if (sources.has(id)) throw new Error('参考语料来源 ID 重复。');
      sources.set(id, { id, title: string(value.title, 'source.title'), origin: string(value.origin, 'source.origin'), ...(typeof value.url === 'string' ? { url: value.url } : {}) });
    }
    const ids = new Set<string>();
    return data.excerpts.map(raw => {
      const value = object(raw);
      const id = string(value.id, 'id');
      if (ids.has(id)) throw new Error('参考语料片段 ID 重复。');
      ids.add(id);
      const source = sources.get(string(value.sourceId, 'sourceId'));
      if (!source) throw new Error('参考语料来源不存在。');
      if (!kinds.includes(value.kind as SpeechReference['kind'])) throw new Error('参考语料类型不正确。');
      const turns = value.turns === undefined ? undefined : (() => {
        if (!Array.isArray(value.turns)) throw new Error('参考语料对白格式不正确。');
        return value.turns.map(rawTurn => { const turn = object(rawTurn); return { speaker: string(turn.speaker, 'speaker'), text: string(turn.text, 'turn.text') }; });
      })();
      const text = typeof value.text === 'string' && value.text.trim() ? value.text : undefined;
      if (!text && !turns?.length) throw new Error('参考语料片段内容不能为空。');
      const kind = value.kind as SpeechReference['kind'];
      if (value.anchor === true && (!['dialogue', 'voice', 'example'].includes(kind) || !turns?.some(turn => turn.speaker === data.targetSpeaker))) throw new Error('固定表达示例必须包含目标角色的对白。');
      return { id, characterId, kind, title: string(value.title, 'title'), source, anchor: value.anchor === true, ...(text ? { text } : {}), ...(turns ? { turns } : {}), ...(typeof value.context === 'string' ? { context: value.context } : {}), ...(typeof value.era === 'string' ? { era: value.era } : {}), ...(typeof value.relationship === 'string' ? { relationship: value.relationship } : {}), ...(Array.isArray(value.tags) && value.tags.every(tag => typeof tag === 'string') ? { tags: value.tags as string[] } : {}) };
    });
  }
}

export class FilePromptRepository implements PromptRepository {
  constructor(private readonly directory: string) {}
  async get(name: 'reply' | 'memory'): Promise<string> {
    if (!['reply', 'memory'].includes(name)) throw new Error('提示词模板不存在。');
    return readFile(join(this.directory, `${name}.md`), 'utf8');
  }
}
