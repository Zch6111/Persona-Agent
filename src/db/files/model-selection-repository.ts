import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ModelProvider, ModelSelectionRepository } from '../../service/ports/model-selection-repository.js';

export class FileModelSelectionRepository implements ModelSelectionRepository {
  constructor(private readonly file: string) {}
  async get(): Promise<ModelProvider | undefined> {
    try {
      const value = JSON.parse(await readFile(this.file, 'utf8'));
      if (value.provider !== 'local' && value.provider !== 'deepseek') throw new Error('模型选择记录不正确。');
      return value.provider;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }
  async set(provider: ModelProvider): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ provider }), { mode: 0o600 });
    await rename(temporary, this.file);
  }
}
