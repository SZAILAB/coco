# coco

`coco` 是一个面向个人工作流的轻量级 agent 远程控制工具。

当前最核心的用法是：

- 在电脑上已经有一个正在使用的 Codex / Claude 会话
- 你出门后，想通过飞书继续和这个会话对话
- 回到电脑后，再继续使用同一个逻辑会话

这版 README 只讲 `coco` 当前最实用的 direct-session 用法，重点放在 **飞书**。

## coco 现在适合做什么

- 通过 **飞书** 继续一个已有的 Claude session
- 通过 **飞书** 继续一个已有的 Codex session
- 在同一个聊天里同时绑定一个 Codex 和一个 Claude
- 在两者之间切换默认目标
- 临时把某一条消息定向发给另一侧 agent
- 让默认 agent 先起草，再让另一侧 agent review，最后回到默认 agent 出 final

## 当前边界

这版 direct-session 很刻意地收得很小：

- 只支持你**手动提供**已有 session id / thread id
- 只支持 resume，不做 latest-session bridge
- 不做 Claude fork
- 不做 tmux attach
- 不做 session list
- binding 目前还是**进程内状态**
  - bot 重启后需要重新 bind
- `xcheck` 目前是固定三段式
  - 不做无限互评
  - 不做自动 hard timeout

也就是说，当前正确的心智模型是：

- `coco` 不是自己发明一套会话
- `coco` 是帮你**接回一个已经存在的会话**

## Direct Session 模型

每个绑定都由 3 个信息组成：

- `agent`
- `session_id` / `thread_id`
- `cwd`

这里的 `cwd` 不是附属信息，而是 binding 的一部分。

原因很简单：

- Claude 的 session 本来就和项目目录强相关
- Codex resume 后这轮真正工作的 repo / 文件上下文，也取决于 `cwd`

所以在使用上，你只需要记住一件事：

- 绑定已有 session 时，除了 `session_id` / `thread_id`，还必须提供它原来的工作目录

## 安装

```bash
cd /path/to/coco
npm install
```

## 飞书优先

如果你只打算先接一个远程入口，当前更推荐 **飞书**。

原因：

- 我们已经做过真机 smoke
- 命令面已经打通
- 适合手机直接继续已有会话

### 飞书启动

```bash
cd /path/to/coco
COCO_FEISHU_APP_ID=你的_app_id \
COCO_FEISHU_APP_SECRET=你的_app_secret \
npm run feishu
```

可选环境变量：

- `COCO_FEISHU_DOMAIN`
- `COCO_FEISHU_USERS`
- `COCO_FEISHU_CHATS`

启动成功后，终端会看到：

```text
[feishu] Starting bot...
[feishu] Bot is running
```

## Telegram

Telegram 也能用，但这版 README 不把它当主路径。

启动方式：

```bash
cd /path/to/coco
COCO_TELEGRAM_TOKEN=你的_bot_token \
COCO_TELEGRAM_USERS=你的_numeric_user_id \
npm run telegram
```

## /coco 命令

所有 bot 自己的 direct-session 控制命令都在 `/coco ...` 命名空间下。

这点很重要，因为 Codex / Claude 自己也有 slash command。

规则是：

- 所有 `/coco ...` 会被 bot 拦截
- 其他所有消息都会发给当前 active target
- 这也包括 agent 自己的 slash command，比如 `/compact`
- 如果 `xcheck` 已开启，普通消息会走 `owner draft -> reviewer review -> owner final`
- 但像 `/compact` 这样的 agent slash command 仍然会直接发给当前 active target，不走 `xcheck`

如果当前 chat 里还没有 active target：

- 普通消息不会被处理
- bot 会提示你先执行 `/coco bind ...`

### 1. `/coco help`

查看帮助：

```text
/coco help
```

### 2. `/coco bind codex <thread_id> <cwd>`

绑定一个已有的 Codex 会话：

```text
/coco bind codex abc123 /path/to/project
```

### 3. `/coco bind claude <session_id> <cwd>`

绑定一个已有的 Claude 会话：

```text
/coco bind claude 3f101bd8-767e-49fa-94e5-39a2eecbe08c /path/to/project
```

### 4. `/coco use <codex|claude>`

切换当前默认目标：

```text
/coco use codex
/coco use claude
```

设置之后，任何**非 `/coco`** 消息都会自动发给当前目标。

### 5. `/coco ask <codex|claude> <text>`

单次定向发消息，但**不切换默认目标**：

```text
/coco ask claude 帮我 review 一下刚才 codex 的回复
/coco ask codex 请你回应一下刚才 claude 的意见
```

### 6. `/coco current`

查看当前绑定状态：

```text
/coco current
```

它会显示：

- 当前 active target
- 当前 chat 绑定了哪些 agent
- 每个 binding 的 session id
- 每个 binding 的 cwd
- 当前状态（`ready / busy / error / exited`）

### 7. `/coco detach [codex|claude]`

解除绑定：

```text
/coco detach
/coco detach claude
/coco detach codex
```

不带参数时，默认 detach 当前 active target。

### 8. `/coco xcheck on`

开启固定三段式 cross-check：

```text
/coco xcheck on
```

前提：

- 当前 chat 里已经同时绑定 `codex` 和 `claude`
- 当前已经有 active target

开启后：

- `owner = 当前 active target`
- `reviewer = 另一侧 agent`

每条普通消息都会执行一轮：

1. 用户消息发给 owner
2. owner 输出 draft
3. reviewer 基于 draft 输出 review
4. owner 基于 review 输出 final

这一轮结束后，下一条普通消息才会再次触发新一轮。

### 9. `/coco xcheck off`

关闭 `xcheck` 模式：

```text
/coco xcheck off
```

关闭后，普通消息恢复成只发给当前 active target。

### 10. `/coco xcheck status`

查看当前 `xcheck` 状态：

```text
/coco xcheck status
```

它会显示：

- 是否开启
- 当前 owner / reviewer
- 当前 run 是 `idle` 还是 `running`
- 如果正在运行，当前停在哪个 step
- 是否已经请求 stop
- 最近一次错误

### 11. `/coco xcheck stop`

停止当前正在执行的这一轮：

```text
/coco xcheck stop
```

注意：

- 这不会关闭 `xcheck mode`
- 它是**协作式停止**
- 也就是会等当前这一步执行完，再不进入下一步

## 最推荐的飞书工作流

### 场景 1：只继续一个 Claude 会话

```text
/coco bind claude <session_id> <cwd>
/coco current
继续刚才的话题，用一句话告诉我我们现在在做什么
```

### 场景 2：只继续一个 Codex 会话

```text
/coco bind codex <thread_id> <cwd>
/coco current
继续刚才那个实现
```

### 场景 3：同一个聊天同时绑定 Codex 和 Claude

```text
/coco bind codex <thread_id> <cwd>
/coco bind claude <session_id> <cwd>
/coco current
/coco use codex
继续做刚才那个修改
/coco ask claude 帮我 review 一下刚才 codex 的思路
/coco use claude
你再展开讲一下刚才的 review
```

这是目前最接近你真实工作流的使用方式。

### 场景 4：固定三段式 xcheck

```text
/coco bind codex <thread_id> <cwd>
/coco bind claude <session_id> <cwd>
/coco use codex
/coco xcheck on
帮我把这个改动方案写完整
```

这时 bot 会依次回：

```text
[codex draft <thread_id>]
...

[claude review <session_id>]
...

[codex final <thread_id>]
...
```

如果这轮还没跑完，你又发了一条普通消息，bot 会提示：

```text
xcheck already running, please wait
```

## 回复长什么样

bot 回复时会带来源前缀，例如：

```text
[claude 3f101bd8-767e-49fa-94e5-39a2eecbe08c]
...
```

或者：

```text
[codex abc123]
...
```

`xcheck` 模式下则会看到带 phase 的前缀：

```text
[codex draft abc123]
...

[claude review 3f101bd8-767e-49fa-94e5-39a2eecbe08c]
...

[codex final abc123]
...
```

这样你不会混淆当前是哪一侧在说话。

## 注意事项

### 1. `cwd` 必须对应原来的工作目录

这是最重要的一条。

如果你给了错误的 `cwd`：

- Claude 可能找不到 session
- Codex 即使 resume 成功，也可能在错误的 repo / 文件上下文里工作

### 2. bot 重启后要重新 bind

当前 direct-session binding 还没有做持久化。

所以：

- bot 进程重启
- Telegram / Feishu 进程重启

之后都需要重新执行 `/coco bind ...`

### 3. 当前不做 list

也就是说：

- 你不能在 bot 里列出现有 session
- 你必须自己知道要继续的 `session_id` / `thread_id`

### 4. 当前不做 tmux attach

`coco` 现在支持的是：

- 继续一个已有的**逻辑会话**

它现在还不支持的是：

- attach 到一个你已经开着的 tmux pane
- 直接接管那个活着的 terminal 进程

这件事后面会再做。

## 项目结构（只列当前最相关部分）

```text
coco/
  src/
    feishu.ts
    feishu-runtime.ts
    telegram.ts
    coco-commands.ts
    direct-backend.ts
    direct-session.ts
```

## 当前最值得继续做的方向

- direct-session binding 持久化
- session list
- tmux attach mode

这三件里，真正最贴近实际工作流的是 **tmux attach mode**，但在它之前，`session-first` 这套 resume 逻辑已经足够让你在飞书上继续已有的 Codex / Claude 会话。
