# coco

`coco` 是一个轻量级的终端 agent orchestrator 原型。

它的目标不是做成一个通用平台，也不是复刻 OpenClaw，而是专注解决一个非常具体的个人工作流问题：

- 在本地或服务器上稳定拉起 `codex`、`claude` 这类交互式 CLI
- 持续读取输出、写入输入、记录日志
- 在进程异常退出或卡住时自动恢复
- 为后续的双 agent 对话、远程控制、定时汇报打下一个足够稳的底座

当前仓库处于第一阶段，重点是把“单个 agent 会话跑稳”这件事做扎实。

## 为什么要做这个项目

现有方案里，像 OpenClaw 这样的系统能力很强，但对当前需求来说偏重。

这个项目的取舍是：

- 不做插件系统
- 不做多渠道消息接入
- 不做复杂权限和路由
- 不做通用 agent 平台抽象

先只做最核心的运行时能力：

- 启动一个交互式 agent
- 像人操作 terminal 一样给它输入
- 实时拿到它的输出
- 把完整事件写入 transcript
- 在故障时自动重启

如果这个地基不稳，后面的 broker、Telegram 控制、睡觉时自动跑任务都没有意义。

## 当前阶段目标

第一阶段的目标很明确：

1. 启动一个真实的 CLI agent 会话
2. 支持 stdin -> PTY 的实时透传
3. 支持 PTY -> stdout 的实时输出
4. 把输入、输出、启动、退出、错误写入 JSONL transcript
5. 在启动失败、异常退出、超时无响应时保留恢复能力
6. 在关闭时尽量保证生命周期事件完整落盘

当前版本已经围绕这些目标完成了最小实现。

## 当前实现了什么

### 1. 单会话 PTY 封装

`src/pty-session.ts` 负责管理一个交互式进程的生命周期：

- `start()`
- `write()`
- `send()`
- `stop()`
- `restart()`
- `onEvent()`

它内部维护了最基本的会话状态：

- `idle`
- `starting`
- `running`
- `stopped`
- `crashed`

并向外发出统一事件：

- `start`
- `input`
- `output`
- `exit`
- `error`

### 2. JSONL Transcript

`src/transcript.ts` 会把所有会话事件追加到 `logs/<session-id>.jsonl`。

这样后续做这些事情时都有可靠的数据基础：

- 回看 agent 到底收到了什么输入
- 检查崩溃前最后几条输出
- 把一个 agent 的回复转发给另一个 agent
- 做周期性摘要或远程状态查询

### 3. Watchdog 与自动重启

`src/watchdog.ts` 负责监控会话状态。

当前支持：

- 进程退出后自动重启
- 可选的 no-output 超时检测
- 最大重启次数限制
- watchdog 自己的错误兜底，避免未处理 rejection

### 4. 交互式 CLI 入口

`src/index.ts` 提供一个非常薄的入口层：

- 创建会话
- 挂载 transcript
- 启动 watchdog
- 将当前终端的 stdin 透传给 agent
- 将 agent 的输出打印回当前终端
- 支持 `Ctrl+Q` 退出 `coco`

## 当前目录结构

```text
coco/
  package.json
  tsconfig.json
  src/
    index.ts
    pty-session.ts
    transcript.ts
    watchdog.ts
  logs/
```

这个结构是刻意保持极简的。

当前没有引入：

- 数据库
- Web UI
- Telegram Bot
- tmux 控制层
- 多 agent broker
- 复杂配置系统

这些能力都要等单会话 runtime 足够稳定之后再加。

## 技术选型

当前技术栈：

- Node.js 22+
- TypeScript
- `tsx`
- `node-pty`
- `vitest`

之所以先用 TypeScript，而不是 Rust，是因为当前阶段的核心问题是 I/O 编排和工作流验证，不是性能瓶颈。

现阶段更重要的是：

- 快速迭代
- 快速改状态机
- 快速验证故障边界
- 快速加 broker 和远程控制

如果未来这个项目真的长期常驻、规模变大，再考虑把底层 runner/watchdog 部分重写成 Rust。

## 与 OpenClaw 的关系

这个项目明显借鉴了 OpenClaw 的几类思路，但不复用它的整个平台结构。

主要借鉴点：

- PTY 驱动交互式 CLI
- 进程生命周期管理
- no-output watchdog
- 事件驱动而不是直接耦合各层逻辑

不打算照搬的部分：

- 大而全的工具层
- 多 channel 接入
- session/router/plugin 体系
- 平台化架构

一句话概括：

`coco` 更像是一个“围绕个人 agent 工作流定制的极简 runtime”。

## 已完成的 TODO

下面这些已经完成，且代码里已有对应实现：

- [x] 初始化 TypeScript 项目骨架
- [x] 引入 `node-pty`，能拉起单个交互式进程
- [x] 统一单会话接口：`start / write / send / stop / restart / onEvent`
- [x] 实时透传终端输入输出
- [x] 记录 `start / input / output / exit / error` 事件
- [x] transcript 以 JSONL 形式落盘
- [x] 加入 watchdog，支持异常退出后自动重启
- [x] 支持 no-output 超时检测的基本框架
- [x] 处理旧进程 `onExit` 回调覆盖新进程状态的竞态问题
- [x] 处理 `start()` 失败后卡在 `starting` 的问题
- [x] 处理 watchdog 中未捕获 promise rejection 的问题
- [x] 处理 transcript 在退出时可能丢尾部日志的问题
- [x] 处理 `stop()` 超时后状态不清理、导致后续无法重启的问题
- [x] 增加 shutdown 防重入，避免多次信号重复执行关闭逻辑

## 下一阶段计划

当前项目的下一步，不是继续堆基础设施，而是在现有稳定地基上逐步扩展能力。

### Phase 1: 真机验证与打磨

目标：

- 用真实 `codex` 会话完成一次完整 smoke test
- 验证 transcript 是否包含完整生命周期事件
- 验证 watchdog 在真实异常退出时的恢复行为

待完成事项：

- [ ] 在目标机器上跑真实 `codex` 会话
- [ ] 验证 `Ctrl+Q` 退出后的 transcript 完整性
- [ ] 人工杀进程，验证 watchdog 重启
- [ ] 根据真实使用情况微调 timeout 和重启策略

### Phase 2: 双 agent broker

目标：

- 让两个会话之间自动转发消息
- 为“Codex 和 Claude 互相讨论”建立最小闭环

计划事项：

- [ ] 新增 `broker.ts`
- [ ] 订阅两个 session 的 `output` 事件
- [ ] 把一个 agent 的输出包装后写给另一个 agent
- [ ] 增加循环保护，避免无限 ping-pong
- [ ] 增加简单的转发规则和停止条件

### Phase 3: 远程控制

目标：

- 人不在电脑前时，也能远程查看状态和下达简单指令

计划事项：

- [ ] 接 Telegram 作为第一版远程入口
- [ ] 支持 `status`
- [ ] 支持 `start`
- [ ] 支持 `stop`
- [ ] 支持查看最近 transcript 摘要

### Phase 4: 后台长任务编排

目标：

- 支持更长时间运行的任务
- 支持周期性汇报
- 支持异常恢复后的继续推进

计划事项：

- [ ] 增加 heartbeat / progress summary
- [ ] 增加更清晰的任务状态输出
- [ ] 设计大任务的 broker 策略
- [ ] 为“睡觉时自动跑任务”建立最小可用闭环

## 非目标

至少在当前阶段，这些都不是本项目要解决的问题：

- 做成通用 AI 平台
- 支持大量 provider / channel
- 做复杂权限系统
- 做 UI 优先的产品
- 解决所有 tmux 自动化问题
- 做分布式任务调度

这些都可能以后再考虑，但不会影响当前阶段的判断标准。

## 当前判断标准

只有下面这些都稳定后，第一阶段才算真正完成：

- 能稳定启动真实 agent
- 能稳定输入和读取输出
- 能稳定写 transcript
- 能在异常退出时自动恢复
- 能在关闭时尽量保住完整事件

只要这几点没有跑稳，就不应该急着进入复杂 broker 或远程控制。

## 运行方式

安装依赖：

```bash
npm install
```

开发运行：

```bash
npm run dev
```

默认行为：

- 默认命令是 `codex`
- 如果没有传参，默认参数是 `--full-auto`
- 工作目录默认是当前目录，或通过 `COCO_CWD` 指定

示例：

```bash
npx tsx src/index.ts
```

指定命令和参数：

```bash
npx tsx src/index.ts claude --dangerously-skip-permissions
```

指定工作目录：

```bash
COCO_CWD=~/my-project npx tsx src/index.ts
```

运行时行为：

- 当前 terminal 的输入会直接透传给 agent
- agent 输出会实时打印回当前 terminal
- `Ctrl+Q` 会退出 `coco`
- transcript 会写到 `logs/<session-id>.jsonl`

## 目前最重要的一句话

`coco` 现在不是一个“全能 agent 平台”，而是一个为了后续多 agent 自动协作而先打稳单会话 runtime 的项目。

如果后续一切顺利，它会逐步长出 broker、远程控制和长任务编排能力；但现阶段最重要的仍然是把底层生命周期边界跑扎实。
