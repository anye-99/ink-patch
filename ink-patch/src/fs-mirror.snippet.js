// ============================================================================
// [fs-mirror] 「磁盘文件夹为唯一数据源」补丁 —— 渲染层
//
// 挂载点：Dexie 实例的表钩子（notes / noteContent / folders）。
// 为什么挂这里：墨记的全部写入（新建、编辑、改名、移动、加标签、删除、云同步拉取、
// 备份恢复…）最终都要落到这四张表上，所以钩子能零侵入地覆盖所有写入路径，
// 不需要改写任何官方 DAO / React 代码，也随官方升级更容易重新注入。
//
// 数据流：库内写入 → 钩子登记受影响笔记（内存，同步、零风险）
//        → 防抖 flush 读回最终状态 → 分批推给主进程落盘（分配路径/写文件/改名/回收站）。
// 回环抑制：主进程登记自写并过滤 watcher 事件；此处落盘前内容一致则完全不写文件。
// ============================================================================
(function () {
  var INK_DB = typeof _ !== 'undefined' ? _ : null;
  var W = typeof window !== 'undefined' ? window : null;
  if (!W || W.__inkFsMirrorInstalled) return;
  if (!INK_DB || !INK_DB.notes || !INK_DB.folders || !INK_DB.noteContent) {
    console.warn('[fs-mirror] 未取到 Dexie 实例，文件优先补丁未启用');
    return;
  }
  W.__inkFsMirrorInstalled = true;

  var VAULT_PATH_KEY = 'ink-obsidian-vault-path'; // 复用官方的「本机 Obsidian 仓库目录」配置
  var INIT_KEY = 'ink-fs-mirror-init'; // 记录已对账过的库路径，避免每次启动都全量对账
  var FLUSH_DELAY_MS = 250;
  var BOOT_DELAY_MS = 7000; // 等补丁 A 的启动补拉先跑完
  var BATCH_SIZE = 40;

  var pending = new Map(); // id -> { rename, keepName }
  var pendingTrash = new Set();
  var folderTouched = false;
  var timer = null;
  var flushing = false;
  var bootstrapTimer = null;
  var stats = { flushed: 0, written: 0, moved: 0, trashed: 0, failed: 0, lastAt: 0, lastError: null, lastBatch: 0 };

  function vaultPath() {
    try {
      return localStorage.getItem(VAULT_PATH_KEY) || null;
    } catch (e) {
      return null;
    }
  }

  function canWrite() {
    return !!(W.inkNotes && typeof W.inkNotes.fsApply === 'function');
  }

  function log(info) {
    try {
      if (W.inkNotes && typeof W.inkNotes.logFsMirror === 'function') W.inkNotes.logFsMirror(info);
    } catch (e) {
      /* 日志失败不影响同步 */
    }
  }

  // 不依赖 instanceof（跨 realm 的 Error 判断不可靠，且 message 比整串更好读）
  function errText(err) {
    if (err && typeof err.message === 'string' && err.message) return err.message;
    return String(err);
  }

  function touch(id, opts) {
    if (!id) return;
    var cur = pending.get(id);
    if (!cur) {
      cur = { rename: false, keepName: false };
      pending.set(id, cur);
    }
    if (opts) {
      if (opts.rename) cur.rename = true;
      if (opts.keepName) cur.keepName = true;
    }
    schedule();
  }

  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () {
      void flush();
    }, FLUSH_DELAY_MS);
  }

  function folderPathOf(folderId, folderMap) {
    if (!folderId) return '';
    var parts = [];
    var cur = folderId;
    var guard = 0;
    while (cur && guard < 500) {
      guard += 1;
      var f = folderMap.get(cur);
      if (!f) break;
      parts.unshift(typeof f.name === 'string' && f.name ? f.name : '未命名文件夹');
      cur = f.parentId || null;
    }
    return parts.join('/');
  }

  async function loadFolderMap() {
    var list = await INK_DB.folders.toArray();
    var m = new Map();
    for (var i = 0; i < list.length; i += 1) m.set(list[i].id, list[i]);
    return m;
  }

  // 组织本轮要落盘的清单：文件夹结构变化 → 全部活跃笔记按「保留文件名 + 新目录」重算
  async function buildItems() {
    var jobs = new Map();

    if (folderTouched) {
      folderTouched = false;
      var all = await INK_DB.notes.filter(function (n) {
        return !n.deletedAt;
      }).toArray();
      for (var i = 0; i < all.length; i += 1) {
        jobs.set(all[i].id, { id: all[i].id, rename: false, keepName: true });
      }
    }

    pending.forEach(function (v, id) {
      var j = jobs.get(id);
      if (j) {
        j.rename = j.rename || !!v.rename;
        j.keepName = j.keepName || !!v.keepName;
      } else {
        jobs.set(id, { id: id, rename: !!v.rename, keepName: !!v.keepName });
      }
    });
    pending.clear();

    var trashIds = Array.from(pendingTrash);
    pendingTrash.clear();

    var folderMap = await loadFolderMap();
    var items = [];
    var ids = Array.from(jobs.keys());
    for (var n = 0; n < ids.length; n += 1) {
      var id = ids[n];
      var note;
      try {
        note = await INK_DB.notes.get(id);
      } catch (e) {
        note = null;
      }
      if (!note) continue; // 已被物理清除
      if (note.deletedAt) {
        if (trashIds.indexOf(id) < 0) trashIds.push(id); // 软删除 → 文件进回收站
        continue;
      }
      if (note.type && note.type !== 'md') continue; // PDF / Word 本期不落盘（原件本就在库里）

      var row = null;
      try {
        row = await INK_DB.noteContent.get(id);
      } catch (e) {
        row = null;
      }
      // 内容读不到时绝不写空文件，宁可这轮跳过
      if (!row || typeof row.content !== 'string') continue;

      var job = jobs.get(id) || { rename: false, keepName: false };
      items.push({
        id: id,
        kind: 'note',
        ext: '.md',
        title: typeof note.title === 'string' ? note.title : '未命名笔记',
        dirPath: folderPathOf(note.folderId, folderMap),
        srcPath: typeof note.srcPath === 'string' && note.srcPath ? note.srcPath : null,
        content: row.content,
        rename: !!job.rename,
        keepName: !!job.keepName,
      });
    }

    for (var t = 0; t < trashIds.length; t += 1) {
      items.push({ id: trashIds[t], kind: 'trash' });
    }
    return items;
  }

  async function flush(opts) {
    var planOnly = !!(opts && opts.planOnly);
    timer = null;
    if (flushing) {
      schedule();
      return null;
    }
    var dir = vaultPath();
    if (!dir || !canWrite()) return null; // 没配库目录或不在桌面客户端：什么都不做
    flushing = true;
    try {
      var items = await buildItems();
      if (items.length === 0) return planOnly ? { total: 0, create: 0, adopt: 0, overwrite: 0, move: 0, trash: 0, failed: 0 } : null;
      var plan = { total: items.length, create: 0, adopt: 0, overwrite: 0, move: 0, trash: 0, failed: 0 };
      var batches = 0;
      for (var s = 0; s < items.length; s += BATCH_SIZE) {
        var batch = items.slice(s, s + BATCH_SIZE);
        batches += 1;
        var res = null;
        try {
          res = await W.inkNotes.fsApply({ vaultPath: dir, items: batch, dryRun: planOnly });
        } catch (err) {
          plan.failed += batch.length;
          if (!planOnly) {
            stats.lastError = errText(err);
            stats.failed += batch.length;
          }
          continue;
        }
        if (!res || !res.ok) {
          plan.failed += batch.length;
          if (!planOnly) {
            stats.lastError = (res && res.reason) || 'apply-failed';
            stats.failed += batch.length;
          }
          continue;
        }
        var results = res.results || [];
        for (var r = 0; r < results.length; r += 1) {
          var it = results[r];
          if (it.ok === false) {
            plan.failed += 1;
            if (!planOnly) {
              stats.failed += 1;
              stats.lastError = it.error || 'item-failed';
            }
            continue;
          }
          if (planOnly) {
            if (it.plan === 'create') plan.create += 1;
            else if (it.plan === 'adopt') plan.adopt += 1;
            else if (it.plan === 'overwrite') plan.overwrite += 1;
            else if (it.plan === 'trash') plan.trash += 1;
            if (it.move) plan.move += 1;
          } else {
            if (it.trashed) stats.trashed += 1;
            if (it.wrote) stats.written += 1;
            if (it.movedFrom) stats.moved += 1;
          }
        }
      }
      if (planOnly) return plan;
      stats.flushed += 1;
      stats.lastBatch = items.length;
      stats.lastAt = Date.now();
      if (batches > 0) {
        log({ event: 'flush', items: items.length, batches: batches, stats: stats });
      }
      return null;
    } catch (err) {
      if (!planOnly) {
        stats.lastError = errText(err);
        console.warn('[fs-mirror] flush 失败:', err);
      }
      return null;
    } finally {
      flushing = false;
      // 预演不改变任何状态，也就不要紧接着又排一次真实 flush
      if (!planOnly && (pending.size > 0 || pendingTrash.size > 0 || folderTouched)) schedule();
    }
  }

  // ---------------------------------------------------------------- 表钩子
  function hookTable(table, handler) {
    if (!table || typeof table.hook !== 'function') return false;
    try {
      table.hook('creating', function (primKey, obj) {
        try {
          handler('create', obj, primKey, null);
        } catch (e) {
          /* 钩子内绝不抛错，否则会回滚业务事务 */
        }
      });
      table.hook('updating', function (mods, primKey, obj) {
        try {
          handler('update', obj, primKey, mods);
        } catch (e) {
          /* 同上 */
        }
      });
      table.hook('deleting', function (primKey, obj) {
        try {
          handler('delete', obj, primKey, null);
        } catch (e) {
          /* 同上 */
        }
      });
      return true;
    } catch (err) {
      console.warn('[fs-mirror] 挂表钩子失败:', err);
      return false;
    }
  }

  function hasKey(obj, key) {
    return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
  }

  var hookedNotes = hookTable(INK_DB.notes, function (op, obj, primKey, mods) {
    var id = (obj && obj.id) || primKey;
    if (!id) return;
    if (op === 'delete') {
      pending.delete(id);
      pendingTrash.add(id);
      schedule();
      return;
    }
    // 只有「标题/所属文件夹真的变了」才触发文件改名，避免把 frontmatter 标题与文件名不同的笔记反复改
    var rename = op === 'create' || hasKey(mods, 'title') || hasKey(mods, 'folderId');
    touch(id, { rename: !!rename });
  });

  var hookedContent = hookTable(INK_DB.noteContent, function (op, obj, primKey) {
    var id = (obj && obj.noteId) || primKey;
    if (!id) return;
    touch(id, null);
  });

  var hookedFolders = hookTable(INK_DB.folders, function () {
    // 文件夹改名/移动会让其下所有笔记的目录路径变化：宁可整库重算一遍
    folderTouched = true;
    schedule();
  });

  // ---------------------------------------------------------------- 启动对账
  // 首次接入（或换了库目录）时做一次「全量对账」：
  //   1) 先跑官方全量拉取 RG()，把磁盘上已有的文件合并进库，并给笔记补上 srcPath 来源标记；
  //   2) 再把库里所有活跃笔记落盘一次（内容一致的只会被认领，不会重复写）。
  // 这样磁盘上的原文件和库里的笔记一一对上，不会出现「同一个文件被当成两篇笔记」。
  function initKeyFor(dir) {
    // 版本号变更会让所有已对账的库重跑一次首次对账
    // v2：按正文比对并保留 frontmatter；v3：同内容的重复笔记共用同一个文件；
    // v4：首次对账包含「把磁盘上还没入库的文本笔记分批导入」，让磁盘真正成为唯一数据源
    return dir + '|v4';
  }

  function alreadyReconciled(dir) {
    try {
      return localStorage.getItem(INIT_KEY) === initKeyFor(dir);
    } catch (e) {
      return false;
    }
  }

  function markReconciled(dir) {
    try {
      localStorage.setItem(INIT_KEY, initKeyFor(dir));
    } catch (e) {
      /* 记不住就下次再对账一次，无副作用 */
    }
  }

  // 安全闸的人工放行开关：预检被拦下后，确认无误再设 localStorage['ink-fs-mirror-force']='1'
  function forced() {
    try {
      return localStorage.getItem('ink-fs-mirror-force') === '1';
    } catch (e) {
      return false;
    }
  }

  // 把库目录里**尚未入库**的文本笔记全量读进来，用于「磁盘 → 库」的完整重建。
  //
  // 为什么自己实现而不用官方的全量拉取 RG()：RG 会把所有受支持文件（含 PDF/Word）
  // 一次性读进渲染进程内存。本机这个库 683 MB，足以把页面直接搞崩。
  // 这里按批（40 个文件）走 vaultManifest（只 stat）+ readVaultFiles（只读该批）+ 官方增量合并 LG，
  // 内存峰值只跟一批文件的大小有关，与库的总规模无关。
  var TEXT_EXTS = /\.(md|markdown|txt)$/i;
  var IMPORT_BATCH = 40;

  async function importAll(opts) {
    var o = opts || {};
    var dir = vaultPath();
    if (!dir || !canWrite()) return { ok: false, reason: 'no-vault-or-bridge' };
    if (typeof LG !== 'function') return { ok: false, reason: 'no-lg' };
    if (typeof W.inkNotes.vaultManifest !== 'function' || typeof W.inkNotes.readVaultFiles !== 'function') {
      return { ok: false, reason: 'no-bridge' };
    }

    var manifest = null;
    try {
      manifest = await W.inkNotes.vaultManifest(dir);
    } catch (e) {
      return { ok: false, reason: 'manifest-failed', error: errText(e) };
    }
    if (!Array.isArray(manifest)) return { ok: false, reason: 'bad-manifest' };

    // 默认只处理文本笔记：PDF / Word 的体积大，且它们在库里的正文是从原件提取的派生文本，
    // 需要时用 importAll({ includeBinary: true }) 显式打开。
    var targets = manifest.filter(function (f) {
      if (!f || typeof f.rel !== 'string') return false;
      return o.includeBinary ? true : TEXT_EXTS.test(f.rel);
    });

    var counts = { files: targets.length, batches: 0, created: 0, updated: 0, unchanged: 0, failed: 0, skipped: 0 };
    for (var i = 0; i < targets.length; i += IMPORT_BATCH) {
      var batch = targets.slice(i, i + IMPORT_BATCH);
      counts.batches += 1;
      var read = null;
      try {
        read = await W.inkNotes.readVaultFiles(dir, batch.map(function (f) { return f.rel; }));
      } catch (e) {
        counts.failed += batch.length;
        continue;
      }
      if (!Array.isArray(read) || read.length === 0) continue;
      var payload = read.map(function (f) {
        var bytes = f.data; // 每次迭代各自持有自己那一份，避免闭包串味
        return {
          dirPath: f.dirPath,
          name: f.name,
          lastModified: f.lastModified,
          read: function () {
            var copy = new Uint8Array(bytes.byteLength);
            copy.set(bytes);
            return Promise.resolve(copy.buffer);
          },
        };
      });
      try {
        var r = await LG(payload);
        if (r && typeof r === 'object') {
          counts.created += r.created || 0;
          counts.updated += r.updated || 0;
          counts.unchanged += r.unchanged || 0;
          counts.failed += r.failed || 0;
          counts.skipped += r.skipped || 0;
        }
      } catch (e) {
        counts.failed += payload.length;
      }
      // 让出主线程：上千个文件连着跑会把界面卡住
      await new Promise(function (res) {
        setTimeout(res, 0);
      });
    }
    return { ok: true, counts: counts };
  }

  // 把磁盘上已经存在的文件认领给库里的笔记。
  // 为什么需要：墨记导入 md 时标题可能取自 frontmatter.title，库里的标题于是和磁盘文件名不一致；
  // 不认领的话，落盘会按标题另起一个文件，同一个文件就变成两篇笔记。
  async function claimExistingFiles(dir) {
    var idmap = null;
    try {
      idmap = await W.inkNotes.fsIdMap(dir);
    } catch (e) {
      return 0;
    }
    if (idmap && idmap.count > 0) return 0; // 已有归属关系，不打扰

    var files = null;
    try {
      files = await W.inkNotes.fsScan(dir);
    } catch (e) {
      files = null;
    }
    if (!files || files.length === 0) return 0;

    var fmIndex = new Map(); // 目录+frontmatter标题 → [rel]（最精确）
    var stemIndex = new Map(); // 目录+文件名主干 → [rel]
    var fmFlat = new Map(); // 仅标题 → [rel]（回退）
    var stemFlat = new Map(); // 仅主干 → [rel]（回退）
    var used = new Set();

    function push(map, key, rel) {
      if (!key) return;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(rel);
    }
    function dirOf(rel) {
      var i = rel.lastIndexOf('/');
      return i < 0 ? '' : rel.slice(0, i);
    }

    for (var i = 0; i < files.length; i += 1) {
      var f = files[i];
      if (!f || typeof f.rel !== 'string') continue;
      var rel = f.rel;
      var dirKey = dirOf(rel).toLowerCase();
      if (f.fmTitle) {
        var fmLower = String(f.fmTitle).toLowerCase();
        push(fmIndex, dirKey + '|' + fmLower, rel);
        push(fmFlat, fmLower, rel);
      }
      var stemLower = String(f.stem || '').toLowerCase();
      if (stemLower) {
        push(stemIndex, dirKey + '|' + stemLower, rel);
        push(stemFlat, stemLower, rel);
      }
    }

    function claim(pool, key) {
      var list = pool.get(key);
      if (!list) return null;
      for (var j = 0; j < list.length; j += 1) {
        if (!used.has(list[j])) {
          used.add(list[j]);
          return list[j];
        }
      }
      return null;
    }

    var folderMap = await loadFolderMap();
    var notes = await INK_DB.notes.filter(function (n) {
      return !n.deletedAt && (!n.type || n.type === 'md');
    }).toArray();
    var entries = [];
    for (var n = 0; n < notes.length; n += 1) {
      var title = String(notes[n].title || '').trim();
      if (!title) continue;
      // 与官方导入合并（LG）同一套身份口径：先「所在目录 + 标题」，再退到仅标题
      var noteDir = folderPathOf(notes[n].folderId, folderMap).toLowerCase();
      var titleLower = title.toLowerCase();
      var hit =
        claim(fmIndex, noteDir + '|' + titleLower) ||
        claim(stemIndex, noteDir + '|' + titleLower) ||
        claim(fmFlat, titleLower) ||
        claim(stemFlat, titleLower);
      if (hit) entries.push([notes[n].id, hit]);
    }
    if (entries.length === 0) return 0;
    try {
      var res = await W.inkNotes.fsSeed({ vaultPath: dir, entries: entries });
      log({ event: 'claim', claimed: entries.length, total: (res && res.count) || 0 });
      return entries.length;
    } catch (e) {
      return 0;
    }
  }

  async function bootstrap() {
    var dir = vaultPath();
    if (!dir || !canWrite()) return;
    var reconciled = alreadyReconciled(dir);
    log({ event: 'bootstrap-start', dir: dir, reconciled: reconciled });

    // 1) 首次接入（或换了库目录）：把磁盘上**还没入库**的文本笔记分批读进来。
    //    这一步才让「磁盘是唯一数据源」真正成立——库里缺什么，就从磁盘补什么。
    //    刻意不用官方全量拉取 RG()：它会把整个库（含 PDF/Word）一次性读进内存，
    //    本机这个库 683 MB，足以把页面搞崩。
    var imported = null;
    if (!reconciled) {
      try {
        imported = await importAll();
      } catch (err) {
        imported = { ok: false, error: errText(err) };
      }
      log({ event: 'bootstrap-import', result: imported });
    }

    // 2) 认领磁盘上已有的原文件（只在还没有任何归属记录时做）
    var claimed = 0;
    try {
      claimed = await claimExistingFiles(dir);
    } catch (err) {
      claimed = 0;
    }
    // 2) 首次接入：先预演一次，确认不会在已有知识库里刷出一堆重复文件
    if (!reconciled && !forced()) {
      folderTouched = true;
      var plan = await flush({ planOnly: true });
      log({ event: 'bootstrap-plan', claimed: claimed, plan: plan });
      // 认领率明显不对（要新建的比认领到的还多，且数量可观）→ 停手，交给人确认
      if (plan && plan.create >= 50 && plan.create > plan.adopt) {
        console.error(
          '[fs-mirror] 首次对账预检未通过：计划新建 ' +
            plan.create +
            ' 个文件，却只认领到 ' +
            plan.adopt +
            ' 个已有文件。为避免在你的知识库里刷出大量重复文件，已暂停落盘。\n' +
            '明细见 %APPDATA%\\ink-notes\\fs-mirror.log；确认无误后，在开发者工具控制台执行\n' +
            "  localStorage.setItem('ink-fs-mirror-force','1')\n" +
            '再重启墨记即可继续。'
        );
        try {
          localStorage.setItem('ink-fs-mirror-blocked', JSON.stringify(plan));
        } catch (e) {
          /* 忽略 */
        }
        return;
      }
    }
    // 3) 把库里所有活跃笔记落盘一次：已有的被认领/跳过，缺文件的补建（启动即自愈）
    folderTouched = true;
    await flush();
    markReconciled(dir);
    log({ event: 'bootstrap-done', dir: dir, claimed: claimed, imported: imported, stats: stats });
  }

  function scheduleBootstrap(delay) {
    if (bootstrapTimer) clearTimeout(bootstrapTimer);
    bootstrapTimer = setTimeout(function () {
      void bootstrap();
    }, typeof delay === 'number' ? delay : BOOT_DELAY_MS);
  }

  // ---------------------------------------------------------------- 调试入口
  W.__inkFsMirror = {
    status: function () {
      return {
        vault: vaultPath(),
        pending: pending.size,
        pendingTrash: pendingTrash.size,
        folderTouched: folderTouched,
        flushing: flushing,
        hooked: { notes: hookedNotes, noteContent: hookedContent, folders: hookedFolders },
        stats: stats,
      };
    },
    flushNow: function () {
      return flush();
    },
    reconcileNow: function () {
      folderTouched = true;
      return flush();
    },
    // 只算不写：看一眼「这一轮会新建/认领/改名多少文件」
    planNow: function () {
      folderTouched = true;
      return flush({ planOnly: true });
    },
    fullBootstrap: function () {
      try {
        localStorage.removeItem(INIT_KEY);
      } catch (e) {
        /* 忽略 */
      }
      return bootstrap();
    },
    // 不抹掉「已对账」标记，按当前状态跑一次对账流程（排查用）
    bootstrapNow: function () {
      return bootstrap();
    },
    idmap: function () {
      var dir = vaultPath();
      if (!dir || !W.inkNotes.fsIdMap) return Promise.resolve(null);
      return W.inkNotes.fsIdMap(dir);
    },
    // 手动把库里还没有的笔记文件读进来（可传 { includeBinary: true } 连 PDF/Word 一起）
    importAll: function (opts) {
      return importAll(opts);
    },
  };

  // 等应用首屏与补丁 A 的启动补拉都跑完再对账，避免与官方初始化抢事务
  scheduleBootstrap(BOOT_DELAY_MS);
  console.log('[fs-mirror] 文件优先补丁已挂载：库内写入将实时落盘到本机仓库');
})();
