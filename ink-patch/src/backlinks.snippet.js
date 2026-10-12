/* ===== [backlinks] 墨记反向链接（Backlinks）面板补丁 v1 =====
 *
 * 能力：
 *   1) 右侧抽屉式「反向链接」面板（原生 DOM，纯 CSS 变量适配，与 AI 助手无缝互斥）
 *   2) 已链接提及（Linked Mentions）：精准匹配 [[当前笔记]]、[[当前笔记|别名]]、[[当前笔记#章节]]
 *   3) 未链接提及（Unlinked Mentions）：检测包含当前笔记名称但未建立双链的正文段落，支持一键「转化为双链」
 *   4) 上下文摘录（Context Excerpts）：展示包含该引用的上下文句子/行并高亮显示，附带行号
 *   5) 快速跳转：点击来源笔记标题或摘录段落，直接跳转并打开该笔记
 *   6) 实时同步：切换笔记时，面板自动跟随更新反向链接；工具栏按钮显示实时反链数
 *   7) 快捷键：Ctrl+Shift+B 切换面板开关；Esc 关闭
 */
var __inkBacklinksInstalled = true;

var __inkBacklinksApi = (function () {
  'use strict';

  var PANEL_ID = 'ink-backlinks-panel';
  var STYLE_ID = 'ink-backlinks-style';
  var WIKILINK_RE = /(!?)\[\[([^\[\]|#\n]+)(?:#([^\[\]|\n]*))?(?:\|([^\[\]\n]*))?\]\]/g;
  var CODE_BLOCK_RE = /(```[\s\S]*?```|~~~[\s\S]*?~~~)/g;
  var INLINE_CODE_RE = /(`[^`\n]+`)/g;
  var MD_LINK_RE = /\[([^\]\n]+)\]\(([^)\n]+)\)/g;

  var state = {
    open: false,
    activeTab: 'linked', // 'linked' | 'unlinked'
    currentNote: null,
    navFn: null,
    searchFilter: '',
    loading: false,
    linkedResults: [],
    unlinkedResults: [],
    lastScannedId: null,
    lastScannedTitle: null,
    syncTimer: null
  };

  var dom = {};

  function getDb() {
    try {
      if (typeof _ !== 'undefined' && _ && _.notes && _.noteContent) return _;
      if (typeof window !== 'undefined' && window.__inkDb) return window.__inkDb;
    } catch (e) {
      /* ignore */
    }
    return null;
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function normTitle(t) {
    return String(t || '').trim().toLowerCase();
  }

  // ---------------------------------------------------------------- DOM 构造辅助
  function h(tag, props, children) {
    var el = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        var v = props[k];
        if (v == null) return;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'html') el.innerHTML = v;
        else if (k === 'style') Object.keys(v).forEach(function (s) { el.style[s] = v[s]; });
        else if (k === 'dataset') Object.keys(v).forEach(function (d) { el.dataset[d] = v[d]; });
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k in el) el[k] = v;
        else el.setAttribute(k, v);
      });
    }
    if (children) {
      (Array.isArray(children) ? children : [children]).forEach(function (c) {
        if (c == null || c === false) return;
        el.appendChild(typeof c === 'string' ? (document.createTextNode ? document.createTextNode(c) : { tagName: '#TEXT', _text: c }) : c);
      });
    }
    return el;
  }

  // ---------------------------------------------------------------- 纯函数：反向链接扫描算法

  /** 计算文件夹路径 */
  function buildFolderPaths(folders) {
    var map = new Map();
    if (!Array.isArray(folders)) return map;
    for (var i = 0; i < folders.length; i++) {
      var f = folders[i];
      if (f && f.id) map.set(f.id, f);
    }
    var pathMap = new Map();
    for (var j = 0; j < folders.length; j++) {
      var cur = folders[j];
      var parts = [];
      var guard = 0;
      var c = cur;
      while (c && guard++ < 50) {
        parts.unshift(c.name || '未命名文件夹');
        c = c.parentId ? map.get(c.parentId) : null;
      }
      pathMap.set(cur.id, parts.join(' / '));
    }
    return pathMap;
  }

  /** 计算匹配位置的行号与单行摘录 */
  function extractExcerpt(text, matchIndex, matchLength, targetSnippet) {
    if (typeof text !== 'string') return { line: 1, text: '', raw: '' };
    var prefix = text.slice(0, matchIndex);
    var line = (prefix.match(/\n/g) || []).length + 1;
    var lineStart = text.lastIndexOf('\n', matchIndex);
    lineStart = lineStart < 0 ? 0 : lineStart + 1;
    var lineEnd = text.indexOf('\n', matchIndex + matchLength);
    if (lineEnd < 0) lineEnd = text.length;
    var rawLine = text.slice(lineStart, lineEnd).trim();

    // 如果该行极长，截取以匹配词为中心的前后部分
    var lineMatchIdx = rawLine.toLowerCase().indexOf((targetSnippet || '').toLowerCase());
    var display = rawLine;
    if (rawLine.length > 140) {
      if (lineMatchIdx >= 0) {
        var start = Math.max(0, lineMatchIdx - 40);
        var end = Math.min(rawLine.length, lineMatchIdx + (targetSnippet ? targetSnippet.length : 10) + 50);
        display = (start > 0 ? '…' : '') + rawLine.slice(start, end).trim() + (end < rawLine.length ? '…' : '');
      } else {
        display = rawLine.slice(0, 130).trim() + '…';
      }
    }

    return {
      line: line,
      raw: rawLine,
      text: display
    };
  }

  /**
   * 扫描给定的笔记库，查找链接到 targetTitle 的所有笔记与未链接提及
   */
  function scanBacklinksCore(targetNote, notesList, contentsList, foldersList) {
    if (!targetNote || !targetNote.title) {
      return { linked: [], unlinked: [] };
    }
    var targetTitle = String(targetNote.title).trim();
    var targetNorm = normTitle(targetTitle);
    if (!targetNorm) return { linked: [], unlinked: [] };
    var targetId = targetNote.id;

    var folderPaths = buildFolderPaths(foldersList || []);
    var notesMap = new Map();
    if (Array.isArray(notesList)) {
      for (var i = 0; i < notesList.length; i++) {
        var n = notesList[i];
        if (n && n.id && !n.deletedAt) {
          notesMap.set(n.id, n);
        }
      }
    }

    var linkedMap = new Map(); // noteId -> { note, excerpts: [] }
    var unlinkedMap = new Map(); // noteId -> { note, excerpts: [] }

    if (Array.isArray(contentsList)) {
      for (var j = 0; j < contentsList.length; j++) {
        var cRow = contentsList[j];
        if (!cRow || !cRow.noteId || typeof cRow.content !== 'string') continue;
        var sId = cRow.noteId;
        if (sId === targetId) continue; // 排除当前笔记自身的自引用
        var srcNote = notesMap.get(sId);
        if (!srcNote) continue; // 笔记已删除或不存在

        var text = cRow.content;
        if (!text) continue;

        // 1. 已链接提及扫描
        var match;
        WIKILINK_RE.lastIndex = 0;
        while ((match = WIKILINK_RE.exec(text)) !== null) {
          var matchedTarget = match[2];
          if (normTitle(matchedTarget) === targetNorm) {
            var heading = match[3] ? match[3].trim() : '';
            var alias = match[4] ? match[4].trim() : '';
            var exc = extractExcerpt(text, match.index, match[0].length, match[0]);
            exc.heading = heading;
            exc.alias = alias;
            exc.rawLink = match[0];

            if (!linkedMap.has(sId)) {
              linkedMap.set(sId, {
                noteId: sId,
                noteTitle: srcNote.title || '未命名笔记',
                folderPath: folderPaths.get(srcNote.folderId) || '',
                excerpts: []
              });
            }
            linkedMap.get(sId).excerpts.push(exc);
          }
        }

        // 2. 未链接提及扫描（目标标题长度需 >= 2，避免单字误报）
        if (targetTitle.length >= 2) {
          // 遮蔽代码块、行内代码、已有的双链与外链
          var masked = text
            .replace(CODE_BLOCK_RE, function (m) { return ' '.repeat(m.length); })
            .replace(INLINE_CODE_RE, function (m) { return ' '.repeat(m.length); })
            .replace(WIKILINK_RE, function (m) { return ' '.repeat(m.length); })
            .replace(MD_LINK_RE, function (m) { return ' '.repeat(m.length); });

          var targetLen = targetTitle.length;
          var searchIdx = 0;
          var lowerMasked = masked.toLowerCase();
          var lowerTarget = targetNorm;
          var unlinkedExcerpts = [];

          while ((searchIdx = lowerMasked.indexOf(lowerTarget, searchIdx)) >= 0) {
            var origWord = text.slice(searchIdx, searchIdx + targetLen);
            var unExc = extractExcerpt(text, searchIdx, targetLen, origWord);
            unExc.mentionWord = origWord;
            unExc.charIndex = searchIdx;
            unlinkedExcerpts.push(unExc);
            searchIdx += targetLen;
            if (unlinkedExcerpts.length >= 10) break; // 单篇笔记最多保留 10 处未链接提及
          }

          if (unlinkedExcerpts.length > 0) {
            unlinkedMap.set(sId, {
              noteId: sId,
              noteTitle: srcNote.title || '未命名笔记',
              folderPath: folderPaths.get(srcNote.folderId) || '',
              excerpts: unlinkedExcerpts
            });
          }
        }
      }
    }

    var linked = Array.from(linkedMap.values());
    var unlinked = Array.from(unlinkedMap.values());

    var sorter = function (a, b) { return a.noteTitle.localeCompare(b.noteTitle, 'zh-CN'); };
    linked.sort(sorter);
    unlinked.sort(sorter);

    return { linked: linked, unlinked: unlinked };
  }

  // ---------------------------------------------------------------- DOM & 样式构建

  function ensureStyle(doc) {
    if (doc.getElementById(STYLE_ID)) return;
    var style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = [
      '#' + PANEL_ID + '{position:fixed;top:0;right:0;bottom:0;width:390px;max-width:100vw;z-index:2147482000;',
      'display:flex;flex-direction:column;background:var(--panel,#fff);border-left:1px solid var(--border,#e2e8f0);',
      'box-shadow:0 0 32px -8px rgba(15,23,42,.25);transform:translateX(100%);transition:transform .2s cubic-bezier(.16,1,.3,1);',
      'font-size:13px;line-height:1.5;color:var(--text,#0f172a);font-family:inherit;user-select:text}',
      '#' + PANEL_ID + '.open{transform:translateX(0)}',

      '#' + PANEL_ID + ' .ink-bl-head{padding:14px 16px 10px;border-bottom:1px solid var(--border,#e2e8f0);display:flex;flex-direction:column;gap:10px}',
      '#' + PANEL_ID + ' .ink-bl-head-row{display:flex;align-items:center;justify-content:space-between;gap:8px}',
      '#' + PANEL_ID + ' .ink-bl-title{font-size:15px;font-weight:600;display:flex;align-items:center;gap:6px}',
      '#' + PANEL_ID + ' .ink-bl-title svg{color:var(--accent,#2563eb);flex-shrink:0}',
      '#' + PANEL_ID + ' .ink-bl-head-actions{display:flex;align-items:center;gap:4px}',
      '#' + PANEL_ID + ' .ink-bl-icon-btn{width:28px;height:28px;border:none;background:transparent;border-radius:var(--radius-sm,6px);',
      'cursor:pointer;color:var(--text-dim,#64748b);display:flex;align-items:center;justify-content:center;transition:background .12s,color .12s}',
      '#' + PANEL_ID + ' .ink-bl-icon-btn:hover{background:var(--hover,rgba(15,23,42,.07));color:var(--text,#0f172a)}',

      '#' + PANEL_ID + ' .ink-bl-target-badge{background:var(--bg,#f8fafc);border:1px solid var(--border,#e2e8f0);padding:6px 10px;',
      'border-radius:var(--radius-sm,6px);font-size:12px;color:var(--text-dim,#64748b);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '#' + PANEL_ID + ' .ink-bl-target-name{color:var(--text,#0f172a);font-weight:600}',

      '#' + PANEL_ID + ' .ink-bl-search-wrap{position:relative}',
      '#' + PANEL_ID + ' .ink-bl-search{width:100%;height:30px;padding:0 28px 0 28px;border:1px solid var(--border,#e2e8f0);',
      'border-radius:var(--radius-sm,6px);background:var(--bg,#f8fafc);color:inherit;font:inherit;outline:none}',
      '#' + PANEL_ID + ' .ink-bl-search:focus{border-color:var(--accent,#2563eb);background:var(--panel,#fff)}',
      '#' + PANEL_ID + ' .ink-bl-search-icon{position:absolute;left:8px;top:7px;color:var(--text-dim,#94a3b8);pointer-events:none}',
      '#' + PANEL_ID + ' .ink-bl-search-clear{position:absolute;right:6px;top:6px;width:18px;height:18px;border:none;background:transparent;',
      'cursor:pointer;color:var(--text-dim,#94a3b8);display:none;align-items:center;justify-content:center;border-radius:50%}',

      '#' + PANEL_ID + ' .ink-bl-tabs{display:flex;padding:0 16px;border-bottom:1px solid var(--border,#e2e8f0);background:var(--bg,#f8fafc)}',
      '#' + PANEL_ID + ' .ink-bl-tab{padding:9px 12px;border:none;background:transparent;cursor:pointer;font-size:12px;font-weight:500;',
      'color:var(--text-dim,#64748b);border-bottom:2px solid transparent;display:flex;align-items:center;gap:6px;transition:all .12s}',
      '#' + PANEL_ID + ' .ink-bl-tab:hover{color:var(--text,#0f172a)}',
      '#' + PANEL_ID + ' .ink-bl-tab.active{color:var(--accent,#2563eb);border-bottom-color:var(--accent,#2563eb)}',
      '#' + PANEL_ID + ' .ink-bl-count-tag{padding:1px 6px;border-radius:10px;font-size:11px;background:var(--hover,rgba(15,23,42,.07))}',
      '#' + PANEL_ID + ' .ink-bl-tab.active .ink-bl-count-tag{background:var(--accent-soft,#eff6ff);color:var(--accent,#2563eb)}',

      '#' + PANEL_ID + ' .ink-bl-body{flex:1 1 auto;overflow-y:auto;padding:12px 16px;display:flex;flex-direction:column;gap:12px}',
      '#' + PANEL_ID + ' .ink-bl-card{background:var(--panel,#fff);border:1px solid var(--border,#e2e8f0);border-radius:var(--radius,10px);',
      'overflow:hidden;box-shadow:var(--shadow-xs,0 1px 2px rgba(0,0,0,.04))}',
      '#' + PANEL_ID + ' .ink-bl-card-head{padding:10px 12px;display:flex;align-items:center;justify-content:space-between;gap:8px;',
      'background:var(--bg,#f8fafc);border-bottom:1px solid var(--border,#e2e8f0);cursor:pointer;transition:background .12s}',
      '#' + PANEL_ID + ' .ink-bl-card-head:hover{background:var(--hover,rgba(15,23,42,.07))}',
      '#' + PANEL_ID + ' .ink-bl-card-title{font-weight:600;color:var(--text,#0f172a);display:flex;align-items:center;gap:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '#' + PANEL_ID + ' .ink-bl-card-folder{font-size:11px;color:var(--text-dim,#64748b);margin-left:auto;white-space:nowrap}',
      '#' + PANEL_ID + ' .ink-bl-card-body{padding:6px 0;display:flex;flex-direction:column}',

      '#' + PANEL_ID + ' .ink-bl-excerpt{padding:7px 12px;cursor:pointer;font-size:12px;line-height:1.6;color:var(--text-dim,#475569);',
      'border-left:3px solid transparent;transition:background .12s,border-color .12s;display:flex;flex-direction:column;gap:4px}',
      '#' + PANEL_ID + ' .ink-bl-excerpt:hover{background:var(--hover,rgba(15,23,42,.05));border-left-color:var(--accent,#2563eb);color:var(--text,#0f172a)}',
      '#' + PANEL_ID + ' .ink-bl-excerpt-meta{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--text-dim,#94a3b8)}',
      '#' + PANEL_ID + ' .ink-bl-line-tag{background:var(--bg,#f1f5f9);padding:1px 4px;border-radius:4px}',
      '#' + PANEL_ID + ' .ink-bl-highlight{background:var(--accent-soft,#eff6ff);color:var(--accent,#2563eb);font-weight:600;padding:1px 3px;border-radius:3px}',

      '#' + PANEL_ID + ' .ink-bl-link-btn{align-self:flex-start;margin-top:4px;padding:3px 8px;font-size:11px;font-weight:500;',
      'border:1px solid var(--accent-soft-border,#bfdbfe);background:var(--accent-soft,#eff6ff);color:var(--accent,#2563eb);',
      'border-radius:var(--radius-sm,6px);cursor:pointer;transition:all .12s;display:inline-flex;align-items:center;gap:4px}',
      '#' + PANEL_ID + ' .ink-bl-link-btn:hover{background:var(--accent,#2563eb);color:#fff}',

      '#' + PANEL_ID + ' .ink-bl-empty{padding:48px 24px;text-align:center;color:var(--text-dim,#94a3b8);display:flex;flex-direction:column;align-items:center;gap:8px}',
      '#' + PANEL_ID + ' .ink-bl-empty-title{font-size:14px;font-weight:500;color:var(--text,#0f172a)}',
      '#' + PANEL_ID + ' .ink-bl-empty-hint{font-size:12px;line-height:1.5}',

      '#' + PANEL_ID + ' .ink-bl-toast{position:absolute;left:50%;bottom:20px;transform:translateX(-50%);background:rgba(15,23,42,.88);',
      'color:#fff;padding:8px 14px;border-radius:8px;font-size:12px;box-shadow:0 8px 20px rgba(0,0,0,.25);z-index:10;pointer-events:none;',
      'opacity:0;transition:opacity .2s}',
      '#' + PANEL_ID + ' .ink-bl-toast.show{opacity:1}'
    ].join('');
    (doc.head || doc.documentElement).appendChild(style);
  }

  function showToast(msg) {
    if (!dom.toast) return;
    dom.toast.textContent = msg;
    dom.toast.className = 'ink-bl-toast show';
    clearTimeout(dom.toastTimer);
    dom.toastTimer = setTimeout(function () {
      if (dom.toast) dom.toast.className = 'ink-bl-toast';
    }, 2200);
  }

  function buildPanel() {
    if (dom.panel) return dom.panel;
    var doc = typeof document !== 'undefined' ? document : null;
    if (!doc) return null;
    ensureStyle(doc);

    // Refresh btn
    var refreshBtn = h('button', {
      class: 'ink-bl-icon-btn ink-bl-refresh',
      title: '重新扫描 (R)',
      onClick: function () { triggerScan(true); },
      html: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/></svg>'
    });

    // Close btn
    var closeBtn = h('button', {
      class: 'ink-bl-icon-btn ink-bl-close',
      title: '关闭面板 (Esc)',
      onClick: function () { toggle(false); },
      html: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'
    });

    // Title & head row
    var titleEl = h('div', {
      class: 'ink-bl-title',
      html: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
            '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>' +
            '<path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>' +
            '</svg><span>反向链接</span>'
    });

    var headRow = h('div', { class: 'ink-bl-head-row' }, [
      titleEl,
      h('div', { class: 'ink-bl-head-actions' }, [refreshBtn, closeBtn])
    ]);

    // Target badge
    var targetName = h('span', { class: 'ink-bl-target-name', text: '无' });
    var targetBadge = h('div', { class: 'ink-bl-target-badge' }, [
      '目标笔记：',
      targetName
    ]);

    // Search wrap
    var searchInput = h('input', {
      type: 'text',
      class: 'ink-bl-search',
      placeholder: '筛选引用来源或内容…',
      onInput: function (e) {
        state.searchFilter = String(e.target.value || '').trim();
        if (dom.searchClear) {
          dom.searchClear.style.display = state.searchFilter ? 'flex' : 'none';
        }
        renderList();
      }
    });

    var searchClear = h('button', {
      class: 'ink-bl-search-clear',
      title: '清空',
      text: '×',
      onClick: function () {
        searchInput.value = '';
        state.searchFilter = '';
        searchClear.style.display = 'none';
        renderList();
        searchInput.focus();
      }
    });

    var searchWrap = h('div', { class: 'ink-bl-search-wrap' }, [
      h('span', {
        class: 'ink-bl-search-icon',
        html: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>'
      }),
      searchInput,
      searchClear
    ]);

    var head = h('div', { class: 'ink-bl-head' }, [headRow, targetBadge, searchWrap]);

    // Tabs
    var linkedCount = h('span', { class: 'ink-bl-count-tag ink-bl-linked-count', text: '0' });
    var unlinkedCount = h('span', { class: 'ink-bl-count-tag ink-bl-unlinked-count', text: '0' });

    var tabLinked = h('button', {
      class: 'ink-bl-tab active',
      dataset: { tab: 'linked' },
      onClick: function () { setTab('linked'); }
    }, ['已链接提及 ', linkedCount]);

    var tabUnlinked = h('button', {
      class: 'ink-bl-tab',
      dataset: { tab: 'unlinked' },
      onClick: function () { setTab('unlinked'); }
    }, ['未链接提及 ', unlinkedCount]);

    var tabs = h('div', { class: 'ink-bl-tabs' }, [tabLinked, tabUnlinked]);

    // Body
    var body = h('div', { class: 'ink-bl-body' });

    // Toast
    var toast = h('div', { class: 'ink-bl-toast' });

    var panel = h('div', { id: PANEL_ID, class: PANEL_ID }, [head, tabs, body, toast]);

    (doc.body || doc.documentElement).appendChild(panel);

    dom.panel = panel;
    dom.targetName = targetName;
    dom.searchInput = searchInput;
    dom.searchClear = searchClear;
    dom.linkedCount = linkedCount;
    dom.unlinkedCount = unlinkedCount;
    dom.body = body;
    dom.toast = toast;
    dom.tabLinked = tabLinked;
    dom.tabUnlinked = tabUnlinked;

    return panel;
  }

  function setTab(tab) {
    state.activeTab = tab;
    if (dom.tabLinked && dom.tabUnlinked) {
      if (tab === 'linked') {
        dom.tabLinked.className = 'ink-bl-tab active';
        dom.tabUnlinked.className = 'ink-bl-tab';
      } else {
        dom.tabLinked.className = 'ink-bl-tab';
        dom.tabUnlinked.className = 'ink-bl-tab active';
      }
    }
    renderList();
  }

  /** 高亮文本中的目标词 */
  function highlightText(text, keyword) {
    if (!keyword) return esc(text);
    var escaped = esc(text);
    var kwEsc = esc(keyword);
    var idx = escaped.toLowerCase().indexOf(kwEsc.toLowerCase());
    if (idx < 0) return escaped;
    return (
      escaped.slice(0, idx) +
      '<mark class="ink-bl-highlight">' +
      escaped.slice(idx, idx + kwEsc.length) +
      '</mark>' +
      escaped.slice(idx + kwEsc.length)
    );
  }

  /** 渲染反链列表视图 */
  function renderList() {
    if (!dom.body) return;
    var list = state.activeTab === 'linked' ? state.linkedResults : state.unlinkedResults;
    var targetTitle = state.currentNote && state.currentNote.title ? state.currentNote.title.trim() : '';

    var filter = state.searchFilter.toLowerCase();
    var filtered = list;
    if (filter) {
      filtered = [];
      for (var i = 0; i < list.length; i++) {
        var card = list[i];
        var titleMatch = card.noteTitle.toLowerCase().indexOf(filter) >= 0;
        var folderMatch = card.folderPath.toLowerCase().indexOf(filter) >= 0;
        var matchingExcerpts = [];
        for (var j = 0; j < card.excerpts.length; j++) {
          var ex = card.excerpts[j];
          if (titleMatch || folderMatch || ex.text.toLowerCase().indexOf(filter) >= 0) {
            matchingExcerpts.push(ex);
          }
        }
        if (matchingExcerpts.length > 0) {
          filtered.push({
            noteId: card.noteId,
            noteTitle: card.noteTitle,
            folderPath: card.folderPath,
            excerpts: matchingExcerpts
          });
        }
      }
    }

    if (state.loading) {
      dom.body.innerHTML =
        '<div class="ink-bl-empty">' +
        '<div class="ink-bl-empty-title">正在扫描引用…</div>' +
        '<div class="ink-bl-empty-hint">遍历库中所有笔记建立双向索引</div>' +
        '</div>';
      return;
    }

    if (!targetTitle) {
      dom.body.innerHTML =
        '<div class="ink-bl-empty">' +
        '<div class="ink-bl-empty-title">无目标笔记</div>' +
        '<div class="ink-bl-empty-hint">在左侧选择一篇笔记后查看反向链接</div>' +
        '</div>';
      return;
    }

    if (filtered.length === 0) {
      var isFilter = !!filter;
      var emptyHtml = '';
      if (state.activeTab === 'linked') {
        emptyHtml =
          '<div class="ink-bl-empty">' +
          '<div class="ink-bl-empty-title">' + (isFilter ? '未匹配到相关引用' : '暂无其他笔记引用此笔记') + '</div>' +
          '<div class="ink-bl-empty-hint">' +
          (isFilter ? '尝试缩短或更换筛选关键词' : '在其他笔记的正文中输入 <code>[[' + esc(targetTitle) + ']]</code> 即可创建双向链接') +
          '</div></div>';
      } else {
        emptyHtml =
          '<div class="ink-bl-empty">' +
          '<div class="ink-bl-empty-title">' + (isFilter ? '未匹配到相关提及' : '未发现包含此名称的未链接文本') + '</div>' +
          '<div class="ink-bl-empty-hint">' +
          (isFilter ? '尝试缩短或更换筛选关键词' : '若其他笔记中出现「' + esc(targetTitle) + '」文本，将在此展示并支持一键转为双链') +
          '</div></div>';
      }
      dom.body.innerHTML = emptyHtml;
      return;
    }

    dom.body.innerHTML = '';
    for (var k = 0; k < filtered.length; k++) {
      var item = filtered[k];
      (function (curItem) {
        var cardTitle = h('div', {
          class: 'ink-bl-card-title',
          html: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>'
        }, [curItem.noteTitle]);

        var headChildren = [cardTitle];
        if (curItem.folderPath) {
          headChildren.push(h('span', { class: 'ink-bl-card-folder', text: '📁 ' + curItem.folderPath }));
        }

        var cardHead = h('div', {
          class: 'ink-bl-card-head',
          onClick: function () { jumpToNote(curItem.noteTitle); }
        }, headChildren);

        var excerptEls = [];
        for (var e = 0; e < curItem.excerpts.length; e++) {
          var exc = curItem.excerpts[e];
          (function (curExc) {
            var metaChildren = [
              h('span', { class: 'ink-bl-line-tag', text: 'L' + curExc.line })
            ];
            if (curExc.heading) metaChildren.push(h('span', { text: '#' + curExc.heading }));
            if (curExc.alias) metaChildren.push(h('span', { text: '| ' + curExc.alias }));
            var metaEl = h('div', { class: 'ink-bl-excerpt-meta' }, metaChildren);

            var highlightWord = state.activeTab === 'linked' ? (curExc.rawLink || '[[' + targetTitle + ']]') : (curExc.mentionWord || targetTitle);
            var textEl = h('div', { class: 'ink-bl-excerpt-text', html: highlightText(curExc.text, highlightWord) });

            var excerptChildren = [metaEl, textEl];

            if (state.activeTab === 'unlinked') {
              var linkBtn = h('button', {
                class: 'ink-bl-link-btn',
                html: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg><span>转为双链</span>',
                onClick: function (ev) {
                  if (ev && ev.stopPropagation) ev.stopPropagation();
                  convertToWikilink(curItem.noteId);
                }
              });
              excerptChildren.push(linkBtn);
            }

            var excerptEl = h('div', {
              class: 'ink-bl-excerpt',
              onClick: function (ev) {
                if (ev && ev.target && ev.target.closest && ev.target.closest('.ink-bl-link-btn')) return;
                jumpToNote(curItem.noteTitle);
              }
            }, excerptChildren);

            excerptEls.push(excerptEl);
          })(exc);
        }

        var cardBody = h('div', { class: 'ink-bl-card-body' }, excerptEls);
        var card = h('div', {
          class: 'ink-bl-card',
          dataset: { noteId: curItem.noteId, noteTitle: curItem.noteTitle }
        }, [cardHead, cardBody]);

        dom.body.appendChild(card);
      })(item);
    }
  }

  /** 跳转至目标笔记 */
  function jumpToNote(noteTitle) {
    if (!noteTitle) return;
    try {
      if (typeof state.navFn === 'function') {
        state.navFn(noteTitle);
        showToast('已跳转至《' + noteTitle + '》');
      } else {
        showToast('无法直接跳转（缺少导航函数）');
      }
    } catch (err) {
      console.warn('[backlinks] 跳转失败：', err);
    }
  }

  /** 将未链接提及一键转为 [[双链]] */
  async function convertToWikilink(sourceNoteId) {
    var db = getDb();
    if (!db || !sourceNoteId || !state.currentNote || !state.currentNote.title) return;
    var targetTitle = state.currentNote.title.trim();
    try {
      var row = await db.noteContent.get(sourceNoteId);
      if (!row || typeof row.content !== 'string') return;
      var content = row.content;

      var targetNorm = normTitle(targetTitle);
      var masked = content
        .replace(CODE_BLOCK_RE, function (m) { return ' '.repeat(m.length); })
        .replace(INLINE_CODE_RE, function (m) { return ' '.repeat(m.length); })
        .replace(WIKILINK_RE, function (m) { return ' '.repeat(m.length); });

      var idx = masked.toLowerCase().indexOf(targetNorm);
      if (idx < 0) {
        showToast('未能定位该文本，可能已被修改');
        return;
      }

      var before = content.slice(0, idx);
      var after = content.slice(idx + targetTitle.length);
      var newContent = before + '[[' + targetTitle + ']]' + after;

      await db.noteContent.put({ noteId: sourceNoteId, content: newContent });
      await db.notes.update(sourceNoteId, { updatedAt: Date.now() });

      showToast('已将文本转为双向链接 [[' + targetTitle + ']]');
      await triggerScan(true);
    } catch (err) {
      console.warn('[backlinks] 转化为双链失败：', err);
      showToast('转化失败：' + (err.message || String(err)));
    }
  }

  /** 触发全局反链扫描 */
  async function triggerScan(force) {
    var note = state.currentNote;
    if (!note || !note.title) {
      state.linkedResults = [];
      state.unlinkedResults = [];
      updateToolbarBadge(0);
      renderList();
      return;
    }
    var title = note.title.trim();
    if (!force && state.lastScannedId === note.id && state.lastScannedTitle === title) {
      return;
    }

    state.loading = true;
    if (dom.targetName) dom.targetName.textContent = '《' + title + '》';
    renderList();

    var db = getDb();
    if (!db) {
      state.loading = false;
      renderList();
      return;
    }

    try {
      var res = await Promise.all([
        db.notes.toArray(),
        db.noteContent.toArray(),
        db.folders.toArray()
      ]);
      var notes = res[0] || [];
      var contents = res[1] || [];
      var folders = res[2] || [];

      var scanned = scanBacklinksCore(note, notes, contents, folders);
      state.linkedResults = scanned.linked;
      state.unlinkedResults = scanned.unlinked;
      state.lastScannedId = note.id;
      state.lastScannedTitle = title;
      state.loading = false;

      var totalLinkedCount = 0;
      for (var i = 0; i < scanned.linked.length; i++) {
        totalLinkedCount += scanned.linked[i].excerpts.length;
      }
      var totalUnlinkedCount = 0;
      for (var j = 0; j < scanned.unlinked.length; j++) {
        totalUnlinkedCount += scanned.unlinked[j].excerpts.length;
      }

      if (dom.linkedCount) dom.linkedCount.textContent = String(totalLinkedCount);
      if (dom.unlinkedCount) dom.unlinkedCount.textContent = String(totalUnlinkedCount);
      updateToolbarBadge(totalLinkedCount);

      renderList();
    } catch (err) {
      console.warn('[backlinks] 扫描异常：', err);
      state.loading = false;
      renderList();
    }
  }

  /** 更新工具栏按钮上的计数角标 */
  function updateToolbarBadge(count) {
    try {
      var btn = document.querySelector('.ink-backlinks-toolbar-btn .btn-label');
      if (btn) {
        btn.textContent = count > 0 ? '反链 (' + count + ')' : '反链';
      }
    } catch (e) {
      /* ignore */
    }
  }

  // ---------------------------------------------------------------- 外部调用接口

  /** 同步当前笔记状态与导航句柄（在工具栏每次渲染时调用） */
  function sync(note, navFn) {
    if (navFn) state.navFn = navFn;
    if (!note) return;
    var changed = !state.currentNote || state.currentNote.id !== note.id || state.currentNote.title !== note.title;
    state.currentNote = note;

    if (changed) {
      if (dom.targetName) {
        dom.targetName.textContent = note.title ? '《' + note.title + '》' : '无';
      }
      clearTimeout(state.syncTimer);
      state.syncTimer = setTimeout(function () {
        triggerScan(false);
      }, 300);
    }
  }

  /** 开关面板 */
  function toggle(force, note, navFn) {
    if (note) state.currentNote = note;
    if (navFn) state.navFn = navFn;

    var panel = buildPanel();
    if (!panel) return false;

    var next = typeof force === 'boolean' ? force : !state.open;
    state.open = next;

    if (next) {
      // 打开反链面板时，若 AI 面板处于开启态，关闭 AI 面板
      try {
        if (typeof __inkAiApi !== 'undefined' && __inkAiApi.toggle && __inkAiApi.internals) {
          if (__inkAiApi.internals.getState().open) __inkAiApi.toggle(false);
        }
      } catch (e) {
        /* ignore */
      }

      panel.className = PANEL_ID + ' open';
      triggerScan(true);
      if (dom.searchInput && dom.searchInput.focus) dom.searchInput.focus();
    } else {
      panel.className = PANEL_ID;
    }
    return next;
  }

  // 全局快捷键注册
  if (typeof window !== 'undefined') {
    window.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'b' || e.key === 'B')) {
        if (e.preventDefault) e.preventDefault();
        if (e.stopPropagation) e.stopPropagation();
        toggle();
      } else if (e.key === 'Escape' && state.open) {
        toggle(false);
      }
    }, true);
  }

  return {
    sync: sync,
    toggle: toggle,
    scanCore: scanBacklinksCore,
    extractExcerpt: extractExcerpt,
    internals: {
      getState: function () { return state; },
      setDb: function (db) {
        if (typeof window !== 'undefined') window.__inkDb = db;
      }
    }
  };
})();

function __inkBacklinksSync(note, navFn) {
  try {
    if (typeof __inkBacklinksApi !== 'undefined' && __inkBacklinksApi.sync) {
      __inkBacklinksApi.sync(note, navFn);
    }
  } catch (err) {
    /* ignore */
  }
}

function __inkBacklinksToggle(note, navFn) {
  try {
    if (typeof __inkBacklinksApi !== 'undefined' && __inkBacklinksApi.toggle) {
      return __inkBacklinksApi.toggle(undefined, note, navFn);
    }
  } catch (err) {
    /* ignore */
  }
}
