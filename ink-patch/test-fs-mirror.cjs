// 渲染层文件优先补丁单测：把 fs-mirror.snippet.js 加载进 vm，
// 用 mock 的 Dexie 实例 / window.inkNotes / localStorage 验证「库内写入 → 落盘清单」的正确性。
// 用法：node test-fs-mirror.cjs
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SNIPPET = path.join(__dirname, 'src', 'fs-mirror.snippet.js');
const CODE = fs.readFileSync(SNIPPET, 'utf8');

let pass = 0;
const failures = [];
function ok(cond, label) {
  if (cond) pass += 1;
  else {
    failures.push(label);
    console.log('  ✗ ' + label);
  }
}
function eq(actual, expected, label) {
  ok(actual === expected, label + '（期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual) + '）');
}

function makeTable(name, entries) {
  const rows = new Map(entries || []);
  const hooks = { creating: [], updating: [], deleting: [] };
  return {
    name,
    rows,
    hook(kind, fn) {
      if (!hooks[kind]) throw new Error('未知钩子：' + kind);
      hooks[kind].push(fn);
    },
    async get(id) {
      return rows.get(id);
    },
    async toArray() {
      return [...rows.values()];
    },
    filter(fn) {
      return { toArray: async () => [...rows.values()].filter(fn) };
    },
    fire(kind, ...args) {
      for (const fn of hooks[kind]) fn(...args);
    },
    hookCount(kind) {
      return hooks[kind].length;
    },
  };
}

// 载入一份全新的 snippet 实例（snippet 是单例，每个用例要独立 context）
function load(opts) {
  const o = opts || {};
  const seed = o.seed || {};
  const tables = {
    notes: makeTable('notes', seed.notes),
    noteContent: makeTable('noteContent', seed.noteContent),
    folders: makeTable('folders', seed.folders),
  };
  const calls = { apply: [], seed: [], logs: [], rg: 0, scan: 0, manifest: 0, readFiles: [], lgPayloads: [] };
  const store = new Map();
  if (o.vault) store.set('ink-obsidian-vault-path', o.vault);
  if (o.initKey) store.set('ink-fs-mirror-init', o.initKey);

  const inkNotes = {
    fsApply: async (payload) => {
      calls.apply.push(payload);
      const dry = !!payload.dryRun;
      return {
        ok: true,
        dryRun: dry,
        results: payload.items.map((it) => {
          const base = { id: it.id, ok: true, rel: 'r/' + it.id, wrote: !dry };
          if (dry) base.plan = o.planFor ? o.planFor(it) : 'create';
          return base;
        }),
      };
    },
    fsIdMap: async () => ({ ok: true, count: o.idmapCount || 0, notes: {} }),
    fsScan: async () => {
      calls.scan += 1;
      return o.scanResult || [];
    },
    fsSeed: async (payload) => {
      calls.seed.push(payload);
      return { ok: true, count: payload.entries.length };
    },
    logFsMirror: async (info) => {
      calls.logs.push(info);
      return { ok: true };
    },
    vaultManifest: async () => {
      calls.manifest += 1;
      return o.manifest || [];
    },
    readVaultFiles: async (_dir, rels) => {
      calls.readFiles.push(rels.slice());
      return rels.map((rel) => ({
        dirPath: rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '',
        name: rel.split('/').pop(),
        lastModified: 1000,
        data: new Uint8Array([1, 2, 3]),
      }));
    },
  };

  const timers = [];
  const ctx = {
    console: { log: () => {}, warn: (m) => calls.logs.push({ event: 'warn', m: String(m) }), error: () => {} },
    // 0 延迟的让步（importAll 里用来让出主线程）要真的执行，否则 await 永远不 resolve；
    // 带延迟的（防抖 flush）只记录，由用例显式调用 flushNow 触发。
    setTimeout: (fn, ms) => {
      if (!ms) {
        fn();
        return 0;
      }
      timers.push(fn);
      return timers.length;
    },
    clearTimeout: () => {},
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    window: {},
    RG: async () => {
      calls.rg += 1;
      return { ok: true, summary: {} };
    },
    // 官方增量合并（index chunk 里的 LG）：用 mock 记录它收到了哪些文件
    LG: async (payload) => {
      calls.lgPayloads.push(payload.map((p) => p.name));
      return { total: payload.length, created: payload.length, updated: 0, unchanged: 0, failed: 0, skipped: 0 };
    },
  };
  if (o.noBridge) ctx.window = {};
  else ctx.window = { inkNotes };
  ctx.window.localStorage = ctx.localStorage;
  ctx._ = tables;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(CODE, ctx, { filename: SNIPPET });
  return { ctx, tables, calls, store, timers };
}

const flushNow = (h) => h.ctx.window.__inkFsMirror.flushNow();
const reconcileNow = (h) => h.ctx.window.__inkFsMirror.reconcileNow();
const fullBootstrap = (h) => h.ctx.window.__inkFsMirror.fullBootstrap();

function note(id, patch) {
  return Object.assign({ id, type: 'md', title: '标题 ' + id, folderId: null, tags: [], createdAt: 1, updatedAt: 1 }, patch || {});
}
function content(id, text) {
  return { noteId: id, content: text };
}

(async () => {
  // ============ R1 挂载：三张表都挂上了钩子 ============
  {
    const h = load({ vault: 'V:/库' });
    eq(h.ctx.window.__inkFsMirrorInstalled, true, 'R1 标记已安装');
    eq(h.tables.notes.hookCount('creating'), 1, 'R1 notes.creating 已挂');
    eq(h.tables.notes.hookCount('updating'), 1, 'R1 notes.updating 已挂');
    eq(h.tables.notes.hookCount('deleting'), 1, 'R1 notes.deleting 已挂');
    eq(h.tables.noteContent.hookCount('updating'), 1, 'R1 noteContent.updating 已挂');
    eq(h.tables.folders.hookCount('updating'), 1, 'R1 folders.updating 已挂');
    ok(typeof h.ctx.window.__inkFsMirror.flushNow === 'function', 'R1 暴露调试入口');
  }

  // ============ R2 新建笔记 → 落盘清单 ============
  {
    const h = load({ vault: 'V:/库' });
    const n = note('n1', { title: '新笔记' });
    h.tables.notes.rows.set('n1', n);
    h.tables.noteContent.rows.set('n1', content('n1', '正文'));
    h.tables.notes.fire('creating', 'n1', n);
    await flushNow(h);
    eq(h.calls.apply.length, 1, 'R2 发起了一批判盘');
    const items = h.calls.apply[0].items;
    eq(items.length, 1, 'R2 一条笔记一个 item');
    eq(items[0].id, 'n1', 'R2 item 带 noteId');
    eq(items[0].title, '新笔记', 'R2 item 带标题');
    eq(items[0].content, '正文', 'R2 item 带正文');
    eq(items[0].kind, 'note', 'R2 kind=note');
    eq(items[0].rename, true, 'R2 新建时要求按标题落位');
    eq(h.calls.apply[0].vaultPath, 'V:/库', 'R2 带上库目录');
  }

  // ============ R3 只改正文 → 不触发文件改名 ============
  {
    const h = load({ vault: 'V:/库' });
    const n = note('n1', { title: '不变' });
    h.tables.notes.rows.set('n1', n);
    h.tables.noteContent.rows.set('n1', content('n1', '新正文'));
    h.tables.noteContent.fire('updating', { content: '新正文' }, 'n1', { noteId: 'n1' });
    await flushNow(h);
    const items = h.calls.apply[0].items;
    eq(items.length, 1, 'R3 只处理这一篇');
    eq(items[0].content, '新正文', 'R3 带上最新正文');
    eq(items[0].rename, false, 'R3 正文变化不要求改名（保住磁盘上的文件名）');
  }

  // ============ R4 改标题 → 要求改名 ============
  {
    const h = load({ vault: 'V:/库' });
    const n = note('n1', { title: '新标题' });
    h.tables.notes.rows.set('n1', n);
    h.tables.noteContent.rows.set('n1', content('n1', '正文'));
    h.tables.notes.fire('updating', { title: '新标题' }, 'n1', { id: 'n1', title: '新标题' });
    await flushNow(h);
    eq(h.calls.apply[0].items[0].rename, true, 'R4 标题变化要求改名');
  }

  // ============ R5 移动到别的文件夹 → 要求改名（换目录） ============
  {
    const h = load({ vault: 'V:/库' });
    const n = note('n1', { folderId: 'f1' });
    h.tables.notes.rows.set('n1', n);
    h.tables.noteContent.rows.set('n1', content('n1', '正文'));
    h.tables.folders.rows.set('f1', { id: 'f1', name: '目标夹', parentId: null });
    h.tables.notes.fire('updating', { folderId: 'f1' }, 'n1', { id: 'n1', folderId: 'f1' });
    await flushNow(h);
    const it = h.calls.apply[0].items[0];
    eq(it.rename, true, 'R5 移动文件夹要求重新定位');
    eq(it.dirPath, '目标夹', 'R5 目录来自文件夹名');
  }

  // ============ R6 多层文件夹 → 目录用 / 拼接 ============
  {
    const h = load({ vault: 'V:/库' });
    h.tables.folders.rows.set('f1', { id: 'f1', name: '父', parentId: null });
    h.tables.folders.rows.set('f2', { id: 'f2', name: '子', parentId: 'f1' });
    h.tables.folders.rows.set('f3', { id: 'f3', name: '孙', parentId: 'f2' });
    const n = note('n1', { folderId: 'f3' });
    h.tables.notes.rows.set('n1', n);
    h.tables.noteContent.rows.set('n1', content('n1', 'x'));
    h.tables.notes.fire('creating', 'n1', n);
    await flushNow(h);
    eq(h.calls.apply[0].items[0].dirPath, '父/子/孙', 'R6 目录层级拼完整');
  }

  // ============ R7 软删除 → 进回收站，不再写正文 ============
  {
    const h = load({ vault: 'V:/库' });
    const n = note('n1', { deletedAt: 1700000000000 });
    h.tables.notes.rows.set('n1', n);
    h.tables.noteContent.rows.set('n1', content('n1', '已删正文'));
    h.tables.notes.fire('updating', { deletedAt: 1700000000000 }, 'n1', { id: 'n1' });
    await flushNow(h);
    const items = h.calls.apply[0].items;
    eq(items.length, 1, 'R7 只发一条');
    eq(items[0].kind, 'trash', 'R7 软删除走回收站');
    ok(!items[0].content, 'R7 不再写正文');
  }

  // ============ R8 物理删除 → 回收站 ============
  {
    const h = load({ vault: 'V:/库' });
    h.tables.notes.fire('deleting', 'n9', { id: 'n9' });
    await flushNow(h);
    eq(h.calls.apply[0].items[0].kind, 'trash', 'R8 物理删除也走回收站（避免 .trash 之外的文件残留）');
  }

  // ============ R9 正文读不到 → 绝不写空文件 ============
  {
    const h = load({ vault: 'V:/库' });
    const n = note('n1');
    h.tables.notes.rows.set('n1', n); // noteContent 故意缺失
    h.tables.notes.fire('creating', 'n1', n);
    await flushNow(h);
    eq(h.calls.apply.length, 0, 'R9 内容不可读时跳过，不产生空的 .md');
  }

  // ============ R10 PDF / Word 笔记本期不落盘 ============
  {
    const h = load({ vault: 'V:/库' });
    const n = note('p1', { type: 'pdf', title: '论文' });
    h.tables.notes.rows.set('p1', n);
    h.tables.noteContent.rows.set('p1', content('p1', '提取出来的文字'));
    h.tables.notes.fire('creating', 'p1', n);
    await flushNow(h);
    eq(h.calls.apply.length, 0, 'R10 pdf 笔记不落盘（原件本就在库里）');
  }

  // ============ R11 文件夹变化 → 全库重算且保留文件名 ============
  {
    const h = load({ vault: 'V:/库' });
    h.tables.folders.rows.set('f1', { id: 'f1', name: '改名后的夹', parentId: null });
    for (let i = 0; i < 3; i += 1) {
      h.tables.notes.rows.set('n' + i, note('n' + i, { folderId: 'f1' }));
      h.tables.noteContent.rows.set('n' + i, content('n' + i, 'x' + i));
    }
    h.tables.notes.rows.set('dead', note('dead', { deletedAt: 1 })); // 已删的不该被重算
    h.tables.folders.fire('updating', { name: '改名后的夹' }, 'f1', { id: 'f1' });
    await flushNow(h);
    const items = h.calls.apply[0].items;
    eq(items.length, 3, 'R11 重算全部活跃笔记（跳过已删）');
    eq(items[0].keepName, true, 'R11 重算时保留原文件名');
    eq(items[0].dirPath, '改名后的夹', 'R11 目录用新文件夹名');
  }

  // ============ R12 没配置库目录 → 什么都不做 ============
  {
    const h = load({});
    const n = note('n1');
    h.tables.notes.rows.set('n1', n);
    h.tables.noteContent.rows.set('n1', content('n1', 'x'));
    h.tables.notes.fire('creating', 'n1', n);
    await flushNow(h);
    eq(h.calls.apply.length, 0, 'R12 未配置库目录时不落盘');
  }

  // ============ R13 浏览器环境（没有 preload 桥）→ 不崩 ============
  {
    const h = load({ vault: 'V:/库', noBridge: true });
    const n = note('n1');
    h.tables.notes.rows.set('n1', n);
    h.tables.noteContent.rows.set('n1', content('n1', 'x'));
    h.tables.notes.fire('creating', 'n1', n);
    await flushNow(h);
    eq(h.calls.apply.length, 0, 'R13 无原生桥时不报错、不落盘');
  }

  // ============ R14 大批量 → 分批推送 ============
  {
    const h = load({ vault: 'V:/库' });
    for (let i = 0; i < 45; i += 1) {
      const n = note('b' + i);
      h.tables.notes.rows.set('b' + i, n);
      h.tables.noteContent.rows.set('b' + i, content('b' + i, 'x'));
      h.tables.notes.fire('creating', 'b' + i, n);
    }
    await flushNow(h);
    eq(h.calls.apply.length, 2, 'R14 45 条分两批（每批 40）');
    eq(h.calls.apply[0].items.length, 40, 'R14 第一批 40 条');
    eq(h.calls.apply[1].items.length, 5, 'R14 第二批 5 条');
  }

  // ============ R15 首次对账：先全量拉取、再认领、再落盘、最后记标记 ============
  {
    const h = load({
      vault: 'V:/库',
      scanResult: [
        { rel: '目录/原文件.md', stem: '原文件', fmTitle: 'frontmatter 标题' },
        { rel: '目录/按文件名.md', stem: '按文件名', fmTitle: null },
        { rel: '目录/没人认领.md', stem: '没人认领', fmTitle: null },
      ],
    });
    h.tables.notes.rows.set('n1', note('n1', { title: 'frontmatter 标题' }));
    h.tables.notes.rows.set('n2', note('n2', { title: '按文件名' }));
    h.tables.noteContent.rows.set('n1', content('n1', 'a'));
    h.tables.noteContent.rows.set('n2', content('n2', 'b'));
    await fullBootstrap(h);
    eq(h.calls.rg, 0, 'R15 不调用官方全量拉取（大库会被读爆内存，回流交给补丁 A 的增量监视）');
    eq(h.calls.scan, 1, 'R15 扫描了库里已有文件');
    eq(h.calls.seed.length, 1, 'R15 写入了认领表');
    const entries = h.calls.seed[0].entries;
    eq(entries.length, 2, 'R15 认领 2 篇（第三篇无人认领）');
    const byId = Object.fromEntries(entries);
    eq(byId.n1, '目录/原文件.md', 'R15 按 frontmatter 标题认领（标题与文件名不同也对得上）');
    eq(byId.n2, '目录/按文件名.md', 'R15 按文件名主干认领');
    eq(h.store.get('ink-fs-mirror-init'), 'V:/库|v4', 'R15 记下已对账的库目录');
  }

  // ============ R16 已对账过 → 不再重复全量拉取 ============
  {
    const h = load({
      vault: 'V:/库',
      initKey: 'V:/库|v4',
      idmapCount: 2,
      scanResult: [{ rel: 'a.md', stem: 'a', fmTitle: null }],
    });
    h.tables.notes.rows.set('n1', note('n1', { title: 'a' }));
    h.tables.noteContent.rows.set('n1', content('n1', 'x'));
    await h.ctx.window.__inkFsMirror.bootstrapNow(h);
    eq(h.calls.rg, 0, 'R16 已对账则不重复全量拉取');
    eq(h.calls.seed.length, 0, 'R16 已有归属也不重新认领');
    eq(h.calls.apply.length, 1, 'R16 仍然做一次落盘检查（启动即自愈）');
  }

  // ============ R17 认领时每个文件只被认领一次 ============
  {
    const h = load({
      vault: 'V:/库',
      scanResult: [{ rel: '同一个.md', stem: '同一个', fmTitle: null }],
    });
    h.tables.notes.rows.set('n1', note('n1', { title: '同一个' }));
    h.tables.notes.rows.set('n2', note('n2', { title: '同一个' }));
    h.tables.noteContent.rows.set('n1', content('n1', 'a'));
    h.tables.noteContent.rows.set('n2', content('n2', 'b'));
    await fullBootstrap(h);
    const entries = h.calls.seed.length ? h.calls.seed[0].entries : [];
    eq(entries.length, 1, 'R17 一个文件只认领给一篇笔记');
  }

  // ============ R18 失败不致命 ============
  {
    const h = load({ vault: 'V:/库' });
    h.ctx.window.inkNotes.fsApply = async () => {
      throw new Error('模拟主进程异常');
    };
    const n = note('n1');
    h.tables.notes.rows.set('n1', n);
    h.tables.noteContent.rows.set('n1', content('n1', 'x'));
    h.tables.notes.fire('creating', 'n1', n);
    await flushNow(h);
    const st = h.ctx.window.__inkFsMirror.status();
    eq(st.stats.failed, 1, 'R18 记录失败计数');
    eq(st.stats.lastError, '模拟主进程异常', 'R18 记录失败原因');
  }

  // ============ R19 同名笔记按所在目录各自认领 ============
  {
    const h = load({
      vault: 'V:/库',
      scanResult: [
        { rel: '甲/同名.md', stem: '同名', fmTitle: null },
        { rel: '乙/同名.md', stem: '同名', fmTitle: null },
      ],
    });
    h.tables.folders.rows.set('fA', { id: 'fA', name: '甲', parentId: null });
    h.tables.folders.rows.set('fB', { id: 'fB', name: '乙', parentId: null });
    h.tables.notes.rows.set('nA', note('nA', { title: '同名', folderId: 'fA' }));
    h.tables.notes.rows.set('nB', note('nB', { title: '同名', folderId: 'fB' }));
    h.tables.noteContent.rows.set('nA', content('nA', 'a'));
    h.tables.noteContent.rows.set('nB', content('nB', 'b'));
    await fullBootstrap(h);
    const byId = Object.fromEntries(h.calls.seed[0].entries);
    eq(byId.nA, '甲/同名.md', 'R19 同名笔记按所在目录对上甲的文件');
    eq(byId.nB, '乙/同名.md', 'R19 同名笔记按所在目录对上乙的文件');
  }

  // ============ R20 首次对账预检：认领率不对时停手，不碰用户的库 ============
  {
    const h = load({ vault: 'V:/库' }); // 空扫描结果 → 一个都认领不上
    for (let i = 0; i < 60; i += 1) {
      h.tables.notes.rows.set('m' + i, note('m' + i));
      h.tables.noteContent.rows.set('m' + i, content('m' + i, 'x'));
    }
    await fullBootstrap(h);
    const dry = h.calls.apply.filter((c) => c.dryRun);
    const real = h.calls.apply.filter((c) => !c.dryRun);
    eq(dry.length, 2, 'R20 60 篇分两批预演');
    eq(real.length, 0, 'R20 预检未过时一个文件都不写');
    eq(!!h.store.get('ink-fs-mirror-blocked'), true, 'R20 记下被拦下的计划备查');
    eq(h.store.get('ink-fs-mirror-init'), undefined, 'R20 不标记已对账（下次启动重新预检）');
  }

  // ============ R21 预检通过（认领为主）→ 正常落盘 ============
  {
    const h = load({ vault: 'V:/库', planFor: () => 'adopt' });
    for (let i = 0; i < 60; i += 1) {
      h.tables.notes.rows.set('m' + i, note('m' + i));
      h.tables.noteContent.rows.set('m' + i, content('m' + i, 'x'));
    }
    await fullBootstrap(h);
    eq(h.calls.apply.filter((c) => c.dryRun).length, 2, 'R21 先预演');
    eq(h.calls.apply.filter((c) => !c.dryRun).length, 2, 'R21 全部认领时照常落盘');
    eq(h.store.get('ink-fs-mirror-init'), 'V:/库|v4', 'R21 标记为已对账');
  }

  // ============ R22 人工放行开关 ============
  {
    const h = load({ vault: 'V:/库' });
    h.store.set('ink-fs-mirror-force', '1');
    for (let i = 0; i < 60; i += 1) {
      h.tables.notes.rows.set('m' + i, note('m' + i));
      h.tables.noteContent.rows.set('m' + i, content('m' + i, 'x'));
    }
    await fullBootstrap(h);
    eq(h.calls.apply.filter((c) => c.dryRun).length, 0, 'R22 放行后跳过预检');
    eq(h.calls.apply.filter((c) => !c.dryRun).length, 2, 'R22 直接落盘');
  }

  // ============ R23 分批全量导入：把磁盘上还没入库的文本笔记读进库 ============
  {
    const many = [];
    for (let i = 0; i < 95; i += 1) many.push({ rel: '目录/笔记' + i + '.md', name: '笔记' + i + '.md', dirPath: '目录' });
    many.push({ rel: '附件/资料.pdf', name: '资料.pdf', dirPath: '附件' });
    const h = load({ vault: 'V:/库', manifest: many });
    const res = await h.ctx.window.__inkFsMirror.importAll();
    eq(res.ok, true, 'R23 导入返回 ok');
    eq(h.calls.manifest, 1, 'R23 取了一次清单（只 stat）');
    eq(res.counts.files, 95, 'R23 默认只处理 md/txt，跳过 PDF/Word');
    eq(res.counts.batches, 3, 'R23 95 个文件分 3 批（每批 40）');
    eq(h.calls.readFiles[0].length, 40, 'R23 第一批读 40 个');
    eq(h.calls.readFiles[2].length, 15, 'R23 最后一批读 15 个');
    eq(res.counts.created, 95, 'R23 累计了官方合并的统计');
  }

  // ============ R24 显式打开二进制开关时连 PDF/Word 一起导入 ============
  {
    const h = load({
      vault: 'V:/库',
      manifest: [
        { rel: 'a.md', name: 'a.md', dirPath: '' },
        { rel: 'b.pdf', name: 'b.pdf', dirPath: '' },
      ],
    });
    const res = await h.ctx.window.__inkFsMirror.importAll({ includeBinary: true });
    eq(res.counts.files, 2, 'R24 打开开关后包含 PDF');
  }

  // ============ R25 没有原生桥时不抛错 ============
  {
    const h = load({ vault: 'V:/库', noBridge: true });
    const res = await h.ctx.window.__inkFsMirror.importAll();
    eq(res.ok, false, 'R25 无桥时明确失败而不是抛异常');
  }

  // ============ R26 首次对账会先把磁盘文件导进来，再认领、再落盘 ============
  {
    const h = load({ vault: 'V:/库', manifest: [{ rel: '新笔记.md', name: '新笔记.md', dirPath: '' }] });
    await fullBootstrap(h);
    eq(h.calls.manifest, 1, 'R26 首次对账取了仓库清单');
    ok(h.calls.lgPayloads.length >= 1, 'R26 调用了官方增量合并 LG');
    eq(h.calls.lgPayloads[0][0], '新笔记.md', 'R26 合并的就是磁盘上的文件');
  }

  console.log('\n渲染层文件优先补丁单测：通过 ' + pass + '，失败 ' + failures.length);
  if (failures.length > 0) {
    console.log('失败用例：\n  - ' + failures.join('\n  - '));
    process.exit(1);
  }
})().catch((err) => {
  console.error('测试崩溃：', err);
  process.exit(1);
});
