/* v4.15.28 · 侧栏宽度拖动 + localStorage 持久化
 *
 * 依赖：
 *   #sidebar        (侧栏容器)
 *   #sidebarResizer (index.html 里紧跟 sidebar 的分隔条 div)
 *   CSS 变量 --sidebar-width  (在 :root / html / body 上都生效)
 *   toggleSidebar() 已存在（ui_prefs.js 里 window.toggleSidebar）
 *
 * 行为：
 *   - 按下 resizer 开始拖动 → mousemove 时把宽度写到 :root style
 *   - 松开后写 localStorage['rp_sidebar_width']
 *   - 双击 resizer → 复位到 220px
 *   - 拖动范围：[160, 480]（防止拖没或拖爆）
 *   - 折叠状态时禁用（CSS hidden）
 *   - 页面加载时从 localStorage 恢复
 */
(function(){
  var MIN_W = 160;
  var MAX_W = 480;
  var DEFAULT_W = 256;   // v6.1.9 · 统一侧栏基准 256px(与多云文件管理侧栏同宽; 旧记忆值仍尊重)
  var LS_KEY = 'rp_sidebar_width';

  function applyWidth(w){
    w = Math.max(MIN_W, Math.min(MAX_W, parseInt(w, 10) || DEFAULT_W));
    document.documentElement.style.setProperty('--sidebar-width', w + 'px');
    return w;
  }

  function restore(){
    var saved = null;
    try { saved = localStorage.getItem(LS_KEY); } catch(_){}
    if (saved && !isNaN(parseInt(saved, 10))){
      var v = parseInt(saved, 10);
      /* v6.2.1 · 一次性统一侧栏宽度: 旧默认 220 的记忆值清除, 让 256 新基准生效
         (用户拖到 >=240 的自定义值视为有意保留) */
      if (v < 240 && !localStorage.getItem('rp_sidebar_w_unified')){
        try { localStorage.removeItem(LS_KEY); localStorage.setItem('rp_sidebar_w_unified', '1'); } catch(_){}
        applyWidth(DEFAULT_W);
        return;
      }
      applyWidth(v);
    } else {
      applyWidth(DEFAULT_W);
    }
  }

  function persist(w){
    try { localStorage.setItem(LS_KEY, String(w)); } catch(_){}
  }

  function initResizer(){
    var el = document.getElementById('sidebarResizer');
    if (!el) return;
    var dragging = false;
    var startX = 0;
    var startW = DEFAULT_W;

    function onDown(ev){
      // 折叠中禁用
      if (document.body.classList.contains('sidebar-collapsed')) return;
      dragging = true;
      startX = ev.clientX;
      var cs = getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width');
      startW = parseInt(cs, 10) || DEFAULT_W;
      el.classList.add('dragging');
      document.body.classList.add('resizing-sidebar');
      ev.preventDefault();
    }

    function onMove(ev){
      if (!dragging) return;
      var dx = ev.clientX - startX;
      applyWidth(startW + dx);
    }

    function onUp(){
      if (!dragging) return;
      dragging = false;
      el.classList.remove('dragging');
      document.body.classList.remove('resizing-sidebar');
      var cs = getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width');
      var w = parseInt(cs, 10) || DEFAULT_W;
      persist(w);
    }

    function onDblClick(){
      applyWidth(DEFAULT_W);
      persist(DEFAULT_W);
    }

    el.addEventListener('mousedown', onDown);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    el.addEventListener('dblclick', onDblClick);
  }

  // 立即恢复（避免 FOUC），再挂事件
  restore();
  if (document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', initResizer);
  } else {
    initResizer();
  }

  // 暴露给控制台调试
  window.SidebarResize = {
    set: function(w){ applyWidth(w); persist(w); },
    reset: function(){ applyWidth(DEFAULT_W); persist(DEFAULT_W); },
    get: function(){
      return parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width'), 10) || DEFAULT_W;
    }
  };
})();
