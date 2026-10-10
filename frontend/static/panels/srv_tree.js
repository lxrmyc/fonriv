/* v6.1.7 · 公共服务器树渲染器 SrvTree (统一左栏方案 P2 · docs/Fonriv_统一左栏与分组模型重设计方案_v1.md)
 *
 * 定位: 「服务器列表左栏」的单一渲染实现 —— 同一份数据(sp_list), 两种正交视图:
 *   · 按分组(groups): 嵌套分组树 + 子孙计数 + 折叠记忆 + 拖拽改组 + 组编辑/删除 —— 连接中心同款,
 *                     面向"企业部门"式组织(用户需求: 服务器按部门划分, 与类型无关)
 *   · 按类型(fixed):  类型分区(SSH/PVE/桌面/云/共享) + 服务器行带**所属分组徽章** —— 类型归属一眼可见
 * 一台服务器 = 系统类型(协议推导, 恒定) + 用户分组(可改); 两视图内容等价、组织不同, 切换差异明显。
 *
 * 三处消费(只传行为, 不改数据):
 *   · 连接中心   showRows:false  点组=过滤本页卡片
 *   · 多云文件管理 showRows:true   点行=打开该存储文件浏览
 *   · 全局侧栏   showRows:true   点行=SP.fillByGuid 填入当前页连接配置(P3 接入)
 *
 * 分组管理 RPC 复用既有单一真源: sp_batch{op:'move'} / sg_save / sg_del(由消费方回调接管 UI 刷新)
 */
(function (g) {
'use strict';

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

/* ── 视图偏好(单一入口; 变更广播 rp-tree-mode, 三处监听同频) ── */
function mode() {
  try { return localStorage.getItem('fonr_tree_mode') === 'fixed' ? 'fixed' : 'groups'; } catch (e) { return 'groups'; }
}
function setMode(m) {
  try { localStorage.setItem('fonr_tree_mode', m === 'fixed' ? 'fixed' : 'groups'); } catch (e) {}
  try { g.dispatchEvent(new CustomEvent('rp-tree-mode', { detail: { mode: mode() } })); } catch (e) {}
}

/* ── 类型推导(唯一实现, 各处口径一致) ── */
var TYPE_ICON = { host: '🐧', pve: '🖥', desktop: '🖥️', cloud: '☁️', share: '🔗' };
var TYPE_NAME = { host: 'SSH', pve: 'PVE', desktop: '桌面', cloud: '云', share: '共享' };
var TYPE_ORDER = ['host', 'pve', 'desktop', 'cloud', 'share'];
function typeOf(p) {
  var prot = (p.protocols_mask || []).join(',').toLowerCase();
  var k = String(p.kind || '').toLowerCase();
  if (k === 'cloud' || prot.indexOf('s3') >= 0 || prot.indexOf('seafile') >= 0) return 'cloud';
  if (prot.indexOf('smb') >= 0 || prot.indexOf('nfs') >= 0 || k === 'share') return 'share';
  if (prot.indexOf('pve') >= 0) return 'pve';
  if (prot.indexOf('rdp') >= 0 || prot.indexOf('vnc') >= 0) return 'desktop';
  return 'host';
}

/* ── 折叠记忆(默认统一键; 连接中心沿用旧键保证老用户状态不丢) ── */
function getExpand(key) {
  try { return JSON.parse(localStorage.getItem(key || 'srv_tree_expand') || '{}') || {}; } catch (e) { return {}; }
}
function setExpand(key, o) {
  try { localStorage.setItem(key || 'srv_tree_expand', JSON.stringify(o || {})); } catch (e) {}
}

/* ── 内部: 拖拽改组(单一实现) ── */
var _dragGuid = '';
/* v6.3.41 · 批 B: 按类型视图的"区域折叠"(每类一块, 记忆键 sec:<type> 与分组折叠同源) */
function _toggleSec(container, sec, expandKey) {
  var o = getExpand(expandKey);
  var key = 'sec:' + sec;
  o[key] = (o[key] === false);          // 当前展开(true/未设) → 折叠
  setExpand(expandKey, o);
  if (container._stRerender) container._stRerender();
}

function _rowDragStart(ev, guid) {
  _dragGuid = guid;
  try { ev.dataTransfer.setData('text/sp-guid', guid); } catch (e) {}
  try { ev.dataTransfer.effectAllowed = 'move'; } catch (e) {}
}
async function _moveTo(guids, gid, onChanged) {
  try {
    var r = await new Promise(function (res) {
      g.send({ action: 'sp_batch', op: 'move', guids: guids, group_id: gid }, function (m) { res(m || {}); });
    });
    if (r.status === 'ok') {
      if (g.toast) g.toast('✓ 已移动 ' + (r.count || guids.length) + ' 台到分组', 'success', 2000);
      if (onChanged) onChanged();
    } else if (g.toast) {
      g.toast('✗ 移动失败: ' + (r.msg || '无响应'), 'err', 4000);
    }
  } catch (e) {}
}

/* ── v6.3.5 · 状态点改按**可观测真源**判定 ──
   用户报障: "网络共享断开或掉线后, 左侧面板还显示连接成功"。
   旧实现只看 `p.status` —— 那是**档案里上次探测留下的字段**, 掉线后不会自己变;
   而 `sessionsByKey()`(活动会话) 与 `share_list`(真实挂载态) 才是当下的真值, 却没被用上。
   口径(与用户要求一致):
     🟢 绿 = 有活动会话 / 主机上次探测在线 / 共享**确实挂载中且 last_status=ok**
     ⚪ 灰 = 掉线 · 未挂载 · 未探测 · 状态未知(凡是"不能给绿点"的一律灰, 一眼可辨)
     🔴 红 = 共享明确报错(挂载失败且有错误文本) —— 比"掉线"更重, 单独区分
   每个点都带 title 说明原因, 悬停可读。 */
function _findShare(p) {
  try {
    var arr = (g.__sharesCache || []);
    var guid = String(p.guid || '');
    var nm = String(p.name || '');
    var host = String(p.hostname || '');
    for (var i = 0; i < arr.length; i++) {
      var s = arr[i] || {};
      if (guid && String(s.uuid || '') === guid) return s;
    }
    for (var j = 0; j < arr.length; j++) {
      var s2 = arr[j] || {};
      if (nm && String(s2.name || '') === nm) return s2;
      if (host && String(s2.host || '') === host && String(s2.share || '') === nm) return s2;
    }
  } catch (e) {}
  return null;
}

/* ── v6.16.16 · 网络共享 / 云存储节点并入左树 ──
   用户实测: "连接中心和数据总览的左栏服务器列表里直接没有网络共享这个显示"。
   根因: 本渲染器数据源只有 sp_list(SSH 档案), 而共享/云在 hub_nodes(连接中心卡片同一真源)。
   数据源优先级: ConnCenter 已加载节点(其 10s 自动刷新在跑) → 本模块自拉(60s TTL + 飞行中去重);
   拉取失败**不覆盖上次成功值**并记错误(禁止静默回落口径: 界面按上次成功显示, 不假装没有)。 */
var _hnodes = [], _hnodesAt = 0, _hnodesBusy = null, _hnodesErr = '';
function _feat(k) {
  try { return typeof g.licenseFeatEnabled === 'function' ? !!g.licenseFeatEnabled(k) : true; } catch (e) { return true; }
}
function nodesNow() {
  try { var cn = g.ConnCenter && g.ConnCenter.nodes; if (cn && cn.length) return cn; } catch (e) {}
  return _hnodes;
}
function loadNodes() {
  if (Date.now() - _hnodesAt < 60000) return Promise.resolve(_hnodes);
  if (_hnodesBusy) return _hnodesBusy;
  _hnodesBusy = new Promise(function (res) {
    var done = function (arr) { _hnodesBusy = null; res(arr); };
    try {
      g.send({ action: 'hub_nodes', kinds: 'cloud,share', include_ssh: false }, function (m) {
        m = m || {};
        if (m.status === 'ok') { _hnodes = m.nodes || []; _hnodesAt = Date.now(); _hnodesErr = ''; }
        else { _hnodesErr = m.msg || 'hub_nodes 无响应'; }   /* 失败: 保留上次成功值 */
        done(_hnodes);
      });
    } catch (e) { _hnodesErr = String(e); done(_hnodes); }
  });
  return _hnodesBusy;
}
function invalidateNodes() { _hnodesAt = 0; }
/* hub 节点 → 行形状(与档案字段对齐, 复用行渲染/状态点/协议徽章) */
function nodeRow(n) {
  return {
    guid: n.guid, name: n.label, hostname: n.sub || '',
    kind: n.kind, protocols_mask: [String(n.provider || n.kind).toLowerCase()],
    is_starred: false, group_id: n.group_id || null,
    _node: n, __node: true
  };
}
/* 节点行默认点击: 共享 → 「网络共享」管理页 · 云 → 「远端存储」页(即该资源的管理首页) */
function _nodeClick(guid, kind) {
  try {
    if (kind === 'share') { g.switchGroup('storage_g'); g.switchTab('shares'); return; }
    if (kind === 'cloud' && _feat('cloud')) { g.switchGroup('storage_g'); g.switchTab('remotes'); return; }
  } catch (e) {}
  if (g.toast) g.toast('请在「连接中心」管理该' + (kind === 'share' ? '共享' : '节点'), 'info', 3000);
}

/* 树里可见的节点(云存储按档位: 社区版不含 cloud → 整类不出现) */
function _visibleNodes() {
  return nodesNow().filter(function (n) {
    if (n.kind === 'share') return true;
    if (n.kind === 'cloud') return _feat('cloud');
    return false;
  });
}
/* v6.16.16 · 节点拉取失败的显式提示行("失败 ≠ 没有", 禁止静默回落; 点击重试)
   前缀/后缀拆成独立文本节点, 便于英文词条精确匹配(整句含动态 msg 无法命中词典) */
function _nodesErrRow() {
  if (!_hnodesErr || nodesNow().length) return '';
  return '<div class="st-sec" data-act="nretry" style="cursor:pointer;color:var(--red)"'
    + ' title="点击重试(网络/会话就绪后一般即可)">'
    + '<span>⚠ 共享/云节点未取到</span>: ' + esc(_hnodesErr) + ' · <span>点此重试</span></div>';
}

function _dotInfo(p) {
  var t = typeOf(p);
  var live = false;
  /* 节点行: 挂载态/统一探测台账即真值(_share_nodes/_cloud_nodes 下发), 优先于档案口径 */
  var nd = p.__node ? p._node : null;
  if (nd && nd.state) {
    if (nd.state.mounted) return { cls: 'st-dot st-dot-on', title: '已挂载' + (nd.state.mnt ? ' · ' + nd.state.mnt : '') };
    var pr = nd.state.probe;
    if (pr && pr.status) {
      if (pr.status === 'online') return { cls: 'st-dot st-dot-on', title: '可达(上次探测)' };
      if (pr.status === 'degraded') return { cls: 'st-dot st-dot-gray', title: '部分异常(上次探测)' };
      return { cls: 'st-dot st-dot-err', title: '探测失败' + (pr.msg ? ': ' + pr.msg : '') };
    }
    return { cls: 'st-dot st-dot-gray', title: '未挂载 · 未探测' };
  }
  try { if (g.SP && g.SP.isConnected) live = !!g.SP.isConnected(p.hostname, p.ssh_port || 22); } catch (e) {}
  if (t === 'share') {
    var sh = _findShare(p);
    if (sh) {
      var st = String(sh.last_status || '');
      if (sh.mounted && (!st || st === 'ok')) {
        return { cls: 'st-dot st-dot-on', title: '已挂载' + (sh.mnt ? ' · ' + sh.mnt : '') };
      }
      if (st && st !== 'ok') {
        return { cls: 'st-dot st-dot-err', title: '挂载异常: ' + st };
      }
      return { cls: 'st-dot st-dot-gray', title: '未挂载(共享已断开/掉线)' };
    }
    if (live) return { cls: 'st-dot st-dot-on', title: '已连接' };
    return { cls: 'st-dot st-dot-gray', title: '共享状态未知(刷新后按真实挂载态显示)' };
  }
  if (live) return { cls: 'st-dot st-dot-on', title: '已连接(活动会话)' };
  if (p.status === 'online') return { cls: 'st-dot st-dot-on', title: '在线(上次探测结果)' };
  if (p.status === 'offline') return { cls: 'st-dot st-dot-gray', title: '离线(上次探测未通)' };
  return { cls: 'st-dot st-dot-gray', title: '未探测 · 状态未知' };
}

/* ── 服务器行(状态点+名称+徽章+★; 点击=消费方行为) ── */
function rowHtml(p, gname, opts) {
  var t = typeOf(p);
  /* groups 视图: 类型徽章; fixed 视图: 分组徽章 —— 双维度互补可见
     (v6.1.9 徽章可按页面模块配置关闭: showTypeBadge / showGroupBadge) */
  var badge = '';
  if (opts.view === 'groups'){
    if (opts.showTypeBadge !== false) badge = '<span class="st-bdg" title="类型">' + TYPE_ICON[t] + ' ' + TYPE_NAME[t] + '</span>';
  } else if (gname && opts.showGroupBadge !== false){
    badge = '<span class="st-bdg" title="所属分组">📁 ' + esc(gname) + '</span>';
  }
  var extraBadges = (p.protocols_mask || []).filter(function (m) { return m !== 'ssh'; })
    .slice(0, 2).map(function (m) {
      return '<span class="st-bdg st-bdg-p">' + esc(String(m).toUpperCase()) + '</span>';
    }).join('');
  var di = _dotInfo(p);
  /* v6.16.16 · 节点行标记 data-nodekind: 点击/右键按类型分流(共享=管理页, 云=远端存储页,
     右键=连接中心节点菜单); 节点不参与拖拽改组(draggable=false) */
  var isNode = !!p.__node;
  return '<div class="st-row' + (opts.activeGuid === p.guid ? ' st-on' : '') + '" data-guid="' + esc(p.guid)
    + '" draggable="' + (isNode ? 'false' : 'true') + '"'
    + (isNode ? ' data-nodekind="' + esc(p.kind) + '"' : '')
    + ' data-act="row">'
    + '<span class="' + di.cls + '" title="' + esc(di.title) + '"></span>'
    // v1.0.0 · 用户要求: 左侧服务器列表显示「服务器名称 + IP 地址」(如 "web-01 · 10.0.0.21")
    + (function(){
        var _nm = String(p.name || '').trim(), _host = String(p.hostname || '').trim();
        var _lab = _nm || _host || p.guid;
        // v1.0.0 · 显示样式由用户配置(默认「仅名称」): 仅名称 / 名称+IP (🎛 按钮切换)
        var _mode = (typeof g.srvLabelMode === 'function') ? g.srvLabelMode() : 'name';
        // 仅当第二段像"地址"(IP/域名/主机:端口)时才拼接 —— 网络共享/云节点的 sub 是描述文字, 不拼
        var _isAddr = !!_host && _host.indexOf('/') < 0 && /^[0-9A-Za-z_.:\[\]-]+$/.test(_host);
        if (_mode === 'name_ip' && _nm && _host && _nm !== _host && _isAddr) _lab = _nm + ' · ' + _host;
        var _tip = (_nm && _host && _nm !== _host) ? (_nm + ' (' + _host + ')') : (_host || _nm);
        return '<span class="st-name" title="' + esc(_tip) + '">' + esc(_lab) + '</span>';
      })()
    + (p.is_starred ? '<span class="st-star">★</span>' : '')
    + badge + extraBadges + '</div>';
}

/* ═══════════ 主渲染 ═══════════
 * data: {profiles:[], groups:[]}  (sp_list 原始形状; groups 含 guid/name/parent_id/sort_order)
 * opts: {
 *   view: 'groups'|'fixed'         缺省=当前偏好
 *   showRows: bool                 组内是否渲染服务器行(连接中心=false 只做组导航)
 *   quick: bool                    分组视图顶部快捷项(全部/星标/未分组); 多云=false
 *   activeGroup / activeGuid       选中态高亮
 *   expandKey: str                 折叠记忆的 localStorage 键
 *   manage: bool                   组行 ✎/✕ 管理按钮(回调接管)
 *   onRowClick(guid)               服务器行点击
 *   onGroupClick(gid)              组/快捷项点击(''=全部 '__star'=星标 '__none'=未分组)
 *   onGroupEdit(gid)/onGroupDel(gid)/onGroupAdd()
 *   onChanged()                    拖拽改组成功后(刷新数据)
 *   rowFilter(p)                   行过滤(多云只显示 SSH 档案等)
 * }
 */
function render(container, data, opts) {
  if (!container) return;
  opts = opts || {};
  data = data || {};
  var profiles = (data.profiles || []).slice();
  if (opts.rowFilter) profiles = profiles.filter(opts.rowFilter);
  /* v6.16.16 · 共享/云节点并入左树(用户实测"左栏没有网络共享显示"): 数据源 hub_nodes,
     自拉一次(60s TTL); 到达后若无新渲染则补一次重渲染, 不刷屏也不静默空白。
     opts.nodes === false 时整块关闭(多云文件管理自管共享行, 传 false 防重)。 */
  var nodes = (opts.nodes === false) ? [] : _visibleNodes();
  if (opts.nodes !== false) {
    var _atSnap = _hnodesAt;
    loadNodes().then(function () { if (container._stRerender && _hnodesAt !== _atSnap) container._stRerender(); });
  }
  var groups = data.groups || [];
  var view = opts.view || mode();
  var expandKey = opts.expandKey || 'srv_tree_expand';
  var gnameOf = {};
  groups.forEach(function (gr) { gnameOf[gr.guid] = gr.name || ''; });

  /* 事件委托一次绑定(重渲染不重挂; 回调一律取 container._stOpts 最新配置) */
  if (!container._stBound) {
    container._stBound = true;
    container.addEventListener('click', function (ev) {
      var o = container._stOpts || {};
      var row = ev.target.closest ? ev.target.closest('[data-act="row"]') : null;
      var gnode = ev.target.closest ? ev.target.closest('[data-act="gnode"]') : null;
      var arrow = ev.target.closest ? ev.target.closest('[data-act="arrow"]') : null;
      var secar = ev.target.closest ? ev.target.closest('[data-act="secar"]') : null;   // v6.3.41 区域折叠箭头
      var ge = ev.target.closest ? ev.target.closest('[data-act="ge"]') : null;
      var gd = ev.target.closest ? ev.target.closest('[data-act="gd"]') : null;
      if (ge) { ev.stopPropagation(); if (o.onGroupEdit) o.onGroupEdit(ge.getAttribute('data-gid')); return; }
      if (gd) { ev.stopPropagation(); if (o.onGroupDel) o.onGroupDel(gd.getAttribute('data-gid')); return; }
      /* 节点拉取失败提示行的"点此重试" */
      var nretry = ev.target.closest ? ev.target.closest('[data-act="nretry"]') : null;
      if (nretry) {
        ev.stopPropagation();
        invalidateNodes();
        loadNodes().then(function () { if (container._stRerender) container._stRerender(); });
        return;
      }
      if (arrow) { ev.stopPropagation(); _toggleExpand(container, arrow.getAttribute('data-gid'), o.expandKey); return; }
      /* 区域折叠箭头要**先于** gnode 判定: 箭头在标题行内部(标题行本身可点是"按类型过滤") */
      if (secar) { ev.stopPropagation(); _toggleSec(container, secar.getAttribute('data-sec'), o.expandKey); return; }
      if (row) {
        var nk = row.getAttribute('data-nodekind');   // v6.16.16: 节点行分流
        if (nk) {
          if (o.onNodeClick) o.onNodeClick(row.getAttribute('data-guid'), nk, ev);
          else _nodeClick(row.getAttribute('data-guid'), nk);
          return;
        }
        if (o.onRowClick) o.onRowClick(row.getAttribute('data-guid'), ev);
        return;
      }
      if (gnode) { if (o.onGroupClick) o.onGroupClick(gnode.getAttribute('data-gid')); return; }
    });
    /* v6.16.16 · 节点行右键 = 连接中心同款节点菜单(挂载/卸载/编辑/删除/测试连通) */
    container.addEventListener('contextmenu', function (ev) {
      var o = container._stOpts || {};
      if (o.nodeMenu === false) return;
      var row = ev.target.closest ? ev.target.closest('[data-act="row"]') : null;
      if (!row || !row.getAttribute('data-nodekind')) return;
      ev.preventDefault();
      ev.stopPropagation();
      var guid = row.getAttribute('data-guid');
      if (o.onNodeMenu) { o.onNodeMenu(guid, row.getAttribute('data-nodekind'), ev); return; }
      try { if (g.ConnCenter && g.ConnCenter.cardMenu) { g.ConnCenter.cardMenu(ev, guid); return; } } catch (e) {}
      _nodeClick(guid, row.getAttribute('data-nodekind'));
    });
    container.addEventListener('dragstart', function (ev) {
      var row = ev.target.closest ? ev.target.closest('[data-act="row"]') : null;
      if (row) _rowDragStart(ev, row.getAttribute('data-guid'));
    });
    container.addEventListener('drop', function (ev) {
      var o = container._stOpts || {};
      var zone = ev.target.closest ? ev.target.closest('[data-drop]') : null;
      if (!zone) return;
      ev.preventDefault();
      if (_dragGuid) { _moveTo([_dragGuid], zone.getAttribute('data-drop'), function(){ if (o.onChanged) o.onChanged(); }); _dragGuid = ''; }
    });
    container.addEventListener('dragover', function (ev) {
      var zone = ev.target.closest ? ev.target.closest('[data-drop]') : null;
      if (zone) ev.preventDefault();
    });
  }
  /* 记住最新 opts(委托回调取用) + 折叠切换后的就地重渲染钩子 */
  container._stOpts = opts;
  container._stRerender = function () { render(container, data, opts); };

  var h = '<div class="st-root">';
  if (view === 'fixed') {
    /* ── 按类型: **独立区域**(每类一块, 标题 + 计数 + 可折叠) ──
       v6.3.41 · 批 B(用户 2026-10-03): "按类型显示时要像多云文件管理那样分成各自的独立区域, 方便区分"。
       多云文件管理左栏正是 sec('🔐 服务器 (SSH)') / sec('☁️ 云 / 对象存储') / sec('🧊 存储池') 这种区块;
       这里把**公共渲染器**的按类型视图对齐成同款, 于是连接中心左树 / 全局侧栏 / 多云文件管理三处
       一次到位(它们共用本渲染器)。区域折叠箭头独立于点标题(点标题仍是"按类型过滤"的老语义),
       折叠记忆写进 expandKey 存储的 `sec:<type>` 键(与分组折叠同源, 老用户状态无缝)。 */
    var _secStore = getExpand(expandKey);
    var secBox = function (sec, icon, tName, items, gid, clickable) {
      var open = _secStore['sec:' + sec] !== false;         // 默认展开
      return '<div class="st-secbox' + (opts.activeGroup === gid ? ' st-secbox-on' : '') + '" data-sec="' + sec + '">'
        + '<div class="st-sechd"'
        + (clickable ? ' data-act="gnode" data-gid="' + gid + '" style="cursor:pointer"' : '')
        + ' title="' + (clickable ? '点击按「' + tName + '」过滤' : tName) + '">'
        + '<span class="st-secar" data-act="secar" data-sec="' + sec + '" title="' + (open ? '折叠该区域' : '展开该区域') + '">'
        + (open ? '▾' : '▸') + '</span>'
        + '<span class="st-secico">' + icon + '</span>'
        + '<span class="st-sect">' + tName + '</span>'
        + '<span class="st-n">' + items.length + '</span></div>'
        + '<div class="st-secbody"' + (open ? '' : ' style="display:none"') + '>'
        + items.map(function (p) { return rowHtml(p, p.group_id ? gnameOf[p.group_id] : '', opts); }).join('')
        + '</div></div>';
    };
    TYPE_ORDER.forEach(function (t) {
      var items = profiles.filter(function (p) { return typeOf(p) === t; });
      /* v6.16.16 · 云/共享分区并入节点行(连接中心"按类型"点分区过滤卡片时, 计数与行同源) */
      if (t === 'cloud' || t === 'share') {
        nodes.filter(function (n) { return n.kind === t; }).forEach(function (n) { items.push(nodeRow(n)); });
      }
      var gid = '__type_' + t;
      var clickable = !!opts.onGroupClick;
      var tName = (t === 'host') ? 'SSH 主机' : (t === 'cloud' ? '云存储' : (t === 'desktop' ? '桌面 / 远程' : TYPE_NAME[t]));
      if (!items.length && !clickable) return;   /* 无内容且不可点 → 整段省略; 可点时保留(0 也显示) */
      h += secBox(t, TYPE_ICON[t], tName, items, gid, clickable);
    });
    /* 侧栏口径: 按类型视图附 ⭐ 星标 区(与旧 SP 树一致) */
    if (opts.starSection) {
      var _stars = profiles.filter(function (p) { return p.is_starred; });
      h += secBox('star', '⭐', '星标', _stars, '__star', !!opts.onGroupClick);
    }
    if (!profiles.length && !nodes.length) h += '<div class="st-empty">暂无服务器 · 到「连接中心」添加</div>';
    h += _nodesErrRow();
    h += '</div>';
    container.innerHTML = h;
    return;
  }

  /* ── 按分组: 快捷项 + 嵌套分组树 ── */
  var count = function (gid) { return profiles.filter(function (p) { return p.group_id === gid; }).length; };
  var totalSub = function (gid) {
    var n = count(gid);
    groups.filter(function (x) { return x.parent_id === gid; }).forEach(function (c) { n += totalSub(c.guid); });
    return n;
  };
  if (opts.quick !== false) {
    h += '<div class="st-quick' + (opts.activeGroup === '' ? ' st-gon' : '') + '" data-act="gnode" data-gid="">📦 全部<span class="st-n">' + (profiles.length + nodes.length) + '</span></div>'
      + '<div class="st-quick' + (opts.activeGroup === '__star' ? ' st-gon' : '') + '" data-act="gnode" data-gid="__star">⭐ 星标<span class="st-n">' + profiles.filter(function (p) { return p.is_starred; }).length + '</span></div>';
    /* v6.12.0 · 批12(用户报障: 数据总览左栏出现**两个「未分组」**):
       列表视图(showRows!==false)下方本来就有「📁 未分组」区块(含具体服务器行),
       快捷项里再放一个同名条 = 同屏两份; 纯导航视图(连接中心 showRows:false)保留快捷项。 */
    if (opts.showRows === false) {
      h += '<div class="st-quick' + (opts.activeGroup === '__none' ? ' st-gon' : '') + '" data-act="gnode" data-gid="__none">📁 未分组<span class="st-n">' + profiles.filter(function (p) { return !p.group_id; }).length + '</span></div>';
    }
  }
  var expand = getExpand(expandKey);
  function node(gr, depth) {
    var open = expand[gr.guid] !== false;
    var kids = groups.filter(function (x) { return x.parent_id === gr.guid; })
      .sort(function (a, b) { return (a.sort_order || 0) - (b.sort_order || 0) || String(a.name).localeCompare(String(b.name)); });
    var direct = profiles.filter(function (p) { return p.group_id === gr.guid; });
    var s = '<div class="st-gwrap" data-drop="' + esc(gr.guid) + '">'
      + '<div class="st-gnode' + (opts.activeGroup === gr.guid ? ' st-gon' : '') + '" data-act="gnode" data-gid="' + esc(gr.guid) + '" style="padding-left:' + (8 + depth * 12) + 'px">'
      + '<span class="st-arrow" data-act="arrow" data-gid="' + esc(gr.guid) + '">' + (open ? '▾' : '▸') + '</span>'
      + '<span class="st-gname">📁 ' + esc(gr.name) + '</span>'
      + '<span class="st-n">' + totalSub(gr.guid) + '</span>'
      + (opts.manage ? '<span class="st-ge" data-act="ge" data-gid="' + esc(gr.guid) + '" title="编辑分组">✎</span>'
                     + '<span class="st-ge" data-act="gd" data-gid="' + esc(gr.guid) + '" title="删除分组">✕</span>' : '')
      + '</div>';
    if (open) {
      if (opts.showRows !== false) {
        direct.forEach(function (p) { s += '<div style="padding-left:' + (18 + depth * 12) + 'px">' + rowHtml(p, '', opts) + '</div>'; });
      }
      kids.forEach(function (c) { s += node(c, depth + 1); });
    }
    return s + '</div>';
  }
  var roots = groups.filter(function (x) { return !x.parent_id; })
    .sort(function (a, b) { return (a.sort_order || 0) - (b.sort_order || 0) || String(a.name).localeCompare(String(b.name)); });
  roots.forEach(function (gr) { h += node(gr, 0); });
  if (opts.showRows !== false && profiles.filter(function (p) { return !p.group_id; }).length) {
    var ungrp = '<div class="st-sec">📁 未分组<span class="st-n">' + profiles.filter(function (p) { return !p.group_id; }).length + '</span></div>';
    profiles.filter(function (p) { return !p.group_id; }).forEach(function (p) { ungrp += rowHtml(p, '', opts); });
    h += ungrp;
  }
  /* v6.16.16 · 共享/云节点独立分区(节点无部门归属, 是"资源"而非"服务器";
     此行点击/右键行为见 _nodeClick / contextmenu 分流) */
  if (nodes.length) {
    var hasC = false, hasS = false;
    nodes.forEach(function (n) { if (n.kind === 'cloud') hasC = true; else hasS = true; });
    var nsec = '<div class="st-sec" title="来自连接中心统一资源目录(hub_nodes)">'
      + (hasC && hasS ? '🔗 共享 / ☁️ 云存储' : (hasC ? '☁️ 云存储' : '🔗 网络共享'))
      + '<span class="st-n">' + nodes.length + '</span></div>';
    nodes.forEach(function (n) { nsec += rowHtml(nodeRow(n), '', opts); });
    h += nsec;
  }
  h += _nodesErrRow();
  if (!roots.length && !profiles.length && !nodes.length) h += '<div class="st-empty">暂无分组 · 连接中心可创建部门分组</div>';
  h += '</div>';
  container.innerHTML = h;
}

function _toggleExpand(container, gid, expandKey) {
  var e = getExpand(expandKey);
  e[gid] = e[gid] === false;            /* false=折叠; 切换 */
  setExpand(expandKey, e);
  /* 就地重渲染(用最新 opts) */
  if (container._stRerender) container._stRerender();
}

g.SrvTree = {
  render: render,
  mode: mode,
  setMode: setMode,
  typeOf: typeOf,
  TYPE_ICON: TYPE_ICON,
  TYPE_NAME: TYPE_NAME,
  /* v6.16.16 · 共享/云节点(左树并入)对外入口: 手动刷/失效/默认点击 */
  loadNodes: loadNodes,
  invalidateNodes: invalidateNodes,
  nodesNow: nodesNow,
  nodeClick: _nodeClick
};

/* v6.16.16 · 共享/云变更 → 缓存失效(下次渲染自动取新; 连接中心自身有事件刷新) */
try {
  if (g.EventBus && g.EventBus.on) {
    ['hub.share.changed', 'hub.cloud.changed', 'hub.node.changed'].forEach(function (t) {
      g.EventBus.on(t, function () { invalidateNodes(); });
    });
  }
} catch (e) {}

/* v6.1.7 · 视图切换统一同频: 任何入口(侧栏下拉/连接中心按钮/多云下拉/未来 UniSideBar)
   调 SrvTree.setMode 后, 三处服务器列表 + 侧栏下拉一次性同步刷新 —— 收敛"各写一套联动" */
g.addEventListener('rp-tree-mode', function () {
  try { if (g.ConnCenter) { ConnCenter.renderGroupTree(); ConnCenter.render(); } } catch (e) {}
  try { if (g.SP && g.SP.renderSidebar) g.SP.renderSidebar(); } catch (e) {}
  try { if (g.FonrVFS && g.FonrVFS.refreshTree) g.FonrVFS.refreshTree(); } catch (e) {}
  try { var sel = document.getElementById('ccTreeMode'); if (sel) sel.value = mode(); } catch (e) {}
});
})(window);
