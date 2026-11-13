<!-- Owner: src/bootstrap.ts; src/domain/; src/service/; src/api/; src/db/; config.json; scripts/migrate-cortico.ts; scripts/start-companion.ts -->

# 角色陪伴后端

固定角色、原作表达参考、完整对话记录和长期记忆。现有飞讯前端通过 WebSocket 连接本后端；运行和构建均不依赖 Cortico。需要 Node.js 24 或以上版本。

## 运行

在项目上一级目录双击 **启动陪伴.command**，同时启动后端和飞讯页面。保留启动窗口；页面的「关闭飞讯」会结束本次启动的网页服务，启动器随后关闭自己启动的后端。已经独立运行的后端继续运行。

也可以单独运行：

```bash
cd gameAgent
npm install
npm start
```

随后在另一窗口运行 `frontend` 的 `npm run dev`，或双击原有的 **启动飞讯.command**。原脚本仍然只启动前端。

- 前端：`http://127.0.0.1:4173/`
- 聊天：`ws://127.0.0.1:8000/ws/chat`
- 状态：`http://127.0.0.1:8000/health`

默认使用此前部署的本地模型 `cortico-roleplay:7b`，地址 `http://127.0.0.1:11434/v1`。本后端不安装、下载或启动模型服务；若该本地服务尚未运行，先运行 `ollama serve`。模型未就绪时仍可读取历史，发送按钮保持离线，模型恢复后自动检测接入。

## 配置与角色资料

`config.json` 为默认配置。需要本地覆盖时创建 `config.local.json`，只填写要调整的项：

```json
{
  "model": {
    "baseUrl": "http://127.0.0.1:11434/v1",
    "model": "cortico-roleplay:7b"
  }
}
```

模型地址也可以是完整的 `/chat/completions` 地址。模型端点需支持 Chat Completions、JSON 对象输出及 `/models` 目录查询。后端只在本机监听，浏览器来源默认允许本机的 4173 端口。

环境变量可覆盖 `AGENT_HOST`、`AGENT_PORT`、`AGENT_DATABASE`、`AGENT_MODEL_BASE_URL`、`AGENT_MODEL`；密钥仅从 `AGENT_API_KEY` 环境变量读取。改变后端端口时同步修改前端的 `public/agent-config.json`。

### 本地模型与 DeepSeek API

聊天页面支持切换本地模型和 DeepSeek API。两者使用同一套角色资料、表达参考、聊天历史、上下文预算、长期记忆提取与召回流程，切换不会建立新的对话或清空记忆。

DeepSeek 默认模型为 `deepseek-flash`。通过环境变量 `DEEPSEEK_API_KEY`、`DEEPSEEK_MODEL`、`DEEPSEEK_BASE_URL` 配置，也可在不提交到版本库的 `config.local.json` 中使用 `deepseek.apiKey`、`deepseek.model`、`deepseek.baseUrl`。密钥不会返回前端。

切换前检查目标模型是否可用；切换期间暂缓新任务执行，等待当前回复和记忆整理完成后切换。失败时保留原来源。选择保存到数据库旁的 `.model.json` 文件，重启后恢复；目标服务临时离线不会静默切换其他模型。当前部署已选用 DeepSeek API。

### 观察完整输入与记忆

点击网页顶栏的「模型与记忆」，打开聊天回复输入、记忆整理输入和记忆库三个观察窗口。窗口打开时自动刷新，也可手动刷新。

输入在模型适配器实际发送请求的位置记录，保留最终 system、全部入选历史消息、模型名和生成参数，可展开原始请求 JSON 与本次输出；不包含鉴权请求头或密钥。输入记录仅保存在当前后端进程内，最多保留最近 20 次实际调用，重启后重新记录。重启前的输入不会伪装成重启后的真实调用。

记忆库显示当前有效记忆、类型、来源消息原文、修正关系、最近一批变更及整理进度。聊天回复完成后，记忆仍可能正在后台整理；界面分别显示等待、处理中和失败状态。数据来自本机受来源限制的只读 `/inspect` 接口。

角色和资料文件：

| 文件 | 内容 |
| --- | --- |
| `assets/characters/dania.json` | 身份、当前设定、关系前提和表达特征 |
| `assets/references/dania.json` | 16 条有出处的原作与表达参考 |
| `assets/prompts/reply.md` | 回复的组织要求和资料使用边界 |
| `assets/prompts/memory.md` | 长期记忆的提取格式与来源规则 |

这些文件会在使用时重新读取，修改后无需重新编译。角色 ID 保持稳定时，调整资料不产生新的个体或清空既有记忆。

上下文采用可配置的字符预算，分别限制总输入、历史、记忆及参考材料；字符预算用于保守控制长度，不等同于模型的 token 数。更换模型窗口后应同步调整。原文始终保存在数据库，未进入某次输入的历史不会被删除。

## 四层职责

| 层 | 主要代码 | 职责 |
| --- | --- | --- |
| domain | `character.ts`、`conversation.ts`、`memory.ts`、`reference.ts` | 角色、对话、真实消息、带来源的记忆、原作参考及规则 |
| service | `ChatService`、`ContextBuilder`、`MemoryService`、`HistoryService`、`AgentRuntime` | 接收消息、回复、上下文、记忆整理、历史查询、串行调度 |
| service/ports | 六个仓库和模型接口 | 描述流程需要的能力，独立于具体数据库、网络和模型厂商 |
| api | `ChatWebSocketController`、`ChatConnection`、`CompatibleLanguageModel` | 前端协议、历史衔接、模型通信、取消与超时 |
| db | SQLite 仓库、JSON/Markdown 文件仓库 | 原子持久化、历史游标、资料读取与关键词检索 |

`bootstrap.ts` 创建具体对象并注入依赖，`main.ts` 负责进程启动和关闭。首版单后端进程，数据库实例锁防止两个后端同时恢复同一批任务。

## 数据与恢复

`var/agent.sqlite` 保存完整聊天、回复任务、长期记忆与整理进度。用户消息和任务先在同一事务中保存；模型回复和任务完成状态也在同一事务中保存，然后才推送到前端。

相同对话下相同消息 ID 不会建立第二个任务。进程中断后，未完成任务会在下次启动时恢复；已保存的回复不会重复生成。若中断发生在模型返回但保存之前，恢复时可能重新请求模型。

同一对话串行生成。模型上下文按用户消息及其回复关联恢复因果顺序，页面历史按真实保存顺序回放。建立连接时先订阅新事件再回放历史快照，随后衔接新消息。

长期记忆只从真实消息提取，区分用户自述、互动和推断；每条关联来源，修正保留旧记录关系。记忆整理只处理最早未完成回复之前的稳定消息范围。失败时保留原进度，后续继续，已保存的聊天和回复不回滚。

首版记忆与原作资料采用中文词组/英文词语的关键词检索。原作资料不写入用户经历。语义向量检索、语音、多角色、主动聊天与外部工具未接入。

前端当前没有持久化确认与自动重发协议，写入连接仍不等于后端已保存；接口细节见 `../frontend/agent-interface.md`。

## Cortico 数据迁移

本项目已有的 50 条真实聊天已迁移，角色资料和原作参考也已复制到本后端。原 Cortico 未更改；工作区文档存档于 `var/legacy-memory`，不自动作为可信的用户记忆。

迁移工具默认仅预览：

```bash
npm run migrate:cortico
npm run migrate:cortico -- --apply --archive-dir var/legacy-memory
```

可指定 `--source`、`--database`、`--user-id`、`--character-id`。工具仅导入 `terminal.message` 和 `terminal.self` 的真实正文，按旧事件游标排序，重复执行不会重复导入。新增旧记录应在新后端开始聊天前迁移，避免改变已使用的历史顺序。

## 检查

```bash
npm run typecheck
npm test
npm run build
```

测试使用真实临时 SQLite、文件和本机 HTTP/WebSocket；模型由脚本化替身提供，不调用真实模型服务。构建后可运行 `node dist/main.js`。
