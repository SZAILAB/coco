# coco

`coco` 是一个轻量级的终端 agent orchestrator 原型。

它的目标不是做成一个通用平台，也不是复刻 OpenClaw，而是专注解决一个非常具体的个人工作流问题：

- 在本地或服务器上稳定拉起 `codex`、`claude` 这类交互式 CLI
- 让两个 agent 围绕一个任务自动讨论并达成结论
- 在进程异常退出时自动恢复并继续对话
- 为后续的远程控制、定时汇报打下一个足够稳的底座

## 当前状态

项目已经完成了两个阶段：

- **Phase 1：单会话 runtime** — 已通过真机 smoke test（启动、输入输出、异常重启、退出日志完整性）
- **Phase 2：双 agent broker** — 已通过 live test（Codex 和 Claude 通过文件协议完成多轮讨论并达成 AGREED）

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
    pty-session.ts     # PTY 封装
    broker.ts          # 文件协议 broker
    watchdog.ts        # 自动重启
    transcript.ts      # JSONL 日志
    sanitize.ts        # TUI 输出清洗（调试辅助）
    *.test.ts          # 测试
  logs/                # transcript 输出
  state/broker/        # broker turn 文件
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
- [x] Live test 通过（Codex + Claude 完成文件协议 roundtrip 并达成 AGREED）

## 下一阶段计划

### Phase 3: 远程控制

- [ ] 接 Telegram 作为第一版远程入口
- [ ] 支持 status / start / stop / 查看最近 turn 摘要

### Phase 4: 后台长任务编排

- [ ] heartbeat / progress summary
- [ ] 为"睡觉时自动跑任务"建立最小闭环

## 与 OpenClaw 的关系

借鉴了 OpenClaw 的进程控制思路（PTY adapter、supervisor watchdog、heartbeat 周期摘要），但不复用其平台结构（插件体系、多渠道接入、session/router）。

`coco` 是一个围绕个人 agent 工作流定制的极简 runtime。
