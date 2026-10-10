// v4.12.0 · UIPrefs (主题/密度/侧栏/快捷键) + Retention (保留策略) + 侧栏折叠 + 简洁模式
// 依赖: window.wsSend / window.rpc (兼容不同后端调用点), switchTab
(function(){
  'use strict';

  // ---------- utils ----------
  function rpc(action, data){
    data = Object.assign({action:action}, data || {});
    return new Promise(function(resolve){
      try {
        if (typeof window.send === 'function'){
          window.send(data, function(res){ resolve(res || {}); });
          return;
        }
      } catch(e){ console.warn('rpc failed', e); }
      resolve({status:'error', msg:'no send()'});
    });
  }

  function toast(msg, type){
    if (typeof window.toast === 'function') return window.toast(msg, type);
    if (typeof window.showToast === 'function') return window.showToast(msg, type);
    console.log('[toast]', type||'info', msg);
  }

  // ---------- Default quick actions ----------
  var DEFAULT_QUICK = [
    {id:'quickSync',       label:'⟳ 立即同步',        action:'js:quickSync()'},
    {id:'auto_backup',     label:'🔧 PVE 一键备份',    action:'tab:auto_backup'},
    {id:'platform_backup', label:'🐧 通用一键备份',    action:'tab:platform_backup'},
    {id:'remotes',         label:'☁️ 远端存储',         action:'tab:remotes'},
    {id:'disk_manager',    label:'💽 远端磁盘管理',     action:'tab:disk_manager'},
    {id:'schedules',       label:'⏰ 定时计划',         action:'tab:schedules'},
    {id:'jobs',            label:'⏰ 任务管理',         action:'tab:jobs'},
    {id:'bandwidth',       label:'📊 带宽监控',         action:'js:openBandwidthMonitor()'},
    {id:'docker',          label:'📦 容器管理',         action:'tab:docker'},
    {id:'conn_center',     label:'🔌 连接中心',          action:'tab:conn_center'},  // v5.35.0
  ];
  var AVAILABLE_ACTIONS = [
    {id:'quickSync',        label:'⟳ 立即同步',        action:'js:quickSync()'},
    {id:'auto_backup',      label:'🔧 PVE 一键备份',    action:'tab:auto_backup'},
    {id:'platform_backup',  label:'🐧 通用一键备份',    action:'tab:platform_backup'},
    {id:'remotes',          label:'☁️ 远端存储',         action:'tab:remotes'},
    {id:'disk_manager',     label:'💽 远端磁盘管理',     action:'tab:disk_manager'},
    {id:'schedules',        label:'⏰ 定时计划',         action:'tab:schedules'},
    {id:'jobs',             label:'⏰ 任务管理',         action:'tab:jobs'},
    {id:'bandwidth',        label:'📊 带宽监控',         action:'js:openBandwidthMonitor()'},
    {id:'conn_center',      label:'🔌 连接中心',          action:'tab:conn_center'},  // v5.35.0
    {id:'transfer',         label:'📁 文件传输',         action:'tab:transfer'},
    {id:'dashboard',        label:'📊 数据总览',         action:'tab:dashboard'},
    {id:'flows',            label:'🔗 跨模块流程',       action:'tab:flows'},
    {id:'terminal',         label:'🖥 终端',              action:'tab:terminal'},
    {id:'proxmox',          label:'🖥 PVE 节点连接',    action:'tab:proxmox'},
    {id:'vzdump',           label:'📦 vzdump',           action:'tab:vzdump'},
    {id:'pbs',              label:'📦 PBS',              action:'tab:pbs'},
    {id:'lvm',              label:'💽 LVM',              action:'tab:lvm'},
    {id:'zfs',              label:'🗄 ZFS',              action:'tab:zfs'},
    {id:'rbd',              label:'🌐 RBD',              action:'tab:rbd'},
    {id:'cloudpool',        label:'🧩 存储池',            action:'tab:cloudpool'},   // v5.99.2 · CloudPool V2
    {id:'downloads',        label:'💾 本地下载',         action:'tab:downloads'},
    {id:'log',              label:'📋 传输日志',         action:'tab:log'},
    {id:'settings',         label:'⚙ 系统设置',         action:'tab:settings'},
    // v4.45.0 · 补缺项 (用户指定: 网络共享等)
    {id:'shares',           label:'🌐 网络共享',         action:'tab:shares'},
    {id:'license',          label:'🔓 授权管理',         action:'tab:license'},
    {id:'users',            label:'👥 用户管理',         action:'tab:users'},
    // v4.49.0 · 容器管理
    {id:'docker',           label:'📦 容器管理',         action:'tab:docker'},
    // v6.3.43 · 批 C: 「快捷方式」区并入「快捷操作」后, 原快捷方式独有的两项也进清单
    {id:'fonrvfs',          label:'🗂 多云文件管理',     action:'tab:fonrvfs'},
    {id:'vdisk_cloud',      label:'💠 多云虚拟存储池',     action:'tab:vdisk_cloud'},
  ];

  /* v6.16.14 · 按功能键过滤可选项(快捷操作里清除非社区版功能按钮):
     action='tab:<key>' → 查 NAV_TREE 的 feat 键 + licenseFeatEnabled / hideEditions;
     js: 动作(立即同步/带宽监控)恒保留。列表在**渲染时**过滤(license 白名单晚于模块加载)。 */
  function _actAllowed(x){
    var m = /^tab:([a-z_0-9]+)$/.exec(String(x.action || ''));
    if (!m) return true;
    var key = m[1], node = null;
    (window.NAV_TREE || []).forEach(function(g){
      if (g.key === key) node = g;
      else if (g.children) g.children.forEach(function(c){ if (c.key === key) node = c; });
    });
    if (!node) return true;                                  // 非导航项(子页/别名) → 不拦
    if (node.feat && typeof window.licenseFeatEnabled === 'function'
        && !window.licenseFeatEnabled(node.feat)) return false;
    if (Array.isArray(node.hideEditions)){
      var edn = window.__licFeatEdition || 'community';
      if (node.hideEditions.indexOf(edn) >= 0) return false;
    }
    /* v6.16.17 · license_get 未回来时 __licFeat=null → licenseFeatEnabled 恒放行,
       按社区内置功能表兜底(默认 community), 社区版首屏即不显示非社区按钮 */
    if (node.feat && !window.__licFeat){
      var _lst = (window.RP_FEATURE_EDITIONS || {})[window.__licFeatEdition || 'community'];
      if (Array.isArray(_lst) && _lst.indexOf(node.feat) < 0) return false;
    }
    return true;
  }
  function availActions(){
    return AVAILABLE_ACTIONS.filter(_actAllowed);
  }

  var STATE = {
    theme: 'light',  // v4.39.0: 默认浅色
    density: 'full',
    sidebar_collapsed: false,
    hide_run_log: false,  // v4.38.37 · 隐藏底部运行日志 dock（所有页面）
    quick_actions: DEFAULT_QUICK.slice(),
    loaded: false,
  };

  // v5.85.2 · 「清爽主题(fresh)」入口已按用户要求移除(它本就是默认主题, 点了看不出变化) →
  //   老用户若仍存着 fresh, 迁移到最接近的「明亮模式」, 免得停在一个没有入口的主题上。
  try {
    var _t = localStorage.getItem('rp_theme') || localStorage.getItem('theme') || '';
    if (_t === 'fresh') {
      localStorage.setItem('rp_theme', 'light');
      try { document.documentElement.setAttribute('data-theme', 'light'); } catch (e) {}
    }
  } catch (e) {}

  // ---------- v5.20.2 · 清爽模式 ----------
  // 隐藏所有提示/说明/装饰 (带 data-clean-hide 标记或命中提示类样式), 只留关键数据与操作。
  // 实现: 扫描面板内的"提示横幅"(border-left 彩条 + 小字) 与 💡 开头的说明行, 打标记;
  // CSS 端 body.clean-mode [data-clean-hide]{display:none!important} 负责隐藏。
  function applyCleanMode(on){
    document.body.classList.toggle('clean-mode', !!on);
    try { localStorage.setItem('rp_clean_mode', on ? '1' : '0'); } catch(_){}
    var hits = 0;
    document.querySelectorAll('.panel').forEach(function(panel){
      // ① 面板顶部的说明横幅 (border-left 彩条)
      panel.querySelectorAll(':scope > div > div, :scope > div > div > div').forEach(function(el){
        var st = (el.getAttribute('style')||'');
        if (st.indexOf('border-left') >= 0 && (el.innerText||'').length > 0
            && /💡|说明|提示|点击|请先|注意/i.test(el.innerText.slice(0,80))){
          el.toggleAttribute ? (on ? el.setAttribute('data-clean-hide','') : el.removeAttribute('data-clean-hide')) : 0;
          hits++;
        }
      });
      // ② 💡 开头的说明行
      panel.querySelectorAll('div,span').forEach(function(el){
        if (el.children.length) return;
        var t = (el.textContent||'').trim();
        if (t.slice(0,2) === '💡' || t.slice(0,2) === '⚙' || /^(提示|说明)[：:]/.test(t)){
          on ? el.setAttribute('data-clean-hide','') : el.removeAttribute('data-clean-hide');
          hits++;
        }
      });
    });
    return hits;
  }
  window.applyCleanMode = applyCleanMode;

  // ---------- theme apply ----------
  function applyTheme(t){
    var final = t;
    if (t === 'auto'){
      try {
        final = (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
      } catch(e){ final = 'dark'; }
    }
    // v1.0.0 · 科技风/清爽三套旧主题(neon/quantum/fresh)源码已移除 → 旧值回退: neon→dark, quantum/fresh→light
    if (final === 'light' || final === 'quantum' || final === 'fresh'){ document.documentElement.setAttribute('data-theme','light'); }
    else { document.documentElement.setAttribute('data-theme','dark'); }   // dark / neon / 其它 (v4.41.3 · 显式设置, 修复切换误判)
    try { localStorage.setItem('rp_theme', t); } catch(_){}
    // v6.0.0 · 顶栏主题按钮图标跟随主题 (helper 定义在 app.js)
    try { if (typeof window.updateThemeToggleIcon === 'function') window.updateThemeToggleIcon(); } catch(_){}
  }

  // ---------- density (简洁模式) ----------
  function applyDensity(d){
    if (d === 'compact'){ document.documentElement.setAttribute('data-density','compact'); }
    else { document.documentElement.removeAttribute('data-density'); }
    try { localStorage.setItem('rp_density', d); } catch(_){}
  }

  // ---------- sidebar collapse (v4.14.1 恢复为二态 · 移除 mini) ----------
  function applySidebar(collapsed){
    var sb = document.getElementById('sidebar');
    var btn = document.getElementById('sidebarToggleBtn');
    if (!sb) return;
    // 兼容旧字符串
    if (collapsed === 'collapsed') collapsed = true;
    else if (collapsed === 'expanded' || collapsed === 'mini') collapsed = false;
    collapsed = !!collapsed;
    // 清理 v4.14.0 遗留的 mini class
    sb.classList.remove('mini');
    document.body.classList.remove('sidebar-mini');
    // v6.3.1 · 收敛到**唯一写入点** applySidebarCollapse: 旧实现只往 body 写 sidebar-collapsed,
    //   而 CSS 隐藏侧栏看的是 .app.sidebar-collapsed → 于是"设置里改了折叠但侧栏没反应/只丢拖动条"。
    if (typeof window.applySidebarCollapse === 'function'){
      window.applySidebarCollapse(collapsed, true);
    } else {
      sb.classList.toggle('collapsed', collapsed);
      document.body.classList.toggle('sidebar-collapsed', collapsed);
      try { localStorage.setItem('rp_sidebar_collapsed', collapsed ? '1' : '0'); } catch(_){}
    }
    if (btn){ btn.textContent = collapsed ? '›' : '‹'; btn.title = collapsed ? '展开侧栏 (Alt+B)' : '折叠侧栏 (Alt+B)'; }
    // 清理旧 tri-state key（不再使用）
    try { localStorage.removeItem('rp_sidebar_mode'); } catch(_){}
    STATE.sidebar_collapsed = collapsed;
  }

  // v5.90.5 · 旧 ‹ 折叠按钮已移除(与折叠后竖条并存造成残留) — 本函数保留为别名,
  //   统一走 toggleSidebarCollapse (折叠后显示「≫ 服务器」竖条, 点竖条展开)
  window.toggleSidebar = function(){
    if (typeof window.toggleSidebarCollapse !== 'function') return;
    var app = document.querySelector('.app') || document.body;
    var collapsed = app.classList.contains('sidebar-collapsed');
    window.toggleSidebarCollapse(!collapsed);
  };

  // ---------- quick actions render ----------
  function actionHandler(item){
    var a = String(item.action || '');
    if (a.indexOf('tab:') === 0){
      var tab = a.slice(4);
      return function(){ if (typeof switchTab === 'function') switchTab(tab); };
    }
    if (a.indexOf('js:') === 0){
      var expr = a.slice(3);
      return function(){ try { (new Function(expr))(); } catch(e){ console.warn('quick action js failed', expr, e); } };
    }
    return function(){};
  }

  // v5.86.2 · 同一套组件挂到两个宿主: 侧栏「快速操作」+ 系统设置里的「自定义快捷操作」(用户要求恢复)
  /* ── v6.3.43 · 批 C · 左栏「快捷操作」显示样式 + 顶栏状态条显隐 ──────────────────
     这两个是"本机怎么看"的偏好(与主题/密度/仪表盘 widget 同类) → 走 localStorage,
     **不动后端 ui_prefs 表**(那张表是固定列, 加键要改表结构; 与本次目的无关, §0.2 最小改动)。
     样式: grid=按钮式(方形两列, 原「快捷方式」观感) / list=单列式(原「快速操作」观感)。 */
  var LS_ACT_STYLE = 'rp_left_actions_style';
  var LS_STRIP_HIDE = 'rp_strip_hidden';
  function _actStyle(){
    try { return localStorage.getItem(LS_ACT_STYLE) === 'list' ? 'list' : 'grid'; } catch(e){ return 'grid'; }
  }
  function _syncStyleBtns(){
    var s = _actStyle();
    var g = document.getElementById('sbActGridBtn'), l = document.getElementById('sbActListBtn');
    // 选中态类名与全站一致: cs-mbtn-on(见 style.css:5237), 不是 'on'
    if (g) g.classList.toggle('cs-mbtn-on', s === 'grid');
    if (l) l.classList.toggle('cs-mbtn-on', s === 'list');
  }
  function setLeftActionsStyle(style){
    try { localStorage.setItem(LS_ACT_STYLE, style === 'list' ? 'list' : 'grid'); } catch(e){}
    _syncStyleBtns(); renderQuickList();
  }
  /* v6.3.45 · 批 E(用户 2026-10-04: 顶部左上角那条一行状态条\u300c你还没有隐藏啊\u300d):
     **默认隐藏**。只有显式写过 '0'(用户在个性化里勾了"显示")才显示 —— 开关仍然有效, 只是默认值反过来了。 */
  function stripHidden(){ try { return localStorage.getItem(LS_STRIP_HIDE) !== '0'; } catch(e){ return true; } }
  function applyStripHidden(){
    var el = document.getElementById('rpStrip');
    if (el) el.style.display = stripHidden() ? 'none' : '';
    var cb = document.getElementById('prefStripShow');
    if (cb) cb.checked = !stripHidden();
  }
  function setStripHidden(on){
    try { localStorage.setItem(LS_STRIP_HIDE, on ? '1' : '0'); } catch(e){}
    applyStripHidden();
  }

  // v6.3.43 · 批 C: 只剩左栏一个宿主(设置页那份已改为指引, 不再重复渲染)
  var QA_HOSTS = ['quickActionsList'];
  function renderQuickList(){
    QA_HOSTS.forEach(function(hid){
      var host = document.getElementById(hid);
      if (host) _renderQuickListInto(host);
    });
    _syncStyleBtns();
    applyStripHidden();          // 状态条显隐也在这里统一应用(单点钩子, 幂等)
  }

  function _renderQuickListInto(host){
    if (!host) return;
    var grid = (_actStyle() === 'grid');
    var html = '';
    (STATE.quick_actions || []).forEach(function(it){
      if (!_actAllowed(it)) return;   // v6.16.17 · 渲染时按功能键过滤: 存档里残留的非社区项不再显示
      var lbl = (it.label || '').replace(/</g,'&lt;');
      var id = (it.id || '');
      html += grid
        ? '<button type="button" class="sb-sc" data-qa-id="'+ id +'">'+ lbl +'</button>'
        : '<div class="sidebar-item" data-qa-id="'+ id +'">'+ lbl +'</div>';
    });
    if (!html){
      html = '<div style="padding:6px 8px;font-size:11px;color:var(--text3)">未配置任何快捷操作。'
           + '<a href="#" onclick="switchTab(\'personalize\');return false" style="color:var(--cyan)">去「个性化」添加</a></div>';
    }
    if (host.classList) host.classList.toggle('sb-short-grid', grid && host.id === 'quickActionsList');
    host.innerHTML = html;
    Array.prototype.forEach.call(host.querySelectorAll('[data-qa-id]'), function(el){
      var id = el.getAttribute('data-qa-id');
      var it = (STATE.quick_actions || []).filter(function(x){ return x.id === id; })[0];
      if (it) el.onclick = actionHandler(it);
    });
  }

  function renderQuickEditor(){
    var host = document.getElementById('uiQuickList');
    if (!host) return;
    var html = '';
    STATE.quick_actions.forEach(function(it, idx){
      if (!_actAllowed(it)) return;   // v6.16.17 · 编辑清单同口径过滤(idx 保持原序号, 删除/移动不错位)
      var lbl = (it.label || '').replace(/</g,'&lt;');
      html += '<div style="display:flex;align-items:center;gap:6px;padding:4px 0;border-bottom:1px solid var(--border)">' +
              '  <span style="flex:1">'+ lbl +' <span style="color:var(--text3);font-size:10px">('+ (it.action||'') +')</span></span>' +
              '  <button class="btn btn-sm" onclick="UIPrefs.move('+ idx +',-1)">▲</button>' +
              '  <button class="btn btn-sm" onclick="UIPrefs.move('+ idx +', 1)">▼</button>' +
              '  <button class="btn btn-sm" style="color:var(--red)" onclick="UIPrefs.remove('+ idx +')">✖</button>' +
              '</div>';
    });
    if (!html) html = '<div style="color:var(--text3);font-size:11px">空 · 从下方 + 添加</div>';
    host.innerHTML = html;

    var addBar = document.getElementById('uiQuickAddBar');
    if (addBar){
      var existing = {};
      STATE.quick_actions.forEach(function(x){ existing[x.id] = 1; });
      var addHtml = '';
      availActions().forEach(function(x){
        if (existing[x.id]) return;
        addHtml += '<button class="btn btn-sm" onclick="UIPrefs.add(\''+ x.id +'\')">+ '+ (x.label||'').replace(/</g,'&lt;') +'</button>';
      });
      if (!addHtml) addHtml = '<span style="color:var(--text3);font-size:11px">已添加全部可用项</span>';
      addBar.innerHTML = addHtml;
    }
  }

  // ---------- load / save ----------
  async function load(){
    try {
      // 先从 localStorage 预热主题避免闪烁（登录界面已经用过）
      var lsTheme = localStorage.getItem('rp_theme'); if (lsTheme) applyTheme(lsTheme);
      // v5.20.2 · 清爽模式启动应用 (延迟到 DOM 渲染稳定)
      setTimeout(function(){
        try { if (localStorage.getItem('rp_clean_mode') === '1') applyCleanMode(true); } catch(e){}
      }, 1200);
      var lsDen = localStorage.getItem('rp_density'); if (lsDen) applyDensity(lsDen);
      // v5.90.5 · 侧栏折叠恢复统一由 app.js restoreSidebarState (新系统) 处理

      // v4.38.37 · 隐藏运行日志: localStorage 即时生效（后端 prefs 作跨设备同步）
      var lsHl = localStorage.getItem('rp_hide_runlog');
      STATE.hide_run_log = (lsHl === '1');
      if (typeof applyRunLogHiddenPref === 'function') applyRunLogHiddenPref();

      var r = await rpc('ui_prefs_get', {});
      if (r && r.status === 'ok' && r.prefs){
        STATE.theme = r.prefs.theme || 'light';  // v4.39.0: 默认浅色
        // v5.20.2 · 本地选择优先于服务端: 用户刚点过的主题存 localStorage (更新),
        //   服务端 prefs 可能还是旧值 — 若反过来会"切完主题一刷新就退回" (实测复现)。
        var lsTheme2 = localStorage.getItem('rp_theme');
        if (lsTheme2 && lsTheme2 !== STATE.theme){ applyTheme(lsTheme2); }
        STATE.density = r.prefs.density || 'full';
        STATE.sidebar_collapsed = !!r.prefs.sidebar_collapsed;
        if (typeof r.prefs.hide_run_log !== 'undefined'){
          // 后端有值且本地无记忆 -> 采纳后端（跨设备同步）；本地有记忆 -> 本地优先
          if (lsHl === null) STATE.hide_run_log = !!r.prefs.hide_run_log;
        }
        if (Array.isArray(r.prefs.quick_actions) && r.prefs.quick_actions.length){
          /* v6.16.17 · 原 v4.38.37「缺 disk_manager 自动补上」删除: 它名为一次性、实为**每次
             加载都跑**, 用户删掉的「💽 远端磁盘管理」重进必复活(报障"删除不掉"), 且不按功能键过滤。 */
          STATE.quick_actions = r.prefs.quick_actions;
        }
        STATE.loaded = true;
        _mergeShortcutsOnce();          // v6.3.43 · 批 C: 快捷方式→快捷操作 一次性合并
      }
    } catch(e){ console.warn('UIPrefs load failed', e); }
    // v5.20.2 · 主题以本地最近选择为准 (applyTheme 会写 localStorage; 服务端值可能滞后,
    //   二次应用会覆盖用户刚点的新主题 — 实测"切清爽主题刷新后回退浅色"即此因)
    var _lsT = localStorage.getItem('rp_theme');
    applyTheme(_lsT || STATE.theme);
    applyDensity(localStorage.getItem('rp_density') || STATE.density);
    applySidebar(STATE.sidebar_collapsed);
    // v4.38.37 · 应用隐藏运行日志偏好（body.bld-hidden -> 所有页面隐藏 dock）
    if (typeof setRunLogHidden === 'function') setRunLogHidden(STATE.hide_run_log);
    renderQuickList();
    // v6.0.1 · 启动即回显表单 (主题单选/清爽模式/密度等): 「🎨 UI 美化」在「个性化」页,
    //   不能依赖用户先切到 settings 才 bindForm — 否则直达个性化页时单选停在 HTML 默认值。
    try { bindForm(); } catch(e){ console.warn('bindForm at boot failed', e); }
  }

  // v4.38.37 · 供 app_utils.js 读取偏好（localStorage 无记忆时兜底）
  function getPref(key){
    return STATE[key];
  }

  function bindForm(){
    /* v6.3.43 · 批 C: 进「个性化」时回显「快捷操作样式」单选与「顶部状态条」复选框 */
    try {
      var _st = _actStyle();
      document.querySelectorAll('input[name="prefActStyle"]').forEach(function(r){
        r.checked = (r.value === _st);
      });
      applyStripHidden();
    } catch(e){}

    Array.prototype.forEach.call(document.querySelectorAll('input[name="uiTheme"]'), function(r){
      r.checked = (r.value === STATE.theme);
      r.onchange = function(){ if (r.checked){ STATE.theme = r.value; applyTheme(r.value); } };
    });
    // v5.20.2 · 清爽模式开关 (localStorage 记忆, 启动时应用)
    var cm = document.getElementById('uiCleanMode');
    if (cm){
      cm.checked = (localStorage.getItem('rp_clean_mode') === '1');
      cm.onchange = function(){ applyCleanMode(cm.checked); };
    }
    Array.prototype.forEach.call(document.querySelectorAll('input[name="uiDensity"]'), function(r){
      r.checked = (r.value === STATE.density);
      r.onchange = function(){ if (r.checked){ STATE.density = r.value; applyDensity(r.value); } };
    });
    // v4.14.1: 由 checkbox 改为 tag radio 组
    Array.prototype.forEach.call(document.querySelectorAll('input[name="uiSidebarCollapse"]'), function(r){
      r.checked = ((r.value === 'on') === !!STATE.sidebar_collapsed);
      r.onchange = function(){
        if (r.checked){
          var v = (r.value === 'on');
          STATE.sidebar_collapsed = v;
          applySidebar(v);
        }
      };
    });
    // v4.41.4 · 隐藏底部运行日志（所有页面）· checkbox 改 tag radio 组（与主题/侧栏字段对齐）
    var hlrEl = document.querySelector('input[name="uiHideRunLog"]:checked');
    var _hlrSync = function(){
      Array.prototype.forEach.call(document.querySelectorAll('input[name="uiHideRunLog"]'), function(r){
        r.checked = ((r.value === 'hide') === !!STATE.hide_run_log);
      });
    };
    if (hlrEl || document.querySelector('input[name="uiHideRunLog"]')){
      _hlrSync();
      Array.prototype.forEach.call(document.querySelectorAll('input[name="uiHideRunLog"]'), function(r){
        r.onchange = function(){
          if (r.checked){
            STATE.hide_run_log = (r.value === 'hide');
            if (typeof setRunLogHidden === 'function') setRunLogHidden(STATE.hide_run_log);
          }
        };
      });
    }
    renderQuickEditor();
  }

  async function save(){
    var r = await rpc('ui_prefs_set', {
      theme: STATE.theme,
      density: STATE.density,
      sidebar_collapsed: STATE.sidebar_collapsed,
      hide_run_log: !!STATE.hide_run_log,  // v4.38.37 · 隐藏运行日志
      quick_actions: STATE.quick_actions,
    });
    if (r && r.status === 'ok'){ toast('✓ UI 偏好已保存', 'ok'); renderQuickList(); }
    else { toast('保存失败: '+ (r && r.msg || '未知'), 'err'); }
  }

  /* v6.3.43 · 批 C · 一次性迁移: 老「快捷方式」区(方形按钮)已并入「快捷操作」——
     把它当时**默认可见**的 5 项补进快捷操作清单, 免得升级后这些入口无声消失(用户能看到/能删)。
     只跑一次(标记 rp_quick_merge_v1); 静默落库(这是数据迁移, 不是用户操作, 不弹 toast)。 */
  function _mergeShortcutsOnce(){
    try {
      if (localStorage.getItem('rp_quick_merge_v1') === '1') return;
      var ids = ['conn_center', 'fonrvfs', 'vdisk_cloud', 'remotes', 'shares'];
      var list = (STATE.quick_actions || []).slice();
      var added = 0;
      ids.forEach(function(id){
        if (list.some(function(x){ return x && x.id === id; })) return;
        var it = AVAILABLE_ACTIONS.filter(function(x){ return x.id === id; })[0];
        if (it){ list.push(it); added++; }
      });
      localStorage.setItem('rp_quick_merge_v1', '1');
      if (added){
        STATE.quick_actions = list;
        try {
          rpc('ui_prefs_set', { theme: STATE.theme, density: STATE.density,
            sidebar_collapsed: STATE.sidebar_collapsed, hide_run_log: !!STATE.hide_run_log,
            quick_actions: STATE.quick_actions });
        } catch(e){}
      }
    } catch(e){}
  }

  function move(idx, dir){
    var j = idx + dir;
    if (j < 0 || j >= STATE.quick_actions.length) return;
    var arr = STATE.quick_actions;
    var t = arr[idx]; arr[idx] = arr[j]; arr[j] = t;
    renderQuickEditor(); renderQuickList();
  }
  /* v6.16.17 · 删除即落库: 原先只改内存不保存, 不点「💾 保存快捷操作」重进即回(用户报障) */
  function remove(idx){ STATE.quick_actions.splice(idx, 1); renderQuickEditor(); renderQuickList(); save(); }
  function add(id){
    if (!availActions().some(function(x){ return x.id === id; })){ try{ toast('该功能不在社区版内', 'warn'); }catch(e){} return; }
    var item = AVAILABLE_ACTIONS.filter(function(x){ return x.id === id; })[0];
    if (!item) return;
    STATE.quick_actions.push(item); renderQuickEditor(); renderQuickList();
  }
  /* v6.16.17 · 恢复默认同样按功能键过滤, 社区版不得借「恢复默认」复活非社区按钮 */
  function resetQuick(){ STATE.quick_actions = DEFAULT_QUICK.filter(_actAllowed); renderQuickEditor(); renderQuickList(); }

  window.UIPrefs = { load:load, bindForm:bindForm, save:save, move:move, remove:remove, add:add,
                     resetQuick:resetQuick, getPref:getPref, state:STATE,
                     // v6.3.43 · 批 C
                     setLeftActionsStyle:setLeftActionsStyle, leftActionsStyle:_actStyle,
                     setStripHidden:setStripHidden, applyStripHidden:applyStripHidden,
                     renderQuickList:renderQuickList, availableActions:function(){ return AVAILABLE_ACTIONS; } };

  // ---------- Retention ----------
  var Retention = {
    async load(){
      var r = await rpc('retention_get', {});
      if (r && r.status === 'ok' && r.policy){
        var p = r.policy;
        var e = document.getElementById('retEnabled'); if (e) e.checked = !!p.enabled;
        var d = document.getElementById('retKeepDays'); if (d) d.value = p.keep_days || 0;
        var c = document.getElementById('retKeepCount'); if (c) c.value = p.keep_count || 0;
        var s = document.getElementById('retScope'); if (s) s.value = p.scope || 'all';
        var f = document.getElementById('retDeleteFiles'); if (f) f.checked = !!p.delete_files;
        var a = document.getElementById('retAutoApply'); if (a) a.checked = !!p.auto_apply;
      }
    },
    _read(){
      return {
        enabled: !!document.getElementById('retEnabled').checked,
        keep_days: parseInt(document.getElementById('retKeepDays').value || 0, 10),
        keep_count: parseInt(document.getElementById('retKeepCount').value || 0, 10),
        scope: document.getElementById('retScope').value || 'all',
        delete_files: !!document.getElementById('retDeleteFiles').checked,
        auto_apply: !!(document.getElementById('retAutoApply') && document.getElementById('retAutoApply').checked),
      };
    },
    async save(){
      var r = await rpc('retention_set', Retention._read());
      if (r && r.status === 'ok') toast('✓ 保留策略已保存', 'ok');
      else toast('保存失败: '+ (r && r.msg || ''), 'err');
    },
    async preview(){
      var r = await rpc('retention_preview', Retention._read());
      var box = document.getElementById('retPreview');
      if (!box) return;
      if (!r || r.status !== 'ok'){ box.innerHTML = '<span style="color:var(--red)">预览失败: '+ (r && r.msg || '') +'</span>'; return; }
      var v = r.victims || [];
      if (!v.length){ box.innerHTML = '<span style="color:var(--green)">✓ 当前无需清理</span>'; return; }
      var sizeMB = ((r.total_size_bytes||0) / 1024 / 1024).toFixed(1);
      var html = '<div style="color:var(--orange);margin-bottom:6px">将删除 <b>'+ r.total_count +'</b> 条记录 · 累计 '+ sizeMB +' MB</div>';
      html += '<table style="width:100%;border-collapse:collapse;font-size:11px"><thead><tr style="color:var(--text3);text-align:left"><th>ID</th><th>类型</th><th>目标</th><th>时间</th></tr></thead><tbody>';
      v.slice(0, 50).forEach(function(x){
        html += '<tr><td>'+x.id+'</td><td>'+(x.type||'')+'</td><td style="max-width:400px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+((x.destination||'').replace(/</g,'&lt;'))+'</td><td>'+(x.started_at||'')+'</td></tr>';
      });
      html += '</tbody></table>';
      if (v.length > 50) html += '<div style="color:var(--text3);margin-top:4px">…以及另外 '+ (v.length-50) +' 条</div>';
      box.innerHTML = html;
    },
    async applyNow(){
      if (!(await rpConfirm({ title:'立即清理老备份', danger:true, okText:'清理', body:'确定要立即清理老备份吗？此操作不可撤销。' }))) return;
      var r = await rpc('retention_apply', {});
      if (r && r.status === 'ok'){
        toast('✓ '+ (r.msg || '已清理'), 'ok');
        Retention.preview();
        Retention.refreshRuns();  // v4.13.6 · 刷新历史图
      }
      else toast('清理失败: '+ (r && r.msg || ''), 'err');
    },
    // v4.13.6 · 执行历史 + 柱状图
    async refreshRuns(){
      var sel = document.getElementById('retRunsWindow');
      var days = sel ? parseInt(sel.value, 10) : 30;
      var stats = await rpc('retention_stats', { days: days });
      var runs  = await rpc('retention_runs',  { limit: 100 });
      if (stats && stats.status === 'ok'){
        Retention._drawChart(stats.buckets || [], days);
        var totRuns = (stats.buckets||[]).reduce(function(a,b){return a+(b.runs||0);}, 0);
        var totRec  = (stats.buckets||[]).reduce(function(a,b){return a+(b.deleted_records||0);}, 0);
        var totBytes= (stats.buckets||[]).reduce(function(a,b){return a+(b.bytes_freed||0);}, 0);
        var s = document.getElementById('retRunsSummary');
        if (s) s.textContent = '窗口 ' + days + ' 天 · 执行 ' + totRuns
             + ' 次 · 清理记录 ' + totRec + ' 条 · 释放空间 ' + Retention._fmtBytes(totBytes);
      }
      if (runs && runs.status === 'ok') Retention._renderRunsTable(runs.runs || []);
    },
    _fmtBytes(n){
      n = n || 0;
      if (n < 1024) return n + ' B';
      if (n < 1048576) return (n/1024).toFixed(1) + ' KB';
      if (n < 1073741824) return (n/1048576).toFixed(1) + ' MB';
      return (n/1073741824).toFixed(2) + ' GB';
    },
    _renderRunsTable(runs){
      var esc = function(s){ return String(s==null?'':s).replace(/[&<>"']/g, function(c){
        return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
      }); };
      var body = document.getElementById('retRunsBody');
      if (!body) return;
      if (!runs.length){
        body.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--text3);padding:12px">暂无执行记录</td></tr>';
        return;
      }
      body.innerHTML = runs.map(function(r){
        var trg = r.trigger === 'auto' ? '🤖 自动'
                : r.trigger === 'scheduled' ? '⏰ 定时'
                : '👤 手动';
        return '<tr>'
          + '<td>'+ esc(r.run_time) +'</td>'
          + '<td>'+ trg +'</td>'
          + '<td>'+ esc(r.scope) +'</td>'
          + '<td style="text-align:right">'+ (r.deleted_records||0) +'</td>'
          + '<td style="text-align:right">'+ (r.deleted_files||0) +'</td>'
          + '<td style="text-align:right">'+ Retention._fmtBytes(r.bytes_freed) +'</td>'
          + '<td style="text-align:right">'+ (r.duration_ms||0) +' ms</td>'
          + '</tr>';
      }).join('');
    },
    _drawChart(buckets, days){
      var cvs = document.getElementById('retRunsChart');
      if (!cvs) return;
      var dpr = window.devicePixelRatio || 1;
      var cssW = cvs.clientWidth || 720, cssH = cvs.clientHeight || 180;
      /* v6.3.15 · 统一图表底座(此前本图是总览时间线图的近似拷贝, 各画一套网格) */
      var _rc = window.rpChart ? rpChart.clear(cvs) : null;
      if (_rc) { cssW = _rc.w; cssH = _rc.h; }
      var ctx = _rc ? _rc.ctx : cvs.getContext('2d');
      if (!_rc) {
        cvs.width = cssW * dpr; cvs.height = cssH * dpr;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, cssW, cssH);
      }
      // 填充完整日期序列（含 0 值）
      var series = [];
      var end = new Date();
      for (var i = days - 1; i >= 0; i--){
        var d = new Date(end.getFullYear(), end.getMonth(), end.getDate() - i);
        var key = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
        var b = buckets.find(function(x){ return x.date === key; });
        series.push({ date: key, records: b ? b.deleted_records : 0, bytes: b ? b.bytes_freed : 0 });
      }
      var maxRec = Math.max.apply(null, series.map(function(x){return x.records;}).concat([1]));
      var pad = { l: 40, r: 10, t: 10, b: 22 };
      var chartW = cssW - pad.l - pad.r;
      var chartH = cssH - pad.t - pad.b;
      // Y 轴(统一走 rpChart.axes: 网格/刻度/标签口径与总览图一致)
      var css = getComputedStyle(document.documentElement);
      var _P = window.rpChart ? rpChart.pal() : null;
      var text3 = _P ? _P.text : (css.getPropertyValue('--text3').trim() || '#888');
      var accent= css.getPropertyValue('--accent').trim() || '#ffb454';
      var border= _P ? _P.grid : (css.getPropertyValue('--border').trim() || '#333');
      var _step = Math.max(1, Math.ceil(series.length / 8));
      var _plot = window.rpChart ? rpChart.axes(ctx, cssW, cssH, {
        pad: pad, yMax: maxRec, yTicks: 4,
        xLabels: series.map(function(s){ return s.date.slice(5); }),
        labelEvery: _step
      }) : null;
      if (_plot) {
        pad = { l: _plot.x0, t: _plot.y0, r: cssW - _plot.x1, b: cssH - _plot.y1 };
        chartW = _plot.w; chartH = _plot.h;
      } else {
        ctx.strokeStyle = border; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(pad.l, pad.t); ctx.lineTo(pad.l, pad.t+chartH);
        ctx.lineTo(pad.l+chartW, pad.t+chartH); ctx.stroke();
        ctx.fillStyle = text3; ctx.font = '10px sans-serif';
        for (var k = 0; k <= 4; k++){
          var val = Math.round(maxRec * k / 4);
          var y = pad.t + chartH - (chartH * k / 4);
          ctx.fillText(String(val), 4, y+3);
          if (k > 0){
            ctx.strokeStyle = border; ctx.globalAlpha = 0.3;
            ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(pad.l+chartW, y); ctx.stroke();
            ctx.globalAlpha = 1;
          }
        }
      }
      // 柱子
      var barW = chartW / series.length * 0.75;
      var gap  = chartW / series.length * 0.25;
      series.forEach(function(s, i){
        var h = (s.records / maxRec) * chartH;
        var x = pad.l + i * (barW + gap) + gap/2;
        var y = pad.t + chartH - h;
        ctx.fillStyle = accent;
        ctx.fillRect(x, y, barW, h);
      });
      // X 轴稀疏 label(走 rpChart.axes 时已统一绘制)
      if (!_plot) {
        ctx.fillStyle = text3;
        var step = _step;
        series.forEach(function(s, i){
          if (i % step !== 0 && i !== series.length - 1) return;
          var x = pad.l + i * (barW + gap) + gap/2 + barW/2;
          ctx.fillText(s.date.slice(5), x - 12, pad.t + chartH + 14);
        });
      }
    },
  };
  window.Retention = Retention;

  // ---------- boot ----------
  document.addEventListener('DOMContentLoaded', function(){
    load();
    // Alt+B 折叠
    window.addEventListener('keydown', function(ev){
      if (ev.altKey && (ev.key === 'b' || ev.key === 'B')){ ev.preventDefault(); window.toggleSidebar(); }
    });
    // 切到 settings 时刷新表单
    var oldSwitch = window.switchTab;
    if (typeof oldSwitch === 'function'){
      window.switchTab = function(t){
        var ret = oldSwitch.apply(this, arguments);
        try {
          // v6.0.1 · 「🎨 UI 美化」区块实际位于「个性化」页: 主题单选/清爽模式切到该页时也要回显当前值
          if (t === 'personalize'){ bindForm(); }
          if (t === 'settings'){
            bindForm(); Retention.load(); Retention.refreshRuns();
            // v4.15.24 · scope_tag 规则表单
            if (window.ScopeRules && typeof window.ScopeRules.load === 'function'){
              try { window.ScopeRules.load(); } catch(e){ console.warn('ScopeRules.load err', e); }
            }
          }
        } catch(e){ console.warn('settings hook err', e); }
        return ret;
      };
    }
  });
})();
