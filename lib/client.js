/*
 * dsh-gh-downloader — Client half (browser).
 * Netdisk-style download manager. Hybrid skin:
 *   - layout / background / cards: Doraemon palette (blue, white, yellow)
 *   - buttons / tabs / slots / dropdowns: Minecraft chest GUI (pixel bevels)
 * Interactions:
 *   - Fixed header (paste form + tabs), scrolling task list only.
 *   - Default download location chip with [打开][更换] buttons.
 *   - File-name field (compact). Subfolder field = input (create) + dropdown
 *     button (pick existing subfolder, MC-style expanding panel).
 *   - "转换链接" opens a popover listing channel candidates; each candidate
 *     has [copy link] and [download] icon buttons on its right.
 * Authored with React.createElement so no JSX/build step is required.
 */
window.__ModuleLoader__.load({
  id: 'dsh-gh-downloader',
  factory: require => {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef } = React
    const NS = 'ghDownloader'
    const PANEL_ID = 'dsh-gh-downloader'
    const ROOT = 'api/dsh-gh-downloader/'

    const zh = {
      panel: 'GitHub 下载', title: '下载管理器',
      desc: 'GitHub 资源高速下载 · Agent 自动调用 · 支持手动粘贴',
      hideForm: '收起', addTask: '新建下载',
      urlPlaceholder: '粘贴 GitHub 链接（Release / Raw / 源码包 / Gist）',
      fileName: '文件名', dirName: '子目录',
      start: '开始下载', starting: '提交中…',
      convert: '转换链接', converting: '解析中…',
      clearDone: '清空已完成', refresh: '刷新',
      defaultDir: '默认下载位置', openDir: '打开', changeDir: '更换', clearUrl: '清空链接',
      tabAll: '全部', tabActive: '下载中', tabDone: '已完成', tabError: '失败',
      emptyAll: '暂无任务。Agent 下载 GitHub 源码时会自动出现在这里，也可以直接粘贴链接手动下载。',
      emptyActive: '没有正在下载的任务', emptyDone: '还没有已完成的任务', emptyError: '没有失败的任务',
      stateDownloading: '下载中', stateQueued: '排队中', statePaused: '已暂停',
      stateDone: '已完成', stateError: '失败', stateCanceled: '已取消',
      sourceAgent: 'AI', sourceManual: '手动',
      pause: '暂停', resume: '继续', cancel: '取消', retry: '重试', remove: '删除', open: '打开文件夹',
      speed: '速度',
      pickerTitle: '选择位置', pickerChildTitle: '选择子文件夹', pickerRoot: '下载根目录', pickerUp: '上级',
      pickerHere: '选这里', pickerNew: '新建', pickerNewHint: '新子目录名',
      pickerEmpty: '（空，输入名字可新建）', pickerCancel: '关闭',
      convTitle: '转换链接 · 选择通道', convHint: '同一资源的多条通道，复制或直接从该通道下载',
      convCopy: '复制', convCopied: '已复制', convDownload: '下载',
      convDirect: '直连', convProxy: '代理',
      listFail: '任务列表读取失败', createFail: '创建任务失败', opFail: '操作失败',
      convertFail: '转换失败', browseFail: '读取目录失败',
      githubOnly: '只接受 GitHub 链接',
      confirmClear: '确定清空所有已完成任务？', confirmRemove: '确定删除该任务记录？',
    }
    const en = {
      panel: 'GitHub Download', title: 'Download Manager',
      desc: 'Fast GitHub downloads · Called by the agent · Manual paste supported',
      hideForm: 'Hide', addTask: 'New download',
      urlPlaceholder: 'Paste a GitHub URL (Release / Raw / Archive / Gist)',
      fileName: 'File name', dirName: 'Subfolder',
      start: 'Start download', starting: 'Submitting…',
      convert: 'Convert link', converting: 'Parsing…',
      clearDone: 'Clear completed', refresh: 'Refresh',
      defaultDir: 'Default download location', openDir: 'Open', changeDir: 'Change', clearUrl: 'Clear link',
      tabAll: 'All', tabActive: 'Downloading', tabDone: 'Completed', tabError: 'Failed',
      emptyAll: 'No tasks yet. Agent downloads appear here automatically, or paste a link above.',
      emptyActive: 'Nothing is downloading', emptyDone: 'No completed tasks', emptyError: 'No failed tasks',
      stateDownloading: 'Downloading', stateQueued: 'Queued', statePaused: 'Paused',
      stateDone: 'Completed', stateError: 'Failed', stateCanceled: 'Canceled',
      sourceAgent: 'AI', sourceManual: 'Manual',
      pause: 'Pause', resume: 'Resume', cancel: 'Cancel', retry: 'Retry', remove: 'Remove', open: 'Open folder',
      speed: 'Speed',
      pickerTitle: 'Choose location', pickerChildTitle: 'Choose subfolder', pickerRoot: 'Download root', pickerUp: 'Up',
      pickerHere: 'Choose', pickerNew: 'New', pickerNewHint: 'New subfolder name',
      pickerEmpty: '(empty, type a name to create)', pickerCancel: 'Close',
      convTitle: 'Convert link · pick a channel', convHint: 'Multiple channels for the same resource. Copy or download from a channel.',
      convCopy: 'Copy', convCopied: 'Copied', convDownload: 'Download',
      convDirect: 'Direct', convProxy: 'Proxy',
      listFail: 'Failed to load tasks', createFail: 'Failed to create task', opFail: 'Operation failed',
      convertFail: 'Convert failed', browseFail: 'Failed to read folder',
      githubOnly: 'Only GitHub URLs are accepted',
      confirmClear: 'Clear all completed tasks?', confirmRemove: 'Remove this task record?',
    }

    function call(path, body) {
      return fetch(ROOT + path, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      }).then(r => r.json())
    }
    function fmtBytes(n) {
      if (typeof n !== 'number' || n <= 0) return '0 B'
      if (n < 1024) return n + ' B'
      if (n < 1048576) return (n / 1024).toFixed(1) + ' KB'
      if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB'
      return (n / 1073741824).toFixed(2) + ' GB'
    }
    const fmtSpeed = n => (n > 0 ? fmtBytes(n) + '/s' : '--')
    function fmtTime(iso) {
      if (!iso) return ''
      try { return new Date(iso).toLocaleString() } catch { return '' }
    }
    function stateKey(state) {
      switch (state) {
        case 'done': return 'stateDone'
        case 'error': return 'stateError'
        case 'paused': return 'statePaused'
        case 'queued': return 'stateQueued'
        case 'canceled': return 'stateCanceled'
        default: return 'stateDownloading'
      }
    }
    const EM = {
      done: '✅', error: '❌', canceled: '🚫', paused: '⏸️', queued: '⏳', downloading: '📥',
      pause: '⏸', resume: '▶', cancel: '✖', retry: '↻', remove: '🗑', open: '📂',
      ai: '🤖', manual: '✋', copy: '📋', copied: '✔', down: '⬇', folder: '📁', up: '⬆',
    }
    function stateColor(s) {
      if (s === 'done') return '#28a745'
      if (s === 'error') return '#e8382f'
      if (s === 'paused' || s === 'canceled') return '#9fb3c0'
      return '#0099d8'
    }

    // ---- hybrid skin: Doraemon surface + Minecraft controls ---------
    const bevel = (bg, fg) => ({
      background: bg, color: fg || '#fff',
      border: '2px solid #3a3a3a',
      boxShadow: 'inset 2px 2px 0 rgba(255,255,255,.45), inset -2px -2px 0 rgba(0,0,0,.35), 0 3px 0 #1f1f1f',
      fontFamily: "'Courier New', monospace", fontWeight: 700, cursor: 'pointer', borderRadius: 2,
    })
    const groove = {
      background: '#eef8ff', border: '2px solid #7fd0f0',
      boxShadow: 'inset 2px 2px 0 rgba(0,80,120,.18), inset -2px -2px 0 rgba(255,255,255,.9)', borderRadius: 3,
    }
    const S = {
      wrap: {
        width: '100%', height: '100%', boxSizing: 'border-box', margin: 0,
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
        fontFamily: "'Segoe UI','Microsoft YaHei',system-ui,sans-serif", fontSize: 14, color: '#173b52',
      },
      frame: {
        flex: 1, minHeight: 0, boxSizing: 'border-box', display: 'flex', flexDirection: 'column',
        background: 'linear-gradient(160deg,#dff4ff 0%,#f4fbff 55%,#ffffff 100%)',
        borderTop: '3px solid #0099d8',
      },
      fixed: { flex: '0 0 auto', padding: '18px 30px 10px', borderBottom: '3px solid #cbe8f7', background: 'linear-gradient(180deg,#e9f7ff,#f6fcff)' },
      inner: { maxWidth: 1400, margin: '0 auto' },
      head: { display: 'flex', alignItems: 'center', gap: 10, borderBottom: '3px dashed #ffd500', paddingBottom: 10, marginBottom: 12 },
      title: { fontSize: 20, color: '#008fd0', margin: 0, fontWeight: 800 },
      desc: { fontSize: 12, color: '#5b7a8c', margin: '4px 0 0' },
      toolbar: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 },
      btnPrimary: Object.assign(bevel('#5b8c3a'), { padding: '9px 15px', display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }),
      btn: Object.assign(bevel('#7aa7c2'), { padding: '8px 11px', display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }),
      iconBtn: Object.assign(bevel('#8fb8d0'), { width: 30, height: 30, padding: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 14 }),
      tab: Object.assign(bevel('#b9d9ec', '#4a6b7d'), { padding: '8px 15px', fontSize: 12, borderBottomWidth: 2 }),
      tabOn: Object.assign(bevel('#5b8c3a'), { padding: '8px 15px', fontSize: 12, borderBottomWidth: 2 }),
      dirWrap: { position: 'relative', display: 'flex', gap: 6, alignItems: 'center', flex: 1, minWidth: 280 },
      dirChip: { flex: 1, minWidth: 140, display: 'flex', alignItems: 'center', gap: 6, padding: '7px 12px', background: '#fff', border: '2px solid #0099d8', borderRadius: 22, color: '#5b7a8c', fontSize: 12 },
      dirPath: { color: '#173b52', fontWeight: 700, wordBreak: 'break-all' },
      form: { background: '#fff', border: '3px solid #ffd500', borderRadius: 16, padding: 12, marginBottom: 4, boxShadow: '0 4px 0 #e5c400', display: 'grid', gap: 9 },
      input: Object.assign({}, groove, { padding: '10px 13px', color: '#173b52', fontSize: 13, boxSizing: 'border-box', outline: 'none' }),
      urlWrap: { display: 'flex', gap: 6, alignItems: 'center' },
      inputRow: { display: 'flex', gap: 8, flexWrap: 'nowrap', alignItems: 'center', width: '100%' },
      subWrap: { position: 'relative', display: 'flex', gap: 4, alignItems: 'center', flex: 1, minWidth: 0 },
      tabs: { display: 'flex', gap: 6, borderBottom: '3px solid #d6eef9', marginTop: 8, paddingBottom: 2, flexWrap: 'wrap' },
      scroll: { flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', padding: '12px 30px 40px' },
      list: { maxWidth: 1400, margin: '0 auto', display: 'grid', gap: 10 },
      row: { display: 'grid', gridTemplateColumns: '46px 1fr auto', gap: 12, alignItems: 'center', padding: '12px 14px', background: '#fff', border: '2px solid #bde6f8', borderRadius: 14, boxShadow: '0 3px 0 #d6eef9' },
      rowIcon: { width: 44, height: 44, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22, background: '#e8f7ff', border: '2px solid #0099d8' },
      rowMain: { minWidth: 0 },
      rowName: { color: '#173b52', fontSize: 14, fontWeight: 700, wordBreak: 'break-all' },
      srcChip: { display: 'inline-block', fontSize: 10, padding: '2px 8px', borderRadius: 10, background: '#e6eef3', color: '#5b7a8c', marginLeft: 6, verticalAlign: 'middle' },
      srcChipAi: { display: 'inline-block', fontSize: 10, padding: '2px 8px', borderRadius: 10, background: '#fff1c1', color: '#a87900', border: '1px solid #ffd500', marginLeft: 6, verticalAlign: 'middle' },
      chChip: { display: 'inline-block', fontSize: 10, padding: '2px 8px', borderRadius: 10, background: '#e8f7ff', color: '#008fd0', marginLeft: 6, verticalAlign: 'middle', fontFamily: "'Courier New',monospace" },
      rowUrl: { color: '#8aa3b2', fontSize: 11, marginTop: 3, wordBreak: 'break-all' },
      barWrap: Object.assign({}, groove, { height: 11, marginTop: 8, padding: 1, boxSizing: 'border-box' }),
      barFill: color => ({ height: '100%', background: 'linear-gradient(180deg,rgba(255,255,255,.35),rgba(0,0,0,.08)), ' + color, borderRight: '1px solid rgba(0,0,0,.25)', transition: 'width .3s steps(8)' }),
      meta: { display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 11, marginTop: 7, color: '#5b7a8c' },
      ops: { display: 'flex', gap: 5 },
      err: { color: '#d62b22', fontSize: 12, marginTop: 6 },
      empty: { textAlign: 'center', color: '#7d9aab', padding: '40px 18px', fontSize: 13, background: '#f4fbff', border: '3px dashed #bde6f8', borderRadius: 16 },
      notice: { color: '#d62b22', fontSize: 12, margin: '6px 0 0' },
      // MC bevel dropdown panel (expands under its trigger)
      dropdown: Object.assign(bevel('#cfd8de'), {
        position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 1000,
        width: 340, padding: 0, cursor: 'default',
        boxShadow: 'inset 2px 2px 0 #fff, inset -2px -2px 0 #6b6b6b, 0 8px 0 #1f1f1f',
      }),
      panelHead: { display: 'flex', alignItems: 'center', padding: '8px 12px', background: '#6b6b6b', color: '#fff', fontFamily: "'Courier New',monospace", borderBottom: '2px solid #373737', fontSize: 12 },
      panelBody: { padding: 12, display: 'grid', gap: 9 },
      folderList: { display: 'grid', gap: 5, maxHeight: 230, overflowY: 'auto', padding: 6, background: '#8b8b8b', border: '2px solid #373737', boxShadow: 'inset 2px 2px 0 #555, inset -2px -2px 0 #fff' },
      folderItem: Object.assign(bevel('#b9d9ec', '#2b4a5d'), { display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', width: '100%', textAlign: 'left', fontSize: 12, justifyContent: 'flex-start' }),
      // convert modal
      overlay: { position: 'fixed', inset: 0, background: 'rgba(10,30,45,.35)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 },
      modal: Object.assign(bevel('#cfd8de'), { width: 560, maxWidth: '100%', maxHeight: '80vh', overflow: 'auto', padding: 0, cursor: 'default', boxShadow: 'inset 2px 2px 0 #fff, inset -2px -2px 0 #6b6b6b, 0 8px 0 #1f1f1f' }),
      candRow: Object.assign(bevel('#eef6fb', '#173b52'), { display: 'grid', gridTemplateColumns: '1fr auto auto', gap: 8, alignItems: 'center', padding: 10, cursor: 'default', boxShadow: 'inset 2px 2px 0 #fff, inset -2px -2px 0 #b0c4cf' }),
      candUrl: { fontSize: 11, wordBreak: 'break-all', color: '#33617a', fontFamily: "'Courier New',monospace", marginTop: 4 },
    }

    // ---- MC-styled directory picker dropdown ------------------------
    // mode='child': browse inside downloadDir, onPick(relativeDir)
    // mode='workspace': browse whole workspace, onPick(workspaceRelativePath)
    function DirPicker({ t, api, mode, current, onPick, onClose }) {
      const [rel, setRel] = useState(current || '')
      const [dirs, setDirs] = useState([])
      const [here, setHere] = useState('')
      const [newName, setNewName] = useState('')
      const [err, setErr] = useState('')
      const base = mode === 'workspace' ? 'workspace' : 'download'
      const title = mode === 'workspace' ? t('pickerTitle') : t('pickerChildTitle')

      const load = useCallback(async (r) => {
        setErr('')
        try {
          const res = await api('browse', { relativeDir: r, base })
          if (res && res.ok) { setDirs(res.value.dirs || []); setHere(res.value.current || '') }
          else setErr(t('browseFail'))
        } catch { setErr(t('browseFail')) }
      }, [api, t, base])
      useEffect(() => { load(rel) }, [rel, load])

      const up = () => { const p = rel.split('/').filter(Boolean); p.pop(); setRel(p.join('/')) }
      const make = async () => {
        const name = newName.trim()
        if (!name) return
        const next = [rel, name].filter(Boolean).join('/')
        try {
          await api('browse', { relativeDir: next, base })
          setRel(next); setNewName('')
        } catch { setErr(t('browseFail')) }
      }

      return h('div', { style: S.dropdown }, [
        h('div', { key: 'h', style: S.panelHead }, [
          EM.folder + ' ' + title,
          h('button', { key: 'x', style: Object.assign({}, S.iconBtn, { marginLeft: 'auto', width: 24, height: 24 }), onClick: onClose }, '✖'),
        ]),
        h('div', { key: 'b', style: S.panelBody }, [
          h('div', { key: 'path', style: { fontFamily: "'Courier New',monospace", fontSize: 11, color: '#2b4a5d', background: '#eef8ff', padding: '7px 9px', border: '2px solid #7fd0f0', wordBreak: 'break-all' } }, '📍 ' + (here || rel || '.')),
          h('div', { key: 'tools', style: { display: 'flex', gap: 5, flexWrap: 'wrap' } }, [
            h('button', { style: S.btn, onClick: up, disabled: !rel }, EM.up + ' ' + t('pickerUp')),
            h('input', {
              value: newName, onChange: e => setNewName(e.target.value),
              placeholder: t('pickerNewHint'),
              style: Object.assign({}, S.input, { flex: 1, minWidth: 110, padding: '7px 9px', fontSize: 12 }),
            }),
            h('button', { style: S.btn, onClick: make }, '+ ' + t('pickerNew')),
          ]),
          h('div', { key: 'list', style: S.folderList },
            dirs.length === 0
              ? h('div', { style: { opacity: .7, padding: 9, fontFamily: "'Courier New',monospace", fontSize: 11 } }, t('pickerEmpty'))
              : dirs.map(d => h('button', {
                  key: d.path, style: S.folderItem, onClick: () => setRel(d.path),
                }, EM.folder + ' ' + d.name))
          ),
          err ? h('div', { style: { color: '#8b1010', fontSize: 11 } }, err) : null,
          h('div', { key: 'foot', style: { display: 'flex', gap: 6, justifyContent: 'flex-end' } }, [
            h('button', { style: S.btn, onClick: onClose }, t('pickerCancel')),
            h('button', { style: S.btnPrimary, onClick: () => onPick(rel) }, '✔ ' + t('pickerHere')),
          ]),
        ]),
      ])
    }

    // ---- inline subfolder dropdown (lists folders inside downloadDir) --
    function SubfolderDropdown({ t, api, value, onPick, onClose }) {
      const [dirs, setDirs] = useState([])
      const [newName, setNewName] = useState('')
      const [err, setErr] = useState('')

      const load = useCallback(async () => {
        setErr('')
        try {
          const res = await api('browse', { relativeDir: '', base: 'download' })
          if (res && res.ok) setDirs(res.value.dirs || [])
          else setErr(t('browseFail'))
        } catch { setErr(t('browseFail')) }
      }, [api, t])
      useEffect(() => { load() }, [load])

      const create = async () => {
        const name = newName.trim()
        if (!name) return
        const next = name.includes('/') ? name.replace(/^\/+/, '') : name
        try {
          await api('browse', { relativeDir: next, base: 'download' })
          onPick(next); setNewName('')
        } catch { setErr(t('browseFail')) }
      }

      return h('div', { style: S.dropdown }, [
        h('div', { key: 'new', style: { display: 'flex', gap: 5, padding: 8, borderBottom: '2px solid #6b6b6b' } }, [
          h('input', {
            value: newName, onChange: e => setNewName(e.target.value),
            placeholder: t('pickerNewHint'),
            style: Object.assign({}, S.input, { flex: 1, minWidth: 0, padding: '7px 9px', fontSize: 12 }),
          }),
          h('button', { style: S.btn, onClick: create }, '+ ' + t('pickerNew')),
        ]),
        h('div', { key: 'list', style: S.folderList },
          dirs.length === 0
            ? h('div', { style: { opacity: .7, padding: 9, fontFamily: "'Courier New',monospace", fontSize: 11 } }, t('pickerEmpty'))
            : dirs.map(d => h('button', {
                key: d.path,
                style: Object.assign({}, S.folderItem, value === d.name ? { background: '#5b8c3a', color: '#fff' } : {}),
                onClick: () => onPick(d.name),
              }, EM.folder + ' ' + d.name))
        ),
        err ? h('div', { style: { color: '#8b1010', fontSize: 11, padding: '4px 8px' } }, err) : null,
        h('button', {
          key: 'root',
          onClick: () => onPick(''),
          title: t('pickerRoot'),
          style: Object.assign({}, S.folderItem, {
            margin: '4px 4px 5px',
            ...(value ? {} : { background: '#5b8c3a', color: '#fff' }),
          }),
        }, EM.folder + ' ' + t('pickerRoot')),
      ])
    }

    // ---- MC-styled convert-link popover -----------------------------
    function ConvertPopover({ t, data, onClose, onDownload }) {
      const [copied, setCopied] = useState(null)
      const copy = async (id, url) => {
        try { await navigator.clipboard.writeText(url) } catch {}
        setCopied(id)
        setTimeout(() => setCopied(null), 1200)
      }
      return h('div', { style: S.overlay, onMouseDown: e => { if (e.target === e.currentTarget) onClose() } },
        h('div', { style: S.modal }, [
          h('div', { key: 'h', style: S.panelHead }, [
            '🔗 ' + t('convTitle'),
            h('button', { key: 'x', style: Object.assign({}, S.iconBtn, { marginLeft: 'auto', width: 26, height: 26 }), onClick: onClose }, '✖'),
          ]),
          h('div', { key: 'b', style: S.panelBody }, [
            h('div', { key: 'hint', style: { fontSize: 12, opacity: .75 } }, t('convHint')),
            (data.candidates || []).map(c => h('div', { key: c.id, style: S.candRow }, [
              h('div', { key: 'info', style: { minWidth: 0 } }, [
                h('div', { style: { fontWeight: 700, fontSize: 13 } },
                  c.label + ' ',
                  h('span', { style: Object.assign({}, S.srcChip, { background: c.proxied ? '#fff1c1' : '#e6eef3', color: c.proxied ? '#a87900' : '#5b7a8c' }) },
                    c.proxied ? t('convProxy') : t('convDirect'))),
                h('div', { style: S.candUrl }, c.url),
              ]),
              h('button', {
                key: 'copy', title: t('convCopy'),
                style: Object.assign({}, S.iconBtn, { width: 'auto', padding: '0 9px', gap: 4 }),
                onClick: () => copy(c.id, c.url),
              }, copied === c.id ? EM.copied : EM.copy, ' ', copied === c.id ? t('convCopied') : t('convCopy')),
              h('button', { key: 'dl', title: t('convDownload'), style: S.btnPrimary, onClick: () => onDownload(c) },
                EM.down, ' ', t('convDownload')),
            ])),
          ]),
        ])
      )
    }

    function Panel(props) {
      const injected = props && props.inject && typeof props.inject === 'object' ? props.inject : {}
      // Always use the plugin's Chinese dictionary; ignore the framework's
      // injected English `t`, which otherwise overrides button labels.
      const t = key => (Object.prototype.hasOwnProperty.call(zh, key) ? zh[key] : key)
      const api = injected.api || (props && props.api) || call

      const [tasks, setTasks] = useState([])
      const [tab, setTab] = useState('all')
      const [showForm, setShowForm] = useState(true)
      const [url, setUrl] = useState('')
      const [fileName, setFileName] = useState('')
      const [dirName, setDirName] = useState('')
      const [config, setConfig] = useState(null)
      const [notice, setNotice] = useState('')
      const [creating, setCreating] = useState(false)
      const [dirPicker, setDirPicker] = useState(null) // null | {mode:'workspace'}
      const [subOpen, setSubOpen] = useState(false)
      const [convData, setConvData] = useState(null)
      const [converting, setConverting] = useState(false)
      const alive = useRef(true)

      const refresh = useCallback(async () => {
        try {
          const res = await api('list', {})
          if (res && res.ok && alive.current) setTasks(res.value || [])
          else if (alive.current && res && !res.ok) setNotice(t('listFail'))
        } catch {}
      }, [api])
      const reloadConfig = useCallback(async () => {
        try {
          const res = await api('config', {})
          if (res && res.ok && res.value && alive.current) setConfig(res.value)
        } catch {}
      }, [api])

      useEffect(() => {
        alive.current = true
        refresh()
        reloadConfig()
        return () => { alive.current = false }
      }, [refresh, reloadConfig])

      const hasActive = tasks.some(x => x.state === 'downloading' || x.state === 'queued')
      useEffect(() => {
        if (!hasActive) return
        const id = setInterval(refresh, 1000)
        return () => clearInterval(id)
      }, [hasActive, refresh])

      const submit = useCallback(async (override) => {
        const value = (override && override.url) || url.trim()
        if (!value) return
        setCreating(true); setNotice('')
        try {
          const res = await api('create', {
            url: value,
            fileName: (override && override.fileName) || fileName.trim(),
            relativeDir: (override && override.relativeDir) || dirName.trim(),
            channel: override && override.channel,
            proxyUrl: override && override.proxyUrl,
          })
          if (res && res.ok) {
            if (!override) { setUrl(''); setFileName('') }
            await refresh()
          } else if (res && res.error && res.error.code === 'invalid-url') {
            setNotice(t('githubOnly'))
          } else setNotice(t('createFail'))
        } catch { setNotice(t('createFail')) } finally { setCreating(false) }
      }, [api, url, fileName, dirName, refresh])

      const doConvert = useCallback(async () => {
        const value = url.trim()
        if (!value) return
        setConverting(true); setNotice('')
        try {
          const res = await api('convert', { url: value })
          if (res && res.ok) setConvData(res.value)
          else if (res && res.error && res.error.code === 'invalid-url') setNotice(t('githubOnly'))
          else setNotice(t('convertFail'))
        } catch { setNotice(t('convertFail')) } finally { setConverting(false) }
      }, [api, url])

      const openDefaultDir = useCallback(async () => {
        try { await api('op', { action: 'openDir' }) } catch { setNotice(t('opFail')) }
      }, [api])

      const changeDefaultDir = useCallback(async (path) => {
        setDirPicker(null)
        if (!path) return
        try {
          const res = await api('setDir', { dir: path })
          if (res && res.ok) {
            setConfig(c => Object.assign({}, c, { downloadDir: res.value.downloadDir }))
            setDirName('')
          } else setNotice(t('browseFail'))
        } catch { setNotice(t('browseFail')) }
      }, [api])

      const doOp = useCallback(async (action, id) => {
        try {
          const res = await api('op', { action, id })
          if (!res || !res.ok) setNotice(t('opFail'))
          await refresh()
        } catch { setNotice(t('opFail')) }
      }, [api, refresh])

      const counts = {
        all: tasks.length,
        active: tasks.filter(x => ['downloading', 'queued', 'paused'].includes(x.state)).length,
        done: tasks.filter(x => x.state === 'done').length,
        error: tasks.filter(x => ['error', 'canceled'].includes(x.state)).length,
      }
      const filtered = tasks.filter(x =>
        tab === 'all' ? true
          : tab === 'active' ? ['downloading', 'queued', 'paused'].includes(x.state)
          : tab === 'done' ? x.state === 'done'
          : ['error', 'canceled'].includes(x.state))
      const tabs = [
        ['all', 'tabAll', counts.all], ['active', 'tabActive', counts.active],
        ['done', 'tabDone', counts.done], ['error', 'tabError', counts.error],
      ]

      function TaskRow(task) {
        const pct = task.progress || (task.total ? Math.min(100, Math.round(task.bytes / task.total * 100)) : 0)
        const color = stateColor(task.state)
        const active = ['downloading', 'queued', 'paused'].includes(task.state)
        const width = task.total ? pct + '%' : (task.state === 'done' ? '100%' : '35%')
        const ops = []
        if (task.state === 'downloading' || task.state === 'queued') {
          ops.push(h('button', { key: 'p', title: t('pause'), style: S.iconBtn, onClick: () => doOp('pause', task.id) }, EM.pause))
          ops.push(h('button', { key: 'x', title: t('cancel'), style: S.iconBtn, onClick: () => doOp('cancel', task.id) }, EM.cancel))
        } else if (task.state === 'paused') {
          ops.push(h('button', { key: 'r', title: t('resume'), style: S.iconBtn, onClick: () => doOp('resume', task.id) }, EM.resume))
        } else {
          ops.push(h('button', { key: 'r', title: t('retry'), style: S.iconBtn, onClick: () => doOp('retry', task.id) }, EM.retry))
        }
        if (task.state === 'done') {
          ops.push(h('button', { key: 'o', title: t('open'), style: S.iconBtn, onClick: () => doOp('open', task.id) }, EM.open))
        }
        ops.push(h('button', { key: 'd', title: t('remove'), style: S.iconBtn,
          onClick: () => { if (window.confirm(t('confirmRemove'))) doOp('remove', task.id) } }, EM.remove))

        return h('div', { key: task.id, style: S.row }, [
          h('div', { key: 'i', style: S.rowIcon }, EM[task.state] || EM.downloading),
          h('div', { key: 'm', style: S.rowMain }, [
            h('div', { key: 'n', style: S.rowName }, [
              task.fileName || task.url,
              h('span', { key: 's', style: task.source === 'agent' ? S.srcChipAi : S.srcChip },
                task.source === 'agent' ? EM.ai + ' ' + t('sourceAgent') : EM.manual + ' ' + t('sourceManual')),
              task.channel ? h('span', { key: 'c', style: S.chChip }, '⚡ ' + task.channel) : null,
            ]),
            h('div', { key: 'u', style: S.rowUrl }, task.url),
            h('div', { key: 'b', style: S.barWrap }, h('div', { style: Object.assign({}, S.barFill(color), { width }) })),
            h('div', { key: 'meta', style: S.meta }, [
              h('span', { key: 'st', style: { color, fontWeight: 700 } }, t(stateKey(task.state))),
              h('span', { key: 'sz' }, fmtBytes(task.bytes) + (task.total ? ' / ' + fmtBytes(task.total) + ' (' + pct + '%)' : '')),
              active && task.state === 'downloading' ? h('span', { key: 'sp' }, t('speed') + ': ' + fmtSpeed(task.speed)) : null,
              h('span', { key: 'tm' }, fmtTime(task.finishedAt || task.startedAt || task.createdAt)),
            ]),
            task.error ? h('div', { key: 'er', style: S.err }, task.error) : null,
          ]),
          h('div', { key: 'ops', style: S.ops }, ops),
        ])
      }

      const defaultDir = config ? (config.downloadDir || '') : '…'
      const saveTo = dirName ? defaultDir + '/' + dirName : defaultDir

      return h('div', { style: S.wrap }, [
        h('div', { key: 'frame', style: S.frame }, [
          h('div', { key: 'fixed', style: S.fixed }, [
            h('div', { key: 'inner', style: S.inner }, [
              h('div', { key: 'head', style: S.head }, [
                h('div', { key: 'ttl' }, [
                  h('h1', { style: S.title }, '🔔 ' + t('title')),
                  h('p', { style: S.desc }, t('desc')),
                ]),
              ]),
              h('div', { key: 'tb', style: S.toolbar }, [
                h('div', { key: 'dirwrap', style: S.dirWrap }, [
                  h('div', { key: 'chip', style: S.dirChip, title: t('defaultDir') },
                    '📂 ', t('defaultDir'), ': ', h('span', { style: S.dirPath }, defaultDir)),
                  h('button', { key: 'open', style: S.btn, onClick: openDefaultDir }, '📂 ' + t('openDir')),
                  h('button', { key: 'change', style: S.btn, onClick: () => setDirPicker({ mode: 'workspace' }) }, '🔄 ' + t('changeDir')),
                  dirPicker && dirPicker.mode === 'workspace'
                    ? h(DirPicker, {
                        key: 'wspick', t, api, mode: 'workspace', current: defaultDir,
                        onPick: changeDefaultDir, onClose: () => setDirPicker(null),
                      })
                    : null,
                ]),
              ]),
              showForm ? h('div', { key: 'form', style: S.form }, [
                h('div', { key: 'urlwrap', style: S.urlWrap }, [
                  h('input', { key: 'url', value: url, onChange: e => setUrl(e.target.value),
                    placeholder: t('urlPlaceholder'), style: Object.assign({}, S.input, { flex: 1, minWidth: 0 }) }),
                  h('button', { key: 'clr', title: t('clearUrl') || '清空', style: Object.assign({}, S.iconBtn, { flex: '0 0 auto' }),
                    onClick: () => setUrl('') }, '❌'),
                ]),
                h('div', { key: 'row', style: S.inputRow }, [
                  h('input', { key: 'f', value: fileName, onChange: e => setFileName(e.target.value),
                    placeholder: '文件名（可选）', style: Object.assign({}, S.input, { flex: 1, minWidth: 0 }) }),
                  h('div', { key: 'sub', style: S.subWrap }, [
                    h('input', { key: 'd', value: dirName, onChange: e => setDirName(e.target.value),
                      placeholder: '子目录（可选，可新建）', style: Object.assign({}, S.input, { flex: 1, minWidth: 0 }) }),
                    h('button', { key: 'dv', title: t('pickerChildTitle'), style: Object.assign({}, S.iconBtn, { flex: '0 0 auto' }),
                      onClick: () => setSubOpen(v => !v) }, '▼'),
                    subOpen
                      ? h(SubfolderDropdown, {
                          key: 'subdrop', t, api, value: dirName,
                          onPick: rel => { setDirName(rel); setSubOpen(false) },
                          onClose: () => setSubOpen(false),
                        })
                      : null,
                  ]),
                  h('button', { key: 'conv',
                    style: Object.assign({}, S.btn, { flex: '0 0 auto', opacity: converting || !url.trim() ? 0.55 : 1 }),
                    onClick: doConvert, disabled: converting || !url.trim() },
                    converting ? t('converting') : '🔗 ' + t('convert')),
                  h('button', { key: 'go', onClick: () => submit(),
                    style: Object.assign({}, S.btnPrimary, { flex: '0 0 auto', opacity: creating || !url.trim() ? 0.55 : 1 }),
                    disabled: creating || !url.trim() },
                    creating ? '提交中…' : '⬇ 开始下载'),
                ]),
                h('div', { key: 'saveto', style: { fontSize: 11, color: '#5b7a8c', opacity: .85 } }, '📍 ' + t('dirName') + ': ' + saveTo),
              ]) : null,
              notice ? h('p', { key: 'notice', role: 'alert', style: S.notice }, notice) : null,
              h('div', { key: 'tabs', style: S.tabs }, [
                ...tabs.map(([key, label, count]) => h('button', {
                  key, onClick: () => setTab(key), style: tab === key ? S.tabOn : S.tab,
                }, t(label) + '  ' + count)),
                h('span', { key: 'spacer', style: { flex: 1 } }),
                h('button', { key: 'clear', style: S.btn,
                  onClick: () => { if (counts.done && window.confirm(t('confirmClear'))) doOp('clearCompleted') } }, '🧹 ' + t('clearDone')),
                h('button', { key: 'rf', style: S.btn, onClick: refresh }, '↻ ' + t('refresh')),
              ]),
            ]),
          ]),
          h('div', { key: 'scroll', style: S.scroll },
            h('div', { key: 'listWrap', style: S.list },
              filtered.length === 0
                ? h('div', { key: 'empty', style: S.empty }, t(tab === 'all' ? 'emptyAll' : tab === 'active' ? 'emptyActive' : tab === 'done' ? 'emptyDone' : 'emptyError'))
                : filtered.map(TaskRow))),
        ]),
        convData ? h(ConvertPopover, {
          t, data: convData,
          onClose: () => setConvData(null),
          onDownload: cand => {
            setConvData(null)
            submit({ url: cand.url, fileName, relativeDir: dirName, channel: cand.id, proxyUrl: cand.url })
          },
        }) : null,
      ])
    }

    function PanelIcon({ size }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
      }, [
        h('path', { key: 'a', d: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4' }),
        h('polyline', { key: 'b', points: '7 10 12 15 17 10' }),
        h('line', { key: 'c', x1: 12, y1: 15, x2: 12, y2: 3 }),
      ])
    }

    return {
      name: 'dsh-gh-downloader',
      inject: ['slots', 'locale', 'layout'],
      apply(ctx) {
        // Force Chinese copy regardless of the host UI language.
        const t = key => (Object.prototype.hasOwnProperty.call(zh, key) ? zh[key] : key)
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), NS + ':copy')
        ctx.effect(
          () => ctx.slots.inject('main', () => ctx.slots.register({
            name: 'main', key: PANEL_ID, locale: NS,
            inject: () => ({ t, api: call }),
          }, Panel)),
          NS + ':panel',
        )
        ctx.effect(
          () => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
            name: 'sidebar.panellist', id: PANEL_ID, order: 40,
            label: () => t('panel'), locale: NS,
          }, PanelIcon)),
          NS + ':sidebar',
        )
      },
    }
  },
})
