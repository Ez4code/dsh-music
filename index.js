/**
 * dsh-music — a Host-only plugin that lets the agent control the macOS
 * 「音乐」Music app for the user's own library: play a track by name, artist,
 * or album, play a user playlist, pause, skip, stop, set the system output
 * volume, and read what is playing.
 *
 * Deliberately library-only: Apple Music catalog playback was removed because
 * every programmatic way to start a catalog track on macOS 26 (itmss:// and
 * music:// URLs, open location, UI scripting) loads the item but never starts
 * streaming, while library tracks — including cloud tracks — play normally.
 * Songs must therefore be in the library before the agent can play them.
 *
 * Why a helper app: the Harness host is sandboxed and its Info.plist declares
 * no Apple-event usage, so `osascript` run from the host is refused by Music
 * (`-10004`). `assets/MusicHelper.app` is a tiny signed helper that runs the
 * AppleScript in its own process, so macOS attributes the automation
 * permission prompt to the helper itself once and later calls need no prompt.
 *
 * The helper is a warm daemon on the Unix socket `/tmp/dsh-music/helper.sock`
 * (length-framed JSON, one request per connection): the first tool call starts
 * it with `open`, every later call is a plain socket round trip, and it exits
 * when the plugin unloads or after five idle minutes. This is why calls cost
 * tens of milliseconds instead of paying a process launch per call.
 *
 * No Harness package is imported: the helper path, exchange directory, and
 * timeout come from the bundle patch row and are normalized here.
 */

import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { connect } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const MODULE_DIR = dirname(fileURLToPath(import.meta.url))

/** Defaults; every value can be overridden in the plugin row's `config`. */
const DEFAULTS = {
  /** Absolute path of the helper bundle that owns the Music automation grant. */
  helperPath: join(MODULE_DIR, 'assets', 'MusicHelper.app'),
  /** Directory the helper reads `script.osa` from and writes `result.json` to. */
  exchangeDir: '/tmp/dsh-music',
  /** How long one AppleScript call may take before the tool reports a timeout. */
  timeoutSec: 20,
}

const SEP = '\t'

/** AppleScript string literal with quotes and backslashes escaped. */
function appleText(value) {
  const source = String(value ?? '')
  const text = source.replace(/[\r\n\t]+/g, ' ').replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  if (!text) throw new Error('要播放或搜索的内容不能为空。')
  return '"' + text.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** AppleScript calls are serialized; the helper daemon serves one at a time. */
let queue = Promise.resolve()

function enqueue(task) {
  const run = queue.then(task, task)
  queue = run.then(() => undefined, () => undefined)
  return run
}

/** One framed request to the helper daemon; resolves with its result string. */
function request(socketPath, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath)
    const body = Buffer.from(JSON.stringify(payload), 'utf8')
    const header = Buffer.alloc(4)
    header.writeUInt32BE(body.length, 0)
    let data = ''
    let settled = false

    const finish = (error, value) => {
      if (settled) return
      settled = true
      socket.destroy()
      if (error) reject(error)
      else resolve(value)
    }

    socket.setEncoding('utf8')
    socket.setTimeout(timeoutMs, () => finish(new Error('timeout')))
    socket.on('connect', () => socket.write(Buffer.concat([header, body])))
    socket.on('data', (chunk) => { data += chunk })
    socket.on('end', () => {
      let parsed
      try {
        parsed = JSON.parse(data)
      } catch {
        finish(new Error('音乐控制助手返回了无法解析的结果'))
        return
      }
      if (parsed.ok !== true) {
        finish(new Error(`「音乐」App 拒绝了操作：${parsed.error ?? '未知错误'}`))
        return
      }
      finish(null, String(parsed.result ?? ''))
    })
    socket.on('error', (error) => finish(error))
  })
}

/** Start the helper daemon (its TCC grant belongs to the app bundle). */
async function startDaemon(options) {
  await mkdir(options.exchangeDir, { recursive: true })
  await new Promise((resolve, reject) => {
    execFile('/usr/bin/open', ['-n', '-g', '-a', options.helperPath], (error) => {
      if (error) reject(new Error(`无法启动音乐控制助手：${error.message}`))
      else resolve()
    })
  })
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    await sleep(50)
    try {
      await request(options.socketPath, { ping: true }, 400)
      return
    } catch {
      // not listening yet
    }
  }
  throw new Error('音乐控制助手没有启动成功，请检查 assets/MusicHelper.app 是否完整。')
}

/** One shared launch promise so concurrent first calls cannot race. */
let daemonPromise = null

function ensureDaemon(options) {
  if (!daemonPromise) {
    daemonPromise = startDaemon(options).catch((error) => {
      daemonPromise = null
      throw error
    })
  }
  return daemonPromise
}

async function shutdownDaemon(options) {
  try {
    await request(options.socketPath, { shutdown: true }, 400)
  } catch {
    // already gone
  }
}

/** Run one AppleScript through the warm daemon, starting it on first use. */
function runScript(source, options) {
  return enqueue(async () => {
    options.signal?.throwIfAborted()
    try {
      return await request(options.socketPath, { source }, options.timeoutSec * 1000)
    } catch (error) {
      if (error.message === 'timeout') throw error
      daemonPromise = null
      await ensureDaemon(options)
      return await request(options.socketPath, { source }, options.timeoutSec * 1000)
    }
  })
}

// ---------------------------------------------------------------------------
// AppleScript builders
// ---------------------------------------------------------------------------

function playTrackScript(query, artist) {
  const q = appleText(query)
  const artistClause = artist ? ` and (artist contains ${appleText(artist)})` : ''
  return `tell application "Music"
  set q to ${q}
  set hits to (every track of library playlist 1 whose (name contains q)${artistClause})
  if (count of hits) is 0 then set hits to (every track of library playlist 1 whose (artist contains q)${artistClause})
  if (count of hits) is 0 then set hits to (every track of library playlist 1 whose (album contains q)${artistClause})
  if (count of hits) is 0 then return "NOT_FOUND"
  set t to item 1 of hits
  play t
  set tries to 0
  repeat until tries > 8
    if (player state) is playing then exit repeat
    delay 0.03
    set tries to tries + 1
  end repeat
  return "OK" & tab & (player state as text) & tab & (name of t) & tab & (artist of t) & tab & (album of t)
end tell`
}

function playPlaylistScript(name) {
  const q = appleText(name)
  return `tell application "Music"
  set q to ${q}
  repeat with p in user playlists
    if (name of p) is q then
      play p
      delay 0.2
      return "OK" & tab & (player state as text) & tab & (name of p) & tab & "-" & tab & "-"
    end if
  end repeat
  repeat with p in user playlists
    if (name of p) contains q then
      play p
      delay 1.5
      return "OK" & tab & (player state as text) & tab & (name of p) & tab & "-" & tab & "-"
    end if
  end repeat
  return "NOT_FOUND"
end tell`
}

const CONTROL_STATEMENTS = {
  play: 'play',
  pause: 'pause',
  next: 'next track',
  previous: 'previous track',
  stop: 'stop',
  toggle: `if (player state is playing) then
    pause
  else
    play
  end if`,
  volume: null,
}

function controlScript(action, volume) {
  if (action === 'volume') {
    // System output volume (Standard Additions), not the Music app's own slider.
    return `set volume output volume ${Math.round(volume)}
if ${Math.round(volume)} > 0 then set volume without output muted
set vs to get volume settings
return "OK" & tab & "system" & tab & (output volume of vs) & tab & (output muted of vs)`
  }
  const statement = CONTROL_STATEMENTS[action]
  // Wait just long enough for the player to settle instead of a fixed delay:
  // a fixed wait is either too slow or races the Music app.
  let waitBlock = ''
  if (action === 'pause' || action === 'stop') {
    waitBlock = [
      '  set tries to 0',
      '  repeat until tries > 6',
      '    if (player state) is not playing then exit repeat',
      '    delay 0.03',
      '    set tries to tries + 1',
      '  end repeat',
    ].join('\n')
  } else if (action === 'play') {
    waitBlock = [
      '  set tries to 0',
      '  repeat until tries > 8',
      '    if (player state) is playing then exit repeat',
      '    delay 0.03',
      '    set tries to tries + 1',
      '  end repeat',
    ].join('\n')
  } else if (action === 'toggle') {
    waitBlock = '  delay 0.12'
  }
  return `tell application "Music"
  ${statement}
${waitBlock}
  return "OK" & tab & (player state as text)
end tell`
}

const STATUS_SCRIPT = `set vs to get volume settings
set sysVol to (output volume of vs) as text
set sysMuted to (output muted of vs) as text
if not (application "Music" is running) then return "OFF" & tab & sysVol & tab & sysMuted
tell application "Music"
  set pstate to (player state as text)
  set tname to "-"
  set tartist to "-"
  set talbum to "-"
  set tpos to "0"
  set tdur to "0"
  try
    set t to current track
    set tname to (name of t)
    set tartist to (artist of t)
    set talbum to (album of t)
    set tpos to (player position as text)
    set tdur to (duration of t as text)
  end try
end tell
return "OK" & tab & pstate & tab & sysVol & tab & sysMuted & tab & tname & tab & tartist & tab & talbum & tab & tpos & tab & tdur`

function searchLibraryScript(query, artist, limit) {
  const clauses = []
  if (query) {
    const q = appleText(query)
    clauses.push(`(name contains ${q})`, `(artist contains ${q})`, `(album contains ${q})`)
  }
  if (artist) clauses.push(`(artist contains ${appleText(artist)})`)
  const condition = clauses.length ? clauses.join(' or ') : 'true'
  return `tell application "Music"
  set out to ""
  set n to 0
  set hits to (every track of library playlist 1 whose ${condition})
  repeat with t in hits
    if n >= ${Math.max(1, Math.min(limit, 50))} then exit repeat
    set n to n + 1
    set out to out & (name of t) & tab & (artist of t) & tab & (album of t) & linefeed
  end repeat
  return out
end tell`
}

// ---------------------------------------------------------------------------
// Result parsing
// ---------------------------------------------------------------------------

function stateLabel(state) {
  if (state === 'playing') return '正在播放'
  if (state === 'paused') return '已暂停'
  if (state === 'stopped') return '已停止'
  return '空闲'
}

function parsePlayResult(raw, kind) {
  if (raw === 'NOT_FOUND') return { ok: false, reason: 'not-found' }
  const [state, track, artist, album] = raw.split(SEP).slice(1)
  if (kind === 'playlist') {
    return { ok: true, state, track, summary: `${stateLabel(state)}播放列表：${track}` }
  }
  const summary = `${stateLabel(state)}：${track} — ${artist}${album && album !== '-' ? `《${album}》` : ''}`
  return { ok: true, state, track, artist, album, summary }
}

function parseControlResult(raw, action) {
  const [state, volume, muted] = raw.split(SEP).slice(1)
  if (action === 'volume') {
    return {
      ok: true,
      state: 'system',
      volume: Number(volume),
      muted: muted === 'true',
      summary: `系统音量已调到 ${volume}`,
    }
  }
  return { ok: true, state, summary: stateLabel(state) }
}

function parseStatus(raw) {
  if (raw.startsWith('OFF')) {
    const [, volume] = raw.split(SEP)
    return {
      ok: true,
      running: false,
      state: 'off',
      volume: Number(volume),
      summary: `「音乐」App 没有在运行（系统音量 ${volume}）。`,
    }
  }
  const [, state, volume, muted, track, artist, album, position, duration] = raw.split(SEP)
  const toNumber = (value) => {
    const number = Number(value)
    return Number.isFinite(number) ? number : 0
  }
  const isMuted = muted === 'true'
  const suffix = isMuted ? '，已静音' : ''
  const summary = state === 'stopped' || track === '-'
    ? `${stateLabel(state)}，当前没有曲目（系统音量 ${volume}${suffix}）`
    : `${stateLabel(state)}：${track} — ${artist}${album && album !== '-' ? `《${album}》` : ''}（${formatTime(position)} / ${formatTime(duration)}，系统音量 ${volume}${suffix}）`
  return {
    ok: true,
    running: true,
    state,
    volume: Number(volume),
    muted: isMuted,
    track,
    artist,
    album,
    position: toNumber(position),
    duration: toNumber(duration),
    summary,
  }
}

function formatTime(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0))
  const minutes = Math.floor(total / 60)
  const rest = String(total % 60).padStart(2, '0')
  return `${minutes}:${rest}`
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export const inject = ['tools']

function normalizeConfig(config) {
  const cfg = { ...DEFAULTS }
  if (typeof config?.helperPath === 'string' && config.helperPath.trim()) cfg.helperPath = config.helperPath.trim()
  if (typeof config?.exchangeDir === 'string' && config.exchangeDir.trim()) cfg.exchangeDir = config.exchangeDir.trim()
  cfg.socketPath = join(cfg.exchangeDir, 'helper.sock')
  const timeout = Number(config?.timeoutSec)
  if (Number.isFinite(timeout) && timeout > 0) cfg.timeoutSec = Math.min(Math.round(timeout), 120)
  return cfg
}

/**
 * Register the library-only music tools on the plugin context.
 * @param {object} ctx - plugin Context.
 * @param {object} [config] - the bundle patch row's config.
 */
export function apply(ctx, config) {
  const cfg = normalizeConfig(config)
  const options = (exec) => ({
    helperPath: cfg.helperPath,
    exchangeDir: cfg.exchangeDir,
    socketPath: cfg.socketPath,
    timeoutSec: cfg.timeoutSec,
    signal: exec?.signal,
  })

  // Warm the daemon during activation so the first tool call is not cold.
  ensureDaemon(options(undefined)).catch(() => {})

  const definitions = [
    {
      name: 'music_play',
      description:
        '在本机「音乐」App 的资料库里播放音乐：按歌名、歌手、专辑匹配，或播放用户播放列表（kind=playlist）。只播放已加入资料库的曲目；不在资料库的歌会直接返回未找到，不做任何网络搜索。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', description: '歌名、歌手、专辑或播放列表名称，支持部分匹配。' },
          artist: { type: 'string', description: '歌手名，用于缩小匹配范围。' },
          kind: {
            type: 'string',
            enum: ['song', 'playlist'],
            description: 'song（默认）按歌曲播放；playlist 只匹配用户播放列表名称。',
          },
        },
        required: ['query'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            state: { type: 'string' },
            track: { type: 'string' },
            artist: { type: 'string' },
            album: { type: 'string' },
            reason: { type: 'string' },
            summary: { type: 'string' },
          },
          required: ['ok', 'summary'],
        },
        render: (_args, value) => [{ type: 'text', text: value?.summary ?? '' }],
      },
      async execute(args, exec) {
        const kind = args?.kind === 'playlist' ? 'playlist' : 'song'
        const query = String(args?.query ?? '').trim()
        const artist = String(args?.artist ?? '').trim()

        if (kind === 'playlist') {
          const raw = await runScript(playPlaylistScript(query), options(exec))
          const parsed = parsePlayResult(raw, 'playlist')
          if (!parsed.ok) parsed.summary = `播放列表里没有找到「${query}」。`
          return parsed
        }

        const raw = await runScript(playTrackScript(query, artist), options(exec))
        const parsed = parsePlayResult(raw, 'song')
        if (!parsed.ok) {
          parsed.summary = `资料库里没有找到「${query}」${artist ? `（${artist}）` : ''}。先把歌加入资料库，或在「音乐」里手动播放一次。`
        }
        return parsed
      },
    },
    {
      name: 'music_search',
      description:
        '只搜索、不播放：在本机「音乐」App 的资料库里按关键词（歌名/歌手/专辑）列出候选曲目，用于确认歌曲是否在资料库、或让用户选择。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', description: '歌名、歌手或专辑关键词。' },
          artist: { type: 'string', description: '只保留该歌手的曲目。' },
          limit: { type: 'number', description: '最多返回多少条，默认 10，上限 50。' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            count: { type: 'number' },
            items: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  title: { type: 'string' },
                  artist: { type: 'string' },
                  album: { type: 'string' },
                },
              },
            },
            summary: { type: 'string' },
          },
          required: ['ok', 'summary'],
        },
        render: (_args, value) => [{ type: 'text', text: value?.summary ?? '' }],
      },
      async execute(args, exec) {
        const query = String(args?.query ?? '').trim()
        const artist = String(args?.artist ?? '').trim()
        const limit = Number(args?.limit) > 0 ? Math.min(Math.round(Number(args.limit)), 50) : 10
        if (!query && !artist) throw new Error('至少提供 query 或 artist。')
        const raw = await runScript(searchLibraryScript(query, artist, limit), options(exec))
        const items = raw.split('\n').filter(Boolean).map((line) => {
          const [title, singer, album] = line.split(SEP)
          return { title, artist: singer, album }
        })
        return {
          ok: true,
          count: items.length,
          items,
          summary: items.length
            ? `资料库里有 ${items.length} 首匹配：${items.slice(0, 5).map((item) => `${item.title}（${item.artist}）`).join('、')}${items.length > 5 ? '…' : ''}`
            : '资料库里没有匹配的曲目。',
        }
      },
    },
    {
      name: 'music_control',
      description:
        '控制本机「音乐」App 的播放：play 继续、pause 暂停、toggle 切换播放/暂停、next 下一首、previous 上一首、stop 停止、volume 调整**系统输出音量**（0-100，不是「音乐」App 内部音量，调大时会自动取消静音）。返回操作后的播放状态。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: {
            type: 'string',
            enum: ['play', 'pause', 'toggle', 'next', 'previous', 'stop', 'volume'],
            description: '要执行的操作。',
          },
          volume: {
            type: 'number',
            description: '当 action=volume 时生效，取值 0-100，调整的是系统输出音量。',
          },
        },
        required: ['action'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            state: { type: 'string' },
            volume: { type: 'number' },
            muted: { type: 'boolean' },
            summary: { type: 'string' },
          },
          required: ['ok', 'summary'],
        },
        render: (_args, value) => [{ type: 'text', text: value?.summary ?? '' }],
      },
      async execute(args, exec) {
        const action = String(args?.action ?? '')
        if (!Object.prototype.hasOwnProperty.call(CONTROL_STATEMENTS, action)) {
          throw new Error(`不支持的操作：${action || '(空)'}`)
        }
        if (action === 'volume') {
          const volume = Number(args?.volume)
          if (!Number.isFinite(volume) || volume < 0 || volume > 100) {
            throw new Error('action=volume 需要 0-100 之间的 volume。')
          }
        }
        const raw = await runScript(controlScript(action, Number(args?.volume)), options(exec))
        return parseControlResult(raw, action)
      },
    },
    {
      name: 'music_status',
      description:
        '读取本机「音乐」App 的当前状态：是否在运行、播放/暂停、当前曲目、歌手、专辑、播放进度，以及系统输出音量与静音状态。适合播放前确认，或在用户问「在放什么」时回答。',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            running: { type: 'boolean' },
            state: { type: 'string' },
            volume: { type: 'number' },
            muted: { type: 'boolean' },
            track: { type: 'string' },
            artist: { type: 'string' },
            album: { type: 'string' },
            position: { type: 'number' },
            duration: { type: 'number' },
            summary: { type: 'string' },
          },
          required: ['ok', 'summary'],
        },
        render: (_args, value) => [{ type: 'text', text: value?.summary ?? '' }],
      },
      async execute(_args, exec) {
        const raw = await runScript(STATUS_SCRIPT, options(exec))
        return parseStatus(raw)
      },
    },
  ]

  const disposeAll = definitions.map((definition) => {
    const dispose = ctx.tools.register(definition)
    return typeof dispose === 'function' ? dispose : undefined
  })

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      for (const dispose of disposeAll) dispose?.()
      shutdownDaemon({ socketPath: cfg.socketPath })
    })
  }
}
