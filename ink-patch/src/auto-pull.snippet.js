/* ===== 墨记自动拉取补丁 v1 =====
 * 追加到 dist/assets/index-*.js 末尾，与官方代码同处一个模块作用域，
 * 因此可以直接复用官方已有的 NG()（读仓库目录）、FG()（自动拉取开关）、LG()（增量合并）、RG()（全量拉取）。
 * 行为：
 *   1) 监视本机 Obsidian 仓库，变化后只读「变化的文件」并增量合并（不全量读仓库）；
 *   2) 启动 6 秒后按 mtime 与上次同步时间做一次补拉，覆盖「墨记关闭期间 Obsidian 同步过」的场景；
 *   3) 目录配置变化时自动重新监视（5 秒轮询 localStorage）。
 * 关闭方式：把设置里的「执行云同步时自动拉取本机 Obsidian 变更并推至云端」取消勾选即可。
 */
(() => {
  try {
    if (window.__inkAutoPullInstalled) return;
    const api = window.inkNotes;
    if (
      !api ||
      typeof api.watchVault !== 'function' ||
      typeof api.onVaultChanged !== 'function' ||
      typeof api.readVaultFiles !== 'function'
    ) {
      console.log('[自动拉取] 当前环境不支持自动拉取（仅墨记桌面客户端可用），补丁跳过');
      return;
    }
    window.__inkAutoPullInstalled = true;

    const LAST_SYNC_KEY = 'ink-obsidian-last-sync';
    const STARTUP_DELAY_MS = 6000;
    const STARTUP_TOLERANCE_MS = 1500;
    const BATCH_MAX_FILES = 40;
    const BATCH_MAX_BYTES = 48 * 1024 * 1024;
    const WATCH_POLL_MS = 5000;

    const state = { dir: null, lastAt: 0, pulledCreated: 0, pulledUpdated: 0, batches: 0 };

    const has = (name, value) => typeof value === 'function';

    function readDir() {
      try {
        return has('NG', NG) ? NG() : null;
      } catch (err) {
        return null;
      }
    }

    function gateOpen() {
      try {
        return has('FG', FG) ? FG() : true;
      } catch (err) {
        return true;
      }
    }

    function report(entry) {
      try {
        if (api.logAutoPull) api.logAutoPull(entry);
      } catch (err) {
        /* 日志失败不影响主流程 */
      }
    }

    function counts(summary) {
      const s = summary || {};
      return {
        total: s.total || 0,
        created: s.created || 0,
        updated: s.updated || 0,
        unchanged: s.unchanged || 0,
        failed: s.failed || 0,
        skipped: s.skipped || 0,
      };
    }

    function toEntries(items) {
      return items.map((it) => ({
        dirPath: it.dirPath,
        name: it.name,
        lastModified: it.lastModified,
        read: () => {
          const u = new Uint8Array(it.data.byteLength);
          u.set(it.data);
          return Promise.resolve(u.buffer);
        },
      }));
    }

    async function merge(rels, reason) {
      const dir = readDir() || state.dir || null;
      if (!dir) return null;
      if (!has('LG', LG)) {
        console.warn('[自动拉取] 未找到增量合并函数 LG()，跳过');
        return null;
      }
      const started = Date.now();
      const items = await api.readVaultFiles(dir, rels);
      if (!items || items.length === 0) {
        return { ms: Date.now() - started, read: 0, ...counts(null) };
      }
      const summary = await LG(toEntries(items));
      const c = counts(summary);
      state.lastAt = Date.now();
      state.pulledCreated += c.created;
      state.pulledUpdated += c.updated;
      state.batches += 1;
      const ms = Date.now() - started;
      console.log(
        '[自动拉取] ' + reason + '：读取 ' + items.length + ' 个文件 → 新增 ' + c.created + '，更新 ' + c.updated +
          '，无变化 ' + c.unchanged + '，跳过 ' + c.skipped + '，失败 ' + c.failed + '（' + ms + 'ms）'
      );
      report({ reason, files: items.length, ms, ok: true, counts: c });
      return { ms, read: items.length, ...c };
    }

    // 串行队列：Obsidian 批量同步时会连续到达多个事件，保证同一时刻只有一次合并写入
    let chain = Promise.resolve();
    function enqueue(reason, rels) {
      chain = chain
        .then(() => {
          if (!gateOpen()) return null;
          return merge(rels, reason);
        })
        .catch((err) => {
          console.warn('[自动拉取] 失败:', err);
          report({ reason, ok: false, error: err && err.message ? err.message : String(err) });
          return null;
        });
      return chain;
    }

    // 启动补拉：利用清单（只 stat）找出比「上次同步时间」更新的文件，只读这些文件
    async function startupCatchUp() {
      const dir = readDir();
      if (!dir) return { skipped: 'no-dir' };
      if (!gateOpen()) return { skipped: 'disabled' };
      let since = 0;
      try {
        since = Number(localStorage.getItem(LAST_SYNC_KEY) || 0) || 0;
      } catch (err) {
        since = 0;
      }
      const manifest = await api.vaultManifest(dir);
      if (!Array.isArray(manifest) || manifest.length === 0) return { skipped: 'empty-manifest' };
      const changed = manifest
        .filter((m) => m && m.size > 0 && m.mtimeMs > since + STARTUP_TOLERANCE_MS)
        .sort((a, b) => a.mtimeMs - b.mtimeMs);
      if (changed.length === 0) {
        console.log('[自动拉取] 启动补拉：无需同步（清单 ' + manifest.length + ' 个文件均未变化）');
        report({ reason: 'startup', ok: true, note: 'no-changes', manifest: manifest.length, since });
        return { skipped: 'no-changes', manifest: manifest.length };
      }
      const batches = [];
      let batch = [];
      let bytes = 0;
      for (const m of changed) {
        if (batch.length >= BATCH_MAX_FILES || bytes + (m.size || 0) > BATCH_MAX_BYTES) {
          if (batch.length) batches.push(batch);
          batch = [];
          bytes = 0;
        }
        batch.push(m.rel);
        bytes += m.size || 0;
      }
      if (batch.length) batches.push(batch);
      console.log(
        '[自动拉取] 启动补拉：清单 ' + manifest.length + ' 个，待同步 ' + changed.length + ' 个，分 ' + batches.length + ' 批'
      );
      report({ reason: 'startup', ok: true, note: 'catching-up', manifest: manifest.length, changed: changed.length, batches: batches.length, since });
      let done = 0;
      for (const b of batches) {
        if (!gateOpen()) break;
        const r = await enqueue('startup', b);
        if (r) done += r.created + r.updated;
      }
      return { changed: changed.length, batches: batches.length, applied: done };
    }

    // 监听主进程推送的变化
    api.onVaultChanged((payload) => {
      const files = payload && Array.isArray(payload.files) ? payload.files : [];
      if (payload && payload.dir && !state.dir) state.dir = payload.dir;
      if (files.length === 0) return;
      enqueue('watch', files);
    });

    // 开始/更新监视（目录在设置里被改动时自动跟随）
    async function syncWatch(force) {
      const dir = readDir();
      if (!force && dir === state.dir) return;
      state.dir = dir;
      try {
        if (dir) {
          const res = await api.watchVault(dir);
          console.log('[自动拉取] 监视目录：' + dir + ' → ' + (res && res.ok ? '已开始' : '失败(' + (res && res.reason) + ')'));
          report({ reason: 'watch', ok: !!(res && res.ok), dir, res: res && { ok: res.ok, reason: res.reason } });
        } else if (api.unwatchVault) {
          await api.unwatchVault();
          console.log('[自动拉取] 已停止监视（未配置本机 Obsidian 仓库目录）');
        }
      } catch (err) {
        console.warn('[自动拉取] 监视设置失败:', err);
      }
    }

    syncWatch(true).catch(() => {});
    setInterval(() => {
      syncWatch(false).catch(() => {});
    }, WATCH_POLL_MS);

    setTimeout(() => {
      startupCatchUp().catch((err) => console.warn('[自动拉取] 启动补拉失败:', err));
    }, STARTUP_DELAY_MS);

    // 调试入口：控制台执行 __inkAutoPull.status / __inkAutoPull.pullNow() 可手动检查
    window.__inkAutoPull = {
      version: 1,
      get status() {
        return { dir: state.dir, lastAt: state.lastAt, created: state.pulledCreated, updated: state.pulledUpdated, batches: state.batches };
      },
      pullNow: (rels) => enqueue('manual', rels && rels.length ? rels : null),
      startupCatchUp,
      manifest: () => api.vaultManifest(readDir() || state.dir),
      watchState: () => {
        const dir = readDir() || state.dir;
        state.dir = dir;
        return dir ? api.watchVault(dir) : Promise.resolve({ ok: false, reason: 'empty-path' });
      },
    };
    console.log('[自动拉取] 补丁 v1 已加载（监视本机 Obsidian 仓库变化并自动增量拉取）');
  } catch (err) {
    console.warn('[自动拉取] 补丁初始化失败:', err);
  }
})();
