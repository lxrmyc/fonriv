/* v5.34.2 · 连接中心完整版 (P2)
   分组树(多层) + 卡片/列表双视图 + 协议筛选 + 活跃会话面板 + 7-Tab 编辑弹窗
   + 导入导出(json/ssh_config) + EventBus 实时同步 (profile/conn/group.changed) */
(function(g){
'use strict';
function esc(v){ return String(v==null?'':v).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function rpc(a,d){return new Promise(function(res){try{g.send(Object.assign({action:a},d||{}),function(r){res(r||{});});}catch(e){res({status:'error',msg:String(e)});}});}
function $id(x){ return document.getElementById(x); }
function toast(m,t,ms){ if(g.toast)g.toast(m,t||'info',ms||2600); }

let _profiles = [];   // 档案 (sp_list)
let _nodes = [];      // v5.51.0 · P1-6 统一资源目录: 云存储/网络共享节点 (hub_nodes)
let _filterKind = ''; // v5.51.0 · 来源过滤: ''=全部 'ssh' 'cloud' 'share'
let _groups = [];     // 分组
let _sessions = [];   // 活跃会话
let _selGuid = '';
let _selGroup = '';   // ''=全部 '__star'=星标 '__none'=未分组
let _filterProto = '';
let _expand = {};     // 分组树展开状态
let _view = 'card';
let _onlyConn = false;   // v6.1.0 · webui 筛选条按钮态(替代旧 checkbox)
let _onlyStar = false;

/* ═══ 数据 ═══ */
async function loadSessions(){
  // v5.93.0 · 走 RPList(退出即空/失败不覆盖 + 短重试); 会话列表允许为空(本来就可能没有会话)
  const r = await RPList.load('cc_sessions', 'conn_list', {}, {pick:'sessions', requireNonEmpty:false});
  if (r && r.ok) _sessions = r.data || [];
}
async function loadProfiles(){
  // v5.93.0 · 收口到 RPList: 空/失败**不覆盖**上次成功档案(旧实现失败即 _profiles=[] → 列表消失)
  const r = await RPList.load('cc_sp_list', 'sp_list', {}, {pick:'profiles', acceptEmpty:true});   // v6.16.2 批20: 成功但空=真没有
  _ccLoadOk = !!(r && r.ok);
  _ccLoadErr = (r && r.err) ? String(r.err) : '';
  _ccStale = !!(r && r.stale);
  if(!_ccLoadOk){ return; }
  _profiles = (r.data||[]).map(function(p){
    const s = _sessions.find(x=>x.host===p.hostname && String(x.port)===String(p.ssh_port) && x.state==='connected');
    return Object.assign({}, p, {session: s||null});
  });
  /* v6.1.5 · FIX(用户报"按分组/按类型互相点击列表没有变化"): v5.93.0 RPList 收口后
     返回结构是 {data, raw, ...}, groups 在 r.raw.groups —— 这里仍读旧的 r.groups
     → _groups 恒为空 → 分组视图只剩"未分组", 与按类型视图看起来一样"没有变化"。
     与 server_profile.js list() 同口径: r.raw.groups 优先。 */
  _groups = (r.raw && r.raw.groups) || r.groups || [];
}
/* v5.51.0 · P1-6 统一资源目录 (后端 hub_nodes 聚合):
 *   云存储 / 网络共享与 SSH 主机同级出现在连接中心, 一处管理入口, 以 guid 为唯一键。
 *   连接语义: ssh=长会话(连接/断开) · cloud=无状态(探测, 不伪造会话) · share=挂载态(挂载/卸载) */
async function loadNodes(){
  // v5.93.0 · FIX(用户报"共享/云列表时有时无"): 旧实现失败/空即 `_nodes=[]` → 界面清空;
  //   现在改为"空/失败不覆盖上次成功节点 + 短重试", 并记录 stale 供界面提示。
  const r = await RPList.load('cc_nodes', 'hub_nodes',
                              {kinds:'cloud,share,cloudpool', include_ssh:false}, {pick:'nodes'});   // v6.13.0 · 批13: 存储池节点(状态=成员健康)
  if (!r || !r.ok){ return; }
  _nodes = r.data || [];
  _ccNodesStale = !!r.stale;
  if (_ccNodesStale) _ccErr = r.err || '';
}
function nodeToProfile(n){
  // 复用现有卡片/行渲染 (字段形状对齐档案), 附原始节点供详情面板使用
  return {guid:n.guid, name:n.label, hostname:n.sub, ssh_port:'', ssh_user:'',
          kind:n.kind, is_starred:false, group_id:n.group_id||null, tags:n.tags||'',
          // v5.61.0 E5 · 多能力徽标: 用后端算出的能力清单(ssh/smb/rdp/docker/…), 不再只标 kind
          protocols_mask:((n.caps_list && n.caps_list.length) ? n.caps_list : [n.kind]),
          caps_detail:n.caps_detail||{}, session:null, _node:n,
          /* v5.93.0 · FIX(用户报"Seafile/SMB 没有绿点"): 状态取后端统一探测台账(probe),
             挂载态也算在线; **未探测保持 undefined → 灰点 + title「未探测」**, 不伪装成正常。 */
          status: (n.state && n.state.probe) ? n.state.probe.status
                  : ((n.state && n.state.mounted) ? 'online' : undefined),
          latency_ms: (n.state && n.state.probe && n.state.probe.latency_ms) || 0,
          probe: (n.state && n.state.probe) || null};
}
/* v6.16.15 · 节点挂载态**统一判定**(此前卡片描述/主按钮只看 p.mounted, 而圆点/详情看的是
   合并态 p._node.state.mounted → 出现"右侧已挂载、卡片显示未挂载"的不一致; 用户实测) */
function _isMounted(p){ return !!(p && (p.mounted || (p._node && p._node.state && p._node.state.mounted))); }
function nodeByGuid(guid){ for(let i=0;i<_nodes.length;i++){ if(_nodes[i].guid===guid) return _nodes[i]; } return null; }
async function refresh(){ await loadSessions(); await loadProfiles(); await loadNodes(); renderAll(); }

/* v5.58.0 FIX (用户报"第一次进入要刷新才有列表") · 连接中心自身的加载与错误可见化
   旧实现: 只有 `DOMContentLoaded → setTimeout(..., 1400)` 这一次性加载。
   登录/WS 尚未就绪时 sp_list 取不到 → _profiles 保持空 → 界面一片空白**且无任何提示**,
   用户只能按 F5; 而进入面板不会重新加载(只有 panelActive 命中时的 10s 定时刷新)。
   现在: ①进入面板即加载(switchTab 钩 onShow) ②空/失败**显式提示 + 重试**按钮
        ③未就绪时自动重试 3 次(间隔 1.2s), 不再静默空白。 */
let _ccLoadOk = false, _ccLoadErr = '', _ccBusy = false;
let _ccStale = false, _ccNodesStale = false, _ccErr = '';   // v5.93.0 · "用的是上次成功数据"标记
/* v5.95.0 · 长期连接的自动续探: 云存储/网络共享没有超时设置, 应长期在线 ——
   进页面时对"未探测 / 结论超过 10 分钟"的这类节点**自动续探**(一轮最多 3 台, 10 分钟节流),
   结论仍进同一台账 → 绿点长期保持, 且不靠用户手点。失败照实报(不伪装在线)。 */
let _probeAutoAt = 0;
const _PROBE_AUTO_MS = 600000, _PROBE_AUTO_MAX = 3;
async function autoProbeStale(force){
  if (!force && Date.now() - _probeAutoAt < _PROBE_AUTO_MS) return 0;
  _probeAutoAt = Date.now();
  const todo = (_nodes || []).filter(function(n){
    if (n.kind !== 'cloud' && n.kind !== 'share') return false;
    const pr = n.state && n.state.probe;
    return !pr || (pr.age_sec || 0) > 600;
  }).slice(0, _PROBE_AUTO_MAX);
  if (!todo.length) return 0;
  for (let i = 0; i < todo.length; i++){
    const n = todo[i];
    try {
      if (n.kind === 'cloud') await rpc('remote_test', {remote_id: n.remote_id, uuid: n.guid});
      else await rpc('share_test', {uuid: n.guid});
    } catch (e) { /* 单台失败不影响其它 */ }
  }
  await refresh();
  return todo.length;
}

/* v5.99.1 · 链路就绪/重连成功后自动补拉(用户报"连接中心刷新不出服务器"): 会话未就绪时
   发出的 conn_list 会被后端拒掉(实测报"请先登录（会话已丢失）"), 旧代码不再重试 → 界面常空。
   现在 app.js 在会话真正就绪时广播 rp-ws-ready, 这里收到就补拉一次(空列表才拉, 不刷屏)。 */
try {
  window.addEventListener('rp-ws-ready', function(){
    try {
      if (!_nodes || !_nodes.length || !_sessions || !_sessions.length){
        if (typeof refresh === 'function') refresh();
      }
    } catch(e){}
  });
} catch(e){}

async function ensureLoaded(){
  if(_ccBusy) return;
  _ccBusy = true;
  try{
    for(let i=0;i<3;i++){
      await refresh();
      if(_profiles.length || _nodes.length || _ccLoadOk) break;
      await new Promise(function(r){ setTimeout(r, 1200); });
    }
  } catch(e){
    _ccLoadErr = String(e && e.message || e);
    _ccLoadOk = false;
  } finally { _ccBusy = false; }
  renderAll();
  if(!_ccLoadOk) toast('未能取到服务器档案: '+(_ccLoadErr||'未知原因')+' — 可点列表里的「重试」', 'err', 5000);
  // v5.95.0 · 顺带把"长期连接"的云/共享状态续探一下(异步, 不阻塞界面)
  try { autoProbeStale(false); } catch(e){}
}
function renderAll(){
  renderGroupTree(); renderSessions(); renderFilterChips(); render();
  if(_selGuid){
    const _col = document.getElementById('ccDetailCol');
    if (_col && _col.style.display !== 'none') renderDetail(_selGuid);   // 批21: 详情随刷新更新
  }
}

function fmtBytes(n){ n=Number(n)||0; if(n<1024)return n+' B'; if(n<1048576)return(n/1024).toFixed(1)+' KB';
  if(n<1073741824)return(n/1048576).toFixed(1)+' MB'; if(n<1099511627776)return(n/1073741824).toFixed(2)+' GB';
  return(n/1099511627776).toFixed(2)+' TB'; }
function fmtRemain(s){ if(s==null)return'持续';if(s>=86400)return(s/86400).toFixed(1)+'天';if(s>=3600)return Math.floor(s/3600)+'时'+Math.floor((s%3600)/60)+'分';if(s>=60)return Math.floor(s/60)+'分';return s+'秒';}
/* v5.93.0 · 圆点 = 真实健康结论(会话 > 探测台账 > 挂载态), 未探测就是灰 + 显式说明 */
/* v5.93.0 · 探测台账结论 → 中文状态词 (未探测绝不写成"正常"/"可达") */
function _statusWord(pr){
  if(!pr) return '未探测';
  return {online:'可达', offline:'不可达', degraded:'部分可用'}[pr.status] || ('未知('+esc(pr.status)+')');
}
function _probeAge(pr){
  const a = pr.age_sec || 0;
  const t = a < 60 ? (a+' 秒前') : (a < 3600 ? (Math.floor(a/60)+' 分钟前') : (Math.floor(a/3600)+' 小时前'));
  /* v5.95.0 · 云存储/网络共享是**长期连接**(用户要求: 除手动卸载/断开外应长期在线, 没有超时设置)
     → 这类结论不提示"已过期, 建议重测", 直接标"长期在线", 并说明会自动续探。 */
  if (pr.long) return (pr.status === 'online' ? '长期在线' : '上次探测 ' + t) + ' · 探测 ' + t;
  return '上次探测 ' + t + (pr.fresh ? '' : ' (已过期, 建议重测)');
}
/* v5.97.3 · FIX(用户报"共享/云圆点恒灰"): hub_nodes 的节点三态在 `_node.state.reachable`
   (true 可达 / false 不可达 / null 未探测), 而 healthDot/healthText 只看顶层 `status`
   —— 于是「🔌 测试连通」明明有结论, 圆点仍是灰的。这里把节点三态接进圆点与文案。 */
function _nodeReach(p){
  try { return (p && p._node && p._node.state) ? p._node.state.reachable : undefined; } catch(e){ return undefined; }
}
function healthDot(p){ if(p.session&&p.session.state==='connected')return '#54d18c';
  if(p.status==='online')return '#54d18c';
  if(p.status==='offline')return '#ff5f5f';
  if(p.status==='degraded')return '#e8b44a';
  { var _r = _nodeReach(p);
    if(_r === true) return '#54d18c';
    if(_r === false) return '#ff5f5f'; }
  if(p.mounted||(p._node&&p._node.state&&p._node.state.mounted))return '#54d18c';
  return '#ccc'; }
/* 状态文案 (供 title/详情使用): 未探测明确写成"未探测", 不写成"正常" */
function healthText(p){
  if(p.session&&p.session.state==='connected') return '已连接';
  if(p.status==='online')  return '可达' + (p.latency_ms? (' · '+p.latency_ms+'ms') : '');
  if(p.status==='offline') return '不可达';
  if(p.status==='degraded')return '部分可用';
  { var _r2 = _nodeReach(p);
    if(_r2 === true)  return '可达 (已探测)';
    if(_r2 === false) return '不可达 (已探测)'; }
  if(p.mounted||(p._node&&p._node.state&&p._node.state.mounted)) return '已挂载';
  return '未探测 (点「🔌 测试」探测)';
}

/* ═══ 分组树 (多层) ═══ */
/* v6.1.5 · 连接中心左栏「按分组/按类型」按钮: 用户报"互相点击后列表没有变化" ——
   根因: 树容器 #ccGroupTree 被藏进兼容块, 两种模式都渲染不进可见区域。
   现已恢复为页面左栏; 此函数 = 模式切换唯一入口(偏好写入 + 本页重渲染 + 全局侧栏/多云文件管理同步)。 */
function setTreeMode(m){
  /* v6.1.7 · 统一走 SrvTree.setMode: 写偏好 + 广播 rp-tree-mode,
     全局监听统一刷新 连接中心/侧栏/多云 三处列表(单一联动入口) */
  const _m = (m === 'fixed') ? 'fixed' : 'groups';
  if (window.SrvTree) { SrvTree.setMode(_m); }
  /* v6.3.40 · 批 A: 切模式必须**同步清掉另一模式的筛选**, 否则会出现"筛选仍然生效、但对应的
     pill 已隐藏"的隐形筛选 —— 用户看到的列表与筛选条不一致(v6.3.33 记的"静默"一类问题)。 */
  _filterProto = ''; _filterKind = ''; _selGroup = '';
  renderFilterChips();
  renderGroupTree();
  render();
  try {
    if (window.SP && SP.renderSidebar) SP.renderSidebar();
    if (window.FonrVFS && FonrVFS.refreshTree) FonrVFS.refreshTree();
    var sel = document.getElementById('ccTreeMode');
    if (sel) sel.value = (m === 'fixed') ? 'fixed' : 'groups';
  } catch(e){}
}
function renderGroupTree(){
  const el = $id('ccGroupTree'); if(!el) return;
  try{ _expand = JSON.parse(localStorage.getItem('cc_group_expand')||'{}')||{}; }catch(e){ _expand={}; }
  /* 模式按钮态与偏好同步(渲染时也刷, 覆盖从侧栏下拉/多云文件管理切换过来的场景) */
  const _mode = (function(){ try { return localStorage.getItem('fonr_tree_mode') === 'fixed' ? 'fixed' : 'groups'; } catch(e){ return 'groups'; } })();
  try {
    var b1 = document.getElementById('ccModeGroups'), b2 = document.getElementById('ccModeFixed');
    if (b1) b1.className = 'cs-mbtn' + (_mode === 'groups' ? ' cs-mbtn-on' : '');
    if (b2) b2.className = 'cs-mbtn' + (_mode === 'fixed' ? ' cs-mbtn-on' : '');
  } catch(e){}
  /* v6.1.7 · 树体改用公共 SrvTree 渲染器(统一左栏方案 P2): 与多云文件管理/全局侧栏同一实现。
     连接中心形态 = 组导航(showRows:false, 点组过滤右侧卡片) + 快捷项 + ✎✕ 管理;
     折叠记忆沿用旧键 cc_group_expand, 老用户状态无缝。 */
  if (window.SrvTree){
    SrvTree.render(el, { profiles: _profiles, groups: _groups }, {
      view: _mode,
      showRows: false,
      quick: true,
      manage: true,
      activeGroup: _selGroup,
      expandKey: 'cc_group_expand',
      onGroupClick: function(gid){ selGroup(gid === '__star' || gid === '__none' ? gid : (gid || '')); },
      onGroupEdit: function(gid){ groupEdit(gid); },
      onGroupDel: function(gid){ groupDel(gid); },
      onChanged: function(){ refresh(); }
    });
    /* 按类型视图的分区点击沿用 __type_ 语义: SrvTree 的 gnode gid 直接透传 */
    return;
  }
  /* ↓ SrvTree 缺席时的原实现兜底(脚本加载顺序异常时不空白) */
  const count = function(gid){ return _profiles.filter(p=>p.group_id===gid).length; };
  const totalSub = function(gid){
    let n = count(gid);
    _groups.filter(x=>x.parent_id===gid).forEach(function(c){ n += totalSub(c.guid); });
    return n;
  };
  const _typeCnt = function(tk){
    return _profiles.filter(function(p){
      var prot = (p.protocols_mask || []).join(',').toLowerCase();
      var k = String(p.kind || '').toLowerCase();
      if (tk === 'host') return k !== 'cloud' && prot.indexOf('s3') < 0 && prot.indexOf('seafile') < 0 && prot.indexOf('smb') < 0 && prot.indexOf('nfs') < 0;
      if (tk === 'cloud') return k === 'cloud' || prot.indexOf('s3') >= 0 || prot.indexOf('seafile') >= 0;
      if (tk === 'share') return prot.indexOf('smb') >= 0 || prot.indexOf('nfs') >= 0 || k === 'share';
      if (tk === 'pve') return prot.indexOf('pve') >= 0;
      if (tk === 'rdp') return prot.indexOf('rdp') >= 0 || prot.indexOf('vnc') >= 0;
      return true;
    }).length;
  };
  let html = '<div class="cc-gnode'+(_selGroup===''?' cc-gactive':'')+'" style="padding:3px 6px;cursor:pointer;font-size:12px;font-weight:600" onclick="ConnCenter.selGroup(\'\')">📦 全部 ('+_profiles.length+')</div>';
  if (_mode === 'fixed'){
    // v5.90.8 · 按类型视图
    [['host','🐧 主机'],['cloud','☁️ 云存储'],['share','🔗 网络共享'],['pve','🖥 PVE'],['rdp','🖥 RDP/VNC']].forEach(function(ts){
      html += '<div class="cc-gnode'+(_selGroup==='__type_'+ts[0]?' cc-gactive':'')+'" style="padding:3px 6px 3px 14px;cursor:pointer;font-size:11.5px" onclick="ConnCenter.selGroup(\'__type_'+ts[0]+'\')">'+ts[1]+' ('+_typeCnt(ts[0])+')</div>';
    });
    el.innerHTML = html;
    return;
  }
  html +='<div class="cc-gnode'+(_selGroup==='__star'?' cc-gactive':'')+'" style="padding:3px 6px 3px 14px;cursor:pointer;font-size:11.5px" onclick="ConnCenter.selGroup(\'__star\')">⭐ 星标 ('+_profiles.filter(p=>p.is_starred).length+')</div>'
    +'<div class="cc-gnode'+(_selGroup==='__none'?' cc-gactive':'')+'" style="padding:3px 6px 3px 14px;cursor:pointer;font-size:11.5px" onclick="ConnCenter.selGroup(\'__none\')">📁 未分组 ('+count('')+')</div>';
  const roots = _groups.filter(x=>!x.parent_id).sort(function(a,b){return (a.sort_order||0)-(b.sort_order||0)||a.name.localeCompare(b.name);});
  function node(gr, depth){
    const open = _expand[gr.guid]!==false;
    const kids = _groups.filter(x=>x.parent_id===gr.guid);
    let h = '<div style="display:flex;align-items:center" draggable="true" ondragstart="ConnCenter.groupDragStart(event,\''+gr.guid+'\')" ondragover="event.preventDefault();this.style.background=\'var(--bg3)\'" ondragleave="this.style.background=\'\'" ondrop="ConnCenter.groupDrop(event,\''+gr.guid+'\')">'
      +'<div class="cc-gnode'+(_selGroup===gr.guid?' cc-gactive':'')+'" style="padding:3px 6px 3px '+(10+depth*13)+'px;cursor:pointer;font-size:11.5px;flex:1;display:flex;align-items:center;gap:4px" onclick="ConnCenter.selGroup(\''+gr.guid+'\')">'
      +(kids.length?'<span style="width:10px;color:var(--text3);font-size:9px" onclick="event.stopPropagation();ConnCenter.toggleGroup(\''+gr.guid+'\')">'+(open?'▼':'▶')+'</span>':'<span style="width:10px"></span>')
      +'<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(gr.name)+'</span>'
      +'<span style="color:var(--text3);font-size:10px">'+totalSub(gr.guid)+'</span></div>'
      +'<span style="font-size:10px;color:var(--text3);cursor:pointer;padding:0 3px" title="编辑" onclick="ConnCenter.groupEdit(\''+gr.guid+'\')">✎</span>'
      +'<span style="font-size:10px;color:var(--text3);cursor:pointer;padding:0 3px" title="删除" onclick="ConnCenter.groupDel(\''+gr.guid+'\')">✕</span></div>';
    if(open) kids.forEach(function(c){ h += node(c, depth+1); });
    return h;
  }
  roots.forEach(function(gr){ html += node(gr, 0); });
  if(!_groups.length) html += '<div style="padding:4px 14px;font-size:10.5px;color:var(--text3)">无分组 · 点上方 ➕ 创建</div>';
  el.innerHTML = html;
}
function saveExpand(){ try{ localStorage.setItem('cc_group_expand', JSON.stringify(_expand)); }catch(e){} }
function selGroup(v){ _selGroup=v; renderGroupTree(); render(); }
function toggleGroup(guid){ _expand[guid] = _expand[guid]===false; saveExpand(); renderGroupTree(); }
let _dragGuid='';
function cardDragStart(ev, guid){ _dragGuid=guid; ev.dataTransfer.effectAllowed='move'; }
function groupDrop(ev, gid){ ev.preventDefault(); if(_dragGuid){ spBatchMove([_dragGuid], gid); _dragGuid=''; } }
function groupDragStart(){}
async function spBatchMove(guids, gid){
  const r = await rpc('sp_batch',{op:'move', guids:guids, group_id:gid});
  if(r.status==='ok'){ toast('✓ 已移动 '+r.count+' 台到分组'); refresh(); }
}

/* ═══ 分组 CRUD ═══ */
function groupOptions(sel, exclude){
  let out = '<option value="">(顶层/未分组)</option>';
  function walk(pid, depth){
    _groups.filter(x=>x.parent_id===pid).forEach(function(gr){
      if(gr.guid!==exclude){
        out += '<option value="'+gr.guid+'"'+(sel===gr.guid?' selected':'')+'>'+('　'.repeat(depth))+'└ '+esc(gr.name)+'</option>';
        walk(gr.guid, depth+1);
      }
    });
  }
  walk('', 0);
  return out;
}
function groupAdd(){
  modal('新建分组', '<div style="display:flex;flex-direction:column;gap:8px;font-size:12px">'
    +'<label>名称 <input class="input" id="gmName" style="width:100%"></label>'
    +'<label>父分组 <select class="input" id="gmParent" style="width:100%">'+groupOptions('')+'</select></label>'
    +'<label>颜色 <input type="color" id="gmColor" value="#6366f1" style="width:50px;height:26px"></label></div>',
    [ ['取消',''], ['保存','primary', async function(){
      const name=($id('gmName').value||'').trim(); if(!name){toast('请填名称','warn');return;}
      const r = await rpc('sg_save',{group:{name:name, color:$id('gmColor').value, parent_id:$id('gmParent').value}});
      toast(r.msg||'', r.status==='ok'?'success':'err'); if(r.status==='ok'){closeModal();refresh();}
    }] ]);
}
function groupEdit(guid){
  const gr = _groups.find(function(x){return x.guid===guid;}); if(!gr) return;
  modal('编辑分组', '<div style="display:flex;flex-direction:column;gap:8px;font-size:12px">'
    +'<label>名称 <input class="input" id="gmName" style="width:100%" value="'+esc(gr.name)+'"></label>'
    +'<label>父分组 <select class="input" id="gmParent" style="width:100%">'+groupOptions(gr.parent_id||'', guid)+'</select></label>'
    +'<label>颜色 <input type="color" id="gmColor" value="'+esc(gr.color||'#6366f1')+'" style="width:50px;height:26px"></label></div>',
    [ ['取消',''], ['保存','primary', async function(){
      const name=($id('gmName').value||'').trim(); if(!name)return;
      const r = await rpc('sg_save',{group:{guid:gr.guid, name:name, color:$id('gmColor').value, parent_id:$id('gmParent').value}});
      toast(r.msg||'', r.status==='ok'?'success':'err'); if(r.status==='ok'){closeModal();refresh();}
    }] ]);
}
async function groupDel(guid){
  const gr = _groups.find(function(x){return x.guid===guid;}); if(!gr) return;
  if(!(await rpConfirm({ title:'删除分组', danger:true, okText:'删除', body:'删除分组「'+gr.name+'」? 组内服务器移到未分组, 子分组上提一层' }))) return;
  const r = await rpc('sg_del',{guid});
  toast(r.msg||'', r.status==='ok'?'success':'err');
  if(_selGroup===guid) _selGroup='';
  refresh();
}

/* ═══ 弹窗基建 ═══ */
let _modalStack = [];
function modal(title, bodyHtml, buttons, wide){
  const ov = document.createElement('div');
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:12000;display:flex;align-items:center;justify-content:center';
  const w = wide ? '880px' : '430px';
  ov.innerHTML = '<div style="background:var(--bg2);border:1px solid var(--border);border-radius:10px;width:'+w+';max-width:94vw;max-height:88vh;display:flex;flex-direction:column;box-shadow:0 18px 50px rgba(0,0,0,0.4)">'
    +'<div style="padding:10px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center"><b style="font-size:13px;color:var(--text);flex:1">'+esc(title)+'</b>'
    +'<span class="cc-mclose" style="cursor:pointer;color:var(--text3);font-size:16px">✕</span></div>'
    +'<div style="padding:14px 16px;overflow-y:auto;flex:1" class="cc-modal-body">'+bodyHtml+'</div>'
    +'<div style="padding:10px 16px;border-top:1px solid var(--border);display:flex;gap:8px;justify-content:flex-end">'
    +(buttons||[]).map(function(b,i){ return '<button class="btn btn-sm'+(b[1]?' btn-'+b[1]:'')+'" data-mbtn="'+i+'">'+esc(b[0])+'</button>'; }).join('')
    +'</div></div>';
  ov.onclick = function(ev){ if(ev.target===ov) closeModal(ov); };
  document.body.appendChild(ov);
  _modalStack.push(ov);
  const _cl = ov.querySelector('.cc-mclose');
  if(_cl) _cl.onclick = function(){ closeModal(ov); };
  (buttons||[]).forEach(function(b,i){
    const btn = ov.querySelector('[data-mbtn="'+i+'"]');
    if(!btn) return;
    // v5.58.0 FIX: 无处理器的按钮(「取消」等)统一兜底为关窗。
    //   旧实现 `if(btn && b[2])` 只在第 3 项是函数时才绑 onclick,
    //   于是 ['取消',''] 成了**点不动的死按钮**(用户报"取消点不动")。
    btn.onclick = (typeof b[2] === 'function') ? function(){ b[2](); } : function(){ closeModal(ov); };
  });
  return ov;
}
/* v5.58.0 FIX: 关闭**指定**弹窗(✕/点遮罩/取消 共用同一出口), 并清理已从 DOM 移除的僵尸栈项,
   避免异常路径下 `closeModal()` 弹错层(把别的弹窗关掉、自己留着)。 */
function closeModal(ov){
  if(ov){
    const i = _modalStack.indexOf(ov);
    if(i >= 0) _modalStack.splice(i,1);
  } else {
    ov = _modalStack.pop();
  }
  if(ov && ov.parentNode) ov.parentNode.removeChild(ov);
  _modalStack = _modalStack.filter(function(x){ return x && x.parentNode; });
}

/* ═══ 筛选 chips ═══ */
const PROTO_CHIPS_ALL = [['ssh','SSH'],['pve_api','PVE'],['rdp','RDP'],['vnc','VNC'],
                     ['docker','DOCKER'],['truenas','NAS'],['remote_storage','S3'],['database','DB'],['pbs','PBS']];
/* v6.16.14 · 档位裁剪: NAS(TrueNAS/cloud)/S3(cloud)/DB(dbbackup)/PBS(pbs) 属商业键 → 未授权不显示筛选片 */
const PROTO_CHIP_FEAT = { truenas:'cloud', remote_storage:'cloud', database:'dbbackup', pbs:'pbs' };
const PROTO_CHIPS = PROTO_CHIPS_ALL.filter(function(c){
  var f = PROTO_CHIP_FEAT[c[0]];
  return !(f && typeof window.licenseFeatEnabled === 'function' && !window.licenseFeatEnabled(f));
});
/* v6.3.40 · 批 A(用户 2026-10-03 反馈): 右侧原先**两组 pill 各带一个「全部」**(来源组 + 协议组)
   → 视觉重复、不好看。现在:
     · **只有一个「全部」**(点了 = 清空全部筛选与左栏选择);
     · 第二组**跟随左栏模式**(用户原话: "左侧点在按类型上, 右侧的全部也就按类型来显示,
       后面的 SSH PVE 等就不显示; 点了按分组, 就显示 SSH PVE, 主机云存储这些就不显示"):
         - 按类型(fixed) → 类型分区(主机/PVE/桌面/云/共享), 与左树同源同标签, 点击=左树同款 __type_ 语义
         - 按分组(groups) → 协议(SSH/PVE/RDP/VNC/DOCKER/NAS/S3/DB/PBS)
   来源类(kind)筛选不再单独占一排 —— 它已由左树的类型分区与上面的第二组覆盖, 避免两个"全部"。 */
const TYPE_CHIPS = [['__type_host','🖥 主机'],['__type_pve','PVE'],['__type_desktop','🖥 桌面'],
                    ['__type_cloud','☁️ 云'],['__type_share','🔗 共享']];
function curTreeMode(){
  try { return localStorage.getItem('fonr_tree_mode') === 'fixed' ? 'fixed' : 'groups'; } catch(e){ return 'groups'; }
}
function renderFilterChips(){
  const el = $id('ccFilterChips'); if(!el) return;
  const total = _profiles.length + _nodes.length;
  const mode = curTreeMode();
  const g1 = '<div class="ftab-grp">'
    + '<button class="ftab'+(_selGroup===''&&_filterProto===''&&_filterKind===''?' on':'')
    + '" onclick="ConnCenter.filterAll()">全部 (' + total + ')</button></div>';
  let g2;
  if (mode === 'fixed'){
    g2 = '<div class="ftab-grp">' + TYPE_CHIPS.map(function(c){
      const on = (_selGroup === c[0]);
      return '<button class="ftab'+(on?' on':'')+'" onclick="ConnCenter.selGroup(\''+c[0]+'\')">'+c[1]+'</button>';
    }).join('') + '</div>';
  } else {
    g2 = '<div class="ftab-grp">' + PROTO_CHIPS.map(function(c){
      const on = _filterProto === c[0];
      return '<button class="ftab'+(on?' on':'')+'" onclick="ConnCenter.filterProto(\''+c[0]+'\')">'+c[1]+'</button>';
    }).join('') + '</div>';
  }
  el.innerHTML = g1 + g2;
}
function filterAll(){ _filterKind=''; _filterProto=''; _selGroup=''; renderFilterChips(); renderGroupTree(); render(); }
function filterKind(v){ _filterKind = v||''; renderFilterChips(); render(); }

/* v5.51.0 · P1-6 非 SSH 节点操作: 云端=探测(无状态, 不建会话) · 共享=挂载/卸载 */
/* v5.93.0 · 探测 = **真的测连通** (云: remote_test · 共享: share_test 不挂载);
   后端会把结论记进统一探测台账 → 刷新后圆点/详情用的是同一个结论(不再只弹一次 toast 就丢)。 */
async function nodeProbe(guid){
  const n = nodeByGuid(guid); if(!n) return;
  /* v6.13.0 · 批13(用户要求: 云存储池状态进连接中心): 池 = 成员健康汇总(cpool_health_center) */
  if(n.kind==='cloudpool'){
    toast('读取池成员健康…');
    const r = await rpc('cpool_health_center', {pool_id: n.pool_id});
    const sm = (r && r.summary) || {};
    const ok = r.status==='ok' && (sm.total||0) > 0 && (sm.degraded||0) === 0;
    const bad = (sm.degraded||0) > 0;
    if(n.state) n.state.probe = {status: ok ? 'online' : (bad ? 'degraded' : 'offline')};
    toast((ok?'✓ ':'⚠ ') + ('池「'+n.label+'」成员 '+(sm.total||0)+' 个 · 健康 '+((sm.total||0)-(sm.degraded||0))+' · 异常 '+(sm.degraded||0)),
          ok?'success':'warn', 7000);
    await refresh();
    renderDetail(guid);
    return;
  }
  if(n.kind==='cloud'){
    toast('探测云存储连通性…');
    const r = await rpc('remote_test', {remote_id:n.remote_id, uuid:n.guid});
    const ok = r.status==='ok';
    if(n.state) n.state.reachable = ok;
    toast((ok?'✓ ':'✗ ') + (r.msg||(ok?'可达':'不可达')), ok?'success':'err', 6000);
    await refresh();                      // 台账已更新 → 圆点/详情立即是同一结论
    renderDetail(guid);
  } else if(n.kind==='share'){
    toast('测试共享连通性(只测不挂载)…');
    const r = await rpc('share_test', {uuid:n.guid});
    const ok = r.status==='ok';
    if(n.state) n.state.reachable = ok;
    toast((ok?'✓ ':'✗ ') + (r.msg||(ok?'可达':'不可达')), ok?'success':'err', 6000);
    await refresh();
    renderDetail(guid);
  }
}
/* v5.93.0 · 挂载与"测连通"拆开: 挂载是写操作, 不能和探测共用一个按钮(此前点"探测"其实在挂载) */
async function nodeMount(guid){
  const n = nodeByGuid(guid); if(!n || n.kind!=='share') return;
  const r = await rpc('share_mount', {uuid:n.guid});
  toast(r.msg||'已下发挂载', r.status==='ok'?'success':'err');
  refresh();
}
/* v5.93.0 · 引用式编辑(用户要求): 连接中心**不再自己画**共享/云的表单,
   而是切到对应页面并调起它自己的编辑表单 —— 单一真源, 两处行为必然一致。 */
async function refEdit(guid){
  const n = nodeByGuid(guid) || _profiles.filter(function(p){ return p.guid===guid; })[0];
  if(!n) return;
  const kind = n.kind || 'ssh';
  if(kind === 'ssh'){ editorOpen(guid); return; }
  const _sleep = function(ms){ return new Promise(function(f){ setTimeout(f, ms); }); };
  if(kind === 'share'){
    if(!(g.Shares && g.Shares.edit)){ toast('网络共享页未加载, 请先切到「🌐 网络共享」', 'err', 5000); return; }
    try { switchGroup('storage_g'); switchTab('shares'); } catch(e){}
    await _sleep(300);
    try { g.Shares.refresh(); } catch(e){}
    let ok = false;
    // v5.98.7 · 3.5s → 12s: 本机偶发数十秒卡顿/列表补拉需要时间, 窗口太短就会"点了编辑没反应"
    for(let i=0;i<24;i++){
      await _sleep(500);
      try { if (g.Shares.edit(n.guid) === true){ ok = true; break; } } catch(e){}
    }
    toast(ok ? '已切到「网络共享」并载入该共享的编辑表单(与共享页同一套表单)'
             : '共享列表未取到, 没能载入编辑表单 — 请稍后重试(或到共享页点刷新)',
          ok?'success':'err', 5000);
  } else {
    if(!(g.Remotes && g.Remotes.edit)){ toast('远端存储页未加载, 请先切到「☁️ 远端存储」', 'err', 5000); return; }
    try { switchGroup('storage_g'); switchTab('remotes'); } catch(e){}
    await _sleep(300);
    try { g.Remotes.loadList(); } catch(e){}
    let ok = false;
    // v5.98.7 · 同上: 远端存储列表可能正在补拉, 给足 12s 再判失败
    for(let i=0;i<24;i++){
      await _sleep(500);
      try { if (g.Remotes.edit(n.remote_id) === true){ ok = true; break; } } catch(e){}
    }
    toast(ok ? '已切到「远端存储」并载入该配置的编辑表单(与云存储页同一套表单)'
             : '云存储列表未取到, 没能载入编辑表单 — 请稍后重试',
          ok?'success':'err', 5000);
  }
}
/* v6.16.15 · 节点删除(用户实测"右键删除也不能删除"): 共享 → 删除共享配置; 云 → 删除远端配置;
   池(cloudpool) → 只跳管理页(删除走存储池页的完整确认流程)。 */
async function nodeDelete(guid){
  const n = nodeByGuid(guid); if(!n) return;
  if(n.kind === 'share'){
    let _ok = false;
    try { _ok = await rpConfirm({ title:'删除共享', danger:true, okText:'删除',
      body:'确认从台账删除该网络共享配置？\n' + (n.label||n.hostname||'') + (n.state&&n.state.mounted ? '\n\n⚠ 当前处于已挂载状态, 建议先「卸载」再删除' : '') }); } catch(e){}
    if(!_ok) return;
    const r = await rpc('share_delete', {uuid: n.guid});
    toast(r.msg || (r.status==='ok' ? '已删除' : '删除失败'), r.status==='ok'?'success':'err');
    await refresh();
    return;
  }
  if(n.kind === 'cloud'){
    toast('请在「☁️ 远端存储」页删除该配置(带引用检查)', 'warn', 5000);
    try { switchGroup('storage_g'); switchTab('remotes'); } catch(e){}
    return;
  }
  toast('该节点请在对应管理页删除', 'warn', 4000);
}
async function nodeUmount(guid){
  const n = nodeByGuid(guid); if(!n) return;
  if(n.kind!=='share') return;
  const r = await rpc('share_umount', {uuid:n.guid});
  toast(r.msg||'已下发卸载', r.status==='ok'?'success':'err');
  refresh();
}
function renderNodeDetail(n){
  const el = $id('ccDetail'); if(!el) return;
  const kindName = n.kind==='cloud' ? '☁ 云存储' : n.kind==='share' ? '📁 网络共享' : n.kind;
  const sem = (n.caps && n.caps.conn_semantics) || (n.kind==='cloud'?'stateless':'mount');
  let h = '<b style="font-size:13px;color:var(--text)">'+esc(n.label)+'</b><br>'
    +'<span style="color:var(--text3)">'+esc(kindName)+' · '+esc(n.sub||'')+'</span><br>';
  if(n.provider) h += '协议/服务: '+esc(n.provider)+'<br>';
  if(n.kind==='cloud'){
    const caps = n.caps||{};
    const on = Object.keys(caps).filter(function(k){return k!=='conn_semantics'&&caps[k];});
    h += '能力: '+esc(on.join(', ')||'—')+'<br>';
    var _pr = (n.state && n.state.probe) || null;
    h += '状态: <b style="color:'+healthDot({status:_pr?_pr.status:undefined})+'">'
       + _statusWord(_pr) + '</b>';
    if(_pr) h += '<span style="color:var(--text3)"> · ' + _probeAge(_pr) + '</span>';
    if(_pr && _pr.msg) h += '<br><span style="font-size:10px;color:var(--text3)">结论: '+esc(_pr.msg)+'</span>';
    h += '<br>';
    h += '<div style="font-size:10px;color:var(--text3);margin-top:4px">连接语义: <b>无状态</b> — 云存储每次请求自带凭据, 无需保持会话(不伪造长连接)</div>';
  } else if(n.kind==='share'){
    var _ps = (n.state && n.state.probe) || null;
    h += '状态: <b style="color:'+(n.state&&n.state.mounted?'var(--green)':healthDot({status:_ps?_ps.status:undefined}))+'">'
       + (n.state&&n.state.mounted ? ('已挂载'+(n.state.mnt?(' · '+esc(n.state.mnt)):'')) : ('未挂载 · 连通性'+_statusWord(_ps))) + '</b>';
    if(_ps) h += '<span style="color:var(--text3)"> · ' + _probeAge(_ps) + '</span>';
    if(_ps && _ps.msg) h += '<br><span style="font-size:10px;color:var(--text3)">结论: '+esc(_ps.msg)+'</span>';
    h += '<br>';
    h += '<div style="font-size:10px;color:var(--text3);margin-top:4px">连接语义: <b>挂载态</b> — 挂载后本机路径可直接浏览/传输</div>';
  }
  // v5.61.0 E5 · 能力清单(每项自带目标面板): 一处看清"这台资源能做什么", 点「去使用」直达
  const _cd = n.caps_detail || {}, _cl = n.caps_list || [];
  if(_cl.length){
    h += '<div style="margin-top:8px;font-size:11px">能力 <b>'+_cl.length+'</b> 项:</div>';
    _cl.forEach(function(c){
      const d = _cd[c] || {};
      const extra = [d.host ? (d.host+':'+(d.port||'')) : '', d.url||'', d.endpoint||'', d.share||'',
                     d.path||'', (d.devices? (d.devices.length+' 块盘'):'')].filter(Boolean).slice(0,1).join('');
      h += '<div style="display:flex;align-items:center;gap:6px;margin:3px 0">'
        + '<span style="font-size:10.5px;padding:1px 6px;border:1px solid var(--border);border-radius:8px">'
        + esc(d.label || c) + '</span>'
        + '<span style="font-size:10px;color:var(--text3);flex:1">'+esc(extra)+'</span>'
        + (d.panel ? '<button class="btn btn-xs" onclick="ConnCenter.useCap(\''+esc(n.guid)+'\',\''+esc(c)+'\')">去使用</button>' : '')
        + '</div>';
    });
  }
  h += 'GUID: <span style="font-size:9.5px;color:var(--text3)">'+esc(n.guid)+'</span><br>';
  h += '<div style="margin-top:8px;display:flex;gap:5px;flex-wrap:wrap">';
  if(n.kind==='cloud'){
    h += '<button class="btn btn-sm btn-primary" onclick="ConnCenter.nodeProbe(\''+n.guid+'\')">🔌 测试连通</button>';
  } else {
    h += '<button class="btn btn-sm btn-primary" onclick="ConnCenter.nodeProbe(\''+n.guid+'\')">🔌 测试连通</button>';
    h += (n.state&&n.state.mounted)
      ? '<button class="btn btn-sm" style="color:var(--red)" onclick="ConnCenter.nodeUmount(\''+n.guid+'\')">⏹ 卸载</button>'
      : '<button class="btn btn-sm" onclick="ConnCenter.nodeMount(\''+n.guid+'\')">🔗 挂载</button>';
  }
  /* v5.93.0 · 引用式编辑: 直接调起对应页面自己的编辑表单(单一真源) */
  h += '<button class="btn btn-sm" onclick="ConnCenter.refEdit(\''+n.guid+'\')">✏️ 编辑</button>';
  h += '<button class="btn btn-sm" onclick="ConnCenter.quickAct(\''+n.guid+'\',\'edit\')">⚙ 管理配置</button>';   // v6.16.15 · 节点按类型分流(修"点不动")
  h += '</div>';
  h += '<div style="margin-top:10px;border-top:1px solid var(--border);padding-top:6px;font-size:10.5px;color:var(--text3)">'
     + '💡 该节点与主机同级管理; 事件按 GUID 刷新 (hub.node.changed)</div>';
  el.innerHTML = h;
}
/* v5.61.0 E5 · 从连接中心「去使用」某个能力: 切到该能力对应的面板, 并按 guid 填充目标面板。
   面板映射由后端 caps_detail[cap].panel 提供(**单一真源**), 前端不硬编码"什么能力开什么页"。 */
function useCap(guid, cap){
  const n = nodeByGuid(guid) || (function(){ const p=_profiles.find(function(x){return x.guid===guid;});
                                              return p?{label:p.name||p.hostname}:null; })();
  const cd = (n && n.caps_detail) || {};
  const panel = (cd[cap] && cd[cap].panel) || '';
  if(!panel){ say('该能力没有对应的使用入口'); return; }
  window._hubLastGuid = guid;
  try{ if(typeof window.switchTab === 'function') window.switchTab(panel); }catch(e){}
  setTimeout(function(){
    try{ if(g.SP && g.SP.fillByGuid) g.SP.fillByGuid(guid); }catch(e){}
    toast('已切到「'+panel+'」· 资源 ' + ((n&&n.label)||guid), 'info', 3200);
  }, 260);
}

/* v5.61.0 E5 · GUID 定向刷新: hub.node.changed 带 guid 时只重取**该节点**(不再整表拉取)。
   注: 列表 DOM 仍是整表重建(当前规模下开销可忽略), 但数据获取与状态合入是按 guid 的。 */
async function refreshNode(guid){
  if(!panelActive()) return;
  if(!guid){ refresh(); return; }
  try{
    const r = await rpc('hub_nodes', {guid: guid, kinds:'cloud,share'});
    const fresh = (r.status==='ok' ? (r.nodes||[]) : []);
    const i = _nodes.findIndex(function(x){ return x.guid===guid; });
    if(fresh.length){
      if(i>=0) _nodes[i] = fresh[0]; else _nodes.push(fresh[0]);
    } else if(i>=0){
      _nodes.splice(i,1);                       // 节点已消失(共享卸载/云配置被删)
    }
  }catch(e){ /* 定向失败 → 退回整表刷新 */ await refresh(); return; }
  await loadProfiles();
  renderAll();
}
function filterProto(v){ _filterProto = (_filterProto===v?'':v); renderFilterChips(); render(); }

/* ═══ 活跃会话面板 ═══ */
function renderSessions(){
  const el = $id('ccSessions'); if(!el) return;
  const act = _sessions.filter(function(s){return s.state==='connected';});
  const cnt = $id('ccSessCount'); if(cnt) cnt.textContent = act.length?(''+act.length):'';
  if(!act.length){ el.innerHTML = '<div style="font-size:10.5px;color:var(--text3);padding:2px 4px">无活跃会话</div>'; return; }
  el.innerHTML = act.map(function(s){
    return '<div style="padding:4px;font-size:10.5px;border-bottom:1px solid var(--border)">'
      +'<div style="display:flex;align-items:center;gap:4px"><span style="width:7px;height:7px;border-radius:50%;background:#54d18c"></span>'
      +'<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+esc(s.endpoint)+'">'+esc(s.name||s.endpoint)+'</span>'
      +'<span style="color:var(--text3)">'+(s.remain_sec!=null?fmtRemain(s.remain_sec):'持续')+'</span></div>'
      +'<div style="display:flex;gap:4px;margin-top:2px"><button class="btn btn-sm" style="padding:0 6px;font-size:10px" onclick="ConnCenter.renew(\''+esc(s.session_id)+'\')">+1h</button>'
      +'<button class="btn btn-sm" style="padding:0 6px;font-size:10px;color:var(--red)" onclick="ConnCenter.close(\''+esc(s.session_id)+'\')">断开</button></div></div>';
  }).join('')
  +'<button class="btn btn-sm" style="width:100%;margin-top:4px;font-size:10px;color:var(--red)" onclick="ConnCenter.disconnectAll()">全部断开</button>';
}
async function disconnectAll(){
  const act = _sessions.filter(function(s){return s.state==='connected';});
  if(!act.length) return;
  if(!(await rpConfirm({ title:'断开全部会话', danger:true, okText:'断开', body:'断开全部 '+act.length+' 个会话?' }))) return;
  for(const s of act){ await rpc('conn_close',{session_id:s.session_id}); }
  refresh();
}

/* ═══ 主列表 (卡片/列表) ═══ */
function setView(v){ _view=v; try{localStorage.setItem('cc_view',v);}catch(e){} _syncFilterBtns(); render(); }
function toggleView(){ setView(_view==='card'?'list':'card'); }
function toggleOnlyConn(){ _onlyConn=!_onlyConn; _syncFilterBtns(); render(); }
function toggleOnlyStar(){ _onlyStar=!_onlyStar; _syncFilterBtns(); render(); }
function _syncFilterBtns(){
  const vb=$id('ccViewBtn'); if(vb){ vb.textContent = _view==='card' ? '▦ 卡片' : '☰ 列表'; vb.classList.toggle('on', true); }
  const cb=$id('ccOnlyConnBtn'); if(cb){ cb.textContent = (_onlyConn?'☑':'□')+' 已连接'; cb.classList.toggle('on', _onlyConn); }
  const sb=$id('ccStarBtn'); if(sb){ sb.textContent = (_onlyStar?'★':'☆')+' 星标'; sb.classList.toggle('on', _onlyStar); }
}
function visibleProfiles(){
  // v5.51.0 · P1-6: 按来源过滤 (全部/主机/云存储/网络共享); 非 SSH 节点并入同一列表
  let items = (_filterKind==='cloud'||_filterKind==='share') ? [] : _profiles;
  if(_filterKind!=='ssh') items = items.concat(_nodes.map(nodeToProfile));
  if(_selGroup && _selGroup.indexOf('__type_') === 0){
    // v5.90.8 · 视图=按类型: 主机/云存储/网络共享/PVE/RDP/其他 (虚拟分组)
    var tk = _selGroup.slice(7);   // '__type_' 长 7
    items = items.filter(function(p){
      var prot = (p.protocols_mask || []).join(',').toLowerCase();
      var k = String(p.kind || '').toLowerCase();
      if (tk === 'host') return k !== 'cloud' && prot.indexOf('s3') < 0 && prot.indexOf('seafile') < 0 && prot.indexOf('smb') < 0 && prot.indexOf('nfs') < 0;
      if (tk === 'cloud') return k === 'cloud' || prot.indexOf('s3') >= 0 || prot.indexOf('seafile') >= 0;
      if (tk === 'share') return prot.indexOf('smb') >= 0 || prot.indexOf('nfs') >= 0 || k === 'share';
      if (tk === 'pve') return prot.indexOf('pve') >= 0;
      if (tk === 'rdp') return prot.indexOf('rdp') >= 0 || prot.indexOf('vnc') >= 0;
      return true;
    });
  }
  else if(_selGroup==='__star') items = items.filter(function(p){return p.is_starred;});
  else if(_selGroup==='__none') items = items.filter(function(p){return !p.group_id;});
  else if(_selGroup) {
    const subIds = function(gid){ let ids=[gid]; _groups.filter(function(x){return x.parent_id===gid;}).forEach(function(c){ids=ids.concat(subIds(c.guid));}); return ids; };
    const ids = subIds(_selGroup);
    items = items.filter(function(p){return ids.indexOf(p.group_id)>=0;});
  }
  if(_filterProto && _filterProto!=='ssh') items = items.filter(function(p){return (p.protocols_mask||[]).indexOf(_filterProto)>=0;});
  const q = ((($id('ccSearch')||{}).value)||'').trim();
  if(q) items = items.filter(function(p){return (p.name||'').indexOf(q)>=0||(p.hostname||'').indexOf(q)>=0||(p.tags||'').indexOf(q)>=0;});
  if(_onlyConn) items = items.filter(function(p){return p.session;});
  if(_onlyStar) items = items.filter(function(p){return p.is_starred;});
  return items;
}
function render(){
  const list = $id('ccList'); if(!list) return;
  // v5.93.0 · 用"上次成功数据"时必须显式说明 —— 不许静默把旧数据当实时(CLAUDE.md §3.7)
  const _sb = $id('ccStaleBar');
  if(_sb){
    const _why = _ccStale ? _ccLoadErr : (_ccNodesStale ? _ccErr : '');
    if(_ccStale || _ccNodesStale){
      _sb.style.display = '';
      _sb.innerHTML = '⚠ 本次未取到最新数据, 显示的是**上次成功结果**' + (_why ? ('（'+esc(_why)+'）') : '')
        + ' <button class="btn btn-xs" onclick="ConnCenter.onShow()">🔄 重试</button>';
    } else { _sb.style.display = 'none'; }
  }
  const items = visibleProfiles();
  if(!items.length){
    list.style.display='block';
    const _noData = !_profiles.length && !_nodes.length;
    if(_noData && !_ccLoadOk){
      // 取不到 ≠ 没有: 明确区分并给重试入口 (禁止静默空白, 见 CLAUDE.md §3.7)
      list.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text3);font-size:12px">'
        + '⚠ 未取到服务器档案' + (_ccLoadErr ? '（'+esc(_ccLoadErr)+'）' : '') + '<br>'
        + '<span style="font-size:11px">可能是登录/连接尚未就绪</span><br><br>'
        + '<button class="btn btn-sm btn-primary" onclick="ConnCenter.onShow()">🔄 重试</button></div>';
      return;
    }
    if(_noData){
      /* v6.16.2 批20 · 新装空档案 = 正常初始态: 绿色引导新建(用户明令), 不再灰字 */
      list.innerHTML = '<div style="padding:40px;text-align:center;font-size:13px;line-height:2.4;color:var(--green)">'
        + '✓ 尚未添加服务器<br/>'
        + '<span style="color:var(--text2);font-size:12px">点下面按钮创建第一台服务器档案</span><br>'
        + '<button class="btn btn-sm btn-primary" onclick="ConnCenter.editorOpen()">➕ 新建服务器</button>　'
        + '<button class="btn btn-sm" onclick="ConnCenter.syncFromConfigs()">🔄 从旧配置迁移</button></div>';
      return;
    }
    list.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text3);font-size:12px">当前筛选无结果<br><br><button class="btn btn-sm btn-primary" onclick="ConnCenter.editorOpen()">➕ 新建服务器</button>　<button class="btn btn-sm" onclick="ConnCenter.syncFromConfigs()">🔄 从旧配置迁移</button></div>';
    return;
  }
  if (_view==='card'){
    list.style.display = 'grid';
    list.style.gridTemplateColumns = 'repeat(auto-fill,minmax(240px,1fr))';
    list.style.gap = '10px';
    list.style.alignContent = 'start';
    list.innerHTML = items.map(cardHtml).join('')
      + '<div class="sc sc-add" onclick="ConnCenter.editorOpen()"><div class="sc-add-inner">'
      + '<div class="sc-add-plus">＋</div><div class="sc-add-txt">新建服务器</div></div></div>';
  } else {
    list.style.display = 'block';
    list.style.gridTemplateColumns = '';
    list.innerHTML = '<div class="cc-rows">' + items.map(rowHtml).join('') + '</div>';
  }
}
function starBtn(p){ return '<span style="cursor:pointer;font-size:12px;color:'+(p.is_starred?'#f5c518':'var(--text3)')+'" onclick="event.stopPropagation();ConnCenter.toggleStar(\''+p.guid+'\')">'+(p.is_starred?'★':'☆')+'</span>'; }
function protoBadges(p){
  const M = {pve_api:'PVE', rdp:'RDP', vnc:'VNC', docker:'DOCKER', truenas:'NAS', remote_storage:'S3', database:'DB', pbs:'PBS', cloudpool:'池'};
  return (p.protocols_mask||[]).filter(function(m){return m!=='ssh';}).map(function(m){return '<span style="font-size:9px;padding:1px 5px;border-radius:3px;background:var(--bg3);color:var(--blue)">'+(M[m]||String(m).toUpperCase())+'</span>';}).join(' ');
}
/* v6.1.0 · webui 卡片体系: 类型顶线渐变 + 头像 + 状态点/延迟 + 协议徽章 + 操作行 */
const _BD = {ssh:['SSH','wui-bd-ssh'], pve_api:['PVE','wui-bd-pve'], pve:['PVE','wui-bd-pve'],
             rdp:['RDP','wui-bd-rdp'], vnc:['VNC','wui-bd-rdp'], docker:['DOCKER','wui-bd-smb'],
             truenas:['NAS','wui-bd-pve'], remote_storage:['S3','wui-bd-s3'], s3:['S3','wui-bd-s3'],
             seafile:['Seafile','wui-bd-sea'], smb:['SMB','wui-bd-smb'], nfs:['NFS','wui-bd-smb'],
             database:['DB','wui-bd-rdp'], pbs:['PBS','wui-bd-loc'], cloudpool:['POOL','wui-bd-s3']};
function _scTags(p){
  let mask = (p.protocols_mask||[]).slice();
  if(p.kind==='cloud'||p.kind==='share'||p.kind==='cloudpool'){   // v6.13.0 · 批13: 池节点不插 SSH 标签
    mask = mask.filter(function(m){return m!=='ssh';});
  } else if(mask.indexOf('ssh')<0){ mask = ['ssh'].concat(mask); }
  return mask.slice(0,4).map(function(m){
    const it = _BD[m] || [String(m).toUpperCase(),'wui-bd-loc'];
    return '<span class="sc-tag si-bd '+it[1]+'">'+it[0]+'</span>';
  }).join('');
}
function _scType(p){
  const prot=(p.protocols_mask||[]).join(',').toLowerCase(); const k=String(p.kind||'').toLowerCase();
  if(k==='cloudpool') return 'type-pool';   // v6.13.0 · 批13
  if(prot.indexOf('seafile')>=0) return 'type-seafile';
  if(k==='cloud'||prot.indexOf('s3')>=0||prot.indexOf('remote_storage')>=0) return 'type-s3';
  if(prot.indexOf('smb')>=0||prot.indexOf('nfs')>=0||k==='share') return 'type-smb';
  if(prot.indexOf('pve')>=0) return 'type-pve';
  if(prot.indexOf('rdp')>=0||prot.indexOf('vnc')>=0) return 'type-win';
  return 'type-linux';
}
function _scAvatar(p){
  const t=_scType(p);
  return { 'type-linux':'🐧','type-pve':'🖥','type-win':'🪟','type-smb':'📡',
           'type-s3':'☁️','type-seafile':'🐟','type-pool':'🧩' }[t] || '🐧';
}
function _dotCls(p){
  if(p.session && p.session.state==='connected') return 'on';
  if(p.status==='online') return 'on';
  if(p.status==='offline') return 'off';
  var _r; try { _r = _nodeReach(p); } catch(e){}
  if(_r === true) return 'on';
  if(_r === false) return 'off';
  if(p.mounted||(p._node&&p._node.state&&p._node.state.mounted)) return 'on';
  return 'warn';
}
function _latText(p){
  if(p.session && p.session.state==='connected') return '已连接';
  if(p.last_latency_ms>0) return p.last_latency_ms+'ms';
  if(p.latency_ms>0) return p.latency_ms+'ms';
  if(p.mounted||(p._node&&p._node.state&&p._node.state.mounted)) return '在线';
  if(p.status==='online') return '可达';
  return '未探测';
}
/* v6.7.0 · 行/卡片共用主操作按钮 —— 恢复 v6.0.0 的观感(用户: 绿底白字那种好看):
   当时是 `btn btn-sm btn-primary`(浅色主题=绿底白字, 深色主题=主题蓝), webui 改版后
   卡片换成了 sc-btn.primary(蓝底深字)、列表行的按钮被整体删掉。现两处统一回到 btn-primary。 */
function _primaryBtn(p, s, compact){
  var st = compact ? 'padding:1px 8px;font-size:10.5px' : 'padding:2px 10px;font-size:11px';
  if (s) return '<button class="btn btn-sm" style="' + st + ';color:var(--red)" title="断开当前会话" '
              + 'onclick="event.stopPropagation();ConnCenter.close(\'' + s.session_id + '\')">⏹ 断开</button>'
              + '<span style="font-size:10.5px;color:var(--green)">剩 ' + fmtRemain(s.remain_sec) + '</span>';
  if (p.kind === 'cloudpool') return '<button class="btn btn-sm btn-primary" style="' + st + '" '
              + 'title="打开「存储池」页管理/查看该池" onclick="event.stopPropagation();try{switchGroup(\'storage_g\');switchTab(\'cloudpool\');}catch(e){}">🧩 打开池</button>';   // v6.13.0 · 批13
  if (p.kind === 'cloud') return '<button class="btn btn-sm btn-primary" style="' + st + '" '
              + 'onclick="event.stopPropagation();ConnCenter.nodeProbe(\'' + p.guid + '\')">🔍 探测</button>';
  if (p.kind === 'share') return _isMounted(p)
    ? '<button class="btn btn-sm" style="' + st + '" onclick="event.stopPropagation();ConnCenter.nodeUmount(\'' + p.guid + '\')">⊘ 卸载</button>'
    : '<button class="btn btn-sm btn-primary" style="' + st + '" onclick="event.stopPropagation();ConnCenter.nodeMount(\'' + p.guid + '\')">🔗 挂载</button>';
  return '<button class="btn btn-sm btn-primary" style="' + st + '" '
       + 'onclick="event.stopPropagation();ConnCenter.select(\'' + p.guid + '\');ConnCenter.open()">🔗 连接</button>';
}
function cardHtml(p){
  const s = p.session;
  const dotCls = _dotCls(p);
  const latT = _latText(p);
  const latCls = dotCls==='on' ? '' : (dotCls==='off' ? ' off' : ' warn');
  // 描述行: 云/共享节点给能力或挂载信息; SSH 档案给系统+状态
  let desc = '', descWarn = false;
  if(p.kind==='cloud'){
    desc = (p.desc || ((p.caps_list&&p.caps_list.length)?('能力: '+p.caps_list.join(' · ')):('云对象存储 · '+(p.provider||''))));
  } else if(p.kind==='share'){
    desc = _isMounted(p) ? ('已挂载 · '+(p.free!=null?fmtBytes(p.free)+' 可用':'')) : (p.desc||'网络共享 · 未挂载');
  } else {
    /* v1.0.0 · i18n: 状态词在拼装时直接翻译(此 desc 走 esc() 输出, 注入标签会被转义成字面量) */
    var _st = (s?'已连接':(p.status==='offline'?'离线':(p.status==='online'?'在线':'')));
    if (_st && window.t) _st = window.t(_st);
    desc = [p.os_version||p.os_type||'', _st].filter(Boolean).join(' · ');
    if(p._noPassHint){ desc = p._noPassHint; descWarn = true; }
  }
  if(!desc) desc = '—';
  // 主按钮: 会话中→断开 · 云→探测 · 共享→挂载/卸载 · 其余→连接 (v6.7.0: 统一回 btn-primary 观感)
  const primary = _primaryBtn(p, s, false);
  return '<div data-guid="'+esc(p.guid)+'" draggable="true" ondragstart="ConnCenter.cardDragStart(event,\''+p.guid+'\')" class="sc '+_scType(p)+(p.guid===_selGuid?' wui-sel':'')+'" onclick="ConnCenter.select(\''+p.guid+'\')" ondblclick="ConnCenter.open()">'
    +'<div class="sc-top">'
    +'<div class="sc-id"><div class="sc-avatar">'+_scAvatar(p)+'</div><div style="min-width:0">'
    +'<div class="sc-name">'+esc(p.name||p.hostname)+(p.is_starred?' <span style="color:#f5c518">★</span>':'')+'</div>'
    +'<div class="sc-host">'+esc(p.hostname||'')+(p.ssh_port?(':'+esc(p.ssh_port)):'')+'</div></div></div>'
    +'<div class="sc-status"><span class="dot '+dotCls+'" title="'+esc(healthText(p))+'"></span><span class="sc-lat'+latCls+'">'+esc(latT)+'</span></div>'
    +'</div>'
    +'<div class="sc-tags">'+_scTags(p)+'</div>'
    +'<div class="sc-desc'+(descWarn?' warn':'')+'">'+esc(desc)+'</div>'
    +'<div class="sc-actions">'
    + primary      // v1.0.0 · 剩余时间已在 primary(断开按钮后)输出, 这里不再重复一份(用户报"两个剩余时间")
    +'<button class="sc-btn ico" title="探测连通" onclick="event.stopPropagation();ConnCenter.quickAct(\''+p.guid+'\',\'probe\')">📡</button>'
    +'<button class="sc-btn ico" title="管理配置" onclick="event.stopPropagation();ConnCenter.quickAct(\''+p.guid+'\',\'edit\')">⚙</button>'
    +'<button class="sc-btn ico" title="更多操作" onclick="event.stopPropagation();ConnCenter.cardMenu(event,\''+p.guid+'\')">⋮</button>'
    +'</div></div>';
}
function rowHtml(p){
  const s = p.session;
  return '<div data-guid="'+esc(p.guid)+'" draggable="true" ondragstart="ConnCenter.cardDragStart(event,\''+p.guid+'\')" class="cc-row'+(p.guid===_selGuid?' sel':'')+'" onclick="ConnCenter.select(\''+p.guid+'\')" ondblclick="ConnCenter.open()">'
    +'<span class="dot '+_dotCls(p)+'" title="'+esc(healthText(p))+'"></span>'
    +'<b style="font-size:12.5px;color:var(--text);width:170px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(p.name||p.hostname)+'</b>'
    +'<span class="sc-host" style="width:180px">'+esc(p.hostname)+(p.ssh_port?(':'+esc(p.ssh_port)):'')+'</span>'
    +'<span style="display:flex;gap:4px;flex:1;flex-wrap:wrap">'+_scTags(p)+'</span>'
    +'<span class="sc-lat'+(_dotCls(p)==='on'?'':' off')+'">'+esc(_latText(p))+'</span>'
    +_primaryBtn(p, s, true)
    +starBtn(p)
    +'<span style="cursor:pointer;color:var(--text3)" onclick="event.stopPropagation();ConnCenter.cardMenu(event,\''+p.guid+'\')">⋮</span></div>';
}
/* v6.16.15 · 右键菜单走既有 listMenu(#ccList oncontextmenu) → ctxMenu; 其 删除 已按节点分流(nodeDelete) */
/* v6.16.15 · 节点/档案通用动作入口: 📡/⚙ 按钮按 guid 类型分流(节点走 nodeProbe/refEdit,
   档案走 sp_*), 修"节点卡片点 📡/⚙ 报「档案不存在」" */
function quickAct(guid, what){
  const n = nodeByGuid(guid);
  if(n){
    if(what === 'probe') return nodeProbe(guid);
    if(what === 'edit')  return refEdit(guid);
    return;
  }
  if(what === 'probe') return probe(guid);
  if(what === 'edit')  return editorOpen(guid);
}
function cardMenu(ev, guid){
  ev.preventDefault(); ev.stopPropagation();
  /* v6.16.15 · 节点(共享/云/池)与档案分流: 此前只查 _profiles → 节点卡片点 ⋮ **毫无反应**
     (用户实测"三个点也点不动"), 且节点菜单缺删除/挂载。 */
  const _n = nodeByGuid(guid);
  if(_n){
    _selGuid = guid;
    const isShare = _n.kind === 'share';
    let h = '<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;font-size:12px">';
    h += '<button class="btn btn-sm" onclick="ConnCenter.closeModal();ConnCenter.quickAct(\''+guid+'\',\'edit\')">⚙ 管理配置</button>';
    h += '<button class="btn btn-sm" onclick="ConnCenter.closeModal();ConnCenter.quickAct(\''+guid+'\',\'probe\')">📡 测试连通</button>';
    if (isShare){
      h += _isMounted(_n)
        ? '<button class="btn btn-sm" onclick="ConnCenter.closeModal();ConnCenter.nodeUmount(\''+guid+'\')">⊘ 卸载</button>'
        : '<button class="btn btn-sm" onclick="ConnCenter.closeModal();ConnCenter.nodeMount(\''+guid+'\')">🔗 挂载</button>';
    }
    if (_n.kind === 'cloud'){
      h += '<button class="btn btn-sm" onclick="ConnCenter.closeModal();switchGroup(\'storage_g\');switchTab(\'remotes\')">☁️ 远端存储页</button>';
    }
    if (_n.kind === 'cloudpool'){
      h += '<button class="btn btn-sm" onclick="ConnCenter.closeModal();ConnCenter.quickAct(\''+guid+'\',\'probe\')">🧩 池健康</button>';
    }
    h += '<button class="btn btn-sm" style="color:var(--red)" onclick="ConnCenter.closeModal();ConnCenter.nodeDelete(\''+guid+'\')">🗑 删除</button>';
    h += '</div>';
    modal((_n.label || _n.hostname || _n.guid) + ' · 操作', h, [['关闭','']]);
    return;
  }
  const p = _profiles.find(function(x){return x.guid===guid;}); if(!p) return;
  _selGuid = guid;
  modal((p.name||p.hostname)+' · 操作',
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;font-size:12px">'
    +'<button class="btn btn-sm" onclick="ConnCenter.closeModal();ConnCenter.editorOpen(\''+guid+'\')">✏️ 编辑档案</button>'
    +'<button class="btn btn-sm" onclick="ConnCenter.closeModal();ConnCenter.probe(\''+guid+'\')">📡 探测</button>'
    +'<button class="btn btn-sm" onclick="ConnCenter.closeModal();ConnCenter.toggleStar(\''+guid+'\')">'+(p.is_starred?'☆ 取消星标':'★ 星标')+'</button>'
    +'<button class="btn btn-sm" onclick="ConnCenter.closeModal();ConnCenter.moveMenu(\''+guid+'\')">📁 移动到分组</button>'
    +'<button class="btn btn-sm" onclick="ConnCenter.closeModal();ConnCenter.duplicate(\''+guid+'\')">📋 复制</button>'
    +'<button class="btn btn-sm" style="color:var(--red)" onclick="ConnCenter.closeModal();ConnCenter.del(\''+guid+'\')">🗑 删除</button></div>', [['关闭','']]);
}
function moveMenu(guid){
  const p = _profiles.find(function(x){return x.guid===guid;}); if(!p) return;
  modal('移动「'+(p.name||p.hostname)+'」到分组',
    '<select class="input" id="mvGroup" style="width:100%;font-size:12px">'
    +groupOptions(p.group_id||'')
    +'</select><div style="font-size:10.5px;color:var(--text3);margin-top:6px">💡 也可以直接把卡片拖到左侧分组树上</div>',
    [['取消',''],['移动','primary',async function(){
      const r = await rpc('sp_batch',{op:'move', guids:[guid], group_id:$id('mvGroup').value});
      toast(r.msg||'', r.status==='ok'?'success':'err'); closeModal(); refresh();
    }]]);
}
async function toggleStar(guid){
  const p = _profiles.find(function(x){return x.guid===guid;}); if(!p) return;
  const r = await rpc('sp_batch',{op:p.is_starred?'unstar':'star', guids:[guid]});
  if(r.status==='ok') refresh();
}
async function duplicate(guid){
  const p = _profiles.find(function(x){return x.guid===guid;}); if(!p) return;
  const r = await rpc('sp_get',{guid:guid});
  if(r.status!=='ok'){toast('读取失败','err');return;}
  const copy = Object.assign({}, r.profile, {guid:'', name:(r.profile.name||'')+' 副本', hostname:''});
  editorOpenWith(copy);
}

/* ═══ 详情面板 ═══ */
async function renderDetail(guid){
  // v5.51.0 · P1-6: 非 SSH 节点 (云存储/网络共享) 走独立详情渲染
  const _n = nodeByGuid(guid);
  if(_n){ renderNodeDetail(_n); return; }
  const p = _profiles.find(function(x){return x.guid===guid;});
  const el = $id('ccDetail'); if(!el||!p) return;
  const s = p.session;
  let h = '<b style="font-size:13px;color:var(--text)">'+esc(p.name||p.hostname)+'</b>'
    +(p.is_starred?' <span style="color:#f5c518">★</span>':'')+'<br>'
    +'<span style="color:var(--text3)">'+esc(p.hostname)+':'+esc(p.ssh_port)+' · '+esc(p.ssh_user)+' · '+(p.ssh_auth_type==='key'?'密钥':'密码')+'</span><br>';
  if(p.kind&&p.kind!=='linux') h += '类型: '+esc(p.kind)+'<br>';
  if(p.os_version||p.os_type) h += '系统: '+esc([p.os_type,p.os_version].filter(Boolean).join(' '))+'<br>';
  if(p.arch||p.hostname_real) h += '架构/主机: '+esc([p.arch,p.hostname_real].filter(Boolean).join(' · '))+'<br>';
  // v5.90.2 · 已连接时不再把"健康: 离线"当主状态显示 (下面会显示 🟢 已连接), 避免"绿的却说离线"
  if(p.status&&p.status!=='unknown'&&!(s&&s.state==='connected')) h += '健康: <b style="color:'+healthDot(p)+'">'+(p.status==='online'?'在线':p.status==='offline'?'离线':esc(p.status))+'</b>'+(p.last_latency_ms>0?' · '+p.last_latency_ms+'ms':'')+'<br>';
  else if(s&&s.state==='connected'&&p.status&&p.status!=='unknown') h += '<span style="font-size:10px;color:var(--text3)">档案探测态: '+esc(p.status)+' (以会话为准)</span><br>';
  if(p.last_seen) h += '<span style="font-size:10px;color:var(--text3)">探测于 '+esc(p.last_seen)+'</span><br>';
  if(p.tags) h += '标签: '+esc(p.tags)+'<br>';
  if((p.protocols_mask||[]).length>1) h += '能力: '+esc((p.protocols_mask||[]).join(', '))+'<br>';
  if(s&&s.state==='connected') h += '<br>🟢 <b>已连接</b> · 剩 '+fmtRemain(s.remain_sec)+(s.latency_ms?' · '+s.latency_ms+'ms':'')+'<br>';
  h += '<div style="margin-top:8px;display:flex;gap:5px;flex-wrap:wrap">';
  if(s&&s.state==='connected'){
    h += '<button class="btn btn-sm" onclick="ConnCenter.renew(\''+s.session_id+'\')">+1h 续期</button>';
    h += '<button class="btn btn-sm" style="color:var(--red)" onclick="ConnCenter.close(\''+s.session_id+'\')">⏹ 断开</button>';
  } else {
    h += '<button class="btn btn-sm btn-primary" onclick="ConnCenter.open()">🔗 连接</button>';
  }
  h += '<button class="btn btn-sm" onclick="ConnCenter.probe(\''+guid+'\')">📡 探测</button>';
  h += '<button class="btn btn-sm" onclick="ConnCenter.editorOpen(\''+guid+'\')">✏️ 编辑</button>';
  h += '</div>';
  h += '<div style="margin-top:10px;border-top:1px solid var(--border);padding-top:6px"><div style="font-size:11px;color:var(--text3);margin-bottom:4px">跳转使用</div><div style="display:flex;gap:5px;flex-wrap:wrap">'
    +'<button class="btn btn-sm" onclick="ConnCenter.jumpTo(\'terminal\',\''+guid+'\')">🖥 终端</button>'
    +'<button class="btn btn-sm" onclick="ConnCenter.jumpTo(\'transfer\',\''+guid+'\')">📁 文件</button>'
    +((p.protocols_mask||[]).indexOf('pve_api')>=0?'<button class="btn btn-sm" onclick="ConnCenter.jumpTo(\'pve_console\',\''+guid+'\')">🖥 PVE台</button>':'')
    +((p.protocols_mask||[]).indexOf('rdp')>=0?'<button class="btn btn-sm" onclick="ConnCenter.jumpTo(\'rdp_console\',\''+guid+'\')">🖱 桌面</button>':'')
    +((p.kind==='storage')?'<button class="btn btn-sm" onclick="ConnCenter.jumpTo(\'remotes\',\''+guid+'\')">☁️ 存储管理</button>':'')
    +'</div></div>';
  h += '<div style="margin-top:10px;border-top:1px solid var(--border);padding-top:6px"><div style="font-size:11px;color:var(--text3);margin-bottom:4px">📜 操作记录</div><div id="ccAudit" style="font-size:10.5px;color:var(--text3)">加载中…</div></div>';
  el.innerHTML = h;
  const r = await rpc('audit_query',{profile_guid:guid, limit:15});
  const ael = $id('ccAudit');
  if(ael){
    if(r.status==='ok' && (r.logs||[]).length){
      ael.innerHTML = r.logs.map(function(l){return '<div style="padding:2px 0;border-bottom:1px dashed var(--border)">'
        +'<span style="color:var(--text2)">'+esc(l.action)+'</span> <span style="color:var(--text3)">'+esc(l.username)+'</span> <span style="font-size:9.5px">'+esc(l.created_at)+'</span></div>';}).join('');
    } else ael.textContent = '暂无记录';
  }
}
function select(guid){
  _selGuid = guid; render();
  // v6.16.2 批21 · 恢复右侧连接信息栏: 选中即展开
  const col = document.getElementById('ccDetailCol');
  if (col) col.style.display = '';
  renderDetail(guid);
}
/* v6.16.2 批21 · 收起右栏详情 */
function closeDetail(){
  _selGuid = '';
  const col = document.getElementById('ccDetailCol');
  if (col) col.style.display = 'none';
  render();
}

/* ═══ 跳转 (轻量填参, P3 由 fillPanel 全面取代) ═══ */
function jumpTo(tab, guid){
  const p = _profiles.find(function(x){return x.guid===guid;}); if(!p) return;
  if(g.switchTab) g.switchTab(tab);
  setTimeout(function(){
    const M = {terminal:['termSrvHost','termSrvPort','termSrvUser'], transfer:['srvHost','srvPort','srvUser'],
               pve_console:['pveCfgHost','pveCfgPort','pveCfgUser'],
               rdp_console:['rdHost','rdPort','rdUser'],
               remotes:null};   // v5.34.5 · storage 档案 → 纯跳转远端存储页
    const ids = M[tab]||[];
    if(ids[0]&&$id(ids[0])) $id(ids[0]).value = p.hostname||'';
    if(ids[1]&&$id(ids[1])) $id(ids[1]).value = p.ssh_port||22;
    if(ids[2]&&$id(ids[2])) $id(ids[2]).value = p.ssh_user||'root';
    toast('已切换到页面并填入 '+ (p.name||p.hostname) +' 基础参数');
  }, 250);
}

/* ═══ 连接操作 ═══ */
async function open(){
  if(!_selGuid){ say('请先选择一台服务器'); return; }
  /* v6.13.0 · 批13: 选中存储池节点时, 双击=打开「存储池」页(池不是 SSH 会话) */
  const _on = nodeByGuid(_selGuid);
  if(_on && _on.kind === 'cloudpool'){
    try{ switchGroup('storage_g'); switchTab('cloudpool'); }catch(e){}
    return;
  }
  const ttlSel = $id('ccTtl');
  let ttl = ttlSel ? ttlSel.value : '3600';
  if(ttl==='__custom'){
    const v = await rpPrompt({ title:'自定义连接时长（小时，≤168）', defaultName:'2' }); if(!v) return;
    ttl = String(Math.round(parseFloat(v)*3600));
    if(isNaN(parseInt(ttl,10))||parseInt(ttl,10)<=0){ say('无效时长'); return; }
  }
  const p = _profiles.find(function(x){return x.guid===_selGuid;}); if(!p) return;
  say('⏳ 连接中…');
  const r = await rpc('conn_open',{guid:p.guid, ttl_sec:parseInt(ttl,10)});
  say((r.status==='ok'?'':'✗ ')+(r.msg||''));
  // v5.84.0 · 点「连接」要有明确反馈(此前只写面板内 ccMsg, 用户看不到 → 以为按钮没反应, 要手动刷新才看到"健康: 在线")
  toast((r.status==='ok' ? '✓ ' : '✗ ') + (r.msg || (r.status==='ok' ? '已连接, 可点「刷新」查看健康状态' : '连接失败')),
        r.status==='ok' ? 'success' : 'err', 3800);
  if (r.status === 'ok'){
    // v1.0.0 · 连接成功后立刻把会话状态发布出去(卡片/左树圆点/胶囊立即更新, 用户报"卡片没有成功提示")
    try { window.SP && SP.refreshSessions && SP.refreshSessions(); } catch(_){}
  }
  await refresh();
}
async function close(sid){
  const r = await rpc('conn_close',{session_id:sid});
  toast(r.msg||'已停止', r.status==='ok'?'success':'err',2400);
  await refresh();
}
async function renew(sid){
  const r = await rpc('conn_renew',{session_id:sid, ttl_sec:3600});
  toast(r.msg||'已续期','success',2200); refresh();
}
async function probe(guid){
  say('📡 探测中…');
  const r = await rpc('sp_probe',{guid:guid});
  const pr = r.probe||{};
  const tcp = pr.tcp||{};
  const tcpTxt = Object.keys(tcp).map(function(k){return String(k).toUpperCase()+(tcp[k].ok?'✓':'✗');}).join(' ');
  say((r.status==='ok'&&pr.ok?'':'✗ ')+(r.msg||'')+(tcpTxt?(' | 端口: '+tcpTxt):''));
  await refresh();
}
async function del(guid){
  // v6.16.15 · 节点(共享/云/池)分流: 此前对节点直接 return → 右键"删除"毫无反应(用户实测)
  if (nodeByGuid(guid)) return nodeDelete(guid);
  const p = _profiles.find(function(x){return x.guid===guid;}); if(!p) return;
  if(!(await rpConfirm({ title:'删除服务器档案', danger:true, okText:'删除', body:'删除服务器档案「'+(p.name||p.hostname)+'」?' }))) return;
  const r = await rpc('sp_del',{guid:guid});
  toast(r.msg||'', r.status==='ok'?'success':'err');
  if(r.status==='ok'){ _selGuid=''; }
  await refresh();
}
async function syncFromConfigs(){
  if(!(await rpConfirm({ title:'迁入服务器档案', okText:'迁入', body:'从左侧服务器列表(configs)把未建档的主机迁入档案? 已有同主机+端口的跳过' }))) return;
  const r = await rpc('sp_sync',{});
  toast(r.msg||'', r.status==='ok'?'success':'err');
  refresh();
}
function say(m){ const el=$id('ccMsg'); if(el) el.textContent=m||''; }

/* ══════════════════ 7-Tab 编辑弹窗 ══════════════════ */
function F(k,label,type,opts){ return {k:k,label:label,type:type||'text',opts:opts}; }
const TABS = [
  ['基本', [
    F('name','名称'), F('hostname','主机/IP'), F('ssh_port','SSH 端口','number'),
    F('kind','类型','select',[['linux','Linux'],['windows','Windows'],['pve','PVE'],['nas','NAS'],['storage','对象存储']]),
    F('group_id','分组','group'), F('tags','标签(逗号分隔)'), F('description','备注'), F('is_starred','⭐ 星标','check'),
  ]],
  ['SSH', [
    F('ssh_user','用户名'), F('ssh_auth_type','认证方式','select',[['pass','密码'],['key','密钥']]),
    F('ssh_auth_value','密码 / 密钥路径','secret'), F('ssh_passphrase','密钥口令','secret'),
    F('ssh_timeout','超时(秒)','number'), F('ssh_keepalive','KeepAlive(秒)','number'),
    F('ssh_proxy_jump','跳板机','profile'), F('strict_host_key','主机密钥检查','select',[['1','严格'],['0','accept-new']]),
  ]],
  ['远程桌面', [
    F('rdp','RDP 远程桌面','block',[F('enabled','启用 RDP','check'),F('port','端口','number'),F('rdp_user','Windows 用户'),F('rdp_pass','Windows 密码','secret'),F('domain','域'),F('security','安全','select',[['tls','TLS'],['nla','NLA'],['rdp','RDP'],['any','自动']]),F('width','宽','number'),F('height','高','number'),F('color_depth','色深','select',[['16','16位'],['24','24位'],['32','32位']]),F('enable_audio','音频','check'),F('enable_clipboard','剪贴板','check'),F('enable_drive','目录映射','check'),F('drive_path','映射路径'),F('ignore_cert','忽略证书','check'),F('backend','后端','select',[['freerdp2','freerdp2(推荐)'],['freerdp3','freerdp3']])]),
    F('vnc','VNC','block',[F('enabled','启用 VNC','check'),F('port','端口','number'),F('password','VNC 密码','secret'),F('encoding','编码','select',[['zrle','ZRLE'],['tight','Tight'],['hextile','Hextile']])]),
  ]],
  ['PVE/PBS', [
    F('pve_api','PVE API','block',[F('enabled','启用','check'),F('api_url','API URL(空=自动)'),F('api_user','API 用户(root@pam)'),F('auth_type','认证','select',[['password','密码'],['token','Token']]),F('api_pass','API 密码','secret'),F('token_id','Token ID'),F('token_value','Token 值','secret'),F('verify_ssl','校验 SSL','check'),F('node_name','节点名(空=自动)')]),
    F('pve_ssh','PVE SSH 通道','block',[F('enabled','启用','check'),F('backup_dst','备份目标路径'),F('tmp_dir','临时目录'),F('local_dir','本地下载目录')]),
    F('pbs','PBS 备份存储','block',[F('enabled','启用','check'),F('server','PBS 地址'),F('port','端口','number'),F('datastore','Datastore'),F('namespace','Namespace'),F('api_user','API 用户'),F('api_pass','API 密码','secret'),F('fingerprint','指纹'),F('relay_via_pve','经 PVE 中转','check')]),
  ]],
  ['存储卷', [
    F('lvm','LVM','block',[F('enabled','启用','check'),F('local_dir','本地导出目录')]),
    F('zfs','ZFS','block',[F('enabled','启用','check'),F('local_dir','本地导出目录')]),
    F('rbd','Ceph RBD','block',[F('enabled','启用','check'),F('local_dir','本地导出目录'),F('pool','Pool')]),
  ]],
  ['备份/DB', [
    F('backup','一键备份','block',[F('enabled','启用','check'),F('local_dst','备份目标'),F('extra_paths','额外路径(逗号)')]),
    F('platform','平台备份','block',[F('enabled','启用','check'),F('key_path','密钥路径'),F('key_passphrase','密钥口令','secret'),F('extra_paths','额外路径')]),
    F('database','数据库','block',[F('enabled','启用','check'),F('db_type','类型','select',[['mysql','MySQL'],['postgres','PostgreSQL'],['mongodb','MongoDB'],['redis','Redis']]),F('db_host','地址(127.0.0.1=SSH本机)'),F('db_port','端口','number'),F('db_user','用户'),F('db_pass','密码','secret'),F('db_name','库名')]),
  ]],
  ['容器/NAS/高级', [
    F('docker','Docker','block',[F('enabled','启用','check'),F('socket','Socket 路径'),F('use_tls','TCP+TLS','check'),F('tcp_port','TCP 端口','number')]),
    F('truenas','TrueNAS','block',[F('enabled','启用','check'),F('api_url','API URL(空=自动)'),F('api_key','API Key','secret'),F('api_user','用户'),F('api_pass','密码','secret')]),
    F('remote_storage','对象存储','block',[F('enabled','启用','check'),F('provider','类型','select',[['s3','S3'],['minio','MinIO'],['oss','阿里OSS'],['cos','腾讯COS'],['b2','B2'],['webdav','WebDAV'],['seafile','Seafile']]),F('endpoint','Endpoint'),F('region','Region'),F('bucket','Bucket'),F('prefix','前缀'),F('access_key','Access Key','secret'),F('secret_key','Secret Key','secret')]),
    F('sort_order','排序权重','number'),
  ]],
];
let _edGuid = '';
let _edProfile = {};   // v5.90.2 · 编辑器当前档案(renderField 判定密钥/密码分栏用)
function fieldId(path){ return 'ed_'+path.replace(/\./g,'__'); }
function renderField(path, f, val){
  const id = fieldId(path);
  const lb = '<label style="font-size:11px;color:var(--text3);display:block;margin-bottom:2px">'+esc(f.label)+'</label>';
  const w = 'width:100%;height:26px;font-size:12px;box-sizing:border-box';
  if(f.type==='check'){
    return '<label style="display:inline-flex;gap:5px;align-items:center;font-size:11.5px;color:var(--text2);padding:3px 0"><input type="checkbox" id="'+id+'"'+(val?' checked':'')+'> '+esc(f.label)+'</label>';
  }
  if(f.type==='select'){
    return '<div>'+lb+'<select class="input" id="'+id+'" style="'+w+'">'
      +f.opts.map(function(o){return '<option value="'+esc(o[0])+'"'+(String(val)===String(o[0])?' selected':'')+'>'+esc(o[1])+'</option>';}).join('')
      +'</select></div>';
  }
  if(f.type==='group'){
    return '<div>'+lb+'<select class="input" id="'+id+'" style="'+w+'">'+groupOptions(val||'')+'</select></div>';
  }
  if(f.type==='profile'){
    const opts = _profiles.filter(function(p){return p.guid!==_edGuid;}).map(function(p){return '<option value="'+p.guid+'"'+(val===p.guid?' selected':'')+'>'+esc(p.name||p.hostname)+'</option>';}).join('');
    return '<div>'+lb+'<select class="input" id="'+id+'" style="'+w+'"><option value="">(不使用)</option>'+opts+'</select></div>';
  }
  if(f.type==='secret'){
    const has = !!val;
    // v5.90.2 · SSH 凭据分栏(用户要求): 密码=掩码框; 密钥=明文路径框 + 📁 选择器
    //   (本机/df/服务器/云端/粘贴), 不再共用一个 *** 输入区
    if(f.k==='ssh_auth_value'){
      const isKey = String(_edProfile.ssh_auth_type||'pass')==='key';
      return '<div>'+lb
        +'<div style="display:flex;gap:4px">'
        +'<input type="'+(isKey?'text':'password')+'" class="input" id="'+id+'" style="'+w+';flex:1;font-family:'+(isKey?'monospace':'inherit')+'" '
        +(isKey
            ? 'value="'+esc(val==null?'':val)+'" placeholder="密钥路径(本机/缓存) — 或点 📁 从服务器/云端选, 也可直接粘贴密钥内容" autocomplete="off"'
            : 'placeholder="'+(has?'●●●●●● 已保存, 留空保持不变':'未保存')+'" autocomplete="new-password"')
        +'>'
        +'<button class="btn btn-sm" id="ed_keyPickBtn" style="display:'+(isKey?'':'none')+'" title="选择密钥文件: 本机 / 已存服务器 / 远端存储 / 粘贴内容">📁</button>'
        +'</div></div>';
    }
    return '<div>'+lb+'<input type="password" class="input" id="'+id+'" style="'+w+'" placeholder="'+(has?'●●●●●● 已保存, 留空保持不变':'未保存')+'" autocomplete="new-password"></div>';
  }
  return '<div>'+lb+'<input class="input" id="'+id+'" style="'+w+'" value="'+esc(val==null?'':val)+'"></div>';
}
async function editorOpen(guid){
  _edGuid = guid||'';
  let profile = {kind:'linux', ssh_auth_type:'pass', protocols:{}};
  if(guid){
    const r = await rpc('sp_get',{guid:guid});
    if(r.status!=='ok'){ toast('读取档案失败','err'); return; }
    profile = r.profile;
  }
  editorOpenWith(profile);
}
function editorOpenWith(profile){
  _edGuid = profile.guid||'';
  _edProfile = profile;   // v5.90.2 · 供 renderField 分栏判定
  const proto = profile.protocols||{};
  /* v6.16.2 批23 · 编辑器字段按档位隐藏: 高版本能力块(功能闸未放行)不出现在表单里
     (用户明令: 编辑服务器里还有好几个高版本功能没隐藏) —— 一次性计算可见页签, 头/体同步 */
  const BLOCK_FEAT = { pbs:'pbs', lvm:'lvm', zfs:'zfs', rbd:'rbd',
                       database:'dbbackup', truenas:'cloud', remote_storage:'cloud' };
  const _featOn = function(k){
    try { return (typeof window.licenseFeatEnabled === 'function') ? window.licenseFeatEnabled(k) : true; }
    catch(e){ return true; }
  };
  const _visTabs = TABS.map(function(t){
    return [t[0], t[1].filter(function(f){
      return !(f.type === 'block' && BLOCK_FEAT[f.k] && !_featOn(BLOCK_FEAT[f.k]));
    })];
  }).filter(function(t){ return t[1].length; });
  let tabsHtml = _visTabs.map(function(t,i){
    return '<span class="cc-edtab" data-tab="'+i+'" style="padding:6px 12px;font-size:12px;cursor:pointer;border-bottom:2px solid '+(i===0?'var(--blue)':'transparent')+';color:'+(i===0?'var(--blue)':'var(--text3)')+'">'+esc(t[0])+'</span>';
  }).join('');
  let bodies = _visTabs.map(function(t,i){
    let out = [];
    t[1].forEach(function(f){
      if(f.type==='block'){
        const blkCfg = proto[f.k]||{};
        out.push('<div style="border:1px solid var(--border);border-radius:7px;padding:8px 10px;margin-bottom:8px;grid-column:1/-1"><b style="font-size:11.5px;color:var(--text2)">▣ '+esc(f.label)+'</b><div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:7px 12px;margin-top:6px">');
        f.opts.forEach(function(sf){
          out.push(renderField('proto.'+f.k+'.'+sf.k, sf, blkCfg[sf.k]));
        });
        out.push('</div></div>');
      } else {
        out.push(renderField(f.k, f, profile[f.k]));
      }
    });
    return '<div data-tabbody="'+i+'" style="display:'+(i===0?'grid':'none')+';grid-template-columns:1fr 1fr;gap:8px 14px;align-content:start" class="cc-edbody">'+out.join('')+'</div>';
  }).join('');
  modal((_edGuid?'编辑':'新建')+'服务器档案',
    '<div style="display:flex;gap:2px;border-bottom:1px solid var(--border);margin:-4px -6px 10px;flex-wrap:wrap">'+tabsHtml+'</div>'
    +'<div style="font-size:10.5px;color:var(--text3);margin-bottom:8px">💡 只填需要的部分; 密码类留空 = 保持原值; 各能力块独立启用</div>'
    +bodies,
    [ ['取消',''],
      (_edGuid?['🗑 删除','',async function(){ closeModal(); del(_edGuid); }]:null),
      ['测试 SSH','primary', async function(){ await editorTestSsh(); }],
      ['💾 保存','primary', async function(){ await editorSave(); }]
    ].filter(Boolean), true);
  const root = _modalStack[_modalStack.length-1];
  // v5.90.2 · 认证方式 ↔ 凭据框联动: 密码=掩码; 密钥=明文路径 + 📁 选择器 + 显示口令栏
  const _syncAuthMode = function(){
    const sel = $id('ed_ssh_auth_type');
    const inp = $id('ed_ssh_auth_value');
    const btn = $id('ed_keyPickBtn');
    if (!sel || !inp) return;
    const isKey = String(sel.value||'pass')==='key';
    inp.type = isKey ? 'text' : 'password';
    inp.style.fontFamily = isKey ? 'monospace' : 'inherit';
    inp.placeholder = isKey
      ? '密钥路径(本机/缓存) — 或点 📁 从服务器/云端选, 也可直接粘贴密钥内容'
      : (inp.placeholder = '未保存');
    if (btn){
      btn.style.display = isKey ? '' : 'none';
      btn.onclick = function(){
        if (window.KeyPicker){
          KeyPicker.open(function(path){ inp.value = path; try{ inp.dispatchEvent(new Event('input',{bubbles:true})); }catch(_){} });
        } else toast('密钥选择器未加载(请刷新页面)', 'warn');
      };
    }
    const ppInp = $id('ed_ssh_passphrase');
    if (ppInp && ppInp.closest('div')) ppInp.closest('div').style.display = isKey ? '' : 'none';
  };
  const _selEl = $id('ed_ssh_auth_type');
  if (_selEl) _selEl.onchange = _syncAuthMode;
  _syncAuthMode();
  root.querySelectorAll('.cc-edtab').forEach(function(tb){
    tb.onclick = function(){
      const i = tb.getAttribute('data-tab');
      root.querySelectorAll('.cc-edtab').forEach(function(x){x.style.borderBottomColor='transparent';x.style.color='var(--text3)';});
      tb.style.borderBottomColor='var(--blue)'; tb.style.color='var(--blue)';
      root.querySelectorAll('.cc-edbody').forEach(function(b){ b.style.display = b.getAttribute('data-tabbody')===i ? 'grid' : 'none'; });
    };
  });
}
function editorCollect(){
  const payload = {protocols:{}};
  TABS.forEach(function(t){
    t[1].forEach(function(f){
      if(f.type==='block'){
        const blk = {};
        let any=false;
        f.opts.forEach(function(sf){
          const el = $id(fieldId('proto.'+f.k+'.'+sf.k));
          if(!el) return;
          any=true;
          let v;
          if(sf.type==='check') v = !!el.checked;
          else if(sf.type==='number'){ v = el.value===''?'':parseInt(el.value,10); if(isNaN(v))v=''; }
          else v = el.value;
          blk[sf.k] = v;
        });
        if(any) payload.protocols[f.k] = blk;
      } else {
        const el = $id(fieldId(f.k));
        if(!el) return;
        let v;
        if(f.type==='check') v = !!el.checked;
        else if(f.type==='number'){ v = el.value===''?'':parseInt(el.value,10); if(isNaN(v))v=''; }
        else v = el.value;
        payload[f.k] = v;
      }
    });
  });
  ['ssh_auth_value','ssh_passphrase'].forEach(function(k){
    if(payload[k]==='') delete payload[k];
  });
  ['rdp_pass','password','api_pass','token_value','api_key','secret_key','access_key','db_pass','key_passphrase'].forEach(function(sf){
    Object.keys(payload.protocols).forEach(function(blk){
      if(payload.protocols[blk][sf]==='') delete payload.protocols[blk][sf];
    });
  });
  if(_edGuid) payload.guid = _edGuid;
  return payload;
}
async function editorSave(){
  const payload = editorCollect();
  const _isSto = payload.kind === 'storage';
  if(!payload.hostname && !_isSto){ toast('请填写主机/IP','warn'); return; }
  if(_isSto && !((payload.protocols||{}).remote_storage || {}).endpoint){ toast('请填写存储 Endpoint','warn'); return; }
  const r = await rpc('sp_save',{profile:payload});
  if(r.status==='ok'){
    toast(r.msg||'已保存','success');
    _edGuid = r.guid;
    // v5.58.0 FIX: 连接中心保存走 rpc 直连(不经 SP.save), 故 SP 的 30s 缓存需**主动**失效,
    //   否则其它面板(三栏/DM/左侧列表)要等事件或缓存过期才看到新档案。
    try{ if(g.SP && typeof g.SP.invalidateCache === 'function') g.SP.invalidateCache(); }catch(e){}
    closeModal();
    await refresh();                       // 立即重载, 新建的档案当场出现在列表里
  } else if(r.code==='version_conflict'){
    toast('⚠ '+r.msg,'warn',5000);
  } else {
    toast(r.msg||'保存失败','err');
  }
}
async function editorTestSsh(){
  const payload = editorCollect();
  if(!payload.hostname){ toast('请先填主机','warn'); return; }
  const r = await rpc('sp_save',{profile:payload});
  if(r.status!=='ok'){ toast(r.msg||'保存失败, 无法测试','err'); return; }
  _edGuid = r.guid;
  say('📡 测试 SSH 中…');
  const r2 = await rpc('sp_probe',{guid:r.guid});
  const pr = r2.probe||{};
  toast((pr.ok?'✓ SSH 连通 '+pr.latency_ms+'ms · '+((pr.os_version||'')+' '+(pr.arch||'')).trim():'✗ SSH 失败: '+(pr.err||r2.msg)), pr.ok?'success':'err', 4200);
  refresh();
}

/* ═══ 导入/导出 ═══ */
function newPickerOpen(){
  modal('新建', '<div style="display:flex;flex-direction:column;gap:8px">'
    +'<button class="btn" style="text-align:left;padding:10px 12px" onclick="ConnCenter.closeModal();ConnCenter.editorOpen()">🖥 <b>SSH 服务器</b><br><span style="font-size:11px;color:var(--text3)">Linux/Windows/PVE 主机 (终端/文件/桌面/备份)</span></button>'
    +'<button class="btn" style="text-align:left;padding:10px 12px" onclick="ConnCenter.closeModal();ConnCenter.editorStorageOpen()">☁ <b>存储档案</b><br><span style="font-size:11px;color:var(--text3)">S3/OSS/Seafile/WebDAV — 三栏云浏览 · 备份投递 · 远端存储页 同步可用</span></button></div>',
    [['取消','']]);
}
function editorStorageOpen(){
  _edGuid = '';
  editorOpenWith({kind:'storage', icon:'cloud', ssh_port:0, ssh_user:'', ssh_auth_type:'pass',
                  protocols:{remote_storage:{enabled:true, provider:'s3'}}});
}
function exportOpen(){
  modal('📤 导出服务器档案',
    '<div style="font-size:12px;display:flex;flex-direction:column;gap:8px">'
    +'<label style="display:flex;gap:6px;align-items:center;cursor:pointer"><input type="checkbox" id="exCreds" onchange="document.getElementById(\'exWarn\').style.display=this.checked?\'block\':\'none\'"> 包含凭据 (仅管理员, 明文写入文件)</label>'
    +'<div id="exWarn" style="display:none;color:var(--red);font-size:11px;background:var(--bg3);padding:6px 8px;border-radius:6px">⚠ 导出文件将包含所有密码明文! 仅用于跨机迁移, 用完即删。</div>'
    +'</div>',
    [['取消',''],['导出','primary',async function(){
      const r = await rpc('sp_export',{include_creds:!!($id('exCreds')||{}).checked});
      if(r.status!=='ok'){ toast(r.msg||'导出失败','err'); return; }
      const blob = new Blob([r.data], {type:'application/json'});
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'fonriv_profiles_'+new Date().toISOString().slice(0,10)+(!!($id('exCreds')||{}).checked?'_含凭据':'')+'.json';
      a.click(); URL.revokeObjectURL(a.href);
      toast('✓ 已导出 '+r.count+' 条档案','success');
      closeModal();
    }]]);
}
function importOpen(){
  modal('📥 导入服务器档案',
    '<div style="font-size:12px;display:flex;flex-direction:column;gap:8px">'
    +'<div style="font-size:11px;color:var(--text3)">支持: ① 本系统导出的 JSON ② ~/.ssh/config 文本 (Host/HostName/Port/User/IdentityFile)</div>'
    +'<input type="file" id="imFile" accept=".json,.txt" style="font-size:11px">'
    +'<div style="font-size:11px;color:var(--text3)">或直接粘贴:</div>'
    +'<textarea id="imText" class="input" style="width:100%;height:120px;font-size:11px;font-family:monospace" placeholder=\'{"fonriv_profiles":1,"profiles":[...]}  或 ssh config 文本\'></textarea>'
    +'<label style="display:flex;gap:6px;align-items:center;font-size:11.5px;cursor:pointer"><input type="checkbox" id="imOverwrite"> 覆盖同主机+端口的既有档案</label>'
    +'</div>',
    [['取消',''],['导入','primary',async function(){
      let text = (($id('imText').value)||'').trim();
      const fl = ($id('imFile').files||[])[0];
      if(fl){ text = (await fl.text()).trim(); }
      if(!text){ toast('请选择文件或粘贴内容','warn'); return; }
      const fmt = (text.charAt(0)==='{'||text.charAt(0)==='[') ? 'json' : 'ssh_config';
      const r = await rpc('sp_import',{format:fmt, data:text, overwrite:!!($id('imOverwrite')||{}).checked});
      toast((r.status==='ok'?'':'✗ ')+(r.msg||'')+(r.errors&&r.errors.length?(' | '+r.errors[0]):''), r.status==='ok'?'success':'err', 4200);
      if(r.status==='ok'){ closeModal(); refresh(); }
    }]]);
}

/* ═══ EventBus 实时同步 ═══ */
function panelActive(){ const p=$id('panel-conn_center'); return !!(p&&p.classList.contains('active')); }
function hookEvents(){
  if(g._ccEventsHooked || !g.EventBus || typeof g.EventBus.on!=='function') return;
  g._ccEventsHooked = true;
  g.EventBus.on('profile.changed', function(ev){
    const actor=(ev&&ev.actor)||'', self=(g.currentUser&&g.currentUser.username)||'';
    if(panelActive()){
      if(actor && self && actor!==self && ev && ev.name && ev.action!=='bulk'){
        toast('📡 服务器配置已更新: '+ev.name, 'info', 3200);
      }
      refresh();
    }
  });
  // v5.51.0 · P1-6: hub.node.changed = 事件契约规范主题 (旧 profile.changed 双发而来)
  // v5.61.0 E5 · hub.node.changed 携带 guid → 只刷新该节点(定向); 其余主题整表刷新
  g.EventBus.on('hub.node.changed', function(ev){
    if(!panelActive()) return;
    refreshNode((ev && (ev.guid || ev.remote_uuid || ev.share_id)) || '');
  });
  ['profile.deleted','conn.changed','group.changed','hub.cloud.changed','hub.share.changed'].forEach(function(t){
    g.EventBus.on(t, function(){ if(panelActive()) refresh(); });
  });
  // v1.0.0 · 全局会话状态变化(5s 轮询/登录后拉取) → 连接状态与绿点自动跟随(用户要求: 不手动刷新也实时)
  try { window.addEventListener('rp-sessions-changed', function(){ if(panelActive()) refresh(); }); } catch(e){}
}

/* ═══ 启动 ═══ */
let _autoTimer=null;
function autoRefresh(){ if(_autoTimer)clearInterval(_autoTimer); _autoTimer=setInterval(function(){ if(panelActive()) refresh(); },10000); }

/* ══════════════════════════════════════════════════════════════════════════════
   v6.3.40 · 批 A(用户 2026-10-03 整改)
     A1 入口恢复: 新建/迁移 在**所有视图**可见 + 右键菜单(复用全局 .fonr-menu* 样式, 与多云文件管理同款观感)
     A3 左栏折叠/展开(记忆) —— 对齐多云文件管理左面板的折叠手感
     A4 一键连接: 按当前左栏选择/筛选**自适应**, 远程桌面(rdp/vnc)不连
   ══════════════════════════════════════════════════════════════════════════════ */

/* ── A1 · 右键菜单(轻量自实现, 直接复用全局 .fonr-menu* 样式类) ── */
let _ctxEl = null, _ctxEsc = null;
function ctxClose(){
  if(_ctxEsc){ try{ document.removeEventListener('keydown', _ctxEsc, true); }catch(e){} _ctxEsc = null; }
  if(_ctxEl && _ctxEl.parentNode) _ctxEl.parentNode.removeChild(_ctxEl);
  _ctxEl = null;
}
function ctxMenu(ev, items){
  /* v6.3.43 · 批 C: 菜单实现抽到公共件 window.rpCtxMenu(侧栏/连接中心共用一份), 这里只做委托 */
  if (window.rpCtxMenu) return window.rpCtxMenu(ev, items);
  ctxClose();
  items = (items || []).filter(Boolean);
  if(!items.length) return;
  let h = '';
  items.forEach(function(it, i){
    if(it.sep){ h += '<div class="fonr-menu-sep"></div>'; return; }
    h += '<div class="fonr-menu-i'+(it.danger?' fonr-menu-danger':'')+'" data-i="'+i+'">'
      + '<span class="fonr-menu-ic">'+(it.icon||'')+'</span><span>'+esc(it.t)+'</span>'
      + (it.hint?'<span class="fonr-menu-hint">'+esc(it.hint)+'</span>':'')+'</div>';
  });
  _ctxEl = document.createElement('div');
  _ctxEl.className = 'fonr-menu';
  _ctxEl.innerHTML = h;
  // 全屏时浏览器只显示全屏元素子树 → 菜单要挂进去(与多云文件管理同一处理)
  (document.fullscreenElement || document.body).appendChild(_ctxEl);
  const r = _ctxEl.getBoundingClientRect();
  let x = ev.clientX, y = ev.clientY;
  if(x + r.width > window.innerWidth - 8) x = Math.max(8, window.innerWidth - r.width - 8);
  if(y + r.height > window.innerHeight - 8) y = Math.max(8, window.innerHeight - r.height - 8);
  _ctxEl.style.left = x+'px'; _ctxEl.style.top = y+'px';
  _ctxEl.querySelectorAll('.fonr-menu-i').forEach(function(el){
    el.onclick = function(){
      const it = items[parseInt(el.dataset.i, 10)];
      ctxClose();
      try { if(it && it.fn) it.fn(); } catch(e){ toast('操作失败: ' + e, 'err'); }
    };
  });
  _ctxEsc = function(e){ if(e.key === 'Escape') ctxClose(); };
  document.addEventListener('keydown', _ctxEsc, true);
  ev.preventDefault(); ev.stopPropagation();
}
/* 左树(空白处 / 分组节点)右键 */
function treeMenu(ev){
  const t = ev.target || {};
  const gid = (t.getAttribute && t.getAttribute('data-gid')) || '';
  const realGroup = gid && gid.indexOf('__') !== 0;
  ctxMenu(ev, [
    { icon:'➕', t:'新建服务器', fn:function(){ editorOpen(); } },
    { icon:'🔄', t:'从旧配置迁移', hint:'其它页面里已保存的服务器', fn:function(){ syncFromConfigs(); } },
    { icon:'⚡', t:'一键连接', hint:'连当前列表(远程桌面除外)', fn:oneKeyConnect },
    { sep:true },
    { icon:'🗂', t:'新建分组', fn:function(){ groupAdd(); } },
    realGroup ? { icon:'✏️', t:'编辑该分组', fn:function(){ groupEdit(gid); } } : null,
    realGroup ? { icon:'🗑', t:'删除该分组', danger:true, fn:function(){ groupDel(gid); } } : null,
    { icon:'🔄', t:'刷新', fn:function(){ refresh(); } },
  ]);
}
/* 右侧列表右键(命中卡片/行 → 该服务器的菜单; 空白处 → 新建/迁移/一键连接) */
function listMenu(ev){
  const holder = (ev.target && ev.target.closest) ? ev.target.closest('[data-guid]') : null;
  const guid = holder ? holder.getAttribute('data-guid') : '';
  if(guid){
    const p = _profiles.find(function(x){ return x.guid === guid; });
    const isNode = !p;                       // 云存储/网络共享/存储池节点
    /* v6.13.0 · 批13: 存储池节点 —— 专属菜单(打开存储池页 / 刷新状态), 不给连接/卸载 */
    const _pn = nodeByGuid(guid);
    if (_pn && _pn.kind === 'cloudpool'){
      ctxMenu(ev, [
        { icon:'🧩', t:'打开存储池页', fn:function(){ try{ switchGroup('storage_g'); switchTab('cloudpool'); }catch(e){} } },
        { icon:'🔌', t:'刷新池状态', hint:'按成员健康汇总', fn:function(){ nodeProbe(guid); } },
      ]);
      return;
    }
    ctxMenu(ev, [
      p && p.session
        ? { icon:'⏹', t:'断开', fn:function(){ close(p.session.session_id); } }
        : { icon:'🔌', t:'连接', hint:isNode?'挂载/探测':((($id('ccTtl')||{}).value)||''), fn:function(){ select(guid); if(p) open(); else nodeMount(guid); } },
      { icon:'📡', t:'探测连通', fn:function(){ isNode ? nodeProbe(guid) : probe(guid); } },
      { sep:true },
      { icon:'✏️', t:'编辑', fn:function(){ isNode ? refEdit(guid) : editorOpen(guid); } },
      p ? { icon:(p.is_starred ? '☆' : '★'), t:(p.is_starred ? '取消星标' : '星标'), fn:function(){ toggleStar(guid); } } : null,
      p ? { icon:'📁', t:'移动到分组', fn:function(){ moveMenu(guid); } } : null,
      p ? { icon:'📋', t:'复制', fn:function(){ duplicate(guid); } } : null,
      { sep:true },
      { icon:'🗑', t:'删除', danger:true, fn:function(){ del(guid); } },
    ]);
    return;
  }
  ctxMenu(ev, [
    { icon:'➕', t:'新建服务器', fn:function(){ editorOpen(); } },
    { icon:'🔄', t:'从旧配置迁移', fn:function(){ syncFromConfigs(); } },
    { icon:'⚡', t:'一键连接', hint:'连当前列表(远程桌面除外)', fn:oneKeyConnect },
    { sep:true },
    { icon:'▦', t:(_view === 'card' ? '切换为列表视图' : '切换为卡片视图'), fn:toggleView },
    { icon:'🔄', t:'刷新', fn:function(){ refresh(); } },
  ]);
}

/* ── A3 · 左栏折叠/展开(记忆; 手感对齐多云文件管理左面板) ── */
function applyFoldSide(){
  let f = false;
  try { f = localStorage.getItem('cc_side_fold') === '1'; } catch(e){}
  let side = null;
  try { side = document.querySelector('#panel-conn_center .conn-side'); } catch(e){}
  const btn = $id('ccSideFold');
  if(side && side.classList) side.classList.toggle('folded', f);
  if(btn){ btn.textContent = f ? '›' : '‹'; btn.title = f ? '展开服务器列表' : '折叠服务器列表 (右侧最大化)'; }
  /* v6.5.0 · 批6: 中缝 grip 上的折叠钮同步(用户反馈"中间的折叠/展开按钮不见了") */
  const gb = $id('ccFoldOnGrip');
  if(gb){ gb.textContent = f ? '›' : '‹'; gb.title = f ? '展开服务器列表' : '折叠服务器列表 (右侧最大化)'; }
  const grip = $id('ccGrip');
  if(grip){ grip.style.cursor = f ? 'default' : 'col-resize'; }
  _applySideWidth(f);
  return f;
}
function _applySideWidth(folded){
  const side = document.querySelector('#panel-conn_center .conn-side');
  if(!side) return;
  if(folded){ side.style.flexBasis = ''; side.style.width = ''; return; }
  let w = 0;
  try { w = parseInt(localStorage.getItem('cc_side_w') || '0', 10) || 0; } catch(e){}
  if(w >= 180 && w <= 480) side.style.flexBasis = w + 'px';
}
function foldSide(){
  let f = false;
  try { f = localStorage.getItem('cc_side_fold') === '1'; } catch(e){}
  try { localStorage.setItem('cc_side_fold', f ? '0' : '1'); } catch(e){}
  applyFoldSide();
}
/* v6.5.0 · 批6: 中缝 grip —— 折叠钮点击 + 拖动调宽(记忆 cc_side_w; 与多云 #fonrFoldL 同款手感) */
function _wireCcGrip(){
  const grip = $id('ccGrip');
  const btn = $id('ccFoldOnGrip');
  if(!grip) return;
  if(btn){
    btn.addEventListener('mousedown', function(e){ e.stopPropagation(); });
    btn.onclick = function(ev){ ev.stopPropagation(); foldSide(); };
  }
  grip.addEventListener('mousedown', function(e){
    if(btn && (e.target === btn)) return;
    const side = document.querySelector('#panel-conn_center .conn-side');
    if(!side || side.classList.contains('folded')) return;
    const startX = e.clientX;
    const startW = side.getBoundingClientRect().width;
    grip.classList.add('on');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    const mm = function(e2){
      let w = Math.round(startW + (e2.clientX - startX));
      w = Math.max(180, Math.min(480, w));
      side.style.flexBasis = w + 'px';
    };
    const mu = function(){
      document.removeEventListener('mousemove', mm);
      document.removeEventListener('mouseup', mu);
      grip.classList.remove('on');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      try { localStorage.setItem('cc_side_w', String(Math.round(side.getBoundingClientRect().width))); } catch(err){}
    };
    document.addEventListener('mousemove', mm);
    document.addEventListener('mouseup', mu);
  });
}

/* ── A4 · 一键连接(自适应) ── */
function oneKeyTargets(){
  /* 用户要求(2026-10-03): 一键连接要**自动适配当前界面** ——
       在「全部」界面 → 连所有服务器 + 云盘 + 共享(OMV 等); 选了 SSH 分区/分组 → 只连 SSH 范围内的;
       其它分区/分组同理; **远程桌面(rdp/vnc)不连**(用户明确"只有远程桌面不用连接")。
     作用域直接取 visibleProfiles() —— 它与右侧列表**同源**(左栏选择 + 筛选 + 搜索 + 星标/已连接都在内),
     所以"看到什么就连什么", 不会出现"连了看不见的东西"。 */
  const scope = visibleProfiles();
  const servers = [], clouds = [], shares = [], skipped = [];
  scope.forEach(function(p){
    const prot = (p.protocols_mask || []).join(',').toLowerCase();
    const k = String(p.kind || '').toLowerCase();
    if(k === 'cloud' || prot.indexOf('s3') >= 0 || prot.indexOf('seafile') >= 0){ clouds.push(p); return; }
    if(k === 'share' || prot.indexOf('smb') >= 0 || prot.indexOf('nfs') >= 0 || k === 'truenas'){ shares.push(p); return; }
    if(prot.indexOf('rdp') >= 0 || prot.indexOf('vnc') >= 0){ skipped.push(p); return; }   // 远程桌面: 不连
    servers.push(p);
  });
  return { servers:servers, clouds:clouds, shares:shares, skipped:skipped };
}
let _oneKeyBusy = false;
async function oneKeyConnect(){
  if(_oneKeyBusy){ toast('一键连接进行中, 请稍候…', 'warn'); return; }
  const t = oneKeyTargets();
  const n = t.servers.length + t.clouds.length + t.shares.length;
  if(!n){
    toast('当前列表没有可连接的服务器' + (t.skipped.length ? ('（' + t.skipped.length + ' 个远程桌面已按规则跳过）') : ''), 'warn', 4200);
    return;
  }
  const ok = await rpConfirm({
    title:'一键连接', okText:'开始连接',
    body:'将连接 <b>' + t.servers.length + '</b> 台服务器 · <b>' + t.clouds.length + '</b> 个云盘(连通性探测, 云端无持久会话)'
       + ' · <b>' + t.shares.length + '</b> 个共享/OMV(挂载)'
       + (t.skipped.length ? ('<br>另有 <b>' + t.skipped.length + '</b> 个远程桌面按规则跳过') : '')
       + '<br>逐个进行并汇总结果, 过程中界面可继续使用。'
  });
  if(!ok) return;
  _oneKeyBusy = true;
  const btn = $id('ccOneKey'); if(btn){ btn.disabled = true; btn.textContent = '⚡ 连接中…'; }
  const res = { ok:0, fail:0, errs:[] };
  const ttlRaw = (($id('ccTtl') || {}).value) || '3600';
  const ttlSec = (ttlRaw === '__custom' || isNaN(parseInt(ttlRaw, 10))) ? 3600 : parseInt(ttlRaw, 10);
  let done = 0;
  const tick = function(){ done++; say('⚡ 一键连接中… ' + done + '/' + n); };
  say('⚡ 一键连接中… 0/' + n);
  for(const p of t.servers){
    try{
      const r = await rpc('conn_open', { guid:p.guid, ttl_sec:ttlSec });
      if(r.status === 'ok') res.ok++; else { res.fail++; res.errs.push((p.name||p.hostname) + ': ' + (r.msg||'连接失败')); }
    }catch(e){ res.fail++; res.errs.push((p.name||p.hostname) + ': ' + e); }
    tick();
  }
  for(const p of t.clouds){
    try{
      const r = await rpc('remote_test', { remote_id:p.remote_id, uuid:p.guid });
      if(r.status === 'ok') res.ok++; else { res.fail++; res.errs.push((p.name||'云盘') + ': ' + (r.msg||'不可达')); }
    }catch(e){ res.fail++; res.errs.push((p.name||'云盘') + ': ' + e); }
    tick();
  }
  for(const p of t.shares){
    try{
      const r = await rpc('share_mount', { uuid:p.guid });
      if(r.status === 'ok') res.ok++; else { res.fail++; res.errs.push((p.name||'共享') + ': ' + (r.msg||'挂载失败')); }
    }catch(e){ res.fail++; res.errs.push((p.name||'共享') + ': ' + e); }
    tick();
  }
  _oneKeyBusy = false;
  if(btn){ btn.disabled = false; btn.textContent = '⚡ 一键连接'; }
  say('✓ 一键连接完成: 成功 ' + res.ok + ' / 失败 ' + res.fail + (t.skipped.length ? (' / 跳过 ' + t.skipped.length) : ''));
  toast('一键连接完成: 成功 ' + res.ok + (res.fail ? (' · 失败 ' + res.fail) : '') + (t.skipped.length ? (' · 跳过 ' + t.skipped.length) : ''),
        res.fail ? 'warn' : 'success', 6500);
  if(res.errs.length){
    // 失败明细必须看得见(不静默): 主题化模态列出, 最多 20 条
    modal('一键连接 · 失败明细 (' + res.fail + ')',
      '<div style="font-size:12px;max-height:40vh;overflow:auto">'
      + res.errs.slice(0, 20).map(function(x){ return '✗ ' + esc(x); }).join('<br>')
      + (res.errs.length > 20 ? '<br>… 其余 ' + (res.errs.length - 20) + ' 条已省略' : '') + '</div>',
      [['关闭','']]);
  }
  try { await refresh(); } catch(e){}
  return res;
}

g.ConnCenter = {
  /* v5.93.0 · 新增: 挂载与探测拆开 / 引用式编辑 / 状态文案自检
     (注意: 这里只能引用**本模块已声明的标识符**; 此前误写 onShow:onShow → 模块加载即 ReferenceError,
      整个连接中心面板变成 "ConnCenter is not defined" —— 真浏览器验证抓出来的) */
  nodeMount:nodeMount, refEdit:refEdit,
  _probeText:function(pr){ return _statusWord(pr) + (pr ? (' · ' + _probeAge(pr)) : ''); },
  refresh:refresh, render:render, renderAll:renderAll,
  select:select, open:open, close:close, renew:renew, probe:probe, del:del,
  editorOpen:editorOpen, cardMenu:cardMenu, moveMenu:moveMenu, toggleStar:toggleStar, duplicate:duplicate,
  quickAct:quickAct, nodeDelete:nodeDelete,   // v6.16.15 · 节点/档案分流动作 + 节点删除
  groupAdd:groupAdd, groupEdit:groupEdit, groupDel:groupDel,
  selGroup:selGroup, toggleGroup:toggleGroup, filterProto:filterProto, setTreeMode:setTreeMode,
  filterKind:filterKind, nodeProbe:nodeProbe, nodeUmount:nodeUmount, nodeDetail:renderNodeDetail,
  /* v6.3.40 · 批 A 新增入口(入口恢复/右键菜单/左栏折叠/一键连接) */
  filterAll:filterAll, curTreeMode:curTreeMode,
  treeMenu:treeMenu, listMenu:listMenu, ctxClose:ctxClose, closeDetail:closeDetail,
  foldSide:foldSide, applyFoldSide:applyFoldSide,
  oneKeyConnect:oneKeyConnect, oneKeyTargets:oneKeyTargets,
  autoProbeStale:autoProbeStale,     // v5.95.0 · 长期连接自动续探(测试/手动触发)
  cardDragStart:cardDragStart, groupDragStart:groupDragStart, groupDrop:groupDrop,
  importOpen:importOpen, exportOpen:exportOpen, syncFromConfigs:syncFromConfigs,
  newPickerOpen:newPickerOpen, editorStorageOpen:editorStorageOpen,
  jumpTo:jumpTo, closeModal:closeModal, setView:setView, toggleView:toggleView, toggleOnlyConn:toggleOnlyConn, toggleOnlyStar:toggleOnlyStar,
  useCap:useCap, refreshNode:refreshNode,   // v5.61.0 E5 · 能力直达 / GUID 定向刷新
  disconnectAll:disconnectAll, autoRefresh:autoRefresh, say:say,
  loadConfigs:async function(){ await refresh(); },
  onShow:ensureLoaded,                     // v5.58.0 · switchTab 进入面板时调用
  invalidateSpCache:function(){ try{ if(g.SP && g.SP.invalidateCache) g.SP.invalidateCache(); }catch(e){} },
  connectedList:async function(){ await loadSessions(); return _sessions.filter(function(s){return s.state==='connected';}); },
  getAuthFor:async function(host,port){ await loadSessions(); const s=_sessions.find(function(x){return x.host===host&&String(x.port)===String(port||22)&&x.state==='connected';}); if(!s)return null; const r=await rpc('conn_auth',{session_id:s.session_id}); return r.status==='ok'?r:null; },
  isConnected:async function(host,port){ await loadSessions(); return _sessions.some(function(x){return x.host===host&&String(x.port)===String(port||22)&&x.state==='connected';}); },
  renderGroupTree: function(){ try { renderGroupTree(); } catch(e){} },
  get profiles(){return _profiles;},
  get nodes(){return _nodes;},
  get sessions(){return _sessions;},
};

document.addEventListener('DOMContentLoaded',function(){
  try{ _view = localStorage.getItem('cc_view')||'card'; }catch(e){}
  const v = $id('ccView'); if(v) v.value=_view;
  _syncFilterBtns();
  try { applyFoldSide(); } catch(e){}          // v6.3.40 · 恢复上次的左栏折叠状态
  try { _wireCcGrip(); } catch(e){}            // v6.5.0 · 批6: 中缝 grip(折叠钮+拖宽)
  // v6.3.40 · 任何位置右键先关掉已开的菜单(点空白/滚动/切页都不留残影)
  document.addEventListener('mousedown', function(e){ if(_ctxEl && e.target !== _ctxEl) ctxClose(); }, true);
  document.addEventListener('scroll', function(){ ctxClose(); }, true);
  setTimeout(function(){ refresh(); autoRefresh(); hookEvents(); },1400);
});
})(window);
