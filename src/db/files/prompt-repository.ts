import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PromptRepository } from '../../service/ports/prompt-repository.js';

export class FilePromptRepository implements PromptRepository {
  constructor(private readonly directory: string) {}
  async get(name: 'reply' | 'memory'): Promise<string> {
    if (!['reply', 'memory'].includes(name)) throw new Error('提示词模板不存在。');
    return readFile(join(this.directory, `${name}.md`), 'utf8');
  }
}
