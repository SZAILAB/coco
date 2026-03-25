# coco

`coco` 是一个轻量级的终端 agent orchestrator 原型。

它的目标不是做成一个通用平台，也不是复刻 OpenClaw，而是专注解决一个非常具体的个人工作流问题：

- 在本地或服务器上稳定拉起 `codex`、`claude` 这类交互式 CLI
- 让两个 agent 围绕一个任务自动讨论并达成结论
- 在进程异常退出时自动恢复并继续对话
- 为后续的远程控制、定时汇报打下一个足够稳的底座
- 提供一个最小控制平面，能看当前 run 的状态和 pid

## 当前状态

项目已经完成了三个阶段中的前两阶段，并落下了两种第一版远程入口和一个最小 direct-session 模式：

- **Phase 1：单会话 runtime** — 已通过真机 smoke test（启动、输入输出、异常重启、退出日志完整性）
- **Phase 2：双 agent broker** — 已通过 live test（Codex 和 Claude 完成文件协议 roundtrip 并达成 AGREED）
- **Phase 3：远程控制（Telegram v1 / Feishu v1）** — 已接入最小命令面（`/run`、`/status`、`/stop`、`/last`）
- **Phase 4：direct session v1** — 已支持按明确 `session_id` / `thread_id` 绑定已有 Claude / Codex 会话，并在聊天里继续对话

## 核心架构

### 文件协议（broker 正文通道）

broker 不从 PTY 输出中提取正文。TUI 输出天然不是给机器读的，从中"猜正文"会陷入无限追噪声的循环。

取而代之的是文件协议：

1. broker 给 agent 指定一个输出文件路径和 `.done` 标记路径
2. agent 把回复写到指定文件
3. agent 写完后创建 `.done` 文件
4. broker 读取文件内容，转发给对端 agent

Turn 文件按轮次编号存储：

```text
state/broker/<run-id>/
  codex/
    turn-001.md
    turn-001.done
  claude/
    turn-001.md
    turn-001.done
    turn-002.md
    turn-002.done
```

这个设计的优势：

- 可预测、可测试、可复盘
- 不依赖 TUI 厂商的输出格式
- 后续接 Telegram 或远程控制也更自然

PTY output 仍然进 JSONL transcript，用于调试和故障排查。

### 单会话 PTY 封装

`src/pty-session.ts` 管理一个交互式进程的完整生命周期：

- 状态机：`idle → starting → running → stopped/crashed`
- 事件：`start / input / output / exit / error`
- generation 计数器防止旧进程回调覆盖新进程状态
- `stop()` 等待 PTY 真正退出后再返回（带 5s 安全超时）
- Claude 长消息分片发送，绕开 paste artifact 问题

### Watchdog

`src/watchdog.ts` 监控会话状态：

- 进程退出后自动重启（带最大重启次数限制）
- 可选的 no-output 超时检测（默认关闭）
- broker 模式下 watchdog 重启后，broker 会自动重发当前 turn 的 prompt

### Broker

`src/broker.ts` 编排双 agent 对话：

- 非对称角色：writer（提方案）+ reviewer（审方案）
- 文件协议：每轮分配 `turn-NNN.md` + `.done`，轮询等待完成
- 三层停止条件：keyword（`AGREED` / `BLOCKED`）、重复检测、最大轮次
- session exit 不会立即终止 broker，给 watchdog 时间恢复
- turn 超时兜底（默认 5 分钟）

### 最小控制平面

`run-broker` 会持续写入：

- `state/broker/<run-id>/status.json`
- `state/broker/<run-id>/broker.pid`
- `state/broker/latest-run.json`

`status.json` 至少包含：

- `runId`
- `phase`
- `round`
- `updatedAt`
- `stopReason`
- 当前等待中的 turn 信息
- 左右 session 的 pid/status
- `recentTurns`
- `progressSummary`
- `heartbeat`

`npm run status` 会读取最新 run 的 `status.json` 并打印当前状态。

`progressSummary` 是一个面向手机查看的短摘要，会在每轮 forward 后自动更新。它会包含：

- 当前是在等待哪一侧继续回复
- 最近最多 3 轮转发摘要
- 结束时的 stop reason / final preview

`heartbeat` 会周期性刷新，表示 broker 还活着，即使当前还没有新的 turn。它至少包含：

- `intervalMs`
- `count`
- `lastAt`
- `lastText`

默认 heartbeat 间隔是 60 秒，可通过 `COCO_HEARTBEAT_MS` 调整；设为 `0` 可关闭。

`src/control.ts` 在这个状态面之上提供了一个很薄的本地控制 API：

- `startBroker(task)`
- `readStatus(runId?)`
- `stopBroker(runId?)`
- `lastTurn(runId?)`

`src/telegram.ts` 只是把这些 API 暴露到 Telegram 命令上，不再重复实现 run 管理。

### Direct Session v1

除了 broker 模式，`coco` 现在还有一个 direct-session 模式，用来继续一个已经存在的 agent 会话。

当前实现范围很刻意地收得很小：

- Claude：只支持给定 `session_id` 后 `--resume`
- Codex：只支持给定 `thread_id` 后 `codex exec resume`
- bind 时必须显式提供该 session 对应的 `cwd`
- 不做 latest-session bridge
- 不做 fork
- 不做 tmux attach
- 不做 session list；必须手动提供 id

bot 自己的 direct-session 控制命令统一放在 `/coco ...` 命名空间下。这样一来：

- `/coco ...` 会被 bot 拦截
- 其他普通消息会直接发给当前绑定的 session
- 像 `/compact` 这类 agent 自己的 slash command，也会原样透传给 agent，而不是被 bot 吃掉

当前 direct-session binding 还是进程内状态：

- bot 重启后需要重新 `/coco bind`
- 这版的目标只是先把“给定 session id 后继续对话”打通

Telegram 的订阅和通知 cursor 会持久化到 `state/telegram/`：

- `subscribers.json`：已订阅 chat 列表
- `notifier.json`：通知 cursor 和 seeded 状态

这样 bot 重启后不会丢掉订阅，也不会把旧的 progress / stop 通知重复推一遍。

### JSONL Transcript

`src/transcript.ts` 记录所有会话事件到 `logs/<session-id>.jsonl`：

- 完整的 I/O 历史（包括 TUI 噪声），用于事后排查
- `close()` 返回 Promise，shutdown 时 await 保证不丢尾部日志

## 目录结构

```text
coco/
  package.json
  tsconfig.json
  scripts/
    fix-node-pty-helper.mjs
  src/
    index.ts           # 单会话入口
    run-broker.ts      # 双 agent broker 入口
    status.ts          # 读取并打印最新 run 状态
    run-status.ts      # status.json / latest-run.json 写入
    coco-commands.ts   # /coco direct-session 命令
    control.ts         # 本地控制 API（start/status/stop/last）
    direct-backend.ts  # Claude / Codex resume backend
    direct-session.ts  # direct-session binding manager
    feishu.ts          # Feishu 长连接入口
    feishu-runtime.ts  # Feishu WebSocket transport
    feishu-commands.ts # Feishu 命令层
    telegram.ts        # Telegram 命令入口
    telegram-state.ts  # Telegram 订阅和 notifier 状态持久化
    pty-session.ts     # PTY 封装
    broker.ts          # 文件协议 broker
    watchdog.ts        # 自动重启
    transcript.ts      # JSONL 日志
    sanitize.ts        # TUI 输出清洗（调试辅助）
    *.test.ts          # 测试
  logs/                # transcript 输出
  state/broker/        # broker turn 文件
  state/telegram/      # Telegram 订阅和 notifier 状态
```

## 运行方式

安装依赖：

```bash
npm install
```

### 单会话模式

```bash
npm run dev
```

默认启动 `codex --full-auto`。指定其他 agent：

```bash
npx tsx src/index.ts claude --dangerously-skip-permissions
```

指定工作目录：

```bash
COCO_CWD=~/my-project npx tsx src/index.ts
```

`Ctrl+Q` 退出 coco。

### Broker 模式

```bash
npm run broker -- "用一段话讨论 Node.js CLI 是否应该对瞬态 API 错误使用指数退避"
```

默认左侧 `codex --full-auto`，右侧 `claude --dangerously-skip-permissions`。可通过环境变量覆盖：

```bash
COCO_LEFT_CMD=claude COCO_LEFT_ARGS="--dangerously-skip-permissions" \
COCO_RIGHT_CMD=codex COCO_RIGHT_ARGS="--full-auto" \
npm run broker -- "讨论任务"
```

Turn 文件写入 `state/broker/<run-id>/`，transcript 写入 `logs/`。

查看最新 broker run 的状态：

```bash
npm run status
```

如果你用 `nohup npm run broker -- "任务" &` 后台运行，`broker.pid` 和 `status.json` 就是最小控制面。

如需调整 heartbeat 间隔：

```bash
COCO_HEARTBEAT_MS=30000 npm run broker -- "讨论任务"
```

### Telegram 模式

先准备一个 Telegram bot token，并把允许访问的 Telegram numeric user ID 放进 `COCO_TELEGRAM_USERS`：

```bash
COCO_TELEGRAM_TOKEN=xxx \
COCO_TELEGRAM_USERS=123456789 \
npm run telegram
```

`COCO_TELEGRAM_USERS` 是逗号分隔的 numeric user ID 列表。可以用 `@userinfobot` 或其他同类 bot 查自己的 Telegram user ID。

当前支持的命令：

- `/run <task>`：后台启动一个 broker run
- `/status [runId]`：查看最新或指定 run 的状态
- `/stop [runId]`：停止最新或指定 run
- `/last [runId]`：查看最近一次转发摘要
- `/subscribe`：为当前 chat 开启主动通知
- `/unsubscribe`：为当前 chat 关闭主动通知
- `/subscribers`：查看当前已订阅 chat 列表
- `/coco help`：查看 direct-session 命令
- `/help`

`/status` 和 `/last` 都会带上 `progressSummary`，方便在手机上快速看进度，而不是只看原始状态字段。

Telegram direct-session 命令：

- `/coco bind codex <thread_id> <cwd>`
- `/coco bind claude <session_id> <cwd>`
- `/coco use <codex|claude>`
- `/coco ask <codex|claude> <text>`
- `/coco current`
- `/coco detach [codex|claude]`

只要设置了 active target，任何**非 `/coco`** 消息都会直接转发给当前绑定的 session。

只要当前 chat 已通过 `/subscribe` 进入订阅列表，Telegram 还会主动推送：

- 新的 turn forward
- watchdog 恢复相关事件（session exit / resend）
- run 停止（`AGREED` / `BLOCKED` / `timeout` / `fatal` / 手动中断）

订阅列表和通知 cursor 都会写进 `state/telegram/`，因此 bot 重启后依然能继续推送，而且不会把旧通知重复发一遍。

Telegram 主动通知轮询默认是 5 秒，可通过 `COCO_TELEGRAM_NOTIFY_POLL_MS` 调整；设为 `0` 可关闭。

### Feishu 模式

Feishu v1 目前走长连接 WebSocket 模式，复用现有 `control.ts`：

```bash
COCO_FEISHU_APP_ID=cli_xxx \
COCO_FEISHU_APP_SECRET=sec_xxx \
npm run feishu
```

可选环境变量：

- `COCO_FEISHU_DOMAIN`：`feishu`（默认）、`lark` 或自定义开放平台域名
- `COCO_FEISHU_USERS`：允许访问的 sender `open_id` 列表，逗号分隔
- `COCO_FEISHU_CHATS`：允许访问的 `chat_id` 列表，逗号分隔

当前支持的命令：

- `/run <task>`：后台启动一个 broker run
- `/status [runId]`：查看最新或指定 run 的状态
- `/stop [runId]`：停止最新或指定 run
- `/last [runId]`：查看最近一次转发摘要
- `/coco help`：查看 direct-session 命令
- `/help`

Feishu v1 暂时不做订阅持久化和主动通知，它的目标只是提供一个最小可用的远程入口。

## 技术栈

- Node.js 22+、TypeScript、`tsx`
- `node-pty`（PTY 驱动）
- `vitest`（测试）
- 不依赖数据库、Web UI、消息队列

## 已完成

- [x] 单会话 PTY 封装（start/write/send/stop/restart/onEvent）
- [x] JSONL transcript 落盘
- [x] Watchdog 自动重启
- [x] 生命周期竞态修复（generation 计数器、stop 等待 exit、start 失败回滚、shutdown 防重入）
- [x] 真机 smoke test 通过（正常启动、异常退出恢复、启动失败恢复、退出日志完整性）
- [x] 双 agent broker — 文件协议（turn 文件 + done 标记）
- [x] broker 停止条件（keyword / duplicate / max-rounds / timeout / session-exit）
- [x] broker 模式下 watchdog 重启后自动重发 prompt
- [x] 最小控制平面（status.json / latest-run.json / broker.pid）
- [x] 本地控制 API（startBroker / readStatus / stopBroker / lastTurn）
- [x] Telegram v1（/run /status /stop /last）
- [x] Feishu v1（WebSocket 长连接，/run /status /stop /last）
- [x] direct session v1（给定 session id/thread id + cwd 后继续对话）
- [x] Telegram 订阅持久化（subscribers.json / notifier.json）
- [x] Telegram 主动通知（forward / recovery / stop）
- [x] 进度摘要（recentTurns / progressSummary）
- [x] heartbeat（周期刷新 status.json，标记 run 仍然存活）
- [x] Live test 通过（Codex + Claude 完成文件协议 roundtrip 并达成 AGREED）

## 下一阶段计划

### Phase 3: 远程控制

- [x] 接 Telegram 作为第一版远程入口
- [x] 接 Feishu 作为第二个第一版远程入口
- [x] 复用现有 status 面，暴露远程 `status`
- [x] 暴露远程 `stop` / 最近 turn 摘要
- [x] 持久化 Telegram 订阅列表和通知 cursor
- [x] 补 Telegram 命令层的自动化测试
- [x] 将 Telegram 鉴权从 username allowlist 升级为 numeric user ID allowlist

### Phase 4: 后台长任务编排

- [x] progress summary（写入 status.json，并在 CLI / Telegram 展示）
- [x] heartbeat
- [x] Telegram 主动通知
- [ ] 为"睡觉时自动跑任务"建立最小闭环

### Phase 5: Existing Session Access

- [x] 给定 Claude `session_id` 后 resume
- [x] 给定 Codex `thread_id` 后 resume
- [x] direct-session binding 显式记录 `cwd`
- [x] `/coco` 命名空间，避免和 agent 自带 slash command 冲突
- [x] 一个聊天里同时绑定 Codex / Claude，并切换 active target
- [ ] session list / latest-session continue
- [ ] tmux attach
- [ ] binding 持久化

## 与 OpenClaw 的关系

借鉴了 OpenClaw 的进程控制思路（PTY adapter、supervisor watchdog、heartbeat 周期摘要），但不复用其平台结构（插件体系、多渠道接入、session/router）。

`coco` 是一个围绕个人 agent 工作流定制的极简 runtime。
