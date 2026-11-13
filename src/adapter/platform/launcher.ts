/** 本机启动器：复用已有服务，只关闭本次启动器自己创建的进程。 */
import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from './config.js';
import { createApplication } from './bootstrap.js';

const config = await loadConfig();
const backendHost = config.host === '::1' ? '[::1]' : config.host;
const backendUrl = `http://${backendHost}:${config.port}`;
const uiUrl = 'http://127.0.0.1:4173/';
let app: ReturnType<typeof createApplication> | undefined;
let ui: ChildProcess | undefined;
let uiExited = false;
let stopping = false;
let cleanup: Promise<void> | undefined;

async function status(url: string, field: string, expected: unknown): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
    const body = await response.json() as Record<string, unknown>;
    return response.ok && body[field] === expected;
  } catch { return false; }
}
function stop(): Promise<void> {
  stopping = true;
  return cleanup ??= (async () => {
    if (ui && !uiExited) ui.kill('SIGTERM');
    await app?.close();
  })();
}
process.once('SIGINT', () => { void stop(); });
process.once('SIGTERM', () => { void stop(); });

try {
  const backendRunning = await status(`${backendUrl}/health`, 'service', 'gameAgent');
  if (!backendRunning) {
    app = createApplication(config, { onWarning: text => console.warn(text) });
    await app.start();
  }
  if (stopping) await stop();
  else {
    const uiRunning = await status(`${uiUrl}__local/status`, 'local', true);
    if (!uiRunning) {
      const frontend = resolve(config.root, 'src/adapter/web');
      ui = spawn(process.execPath, [resolve(frontend, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', '4173', '--strictPort'], { cwd: frontend, stdio: 'inherit' });
      ui.once('exit', () => { uiExited = true; });
      ui.once('error', () => { uiExited = true; });
      let ready = false;
      for (let attempt = 0; attempt < 50 && !uiExited && !stopping; attempt++) {
        if (await status(`${uiUrl}__local/status`, 'local', true)) { ready = true; break; }
        await delay(200);
      }
      if (!ready && !stopping) throw new Error('网页服务启动失败，请检查端口 4173。');
    }
    if (!stopping) {
      console.log('陪伴聊天已启动。关闭网页右上角的“关闭飞讯”后，本窗口启动的服务会一起关闭。');
      if (app && !app.runtime.online) console.log('本地模型尚未就绪，请启动已配置的模型服务。');
      const browser = spawn('open', [uiUrl], { stdio: 'ignore' });
      browser.on('error', () => console.log(`请手动打开 ${uiUrl}`));
      if (!app && !ui) console.log('已打开正在运行的服务。');
      else {
        while (!stopping && !uiExited) {
          await delay(1000);
          if (!ui && !await status(`${uiUrl}__local/status`, 'local', true)) break;
        }
      }
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : '启动失败。');
  process.exitCode = 1;
} finally { await stop(); }
