<!-- Owner: vite.config.js; main.js; chat.js; inspector.js; agent-client.js; settings.js; public/agent-config.json -->

# 飞讯 · 达妮娅

独立的聊天前端，使用 Node.js 22.12 或以上版本。样式、头像和界面设置都由前端管理；agent 服务自行启动和停止。联系人与消息头像使用 `public/images/dania.png`。

## 本地运行

在 gameAgent 根目录双击 **启动飞讯.command**。脚本只启动前端并打开网页；已运行时打开现有页面。运行期间保留启动窗口，点击网页右上角的「关闭飞讯」停止前端服务。

也可以在当前目录运行：

```bash
npm ci
npm run dev
```

默认地址为 `http://127.0.0.1:4173/`。当前连接 `gameAgent` 后端（`ws://127.0.0.1:8000/ws/chat`）；页面与界面设置可以独立使用，发送按钮在聊天服务可用时启用。需要同时启动前后端时，双击 gameAgent 根目录的 **启动陪伴.command**。

## 接入 agent

修改 `public/agent-config.json`，填写新后端的 WebSocket 地址，再刷新页面：

```json
{
  "url": "ws://127.0.0.1:8000/ws/chat"
}
```

`url` 留空表示断开 agent。也支持同源路径，例如 `/ws/chat`，此时静态服务器或反向代理需要将该路径转给后端。HTTPS 页面应使用 `wss://` 服务。跨源后端需要允许前端的 Origin；本地默认是 `http://127.0.0.1:4173`。

接口契约和消息示例见 [agent-interface.md](./agent-interface.md)。新后端只需实现聊天协议，内部的模型、推理、工具和记忆设计由后端自行决定。

## 交互

- 输入消息后按 Enter 发送，Shift + Enter 换行；用户消息发送成功后立即显示。
- 连接中断后自动重连；同一页面内按消息 ID 去重，后端负责历史存储与回放。
- 手机上点击联系人进入聊天，左上角箭头返回联系人。
- 顶栏支持界面设置、使用说明和全屏。设置支持消息字号和减少动效，并保存到当前浏览器。
- 左侧「回到最新消息」跳转到对话末尾。
- 顶栏「模型与记忆」打开三个观察窗口：聊天模型完整输入、记忆整理模型完整输入、当前记忆库。打开时自动刷新，支持选择最近调用及展开来源消息。需要后端提供 `/inspect` 接口。

## 构建与检查

```bash
npm test
npm run build
npm run preview
```

`build` 生成 `dist/`，可用任意静态 HTTP 服务托管；`preview` 只预览前端。构建后的连接配置位于 `dist/agent-config.json`，可以直接修改，无需重新构建。下次构建会用 `public/agent-config.json` 覆盖它。

「关闭飞讯」使用本地 Vite 服务提供的 `/__local/status` 与 `/__local/shutdown`，只关闭前端。普通静态部署时该按钮隐藏。

代码直接位于本目录：`main.js` 挂载页面，`chat.js` 管理聊天交互与模型切换，`agent-client.js` 管理协议与重连，`inspector.js` 管理观察窗口，`settings.js` 管理浏览器中的界面设置，`style.css` 管理样式。业务规则与聊天数据由后端 application 处理，前端不导入后端源码。

也可在 gameAgent 根目录使用 `npm run dev:web`、`npm run build:web`、`npm run test:web`。测试集中位于 `tests/web/`。
