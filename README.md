# AI 桌面宠物（基于 BongoCat 改造）

> 本项目基于开源桌面宠物 [BongoCat](https://github.com/ayangweb/BongoCat)（Tauri + Vue + Live2D）二次开发，在保留原有"猫咪随键鼠动作实时联动"能力的基础上，**新增 AI 对话功能**，把一只桌面宠物升级为「桌面常驻型 AI 宠物助手」。

---

## 一、项目定位

电脑端桌面常驻型 **AI 宠物助手**。用户启动后，桌面上显示一只可移动、可互动、可 DIY 外观的 Live2D 宠物；宠物在原有键鼠联动动画之外，还能与用户进行 AI 对话，并让动画状态与 AI 行为同步（思考 / 说话 / 待机等）。

当前阶段（MVP）**明确不做**工具调用、不读取文件、不操作系统，只聚焦：**桌宠展示 + AI 对话 + 动画联动**，先验证产品体验闭环。

## 二、新增需求

在原 BongoCat 功能之上，本次改造新增以下需求：

- **聊天窗口**：独立的、透明无边框、可置顶的聊天窗口，双击桌宠即可呼出。
- **AI 对话能力**：接入 OpenAI-compatible API，支持在设置中填写 API Key / 模型 / BaseURL，实现连续问答。
- **流式输出**：AI 回复逐字显示，体验更自然。
- **状态联动**：宠物动作 / 表情与 AI 状态同步——发送消息时进入「思考」，模型输出时进入「说话」，回复结束回到「待机 / 开心」。
- **（预留）人格设定与 DIY**：通过系统 Prompt 定义宠物人格，后续扩展资源包机制。

## 三、改造方案

### 技术路线

沿用 BongoCat 的 **Tauri 2 + Vue 3 + Pinia + Live2D（easy-live2d / pixi.js）** 底座（而非另起 Electron 项目），最大化复用现有的透明窗口、托盘、键鼠监听与 Live2D 渲染能力。

### 落地四步（纵向切片，逐步可验证）

| 步骤       | 目标     | 内容                                                                            |
| ---------- | -------- | ------------------------------------------------------------------------------- |
| 第 1 步 ✅ | 打通窗口 | 新增 `chat` 窗口 + 路由 `/chat` + 双击桌宠打开入口，先出一个空聊天窗            |
| 第 2 步 ✅ | 打通 AI  | `ai.ts`（AI 客户端）+ `chat.ts`（消息 store）+ 设置页填 Key，实现**非流式**问答 |
| 第 3 步    | 加流式   | 改为 `streamChat`，气泡逐字显示                                                 |
| 第 4 步    | 加联动   | 通过 `usePetState` 驱动猫咪随 AI 状态切换表情 / 动作                            |

### 关键架构说明

- **多窗口通信**：聊天窗口（`chat`）与桌宠主窗口（`main`）是两个独立的 Tauri WebviewWindow，Pinia store 默认不跨窗口共享。控制 Live2D 的实例只存在于主窗口，因此「聊天触发 → 猫咪变表情」必须走 **Tauri 事件**（复用主窗口已有的 `START_MOTION` / `SET_EXPRESSION` 监听通道）。
- **网络请求**：建议使用 `@tauri-apps/plugin-http` 从 Rust 侧发起 LLM 请求，绕开浏览器 CORS 限制并稳定支持流式响应。
- **状态 → 表情映射**：Live2D 模型以 motion（分组）和 expression（按 index）暴露动画，需要一层 `状态(thinking/speaking/happy/idle) → expression index` 的映射配置，按所用模型实际拥有的表情来定。
- **API Key 存储**：Key 由 Rust 写在本机应用配置目录的 `ai-key.json`（`src-tauri/src/ai_secret.rs`），退出应用后再打开仍然有效，并与保存时的接口基础地址绑定。它不进入普通设置存档、日志或 Git。只有 `preference` 窗口能设置 / 清除，`chat` 与 `preference` 能读取。输入框在保存后仍会清空，界面不回显 Key。
- **网络授权**：只有 `src-tauri/capabilities/ai-network.json` 中列出的服务商地址和本机回环地址可以访问，且只授予 `chat`、`preference` 窗口；新增服务商需要修改该文件并重新构建。

### 数据流

```
双击桌宠 / 打开聊天框
   → 输入并发送
   → chat.ts 接收消息，emit「思考」状态事件
   → 主窗口播放思考动画
   → ai.ts 调用 LLM（流式）
   → emit「说话」状态，气泡逐字显示
   → 回复完成，保存记录，状态回到 待机 / 开心
```

## 四、改造进度

- [x] 第 1 步：新增 `chat` 窗口、路由、双击打开入口，搭建聊天窗口基础界面
- [ ] 第 2 步：接入 AI，实现非流式问答（AI 设置页与测试连接、本机保存的 Key（重启后仍有效）、最小宠物档案、非流式聊天；聊天记录本阶段不跨重启保存）
  - 代码：已实现，自动化测试通过
  - 验收：**未正式验收通过**，桌面实机验收和真实服务商联调未完成
- [ ] 第 3 步：流式输出（未开始）
- [ ] 第 4 步：宠物状态联动（未开始）

### 阶段 2 收尾状态

| 项目                   | 状态                                                                                                                       |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `main`                 | 停在 `ff1851b`，**不含**取消草稿修复（S2-R01）                                                                             |
| 修复分支               | `claude/sleepy-knuth-wxa3e2`，基于 `fix/phase2-cancel-draft`（含 `f0a53b2`）并补上 S2-R02，目标合入 `main`，等待负责人审查 |
| 自动化检查             | 修复分支上 lint、类型检查、前端测试、构建、`cargo check`、`cargo test` 均通过，见 `开发文档/阶段2整改验证记录.md`          |
| 桌面实机验收（S2-R03） | 未完成                                                                                                                     |

阶段 2 未完成的验收（详见验证记录）：

- [ ] 用本人授权的服务商 Key 完成连接测试和正式聊天
- [ ] 连续 5 轮对话及上下文携带
- [ ] 界面上的认证、限流、超时、坏响应、重试、取消、清空，包括取消草稿（S2-R01 / S2-R02）的页面操作
- [ ] 隐藏聊天窗口再打开
- [ ] 退出重启后宠物档案、非敏感配置和 API Key 恢复（不用重输），聊天记录不恢复
- [ ] `chat` / `main` 调用未授权导入命令被拒绝，`preference` 可正常导入
- [ ] 自定义模型删除或损坏后的回退，宠物档案不变
- [ ] 原有功能回归：拖动、缩放、穿透、置顶、托盘、键鼠 / 手柄、内置模型切换、更新隔离
- [ ] 日志和普通存档中没有 Key、Authorization 或私人会话
- [ ] Windows / Linux（未验证；先完成主开发平台 macOS）

## 五、技术栈

- **框架**：Tauri 2 + Vue 3 + TypeScript
- **状态管理**：Pinia（`@tauri-store/pinia` 持久化）
- **动画渲染**：easy-live2d + pixi.js（Live2D）
- **UI**：antdv-next + UnoCSS
- **AI**：OpenAI-compatible API（流式）

## 六、本地开发

```bash
# 安装依赖（仅支持 pnpm）
pnpm install

# 启动开发（首次会编译 Rust，耗时较长）
pnpm tauri dev

# 打包
pnpm tauri build
```

### 检查与测试

```bash
pnpm exec eslint src          # 代码检查（不自动修复；pnpm lint 会带 --fix 修改文件）
pnpm typecheck                # Vue / TypeScript 类型检查（vue-tsc）
pnpm test                     # 单元测试（vitest，网络层全部 mock，不访问真实服务商）
pnpm build                    # 前端构建
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
```

### 本机 mock 联调

没有真实 Key 时，可以用本地 OpenAI 兼容 mock 服务验证 AI 设置与聊天流程：

```bash
node scripts/mock-openai-server.mjs 18080
```

在 AI 设置中填写 BaseURL `http://127.0.0.1:18080/v1`、API Key `sk-mock-local-key-0000`（仅 mock 使用，非真实凭证），模型填 `mock-ok`。把模型改成 `mock-slow`、`mock-404`、`mock-429`、`mock-500`、`mock-html`、`mock-badjson`、`mock-length`、`mock-context`、`mock-redirect` 可以复现对应的异常场景。

> 如果系统开启了代理（如 Clash），HTTP 插件可能会把回环地址的请求也交给代理；端口未监听时会表现为 HTTP 502。可以用 `NO_PROXY=127.0.0.1,localhost pnpm tauri dev` 启动。

> macOS 首次运行需在「系统设置 → 隐私与安全性 → 辅助功能 / 输入监控」中为应用授权，宠物才能监听全局键鼠。

## 七、致谢

本项目基于 [ayangweb/BongoCat](https://github.com/ayangweb/BongoCat) 改造，原项目灵感来源于 [MMmmmoko/Bongo-Cat-Mver](https://github.com/MMmmmoko/Bongo-Cat-Mver)。感谢原作者们的开源贡献。原项目遵循其 [LICENSE](./LICENSE)，二次开发同样遵循该协议。
