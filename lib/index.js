/**
 * dsh-gh-downloader — Host half.
 *
 * A download-manager service used primarily by the agent (via the
 * `github_download` tool) and secondarily by a manual web panel.
 *
 *  - Downloads GitHub-family resources through a gh-proxy style accelerator.
 *  - Real byte/speed progress, concurrency queue, pause/resume (HTTP Range),
 *    retry, cancel, remove, open-folder.
 *  - Task ledger persisted under DSH_HOME so history survives restarts.
 *
 * Pure ESM, no external imports beyond Node builtins (the profile has no
 * @deepseek-ai/* packages resolvable from disk).
 */

import { createWriteStream, promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'

export const name = 'dsh-gh-downloader'
export const inject = ['tools', 'connection']

const NS = 'dsh-gh-downloader'
const DEFAULT_PROXY = 'https://gh-proxy.com/'
const DEFAULT_DOWNLOAD_DIR = 'dsh-gh-downloader-downloads'
const MAX_CONCURRENT = 3

/**
 * Named download channels. Each is a proxy prefix applied to the normalized
 * GitHub URL. `direct` is the raw GitHub URL with no proxy.
 */
const CHANNELS = [
  { id: 'gh-proxy', label: 'GH-Proxy (主站)', prefix: 'https://gh-proxy.com/' },
  { id: 'gh-proxy-org', label: 'GH-Proxy (备用)', prefix: 'https://gh-proxy.org/' },
  { id: 'ghfast', label: 'GhFast', prefix: 'https://ghfast.top/' },
  { id: 'direct', label: '直连 GitHub', prefix: '' },
]
const channelById = id => CHANNELS.find(c => c.id === id)

/** Build a concrete URL for a channel. */
function channelUrl(raw, channelId, proxyBase) {
  const normalized = normalizeGithubUrl(raw)
  if (channelId === 'direct' || channelId === '' || channelId == null) return normalized
  const ch = channelById(channelId)
  if (!ch) {
    return (proxyBase || DEFAULT_PROXY).replace(/\/+$/, '') + '/' + normalized
  }
  return ch.prefix.replace(/\/+$/, '') + '/' + normalized
}

/** Produce multiple candidate links for one GitHub URL. */
function convertCandidates(raw, proxyBase) {
  return CHANNELS.map(ch => ({
    id: ch.id,
    label: ch.label,
    url: channelUrl(raw, ch.id, proxyBase),
    proxied: ch.id !== 'direct',
  }))
}

/** GitHub resource hosts that may be proxied. */
const GH_HOSTS = [
  'github.com',
  'raw.githubusercontent.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
  'api.github.com',
  'gist.githubusercontent.com',
  'githubusercontent.com',
]

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}
const ok = (value) => json({ ok: true, value })
const fail = (code, message, status = 200) =>
  json({ ok: false, error: { code, message } }, status)

function isGitHubUrl(raw) {
  try {
    const u = new URL(raw)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false
    const h = u.hostname.toLowerCase()
    return GH_HOSTS.some((host) => h === host || h.endsWith('.' + host))
  } catch {
    return false
  }
}

/** Rewrite /blob/ view links into raw download links. */
function normalizeGithubUrl(raw) {
  try {
    const u = new URL(raw)
    if (u.hostname === 'github.com' && u.pathname.includes('/blob/')) {
      u.hostname = 'raw.githubusercontent.com'
      u.pathname = u.pathname.replace('/blob/', '/')
    }
    return u.toString()
  } catch {
    return raw
  }
}

function proxiedUrl(raw, proxyBase) {
  const base = (proxyBase || DEFAULT_PROXY).replace(/\/+$/, '') + '/'
  return base + normalizeGithubUrl(raw)
}

function fileNameFromUrl(raw) {
  try {
    const u = new URL(raw)
    const parts = u.pathname.split('/').filter(Boolean)
    let last = parts[parts.length - 1] || 'download'
    try {
      last = decodeURIComponent(last)
    } catch {
      /* keep raw */
    }
    return /^[\w.\-\u4e00-\u9fa5]+$/.test(last) ? last : 'download'
  } catch {
    return 'download'
  }
}

function safeJoin(baseDir, relative) {
  const target = path.resolve(baseDir, relative || '')
  const root = path.resolve(baseDir)
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error('target path escapes the workspace directory')
  }
  return target
}

const TERMINAL = new Set(['done', 'error', 'canceled'])
const ACTIVE = new Set(['queued', 'downloading', 'paused'])

/** Compose the plugin. */
export function apply(ctx, config = {}) {
  const proxyBase =
    typeof config.proxy === 'string' && config.proxy ? config.proxy : DEFAULT_PROXY
  const timeoutMs = Number.isFinite(config.timeoutMs) ? config.timeoutMs : 0
  const concurrency =
    Number.isInteger(config.concurrency) && config.concurrency > 0
      ? Math.min(config.concurrency, 16)
      : MAX_CONCURRENT

  const home = process.env.DSH_HOME || path.join(homedir(), '.dsh')
  const stateDir = path.join(home, NS)
  const stateFile = path.join(stateDir, 'tasks.json')
  const settingsFile = path.join(stateDir, 'settings.json')

  // Mutable default download directory. Persisted so "更换" survives restarts.
  let downloadDir =
    typeof config.downloadDir === 'string' && config.downloadDir ? config.downloadDir : DEFAULT_DOWNLOAD_DIR

  /** @type {Map<string, any>} */
  const tasks = new Map()
  /** @type {string[]} */
  const queue = []
  let active = 0
  let seq = 0
  let saveTimer = null

  function workspaceRoot() {
    try {
      const ws = ctx.get('workspace')
      if (ws && typeof ws.currentPath === 'function') return ws.currentPath()
      if (ws && typeof ws.cwd === 'function') return ws.cwd()
      if (ws && typeof ws.get === 'function') {
        const cur = ws.get('current')
        if (cur && typeof cur.cwd === 'string') return cur.cwd
      }
    } catch {
      /* fall through */
    }
    return process.cwd()
  }

  // --- persistence ---------------------------------------------------
  function serialize(t) {
    return {
      id: t.id,
      url: t.url,
      proxyUrl: t.proxyUrl,
      fileName: t.fileName,
      filePath: t.filePath,
      relativeDir: t.relativeDir,
      channel: t.channel || null,
      state: t.state,
      bytes: t.bytes,
      total: t.total,
      speed: t.speed,
      error: t.error,
      source: t.source,
      sessionId: t.sessionId,
      createdAt: t.createdAt,
      startedAt: t.startedAt,
      finishedAt: t.finishedAt,
    }
  }

  function saveNow() {
    try {
      clearTimeout(saveTimer)
      saveTimer = null
    } catch {
      /* ignore */
    }
    const data = [...tasks.values()].map(serialize)
    return fs.mkdir(stateDir, { recursive: true }).then(() =>
      fs.writeFile(stateFile, JSON.stringify(data, null, 2), 'utf8')
    ).catch(() => {})
  }

  function saveSoon() {
    if (saveTimer) return
    saveTimer = setTimeout(() => {
      saveTimer = null
      saveNow()
    }, 500)
    saveTimer.unref?.()
  }

  async function load() {
    try {
      const raw = await fs.readFile(stateFile, 'utf8')
      const arr = JSON.parse(raw)
      if (!Array.isArray(arr)) return
      for (const rec of arr) {
        if (!rec || typeof rec.id !== 'string') continue
        const t = {
          ...rec,
          speed: 0,
          error: rec.error ?? null,
          // interrupted tasks become resumable paused tasks
          state: ACTIVE.has(rec.state) ? 'paused' : rec.state,
        }
        tasks.set(t.id, t)
      }
      saveSoon()
    } catch {
      /* no ledger yet */
    }
  }

  async function loadSettings() {
    try {
      const raw = await fs.readFile(settingsFile, 'utf8')
      const obj = JSON.parse(raw)
      if (obj && typeof obj.downloadDir === 'string' && obj.downloadDir) {
        downloadDir = obj.downloadDir
      }
    } catch {
      /* no settings yet */
    }
  }

  function saveSettings() {
    return fs.mkdir(stateDir, { recursive: true })
      .then(() => fs.writeFile(settingsFile, JSON.stringify({ downloadDir }, null, 2), 'utf8'))
      .catch(() => {})
  }

  function publicTask(t) {
    return {
      id: t.id,
      url: t.url,
      proxyUrl: t.proxyUrl,
      fileName: t.fileName,
      filePath: t.filePath,
      relativeDir: t.relativeDir,
      channel: t.channel || null,
      state: t.state,
      bytes: t.bytes || 0,
      total: t.total ?? null,
      speed: t.speed || 0,
      error: t.error ?? null,
      source: t.source || 'manual',
      sessionId: t.sessionId ?? null,
      createdAt: t.createdAt,
      startedAt: t.startedAt ?? null,
      finishedAt: t.finishedAt ?? null,
      progress: t.state === 'done'
        ? 100
        : t.total ? Math.min(100, Math.round(((t.bytes || 0) / t.total) * 100)) : 0,
    }
  }

  // --- download engine ------------------------------------------------
  function pump() {
    while (active < concurrency && queue.length > 0) {
      const id = queue.shift()
      const t = tasks.get(id)
      if (!t || t.state !== 'queued') continue
      active++
      runTask(t).finally(() => {
        active--
        pump()
      })
    }
  }

  function enqueue(t) {
    tasks.set(t.id, t)
    if (t.state === 'queued') queue.push(t.id)
    saveSoon()
    pump()
  }

  async function runTask(task) {
    const controller = new AbortController()
    task._controller = controller
    task.state = 'downloading'
    task.startedAt = task.startedAt || new Date().toISOString()
    task.error = null
    task.speed = 0
    saveSoon()

    let timer = null
    if (timeoutMs > 0) {
      timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
      timer.unref?.()
    }

    const resumeFrom = task.bytes > 0 ? task.bytes : 0
    try {
      const headers = { 'user-agent': 'Mozilla/5.0 dsh-gh-downloader' }
      if (resumeFrom > 0) headers.range = `bytes=${resumeFrom}-`
      const res = await fetch(task.proxyUrl, { redirect: 'follow', signal: controller.signal, headers })
      if (!res.ok && res.status !== 206) throw new Error(`upstream responded ${res.status}`)

      const append = resumeFrom > 0 && res.status === 206
      if (!append) {
        task.bytes = 0
      }
      const lenHeader = res.headers.get('content-length')
      if (lenHeader) {
        task.total = append ? resumeFrom + Number(lenHeader) : Number(lenHeader)
      }
      if (!res.body) throw new Error('upstream returned no body')

      const writer = createWriteStream(task.filePath, { flags: append ? 'a' : 'w' })
      const reader = res.body.getReader()
      let last = Date.now()
      let lastBytes = task.bytes

      while (true) {
        if (controller.signal.aborted) throw new Error('aborted')
        const { done, value } = await reader.read()
        if (done) break
        if (!value || value.byteLength === 0) continue
        await new Promise((resolve, reject) => {
          writer.write(Buffer.from(value), (err) => (err ? reject(err) : resolve()))
        })
        task.bytes += value.byteLength
        const now = Date.now()
        const dt = (now - last) / 1000
        if (dt >= 0.6) {
          task.speed = Math.max(0, Math.round((task.bytes - lastBytes) / dt))
          last = now
          lastBytes = task.bytes
        }
      }
      await new Promise((resolve, reject) => writer.end((err) => (err ? reject(err) : resolve())))

      if (task._pauseRequested) {
        task._pauseRequested = false
        task.state = 'paused'
      } else {
        task.state = 'done'
        task.speed = 0
        task.finishedAt = new Date().toISOString()
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (task._pauseRequested) {
        task._pauseRequested = false
        task.state = 'paused'
      } else if (/abort/i.test(msg)) {
        task.state = 'canceled'
        task.finishedAt = new Date().toISOString()
        try { await fs.rm(task.filePath, { force: true }) } catch { /* ignore */ }
      } else {
        task.state = 'error'
        task.error = msg
        task.finishedAt = new Date().toISOString()
      }
    } finally {
      if (timer) clearTimeout(timer)
      task._controller = null
      task.speed = 0
      saveSoon()
    }
  }

  function startDownload({ url, relativeDir, fileName, source, sessionId, channel, proxyUrl }) {
    const id = `dl-${Date.now().toString(36)}-${(seq++).toString(36)}`
    const targetUrl = proxyUrl || channelUrl(url, channel, proxyBase)
    const name = fileName || fileNameFromUrl(url)
    const root = workspaceRoot()
    const destDir = safeJoin(root, path.join(downloadDir, relativeDir || ''))
    // create directory synchronously-ish before enqueue; failure propagates to caller
    const task = {
      id,
      url,
      proxyUrl: targetUrl,
      fileName: name,
      filePath: path.join(destDir, name),
      relativeDir: relativeDir || '',
      channel: channel || null,
      state: 'queued',
      bytes: 0,
      total: null,
      speed: 0,
      error: null,
      source: source || 'manual',
      sessionId: sessionId ?? null,
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      _controller: null,
      _pauseRequested: false,
    }
    // ensure directory exists before the worker opens the write stream
    fs.mkdir(destDir, { recursive: true }).catch(() => {})
    enqueue(task)
    return publicTask(task)
  }

  // --- operations -----------------------------------------------------
  function opPause(id) {
    const t = tasks.get(id)
    if (!t || !ACTIVE.has(t.state)) return false
    if (t.state === 'queued') {
      t.state = 'paused'
    } else {
      t._pauseRequested = true
      try { t._controller?.abort(new Error('pause')) } catch { /* ignore */ }
    }
    saveSoon()
    return true
  }

  function opResume(id) {
    const t = tasks.get(id)
    if (!t || t.state !== 'paused') return false
    t.state = 'queued'
    t.error = null
    enqueue(t)
    return true
  }

  function opCancel(id) {
    const t = tasks.get(id)
    if (!t || !ACTIVE.has(t.state)) return false
    if (t.state === 'queued') {
      t.state = 'canceled'
      t.finishedAt = new Date().toISOString()
    } else {
      try { t._controller?.abort(new Error('cancel')) } catch { /* ignore */ }
      // state settles in runTask catch (canceled) unless pause flag wins
    }
    const idx = queue.indexOf(id)
    if (idx >= 0) queue.splice(idx, 1)
    saveSoon()
    return true
  }

  function opRetry(id) {
    const t = tasks.get(id)
    if (!t || !TERMINAL.has(t.state)) return false
    t.bytes = 0
    t.total = null
    t.error = null
    t.startedAt = null
    t.finishedAt = null
    t.state = 'queued'
    enqueue(t)
    return true
  }

  function opRemove(id) {
    const t = tasks.get(id)
    if (!t) return false
    if (ACTIVE.has(t.state)) opCancel(id)
    tasks.delete(id)
    const idx = queue.indexOf(id)
    if (idx >= 0) queue.splice(idx, 1)
    saveSoon()
    // do not delete the file here: user may want partial data; retry reuses it only via resume
    return true
  }

  function opClearCompleted() {
    let n = 0
    for (const [id, t] of [...tasks]) {
      if (t.state === 'done') {
        tasks.delete(id)
        n++
      }
    }
    saveSoon()
    return n
  }

  function openFolder(filePath) {
    try {
      if (process.platform === 'win32') {
        execFile('explorer', ['/select,', filePath], () => {})
      } else if (process.platform === 'darwin') {
        execFile('open', ['-R', filePath], () => {})
      } else {
        execFile('xdg-open', [path.dirname(filePath)], () => {})
      }
      return true
    } catch {
      return false
    }
  }

  // --- model-facing tools --------------------------------------------
  ctx.effect(() => {
    if (!ctx.tools || typeof ctx.tools.register !== 'function') return
    const tool = {
      name: 'github_download',
      description:
        'Download a GitHub resource (source code, release asset, raw file, archive, gist) through the gh-proxy accelerator into the local workspace. USE THIS instead of curl/wget when downloading any GitHub URL — it is faster and tracks progress. Returns a task handle; use github_download_status to poll.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'Full GitHub URL, e.g. https://github.com/owner/repo/archive/refs/heads/main.zip',
          },
          fileName: { type: 'string', description: 'Optional output file name; defaults to URL basename.' },
          relativeDir: { type: 'string', description: 'Optional subdirectory under the download folder.' },
          wait: { type: 'boolean', description: 'Wait until the download finishes (default false).' },
        },
        required: ['url'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            state: { type: 'string' },
            filePath: { type: 'string' },
            fileName: { type: 'string' },
            url: { type: 'string' },
            error: { type: 'string' },
          },
          required: ['id', 'state', 'filePath', 'fileName', 'url'],
        },
        render: (_args, value) => [
          { type: 'text', text: `GitHub 下载任务 ${value.id}：${value.state} → ${value.filePath}` },
        ],
      },
      async execute(args, exec) {
        if (typeof args.url !== 'string' || !isGitHubUrl(args.url)) {
          throw new Error('Only GitHub-family URLs are accepted by github_download.')
        }
        let sessionId = null
        try {
          sessionId = exec?.agent?.session?.id ?? exec?.session?.id ?? null
        } catch {
          sessionId = null
        }
        const task = startDownload({
          url: args.url,
          relativeDir: typeof args.relativeDir === 'string' ? args.relativeDir : '',
          fileName: typeof args.fileName === 'string' ? args.fileName : '',
          source: 'agent',
          sessionId,
        })
        if (args.wait === true) {
          const deadline = Date.now() + 10 * 60 * 1000
          let t = tasks.get(task.id)
          while (t && !TERMINAL.has(t.state) && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 250))
            t = tasks.get(task.id)
          }
          const final = publicTask(t || task)
          return {
            id: final.id, state: final.state, filePath: final.filePath,
            fileName: final.fileName, url: final.url,
            ...(final.error ? { error: final.error } : {}),
          }
        }
        return {
          id: task.id, state: task.state, filePath: task.filePath,
          fileName: task.fileName, url: task.url,
        }
      },
    }
    const dispose = ctx.tools.register(tool)
    return typeof dispose === 'function' ? dispose : undefined
  }, `${NS}:tool`)

  ctx.effect(() => {
    if (!ctx.tools || typeof ctx.tools.register !== 'function') return
    const tool = {
      name: 'github_download_status',
      description:
        'Query progress/state of a github_download task by id, or list all download tasks when id is omitted.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Task id.' } },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args) {
        if (typeof args.id === 'string' && args.id) {
          const t = tasks.get(args.id)
          if (!t) return `Task ${args.id} not found.`
          return JSON.stringify(publicTask(t), null, 2)
        }
        return JSON.stringify([...tasks.values()].map(publicTask), null, 2)
      },
    }
    const dispose = ctx.tools.register(tool)
    return typeof dispose === 'function' ? dispose : undefined
  }, `${NS}:status-tool`)

  // --- HTTP routes for the web panel ---------------------------------
  const route = (p) => `/api/${NS}/${p}`

  function registerRoute(routePath, handler) {
    const conn = ctx.get('connection')
    const reg = conn?.fetch?.register
    if (typeof reg !== 'function') return
    ctx.effect(
      () => reg.call(conn.fetch, {
        path: routePath,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: handler,
      }),
      `${NS}:route:${routePath}`,
    )
  }

  async function bodyOf(request) {
    try {
      return await request.json()
    } catch {
      return null
    }
  }

  registerRoute(route('list'), async () =>
    ok([...tasks.values()].map(publicTask)))

  registerRoute(route('create'), async (request) => {
    const body = await bodyOf(request)
    if (!body || typeof body.url !== 'string' || !isGitHubUrl(body.url)) {
      return fail('invalid-url', 'Only GitHub-family URLs are accepted.')
    }
    try {
      const task = startDownload({
        url: body.url,
        relativeDir: typeof body.relativeDir === 'string' ? body.relativeDir : '',
        fileName: typeof body.fileName === 'string' ? body.fileName : '',
        channel: typeof body.channel === 'string' ? body.channel : null,
        proxyUrl: typeof body.proxyUrl === 'string' && body.proxyUrl ? body.proxyUrl : undefined,
        source: 'manual',
      })
      return ok(task)
    } catch (err) {
      return fail('start-failed', err instanceof Error ? err.message : String(err))
    }
  })

  registerRoute(route('op'), async (request) => {
    const body = await bodyOf(request)
    if (!body || typeof body.action !== 'string') return fail('bad-request', 'action required')
    const id = body.id
    let result = false
    switch (body.action) {
      case 'pause': result = opPause(id); break
      case 'resume': result = opResume(id); break
      case 'cancel': result = opCancel(id); break
      case 'retry': result = opRetry(id); break
      case 'remove': result = opRemove(id); break
      case 'open': {
        const t = tasks.get(id)
        if (t) result = openFolder(t.filePath)
        break
      }
      case 'openDir': {
        try {
          const dir = safeJoin(workspaceRoot(), downloadDir)
          await fs.mkdir(dir, { recursive: true }).catch(() => {})
          result = openFolder(dir)
        } catch { result = false }
        break
      }
      case 'clearCompleted': result = opClearCompleted(); break
      default: return fail('unknown-action', 'Unknown action.')
    }
    return ok({ action: body.action, result })
  })

  registerRoute(route('config'), async () =>
    ok({ proxy: proxyBase, downloadDir, timeoutMs, concurrency, stateFile,
      workspaceRoot: workspaceRoot(),
      channels: CHANNELS.map(c => ({ id: c.id, label: c.label })) }))

  /** Change the default download directory (relative to workspace root). */
  registerRoute(route('setDir'), async (request) => {
    const body = await bodyOf(request)
    if (!body || typeof body.dir !== 'string') return fail('bad-request', 'dir required')
    const next = body.dir.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    if (!next || next.split('/').includes('..')) return fail('invalid-dir', 'Invalid directory.')
    try {
      safeJoin(workspaceRoot(), next)
    } catch {
      return fail('escape', 'Path escapes the workspace directory.')
    }
    downloadDir = next
    saveSettings()
    return ok({ downloadDir })
  })

  /** Convert one GitHub URL into multiple candidate channel links. */
  registerRoute(route('convert'), async (request) => {
    const body = await bodyOf(request)
    if (!body || typeof body.url !== 'string' || !isGitHubUrl(body.url)) {
      return fail('invalid-url', 'Only GitHub-family URLs are accepted.')
    }
    return ok({
      original: body.url,
      normalized: normalizeGithubUrl(body.url),
      name: fileNameFromUrl(body.url),
      candidates: convertCandidates(body.url, proxyBase),
    })
  })

  /**
   * Browse directories for the folder picker.
   * base='download' (default): inside downloadDir, rel is a sub-path of it.
   * base='workspace': whole workspace, rel is a path from workspace root
   *   (used by the "更换默认位置" browser).
   */
  registerRoute(route('browse'), async (request) => {
    const body = await bodyOf(request)
    const base = body && body.base === 'workspace' ? 'workspace' : 'download'
    const rel = body && typeof body.relativeDir === 'string' ? body.relativeDir : ''
    const root = workspaceRoot()
    const prefix = base === 'download' ? downloadDir : ''
    let target
    try {
      target = safeJoin(root, path.join(prefix, rel))
    } catch {
      return fail('escape', 'Path escapes the allowed directory.')
    }
    try {
      await fs.mkdir(target, { recursive: true })
      const entries = await fs.readdir(target, { withFileTypes: true })
      const dirs = entries
        .filter(e => e.isDirectory() && !e.name.startsWith('.'))
        .map(e => ({
          name: e.name,
          path: path.join(prefix, rel, e.name).replace(/\\/g, '/'),
        }))
        .sort((a, b) => a.name.localeCompare(b.name))
      const current = path.join(prefix, rel).replace(/\\/g, '/') || '.'
      const parentRel = rel ? path.dirname(rel) : (base === 'download' ? null : '')
      const parent = parentRel === null ? null
        : base === 'download' ? (rel ? path.join(downloadDir, parentRel).replace(/\\/g, '/') : null)
        : (parentRel === '.' ? '' : parentRel.replace(/\\/g, '/'))
      return ok({ current, parent, dirs, base })
    } catch (err) {
      return fail('browse-failed', err instanceof Error ? err.message : String(err))
    }
  })

  // restore history and settings (non-blocking)
  load().catch(() => {})
  loadSettings().catch(() => {})
}
