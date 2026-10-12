// 预加载脚本：contextIsolation 下唯一的应用原生能力入口
// 补丁版 v3：v1 自动拉取（监视/按需读取）+ v2 文件优先（落盘/改名/回收站）+ v3 AI 助手（配置读写/流式代理）
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('inkNotes', {
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
  // WebDAV 请求走主进程代理，绕过渲染进程的 CORS 限制
  davRequest: (req) => ipcRenderer.invoke('ink:dav-request', req),
  // 选择本地 Obsidian 仓库目录
  selectVaultDir: () => ipcRenderer.invoke('ink:select-vault-dir'),
  // 读取本地 Obsidian 仓库文件
  readLocalVault: (vaultPath) => ipcRenderer.invoke('ink:read-local-vault', vaultPath),

  // ===== [auto-pull] 自动拉取补丁开始 =====
  // 开始 / 停止监视本地 Obsidian 仓库变化
  watchVault: (vaultPath) => ipcRenderer.invoke('ink:watch-vault', vaultPath),
  unwatchVault: () => ipcRenderer.invoke('ink:unwatch-vault'),
  // 只读取变化的那几个文件（避免全量读取整个仓库）
  readVaultFiles: (vaultPath, relPaths) => ipcRenderer.invoke('ink:read-vault-files', vaultPath, relPaths),
  // 仓库清单（只含 mtime / 大小，不读内容），供启动时补拉筛选
  vaultManifest: (vaultPath) => ipcRenderer.invoke('ink:vault-manifest', vaultPath),
  // 订阅「仓库发生变化」事件（主进程已做 2.5s 防抖合并）
  onVaultChanged: (cb) => {
    if (typeof cb !== 'function') return false;
    ipcRenderer.on('ink:vault-changed', (_event, payload) => {
      try {
        cb(payload);
      } catch (err) {
        console.warn('[auto-pull] 处理变化事件失败:', err);
      }
    });
    return true;
  },
  offVaultChanged: () => {
    ipcRenderer.removeAllListeners('ink:vault-changed');
    return true;
  },
  // 上报自动拉取结果（主进程写入 auto-pull.log）
  logAutoPull: (info) => ipcRenderer.invoke('ink:auto-pull-log', info),
  // ===== [auto-pull] 自动拉取补丁结束 =====

  // ===== [fs-mirror] 「磁盘文件夹为唯一数据源」补丁开始 =====
  // 把一批受影响笔记的最终状态交给主进程落盘（分配路径 / 写文件 / 改名 / 进回收站）
  fsApply: (payload) => ipcRenderer.invoke('ink:fs-apply', payload),
  // noteId → 库内相对路径映射（排查与「从磁盘完全重建」用）
  fsIdMap: (vaultPath) => ipcRenderer.invoke('ink:fs-idmap', vaultPath),
  // 扫描库里已有文本文件（相对路径 + 文件名主干 + frontmatter title），用于认领原文件
  fsScan: (vaultPath) => ipcRenderer.invoke('ink:fs-scan', vaultPath),
  // 写入初始「笔记 → 文件」认领表（仅在还没有归属记录时生效）
  fsSeed: (payload) => ipcRenderer.invoke('ink:fs-seed', payload),
  // 上报落盘结果（主进程写入 fs-mirror.log）
  logFsMirror: (info) => ipcRenderer.invoke('ink:fs-log', info),
  // ===== [fs-mirror] 文件优先补丁结束 =====

  // ===== [ai-assistant] AI 助手侧边栏补丁开始 =====
  // API 配置读写（落在 <userData>/ai-config.json，Key 为明文，仅存本机）
  getAiConfig: () => ipcRenderer.invoke('ink:ai-config-get'),
  saveAiConfig: (cfg) => ipcRenderer.invoke('ink:ai-config-save', cfg),
  // 发起一次流式对话：主进程 net.fetch 代理（不受 CORS 限制），增量经 ink:ai-chunk 推回
  aiChat: (req) => ipcRenderer.invoke('ink:ai-chat', req),
  aiAbort: (requestId) => ipcRenderer.invoke('ink:ai-abort', requestId),
  onAiChunk: (cb) => {
    if (typeof cb !== 'function') return false;
    ipcRenderer.on('ink:ai-chunk', (_event, payload) => {
      try {
        cb(payload);
      } catch (err) {
        console.warn('[ai-assistant] 处理流式数据失败:', err);
      }
    });
    return true;
  },
  offAiChunk: () => {
    ipcRenderer.removeAllListeners('ink:ai-chunk');
    return true;
  },
  // ===== [ai-assistant] AI 助手侧边栏补丁结束 =====
});
