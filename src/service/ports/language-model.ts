import type { ModelInput } from '../contracts.js';
export interface LanguageModel {
  generateText(input: ModelInput): Promise<string>;
  generateStructured(input: ModelInput): Promise<unknown>;
  isAvailable(): Promise<boolean>;
}
