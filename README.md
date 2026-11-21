# dsh-music · 在聊天窗口里控制 Mac 播放 Apple Music

> **一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件。**
> 给本机「音乐」App 装上双手：点歌、暂停、切歌、调系统音量、查当前播放。
> 配合 [`@xmanrui/dsh-im`](https://www.npmjs.com/package/@xmanrui/dsh-im)，在**微信 / QQ / 飞书 / Telegram** 发一句话，家里的 Mac 就开始放歌——人不在电脑前也能点歌。

![platform](https://img.shields.io/badge/platform-macOS%2026-black)
![dsh](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4B6BFB)
![license](https://img.shields.io/badge/license-MIT-green)

如果你正在搜「**怎么用脚本控制 macOS 音乐**」「**AppleScript 控制 Music.app 报 -10004**」「**让 IM 机器人 / Agent 点歌**」「**微信控制电脑播放音乐**」——本项目把踩过的坑和解法都写在下面了，代码可以直接复用。

---

## 30 秒上手

```bash
# 1. 前置：macOS 26+、DSH、已登录 Apple Music 且资料库里有歌
git clone https://github.com/Ez4code/dsh-music.git
# 2. 装进 DSH
#    DSH → 插件（Plugins）→ 添加插件（Add plugin）→ 选择刚克隆的 dsh-music 目录
#    或让 Agent 执行：plugin_manager → install_bundle("/path/to/dsh-music")
# 3. 新开一个会话验证
```

然后直接说：

> 「现在在放什么」
> 「放一首 Bang!」
> 「下一首，声音小一点」

首次控制「音乐」时，macOS 会弹一次 **「MusicHelper 想要控制「音乐」」**，点「允许」即可，之后不再打扰。

---

## 在微信 / QQ 里点歌（亮点）

这是本项目最实用的玩法：DSH 装好 [`@xmanrui/dsh-im`](https://www.npmjs.com/package/@xmanrui/dsh-im) 并接入一个 IM 通道后，**聊天窗口就是遥控器**：

```
你（微信）：放一首 Bang!
DSH：正在播放：Bang! — AJR《OK ORCHESTRA》

你：下一首，音量调到 40
DSH：正在播放（系统音量 40）：Sports car — Tate McRae

你：现在在放什么
DSH：正在播放：Sports car — Tate McRae《SO CLOSE TO WHAT???》
     （0:42 / 2:45，系统音量 40）
```

**不需要任何胶水代码**：`dsh-music` 的工具注册在 profile 上，`dsh-im` 只负责把消息送进同一个 Agent，两个插件各装各的。

> ⚠️ 安全提醒：能给机器人发消息的人，就能控制这台 Mac 的音量。请把机器人设为私有，或只允许自己的账号。

---

## 它能做什么

| 能力 | 说明 |
|---|---|
| 🎵 点歌 | 按歌名 / 歌手 / 专辑匹配资料库曲目，部分匹配，中英文都行 |
| 📃 播放列表 | 播放你自己的播放列表 |
| ⏯️ 播放控制 | 继续、暂停、播放/暂停、上一首、下一首、停止 |
| 🔊 系统音量 | 调的是**系统输出音量**（和菜单栏、键盘音量键同一个），不是「音乐」App 内部滑块；调大时自动取消静音 |
| 🔍 搜索 | 只搜不播，确认某首歌在不在资料库 |
| 📊 状态 | 当前曲目、歌手、专辑、进度、系统音量与静音状态 |

插件向 Agent 注册四个工具：`music_play`、`music_search`、`music_control`、`music_status`。你不需要记这些名字，直接说话就行。

---

## 为什么只支持资料库（重要设计）

不是 Apple Music 的限制，而是 **macOS 26（Tahoe）的自动化限制**：用 `itmss://`、`music://`、`https://` 链接、`open location`、甚至 UI 脚本让「音乐」播放**未加入资料库**的目录曲目时，App 只会把条目加载出来，`player state` 停在 `stopped`、进度停在 0，**不会串流**；而资料库里的曲目（包括云端曲目）能正常从 0 秒开始播。

所以本插件砍掉了目录搜索和 30 秒试听，只做资料库，换来「点了一定能响」。想听某首目录里的歌：先在「音乐」App 里搜到并点「＋」加入资料库，之后就能用 `music_play` 完整播放。

---

## 工作原理

```mermaid
flowchart LR
  Phone["📱 手机微信 / QQ"] --> IM["@xmanrui/dsh-im<br/>消息通道"]
  IM --> Agent["DSH Agent"]
  Agent -->|"music_play / music_control / music_status"| Plugin["dsh-music 插件"]
  Plugin -->|"Unix socket<br/>/tmp/dsh-music/helper.sock"| Helper["MusicHelper.app"]
  Helper -->|AppleScript| Music["🎵 音乐 App"]
  Music --> Speakers["🔊 Mac 扬声器"]
```

1. **为什么需要一个助手 App**：DSH 宿主本身在沙箱里运行、且没有声明 Apple Events 用途，直接 `osascript` 控制「音乐」会被系统拒绝（`-10004 权限违例`）。插件因此内置 ad-hoc 签名的 `assets/MusicHelper.app`，由 `open` 启动——它有自己的自动化授权身份，不受宿主沙箱限制。
2. **常驻守护进程**：助手监听 Unix socket（长度前缀 + JSON，一次连接一个请求）。第一次调用冷启动约 300–500 ms，之后每次只是一次 socket 往返（10–30 ms）+ AppleScript 执行。
3. **生命周期**：插件卸载时发送 `{"shutdown": true}` 让助手退出；空闲 5 分钟自动退出；socket 文件权限 `0600`；重复启动会用文件锁 + socket 探测直接退出，不会抢走正在工作的守护进程。
4. **串行执行**：AppleScript 调用在插件内排队，助手一次只处理一个请求。

### 性能（本机实测，资料库 75 首）

| 工具 | 优化前（每次冷启动助手） | 现在（常驻 socket） |
|---|---|---|
| `music_status` | 275–390 ms | 约 130 ms |
| `music_control` | 约 1000 ms | 50–70 ms |
| `music_play` | 约 1730 ms | 约 130–270 ms |
| `music_play`（未命中） | 约 280 ms | 约 65 ms |
| `music_search` | 约 390 ms | 70–85 ms |

---

## 配置

在 `cordis.patch.yml` 的插件行里可调：

| 键 | 默认值 | 说明 |
|---|---|---|
| `timeoutSec` | `20` | 单次 AppleScript 调用的超时（秒），上限 120 |
| `helperPath` | 包内 `assets/MusicHelper.app` | 助手 App 路径 |
| `exchangeDir` | `/tmp/dsh-music` | 助手与插件交换 socket 的目录 |

---

## 给实现同类功能的开发者（可直接复用的部分）

如果你也在做「Agent / 机器人控制 macOS 音乐」或类似的 AppleScript 集成，这几条能省你不少时间：

- **`-10004 权限违例` 不是脚本写错了**：宿主应用没有 `NSAppleEventsUsageDescription` 时，TCC 不会弹窗，直接拒绝。解法是让 AppleScript 跑在**有自己 bundle id 的助手 App** 里（`open` 启动，TCC 身份独立）。`tools/MusicHelper.m` 是完整实现。
- **别用 `osascript` 子进程**：每次调用 ~400 ms 起步。改成常驻 Unix socket 守护进程后，单次调用降到 10–30 ms。
- **macOS 26 目录曲目不可编程播放**：`itmss://` / `music://` / `open location` 都只会加载不串流，只能播资料库（含云端）曲目。别在目录搜索上浪费时间。
- **调系统音量**：`set volume output volume N`（Standard Additions），不是 Music 的 `sound volume`。
- **读状态**：`player state`、`player position`、`current track`；注意 `current track` 在无曲目时会报错，要用 `try` 包住。

---

## FAQ

**Q：为什么第一次调用会弹「MusicHelper 想要控制「音乐」」？**
A：macOS 的自动化授权（TCC）绑定在「发送 Apple 事件的应用」上。助手 App 是独立的签名主体，授权一次后长期有效。点「允许」即可；如果误点拒绝，可在「系统设置 → 隐私与安全性 → 自动化」里重新打开。

**Q：为什么调了音量还是没声音？**
A：先看 `music_status` 里的系统音量与静音状态；播放器本身没在播、或系统输出设备被切到别的设备也会导致没声音。

**Q：支持 Spotify / 网易云吗？**
A：目前只做「音乐」App（Apple Music）。协议层（助手 + 工具）是通用的，欢迎 PR 扩展。

**Q：会把我的音乐数据传到哪吗？**
A：不会。插件只在本机通过 AppleScript 操作「音乐」App，不联网、不录音、不上传；`dsh-im` 只负责在你的 IM 与 Agent 之间传消息。

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

改助手逻辑：`sh tools/build-helper.sh`（需要 Xcode Command Line Tools）。重新签名后首次控制可能再弹一次授权。

## 限制

- 只播放**已加入资料库**的曲目，不访问网络、不搜索 Apple Music 目录、不录音、不上传任何数据。
- 云端曲目需要有效的 Apple Music 订阅；本地文件曲目无此限制。
- 只在 macOS 上工作（依赖「音乐」App 与 AppleScript），需要 macOS 26+。
- 同一时间只串行执行一条 AppleScript。

---

## 搜索关键词

`dsh 插件` · `DeepSeek Harness 插件` · `Apple Music 控制` · `macOS 音乐自动化` · `AppleScript Music.app` · `微信控制电脑播放音乐` · `QQ 机器人点歌` · `IM 远程点歌` · `macOS TCC -10004` · `AppleEvents 授权` · `remote control Apple Music` · `music automation agent` · `AI agent tool plugin` · `Apple Music library playback`

## English

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin (Host-only bundle) that lets the agent control the macOS **Music** app: play a library track by title/artist/album, play a user playlist, pause/resume, skip, stop, set the **system output volume**, and read what is playing. It registers four tools — `music_play`, `music_search`, `music_control`, `music_status`.

Paired with [`@xmanrui/dsh-im`](https://www.npmjs.com/package/@xmanrui/dsh-im), you can send "play something" from WeChat, QQ, Feishu, or Telegram and the Mac starts playing — no glue code, because both plugins share the same agent.

Library-only by design: on macOS 26 every programmatic route to a catalog track loads it without streaming, while library tracks (including cloud tracks) play normally. The bundled helper app exists because the Harness host is sandboxed and cannot send Apple events itself.

## License

MIT
