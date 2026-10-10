/* v5.34.3 · P3 连接中心接入层 (window.SP)
   —— 跨页填参 / 表单回写 / 凭据解析缓存 / 事件订阅
   数据源: server_profiles (唯一凭据真源) · 复用 app.js 的 PANEL_FIELDS 映射覆盖 12 页
   设计: fillPanel 只填非敏感字段; 凭据走 _credCache (点档案时异步 resolve 缓存),
        getSrvAuth 由 app.js 侧兜底读取 —— 密码不进 DOM */
(function(g){
'use strict';
function rpc(a,d){return new Promise(function(res){try{g.send(Object.assign({action:a},d||{}),function(r){res(r||{});});}catch(e){res({status:'error',msg:String(e)});}});}

let _cache = null;          // sp_list 结果 {profiles:[], groups:[], at:ts}
let _credCache = {};        // "host:port" → {creds, caps, guid, at}  (resolve 缓存, 5min)
let _activeGuid = '';       // 当前选中的档案 (档案区点击 / 面板对齐)
let _sessions = [];         // v5.34.4 · P4 活跃会话 (conn_list 缓存, conn.changed 驱动刷新)
const CRED_TTL = 300000;

function cacheValid(){
  // v5.50.0 修: 登录前 SP.list() 会拉到空列表并缓存 30s → 整个会话 serverRows() 恒 0 台,
  //   导致 DM 三栏/双栏/文件预览等"服务器"分组永远为空 → 选不到机器而回落「本机:/」
  //   (用户报的"打开其他机器显示本机根目录"的深层根因)。空结果不再进缓存。
  return _cache && (Date.now()-_cache.at < 30000) && ((_cache.profiles||[]).length > 0);
}

/* ═══ 数据 ═══ */
async function list(force){
  if(!force && cacheValid()) return _cache;
  // v5.93.0 · 收口到 RPList: 空结果/失败**不覆盖**上次成功数据 + 短重试 + 带 stale/err
  const r = await RPList.load('sp_list', 'sp_list', {}, {pick:'profiles', acceptEmpty:true});   // v6.16.2 批18: 空列表=真没有
  const _prevGroups = (_cache && _cache.groups) || [];
  if(r && r.ok){
    _cache = {profiles: r.data||[], groups: (r.raw && r.raw.groups) || _prevGroups,
              at: Date.now(), stale: !!r.stale, err: r.err || ''};
  } else {
    _cache = {profiles: [], groups: _prevGroups, at: Date.now(), stale: false,
              err: (r && r.err) || 'sp_list 未取到'};
  }
  return _cache;
}
async function get(guid){
  const r = await rpc('sp_get',{guid:guid});
  return r.status==='ok' ? r.profile : null;
}
async function resolve(host, port, need){
  const key = (host||'')+':'+(port||22);
  const hit = _credCache[key];
  if(hit && (Date.now()-hit.at < CRED_TTL)) return hit;
  const r = await rpc('sp_resolve',{host:host, port:port||22, need:need||[]});
  if(r.status==='ok' && r.matched){
    const entry = {creds:r.creds, caps:r.caps||{}, guid:r.guid||'', via_session:!!r.via_session,
                   summary:r.profile_summary||{}, at:Date.now()};
    _credCache[key] = entry;
    if(r.guid) _activeGuid = _activeGuid || r.guid;
    return entry;
  }
  _credCache[key] = {creds:null, at:Date.now()};   // 负缓存, 避免每次打后端
  return null;
}
function cachedCreds(host, port){
  const hit = _credCache[(host||'')+':'+(port||22)];
  return (hit && hit.creds) ? hit.creds : null;
}
function forget(host, port){ delete _credCache[(host||'')+':'+(port||22)]; }
function forgetAll(){ _credCache = {}; _cache = null; }

/* ═══ 填参: 档案 → 当前面板表单 (复用 app.js PANEL_FIELDS) ═══ */
function normalizeAuthType(at){
  // 档案 ssh_auth_type: pass|key ; 表单: pass|key
  return (at==='key')?'key':'pass';
}
function fillPanel(panelKey, profile){
  // v5.84.0 · 预热凭据缓存: getSrvAuth() 的跨页兜底读的是 SP.resolve 写的缓存,
  //   而"把档案填进表单"这条路从不预热 → 文件管理/容器管理拿去空凭据 → 后端退化成公钥尝试 →
  //   "Permission denied (publickey,password)"。放在 fillPanel 里, 所有填参入口统一生效。
  try {
    if (profile && profile.hostname) resolve(profile.hostname, profile.ssh_port || 22);
  } catch (e) {}

  if(!profile) return false;
  const PF = g.PANEL_FIELDS || {};
  const f = PF[panelKey];
  if(!f) return false;
  function set(id, val){
    const el = document.getElementById(id);
    if(!el) return;
    if(val==null || val==='') return;      // 空值不覆盖已有输入
    el.value = val;
  }
  set(f.host, profile.hostname);
  set(f.port, String(profile.ssh_port||22));
  set(f.user, profile.ssh_user||'root');
  // 认证方式 (radio/select 由各页 ConnPanel_renderAuth 接管, 这里写 select 值并触发变更)
  const atEl = document.getElementById(f.at);
  if(atEl && profile.ssh_auth_type){
    try{ atEl.value = normalizeAuthType(profile.ssh_auth_type);
         atEl.dispatchEvent(new Event('change', {bubbles:true})); }catch(e){}
  }
  // extras (路径类字段: 备份目标/本地目录等) — 从 protocols 里找对应块
  const proto = profile.protocols || {};
  (f.extras||[]).forEach(function(x){
    if(!x.id) return;
    let v = '';
    // 直接同名 (旧 configs 兼容字段) 优先
    if(profile[x.cfgKey] != null && profile[x.cfgKey] !== '') v = profile[x.cfgKey];
    if(!v){
      const search = {backupDst:['pve_ssh','backup_dst'], vdTmpDir:['pve_ssh','tmp_dir'],
        vdLocalDir:['pve_ssh','local_dir'], lvmLocalDir:['lvm','local_dir'],
        zfsLocalDir:['zfs','local_dir'], rbdLocalDir:['rbd','local_dir'], rbdPool:['rbd','pool'],
        pbsServer:['pbs','server'], pbsDatastore:['pbs','datastore'], pbsApiUser:['pbs','api_user'],
        abLocalDst:['backup','local_dst'], abExtraPaths:['backup','extra_paths'],
        pbKeyPath:['platform','key_path'], pbExtraPaths:['platform','extra_paths'],
        pbLocalDir:['platform','local_dir']};
      const path = search[x.cfgKey];
      if(path && proto[path[0]]) v = proto[path[0]][path[1]] || '';
    }
    if(v) set(x.id, v);
  });
  // 记活跃档案 + 异步解析凭据 (供 getSrvAuth 兜底)
  _activeGuid = profile.guid || '';
  try{ g._spActiveGuid = _activeGuid; }catch(e){}
  resolve(profile.hostname, profile.ssh_port||22).then(function(entry){
    if(entry && g.toast && !entry.via_session){
      // 静默: 凭据已就绪可供本页执行 (不弹窗, 避免打扰)
    }
  });
  return true;
}
function fillByGuid(panelKey, guid){
  const p = (_cache && _cache.profiles||[]).find(function(x){return x.guid===guid;});
  if(!p) return get(guid).then(function(full){ return full?fillPanel(panelKey, full):false; });
  // 列表数据已够填身份字段; 需要 protocols 时再拉全档
  if(!p.protocols){
    return get(guid).then(function(full){
      if(!full) return false;
      // 列表无 protocols → 用全档, 但保留列表里的展示字段
      return fillPanel(panelKey, Object.assign({}, p, full));
    });
  }
  return Promise.resolve(fillPanel(panelKey, p));
}

/* ═══ 收集: 当前面板表单 → 档案增量 (含能力块按面板归属) ═══ */
const PANEL_PROTO_MAP = {
  // panelKey → [protocols 块, 该块字段→表单 id 映射]
  proxmox:  ['pve_ssh', {backup_dst:'backupDst'}],
  vzdump:   ['pve_ssh', {tmp_dir:'vdTmpDir', local_dir:'vdLocalDir'}],
  lvm:      ['lvm',     {local_dir:'lvmLocalDir'}],
  zfs:      ['zfs',     {local_dir:'zfsLocalDir'}],
  rbd:      ['rbd',     {local_dir:'rbdLocalDir', pool:'rbdPool'}],
  pbs:      ['pbs',     {server:'pbsServer', datastore:'pbsDatastore', api_user:'pbsApiUser'}],
  auto_backup:      ['backup',   {local_dst:'abLocalDst', extra_paths:'abExtraPaths'}],
  platform_backup:  ['platform', {key_path:'pbKeyPath', extra_paths:'pbExtraPaths', local_dir:'pbLocalDir'}],
};
function collectPanel(panelKey){
  const PF = g.PANEL_FIELDS || {};
  const f = PF[panelKey];
  if(!f) return null;
  function val(id){ const el = document.getElementById(id); return el ? (el.value||'').trim() : ''; }
  const out = {hostname: val(f.host), ssh_port: parseInt(val(f.port)||'22',10)||22,
               ssh_user: val(f.user)||'root'};
  const at = val(f.at) || 'pass';
  out.ssh_auth_type = normalizeAuthType(at);
  const av = val(f.av);
  // 密码/密钥: 仅在用户实际填了值时才带上 (留空 = 保持档案原值)
  if(av) out.ssh_auth_value = av;
  if(!out.hostname) return null;
  // 面板专属能力块 (只提交本页字段, 不覆盖其他块)
  const pm = PANEL_PROTO_MAP[panelKey];
  if(pm){
    const blk = {};
    let any = false;
    Object.keys(pm[1]).forEach(function(k){
      const v = val(pm[1][k]);
      if(v){ blk[k] = v; any = true; }
    });
    if(any){ blk.enabled = true; out.protocols = {}; out.protocols[pm[0]] = blk; }
  }
  return out;
}
async function saveFromPanel(panelKey){
  const payload = collectPanel(panelKey);
  if(!payload) return null;
  // 先按 host:port 找档案 (没有则按当前活跃 guid 更新)
  let guid = _activeGuid;
  if(!guid){
    try{
      const r = await rpc('sp_get_by_host',{hostname:payload.hostname, port:payload.ssh_port});
      if(r.status==='ok' && r.profile) guid = r.profile.guid;
    }catch(e){}
  }
  if(guid) payload.guid = guid;
  const r = await rpc('sp_save',{profile:payload});
  if(r.status==='ok'){
    _activeGuid = r.guid; g._spActiveGuid = r.guid;
    forget(payload.hostname, payload.ssh_port);   // 凭据可能已更新
    if(_cache) _cache.at = 0;
    return r;
  }
  return r.status==='error' ? r : null;
}

/* ═══ v5.34.4 · P4 会话全域贯通 ═══ */
function sessionKey(host, port){ return (host||'')+':'+String(port||22); }
function sessionsByKey(){
  const m = {};
  _sessions.forEach(function(s){ if(s.state==='connected') m[sessionKey(s.host,s.port)] = s; });
  return m;
}
function isConnected(host, port){ return !!sessionsByKey()[sessionKey(host,port)]; }

async function refreshSessions(){
  try{
    // v1.0.0 · WS 未开就别打(避免在断线/重连窗口里反复触发 RPC 抖动); 可见性恢复与登录后会立即补一次
    if (g._wsStatus && g._wsStatus !== 'open') { publishSessions(); renderCapsule(); return; }
    const r = await rpc('conn_list');
    if (r && r.status === 'ok'){
      _sessions = (r.sessions||[]).filter(function(s){ return s.state==='connected'; });
      _sessFail = 0;
    } else {
      // v1.0.0 · 页面刚刷新的首帧往往"还没登录" → conn_list 被拒; 旧代码直接当空列表且**不再重试**
      //   → 表现就是"刷新后连接状态全丢"。这里改成有界重试(登录完成后即恢复)。
      var m = String((r && r.msg) || '');
      if ((/登录/.test(m) || (r && r.code === 'unauthenticated')) && _sessFail < 20){
        _sessFail++;
        setTimeout(function(){ refreshSessions(); }, 1500);
      }
    }
  }catch(e){ }
  publishSessions();
  renderCapsule();
  refreshHostDots();
  // 侧栏档案区绿点重绘 (只更新圆点, 避免整栏重渲染打断交互)
  try{
    const sec = document.getElementById('configList');   // v5.35.0 · 单轨侧栏容器
    if(sec){
      const byKey = sessionsByKey();
      sec.querySelectorAll('.sp-row').forEach(function(row){
        const gid = row.getAttribute('data-guid');
        const p = ((_cache&&_cache.profiles)||[]).find(function(x){return x.guid===gid;});
        if(!p) return;
        const dot = row.querySelector('.sp-dot');
        if(dot){
          const on = !!byKey[sessionKey(p.hostname, p.ssh_port||22)];
          dot.style.background = on ? '#54d18c' : ((p.status==='online') ? '#54d18c' : (p.status==='offline' ? '#ff5f5f' : '#ccc'));
          dot.style.boxShadow = on ? '0 0 5px #54d18c' : 'none';
          dot.title = on ? '已连接 (会话活跃)' : (p.status||'未探测');
        }
        const nm = row.querySelector('.sp-name');
        if(nm){
          const on = !!byKey[sessionKey(p.hostname, p.ssh_port||22)];
          let g = row.querySelector('.sp-gdot');
          if(on){
            if(!g){ g = document.createElement('span'); g.className='sp-gdot'; g.textContent='🟢';
                    g.style.cssText='font-size:9px;margin-left:3px'; nm.parentNode.insertBefore(g, nm.nextSibling); }
          } else if(g){ g.remove(); }
        }
      });
    }
  }catch(e){}
}

/* v1.0.0 · 会话状态单源发布: 写 window.__rpSessions(总览用) + 广播事件(连接中心/活跃会话订阅) */
var _sessFail = 0, _sessTimer = null, _sessPolling = false;
function publishSessions(){
  try { window.__rpSessions = _sessions; } catch(e){}
  try { g.dispatchEvent(new CustomEvent('rp-sessions-changed', { detail: { sessions: _sessions } })); } catch(e){}
  _refreshTreeDots();
}
/* 新树(SrvTree .st-row/.st-dot)圆点: 会话活跃 → 绿; 会话结束 → 回落到档案自身状态点 */
function _refreshTreeDots(){
  try {
    const sec = document.getElementById('configList');
    if (!sec) return;
    const byKey = sessionsByKey();
    sec.querySelectorAll('.st-row[data-guid]').forEach(function(row){
      const gid = row.getAttribute('data-guid');
      const p = ((_cache && _cache.profiles) || []).find(function(x){ return x.guid === gid; });
      if (!p) return;
      const dot = row.querySelector('.st-dot');
      if (!dot) return;
      if (byKey[sessionKey(p.hostname, p.ssh_port || 22)]){
        dot.className = 'st-dot st-dot-on';
        dot.title = '已连接 (会话活跃)';
      } else if (dot.className.indexOf('st-dot-on') >= 0){
        const st = String(p.status || '');
        dot.className = 'st-dot ' + (st === 'online' ? 'st-dot-on' : (st === 'offline' ? 'st-dot-err' : 'st-dot-gray'));
        dot.title = st || '未探测';
      }
    });
  } catch(e){}
}
/* 定时刷新(5s, 仅可见时) —— 后端 conn_list 自带 5s 结果缓存与真实 `ssh -O check` 探活,
   所以轮询成本极低; 会话到期/被回收后 ≤5s 内 UI 自动翻成"未连接"。 */
function startSessionPolling(){
  if (_sessPolling) return;
  _sessPolling = true;
  _sessTimer = setInterval(function(){ if (!document.hidden) refreshSessions(); }, 5000);
  document.addEventListener('visibilitychange', function(){ if (!document.hidden) refreshSessions(); });
}

/* 注: startSessionPolling 的对外导出放在 window.SP 定义之后(见下方 sideModMenu 处) —— 
   此前放在这里会先于 window.SP 赋值执行, 抛 TypeError 打断整个 IIFE 初始化。 */

function renderCapsule(){
  const wrap = document.getElementById('globalConnStatus');
  const dot = document.getElementById('globalConnDot');
  const txt = document.getElementById('globalConnText');
  if(!wrap||!dot||!txt) return;
  const n = _sessions.length;
  const wsOpen = (g._wsStatus === 'open');
  /* v1.0.0 · 用户要求: 左上角**只留一个圆点**, 不因"N 会话"等文案改变尺寸(此前每次轮询/会话变化
     都会撑开成 "N 会话" → 视觉抖动)。会话数只放 title, 详情点一下看弹层。 */
  if(wsOpen){
    dot.style.background = 'var(--green)';
    dot.style.boxShadow = '0 0 6px var(--green)';
    txt.textContent = ''; txt.style.display = 'none';
    wrap.style.padding = '3px 6px';
    wrap.style.border = '1px solid transparent';
    wrap.style.background = 'transparent';
    /* v1.0.0 · i18n: title 是"就地改写属性", 不产生 childList 变更 → 观察器兜不住,
       这里直接走 t() (含数字的走引擎的数字模板) */
    var _tt = (typeof g.t === 'function') ? g.t : function(x){ return x; };
    wrap.title = n > 0 ? _tt('WS: 已连接 · ' + n + ' 个活跃会话 · 点击查看/管理')
                       : _tt('WS: 已连接 · 点击查看详细连接状态');
  }
}

/* 各页表单 host 标签旁 🟢 (全页面可见的会话指示) */
function refreshHostDots(){
  const PF = g.PANEL_FIELDS || {};
  const byKey = sessionsByKey();
  Object.keys(PF).forEach(function(pk){
    const f = PF[pk];
    const hostEl = document.getElementById(f.host);
    if(!hostEl) return;
    const field = hostEl.closest && hostEl.closest('.field');
    if(!field) return;
    const label = field.querySelector('label');
    if(!label) return;
    const cur = (hostEl.value||'').trim();
    const on = cur && !!byKey[sessionKey(cur, (document.getElementById(f.port)||{}).value||22)];
    let d = label.querySelector('.sp-host-dot');
    if(on){
      if(!d){ d = document.createElement('span'); d.className = 'sp-host-dot';
              d.textContent = '🟢'; d.style.cssText='font-size:10px;margin-left:5px';
              d.title = '连接中心: 该服务器已连接 (复用会话, 免认证)';
              label.appendChild(d); }
    } else if(d){ d.remove(); }
  });
}

/* 连接状态面板注入「活跃会话」区 (app.js renderConnStatusPanel 调用) */
function injectSessionSection(panel){
  try{
    if(!panel || panel.querySelector('#ccSessPanel')) return;
    const n = _sessions.length;
    let h = '<div id="ccSessPanel" style="margin-bottom:12px;border:1px solid var(--border);border-radius:7px;padding:8px 10px;background:var(--bg3)">'
      + '<div style="font-size:12px;font-weight:600;margin-bottom:6px">🔌 连接中心会话 <span style="color:var(--text3);font-weight:normal">('+n+')</span>'
      + '<a href="javascript:;" style="float:right;font-size:11px;color:var(--blue)" onclick="SP.openConnCenter()">打开连接中心 →</a></div>';
    if(!n){
      h += '<div style="font-size:11px;color:var(--text3)">无活跃会话 · 在连接中心点「连接」后各页免测试直接用</div>';
    } else {
      h += _sessions.map(function(s){
        return '<div style="display:flex;align-items:center;gap:6px;font-size:11.5px;padding:3px 0;border-bottom:1px dashed var(--border)">'
          + '<span style="width:7px;height:7px;border-radius:50%;background:#54d18c;flex-shrink:0"></span>'
          + '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+String(s.name||s.endpoint||'').replace(/</g,'&lt;')+'</span>'
          + '<span style="color:var(--text3);font-size:10.5px">'+(s.remain_sec!=null?fmtRemain(s.remain_sec):'持续')+'</span>'
          + '<a href="javascript:;" style="font-size:10.5px;color:var(--blue)" onclick="SP.renewSession(&#39;'+String(s.session_id)+'&#39;)">+1h</a>'
          + '<a href="javascript:;" style="font-size:10.5px;color:var(--red)" onclick="SP.closeSession(&#39;'+String(s.session_id)+'&#39;)">断开</a></div>';
      }).join('');
    }
    h += '</div>';
    panel.insertAdjacentHTML('afterbegin', h);
  }catch(e){}
}
function fmtRemain(s){ if(s==null)return'持续';if(s>=86400)return(s/86400).toFixed(1)+'天';if(s>=3600)return Math.floor(s/3600)+'时'+Math.floor((s%3600)/60)+'分';if(s>=60)return Math.floor(s/60)+'分';return s+'秒';}
function openConnCenter(){
  const p = document.getElementById('connStatusPanel');
  if(p) p.remove();
  if(g.switchTab) g.switchTab('conn_center');
}
async function renewSession(sid){
  const r = await rpc('conn_renew',{session_id:sid, ttl_sec:3600});
  if(g.toast) g.toast(r.msg||'已续期','success',2200);
  await refreshSessions();
  try{ if(g.ConnCenter && g.ConnCenter.refresh) g.ConnCenter.refresh(); }catch(e){}
}
async function closeSession(sid){
  const r = await rpc('conn_close',{session_id:sid});
  if(g.toast) g.toast(r.msg||'已断开', r.status==='ok'?'success':'err',2400);
  await refreshSessions();
  try{ if(g.ConnCenter && g.ConnCenter.refresh) g.ConnCenter.refresh(); }catch(e){}
}

/* ═══ v5.35.0 · G1 侧栏单轨: 档案 + 多层分组树 (唯一服务器列表) ═══ */
function _sbHidden(){ try { return JSON.parse(localStorage.getItem('sb_hidden') || '{}'); } catch(e){ return {}; } }
function _sbSetHidden(g, on){
  try {
    var o = _sbHidden();
    if (on) o[g] = 1; else delete o[g];
    localStorage.setItem('sb_hidden', JSON.stringify(o));
  } catch(e){}
}
/* v5.90.6 · 服务器列表右键菜单: 断开连接 / 从列表移除 */
function _spRowMenu(ev, p){
  ev.preventDefault(); ev.stopPropagation();
  var old = document.getElementById('spRowMenu'); if (old) old.remove();
  var byKey = sessionsByKey();
  var on = !!byKey[sessionKey(p.hostname, p.ssh_port || 22)];
  var menu = document.createElement('div');
  menu.id = 'spRowMenu';
  menu.style.cssText = 'position:fixed;z-index:100000;background:var(--bg2);border:1px solid var(--border);border-radius:8px;box-shadow:0 10px 32px rgba(0,0,0,.45);padding:4px;min-width:170px;font-size:12px';
  var rows = [];
  rows.push({ t: on ? '⛔ 断开连接' : '🔌 连接', fn: function(){
    if (on){
      window.send({ action: 'conn_close', session_id: (byKey[sessionKey(p.hostname, p.ssh_port || 22)] || {}).session_id || '' }, function(){ renderSidebarSection(document.getElementById('configList')); });
    } else {
      if (typeof window.ConnCenter !== 'undefined' && ConnCenter.openSession) ConnCenter.openSession(p.guid);
      else if (typeof switchTab === 'function') switchTab('conn_center');
    }
  }});
  rows.push({ sep: 1 });
  rows.push({ t: '👁 从列表移除 (可恢复)', fn: function(){
    _sbSetHidden(p.guid, true);
    renderSidebarSection(document.getElementById('configList'));
  }});
  rows.push({ t: '🗂 到连接中心管理', fn: function(){ switchTab('conn_center'); }});
  rows.forEach(function(r){
    if (r.sep){ var d = document.createElement('div'); d.style.cssText = 'height:1px;background:var(--border);margin:4px 2px'; menu.appendChild(d); return; }
    var el = document.createElement('div');
    el.textContent = r.t;
    el.style.cssText = 'padding:5px 10px;border-radius:5px;cursor:pointer;white-space:nowrap';
    el.onmouseenter = function(){ el.style.background = 'var(--bg3)'; };
    el.onmouseleave = function(){ el.style.background = ''; };
    el.onclick = function(){ menu.remove(); try { r.fn(); } catch(e){ console.warn(e); } };
    menu.appendChild(el);
  });
  document.body.appendChild(menu);
  var fix = function(){
    var r = menu.getBoundingClientRect();
    if (ev.clientX + r.width > window.innerWidth - 8) menu.style.left = Math.max(4, window.innerWidth - r.width - 8) + 'px';
    if (ev.clientY + r.height > window.innerHeight - 8) menu.style.top = Math.max(4, window.innerHeight - r.height - 8) + 'px';
  };
  menu.style.left = ev.clientX + 'px'; menu.style.top = ev.clientY + 'px'; fix();
  setTimeout(function(){
    document.addEventListener('mousedown', function h(ev){
      if (!menu.contains(ev.target)){ menu.remove(); document.removeEventListener('mousedown', h); }
    });
  }, 0);
}
/* v5.90.6 · 添加选择器: 列出全部档案, 已在列表的灰显, 被移除的可恢复 */
function _spAddPicker(){
  var hidden = _sbHidden();
  var m = document.createElement('div');
  m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:100000;display:flex;align-items:center;justify-content:center';
  m.innerHTML = '<div style="background:var(--bg2);border:1px solid var(--border);border-radius:10px;min-width:380px;max-width:92vw;max-height:80vh;display:flex;flex-direction:column;padding:14px">'
    + '<div style="font-weight:600;font-size:13px;margin-bottom:8px">➕ 添加服务器到列表</div>'
    + '<div id="spAddList" style="flex:1;overflow:auto;min-height:120px"></div>'
    + '<div style="text-align:right;margin-top:10px"><button class="btn btn-sm" id="spAddClose">关闭</button></div></div>';
  document.body.appendChild(m);
  m.querySelector('#spAddClose').onclick = function(){ m.remove(); };
  m.onclick = function(ev){ if (ev.target === m) m.remove(); };
  list().then(function(c){
    var box = m.querySelector('#spAddList');
    var rows = c.profiles || [];
    if (!rows.length){ box.innerHTML = '<div style="color:var(--text3);font-size:12px;padding:8px">暂无档案 — 先到连接中心新建</div>'; return; }
    rows.forEach(function(p){
      var hid = !!hidden[p.guid];
      var row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;cursor:' + (hid ? 'pointer' : 'default') + ';opacity:' + (hid ? 1 : .45);
      row.innerHTML = '<span style="flex:1;font-size:12.5px">' + String(p.name || p.hostname || '').replace(/[<>&]/g, '')
        + ' <span style="color:var(--text3);font-size:11px">' + String(p.hostname || '') + '</span></span>'
        + '<span style="font-size:10.5px;color:' + (hid ? 'var(--green)' : 'var(--text3)') + '">' + (hid ? '点此恢复' : '已在列表') + '</span>';
      if (hid) row.onclick = function(){
        _sbSetHidden(p.guid, false);
        row.style.opacity = .45;
        row.querySelector('span:last-child').textContent = '已在列表';
        renderSidebarSection(document.getElementById('configList'));
      };
      box.appendChild(row);
    });
  });
}


/* ══ v6.1.9 · 左栏模块自定义(按页面): localStorage['uni_side_mod_<pageKey>']
   项: quick(分组视图快捷项) star(按类型星标区) typeBdg(类型徽章) grpBdg(分组徽章) sess(活跃会话区)
   默认全开; ⚙ 菜单改的是**当前页**的配置 —— 不同页面可以有不同的左栏形态(用户需求) ══ */
function _sideModKey(){
  var el = document.querySelector('.panel.active');
  return 'uni_side_mod_' + (el ? el.id.replace(/^panel-/,'') : 'transfer');
}
/* ═══ v6.3.6 · 左栏模块化(用户要求) ═══
   可勾选 + **可自由排序**的两类模块:
     · 宿主机信息: CPU / 内存 / 磁盘 / 网络 / 负载 / 运行时长 / 存储池状态 / 活跃会话数
     · 快捷方式:   连接中心 / 多云文件管理 / 多云虚拟存储池 / 远端存储 / 网络共享
   数据全部来自**已有的真值**(window.__sysStats ← system_stats, __rpSessions ← conn_list,
   __rpPools ← cpool_list), 不再各处各拉一份(§3.7 单一数据源)。 */
var HOST_ITEMS = [['cpu','🖥 CPU 使用率'], ['mem','🧠 内存'], ['disk','💾 磁盘'],
                  ['net','📡 网络上下行'], ['load','📈 系统负载'], ['sys','🕒 运行时长'],
                  ['os','🏷 操作系统'], ['kern','🐧 内核 / 架构'], ['hostname','🖧 主机名'],
                  ['pool','🧊 存储池状态'], ['sess','🔌 活跃会话数']];
/* v6.16.14 · 功能裁剪: 「存储池状态」属 cloudpool → 社区版不出现在宿主机区与左栏模块设置里 */
var HOST_ITEM_FEAT = { pool: 'cloudpool' };
function _hostItemAllowed(k){
  var f = HOST_ITEM_FEAT[k];
  if (!f) return true;
  return !(typeof window.licenseFeatEnabled === 'function' && !window.licenseFeatEnabled(f));
}
HOST_ITEMS = HOST_ITEMS.filter(function(x){ return _hostItemAllowed(x[0]); });
var HOST_DEF_ORDER = ['cpu','mem','disk','net','load','sys','os','kern','hostname','pool','sess'].filter(_hostItemAllowed);
var SHORT_ITEMS = [['conn_center','🔌 连接中心'], ['fonrvfs','🗂 多云文件管理'],
                   ['vdisk_cloud','💠 多云虚拟存储池'], ['remotes','☁️ 远端存储'], ['shares','🌐 网络共享']];
var SHORT_DEF_ORDER = ['conn_center','fonrvfs','vdisk_cloud','remotes','shares'];
/* 左栏区块顺序(用户可调)。v6.3.43 · 批 C(用户确认): 服务器列表**最先**,
   快捷操作(快捷方式+快速操作合并)其次, 活跃会话, 宿主机最后(且默认隐藏)。 */
var SEC_DEF_ORDER = ['servers','actions','sess','host'];

function _defMods(){
  /* v6.3.43 · 批 C: `host` 默认 **false**(用户要求"宿主机信息默认不显示");
     `short` 置 false —— 快捷方式区已并入「快捷操作」(#sbShortSect 元素已移除), 老偏好里有 true 也无害 */
  var o = { quick:true, star:true, typeBdg:true, grpBdg:true, sess:true, actions:true,
            host:false, short:false,
            hostItems:{}, shortItems:{}, hostOrder:HOST_DEF_ORDER.slice(),
            shortOrder:SHORT_DEF_ORDER.slice(), secOrder:SEC_DEF_ORDER.slice() };
  HOST_ITEMS.forEach(function(it){ o.hostItems[it[0]] = true; });
  SHORT_ITEMS.forEach(function(it){ o.shortItems[it[0]] = true; });
  return o;
}
function sideMods(){
  var d = _defMods();
  try {
    var raw = JSON.parse(localStorage.getItem(_sideModKey()) || '{}');
    if (raw){
      Object.keys(raw).forEach(function(k){
        if (k === 'hostItems' || k === 'shortItems') Object.assign(d[k], raw[k] || {});
        else if (k === 'hostOrder' || k === 'shortOrder' || k === 'secOrder'){
          if (Array.isArray(raw[k]) && raw[k].length) d[k] = raw[k].slice();
        } else d[k] = raw[k];
      });
      // 顺序数组补齐新增项(以后加条目不会因旧偏好而消失)
      d.hostOrder = d.hostOrder.filter(function(k){ return HOST_DEF_ORDER.indexOf(k) >= 0; });
      HOST_DEF_ORDER.forEach(function(k){ if (d.hostOrder.indexOf(k) < 0) d.hostOrder.push(k); });
      d.shortOrder = d.shortOrder.filter(function(k){ return SHORT_DEF_ORDER.indexOf(k) >= 0; });
      SHORT_DEF_ORDER.forEach(function(k){ if (d.shortOrder.indexOf(k) < 0) d.shortOrder.push(k); });
      d.secOrder = d.secOrder.filter(function(k){ return SEC_DEF_ORDER.indexOf(k) >= 0; });
      SEC_DEF_ORDER.forEach(function(k){ if (d.secOrder.indexOf(k) < 0) d.secOrder.push(k); });
    }
  } catch(e){}
  return d;
}

/* ── 宿主机信息渲染(只吃真值缓存; 缺数据就显示"—", 不编数) ── */
function _fmtBytes(v){
  if (v == null || isNaN(Number(v))) return '—';
  var b = Number(v), u = ['B', 'KiB', 'MiB', 'GiB', 'TiB'], i = 0;
  while (b >= 1024 && i < u.length - 1){ b /= 1024; i++; }
  return (i ? b.toFixed(1) : b) + ' ' + u[i];
}
function _fmtUptime(sec){
  sec = Number(sec) || 0;
  if (!sec) return '—';
  var d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return (d ? d + ' 天 ' : '') + h + ' 时 ' + m + ' 分';
}
function renderHostInfo(){
  var box = document.getElementById('sbHost');
  if (!box) return;
  var m = sideMods();
  var s = window.__sysStats || null;
  var pools = window.__rpPools || null;
  var sess = (window.__rpSessions || []).length;
  function row(icon, label, val, tip, col){
    return '<div class="sb-hi" title="' + (tip || '') + '">'
      + '<span class="sb-hi-ic">' + icon + '</span><span class="sb-hi-lb">' + label + '</span>'
      + '<span class="sb-hi-v" style="' + (col ? ('color:' + col) : '') + '">' + val + '</span></div>';
  }
  var out = [];
  m.hostOrder.forEach(function(k){
    if (m.hostItems[k] === false) return;
    if (k === 'cpu'){
      var c = s ? Math.round(Number(s.cpu_percent) || 0) : null;
      out.push(row('🖥', 'CPU', c == null ? '—' : (c + '%'), '宿主机 CPU 使用率',
                   c == null ? '' : (c >= 90 ? 'var(--red)' : (c >= 70 ? 'var(--orange)' : ''))));
    } else if (k === 'mem'){
      var mm = (s && s.memory) || null;
      var mp = mm ? Math.round(Number(mm.percent) || 0) : null;
      out.push(row('🧠', '内存', mp == null ? '—' : (mp + '% · ' + _fmtBytes(mm.used) + '/' + _fmtBytes(mm.total)),
                   '宿主机内存占用', mp == null ? '' : (mp >= 90 ? 'var(--red)' : (mp >= 80 ? 'var(--orange)' : ''))));
    } else if (k === 'disk'){
      var dd = (s && s.disk) || null;
      var dp = dd ? Math.round(Number(dd.percent) || 0) : null;
      out.push(row('💾', '磁盘', dp == null ? '—' : (dp + '% · 剩 ' + _fmtBytes(dd.free)),
                   '宿主机根分区占用', dp == null ? '' : (dp >= 90 ? 'var(--red)' : (dp >= 80 ? 'var(--orange)' : ''))));
    } else if (k === 'net'){
      var n = (s && s.net) || null;
      out.push(row('📡', '网络', n ? ('↑' + (n.sent_rate || 0) + ' ↓' + (n.recv_rate || 0) + ' KB/s') : '—',
                   '宿主机网络即时速率'));
    } else if (k === 'load'){
      var l = (s && s.load) || null;
      out.push(row('📈', '负载', l ? (l[0].toFixed(2) + ' / ' + l[1].toFixed(2) + ' / ' + l[2].toFixed(2)) : '—',
                   '1 / 5 / 15 分钟平均负载'));
    } else if (k === 'sys'){
      out.push(row('🕒', '运行时长', s ? _fmtUptime(s.uptime_sec) : '—', '宿主机开机时长'));
    } else if (k === 'os'){
      var ho = (s && s.host) || null;
      out.push(row('🏷', '系统', (ho && ho.os) ? ho.os : '—', '宿主机发行版(/etc/os-release PRETTY_NAME)'));
    } else if (k === 'kern'){
      var hk = (s && s.host) || null;
      out.push(row('🐧', '内核', (hk && hk.kernel) ? (hk.kernel + (hk.arch ? (' · ' + hk.arch) : '')) : '—',
                   '内核版本与 CPU 架构'));
    } else if (k === 'hostname'){
      var hn = (s && s.host) || null;
      out.push(row('🖧', '主机名', (hn && hn.hostname) ? hn.hostname : '—', '宿主机主机名'));
    } else if (k === 'pool'){
      if (!pools) out.push(row('🧊', '存储池', '—', '存储池状态读取中…'));
      else if (!pools.length) out.push(row('🧊', '存储池', '无', '还没有存储池'));
      else {
        var bad = pools.filter(function(p){ return String(p.status || '') !== 'ACTIVE'; });
        var txt = pools.length + ' 个' + (bad.length ? (' · ' + bad.length + ' 个异常') : ' · 全部正常');
        out.push(row('🧊', '存储池', txt, pools.map(function(p){ return (p.name || p.id) + ': ' + (p.status || '?'); }).join(String.fromCharCode(10)),
                     bad.length ? 'var(--orange)' : 'var(--green)'));
      }
    } else if (k === 'sess'){
      out.push(row('🔌', '活跃会话', sess + ' 个', '当前 SSH/桌面等活跃会话数',
                   sess ? 'var(--green)' : 'var(--text3)'));
    }
  });
  box.innerHTML = out.length ? out.join('')
    : '<div style="padding:4px 10px;font-size:11.5px;color:var(--text3)">未选择任何宿主机信息项(点 ⚙ 勾选)</div>';
}

/* ── 快捷方式渲染(方形长条按钮) ── */
function renderShortcuts(){
  var box = document.getElementById('sbShort');
  if (!box) return;
  var m = sideMods();
  var rows = [];
  m.shortOrder.forEach(function(k){
    if (m.shortItems[k] === false) return;
    var it = SHORT_ITEMS.filter(function(x){ return x[0] === k; })[0];
    if (!it) return;
    rows.push('<button type="button" class="sb-sc" onclick="switchTab(\'' + k + '\')" title="打开「'
      + it[1] + '」">' + it[1] + '</button>');
  });
  box.innerHTML = rows.length ? rows.join('')
    : '<div style="font-size:11.5px;color:var(--text3)">未选择快捷方式(点 ⚙ 勾选)</div>';
}

/* ── 区块排序(用户自由排序): 按 secOrder 把 DOM 区块挪到正确位置 ── */
function _applySbOrder(){
  var m = sideMods();
  var map = { host: 'sbHostSect', servers: 'configSection',
              actions: 'quickActionsSection',
              // 老键兼容(老偏好里存的 short/quick): 都指向合并后的「快捷操作」区
              short: 'quickActionsSection', quick: 'quickActionsSection' };
  var anchor = null;                                  // 依次追加到 sb-scroll 里
  var scroll = document.getElementById('configSection');
  scroll = scroll ? scroll.parentNode : null;
  if (!scroll) return;
  var sessBox = document.getElementById('sbSessions');
  sessBox = sessBox ? sessBox.closest('.sb-sect') : null;
  m.secOrder.forEach(function(k){
    var el = (k === 'sess') ? sessBox : document.getElementById(map[k]);
    if (!el || !el.parentNode) return;
    if (anchor) anchor.parentNode.insertBefore(el, anchor.nextSibling);
    else scroll.insertBefore(el, scroll.firstChild);
    anchor = el;
  });
}

function _sideModApply(){
  var m = sideMods();
  var hs = document.getElementById('sbHostSect');
  if (hs) hs.style.display = (m.host === false) ? 'none' : '';
  var as = document.getElementById('quickActionsSection');
  if (as){
    /* v6.3.43 · 批 C: 「快捷操作」区显隐。注意它是**功能键声明式隐藏**的元素
       (data-hide-editions="community"): 我们放开时不能直接写 '' 把隐藏规则冲掉,
       必须让 applyEditionHides() 再跑一次(单一真源)。 */
    if (m.actions === false) as.style.display = 'none';
    else { as.style.display = ''; try { if (window.applyEditionHides) window.applyEditionHides(); } catch(e){} }
  }
  var sec = document.getElementById('sbSessions');
  if (sec){ var box = sec.closest('.sb-sect'); if (box) box.style.display = m.sess === false ? 'none' : ''; }
  try { renderHostInfo(); } catch(e){}
  try { renderShortcuts(); } catch(e){}
  try { _applySbOrder(); } catch(e){}
  try { _refreshPoolBrief(); } catch(e){}
}

/* 存储池简报: 60s 缓存, 供左栏「存储池状态」用(与总览同源: cpool_list) */
var _poolBriefAt = 0, _poolBriefBusy = false;
function _refreshPoolBrief(force){
  // v1.0.0 · 社区档无"智能存储池"键 → 不轮询 cpool_list(此前 60s 一次, 服务端日志刷"未知 action")
  if (g.__featInEdition && !g.__featInEdition('cloudpool')) return;
  if (_poolBriefBusy) return;
  if (!force && (Date.now() - _poolBriefAt) < 60000) return;
  _poolBriefBusy = true;
  g.send({ action: 'cpool_list' }, function(r){
    _poolBriefBusy = false;
    _poolBriefAt = Date.now();
    if (r && r.status === 'ok'){ window.__rpPools = r.pools || []; try { renderHostInfo(); } catch(e){} }
    else { try { console.warn('[sidebar] cpool_list 失败:', (r && r.msg) || '无响应'); } catch(e){} }
  });
}
function sideModMenu(){
  var pageKey = _sideModKey().replace('uni_side_mod_','');
  var w = sideMods();                                   // 工作副本(编辑中)
  var card = document.createElement('div');
  card.style.cssText = 'background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:16px 18px;width:400px;max-width:94vw;max-height:86vh;overflow:auto;box-shadow:0 18px 50px rgba(0,0,0,.35)';
  function secRow(k, label){
    return '<div class="smm-r"><label><input type="checkbox" data-sm="' + k + '"'
      + (w[k] !== false ? ' checked' : '') + '> ' + label + '</label>'
      + '<span class="smm-o"><button type="button" class="btn btn-xs" data-mv="up" data-sec="' + k + '" title="上移">↑</button>'
      + '<button type="button" class="btn btn-xs" data-mv="dn" data-sec="' + k + '" title="下移">↓</button></span></div>';
  }
  function itemRow(kind, k, label){
    return '<div class="smm-r"><label><input type="checkbox" data-smi="' + kind + ':' + k + '"'
      + (w[kind + 'Items'][k] !== false ? ' checked' : '') + '> ' + label + '</label>'
      + '<span class="smm-o"><button type="button" class="btn btn-xs" data-imv="up" data-kind="' + kind + '" data-k="' + k + '" title="上移">↑</button>'
      + '<button type="button" class="btn btn-xs" data-imv="dn" data-kind="' + kind + '" data-k="' + k + '" title="下移">↓</button></span></div>';
  }
  function paint(){
    var h = '<div style="font-size:11.5px;color:var(--text3);margin-bottom:8px">自定义「' + pageKey
      + '」页的左栏模块 · 当前页生效 · 勾选=显示, ↑↓=排序(即时预览)</div>';
    h += '<div class="smm-h">🧱 区块(顺序可调)</div>'
      + [['servers','🖧 服务器列表'], ['actions','⚡ 快捷操作'], ['sess','📡 活跃会话'],
         ['host','🏠 宿主机信息(默认隐藏)']].map(function(p){ return secRow(p[0], p[1]); }).join('');
    h += '<div class="smm-h">🏠 宿主机信息条目</div>'
      + w.hostOrder.map(function(k){
          var it = HOST_ITEMS.filter(function(x){ return x[0] === k; })[0];
          return it ? itemRow('host', k, it[1]) : '';
        }).join('');
    /* v6.3.43 · 批 C: 「快捷方式」与「快速操作」已合并 → 条目清单(含显示样式)统一在**个性化**里配,
       这里只留入口(不再维护第二份清单, 避免两处配置打架)。 */
    h += '<div class="smm-h">⚡ 快捷操作条目 / 样式</div>'
      + '<div style="font-size:11.5px;color:var(--text3);margin-bottom:6px">'
      + '条目清单与"按钮式 / 单列式"样式已统一到个性化, 点下面按钮直达。</div>'
      + '<div style="margin-bottom:4px"><button class="btn btn-xs" data-smact="toPersonalize">🎨 去个性化配置快捷操作</button></div>';
    h += '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">'
      + '<button class="btn btn-sm" data-smact="reset">恢复默认</button>'
      + '<button class="btn btn-sm" data-smact="cancel">关闭</button>'
      + '<button class="btn btn-sm btn-primary" data-smact="save">保存</button></div>';
    card.innerHTML = '<div style="font-size:13px;font-weight:600;margin-bottom:10px">⚙ 左栏模块 · ' + pageKey + '</div>' + h;
  }
  function persist(){
    try { localStorage.setItem(_sideModKey(), JSON.stringify(w)); } catch(e){}
    _sideModApply();
  }
  function moveIn(arr, k, dir){
    var i = arr.indexOf(k);
    if (i < 0) return;
    var j = dir === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= arr.length) return;
    var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  paint();
  var ov = document.createElement('div');
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:12000;display:flex;align-items:center;justify-content:center';
  ov.appendChild(card);
  ov.addEventListener('click', function(ev){
    if (ev.target === ov){ document.body.removeChild(ov); return; }
    var t = ev.target;
    var cb = t.closest ? t.closest('input[data-sm],input[data-smi]') : null;
    if (cb){
      if (cb.hasAttribute('data-sm')) w[cb.getAttribute('data-sm')] = cb.checked;
      else {
        var parts = cb.getAttribute('data-smi').split(':');
        w[parts[0] + 'Items'][parts[1]] = cb.checked;
      }
      persist();
      return;
    }
    var mv = t.closest ? t.closest('[data-mv]') : null;
    if (mv){ moveIn(w.secOrder, mv.getAttribute('data-sec'), mv.getAttribute('data-mv')); persist(); paint(); return; }
    var imv = t.closest ? t.closest('[data-imv]') : null;
    if (imv){
      var kind = imv.getAttribute('data-kind');
      moveIn(w[kind + 'Order'], imv.getAttribute('data-k'), imv.getAttribute('data-imv'));
      persist(); paint(); return;
    }
    var btn = t.closest ? t.closest('[data-smact]') : null;
    if (!btn) return;
    var act = btn.getAttribute('data-smact');
    if (act === 'toPersonalize'){
      document.body.removeChild(ov);
      try { switchTab('personalize'); } catch(e){}
      return;
    }
    if (act === 'reset'){
      try{ localStorage.removeItem(_sideModKey()); }catch(e){}
      w = _defMods();
      persist(); paint();
      if (g.toast) g.toast('✓ 已恢复默认', 'success', 1600);
      return;
    }
    if (act === 'save'){
      persist();
      renderSidebarSection(document.getElementById('configList'));
      if (g.toast) g.toast('✓ 左栏模块已更新(当前页)', 'success', 1800);
    }
    document.body.removeChild(ov);
  });
  document.body.appendChild(ov);
}

/* v6.3.5 · 公共侧栏的补拉机制(此前**只有它没有**) ——
   空列表时最多再自动重试两次(6s / 15s), 仍空则保持失败态(带手动重试), 不再静默定格。 */
var _sbRetryTimers = [];
function _armSidebarRetry(){
  if (_sbRetryTimers.length) return;
  [6000, 15000].forEach(function(ms){
    _sbRetryTimers.push(setTimeout(function(){
      try {
        if (!window.SP) return;
        var cl = document.getElementById('configList');
        if (!cl) return;
        if (cl.querySelector('.st-row')) return;              // 已经有行了, 不打扰
        SP.forgetAll();
        SP.renderSidebarSection(cl);
      } catch(e){}
      if (ms === 15000) _sbRetryTimers = [];
    }, ms));
  });
}
try {
  window.addEventListener('rp-ws-ready', function(){
    try {
      var cl = document.getElementById('configList');
      if (!cl || cl.querySelector('.st-row')) return;         // 只有"还是空的"才补拉
      if (window.SP){ SP.forgetAll(); SP.renderSidebarSection(cl); }
      try { if (window.rpRefreshShares) window.rpRefreshShares(true); } catch(e){}
    } catch(e){}
  });
} catch(e){}

async function renderSidebarSection(container){
  if(!container) return;
  /* v6.3.42 · 首帧不再留白 + 只写活容器(本轮实测钉死的两个成因):
     ① 传进来的容器可能是**已脱离文档**的旧节点(登录/面板重建后重挂) → 渲染进旧节点 =
        用户看到"左栏空白"且之后再也补不上 → 重新解析活容器。
     ② 此前是 **await list() 之后**才写容器 → await 期间整段全白(连"正在读取"都没有)。
        实测空白窗口 0.5~4.5s、最坏十余秒, 正是用户反馈的"左栏时有时无 / 显示缓慢"。
        现在先**同步**写加载占位, 数据到手再覆盖(不冒充"暂无服务器", 见 v6.3.5 口径)。 */
  if(!container.isConnected){
    var _live = document.getElementById('configList');
    if(!_live) return;
    container = _live;
  }
  if(!container.querySelector('.st-row') && !String(container.innerHTML).trim()){
    container.innerHTML = (window.rpState
      ? window.rpState({ state:'loading', msg:'载入服务器列表…' })
      : '<div class="st-loading">载入服务器列表…</div>');
  }
  /* v6.3.6 · 先应用左栏模块(宿主机信息 / 快捷方式 / 区块排序) —— 与服务器列表渲染无关,
     放在最前面保证任一路径(含空列表/失败态)都会把用户配置的模块摆好。 */
  try { _sideModApply(); } catch(e){ console.warn('[sidebar] sideModApply', e); }
  const c = await list();
  const byKey = sessionsByKey();
  const hidden = _sbHidden();
  const mode = (function(){ try { return localStorage.getItem('fonr_tree_mode') === 'fixed' ? 'fixed' : 'groups'; } catch(e){ return 'groups'; } })();

  /* ── v6.3.5 · 空列表不再"就地定格" ──
     用户报"左栏显示缓慢 / 时有时无 / 一会儿才有服务器": 根因是**公共侧栏没监听 `rp-ws-ready`**
     (连接中心/多云/远端/共享四个面板都监听了, 就它没有)。会话未就绪时 `sp_list` 取不到 →
     这里渲染出"暂无服务器 · 到连接中心添加"(**误导**: 明明有服务器, 只是还没就绪) →
     之后再没有任何东西触发重渲染 → 一直空到用户切页。
     现在: ① 未就绪/失败 → 显示**加载中/失败态(带重试)**, 不冒充"暂无服务器";
           ② 监听 rp-ws-ready 与登录完成 → 自动补拉一次; ③ 看门狗兜底(6s/15s 各重试一次)。 */
  if (!c.profiles.length){
    /* 三种"空"要区分开(不许混为一谈):
       · 取数失败(c.err) → 红字 + 重试(这是**错误**, 不是"没有服务器")
       · 取数成功但没有档案 → 如实说"暂无服务器"(并给添加入口)
       两种情况都挂看门狗 + 就绪广播补拉 —— 会话未就绪时的空是"还没到", 不是"没有"。 */
    var _err = (c && c.err) || '';
    var _retry = "SP.forgetAll();SP.renderSidebarSection(document.getElementById('configList'))";
    container.innerHTML = (_err
      ? (window.rpState
          ? window.rpState({ state: 'error', msg: '读取服务器列表失败: ' + _err, hint: '可能是会话未就绪或链路抖动', retry: _retry })
          : ('<div style="padding:8px 10px;font-size:12px;color:var(--text3)">读取失败</div>'))
      /* v6.16.2 批18 · 新装无服务器 = 正常初始态: 绿色引导新建, 不再像报错(用户实测反馈) */
      : ('<div style="padding:14px 10px;font-size:12.5px;line-height:2;color:var(--green)">'
          + '✓ 尚未添加服务器<br/>'
          + '<span style="color:var(--text2)">点左上角 <b>＋ 新建服务器</b> 创建第一台,<br/>或到「连接中心」统一添加。</span>'
          + '</div>'));
    _armSidebarRetry();
    return;
  }

  /* ══ v6.1.8 · 主路径: 公共 SrvTree 渲染(统一左栏方案 P3) ══
     全局侧栏服务器列表与 连接中心/多云文件管理 同一实现 —— 修一处全站生效。
     行为(fill 模式): 点服务器 = fillByGuid(当前页 key) 填入右侧连接配置表单
     (13 个 PANEL_FIELDS 页面通用, 备份中心全部子页在内); 拖拽 = sp_batch 改组;
     右键 = 断开/移除(委托 _spRowMenu); 折叠记忆沿用 sp_sb_expand 键(老状态无缝)。 */
  if (window.SrvTree){
    const byKey0 = sessionsByKey();
    const _prof = c.profiles.filter(function(p){ return !hidden[p.guid]; })
      .map(function(p){
        const _on = !!byKey0[sessionKey(p.hostname, p.ssh_port||22)];
        return Object.assign({}, p, { status: _on ? 'online' : (p.status || '') });
      });
    /* v6.3.6 · 总览 SSH 区自愈: 档案到手后若它还是空的, 用同一份档案补渲染 */
    try {
      if (window.Dashboard && Dashboard.patchSshFromProfiles && c.profiles.length){
        Dashboard.patchSshFromProfiles(c.profiles);
      }
    } catch(e){}
    var _mods = sideMods();
    SrvTree.render(container, { profiles: _prof, groups: c.groups }, {
      view: mode,
      showRows: true,
      quick: _mods.quick !== false,
      manage: false,            // 组管理(✎✕)在连接中心; 侧栏保持只读导航
      starSection: _mods.star !== false,   // 按类型视图 ⭐ 星标 区
      showTypeBadge: _mods.typeBdg,
      showGroupBadge: _mods.grpBdg,
      activeGuid: _activeGuid,
      expandKey: 'sp_sb_expand',
      /* v6.3.5 · 融合连接中心左树的强项: **拖拽到分组**在侧栏也能用(此前 onChanged 未传 →
         拖了不会刷新, 看着"没反应")。组管理(✎✕)仍留连接中心, 侧栏保持只读导航。 */
      onChanged: function(){
        try { SP.forgetAll(); } catch(e){}
        var cl = document.getElementById('configList');
        if (cl) SP.renderSidebarSection(cl);
      },
      onRowClick: function(guid, ev){
        _activeGuid = guid || '';
        try{ g._spActiveGuid = _activeGuid; }catch(e){}
        const el = ev && ev.target && ev.target.closest ? ev.target.closest('.st-row') : null;
        if (el && el.parentNode){
          el.parentNode.querySelectorAll('.st-row').forEach(function(x){ x.classList.remove('st-on'); });
          el.classList.add('st-on');
        }
        const panelEl = document.querySelector('.panel.active');
        const panelKey = panelEl ? panelEl.id.replace(/^panel-/,'') : 'transfer';
        fillByGuid(panelKey, guid).then(function(ok){
          if(!ok) return;
          const p0 = ((_cache&&_cache.profiles)||[]).find(function(x){return x.guid===guid;});
          if(g.toast && p0) g.toast('已填入 '+(p0.name||p0.hostname)+' → 当前页', 'info', 2200);
        });
      },
      onChanged: function(){ renderSidebarSection(container); }
    });
    /* 行右键(委托一次): 断开连接 / 从列表移除 —— 与旧侧栏同款 */
    _sideModApply();
    if (!container._stCtx){
      container._stCtx = true;
      container.addEventListener('contextmenu', function(ev){
        const row = ev.target.closest ? ev.target.closest('.st-row[data-guid]') : null;
        if (!row) return;
        ev.preventDefault();
        const p0 = (c.profiles || []).find(function(x){ return x.guid === row.getAttribute('data-guid'); });
        if (p0) _spRowMenu(ev, p0);
      });
    }
    return;
  }

  /* ↓ SrvTree 缺席时的旧实现兜底(脚本加载顺序异常时不空白) */
  let html = '';
  html += '<div style="display:flex;gap:3px;padding:2px 8px 6px">'
    +'<button class="btn btn-xs" style="flex:1" onclick="SP.quickAdd()">➕ 新建</button>'
    +'<button class="btn btn-xs" style="flex:1" onclick="switchTab(\'conn_center\')">🗂 管理</button>'
    +'<button class="btn btn-xs" style="flex:0 0 auto" title="添加服务器到列表 (恢复被移除的项)"'
    +' onclick="SP.showAddPicker()">➕⁺</button>'
    +'<button class="btn btn-xs" style="flex:0 0 auto" title="折叠服务器列表栏 (点左侧「› 服务器」竖条展开)"'
    +' onclick="toggleSidebarCollapse(true)">‹</button></div>';
  const visProfiles = c.profiles.filter(function(p){ return !hidden[p.guid]; });
  const starred = visProfiles.filter(function(p){return p.is_starred;});
  const ungrouped = visProfiles.filter(function(p){return !p.group_id;});
  /* v5.90.6 · 按类型视图: 主机/PVE/桌面/云存储/网络共享 (fixed 模式) */
  function _typeOf(p){
    var prot = (p.protocols_mask || []).join(',').toLowerCase();
    var k = String(p.kind || '').toLowerCase();
    if (k === 'cloud' || prot.indexOf('s3') >= 0 || prot.indexOf('seafile') >= 0) return 'cloud';
    if (prot.indexOf('smb') >= 0 || prot.indexOf('nfs') >= 0 || k === 'share') return 'share';
    if (prot.indexOf('pve') >= 0) return 'pve';
    if (prot.indexOf('rdp') >= 0 || prot.indexOf('vnc') >= 0) return 'desktop';
    return 'host';
  }
  const TYPE_SECS = [['host', '🐧 主机'], ['pve', '🖥 PVE 节点'], ['desktop', '🖥 桌面 / 远程'], ['cloud', '☁️ 云存储'], ['share', '🔗 网络共享']];
  function row(p, depth, gname){
    const on = !!byKey[sessionKey(p.hostname, p.ssh_port||22)];
    const dotC = on ? '#54d18c' : ((p.status==='online')?'#54d18c':(p.status==='offline'?'#ff5f5f':'#ccc'));
    const badges = (p.protocols_mask||[]).filter(function(m){return m!=='ssh';})
      .slice(0,3).map(function(m){return '<span style="font-size:8px;padding:0 2.5px;border-radius:2px;background:var(--bg3);color:var(--blue);margin-left:3px">'+String(m).toUpperCase()+'</span>';}).join('');
    /* v6.1.7 · 按类型视图行尾带"所属分组"徽章(类型×分组双维度互补: 类型视图也能看到部门归属) */
    const gBadge = gname ? '<span style="font-size:9px;padding:0 4px;border-radius:3px;background:var(--bg3);color:var(--text3);margin-left:3px;flex-shrink:0;max-width:64px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="所属分组">📁 '+String(gname).replace(/</g,'&lt;')+'</span>' : '';
    return '<div class="sidebar-item sp-row'+(_activeGuid===p.guid?' active':'')+'" data-guid="'+p.guid+'" draggable="true" style="cursor:pointer;padding:3px '+(10+depth*11)+'px;display:flex;align-items:center"'
      +' title="'+String(p.hostname||'').replace(/"/g,'')+':'+(p.ssh_port||22)+(on?' · 已连接':'')+'">'
      +'<span class="sp-dot" style="width:7px;height:7px;border-radius:50%;background:'+dotC+';display:inline-block;margin-right:5px;flex-shrink:0'+(on?';box-shadow:0 0 4px #54d18c':'')+'"></span>'
      +'<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+String(p.name||p.hostname||'').replace(/</g,'&lt;')+'</span>'
      +(on?'<span style="font-size:8px">🟢</span>':'')
      +(p.is_starred?'<span style="color:#f5c518;font-size:9px">★</span>':'')
      +gBadge+badges+'</div>';
  }
  const openState = (function(){
    try{
      var raw = JSON.parse(localStorage.getItem('sp_sb_expand')||'{}')||{};
      // v5.40.0 · 方案B修复: 残留 false 且分组已无子分组的 → 归位为展开(防永久隐藏)
      var cleaned = {};
      Object.keys(raw).forEach(function(k){
        if(raw[k] === false){
          var grp = c.groups.find(function(x){return x.guid===k;});
          var hasKids = grp && c.groups.some(function(x){return x.parent_id===k;});
          var hasProfiles = c.profiles.some(function(p){return p.group_id===k;});
          if(hasKids || hasProfiles) cleaned[k] = false;  // 合法折叠
          // 无内容 → 不记录(展开)
        }
      });
      // v5.79.0 · 清洗结果回写, 让残留键即时收敛(否则要等下一次手动 toggle)
      var rawKeys = Object.keys(raw).filter(function(k){return raw[k]===false;}).sort().join(',');
      if(rawKeys !== Object.keys(cleaned).sort().join(',')){
        try{ localStorage.setItem('sp_sb_expand', JSON.stringify(cleaned)); }catch(e2){}
      }
      return cleaned;
    }catch(e){ return {}; }
  })();
  function groupNode(gr, depth){
    const kids = c.groups.filter(function(x){return x.parent_id===gr.guid;});
    const direct = c.profiles.filter(function(p){return p.group_id===gr.guid;});
    // v5.79.0 · FIX: 旧递归 sub() 无返回值, n += undefined → 有子分组的组计数显示 NaN
    //   计数语义 = 本组+全部子孙分组内的档案总数(与子组行的计数口径一致)
    let n = direct.length + (function sub(gid){
      let s = 0;
      c.groups.filter(function(x){return x.parent_id===gid;}).forEach(function(k){
        s += c.profiles.filter(function(p){return p.group_id===k.guid;}).length + sub(k.guid);
      });
      return s;
    })(gr.guid);
    const open = openState[gr.guid] !== false;
    // v5.40.0 · 方案B修复: ▼/▶ 一律渲染(无子分组也画), 点击整行(不只箭头)切换
    let h = '<div class="sp-gnode" data-gid="'+gr.guid+'" style="display:flex;align-items:center;padding:2px '+(8+depth*11)+'px;cursor:pointer;border-radius:5px" '
      +'onclick="SP.sbToggle(\''+gr.guid+'\')" '
      +'ondragover="event.preventDefault();this.style.background=\'var(--bg3)\'" ondragleave="this.style.background=\'\'" ondrop="SP.sbDrop(event,\''+gr.guid+'\')">'
      +'<span style="width:10px;font-size:8px;color:var(--text3)">'+(open?'▼':'▶')+'</span>'
      +'<span style="flex:1;font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">📁 '+String(gr.name).replace(/</g,'&lt;')+'</span>'
      +'<span style="font-size:9.5px;color:var(--text3)">'+n+'</span></div>';
    if(open){
      direct.forEach(function(p){ h += row(p, depth+1); });
      kids.forEach(function(k){ h += groupNode(k, depth+1); });
    }
    return h;
  }
  if(starred.length){
    html += '<div class="sidebar-label" style="display:flex;align-items:center;gap:4px"><span>⭐ 星标</span><span style="margin-left:auto;color:var(--text3);font-size:10px">'+starred.length+'</span></div>';
    starred.forEach(function(p){ html += row(p, 0); });
  }
  // v5.90.6 · 视图 = 按分组(原分组树) 或 按类型(主机/PVE/桌面/云/共享)
  if (mode === 'fixed'){
    html += '<div class="sidebar-label"><span>按类型</span></div>';
    /* v6.1.7 · guid→组名映射: 按类型视图行尾显示所属分组徽章(类型×分组双维度互补) */
    var _gnameMap = {};
    (c.groups || []).forEach(function(gr){ _gnameMap[gr.guid] = gr.name || ''; });
    TYPE_SECS.forEach(function(ts){
      var items = visProfiles.filter(function(p){ return _typeOf(p) === ts[0]; });
      if (!items.length) return;
      html += '<div class="sidebar-label" style="margin-top:4px"><span>' + ts[1]
        + '<span style="margin-left:auto;color:var(--text3);font-size:10px">' + items.length + '</span></span></div>';
      items.forEach(function(p){ html += row(p, 0, p.group_id ? _gnameMap[p.group_id] : ''); });
    });
    html += '<div class="sidebar-label" style="margin-top:6px"><span>⭐ 星标</span><span style="margin-left:auto;color:var(--text3);font-size:10px">' + starred.length + '</span></div>';
    starred.forEach(function(p){ html += row(p, 0, p.group_id ? _gnameMap[p.group_id] : ''); });
  } else {
  html += '<div class="sidebar-label" style="display:flex;align-items:center;gap:4px"><span>📁 分组</span>'
    +'<span style="margin-left:auto;cursor:pointer;font-size:10px;color:var(--text3)" title="连接中心管理分组" onclick="switchTab(\'conn_center\')">＋</span></div>';
  const roots = c.groups.filter(function(x){return !x.parent_id;})
    .sort(function(a,b){return (a.sort_order||0)-(b.sort_order||0)||String(a.name).localeCompare(String(b.name));});
  roots.forEach(function(gr){ html += groupNode(gr, 0); });
  if(ungrouped.length){
    html += '<div class="sidebar-label" style="display:flex;align-items:center;gap:4px"><span>📄 未分组</span><span style="margin-left:auto;color:var(--text3);font-size:10px">'+ungrouped.length+'</span></div>';
    ungrouped.forEach(function(p){ html += row(p, 0); });
  }  // v5.90.6 · end 按分组分支
  }
  if(!c.profiles.length){
    html += '<div style="padding:8px 12px;font-size:11px;color:var(--text3);line-height:1.7">暂无服务器档案<br>点「➕ 新建」或在<a href="javascript:;" style="color:var(--blue)" onclick="switchTab(\'conn_center\')">连接中心</a>批量导入</div>';
  }
  container.innerHTML = html;
  // v5.90.6 · 行右键菜单 (委托): 断开连接 / 从列表移除
  container.querySelectorAll('.sp-row[data-guid]').forEach(function(el){
    el.oncontextmenu = function(ev){
      var g = el.dataset.guid;
      var p0 = (c.profiles || []).find(function(x){ return x.guid === g; });
      if (p0) _spRowMenu(ev, p0);
    };
  });
  container.querySelectorAll('.sp-row').forEach(function(r){
    r.onclick = function(){
      const guid = r.getAttribute('data-guid');
      container.querySelectorAll('.sp-row').forEach(function(x){x.classList.remove('active');});
      r.classList.add('active');
      const panelEl = document.querySelector('.panel.active');
      const panelKey = panelEl ? panelEl.id.replace(/^panel-/,'') : 'transfer';
      fillByGuid(panelKey, guid).then(function(ok){
        if(!ok) return;
        const p = ((_cache&&_cache.profiles)||[]).find(function(x){return x.guid===guid;});
        if(g.toast && p) g.toast('已填入 '+(p.name||p.hostname)+' → 当前页', 'info', 2200);
      });
    };
    r.ondragstart = function(ev){ try{ ev.dataTransfer.setData('text/sp-guid', r.getAttribute('data-guid')); }catch(e){} };
  });
}
function sbToggle(gid){
  let st = {}; try{ st = JSON.parse(localStorage.getItem('sp_sb_expand')||'{}')||{}; }catch(e){}
  st[gid] = st[gid] === false;
  try{ localStorage.setItem('sp_sb_expand', JSON.stringify(st)); }catch(e){}
  const cl = document.getElementById('configList');
  if(cl) renderSidebarSection(cl);
}
async function sbDrop(ev, gid){
  ev.preventDefault();
  let guid = '';
  try{ guid = ev.dataTransfer.getData('text/sp-guid'); }catch(e){}
  if(!guid) return;
  const r = await rpc('sp_batch',{op:'move', guids:[guid], group_id:gid});
  if(r.status==='ok' && g.toast) g.toast('✓ 已移入分组', 'success', 1800);
  forgetAll();
  const cl = document.getElementById('configList');
  if(cl) await renderSidebarSection(cl);
}
async function quickAdd(){
  if(g.switchTab) g.switchTab('conn_center');
  setTimeout(function(){
    try {
      if (g.ConnCenter && g.ConnCenter.newPickerOpen) { g.ConnCenter.newPickerOpen(); return; }
      if (g.ConnCenter && g.ConnCenter.editorOpen) g.ConnCenter.editorOpen();
    } catch(e){}
  }, 400);
}

/* ═══ 事件订阅 ═══ */
function hook(){
  const EB = g.EventBus;
  if(!EB || EB.__spHooked) return;
  EB.__spHooked = true;
  EB.on('profile.changed', function(ev){
    forgetAll();
    // 当前面板 host 命中变更档案 → 重填 (身份字段, 不动用户手输)
    const panelEl = document.querySelector('.panel.active');
    const panelKey = panelEl ? panelEl.id.replace(/^panel-/,'') : 'transfer';
    const PF = g.PANEL_FIELDS||{}; const f = PF[panelKey];
    if(!f || !ev) return;
    const hostEl = document.getElementById(f.host);
    const curHost = hostEl ? (hostEl.value||'').trim() : '';
    if(!curHost) return;
    list(true).then(function(c){
      const p = (c.profiles||[]).find(function(x){return x.hostname===curHost;});
      if(!p) return;
      // 只刷新能力块/extras 与身份字段, 不触碰用户正在编辑的密码框
      get(p.guid).then(function(full){
        if(!full) return;
        fillPanel(panelKey, full);
      });
    });
  });
  ['profile.deleted','group.changed'].forEach(function(t){
    EB.on(t, function(){ forgetAll(); });
  });
  EB.on('conn.changed', function(){ forgetAll(); refreshSessions(); });   // 会话变化 → 凭据来源+绿点+胶囊同步
}

/* v5.35.0 · G3: 兼容旧面板的"服务器列表"数据源 (db_config_list 替代)
   返回旧 msg 形状 {status:'ok', configs:[...]}; 密码不下发 (执行时走 resolve) */
async function serverRows(){
  const c = await list();
  return {status:'ok',
          configs: c.profiles.filter(function(p){
            // v5.50.0 修: 原按 kind!=='storage' 过滤 → 有 SSH 能力的存储档案(如 Seafile 主机)被
            //   一并滤掉, 双栏/DM 里选不到该机器。改为"按能力过滤": 有 ssh 能力即保留。
            var mask = p.protocols_mask || [];
            if (mask.indexOf('ssh') >= 0) return true;
            return p.kind !== 'storage' && String(p.ssh_port||22) !== '0';
          }).map(function(p){
            return {id: p.guid, uuid: p.guid, name: p.name || p.hostname,
                    host: p.hostname, port: String(p.ssh_port || 22),
                    user: p.ssh_user || 'root', auth_type: p.ssh_auth_type || 'pass',
                    auth_value: '', panel: 'transfer', panel_scope: '',
                    _guid: p.guid, _mask: p.protocols_mask || []};
          })};
}
/* ═══ v5.93.0 · 统一列表获取 RPList (用户要求: 空结果缓存收口成一处) ═══
   症状: sp_list / hub_list / share_list 各处自己写"取不到就当空" →
         界面时有时无, 刷新一次变一个样(用户报"刷新不出服务器/共享列表消失又回来")。
   规则(单一实现, 所有列表共用):
     ① 失败 or 空结果 **不覆盖**上次成功快照 —— 空结果既不入缓存, 也不清空界面;
     ② 空/失败自动短重试(默认 2 次, 间隔 1.2s);
     ③ 返回永远带 ok / stale / err: 界面必须能区分"真的空"与"没取到", 不许静默回落;
     ④ 同一 key 的并发请求合并(避免多个面板同时打后端)。 */
const _listSnap = {};     // key → {data, at, ok, err, raw}
const _listBusy = {};     // key → Promise
const _listSeq = {};      // v6.16.14 · key → 请求序号: 并发/新旧请求乱序回来时, 只让最新一次写快照
                          //   (实测: 共享刚创建完后的刷新并入了飞行中的旧请求 → 渲染旧空列表, 用户看到"已创建但不显示")
function _listSleep(ms){ return new Promise(function(f){ setTimeout(f, ms); }); }
const RPList = {
  snap: function(key){ return _listSnap[key] || null; },
  forget: function(key){
    if (key) { delete _listSnap[key]; return; }
    for (const k in _listSnap) delete _listSnap[k];
  },
  load: async function(key, action, params, opts){
    opts = opts || {};
    const pick = opts.pick || action;
    const retry = (opts.retry == null ? 2 : opts.retry);
    const gap = (opts.gap == null ? 1200 : opts.gap);
    const need = (opts.requireNonEmpty !== false);
    // v6.16.14 · opts.fresh: 写操作(新建/删除/挂载)后的刷新必须**另起新请求**,
    //   不能并入飞行中的旧请求(否则拿到的是写之前的旧数据); 同时用序号保证旧请求晚回也不覆盖新结果。
    if (_listBusy[key] && !opts.fresh) return _listBusy[key];
    const seq = (_listSeq[key] = (_listSeq[key] || 0) + 1);
    const run = (async function(){
      let raw = null, arr = null, lastErr = '';
      for (let i = 0; i <= retry; i++){
        try {
          // v5.94.0 · transport:'dir' → 目录类 action(share_list/mounts_list/hub_list) 必须走 rpcDirAction,
          //   否则响应 type 不在 send() 白名单里, Promise 永远挂起(历史踩坑, 见 key_picker)
          if (opts.transport === 'dir' && typeof g.rpcDirAction === 'function'){
            raw = await Promise.resolve(g.rpcDirAction(action, params || {}, opts.timeout || 20000));
          } else {
            raw = await rpc(action, params || {});
          }
        } catch (e) { raw = {status:'error', msg:String(e)}; }
        const ok = !!(raw && raw.status === 'ok');
        arr = ok ? (raw[pick] || []) : null;
        // v6.16.2 批18 · acceptEmpty: 调用成功但列表为空 = 真的没有(如新装无服务器),
        //   不再按"可疑空"重试并报错 —— 用户看到的是绿色新建引导而不是红字失败
        if (ok && opts.acceptEmpty) break;
        if (ok && (!need || (arr && arr.length))) break;
        lastErr = ok ? (pick + ' 返回空列表') : String((raw && (raw.msg || raw.code)) || '调用失败');
        if (i < retry) await _listSleep(gap);
      }
      // "持久空"是否算真值: sp_list/hub_nodes 空=可疑(回落上次成功); share_list 空可能是真的删光了
      const good = !!(arr && (!need || arr.length))
                   || !!(opts.acceptSettledEmpty && raw && raw.status === 'ok')
                   || !!(opts.acceptEmpty && raw && raw.status === 'ok');
      const prev = _listSnap[key];
      const _write = function(val){
        if (seq === _listSeq[key]) _listSnap[key] = val;   // 只有最新一次请求可写快照
        return val;
      };
      if (good){
        return _write({data: arr, at: Date.now(), ok: true, err: '', raw: raw});
      }
      if (prev && prev.ok && prev.data && prev.data.length){
        // 明确回报"这次没拿到, 用的是上次成功的数据" —— 界面据此提示, 不假装成功
        return {data: prev.data, at: prev.at, ok: true, stale: true, err: lastErr, raw: raw};
      }
      return _write({data: [], at: Date.now(), ok: false, err: lastErr, raw: raw});
    })();
    _listBusy[key] = run;
    try { return await run; } finally { if (_listBusy[key] === run) delete _listBusy[key]; }
  },
};
g.RPList = RPList;

g.SP = {
  serverRows:serverRows,
  list:list, get:get, resolve:resolve, cachedCreds:cachedCreds,
  forget:forget, forgetAll:forgetAll,
  // v5.58.0 · 供连接中心等"直连 sp_save"的写入方主动失效 30s 缓存
  invalidateCache:function(){ _cache = null; },
  refreshSessions:refreshSessions, renderCapsule:renderCapsule, refreshHostDots:refreshHostDots,
  injectSessionSection:injectSessionSection, renewSession:renewSession, closeSession:closeSession,
  openConnCenter:openConnCenter,
  sbToggle:sbToggle, sbDrop:sbDrop, quickAdd:quickAdd,
  isConnected:isConnected, get sessions(){ return _sessions; },
  fillPanel:fillPanel, fillByGuid:fillByGuid, collectPanel:collectPanel, saveFromPanel:saveFromPanel,
  renderSidebarSection:renderSidebarSection,
  get activeGuid(){ return _activeGuid; },
  setActiveGuid:function(gid){ _activeGuid=gid||''; try{g._spActiveGuid=_activeGuid;}catch(e){} },
  get profiles(){ return (_cache&&_cache.profiles)||[]; },
  get groups(){ return (_cache&&_cache.groups)||[]; },
  _hook:hook,
};
document.addEventListener('DOMContentLoaded', function(){
  setTimeout(function(){
    hook();
    refreshSessions();                        // 首屏会话拉取 (胶囊/绿点; 未登录会被拒 → 自动重试)
    try { startSessionPolling(); } catch(e){}   // v1.0.0 · 5s 定时刷新(刷新/重登/到期都能自愈)
    setInterval(refreshSessions, 30000);      // 兜底轮询 (conn.changed 为主驱动)
  }, 1500);
});

/* v5.90.6 · 侧栏视图切换/添加选择器 (须在 g.SP 导出之后附加) */
window.SP = window.SP || {};
window.SP.showAddPicker = _spAddPicker;
/* v5.91.3 · 暴露服务器列表隐藏名单: 多云文件管理左栏右键「移除/添加服务器」与侧栏共用同一份,
   两处行为与状态完全一致 (单一真源, 不各存一份) */
window.SP.sbHidden = _sbHidden;
window.SP.sbSetHidden = function(guid, on){
  _sbSetHidden(guid, on);
  try { renderSidebarSection(document.getElementById('configList')); } catch(e){}
};
window.SP.renderSidebar = function(){ renderSidebarSection(document.getElementById('configList')); };
window.SP.renderHostInfo = renderHostInfo;   // v6.3.6 · 宿主机信息(供 system_stats 更新后调用)
window.SP.sideModApply    = _sideModApply;   // v6.3.6 · 应用左栏模块设置(显隐+排序)
window.SP.sideModMenu = sideModMenu;   // v6.1.9 · 左栏模块自定义菜单(按页面)
window.SP.startSessionPolling = startSessionPolling;   // v1.0.0 · 会话状态 5s 定时刷新(登录后由 app.js 启动)

/* ═══ v1.0.0 · 服务器列表「显示样式」配置 (用户要求) ═══════════════════════
   可选: 仅名称(默认) / 名称 + IP。存 localStorage('srv_label_mode'), 立即重绘左树。
   作用范围: 所有用 SrvTree 渲染的服务器列表(数据总览/连接中心/文件与传输左栏)。 */
var SRV_LABEL_KEY = 'srv_label_mode';
function srvLabelMode(){
  try { return localStorage.getItem(SRV_LABEL_KEY) === 'name_ip' ? 'name_ip' : 'name'; }
  catch(e){ return 'name'; }
}
window.srvLabelMode = srvLabelMode;
function rowLabelMenu(ev){
  if (ev && ev.stopPropagation) ev.stopPropagation();
  var old = document.getElementById('srvLabelMenu'); if (old){ old.remove(); return; }
  var m = document.createElement('div');
  m.id = 'srvLabelMenu';
  var r = (ev && ev.target && ev.target.getBoundingClientRect) ? ev.target.getBoundingClientRect() : {left: 40, bottom: 120};
  m.style.cssText = 'position:fixed;left:' + Math.round(r.left) + 'px;top:' + Math.round(r.bottom + 4)
    + 'px;z-index:100000;background:var(--bg2);border:1px solid var(--border);border-radius:8px;'
    + 'box-shadow:0 12px 30px rgba(0,0,0,.32);padding:8px 10px;font-size:12px;min-width:190px';
  function row(val, label, hint){
    var on = (srvLabelMode() === val);
    return '<label style="display:flex;align-items:center;gap:6px;padding:5px 4px;cursor:pointer;border-radius:6px">'
      + '<input type="radio" name="srvLabelMode" value="' + val + '"' + (on ? ' checked' : '') + '>'
      + '<span>' + label + '</span><span style="color:var(--text3);font-size:10.5px;margin-left:auto">' + hint + '</span></label>';
  }
  m.innerHTML = '<div style="font-size:11px;color:var(--text3);margin:0 0 4px">服务器列表显示样式</div>'
    + row('name', '仅名称', '默认') + row('name_ip', '名称 + IP', '如 web-01 · 10.0.0.21');
  document.body.appendChild(m);
  m.addEventListener('click', function(e){ e.stopPropagation(); });
  m.addEventListener('change', function(e){
    var v = e.target && e.target.value;
    if (!v) return;
    try { localStorage.setItem(SRV_LABEL_KEY, v === 'name_ip' ? 'name_ip' : 'name'); } catch(_){}
    m.remove();
    try { renderSidebarSection(document.getElementById('configList')); } catch(_){}
    try { if (window.ConnCenter && ConnCenter.refresh) ConnCenter.refresh(); } catch(_){}
    try { if (g.toast) g.toast('已切换为「' + (v === 'name_ip' ? '名称 + IP' : '仅名称') + '」', 'success', 1800); } catch(_){}
  });
  setTimeout(function(){
    document.addEventListener('click', function _away(){ try { m.remove(); } catch(_){}; document.removeEventListener('click', _away); });
  }, 0);
}
window.SP.rowLabelMenu = rowLabelMenu;

/* ═══ v6.3.43 · 批 C · 侧栏右键菜单(与多云文件管理同款) ═══════════════════════
   用户要求: "数据总览左侧面板的新建服务器、导入等菜单全部放到右键菜单里, 类似多云文件管理"。
   原头部那排按钮(新建/导入/导出/＋⁺)已收进来; 头部只留「＋ 新建」+「‹ 折叠」+「⋯」(本菜单)。
   菜单实现在公共件 window.rpCtxMenu(与连接中心左栏同一份)。 */
function sideCtxMenu(ev){
  if (!window.rpCtxMenu) return;
  var mode = 'groups';
  try { mode = localStorage.getItem('fonr_tree_mode') === 'fixed' ? 'fixed' : 'groups'; } catch(e){}
  window.rpCtxMenu(ev, [
    { icon:'➕', t:'新建服务器', hint:'新建一份服务器档案', fn:function(){
        if (window.ConnCenter && ConnCenter.editorOpen) ConnCenter.editorOpen(); } },
    { icon:'📥', t:'导入配置', hint:'从 JSON 导入服务器档案', fn:function(){
        if (window.ConnCenter && ConnCenter.importOpen) ConnCenter.importOpen(); } },
    { icon:'📤', t:'导出配置', hint:'导出当前服务器档案', fn:function(){
        if (window.ConnCenter && ConnCenter.exportOpen) ConnCenter.exportOpen(); } },
    { icon:'🔄', t:'从旧配置迁移', hint:'把其它页面已保存的服务器导入列表', fn:function(){
        if (window.ConnCenter && ConnCenter.syncFromConfigs) ConnCenter.syncFromConfigs(); } },
    { icon:'＋', t:'恢复被移除的服务器', hint:'从隐藏名单里挑回来', fn:function(){
        if (window.SP && SP.showAddPicker) SP.showAddPicker(); } },
    { sep:true },
    { icon:'▦', t:(mode === 'fixed' ? '切换为「按分组」' : '切换为「按类型」'), fn:function(){
        try { setSrvTreeMode(mode === 'fixed' ? 'groups' : 'fixed'); } catch(e){} } },
    { icon:'⚡', t:'一键连接', hint:'连接当前列表(远程桌面除外)', fn:function(){
        if (window.ConnCenter && ConnCenter.oneKeyConnect) ConnCenter.oneKeyConnect(); } },
    { icon:'🗂', t:'打开连接中心', fn:function(){ try { switchGroup('storage_g'); switchTab('conn_center'); } catch(e){} } },
    { sep:true },
    { icon:'🎨', t:'左栏模块设置', hint:'勾选/排序/宿主机显隐', fn:sideModMenu },
    { icon:'⟳', t:'刷新列表', fn:function(){ try { SP.forgetAll(); SP.renderSidebarSection(document.getElementById('configList')); } catch(e){} } },
    { icon:'‹', t:'折叠侧栏', fn:function(){ try { toggleSidebarCollapse(true); } catch(e){} } },
  ]);
}
window.SP.sideCtxMenu = sideCtxMenu;

/* v6.3.43 · 批 C · 一次性迁移: 把 6.3.43 之前保存过的左栏偏好里的 `host` 关掉一次
   (用户要求"宿主机信息默认不显示"; 只改默认值对**已有偏好**无效, 所以显式迁移一次;
   之后用户在模块设置里手动打开的选择会正常保存, 不再被迁移覆盖 —— 迁移只跑一次)。 */
(function(){
  try {
    if (localStorage.getItem('rp_side_host_migrated_v1') === '1') return;
    var touched = 0;
    for (var i = 0; i < localStorage.length; i++){
      var k = localStorage.key(i);
      if (!k || k.indexOf('uni_side_mod_') !== 0) continue;
      try {
        var o = JSON.parse(localStorage.getItem(k) || '{}') || {};
        o.host = false;
        localStorage.setItem(k, JSON.stringify(o));
        touched++;
      } catch(e){}
    }
    localStorage.setItem('rp_side_host_migrated_v1', '1');
    if (touched) console.info('[sidebar] v6.3.43 迁移: 已把', touched, '份左栏偏好中的「宿主机」置为默认隐藏');
  } catch(e){}
})();
})(window);
