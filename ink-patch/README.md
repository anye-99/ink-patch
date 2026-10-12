# 墨记 InkNotes 补丁工程 v2

包含两个独立补丁，都打在同一个 `app.asar` 上，可分别回退（`pack.cjs` 可重复运行，已在位的补丁不会重复注入）：

| 补丁 | 目标 |
| --- | --- |
| A. 自动拉取（v1） | 本机 Obsidian 仓库变化时（Obsidian 同步、编辑、坚果云拉取），墨记自动增量拉取，不用再进设置手点「立即拉取」 |
| B. 导出按钮合并（v2） | 编辑器工具栏的「导出 MD」「导出 Word」两个按钮合并为单个「导出」，点击弹出下拉菜单选择格式 |
| C. 文件优先（v3） | **笔记就是本机仓库里的 `.md` 文件**（Obsidian 式）：墨记里改什么文件就变什么，文件改了什么墨记就变什么；删除进 `.trash` |
| D. AI 助手侧边栏（v4） | 右侧滑出对话面板：**自定义添加多套 OpenAI 兼容 API**（Base URL / Key / 模型可增删改切换），流式回答，可引用当前笔记作上下文，回复一键插入光标处 |
| E. 反向链接面板（v5） | 右侧滑出「反向链接」抽屉：**实时扫描库中引用当前笔记的来源列表**（支持标准双链、别名、锚点、嵌入），展示上下文行号摘录与高亮；支持未链接提及扫描与一键「转为双链」；点击卡片或摘录平滑跳转目标笔记 |

## 现在生效的行为

| 场景 | 行为 |
| --- | --- |
| Obsidian 侧写入/同步过文件 | 主进程 2.5 秒防抖合并后，**只读变化的文件**并增量合并入库 |
| 墨记关闭期间 Obsidian 同步过 | 每次启动墨记 6 秒后补拉一次：按 mtime 找出比「上次同步时间」更新的文件（先 stat 清单，再分批读取） |
| 在设置里换仓库目录 | 5 秒内自动改为监视新目录 |
| 清空仓库目录配置 | 自动停止监视 |
| 取消勾选「执行云同步时自动拉取本机 Obsidian 变更并推至云端」 | 自动拉取整体停用（含启动补拉） |

拉取等价于点「立即拉取」：走官方增量合并（同名笔记 upsert），**不会删除**墨记里的笔记。

## 改了什么（都在 app.asar 内）

补丁 A（自动拉取）：

| 文件 | 改动 |
| --- | --- |
| `electron/main.cjs` | 新增 `fs.watch` 递归监视、2.5s 防抖、以及 IPC：`ink:watch-vault` / `ink:unwatch-vault` / `ink:read-vault-files` / `ink:vault-manifest` / `ink:auto-pull-log` |
| `electron/preload.cjs` | 桥接上述接口为 `window.inkNotes.{watchVault,unwatchVault,readVaultFiles,vaultManifest,onVaultChanged,offVaultChanged,logAutoPull}` |
| `dist/assets/index-CXqJx8nv.js` | 文件末尾追加自动拉取逻辑（与官方代码同作用域，直接复用官方 `NG()` / `FG()` / `LG()`） |

补丁 B（导出按钮合并，同一个 bundle）：

| 位置 | 改动 |
| --- | --- |
| `dist/assets/index-CXqJx8nv.js` 中部 | 工具栏那两个导出 button 的 JSX 文本整段替换为单个「导出」按钮（`onClick` 调 `__inkExportMenu`） |
| `dist/assets/index-CXqJx8nv.js` 末尾 | 追加 `src/export-menu.snippet.js`（下拉菜单实现，原生 DOM 浮层 + `<style>` 注入） |

补丁 C（文件优先）：

| 文件 | 改动 |
| --- | --- |
| `electron/main.cjs` | 新增文件服务 IPC：`ink:fs-apply`（写文件/改名/回收站，支持 `dryRun` 预演）、`ink:fs-scan`（只读文件头 8KB 解析 frontmatter title）、`ink:fs-seed`、`ink:fs-idmap`、`ink:fs-log`；新增**自写抑制**（watcher 与启动补拉过滤掉本应用自己写的文件） |
| `electron/preload.cjs` | 桥接 `fsApply` / `fsScan` / `fsSeed` / `fsIdMap` / `logFsMirror` |
| `dist/assets/index-CXqJx8nv.js` 末尾 | 追加 `src/fs-mirror.snippet.js`（Dexie 表钩子 + 防抖 flush + 路径计算 + 首次对账与安全闸） |

补丁 D（AI 助手侧边栏）：

| 文件 | 改动 |
| --- | --- |
| `electron/main.cjs` | 新增 IPC：`ink:ai-config-get` / `ink:ai-config-save`（配置存 `%APPDATA%\ink-notes\ai-config.json`）、`ink:ai-chat`（`net.fetch` 流式代理，绕开 CORS，SSE 增量经 `ink:ai-chunk` 推回渲染层）、`ink:ai-abort`（按 requestId 中止，5 分钟超时兜底） |
| `electron/preload.cjs` | 桥接 `getAiConfig` / `saveAiConfig` / `aiChat` / `aiAbort` / `onAiChunk` / `offAiChunk` |
| `dist/assets/index-CXqJx8nv.js` 中部 | 编辑器 JSX 加 `onCreateEditor:__inkAiOnEditor`（拿 CodeMirror EditorView，用于读全文与光标插入）；工具栏「导出」按钮后加「AI」按钮 |
| `dist/assets/index-CXqJx8nv.js` 末尾 | 追加 `src/ai-panel.snippet.js`（面板 UI + 多配置管理 + 流式渲染 + 极简 Markdown 渲染器） |

其余 5000+ 个文件的数据区**逐字节未动**（offset 不变），只重算了被改动文件的 integrity。
校验方式：`node tools/compare-bundle.cjs` 比对 asar 内 bundle 与 `preview/dist` 提取副本的 SHA256。

## 补丁 C：文件优先（v3）—— 让笔记就是磁盘上的 .md 文件

**做了什么**：在墨记里新建 / 编辑 / 改名 / 移动笔记，都会实时写成本机仓库里的 `.md` 文件；
用 Obsidian 或任何编辑器改这些文件，改动也会回流墨记。删除走 `.trash` 回收站，不物理删。

**怎么做到（零侵入）**：墨记的全部写操作最终都落到 IndexedDB 的四张表上。补丁 C 只在入口 bundle
末尾给 Dexie 实例挂表钩子，**没有改动一行官方 DAO / UI 代码**，因此官方升级后重新注入的成本很低：

```
库内写入 → 表钩子登记受影响笔记（同步、内存操作）→ 防抖 250ms → 读回最终状态 → 分批（40/批）推给主进程
```

主进程负责：分配稳定路径（`noteId → 库内路径`，记录在 `<库>/.ink-notes/idmap.json`）、建目录、写文件、改名、进回收站。

**回环保卫**（写文件会触发 watcher，不防就会「写 → 拉 → 写」死循环）：

1. 主进程登记自写路径 + mtime，watcher 与启动补拉遇到自写文件直接丢弃；
2. 落盘前先比对内容，**完全一致就一个字节都不写**（幂等，不产生多余的 mtime 变化）；
3. 官方增量合并自身的内容比较作为兜底。

**首次对账的安全闸**：第一次接入时会先**预演**（只算不写），统计「会新建几个文件、能认领几个已有文件」。
如果出现「要新建的比认领到的还多，且 ≥50 个」这种明显不对的情况，会**停手不动你的库**，
并在控制台给出放行方法。正常情况（库里的笔记本来就来自这些文件）预演会显示绝大多数是「认领」。

**明确不会碰的东西**：

- PDF / Word 笔记不落盘（它们的正文是从原件提取出来的文本，原件本来就在仓库里）；
- 不属于这份笔记的同名文件绝不覆盖，一律退让为 `标题 (2).md`；
- 删除只把文件移入 `.trash`（带时间戳），可手工找回；
- 文件夹改名/移动会让其下笔记的**目录**跟着变，但**文件名保持不动**（这样 frontmatter 标题与文件名不一致的笔记不会被反复改名）。

**日志与排查**

日志：`%APPDATA%\ink-notes\fs-mirror.log`（每行一条 JSON，事件有 `bootstrap-plan` / `bootstrap-done` / `claim` / `flush` / `apply-failed`）。

在墨记里按 `Ctrl+Shift+I` 打开控制台：

```js
__inkFsMirror.status()    // 待落盘队列、钩子挂载情况、累计统计
__inkFsMirror.planNow()   // 只算不写：看这一轮会新建/认领/改名多少文件
__inkFsMirror.flushNow()  // 立即落盘一次
__inkFsMirror.idmap()     // 笔记 → 文件 的归属表
__inkFsMirror.fullBootstrap()  // 忘掉「已对账」标记，重新走一次首次对账流程
```

**这个补丁的边界**（说清楚，免得误解）：IndexedDB 并没有被删掉，它的地位变成了**派生索引/缓存**
——和 Obsidian 的 `.obsidian/` 目录是同一性质的东西：运行期内存态与索引，丢了能从文件重建，不是数据的家。
真正的事实来源是磁盘上的 `.md` 文件。

## 补丁 D：AI 助手侧边栏（v4）—— 自定义 API 的对话面板

**做了什么**：编辑器工具栏多一个「AI」按钮（或 `Ctrl+Shift+A`），右侧滑出 420px 对话抽屉：

- **多套 API 配置**：⚙ 进入配置页，可添加 / 编辑 / 删除 / 切换任意多个 OpenAI 兼容服务
  （DeepSeek、OpenAI、硅基流动、Ollama 本地等，带一键预设回填；填 Base URL + Key + 模型名即可）；
- **流式输出**：边生成边渲染，生成中按钮变「停止」可随时中止；
- **引用当前笔记**：勾选后把正在编辑的正文（≤20000 字，超长自动截断）作为上下文随问题发送；
- **一键插入**：每条回复下有「插入到笔记」（写进 CodeMirror 光标处）与「复制」；
- 对话历史存 localStorage，重启不丢；回复里的 Markdown（标题/列表/代码块/引用/粗斜体/链接）按格式渲染。

**为什么走主进程代理**：多数国内服务与本地 Ollama 不返回 CORS 头，渲染进程直接 fetch 会被拦；
主进程 `net.fetch` 无此限制（与 WebDAV 代理同一套路）。请求失败时错误原文（含 HTTP 状态）会显示在面板里。

**安全边界**：API Key 明文存 `%APPDATA%\ink-notes\ai-config.json`（仅本机，不上传不同步）；
Markdown 渲染先转义 HTML 再拼装，链接只放行 http(s)，不引入任何第三方渲染库。

**日志与排查**：`%APPDATA%\ink-notes\ai-assistant.log`（每次请求一行：status / chars / ms / error）。
DevTools 控制台可查：

```js
__inkAiApi.internals.getState()      // 面板状态：open / streaming / history / editorView 是否绑定
__inkAiApi.toggle(true)              // 代码方式打开面板
__inkAiApi.insertToNote('文本')      // 往光标处插一段文字
```

**与 preview 的关系**：浏览器里的 preview 没有 `window.inkNotes`，面板自动回退为
localStorage 存配置 + 渲染进程直接 fetch（可能被 CORS 拦，属预期）。

**实测记录（2026-10-11 首次接入真实库）**

真实库规模：2319 个文件 / 696 MB / **1292 个 md**；墨记库里 476 篇活跃笔记。

| 阶段 | 结果 |
| --- | --- |
| 首次对账预演 | `create 17 / adopt 459 / overwrite 0`，安全闸未触发 |
| 真实落盘 | 17 个文件，0 失败 |
| 文件侧改动回流 | `reason=watch counts={total:1, updated:1}`，紧接着 `flush written:0`（幂等，无回环） |
| 原有笔记完整性 | 相对接入前备份 **0 改动、0 丢失** |

**踩过的三个坑（都已修，别踩回去）**

1. **frontmatter 被抹掉**：墨记导入 md 时只把**正文**存进库，frontmatter 里的 `tags` 不入库。
   最初按「文件全文 vs 库正文」比对，于是把 23 个带 frontmatter 的文件判为「内容不同」直接覆盖，`tags` 全丢。
   现在改成**按正文比对 + 写回时保留原 frontmatter**（`fsSplitFrontmatter` / `fsBodyEqual`）。
2. **按标记跳过导致补丁无法升级**：pack.cjs 原先「标记已在位就不重打」，结果改完 snippet 重新打包，
   asar 里留着的仍是旧版逻辑（症状：对账标记还是 `|v1`、日志报 `reconciled:true`）。
   现在**优先从干净的官方原版备份重建全部补丁**（`findCleanBaseline()`），顺带把多次追加累积膨胀的 asar 从 107 MB 瘦回 98.8 MB。
3. **同名重复笔记被放大**：库里存在同目录同标题、**内容完全相同**的重复笔记（历史重复导入造成）。
   最初先按「路径已被别的笔记占用」让位，写出 `标题 (2).md`；而这个文件名回流后会被官方合并逻辑
   当成一篇叫「标题 (2)」的新笔记，重复越滚越多（实测滚出 `(2) (2)`）。
   现在改成**先判断内容是否就是这一份 —— 相同就共用同一个文件**，只有内容真的不同才退让。

**已知遗留**：库里现有 17 篇 `X (2)` 重复笔记（早期版本的产物），在墨记里删掉它们即可（删了会进 `.trash`）。

**v4 追加的两件事（2026-10-11 第二轮实测）**

1. **分批全量导入**：首次对账时把磁盘上**还没入库**的笔记文件按批（40 个）读进库，
   内存峰值只跟一批文件有关。这是「磁盘是唯一数据源」的最后一环——官方全量拉取 `RG()`
   会把整个库（本机 683 MB，含 PDF/Word）一次性读进渲染进程内存，足以把页面搞崩，所以一直没敢用。
   实测：459 个可见文件 / 12 批 / `created 0, unchanged 459`（幂等）。
   手动触发：`__inkFsMirror.importAll()`；连 PDF/Word 一起：`__inkFsMirror.importAll({ includeBinary: true })`。
2. **尊重磁盘侧的删除**：某篇笔记原本已经落过盘、而那个文件在磁盘上不见了 → 判为「用户在 Obsidian 侧删掉了它」，
   **不再重建**。修之前的行为是删了下次启动又回来（实测 `written: 1`），等于用户永远删不掉文件；现在实测 `written: 0`。

**收敛性证据**：库内 476 篇笔记 ↔ 磁盘 476 个文件，**一一对应、0 缺失**；
首次对账 `create 0 / adopt 476 / overwrite 0`；日常 flush `written: 0`。

> 注：`D:\TRAEWORK\个人知识库` 下另有 853 个 md/txt 位于 `.workbuddy` 之类的**隐藏目录**里
> （第三方工具产物）。墨记与补丁都按官方口径跳过以 `.` 开头的路径段，因此它们不计入笔记——这是预期行为。

## 补丁 E：反向链接（Backlinks）面板（v5）

**做了什么**：在编辑器工具栏右侧新增「反链」按钮（并支持 `Ctrl+Shift+B` 快捷键），右侧滑出 390px 反向链接抽屉：

- **已链接提及（Linked Mentions）**：精准匹配所有包含 `[[当前笔记]]`、`[[当前笔记|别名]]`、`[[当前笔记#锚点]]` 及嵌入 `![[当前笔记]]` 的来源笔记；
- **未链接提及（Unlinked Mentions）**：自动排查正文中提到当前笔记名称、但未加 `[[]]` 的段落（智能排除代码块、行内代码与 Markdown 外部链接），并提供**一键「转为双链」**按钮；
- **智能上下文摘录**：显示引用所在的上下文句子与行号（如 `L12`），高亮关键引用词，长行自动以匹配词为中心居中截断；
- **一键平滑跳转**：点击来源笔记标题或摘录段落，直接跳转并打开目标笔记；若反链面板保持打开，会自动跟随更新为新笔记的反链视图；
- **实时角标与动态同步**：切换笔记时，工具栏按钮即时显示该笔记的反链数量（如 `反链 (3)`）；打开反链面板时会自动与 AI 助手面板互斥关闭，避免视觉遮挡。

## 补丁 B 的细节与取舍

- **不抄写整段压缩代码**：`src/ui-patches.cjs` 用一对短锚点（`title:\`导出为 Markdown 文件\`` 开头 → `children:\`导出 Word\`})]})` 收尾）定位区间，替换前校验区间内确实含「导出 MD」「导出 Word」及两个 onClick，长度异常或命中次数 ≠ 1 一律报错中止。
- **不用 React state**：那段 JSX 是条件渲染，在其中调 `useState` 会破坏 hooks 顺序；改用原生 DOM 浮层，样式走应用已有的 CSS 变量（`--panel/--border/--radius/--hover`…），带浅色回退值。
- **失败可降级**：菜单创建异常时回退为直接导出 Markdown；导出回调同步抛错或返回 rejected Promise 都只记 `console.warn`，不影响菜单关闭。
- 菜单行为：点击同一按钮再点＝收起；点另一处按钮＝换锚点重开（不残留）；点空白/按 Esc/窗口 resize 关闭；键盘与滚动监听随开关成对增删。

## 常用命令

```powershell
$NODE = 'C:\Users\33313\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'

& $NODE .\pack.cjs --dry-run   # 只构建并自检，不替换（安全）
& $NODE .\pack.cjs --apply     # 备份原 asar 后替换（需先完全退出墨记）
& $NODE .\restore.cjs --list   # 列出备份
& $NODE .\restore.cjs          # 还原到上一次替换前的备份（撤销最近的补丁）
& $NODE .\test-auto-pull.cjs   # 自动拉取逻辑单测（26 项）
& $NODE .\test-export-menu.cjs # 导出下拉菜单单测（29 项，vm + 迷你 DOM）
& $NODE .\test-fs-service.cjs  # 主进程文件服务单测（53 项，vm 加载 electron-main.cjs + 真实临时目录）
& $NODE .\test-fs-mirror.cjs   # 渲染层落盘逻辑单测（60 项，vm + mock Dexie/桥接）
& $NODE .\test-ai-panel.cjs    # AI 助手面板单测（114 项，vm + 迷你 DOM）
& $NODE .\test-backlinks.cjs   # 反向链接面板单测（11 项，vm + 迷你 DOM）

& $NODE .\tools\asar-marks.cjs               # 检查 app.asar 里 A/B/C/D 各补丁标记是否都在位
& $NODE .\tools\preview-patch.cjs --check    # 查看补丁锚点命中与替换内容
& $NODE .\tools\preview-patch.cjs --apply    # 把补丁应用到 preview 副本（浏览器里先看效果）
& $NODE .\tools\preview-patch.cjs --restore  # 还原 preview 副本
& $NODE .\tools\compare-bundle.cjs           # asar 与 preview 副本一致性 / 补丁标记检查
```

`pack.cjs` 的强制自检：注入前提（官方函数是否存在、是否重复打补丁）→ UI 补丁可应用性 → 语法 `node --check` → 新 asar 全量 integrity（5061 项）→ 替换文件内容一致性 → 未修改文件抽样字节比对。任一项失败即中止，不会碰原文件。

## 日志与验证

日志：`%APPDATA%\ink-notes\auto-pull.log`（每行一条 JSON）

| event | 含义 |
| --- | --- |
| `watch-start` / `unwatch` | 开始/停止监视，带 `dir` |
| `vault-changed` | 检测到变化，`count` 为文件数，`files` 为前 50 个路径 |
| `auto-pull` | 一次拉取完成：`reason`（`watch` / `startup` / `manual`）、`files`、`counts`（created/updated/unchanged/skipped/failed）、`ms` |

实测（2026-10-11 首次启用）：

```
watch-start dir=D:\TRAEWORK\个人知识库
vault-changed count=443                      ← 启动时目录事件合并
auto-pull reason=watch  files=443 counts={created:18, updated:17, unchanged:408} ms=3776
auto-pull reason=startup manifest=459 changed=69 batches=2
auto-pull reason=watch  files=1   counts={updated:1} ms=10   ← 改动单个笔记的实时拉取
```

在墨记里按 `Ctrl+Shift+I` 打开 DevTools，控制台可查：

```js
__inkAutoPull.status        // { dir, lastAt, created, updated, batches }
__inkAutoPull.manifest()    // 仓库清单（只 stat）
__inkAutoPull.pullNow()     // 立即手动触发一次
```

## 注意

- **导出菜单**：合并后的「导出」按钮点击后弹出小菜单（Markdown 文件 `.md` / Word 文档 `.docx`），两个格式的导出行为完全没变，只是入口合并了。
- **AI 助手面板是覆盖式抽屉**：墨记主界面是 `width:100%` 定宽布局，挤压会打乱工具栏，因此面板浮在右上（420px 宽）；`Esc` 旁的 ✕ 或 `Ctrl+Shift+A` 随时收起。
- **补丁顺序**：D 的工具栏锚点就是 B 的替换结果，`pack.cjs` 已强制 B → D 顺序；两者各自按标记去重，可分别跳过。
- **仅桌面客户端生效**：自动拉取依赖 `window.inkNotes`（Electron preload），浏览器里打开的 `preview` 版本没有该接口，会跳过补丁 A；补丁 B 是纯前端逻辑，preview 里也能看。
- **升级/重装墨记会覆盖 app.asar**，补丁随之失效；重新执行 `pack.cjs --apply` 即可（脚本会校验官方函数与锚点是否还在，版本不匹配会明确报错而不是静默出错）。
- 首次启用时若距上次同步较久，启动补拉会读较多文件（本仓库 459 个受支持文件中筛出 69 个），分 40 个/48MB 一批执行，日志可观察进度。
- 自动拉取只处理 `md / markdown / txt / pdf / docx`，跳过 `.obsidian`、`.git`、`.trash`、隐藏文件与临时文件，与官方「立即拉取」口径一致。

## 回退

```powershell
& $NODE .\restore.cjs        # 用最新的 app.asar.bak-auto-pull-* 还原，并把当前版本另存为 .patched-*
```

备份按时间递增，`restore.cjs` 取最新一个 → 即撤销最近一次补丁：

- `app.asar.bak-auto-pull-20261011092732`：官方原版（2026-09-19）
- `app.asar.bak-auto-pull-20261011093405`：只有补丁 A（自动拉取）的版本 —— 撤销补丁 B 就到这一版
