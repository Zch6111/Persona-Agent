# 项目结构与业务职责

业务代码位于 `src/`，只有 `application/`、`adapter/` 两大类。每个业务包内直接放职责文件，不继续拆成 model、usecase、repository 等目录。

| 文件 | 架构职责 | 边界 |
| --- | --- | --- |
| `application/业务/model.ts` | domain 模型与规则 | 业务对象、状态、校验；仅依赖其他业务模型 |
| `application/业务/usecase.ts` | service 业务用例 | 编排流程；通过内部接口访问存储与外部能力 |
| `application/业务/repository.ts` | 存储接口 | 描述数据存取、排序、幂等与原子性，不实现 SQL 或文件读写 |
| `adapter/业务/api.ts` | api 协议适配 | HTTP、WebSocket、第三方模型协议、超时与取消 |
| `adapter/业务/db.ts` | db 仓库实现 | SQLite、文件或进程内存储与记录转换 |

repository 专门表示存储能力。模型生成、调用观察、任务定时调度等非存储接口定义在对应业务的 usecase.ts 中。文件内允许多个相关接口和类，用注释说明各自职责。

## application

| 业务包 | model.ts | usecase.ts | repository.ts |
| --- | --- | --- | --- |
| `conversation/` | 对话、消息、消息引用、回复任务、业务事件、上下文预算、正文校验 | ChatService 接收与回复；ContextBuilder 组装输入；HistoryService 查询历史；AgentRuntime 串行调度、恢复、暂停切换与取消；TaskScheduler 定时能力接口 | ConversationRepository：对话、消息和任务的存取、恢复、历史游标及原子操作 |
| `memory/` | 记忆、候选格式、来源、归属、修正关系和整理进度 | MemoryService 召回与分批整理；校验候选是否引用本批真实来源和已有修正目标 | MemoryRepository：有效记忆、检索、检查点及批次提交 |
| `persona/` | CharacterProfile、SpeechReference、提示词用途、角色资料校验 | PersonaService 读取最新角色、选择固定和相关参考、获取模板、启动预检 | CharacterRepository、ReferenceRepository、PromptRepository |
| `inference/` | ModelInput、ModelProvider，统一生成输入与来源 | LanguageModel 生成能力接口；ModelRouter 选择、恢复、可用性探测和生成转发 | ModelSelectionRepository：模型选择结果的存储 |
| `inspection/` | ModelTrace、MemoryStatus、InspectionSnapshot、近期记录数量限制 | ModelTraceObserver 观察能力接口；InspectionService 记录调用与状态、聚合记忆及来源 | InspectionRepository：近期调用与整理状态存取 |

### 关键方法契约

- `acceptUserMessage` 在同一 SQLite 事务保存用户消息和回复任务。同一对话相同消息 ID、正文返回已有结果，不重复生成；ID 内容冲突拒绝。
- `completeReply` 在同一事务保存回复与任务完成状态，成功后才通知前端。重复完成返回原回复。
- `listMessages` 按保存顺序回放；`listContextMessages` 按用户输入及其对应回复组织因果顺序，防止排队中的后续输入泄入前一个回复。
- `getMemoryReadySequence` 将整理范围限制在最早未完成回复的输入之前。
- `applyBatch` 原子提交记忆、旧记忆替代关系及检查点；来源不存在、跨用户、跨角色或进度无效时全部回滚。
- `changeModel` 等待正在执行的回复及记忆任务结束，切换期间不执行新回复；目标不可用或保存失败保留原来源。
- `stop` 取消生成；中断任务保留可恢复状态。启动在持有数据库实例锁后恢复任务。
- `PersonaService` 每次使用重新读取资料和模板；修改文件无需重新编译，角色 ID 不变时沿用对话与记忆。
- `InspectionService.begin` 在模型适配器发送请求的位置记录最终请求体，不记录鉴权请求头。仅保留进程内最近 20 次实际调用。

## adapter

| 文件 | 职责 |
| --- | --- |
| `conversation/api.ts` | 聊天帧解析、协议转换、WebSocket 控制器、连接订阅、历史回放、缓冲实时事件与清理 |
| `conversation/db.ts` | SQLite 对话、消息、任务及历史导入；行记录转换与原子事务 |
| `memory/db.ts` | SQLite 记忆、来源、修正、检查点及关键词检索 |
| `persona/db.ts` | JSON 角色、JSON 原作参考、Markdown 提示词读取与资料解析 |
| `inference/api.ts` | Chat Completions 模型客户端、模型目录探测、请求取消超时与错误转换；模型设置 HTTP 接口 |
| `inference/db.ts` | 用临时文件和重命名持久化当前模型来源 |
| `inspection/api.ts` | 只读 `/inspect` 请求，检查本机 Host、允许的 Origin 和 GET 方法 |
| `inspection/db.ts` | 近期调用与记忆状态的进程内仓库，写入和读取时复制对象 |
| `platform/config.ts` | 默认配置、本地覆盖、环境变量、路径与配置值校验 |
| `platform/database.ts` | SQLite 连接、表结构、事务与数据库实例锁 |
| `platform/search.ts` | 供仓库共用的中文双字片段、英文词项及关键词计分机制 |
| `platform/server.ts` | 创建 HTTP 服务、注册各业务 HTTP 路由、WebSocket 升级检查、健康接口与关闭 |
| `platform/scheduler.ts` | TaskScheduler 的 Node 定时器实现，可取消且不阻止进程退出 |
| `platform/bootstrap.ts` | 创建仓库和模型适配器，装配用例并统一管理资源 |
| `platform/main.ts` | 后端入口、信号处理、启动失败提示 |
| `platform/launcher.ts` | 同时启动网页与后端，复用已有服务，只关闭自己创建的进程 |
| `platform/migration.ts` | 旧 Cortico 数据预览、导入与资料归档，保持原文顺序、幂等和来源保护 |

### 浏览器包

`adapter/web/` 保持独立的 package.json、锁文件和 Vite 构建配置。以下代码直接放在包内：

| 文件 | 职责 |
| --- | --- |
| `main.js` | 页面结构、联系人导航、弹窗、全屏和本机关闭交互 |
| `chat.js` | 聊天列表、输入、正在输入、滚动、模型来源切换与观察窗口装配 |
| `agent-client.js` | 后端地址解析、WebSocket、重连、消息去重和协议兼容 |
| `inspector.js` | 聊天输入、记忆整理输入与记忆库观察窗口 |
| `settings.js` | 字号、减少动效、本地偏好读取与保存 |
| `style.css` | 页面布局、移动端适配、动画和观察窗口样式 |
| `vite.config.js` | Vite 服务和仅本机、同来源可调用的网页关闭接口 |
| `index.html` | 浏览器页面入口 |
| `public/agent-config.json` | 可在部署后独立修改的后端连接地址 |
| `public/images/dania.png` | 原有角色头像 |

public 是静态资源目录，node_modules、dist 是依赖与生成产物；它们不属于业务代码的职责分层。

## 依赖方向

application 不导入 adapter，也不直接调用 HTTP、文件系统、进程环境或定时器。repository 文件只依赖 model；model 文件只依赖 model。各业务用例可以使用其他业务提供的内部接口和能力，跨包依赖不携带存储实现。

adapter 实现内部接口。bootstrap 是组合入口，向用例注入具体仓库、模型、观察存储和定时器。浏览器包通过协议独立连接，不导入后端源码。

## 现有功能与数据兼容

| 功能 | 保留的位置与行为 |
| --- | --- |
| 持久聊天、去重、排队、回复关联与恢复 | conversation 用例与仓库；数据库结构保持原版本 |
| 历史分页、连接时回放和实时衔接 | HistoryService、conversation/api.ts |
| 角色、固定表达、完整原作参考和上下文预算 | persona、ContextBuilder，继续读取原 assets 路径 |
| 长期记忆提取、召回、分类、来源、修正与恢复 | memory 模型、用例与 SQLite 仓库 |
| 本地模型与 DeepSeek 切换及选择恢复 | inference、对话调度协调；继续使用原 .model.json |
| 模型离线可读历史、恢复后自动接入 | AgentRuntime 与注入的定时器 |
| 实际模型输入输出和记忆观察 | inspection；保留 HTTP 路径与响应结构 |
| 飞讯聊天、移动端、界面设置和全屏 | adapter/web 中原有页面与样式 |
| 自动重连、历史和实时消息去重、旧消息格式兼容 | agent-client.js |
| 本机联合启动、网页单独启动与关闭 | 仓库根目录两个 .command、platform/launcher.ts |
| 旧 Cortico 真实消息导入与文档归档 | platform/migration.ts，仍默认预览 |

根目录 config.json、config.local.json、assets、var 和现有数据库均不移动。配置加载器根据自己的新位置定位同一个项目根目录；源码和 dist 中的版本得到相同路径。构建后的后端入口为 `dist/adapter/platform/main.js`。

旧 Cortico 保留为项目外的归档与可选导入来源，不参与当前前后端运行。迁移时仍可用 --source 指定其他来源。

## 验证

- `npm run typecheck`：所有后端源码及 TypeScript 测试的严格类型检查。
- `npm run test:core`：架构边界、真实 SQLite 与文件、记忆规则、迁移、实例锁、业务流程、内存观察、模型协议与连接回放测试，不需要监听端口。
- `npm test`：保留全部原有 HTTP/WebSocket、集成与前端通信测试，同时运行新增回归测试。需要允许本机端口监听。
- `npm run build`：构建后端和前端。
- `npm run start:companion`：联合启动；`npm start` 和 `npm run dev:web` 可分别启动。

源码注释说明方法的业务目标及关键约束；事务、去重、来源校验和取消恢复等契约也在 repository 与 usecase 方法旁明确记录。
