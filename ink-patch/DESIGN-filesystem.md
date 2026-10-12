# 补丁 C 设计：把墨记改造成「磁盘文件夹为唯一数据源」

目标：像 Obsidian 一样，**笔记就是磁盘上的 `.md` 文件**。墨记里新建/编辑实时落盘，
用 Obsidian 或任何编辑器直接改文件，改动回流墨记；重命名/移动同步文件位置；删除进 `.trash`。

## 一、为什么是这个架构

墨记（官方版）的真实结构（逆向结论，见「事实」一节）：

```
React UI ──> DAO 函数(k/ge/ve/Se/Ce/we/Te/ye/Ee) ──> Dexie 实例 ──> IndexedDB
                    (importVault chunk)              (同一实例导出给 index chunk)
```

要「不再用内部数据库」有两种做法：

| 做法 | 评价 |
| --- | --- |
| 换掉 Dexie 后端（假 IndexedDB → 文件） | 要复刻 Dexie 全部查询/索引/liveQuery 语义，工作量极大且脆弱 |
| **保留 Dexie 但降级为派生索引**（本项目采用） | 零侵入应用逻辑，磁盘是唯一真相源 |

采用后者后，**IndexedDB 的地位等同于 Obsidian 的 `.obsidian/` 缓存目录**：
它是索引与运行期内存态，丢了能重建，不是数据的家。用户感知上完全一致。

## 二、数据流（双向，带回环抑制）

```
                  ① 启动对账 / 文件变化监视（补丁 A：fs.watch → LG 增量合并）
   磁盘 vault  ──────────────────────────────────────────────>  IndexedDB
   （唯一真相源）                                                  （派生索引）
        ▲                                                             │
        └──────────────────────── ② Dexie 表钩子 → 防抖 flush → 落盘 ─┘
                                    （补丁 C：本设计）
```

**回环风险**：②写文件会产生 mtime 变化 → ①的 watcher 收到事件 → 回流入库 → 又触发② → 死循环。

三道防线：
1. **主进程自写抑制**：②写盘后登记 `rel → mtimeMs`，watcher 收到事件时 stat 比对，
   mtime 未变即判为自写并丢弃；`readVaultFiles` / `vaultManifest` 同样过滤（挡住启动补拉）。
2. **幂等写**：②落盘前先读现状，内容完全相同就**不写**，从源头不产生事件。
3. **LG 自身的内容比较**：即便漏进来，`contentChanged` 为 false 时不会改库。

## 三、路径身份：`srcPath` + `idmap`

纯「文件夹 + 标题」当身份不够用：vault 里 `A.md` 的 frontmatter 可能写着 `title: B`，
库里标题是 B，若按标题落盘会写出 `B.md`，于是同一篇笔记在磁盘上出现两份、下次对账变成两篇。

因此：
- **补丁 C 顺带给 `LG` 加一个字段 `srcPath`**（文件来源相对路径），无主笔记优先认领自己的 Node；
- `noteId → relPath` 映射持久化在 `<vault>/.ink-notes/idmap.json`（缓存，可重建）；
- `.ink-notes/` 以点开头，已被 watcher 与 LG 的忽略规则排除。

### 何时重命名文件

只在**墨记内部真的改了标题/移动了文件夹**时重命名（Dexie `updating` 钩子的 `mods` 里能看出
`title`/`folderId` 变了）。否则保持现有路径不动 —— 这样 `A.md`（frontmatter title=B）不会被反复改名。

### 冲突策略

目标路径已被别的笔记占用，或磁盘上存在**内容不同**的同名无主文件 → 退让为 `标题 (2).md`，
**绝不覆盖**不属于这份笔记的文件。

## 四、删除：进 `.trash`，不物理删

用户要求「保守」。但纯保守（文件留着不动）在双向同步下必然出 bug：文件还在 → 下次对账
把它当新笔记导回来 → 已删笔记复活。

所以采用 Obsidian 自己的做法：**墨记里删除笔记 → 文件移入 `<vault>/.trash/<名字> <时间戳>.md`**。
文件没丢（可手工恢复），且 `.trash` 在忽略列表里，不会回流。恢复笔记时按 idmap 写回原路径。

## 五、本期不做（明确边界）

- **PDF / Word 笔记**：它们的 `content` 是从原件提取的文本，落成 `.md` 会与原件混淆。
  本期跳过这两类笔记的落盘（原件本来就在 vault 里）。
- **云同步（WebDAV）**：仍然可用，它作用于派生索引；磁盘与索引一致时不会有额外变化。
- 附件 `files` 表的二进制（非 vault 来源的导入件）暂不导出到 vault。

## 六、关键事实（逆向取证，供后续维护）

| 事项 | 结论 |
| --- | --- |
| 数据库 | Dexie，库名 `ink-notes`，v5；表 `notes(id,updatedAt,folderId,*tags,deletedAt)`、`noteContent(noteId,content)`、`folders(id,name,parentId,updatedAt,deletedAt)`、`files(id,updatedAt,deletedAt)` |
| Dexie 实例 | `importVault-*.js` 内的 `O`，导出给 index chunk 后叫 `_`（`T as _`） |
| DAO | 同 chunk：`k`新建 / `ge`更新 / `ve`软删 / `Ee`物理删 / `Se`文件夹改名 / `Ce`移动 / `we`加标签 / `Te`恢复 / `ye`删文件夹 / `xe`清理 30 天前已删 |
| 拦截点 | **不用改 DAO**：在 index chunk 末尾给 `_` 挂 Dexie 表钩子即可覆盖所有写入路径 |
| 导入合并 | index chunk `LG(files)`：身份键 `${folderId??'__root__'}:${title.toLowerCase()}`；md 走 frontmatter 解析 |
| 配置 | localStorage：`ink-obsidian-vault-path`(NG/PG)、`ink-obsidian-auto-pull`(FG/IG)、`ink-obsidian-last-sync`(jG) |
| 导出格式 | 墨记导出 md = noteContent **原样**，不写 frontmatter；标题靠文件名 |
| 忽略规则 | 名称以 `.` 开头、`.obsidian`/`.git`/`.trash`/`.vscode`/`node_modules`/`$recycle.bin`，扩展名限 `md/markdown/txt/pdf/docx` |
| 构建 | 无 sourcemap；asar 头 16B + uint32 头长度 + JSON 树 + 4 字节对齐数据区；`pack.cjs` 改文件后追加到数据区末尾并重算 integrity |
