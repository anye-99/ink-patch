/* [ink-patch v2] 导出下拉菜单
 *
 * 目的：把编辑器工具栏右侧的「导出 MD」「导出 Word」两个按钮合并为一个「导出」按钮，
 *       点击后弹出小菜单，从中选择 Markdown 或 Word。
 *
 * 注入方式：pack.cjs 把工具栏里那两个 button 的 JSX 文本替换为单个 button（onClick 调用本函数），
 *           并把本文件追加到入口 bundle 末尾。函数声明在同一模块作用域内，渲染时可直接引用。
 *
 * 设计取舍：
 *   - 不用 React state（工具栏那段 JSX 是条件渲染，在其中调 useState 会破坏 hooks 顺序），
 *     改为原生 DOM 浮层，样式用应用已有的 CSS 变量，缺失时回退到浅色主题色值。
 *   - 任何异常都不得影响导出本身：创建菜单失败时直接执行 Markdown 导出。
 */

var __inkExportMenuInstalled = true; // pack.cjs 用它检测是否重复打补丁

var INK_EXPORT_MENU_ID = 'ink-export-menu';
var INK_EXPORT_MENU_STYLE_ID = 'ink-export-menu-style';
var INK_EXPORT_MENU_WIDTH = 196;

function __inkExportMenuEnsureStyle(doc) {
  if (doc.getElementById(INK_EXPORT_MENU_STYLE_ID)) return;
  var style = doc.createElement('style');
  style.id = INK_EXPORT_MENU_STYLE_ID;
  style.textContent =
    '#' + INK_EXPORT_MENU_ID + '{position:fixed;z-index:2147483000;padding:6px;display:flex;flex-direction:column;gap:2px;' +
    'background:var(--panel,var(--bg,#fff));border:1px solid var(--border,#e2e8f0);border-radius:var(--radius,12px);' +
    'box-shadow:0 18px 40px -12px rgba(15,23,42,.35);font-size:13px;line-height:1.5;color:var(--text,#0f172a);' +
    'animation:ink-export-menu-in .12s cubic-bezier(.16,1,.3,1)}' +
    '@keyframes ink-export-menu-in{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}' +
    '#' + INK_EXPORT_MENU_ID + ' .ink-export-item{display:flex;align-items:center;gap:8px;width:100%;padding:8px 10px;' +
    'border:none;background:transparent;border-radius:var(--radius-sm,8px);color:inherit;font:inherit;cursor:pointer;' +
    'text-align:left;transition:background .12s}' +
    '#' + INK_EXPORT_MENU_ID + ' .ink-export-item:hover{background:var(--hover,rgba(15,23,42,.07))}' +
    '#' + INK_EXPORT_MENU_ID + ' .ink-export-item .ink-export-label{font-weight:500}' +
    '#' + INK_EXPORT_MENU_ID + ' .ink-export-item .ink-export-ext{margin-left:auto;color:var(--text-dim,#94a3b8);font-size:11px;letter-spacing:.02em}';
  (doc.head || doc.documentElement).appendChild(style);
}

/**
 * 在 anchor 按钮下方弹出导出格式菜单。
 * @param {Element} anchor 触发按钮
 * @param {object} note 传给导出函数的笔记对象（{...note, title, content}）
 * @param {Function} exportMd Markdown 导出
 * @param {Function} exportWord Word(.docx) 导出
 */
function __inkExportMenu(anchor, note, exportMd, exportWord) {
  try {
    var doc = (anchor && anchor.ownerDocument) || document;
    var win = (doc && doc.defaultView) || window;

    // 已打开：点击同一按钮＝收起；点击另一个按钮＝换位置重开
    var opened = doc.getElementById(INK_EXPORT_MENU_ID);
    if (opened) {
      var same = opened.__inkAnchor === anchor;
      if (typeof opened.__inkClose === 'function') opened.__inkClose();
      if (same) return;
    }

    __inkExportMenuEnsureStyle(doc);

    var menu = doc.createElement('div');
    menu.id = INK_EXPORT_MENU_ID;
    menu.setAttribute('role', 'menu');
    menu.__inkAnchor = anchor;
    menu.style.minWidth = INK_EXPORT_MENU_WIDTH + 'px';

    var entries = [
      { label: 'Markdown 文件', ext: '.md', title: '导出为 Markdown 文件', run: exportMd },
      { label: 'Word 文档', ext: '.docx', title: '导出为 Word (.docx) 文档', run: exportWord },
    ];

    var closed = false;
    function close() {
      if (closed) return;
      closed = true;
      doc.removeEventListener('mousedown', onDocMouseDown, true);
      doc.removeEventListener('keydown', onKeyDown, true);
      win.removeEventListener('resize', close, true);
      win.removeEventListener('scroll', close, true);
      if (menu.parentNode) menu.parentNode.removeChild(menu);
    }
    function onDocMouseDown(ev) {
      var t = ev.target;
      if (menu.contains(t)) return;
      if (anchor && (anchor === t || (anchor.contains && anchor.contains(t)))) return;
      close();
    }
    function onKeyDown(ev) {
      if (ev.key === 'Escape' || ev.keyCode === 27) close();
    }
    menu.__inkClose = close;

    for (var i = 0; i < entries.length; i++) {
      (function (entry) {
        var btn = doc.createElement('button');
        btn.type = 'button';
        btn.className = 'ink-export-item';
        btn.title = entry.title;
        var label = doc.createElement('span');
        label.className = 'ink-export-label';
        label.textContent = entry.label;
        var ext = doc.createElement('span');
        ext.className = 'ink-export-ext';
        ext.textContent = entry.ext;
        btn.appendChild(label);
        btn.appendChild(ext);
        btn.addEventListener('click', function (ev) {
          if (ev && ev.preventDefault) ev.preventDefault();
          if (ev && ev.stopPropagation) ev.stopPropagation();
          close();
          try {
            var r = entry.run(note);
            if (r && typeof r.then === 'function') {
              r.catch(function (err) {
                console.warn('[ink-patch] 导出失败：', err);
              });
            }
          } catch (err) {
            console.warn('[ink-patch] 导出失败：', err);
          }
        });
        menu.appendChild(btn);
      })(entries[i]);
    }

    // 先隐藏挂载以量高度，再按按钮位置摆放（空间不足时翻到按钮上方）
    menu.style.visibility = 'hidden';
    (doc.body || doc.documentElement).appendChild(menu);

    var rect = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { right: 0, bottom: 0, top: 0, left: 0 };
    var menuHeight = menu.offsetHeight || 92;
    var viewportW = win.innerWidth || 1024;
    var viewportH = win.innerHeight || 768;
    var left = Math.min(Math.max(8, rect.right - INK_EXPORT_MENU_WIDTH), Math.max(8, viewportW - INK_EXPORT_MENU_WIDTH - 8));
    var top = rect.bottom + 6;
    if (top + menuHeight > viewportH - 8) top = Math.max(8, rect.top - menuHeight - 6);
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
    menu.style.visibility = '';

    doc.addEventListener('mousedown', onDocMouseDown, true);
    doc.addEventListener('keydown', onKeyDown, true);
    win.addEventListener('resize', close, true);
    win.addEventListener('scroll', close, true);
  } catch (err) {
    console.warn('[ink-patch] 导出菜单创建失败，已回退为直接导出 Markdown：', err);
    try {
      if (typeof exportMd === 'function') exportMd(note);
    } catch (e) {
      console.warn('[ink-patch] 回退导出也失败：', e);
    }
  }
}
