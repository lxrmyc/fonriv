/* ============================================================================
 * tri_pane_transfer.js · v4.38.21 (修订)
 * 三列文件传输面板：① 本地浏览 | ② 传输项列表 | ③ 远端浏览+服务器列表
 *
 * v4.38.21 修订:
 *   - 修复本地栏 list_dir "正在加载" 死循环：load() 在 WS 断开时发不出去；用 send() 包裹+重试机制
 *   - 修复远端连接：connect() 后 srvHost 等字段写入并触发 change，让 FileBrowser 读到
 *   - 中间栏顶部色与本地栏一致（var(--cyan)）
 *   - 传输方向切换：up=本地左+远端右；down=远端左+本地右；sync=两栏都显示
 *   - 三列交界处加左右拖拽按钮（grip），可手动调整列宽
 *   - 服务器列表条 + 远端连接 真正可用
 * ========================================================================== */
(function(){
  'use strict';

  var _host = null;
  var _leftPane = null;       // 当前左栏（可能是本地或远端，取决于方向）
  var _rightPane = null;      // 当前右栏
  var _leftSide = 'local';    // 'local' | 'remote' (当前左栏代表哪一侧)
  var _rightSide = 'remote';
  var _items = [];
  var _onStart = null;
  var _onChange = null;
  var _servers = [];
  var _activeServerId = null;
  var _activeCloud = null;    // v4.41.2 · 当前连接的 ☁ 远端存储行 (null=非云)
  var _loaded = false;
  var _direction = 'up';      // 'up' (local→remote) | 'down' (remote→local) | 'sync' (双向)
  var _widths = { left: 1, mid: 1.2, right: 1 };
  var _ccSet = {};  // v5.33.1 · 连接中心已连接 host:port 集合  // 默认 grid 比例
var _STORAGE_KEY = 'tri_pane_items_v1';
  var _STORAGE_WIDTHS = 'tri_pane_widths_v1';
  // v6.16.12 · 拖拽条取消 → 历史比例值不再使用, 直接清掉(避免残留误导)
  try { localStorage.removeItem('tri_pane_widths_v1'); } catch(e){}
  var _STORAGE_DIRECTION = 'tri_pane_direction_v1';

  function _uuid(){
    return 'tp_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2,8);
  }
  function _esc(s){
    return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function _fmtSize(b){
    if (b == null || isNaN(b)) return '';
    var n = Number(b);
    if (n < 1024) return n + ' B';
    if (n < 1024*1024) return (n/1024).toFixed(1) + ' KB';
    if (n < 1024*1024*1024) return (n/1024/1024).toFixed(1) + ' MB';
    if (n < 1024*1024*1024*1024) return (n/1024/1024/1024).toFixed(2) + ' GB';
    return (n/1024/1024/1024/1024).toFixed(2) + ' TB';
  }

  // ==========================================================================
  // 持久化
  // ==========================================================================
  function _loadItems(){
    try {
      var raw = localStorage.getItem(_STORAGE_KEY);
      if (!raw) return [];
      var arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch(e){ return []; }
  }
  function _saveItems(){
    try { localStorage.setItem(_STORAGE_KEY, JSON.stringify(_items)); } catch(e){}
  }
  function _loadWidths(){
    try {
      var raw = localStorage.getItem(_STORAGE_WIDTHS);
      if (raw) _widths = JSON.parse(raw);
    } catch(e){}
  }
  function _saveWidths(){
    try { localStorage.setItem(_STORAGE_WIDTHS, JSON.stringify(_widths)); } catch(e){}
  }
  function _loadDirection(){
    try {
      var d = localStorage.getItem(_STORAGE_DIRECTION);
      if (d === 'up' || d === 'down' || d === 'sync') _direction = d;
    } catch(e){}
  }
  function _saveDirection(){
    try { localStorage.setItem(_STORAGE_DIRECTION, _direction); } catch(e){}
  }

  // ==========================================================================
  // WS ready 探测（修复 list_dir 死循环）
  // ==========================================================================
  function _wsReady(){
    try { return window.ws && window.ws.readyState === 1; } catch(e){ return false; }
  }
  function _wsWaitReady(maxMs){
    return new Promise(function(resolve){
      var t0 = Date.now();
      (function tick(){
        if (_wsReady()) return resolve(true);
        if (Date.now() - t0 > (maxMs||5000)) return resolve(false);
        setTimeout(tick, 200);
      })();
    });
  }

  // ==========================================================================
  // ② 列表：增删改
  // ==========================================================================
  // v5.7.0 · 路径规范化: 折叠 /../ 与重复斜杠 (df 挂载点经 ".." 上溯后会留下 /a/b/../b 这类路径,
  //   直接送给 rsync 会导致源不可达 → 退出码 23 "传输异常终止")
  function _normPath(p){
    try {
      var str = String(p == null ? '' : p).replace(/\/{2,}/g, '/');
      var isDir = /\/$/.test(str) && str.length > 1;
      var abs = str.charAt(0) === '/';
      var out = [];
      str.split('/').forEach(function(seg){
        if (!seg || seg === '.') return;
        if (seg === '..'){
          if (out.length && out[out.length-1] !== '..') out.pop();
          else if (!abs) out.push('..');
          return;
        }
        out.push(seg);
      });
      var res = (abs ? '/' : '') + out.join('/');
      if (!res) res = '/';
      if (isDir && res !== '/') res += '/';
      return res;
    } catch(e){ return p; }
  }
  function _normItem(it){
    try {
      if (!it) return it;
      if (it.src) it.src = _normPath(it.src);
      if (it.dst && String(it.dst).trim() !== '/') it.dst = _normPath(it.dst);
      return it;
    } catch(e){ return it; }
  }
  /* v5.31.0 · 方向自适应 —— 用户从哪一栏「加入传输项」, 就以那一栏为源自动切方向。
     只更新方向状态与按钮高亮, **不重建 panes** (重建会清掉用户刚导航的目录, 体验更差)。
     反向也成立: 页面上的方向按钮 → setDirection() → _rebuildPanes() 会真实换栏,
     两边状态始终一致。 */
  function _dirButtonMap(d){
    return {up:'dirUp', down:'dirDown', cross:'dirCross', same:'dirSame', sync:'dirSync'}[d];
  }
  function _mapDirBySides(srcSide, dstSide){
    if (srcSide === 'local' && dstSide === 'remote') return 'up';
    if (srcSide === 'remote' && dstSide === 'local') return 'down';
    if (srcSide === 'remote' && dstSide === 'remote') return 'cross';
    if (srcSide === 'local' && dstSide === 'local') return 'same';
    return 'up';
  }
  function _autoDirectionBySource(fromLeft){
    var src = fromLeft ? _leftSide : _rightSide;
    var dst = fromLeft ? _rightSide : _leftSide;
    var d = _mapDirBySides(src, dst);
    if (d === _direction) return d;
    _direction = d;
    _saveDirection();
    try {
      ['up','down','cross','same','sync'].forEach(function(k){
        var btn = document.getElementById(_dirButtonMap(k));
        if (btn) btn.classList.toggle('active', d === k);
      });
      var lbl = ({up:'本地 → 远端', down:'远端 → 本地', cross:'远端 → 远端',
                  same:'本地 → 本地', sync:'双向同步'})[d] || d;
      _toast('方向已按来源自动切换: ' + lbl, 'info');
    } catch(e){}
    return d;
  }

  function addItem(item){
    if (!item) return false;
    if (typeof item === 'string'){
      item = { src: item, dst: '', server: _activeServerId || 'local', mode: _direction === 'down' ? 'pull' : (_direction === 'sync' ? 'sync' : 'push') };
    }
    if (!item.src) return false;
    if (!item.id) item.id = _uuid();
    if (!item.dst) item.dst = '';
    if (!item.server) item.server = _activeServerId || 'local';
    if (!item.mode) item.mode = _direction === 'down' ? 'pull' : (_direction === 'sync' ? 'sync' : 'push');
    if (item.addedAt == null) item.addedAt = Date.now();
    _normItem(item);   // v5.7.0 · 规范化 src/dst
    for (var i=0;i<_items.length;i++){
      if (_items[i].src === item.src && (_items[i].server||'') === (item.server||'') && (_items[i].dst||'') === (item.dst||'')){
        return false;
      }
    }
    _items.push(item);
    _fireChange();
    return true;
  }
  function addItems(arr){
    if (!arr) return 0;
    if (!Array.isArray(arr)) arr = [arr];
    var added = 0;
    for (var i=0;i<arr.length;i++){
      if (addItem(arr[i])) added++;
    }
    return added;
  }
  function removeItem(id){
    for (var i=0;i<_items.length;i++){
      if (_items[i].id === id){ _items.splice(i,1); _fireChange(); return true; }
    }
    return false;
  }
  function removeSelected(){
    var n = 0;
    _host.querySelectorAll('.tp-item-check:checked').forEach(function(c){
      var id = c.getAttribute('data-id');
      if (removeItem(id)) n++;
    });
    return n;
  }
  function clearItems(){
    _items = [];
    _fireChange();
  }
  function getItems(){ return _items.slice(); }
  function _fireChange(){
    _saveItems();
    renderList();
    try { if (typeof _onChange === 'function') _onChange(_items.slice()); } catch(e){}
  }

  // ==========================================================================
  // 加项辅助
  // ==========================================================================
  // 当前远端 cwd（用于"自动作为 dst"）
  var _remoteCwd = '/';
  var _localCwd  = '/';
  // v4.38.21 rev · 用户在远端栏点选的目标目录（覆盖 _remoteCwd）
  var _targetDir = null;  // null 表示用 _remoteCwd；非 null 是用户显式选的 dst
  function _setTargetDir(p, isRemote){
    if (isRemote){
      _targetDir = p || null;
    } else {
      _targetDir = p || null;
    }
    _applyTargetDir();
  }
  function _applyTargetDir(){
    // 1) 视觉提示
    var panes = _host ? _host.querySelectorAll('.tp-grid .dpb-pane[data-side="remote"]') : [];
    panes.forEach(function(pane){
      // 显示"目标"行
      var ind = pane.querySelector('.dpb-target-ind');
      if (!ind){
        ind = document.createElement('div');
        ind.className = 'dpb-target-ind';
        ind.style.cssText = 'padding:3px 10px;background:var(--bg3);border-bottom:1px solid var(--border);font-size:11px;color:var(--text2);display:flex;align-items:center;gap:6px';
        var list = pane.querySelector('.dpb-list');
        if (list && list.parentNode) list.parentNode.insertBefore(ind, list);
      }
      var target = _targetDir || _remoteCwd;
      ind.innerHTML = '<span>📌 目标：</span><code style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--cyan)">'
        + (target || '/').replace(/[<>&"']/g, function(c){return {'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[c]})
        + '</code><button class="btn btn-sm dpb-target-clear" style="padding:1px 6px;font-size:10px">清</button>';
      var clr = ind.querySelector('.dpb-target-clear');
      if (clr) clr.onclick = function(){
        _targetDir = null;
        _applyTargetDir();
      };
      // 高亮当前 targetDir 所在项
      var items = pane.querySelectorAll('.dpb-item');
      items.forEach(function(it){
        var ip = it.getAttribute('data-path') || '';
        if (_targetDir && (ip + '/') === _targetDir){
          it.classList.add('dpb-target');
          it.style.outline = '2px solid var(--green)';
          it.style.outlineOffset = '-2px';
        } else {
          it.classList.remove('dpb-target');
          it.style.outline = '';
          it.style.outlineOffset = '';
        }
      });
    });
    // 2) 自动配对 pending src-only 项
    var dst = _targetDir || _guessDst();
    if (dst && dst !== '/'){
      for (var i=0;i<_items.length;i++){
        if (_needsDst(_items[i])){
          _items[i].dst = dst;
          _items[i].mode = _direction === 'down' ? 'pull' : 'push';
          if (!_items[i].server || _items[i].server === 'local' || _items[i].server === 'l'){
            _items[i].server = _activeServerId || 'local';
          }
        }
      }
      _saveItems();
      _fireChange();
    }
  }
  // v4.38.21 rev · 在 src 加入时自动以"对侧 cwd"作为 dst
  // 这样用户只点本地文件的 ➕ 即可：远程已经导航到目标目录时，dst 自动填上
  function _guessDst(){
    // 优先用用户显式选的目标，否则用远端/本地 cwd
    if (_targetDir) return _targetDir;
    // direction=up: 推到远端，dst = 远端 cwd；direction=down: 拉到本地，dst = 本地 cwd
    if (_direction === 'down') return _localCwd;
    return _remoteCwd;
  }
  // v4.38.21 rev · 若刚加的 src 项有对侧 cwd，立即补全 dst
  // 注意：dst === '/' 也算未设置（用户没真正选目标）
  function _needsDst(item){
    if (!item) return false;
    if (!item.src) return false;  // src 没有，不算"需要 dst"
    if (!item.dst) return true;
    if (item.dst === '/') return true;  // 根目录不算有效目标
    return false;
  }
  function _autoPairDst(item){
    if (!_needsDst(item)) return false;
    var dst = _guessDst();
    if (!dst || dst === '/') return false;  // 对侧还没导航，不臆测
    item.dst = dst;
    item.server = (item.server && item.server !== 'local' && item.server !== 'l') ? item.server : (_activeServerId || 'local');
    // v4.51.0 · sync 模式: mode 传 'sync' (后端真双向: 两轮 rsync -u 较新者胜)
    item.mode = _direction === 'down' ? 'pull' : (_direction === 'sync' ? 'sync' : 'push');
    return true;
  }
  function _addFromLeft(p){
    try { _autoDirectionBySource(true); } catch(e){}
    // left 是 UI 位置: src 来自哪一侧基于 direction 决定
    // direction='up' (本地→远端): left=local → src=p, dst=空(待补)
    // direction='down' (远端→本地): left=remote → src=p, dst=空(待补)
    // direction='sync': left=local, src=p
    var side = _leftSide;
    var item = {
      src: p,           // 左侧的路径作为 src
      dst: '',          // 右侧路径待用户填入（或由对侧 cwd 自动填入）
      server: side === 'remote' ? (_activeServerId || 'local') : 'local',
      mode: _direction === 'down' ? 'pull' : (_direction === 'sync' ? 'sync' : 'push'),
    };
    // v4.38.21 rev · 智能 dst：对侧已有 cwd 时直接填入（最常见 UX）
    var paired = _autoPairDst(item);
    if (addItem(item)) {
      if (paired) _toast('已加入: ' + p + ' → ' + item.dst, 'ok');
      else _toast('已加入: ' + p, 'ok');
    }
  }
  function _addFromRight(p){
    try { _autoDirectionBySource(false); } catch(e){}
    // right 是 UI 位置: 右侧路径补全 dst
    // 智能补全：如果 _items 末尾存在"仅有 src、dst 空"的项，附加到它的 dst
    // 否则新建 dst-only 项
    var side = _rightSide;
    var server = side === 'remote' ? (_activeServerId || 'local') : 'local';
    var mode = _direction === 'down' ? 'pull' : 'push';
    // 倒序找最近一个 src 存在但 dst 为空的项
    var pairedIdx = -1;
    for (var i=_items.length-1; i>=0; i--){
      if (_items[i].src && !_items[i].dst){
        pairedIdx = i;
        break;
      }
    }
    if (pairedIdx >= 0){
      _items[pairedIdx].dst = p;
      if (server && server !== 'local') _items[pairedIdx].server = server;
      if (mode) _items[pairedIdx].mode = mode;
      _saveItems();
      _fireChange();
      _toast('已补全目的: ' + p, 'ok');
      return;
    }
    // 没有可补全项，新建 dst-only
    var item = {
      src: '',
      dst: p,
      server: server,
      mode: mode,
    };
    if (addItem(item)) _toast('已加入目的: ' + p, 'ok');
  }
  function _addBatchFromLeft(paths){
    var n = 0;
    for (var i=0;i<paths.length;i++){ if (_addFromLeft(paths[i])) n++; }
    if (n) _toast('已批量加入 ' + n + ' 项', 'ok');
  }
  function _addBatchFromRight(paths){
    // 批量补全 dst: 倒序查找 src-only 项，依次配对
    var n = 0;
    var pending = [];
    for (var i=_items.length-1; i>=0 && pending.length < paths.length; i--){
      if (_items[i].src && !_items[i].dst){
        pending.unshift(_items[i]);  // 按原序
      }
    }
    var side = _rightSide;
    var server = side === 'remote' ? (_activeServerId || 'local') : 'local';
    var mode = _direction === 'down' ? 'pull' : 'push';
    // 配对：pending 头部配 paths 头部
    for (var j=0; j<paths.length; j++){
      if (j < pending.length){
        // 补全到 pending[j]
        pending[j].dst = paths[j];
        if (server && server !== 'local') pending[j].server = server;
        if (mode) pending[j].mode = mode;
        n++;
      } else {
        // 新建 dst-only
        var item = { src: '', dst: paths[j], server: server, mode: mode };
        if (addItem(item)) n++;
      }
    }
    if (n){ _saveItems(); _fireChange(); }
    if (n) _toast('已批量补全 ' + n + ' 项', 'ok');
  }

  // ==========================================================================
  // 服务器
  // ==========================================================================
  function _getServerById(id){
    // v4.41.1 · id 宽松比较: select value 是 String(s.id) 字符串, 而 /api/servers 的 id 是
    //   数字 (SQLite int) -> 严格 === 永远匹配失败 -> 选中任何服务器都提示"请先在列表中选择服务器"
    var _sid = String(id);
    for (var i=0;i<_servers.length;i++) if (String(_servers[i].id) === _sid) return _servers[i];
    // v4.38.34 · 临时服务器 (SrvPool 负数 id) 也能查到
    if (window.SrvPool && window.SrvPool.getSrvList){
      var all = window.SrvPool.getSrvList();
      for (var j=0;j<all.length;j++) if (String(all[j].srv_id) === _sid) return all[j];
    }
    // v4.38.35 · df 挂载点伪服务器 (id 形如 'dfm_N' · 借 DM 扫描主机凭据)
    if (typeof id === 'string' && id.indexOf('dfm_') === 0){
      var c = window.__dmDfMounts;
      var k = parseInt(id.slice(4), 10);
      if (c && c.mounts && c.mounts[k] && c.host){
        var creds = null;
        try {
          // DM 主机凭据: 优先 window.getSrvAuth (含 dm form fallback)
          if (typeof window.getSrvAuth === 'function'){
            var g = window.getSrvAuth();
            if (g && g.host) creds = g;
          }
        } catch(_){}
        if (!creds && window.DiskManager && window.DiskManager.instance){
          try {
            var ci = window.DiskManager.instance('disk_manager');
            var cc = ci && ci.getConn && ci.getConn();
            if (cc && cc.host) creds = cc;
          } catch(_){}
        }
        if (!creds) return null;
        return {
          id: id, df: true, label: '📊 ' + c.mounts[k].mount + ' (df)',
          host: c.host, mount: c.mounts[k].mount,
          port: creds.port || 22, user: creds.user || 'root',
          auth_type: creds.auth_type || 'pass', password: creds.password || '',
          key: creds.key || '', passphrase: creds.passphrase || '',
        };
      }
    }
    // v4.40.0 · 网络共享伪服务器 (id 形如 'shs_<uuid>' · 挂载点在本机 · 走 list_dir 不走 SSH)
    if (typeof id === 'string' && id.indexOf('shs_') === 0){
      var shUid = id.slice(4);
      var _sh = null;
      try {
        (window.__sharesCache || []).forEach(function(s){ if (s && s.uuid === shUid) _sh = s; });
      } catch(_){}
      if (!_sh) return null;
      var SR2 = '/var/lib/fonriv_mounts/shares/';
      var mnt2 = '';
      try {
        ((window.__dmDfMounts || {}).mounts || []).forEach(function(m){
          if (m && m.mount === SR2 + shUid) mnt2 = m.mount;
        });
      } catch(_){}
      var isM2 = !!mnt2 || !!(_sh && _sh.mounted);
      return {
        id: id, share: true, mounted: isM2,
        label: (isM2 ? '✓ ' : '🔌 ') + (_sh.name || shUid) + ' · ' + String(_sh.proto||'').toUpperCase() + ' ' + (_sh.host||'') + ':' + (_sh.share||''),
        host: _sh.host || '', port: _sh.port || '', proto: _sh.proto || '',
        mount: mnt2 || (isM2 ? SR2 + shUid : ''),
        _uuid: shUid,
      };
    }
    // v4.41.2 · ☁ 云存储伪服务器 (id 形如 'cld_<remote_id>')
    if (_isCloudOptId(id)){
      var rid2 = _cloudRidFromOpt(id);
      var c2 = _getCloudById(rid2);
      if (!c2) return null;
      var pr = { seafile: 'Seafile', s3: 'S3', webdav: 'WebDAV', local: '本地目录' };
      return {
        id: id, cloud: true,
        label: '☁ ' + (c2.name || ('remote#' + rid2)) + ' · ' + (pr[c2.provider] || c2.provider || '云存储'),
        host: c2.host || '', _cloud: c2,
      };
    }
    return null;
  }
  // v4.41.2 · ☁ 远端存储 (云) 辅助: 列表/按 id 查行 (__cloudRemotesCache · 与 transfer_tri 同源)
  var _clouds = [];
  function _loadClouds(){
    return new Promise(function(resolve){
      var use = function(list){
        _clouds = Array.isArray(list) ? list : [];
        try { window.__cloudRemotesCache = _clouds.slice(); } catch(e){}
        resolve(_clouds);
      };
      if (_clouds.length) return resolve(_clouds);
      try {
        if (window.__cloudRemotesCache && window.__cloudRemotesCache.length) return use(window.__cloudRemotesCache);
      } catch(e){}
      if (typeof send !== 'function') return resolve([]);
      // v1.0.0 · 社区档无"远端存储"键 → 不拉(该组本就不显示)
      if (window.__featInEdition && !window.__featInEdition('cloud')) return;
      send({ action: 'remote_list' }, function(d){
        use((d && d.status === 'ok' && d.remotes) ? d.remotes : []);
      });
    });
  }
  function _getCloudById(cloudId){
    for (var i=0;i<_clouds.length;i++){
      var c = _clouds[i];
      if (String(c.uuid || '') === String(cloudId) || String(c.id) === String(cloudId)) return c;
    }
    try {  // 兜底全局缓存
      var cs = window.__cloudRemotesCache || [];
      for (var j=0;j<cs.length;j++){
        if (String(cs[j].uuid || '') === String(cloudId) || String(cs[j].id) === String(cloudId)) return cs[j];
      }
    } catch(e){}
    return null;
  }
  // 云条目 id (下拉 value): "cld_<remote_id>"
  function _cloudOptId(c){ return 'cld_' + (c && (c.id != null ? c.id : c.remote_id)); }
  function _isCloudOptId(v){ return typeof v === 'string' && v.indexOf('cld_') === 0; }
  function _cloudRidFromOpt(v){ return parseInt(String(v || '').slice(4), 10) || 0; }

  // v4.41.2 · ☁ 云浏览: 用 remote_ls 拉目录 -> setEntries 灌入右栏 (与 SSH 浏览同 UI)
  function _browseCloud(c, paneR, initPath){
    var rid = (c && (c.id != null ? c.id : c.remote_id)) || 0;
    if (!rid){ _toast('⚠ 无效的远端存储配置', 'warn'); return; }
    var path = initPath || '';
    var reqId = 'tpcld_' + Date.now() + '_' + Math.random().toString(36).slice(2,6);
    if (paneR) paneR.setStatus('☁ 加载 ' + (path || '/') + ' ...');
    openWs(function(ws){
      var h = function(e){
        var d;
        try { d = JSON.parse(e.data); } catch(_){ return; }
        if (!d || d.type !== 'remote_ls_result' || d.req_id !== reqId) return;
        try { ws.removeEventListener('message', h); } catch(_){}
        if (d.status === 'ok'){
          var entries = (d.entries || []).map(function(en){
            return { name: en.name, type: en.is_dir ? 'dir' : 'file', size: en.size || 0,
                     path: (path ? path.replace(/\/+$/,'') + '/' : '') + en.name };
          });
          if (paneR && paneR.setEntries){
            paneR.setEntries(entries, '/' + (path || '').replace(/^\/+|\/+$/g,''));
            paneR.setStatus('☁ ' + (c.name || c.label || ('remote#' + rid)) + ' · ' + entries.length + ' 项');
          }
        } else {
          if (paneR) paneR.setStatus('✖ ☁ ' + (d.msg || '加载失败'), true);
          _toast('✖ ☁ 远端存储浏览失败: ' + (d.msg || ''), 'err');
        }
      };
      ws.addEventListener('message', h);
      _rpSendWhenReady(ws, { action: 'remote_ls', remote_id: rid, path: path, req_id: reqId }, undefined, function(){ try { console.warn('[ws] 发送失败'); } catch(_){} })
    });
  }
  // v4.41.2 · ☁ 连接云存储 (等价 _connectServer): 状态置已连接 + 云浏览根目录
  function _connectCloud(srv, targetPane){
    if (!srv) return;
    _activeServerId = srv.id;
    _activeCloud = srv._cloud;
    var paneR = (function(){
      if (_rightSide === 'remote') return _rightPane;
      if (_leftSide === 'remote') return _leftPane;
      return _rightPane || _leftPane;
    })();
    if (paneR){
      try { paneR.setConnState(true); } catch(_){}
      var rid = (srv._cloud && (srv._cloud.id != null ? srv._cloud.id : srv._cloud.remote_id)) || 0;
      if (typeof paneR.setCloudFs === 'function'){
        try { paneR.setCloudFs(true, rid, '/'); } catch(e){ console.warn('[TriPane] setCloudFs', e); }
      }
    }
    renderServerBar();
    _toast('☁ 已连接远端存储: ' + (srv.label || ''), 'ok');
    try {
      var dstEl = _host && _host.querySelector('.tp-srv-dst');
      if (dstEl){
        dstEl.textContent = '📍 ☁ ' + (srv.label || '') + ':/';
        dstEl.title = '当前目标: ☁ ' + (srv.label || '');
      }
    } catch(_){}
  }
  /* v5.31.0 · 服务器列表改为「WS 配置源优先」——
     旧实现只走 /api/servers (REST), 有两个硬伤:
       ① 页面刚加载时 auth_token 可能尚未就绪 → 401 → 列表为空, 用户要刷几次页面才看到服务器;
       ② REST 端只返回主 auth_value, 对在 ab_ / pbs_ 等分栏字段里存凭据的配置会给出空密码,
          点了就报"密码或密钥问题", 而上方表单(走 WS db_config_list)却是好的 —— 两边不一致。
     现在与侧栏/上表单**同源** (WS db_config_list, 已按 scope 合并 + Fernet 解密),
     REST 仅作降级兜底。 */
  function _mapCfgRow(r){
    var at = r.auth_type || 'pass';
    return {
      id: r.id, uuid: r.uuid || ('cfg_' + r.id),
      name: r.name || r.host, label: r.name || r.host,
      host: r.host || '', port: r.port || '22', user: r.user || 'root',
      auth_type: at,
      password: (at === 'pass') ? (r.auth_value || '') : '',
      key: (at === 'key') ? (r.auth_value || '') : '',
      passphrase: r.auth_passphrase || '',
      panel_scope: r.panel_scope || '',
      _hasCred: !!(r.auth_value || r.auth_passphrase)
    };
  }
  function _loadServersFromWs(){
    return new Promise(function(resolve){
      if (typeof send !== 'function') return resolve(null);
      var done = false;
      var timer = setTimeout(function(){
        if (done) return; done = true; resolve(null);      // WS 无响应 → 交给 REST 兜底
      }, 6000);
      try {
        window.SP.serverRows().then(function(d){
          if (done) return; done = true; clearTimeout(timer);
          var rows = (d && (d.configs || d.rows)) || [];
          if (!Array.isArray(rows) || !rows.length) return resolve(null);
          var mapped = rows.filter(function(r){ return r && r.host; }).map(_mapCfgRow);
          resolve(mapped);
        });
      } catch(e){ if (!done){ done = true; clearTimeout(timer); resolve(null); } }
    });
  }
  function _loadServersFromApi(){
    return new Promise(function(resolve){
      if (typeof fetch !== 'function') return resolve([]);
      var token = localStorage.getItem('auth_token') || '';
      var url = '/api/servers' + (token ? '?token=' + encodeURIComponent(token) : '');
      fetch(url, { credentials: 'same-origin' })
        .then(function(r){ return r.ok ? r.json() : []; })
        .then(function(arr){
          _servers = Array.isArray(arr) ? arr : [];
          try { window.__serversCache = _servers.slice(); } catch(e){}
          resolve(_servers);
        })
        .catch(function(){ resolve(_servers); });
    });
  }
  /* 统一入口: WS 优先, 空则 REST 兜底, 再空则 800ms 后重试一次
     (修"必须刷新几次页面服务器才出现") */
  function _loadServers(){
    return _loadServersFromWs().then(function(list){
      if (list && list.length){
        _servers = list;
        try { window.__serversCache = _servers.slice(); } catch(e){}
        return _servers;
      }
      return _loadServersFromApi().then(function(rest){
        if (rest && rest.length) return rest;
        return new Promise(function(res){
          setTimeout(function(){
            _loadServersFromWs().then(function(l2){
              if (l2 && l2.length){
                _servers = l2;
                try { window.__serversCache = _servers.slice(); } catch(e){}
                res(_servers);
              } else res(_servers);
            });
          }, 800);
        });
      });
    });
  }

  // v4.39.3 · 获取本机 df 共享挂载点 (share_list 返回 df_mounts) -> 更新 __dmDfMounts + 重渲染
  function _fetchDfMounts(){
    return new Promise(function(resolve){
      if (typeof send !== 'function'){ resolve(); return; }
      send({ action: 'share_list' }, function(d){
        // v4.39.4 · 也缓存共享配置 (供 df 下拉列出未挂载共享)
        if (d && d.shares){ try { window.__sharesCache = d.shares.slice(); } catch(_){} }
        if (d && d.df_mounts){
          // 合并进 __dmDfMounts (与 shares.js _syncDfMounts 同逻辑)
          var SR = '/var/lib/fonriv_mounts/shares/';
          var existing = window.__dmDfMounts || { host: '127.0.0.1', ts: 0, mounts: [] };
          var keep = [];
          (existing.mounts || []).forEach(function(m){
            if (m && m.mount && m.mount.indexOf(SR) === 0) return;
            keep.push(m);
          });
          (d.df_mounts || []).forEach(function(m){
            if (m && m.mount){
              var _isShareMnt = (m.mount.indexOf('/var/lib/fonriv_mounts/shares/') === 0);
              keep.push({ mount: m.mount, source: m.source||'', avail: m.avail||'', use_pct: m.use_pct||'', local: _isShareMnt });
            }
          });
          // v5.5.0 · 保留 DM 扫描主机 (旧实现写死 127.0.0.1 → 与凭据不同源 → 静默 SSH 到 127.0.0.1 失败)
          var _prevHost = (window.__dmDfMounts && window.__dmDfMounts.host) || '';
          window.__dmDfMounts = { host: _prevHost, ts: Date.now(), mounts: keep };
          renderServerBar();
        }
        resolve();
      });
    });
  }

  // v4.39.4 · 合并 df_mounts 进 __dmDfMounts + 刷新 (供 share_auto_remount 回调用)
  function _syncDfMountsGlobal(d){
    try {
      if (!d) return;
      // v4.39.4 · 也缓存共享配置 (供 df 下拉列出未挂载共享)
      if (d.shares){ try { window.__sharesCache = d.shares.slice(); } catch(_){} }
      if (!d.df_mounts) return;
      var SR = '/var/lib/fonriv_mounts/shares/';
      var existing = window.__dmDfMounts || { host: '127.0.0.1', ts: 0, mounts: [] };
      var keep = [];
      (existing.mounts || []).forEach(function(m){
        if (m && m.mount && m.mount.indexOf(SR) === 0) return;
        keep.push(m);
      });
      (d.df_mounts || []).forEach(function(m){
        if (m && m.mount) keep.push({ mount: m.mount, source: m.source||'', avail: m.avail||'', use_pct: m.use_pct||'' });
      });
      // v5.5.0 · 保留已有扫描主机, 不写死 127.0.0.1
      var _prevHost2 = (window.__dmDfMounts && window.__dmDfMounts.host) || '';
      window.__dmDfMounts = { host: _prevHost2, ts: Date.now(), mounts: keep };
      renderServerBar();
      // v4.39.4 · 也刷新 DM 三栏 df 下拉
      if (window._triInstances){
        for (var k in window._triInstances){
          var tri = window._triInstances[k];
          if (tri && typeof tri.refreshServers === 'function') tri.refreshServers();
        }
      }
    } catch(e){ console.warn('_syncDfMountsGlobal', e); }
  }
  function _connectServer(srv, targetPane){
    if (!srv) return;
    var _tgt = targetPane || null;
    if (_tgt && typeof _tgt.setStatus === 'function') _tgt.setStatus('正在连接 '+srv.label+' ...');
    else if (_rightPane) _rightPane.setStatus('正在连接 '+srv.label+' ...');
    // v5.28.2 · FIX 认证竞态: 不再写 DOM 字段 (getSrvAuth 读 DOM 有竞态 → 认证失败),
    //   凭据直接通过 setAuthOverride 闭包传递 (与 disk_manager getConn() 同语义)。
    //   DOM 字段仅在用户手动填写时使用。
    _activeServerId = srv.id;
    // v4.40.0 · 连接普通 SSH 服务器 -> 恢复 SSH 模式 (v4.96.0: cross 下按所在栏连接)
    var _pR = _tgt || (function(){
      if (_rightSide === 'remote') return _rightPane;
      if (_leftSide === 'remote') return _leftPane;
      return _rightPane;
    })();
    // v4.96.0 · 本栏专属凭据 (cross 双远端: 左栏连 A 机、右栏连 B 机互不覆盖)
    if (_pR && typeof _pR.setAuthOverride === 'function'){
      try {
        _pR.setAuthOverride(function(){
          return { host: srv.host || '', port: srv.port || '22', user: srv.user || 'root',
                   auth_type: srv.auth_type || 'pass', password: srv.password || '',
                   key: srv.key || '', passphrase: srv.passphrase || '' };
        });
      } catch(e){ console.warn('[TriPane] setAuthOverride', e); }
    }
    if (_pR && typeof _pR.setLocalFs === 'function'){ try { _pR.setLocalFs(false); } catch(_){} }
    // v4.41.2 · 切回 SSH 服务器时关闭云模式 (若此前在 ☁ 远端存储)
    if (_pR && typeof _pR.setCloudFs === 'function'){ try { _pR.setCloudFs(false); } catch(_){} }
    if (_pR && typeof _pR.setConnState === 'function'){ try { _pR.setConnState(false); } catch(_){} }
    _activeCloud = null;
    // v4.96.0 · 修复 cross: 此前硬编码 _rightPane, 左栏连接后从不加载
    //   (用户报「左侧连了服务器但目录空白」的直接原因)
    if (_pR){
      try { _pR.setConnState(true); } catch(_){}
      try { _pR.load('/'); } catch(_){}
    }
    renderServerBar();
    _toast('已连接: ' + srv.label, 'ok');
    // v4.38.21 rev · 连接后自动预检 rsync/sshpass 缺失，给出明确提示
    setTimeout(_autoCheckRemoteDeps, 800);
  }

  // v4.40.0 · 连接网络共享: 未挂载 -> share_mount 挂载 -> 右栏直接本机浏览挂载点 (list_dir · 不走 SSH)
  //   修复 v4.39.x "加载超时(请检查 WS 连接)": 旧实现 df 伪服务器借 SSH 到 127.0.0.1 浏览挂载点,
  //   sshd/凭据问题导致 15s 超时; 现在挂载点路径直接走本机 list_dir。
  function _connectShare(srv, targetPane){
    if (!srv || !srv._uuid) return;
    var SR = '/var/lib/fonriv_mounts/shares/';
    var mnt = srv.mount || '';
    var paneR = targetPane || (function(){
      if (_rightSide === 'remote') return _rightPane;
      if (_leftSide === 'remote') return _leftPane;
      return _rightPane || _leftPane;
    })();
    function _browse(m){
      _activeServerId = srv.id;
      if (paneR){
        try { paneR.setConnState(true); } catch(_){}
        // v4.40.0 · remote pane 切本机模式 (list_dir 浏览挂载点, 不走 SSH)
        // v4.41.2 · 同时关闭云模式 (互斥)
        if (typeof paneR.setCloudFs === 'function'){ try { paneR.setCloudFs(false); } catch(_){} }
        if (typeof paneR.setLocalFs === 'function'){
          try { paneR.setLocalFs(true, m); } catch(_){}
        } else {
          try { paneR.load(m); } catch(_){}
        }
      }
      renderServerBar();
      _toast('✓ 网络共享已连接: ' + srv.label, 'ok');
      // 更新目标指示
      try {
        var dstEl = _host && _host.querySelector('.tp-srv-dst');
        if (dstEl){ dstEl.textContent = '📍 ' + srv.label + ':' + m; dstEl.title = m; }
      } catch(_){}
    }
    if (mnt){
      _browse(mnt);
      return;
    }
    // 未挂载 -> 挂载
    if (typeof send !== 'function'){ _toast('✖ WS 未就绪', 'err'); return; }
    _toast('🔌 正在挂载网络共享 ' + (srv.label||'') + ' ...', 'info');
    if (paneR) try { paneR.setStatus('🔌 正在挂载网络共享 ...'); } catch(_){}
    send({ action:'share_mount', uuid: srv._uuid }, function(d){
      _syncDfMountsGlobal(d);   // 更新 __dmDfMounts/__sharesCache + 刷新所有下拉
      if (d && d.status === 'ok'){
        var m2 = (d && d.mnt) ? d.mnt : (SR + srv._uuid);
        _toast('✓ ' + (d.msg || '已挂载'), 'ok');
        // v4.40.0 · 只读/读写检测提示
        if (d.rw === 'ro'){
          _toast('🔒 该共享实际只读' + (d.rw_reason ? ' (' + d.rw_reason + ')' : '') + ' · 仅可下载/读取', 'warn');
          try { addLog('网络共享 ' + srv.label + ' 实际只读 (' + (d.rw_reason || '服务器限制') + ') · 仅可下载/读取, 上传会被拒绝', 'warn'); } catch(_){}
        } else if (d.rw === 'rw'){
          try { addLog('网络共享 ' + srv.label + ' 读写检测通过 · 可正常上传/写入', 'success'); } catch(_){}
        } else if (d.rw_label){
          _toast('⚠ 读写状态未知: ' + (d.rw_reason || ''), 'warn');
        }
        _browse(m2);
      } else {
        _toast('✗ 挂载失败: ' + ((d && d.msg) || '未知错误'), 'err');
        if (paneR) try { paneR.setStatus('✗ 挂载失败: ' + ((d && d.msg) || ''), true); } catch(_){}
      }
    });
  }
  // v4.38.21 rev · 远端依赖预检：缺 sshpass/rsync 时给出"一键安装"入口
  function _autoCheckRemoteDeps(){
    try {
      if (typeof checkRsyncPlugins !== 'function') return;
      // 直接调用，让现有 UI 显示结果；用户看不到可手动点"检测依赖"按钮
      checkRsyncPlugins();
    } catch(e){ /* ignore */ }
  }
  
  // v6.16.11 · FIX(用户实测: 全屏按钮绝对定位悬浮在右上角, 压住栏头其他按钮/菜单):
  //   改为**内联**放进每条服务器栏 (.tp-srvbar) 的末尾 —— 连接/临时/删除等在前, 全屏排最后。
  //   五个方向(双向/上传/下载/本地→本地/远端→远端)的每条栏走同一 _buildSrvBar, 全量生效。
  function _fsBtnLabel(){
    return (_host && _host.classList.contains('tp-fullscreen')) ? '✕ 退出全屏' : '⛶ 全屏';
  }
  function toggleFullscreen(){
    if (!_host) return;
    var isFs = _host.classList.toggle('tp-fullscreen');
    Array.prototype.forEach.call(_host.querySelectorAll('.tp-fs-btn'), function(b){
      b.textContent = _fsBtnLabel();
    });
    setTimeout(function(){ window.dispatchEvent(new Event('resize')); }, 100);
  }
function renderServerBar(){
    // v4.96.0 · cross 远端-远端: 每个含 .tp-srvbar 的栏都渲染自己的服务器栏, 各自驱动所在栏
    var bars = _host ? Array.prototype.slice.call(_host.querySelectorAll('.tp-srvbar')) : [];
    if (!bars.length) return;
    bars.forEach(function(barEl){
      var paneEl = barEl.closest ? barEl.closest('.dpb-pane') : null;
      var pane = _rightPane;
      if (paneEl && _leftPane && paneEl === _leftPane.pane) pane = _leftPane;
      else if (paneEl && _rightPane && paneEl === _rightPane.pane) pane = _rightPane;
      _buildSrvBar(barEl, pane);
    });
  }
  function _buildSrvBar(bar, pane){
    try { window.ConnCenter.connectedList().then(function(l){ l.forEach(function(c){ _ccSet[c.host+':'+c.port]=1; }); }); } catch(e){}
    // pane = 本服务器栏驱动的浏览栏 (cross 左栏可独立连接第二台远端)
    // v4.38.34 · 合并持久服务器 + SrvPool 临时服务器 (负数 id), 全部进下拉
    var all = _servers.slice();
    if (window.SrvPool && window.SrvPool.getSrvList){
      try {
        var pool = window.SrvPool.getSrvList() || [];
        var have = {};
        all.forEach(function(s){ have[String(s.id)] = true; have[String(s.label)] = true; });
        pool.forEach(function(s){
          var sid = s.srv_id;
          var exists = all.some(function(x){ return String(x.id) === String(sid); });
          if (!exists && sid !== undefined && sid !== null){
            all.push({ id: sid, label: (s.label || s.host) + ' (临时)', host: s.host, port: s.port, user: s.user, auth_type: s.auth_type, password: s.password, key: s.key, passphrase: s.passphrase });
          }
        });
      } catch(e){}
    }
    // v4.38.34 · 下拉选择 (省空间) + ✚临时按钮
    // v4.38.35 · 合并 📊df挂载点分组 (来自 DM 扫描缓存 __dmDfMounts · 借 DM 主机凭据连接)
    // v4.40.0 · df 组过滤共享挂载点 (共享单独归"📂 网络共享"组, 不再混入 df 组 -- 便于区分)
    var SR = '/var/lib/fonriv_mounts/shares/';
    var dfC = window.__dmDfMounts;
    var dfSrvs = [];
    /* v1.0.0 · 用户报"里面还残留 DF 挂载点": df 挂载点来自远端磁盘管理(DM)的缓存
       (window.__dmDfMounts)；社区档没有该能力(disk 键) → 整组不显示, 免得露出过期条目。 */
    var _dfAllowed = !(window.__featInEdition && !window.__featInEdition('disk'));
    if (_dfAllowed && dfC && dfC.mounts && dfC.mounts.length && dfC.host){
      dfC.mounts.forEach(function(mt, i){
        if (mt && mt.mount && mt.mount.indexOf(SR) === 0) return;  // 共享挂载点 -> 📂 组
        // v4.39.2 · 挂载点友好显示: 来源-短名 (nas-host:data-01a017da)
        var lbl = (typeof window.fmtDfLabel === 'function') ? window.fmtDfLabel(mt) : mt.mount;
        dfSrvs.push({ id: 'dfm_' + i, df: true, label: '📊 ' + lbl + ' (df)', host: dfC.host, mount: mt.mount, avail: mt.avail, _title: mt.mount });
      });
    }
    // v4.40.0 · 📂 网络共享组: 所有已配置共享 (已挂载=✓ 可直接浏览; 未挂载=🔌 点击挂载)
    var _sharesList = [];
    try { _sharesList = window.__sharesCache || []; } catch(_){}
    var _mountedShareMnts = {};   // {uuid: mount_path}
    try {
      (dfC && dfC.mounts || []).forEach(function(m){
        if (m && m.mount && m.mount.indexOf(SR) === 0){
          var uid = m.mount.slice(SR.length);
          if (uid) _mountedShareMnts[uid] = m.mount;
        }
      });
    } catch(_){}
    // 共享挂载点也可能不在 __dmDfMounts (df 刷新竞态) -- 以 share_list 的 mounted 字段兜底
    var _mountedByFlag = {};
    try { _sharesList.forEach(function(s){ if (s && s.mounted) _mountedByFlag[s.uuid] = true; }); } catch(_){}
    var shareSrvs = [];
    _sharesList.forEach(function(s){
      if (!s || !s.uuid) return;
      var mnt = _mountedShareMnts[s.uuid] || (s.mounted ? (SR + s.uuid) : '');
      var isM = !!mnt;
      shareSrvs.push({
        id: 'shs_' + s.uuid, share: true, mounted: isM,
        label: (isM ? '✓ ' : '🔌 ') + s.name + ' · ' + String(s.proto||'').toUpperCase() + ' ' + s.host + ':' + s.share,
        host: s.host, port: s.port, proto: s.proto,
        mount: isM ? mnt : '', _title: (isM ? mnt : s.host + ':' + s.share + ' (未挂载, 选中自动挂载)'),
      });
    });
    var html = '<span style="color:var(--text3);font-size:10px;white-space:nowrap">🖥</span>'
      + '<select class="tp-srv-select" style="flex:1;min-width:90px;max-width:180px;padding:2px 4px;font-size:11px;border:1px solid var(--border);border-radius:4px;background:var(--bg2);color:var(--text)\">';
    var hasActive = false;
    if (all.length){
      html += '<optgroup label="🖥 服务器">';
      all.forEach(function(s){
        var sel = (_activeServerId !== null && String(_activeServerId) === String(s.id));
        if (sel) hasActive = true;
        var _cc = _ccSet[s.host+':'+s.port] ? '🟢 ' : '';
        html += '<option value="'+_esc(String(s.id))+'"'+(sel?' selected':'')+'>'+_cc+_esc(s.label || s.host)+(s.host?' · '+_esc(s.host):'')+'</option>';
      });
      html += '</optgroup>';
    }
    if (dfSrvs.length){
      html += '<optgroup label="📊 df 挂载点 (' + _esc(dfC.host) + ')" title="'+_esc(dfC.host)+' 上的挂载点">';
      dfSrvs.forEach(function(s){
        var sel = (String(_activeServerId) === String(s.id));
        if (sel) hasActive = true;
        html += '<option value="'+_esc(String(s.id))+'"'+(sel?' selected':'')+' title="'+_esc(s._title||s.mount||'')+'">'+_esc(s.label)+(s.avail?' · '+_esc(s.avail)+'可用':'')+'</option>';
      });
      html += '</optgroup>';
    }
    // v4.40.0 · 📂 网络共享组 (已挂载 ✓ / 未挂载 🔌 选中自动挂载)
    if (shareSrvs.length){
      html += '<optgroup label="📂 网络共享">';
      shareSrvs.forEach(function(s){
        var sel = (String(_activeServerId) === String(s.id));
        if (sel) hasActive = true;
        html += '<option value="'+_esc(String(s.id))+'"'+(sel?' selected':'')+' title="'+_esc(s._title||'')+'">'+_esc(s.label)+'</option>';
      });
      html += '</optgroup>';
    }
    // v4.41.2 · ☁ 远端存储组 (云: Seafile/S3/WebDAV/本地目录 · 走 remote_ls 浏览 + remote_upload/download 传输)
    /* v1.0.0 · 社区档无"远端存储"(cloud)键 → 不显示该组(社区版没有云存储入口) */
    var _cloudAllowed = !(window.__featInEdition && !window.__featInEdition('cloud'));
    var cloudSrvs = (_cloudAllowed ? _clouds : []).map(function(c){
      var pr = { seafile: 'Seafile', s3: 'S3', webdav: 'WebDAV', local: '本地目录' };
      return { id: _cloudOptId(c), cloud: true, label: '☁ ' + (c.name || ('remote#' + c.id)) + ' · ' + (pr[c.provider] || c.provider || '云存储'), host: c.host || '', _cloud: c, _title: (pr[c.provider] || c.provider || '') + (c.host ? ' · ' + c.host : '') };
    });
    if (cloudSrvs.length){
      html += '<optgroup label="☁ 远端存储">';
      cloudSrvs.forEach(function(s){
        var sel = (String(_activeServerId) === String(s.id));
        if (sel) hasActive = true;
        html += '<option value="'+_esc(String(s.id))+'"'+(sel?' selected':'')+' title="'+_esc(s._title||'')+'">'+_esc(s.label)+'</option>';
      });
      html += '</optgroup>';
    }
    if (!all.length && !dfSrvs.length && !shareSrvs.length && !cloudSrvs.length){
      bar.innerHTML = '<span style="color:var(--text3);font-size:10px">无已配置服务器 · <a href="javascript:void(0)" onclick="(typeof openServerModal===\'function\'?openServerModal():(window.toast&amp;&amp;toast(\'请到「服务器」面板添加\',\'info\')))" style="color:var(--cyan)">添加</a></span>';
      return;
    }
    html += '</select>'
      // v4.39.2 · 🔌 连接按钮: 选中服务器 → 点连接 → 连接成功 + 目标自动定位到该服务器
      + '<button class="btn btn-sm tp-srv-connect" style="padding:2px 8px;font-size:10px;background:var(--green);color:#000;border:1px solid var(--green)" title="连接下拉框选中的服务器">🔌 连接</button>'
      + '<button class="btn btn-sm tp-srv-temp" style="padding:2px 8px;font-size:10px;background:var(--bg3);color:var(--yellow);border:1px solid var(--yellow)" title="手动配置临时服务器连接">✚ 临时</button>'
      // v4.41.1 · 🗑 删除按钮: 删除下拉选中的服务器 (持久配置走 db_config_delete · uuid safe_delete 有引用自动阻止; 临时服务器走 SrvPool.removeTemp)
      + '<button class="btn btn-sm tp-srv-del" style="padding:2px 8px;font-size:10px;background:var(--bg3);color:var(--red);border:1px solid var(--red)" title="删除下拉框选中的服务器配置">🗑 删除</button>'
      // v4.38.34 · 目标目录指示: 📍 srv:cwd (用户识别传输目标位置)
      + '<span class="tp-srv-dst" style="color:var(--yellow);font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:260px" title=""></span>'
      + '<span class="tp-srv-conn" style="color:var(--text3);font-size:10px;white-space:nowrap"></span>'
      // v6.16.11 · 全屏按钮内联排最后(margin-left:auto 推到行尾), 不再绝对定位遮挡
      + '<button type="button" class="tp-fs-btn" title="全屏 / 退出全屏 (整个传输区)">' + _fsBtnLabel() + '</button>';
    bar.innerHTML = html;
    (function(){
      var _b = bar.querySelector('.tp-fs-btn');
      if (_b) _b.onclick = function(e){ e.stopPropagation(); toggleFullscreen(); };
    })();
    // 当前连接信息回显
    try {
      var cur = _getServerById(_activeServerId);
      var infoEl = bar.querySelector('.tp-srv-conn');
      if (cur && infoEl) infoEl.textContent = cur.label ? ('-> ' + cur.label) : '';
      // v4.38.34 · 目标目录指示 (服务器切换时同步): 📍 srv:cwd
      var dstEl2 = bar.querySelector('.tp-srv-dst');
      if (dstEl2){
        var lbl2 = (cur && (cur.label || cur.host)) || '本机';
        var dir2 = _targetDir || _remoteCwd || '/';
        dstEl2.textContent = '📍 ' + lbl2 + ':' + dir2;
        dstEl2.title = '当前目标目录: ' + lbl2 + ':' + dir2;
      }
    } catch(e){}
    var selEl = bar.querySelector('.tp-srv-select');
    // v4.39.2 · 连接逻辑抽取为公共函数: 连接选中的服务器 + 目标自动定位
    function _doConnectSrv(srv){
      if (!srv){ _toast('⚠ 请先在列表中选择服务器', 'warn'); return; }
      // v4.41.2 · ☁ 云存储伪服务器 (cld_<rid>): 走云浏览通路 (remote_ls · 不走 SSH)
      if (srv && srv.cloud){
        _connectCloud(srv, pane);
        return;
      }
      // v4.40.0 · 共享伪服务器 (shs_<uuid>): 未挂载先挂载 -> 挂载点路径本机浏览 (不走 SSH)
      if (srv && srv.share){
        _connectShare(srv, pane);
        return;
      }
      _connectServer(srv, pane);
      // v4.38.35 · df 伪服务器: 连接后所在栏直接跳到挂载点目录
      if (srv && srv.df && srv.mount && pane){
        setTimeout(function(){ try { pane.load(srv.mount); } catch(_){} }, 400);
      }
      // v4.39.2 · 目标自动定位: 下方目标指示立即反映新服务器
      try {
        var dstEl3 = bar.querySelector('.tp-srv-dst');
        if (dstEl3){
          var lbl3 = (srv.label || srv.host);
          var dir3 = srv.mount || _targetDir || _remoteCwd || '/';
          dstEl3.textContent = '📍 ' + lbl3 + ':' + dir3;
          dstEl3.title = '当前目标目录: ' + lbl3 + ':' + dir3;
        }
      } catch(_){}
    }
    if (selEl) selEl.onchange = function(){
      var sid = selEl.value;
      console.log('[TriPane] srv select id=' + sid);
      _doConnectSrv(_getServerById(sid));
    };
    // v4.39.2 · 🔌 连接按钮: 点击连接当前选中项
    var connBtn = bar.querySelector('.tp-srv-connect');
    if (connBtn) connBtn.onclick = function(){
      var srv = _getServerById(selEl ? selEl.value : null);
      _doConnectSrv(srv);
    };
    var tmpBtn = bar.querySelector('.tp-srv-temp');
    if (tmpBtn) tmpBtn.onclick = function(){
      // v4.38.34 · 弹临时服务器对话框 (与 TransferTri tri-srv-temp 相同机制: SrvPool.addTemp 负数 id)
      var html2 = ''
        + '<div style="display:flex;flex-direction:column;gap:8px;font-size:12px;min-width:280px">'
        + '<div style="display:flex;gap:6px"><span style="width:70px;color:var(--text2)">主机 *</span><input id="tpsHost" style="flex:1" placeholder="203.0.113.10"></div>'
        + '<div style="display:flex;gap:6px"><span style="width:70px;color:var(--text2)">端口</span><input id="tpsPort" style="flex:1" value="22"></div>'
        + '<div style="display:flex;gap:6px"><span style="width:70px;color:var(--text2)">用户</span><input id="tpsUser" style="flex:1" value="root"></div>'
        + '<div style="display:flex;gap:6px"><span style="width:70px;color:var(--text2)">认证</span><select id="tpsAuth" style="flex:1"><option value="pass">密码</option><option value="key">密钥</option></select></div>'
        + '<div style="display:flex;gap:6px"><span style="width:70px;color:var(--text2)">密码/密钥</span><input id="tpsPass" type="password" style="flex:1" placeholder="登录密码或密钥内容"></div>'
        + '<div style="color:var(--text3);font-size:11px">临时服务器仅存内存 (SrvPool), 刷新后消失; 可在「服务器」面板保存为正式配置</div>'
        + '</div>';
      _promptModal('✚ 临时服务器', html2, function(vals){
        if (!vals || !vals.host){ _toast('⚠ 请填写主机地址', 'warn'); return false; }
        var newSrv = (window.SrvPool && window.SrvPool.addTemp)
          ? window.SrvPool.addTemp({
              host: vals.host, port: parseInt(vals.port)||22, user: vals.user||'root',
              auth_type: vals.auth || 'pass',
              password: (vals.auth !== 'key') ? (vals.pass||'') : '',
              key: (vals.auth === 'key') ? (vals.pass||'') : '',
            })
          : null;
        if (!newSrv){ _toast('⚠ SrvPool 不可用', 'warn'); return false; }
        var srv = {
          id: newSrv.srv_id, label: newSrv.label, host: newSrv.host, port: newSrv.port,
          user: newSrv.user, auth_type: newSrv.auth_type, password: newSrv.password,
          key: newSrv.key, passphrase: newSrv.passphrase || '',
        };
        _servers.push(srv);
        renderServerBar();
        _connectServer(srv);
        _toast('✓ 临时服务器已连接: ' + vals.host, 'ok');
        return true;
      });
    };
    // v4.41.1 · 🗑 删除按钮: 删除下拉选中的服务器 (持久配置 db_config_delete·uuid safe_delete 有引用自动阻止; 临时 SrvPool.removeTemp)
    var delBtn = bar.querySelector('.tp-srv-del');
    if (delBtn) delBtn.onclick = async function(){
      var srv = _getServerById(selEl ? selEl.value : null);
      if (!srv){ _toast('⚠ 请先在列表中选择服务器', 'warn'); return; }
      if (srv.df || srv.share){
        _toast('ℹ ' + (srv.df ? '📊 df 挂载点' : '📂 网络共享') + '为动态条目, 无需删除', 'info');
        return;
      }
      var delLabel = srv.label || srv.host || String(srv.id);
      if (!(await rpConfirm({ title:'删除服务器', danger:true, okText:'删除', body:'确认删除服务器「' + delLabel + '」？' }))) return;
      var isTemp = !!srv.isTemp || (typeof srv.srv_id === 'number' && srv.srv_id < 0) || (typeof srv.id === 'number' && srv.id < 0);
      if (isTemp){
        var tid = (typeof srv.srv_id === 'number') ? srv.srv_id : srv.id;
        try { if (window.SrvPool && window.SrvPool.removeTemp) window.SrvPool.removeTemp(tid); } catch(_){}
        _servers = _servers.filter(function(x){ return String(x.id) !== String(tid); });
        renderServerBar();
        _toast('✓ 已删除临时服务器: ' + delLabel, 'ok');
        return;
      }
      // v5.35.0 · G3: 持久服务器=档案 → sp_del (guid)
      var payload = { action: 'sp_del', guid: srv.uuid || srv.id };
      window.send(payload, function(res){
        if (res && res.status === 'ok'){
          _servers = _servers.filter(function(x){ return String(x.id) !== String(srv.id); });
          renderServerBar();
          _toast('✓ 已删除服务器: ' + delLabel, 'ok');
        } else {
          _toast('✗ 删除失败: ' + ((res && res.msg) || '未知错误'), 'err');
        }
      });
    };
  }

  // ==========================================================================
  // 渲染
  // ==========================================================================
  // v4.38.34 · 通用输入模态框 (供 ✚临时服务器 等使用)
  function _promptModal(title, bodyHtml, onOk){
    var wrap = document.createElement('div');
    wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:99999;display:flex;align-items:center;justify-content:center';
    var box = document.createElement('div');
    box.style.cssText = 'background:var(--bg1);border:1px solid var(--border);border-radius:8px;min-width:340px;max-width:90vw;max-height:85vh;overflow:auto;box-shadow:0 8px 30px rgba(0,0,0,0.4)';
    box.innerHTML =
      '<div style="padding:8px 12px;border-bottom:1px solid var(--border);font-weight:600;font-size:13px;background:var(--bg3)">'+_esc(title)+'</div>'
      + '<div style="padding:12px">'+bodyHtml+'</div>'
      + '<div style="padding:8px 12px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:6px">'
      + '<button class="btn btn-sm _pm-cancel" style="padding:3px 12px">取消</button>'
      + '<button class="btn btn-sm _pm-ok" style="padding:3px 12px;background:var(--green);color:#000">确定</button>'
      + '</div>';
    wrap.appendChild(box);
    document.body.appendChild(wrap);
    function _close(){ if (wrap.parentNode) wrap.parentNode.removeChild(wrap); }
    function _collect(){
      var vals = {};
      box.querySelectorAll('input,select').forEach(function(el){ vals[el.id.replace(/^tps/,'').toLowerCase()] = el.value; });
      return vals;
    }
    box.querySelector('._pm-cancel').onclick = _close;
    box.querySelector('._pm-ok').onclick = function(){
      var ok = onOk && onOk(_collect());
      if (ok !== false) _close();
    };
    wrap.addEventListener('click', function(ev){ if (ev.target === wrap) _close(); });
    return { close: _close };
  }
  function _toast(msg, type){
    try {
      if (typeof window.toast === 'function') window.toast(msg, type || 'info');
      else console.log('[TriPane]', type||'info', msg);
    } catch(e){ console.log('[TriPane]', msg); }
  }

  function renderList(){
    var list = _host && _host.querySelector('.tp-list');
    if (!list) return;
    var cnt = _host.querySelector('.tp-cnt');
    if (cnt) cnt.textContent = _items.length + ' 项';
    if (!_items.length){
      list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text3);font-size:12px">📋 暂无传输项<br><span style="font-size:10px">从 ① 或 ③ 选目录/文件 → 点 ➕ 加入</span></div>';
      return;
    }
    var html = '';
    _items.forEach(function(it){
      var modeLabel = it.mode === 'pull' ? '⬇拉取' : (it.mode === 'sync' ? '⟳同步' : '⬆推送');
      var modeColor = it.mode === 'pull' ? 'var(--orange)' : (it.mode === 'sync' ? 'var(--purple)' : 'var(--green)');
      html += '<div class="tp-item" data-id="'+it.id+'" style="padding:6px 8px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:4px;font-size:11px">'
        + '<input type="checkbox" class="tp-item-check" data-id="'+it.id+'" style="flex:0 0 auto;margin:0">'
        + '<div style="flex:1;min-width:0;overflow:hidden">'
          + '<div style="display:flex;align-items:center;gap:4px;margin-bottom:2px">'
            + '<span style="background:'+modeColor+';color:#fff;padding:0 4px;border-radius:3px;font-size:9px;flex:0 0 auto">'+modeLabel+'</span>'
            + '<span style="color:var(--text3);font-size:10px;flex:0 0 auto">@'+_esc(it.server||'local')+'</span>'
          + '</div>'
          + '<div style="display:flex;align-items:center;gap:2px;font-family:monospace">'
            + '<span style="color:var(--cyan);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0" title="'+_esc(it.src)+'">'+_esc(it.src||'(空)')+'</span>'
            + '<span style="color:var(--text3);flex:0 0 auto">→</span>'
            + '<input class="tp-dst-input" data-id="'+it.id+'" value="'+_esc(it.dst||'')+'" placeholder="dst 路径" style="flex:1;min-width:0;background:var(--bg3);border:1px solid var(--border);color:var(--green);padding:1px 4px;font-size:10px;font-family:monospace">'
          + '</div>'
        + '</div>'
        + '<button class="btn btn-sm tp-item-del" data-id="'+it.id+'" style="padding:1px 5px;font-size:10px;background:var(--red);color:#fff;flex:0 0 auto">✕</button>'
      + '</div>';
    });
    list.innerHTML = html;
    list.querySelectorAll('.tp-item-del').forEach(function(b){
      b.onclick = async function(){
        var id = b.getAttribute('data-id');
        if (await rpConfirm({ title:'删除该项', danger:true, okText:'删除', body:'确认删除该项？' })) removeItem(id);
      };
    });
    list.querySelectorAll('.tp-dst-input').forEach(function(inp){
      inp.addEventListener('change', function(){
        var id = inp.getAttribute('data-id');
        for (var i=0;i<_items.length;i++){
          if (_items[i].id === id){ _items[i].dst = inp.value; _saveItems(); break; }
        }
      });
    });
  }

  // ==========================================================================
  // 拖拽按钮
  // ==========================================================================
  // v4.38.21 rev · 拖拽线性化
  //   旧实现：fr 灵敏度换算 + 累计 `_widths`，遇到 0.3 限位后非线性
  //   新实现：直接以 px 形式 set grid-template-columns，dx 1:1 对应 px 变化
  //         拖拽时实时计算（不存 _widths.fr），mouseup 时再回写 _widths.fr 用于持久化
  var _dragData = null;
  function _initGrip(grip, side){
    grip.addEventListener('mousedown', function(e){
      e.preventDefault();
      e.stopPropagation();
      var grid = grip.closest('.tp-grid');
      if (!grid) return;
      // 抓取拖拽瞬间的 grid 总宽 + 各列当前实际宽度
      var gridW = grid.getBoundingClientRect().width;
      // 用 grid-template-areas 或者 children 拿 left/mid/right 的实际宽度
      // 简单做法：parse 当前 gridTemplateColumns 中的 fr 比例 × gridW
      var cs = getComputedStyle(grid).gridTemplateColumns;
      var colsPx = cs.split(' ').map(function(s){
        if (s === '6px') return 6;
        // fr 单位: 1fr 会被 computed style 算成实际像素
        var v = parseFloat(s);
        return isNaN(v) ? 0 : v;
      });
      // colsPx: [left, 6, mid, 6, right]
      _dragData = {
        startX: e.clientX,
        side: side,
        grid: grid,
        startCols: colsPx.slice(),  // 5 元素
        gridW: gridW,
      };
      document.body.style.cursor = 'col-resize';
    });
  }
  function _initGrips(){
    var grid = _host.querySelector('.tp-grid');
    if (!grid) return;
    grid.querySelectorAll('.tp-grip').forEach(function(g){
      _initGrip(g, g.getAttribute('data-side'));
    });
    document.addEventListener('mousemove', function(e){
      if (!_dragData) return;
      var dx = e.clientX - _dragData.startX;
      var c = _dragData.startCols.slice();  // [left, 6, mid, 6, right]
      // 最小列宽 80px
      var MIN = 80;
      if (_dragData.side === 'left'){
        // 拖 grip1：改变 left 和 mid，保持 right 不变
        // 上限：mid 可以最小到 MIN，所以 left <= gridW - right - 12 - MIN
        var maxLeft = _dragData.gridW - c[4] - 12 - MIN;
        if (c[0] + dx > maxLeft) dx = maxLeft - c[0];
        if (c[0] + dx < MIN) dx = MIN - c[0];
        c[0] = c[0] + dx;
        c[2] = c[2] - dx;
      } else if (_dragData.side === 'right'){
        // 拖 grip2：改变 mid 和 right，保持 left 不变
        // 下限：mid 可以最小到 MIN，所以 right <= gridW - left - 12 - MIN
        var maxRight = _dragData.gridW - c[0] - 12 - MIN;
        if (c[4] - dx > maxRight) dx = c[4] - maxRight;
        if (c[4] - dx < MIN) dx = c[4] - MIN;
        c[2] = c[2] + dx;
        c[4] = c[4] - dx;
      }
      // 直接以 px 应用
      _dragData.grid.style.gridTemplateColumns =
        c[0].toFixed(1) + 'px ' + c[1] + 'px ' + c[2].toFixed(1) + 'px ' + c[3] + 'px ' + c[4].toFixed(1) + 'px';
    });
    document.addEventListener('mouseup', function(){
      if (_dragData){
        // mouseup 时把 px 转回 fr 写回 _widths（用于持久化）
        var cs = _dragData.grid.style.gridTemplateColumns.split(' ');
        var pxL = parseFloat(cs[0]) || 0;
        var pxM = parseFloat(cs[2]) || 0;
        var pxR = parseFloat(cs[4]) || 0;
        var total = pxL + pxM + pxR;
        if (total > 0){
          _widths.left = +(pxL / total * 3.2).toFixed(3);  // 3.2 = 1+1.2+1
          _widths.mid  = +(pxM / total * 3.2).toFixed(3);
          _widths.right= +(pxR / total * 3.2).toFixed(3);
          _saveWidths();
        }
        _dragData = null;
        document.body.style.cursor = '';
        // 恢复 fr 显示（持久化值）
        _applyWidths();
      }
    });
  }
  function _applyWidths(){
    var grid = _host && _host.querySelector('.tp-grid');
    if (!grid) return;
    // v6.16.12 · 取消左右拖拽条(用户实测: 拖歪后整页自适应失效/出现可拖很远的横向滚动条):
    //   三栏改**固定比例 fr 自适应**(左:中:右 = 1 : 1.2 : 1), 不再渲染 grip 列、
    //   也不再套用历史像素/比例值 —— 窗口与分辨率怎么变都自动铺满, 且无法被拖歪。
    // v6.16.14 · FIX(用户实测: 文件传输中栏不见了/被压成细条): grip 元素 display:none 后
    //   **脱离网格流** → 3 个面板落在第 1/2/3 列, 中栏掉进原 0px 的 grip 列被压扁。
    //   现直接按 3 列布局(左:中:右 = 1 : 1.2 : 1), grip 保持隐藏且不参与网格。
    grid.style.gridTemplateColumns = '1fr 1.2fr 1fr';
    try { grid.querySelectorAll('.tp-grip').forEach(function(g){ g.style.display = 'none'; }); } catch(e){}
  }

  // ==========================================================================
  // 方向切换：up = 本地左 远端右；down = 远端左 本地右；sync = 不变（两栏都可）
  // ==========================================================================
  function setDirection(d){
    // v4.38.26 · 接受 'cross' (远端→远端) 和 'same' (本地→本地)
    if (d !== 'up' && d !== 'down' && d !== 'sync' && d !== 'cross' && d !== 'same') return;
    _direction = d;
    _saveDirection();
    if (d === 'up'){ _leftSide = 'local'; _rightSide = 'remote'; }
    else if (d === 'down'){ _leftSide = 'remote'; _rightSide = 'local'; }
    else if (d === 'cross'){ _leftSide = 'remote'; _rightSide = 'remote'; }  // v4.38.26 · 双远端
    else if (d === 'same'){ _leftSide = 'local'; _rightSide = 'local'; }     // v4.38.26 · 双本地
    else { _leftSide = 'local'; _rightSide = 'remote'; }                       // sync
    _rebuildPanes();
    var dLabel = ({up:'本地 → 远端', down:'远端 → 本地', cross:'远端 → 远端', same:'本地 → 本地', sync:'双向同步'})[d] || d;
    _toast('方向已切换: ' + dLabel, 'info');
    // 同步 UI
    try {
      var map = {up:'dirUp', down:'dirDown', cross:'dirCross', same:'dirSame', sync:'dirSync'};
      ['up','down','cross','same','sync'].forEach(function(k){
        var btn = document.getElementById(map[k]);
        if (btn) btn.classList.toggle('active', d === k);
      });
    } catch(e){}
  }
  function _rebuildPanes(){
    var grid = _host.querySelector('.tp-grid');
    if (!grid) return;
    // 关键：完全重排 - 按 grid 顺序 left|grip1|mid|grip2|right
    // 销毁旧 panes（保留 mid 和 grips）
    try { if (_leftPane && _leftPane.pane && _leftPane.pane.parentNode) _leftPane.pane.parentNode.removeChild(_leftPane.pane); } catch(e){}
    try { if (_rightPane && _rightPane.pane && _rightPane.pane.parentNode) _rightPane.pane.parentNode.removeChild(_rightPane.pane); } catch(e){}
    // 创建新 panes
    _leftPane = _createOnePane(_leftSide, 'left');
    _rightPane = _createOnePane(_rightSide, 'right');
    // 找到 grips 位置，按 grid-template-columns 重新插入
    var grips = grid.querySelectorAll('.tp-grip');
    var midPane = grid.querySelector('.tp-mid');
    // 清空 grid（保留所有 child，因为我们要重新排序）
    // 实际上 grid 顺序：left|grip1|mid|grip2|right
    // 先移除 left/right，再按顺序插回
    var children = Array.from(grid.children);
    // 排序: left, grip1, mid, grip2, right
    var newOrder = [];
    newOrder.push(_leftPane.pane);     // 0: left
    newOrder.push(grips[0]);          // 1: grip1
    newOrder.push(midPane);           // 2: mid
    newOrder.push(grips[1]);          // 3: grip2
    newOrder.push(_rightPane.pane);   // 4: right
    // 全部重新 append（appendChild 会先 remove 再 append，自动去重）
    newOrder.forEach(function(n){
      if (n) grid.appendChild(n);
    });
    // 确保 srvbar 注入（远端栏）
    if (_rightSide === 'remote') _injectServerBar(_rightPane, 'right');
    if (_leftSide === 'remote') _injectServerBar(_leftPane, 'left');
    renderServerBar();
    // 重新加载两侧 pane（等 WS 就绪）
    _loadPane(_leftPane);
    _loadPane(_rightPane);
  }
  function _createOnePane(side, pos){
  var isLeft = (pos === 'left');
  var title = (side === 'local') ? (isLeft ? '📁 本地浏览' : '📁 本地文件') : (isLeft ? '🌐 远端浏览' : '🌐 远端文件');
  var pane = window.FileBrowser.createPane({
    side: side,
    title: title,
    onAdd: function(p){ isLeft ? _addFromLeft(p) : _addFromRight(p); },
    onAddedBatch: function(paths){ isLeft ? _addBatchFromLeft(paths) : _addBatchFromRight(paths); },
    // v4.93.0 · A1 跨栏拖拽: 拖到对侧栏 → 以拖出侧的 add 发起传输 (dst 由对侧 cwd 智能补全)
    onDropTransfer: function(srcPath, srcSide){ (srcSide === 'local') ? _addFromLeft(srcPath) : _addFromRight(srcPath); },
    onCwdChange: function(cwd){
      // v4.38.21 rev · 记录远端/本地 cwd 供自动配对
      if (side === 'remote') _remoteCwd = cwd;
      else _localCwd = cwd;
      // v4.38.34 · 目标目录指示条: 📍 srv:cwd (远端浏览到哪里 = 传输目标位置)
      try {
        var dstEl = _host && _host.querySelector('.tp-srv-dst');
        if (dstEl){
          var cur = _getServerById(_activeServerId);
          var lbl = (cur && (cur.label || cur.host)) || '本机';
          var dir = (side === 'remote') ? cwd : (_targetDir || _remoteCwd);
          dstEl.textContent = '📍 ' + lbl + ':' + (dir || '/');
          dstEl.title = '当前目标目录: ' + lbl + ':' + (dir || '/');
        }
      } catch(e){}
      // 如果有待补全 dst 的 src-only 项，把新 cwd 应用到它们
      if (side === 'remote' && !_targetDir){
        for (var i=0;i<_items.length;i++){
          if (_needsDst(_items[i])){
            _items[i].dst = cwd;
            _items[i].mode = _direction === 'down' ? 'pull' : 'push';
            if (!_items[i].server || _items[i].server === 'local' || _items[i].server === 'l'){
              _items[i].server = _activeServerId || 'local';
            }
          }
        }
        _saveItems();
        _fireChange();
      }
      _applyTargetDir();  // 更新"目标"行显示
    },
    onTargetSelect: function(p){
      // v4.38.21 rev · 用户在远端栏显式选了目标目录
      // v4.38.22 · 单击=进入+设目标（在 dir click handler 中已 load，触发 onCwdChange 即可）
      _targetDir = p;
      // v1.0.0 · FIX(用户实测"目标已经选了的, 却提示缺目标目录"): 原先只有"进入目录(onCwdChange)"
      //   会补全待定项, 且在 _targetDir 已设时被跳过 → 先加项后选目标时 dst 永远为空。
      //   这里在显式选目标时把所有 src-only 项补上 dst。
      try {
        var _n = 0;
        for (var i=0;i<_items.length;i++){
          if (_needsDst(_items[i])){
            _items[i].dst = p;
            _items[i].mode = _direction === 'down' ? 'pull' : (_direction === 'sync' ? 'sync' : 'push');
            if (!_items[i].server || _items[i].server === 'local' || _items[i].server === 'l'){
              _items[i].server = _activeServerId || 'local';
            }
            _n++;
          }
        }
        if (_n){ _saveItems(); _fireChange(); _toast('已把选中的目标目录应用到 ' + _n + ' 个待定传输项', 'ok'); }
      } catch(e){}
      _applyTargetDir();
    },
  });
  return pane;
  }
  function _loadPane(pane){
    if (!pane) return;
    _wsWaitReady(5000).then(function(ok){
      if (!ok){ pane.setStatus('⚠ WS 未连接（请先登录）', true); return; }
      try { pane.load('/'); } catch(e){ console.warn('[TriPane] pane.load', e); }
    });
  }

  // ==========================================================================
  // 构建 DOM
  // ==========================================================================
  function _build(hostId){
    if (_loaded) return;
    _loaded = true;
    _host = document.getElementById(hostId || 'triPaneTransfer');
    if (!_host){
      console.warn('[TriPaneTransfer] #' + (hostId || 'triPaneTransfer') + ' not found');
      _loaded = false;
      return;
    }
    _host.innerHTML = '';
    _loadWidths();
    _loadDirection();
    if (_direction === 'down'){ _leftSide = 'remote'; _rightSide = 'local'; }

    // 三列布局（grid + 中间夹两个 grip 拖拽条）
    // v4.38.21 rev · 拖拽线性化：grid-template-columns 直接用 px（不含 fr 灵敏度换算），
    // 让拖动 1 像素 = 1 像素列宽变化。同时 max-height: 60vh 限制面板高度，
    // 内部 dpb-list overflow:auto 显示垂直滚动条（文件多时不会把窗口撑太长）。
    var grid = document.createElement('div');
    grid.className = 'tp-grid';
    // v6.16.12 · 取消左右拖拽条 → 固定比例自适应(左:中:右 = 1 : 1.2 : 1), grip 列宽 0
    grid.style.cssText = 'display:grid;grid-template-columns:1fr 1.2fr 1fr;gap:0;margin:6px 0;min-height:380px;max-height:60vh;height:60vh;overflow:hidden;align-items:stretch';

    // ② 传输项列表（先建，因为是中间）
    var midPane = document.createElement('div');
    midPane.className = 'tp-mid';
    midPane.style.cssText = 'display:flex;flex-direction:column;border:1px solid var(--border);border-radius:8px;background:var(--bg2);overflow:hidden;min-width:0;margin:0 3px';
    midPane.innerHTML =
      // v4.66.0 · 中间栏双 Tab 头 (传输列表 / 文件预览)
      '<div class="tp-mid-tabs" style="display:flex;gap:0;background:var(--bg3);border-bottom:1px solid var(--border)">'
        + '<div class="tp-mid-tab active" data-tab="list" style="flex:1;text-align:center;padding:7px 10px;font-size:12px;font-weight:600;cursor:pointer;color:var(--cyan);border-bottom:2px solid var(--cyan)">📋 传输列表</div>'
        + '<div class="tp-mid-tab" data-tab="preview" style="flex:1;text-align:center;padding:7px 10px;font-size:12px;font-weight:600;cursor:pointer;color:var(--text3);border-bottom:2px solid transparent">👁 文件预览</div>'
      + '</div>'
      + '<div class="tp-toolbar" style="padding:6px 10px;background:var(--bg3);border-bottom:1px solid var(--border);color:var(--text2);display:flex;align-items:center;gap:6px;font-size:12px;font-weight:600">'
        + '<span class="tp-cnt" style="background:rgba(0,0,0,0.08);padding:0 6px;border-radius:10px;font-size:10px;color:var(--text2)">0 项</span>'
        + '<span style="flex:1"></span>'
        + '<button class="btn btn-sm tp-start-btn" style="padding:1px 10px;font-size:11px;font-weight:700;background:var(--green);color:#fff;border-color:var(--green)" title="开始传输列表中的所有项">▶ 开始传输</button>'
        + '<button class="btn btn-sm tp-to-flow" style="padding:1px 10px;font-size:11px;font-weight:700;background:var(--purple);color:#fff;border-color:var(--purple)" title="把传输项桥接到『跨模块自动备份』流程（本地源 -> ☁ 远端存储目标，支持定时调度）">⇪ 自动备份</button>'
        + '<button class="btn btn-sm tp-sel-all" style="padding:1px 6px;font-size:10px;background:var(--bg2);color:var(--cyan);border:1px solid var(--cyan)">全选</button>'
        + '<button class="btn btn-sm tp-sel-none" style="padding:1px 6px;font-size:10px;background:var(--bg2);color:var(--cyan);border:1px solid var(--cyan)">反选</button>'
        + '<button class="btn btn-sm tp-del-sel" style="padding:1px 6px;font-size:10px;background:var(--bg2);color:var(--cyan);border:1px solid var(--cyan)">删除</button>'
        + '<button class="btn btn-sm tp-clear" style="padding:1px 6px;font-size:10px;background:var(--red);color:#fff">清空</button>'
      + '</div>'
      + '<div class="tp-list" style="flex:1;overflow:auto;background:var(--bg1)"></div>'
      // v4.66.0 · 文件预览容器 (默认隐藏)
      + '<div class="tp-preview" style="display:none;flex:1;min-height:0;flex-direction:column;background:var(--bg1)"></div>';
    // v5.90.5 · 打开方式偏好 (文件传输三栏; 与多云文件管理/文件预览/远端磁盘管理共享同一偏好)
    try {
      var _tpBar = midPane.querySelector('.tp-toolbar');
      if (_tpBar && window.RPOpenMode){
        // v1.0.0 · 用户要求: 下拉改**按钮式**, 4 字标签「单击进入 / 双击进入」, 点击即切换
        var _omBtn = (typeof window.RPOpenMode.button === 'function')
          ? window.RPOpenMode.button('') : window.RPOpenMode.select('');
        _tpBar.appendChild(_omBtn);
      }
    } catch(e){}
    // ═══ v4.66.0 · 中间栏 Tab: 传输列表 ↔ 文件预览 ═══
    var _midTab = 'list';
    var _previewCtx = null;   // { side, path, name } 最近预览的文件
    function _setMidTab(t){
      _midTab = (t === 'preview') ? 'preview' : 'list';
      var listEl = midPane.querySelector('.tp-list');
      var prevEl = midPane.querySelector('.tp-preview');
      var tbEl = midPane.querySelector('.tp-toolbar');
      midPane.querySelectorAll('.tp-mid-tab').forEach(function(el){
        var on = el.getAttribute('data-tab') === _midTab;
        el.style.color = on ? 'var(--cyan)' : 'var(--text3)';
        el.style.borderBottom = on ? '2px solid var(--cyan)' : '2px solid transparent';
        el.classList.toggle('active', on);
      });
      if (_midTab === 'preview'){
        if (listEl) listEl.style.display = 'none';
        if (tbEl) tbEl.style.display = 'none';
        if (prevEl){ prevEl.style.display = 'flex'; }
        _bindPreviewMode(true);
        _renderPreviewPane();
      } else {
        if (prevEl) prevEl.style.display = 'none';
        if (listEl) listEl.style.display = '';
        if (tbEl) tbEl.style.display = '';
        _bindPreviewMode(false);
        renderList();
      }
      try { localStorage.setItem('tp_mid_tab_v1', _midTab); } catch(e){}
    }
    function _bindPreviewMode(on){
      // v4.98.0 · 始终绑定预览回调: 左/右栏图标·相册视图单击即出大图
      //   (_previewFrom 内部会自动切到「文件预览」Tab, 不再要求用户先手动切)
      //   on=false (传输列表 Tab) 时保留原来的"单击加入传输项"语义 → 用第二个参数区分:
      //   仅当点击来自图标/相册视图(entry.__fromCard) 时才强制预览
      if (_leftPane && _leftPane.setFileOpenHandler){
        _leftPane.setFileOpenHandler(function(p, entry){ _previewFrom(_leftPane, p, entry); });
      }
      if (_rightPane && _rightPane.setFileOpenHandler){
        _rightPane.setFileOpenHandler(function(p, entry){ _previewFrom(_rightPane, p, entry); });
      }
    }
    function _previewFrom(pane, p, entry){
      // v1.0.0 · 用户要求: 中栏停在「传输列表」时, 左右栏点文件/目录**不要**自动跳到「文件预览」;
      //   只有用户当前就在预览页签时才渲染预览(想预览就自己点中栏的「文件预览」页签)。
      if (_midTab !== 'preview') return;
      if (!pane) return;
      var nm = String(p).split('/').filter(Boolean).pop() || p;
      // 通过 pane 实例判断 side: 本地栏 pane.getState().connected etc. 用 _leftPane/_rightPane 归属判断
      var side = (pane === _leftPane) ? _leftSide : _rightSide;
      // 云/共享挂载点走本机通路 (localFs 模式)
      if (pane.isLocalFs && pane.isLocalFs()) side = 'local';
      // v5.1.0 · 「仅预览」模式: 目录不再送进中栏 (回到"点文件才预览"的旧行为)
      try {
        if (entry && entry.type === 'dir' && window.RpUI && window.RpUI.modeOf('transfer') === 'preview'){
          return;
        }
      } catch(e){}
      // v5.0.0 · 为媒体文件构建同目录导航列表 (中栏图片上出现左右翻页区 + ← → 键)
      var _navList = null, _navIdx = 0;
      try {
        var MEDIA_RE = /\.(jpe?g|png|gif|webp|svg|bmp|avif|mp4|mkv|webm|mov|mp3|flac|wav|m4a|ogg)$/i;
        if (!(entry && entry.type === 'dir') && MEDIA_RE.test(nm)){
          var all = (pane && typeof pane.getEntries === 'function') ? pane.getEntries() : [];
          var medias = all.filter(function(x){ return x.type !== 'dir' && MEDIA_RE.test(x.name || ''); })
                          .sort(function(x, y){ return String(x.name).localeCompare(String(y.name)); });
          if (medias.length > 1){
            var curName = String(p).split('/').filter(Boolean).pop();
            _navList = medias.map(function(x){ return { name: x.name, path: x.path, size: x.size || 0 }; });
            _navIdx = Math.max(0, _navList.findIndex(function(x){ return x.name === curName; }));
          }
        }
      } catch(e){ console.warn('[tri] navList', e); }
      // v5.4.0 · 带上"该栏自己的"连接信息/云标识 (旧实现不传 conn → 预览回落到全局表单字段,
      //   远端文件预览就会用错服务器凭据, 报"SSH 认证失败"; 云端文件则完全读不到)
      var _conn = {};
      try { if (pane && typeof pane.getAuth === 'function') _conn = pane.getAuth() || {}; } catch(e){}
      var _cloudId = null;
      try { if (pane && typeof pane.getCloudId === 'function') _cloudId = pane.getCloudId(); } catch(e){}
      _previewCtx = { side: side, path: p, name: nm, isDir: !!(entry && entry.type === 'dir'),
                      conn: _conn, cloudId: _cloudId,
                      navList: _navList, navIdx: _navIdx,
                      navDir: _navList ? (String(p).replace(/\/[^\/]*$/, '') || '/') : null };
      _renderPreviewPane();
    }
    function _renderPreviewPane(){
      var prevEl = midPane.querySelector('.tp-preview');
      if (!prevEl) return;
      // v4.98.0 · 预览区面包屑 (可点击任意层级跳转) + 返回上级
      try {
        // v5.2.0 · 仅预览模式: 隐藏面包屑/导航条 (用户只能从左栏点文件预览)
        var _pmOnly = false;
        try { _pmOnly = (window.RpUI && window.RpUI.modeOf('transfer') === 'preview'); } catch(e){}
        var crumbHost = midPane.querySelector('.tp-preview-crumb');
        // v5.5.0 · 仅加 class, 不再改 display (旧实现改 display 会连 ⚙ 一起藏起来, 且干扰渲染)
        if (crumbHost) crumbHost.classList.toggle('rp-pm-only', !!_pmOnly);
        // v5.3.0 · 仅预览只跳过"面包屑渲染", 绝不能 return (否则整个预览都不渲染)
        if (!crumbHost){
          crumbHost = document.createElement('div');
          crumbHost.className = 'tp-preview-crumb';
          crumbHost.style.cssText = 'padding:4px 10px;background:var(--bg3);border-bottom:1px solid var(--border);display:flex;align-items:center;gap:4px;flex-wrap:wrap';
          // v1.0.0 · 用户要求: 面包屑放到中栏顶部 —— 即「开始传输」工具栏那一排的**上面**
          var _tpToolbar = midPane.querySelector('.tp-toolbar');
          if (_tpToolbar && _tpToolbar.parentNode){
            _tpToolbar.parentNode.insertBefore(crumbHost, _tpToolbar);
          } else {
            prevEl.parentNode.insertBefore(crumbHost, prevEl);
          }
        }
        var curPath = (_previewCtx && _previewCtx.path) || '';
        var dirPath = curPath;
        // 目录视图用目录自身, 文件用其父目录
        if (_previewCtx && !_previewCtx.isDir && curPath.indexOf('/') > 0){
          dirPath = curPath.replace(/\/[^\/]*$/, '') || '/';
        }
        // v5.5.0 · 无预览上下文时用左栏(或右栏)当前目录兜底, 保证面包屑与 ⚙ 预览设置按钮始终存在
        if (!dirPath){
          try {
            var _cp = (_leftPane && _leftPane.getCwd && _leftPane.getCwd())
                   || (_rightPane && _rightPane.getCwd && _rightPane.getCwd()) || '/';
            dirPath = _cp;
          } catch(e){ dirPath = '/'; }
        }
        if (window.RpUI && dirPath){
          window.RpUI.mountBreadcrumb(crumbHost, dirPath, {
            onNav: function(p2){
              // 跳到该层级: 让所在栏 load, 并在中栏列出该目录
              _previewCtx = { side: (_previewCtx && _previewCtx.side) || 'local', path: p2,
                              name: String(p2).split('/').filter(Boolean).pop() || '', isDir: true };
              try {
                var pn = (_previewCtx.side === _rightSide) ? _rightPane : _leftPane;
                if (pn && pn.load) pn.load(p2);
              } catch(e){}
              _renderPreviewPane();
            },
            onBack: function(){
              var up = dirPath.replace(/\/[^\/]*$/, '') || '/';
              _previewCtx = { side: (_previewCtx && _previewCtx.side) || 'local', path: up,
                              name: String(up).split('/').filter(Boolean).pop() || '', isDir: true };
              try {
                var pn2 = (_previewCtx.side === _rightSide) ? _rightPane : _leftPane;
                if (pn2 && pn2.load) pn2.load(up);
              } catch(e){}
              _renderPreviewPane();
            }
          });
          // v5.1.0 · 设置按钮须在 mountBreadcrumb(会重写 innerHTML) 之后追加
          if (!crumbHost.querySelector('.rp-pm-btn')){
            try { crumbHost.appendChild(window.RpUI.settingsButton('transfer', '文件传输 · 中栏预览')); } catch(e){}
          }
          // v5.5.0 · 重建面包屑后重新打 class
          try { crumbHost.classList.toggle('rp-pm-only', !!_pmOnly); } catch(e){}
        }
      } catch(e){ console.warn('[tri] crumb', e); }
      // v5.2.0 · 已移除 (改用组件自带 grid 拖拽)
      if (!window.FilePreview){
        prevEl.innerHTML = '<div style="padding:16px;color:var(--red);font-size:12px">✗ file_preview.js 未加载</div>';
        return;
      }
      window.FilePreview.render(prevEl, {
        side: _previewCtx ? _previewCtx.side : 'local',
        path: _previewCtx ? _previewCtx.path : '',
        name: _previewCtx ? _previewCtx.name : '',
        _isDir: _previewCtx ? !!_previewCtx.isDir : false,
        _pmScope: 'transfer',
        conn: _previewCtx ? _previewCtx.conn : undefined,
        cloudId: _previewCtx ? _previewCtx.cloudId : null,
        _navList: _previewCtx ? _previewCtx.navList : null,
        _navIdx: _previewCtx ? (_previewCtx.navIdx || 0) : 0,
        _navDir: _previewCtx ? _previewCtx.navDir : null,
        onAddTransfer: function(p, entry){
          var added = addItem({ src: p, server: _activeServerId || 'local',
                                mode: _direction === 'down' ? 'pull' : (_direction === 'sync' ? 'sync' : 'push') });
          if (added){ _toast('✓ 已加入传输列表: ' + p, 'success'); renderList(); }
          else { _toast('已在传输列表中', 'info'); }
        },
        // v5.6.0 · 直接传输: 加入队列后立即开始
        onDirectTransfer: function(p, entry){
          // v5.7.0 · 必须复用「智能目标填充」: 直接 addItem 不带 dst → 被 _validateItems 拦下
          //   (用户看到"有 N 项缺目标目录")。这里等价于点该栏的 ➕ 按钮。
          var _isLeft = (_previewCtx && _previewCtx.side === _leftSide) || false;
          var added;
          try {
            var _pane = _isLeft ? _leftPane : _rightPane;
            added = _isLeft ? _addFromLeft(_normPath(p)) : _addFromRight(_normPath(p));
          } catch(e){ added = addItem({ src: _normPath(p), server: _activeServerId || 'local' }); }
          try { renderList(); } catch(e){}
          if (!added){ _toast('已在传输列表中, 直接开始', 'info'); }
          setTimeout(function(){
            try {
              if (typeof window.startTransfer === 'function') window.startTransfer();
              else _toast('未找到开始传输入口', 'warn');
            } catch(e){ _toast('启动传输失败: ' + e.message, 'err'); }
          }, 250);
        },
        onChanged: function(){
          // 文件被改名/删除/解压后刷新两侧目录 + 清空预览
          _previewCtx = null;
          _renderPreviewPane();
          try { if (_leftPane && _leftPane.load) _leftPane.load(_leftPane.getCwd()); } catch(e){}
          try { if (_rightPane && _rightPane.load) _rightPane.load(_rightPane.getCwd()); } catch(e){}
        },
      });
    }
    midPane.querySelectorAll('.tp-mid-tab').forEach(function(el){
      el.onclick = function(){ _setMidTab(el.getAttribute('data-tab')); };
    });
    midPane.querySelector('.tp-sel-all').onclick = function(){
      _host.querySelectorAll('.tp-item-check').forEach(function(c){ c.checked = true; });
    };
    // v4.38.37 · ▶ 开始传输按钮（中栏顶部，与下方主按钮等价）
    var _startBtn = midPane.querySelector('.tp-start-btn');
    if (_startBtn){
      _startBtn.onclick = function(){
        if (typeof window.startTransfer === 'function') window.startTransfer();
        else _toast('未找到开始传输入口', 'warn');
      };
    }
    // v4.41.4 · ⇪ 桥接到跨模块自动备份 (FlowMini transfer scope)
    //   item.server: 'local' -> local 源 | 'cld_<rid>' -> ☁ 云源(暂不支持) | 其他 srvId -> SSH 远端源(rsync)
    //   ☁ 目标项 (mode=push 且对侧为 cld_) 目前无法从 item 反推 -> 统一引导用户在 mini 卡勾选远端
    var _toFlowBtn = midPane.querySelector('.tp-to-flow');
    if (_toFlowBtn){
      _toFlowBtn.onclick = function(){
        var miniRoot = document.getElementById('flowMini_root_transfer');
        if (!miniRoot){ _toast('⚠ 未找到『跨模块自动备份』卡片, 请刷新页面', 'err'); return; }
        var body = miniRoot.querySelector('.section-body');
        if (body && body.style.display === 'none'){
          var hd = miniRoot.querySelector('.section-header');
          if (hd && typeof toggleSection === 'function') toggleSection(hd);
          else body.style.display = '';
        }
        var localPaths = [], rsyncPaths = [], skipped = [];
        _items.forEach(function(it){
          if (!it || !it.src) return;
          var srv = String(it.server || 'local');
          if (srv === 'local' || srv === '' || srv === '0'){
            if (localPaths.indexOf(it.src) < 0) localPaths.push(it.src);
          } else if (srv.indexOf('cld_') === 0){
            skipped.push(it.src + ' (☁ 云源)');
          } else {
            // SSH 远端源: 桥为 rsync 源路径; 保存时需在下拉选该服务器或先页头连接
            var rp = it.src;
            if (rsyncPaths.indexOf(rp) < 0) rsyncPaths.push(rp);
          }
        });
        var allPaths = localPaths.concat(rsyncPaths);
        if (!allPaths.length){
          _toast('⚠ 无可桥接项' + (skipped.length ? ' (跳过: ' + skipped.join('; ') + ')' : ''), 'warn', 3200);
          return;
        }
        var srcSel = document.getElementById('flowMini_srcType_transfer');
        var useRsync = rsyncPaths.length > 0;
        if (srcSel){
          srcSel.value = useRsync ? 'rsync' : 'local';
          if (window.FlowMini && FlowMini.onSrcTypeChange) FlowMini.onSrcTypeChange('transfer');
        }
        var ta = document.getElementById('flowMini_paths_transfer');
        if (ta){
          var cur = (ta.value || '').split(/\r?\n/).map(function(s){ return s.trim(); }).filter(Boolean);
          allPaths.forEach(function(p){ if (cur.indexOf(p) < 0) cur.push(p); });
          ta.value = cur.join('\n');
          ta.scrollIntoView({behavior:'smooth', block:'center'});
          ta.style.boxShadow = '0 0 0 2px var(--accent,#3498db)';
          setTimeout(function(){ ta.style.boxShadow = ''; }, 1600);
        }
        var msg = '⇪ 已桥接 ' + allPaths.length + ' 个源路径到跨模块自动备份'
                + (useRsync ? ' (含 rsync 远端源 x' + rsyncPaths.length + ' · 保存前请选服务器/先连接)' : '')
                + ' · 请勾选目标远端 + 可选调度后保存';
        _toast(msg, 'success', 3800);
        if (skipped.length) _toast('⚠ 跳过 ' + skipped.length + ' 项: ' + skipped.join('; '), 'warn', 3200);
        miniRoot.scrollIntoView({behavior:'smooth', block:'center'});
      };
    }
    midPane.querySelector('.tp-sel-none').onclick = function(){
      _host.querySelectorAll('.tp-item-check').forEach(function(c){ c.checked = !c.checked; });
    };
    midPane.querySelector('.tp-del-sel').onclick = function(){
      var n = removeSelected();
      if (!n) _toast('请先勾选要删除的项', 'warn');
    };
    midPane.querySelector('.tp-clear').onclick = async function(){
      if (_items.length && !(await rpConfirm({ title:'清空全部传输', danger:true, okText:'清空', body:'确认清空所有 ' + _items.length + ' 项传输？' }))) return;
      clearItems();
    };

    // ① ③ 左右栏（按方向决定）
    _leftPane = _createOnePane(_leftSide, 'left');
    _rightPane = _createOnePane(_rightSide, 'right');

    // 拖拽条
    var grip1 = document.createElement('div');
    grip1.className = 'tp-grip';
    grip1.setAttribute('data-side', 'left');
    // v6.16.12 · 取消左右拖拽条(用户实测): 占位仍保留(网格 5 列结构不变)但 0 宽不可见不可拖
    grip1.style.cssText = 'width:0;display:none';
    grip1.innerHTML = '<div style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:2px;height:30px;background:var(--border);border-radius:1px"></div>';
    grip1.addEventListener('mouseenter', function(){ grip1.firstElementChild.style.background = 'var(--cyan)'; });
    grip1.addEventListener('mouseleave', function(){ if (!_dragData) grip1.firstElementChild.style.background = 'var(--border)'; });

    var grip2 = document.createElement('div');
    grip2.className = 'tp-grip';
    grip2.setAttribute('data-side', 'right');
    // v6.16.12 · 取消左右拖拽条(用户实测)
    grip2.style.cssText = 'width:0;display:none';
    grip2.innerHTML = '<div style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:2px;height:30px;background:var(--border);border-radius:1px"></div>';
    grip2.addEventListener('mouseenter', function(){ grip2.firstElementChild.style.background = 'var(--cyan)'; });
    grip2.addEventListener('mouseleave', function(){ if (!_dragData) grip2.firstElementChild.style.background = 'var(--border)'; });

    grid.appendChild(_leftPane.pane);
    grid.appendChild(grip1);
    grid.appendChild(midPane);
    // v4.66.0 · 恢复上次中间栏 Tab (list/preview); 预览 Tab 需两侧 pane 就绪后绑定
    setTimeout(function(){
      var lastTab = 'list';
      try { lastTab = localStorage.getItem('tp_mid_tab_v1') || 'list'; } catch(e){}
      if (lastTab === 'preview') _setMidTab('preview');
    }, 300);
    grid.appendChild(grip2);
    grid.appendChild(_rightPane.pane);
    _host.appendChild(grid);
    // v6.16.11 · 全屏按钮改内联进各栏工具栏(_buildSrvBar 末尾), 原绝对定位悬浮注入已移除


    // v4.38.37 · 三栏底部竖向拖拽条（上下拖动调整三栏整体高度）
    if (window.VGrip){
      try {
        VGrip.attach(grid, { key: 'tri_transfer', min: 300, max: 1400 });
        grid.style.maxHeight = 'none';  // 高度交给 vgrip 控制
      } catch(e){ console.warn('[TriPane] VGrip', e); }
    }

    // 远端栏特殊增强：服务器列表条（无论左右位置都需要）
    // 但只有当远端栏在左或右时，把 srvbar 注入
    if (_rightSide === 'remote') _injectServerBar(_rightPane, 'right');
    if (_leftSide === 'remote') _injectServerBar(_leftPane, 'left');

    // 初始
    _items = _loadItems();
    renderList();
    renderServerBar();
    _loadServers().then(function(){
      renderServerBar();
      if (_rightSide === 'remote') _injectServerBar(_rightPane, 'right');
      if (_leftSide === 'remote') _injectServerBar(_leftPane, 'left');
    });
    /* v1.0.0 · 用户报"源列表不会刷新出 SSH 服务器": 档案新增/改名后此前要整页刷新才出现。
       这里订阅全局事件, 档案变化即重拉 + 重绘下拉(两侧都刷)。 */
    try {
      var _eb = window.EventBus;
      if (_eb && typeof _eb.on === 'function' && !window.__tpSrvEvHooked){
        window.__tpSrvEvHooked = true;
        ['profile.changed','hub.node.changed','profile.deleted'].forEach(function(tp){
          _eb.on(tp, function(){
            try { window.TriPaneTransfer.refreshServers(); } catch(e){}
          });
        });
      }
    } catch(e){}

    // 拖拽
    _initGrips();

    // 同步方向按钮
    try {
      var upBtn = document.getElementById('dirUp');
      var dnBtn = document.getElementById('dirDown');
      var syBtn = document.getElementById('dirSync');
      if (upBtn) upBtn.classList.toggle('active', _direction === 'up');
      if (dnBtn) dnBtn.classList.toggle('active', _direction === 'down');
      if (syBtn) syBtn.classList.toggle('active', _direction === 'sync');
    } catch(e){}

    // 加载两侧 pane（等 WS 就绪）
    _loadPane(_leftPane);
    _loadPane(_rightPane);
    // v4.98.0 · 初始绑定预览回调 (此前仅 _setMidTab 时绑定, 初始为「传输列表」则从不绑定
    //   → 左/右栏图标·相册单击文件不会出预览)
    try { _bindPreviewMode(_midTab === 'preview'); } catch(e){}
    // v5.4.0 · 预览模式(仅预览/目录浏览)变化 → 立即重绘中栏, 使面包屑显隐即时生效
    try {
      if (!window.__triPmBound){
        window.__triPmBound = true;
        window.addEventListener('rp-preview-mode-changed', function(){
          try { if (_midTab === 'preview') _renderPreviewPane(); } catch(e){}
        });
      }
    } catch(e){}
    // v5.2.0 · 移除自加 flex 拖动条: 三栏本身是 grid + 自带 grid-template-columns 拖拽,
    //   两套机制同时改宽度会互相打架 (左栏撑大/中栏被压到 110px)。沿用组件自带拖拽即可。
    console.log('[TriPaneTransfer] _build complete. _host.innerHTML.length =', _host ? _host.innerHTML.length : 'null');
  }
  // 调试 hook：暴露 _build 给 window 便于排查
  window.TriPaneTransfer = window.TriPaneTransfer || {};
  window.__triPane_lastBuildAt = null;
  var _origBuild = _build;
  function _buildLogged(hostId){
    console.log('[TriPaneTransfer] _build called, hostId=', hostId, '_host was=', window.TriPaneTransfer && window.TriPaneTransfer._state && window.TriPaneTransfer._state().hostId);
    try { _origBuild(hostId); }
    catch(e){ console.error('[TriPaneTransfer] _build threw', e); throw e; }
  }
  // 不替换 _build（避免 break 内部调用），但暴露 getState 包含 lastBuildAt

  function _injectServerBar(pane, pos){
    if (!pane || !pane.pane) return;
    if (pane.pane.querySelector('.tp-srvbar')) return;  // 已存在
    var header = pane.pane.querySelector('div');
    if (!header) return;
    var srvBar = document.createElement('div');
    srvBar.className = 'tp-srvbar';
    srvBar.style.cssText = 'padding:4px 8px;background:var(--bg);border-bottom:1px solid var(--border);display:flex;align-items:center;gap:4px;flex-wrap:wrap';
    header.parentNode.insertBefore(srvBar, header.nextSibling);
  }

  // ==========================================================================
  // 公开 API
  // ==========================================================================
  window.TriPaneTransfer = {
    toggleFullscreen: toggleFullscreen,
    init: function(){ _build(); },
    rebuild: function(){ _loaded = false; _build(); },
    getItems: getItems,
    clear: clearItems,
    addItem: addItem,
    addItems: addItems,
    removeItem: removeItem,
    setDirection: setDirection,
    getState: function(){ return { _leftSide: _leftSide, _rightSide: _rightSide, _direction: _direction }; },
    // v4.97.0 · 供传输完成后自动刷新使用
    getPanes: function(){ return { left: _leftPane, right: _rightPane }; },
    refreshPanes: function(){
      var n = 0;
      [_leftPane, _rightPane].forEach(function(pn){
        if (!pn || typeof pn.load !== 'function') return;
        try { pn.load((typeof pn.getCwd === 'function' ? pn.getCwd() : '') || '/'); n++; } catch(e){}
      });
      // 服务器/共享/云下拉也一并刷新 (挂载点可能在传输后变化)
      try { renderServerBar(); } catch(e){}
      return n;
    },
    getDirection: function(){ return _direction; },
    refreshServers: function(){ return _loadServers().then(function(){ renderServerBar(); }); },
    setOnStart: function(fn){ _onStart = fn; },
    setOnChange: function(fn){ _onChange = fn; },
    getActiveServer: function(){ return _getServerById(_activeServerId); },
    setActiveServer: function(id){ _activeServerId = id; _connectServer(_getServerById(id)); },
    onLoginSuccess: function(){
      var p1 = _loadServers().then(function(){
        renderServerBar();
        if (_rightSide === 'remote') _injectServerBar(_rightPane, 'right');
        if (_leftSide === 'remote') _injectServerBar(_leftPane, 'left');
      });
      // v4.39.3 · 登录后获取本机 df 共享挂载点 -> __dmDfMounts -> df 下拉显示
      var p3 = _fetchDfMounts();
      // v4.41.2 · ☁ 拉取远端存储列表 -> _clouds -> 下拉 ☁ 组渲染
      var p4 = _loadClouds().then(function(){ renderServerBar(); }).catch(function(){});
      // v4.39.4 · 登录自动重新挂载上次已挂载的共享 (持续挂载恢复)
      try {
        if (typeof send === 'function'){
          send({ action: 'share_auto_remount' }, function(d){
            if (d && d.status === 'ok' && d.remounted && d.remounted.length){
              renderServerBar();
            }
            _syncDfMountsGlobal(d);  // 合并 df_mounts 进 __dmDfMounts
          });
        }
      } catch(e){ console.warn('share_auto_remount', e); }
      var p2 = new Promise(function(resolve){
        setTimeout(function(){
          if (_leftPane) _loadPane(_leftPane);
          if (_rightPane) _loadPane(_rightPane);
          resolve();
        }, 600);
      });
      return Promise.all([p1, p2, p3, p4]);
    },
    // 调试
    _items: function(){ return _items; },
    _state: function(){ return { direction: _direction, leftSide: _leftSide, rightSide: _rightSide, widths: _widths, items: _items.length, servers: _servers.length, activeServer: _activeServerId }; },
  };

  // DOMContentLoaded 自动初始化
  document.addEventListener('DOMContentLoaded', function(){
    setTimeout(function(){
      try {
        if (document.getElementById('triPaneTransfer') && !window.TriPaneTransfer._state){
          window.TriPaneTransfer.init();
        }
      } catch(e){ console.warn('[TriPaneTransfer] init', e); }
    }, 700);
  });

  // panel-transfer 激活时强制 init
  (function(){
    function _check(panel){
      if (panel && panel.classList && panel.classList.contains('active')){
        try { window.TriPaneTransfer.init(); } catch(e){}
      }
    }
    document.addEventListener('DOMContentLoaded', function(){
      setTimeout(function(){
        var panel = document.getElementById('panel-transfer');
        if (!panel) return;
        _check(panel);
        if (typeof MutationObserver !== 'undefined'){
          var mo = new MutationObserver(function(muts){
            for (var i=0;i<muts.length;i++){
              if (muts[i].attributeName === 'class'){ _check(panel); break; }
            }
          });
          mo.observe(panel, { attributes: true, attributeFilter: ['class'] });
        }
      }, 800);
    });
  })();
})();
