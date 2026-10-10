/* v4.80.0 · Monaco 编辑器集成
 * 懒加载: 首次调用 openMonaco() 时才注入 CSS+JS
 * 用法: MonacoEditor.open(container, { value, language, onChange, onSave, theme })
 *       MonacoEditor.destroy()
 *       MonacoEditor.setValue(val) / getValue()
 */
(function(g){
  'use strict';

  var _loaded = false;
  var _loading = false;
  var _pending = [];       // 加载完成后待执行的回调
  var _editors = {};       // domId → editor instance
  var _counter = 0;

  // ── 懒加载 Monaco ──
  function _ensureLoaded(cb){
    if (_loaded){ cb(); return; }
    _pending.push(cb);
    if (_loading) return;
    _loading = true;

    // CSS
    if (!document.getElementById('monaco-css')){
      var link = document.createElement('link');
      link.id = 'monaco-css';
      link.rel = 'stylesheet';
      link.href = '/static/vendor/monaco/monaco.min.css';
      document.head.appendChild(link);
    }
    // JS · v4.93.0 修复: monaco.min.js 是 AMD 模块, 须经官方 loader.js 加载
    // (旧实现直接 <script> 引入 → "define is not defined", monaco 全局从未出现, 一直静默降级 textarea)
    if (!document.getElementById('monaco-js')){
      var js = document.createElement('script');
      js.id = 'monaco-js';
      js.src = '/static/vendor/monaco/loader.js';
      js.onload = function(){
        try {
          require.config({ paths: { vs: '/static/vendor/monaco',
                                    'vs/editor/editor.main': '/static/vendor/monaco/monaco.min' } });
          require(['vs/editor/editor.main'], function(){
            _loaded = true;
            _configureTheme();
            _pending.forEach(function(cb2){ try { cb2(); } catch(e){} });
            _pending = [];
          }, function(err){
            _loaded = true;  // 标记已尝试, open() 检测 monaco 不存在退回 textarea
            console.error('[Monaco] require failed', err);
            _pending.forEach(function(cb2){ try { cb2(); } catch(e){} });
            _pending = [];
          });
        } catch(e){
          _loaded = true;
          console.error('[Monaco] loader config failed', e);
          _pending.forEach(function(cb2){ try { cb2(); } catch(e){} });
          _pending = [];
        }
      };
      js.onerror = function(){
        _loading = false;
        console.error('[Monaco] loader.js load failed');
        _loaded = true; // 标记为已尝试
        _pending.forEach(function(cb2){ try { cb2(); } catch(e){} });
        _pending = [];
      };
      document.head.appendChild(js);
    }
  }

  function _configureTheme(){
    if (typeof monaco === 'undefined') return;
    monaco.editor.defineTheme('rp-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [],
      colors: {
        'editor.background': '#161b22',
        'editor.lineHighlightBackground': '#21262d',
        'editorLineNumber.foreground': '#484f58',
        'editorCursor.foreground': '#58a6ff',
      }
    });
    monaco.editor.defineTheme('rp-light', {
      base: 'vs',
      inherit: true,
      rules: [],
      colors: {
        'editor.background': '#ffffff',
        'editor.lineHighlightBackground': '#f6f8fa',
      }
    });
  }

  function _getTheme(){
    // 浅色主题(light)用亮色编辑器, 其余用深色编辑器
    var _t = document.documentElement.getAttribute('data-theme');
    return (_t === 'light') ? 'rp-light' : 'rp-dark';
  }

  // 语言映射 (扩展名 → Monaco languageId)
  var LANG_MAP = {
    js: 'javascript', ts: 'typescript', jsx: 'javascript', tsx: 'typescript',
    py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
    c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cs: 'csharp',
    html: 'html', htm: 'html', xml: 'xml', svg: 'xml',
    css: 'css', scss: 'scss', less: 'less',
    json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'ini',
    sh: 'shell', bash: 'shell', zsh: 'shell',
    sql: 'sql', md: 'markdown', php: 'php', lua: 'lua',
    pl: 'perl', r: 'r', swift: 'swift', kt: 'kotlin',
    dockerfile: 'dockerfile', makefile: 'makefile',
    ini: 'ini', conf: 'ini', cfg: 'ini', properties: 'ini',
    service: 'ini', timer: 'ini',
  };
  function langFromName(name){
    if (!name) return 'plaintext';
    var base = String(name).split('/').pop().toLowerCase();
    if (base === 'dockerfile') return 'dockerfile';
    if (base === 'makefile') return 'makefile';
    if (base.indexOf('.') < 0) return 'plaintext';
    var ext = base.split('.').pop();
    return LANG_MAP[ext] || 'plaintext';
  }

  // ── 打开 Monaco 编辑器 (嵌入 container) ──
  function open(container, opts){
    if (!container) return;
    opts = opts || {};
    var domId = 'monaco_' + (++_counter);
    container.innerHTML = '<div id="' + domId + '" style="width:100%;height:100%"></div>';
    var value = opts.value || '';
    var lang = opts.language || langFromName(opts.name || '');

    _ensureLoaded(function(){
      var el = document.getElementById(domId);
      if (!el || !el.isConnected){
        // container 已被替换 → 降级 textarea
        _fallback(container, opts);
        return;
      }
      if (typeof monaco === 'undefined'){
        _fallback(container, opts);
        return;
      }
      var ed = monaco.editor.create(el, {
        value: value,
        language: lang,
        theme: _getTheme(),
        automaticLayout: true,
        minimap: { enabled: false },
        fontSize: 13,
        lineNumbers: 'on',
        wordWrap: 'off',
        scrollBeyondLastLine: false,
        renderWhitespace: 'none',
        tabSize: 4,
        readOnly: false,
      });
      _editors[domId] = ed;

      // Ctrl+S 快捷键
      ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, function(){
        if (typeof opts.onSave === 'function') opts.onSave(ed.getValue());
      });
      if (typeof opts.onChange === 'function'){
        ed.onDidChangeModelContent(function(){ opts.onChange(ed.getValue()); });
      }
      if (typeof opts.onReady === 'function') opts.onReady(ed);
    });

    return domId;
  }

  // Monaco 未加载成功 → 降级 textarea
  function _fallback(container, opts){
    container.innerHTML = '<textarea style="width:100%;height:100%;font-family:monospace;font-size:13px;'+
      'background:var(--bg);color:var(--text);border:none;outline:none;resize:none;padding:8px;'+
      'white-space:pre;overflow:auto" spellcheck="false">'+ (opts.value||'').replace(/</g,'&lt;') +'</textarea>';
    var ta = container.querySelector('textarea');
    if (ta && opts.onSave){
      ta.addEventListener('keydown', function(e){
        if ((e.ctrlKey||e.metaKey) && e.key === 's'){ e.preventDefault(); opts.onSave(ta.value); }
      });
    }
  }

  function getValue(domId){
    var ed = _editors[domId];
    if (ed) return ed.getValue();
    var el = document.getElementById(domId);
    if (el){
      var ta = el.querySelector('textarea');
      if (ta) return ta.value;
    }
    return '';
  }

  function setValue(domId, val){
    var ed = _editors[domId];
    if (ed) ed.setValue(val);
  }

  function destroy(){
    Object.keys(_editors).forEach(function(k){
      try { _editors[k].dispose(); } catch(e){}
    });
    _editors = {};
  }

  // 语言切换时更新主题
  if (g.addEventListener){
    var _themeObserver = new MutationObserver(function(){
      if (typeof monaco !== 'undefined'){
        monaco.editor.setTheme(_getTheme());
      }
    });
    document.addEventListener('DOMContentLoaded', function(){
      _themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    });
  }

  g.MonacoEditor = { open: open, getValue: getValue, setValue: setValue, destroy: destroy,
                     editors: _editors,  // v4.93.0 · 导出活动编辑器表 (修复按钮保存读不到 Monaco 值)
                     langFromName: langFromName, isLoaded: function(){ return _loaded && typeof monaco !== 'undefined'; } };
})(window);
