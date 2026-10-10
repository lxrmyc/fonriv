/* ============================================================================
 * hotkeys.js · v4.70.1 · 全局快捷键系统
 *  - 可配置快捷键 (localStorage 持久化, 设置页可改, 支持恢复默认)
 *  - 内置动作:
 *      fullscreen     全屏 / 退出全屏 (当前可全屏区域; 无区域时全屏整个内容区)
 *      fullscreenExit 仅退出全屏
 *      focusSearch    聚焦左栏文件过滤框
 *      previewTab     传输页切到「文件预览」Tab
 *      listTab        传输页切回「传输列表」Tab
 *      refresh        刷新当前列表
 *  - 默认: Ctrl+Shift+F = 全屏, F11 = 全屏(浏览器通常占用, 可改), Esc = 退出全屏
 *  - API: Hotkeys.get() / set(map) / reset() / bind(action, fn) / fire(action)
 * ========================================================================== */
(function(g){
  'use strict';

  var KEY = 'rp_hotkeys_v1';
  var ACTIONS = {
    fullscreen:     { label: '全屏 / 退出全屏', def: 'Ctrl+Shift+F' },
    fullscreenExit: { label: '仅退出全屏',      def: 'Escape' },
    focusSearch:    { label: '聚焦文件过滤框',  def: 'Ctrl+F' },
    previewTab:     { label: '切到「文件预览」Tab', def: 'Ctrl+1' },
    listTab:        { label: '切到「传输列表」Tab', def: 'Ctrl+2' },
    refresh:        { label: '刷新当前列表',     def: 'Ctrl+R' },
    portal:         { label: '打开传送门 (快速跳转)', def: 'Ctrl+G' },   // v5.84.0 · 用户要求把 Ctrl+G 纳入快捷键
  };
  var _map = null;      // { action: combo }
  var _handlers = {};   // { action: [fn] }

  function defaults(){
    var m = {};
    Object.keys(ACTIONS).forEach(function(k){ m[k] = ACTIONS[k].def; });
    return m;
  }
  function load(){
    if (_map) return _map;
    _map = defaults();
    try {
      var raw = localStorage.getItem(KEY);
      if (raw){
        var o = JSON.parse(raw) || {};
        Object.keys(o).forEach(function(k){ if (k in ACTIONS) _map[k] = o[k]; });
      }
    } catch(e){}
    return _map;
  }
  function save(){
    try { localStorage.setItem(KEY, JSON.stringify(_map || defaults())); } catch(e){}
  }
  function get(){ return Object.assign({}, load()); }
  function set(o){
    load();
    Object.keys(o || {}).forEach(function(k){ if (k in ACTIONS) _map[k] = o[k]; });
    save();
    return get();
  }
  function reset(){
    _map = defaults();
    save();
    return get();
  }

  // ── 组合键解析 ──
  function comboOf(ev){
    if (ev.key === 'Escape') return 'Escape';   // Esc 单独成键, 不带修饰
    var parts = [];
    if (ev.ctrlKey) parts.push('Ctrl');
    if (ev.altKey) parts.push('Alt');
    if (ev.shiftKey) parts.push('Shift');
    if (ev.metaKey) parts.push('Meta');
    var k = ev.key;
    if (!k) return '';
    if (k === ' ') k = 'Space';
    else if (k.length === 1) k = k.toUpperCase();
    // 有修饰键时, 忽略纯修饰键本身
    if (['Control','Alt','Shift','Meta'].indexOf(k) >= 0) return '';
    parts.push(k);
    return parts.join('+');
  }
  function normalize(str){
    if (!str) return '';
    var p = String(str).split('+').map(function(x){ return x.trim(); }).filter(Boolean);
    var out = [];
    var mods = ['Ctrl','Alt','Shift','Meta'];
    mods.forEach(function(m){ if (p.indexOf(m) >= 0) out.push(m); });
    p.forEach(function(x){ if (mods.indexOf(x) < 0) out.push(x.length === 1 ? x.toUpperCase() : x); });
    return out.join('+');
  }

  // ── 动作执行 ──
  function bind(action, fn){
    (_handlers[action] = _handlers[action] || []).push(fn);
  }
  function fire(action){
    var hs = _handlers[action] || [];
    for (var i = 0; i < hs.length; i++){
      try { if (hs[i]() === true) return true; } catch(e){ console.warn('[hotkeys] handler', action, e); }
    }
    return false;
  }

  // ── 默认处理器 ──
  document.addEventListener('keydown', function(ev){
    // 输入框内: 仅放行带修饰键的组合与 Esc, 避免干扰打字
    var t = ev.target || {};
    var tag = (t.tagName || '').toUpperCase();
    var typing = (tag === 'INPUT' || tag === 'TEXTAREA' || t.isContentEditable);
    var combo = comboOf(ev);
    if (!combo) return;
    var map = load();
    var hit = null;
    Object.keys(map).forEach(function(a){ if (hit) return; if (normalize(map[a]) === combo) hit = a; });
    if (!hit) return;
    if (typing && combo !== 'Escape') return;

    // Ctrl+R / F5 类交给页面自己处理时避免双重刷新
    var handled = fire(hit);
    // v5.90.5 · 输入框里的 Esc: 只在真全屏时才拦截(退出全屏), 否则放行给输入框
    //   (此前无条件 stopPropagation, 地址栏/过滤框的 Esc 全部被吞 — 实测缺陷)
    if (typing && hit === 'fullscreenExit'){
      var _fsOn = document.fullscreenElement || document.webkitFullscreenElement;
      if (!_fsOn) return;
    }
    if (handled || hit === 'fullscreen' || hit === 'fullscreenExit'){
      if (ev.preventDefault) ev.preventDefault();
      if (ev.stopPropagation) ev.stopPropagation();
    }
  }, true);

  // ── 内置: 全屏 (支持 独立全屏按钮区域 / 内容区兜底) ──
  function _activeFullHost(){
    // 优先: 当前可见的可全屏区域
    var cands = [
      { el: document.querySelector('#panel-file_preview .fpp-cols'), page: 'file_preview' },
      { el: document.querySelector('#panel-disk_manager .tri-grid'), page: 'disk_manager' },
      { el: document.querySelector('#triPaneTransfer .tp-grid'), page: 'transfer' },
      { el: document.querySelector('#panel-transfer .tri-grid'), page: 'transfer' },
    ];
    for (var i = 0; i < cands.length; i++){
      var it = cands[i];
      if (it.el && it.el.offsetParent !== null) return it;
    }
    return null;
  }
  function _isFull(){
    if (document.fullscreenElement) return true;
    return !!document.querySelector('.rp-fullscreen-host');
  }
  function _applyAppFull(el, on){
    if (!el) return;
    if (on) el.classList.add('rp-fullscreen-host');
    else el.classList.remove('rp-fullscreen-host');
  }
  g.addEventListener('beforeunload', function(){
    document.querySelectorAll('.rp-fullscreen-host').forEach(function(e){ e.classList.remove('rp-fullscreen-host'); });
  });

  function toggleFull(){
    // 1) 已在全屏 → 退出
    if (document.fullscreenElement){
      try { document.exitFullscreen(); } catch(e){}
      return true;
    }
    var host = document.querySelector('.rp-fullscreen-host');
    if (host){ _applyAppFull(host, false); _notify(); return true; }
    // 2) 页面级全屏实现优先 (文件预览页有自己的兜底)
    var cur = (g._currentPanelKey || '');
    if (cur === 'file_preview' && g.FilePreviewPage && g.FilePreviewPage.toggleFull){
      g.FilePreviewPage.toggleFull();
      return true;
    }
    // 3) 通用: 当前可见的可全屏区域
    var it = _activeFullHost();
    if (it && it.el){
      try {
        var pr = it.el.requestFullscreen && it.el.requestFullscreen();
        if (pr && pr.then){
          pr.then(function(){ _notify(); }).catch(function(){ _applyAppFull(it.el, true); _notify(); });
        }
        setTimeout(function(){ if (!document.fullscreenElement && !it.el.classList.contains('rp-fullscreen-host')){ _applyAppFull(it.el, true); _notify(); } }, 400);
      } catch(e){ _applyAppFull(it.el, true); _notify(); }
      return true;
    }
    // 4) 兜底: 整个内容区
    var content = document.querySelector('.content');
    if (content){ _applyAppFull(content, true); _notify(); return true; }
    return false;
  }
  function exitFull(){
    if (document.fullscreenElement){ try { document.exitFullscreen(); } catch(e){} return true; }
    var host = document.querySelector('.rp-fullscreen-host');
    if (host){ _applyAppFull(host, false); _notify(); return true; }
    if (g.FilePreviewPage && g.FilePreviewPage.isFull && g.FilePreviewPage.isFull()){
      if (g.FilePreviewPage.onLeave) g.FilePreviewPage.onLeave();
      _notify();
      return true;
    }
    return false;
  }
  function _notify(){
    if (g.FilePreview && g.FilePreview.syncFullBtns){
      g.FilePreview.syncFullBtns(_isFull());
    }
    // 通用全屏按钮态同步 (任意页面内的 [data-rp-fullbtn])
    document.querySelectorAll('[data-rp-fullbtn]').forEach(function(b){
      b.textContent = _isFull() ? '⛶ 退出全屏' : '⛶ 全屏';
      b.style.background = _isFull() ? 'var(--green)' : '';
      b.style.color = _isFull() ? '#fff' : '';
    });
  }
  document.addEventListener('fullscreenchange', _notify);

  bind('fullscreen', toggleFull);
  bind('fullscreenExit', exitFull);

  // 应用内全屏样式
  (function inject(){
    if (document.getElementById('rpHkStyle')) return;
    var st = document.createElement('style');
    st.id = 'rpHkStyle';
    st.textContent = '.rp-fullscreen-host{position:fixed !important;inset:0 !important;z-index:99999;'+
      'background:var(--bg);padding:10px;overflow:auto;margin:0 !important}';
    document.head.appendChild(st);
  })();

  g.Hotkeys = { get: get, set: set, reset: reset, defaults: defaults, actions: ACTIONS,
                bind: bind, fire: fire, toggleFull: toggleFull, exitFull: exitFull,
                isFull: _isFull, comboOf: comboOf, normalize: normalize };
})(window);
