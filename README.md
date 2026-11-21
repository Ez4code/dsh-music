# dsh-music — 让 DeepSeek Harness 控制 Mac 上的 Apple Music

**一个 DeepSeek Harness 插件**（Host-only bundle）。装上它，DSH 就能用一句自然语言控制本机「音乐」App——点歌、暂停、切歌、调系统音量、查当前播放。插件向 Agent 注册 `music_play`、`music_search`、`music_control`、`music_status` 四个工具，你不用记这些名字，直接说话就行。

**真正的亮点**：配合基础插件 [`@xmanrui/dsh-im`](https://www.npmjs.com/package/@xmanrui/dsh-im)，你可以在**微信 / QQ / 飞书 / Telegram** 里发一句话，让家里的 Mac 放歌——人不在电脑前也能点歌。

```mermaid
flowchart LR
  Phone["📱 手机微信 / QQ"] --> IM["@xmanrui/dsh-im<br/>消息通道"]
  IM --> Agent["DSH Agent"]
  Agent -->|music_play / music_control| Plugin["dsh-music"]
  Plugin -->|Unix socket| Helper["MusicHelper.app"]
  Helper -->|AppleScript| Music["🎵 音乐 App"]
  Music --> Speakers["🔊 Mac 扬声器"]
```

---

## 亮点：在微信 / QQ 里点歌

装上 `dsh-im` 并接入一个通道后，聊天窗口就是你的遥控器：

| 你在手机里说 | 实际发生 |
|---|---|
| 「放一首 Bang!」 | `music_play` 在资料库里按歌名匹配并播放 |
| 「来点周杰伦」 | 按歌手匹配，播放资料库里的周杰伦 |
| 「下一首」「暂停一下」 | `music_control` 对应操作 |
| 「声音小一点」/「音量调到 30」 | 调**系统输出音量**（菜单栏那个） |
| 「现在在放什么」 | `music_status` 回报曲目、进度、音量 |

代码上不需要任何胶水：`dsh-music` 的工具注册在 profile 上，`dsh-im` 只是把 IM 消息送进同一个 Agent。两个插件各装各的即可。

> ⚠️ 安全提醒：能给你 IM 机器人发消息的人，就能控制这台 Mac 的音量。请把机器人设为私有，或只允许自己的账号。

---

## 插件提供的工具

插件是一个 bundle（`package.json` 里 `dsh.bundle.patch` 指向 `cordis.patch.yml`），安装后向 Agent 注册四个工具：

| 工具 | 说明 |
|---|---|
| `music_play` | 播放资料库曲目：`query` 依次匹配歌名、歌手、专辑；`kind: "playlist"` 播放用户播放列表 |
| `music_search` | 只搜不播，列出资料库里的候选曲目（确认是否已加入资料库时用） |
| `music_control` | `play` / `pause` / `toggle` / `next` / `previous` / `stop` / `volume`（0–100，**系统输出音量**） |
| `music_status` | 运行状态、播放状态、当前曲目、歌手、专辑、进度、系统音量与静音状态 |

对 DSH 说「放一首 Bang!」「下一首」「声音小一点」「现在在放什么」就行。

`volume` 调的是 **macOS 系统输出音量**（和菜单栏、键盘音量键同一个），不是「音乐」App 内部的音量滑块；调大时如果系统处于静音会自动取消静音。

---

## 为什么只支持资料库

不是 Apple Music 的限制，而是 macOS 26（Tahoe）上的自动化限制：用 `itmss://`、`music://`、`https://` 链接、`open location`、甚至 UI 脚本让「音乐」播放**未加入资料库**的目录曲目时，App 只会把条目加载出来，`player state` 停在 `stopped`、进度停在 0，不会串流；而资料库里的曲目（包括云端曲目）能正常从 0 秒开始播放。

所以本插件砍掉了目录搜索和 30 秒试听，只做资料库。想听某首目录里的歌：先在「音乐」App 里搜到并点「＋」加入资料库，之后 `music_play` 就能完整播放。

---

## 安装

前置条件：

- macOS 26（Tahoe）或更新版本
- DeepSeek Harness（Desktop 或 Web）
- 「音乐」App 已登录 Apple Music，且资料库里有一些曲目

安装方式：

1. 打开 DSH 的 **插件（Plugins）** 页面；
2. 点 **添加插件（Add plugin）**，选择本目录（包含 `package.json` 的那一层）；
3. 新开一个会话，问它「现在在放什么」验证。

也可以让 DSH 自己装：把本目录路径交给 `plugin_manager` 的 `install_bundle`。

首次控制「音乐」时，macOS 可能弹出一次 **「MusicHelper 想要控制「音乐」」**，点「允许」即可，之后不再打扰。插件卸载后工具立即消失，不会影响正在播放的音乐。

---

## 工作原理

1. **为什么需要助手 App**：Harness 宿主本身在沙箱里运行，且没有声明 Apple Events 用途，直接 `osascript` 控制「音乐」会被系统拒绝（错误 `-10004 权限违例`）。插件因此内置了一个 ad-hoc 签名的小助手 `assets/MusicHelper.app`，由 `open` 启动——它有自己的自动化授权身份，不受宿主沙箱限制。
2. **常驻守护进程**：助手监听 Unix socket `/tmp/dsh-music/helper.sock`（长度前缀 + JSON，一次连接一个请求）。第一次调用冷启动约 300–500 ms，之后每次只是一次 socket 往返（10–30 ms）。
3. **生命周期**：插件卸载时发送 `{"shutdown": true}` 让助手退出；空闲 5 分钟也会自动退出；socket 文件权限 `0600`。
4. **串行执行**：AppleScript 调用在插件内排队，助手一次只处理一个请求，避免互相覆盖。

### 性能（同一台机器，资料库 75 首）

| 工具 | 优化前（每次冷启动助手） | 现在（常驻 socket） |
|---|---|---|
| `music_status` | 275–390 ms | 约 130 ms |
| `music_control` | 约 1000 ms | 50–70 ms |
| `music_play` | 约 1730 ms | 约 130–270 ms |
| `music_play`（未命中） | 约 280 ms | 约 65 ms |
| `music_search` | 约 390 ms | 70–85 ms |

做法：常驻守护进程 + 用「等状态变化」的短轮询替代固定的 `delay` + 控制操作不再多余地读一次系统音量。

---

## 配置

在 `cordis.patch.yml` 的插件行里可调：

| 键 | 默认值 | 说明 |
|---|---|---|
| `timeoutSec` | `20` | 单次 AppleScript 调用的超时（秒），上限 120 |
| `helperPath` | 包内 `assets/MusicHelper.app` | 助手 App 路径 |
| `exchangeDir` | `/tmp/dsh-music` | 助手与插件交换 socket 的目录 |

---

## 目录结构

```
dsh-music/
├── index.js              # 插件实现：工具注册 + 助手守护进程客户端
├── cordis.patch.yml      # bundle 补丁：插入插件行
├── package.json          # bundle 清单（dsh.bundle.patch）
├── locale/{en,zh}.json   # 插件页里的标题与描述
├── icon.svg              # 插件图标
├── assets/MusicHelper.app # 持有自动化授权的助手（含已签名二进制）
└── tools/
    ├── MusicHelper.m     # 助手源码（Objective-C）
    └── build-helper.sh   # 重新编译 + ad-hoc 签名
```

想改助手逻辑时：`sh tools/build-helper.sh`（需要 Xcode Command Line Tools）。重新签名后首次控制可能会再弹一次授权。

---

## 限制

- **只播放已加入资料库的曲目**，不访问网络、不搜索 Apple Music 目录、不录音、不上传任何数据。
- 云端曲目需要有效的 Apple Music 订阅；本地文件曲目无此限制。
- 同一时间只串行执行一条 AppleScript。
- 只在 macOS 上工作（依赖「音乐」App 与 AppleScript）。

---

## English

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin (Host-only bundle) that lets the agent control the macOS **Music** app: play a library track by title/artist/album, play a user playlist, pause/resume, skip, stop, set the **system output volume**, and read what is playing. It registers four tools — `music_play`, `music_search`, `music_control`, `music_status`.

Combined with [`@xmanrui/dsh-im`](https://www.npmjs.com/package/@xmanrui/dsh-im), you can send "play something" from WeChat, QQ, Feishu, or Telegram and the Mac starts playing — no extra glue code, because both plugins share the same agent.

Library-only by design: on macOS 26 every programmatic route to a catalog track loads it without streaming, while library tracks (including cloud tracks) play normally.

## License

MIT
