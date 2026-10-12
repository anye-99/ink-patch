// 主进程文件服务单测：把 electron-main.cjs 加载进 vm（mock electron），直接调用它注册的 IPC handler，
// 在真实临时目录上验证落盘行为（路径分配、幂等、改名、冲突退让、回收站、认领、idmap 持久化）。
// 用法：node test-fs-service.cjs
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const MAIN = path.join(__dirname, 'src', 'electron-main.cjs');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ink-fs-test-'));

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

function loadMain() {
  const handlers = new Map();
  const electronMock = {
    app: {
      isPackaged: false,
      getPath: () => ROOT,
      whenReady: () => Promise.resolve(),
      on: () => {},
      quit: () => {},
    },
    BrowserWindow: function BrowserWindow() {
      this.webContents = {
        on: () => {},
        send: () => {},
        setWindowOpenHandler: () => {},
        openDevTools: () => {},
      };
      this.loadFile = () => {};
      this.loadURL = () => {};
      this.isDestroyed = () => false;
      return this;
    },
    Menu: { setApplicationMenu: () => {}, append: () => {}, popup: () => {} },
    MenuItem: function MenuItem() {},
    ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
    net: { fetch: async () => ({ status: 0, headers: { forEach: () => {} }, arrayBuffer: async () => new ArrayBuffer(0) }) },
    shell: { openExternal: () => {} },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  };
  const ctx = {
    require: (id) => (id === 'electron' ? electronMock : require(id)),
    module: { exports: {} },
    exports: {},
    console,
    process,
    Buffer,
    setTimeout,
    clearTimeout,
    __dirname: path.join(__dirname, 'src'),
    __filename: MAIN,
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(MAIN, 'utf8'), ctx, { filename: MAIN });
  return handlers;
}

const handlers = loadMain();
function call(channel, payload) {
  const fn = handlers.get(channel);
  if (!fn) throw new Error('未注册的 IPC：' + channel);
  return fn({}, payload);
}

function mkVault(name) {
  const dir = path.join(ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function readIf(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}
function exists(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
function listFiles(dir, base) {
  const out = [];
  const root = base || dir;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...listFiles(full, root));
    else out.push(path.relative(root, full).split(path.sep).join('/'));
  }
  return out;
}

(async () => {
  // ---- 等 whenReady 的 then 回调把 handler 注册完
  await new Promise((r) => setImmediate(r));
  ok(handlers.has('ink:fs-apply'), '注册了 ink:fs-apply');
  ok(handlers.has('ink:fs-scan'), '注册了 ink:fs-scan');
  ok(handlers.has('ink:fs-seed'), '注册了 ink:fs-seed');
  ok(handlers.has('ink:fs-idmap'), '注册了 ink:fs-idmap');
  ok(handlers.has('ink:watch-vault'), '补丁 A 的 watcher 接口仍在');
  ok(handlers.has('ink:read-local-vault'), '官方读仓库接口仍在');

  // ============ T1 新建：目录层级 + 文件名净化 + 内容 ============
  {
    const vault = mkVault('t1');
    const res = await call('ink:fs-apply', {
      vaultPath: vault,
      items: [{ id: 'n1', kind: 'note', ext: '.md', title: '你好 世界', dirPath: '哲学/伦理', content: '正文一' }],
    });
    eq(res.ok, true, 'T1 apply ok');
    eq(res.results[0].wrote, true, 'T1 首次写入 wrote=true');
    eq(readIf(path.join(vault, '哲学', '伦理', '你好 世界.md')), '正文一', 'T1 文件落在净化后的目录并写入内容');
  }

  // ============ T2 幂等：内容没变不重写（也不产生文件事件） ============
  {
    const vault = path.join(ROOT, 't1');
    const res = await call('ink:fs-apply', {
      vaultPath: vault,
      items: [{ id: 'n1', kind: 'note', ext: '.md', title: '你好 世界', dirPath: '哲学/伦理', content: '正文一' }],
    });
    eq(res.results[0].wrote, false, 'T2 内容相同 → 不写文件（幂等，避免无谓 mtime 变化）');
    eq(readIf(path.join(vault, '哲学', '伦理', '你好 世界.md')), '正文一', 'T2 内容保持');
  }

  // ============ T3 改名：旧文件消失，新文件出现 ============
  {
    const vault = path.join(ROOT, 't1');
    const res = await call('ink:fs-apply', {
      vaultPath: vault,
      items: [{ id: 'n1', kind: 'note', ext: '.md', title: '改过的标题', dirPath: '哲学/伦理', content: '正文一', rename: true }],
    });
    eq(res.results[0].movedFrom, '哲学/伦理/你好 世界.md', 'T3 报告旧路径作为 movedFrom');
    ok(!exists(path.join(vault, '哲学', '伦理', '你好 世界.md')), 'T3 旧文件已移除');
    eq(readIf(path.join(vault, '哲学', '伦理', '改过的标题.md')), '正文一', 'T3 新文件已就位');
  }

  // ============ T4 冲突退让：路径被别的笔记占用 → 加 (2) ============
  {
    const vault = path.join(ROOT, 't1');
    const res = await call('ink:fs-apply', {
      vaultPath: vault,
      items: [{ id: 'n2', kind: 'note', ext: '.md', title: '改过的标题', dirPath: '哲学/伦理', content: '正文二' }],
    });
    eq(res.results[0].rel, '哲学/伦理/改过的标题 (2).md', 'T4 同名冲突时退让为 (2)');
    eq(readIf(path.join(vault, '哲学', '伦理', '改过的标题.md')), '正文一', 'T4 原文件未被覆盖');
  }

  // ============ T5 磁盘上已有内容相同的无主文件 → 认领，不产生副本 ============
  {
    const vault = mkVault('t5');
    fs.mkdirSync(path.join(vault, '目录'), { recursive: true });
    fs.writeFileSync(path.join(vault, '目录', 'A.md'), 'X 正文', 'utf8');
    const res = await call('ink:fs-apply', {
      vaultPath: vault,
      items: [{ id: 'a1', kind: 'note', ext: '.md', title: 'A', dirPath: '目录', content: 'X 正文' }],
    });
    eq(res.results[0].rel, '目录/A.md', 'T5 认领已有的同内容文件');
    eq(res.results[0].wrote, false, 'T5 认领时不重写');
    eq(listFiles(vault).filter((f) => f.endsWith('.md')).length, 1, 'T5 没有产生副本');
  }

  // ============ T6 磁盘上已有内容不同的同名文件 → 绝不覆盖，退让 ============
  {
    const vault = mkVault('t6');
    fs.mkdirSync(path.join(vault, '目录'), { recursive: true });
    fs.writeFileSync(path.join(vault, '目录', 'B.md'), '用户手写的内容', 'utf8');
    const res = await call('ink:fs-apply', {
      vaultPath: vault,
      items: [{ id: 'b1', kind: 'note', ext: '.md', title: 'B', dirPath: '目录', content: '墨记里的内容' }],
    });
    eq(res.results[0].rel, '目录/B (2).md', 'T6 同名不同内容时退让为 (2)');
    eq(readIf(path.join(vault, '目录', 'B.md')), '用户手写的内容', 'T6 用户文件完好无损');
  }

  // ============ T7 文件名净化：非法字符 / 保留名 / 空标题 / 结尾点 ============
  {
    const vault = mkVault('t7');
    const items = [
      { id: 's1', kind: 'note', title: 'a/b:c*d?e"f<g>h|i', dirPath: '', content: '1' },
      { id: 's2', kind: 'note', title: 'CON', dirPath: '', content: '2' },
      { id: 's3', kind: 'note', title: '   ', dirPath: '', content: '3' },
      { id: 's4', kind: 'note', title: '尾点...', dirPath: '', content: '4' },
      { id: 's5', kind: 'note', title: '尾空格   ', dirPath: ' 空 目录 / 子 ', content: '5' },
    ];
    const res = await call('ink:fs-apply', { vaultPath: vault, items });
    const rels = res.results.map((r) => r.rel);
    eq(rels[0], 'a_b_c_d_e_f_g_h_i.md', 'T7 非法字符替换为下划线');
    eq(rels[1], '_CON.md', 'T7 Windows 保留名加前缀');
    eq(rels[2], '未命名.md', 'T7 空标题回落为未命名');
    eq(rels[3], '尾点.md', 'T7 去掉结尾的点');
    eq(rels[4], '空 目录/子/尾空格.md', 'T7 目录段被净化且首尾空格裁剪');
  }

  // ============ T8 文件夹改名/移动：目录跟着变，文件名不变（keepName） ============
  {
    const vault = mkVault('t8');
    await call('ink:fs-apply', {
      vaultPath: vault,
      items: [{ id: 'k1', kind: 'note', title: '自定义文件名', dirPath: '旧目录', content: 'C' }],
    });
    ok(exists(path.join(vault, '旧目录', '自定义文件名.md')), 'T8 初始位置正确');
    const res = await call('ink:fs-apply', {
      vaultPath: vault,
      items: [{ id: 'k1', kind: 'note', title: '自定义文件名', dirPath: '新目录/深层', content: 'C', keepName: true }],
    });
    eq(res.results[0].rel, '新目录/深层/自定义文件名.md', 'T8 只换目录、保留文件名');
    ok(!exists(path.join(vault, '旧目录', '自定义文件名.md')), 'T8 旧位置已清理');
  }

  // ============ T9 删除 → 进回收站，不物理删 ============
  {
    const vault = path.join(ROOT, 't8');
    const res = await call('ink:fs-apply', { vaultPath: vault, items: [{ id: 'k1', kind: 'trash' }] });
    ok(!!res.results[0].trashed, 'T9 返回回收站路径');
    eq(res.results[0].trashed.indexOf('.trash/'), 0, 'T9 落在 .trash 下');
    ok(!exists(path.join(vault, '新目录', '深层', '自定义文件名.md')), 'T9 原位置文件已移走');
    eq(readIf(path.join(vault, ...res.results[0].trashed.split('/'))), 'C', 'T9 回收站里内容完好（可人工恢复）');
  }

  // ============ T10 idmap 持久化 ============
  {
    const vault = path.join(ROOT, 't1');
    const raw = readIf(path.join(vault, '.ink-notes', 'idmap.json'));
    ok(!!raw, 'T10 写出了 .ink-notes/idmap.json');
    const obj = JSON.parse(raw);
    eq(obj.kind, 'fs-mirror-idmap', 'T10 idmap 带类型标记');
    eq(obj.notes.n1, '哲学/伦理/改过的标题.md', 'T10 记录了笔记 → 文件归属');
  }

  // ============ T11 fs-scan：读取文件名主干与 frontmatter title ============
  {
    const vault = mkVault('t11');
    fs.mkdirSync(path.join(vault, '子'), { recursive: true });
    fs.writeFileSync(path.join(vault, '子', '文件名.md'), '---\ntitle: frontmatter 标题\ntags: [x]\n---\n正文', 'utf8');
    fs.writeFileSync(path.join(vault, '子', '朴素.md'), '没有 frontmatter', 'utf8');
    fs.mkdirSync(path.join(vault, '.trash'), { recursive: true });
    fs.writeFileSync(path.join(vault, '.trash', '忽略我.md'), 'x', 'utf8');
    const list = await call('ink:fs-scan', vault);
    eq(list.length, 2, 'T11 忽略 .trash 与隐藏目录');
    const withFm = list.find((x) => x.rel === '子/文件名.md');
    eq(withFm.stem, '文件名', 'T11 给出文件名主干');
    eq(withFm.fmTitle, 'frontmatter 标题', 'T11 解析出 frontmatter title');
    const plain = list.find((x) => x.rel === '子/朴素.md');
    eq(plain.fmTitle, null, 'T11 无 frontmatter 时 fmTitle 为空');
  }

  // ============ T12 fs-seed：只在没有归属记录时写入 ============
  {
    const vault = mkVault('t12');
    const r1 = await call('ink:fs-seed', { vaultPath: vault, entries: [['p1', '目录/一.md'], ['p2', '目录/二.md']] });
    eq(r1.seeded, 2, 'T12 首次 seed 写入 2 条');
    const r2 = await call('ink:fs-seed', { vaultPath: vault, entries: [['p3', '目录/三.md']] });
    eq(r2.skipped, true, 'T12 已有归属时跳过（不覆盖运行期稳定关系）');
    const r3 = await call('ink:fs-seed', { vaultPath: vault, entries: [['p3', '目录/三.md']], force: true });
    eq(r3.seeded, 1, 'T12 force 时允许补充');
    const idmap = await call('ink:fs-idmap', vault);
    eq(idmap.count, 3, 'T12 idmap 共 3 条');
  }

  // ============ T13 路径穿越防护 ============
  {
    const vault = mkVault('t13');
    const r = await call('ink:fs-seed', { vaultPath: vault, entries: [['x1', '../../evil.md']] });
    eq(r.seeded, 0, 'T13 seed 拒绝含 .. 的路径');
  }

  // ============ T14 空批次 / 不存在的库目录 ============
  {
    const vault = mkVault('t14');
    const r1 = await call('ink:fs-apply', { vaultPath: vault, items: [] });
    eq(r1.ok, true, 'T14 空批次返回 ok');
    eq(r1.count, 0, 'T14 空批次处理 0 条');
    const r2 = await call('ink:fs-apply', { vaultPath: path.join(vault, '不存在'), items: [{ id: 'z', title: 'a', content: 'b' }] });
    eq(r2.ok, false, 'T14 库目录不存在时明确失败');
    eq(r2.reason, 'vault-not-found', 'T14 失败原因可读');
    const r3 = await call('ink:fs-apply', { items: [{ id: 'z' }] });
    eq(r3.reason, 'no-vault', 'T14 没给库目录时明确失败');
  }

  // ============ T15 空内容与超长标题 ============
  {
    const vault = mkVault('t15');
    const long = '长'.repeat(300);
    const res = await call('ink:fs-apply', {
      vaultPath: vault,
      items: [
        { id: 'e1', kind: 'note', title: '空笔记', dirPath: '', content: '' },
        { id: 'e2', kind: 'note', title: long, dirPath: '', content: 'x' },
      ],
    });
    eq(res.results[0].wrote, true, 'T15 空内容也能建文件（合法的空笔记）');
    eq(readIf(path.join(vault, '空笔记.md')), '', 'T15 空文件内容为空');
    ok(res.results[1].rel.length <= 124, 'T15 超长标题被截断到安全长度（' + res.results[1].rel.length + '）');
  }

  // ============ T16 带 frontmatter 的文件：正文一致 → 不写，元数据原样保住 ============
  {
    const vault = mkVault('t16');
    const fm = '---\ntags:\n  - 知识点\n  - ch1\n---\n';
    fs.writeFileSync(path.join(vault, '知识点.md'), fm + '正文内容', 'utf8');
    const res = await call('ink:fs-apply', {
      vaultPath: vault,
      items: [{ id: 'f1', kind: 'note', title: '知识点', dirPath: '', content: '正文内容' }],
    });
    eq(res.results[0].wrote, false, 'T16 正文一致就不写（否则会抹掉 frontmatter）');
    eq(readIf(path.join(vault, '知识点.md')), fm + '正文内容', 'T16 frontmatter 原样保留');
  }

  // ============ T17 正文真的变了 → 更新正文，frontmatter 仍然保留 ============
  {
    const vault = path.join(ROOT, 't16');
    const fm = '---\ntags:\n  - 知识点\n  - ch1\n---\n';
    const res = await call('ink:fs-apply', {
      vaultPath: vault,
      items: [{ id: 'f1', kind: 'note', title: '知识点', dirPath: '', content: '改过的正文' }],
    });
    eq(res.results[0].wrote, true, 'T17 正文变化时写入');
    eq(readIf(path.join(vault, '知识点.md')), fm + '改过的正文', 'T17 只换正文，frontmatter 保留');
  }

  // ============ T18 只有行尾差异 → 视为同一份内容，不动文件 ============
  {
    const vault = mkVault('t18');
    fs.writeFileSync(path.join(vault, '行尾.md'), '第一行\r\n第二行\r\n', 'utf8');
    const res = await call('ink:fs-apply', {
      vaultPath: vault,
      items: [{ id: 'c1', kind: 'note', title: '行尾', dirPath: '', content: '第一行\n第二行\n' }],
    });
    eq(res.results[0].wrote, false, 'T18 CRLF / LF 差异不算内容变化');
    eq(readIf(path.join(vault, '行尾.md')), '第一行\r\n第二行\r\n', 'T18 文件一个字节都没动');
  }

  // ============ T19 认领带 frontmatter 的同名文件，不退让成副本 ============
  {
    const vault = mkVault('t19');
    fs.mkdirSync(path.join(vault, '夹'), { recursive: true });
    fs.writeFileSync(path.join(vault, '夹', '带元数据.md'), '---\ntags: [x]\n---\n正文', 'utf8');
    const res = await call('ink:fs-apply', {
      vaultPath: vault,
      items: [{ id: 'fm1', kind: 'note', title: '带元数据', dirPath: '夹', content: '正文' }],
    });
    eq(res.results[0].rel, '夹/带元数据.md', 'T19 认领带元数据的原文件');
    eq(listFiles(vault).filter((f) => f.endsWith('.md')).length, 1, 'T19 没有生成多余副本');
  }

  // ============ T20 同目录同标题的重复笔记（内容相同）共用同一个文件 ============
  {
    const vault = mkVault('t20');
    await call('ink:fs-apply', {
      vaultPath: vault,
      items: [{ id: 'dupA', kind: 'note', title: '题单', dirPath: '夹', content: '一样的内容' }],
    });
    const res = await call('ink:fs-apply', {
      vaultPath: vault,
      items: [
        { id: 'dupB', kind: 'note', title: '题单', dirPath: '夹', content: '一样的内容' },
        { id: 'dupC', kind: 'note', title: '题单', dirPath: '夹', content: '不同的内容' },
      ],
    });
    eq(res.results[0].rel, '夹/题单.md', 'T20 重复笔记共用同一个文件，不造副本');
    eq(res.results[0].wrote, false, 'T20 共用时也不重写');
    eq(res.results[1].rel, '夹/题单 (2).md', 'T20 只有内容真的不同才退让到 (2)');
    eq(listFiles(vault).filter((f) => f.endsWith('.md')).length, 2, 'T20 磁盘上一共只有两个文件');
  }

  // ============ T21 磁盘侧删掉的文件不会被「复活」 ============
  {
    const vault = mkVault('t21');
    await call('ink:fs-apply', {
      vaultPath: vault,
      items: [{ id: 'gone', kind: 'note', title: '被删的笔记', dirPath: '', content: '正文' }],
    });
    ok(exists(path.join(vault, '被删的笔记.md')), 'T21 首次正常落盘');
    fs.unlinkSync(path.join(vault, '被删的笔记.md')); // 模拟用户在 Obsidian 里删除
    const res = await call('ink:fs-apply', {
      vaultPath: vault,
      items: [{ id: 'gone', kind: 'note', title: '被删的笔记', dirPath: '', content: '正文' }],
    });
    eq(res.results[0].skipped, true, 'T21 文件已被删 → 跳过，不复活');
    eq(res.results[0].reason, 'deleted-on-disk', 'T21 给出明确原因');
    eq(exists(path.join(vault, '被删的笔记.md')), false, 'T21 文件确实没有被重建');
  }

  // ============ T22 明确改名时不受「磁盘已删」影响，新位置照常建出来 ============
  {
    const vault = path.join(ROOT, 't21');
    const res = await call('ink:fs-apply', {
      vaultPath: vault,
      items: [{ id: 'gone', kind: 'note', title: '新名字', dirPath: '', content: '正文', rename: true }],
    });
    eq(res.results[0].skipped, undefined, 'T22 改名时照常创建新文件');
    ok(exists(path.join(vault, '新名字.md')), 'T22 新文件已建立');
  }

  // 清理临时目录
  try {
    fs.rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }

  console.log('\n主进程文件服务单测：通过 ' + pass + '，失败 ' + failures.length);
  if (failures.length > 0) {
    console.log('失败用例：\n  - ' + failures.join('\n  - '));
    process.exit(1);
  }
})().catch((err) => {
  console.error('测试崩溃：', err);
  process.exit(1);
});
