export interface PromptRepository { get(name: 'reply' | 'memory'): Promise<string> }
