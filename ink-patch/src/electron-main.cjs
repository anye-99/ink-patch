// 墨记 InkNotes 主进程（补丁版 v1：新增「本机 Obsidian 变化 → 自动增量拉取」）
// 基线：安装目录 app.asar 内 electron/main.cjs（原样保留，仅新增带 [auto-pull] 标记的部分）
const { app, BrowserWindow, Menu, MenuItem, ipcMain, net, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

const isDev = !app.isPackaged;

// ===== [auto-pull] 与渲染层 readLocalVault 对齐的过滤口径 =====
const VAULT_IGNORED_NAMES = new Set(['.obsidian', '.git', '.trash', '.vscode', 'node_modules', '$recycle.bin']);
const VAULT_SUPPORTED_EXTS = new Set(['.md', '.markdown', '.txt', '.pdf', '.docx']);
const VAULT_DEBOUNCE_MS = 2500;

// ===== [fs-mirror] 「磁盘文件夹为唯一数据源」补丁：常量与自写抑制 =====
// 目的：让「墨记自己落盘」产生的文件事件不再被 watcher 当成外部变化读回来，
//       否则会形成「写文件 → watcher → 拉回库 → 又写」的死循环。
const FS_META_DIRNAME = '.ink-notes'; // 库内元数据目录（以点开头，已被忽略规则排除）
const FS_TRASH_DIRNAME = '.trash'; // 回收站，与 Obsidian 习惯一致
const FS_SELF_WRITE_TTL_MS = 15000; // 自写记录存活窗口
const FS_SELF_WRITE_TOLERANCE_MS = 5; // mtime 比对容差（文件系统时间精度）
const fsSelfWrites = new Map(); // rel -> { mtimeMs, at }

function fsNormRel(rel) {
  return String(rel).split('\\').join('/').replace(/^\.\//, '');
}

function fsMarkSelfWrite(rel, mtimeMs) {
  const key = fsNormRel(rel);
  if (!key) return;
  fsSelfWrites.set(key, { mtimeMs, at: Date.now() });
  if (fsSelfWrites.size > 4000) {
    const cutoff = Date.now() - FS_SELF_WRITE_TTL_MS;
    for (const [k, v] of fsSelfWrites) {
      if (v.at < cutoff) fsSelfWrites.delete(k);
    }
  }
}

// 判定某个相对路径的文件事件是否由本应用自己落盘引起
function fsIsSelfWrite(rel, vaultDir) {
  const key = fsNormRel(rel);
  const rec = fsSelfWrites.get(key);
  if (!rec) return false;
  if (Date.now() - rec.at > FS_SELF_WRITE_TTL_MS) {
    fsSelfWrites.delete(key);
    return false;
  }
  try {
    const st = fs.statSync(path.join(vaultDir, ...key.split('/')));
    if (!st.isFile()) return true;
    return Math.abs(st.mtimeMs - rec.mtimeMs) <= FS_SELF_WRITE_TOLERANCE_MS;
  } catch {
    // 文件已不在（被改名或回收）：本次事件仍算自写
    return true;
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 920,
    minHeight: 600,
    title: '墨记 InkNotes',
    backgroundColor: '#f2f4f8',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // 生产环境去掉原生菜单栏
  if (app.isPackaged) {
    Menu.setApplicationMenu(null);
  }

  // 注入标准右键上下文菜单（剪切、复制、粘贴、全选，保障用户剪贴板操作习惯）
  win.webContents.on('context-menu', (_event, params) => {
    const menu = new Menu();
    if (params.isEditable) {
      menu.append(new MenuItem({ label: '剪切', role: 'cut' }));
      menu.append(new MenuItem({ label: '复制', role: 'copy' }));
      menu.append(new MenuItem({ label: '粘贴', role: 'paste' }));
      menu.append(new MenuItem({ type: 'separator' }));
      menu.append(new MenuItem({ label: '全选', role: 'selectAll' }));
      menu.popup({ window: win });
    } else if (params.selectionText && params.selectionText.trim().length > 0) {
      menu.append(new MenuItem({ label: '复制', role: 'copy' }));
      menu.append(new MenuItem({ label: '全选', role: 'selectAll' }));
      menu.popup({ window: win });
    }
  });

  // 拦截外部链接，使用系统默认浏览器打开，防止覆盖应用主窗口
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    const isInternal = isDev
      ? url.startsWith(process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173')
      : url.startsWith('file://');
    if (!isInternal) {
      event.preventDefault();
      if (url.startsWith('http://') || url.startsWith('https://')) {
        void shell.openExternal(url);
      }
    }
  });

  if (isDev) {
    // 开发模式：在 .env 或默认地址上连 Vite dev server
    const devUrl = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173';
    win.loadURL(devUrl);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

app.whenReady().then(() => {
  createWindow();

  // WebDAV 代理：主进程 net.fetch 不受 CORS 限制，坚果云等 DAV 服务不返回 CORS 头
  ipcMain.handle('ink:dav-request', async (_event, req) => {
    const { method, url, headers, body } = req;
    try {
      const res = await net.fetch(url, {
        method,
        headers,
        body: body ? Buffer.from(body) : undefined,
      });
      const headersObj = {};
      res.headers.forEach((value, key) => {
        headersObj[key.toLowerCase()] = value;
      });
      const buf = await res.arrayBuffer();
      return {
        status: res.status,
        headers: headersObj,
        body: buf.byteLength > 0 ? new Uint8Array(buf) : null,
      };
    } catch (err) {
      // 网络不可达时返回 status 0，让渲染进程按普通失败处理，避免主进程抛出未捕获异常
      return {
        status: 0,
        headers: {},
        body: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  // 选择本地 Obsidian 仓库目录
  ipcMain.handle('ink:select-vault-dir', async () => {
    const res = await dialog.showOpenDialog({
      title: '选择本地 Obsidian 仓库文件夹',
      properties: ['openDirectory'],
    });
    if (res.canceled || !res.filePaths || res.filePaths.length === 0) {
      return null;
    }
    return res.filePaths[0];
  });

  // 递归读取本地 Obsidian 仓库的所有笔记与支持的文件
  ipcMain.handle('ink:read-local-vault', async (_event, vaultPath) => {
    if (!vaultPath || !fs.existsSync(vaultPath)) {
      throw new Error('指定的本地 Obsidian 仓库路径不存在');
    }

    const items = [];
    const IGNORED_NAMES = new Set(['.obsidian', '.git', '.trash', '.vscode', 'node_modules', '$recycle.bin']);
    const SUPPORTED_EXTS = new Set(['.md', '.markdown', '.txt', '.pdf', '.docx']);

    async function walk(currentDir, relDir) {
      const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
      for (const ent of entries) {
        const lowerName = ent.name.toLowerCase();
        if (IGNORED_NAMES.has(lowerName) || ent.name.startsWith('.')) continue;
        const full = path.join(currentDir, ent.name);
        if (ent.isDirectory()) {
          const nextRel = relDir ? `${relDir}/${ent.name}` : ent.name;
          await walk(full, nextRel);
        } else if (ent.isFile()) {
          const ext = path.extname(ent.name).toLowerCase();
          if (!SUPPORTED_EXTS.has(ext)) continue;
          try {
            const stat = await fs.promises.stat(full);
            const buf = await fs.promises.readFile(full);
            items.push({
              dirPath: relDir,
              name: ent.name,
              lastModified: stat.mtimeMs,
              data: buf,
            });
          } catch (e) {
            console.warn('读取本地仓库文件失败:', full, e);
          }
        }
      }
    }

    await walk(vaultPath, '');
    return items;
  });

  // ==================== [auto-pull] 自动拉取补丁开始 ====================
  // 思路：主进程 fs.watch 监视仓库 → 只把「变化的相对路径」推给渲染层
  //       → 渲染层只读这些文件并走原有的增量合并（LG），无需全量读仓库。
  let vaultWatcher = null;
  let vaultFlushTimer = null;
  const vaultPending = new Set();
  let vaultWatchedDir = null;

  const AUTO_PULL_LOG = path.join(app.getPath('userData'), 'auto-pull.log');

  function logAutoPull(entry) {
    try {
      fs.appendFileSync(AUTO_PULL_LOG, JSON.stringify({ at: Date.now(), ...entry }) + '\n', 'utf8');
    } catch (err) {
      console.warn('[auto-pull] 写日志失败:', err);
    }
  }

  function normalizeRel(rel) {
    return String(rel).split('\\').join('/');
  }

  function isRelevantRel(rel) {
    if (!rel || rel.endsWith('/')) return false;
    for (const seg of rel.split('/')) {
      if (!seg) continue;
      if (seg.startsWith('.')) return false;
      if (VAULT_IGNORED_NAMES.has(seg.toLowerCase())) return false;
    }
    return VAULT_SUPPORTED_EXTS.has(path.extname(rel).toLowerCase());
  }

  function closeVaultWatcher() {
    if (vaultWatcher) {
      try {
        vaultWatcher.close();
      } catch (err) {
        console.warn('[auto-pull] 关闭监视失败:', err);
      }
      vaultWatcher = null;
    }
    if (vaultFlushTimer) {
      clearTimeout(vaultFlushTimer);
      vaultFlushTimer = null;
    }
    vaultPending.clear();
    vaultWatchedDir = null;
    logAutoPull({ event: 'unwatch' });
  }

  function flushVaultChanges() {
    vaultFlushTimer = null;
    const dir = vaultWatchedDir;
    if (!dir) return;
    const rels = [];
    for (const rel of vaultPending) {
      // 过滤 1：本应用自己刚落盘的文件不回流（补丁 C 的回环保卫）
      if (fsIsSelfWrite(rel, dir)) continue;
      // 过滤 2：仅保留仍然存在且有内容的受支持文件（Obsidian 同步时会产生大量临时文件）
      try {
        const full = path.join(dir, ...rel.split('/'));
        const st = fs.statSync(full);
        if (!st.isFile() || st.size === 0) continue;
      } catch {
        continue;
      }
      rels.push(rel);
    }
    vaultPending.clear();
    if (rels.length === 0) return;
    logAutoPull({ event: 'vault-changed', dir, files: rels.slice(0, 50), count: rels.length });
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.isDestroyed()) continue;
      w.webContents.send('ink:vault-changed', { dir, files: rels });
    }
  }

  function scheduleVaultFlush() {
    if (vaultFlushTimer) clearTimeout(vaultFlushTimer);
    vaultFlushTimer = setTimeout(flushVaultChanges, VAULT_DEBOUNCE_MS);
  }

  // 开始监视本机 Obsidian 仓库
  ipcMain.handle('ink:watch-vault', async (_event, vaultPath) => {
    closeVaultWatcher();
    if (!vaultPath || typeof vaultPath !== 'string') {
      return { ok: false, reason: 'empty-path' };
    }
    if (!fs.existsSync(vaultPath)) {
      logAutoPull({ event: 'watch-failed', dir: vaultPath, reason: 'not-found' });
      return { ok: false, reason: 'not-found' };
    }
    try {
      vaultWatchedDir = vaultPath;
      vaultWatcher = fs.watch(vaultPath, { recursive: true }, (_eventType, filename) => {
        if (!filename) return; // 无法判定具体文件时忽略，避免退化为全量拉取
        const rel = normalizeRel(filename);
        if (!isRelevantRel(rel)) return;
        vaultPending.add(rel);
        scheduleVaultFlush();
      });
      vaultWatcher.on('error', (err) => {
        console.warn('[auto-pull] 监视出错:', err);
        logAutoPull({ event: 'watch-error', dir: vaultPath, error: err instanceof Error ? err.message : String(err) });
        closeVaultWatcher();
      });
      logAutoPull({ event: 'watch-start', dir: vaultPath });
      return { ok: true, dir: vaultPath };
    } catch (err) {
      logAutoPull({ event: 'watch-failed', dir: vaultPath, error: err instanceof Error ? err.message : String(err) });
      closeVaultWatcher();
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('ink:unwatch-vault', async () => {
    closeVaultWatcher();
    return { ok: true };
  });

  // 只读取指定文件的清单（渲染层自动拉取用，避免全量读取整个仓库）
  ipcMain.handle('ink:read-vault-files', async (_event, vaultPath, relPaths) => {
    if (!vaultPath || typeof vaultPath !== 'string' || !Array.isArray(relPaths)) return [];
    const out = [];
    for (const relRaw of relPaths) {
      if (typeof relRaw !== 'string' || !relRaw) continue;
      const rel = normalizeRel(relRaw);
      if (rel.includes('..')) continue; // 防路径穿越
      if (!isRelevantRel(rel)) continue;
      if (fsIsSelfWrite(rel, vaultPath)) continue; // 本应用自己刚写的文件无需回流
      const full = path.join(vaultPath, ...rel.split('/'));
      try {
        const stat = await fs.promises.stat(full);
        if (!stat.isFile()) continue;
        const buf = await fs.promises.readFile(full);
        const slash = rel.lastIndexOf('/');
        out.push({
          dirPath: slash >= 0 ? rel.slice(0, slash) : '',
          name: slash >= 0 ? rel.slice(slash + 1) : rel,
          lastModified: stat.mtimeMs,
          data: buf,
        });
      } catch {
        // 文件在事件与读取之间被删除/占用时静默跳过
      }
    }
    return out;
  });

  // 仓库清单（只 stat 不读内容，供「启动时补拉」筛选出比上次同步更新的文件）
  ipcMain.handle('ink:vault-manifest', async (_event, vaultPath) => {
    if (!vaultPath || typeof vaultPath !== 'string' || !fs.existsSync(vaultPath)) return [];
    const out = [];
    async function walk(currentDir, relDir) {
      let entries;
      try {
        entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of entries) {
        const lowerName = ent.name.toLowerCase();
        if (VAULT_IGNORED_NAMES.has(lowerName) || ent.name.startsWith('.')) continue;
        const full = path.join(currentDir, ent.name);
        if (ent.isDirectory()) {
          await walk(full, relDir ? `${relDir}/${ent.name}` : ent.name);
        } else if (ent.isFile()) {
          const ext = path.extname(ent.name).toLowerCase();
          if (!VAULT_SUPPORTED_EXTS.has(ext)) continue;
          const rel = relDir ? `${relDir}/${ent.name}` : ent.name;
          if (fsIsSelfWrite(rel, vaultPath)) continue; // 本应用自己刚写的文件无需回流
          try {
            const stat = await fs.promises.stat(full);
            out.push({
              rel,
              dirPath: relDir,
              name: ent.name,
              mtimeMs: stat.mtimeMs,
              size: stat.size,
            });
          } catch {
            // 忽略读取失败的文件
          }
        }
      }
    }
    await walk(vaultPath, '');
    return out;
  });

  // 渲染层上报自动拉取结果（便于排查：默认写入 %APPDATA%\ink-notes\auto-pull.log）
  ipcMain.handle('ink:auto-pull-log', async (_event, info) => {
    if (!info || typeof info !== 'object') return { ok: false };
    logAutoPull({ event: 'auto-pull', ...info });
    return { ok: true, log: AUTO_PULL_LOG };
  });
  // ==================== [auto-pull] 自动拉取补丁结束 ====================

  // ==================== [fs-mirror] 「磁盘文件夹为唯一数据源」补丁开始 ====================
  // 职责划分：渲染层负责算出「这篇笔记最终该长什么样」（标题、所在文件夹、正文），
  //          主进程负责把它变成库里的一个文件：分配稳定路径、建目录、写盘、改名、进回收站。
  // 路径身份：noteId → 库内相对路径，持久化在 <vault>/.ink-notes/idmap.json（派生缓存，丢了可重建）。

  const FS_LOG = path.join(app.getPath('userData'), 'fs-mirror.log');

  function logFsMirror(entry) {
    try {
      fs.appendFileSync(FS_LOG, JSON.stringify({ at: Date.now(), ...entry }) + '\n', 'utf8');
    } catch (err) {
      console.warn('[fs-mirror] 写日志失败:', err);
    }
  }

  const fsIdMaps = new Map(); // vaultDir -> Map(noteId -> relPath)

  function fsMetaDir(vaultDir) {
    return path.join(vaultDir, FS_META_DIRNAME);
  }

  function fsIdMapFile(vaultDir) {
    return path.join(fsMetaDir(vaultDir), 'idmap.json');
  }

  function fsLoadIdMap(vaultDir) {
    const cached = fsIdMaps.get(vaultDir);
    if (cached) return cached;
    const map = new Map();
    try {
      const obj = JSON.parse(fs.readFileSync(fsIdMapFile(vaultDir), 'utf8'));
      if (obj && obj.notes && typeof obj.notes === 'object') {
        for (const [id, rel] of Object.entries(obj.notes)) {
          if (typeof rel === 'string' && rel) map.set(id, fsNormRel(rel));
        }
      }
    } catch {
      // 首次运行或文件损坏：从空表开始，靠内容比对重新认领已有文件
    }
    fsIdMaps.set(vaultDir, map);
    return map;
  }

  function fsSaveIdMap(vaultDir, map) {
    try {
      fs.mkdirSync(fsMetaDir(vaultDir), { recursive: true });
      const obj = {
        app: 'ink-notes',
        kind: 'fs-mirror-idmap',
        version: 1,
        vault: vaultDir,
        updatedAt: Date.now(),
        notes: Object.fromEntries(map),
      };
      fs.writeFileSync(fsIdMapFile(vaultDir), JSON.stringify(obj, null, 2), 'utf8');
    } catch (err) {
      console.warn('[fs-mirror] 保存 idmap 失败:', err);
    }
  }

  // Windows 文件名非法字符 / 控制字符 / 结尾点空格 / 设备保留名
  const FS_ILLEGAL_CHARS = /[\\/:*?"<>|]/g;
  const FS_CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;
  const FS_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

  function fsSanitizeSegment(name) {
    let s = String(name == null ? '' : name)
      .replace(FS_ILLEGAL_CHARS, '_')
      .replace(FS_CONTROL_CHARS, '')
      .replace(/\s+/g, ' ')
      .trim();
    s = s.replace(/[. ]+$/, '');
    if (!s) s = '未命名';
    if (s.length > 120) s = s.slice(0, 120).replace(/[. ]+$/, '') || '未命名';
    if (FS_RESERVED_NAMES.test(s)) s = '_' + s;
    return s;
  }

  function fsSanitizeDirPath(dirPath) {
    if (!dirPath) return '';
    return String(dirPath)
      .split('/')
      .map((seg) => String(seg == null ? '' : seg).trim())
      .filter(Boolean)
      .map(fsSanitizeSegment)
      .join('/');
  }

  function fsJoinRel(dir, fileName) {
    return dir ? dir + '/' + fileName : fileName;
  }

  function fsAbs(vaultDir, rel) {
    return path.join(vaultDir, ...fsNormRel(rel).split('/'));
  }

  function fsTakenSet(map, exceptId) {
    const taken = new Set();
    for (const [id, rel] of map) {
      if (id === exceptId) continue;
      taken.add(fsNormRel(rel).toLowerCase());
    }
    return taken;
  }

  async function fsExistsFile(full) {
    try {
      const st = await fs.promises.stat(full);
      return st.isFile();
    } catch {
      return false;
    }
  }

  async function fsReadTextIfExists(full) {
    try {
      return await fs.promises.readFile(full, 'utf8');
    } catch {
      return null;
    }
  }

  // 拆分 YAML frontmatter。
  // 背景：墨记导入 md 时只把**正文**存进库（frontmatter 里的 tags/aliases 等不入库），
  // 所以「文件内容 vs 库内容」必须按正文比较；写回时也要保留文件原有的 frontmatter，
  // 否则会把用户在 Obsidian 里维护的元数据整段抹掉（实测踩过：23 个文件的 tags 被清空）。
  function fsSplitFrontmatter(text) {
    const s = String(text == null ? '' : text).replace(/^\uFEFF/, '');
    if (!s.startsWith('---')) return { head: '', body: s };
    const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/.exec(s);
    if (!m) return { head: '', body: s };
    return { head: s.slice(0, m[0].length), body: s.slice(m[0].length) };
  }

  function fsNormalizeBody(text) {
    return String(text == null ? '' : text)
      .replace(/^\uFEFF/, '')
      .replace(/\r\n/g, '\n')
      .trim();
  }

  // 磁盘文件的正文是否就是库里的这份正文（忽略 frontmatter 与行尾差异）
  function fsBodyEqual(fileText, content) {
    return fsNormalizeBody(fsSplitFrontmatter(fileText).body) === fsNormalizeBody(content);
  }

  // 计算这篇笔记该落到哪个相对路径：目标名 = 净化标题 + 扩展名，目标目录 = 净化后的文件夹链。
  // 被别的笔记占用、或磁盘上已存在内容不同的同名文件时，退让为「标题 (2).md」…，
  // 绝不覆盖不属于这篇笔记的文件；内容完全一致则视为同一篇笔记的旧文件并认领。
  async function fsResolveRel(vaultDir, map, noteId, dirPath, title, content, ext) {
    const dir = fsSanitizeDirPath(dirPath);
    const base = fsSanitizeSegment(title || '未命名笔记');
    const taken = fsTakenSet(map, noteId);
    const cur = map.get(noteId) || null;
    for (let n = 1; n <= 999; n += 1) {
      const rel = fsJoinRel(dir, (n === 1 ? base : `${base} (${n})`) + ext);
      const full = fsAbs(vaultDir, rel);
      const exists = await fsExistsFile(full);
      if (exists) {
        const existing = await fsReadTextIfExists(full);
        // 关键顺序：先判断「磁盘上这份内容是不是就是我要写的内容」。
        // 墨记库里存在同目录同标题的重复笔记（历史导入造成），它们内容完全相同，应当**共用同一个文件**。
        // 若先按「路径已被别的笔记占用」让位，就会写出「标题 (2).md」这种副本，
        // 而这种文件名一旦回流，又会被官方合并逻辑当成一篇叫「标题 (2)」的新笔记，把重复放大。
        if (existing !== null && fsBodyEqual(existing, content)) return { rel, previous: cur };
      }
      if (taken.has(rel.toLowerCase())) continue; // 被别的笔记占用且内容不同 → 换位置
      if (!exists) return { rel, previous: cur };
    }
    return { rel: fsJoinRel(dir, `${base} ${Date.now()}${ext}`), previous: cur };
  }

  async function fsWriteNote(vaultDir, map, item, planOnly) {
    const ext = typeof item.ext === 'string' && item.ext.startsWith('.') ? item.ext : '.md';
    const content = typeof item.content === 'string' ? item.content : '';
    const cur = map.get(item.id) ? fsNormRel(map.get(item.id)) : null;
    let rel = null;
    let previous = cur;

    if (!item.rename) {
      // (1) 文件夹改名/移动：目录跟着变，但文件名保持不变（避免把 frontmatter 标题与文件名不同的笔记改成标题名）
      if (item.keepName && cur) {
        const carried = fsJoinRel(fsSanitizeDirPath(item.dirPath), cur.split('/').pop());
        if (!fsTakenSet(map, item.id).has(carried.toLowerCase())) {
          const carriedFull = fsAbs(vaultDir, carried);
          if (!(await fsExistsFile(carriedFull))) rel = carried;
          else {
            const carriedText = await fsReadTextIfExists(carriedFull);
            if (carriedText !== null && fsBodyEqual(carriedText, content)) rel = carried;
          }
        }
      }
      // (2) 没改名也没挪文件夹：沿用已归属的路径
      if (!rel && cur) rel = cur;
      // (3) 认领它当初的来源文件
      if (!rel && typeof item.srcPath === 'string' && item.srcPath && (await fsExistsFile(fsAbs(vaultDir, item.srcPath)))) {
        rel = fsNormRel(item.srcPath);
      }
    }
    if (!rel) {
      const resolved = await fsResolveRel(vaultDir, map, item.id, item.dirPath, item.title, content, ext);
      rel = resolved.rel;
      previous = resolved.previous;
    }

    const full = fsAbs(vaultDir, rel);
    const existing = await fsReadTextIfExists(full);
    const movedTarget = previous && previous.toLowerCase() !== rel.toLowerCase() ? previous : null;
    // 磁盘是唯一数据源：这篇笔记原本已经落过盘（有归属记录），而那个文件现在不在磁盘上了，
    // 说明是用户在磁盘侧删掉了它（在 Obsidian 里删除、同步软件删除等）。
    // 必须尊重这个删除——否则用户永远删不掉文件：删了下一次启动又会把它「复活」。
    if (!item.rename && previous && fsNormRel(previous).toLowerCase() === rel.toLowerCase() && existing === null) {
      return { id: item.id, ok: true, skipped: true, reason: 'deleted-on-disk', rel };
    }
    // 正文一致就认为这篇笔记已经在磁盘上了（哪怕文件还带着 frontmatter 等额外元数据）
    const bodySame = existing !== null && fsBodyEqual(existing, content);
    // 写回时保留文件原有的 YAML frontmatter（Obsidian 的 tags / aliases 等都在里面）
    const head = existing !== null ? fsSplitFrontmatter(existing).head : '';
    const payload = head ? head + content : content;
    if (planOnly) {
      // 预演：只算不写。首次对账前用它判断「会不会在你已有的知识库里刷出一堆重复文件」。
      return {
        id: item.id,
        ok: true,
        rel,
        previous: previous || null,
        plan: existing === null ? 'create' : bodySame ? 'adopt' : 'overwrite',
        move: movedTarget,
        wrote: false,
      };
    }
    let wrote = false;
    if (!bodySame) {
      await fs.promises.mkdir(path.dirname(full), { recursive: true });
      await fs.promises.writeFile(full, payload, 'utf8');
      wrote = true;
      try {
        const st = await fs.promises.stat(full);
        fsMarkSelfWrite(rel, st.mtimeMs);
      } catch {
        /* 登记失败只影响回环抑制，不影响数据 */
      }
    }

    let movedFrom = null;
    if (previous && previous.toLowerCase() !== rel.toLowerCase()) {
      try {
        await fs.promises.unlink(fsAbs(vaultDir, previous));
        fsMarkSelfWrite(previous, 0);
        movedFrom = previous;
      } catch {
        // 旧文件已不在（用户手工删过）：无妨
      }
    }

    map.set(item.id, rel);
    return { id: item.id, ok: true, rel, wrote, movedFrom };
  }

  // 删除走回收站，不物理删除：文件还在（可手工找回），而 .trash 在忽略列表里不会回流。
  async function fsTrashNote(vaultDir, map, noteId, planOnly) {
    const rel = map.get(noteId);
    if (!rel) return { id: noteId, ok: true, skipped: true };
    const full = fsAbs(vaultDir, rel);
    if (!(await fsExistsFile(full))) return { id: noteId, ok: true, skipped: true, rel };
    if (planOnly) return { id: noteId, ok: true, rel, plan: 'trash', wrote: false };
    const trashDir = path.join(vaultDir, FS_TRASH_DIRNAME);
    await fs.promises.mkdir(trashDir, { recursive: true });
    const baseName = path.basename(full);
    const ext = path.extname(baseName);
    const stem = baseName.slice(0, baseName.length - ext.length);
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    let target = path.join(trashDir, `${stem} ${stamp}${ext}`);
    let k = 1;
    while (fs.existsSync(target)) {
      target = path.join(trashDir, `${stem} ${stamp} (${k})${ext}`);
      k += 1;
    }
    await fs.promises.rename(full, target);
    fsMarkSelfWrite(rel, 0);
    fsMarkSelfWrite(`${FS_TRASH_DIRNAME}/${path.basename(target)}`, 0);
    return { id: noteId, ok: true, rel, trashed: `${FS_TRASH_DIRNAME}/${path.basename(target)}` };
  }

  // 批量落盘：渲染层一次 flush 推一批受影响笔记的最终状态
  // payload.dryRun=true 时只预演不写盘（首次对账的安全闸用），此时不落地 idmap。
  ipcMain.handle('ink:fs-apply', async (_event, payload) => {
    const vaultPath = payload && typeof payload.vaultPath === 'string' ? payload.vaultPath : null;
    const items = payload && Array.isArray(payload.items) ? payload.items : [];
    const planOnly = !!(payload && payload.dryRun);
    if (!vaultPath) return { ok: false, reason: 'no-vault' };
    if (!fs.existsSync(vaultPath)) return { ok: false, reason: 'vault-not-found' };
    if (items.length === 0) return { ok: true, results: [], count: 0, dryRun: planOnly };
    const map = fsLoadIdMap(vaultPath);
    const results = [];
    for (const item of items) {
      if (!item || typeof item.id !== 'string' || !item.id) continue;
      try {
        if (item.kind === 'trash') results.push(await fsTrashNote(vaultPath, map, item.id, planOnly));
        else results.push(await fsWriteNote(vaultPath, map, item, planOnly));
      } catch (err) {
        results.push({ id: item.id, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (!planOnly) fsSaveIdMap(vaultPath, map);
    const failed = results.filter((r) => r.ok === false);
    if (failed.length > 0) logFsMirror({ event: 'apply-failed', count: failed.length, sample: failed.slice(0, 5) });
    return { ok: true, results, count: results.length, dryRun: planOnly };
  });

  // 主进程侧的 noteId → 库内路径映射（排查用；也是「从磁盘完全重建」时的对照表）
  ipcMain.handle('ink:fs-idmap', async (_event, vaultPath) => {
    if (!vaultPath || typeof vaultPath !== 'string' || !fs.existsSync(vaultPath)) {
      return { ok: false, notes: {} };
    }
    const map = fsLoadIdMap(vaultPath);
    return { ok: true, count: map.size, notes: Object.fromEntries(map), file: fsIdMapFile(vaultPath) };
  });

  // 扫描库里已有的文本文件（相对路径 + 文件名主干 + frontmatter 里的 title）。
  // 渲染层用它把「磁盘上已经存在的原文件」认领给库里的笔记，避免同一篇笔记在库中出现两个文件。
  ipcMain.handle('ink:fs-scan', async (_event, vaultPath) => {
    if (!vaultPath || typeof vaultPath !== 'string' || !fs.existsSync(vaultPath)) return [];
    const out = [];
    async function walk(currentDir, relDir) {
      let entries;
      try {
        entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of entries) {
        const lowerName = ent.name.toLowerCase();
        if (VAULT_IGNORED_NAMES.has(lowerName) || ent.name.startsWith('.')) continue;
        const full = path.join(currentDir, ent.name);
        if (ent.isDirectory()) {
          await walk(full, relDir ? `${relDir}/${ent.name}` : ent.name);
          continue;
        }
        if (!ent.isFile()) continue;
        const ext = path.extname(ent.name).toLowerCase();
        if (ext !== '.md' && ext !== '.markdown' && ext !== '.txt') continue;
        const item = {
          rel: relDir ? `${relDir}/${ent.name}` : ent.name,
          stem: ent.name.slice(0, ent.name.length - ext.length),
          fmTitle: null,
        };
        try {
          // 只读文件开头 8KB：认领只需要 frontmatter 里的 title，
          // 整个大库（本机这个库 690+MB）挨个全读会把主进程内存吃光。
          const fh = await fs.promises.open(full, 'r');
          let head = '';
          try {
            const buf = Buffer.alloc(8192);
            const readRes = await fh.read(buf, 0, buf.length, 0);
            head = buf.slice(0, readRes.bytesRead).toString('utf8');
          } finally {
            await fh.close();
          }
          const fm = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(head);
          if (fm) {
            const titleLine = /^[ \t]*title[ \t]*:[ \t]*(.+?)[ \t]*$/m.exec(fm[1]);
            if (titleLine) item.fmTitle = titleLine[1].replace(/^["']|["']$/g, '').trim();
          }
        } catch {
          // 读不动就只按文件名匹配
        }
        out.push(item);
      }
    }
    await walk(vaultPath, '');
    return out;
  });

  // 写入初始「笔记 → 文件」认领表。仅在 idmap 还没有记录时生效，避免覆盖运行期已稳定的归属关系。
  ipcMain.handle('ink:fs-seed', async (_event, payload) => {
    const vaultPath = payload && typeof payload.vaultPath === 'string' ? payload.vaultPath : null;
    const entries = payload && Array.isArray(payload.entries) ? payload.entries : [];
    if (!vaultPath || !fs.existsSync(vaultPath)) return { ok: false, reason: 'vault-not-found' };
    const map = fsLoadIdMap(vaultPath);
    if (map.size > 0 && !(payload && payload.force)) {
      return { ok: true, skipped: true, count: map.size };
    }
    let seeded = 0;
    for (const pair of entries) {
      if (!Array.isArray(pair) || pair.length < 2) continue;
      const id = pair[0];
      const rel = pair[1];
      if (typeof id !== 'string' || !id || typeof rel !== 'string' || !rel) continue;
      if (rel.includes('..')) continue;
      if (map.has(id)) continue;
      map.set(id, fsNormRel(rel));
      seeded += 1;
    }
    fsSaveIdMap(vaultPath, map);
    logFsMirror({ event: 'seed', dir: vaultPath, seeded, total: map.size });
    return { ok: true, seeded, count: map.size };
  });

  // 渲染层上报落盘结果（写入 %APPDATA%\ink-notes\fs-mirror.log）
  ipcMain.handle('ink:fs-log', async (_event, info) => {
    if (!info || typeof info !== 'object') return { ok: false };
    logFsMirror({ event: 'renderer', ...info });
    return { ok: true, log: FS_LOG };
  });
  // ==================== [fs-mirror] 「磁盘文件夹为唯一数据源」补丁结束 ====================

  // ==================== [ai-assistant] AI 助手侧边栏补丁开始 ====================
  // 渲染层不直接发请求：一是 CORS（多数服务不返回 CORS 头），二是 Key 由主进程统一管理。
  // 配置放 userData/ai-config.json；流式增量通过 webContents.send('ink:ai-chunk') 推回渲染层。
  const AI_CONFIG_FILE = path.join(app.getPath('userData'), 'ai-config.json');
  const AI_LOG_FILE = path.join(app.getPath('userData'), 'ai-assistant.log');
  const AI_TIMEOUT_MS = 5 * 60 * 1000;
  const aiRequests = new Map(); // requestId -> AbortController

  function logAi(entry) {
    try {
      fs.appendFileSync(AI_LOG_FILE, JSON.stringify({ at: Date.now(), ...entry }) + '\n', 'utf8');
    } catch (err) {
      console.warn('[ai-assistant] 写日志失败:', err);
    }
  }

  function extractAiDelta(block) {
    const lines = String(block || '').replace(/\r\n/g, '\n').split('\n');
    let out = '';
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith(':') || !line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const json = JSON.parse(payload);
        const choice = json && json.choices && json.choices[0];
        if (!choice) continue;
        const delta =
          (choice.delta && choice.delta.content) ||
          (choice.message && choice.message.content) ||
          (typeof choice.text === 'string' ? choice.text : '');
        if (delta) out += String(delta);
      } catch {
        // 心跳或非 JSON 数据行忽略
      }
    }
    return out;
  }

  ipcMain.handle('ink:ai-config-get', async () => {
    try {
      if (!fs.existsSync(AI_CONFIG_FILE)) return null;
      return JSON.parse(fs.readFileSync(AI_CONFIG_FILE, 'utf8'));
    } catch (err) {
      logAi({ event: 'config-read-failed', error: String((err && err.message) || err) });
      return null;
    }
  });

  ipcMain.handle('ink:ai-config-save', async (_event, cfg) => {
    try {
      fs.mkdirSync(path.dirname(AI_CONFIG_FILE), { recursive: true });
      fs.writeFileSync(AI_CONFIG_FILE, JSON.stringify(cfg || {}, null, 2), 'utf8');
      return { ok: true, path: AI_CONFIG_FILE };
    } catch (err) {
      logAi({ event: 'config-save-failed', error: String((err && err.message) || err) });
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  ipcMain.handle('ink:ai-abort', async (_event, requestId) => {
    const ctrl = aiRequests.get(requestId);
    if (!ctrl) return { ok: false };
    try {
      ctrl.abort();
    } catch {
      // ignore
    }
    aiRequests.delete(requestId);
    return { ok: true };
  });

  ipcMain.handle('ink:ai-chat', async (event, req) => {
    const requestId = (req && req.requestId) || 'unknown';
    const url = req && req.url;
    if (!url) return { ok: false, error: '缺少请求地址（Base URL 未填？）' };
    const ctrl = new AbortController();
    aiRequests.set(requestId, ctrl);
    const timer = setTimeout(() => {
      try {
        ctrl.abort();
      } catch {
        // ignore
      }
    }, AI_TIMEOUT_MS);
    const started = Date.now();
    let text = '';
    try {
      const res = await net.fetch(url, {
        method: 'POST',
        headers: req.headers || {},
        body: req.body,
        signal: ctrl.signal,
      });
      if (!res.ok) {
        let detail = '';
        try {
          detail = (await res.text()).slice(0, 400);
        } catch {
          // ignore
        }
        logAi({ event: 'ai-chat', requestId, status: res.status, ms: Date.now() - started, error: detail });
        return { ok: false, error: 'HTTP ' + res.status + '：' + (detail || '请求被拒绝') };
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        buffer = buffer.replace(/\r\n/g, '\n');
        let idx;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const delta = extractAiDelta(block);
          if (delta) {
            text += delta;
            try {
              event.sender.send('ink:ai-chunk', { requestId, delta });
            } catch {
              // 窗口已关闭
            }
          }
        }
      }
      if (buffer.trim()) {
        const delta = extractAiDelta(buffer);
        if (delta) {
          text += delta;
          try {
            event.sender.send('ink:ai-chunk', { requestId, delta });
          } catch {
            // ignore
          }
        }
      }
      logAi({ event: 'ai-chat', requestId, ok: true, chars: text.length, ms: Date.now() - started });
      return { ok: true, text };
    } catch (err) {
      const message = String((err && err.message) || err);
      const aborted = Boolean(ctrl.signal && ctrl.signal.aborted) || /abort/i.test(message);
      logAi({
        event: 'ai-chat',
        requestId,
        ok: false,
        aborted,
        chars: text.length,
        ms: Date.now() - started,
        error: message.slice(0, 300),
      });
      return { ok: false, aborted, error: aborted ? '已中止' : message };
    } finally {
      clearTimeout(timer);
      aiRequests.delete(requestId);
    }
  });
  // ==================== [ai-assistant] AI 助手侧边栏补丁结束 ====================

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
