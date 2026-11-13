/** 后端进程入口：加载配置，启动应用，响应终止信号。 */
import { loadConfig } from './config.js';
import { createApplication } from './bootstrap.js';

async function main(): Promise<void> {
  const config = await loadConfig();
  const app = createApplication(config, { onWarning: text => console.warn(text) });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await app.close();
  };
  process.once('SIGINT', () => { void stop(); });
  process.once('SIGTERM', () => { void stop(); });
  const address = await app.start();
  console.log(`角色聊天后端：http://${address.host}:${address.port}`);
  console.log(app.runtime.online ? '模型已接入。' : '模型尚未就绪；聊天历史仍可读取，模型恢复后会自动接入。');
}

main().catch(() => { console.error('后端启动失败，请检查配置、端口和数据目录。'); process.exitCode = 1; });
