// 自动拉取补丁的逻辑单测（不依赖 Electron，用 vm 模拟运行环境）
// 用法：node test-auto-pull.cjs
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SNIPPET = path.join(__dirname, 'src', 'auto-pull.snippet.js');
const source = fs.readFileSync(SNIPPET, 'utf8');

const silent = { log: () => {}, warn: () => {}, error: () => {} };
let pass = 0;
let fail = 0;
function assert(cond, label, extra) {
  if (cond) {
    pass++;
    console.log('  ✓ ' + label);
  } else {
    fail++;
    console.log('  ✗ ' + label + (extra ? '  → ' + JSON.stringify(extra) : ''));
  }
}

function makeFile(rel, mtimeMs, text) {
  const data = Buffer.from(text, 'utf8');
  const slash = rel.lastIndexOf('/');
  return {
    rel,
    dirPath: slash >= 0 ? rel.slice(0, slash) : '',
    name: slash >= 0 ? rel.slice(slash + 1) : rel,
    mtimeMs,
    size: data.length,
    data,
    lastModified: mtimeMs,
  };
}

function buildEnv(opts) {
  const state = {
    gate: opts.gate !== false,
    dir: opts.dir === undefined ? 'D:/vault' : opts.dir,
    lastSync: opts.lastSync || 0,
  };
  const calls = { watch: [], unwatch: 0, read: [], manifest: [], log: [], lg: [], rg: 0 };
  let changedCb = null;
  const store = {};
  if (state.lastSync) store['ink-obsidian-last-sync'] = String(state.lastSync);

  const vaultFiles = opts.files || [];
  const api = {
    watchVault: async (dir) => {
      calls.watch.push(dir);
      return { ok: true, dir };
    },
    unwatchVault: async () => {
      calls.unwatch++;
      return { ok: true };
    },
    readVaultFiles: async (dir, rels) => {
      calls.read.push({ dir, rels: rels.slice() });
      return vaultFiles
        .filter((f) => rels.includes(f.rel))
        .map((f) => ({ dirPath: f.dirPath, name: f.name, lastModified: f.lastModified, data: f.data }));
    },
    vaultManifest: async (dir) => {
      calls.manifest.push(dir);
      return vaultFiles.map((f) => ({ rel: f.rel, dirPath: f.dirPath, name: f.name, mtimeMs: f.mtimeMs, size: f.size }));
    },
    onVaultChanged: (cb) => {
      changedCb = cb;
      return true;
    },
    logAutoPull: (info) => {
      calls.log.push(info);
      return { ok: true };
    },
  };

  const timers = { timeouts: [], intervals: [] };
  const ctx = {
    window: { inkNotes: api },
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => {
        store[k] = String(v);
      },
      removeItem: (k) => {
        delete store[k];
      },
    },
    console: silent,
    setTimeout: (fn, ms) => {
      timers.timeouts.push({ fn, ms });
      return timers.timeouts.length;
    },
    setInterval: (fn, ms) => {
      timers.intervals.push({ fn, ms });
      return timers.intervals.length;
    },
    clearTimeout: () => {},
    clearInterval: () => {},
    NG: () => state.dir,
    FG: () => state.gate,
    RG: async () => {
      calls.rg++;
      return { ok: true, summary: { total: 3, created: 2, updated: 1, unchanged: 0, failed: 0, skipped: 0 } };
    },
    LG: async (entries) => {
      for (const e of entries) {
        const buf = await e.read();
        calls.lg.push({ dirPath: e.dirPath, name: e.name, lastModified: e.lastModified, bytes: buf.byteLength });
      }
      return { total: entries.length, created: 1, updated: Math.max(0, entries.length - 1), unchanged: 0, failed: 0, skipped: 0 };
    },
    Uint8Array,
  };
  vm.createContext(ctx);
  vm.runInContext(source, ctx);
  const flush = async (n = 6) => {
    for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
  };
  return { ctx, calls, state, store, api, flush, fire: (payload) => changedCb && changedCb(payload), timers };
}

(async () => {
  console.log('=== T1 补丁加载 + 启动即开始监视 ===');
  {
    const env = buildEnv({ files: [makeFile('a.md', 1000, 'hi')] });
    await env.flush();
    assert(env.ctx.window.__inkAutoPullInstalled === true, '已安装标记存在');
    assert(env.calls.watch.length === 1 && env.calls.watch[0] === 'D:/vault', 'watchVault 以配置目录被调用', env.calls.watch);
    assert(env.calls.log.some((l) => l.reason === 'watch' && l.ok === true), '上报 watch 日志');
    assert(env.ctx.window.__inkAutoPull && env.ctx.window.__inkAutoPull.version === 1, '调试口 __inkAutoPull 已暴露');
  }

  console.log('\n=== T2 仓库变化 → 只读变化的文件并增量合并 ===');
  {
    const files = [makeFile('a.md', 5000, 'one'), makeFile('sub/b.md', 6000, 'two'), makeFile('c.md', 1000, 'old')];
    const env = buildEnv({ files });
    await env.flush();
    env.fire({ dir: 'D:/vault', files: ['a.md', 'sub/b.md'] });
    await env.flush(10);
    const r = env.calls.read[0];
    assert(!!r && r.rels.length === 2 && r.rels.includes('sub/b.md'), '只请求变化的 2 个文件', r && r.rels);
    assert(env.calls.lg.length === 2, 'LG 收到 2 个条目', env.calls.lg);
    const entry = env.calls.lg.find((e) => e.name === 'b.md');
    assert(!!entry && entry.dirPath === 'sub' && entry.lastModified === 6000 && entry.bytes === 3, '条目结构（dirPath/name/lastModified/read→ArrayBuffer）正确', entry);
    assert(env.calls.log.some((l) => l.reason === 'watch' && l.ok === true && l.counts && l.counts.created === 1), '上报合并结果统计');
  }

  console.log('\n=== T3 关掉「自动拉取」开关后不拉取 ===');
  {
    const env = buildEnv({ gate: false, files: [makeFile('a.md', 5000, 'one')] });
    await env.flush();
    env.fire({ dir: 'D:/vault', files: ['a.md'] });
    await env.flush(10);
    assert(env.calls.read.length === 0, 'FG()=false 时不读取仓库', env.calls.read.length);
    const r = await env.ctx.window.__inkAutoPull.startupCatchUp();
    assert(r && r.skipped === 'disabled', '启动补拉同样被开关拦住', r);
  }

  console.log('\n=== T4 启动补拉：按 mtime 只取上次同步之后变化的文件 ===');
  {
    const files = [makeFile('new1.md', 10000, 'n1'), makeFile('new2.md', 12000, 'n2'), makeFile('old.md', 3000, 'o')];
    const env = buildEnv({ files, lastSync: 8000 });
    await env.flush();
    const r = await env.ctx.window.__inkAutoPull.startupCatchUp();
    await env.flush(30);
    assert(env.calls.read.length === 1, '只发起 1 批读取', env.calls.read.length);
    const rels = env.calls.read[0].rels;
    assert(rels.length === 2 && !rels.includes('old.md'), '只拉取 mtime 晚于上次同步的 2 个文件', rels);
    assert(env.calls.lg.length === 2, '两个文件都进入增量合并', env.calls.lg.length);
    assert(r && r.changed === 2 && r.batches === 1, '返回统计：changed=2, batches=1', r);
  }

  console.log('\n=== T5 启动补拉：大批量按 40 个/批分片 ===');
  {
    const files = [];
    for (let i = 0; i < 45; i++) files.push(makeFile('n' + i + '.md', 9000 + i, 'x'));
    const env = buildEnv({ files, lastSync: 1000 });
    await env.flush();
    const r = await env.ctx.window.__inkAutoPull.startupCatchUp();
    await env.flush(40);
    assert(r && r.batches === 2, '45 个文件分成 2 批', r);
    assert(env.calls.read.length === 2 && env.calls.read[0].rels.length === 40 && env.calls.read[1].rels.length === 5, '每批 40 / 5 个', env.calls.read.map((x) => x.rels.length));
    assert(r.applied === 45, '45 个文件全部合并（created+updated）', r.applied);
  }

  console.log('\n=== T6 无变化 / 未配置目录时的行为 ===');
  {
    const env = buildEnv({ files: [makeFile('a.md', 1000, 'a')], lastSync: 9999999 });
    await env.flush();
    const r = await env.ctx.window.__inkAutoPull.startupCatchUp();
    assert(r && r.skipped === 'no-changes', '清单均未变化时不做任何读取', r);
    assert(env.calls.read.length === 0, '确实没有读取文件', env.calls.read.length);

    const env2 = buildEnv({ dir: null, files: [] });
    await env.flush();
    const r2 = await env2.ctx.window.__inkAutoPull.startupCatchUp();
    assert(r2 && r2.skipped === 'no-dir', '未配置目录时不拉取', r2);
    assert(env2.calls.unwatch === 1 || env2.calls.watch.length === 0, '未配置目录时不会去监视', { watch: env2.calls.watch, unwatch: env2.calls.unwatch });
  }

  console.log('\n=== T7 目录配置变化后自动改监视目标 ===');
  {
    const env = buildEnv({ files: [makeFile('a.md', 1000, 'a')] });
    await env.flush();
    assert(env.calls.watch.length === 1 && env.calls.watch[0] === 'D:/vault', '初始监视目标正确', env.calls.watch);
    env.state.dir = 'D:/another-vault';
    env.timers.intervals[0].fn(); // 模拟 5 秒轮询回调
    await env.flush();
    assert(env.calls.watch.includes('D:/another-vault'), '轮询发现目录变化后监视新目录', env.calls.watch);
    assert(env.timers.intervals.length === 1 && env.timers.intervals[0].ms === 5000, '存在 5 秒轮询以跟随目录配置变化', env.timers.intervals.map((t) => t.ms));
    const st = env.ctx.window.__inkAutoPull;
    env.state.dir = 'D:/third-vault';
    await st.watchState();
    assert(env.calls.watch[env.calls.watch.length - 1] === 'D:/third-vault', '调试口 watchState 立即跟随最新配置', env.calls.watch.slice(-2));
  }

  console.log('\n=== T8 重复注入保护 ===');
  {
    const env = buildEnv({ files: [] });
    await env.flush();
    const before = env.calls.watch.length;
    vm.runInContext(source, env.ctx); // 再注入一次
    await env.flush();
    assert(env.calls.watch.length === before, '二次加载补丁不会重复注册监视', { before, after: env.calls.watch.length });
  }

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail === 0 ? 0 : 1);
})();
