/*
 * Fonriv · app_utils.js · v4.37.4
 * 提取自 app.js · 独立工具函数 + 底部日志 dock 系统
 *
 * 内容：
 *   - gv / escHtml / addLogLine / addLog（通用工具）
 *   - BLD_MAX_LINES / BLD_SCOPE_MEM + bld* 系列（底部日志 dock）
 *
 * 依赖：window.toast, window.toastOk, window.toastWarn（由 app.js 提供）
 * 加载顺序：必须在 app.js 之前
 */
function gv(id, value){
  var e=document.getElementById(id);
  if(!e) return '';
  if(arguments.length > 1){
    e.value = value;
    return value;
  }
  return e.value || '';
}

function escHtml(s){
  var d=document.createElement('div'); d.textContent=s; return d.innerHTML;
}

function addLogLine(el,text,cls){
  if(!el)return;
  var d=document.createElement('div');
  d.className='log-line '+(cls||'');
  var now=new Date();
  var ts=String(now.getHours()).padStart(2,'0')+':'+String(now.getMinutes()).padStart(2,'0')+':'+String(now.getSeconds()).padStart(2,'0');
  d.textContent='['+ts+'] '+text;
  el.appendChild(d); 
  el.scrollTop=el.scrollHeight;
}

function addLog(text,cls){
  var el=document.getElementById('globalLog');
  if(el) addLogLine(el,text,cls);
}

// ============================================
// v2.6.8: 底部日志 dock + 每页/每服务器 日志持久化
// ============================================
var BLD_MAX_LINES = 500;              // 内存中每页最多保留行数
var BLD_HISTORY_MAX = 100;            // 每 scope 保留 100 条最新
var BLD_SCOPE_MEM = {};               // { 'panel|host': [{ts, level, text}] }

function _bldCurrentPanel(){
  var p = document.querySelector('.panel.active');
  return p ? p.id.replace(/^panel-/,'') : '-';
}
function _bldCurrentHost(){
  var panel = _bldCurrentPanel();
  var hostIds = {
    'transfer':'srvHost','proxmox':'pveHost','vzdump':'vdHost',
    'lvm':'lvmHost','zfs':'zfsHost','rbd':'rbdHost','pbs':'pbsHost','auto_backup':'abHost'
  };
  var id = hostIds[panel];
  return (id && document.getElementById(id) && document.getElementById(id).value) || '-';
}
function _bldScopeKey(panel, host){ return (panel||'-') + '|' + (host||'-'); }

function bldAppend(text, cls){
  if(text === undefined || text === null) return;
  var line = String(text);
  if(!line.trim()) return;
  var level = cls || 'info';
  var panel = _bldCurrentPanel();
  var host = _bldCurrentHost();
  var scope = _bldScopeKey(panel, host);
  var now = new Date();
  var ts = now.getFullYear()+'-'+String(now.getMonth()+1).padStart(2,'0')+'-'+
           String(now.getDate()).padStart(2,'0')+' '+
           String(now.getHours()).padStart(2,'0')+':'+
           String(now.getMinutes()).padStart(2,'0')+':'+
           String(now.getSeconds()).padStart(2,'0');
  var entry = { ts: ts, level: level, text: line, panel: panel, host: host };
  if(!BLD_SCOPE_MEM[scope]) BLD_SCOPE_MEM[scope] = [];
  BLD_SCOPE_MEM[scope].push(entry);
  if(BLD_SCOPE_MEM[scope].length > BLD_MAX_LINES){
    BLD_SCOPE_MEM[scope].shift();
  }
  _bldRenderLine(entry);
  _bldUpdateCounter();
  _bldPersist(entry);
}

function _bldRenderLine(entry){
  var body = document.getElementById('bldBody');
  if(!body) return;
  // 只渲染当前 scope 的
  var curScope = _bldScopeKey(_bldCurrentPanel(), _bldCurrentHost());
  if(_bldScopeKey(entry.panel, entry.host) !== curScope) return;
  var div = document.createElement('div');
  div.className = 'bld-line ' + (entry.level || 'info');
  div.innerHTML = '<span class="bld-ts">['+entry.ts.slice(11)+']</span>'+
                  '<span class="bld-scope">'+entry.panel+'</span>'+
                  entry.text.replace(/[&<>]/g, function(c){
                    return {'&':'&amp;','<':'&lt;','>':'&gt;'}[c];
                  });
  body.appendChild(div);
  // 限制 DOM 行数
  while(body.childElementCount > BLD_MAX_LINES) body.firstElementChild.remove();
  body.scrollTop = body.scrollHeight;
}

function _bldUpdateCounter(){
  var scope = _bldScopeKey(_bldCurrentPanel(), _bldCurrentHost());
  var c = (BLD_SCOPE_MEM[scope] || []).length;
  var el = document.getElementById('bldCounter');
  if(el) el.textContent = c;
  var pt = document.getElementById('bldPageTag');
  if(pt) pt.textContent = _bldCurrentPanel() + ' @ ' + _bldCurrentHost();
}

function _bldPersist(entry){
  // 按 scope 存 localStorage，最多 BLD_HISTORY_MAX 条最新
  try{
    var scope = _bldScopeKey(entry.panel, entry.host);
    var key = 'bld_hist_' + scope;
    var arr = JSON.parse(localStorage.getItem(key) || '[]');
    arr.push(entry);
    if(arr.length > BLD_HISTORY_MAX) arr = arr.slice(-BLD_HISTORY_MAX);
    localStorage.setItem(key, JSON.stringify(arr));
    // 索引所有 scope（便于后续列出）
    var idx = JSON.parse(localStorage.getItem('bld_scopes') || '[]');
    if(idx.indexOf(scope) < 0){ idx.push(scope); localStorage.setItem('bld_scopes', JSON.stringify(idx)); }
  }catch(e){}
}

async function bldClear(){
  if(!(await rpConfirm({ title:'清空当前日志', danger:true, okText:'清空', body:'清空当前页当前服务器的日志？（历史记录保留在浏览器本地）' }))) return;
  var scope = _bldScopeKey(_bldCurrentPanel(), _bldCurrentHost());
  BLD_SCOPE_MEM[scope] = [];
  var body = document.getElementById('bldBody');
  if(body) body.innerHTML = '';
  _bldUpdateCounter();
}

// v4.38.14 · FIX: bldRerenderCurrentScope 原先被调用但从未定义，导致页面每 800ms 抛
// ReferenceError。作用域切换（面板/主机变化）时需重绘 bldBody + 计数器。
function bldRerenderCurrentScope(){
  var body = document.getElementById('bldBody');
  var scope = _bldScopeKey(_bldCurrentPanel(), _bldCurrentHost());
  if(body){
    body.innerHTML = '';
    var arr = BLD_SCOPE_MEM[scope] || [];
    arr.forEach(function(e){ _bldRenderLine(e); });
  }
  _bldUpdateCounter();
}

function bldDownload(){
  var scope = _bldScopeKey(_bldCurrentPanel(), _bldCurrentHost());
  var arr = BLD_SCOPE_MEM[scope] || [];
  if(!arr.length){ toastWarn('当前页无日志可下载'); return; }
  var txt = arr.map(function(e){
    return '['+e.ts+'] ['+(e.level||'info').toUpperCase()+'] ('+e.panel+'@'+e.host+') '+e.text;
  }).join('\n') + '\n';
  var blob = new Blob([txt], {type:'text/plain;charset=utf-8'});
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  var fn = 'fonriv_log_'+_bldCurrentPanel()+'_'+
           (_bldCurrentHost().replace(/[^a-zA-Z0-9._-]/g,'_'))+'_'+
           new Date().toISOString().replace(/[:T.]/g,'-').slice(0,19)+'.log';
  a.href = url; a.download = fn; a.click();
  setTimeout(function(){ URL.revokeObjectURL(url); }, 1000);
}

function bldOpenHistory(){
  var idx = JSON.parse(localStorage.getItem('bld_scopes') || '[]');
  // 汇总所有历史条目
  var all = [];
  idx.forEach(function(scope){
    try{
      var arr = JSON.parse(localStorage.getItem('bld_hist_' + scope) || '[]');
      all = all.concat(arr);
    }catch(e){}
  });
  if(!all.length){ alert('尚无历史日志。'); return; }
  // modal
  var modal = document.getElementById('bldHistoryModal');
  if(!modal){
    modal = document.createElement('div');
    modal.id = 'bldHistoryModal';
    modal.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;background:rgba(0,0,0,.55);z-index:9500;display:flex;align-items:center;justify-content:center';
    modal.innerHTML = '<div style="background:var(--bg2);border:1px solid var(--border);border-radius:8px;width:min(900px,95vw);max-height:85vh;display:flex;flex-direction:column;overflow:hidden">'
      + '<div style="padding:10px 14px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px">'
      + '<span style="font-weight:600">📅 日志历史（按页面/服务器/日期筛选）</span>'
      + '<span style="flex:1"></span>'
      + '<button class="btn btn-sm" onclick="bldClearHistoryAll()">🗑 清空所有历史</button>'
      + '<button class="btn btn-sm" onclick="document.getElementById(\'bldHistoryModal\').remove()">✕ 关闭</button>'
      + '</div>'
      + '<div style="padding:10px 14px;display:flex;gap:10px;flex-wrap:wrap;border-bottom:1px solid var(--border)">'
      + '<label style="font-size:11px;color:var(--text3)">页面 <select id="bldFPanel" style="margin-left:4px"></select></label>'
      + '<label style="font-size:11px;color:var(--text3)">服务器 <select id="bldFHost" style="margin-left:4px"></select></label>'
      + '<label style="font-size:11px;color:var(--text3)">日期 <input type="date" id="bldFDate" style="margin-left:4px"></label>'
      + '<label style="font-size:11px;color:var(--text3)">关键字 <input type="text" id="bldFKw" placeholder="模糊搜索..." style="margin-left:4px;width:180px"></label>'
      + '<button class="btn btn-sm btn-primary" onclick="bldApplyFilter()">🔍 筛选</button>'
      + '<span style="flex:1"></span>'
      + '<span id="bldFCount" style="font-size:11px;color:var(--text3)">-</span>'
      + '</div>'
      + '<div id="bldHistBody" style="flex:1;overflow-y:auto;padding:10px 14px;font-family:monospace;font-size:11px;line-height:1.6;min-height:0"></div>'
      + '</div>';
    document.body.appendChild(modal);
  }
  // 填 filter
  var panels = {}, hosts = {};
  all.forEach(function(e){ panels[e.panel]=1; hosts[e.host]=1; });
  var ps = document.getElementById('bldFPanel'), hs = document.getElementById('bldFHost');
  ps.innerHTML = '<option value="">全部</option>' + Object.keys(panels).sort().map(function(p){ return '<option>'+p+'</option>'; }).join('');
  hs.innerHTML = '<option value="">全部</option>' + Object.keys(hosts).sort().map(function(h){ return '<option>'+h+'</option>'; }).join('');
  window._bldAllHist = all;
  bldApplyFilter();
}

function bldApplyFilter(){
  var all = window._bldAllHist || [];
  /* v6.3.35 · FIX(记录在案的潜在崩溃): 本函数会被**面板未渲染**的路径调用到过 —— 实测 v6.3.27
     浏览器测试直接调用即抛 `Cannot read properties of null (reading 'value')`(当时只记录未改),
     真实场景是面板还没渲染完/被切走时, 其它入口(如清空历史后的重绘)调到它。
     这里显式防护并留一条**可追踪的警告**: 不静默假装成功、也不改数据, 只说明"面板不在 DOM"。
     注意不是"静默回落"(§3.7): 不替换任何语义, 只是不崩。 */
  var pEl = document.getElementById('bldFPanel'), hEl = document.getElementById('bldFHost');
  var dEl = document.getElementById('bldFDate'), kwEl = document.getElementById('bldFKw');
  var body = document.getElementById('bldHistBody');
  if(!pEl || !hEl || !dEl || !kwEl || !body){
    try { console.warn('[bld] 面板未渲染, 跳过历史日志过滤渲染'); } catch(_){}
    return;
  }
  var p = pEl.value;
  var h = hEl.value;
  var d = dEl.value;
  var kw = (kwEl.value || '').toLowerCase();
  var filtered = all.filter(function(e){
    if(p && e.panel !== p) return false;
    if(h && e.host !== h) return false;
    if(d && e.ts.slice(0,10) !== d) return false;
    if(kw && e.text.toLowerCase().indexOf(kw) < 0) return false;
    return true;
  });
  filtered.sort(function(a,b){ return a.ts.localeCompare(b.ts); });
  if(!filtered.length){ body.innerHTML = '<div style="color:var(--text3);padding:20px;text-align:center">无匹配记录</div>'; }
  else {
    body.innerHTML = filtered.map(function(e){
      var lv = e.level || 'info';
      var color = {info:'var(--text2)',success:'var(--green)',warn:'var(--yellow)',error:'var(--red)',dim:'var(--text3)'}[lv] || 'var(--text2)';
      var esc = e.text.replace(/[&<>]/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;'}[c]; });
      return '<div style="color:'+color+';padding:1px 0"><span style="color:var(--text3)">['+e.ts+']</span> '
        + '<span style="color:var(--purple);font-size:10px">'+e.panel+'@'+e.host+'</span> '+esc+'</div>';
    }).join('');
  }
  var fc = document.getElementById('bldFCount');
  if(fc) fc.textContent = filtered.length + ' 条 / 总 ' + all.length;
}

async function bldClearHistoryAll(){
  if(!(await rpConfirm({ title:'清空所有历史日志', danger:true, okText:'清空', body:'确定清空所有历史日志？此操作不可撤销。' }))) return;
  var idx = JSON.parse(localStorage.getItem('bld_scopes') || '[]');
  idx.forEach(function(s){ localStorage.removeItem('bld_hist_'+s); });
  localStorage.removeItem('bld_scopes');
  window._bldAllHist = [];
  bldApplyFilter();
  toastOk('已清空历史日志');
}

// 页面切换后刷新 dock 显示
document.addEventListener('DOMContentLoaded', function(){
  // v4.44.1 · FIX: 数据总览/跨模块流程面板头部的版本徽章硬编码 v4.15（初版版本,
  //   从未跟随发版更新）。改为从 window.RP_VERSION 动态取值, 发版即自动跟随。
  try {
    if (window.RP_VERSION){
      document.querySelectorAll('.dash-flows-ver').forEach(function(b){
        b.textContent = 'v' + window.RP_VERSION;
      });
    }
  } catch(e){ }
  // v2.6.11: 若 HTML 里没有 dock 容器（早期未挂载），自动构造 + 附带 footer 版权
  if(!document.getElementById('bottomLogDock')){
    var dock = document.createElement('div');
    dock.id = 'bottomLogDock';
    dock.className = 'bottom-log-dock collapsed';
    dock.innerHTML =
      '<div class="bld-header" onclick="var d=document.getElementById(\'bottomLogDock\');'
        + 'd.classList.toggle(\'collapsed\');'
        + 'localStorage.setItem(\'bld_collapsed\', d.classList.contains(\'collapsed\')?\'1\':\'0\');">'
      + '  <span class="bld-title">📋 运行日志</span>'
      + '  <span class="bld-page-tag" id="bldPageTag">-</span>'
      + '  <span class="bld-counter" id="bldCounter">0</span>'
      + '  <span class="bld-toggle">▲</span>'
      + '  <span style="flex:1"></span>'
      + '  <button class="btn btn-sm" onclick="event.stopPropagation();bldToggleHide()" title="隐藏底部运行日志（所有页面，可在 系统设置/传输日志页 恢复）">🙈</button>'
      + '  <button class="btn btn-sm" onclick="event.stopPropagation();bldClear()" title="清空当前作用域">🗑</button>'
      + '  <button class="btn btn-sm" onclick="event.stopPropagation();bldDownload()" title="下载 .log">💾</button>'
      + '  <button class="btn btn-sm" onclick="event.stopPropagation();bldOpenHistory()" title="历史筛选">📅</button>'
      + '</div>'
      + '<div class="bld-body" id="bldBody"></div>'
      // v4.41.4 · 版本信息栏移出 fixed dock: 改为文档流普通元素, 跟随页面滚动, 滚动到底部才看到
      + '<div class="bld-footer-inflow" id="bldFooter">'
      + '  <span class="bld-copy">© 2025-2026 Fonriv · v' + (window.RP_VERSION || '2.6.11')
      +      ' · <a href="#" onclick="switchTab(\'log\');return false;" style="color:var(--cyan);text-decoration:none">传输日志</a>'
      +      ' · <a href="https://www.fonriv.com" target="_blank" rel="noopener" style="color:var(--cyan);text-decoration:none;opacity:.6">官网</a>'
      +  '</span>'
      + '</div>';
    document.body.appendChild(dock);
  }
  // 恢复折叠状态
  var d = document.getElementById('bottomLogDock');
  if(d && localStorage.getItem('bld_collapsed') === '0') d.classList.remove('collapsed');
  // v4.41.4 · 版本信息栏跟随滚动: 把 footer 从 fixed dock 内搬到 .app 文档流末尾,
  //   滚动到页面底部才可见, 不再常驻占屏; dock 隐藏/折叠态均不影响
  try {
    var _foot = document.getElementById('bldFooter');
    // v4.97.0 · 全宽悬浮页脚: 挂在 body 末尾 + position:fixed 铺满整宽 (含左侧服务器栏),
    //   默认隐藏, 主滚动容器 .content 滚到底部才淡入 (兼顾「不常驻」与「覆盖全宽」)
    if (_foot){
      if (_foot.parentNode !== document.body) document.body.appendChild(_foot);
      _foot.style.cssText = [
        'position:fixed', 'left:0', 'right:0', 'bottom:0', 'z-index:900',
        'height:30px', 'line-height:30px', 'text-align:center',
        'background:var(--bg2)', 'border-top:1px solid var(--border)',
        'font-size:11px', 'color:var(--text3)',
        'pointer-events:none', 'opacity:0', 'transition:opacity .18s ease',
      ].join(';');
      var _sc = document.querySelector('.content');
      var _sync = function(){
        var atBottom = true;
        if (_sc && _sc.scrollHeight > _sc.clientHeight + 4){
          atBottom = (_sc.scrollTop + _sc.clientHeight) >= (_sc.scrollHeight - 8);
        }
        _foot.style.opacity = atBottom ? '1' : '0';
        _foot.style.pointerEvents = atBottom ? 'auto' : 'none';
      };
      if (_sc && !_sc.__ftBound){ _sc.__ftBound = true; _sc.addEventListener('scroll', _sync, { passive: true }); }
      window.addEventListener('resize', _sync);
      setTimeout(_sync, 300);
      window.__syncFooter = _sync;
    }
  } catch(_e){}
  // v4.38.37 · 应用「隐藏运行日志」偏好（设置页勾选后所有页面隐藏 dock）
  applyRunLogHiddenPref();
  // 定时刷新 counter 和当前 scope 展示
  setInterval(function(){
    var curScope = _bldScopeKey(_bldCurrentPanel(), _bldCurrentHost());
    if(curScope !== window._bldLastScope){
      window._bldLastScope = curScope;
      bldRerenderCurrentScope();
    }
  }, 800);
});

// v4.38.37 · 运行日志隐藏偏好：localStorage 优先，UIPrefs 兜底；隐藏时给 <body> 加 bld-hidden 类
function applyRunLogHiddenPref(){
  try {
    var v = localStorage.getItem('rp_hide_runlog');
    var hide = (v === null) ? null : (v === '1');
    if (hide === null && window.UIPrefs && window.UIPrefs.getPref){
      try { hide = !!window.UIPrefs.getPref('hide_run_log'); } catch(e){ }
    }
    document.body.classList.toggle('bld-hidden', !!hide);
    // v4.41.4 · 同步设置页 tag 单选组 + 传输日志页 tag 单选组状态（若存在）
    Array.prototype.forEach.call(document.querySelectorAll('input[name="uiHideRunLog"]'), function(r){
      r.checked = ((r.value === 'hide') === !!hide);
    });
    Array.prototype.forEach.call(document.querySelectorAll('input[name="logHideRunLog"]'), function(r){
      // v4.57.0 · 三态: show(跟随)/bottom(滚到底)/hide
      r.checked = ((r.value === 'hide') === !!hide) || (r.value === 'follow' && !hide);
    });
    applyRunLogMode(hide);
    return !!hide;
  } catch(e){ return false; }
}

// v4.57.0 · 运行日志显示模式: follow=跟随所有页面 / bottom=滚动到底才显示 (默认)
//   hide 偏好(rp_hide_runlog)优先级最高; body.bld-follow 与 bld-at-bottom 由 CSS/scroll 驱动
function applyRunLogMode(hide){
  try {
    var follow = false;
    try { follow = localStorage.getItem('rp_runlog_follow') === '1'; } catch(e){}
    document.body.classList.toggle('bld-follow', follow && !hide);
    document.body.classList.toggle('bld-bottom-mode', !follow && !hide);
    // 同步设置页三态 radio
    Array.prototype.forEach.call(document.querySelectorAll('input[name="logHideRunLog"]'), function(r){
      if (r.value === 'hide') return;
      if (r.value === 'follow') r.checked = follow;
      if (r.value === 'bottom') r.checked = !follow;
    });
  } catch(e){}
}

// v4.57.0 · 滚动到底检测 (bottom 模式下接近页底才显示 dock)
window.addEventListener('scroll', function(){
  try {
    if (!document.body.classList.contains('bld-bottom-mode')) return;
    var doc = document.documentElement;
    var near = (window.innerHeight + window.scrollY) >= (doc.scrollHeight - 80);
    document.body.classList.toggle('bld-at-bottom', near);
  } catch(e){}
}, { passive: true });
// v4.57.0 · 跟随模式偏好 (与 hide 互斥语义: follow=1 时 bottom 模式失效)
function setRunLogFollow(follow){
  try { localStorage.setItem('rp_runlog_follow', follow ? '1' : '0'); } catch(e){ }
  try {
    if (typeof send === 'function'){
      send({action:'ui_prefs_set', run_log_follow: !!follow, hide_run_log: hide_pref()}, function(_){ });
    }
  } catch(e){ }
  applyRunLogMode(hide_pref());
  if (typeof toast === 'function'){
    toast(follow ? '📌 已切换为跟随显示（所有页面）' : '📜 已切换为滚动到底显示', 'ok');
  }
}
function hide_pref(){
  try {
    var v = localStorage.getItem('rp_hide_runlog');
    if (v === null && window.UIPrefs && window.UIPrefs.getPref){
      try { return !!window.UIPrefs.getPref('hide_run_log'); } catch(e){}
    }
    return v === '1';
  } catch(e){ return false; }
}
function setRunLogHidden(hide){
  try { localStorage.setItem('rp_hide_runlog', hide ? '1' : '0'); } catch(e){ }
  applyRunLogHiddenPref();
  // v4.41.3 · 同步写入后端偏好（跨设备生效），静默失败不打扰
  try {
    if (typeof send === 'function'){
      send({action:'ui_prefs_set', hide_run_log: !!hide}, function(_){ /* silent */ });
    }
  } catch(e){ }
  if (typeof toast === 'function'){
    toast(hide ? '🙈 已隐藏底部运行日志（所有页面）' : '✓ 已恢复显示底部运行日志', 'ok');
  }
}
// v4.41.3 · dock 🙈 按钮 / 传输日志页开关共用入口（可来回切换）
function bldToggleHide(){
  var cur = false;
  try { cur = document.body.classList.contains('bld-hidden'); } catch(e){ }
  setRunLogHidden(!cur);
}

// v4.44.1 · FIX: 底部运行日志 dock 此前从未显示过日志 —— bldAppend 全前端零调用，
//   dock 没有任何数据源。此处把 addLogLine（页面级日志统一底层, 216 处调用）接入
//   dock：addLogLine 先渲染到页面日志区，再镜像一份进 dock（按页面/服务器作用域）。
//   toast 主通道已在 panels/toast.js 内接入 bldAppend。加载顺序：app_utils.js 在
//   app.js 之前，运行时才被调用，无顺序问题。
(function(){
  if (typeof window === 'undefined') return;
  if (window.__bldHookAddLogLine) return;
  window.__bldHookAddLogLine = true;
  var _orig = window.addLogLine;
  window.addLogLine = function(el, text, cls){
    // 1) 原行为：渲染到页面内日志区
    if (_orig) { try { _orig(el, text, cls); } catch(e){} }
    // 2) 新增：镜像进底部运行日志 dock
    try {
      if (typeof bldAppend === 'function' && text !== undefined && text !== null
          && String(text).trim()){
        bldAppend(String(text), cls || 'info');
      }
    } catch(e){ /* dock 未就绪时静默 */ }
  };
})();

/* ═══ v6.3.43 · 批 C · 共享右键菜单(与多云文件管理同款观感) ════════════════════
   此前连接中心左栏自实现了一份; 侧栏(数据总览左栏)也要同款菜单 → 抽成公共件,
   全站**一份实现**(§3.7 单一来源): 复用全局 .fonr-menu* 样式, 支持 Esc / 点外关闭 /
   滚动关闭 / 贴边修正 / 全屏时挂进全屏元素(否则浏览器不显示)。
   用法: window.rpCtxMenu(event, [{icon:'➕', t:'新建', fn:function(){...}}, {sep:true}, ...]) */
window.rpCtxMenu = (function(){
  var el = null, escKey = null, bound = false;
  function _esc(s){ return (typeof escHtml === 'function') ? escHtml(s) : String(s == null ? '' : s); }
  function close(){
    if (escKey){ document.removeEventListener('keydown', escKey, true); escKey = null; }
    if (el && el.parentNode) el.parentNode.removeChild(el);
    el = null;
  }
  function bindOnce(){
    if (bound) return;
    bound = true;
    document.addEventListener('mousedown', function(e){ if (el && e.target !== el && !el.contains(e.target)) close(); }, true);
    document.addEventListener('scroll', function(){ close(); }, true);
    window.addEventListener('resize', function(){ close(); });
  }
  return function(ev, items){
    close();
    items = (items || []).filter(Boolean);
    if (!items.length || !ev) return;
    var h = '';
    items.forEach(function(it, i){
      if (it.sep){ h += '<div class="fonr-menu-sep"></div>'; return; }
      h += '<div class="fonr-menu-i' + (it.danger ? ' fonr-menu-danger' : '') + '" data-i="' + i + '">'
         + '<span class="fonr-menu-ic">' + (it.icon || '') + '</span><span>' + _esc(it.t) + '</span>'
         + (it.hint ? '<span class="fonr-menu-hint">' + _esc(it.hint) + '</span>' : '') + '</div>';
    });
    el = document.createElement('div');
    el.className = 'fonr-menu';
    el.innerHTML = h;
    (document.fullscreenElement || document.body).appendChild(el);
    var r = el.getBoundingClientRect();
    var x = ev.clientX || 0, y = ev.clientY || 0;
    if (x + r.width > window.innerWidth - 8) x = Math.max(8, window.innerWidth - r.width - 8);
    if (y + r.height > window.innerHeight - 8) y = Math.max(8, window.innerHeight - r.height - 8);
    el.style.left = x + 'px'; el.style.top = y + 'px';
    el.querySelectorAll('.fonr-menu-i').forEach(function(node){
      node.onclick = function(){
        var it = items[parseInt(node.dataset.i, 10)];
        close();
        try { if (it && it.fn) it.fn(); } catch(e){ console.error('[rpCtxMenu] 动作失败:', e); }
      };
    });
    escKey = function(e){ if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', escKey, true);
    bindOnce();
    if (ev.preventDefault) ev.preventDefault();
    if (ev.stopPropagation) ev.stopPropagation();
  };
})();
window.rpCtxMenuClose = function(){ try { window.rpCtxMenu(null, []); } catch(e){} };
