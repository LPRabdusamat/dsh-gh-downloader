# dsh-gh-downloader

GitHub 资源下载管理器插件。左侧栏提供一个**百度网盘式的下载管理面板**（下载中 / 已完成 / 失败分类、进度条、实时速度、暂停/继续/重试/删除/打开文件夹），主要供 Agent 在下载 GitHub 源码时自动调用，同时支持手动粘贴链接下载。

界面风格：哆啦A梦色调的界面 + 我的世界箱子风的按钮/控件。

## 功能

### Agent 自动调用（主用途）

- `github_download({ url, fileName?, relativeDir?, wait? })` — AI 遇到 GitHub 链接时调用，通过加速代理下载到工作区。传 `wait:true` 可等待下载完成再返回。
- `github_download_status({ id? })` — 查询单个任务进度，或列出全部任务。
- 工具描述中明确要求 AI 下载任何 GitHub URL 时都走本插件（而非 curl/wget）。
- Agent 创建的任务自动出现在面板里，带 `AI` 来源标记。

### 面板（左侧栏「GitHub 下载」）

- 上半部分固定（粘贴框 / 转换 / 目录位置 / 标签），只有下面的下载列表滚动，任务多也不乱。
- 顶部「默认下载位置」旁边有：
  - **[打开]**：在系统文件管理器中打开该目录。
  - **[更换]**：箱子风下拉浏览工作区目录，选新位置，持久化到 `settings.json`。
- 粘贴框右侧有 **❌** 用于清空链接。
- **文件名**：可选，不填自动取 URL 末段。
- **子目录**：可选，是输入框 + ▼ 下拉。▼ 在框下方内嵌列出下载目录里的文件夹供选择；输入框里输入名字则新建子目录。
- **[开始下载]**：用默认前缀（gh-proxy.com）直接下载。
- **[转换链接]**：解析后弹窗列出多条通道候选（gh-proxy 主站 / 备用 / ghfast / 直连），每条最右侧有 **复制链接** 和 **下载** 两个图标按钮，点下载直接从该通道开始。
- 分类标签：全部 / 下载中 / 已完成 / 失败，带计数；清空已完成、刷新放在标签行右侧。
- 每行显示：文件名、来源（AI/手动）、通道标记、URL、进度条、百分比、大小、速度、时间。
- 操作：暂停、继续、取消、重试、删除、打开文件夹、清空已完成。
- 所有文案固定中文，不受 DSH 界面语言影响。

### 下载引擎

- 多个 gh-proxy 加速通道，默认 `https://gh-proxy.com/`。
- GitHub 域名白名单（github.com / raw / codeload / objects / api.github.com / gist 等）；`/blob/` 浏览链接自动改写为 raw 直链。
- 真实字节进度与速度计算，HTTP Range 断点续传（暂停/继续保留已下载部分）。
- 并发队列（默认 3，可配置），流式落盘不缓存整包。
- 任务账本持久化到 `<DSH_HOME>/dsh-gh-downloader/tasks.json`，重启后历史保留，中断任务恢复为可续传的暂停态；默认目录变更存到同目录的 `settings.json`。

## 安装

在 profile 目录（本机为 `C:\Users\Administrator\.dsh\profiles\desktop`）执行：

```powershell
dsh plugin --profile desktop add file:<本插件目录的绝对路径>
```

例如：

```powershell
dsh plugin --profile desktop add file:C:/Users/Administrator/Documents/deepseek-harness/default-workspace/dsh-gh-downloader
```

安装会自动把 `dsh-gh-downloader` 加入 `dsh.profile.bundles` 并用 pnpm 建立依赖。

本 profile 未启用 HMR，**改动代码后需重启 DSH 生效**。若直接改源码，需同步到安装目录：

```powershell
$src='<本插件目录>\lib'
$dst='C:\Users\Administrator\.dsh\profiles\desktop\node_modules\dsh-gh-downloader\lib'
Copy-Item "$src\index.js" "$dst\index.js" -Force
Copy-Item "$src\client.js" "$dst\client.js" -Force
```

## 配置

`cordis.patch.yml` 的行配置：

```yaml
- insert:
    - id: dsh-gh-downloader
      name: dsh-gh-downloader
      config:
        proxy: https://gh-proxy.com/
        downloadDir: dsh-gh-downloader-downloads
        concurrency: 3
        timeoutMs: 0
```

| 字段 | 默认 | 含义 |
|---|---|---|
| `proxy` | `https://gh-proxy.com/` | 默认加速前缀（「开始下载」用） |
| `downloadDir` | `dsh-gh-downloader-downloads` | 下载目录，相对工作区根目录 |
| `concurrency` | `3` | 并发下载数 |
| `timeoutMs` | `0` | 单任务超时（毫秒），0 为不限 |

运行时可通过面板的「更换」按钮改默认下载位置，覆盖 `downloadDir` 并写入 `settings.json`（优先级高于 patch 配置）。

### 通道

「转换链接」弹窗中的候选通道定义在 `lib/index.js` 顶部的 `CHANNELS` 数组，可自行增删：

```js
const CHANNELS = [
  { id: 'gh-proxy',     label: 'GH-Proxy (主站)', prefix: 'https://gh-proxy.com/' },
  { id: 'gh-proxy-org', label: 'GH-Proxy (备用)', prefix: 'https://gh-proxy.org/' },
  { id: 'ghfast',       label: 'GhFast',          prefix: 'https://ghfast.top/' },
  { id: 'direct',       label: '直连 GitHub',     prefix: '' },
]
```

## 结构

```
dsh-gh-downloader/
├── package.json          # dsh.bundle.patch + dsh.client 声明
├── cordis.patch.yml      # Host loader 行 + 配置
├── icon.svg
├── lib/
│   ├── index.js          # Host：AI 工具 + HTTP 路由 + 下载引擎 + 持久化
│   └── client.js         # Client：网盘式 main 面板 + 侧栏入口（无 JSX/构建步骤）
├── preview.html          # 面板静态预览（浏览器直接打开）
└── README.md
```

## HTTP 路由（供面板调用）

全部为 `POST`，路径前缀 `/api/dsh-gh-downloader/`：

| 路由 | 用途 |
|---|---|
| `list` | 列出全部任务 |
| `create` | 新建下载任务（可指定 channel / proxyUrl） |
| `op` | 任务操作：pause / resume / cancel / retry / remove / open / openDir / clearCompleted |
| `config` | 读取配置与通道列表 |
| `setDir` | 更换默认下载目录 |
| `convert` | 把 GitHub URL 转换成多通道候选链接 |
| `browse` | 浏览目录（base=download 下载目录内 / base=workspace 工作区） |

## 许可

MIT
