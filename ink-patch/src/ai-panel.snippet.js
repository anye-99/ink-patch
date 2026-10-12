/* ===== [ai-assistant] 墨记 AI 助手侧边栏补丁 v1 =====
 *
 * 注入方式（见 src/ui-patches.cjs）：
 *   1) 编辑器 JSX 加 onCreateEditor:__inkAiOnEditor —— 拿到 CodeMirror 6 的 EditorView（读全文 / 光标处插入）
 *   2) 工具栏加一个「AI」按钮，onClick 调 __inkAiToggle() —— 用于把当前笔记标题带进来并打开面板
 *   3) 本文件追加到入口 bundle 末尾，与官方代码同作用域
 *
 * 能力：
 *   - 右侧抽屉式对话面板（不打断编辑，可随时收起）
 *   - 多套 OpenAI 兼容 API 配置（名称 / Base URL / Key / 模型 / 系统提示 / 温度），可增删改切换
 *   - 流式输出（桌面走主进程 net 代理，绕开 CORS；浏览器预览回退到直接 fetch）
 *   - 「引用当前笔记」把正文作为上下文随问题一起发送（超出上限自动截断）
 *   - 助手回复可一键插入到笔记光标处
 *
 * 安全取舍：
 *   - 不用 React state（本文件在模块作用域，不属于任何组件），整个面板是原生 DOM
 *   - 所有 DOM/网络操作都包 try/catch，任何异常只 warn，绝不影响墨记本身
 *   - Markdown 渲染先转义 HTML 再拼装，链接只允许 http(s)
 */
var __inkAiInstalled = true; // pack.cjs 用它检测是否重复打补丁

var __inkAiApi = (function () {
  'use strict';

  // ---------------------------------------------------------------- 常量
  var PANEL_ID = 'ink-ai-panel';
  var STYLE_ID = 'ink-ai-style';
  var LS_CONFIG = 'ink-ai-config-v1';
  var LS_HISTORY = 'ink-ai-history-v1';
  var LS_UI = 'ink-ai-ui-v1';
  var MAX_CONTEXT_CHARS = 20000;
  var MAX_HISTORY_ITEMS = 60;
  var STREAM_RENDER_MS = 80;
  var DEFAULT_SYSTEM = '你是墨记笔记里的写作助手。回答简洁、准确，默认用简体中文。涉及代码或 Markdown 时直接给出可复制的格式，不要客套话。';

  var PRESETS = [
    { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
    { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    { name: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', model: 'deepseek-ai/DeepSeek-V3' },
    { name: 'Ollama（本地）', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b' }
  ];

  // ---------------------------------------------------------------- 状态
  var state = {
    open: false,
    view: 'chat',
    config: null,
    history: [],
    editorView: null,
    noteTitle: '',
    streaming: false,
    requestId: null,
    abortRef: null,
    streamText: '',
    streamEl: null,
    renderTimer: 0,
    editingId: null,
    useNoteContext: true,
    booted: false
  };

  var dom = {}; // 面板内元素缓存

  function bridge() {
    try {
      return (typeof window !== 'undefined' && window.inkNotes) || null;
    } catch (err) {
      return null;
    }
  }

  function warn() {
    try {
      console.warn.apply(console, ['[AI 助手]'].concat(Array.prototype.slice.call(arguments)));
    } catch (err) {
      /* ignore */
    }
  }

  // ---------------------------------------------------------------- 纯函数（可单测）
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function inline(s) {
    var out = esc(s);
    // 行内代码先占位，避免其中内容被后续规则二次处理
    var codes = [];
    out = out.replace(/`([^`\n]+)`/g, function (_m, code) {
      codes.push(code);
      return '\u0000' + (codes.length - 1) + '\u0000';
    });
    out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    out = out.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, function (_m, text, url) {
      return '<a href="' + esc(url) + '" target="_blank" rel="noreferrer noopener">' + text + '</a>';
    });
    out = out.replace(/\u0000(\d+)\u0000/g, function (_m, i) {
      return '<code>' + esc(codes[Number(i)] || '') + '</code>';
    });
    return out;
  }

  /** 极简 Markdown → HTML。只覆盖对话里常见的块级语法，先转义再拼装。 */
  function md(src) {
    var lines = String(src == null ? '' : src).replace(/\r\n?/g, '\n').split('\n');
    var html = [];
    var buf = [];       // 段落缓冲
    var list = null;    // { tag:'ul'|'ol', items:[] }
    var inCode = false;
    var codeLang = '';
    var codeBuf = [];

    function flushParagraph() {
      if (!buf.length) return;
      html.push('<p>' + buf.join('<br>') + '</p>');
      buf = [];
    }
    function flushList() {
      if (!list) return;
      html.push('<' + list.tag + '>' + list.items.map(function (it) {
        return '<li>' + it + '</li>';
      }).join('') + '</' + list.tag + '>');
      list = null;
    }
    function flushAll() {
      flushParagraph();
      flushList();
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var fence = /^\s*```+\s*([\w+#.-]*)\s*$/.exec(line);
      if (fence) {
        if (inCode) {
          html.push('<pre class="ink-ai-code"' + (codeLang ? ' data-lang="' + esc(codeLang) + '"' : '') + '><code>' + esc(codeBuf.join('\n')) + '</code></pre>');
          inCode = false;
          codeLang = '';
          codeBuf = [];
        } else {
          flushAll();
          inCode = true;
          codeLang = fence[1] || '';
        }
        continue;
      }
      if (inCode) {
        codeBuf.push(line);
        continue;
      }
      if (!line.trim()) {
        flushAll();
        continue;
      }
      var heading = /^(#{1,6})\s+(.*)$/.exec(line);
      if (heading) {
        flushAll();
        var level = heading[1].length;
        html.push('<h' + level + '>' + inline(heading[2]) + '</h' + level + '>');
        continue;
      }
      if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) {
        flushAll();
        html.push('<hr>');
        continue;
      }
      var quote = /^\s*>\s?(.*)$/.exec(line);
      if (quote) {
        flushAll();
        html.push('<blockquote>' + inline(quote[1]) + '</blockquote>');
        continue;
      }
      var ul = /^\s*[-*+]\s+(.*)$/.exec(line);
      if (ul) {
        flushParagraph();
        if (!list || list.tag !== 'ul') {
          flushList();
          list = { tag: 'ul', items: [] };
        }
        list.items.push(inline(ul[1]));
        continue;
      }
      var ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
      if (ol) {
        flushParagraph();
        if (!list || list.tag !== 'ol') {
          flushList();
          list = { tag: 'ol', items: [] };
        }
        list.items.push(inline(ol[1]));
        continue;
      }
      flushList();
      buf.push(inline(line));
    }
    if (inCode) {
      html.push('<pre class="ink-ai-code"><code>' + esc(codeBuf.join('\n')) + '</code></pre>');
    }
    flushAll();
    return html.join('');
  }

  /** 把用户填的 Base URL 规范成 chat/completions 终点。 */
  function endpointOf(baseUrl) {
    var url = String(baseUrl || '').trim().replace(/\s+/g, '');
    if (!url) return '';
    if (/\/chat\/completions\/?$/.test(url)) return url.replace(/\/$/, '');
    if (/\/completions\/?$/.test(url)) return url.replace(/\/$/, '');
    if (/\/v\d+\/?$/.test(url)) return url.replace(/\/$/, '') + '/chat/completions';
    return url.replace(/\/$/, '') + '/v1/chat/completions';
  }

  function uid() {
    return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function normalizeConfig(raw) {
    var cfg = raw && typeof raw === 'object' ? raw : {};
    var providers = Array.isArray(cfg.providers) ? cfg.providers : [];
    providers = providers.filter(function (p) {
      return p && typeof p === 'object';
    }).map(function (p) {
      return {
        id: String(p.id || uid()),
        name: String(p.name || '未命名服务'),
        baseUrl: String(p.baseUrl || ''),
        apiKey: String(p.apiKey || ''),
        model: String(p.model || ''),
        systemPrompt: typeof p.systemPrompt === 'string' ? p.systemPrompt : DEFAULT_SYSTEM,
        temperature: typeof p.temperature === 'number' && p.temperature >= 0 && p.temperature <= 2 ? p.temperature : 0.7
      };
    });
    var currentId = cfg.currentId && providers.some(function (p) { return p.id === cfg.currentId; })
      ? cfg.currentId
      : (providers[0] ? providers[0].id : '');
    return { version: 1, currentId: currentId, providers: providers };
  }

  function currentProvider(cfg) {
    var c = cfg || state.config;
    if (!c || !c.providers.length) return null;
    return c.providers.filter(function (p) { return p.id === c.currentId; })[0] || c.providers[0];
  }

  /** 按字符上限截断上下文，返回 { text, truncated }。 */
  function clipContext(text, limit) {
    var max = limit || MAX_CONTEXT_CHARS;
    var s = String(text == null ? '' : text);
    if (s.length <= max) return { text: s, truncated: false };
    return {
      text: s.slice(0, max) + '\n\n…（笔记过长，已截断 ' + (s.length - max) + ' 字）',
      truncated: true
    };
  }

  /** 组装发给模型的消息数组。 */
  function buildMessages(opts) {
    var providers = opts.provider || {};
    var msgs = [];
    msgs.push({ role: 'system', content: providers.systemPrompt || DEFAULT_SYSTEM });
    if (opts.context && String(opts.context).trim()) {
      msgs.push({
        role: 'system',
        content: '以下是用户当前正在编辑的笔记（标题：' + (opts.title || '无标题') + '），仅作为回答上下文，不要复述全文：\n\n' + opts.context
      });
    }
    var history = (opts.history || []).filter(function (m) {
      return m && (m.role === 'user' || m.role === 'assistant') && String(m.content || '').trim();
    });
    var tail = history.slice(-(opts.maxHistory || MAX_HISTORY_ITEMS));
    for (var i = 0; i < tail.length; i++) msgs.push({ role: tail[i].role, content: String(tail[i].content) });
    return msgs;
  }

  /** 取编辑器 view：优先用 onCreateEditor 绑定的，其次从 CodeMirror 的 DOM 内部引用兜底。 */
  function resolveView() {
    if (state.editorView) return state.editorView;
    try {
      var content = document.querySelector('.cm-content');
      var view = content && content.cmView && content.cmView.view;
      if (view && view.state) {
        state.editorView = view;
        return view;
      }
    } catch (err) {
      /* ignore */
    }
    return null;
  }

  /** 读取当前笔记正文与标题。 */
  function readNote() {
    var content = '';
    var view = resolveView();
    try {
      if (view && view.state && view.state.doc && typeof view.state.doc.toString === 'function') {
        content = view.state.doc.toString();
      }
    } catch (err) {
      warn('读取编辑器内容失败：', err);
    }
    if (!content) {
      try {
        var el = document.querySelector('.cm-content');
        if (el) content = el.innerText || el.textContent || '';
      } catch (err) {
        /* ignore */
      }
    }
    var title = state.noteTitle || '';
    if (!title) {
      try {
        var input = document.querySelector('.doc-title-input');
        if (input && input.value) title = input.value;
      } catch (err) {
        /* ignore */
      }
    }
    return { title: title, content: content };
  }

  // ---------------------------------------------------------------- 存储
  var storage = (function () {
    try {
      var ls = window.localStorage;
      var probe = '__ink_ai_probe';
      ls.setItem(probe, '1');
      ls.removeItem(probe);
      return ls;
    } catch (err) {
      var mem = {};
      return {
        getItem: function (k) { return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null; },
        setItem: function (k, v) { mem[k] = String(v); },
        removeItem: function (k) { delete mem[k]; }
      };
    }
  })();

  function readLocalConfig() {
    try {
      var raw = storage.getItem(LS_CONFIG);
      if (!raw) return null;
      return normalizeConfig(JSON.parse(raw));
    } catch (err) {
      warn('本地配置解析失败，已忽略：', err);
      return null;
    }
  }

  function loadConfig() {
    var api = bridge();
    if (api && typeof api.getAiConfig === 'function') {
      return Promise.resolve()
        .then(function () { return api.getAiConfig(); })
        .then(function (cfg) { return normalizeConfig(cfg); })
        .catch(function (err) {
          warn('读取桌面配置失败，回退到本地存储：', err);
          return readLocalConfig() || normalizeConfig(null);
        });
    }
    return Promise.resolve(readLocalConfig() || normalizeConfig(null));
  }

  function saveConfig(cfg) {
    state.config = cfg;
    var api = bridge();
    if (api && typeof api.saveAiConfig === 'function') {
      return Promise.resolve()
        .then(function () { return api.saveAiConfig(cfg); })
        .catch(function (err) {
          warn('保存到桌面配置失败，已回退本地存储：', err);
          try { storage.setItem(LS_CONFIG, JSON.stringify(cfg)); } catch (e2) { /* ignore */ }
        });
    }
    try { storage.setItem(LS_CONFIG, JSON.stringify(cfg)); } catch (err) { /* ignore */ }
    return Promise.resolve();
  }

  function saveHistory() {
    try {
      storage.setItem(LS_HISTORY, JSON.stringify(state.history.slice(-MAX_HISTORY_ITEMS)));
    } catch (err) {
      /* ignore */
    }
  }

  function loadHistory() {
    try {
      var raw = storage.getItem(LS_HISTORY);
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr.filter(function (m) {
        return m && typeof m.content === 'string';
      }) : [];
    } catch (err) {
      return [];
    }
  }

  // ---------------------------------------------------------------- 传输
  function parseSseChunk(chunk, onDelta) {
    // 处理形如 "data: {...}\n\n" 的片段，返回剩余未成事件的部分
    var idx;
    var rest = chunk;
    while ((idx = rest.indexOf('\n\n')) >= 0) {
      var block = rest.slice(0, idx);
      rest = rest.slice(idx + 2);
      var lines = block.split('\n');
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (!line || line.charAt(0) === ':') continue;
        if (line.indexOf('data:') !== 0) continue;
        var payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          var json = JSON.parse(payload);
          var delta = json && json.choices && json.choices[0] &&
            ((json.choices[0].delta && json.choices[0].delta.content) ||
              (json.choices[0].message && json.choices[0].message.content) ||
              (typeof json.choices[0].text === 'string' ? json.choices[0].text : ''));
          if (delta) onDelta(String(delta));
        } catch (err) {
          /* 非 JSON 数据行忽略 */
        }
      }
    }
    return rest;
  }

  function buildRequest(req) {
    var payload = {
      model: req.model,
      messages: req.messages,
      stream: true
    };
    if (typeof req.temperature === 'number') payload.temperature = req.temperature;
    return {
      url: endpointOf(req.baseUrl),
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + (req.apiKey || ''),
        Accept: 'text/event-stream'
      },
      body: JSON.stringify(payload)
    };
  }

  function chatViaBrowser(req) {
    var built = buildRequest(req);
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    state.abortRef = ctrl;
    var init = { method: 'POST', headers: built.headers, body: built.body };
    if (ctrl) init.signal = ctrl.signal;
    return fetch(built.url, init).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (t) {
          throw new Error('HTTP ' + res.status + '：' + String(t).slice(0, 300));
        });
      }
      if (!res.body || typeof res.body.getReader !== 'function') {
        return res.text().then(function (t) {
          var text = '';
          parseSseChunk(t.replace(/\r\n/g, '\n'), function (d) { text += d; req.onDelta(d); });
          return text;
        });
      }
      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buffer = '';
      var full = '';
      function pump() {
        return reader.read().then(function (r) {
          if (r.done) return full;
          buffer += decoder.decode(r.value, { stream: true });
          buffer = parseSseChunk(buffer.replace(/\r\n/g, '\n'), function (d) {
            full += d;
            req.onDelta(d);
          });
          return pump();
        });
      }
      return pump();
    });
  }

  function chat(req) {
    var api = bridge();
    var built = buildRequest(req);
    if (api && typeof api.aiChat === 'function') {
      return Promise.resolve()
        .then(function () {
          return api.aiChat({
            requestId: req.requestId,
            url: built.url,
            headers: built.headers,
            body: built.body
          });
        })
        .then(function (res) {
          if (res && res.ok) return res.text || '';
          throw new Error((res && res.error) || '请求失败');
        });
    }
    return chatViaBrowser(req);
  }

  function abort(requestId) {
    var api = bridge();
    if (api && typeof api.aiAbort === 'function') {
      try { api.aiAbort(requestId); } catch (err) { warn('中止失败：', err); }
      return;
    }
    if (state.abortRef && typeof state.abortRef.abort === 'function') {
      try { state.abortRef.abort(); } catch (err) { /* ignore */ }
    }
  }

  // ---------------------------------------------------------------- DOM 小工具
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
        el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      });
    }
    return el;
  }

  function ensureStyle() {
    try {
      if (document.getElementById(STYLE_ID)) return;
      var style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = [
        '#' + PANEL_ID + '{position:fixed;top:0;right:0;bottom:0;width:420px;max-width:100vw;z-index:2147482000;display:flex;flex-direction:column;',
        'background:var(--panel,#fff);border-left:1px solid var(--border,#e2e8f0);box-shadow:-18px 0 44px -24px rgba(15,23,42,.4);',
        'color:var(--text,#0f172a);font-size:13px;line-height:1.6;transform:translateX(101%);transition:transform .22s cubic-bezier(.16,1,.3,1)}',
        '#' + PANEL_ID + '.open{transform:none}',
        '#' + PANEL_ID + ' *{box-sizing:border-box}',
        '#' + PANEL_ID + ' .ink-ai-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--border,#e8edf3);flex:0 0 auto}',
        '#' + PANEL_ID + ' .ink-ai-brand{font-weight:600;font-size:14px;display:flex;align-items:center;gap:6px}',
        '#' + PANEL_ID + ' .ink-ai-dot{width:8px;height:8px;border-radius:50%;background:var(--accent,#2f6fed);flex:0 0 auto}',
        '#' + PANEL_ID + ' select.ink-ai-provider{flex:1 1 auto;min-width:0;height:28px;padding:0 6px;border:1px solid var(--border,#dfe6ee);border-radius:var(--radius-sm,8px);background:transparent;color:inherit;font:inherit}',
        '#' + PANEL_ID + ' .ink-ai-icon-btn{width:28px;height:28px;flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;border:1px solid transparent;',
        'border-radius:var(--radius-sm,8px);background:transparent;color:inherit;cursor:pointer;font:inherit;font-size:14px;line-height:1}',
        '#' + PANEL_ID + ' .ink-ai-icon-btn:hover{background:var(--hover,rgba(15,23,42,.07))}',
        '#' + PANEL_ID + ' .ink-ai-body{flex:1 1 auto;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:10px}',
        '#' + PANEL_ID + ' .ink-ai-body::-webkit-scrollbar{width:8px}',
        '#' + PANEL_ID + ' .ink-ai-body::-webkit-scrollbar-thumb{background:rgba(15,23,42,.16);border-radius:4px}',
        '#' + PANEL_ID + ' .ink-ai-msg{max-width:100%;display:flex;flex-direction:column;gap:4px}',
        '#' + PANEL_ID + ' .ink-ai-msg .ink-ai-bubble{padding:8px 10px;border-radius:var(--radius,12px);word-break:break-word;overflow-wrap:anywhere}',
        '#' + PANEL_ID + ' .ink-ai-msg.user{align-items:flex-end}',
        '#' + PANEL_ID + ' .ink-ai-msg.user .ink-ai-bubble{background:var(--accent,#2f6fed);color:#fff;border-bottom-right-radius:4px;white-space:pre-wrap}',
        '#' + PANEL_ID + ' .ink-ai-msg.assistant .ink-ai-bubble{background:var(--hover,rgba(15,23,42,.05));border-bottom-left-radius:4px}',
        '#' + PANEL_ID + ' .ink-ai-msg.system .ink-ai-bubble{background:transparent;border:1px dashed var(--border,#dfe6ee);color:var(--text-dim,#64748b);font-size:12px}',
        '#' + PANEL_ID + ' .ink-ai-msg .ink-ai-actions{display:flex;gap:6px;opacity:.55;transition:opacity .15s}',
        '#' + PANEL_ID + ' .ink-ai-msg:hover .ink-ai-actions{opacity:1}',
        '#' + PANEL_ID + ' .ink-ai-mini{border:1px solid var(--border,#dfe6ee);background:transparent;color:inherit;font:inherit;font-size:11px;',
        'padding:2px 7px;border-radius:6px;cursor:pointer}',
        '#' + PANEL_ID + ' .ink-ai-mini:hover{background:var(--hover,rgba(15,23,42,.07))}',
        '#' + PANEL_ID + ' .ink-ai-bubble p{margin:0 0 8px}' + '#' + PANEL_ID + ' .ink-ai-bubble p:last-child{margin-bottom:0}',
        '#' + PANEL_ID + ' .ink-ai-bubble h1,#' + PANEL_ID + ' .ink-ai-bubble h2,#' + PANEL_ID + ' .ink-ai-bubble h3{margin:10px 0 6px;line-height:1.35}',
        '#' + PANEL_ID + ' .ink-ai-bubble h1{font-size:16px}#' + PANEL_ID + ' .ink-ai-bubble h2{font-size:15px}#' + PANEL_ID + ' .ink-ai-bubble h3{font-size:14px}',
        '#' + PANEL_ID + ' .ink-ai-bubble ul,#' + PANEL_ID + ' .ink-ai-bubble ol{margin:6px 0;padding-left:20px}',
        '#' + PANEL_ID + ' .ink-ai-bubble blockquote{margin:6px 0;padding-left:10px;border-left:3px solid var(--border,#dfe6ee);color:var(--text-dim,#64748b)}',
        '#' + PANEL_ID + ' .ink-ai-bubble hr{border:none;border-top:1px solid var(--border,#e8edf3);margin:10px 0}',
        '#' + PANEL_ID + ' .ink-ai-bubble a{color:var(--accent,#2f6fed)}',
        '#' + PANEL_ID + ' .ink-ai-bubble code{background:rgba(15,23,42,.08);padding:1px 4px;border-radius:4px;font-family:ui-monospace,Consolas,monospace;font-size:12px}',
        '#' + PANEL_ID + ' .ink-ai-bubble pre.ink-ai-code{position:relative;background:rgba(15,23,42,.06);border:1px solid var(--border,#e8edf3);border-radius:8px;',
        'padding:8px 10px;margin:8px 0;overflow-x:auto}',
        '#' + PANEL_ID + ' .ink-ai-bubble pre.ink-ai-code code{background:transparent;padding:0;white-space:pre}',
        '#' + PANEL_ID + ' .ink-ai-empty{margin:auto;text-align:center;color:var(--text-dim,#94a3b8);font-size:12.5px;line-height:1.8;padding:20px 8px}',
        '#' + PANEL_ID + ' .ink-ai-empty b{color:inherit;font-weight:600}',
        '#' + PANEL_ID + ' .ink-ai-err{color:#b91c1c;background:rgba(185,28,28,.08);border:1px solid rgba(185,28,28,.25);border-radius:8px;padding:6px 8px;font-size:12px;word-break:break-word}',
        '#' + PANEL_ID + ' .ink-ai-composer{flex:0 0 auto;border-top:1px solid var(--border,#e8edf3);padding:8px 10px 10px;display:flex;flex-direction:column;gap:6px}',
        '#' + PANEL_ID + ' textarea.ink-ai-input{width:100%;min-height:56px;max-height:160px;resize:none;border:1px solid var(--border,#dfe6ee);',
        'border-radius:var(--radius-sm,8px);background:transparent;color:inherit;font:inherit;padding:7px 9px;outline:none;line-height:1.55}',
        '#' + PANEL_ID + ' textarea.ink-ai-input:focus{border-color:var(--accent,#2f6fed)}',
        '#' + PANEL_ID + ' .ink-ai-bar{display:flex;align-items:center;gap:10px;font-size:12px;color:var(--text-dim,#64748b)}',
        '#' + PANEL_ID + ' .ink-ai-bar label{display:inline-flex;align-items:center;gap:5px;cursor:pointer;user-select:none}',
        '#' + PANEL_ID + ' .ink-ai-bar .ink-ai-status{margin-left:auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '#' + PANEL_ID + ' .ink-ai-btn{border:1px solid var(--border,#dfe6ee);background:transparent;color:inherit;font:inherit;padding:5px 12px;',
        'border-radius:var(--radius-sm,8px);cursor:pointer}',
        '#' + PANEL_ID + ' .ink-ai-btn:hover{background:var(--hover,rgba(15,23,42,.07))}',
        '#' + PANEL_ID + ' .ink-ai-btn.primary{background:var(--accent,#2f6fed);border-color:var(--accent,#2f6fed);color:#fff}',
        '#' + PANEL_ID + ' .ink-ai-btn.primary:hover{filter:brightness(1.06)}',
        '#' + PANEL_ID + ' .ink-ai-btn[disabled]{opacity:.5;cursor:not-allowed}',
        '#' + PANEL_ID + ' .ink-ai-card{border:1px solid var(--border,#e8edf3);border-radius:10px;padding:10px;display:flex;flex-direction:column;gap:6px;margin-bottom:8px}',
        '#' + PANEL_ID + ' .ink-ai-card .ink-ai-card-head{display:flex;align-items:center;gap:8px}',
        '#' + PANEL_ID + ' .ink-ai-card .ink-ai-card-name{font-weight:600}',
        '#' + PANEL_ID + ' .ink-ai-card .ink-ai-card-meta{color:var(--text-dim,#94a3b8);font-size:11.5px;word-break:break-all}',
        '#' + PANEL_ID + ' .ink-ai-card .ink-ai-spacer{flex:1 1 auto}',
        '#' + PANEL_ID + ' .ink-ai-badge{font-size:10.5px;padding:1px 6px;border-radius:999px;background:var(--accent,#2f6fed);color:#fff}',
        '#' + PANEL_ID + ' .ink-ai-field{display:flex;flex-direction:column;gap:3px;margin-bottom:8px}',
        '#' + PANEL_ID + ' .ink-ai-field > span{font-size:11.5px;color:var(--text-dim,#64748b)}',
        '#' + PANEL_ID + ' .ink-ai-field input,#' + PANEL_ID + ' .ink-ai-field textarea{width:100%;border:1px solid var(--border,#dfe6ee);border-radius:8px;',
        'background:transparent;color:inherit;font:inherit;padding:6px 8px;outline:none}',
        '#' + PANEL_ID + ' .ink-ai-field input:focus,#' + PANEL_ID + ' .ink-ai-field textarea:focus{border-color:var(--accent,#2f6fed)}',
        '#' + PANEL_ID + ' .ink-ai-presets{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px}',
        '#' + PANEL_ID + ' .ink-ai-hint{font-size:11.5px;color:var(--text-dim,#94a3b8);line-height:1.6}',
        '#' + PANEL_ID + ' .ink-ai-toast{position:absolute;left:50%;bottom:76px;transform:translateX(-50%);background:rgba(15,23,42,.88);color:#fff;',
        'font-size:12px;padding:5px 12px;border-radius:999px;opacity:0;transition:opacity .18s;pointer-events:none}',
        '#' + PANEL_ID + ' .ink-ai-toast.show{opacity:1}',
        '@media (width<=1100px){#' + PANEL_ID + '{width:100vw}}'
      ].join('');
      (document.head || document.documentElement).appendChild(style);
    } catch (err) {
      warn('样式注入失败：', err);
    }
  }

  // ---------------------------------------------------------------- 面板构建
  function buildPanel() {
    if (dom.panel) return dom.panel;
    ensureStyle();

    var providerSelect = h('select', { class: 'ink-ai-provider', title: '当前使用的 API 配置' });
    providerSelect.addEventListener('change', function () {
      if (!state.config) return;
      state.config.currentId = providerSelect.value;
      void saveConfig(state.config);
      updateHead();
      pushSystem('已切换到「' + (currentProvider() || {}).name + '」');
    });

    var head = h('div', { class: 'ink-ai-head' }, [
      h('div', { class: 'ink-ai-brand' }, [h('span', { class: 'ink-ai-dot' }), 'AI 助手']),
      providerSelect,
      h('button', { class: 'ink-ai-icon-btn', title: '新建对话', text: '＋', onclick: newChat }),
      h('button', { class: 'ink-ai-icon-btn', title: 'API 配置', text: '⚙', onclick: function () { setView(state.view === 'config' ? 'chat' : 'config'); } }),
      h('button', { class: 'ink-ai-icon-btn', title: '收起（Esc）', text: '✕', onclick: function () { toggle(false); } })
    ]);

    var body = h('div', { class: 'ink-ai-body' });
    var configBody = h('div', { class: 'ink-ai-body', style: { display: 'none' } });

    var input = h('textarea', { class: 'ink-ai-input', placeholder: '问点什么…（Enter 发送，Shift+Enter 换行）' });
    input.addEventListener('input', function () {
      try {
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight || 56, 160) + 'px';
      } catch (err) { /* ignore */ }
    });
    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
        ev.preventDefault();
        void send();
      }
    });

    var contextToggle = h('input', { type: 'checkbox', checked: state.useNoteContext });
    contextToggle.addEventListener('change', function () {
      state.useNoteContext = !!contextToggle.checked;
      updateHead();
      persistUi();
    });
    var toggleLabel = h('label', { title: '把当前笔记正文作为上下文一并发送' }, [contextToggle, '引用当前笔记']);

    var sendBtn = h('button', { class: 'ink-ai-btn primary', text: '发送', onclick: function () { void send(); } });
    var status = h('span', { class: 'ink-ai-status' });

    var bar = h('div', { class: 'ink-ai-bar' }, [toggleLabel, h('span', { class: 'ink-ai-spacer', style: { flex: '1 1 auto' } }), status, sendBtn]);
    var composer = h('div', { class: 'ink-ai-composer' }, [input, bar]);
    var toast = h('div', { class: 'ink-ai-toast' });

    var panel = h('div', { id: PANEL_ID, class: 'ink-ai-panel' }, [head, body, configBody, composer, toast]);
    try {
      (document.body || document.documentElement).appendChild(panel);
    } catch (err) {
      warn('面板挂载失败：', err);
      return null;
    }

    dom = {
      panel: panel,
      head: head,
      providerSelect: providerSelect,
      body: body,
      configBody: configBody,
      composer: composer,
      input: input,
      sendBtn: sendBtn,
      status: status,
      contextToggle: contextToggle,
      toast: toast,
      emptyEl: null,
      toastTimer: 0
    };
    return panel;
  }

  function emptyState() {
    return h('div', { class: 'ink-ai-empty' }, [
      h('div', {}, ['还没有对话。']),
      h('div', {}, ['先在右上角 ⚙ 里添加一个 API 配置，']),
      h('div', {}, ['然后就可以对着笔记提问了。'])
    ]);
  }

  function messageEl(role, content) {
    var bubble = h('div', { class: 'ink-ai-bubble' });
    if (role === 'assistant') bubble.innerHTML = md(content);
    else bubble.textContent = content;
    var msg = h('div', { class: 'ink-ai-msg ' + role }, [bubble]);
    if (role === 'assistant') {
      var actions = h('div', { class: 'ink-ai-actions' }, [
        h('button', {
          class: 'ink-ai-mini', text: '插入到笔记', title: '插入到编辑器光标处',
          onclick: function () { void insertToNote(String(msg.__inkText || '')); }
        }),
        h('button', {
          class: 'ink-ai-mini', text: '复制', title: '复制这条回复',
          onclick: function () { void copy(String(msg.__inkText || '')); }
        })
      ]);
      msg.appendChild(actions);
    }
    msg.__inkText = content;
    return msg;
  }

  function renderMessages() {
    if (!dom.body) return;
    dom.body.textContent = '';
    if (!state.history.length) {
      dom.emptyEl = emptyState();
      dom.body.appendChild(dom.emptyEl);
      return;
    }
    dom.emptyEl = null;
    state.history.forEach(function (m) {
      dom.body.appendChild(messageEl(m.role, m.content));
    });
    scrollToEnd();
  }

  function scrollToEnd() {
    try {
      if (dom.body) dom.body.scrollTop = dom.body.scrollHeight;
    } catch (err) { /* ignore */ }
  }

  /** 只往消息区追加一个气泡，不写历史（流式占位用）。 */
  function appendMessageEl(role, content) {
    if (!dom.body) return null;
    if (dom.emptyEl && dom.emptyEl.parentNode) {
      dom.emptyEl.parentNode.removeChild(dom.emptyEl);
      dom.emptyEl = null;
    }
    var el = messageEl(role, content);
    dom.body.appendChild(el);
    scrollToEnd();
    return el;
  }

  function pushMessage(role, content) {
    state.history.push({ role: role, content: content, at: Date.now() });
    saveHistory();
    return appendMessageEl(role, content);
  }

  function pushSystem(text) {
    if (!dom.body) return;
    pushMessage('system', text);
  }

  function pushError(text) {
    if (!dom.body) return;
    dom.body.appendChild(h('div', { class: 'ink-ai-err', text: text }));
    scrollToEnd();
  }

  function toast(text) {
    if (!dom.toast) return;
    try {
      dom.toast.textContent = text;
      dom.toast.className = 'ink-ai-toast show';
      if (dom.toastTimer) clearTimeout(dom.toastTimer);
      dom.toastTimer = setTimeout(function () {
        dom.toast.className = 'ink-ai-toast';
      }, 1600);
    } catch (err) { /* ignore */ }
  }

  function updateHead() {
    if (!dom.providerSelect) return;
    var cfg = state.config || normalizeConfig(null);
    try {
      dom.providerSelect.textContent = '';
      if (!cfg.providers.length) {
        dom.providerSelect.appendChild(h('option', { value: '', text: '（未配置 API）' }));
      } else {
        cfg.providers.forEach(function (p) {
          dom.providerSelect.appendChild(h('option', { value: p.id, text: p.name + (p.model ? ' · ' + p.model : '') }));
        });
      }
      dom.providerSelect.value = cfg.currentId || '';
    } catch (err) {
      warn('刷新配置下拉失败：', err);
    }
    updateStatus();
  }

  function updateStatus() {
    if (!dom.status) return;
    var provider = currentProvider();
    var parts = [];
    if (state.streaming) parts.push('生成中…');
    if (provider) {
      if (state.noteTitle) parts.push(state.noteTitle.slice(0, 14));
    } else {
      parts.push('未配置 API');
    }
    dom.status.textContent = parts.join(' · ');
  }

  // ---------------------------------------------------------------- 配置视图
  function setView(view) {
    state.view = view;
    if (dom.body) dom.body.style.display = view === 'chat' ? 'flex' : 'none';
    if (dom.configBody) dom.configBody.style.display = view === 'config' ? 'flex' : 'none';
    if (dom.composer) dom.composer.style.display = view === 'chat' ? 'flex' : 'none';
    if (view === 'config') renderConfig();
  }

  function renderConfig() {
    if (!dom.configBody) return;
    var cfg = state.config || normalizeConfig(null);
    dom.configBody.textContent = '';

    if (state.editingId) {
      dom.configBody.appendChild(configForm(cfg));
      return;
    }

    dom.configBody.appendChild(h('div', { class: 'ink-ai-hint' }, ['API 配置存在本机（桌面版存 %APPDATA%\\ink-notes\\ai-config.json，浏览器预览存 localStorage），Key 为明文，注意不要外借设备。']));

    if (!cfg.providers.length) {
      dom.configBody.appendChild(h('div', { class: 'ink-ai-empty' }, ['还没有 API 配置，点下面的「+ 添加 API」开始。']));
    }

    cfg.providers.forEach(function (p) {
      var isCurrent = p.id === cfg.currentId;
      var card = h('div', { class: 'ink-ai-card' }, [
        h('div', { class: 'ink-ai-card-head' }, [
          h('span', { class: 'ink-ai-card-name', text: p.name }),
          isCurrent ? h('span', { class: 'ink-ai-badge', text: '当前' }) : null,
          h('span', { class: 'ink-ai-spacer' }),
          isCurrent ? null : h('button', {
            class: 'ink-ai-mini', text: '设为当前',
            onclick: function () {
              cfg.currentId = p.id;
              void saveConfig(cfg).then(function () { updateHead(); renderConfig(); });
            }
          }),
          h('button', {
            class: 'ink-ai-mini', text: '编辑',
            onclick: function () { state.editingId = p.id; renderConfig(); }
          }),
          h('button', {
            class: 'ink-ai-mini', text: '删除',
            onclick: function () {
              var sure = true;
              try { sure = window.confirm('删除 API 配置「' + p.name + '」？'); } catch (err) { /* ignore */ }
              if (!sure) return;
              cfg.providers = cfg.providers.filter(function (x) { return x.id !== p.id; });
              if (cfg.currentId === p.id) cfg.currentId = cfg.providers[0] ? cfg.providers[0].id : '';
              void saveConfig(cfg).then(function () { updateHead(); renderConfig(); });
            }
          })
        ]),
        h('div', { class: 'ink-ai-card-meta', text: (p.model || '未填模型') + ' · ' + (p.baseUrl || '未填 Base URL') })
      ]);
      dom.configBody.appendChild(card);
    });

    dom.configBody.appendChild(h('button', {
      class: 'ink-ai-btn primary', text: '+ 添加 API',
      onclick: function () {
        var p = { id: uid(), name: '新配置', baseUrl: '', apiKey: '', model: '', systemPrompt: DEFAULT_SYSTEM, temperature: 0.7 };
        state.config.providers.push(p);
        state.editingId = p.id;
        renderConfig();
      }
    }));
  }

  function configForm(cfg) {
    var provider = cfg.providers.filter(function (p) { return p.id === state.editingId; })[0];
    if (!provider) {
      state.editingId = null;
      return h('div', { class: 'ink-ai-hint', text: '配置不存在。' });
    }
    var fields = {};
    var hintEl = null;
    function field(label, key, opts) {
      var opts2 = opts || {};
      var el = opts2.multiline
        ? h('textarea', { rows: 3 })
        : h('input', { type: opts2.password ? 'password' : 'text', placeholder: opts2.placeholder || '' });
      el.value = provider[key] == null ? '' : String(provider[key]);
      fields[key] = el;
      return h('label', { class: 'ink-ai-field' }, [h('span', { text: label }), el]);
    }

    // 请求终点提示：随 Base URL（含预设回填）实时更新，避免用户以为填错了地址
    function refreshHint() {
      if (!hintEl || !fields.baseUrl) return;
      var ep = endpointOf(fields.baseUrl.value);
      hintEl.textContent = '实际请求终点：' + (ep || '（待填 Base URL）');
    }

    var form = h('div', {}, [
      h('div', { class: 'ink-ai-presets' }, PRESETS.map(function (preset) {
        return h('button', {
          class: 'ink-ai-mini', text: preset.name, title: '填入 ' + preset.baseUrl,
          onclick: function () {
            fields.name.value = preset.name;
            fields.baseUrl.value = preset.baseUrl;
            fields.model.value = preset.model;
            refreshHint();
          }
        });
      }).concat([
        h('button', {
          class: 'ink-ai-mini', text: '自定义',
          onclick: function () {
            fields.name.value = fields.name.value || '自定义';
            fields.baseUrl.value = '';
            fields.model.value = '';
            refreshHint();
          }
        })
      ])),
      field('名称', 'name', { placeholder: '例如 DeepSeek 官方' }),
      field('Base URL', 'baseUrl', { placeholder: 'https://api.deepseek.com/v1' }),
      field('API Key', 'apiKey', { password: true, placeholder: 'sk-...' }),
      field('模型', 'model', { placeholder: 'deepseek-chat' }),
      field('温度（0~2，默认 0.7）', 'temperature', { placeholder: '0.7' }),
      field('系统提示词', 'systemPrompt', { multiline: true })
    ]);

    var save = h('button', {
      class: 'ink-ai-btn primary', text: '保存',
      onclick: function () {
        provider.name = String(fields.name.value || '').trim() || '未命名服务';
        provider.baseUrl = String(fields.baseUrl.value || '').trim();
        provider.apiKey = String(fields.apiKey.value || '').trim();
        provider.model = String(fields.model.value || '').trim();
        provider.systemPrompt = String(fields.systemPrompt.value || '') || DEFAULT_SYSTEM;
        var t = parseFloat(fields.temperature.value);
        provider.temperature = isNaN(t) ? 0.7 : Math.min(2, Math.max(0, t));
        if (!cfg.currentId) cfg.currentId = provider.id;
        void saveConfig(cfg).then(function () {
          state.editingId = null;
          updateHead();
          renderConfig();
          toast('已保存');
        });
      }
    });
    var cancel = h('button', {
      class: 'ink-ai-btn', text: '取消',
      onclick: function () {
        state.editingId = null;
        renderConfig();
      }
    });

    var hint = h('div', { class: 'ink-ai-hint' });
    hintEl = hint;
    refreshHint();
    if (fields.baseUrl) fields.baseUrl.addEventListener('input', refreshHint);

    return h('div', {}, [
      h('div', { class: 'ink-ai-card-head' }, [h('span', { class: 'ink-ai-card-name', text: '编辑 API 配置' })]),
      form,
      hint,
      h('div', { style: { display: 'flex', gap: '8px', marginTop: '10px' } }, [save, cancel])
    ]);
  }

  // ---------------------------------------------------------------- 动作
  function persistUi() {
    try {
      storage.setItem(LS_UI, JSON.stringify({ useNoteContext: state.useNoteContext }));
    } catch (err) { /* ignore */ }
  }

  function restoreUi() {
    try {
      var raw = storage.getItem(LS_UI);
      if (!raw) return;
      var ui = JSON.parse(raw);
      if (ui && typeof ui.useNoteContext === 'boolean') state.useNoteContext = ui.useNoteContext;
    } catch (err) { /* ignore */ }
  }

  function toggle(open) {
    var next = typeof open === 'boolean' ? open : !state.open;
    state.open = next;
    var panel = buildPanel();
    if (!panel) return false;
    if (next) {
      panel.className = PANEL_ID + ' open';
      updateHead();
      if (!state.config || !state.config.providers.length) setView('config');
      else setView(state.view);
      try { if (dom.input) dom.input.focus(); } catch (err) { /* ignore */ }
    } else {
      panel.className = PANEL_ID;
    }
    return true;
  }

  function newChat() {
    state.history = [];
    saveHistory();
    if (dom.body) {
      dom.body.textContent = '';
      renderMessages();
    }
    setView('chat');
    toast('已新建对话');
  }

  function onEditor(view) {
    state.editorView = view || null;
    // 编辑器换笔记时标题可能变化，顺带刷新一下状态行
    try {
      if (dom.panel) updateStatus();
    } catch (err) { /* ignore */ }
    return true;
  }

  function insertToNote(text) {
    var content = String(text || '');
    if (!content.trim()) return false;
    var view = resolveView();
    try {
      if (view && view.state && typeof view.dispatch === 'function') {
        var sel = view.state.selection && view.state.selection.main ? view.state.selection.main : { from: 0, to: 0 };
        var prefix = '';
        try {
          var doc = view.state.doc;
          var before = doc && typeof doc.sliceString === 'function' ? doc.sliceString(Math.max(0, sel.from - 1), sel.from) : '';
          var after = doc && typeof doc.sliceString === 'function' ? doc.sliceString(sel.to, sel.to + 1) : '';
          if (before && before !== '\n') prefix = '\n\n';
          else if (!before && after && after !== '\n') prefix = '';
          else if (!before && !after) prefix = '';
          if (before === '\n' && after !== '\n' && after) prefix = '\n';
        } catch (err) { /* 位置修饰失败不影响插入 */ }
        var insert = prefix + content;
        view.dispatch({
          changes: { from: sel.from, to: sel.to, insert: insert },
          selection: { anchor: sel.from + insert.length }
        });
        if (typeof view.focus === 'function') view.focus();
        toast('已插入到笔记');
        return true;
      }
    } catch (err) {
      warn('通过编辑器插入失败，尝试回退方案：', err);
    }
    // 回退：对当前聚焦的可编辑元素执行 insertText
    try {
      if (document.execCommand && document.execCommand('insertText', false, content)) {
        toast('已插入到笔记');
        return true;
      }
    } catch (err2) {
      warn('回退插入失败：', err2);
    }
    toast('插入失败：请先打开一篇 Markdown 笔记');
    return false;
  }

  function copy(text) {
    var content = String(text || '');
    if (!content) return Promise.resolve(false);
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(content).then(function () {
          toast('已复制');
          return true;
        }).catch(function () {
          toast('复制失败');
          return false;
        });
      }
    } catch (err) { /* ignore */ }
    toast('复制失败');
    return Promise.resolve(false);
  }

  function setStreaming(on, requestId) {
    state.streaming = !!on;
    state.requestId = on ? requestId : null;
    if (dom.sendBtn) {
      dom.sendBtn.textContent = on ? '停止' : '发送';
      dom.sendBtn.className = on ? 'ink-ai-btn' : 'ink-ai-btn primary';
    }
    updateStatus();
  }

  function send() {
    if (state.streaming) {
      abort(state.requestId);
      setStreaming(false, null);
      return Promise.resolve();
    }
    var input = dom.input;
    var text = input ? String(input.value || '').trim() : '';
    if (!text) return Promise.resolve();
    var provider = currentProvider();
    if (!provider) {
      setView('config');
      pushError('还没有可用的 API 配置，请先添加一个。');
      return Promise.resolve();
    }
    if (!provider.baseUrl || !provider.model) {
      setView('config');
      pushError('当前配置缺少 Base URL 或模型名，请补全后重试。');
      return Promise.resolve();
    }

    if (input) {
      input.value = '';
      input.style.height = 'auto';
    }
    pushMessage('user', text);

    var context = '';
    if (state.useNoteContext) {
      var note = readNote();
      state.noteTitle = note.title || state.noteTitle;
      if (String(note.content || '').trim()) {
        var clipped = clipContext(note.content);
        context = clipped.text;
        if (clipped.truncated) pushSystem('笔记较长，已截断后作为上下文发送。');
      }
    }

    var messages = buildMessages({
      provider: provider,
      history: state.history,
      context: context,
      title: state.noteTitle
    });

    var requestId = 'r' + Date.now().toString(36);
    var el = appendMessageEl('assistant', '');
    state.streamText = '';
    state.streamEl = el;
    setStreaming(true, requestId);
    updateStatus();

    var lastPaint = 0;
    function onDelta(delta) {
      state.streamText += delta;
      var now = Date.now();
      if (now - lastPaint < STREAM_RENDER_MS) return;
      lastPaint = now;
      paintStream();
    }
    function paintStream() {
      if (!state.streamEl) return;
      state.streamEl.__inkText = state.streamText;
      var bubble = state.streamEl.firstChild;
      if (bubble) bubble.innerHTML = md(state.streamText) || '<em>…</em>';
      scrollToEnd();
    }

    return chat({
      requestId: requestId,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      model: provider.model,
      temperature: provider.temperature,
      messages: messages,
      onDelta: onDelta
    }).then(function (full) {
      var text2 = full || state.streamText;
      state.streamText = text2;
      paintStream();
      if (state.streamEl) state.streamEl.__inkText = text2;
      if (text2) {
        state.history.push({ role: 'assistant', content: text2, at: Date.now() });
        saveHistory();
      } else {
        pushError('模型没有返回内容。');
      }
      setStreaming(false, null);
    }).catch(function (err) {
      var message = err && err.message ? err.message : String(err);
      if (/abort/i.test(message)) {
        if (state.streamText) {
          state.history.push({ role: 'assistant', content: state.streamText, at: Date.now() });
          saveHistory();
        }
        pushSystem('已停止生成。');
      } else {
        pushError('请求失败：' + message);
      }
      if (state.streamEl && !state.streamText && state.streamEl.parentNode) {
        state.streamEl.parentNode.removeChild(state.streamEl);
      }
      setStreaming(false, null);
    });
  }

  // ---------------------------------------------------------------- 启动
  function boot() {
    if (state.booted) return;
    state.booted = true;
    restoreUi();

    var api = bridge();
    if (api && typeof api.onAiChunk === 'function') {
      try {
        api.onAiChunk(function (payload) {
          if (!payload || payload.requestId !== state.requestId) return;
          if (payload.delta) {
            state.streamText += payload.delta;
            if (state.streamEl) {
              state.streamEl.__inkText = state.streamText;
              var bubble = state.streamEl.firstChild;
              if (bubble) bubble.innerHTML = md(state.streamText) || '<em>…</em>';
              scrollToEnd();
            }
          }
        });
      } catch (err) {
        warn('注册流式回调失败：', err);
      }
    }

    try {
      document.addEventListener('keydown', function (ev) {
        if (!ev.ctrlKey || !ev.shiftKey || ev.altKey || ev.metaKey) return;
        var key = String(ev.key || '').toLowerCase();
        if (key !== 'a') return;
        ev.preventDefault();
        ev.stopPropagation();
        toggle();
      }, true);
    } catch (err) {
      warn('注册快捷键失败：', err);
    }

    void loadConfig().then(function (cfg) {
      state.config = cfg;
      state.history = loadHistory();
      buildPanel();
      updateHead();
      if (state.history.length) renderMessages();
    });
  }

  return {
    onEditor: onEditor,
    toggle: toggle,
    boot: boot,
    insertToNote: insertToNote,
    send: send,
    internals: {
      esc: esc,
      inline: inline,
      md: md,
      endpointOf: endpointOf,
      normalizeConfig: normalizeConfig,
      clipContext: clipContext,
      buildMessages: buildMessages,
      parseSseChunk: parseSseChunk,
      buildRequest: buildRequest,
      setState: function (patch) {
        Object.keys(patch || {}).forEach(function (k) { state[k] = patch[k]; });
        return state;
      },
      getState: function () { return state; },
      setDom: function (patch) { Object.keys(patch || {}).forEach(function (k) { dom[k] = patch[k]; }); return dom; },
      version: 1
    }
  };
})();

function __inkAiOnEditor(view) {
  try {
    return __inkAiApi.onEditor(view);
  } catch (err) {
    try { console.warn('[AI 助手] 绑定编辑器失败：', err); } catch (e2) { /* ignore */ }
    return false;
  }
}

function __inkAiToggle() {
  try {
    return __inkAiApi.toggle();
  } catch (err) {
    try { console.warn('[AI 助手] 打开面板失败：', err); } catch (e2) { /* ignore */ }
    return false;
  }
}

// bundle 是 ES module，模块内的名字不会自动出现在 window 上；
// 主动暴露一份，便于在 DevTools 里排查（__inkAiApi.internals.getState() 等）与自动化验证。
(function () {
  try {
    if (typeof window === 'undefined') return;
    window.__inkAiApi = __inkAiApi;
    window.__inkAiToggle = __inkAiToggle;
    window.__inkAiOnEditor = __inkAiOnEditor;
  } catch (err) {
    /* ignore */
  }
})();

(function () {
  try {
    var start = function () {
      try { __inkAiApi.boot(); } catch (err) {
        try { console.warn('[AI 助手] 启动失败：', err); } catch (e2) { /* ignore */ }
      }
    };
    if (typeof document === 'undefined') return;
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else setTimeout(start, 0);
  } catch (err) {
    /* ignore */
  }
})();
