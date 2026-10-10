/* v6.1.0 · shell_webui — webui 参考稿版面壳层
 *
 * 职责(只做渲染与接线, 不改业务逻辑):
 *   1. 左侧栏「活跃会话」区块(conn_list; 空态提示)
 *   2. 左侧栏底部 CPU/内存/磁盘 资源条(system_stats + system.stats 事件; 网络行由 app.js 带宽监控驱动)
 *   3. 顶栏右上角: 🔍 搜索聚焦连接中心 · 头像下拉(设置/授权/改密/退出)与用户首字母
 *
 * v6.1.2 · 侧栏「按类型/分组」计数区块已按用户要求移除 —— 服务器树(SP.renderSidebarSection)
 *          自带 按分组/按类型 切换与可点击服务器, 不再重复一份计数列表。
 * 数据走既有 WS RPC: conn_list / system_stats。渲染失败/未登录时静默保留上次内容。
 */
(function(){
  'use strict';

  var SESSIONS = [];    // conn_list 会话

  function rpc(action, data){
    return new Promise(function(resolve){
      try { window.send(Object.assign({action: action}, data || {}), resolve); }
      catch(e){ resolve(null); }
    });
  }

  /* ── 活跃会话 (webui: 绿点 + 图标 + 名称) ── */
  function renderSessions(){
    var host = document.getElementById('sbSessions');
    var cnt = document.getElementById('sbSessCount');
    var act = SESSIONS.filter(function(s){ return s.state === 'connected'; });
    if (cnt) cnt.textContent = act.length ? ('● ' + act.length) : '';
    if (!host) return;
    if (!act.length){
      host.innerHTML = '<div style="font-size:11px;color:var(--text3);padding:3px 7px" title="连接中心建立 SSH 会话后出现在这里">无活跃会话</div>';
      return;
    }
    host.innerHTML = act.slice(0, 8).map(function(s){
      var name = s.name || s.endpoint || (s.host + (s.port ? ':' + s.port : ''));
      return '<div class="si" title="' + esc(s.endpoint || '') + (s.remain_sec != null ? ' · 剩 ' + esc(String(s.remain_sec)) + 's' : '') + '">'
        + '<span class="dot on"></span>'
        + '<span class="si-ic">💻</span>'
        + '<span class="si-nm">' + esc(name) + '</span>'
        + '</div>';
    }).join('');
  }

  function esc(s){
    return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
    });
  }

  /* ── 底部资源条: CPU / 内存 / 磁盘 (webui stat-r) ── */
  function renderStats(s){
    if (!s) return;
    function set(barId, valId, pct, txt){
      pct = Math.max(0, Math.min(100, Number(pct) || 0));
      var bar = document.getElementById(barId);
      var val = document.getElementById(valId);
      if (bar){
        bar.style.width = pct.toFixed(1) + '%';
        bar.className = 'stat-bar ' + (pct >= 90 ? 'bar-crit' : (pct >= 70 ? 'bar-warn' : 'bar-ok'));
      }
      if (val) val.textContent = txt != null ? txt : pct.toFixed(0) + '%';
    }
    var mem = s.memory || {}, disk = s.disk || {};
    set('sbCpuBar',  'sbCpuVal',  s.cpu_percent || 0);
    set('sbMemBar',  'sbMemVal',  mem.percent || 0);
    set('sbDiskBar', 'sbDiskVal', disk.percent || 0);
  }

  async function loadStats(){
    var r = await rpc('system_stats');
    if (r && r.status === 'ok' && r.stats){
      renderStats(r.stats);
      /* v6.3.6 · 同一次采样喂给「左栏宿主机信息」与「总览」等消费方 —— 单一真源,
         不再各处各拉一次(§3.7: 同一个东西只有一个数据源)。 */
      try {
        window.__sysStats = r.stats;
        if (window.SP && SP.renderHostInfo) SP.renderHostInfo();
        if (window.rpStatusStrip) window.rpStatusStrip.render();     // v6.3.7 · 顶栏状态条同源刷新
      } catch(e){}
    }
  }

  /* ── 主刷新 ── */
  var _busy = false;
  async function refresh(){
    if (_busy) return;
    _busy = true;
    try {
      var ss = await rpc('conn_list');
      if (ss && ss.status === 'ok'){
        SESSIONS = ss.sessions || [];
        /* v6.3.6 · 会话真值对外可见(总览 SSH 卡片显示"已连接/未连接"; 与左栏状态点同源) */
        try { window.__rpSessions = SESSIONS; } catch(e){}
      }
      renderSessions();
    } catch(e){ /* 静默: 保留上次渲染 */ }
    _busy = false;
  }

  /* ── 跳转接线 ── */
  function _goConnCenter(){
    try { if (typeof window.switchGroup === 'function') window.switchGroup('conn_center'); } catch(e){}
  }
  function searchFocus(){
    _goConnCenter();
    setTimeout(function(){
      var el = document.getElementById('ccSearch');
      if (el && el.focus) el.focus();
    }, 120);
  }

  /* ── 头像: 首字母 + 下拉菜单 (webui nav-avatar) ── */
  var _menuEl = null;
  function _closeMenu(){
    if (_menuEl && _menuEl.parentNode) _menuEl.parentNode.removeChild(_menuEl);
    _menuEl = null;
  }
  /* v6.3.45 · 批 E(用户 2026-10-04): 头像菜单项此前直接 `window.switchTab(...)` —— **绕过 switchGroup**,
     导致"主界面切过去了, 但左栏主组高亮与上方二级菜单没跟着切"。统一走这条 goTab:
     ① 用 NAV_PARENT(由 NAV_TREE 自动构建)查出该 tab 所属**主组** → ② switchGroup(主组) → ③ switchTab(tab)。 */
  function goTab(tab){
    try {
      var grp = (window.NAV_PARENT || {})[tab];
      if (grp && typeof window.switchGroup === 'function') window.switchGroup(grp);
      if (typeof window.switchTab === 'function') window.switchTab(tab);
    } catch(e){ console.warn('[avatarMenu] goTab 失败:', e); }
  }

  function avatarMenu(ev){
    if (ev && ev.stopPropagation) ev.stopPropagation();
    if (_menuEl){ _closeMenu(); return; }
    var btn = document.getElementById('navAvatar');
    if (!btn) return;
    var isAdmin = !!(window.currentUser && window.currentUser.role === 'admin');
    var uname = (window.currentUser && window.currentUser.username) || '';
    var m = document.createElement('div');
    m.style.cssText = 'position:fixed;z-index:1000;min-width:150px;padding:4px;'
      + 'background:var(--bg3);border:1px solid var(--border2);border-radius:8px;'
      + 'box-shadow:0 12px 40px rgba(0,0,0,.45);font-size:12.5px;';
    function item(label, fn, color){
      var d = document.createElement('div');
      d.textContent = label;
      d.style.cssText = 'padding:6px 10px;border-radius:6px;cursor:pointer;color:' + (color || 'var(--text2)');
      d.onmouseenter = function(){ d.style.background = 'var(--bg4)'; d.style.color = 'var(--text)'; };
      d.onmouseleave = function(){ d.style.background = ''; d.style.color = color || 'var(--text2)'; };
      d.onclick = function(){ _closeMenu(); try { fn(); } catch(e){} };
      m.appendChild(d);
    }
    if (uname){
      var head = document.createElement('div');
      head.textContent = uname;
      head.style.cssText = 'padding:6px 10px;color:var(--text);font-weight:600;border-bottom:1px solid var(--border);margin-bottom:4px';
      m.appendChild(head);
    }
    item('⚙ 系统设置', function(){ goTab('settings'); });
    if (isAdmin) item('👥 用户管理', function(){ if (typeof window.openUserManager === 'function') window.openUserManager(); else goTab('users'); });
    item('🔓 授权管理', function(){ goTab('license'); });
    item('🔑 修改密码', function(){ if (typeof window.openChangePassword === 'function') window.openChangePassword(); });
    item('🚪 退出登录', function(){ if (typeof window.doLogout === 'function') window.doLogout(); }, 'var(--red)');
    document.body.appendChild(m);
    var r = btn.getBoundingClientRect();
    m.style.top = (r.bottom + 6) + 'px';
    m.style.left = Math.max(8, r.right - m.offsetWidth) + 'px';
    _menuEl = m;
    setTimeout(function(){
      document.addEventListener('click', function _once(){ _closeMenu(); document.removeEventListener('click', _once); });
    }, 0);
  }
  function syncAvatar(){
    var a = document.getElementById('navAvatar');
    if (!a) return;
    var u = (window.currentUser && window.currentUser.username) || '';
    a.textContent = u ? String(u).charAt(0).toUpperCase() : 'F';
    /* v1.0.0 · i18n: 用户名是数据, 只翻译标签部分 */
    var _T = (typeof window.t === 'function') ? window.t : function(x){ return x; };
    a.title = u ? (u + ' · ' + _T('账户菜单')) : _T('账户菜单');
  }

  window.ShellWebui = {
    refresh: refresh,
    searchFocus: searchFocus,
    avatarMenu: avatarMenu,
  };

  document.addEventListener('DOMContentLoaded', function(){
    renderSessions();
    syncAvatar();
    setTimeout(refresh, 1800);          // 等 WS 会话就绪门放行
    setTimeout(loadStats, 2200);
    setInterval(function(){
      if (!document.hidden) refresh();
    }, 15000);
    setInterval(syncAvatar, 5000);
    setInterval(function(){
      if (!document.hidden) loadStats();
    }, 15000);
    // 会话变化时联动刷新 (事件总线可能尚未加载, 容错)
    setTimeout(function(){
      if (window.EventBus){
        ['session.changed', 'profile.changed'].forEach(function(ev){
          try { window.EventBus.on(ev, function(){ setTimeout(refresh, 200); }); } catch(e){}
        });
        try { window.EventBus.on('system.stats', function(p){ renderStats(p); }); } catch(e){}
      }
    }, 3000);
  });
})();
