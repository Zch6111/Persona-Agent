/** 生成业务模型：统一输入与模型来源；不包含第三方协议字段和网络实现。 */

export interface ModelInput {
  purpose: 'reply' | 'memory';
  instructions: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  maxOutputTokens: number;
  signal?: AbortSignal;
}

/** 已支持的模型来源；切换不改变对话与记忆归属。 */
export type ModelProvider = 'local' | 'deepseek';
