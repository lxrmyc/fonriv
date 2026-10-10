/* ============================================================================
 * transfer_tri.js · v4.38.23
 * 三列文件传输组件：源 | 传输项 | 目标
 *  - 工厂模式: TransferTri.create(hostEl, opts={scope, srvList, onLog})
 *  - 4 种传输方向: 本地→远端 / 远端→本地 / 本地→本地 / 远端→远端
 *  - 每栏独立 FileBrowser 实例 + 独立传输项列表 + 独立操作日志（外部传入）
 *  - 远端-远端模式: 源/目标栏下拉禁用"本机"
 *  - localStorage 持久化传输项列表（按 scope）
 * ========================================================================== */
(function(){
  'use strict';

  var STORAGE_PREFIX = 'tri_items_';
  // v4.38.24 · 微调列宽比例（左中右 1.2/1.5/1.2）让中间源/目标列更舒展
  var DEFAULT_HEIGHTS = { left: 1.2, mid: 1.5, right: 1.2 };

  function _storageKey(scope){ return STORAGE_PREFIX + (scope||'transfer'); }

  function _loadItems(scope){
    try {
      var raw = localStorage.getItem(_storageKey(scope));
      return raw ? JSON.parse(raw) : [];
    } catch(e){ return []; }
  }
  function _saveItems(scope, items){
    try { localStorage.setItem(_storageKey(scope), JSON.stringify(items)); } catch(e){}
  }

  function _esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  // v4.38.33 · SSH 源栏浏览用 · 字节格式化
  function _fmtBytes(n){
    n = parseInt(n, 10) || 0;
    if (n < 1024) return n + ' B';
    var units = ['KB','MB','GB','TB'], i = -1;
    do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
    return n.toFixed(n >= 100 ? 0 : 1) + ' ' + units[i];
  }

  // v4.40.0 P1 · 远端存储浏览用 · epoch 秒 -> "MM-DD HH:MM"
  function _fmtTime(t){
    t = parseInt(t, 10) || 0;
    if (!t) return '';
    try {
      var d = new Date(t * 1000);
      var p2 = function(x){ return (x < 10 ? '0' : '') + x; };
      return (d.getMonth()+1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
    } catch(_){ return ''; }
  }

  // v4.39.2 · 判断主机是否为本机 (用于 df 挂载点浏览: 本机挂载点应走 list_dir 而非 SSH)
  function _isLocalHost(host){
    if (!host) return false;
    host = String(host).trim().toLowerCase();
    if (host === '127.0.0.1' || host === 'localhost' || host === '::1') return true;
    // 常见本机网卡 IP (与后端 MOUNT_ROOT 命名空间一致)
    return host === '0.0.0.0';
  }

  function _buildSrvOptions(srvList, currentId, opts){
    opts = opts || {};
    var html = '<option value="0"'+(currentId===0||!currentId?' selected':'')+'>📌 本机</option>';
    (srvList || []).forEach(function(s){
      var id = s.srv_id || s.id;
      // v4.38.24 · 临时服务器加 ⌚ 标识 + 长按删除提示
      var label = s.label || (s.host + ':' + s.port);
      var icon  = s.isTemp ? '⌚' : '🖥';
      var disabled = opts.disableLocal && (id === 0 || id === '0') ? ' disabled' : '';
      var selected = (id === currentId) ? ' selected' : '';
      var title    = s.isTemp ? ' title="临时服务器 · 刷新页面后会保留(直到localStorage清理)"' : '';
      html += '<option value="'+_esc(id)+'"'+disabled+selected+title+'>'+icon+' '+_esc(label)+'</option>';
    });
    return html;
  }

  // ===== v4.38.35 · UniPane 统一来源模型 =====
  // 来源描述符: {kind:'local'} | {kind:'ssh',srvId} | {kind:'df',mount?,host?} | {kind:'cloud',cloudId}
  // window.__dmDfMounts = {host, ts, mounts:[{mount,source,avail,use_pct}]} · disk_manager 扫描后注入
  function _getDfMounts(){
    try {
      var c = window.__dmDfMounts;
      if (c && c.mounts && c.mounts.length) return c;
      return { host:'', mounts:[] };
    } catch(_){ return { host:'', mounts:[] }; }
  }
  function _getCloudRemotes(){
    try { return (window.__cloudRemotesCache && window.__cloudRemotesCache.length) ? window.__cloudRemotesCache : []; }
    catch(_){ return []; }
  }
  // v4.40.0 P1 · cloudId (uuid 或数字 id) -> 云配置行 (含 id 供 remote_ls/remote_download)
  function _getCloudById(cloudId){
    var cs = _getCloudRemotes();
    for (var i=0;i<cs.length;i++){
      var c = cs[i];
      if (String(c.uuid || '') === String(cloudId) || String(c.id) === String(cloudId)) return c;
    }
    return null;
  }
  // v4.40.0 · 网络共享辅助: 列表/查uuid/挂载点 (__sharesCache · 与 TriPaneTransfer 同源)
  var _SHARE_ROOT = '/var/lib/fonriv_mounts/shares/';
  function _getShares(){
    try { return (window.__sharesCache && window.__sharesCache.length) ? window.__sharesCache : []; }
    catch(_){ return []; }
  }
  function _getShareByUuid(uid){
    var arr = _getShares();
    for (var i=0;i<arr.length;i++){ if (arr[i] && arr[i].uuid === uid) return arr[i]; }
    return null;
  }
  function _shareMnt(s){
    if (!s || !s.uuid) return '';
    try {
      var ms = (window.__dmDfMounts && window.__dmDfMounts.mounts) || [];
      for (var i=0;i<ms.length;i++){ if (ms[i] && ms[i].mount === _SHARE_ROOT + s.uuid) return ms[i].mount; }
    } catch(_){}
    return s.mounted ? (_SHARE_ROOT + s.uuid) : '';
  }
  // 来源下拉 (optgroup 分组): 📌本机 | 🖥服务器 | ⌚临时 | 📊df挂载点 | ☁远端存储
  function _buildSrcOptions(desc, ctx){
    ctx = ctx || {};
    var cur = _srcVal(desc);
    var html = '<optgroup label="📌 本机">'
      + '<option value="local"'+(cur==='local'?' selected':'')+'>📂 本机文件系统</option></optgroup>';
    var srvs = [], temps = [];
    (ctx.srvList || []).forEach(function(s){ if (s && s.isTemp) temps.push(s); else srvs.push(s); });
    html += '<optgroup label="🖥 服务器">';
    if (!srvs.length) html += '<option value="" disabled>（无 · ✚临时 或到服务器面板添加）</option>';
    srvs.forEach(function(s){
      var v = 'srv:' + (s.srv_id || s.id);
      html += '<option value="'+_esc(v)+'"'+(cur===v?' selected':'')+'>'+_esc(s.label || (s.host+':'+s.port))+'</option>';
    });
    html += '</optgroup>';
    if (temps.length){
      html += '<optgroup label="⌚ 临时">';
      temps.forEach(function(s){
        var v = 'srv:' + (s.srv_id || s.id);
        html += '<option value="'+_esc(v)+'"'+(cur===v?' selected':'')+'>'+_esc(s.label || (s.host+':'+s.port))+'</option>';
      });
      html += '</optgroup>';
    }
    if (ctx.showDf){
      var mounts = _getDfMounts();
      // v4.40.0 · df 组过滤共享挂载点 (共享单独归 "📂 网络共享" 组)
      var SR = '/var/lib/fonriv_mounts/shares/';
      var dfOnly = [];
      mounts.mounts.forEach(function(mt){ if (!(mt && mt.mount && mt.mount.indexOf(SR) === 0)) dfOnly.push(mt); });
      html += '<optgroup label="📊 df 挂载点 ('+_esc(mounts.host||'?')+')">';
      if (!dfOnly.length){
        html += '<option value="" disabled>（扫描磁盘后可用）</option>';
      } else {
        dfOnly.forEach(function(mt){
          // v4.40.0 · 索引改为按 dfOnly 数组 (过滤后) · 需在 _parseSrcVal/_srcVal 同步映射
          var v = 'df:' + mt.mount;
          // v4.39.3 · df 挂载点友好显示: 来源-短名 (与 TriPaneTransfer 一致)
          var lbl = (typeof window.fmtDfLabel === 'function') ? window.fmtDfLabel(mt) : mt.mount;
          html += '<option value="'+_esc(v)+'"'+(cur===v?' selected':'')+' title="'+_esc(mt.mount||'')+'">📊 '+_esc(lbl)+' · '+_esc(mt.avail||'')+'可用</option>';
        });
      }
      html += '</optgroup>';
    }
    // v4.40.0 · 📂 网络共享组 (已挂载 ✓ 可浏览 · 未挂载 🔌 选中自动挂载)
    {
      var shares = _getShares();
      html += '<optgroup label="📂 网络共享">';
      if (!shares.length){
        html += '<option value="" disabled>（未配置 · 到「网络共享」面板添加）</option>';
      } else {
        shares.forEach(function(s){
          var mnt = _shareMnt(s);
          var isM = !!mnt;
          var v = 'share:' + s.uuid;
          html += '<option value="'+_esc(v)+'"'+(cur===v?' selected':'')+' title="'+_esc(isM?mnt:(s.host+':'+s.share))+'">'+(isM?'✓ ':'🔌 ')+_esc(s.name)+' · '+_esc(String(s.proto||'').toUpperCase())+' '+_esc(s.host+':'+s.share)+'</option>';
        });
      }
      html += '</optgroup>';
    }
    if (ctx.showCloud){
      var clouds = _getCloudRemotes();
      html += '<optgroup label="☁ 远端存储">';
      if (!clouds.length){
        html += '<option value="" disabled>（未配置 · 到「远端存储」面板添加）</option>';
      } else {
        clouds.forEach(function(c){
          var v = 'cloud:' + (c.id != null ? c.id : c.uuid);  // v4.97.0 · 优先数字 id
          html += '<option value="'+_esc(v)+'"'+(cur===v?' selected':'')+'>☁ '+_esc(c.label || c.name || ('remote#'+(c.id||'?')))+' · '+_esc(c.provider||c.type||'')+'</option>';
        });
      }
      html += '</optgroup>';
    }
    // 当前来源已不在列表 (如 df 缓存失效) · 追加一个占位保持显示
    if (cur !== 'local' && cur.indexOf && cur.indexOf('srv:') !== 0){
      var known = false;
      try {
        var selProbe = document.createElement('select');
        selProbe.innerHTML = html;
        known = !!selProbe.querySelector('option[value="'+_esc(cur)+'"]');
      } catch(_){}
      if (!known && cur.indexOf('df:') === 0 && desc && desc.mount){
        html += '<option value="'+_esc(cur)+'" selected>📊 '+_esc(desc.host||'')+':'+_esc(desc.mount)+'</option>';
      }
    }
    return html;
  }
  // 描述符 -> 下拉 value
  function _srcVal(desc){
    if (!desc || desc.kind === 'local') return 'local';
    if (desc.kind === 'ssh') return 'srv:' + desc.srvId;
    if (desc.kind === 'cloud') return 'cloud:' + (desc.cloudId != null ? desc.cloudId : '');
    if (desc.kind === 'share') return 'share:' + (desc.uuid || '');
    if (desc.kind === 'df'){
      // v4.40.0 · df value 改用挂载点路径 (不再用易漂移的数组索引)
      if (desc.mount) return 'df:' + desc.mount;
      return 'df:head';
    }
    return 'local';
  }
  // 下拉 value -> 描述符
  function _parseSrcVal(v){
    if (!v || v === 'local') return { kind:'local' };
    var m;
    // v5.52.0 修: 统一数据源(SP.serverRows/sp_list)后档案 id 是 **GUID 字符串**,
    //   旧正则只认 /^srv:(-?\d+)$/ → 解析失败后**静默回落 {kind:'local'}** →
    //   用户"选了 9.21 却列本机根目录"(DM/双栏三栏)。现同时接受数字与 GUID。
    if ((m = /^srv:(.+)$/.exec(v))){
      var _sid = m[1];
      return { kind:'ssh', srvId: /^-?\d+$/.test(_sid) ? Number(_sid) : _sid };
    }
    if ((m = /^share:(.+)$/.exec(v))){
      // v4.40.0 · 网络共享: 挂载点在本机 -> kind='share' (load 时走 list_dir)
      var sh = _getShareByUuid(m[1]);
      if (sh) return { kind:'share', uuid: m[1], name: sh.name, host: sh.host, share: sh.share, proto: sh.proto, mounted: !!sh.mounted };
      return { kind:'share', uuid: m[1] };
    }
    if ((m = /^df:(.+)$/.exec(v))){
      // v4.40.0 · df:<mount_path> · 挂载点路径直接解析 (不再依赖数组索引)
      if (v === 'df:head') return { kind:'df', host: _getDfMounts().host };
      var mounts = _getDfMounts();
      var mt = null;
      for (var i=0;i<mounts.mounts.length;i++){ if (mounts.mounts[i].mount === m[1]){ mt = mounts.mounts[i]; break; } }
      return mt ? { kind:'df', mount: mt.mount, host: mounts.host } : { kind:'df', mount: m[1], host: mounts.host };
    }
    if ((m = /^cloud:(.+)$/.exec(v))) return { kind:'cloud', cloudId: m[1] };
    return { kind:'local' };
  }

  function create(hostEl, opts){
    opts = opts || {};
    var scope      = opts.scope      || 'transfer';
    var onLog      = opts.onLog      || function(){};
    var srvList    = opts.srvList    || [];
    var title      = opts.title      || '文件传输';
    var hideDirBtn = opts.hideDirBtn || false;  // v4.38.29 · 外部已有 dir-btn 时隐藏内部
    var initialDirection = opts.direction || 'up';  // up=本地→远端 / down=远端→本地 / same=本地→本地 / cross=远端→远端

    var st = {
      direction: initialDirection,    // up / down / same / cross / sync
      sourceSrvId: 0,
      targetSrvId: 0,
      // v4.38.35 · UniPane 来源描述符
      //   {kind:'local'} | {kind:'ssh',srvId} | {kind:'df',mount,host} | {kind:'cloud',cloudId}
      sourceDesc: (opts.dmSshSource ? { kind:'df' } : { kind:'local' }),  // DM 初始: df 挂载点 (SSH 锚定)
      targetDesc: { kind:'local' },
      items: (function(){
        // v4.41.0 P3-3 · 断点续传: 刷新后把卡在 running 的项重置为 retry (rsync 已带 --partial,
        //   重传自动跳过已完整部分); abort 项也重置为 retry 供用户选择重传/删除
        var loaded = _loadItems(scope) || [];
        var dirty = false;
        loaded.forEach(function(it){
          if (it && (it.status === 'running' || it.status === 'abort')){
            it.status = 'retry'; dirty = true;
          }
        });
        if (dirty) _saveItems(scope, loaded);
        return loaded;
      })(),
      widths: DEFAULT_HEIGHTS,
    };

    // -- 容器 --
    var wrap = document.createElement('div');
    wrap.className = 'tri-wrap';
    wrap.setAttribute('data-scope', scope);
    wrap.style.cssText = 'display:flex;flex-direction:column;gap:6px';

    // -- 方向栏 --
    var dirBar = document.createElement('div');
    dirBar.className = 'tri-dir';
    dirBar.style.cssText = 'display:flex;align-items:center;gap:6px;padding:6px 10px;background:var(--bg2);border:1px solid var(--border);border-radius:6px;flex-wrap:wrap';
    dirBar.innerHTML =
      '<span style="color:var(--cyan);font-weight:600">↔ 传输方向:</span>' +
      '<div class="tri-dir-btns" style="display:flex;gap:4px">' +
        '<button class="tri-dir-btn" data-dir="up"    title="本地 → 远端">⬆ 本地→远端</button>' +
        '<button class="tri-dir-btn" data-dir="down"  title="远端 → 本地">⬇ 远端→本地</button>' +
        '<button class="tri-dir-btn" data-dir="cross" title="远端 → 远端（需连接两台远端）">🔁 远端→远端</button>' +
        '<button class="tri-dir-btn" data-dir="sync"  title="双向同步（两侧新增/修改的文件互相同步 · 同名冲突较新者胜 · 删除不传播 · v4.51 真双向）">⟳ 双向同步</button>' +
        '<button class="tri-dir-btn" data-dir="same"  title="本地 → 本地（同一台机内的两个目录）">⇄ 本地→本地</button>' +
      '</div>' +
      '<span class="tri-dir-hint" style="margin-left:auto;color:var(--text3);font-size:11px"></span>';

    // v4.38.29 · 外部已有 dir-btn 时, 隐藏内部 dir-bar
    if (hideDirBtn){
      dirBar.style.display = 'none';
      dirBar.style.visibility = 'hidden';
      dirBar.style.height = '0';
      dirBar.style.margin = '0';
      dirBar.style.padding = '0';
      dirBar.setAttribute('aria-hidden', 'true');
    }

    // -- 三列 grid --
    var grid = document.createElement('div');
    grid.className = 'tri-grid';
    // v6.16.12 · 取消左右拖拽条 → 固定比例自适应
grid.style.cssText = 'display:grid;grid-template-columns:1.2fr 0px 1.5fr 0px 1.2fr;gap:0;margin:6px 0;min-height:380px;height:60vh;max-height:60vh;overflow:hidden;align-items:stretch';

    grid.innerHTML =
      '<div class="tri-cell tri-cell-source" data-side="source" style="min-width:0;display:flex;flex-direction:column;overflow:hidden"></div>' +
      '<div class="tri-grip" data-side="left"  title="拖动调节源栏宽度" style="cursor:col-resize;background:var(--border);width:6px;align-self:stretch;user-select:none"></div>' +
      '<div class="tri-cell tri-cell-mid"    data-side="middle" style="min-width:0;display:flex;flex-direction:column;overflow:hidden"></div>' +
      '<div class="tri-grip" data-side="right" title="拖动调节目标栏宽度" style="cursor:col-resize;background:var(--border);width:6px;align-self:stretch;user-select:none"></div>' +
      '<div class="tri-cell tri-cell-target" data-side="target" style="min-width:0;display:flex;flex-direction:column;overflow:hidden"></div>';

    wrap.appendChild(dirBar);
    wrap.appendChild(grid);
    hostEl.appendChild(wrap);

    // v4.38.37 · DM 三栏底部竖向拖拽条（上下拖动调整三栏整体高度）
    if (window.VGrip){
      try {
        (function(){
          var key = 'tri_' + scope;
          var old = wrap.querySelector('.vgrip-' + key);
          if (old) old.remove();
          VGrip.attach(grid, { key: key, min: 300, max: 1400 });
          // v4.38.40 · 初始默认高度: 无保存值时给 50vh, 避免塌到 min-height 后内容挤
          if (!localStorage.getItem('rp_vgrip_' + key)){
            grid.style.height = '50vh';
          }
          grid.style.maxHeight = 'none';
        })();
      } catch(e){ console.warn('[TransferTri] VGrip', e); }
    }

    // -- 源/目标/中 三栏内容 --
    var sourceCell = grid.querySelector('.tri-cell-source');
    var midCell    = grid.querySelector('.tri-cell-mid');
    var targetCell = grid.querySelector('.tri-cell-target');

    // v4.38.37 · _autoRetarget: 用户进入某目录后，把「从对侧已加入」的传输项的对侧路径
    // 重定位到该目录（行为对齐文件传输页: 点了目录即为目标，直接点开始传输）。
    // sideKey = 用户刚导航的栏 ('source'|'target'), newDir = 该栏新的 cwd（带尾斜杠）
    //   - 用户在 target 栏进入 /data/backup/ -> 所有 pending 项 dst 重写为 /data/backup/<basename>
    //   - 用户在 source 栏进入 /var/log/    -> 所有 pending 项 src 重写为 /var/log/<basename>
    //     （仅当该项 src basename 与源栏原目录同名时；避免误改用户手工改过的路径）
    // 已开始(running/done/error/skip)的项不动。
    function _autoRetarget(sideKey, newDir){
      if (!newDir || typeof newDir !== 'string') return 0;
      if (newDir.slice(-1) !== '/') newDir += '/';
      var n = 0;
      var lastDir = _autoRetarget._last || {};
      var prevCwd = lastDir[sideKey];
      _autoRetarget._last = lastDir;
      lastDir[sideKey] = newDir;
      if (!st.items || !st.items.length) return 0;
      st.items.forEach(function(it){
        if (!it || it.status === 'running' || it.status === 'done' || it.status === 'error' || it.status === 'skip') return;
        if (sideKey === 'target'){
          // target 栏进入新目录 -> 该目录成为所有 pending 项的目的地
          var bn = (it.src || '').replace(/\/+$/,'').split('/').pop();
          if (!bn) return;
          var nd = newDir + bn + ((it.type === 'dir') ? '/' : '');
          if (it.dst !== nd){ it.dst = nd; n++; }
        } else {
          // source 栏进入新目录 -> 只重定位「路径仍停留在原 cwd」的项（防误改）
          var sbn = (it.src || '').replace(/\/+$/,'').split('/').pop();
          if (!sbn) return;
          if (prevCwd && it.src === prevCwd + sbn + ((it.type === 'dir') ? '/' : '')){
            it.src = newDir + sbn + ((it.type === 'dir') ? '/' : '');
            n++;
          }
        }
      });
      if (n){
        _saveItems(scope, st.items);
        _renderItems();
        onLog('📍 已重定位 ' + n + ' 个传输项 -> ' + newDir, 'ok');
      }
      return n;
    }

    function _buildPaneContent(cell, paneTitle, sideKey){
      cell.innerHTML =
        // 头部第一行：标题 + 服务器下拉 + 连接 + 临时按钮
        '<div class="tri-pane-head" style="display:flex;align-items:center;gap:6px;padding:6px 10px;background:var(--bg3);border-bottom:1px solid var(--border);font-size:12px;font-weight:600">' +
          '<span class="tri-pane-title" data-side="'+sideKey+'" style="color:var(--cyan);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:26%;min-width:0;flex-shrink:1" title="'+_esc(paneTitle)+'">'+paneTitle+'</span>' +
          '<select class="tri-srv-sel" data-side="'+sideKey+'" style="flex:1;min-width:80px;padding:2px 4px;font-size:11px"></select>' +
          '<button class="btn btn-sm tri-srv-connect" data-side="'+sideKey+'" style="padding:1px 6px;font-size:11px" title="连接选中的服务器">🔌 连接</button>' +
          '<button class="btn btn-sm tri-srv-temp" data-side="'+sideKey+'" style="padding:1px 6px;font-size:11px;color:var(--yellow)" title="手动配置临时服务器连接">✚ 临时</button>' +
        '</div>' +
        // v4.38.24 · 临时连接配置面板（默认折叠，点 ✚ 临时 后展开）
        '<div class="tri-temp-panel" data-side="'+sideKey+'" style="display:none;padding:6px 10px;background:var(--bg2);border-bottom:1px dashed var(--border);font-size:11px">' +
          '<div style="display:grid;grid-template-columns:60px 1fr 60px 70px;gap:4px 6px;align-items:center">' +
            '<label>主机</label><input class="tri-tmp-host" data-side="'+sideKey+'" type="text" placeholder="192.168.1.100" style="font-size:11px;padding:2px 4px">' +
            '<label>端口</label><input class="tri-tmp-port" data-side="'+sideKey+'" type="number" value="22" style="font-size:11px;padding:2px 4px">' +
            '<label>用户</label><input class="tri-tmp-user" data-side="'+sideKey+'" type="text" value="root" style="font-size:11px;padding:2px 4px">' +
            '<label>认证</label><select class="tri-tmp-auth" data-side="'+sideKey+'" style="font-size:11px;padding:2px 4px"><option value="pass">密码</option><option value="key">密钥</option></select>' +
          '</div>' +
          '<div style="display:flex;gap:4px;align-items:center;margin-top:4px">' +
            '<input class="tri-tmp-val" data-side="'+sideKey+'" type="password" placeholder="密码 / 私钥路径" style="flex:1;font-size:11px;padding:2px 4px">' +
            '<button class="btn btn-sm tri-tmp-save" data-side="'+sideKey+'" style="padding:2px 8px;font-size:11px;background:var(--green);color:#000" title="把当前临时配置加入服务器池（下拉可选用）">➕ 加入</button>' +
            '<button class="btn btn-sm tri-tmp-cancel" data-side="'+sideKey+'" style="padding:2px 8px;font-size:11px" title="折叠临时配置面板">✕</button>' +
          '</div>' +
          '<div class="tri-tmp-msg" data-side="'+sideKey+'" style="margin-top:4px;font-size:10px;color:var(--text3);min-height:14px"></div>' +
        '</div>' +
        '<div class="tri-pane-body" data-side="'+sideKey+'" style="flex:1;min-height:0;overflow:hidden;display:flex;flex-direction:column"></div>' +
        '<div class="tri-pane-foot" style="display:flex;align-items:center;gap:6px;padding:4px 10px;border-top:1px solid var(--border);background:var(--bg2);font-size:11px">' +
          '<button class="btn btn-sm tri-add-sel" data-side="'+sideKey+'" style="padding:1px 8px;font-size:11px;color:var(--green)" title="将当前目录或选中项加入传输项">+ ➕ 选中加入</button>' +
          '<span class="tri-pane-status" style="flex:1;color:var(--text3)">未连接</span>' +
        '</div>';
      // v4.38.24 · 临时面板交互：✚ 临时 → 展开/折叠, 认证切换 → 改 input type
      var tempBtn = cell.querySelector('.tri-srv-temp');
      var tempPanel = cell.querySelector('.tri-temp-panel');
      var tempAuth = cell.querySelector('.tri-tmp-auth');
      var tempVal  = cell.querySelector('.tri-tmp-val');
      var tempSave = cell.querySelector('.tri-tmp-save');
      var tempCancel = cell.querySelector('.tri-tmp-cancel');
      var tempMsg = cell.querySelector('.tri-tmp-msg');
      tempBtn.onclick = function(){
        var showing = tempPanel.style.display !== 'none';
        tempPanel.style.display = showing ? 'none' : 'block';
        if (!showing){
          // v4.38.24 · 展开时若下拉当前是临时 srv 且 form host 字段为空才回填
          //   避免覆盖用户已填写的字段
          var cur = (sideKey === 'source') ? st.sourceSrvId : st.targetSrvId;
          var srv = cur ? _resolveFromPool(cur) : null;
          var hostInput = cell.querySelector('.tri-tmp-host');
          if (srv && srv.isTemp && hostInput && !hostInput.value.trim()){
            hostInput.value = srv.host;
            cell.querySelector('.tri-tmp-port').value = srv.port || 22;
            cell.querySelector('.tri-tmp-user').value = srv.user || 'root';
            cell.querySelector('.tri-tmp-auth').value = srv.auth_type || 'pass';
            cell.querySelector('.tri-tmp-val').value  = srv.password || srv.key || '';
            cell.querySelector('.tri-tmp-auth').onchange();
          }
        }
      };
      tempCancel.onclick = function(){ tempPanel.style.display = 'none'; tempMsg.textContent = ''; };
      tempAuth.onchange = function(){
        // 切到 key 时 placeholder 提示"私钥路径"
        tempVal.type = (tempAuth.value === 'key') ? 'text' : 'password';
        if (tempAuth.value === 'key') tempVal.placeholder = '私钥路径（如 /root/.ssh/id_rsa）';
        else tempVal.placeholder = '密码';
      };
      tempSave.onclick = function(){
        var host = cell.querySelector('.tri-tmp-host').value.trim();
        var port = parseInt(cell.querySelector('.tri-tmp-port').value) || 22;
        var user = cell.querySelector('.tri-tmp-user').value.trim() || 'root';
        var at   = cell.querySelector('.tri-tmp-auth').value;
        var val  = cell.querySelector('.tri-tmp-val').value;
        if (!host){ tempMsg.style.color='var(--red)'; tempMsg.textContent='✗ 请填主机 IP'; return; }
        if (!val){ tempMsg.style.color='var(--red)'; tempMsg.textContent='✗ 请填密码或密钥路径'; return; }
        var srv = (window.SrvPool && window.SrvPool.addTemp) ? window.SrvPool.addTemp({
          host: host, port: port, user: user,
          auth_type: at,
          password: (at === 'pass') ? val : '',
          key: (at === 'key')  ? val : '',
        }) : null;
        if (!srv){ tempMsg.style.color='var(--red)'; tempMsg.textContent='✗ SrvPool 不可用'; return; }
        // 刷新下拉 + 自动选中新加的临时 srv (v4.38.35 · 描述符驱动)
        var newDesc = { kind:'ssh', srvId: srv.srv_id };
        if (sideKey === 'source'){ st.sourceDesc = newDesc; st.sourceSrvId = srv.srv_id; }
        else { st.targetDesc = newDesc; st.targetSrvId = srv.srv_id; }
        _refreshSrvSel();
        var pane = (sideKey === 'source') ? st.sourcePane : st.targetPane;
        if (pane && pane.setDesc) pane.setDesc(newDesc, '/');
        _updateDirFromDesc();
        tempMsg.style.color='var(--green)';
        tempMsg.textContent = '✓ 已加入临时服务器池: ' + srv.label + ' (id=' + srv.srv_id + ')';
        onLog('➕ 临时服务器已加入: ' + srv.label + ' (' + sideKey + ')', 'ok');
        // 1.5s 后折叠
        setTimeout(function(){ tempPanel.style.display = 'none'; tempMsg.textContent=''; }, 1500);
      };
    }
    // v4.38.24 · _resolveFromPool · 内部查找 srv（含已保存+临时）
    function _resolveFromPool(srvId){
      // 从合并列表（含临时）里查
      // v4.41.1 · 宽松比较: srvId 数字/字符串统一 String 匹配
      var all = (window.SrvPool && window.SrvPool.getSrvList) ? window.SrvPool.getSrvList() : [];
      for (var i=0;i<all.length;i++) if (String(all[i].srv_id) === String(srvId) || String(all[i].id) === String(srvId)) return all[i];
      // 0 = 本机
      if (!srvId || srvId === 0) return { srv_id: 0, host: '127.0.0.1', port: 22, user: 'root', isTemp: false };
      return null;
    }
    _buildPaneContent(sourceCell, '📂 源', 'source');
    _buildPaneContent(targetCell, '🎯 目标', 'target');
    midCell.innerHTML =
      // v4.66.0 · DM 中间栏双 Tab (传输项 / 文件预览)
      '<div class="tri-mid-tabs" style="display:flex;gap:0;background:var(--bg3);border-bottom:1px solid var(--border)">' +
        '<div class="tri-mid-tab active" data-tab="list" style="flex:1;text-align:center;padding:7px 10px;font-size:12px;font-weight:600;cursor:pointer;color:var(--cyan);border-bottom:2px solid var(--cyan)">📋 传输项</div>' +
        '<div class="tri-mid-tab" data-tab="preview" style="flex:1;text-align:center;padding:7px 10px;font-size:12px;font-weight:600;cursor:pointer;color:var(--text3);border-bottom:2px solid transparent">👁 文件预览</div>' +
      '</div>' +
      '<div class="tri-items-toolbar" style="display:flex;align-items:center;gap:6px;padding:6px 10px;background:var(--bg3);border-bottom:1px solid var(--border);font-size:12px;font-weight:600">' +
        '<span style="color:var(--cyan)">📋 传输项</span>' +
        '<span class="tri-items-count" style="color:var(--text3);font-size:11px">0 项</span>' +
        '<span style="flex:1"></span>' +
        '<button class="btn btn-sm tri-audit"  style="padding:2px 10px;font-size:12px;background:var(--cyan);color:#000" title="传输前 dry-run 对比源/目标差异清单">🔍 审计</button>' +
        '<button class="btn btn-sm tri-to-flow" style="padding:2px 10px;font-size:12px;background:var(--purple);color:#fff" title="把传输项桥接到『跨模块自动备份』流程（本地/SSH 源 -> ☁ 远端存储目标，支持定时调度）">⇪ 自动备份</button>' +
        '<button class="btn btn-sm tri-start"   style="padding:2px 10px;font-size:12px;background:var(--green);color:#000">▶ 开始传输</button>' +
        '<button class="btn btn-sm tri-abort"  style="padding:2px 8px;font-size:12px;background:var(--red);color:#fff" disabled>⏹ 中止</button>' +
        '<button class="btn btn-sm tri-clear"  style="padding:2px 8px;font-size:11px" title="清空传输项">🗑 清空</button>' +
      '</div>' +
      '<div class="tri-items-body" style="flex:1;min-height:0;overflow:auto;padding:4px 8px;font-family:monospace;font-size:12px"></div>' +
      // v4.66.0 · 文件预览容器 (默认隐藏)
      '<div class="tri-preview" style="display:none;flex:1;min-height:0;flex-direction:column;background:var(--bg1)"></div>';

    // -- v4.38.33 · DM 专用 SSH 源栏（disk_list_dir · 复刻旧 dm-browser）--
    // 与 FileBrowser.createPane 同形接口: { pane, load(p), getCwd(), setEntries(), destroy() }
    // 数据来源: window.send({action:'disk_list_dir', ...getConnAuth()}) -> disk_list_dir_result
    function _dmSshConnAuth(){
      // v4.38.33 · 与 DM scan 完全相同的凭据源 (self.getConn -> getSrvAuth)
      //   scan 能列出 df 表 -> 浏览必能用。getSrvAuth 内部已处理 dm form fallback + 密码编码。
      var a = { host:'', port:22, user:'root', auth_type:'pass', password:'', key:'', passphrase:'' };
      try {
        if (typeof window.getSrvAuth === 'function'){
          var s = window.getSrvAuth();
          if (s && s.host){
            a = { host:s.host, port:s.port||22, user:s.user||'root', auth_type:s.auth_type||'pass',
                  password:s.password||'', key:s.key||'', passphrase:s.passphrase||'' };
          }
        }
      } catch(_){}
      if (!a.host && window.DiskManager && window.DiskManager.instance){
        try {
          var dmInst = window.DiskManager.instance('disk_manager');
          var c = dmInst && dmInst.getConn && dmInst.getConn();
          if (c && c.host) a = { host:c.host, port:c.port||22, user:c.user||'root', auth_type:c.auth_type||'pass', password:c.password||'', key:c.key||'', passphrase:c.passphrase||'' };
        } catch(_){}
      }
      return a;
    }

    // -- v4.38.35 · UniPane · 左右通用统一浏览栏 (取代 _buildDmSshPane / FileBrowser.createPane) --
    // 来源描述符驱动: local -> list_dir | ssh/df -> disk_list_dir (SSH, 自带凭据) | cloud -> 占位(Phase 2)
    // 事件路由: 直接挂 ws message handler (不走 send() 回调 · dir_result/disk_list_dir_result 均可达)
    function _buildUniPane(bodyEl, sideKey){
      var cell = (sideKey === 'source') ? sourceCell : targetCell;
      var ps = {
        desc: (sideKey === 'source') ? st.sourceDesc : st.targetDesc,
        cwd: '/',
        entries: [], loadId: 0, selMode: false, lastMsg: '',
        // v4.97.0 · 视图模式 (list|icon|detail|gallery)
        view: (function(){ try { return localStorage.getItem('uni_view') || 'list'; } catch(e){ return 'list'; } })(),
      };
      var pane = document.createElement('div');
      pane.className = 'uni-pane';
      pane.style.cssText = 'display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden';

      // 工具行: 路径 + ☐选择 + ⬆ + 🔄
      var bar = document.createElement('div');
      bar.style.cssText = 'display:flex;align-items:center;gap:4px;padding:4px 6px;background:var(--bg2);border-bottom:1px solid var(--border);font-size:11px';
      bar.innerHTML =
        '<div class="dm-ssh-path uni-path" style="flex:1;min-width:60px;color:var(--cyan);font-family:monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer" title="点击返回上一级">/</div>' +
        '<button class="btn btn-sm dm-ssh-selmode uni-selmode" style="padding:1px 6px;font-size:10px;background:var(--bg3);color:var(--cyan);border:1px solid var(--cyan)" title="切换到选择模式：勾选文件/目录后批量加入">☐ 选择</button>' +
        '<button class="btn btn-sm dm-ssh-up uni-up" style="padding:1px 6px;font-size:10px" title="上一级">⬆</button>' +
        '<button class="btn btn-sm dm-ssh-refresh uni-refresh" style="padding:1px 6px;font-size:10px" title="刷新">🔄</button>' +
        // v4.97.0 · 视图切换 (列表/图标/详情/相册)
        '<span class="uni-viewmodes" style="display:inline-flex;gap:2px;background:var(--bg3);border:1px solid var(--border);border-radius:6px;padding:1px;margin-left:2px">' +
          ['list:☰','icon:▦','detail:📋','gallery:🖼'].map(function(v){
            var pr = v.split(':');
            return '<button class="btn btn-sm uni-vm" data-vm="'+pr[0]+'" title="'+({list:'列表',icon:'图标',detail:'详情',gallery:'相册'})[pr[0]]+'视图" style="padding:1px 6px;font-size:11px;border:none;background:transparent;color:var(--text2);cursor:pointer">'+pr[1]+'</button>';
          }).join('') +
        '</span>' +
        // v5.17.0 · 目标区高频操作: 新建目录 / 新建文件 (源栏同样可用)
        '<button class="btn btn-sm uni-mkdir" style="padding:1px 6px;font-size:11px" title="在此目录新建文件夹">📁＋</button>' +
        '<button class="btn btn-sm uni-mkfile" style="padding:1px 6px;font-size:11px" title="在此目录新建文件">📄＋</button>';
      // v5.90.5 · 打开方式偏好 (仅源栏挂一个, 与全站共享同一 localStorage 键)
      try {
        if (sideKey === 'source' && window.RPOpenMode){
          var _oms = window.RPOpenMode.select('');
          _oms.style.cssText = 'padding:1px 4px;font-size:10px;background:var(--bg3);color:var(--text2);border:1px solid var(--border);border-radius:4px;max-width:132px';
          bar.appendChild(_oms);
        }
      } catch(e){}
      var list = document.createElement('div');
      list.className = 'dm-ssh-list uni-list';
      list.style.cssText = 'flex:1;min-height:0;overflow:auto;padding:2px 4px;font-family:monospace;font-size:12px';
      list.innerHTML = '<div style="padding:14px 8px;color:var(--text3);font-size:12px">💡 在上方选择来源（本机/服务器/df挂载点），点 [🔌 连接] 浏览</div>';

      // v4.97.0 · 视图按钮: 切换 + 记忆 + 重绘
      try {
        bar.querySelectorAll('.uni-vm').forEach(function(b){
          var v = b.getAttribute('data-vm');
          var on = v === ps.view;
          b.style.background = on ? 'var(--cyan)' : 'transparent';
          b.style.color = on ? '#000' : 'var(--text2)';
          b.onclick = function(ev){
            ev.stopPropagation();
            ps.view = v;
            try { localStorage.setItem('uni_view', v); } catch(e){}
            bar.querySelectorAll('.uni-vm').forEach(function(x){
              var o2 = x.getAttribute('data-vm') === v;
              x.style.background = o2 ? 'var(--cyan)' : 'transparent';
              x.style.color = o2 ? '#000' : 'var(--text2)';
            });
            _render('');
          };
        });
      } catch(e){}
      pane.appendChild(bar);
      pane.appendChild(list);
      bodyEl.appendChild(pane);

      function _parent(p){ return (p && p !== '/' ) ? (p.replace(/\/+$/,'').split('/').slice(0,-1).join('/') || '/') : '/'; }
      function _setStatus(msg){ var s = cell.querySelector('.tri-pane-status'); if (s) s.textContent = msg; }

      // ---- 来源 -> 凭据 (v5.5.0 · 与描述符 host 同源, 不再无条件套用主表单凭据) ----
      function _isLocalHost(h){
        h = String(h || '').trim().toLowerCase();
        return !h || h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '0.0.0.0';
      }
      function _descAuth(desc){
        if (!desc || desc.kind === 'local') return null;
        if (desc.kind === 'share') return null;        // 共享挂载点在本机 → 本机通路
        if (desc.kind === 'ssh' && desc.srvId != null && desc.srvId !== 0){
          var s = _resolveFromPool(desc.srvId);
          if (s && s.host) return { host:s.host, port:s.port||22, user:s.user||'root', auth_type:s.auth_type||'pass', password:s.password||'', key:s.key||'', passphrase:s.passphrase||'' };
          return null;
        }
        if (desc.kind === 'df'){
          // v5.5.0 · df 的权威主机是描述符上的 host (DM 扫描主机);
          //   旧实现直接用主表单凭据 → 主机与凭据不同源, 且缺凭据时会静默 SSH 到 127.0.0.1
          var dh = desc.host;
          if (_isLocalHost(dh)) return null;   // 本机挂载点 → 本机通路, 不发 SSH
          if (!dh) return null;                // 无主机 → 上层给明确提示
          var a = _dmSshConnAuth();
          if (!a || !a.host || _isLocalHost(a.host)) return { host: dh, port: desc.port||22,
                                                              user: 'root', auth_type:'pass', password:'', key:'', passphrase:'' };
          // 用描述符主机覆盖 (凭据仍取自 DM 表单)
          a.host = dh;
          return a;
        }
        if (desc.kind === 'cloud') return null;   // 云端走 cloudId (remote_*), 不发 SSH
        return null;
  }

      // ---- 渲染 ----
      function _render(msg){
        var pathEl = bar.querySelector('.uni-path');
        if (pathEl){ pathEl.textContent = ps.cwd; pathEl.title = ps.cwd; }
        if (msg){ _setStatus(msg); return; }
        _setStatus(ps.entries.length + ' 项 · ' + ps.cwd);
        if (!ps.entries.length){
          list.innerHTML = '<div style="padding:14px 8px;color:var(--text3);font-size:12px">（空目录）</div>';
          return;
        }
        // v4.97.0 · 图标 / 相册视图 (缩略图网格)
        if (ps.view === 'icon' || ps.view === 'gallery'){
          var _IMG = /\.(jpe?g|png|gif|webp|svg|bmp|avif)$/i;
          var _AV = /\.(mp4|mkv|webm|mov|mp3|flac|wav|m4a|ogg)$/i;
          var cards = [];
          ps.entries.forEach(function(e){
            var isDir = (e.type === 'dir');
            var isImg = !isDir && _IMG.test(e.name || '');
            var isAV = !isDir && _AV.test(e.name || '');
            if (ps.view === 'gallery' && !isDir && !isImg && !isAV) return;
            var full = e.path || ((ps.cwd.replace(/\/+$/,'') || '') + '/' + e.name);
            if (!e.path && ps.cwd === '/') full = '/' + e.name;
            var body = isDir ? '📁' : (isAV ? '🎬' : (isImg ? '🖼' : '📄'));
            var thumb = (isImg && ps.desc && (ps.desc.kind === 'local' || ps.desc.kind === 'share'))
              ? '<div data-uni-th="'+_esc(full)+'" style="width:100%;height:72px;border-radius:5px;background:var(--bg3);display:flex;align-items:center;justify-content:center;font-size:22px">⏳</div>'
              : '<div style="width:100%;height:72px;border-radius:5px;background:var(--bg3);display:flex;align-items:center;justify-content:center;font-size:24px">'+body+'</div>';
            cards.push('<div class="uni-card" data-path="'+_esc(full)+'" data-type="'+_esc(e.type||'file')+'" data-name="'+_esc(e.name)+'" style="width:'+(ps.view==='gallery'?'124':'104')+'px;padding:5px;border-radius:6px;cursor:pointer;display:flex;flex-direction:column;gap:3px;font-size:11px">'
              + thumb
              + '<span style="max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:'+(isDir?'var(--purple)':'var(--text)')+'">'+(isDir?'📁 ':'')+_esc(e.name)+'</span></div>');
          });
          list.innerHTML = '<div style="display:flex;flex-wrap:wrap;gap:8px;padding:8px">'
            + (cards.join('') || '<div style="color:var(--text3);font-size:12px;padding:8px">本目录没有图片/音视频</div>') + '</div>';
          // v5.14.1 · 本机/共享挂载图片缩略图: 目录级 token 一次签发 → 批量出图
          //   旧实现每张图单独 file_stream_token (187 张图 = 187 个 WS 往返) → WS 排队,
          //   点击预览的 token 请求排在队尾 → 用户感觉"点图片很慢"
          if (ps.desc && (ps.desc.kind === 'local' || ps.desc.kind === 'share')){
            var _thumbs = list.querySelectorAll('[data-uni-th]');
            if (_thumbs.length){
              // v5.17.0 · 三重加固 (修"仅预览模式下缩略图不显示"+"点击慢"):
              //   ① 共享 token 缓存 (同目录 10min 复用) — 旧实现每次 _render 都签发新 token,
              //      视图切换/预览联动会连续触发 → WS 请求排队 → 图不显示 + 后续点击变慢
              //   ② loadId 竞态保护 — 快速重绘时旧回调不再作用于已废弃的 DOM
              //   ③ 回调内重新查询 DOM — 旧实现闭包持有外层引用, DOM 被重绘后全部 isConnected=false
              var _myLoad = ps.loadId;   // _render 无 myLoadId (那是 load 的局部量)
              var _applyThumbs = function(tok){
                if (_myLoad !== ps.loadId) return;                 // 已被更新的加载取代, 丢弃
                var els2 = list.querySelectorAll('[data-uni-th], .uni-th-pending');
                if (!tok){
                  els2.forEach(function(el){ if (el.isConnected) el.innerHTML = '🖼'; });
                  return;
                }
                els2.forEach(function(el){
                  if (!el.isConnected) return;
                  var p2 = el.getAttribute('data-uni-th');
                  if (!p2) return;
                  el.outerHTML = '<img loading="lazy" src="/api/file/stream?path=' + encodeURIComponent(p2) +
                                 '&st=' + encodeURIComponent(tok) + '" style="width:100%;height:72px;object-fit:cover;border-radius:5px" onerror="this.style.display=\'none\'">';
                });
              };
              var _cache = window.__rpStreamTok && window.__rpStreamTok[String(ps.cwd || '/')];
              if (_cache && _cache.token && (Date.now() - _cache.ts) < 10 * 60 * 1000){
                _applyThumbs(_cache.token);
              } else {
                try {
                  send({ action: 'file_stream_token', path: ps.cwd || '/' }, function(tk){
                    if (tk && tk.status === 'ok' && tk.token){
                      window.__rpStreamTok = window.__rpStreamTok || {};
                      window.__rpStreamTok[String(ps.cwd || '/')] = { token: tk.token, ts: Date.now() };
                    }
                    _applyThumbs(tk && tk.status === 'ok' ? tk.token : '');
                  });
                } catch(e2){ _applyThumbs(''); }
              }
            }
          }
          list.querySelectorAll('.uni-card').forEach(function(el){
            el.onclick = function(){
              var p3 = el.getAttribute('data-path');
              // v5.90.5 · 双击模式: 卡片单击不进入/不加项 (".." 除外, 恒单击返回)
              var _dblCard = (!window.RPOpenMode || window.RPOpenMode.get() === 'double');
              if (_dblCard && (el.getAttribute('data-name') || '') !== '..') return;
              if (el.getAttribute('data-type') === 'dir'){
                // v5.0.0 · 预览 Tab 下点目录 → 中栏列目录; 否则进入该目录
                if (typeof _midTab !== 'undefined' && _midTab === 'preview'){
                  var _dmPO = false;
                  try { _dmPO = (window.RpUI && window.RpUI.modeOf('dm') === 'preview'); } catch(e8){}
                  _previewCtx = { sideKey: sideKey, path: p3, name: el.getAttribute('data-name') || '', isDir: true };
                  try { load(p3); } catch(e9){}     // v5.3.0 · 左栏同步进入
                  if (!_dmPO){ try { _dmRenderPreview(); } catch(e7){} }
                  return;
                }
                load(p3); return;
              }
              // v4.97.0 · 文件: 复用列表视图单击逻辑 (预览 Tab 激活则预览, 否则加入传输项)
              var fty2 = el.getAttribute('data-type') || 'file';
              if (typeof _midTab !== 'undefined' && _midTab === 'preview'){
                _previewCtx = { sideKey: sideKey, path: p3, name: el.getAttribute('data-name') || '' };
                try { _dmRenderPreview(); } catch(e3){}
                return;
              }
              var ff2 = (fty2 === 'dir') ? (p3.replace(/\/+$/, '') + '/') : p3;
              if (st.items.some(function(it){ return it.src === ff2; })){ onLog('⚠ 已在传输项中: ' + ff2, 'warn'); return; }
              // v5.14.1 · 与列表视图同一完整项结构 (旧实现 {src,dst:'',marks} 缺 status/dstSrv → 永远不被传输)
              var _dmm = _descMarks(sideKey);
              var _srcM2 = _descMarks('source');
              var _dstM2 = _descMarks('target');
              var _ocwd2 = (sideKey === 'source')
                ? ((st.targetPane && st.targetPane.getCwd) ? (st.targetPane.getCwd() || '/') : '/')
                : ((st.sourcePane && st.sourcePane.getCwd) ? (st.sourcePane.getCwd() || '/') : '/');
              if (_ocwd2.slice(-1) !== '/') _ocwd2 += '/';
              var _base2 = ff2.replace(/\/+$/,'').split('/').pop() || 'item';
              var _other2 = (fty2 === 'dir') ? (_ocwd2 + _base2 + '/') : (_ocwd2 + _base2);
              try {
                st.items.push({
                  id: 'ti_' + Date.now() + '_' + Math.random().toString(36).slice(2,6),
                  src: (sideKey === 'source') ? ff2 : _other2,
                  dst: (sideKey === 'source') ? _other2 : ff2,
                  type: (fty2 === 'dir') ? 'dir' : 'item',
                  status: 'pending', ts: Date.now(),
                  srcSrv: (sideKey === 'source') ? (_dmm.srcSrv || st.sourceSrvId || 0) : (_srcM2.srcSrv || 0),
                  dstSrv: (sideKey === 'target') ? (_dmm.dstSrv || st.targetSrvId || 0) : (_dstM2.dstSrv || 0),
                  srcHost: (sideKey === 'source') ? (_dmm.srcHost || '') : (_srcM2.srcHost || ''),
                  dstHost: (sideKey === 'target') ? (_dmm.dstHost || '') : (_dstM2.dstHost || ''),
                  srcCloud: (sideKey === 'source') ? (_dmm.srcCloud || '') : (_srcM2.srcCloud || ''),
                  dstCloud: (sideKey === 'target') ? (_dmm.dstCloud || '') : (_dstM2.dstCloud || ''),
                  fromSide: sideKey,
                });
                _saveItems(scope, st.items);
                onLog('➕ ' + ff2);
                try { _renderItems(); } catch(e4){}
                try { renderLists && renderLists(); } catch(e5){}
              } catch(e6){ onLog('✗ 加入失败: ' + e6, 'err'); }
            };
          });
          _updateSelbar();
          return;
        }
        var entries = ps.entries;
        entries.sort(function(a,b){
          var da = (a.type==='dir')?0:1, db = (b.type==='dir')?0:1;
          if (da !== db) return da-db;
          return String(a.name).localeCompare(String(b.name));
        });
        var html = '<table style="width:100%;border-collapse:collapse">'
                 + '<thead><tr style="color:var(--text3);border-bottom:1px solid var(--border);font-size:10px">'
                 + '<th style="width:22px;padding:2px 2px"></th>'
                 + '<th style="text-align:left;padding:2px 4px">名称</th>'
                 + '<th style="text-align:right;padding:2px 4px">大小</th>'
                 + '<th style="text-align:right;padding:2px 4px">修改时间</th>'
                 + (ps.selMode ? '' : '<th style="width:26px;padding:2px 2px"></th>')
                 + '</tr></thead><tbody>';
        for (var i=0;i<entries.length;i++){
          var e = entries[i];
          var isDir = (e.type === 'dir');
          var icon = isDir ? '📁' : '📄';
          var full = e.path || ((ps.cwd.replace(/\/+$/,'') || '') + '/' + e.name);
          if (!e.path && ps.cwd === '/') full = '/' + e.name;
          var nameCell = isDir
            ? '<span class="dm-ssh-dir uni-dir" data-name="'+_esc(e.name)+'" data-path="'+_esc(full)+'" style="color:var(--purple);cursor:pointer">'+icon+' '+_esc(e.name)+'</span>'
            : '<span class="dm-ssh-file uni-file" data-path="'+_esc(full)+'" data-type="'+_esc(e.type||'file')+'" style="color:var(--text);cursor:pointer" title="单击加入传输项">'+icon+' '+_esc(e.name)+'</span>';
          var addBtn = ps.selMode ? '' : '<button class="btn btn-sm dm-ssh-add uni-add" data-path="'+_esc(full)+'" data-type="'+_esc(e.type||'file')+'" style="padding:0 4px;font-size:10px;color:var(--green)" title="加入传输项">➕</button>';
          html += '<tr style="border-bottom:1px dashed var(--border)">'
                + '<td style="padding:1px 2px;text-align:center"><input type="checkbox" class="dm-ssh-chk uni-chk" data-name="'+_esc(e.name)+'" data-path="'+_esc(full)+'" data-type="'+_esc(e.type||'file')+'" data-size="'+(e.size||0)+'"></td>'
                + '<td style="padding:1px 4px">'+nameCell+'</td>'
                + '<td style="padding:1px 4px;text-align:right;color:var(--text3);font-size:11px">'+(isDir ? '-' : _fmtBytes(e.size))+'</td>'
                + '<td style="padding:1px 4px;text-align:right;color:var(--text3);font-size:11px">'+_esc(e.mtime||'')+'</td>'
                + (ps.selMode ? '' : '<td style="padding:1px 2px;text-align:center">'+addBtn+'</td>')
                + '</tr>';
        }
        list.innerHTML = html + '</tbody></table>';
        _updateSelbar();
        return;
      }

      // ---- 数据加载: local -> list_dir | ssh/df/cloud -> disk_list_dir ----
      function load(p){
        p = p || '/';
        ps.loadId++;
        var myLoadId = ps.loadId;
        ps.cwd = p;
        ps.entries = [];
        list.innerHTML = '<div style="padding:14px 8px;color:var(--text3);font-size:12px">⏳ 加载 '+_esc(p)+' ...</div>';
        _render('加载 '+p+' ...');
        var desc = ps.desc;
        if (desc.kind === 'cloud'){
          // v4.40.0 P1 · 远端存储浏览: remote_ls (openWs 直挂 handler · send() 不路由 remote_ls_result)
          var cRow = _getCloudById(desc.cloudId);
          var rid = (cRow && (cRow.id || cRow.remote_id)) || 0;
          if (!rid){
            list.innerHTML = '<div style="padding:14px 8px;color:var(--red);font-size:12px">✗ 无效的远端存储配置 (无法解析 remote_id)</div>';
            _render('✖ 无效配置');
            return;
          }
          var reqId = 'cloud_' + Date.now() + '_' + Math.random().toString(36).slice(2,6);
          openWs(function(wsC){
            var hC = function(e){
              var dC;
              try { dC = JSON.parse(e.data); } catch(_){ return; }
              if (dC.type !== 'remote_ls_result' || dC.req_id !== reqId) return;
              try { wsC.removeEventListener('message', hC); } catch(_){}
              if (myLoadId !== ps.loadId) return;
              if (dC.status === 'ok'){
                ps.entries = (dC.entries || []).map(function(en){
                  return { name: en.name, path: (p === '/' ? '' : p.replace(/\/+$/,'')) + '/' + en.name,
                           type: en.is_dir ? 'dir' : 'file', size: en.size||0,
                           mtime: _fmtTime(en.mtime) };
                });
                ps.cwd = p;
                _render();
                onLog('✓ ☁ ' + (dC.remote_name||'') + ' ' + p + ' · ' + ps.entries.length + ' 项', 'ok');
              } else {
                list.innerHTML = '<div style="padding:14px 8px;color:var(--red);font-size:12px">✗ '+_esc(dC.msg||'加载失败')+'</div>';
                _render('✖ ' + (dC.msg||'加载失败'));
                onLog('✗ ☁ 远端存储浏览失败: '+(dC.msg||''), 'err');
              }
            };
            wsC.addEventListener('message', hC);
            wsC.send(JSON.stringify({ action:'remote_ls', remote_id: rid, path:(p==='/'?'':p), req_id:reqId }));
          });
          return;
        }
        // v4.40.0 · 网络共享: 挂载点在本机 -> 未挂载先自动挂载 -> 本机 list_dir 浏览
        if (desc.kind === 'share'){
          var shUuid = desc.uuid || '';
          var shMnt = _shareMnt(_getShareByUuid(shUuid)) || (desc.mounted ? (_SHARE_ROOT + shUuid) : '');
          var _loadShareLocal = function(mntPath){
            var reqId2 = 'unish_' + Date.now() + '_' + Math.random().toString(36).slice(2,6);
            openWs(function(ws2){
              var h2 = function(e){
                var d2;
                try { d2 = JSON.parse(e.data); } catch(_){ return; }
                if (d2.type !== 'dir_result' || d2.req_id !== reqId2) return;
                try { ws2.removeEventListener('message', h2); } catch(_){}
                if (myLoadId !== ps.loadId) return;
                if (d2.status === 'ok' || d2.status === 'success'){
                  ps.entries = (d2.entries || []).map(function(en){
                    return { name: en.name, path: en.path, type: en.type, size: en.size||0, mtime: en.mtime||'' };
                  });
                  ps.cwd = d2.path || p;
                  _render();
                  onLog('✓ 共享浏览 '+ps.cwd+' · '+ps.entries.length+' 项', 'ok');
                } else {
                  list.innerHTML = '<div style="padding:14px 8px;color:var(--red);font-size:12px">✗ '+_esc(d2.msg||'加载失败')+'</div>';
                  _render('✖ ' + (d2.msg||'加载失败'));
                }
              };
              ws2.addEventListener('message', h2);
              ws2.send(JSON.stringify({ action:'list_dir', path:(p && p !== '/' ? p : mntPath), req_id:reqId2 }));
            });
          };
          if (shMnt){
            // 已挂载: path 为挂载点子路径时直接用, 否则从挂载点根开始
            var effP = (p && p.indexOf(_SHARE_ROOT) === 0) ? p : shMnt;
            _loadShareLocal(effP);
          } else {
            // 未挂载 -> 自动挂载 -> 浏览
            list.innerHTML = '<div style="padding:14px 8px;color:var(--yellow);font-size:12px">🔌 正在挂载网络共享 ...</div>';
            _setStatus('🔌 挂载中 ...');
            window.send({ action:'share_mount', uuid: shUuid }, function(m2){
              if (m2 && m2.status === 'ok'){
                onLog('✓ 共享已挂载: ' + (m2.msg||''), 'ok');
                // v4.40.0 · 只读/读写检测提示
                if (m2.rw === 'ro'){
                  onLog('🔒 实际只读 (' + (m2.rw_reason || '服务器限制') + ') · 仅可下载/读取, 上传会被拒绝', 'warn');
                } else if (m2.rw === 'rw'){
                  onLog('✏️ 读写检测通过 · 可正常上传/写入', 'ok');
                } else if (m2.rw_label){
                  onLog('⚠ 读写状态未知: ' + (m2.rw_reason || ''), 'warn');
                }
                try {
                  if (typeof window.__syncSharesCache === 'function') window.__syncSharesCache(m2);
                  else if (m2.df_mounts && window._syncDfMountsGlobal) window._syncDfMountsGlobal(m2);
                } catch(_){}
                _loadShareLocal(m2.mnt || (_SHARE_ROOT + shUuid));
              } else {
                var msg2 = (m2 && m2.msg) || '挂载失败';
                list.innerHTML = '<div style="padding:14px 8px;color:var(--red);font-size:12px">✗ '+_esc(msg2)+'</div>';
                _render('✖ ' + msg2);
                onLog('✗ 共享挂载失败: '+msg2, 'err');
              }
            });
          }
          return;
        }
        // v4.39.2 · df 挂载点且扫描主机是本机 -> 走本机 list_dir
        //   (共享挂载点 /var/lib/fonriv_mounts/shares/<uuid> 在本机 · 无需 SSH · 避免 ssh_askpass)
        if (desc.kind === 'df'){
          try {
            // v5.6.0 · 修复"磁盘已挂载但源/目标打不开":
            //   旧逻辑要求 _descAuth(desc) 非空且 host 为本机才降级本机 → host 为空(本机扫描未记 host)
            //   时既不降级、又拿不到凭据 → 直接提示"请先填写主机连接并扫描"(用户已扫描成功, 提示误导)
            //   新逻辑: 挂载点路径形如绝对路径 → 一律先按本机浏览; 只有明确是远端主机时才走 SSH。
            var isLocalMount = (String(p || '').indexOf('/var/lib/fonriv_mounts/shares/') === 0);
            var _dh = desc.host;
            var _remoteHost = (_dh && !_isLocalHost(_dh) && String(_dh) !== String(location.hostname || '')) ? _dh : '';
            // 无远端主机 / 本机主机 → 本机通路 (list_dir 会真实校验路径, 不存在会明确报错)
            if (!_remoteHost || isLocalMount){
              desc = { kind:'local', _remoteHost: _remoteHost };
            }
          } catch(_){}
        }
        if (desc.kind === 'local'){
          // 本机: openWs + list_dir + 直接挂 ws handler (send() 不路由 dir_result)
          if (typeof openWs !== 'function'){ _setStatus('✖ WebSocket 未就绪'); return; }
          var reqId = 'uni_' + Date.now() + '_' + Math.random().toString(36).slice(2,6);
          openWs(function(ws){
            var handler = function(e){
              var d;
              try { d = JSON.parse(e.data); } catch(_){ return; }
              if (d.type !== 'dir_result' || d.req_id !== reqId) return;
              try { ws.removeEventListener('message', handler); } catch(_){}
              if (myLoadId !== ps.loadId) return;
              if (d.status === 'ok' || d.status === 'success'){
                ps.entries = (d.entries || []).map(function(en){
                  return { name: en.name, path: en.path, type: en.type, size: en.size||0, mtime: en.mtime||'' };
                });
                ps.cwd = d.path || p;
                _render();
                onLog('✓ 本机浏览 '+ps.cwd+' · '+ps.entries.length+' 项', 'ok');
              } else {
                // v5.6.0 · 本机列目录失败且该来源是 df/ssh(有远端主机) → 自动改用 SSH 重试一次
                var _rh = (desc && desc._remoteHost) || '';
                if (_rh && window.send){
                  onLog('本机路径不可用, 改用远端主机 ' + _rh + ' 重试: ' + p, 'warn');
                  window.send({
                    action: 'disk_list_dir', path: p, host: _rh,
                    port: desc.port || 22, user: (desc.user || 'root'),
                    auth_type: (desc.auth_type || 'pass'), password: (desc.password || ''),
                    key: (desc.key || ''), passphrase: (desc.passphrase || ''),
                    /* v6.3.33 · FIX(全面审计): 纯时间戳 req_id 在同一毫秒并发时会**撞号**
                       (同 rpcDirAction v6.3.31 那类问题) → 响应互相认领。补随机后缀。 */
                    req_id: 'dfssh_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
                  }, function(m3){
                    if (myLoadId !== ps.loadId) return;
                    if (m3 && (m3.status === 'ok' || m3.status === 'success')){
                      ps.entries = (m3.entries || []).map(function(en){
                        return { name: en.name, path: en.path, type: en.type, size: en.size||0, mtime: en.mtime||'' };
                      });
                      ps.cwd = m3.path || p;
                      _render();
                    } else {
                      list.innerHTML = '<div style="padding:14px 8px;color:var(--red);font-size:12px">✗ '+_esc((m3&&m3.msg)||d.msg||'加载失败')+'</div>';
                      _render('✖ ' + ((m3&&m3.msg)||d.msg||'加载失败'));
                    }
                  });
                  return;
                }
                list.innerHTML = '<div style="padding:14px 8px;color:var(--red);font-size:12px">✗ '+_esc(d.msg||'加载失败')+'</div>';
                _render('✖ ' + (d.msg||'加载失败'));
              }
            };
            ws.addEventListener('message', handler);
            _rpSendWhenReady(ws, { action:'list_dir', path:p, req_id:reqId }, undefined, function(){ try { console.warn('[ws] 发送失败'); } catch(_){} })
          });
          return;
        }
        // ssh / df / cloud(暂挂 df 凭据) -> disk_list_dir
        var conn = _descAuth(desc);
        if (!conn || !conn.host){
          list.innerHTML = '<div style="padding:14px 8px;color:var(--yellow);font-size:12px">⚠ '+(desc.kind==='df' ? '请先在上方「远端磁盘管理」填写主机连接并扫描' : '无法解析服务器凭据')+'</div>';
          _setStatus('✖ 未配置主机');
          return;
        }
        if (typeof window.send !== 'function'){ _setStatus('✖ WebSocket 未就绪'); return; }
        var _goSsh = function(){
          window.send({
            action: 'disk_list_dir',
            host: conn.host, port: conn.port, user: conn.user,
            auth_type: conn.auth_type,
            password: conn.password, key: conn.key, passphrase: conn.passphrase,
            path: p,
          }, function(m){
            if (myLoadId !== ps.loadId) return;
            if (!m){ _render('✖ 无响应'); return; }
            if (m.type === 'disk_list_dir_result' && m.status === 'ok'){
              ps.entries = m.entries || [];
              ps.cwd = m.path || p;
              _render();
              onLog('✓ SSH 浏览 '+ps.cwd+' · '+ps.entries.length+' 项 ('+conn.host+')', 'ok');
            } else {
              var msg = (m && (m.msg||m.message)) || '加载失败';
              list.innerHTML = '<div style="padding:14px 8px;color:var(--red);font-size:12px">✗ '+_esc(msg)+'</div>';
              _render('✖ ' + msg);
              onLog('✗ SSH 浏览失败: '+msg, 'err');
            }
          });
        };
        // v5.52.0 · 连接前按需解析凭据: 统一数据源(server_profiles)出于安全**不下发密码**,
        //   而 SrvPool 里的条目 auth_value 为空 → 旧实现直接空密码 SSH(必然失败)。
        //   这里走 SP.resolve (sp_resolve, 密码仅在后端使用) 补齐凭据后再列目录。
        if (desc.kind === 'ssh' && !conn.password && !conn.key && window.SP && SP.resolve){
          try {
            SP.resolve(conn.host, conn.port, ['ssh']).then(function(rr){
              if (rr && rr.creds){
                conn.auth_type = rr.creds.auth_type || conn.auth_type;
                conn.password = rr.creds.password || '';
                conn.key = rr.creds.key || '';
                conn.passphrase = rr.creds.passphrase || '';
              }
            }).catch(function(){}).then(_goSsh, _goSsh);
            return;
          } catch(e){ /* 回落直接连接 */ }
        }
        _goSsh();
      }

      // ---- 交互绑定 ----
      bar.querySelector('.uni-up').onclick = function(){ load(_parent(ps.cwd)); };
      bar.querySelector('.uni-refresh').onclick = function(){ load(ps.cwd); };

      // ═══ v5.17.0 · 新建目录 / 新建文件 (目标区高频操作) ═══
      function _uniTargetPath(){ return (ps.cwd || '/').replace(/\/+$/, '') || '/'; }
      function _uniSend(action, payload){
        return new Promise(function(resolve){
          try {
            send(Object.assign({ action: action }, _uniConn(), payload), function(r){ resolve(r || {}); });
          } catch(e){ resolve({ status: 'error', msg: String(e) }); }
        });
      }
      function _uniConn(){
        // 按当前描述符取连接 (远端 → SSH 凭据; 本机/共享 → 空)
        try {
          var a = _descAuth(ps.desc);
          if (!a) return {};
          return { host: a.host, port: a.port, user: a.user, auth_type: a.auth_type,
                   password: a.password, key: a.key, passphrase: a.passphrase };
        } catch(e){ return {}; }
      }
      function _uniMkdir(){
        var cur = _uniTargetPath();
        var nm = window.prompt('新建文件夹名称 (在 ' + cur + ' 下):');
        if (!nm) return;
        nm = String(nm).trim().replace(/^\/+/, '');
        if (!nm || nm.indexOf('..') >= 0) return;
        _uniSend('file_mkdir', { path: cur + '/' + nm }).then(function(r){
          if (r.status === 'ok'){ _setStatus('✓ 已创建目录 ' + nm); load(cur); }
          else { _setStatus('✗ ' + (r.msg || '创建失败')); _dmToast('✗ ' + (r.msg || '创建失败'), 'err'); }
        });
      }
      function _uniMkfile(){
        var cur = _uniTargetPath();
        var nm = window.prompt('新建文件名 (在 ' + cur + ' 下, 可含子路径):');
        if (!nm) return;
        nm = String(nm).trim().replace(/^\/+/, '');
        if (!nm || nm.indexOf('..') >= 0) return;
        _uniSend('file_mkfile', { path: cur + '/' + nm, content: '' }).then(function(r){
          if (r.status === 'ok'){ _setStatus('✓ 已创建文件 ' + nm); load(cur); }
          else { _setStatus('✗ ' + (r.msg || '创建失败')); _dmToast('✗ ' + (r.msg || '创建失败'), 'err'); }
        });
      }
      var _mkdBtn = bar.querySelector('.uni-mkdir'); if (_mkdBtn) _mkdBtn.onclick = function(ev){ ev.stopPropagation(); _uniMkdir(); };
      var _mkfBtn = bar.querySelector('.uni-mkfile'); if (_mkfBtn) _mkfBtn.onclick = function(ev){ ev.stopPropagation(); _uniMkfile(); };

      // ═══ v5.17.0 · 栏内右键菜单 (新建/刷新/返回上级/加入传输/复制路径/收藏) ═══
      function _uniCtxMenu(ev, itemPath, itemName, isDir){
        ev.preventDefault(); ev.stopPropagation();
        var old = document.getElementById('uniCtxMenu'); if (old) old.remove();
        var cur = _uniTargetPath();
        var menu = document.createElement('div');
        menu.id = 'uniCtxMenu';
        menu.style.cssText = 'position:fixed;z-index:99999;background:var(--bg2);border:1px solid var(--border);' +
          'border-radius:8px;box-shadow:0 10px 32px rgba(0,0,0,.45);padding:4px;min-width:190px;font-size:12px';
        var rows = [];
        rows.push({ t: '📁＋ 新建文件夹', fn: _uniMkdir });
        rows.push({ t: '📄＋ 新建文件', fn: _uniMkfile });
        rows.push({ sep: 1 });
        if (itemPath && isDir) rows.push({ t: '📂 进入目录', fn: function(){ load(itemPath); } });
        if (itemPath && !isDir) rows.push({ t: '➕ 加入传输项', fn: function(){
          st.items.push({ id: 'ti_' + Date.now() + '_' + Math.random().toString(36).slice(2,6),
                          src: (sideKey === 'source') ? itemPath : itemPath,
                          dst: '', type: 'item', status: 'pending', ts: Date.now(),
                          fromSide: sideKey });
          try { _saveItems(scope, st.items); } catch(e){}
          try { _renderItems(); } catch(e){}
          onLog('➕ 已加入传输项: ' + itemPath);
        }});
        rows.push({ t: '🔄 刷新', fn: function(){ load(cur); } });
        rows.push({ t: '⬆ 上级目录', fn: function(){ load(_parent(cur)); } });
        rows.push({ sep: 1 });
        rows.push({ t: '⭐ 收藏当前路径', fn: function(){
          if (window.FileOps && window.FileOps.favToggle){ window.FileOps.favToggle(sideKey === 'target' ? 'remote' : 'local', cur); }
        }});
        rows.push({ t: '📁 收藏夹', fn: function(){
          if (window.FileOps && window.FileOps.favPopup){ window.FileOps.favPopup(ev, sideKey === 'target' ? 'remote' : 'local', { load: load, getCwd: function(){ return ps.cwd; } }); }
        }});
        rows.push({ t: '📋 复制路径', fn: function(){
          var p2 = itemPath || cur;
          if (navigator.clipboard) navigator.clipboard.writeText(p2).then(function(){ _setStatus('✓ 已复制'); });
        }});
        if (itemPath && window.FileOps && window.FileOps.chmodModal){
          rows.push({ t: '🔐 修改权限…', fn: function(){                       // v5.90.5
            window.FileOps.chmodModal(sideKey === 'target' ? 'remote' : 'local', itemPath,
                                      { load: load, getCwd: function(){ return ps.cwd; } });
          }});
        }
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
        var w = menu.offsetWidth, h = menu.offsetHeight;
        menu.style.left = Math.min(ev.clientX, window.innerWidth - w - 8) + 'px';
        menu.style.top = Math.min(ev.clientY, window.innerHeight - h - 8) + 'px';
        setTimeout(function(){
          var close = function(e2){ if (!menu.contains(e2.target)) { menu.remove(); document.removeEventListener('mousedown', close); } };
          document.addEventListener('mousedown', close);
        }, 10);
      }
      pane.addEventListener('contextmenu', function(ev){
        var t = ev.target;
        var card = t.closest ? t.closest('.uni-card') : null;
        if (card){
          _uniCtxMenu(ev, card.getAttribute('data-path'), card.getAttribute('data-name'),
                      card.getAttribute('data-type') === 'dir');
          return;
        }
        var f = t.closest ? t.closest('.uni-file, .uni-dir') : null;
        if (f){
          _uniCtxMenu(ev, f.getAttribute('data-path'), f.getAttribute('data-name'),
                      f.classList.contains('uni-dir'));
          return;
        }
        // 空白区右键 → 仅目录级操作
        _uniCtxMenu(ev, '', '', false);
      });
      bar.querySelector('.uni-path').onclick = function(){ load(_parent(ps.cwd)); };
      var selModeBtn = bar.querySelector('.uni-selmode');
      function _toggleSelMode(){
        ps.selMode = !ps.selMode;
        if (selModeBtn){
          if (ps.selMode){ selModeBtn.textContent = '✓ 选择中'; selModeBtn.style.background='var(--green)'; selModeBtn.style.color='#fff'; selModeBtn.style.borderColor='var(--green)'; }
          else { selModeBtn.textContent = '☐ 选择'; selModeBtn.style.background='var(--bg3)'; selModeBtn.style.color='var(--cyan)'; selModeBtn.style.borderColor='var(--cyan)'; }
        }
        _render();
      }
      selModeBtn.onclick = _toggleSelMode;
      // 底部 selbar: 已选 N · ➕全部加入 · ✕清空
      var footSelbar = document.createElement('span');
      footSelbar.className = 'dm-ssh-selbar';
      footSelbar.style.cssText = 'display:none;align-items:center;gap:4px';
      footSelbar.innerHTML =
        '<span class="dm-ssh-selcount" style="color:var(--green);font-weight:600;font-size:11px">已选 0 项</span>' +
        '<button class="btn btn-sm dm-ssh-seladd" style="padding:1px 6px;font-size:10px;background:var(--green);color:#fff" title="把勾选项全部加入传输项">➕ 全部加入</button>' +
        '<button class="btn btn-sm dm-ssh-selclr" style="padding:1px 6px;font-size:10px" title="清空勾选">✕ 清空</button>';
      // v4.41.4 · selbar 上移: 从底部 foot 移到栏头 (选择按钮旁), 多选后「全部加入」就在眼前
      var headBar = cell.querySelector('.tri-pane-head');
      if (headBar) headBar.appendChild(footSelbar);
      else {
        var foot = cell.querySelector('.tri-pane-foot');
        var statusEl = cell.querySelector('.tri-pane-status');
        if (foot && statusEl) foot.insertBefore(footSelbar, statusEl);
      }
      function _updateSelbar(){
        var boxes = list.querySelectorAll('.uni-chk:checked');
        footSelbar.style.display = (boxes.length > 0 || ps.selMode) ? 'inline-flex' : 'none';
        footSelbar.querySelector('.dm-ssh-selcount').textContent = '✓ 已选 ' + boxes.length + ' 项';
      }
      footSelbar.querySelector('.dm-ssh-seladd').onclick = function(){
        var checked = list.querySelectorAll('.uni-chk:checked');
        if (!checked.length){ _setStatus('⚠ 请先勾选文件/目录'); return; }
        // v4.38.35 · 描述符标记 (df->srcHost/dstHost, ssh->srcSrv/dstSrv) · 供 _dirArrow/_runOne 推导
        var dmarks = _descMarks(sideKey);
        var srcM = _descMarks('source');
        var dstM = _descMarks('target');
        // v4.38.36 · bug C 修复: 对侧路径 = 对侧栏 cwd + 文件名 (dst 不再等于 src)
        var otherCwd = (sideKey === 'source')
          ? ((st.targetPane && st.targetPane.getCwd) ? (st.targetPane.getCwd() || '/') : '/')
          : ((st.sourcePane && st.sourcePane.getCwd) ? (st.sourcePane.getCwd() || '/') : '/');
        if (otherCwd.slice(-1) !== '/') otherCwd += '/';
        var added = 0;
        checked.forEach(function(c){
          var p = c.getAttribute('data-path');
          var t = c.getAttribute('data-type');
          if (!p) return;
          var finalP = (t === 'dir') ? (p.replace(/\/+$/,'') + '/') : p;
          var baseName = finalP.replace(/\/+$/,'').split('/').pop() || 'item';
          var otherP = (t === 'dir') ? (otherCwd + baseName + '/') : (otherCwd + baseName);
          var _src = (sideKey === 'source') ? finalP : otherP;
          var _dst = (sideKey === 'source') ? otherP : finalP;
          if (!st.items.some(function(it){ return it.src === _src; })){
            st.items.push({
              id: 'ti_' + Date.now() + '_' + Math.random().toString(36).slice(2,6),
              src: _src, dst: _dst,
              type: (t === 'dir') ? 'dir' : 'item',
              status: 'pending', ts: Date.now(),
              // v4.38.35 · 侧描述符标记: ssh 源/目标 -> srcSrv/dstSrv; df 源/目标 -> srcHost/dstHost
              srcSrv: (sideKey === 'source') ? (dmarks.srcSrv || st.sourceSrvId || 0) : (srcM.srcSrv || 0),
              dstSrv: (sideKey === 'target') ? (dmarks.dstSrv || st.targetSrvId || 0) : (dstM.dstSrv || 0),
              srcHost: (sideKey === 'source') ? (dmarks.srcHost || '') : (srcM.srcHost || ''),
              dstHost: (sideKey === 'target') ? (dmarks.dstHost || '') : (dstM.dstHost || ''),
              // v4.40.1 bugfix · 补 ☁ 远端存储标记 (勾选批量加入此前漏掉 -> 云上传误走 local 复制)
              srcCloud: (sideKey === 'source') ? (dmarks.srcCloud || '') : (srcM.srcCloud || ''),
              dstCloud: (sideKey === 'target') ? (dmarks.dstCloud || '') : (dstM.dstCloud || ''),
              fromSide: sideKey,
            });
            added++;
          }
        });
        if (added){
          _saveItems(scope, st.items);
          _renderItems();
          onLog('+ 已加入 ' + added + ' 个勾选项 (共 ' + st.items.length + ' 项)', 'ok');
        } else {
          onLog('⚠ 勾选项均已存在', 'warn');
        }
        checked.forEach(function(c){ c.checked = false; });
        _updateSelbar();
        _setStatus(ps.entries.length + ' 项 · ' + ps.cwd);
      };
      footSelbar.querySelector('.dm-ssh-selclr').onclick = function(){
        list.querySelectorAll('.uni-chk').forEach(function(c){ c.checked = false; });
        _updateSelbar();
        _setStatus(ps.entries.length + ' 项 · ' + ps.cwd);
      };
      list.addEventListener('click', function(ev){
        var t = ev.target;
        // v5.90.5 · 打开方式偏好: double=双击进入, 单击=勾选(可多选); ".." 恒为单击返回上级
        var _dblOpen = (!window.RPOpenMode || window.RPOpenMode.get() === 'double');
        // v5.0.0 · 单击目录名: 进入目录 + 中栏列出该目录内容 (与文件传输页一致)
        if (t && t.classList && t.classList.contains('uni-dir')){
          var _nm1 = t.getAttribute('data-name') || '';
          if (_dblOpen && _nm1 !== '..'){
            var rowEl1 = t.closest ? t.closest('tr') : null;
            var chk1 = rowEl1 ? rowEl1.querySelector('.uni-chk') : null;
            if (chk1){ chk1.checked = !chk1.checked; chk1.dispatchEvent(new Event('change', {bubbles:true})); }
            return;
          }
          // v5.1.0 · 「仅预览」模式下目录不进中栏
          var _dmPrevOnly = false;
          try { _dmPrevOnly = (window.RpUI && window.RpUI.modeOf('dm') === 'preview'); } catch(e){}
          if (typeof _midTab !== 'undefined' && _midTab === 'preview' && !_dmPrevOnly){
            ev.stopPropagation();
            var dp = t.getAttribute('data-name') || '';
            // v5.5.0 · 优先用条目自带 path (旧实现只用 cwd+name 重拼 → 与后端规范化路径分叉 → /etc/... 错乱)
            var dpFull = t.getAttribute('data-path') || ((ps.cwd.replace(/\/+$/, '') || '') + '/' + dp);
            _previewCtx = { sideKey: sideKey, path: dpFull, name: dp, isDir: true };
            // v5.3.0 · 左栏必须同步进入该目录 (旧实现只更新中栏 → 用户感觉"左栏点不动目录")
            try { load(dpFull); } catch(e){}
            _dmRenderPreview();
            return;
          }
        }
        if (t && t.classList && t.classList.contains('uni-file')){
          // v5.90.5 · 双击模式: 单击文件 = 勾选 (可多选)
          if (_dblOpen){
            var rowEl2 = t.closest ? t.closest('tr') : null;
            var chk2 = rowEl2 ? rowEl2.querySelector('.uni-chk') : null;
            if (chk2){ chk2.checked = !chk2.checked; chk2.dispatchEvent(new Event('change', {bubbles:true})); }
            return;
          }
          // v4.66.0 · 预览 Tab 激活时: 单击文件 → DM 中栏预览 (而非加入传输项)
          if (typeof _midTab !== 'undefined' && _midTab === 'preview'){
            ev.stopPropagation();
            var pv = t.getAttribute('data-path');
            _previewCtx = { sideKey: sideKey, path: pv, name: String(pv).split('/').pop() };
            _dmRenderPreview();
            return;
          }
          // v4.41.4 · 单击文件名 = 加入传输项 (与行内 ➕ 同逻辑, 免去找小按钮)
          ev.stopPropagation();
          var fp = t.getAttribute('data-path');
          var fty = t.getAttribute('data-type') || 'file';
          var ffinal = (fty === 'dir') ? (fp.replace(/\/+$/,'') + '/') : fp;
          if (st.items.some(function(it){ return it.src === ffinal; })){ onLog('⚠ 已在传输项中: ' + ffinal, 'warn'); return; }
          var fdm = _descMarks(sideKey);
          var fsm = _descMarks('source');
          var fdmM = _descMarks('target');
          var focwd = (sideKey === 'source')
            ? ((st.targetPane && st.targetPane.getCwd) ? (st.targetPane.getCwd() || '/') : '/')
            : ((st.sourcePane && st.sourcePane.getCwd) ? (st.sourcePane.getCwd() || '/') : '/');
          if (focwd.slice(-1) !== '/') focwd += '/';
          var fbase = ffinal.replace(/\/+$/,'').split('/').pop() || 'item';
          var fother = (fty === 'dir') ? (focwd + fbase + '/') : (focwd + fbase);
          var fsrc = (sideKey === 'source') ? ffinal : fother;
          var fdst = (sideKey === 'source') ? fother : ffinal;
          st.items.push({
            id: 'ti_' + Date.now() + '_' + Math.random().toString(36).slice(2,6),
            src: fsrc, dst: fdst,
            type: (fty === 'dir') ? 'dir' : 'item',
            status: 'pending', ts: Date.now(),
            srcSrv: (sideKey === 'source') ? (fdm.srcSrv || st.sourceSrvId || 0) : (fsm.srcSrv || 0),
            dstSrv: (sideKey === 'target') ? (fdm.dstSrv || st.targetSrvId || 0) : (fdmM.dstSrv || 0),
            srcHost: (sideKey === 'source') ? (fdm.srcHost || '') : (fsm.srcHost || ''),
            dstHost: (sideKey === 'target') ? (fdm.dstHost || '') : (fdmM.dstHost || ''),
            srcCloud: (sideKey === 'source') ? (fdm.srcCloud || '') : (fsm.srcCloud || ''),
            dstCloud: (sideKey === 'target') ? (fdm.dstCloud || '') : (fdmM.dstCloud || ''),
            fromSide: sideKey,
          });
          _saveItems(scope, st.items);
          _renderItems();
          _setStatus('✓ 已加入: ' + ffinal);
          onLog('+ 已加入传输项 (点击文件): ' + ffinal + ' -> ' + fother + ' (共 ' + st.items.length + ' 项)', 'ok');
          return;
        }
        if (t && t.classList && t.classList.contains('uni-add')){
          ev.stopPropagation();
          var p = t.getAttribute('data-path');
          var ty = t.getAttribute('data-type');
          var finalP = (ty === 'dir') ? (p.replace(/\/+$/,'') + '/') : p;
          if (st.items.some(function(it){ return it.src === finalP; })){ onLog('⚠ 已在传输项中: ' + finalP, 'warn'); return; }
          // v4.38.35 · 行内 ➕: 描述符标记 (df->srcHost/dstHost, ssh->srcSrv/dstSrv)
          var dm2 = _descMarks(sideKey);
          var srcM2 = _descMarks('source');
          var dstM2 = _descMarks('target');
          // v4.38.36 · bug C 修复: 对侧路径 = 对侧栏 cwd + 文件名
          var otherCwd2 = (sideKey === 'source')
            ? ((st.targetPane && st.targetPane.getCwd) ? (st.targetPane.getCwd() || '/') : '/')
            : ((st.sourcePane && st.sourcePane.getCwd) ? (st.sourcePane.getCwd() || '/') : '/');
          if (otherCwd2.slice(-1) !== '/') otherCwd2 += '/';
          var baseName2 = finalP.replace(/\/+$/,'').split('/').pop() || 'item';
          var otherP2 = (ty === 'dir') ? (otherCwd2 + baseName2 + '/') : (otherCwd2 + baseName2);
          var _src2 = (sideKey === 'source') ? finalP : otherP2;
          var _dst2 = (sideKey === 'source') ? otherP2 : finalP;
          st.items.push({
            id: 'ti_' + Date.now() + '_' + Math.random().toString(36).slice(2,6),
            src: _src2, dst: _dst2,
            type: (ty === 'dir') ? 'dir' : 'item',
            status: 'pending', ts: Date.now(),
            srcSrv: (sideKey === 'source') ? (dm2.srcSrv || st.sourceSrvId || 0) : (srcM2.srcSrv || 0),
            dstSrv: (sideKey === 'target') ? (dm2.dstSrv || st.targetSrvId || 0) : (dstM2.dstSrv || 0),
            srcHost: (sideKey === 'source') ? (dm2.srcHost || '') : (srcM2.srcHost || ''),
            dstHost: (sideKey === 'target') ? (dm2.dstHost || '') : (dstM2.dstHost || ''),
            // v4.40.0 P1 · 远端存储标记 (cloudId) · 传输时 remote_download/upload
            srcCloud: (sideKey === 'source') ? (dm2.srcCloud || '') : (srcM2.srcCloud || ''),
            dstCloud: (sideKey === 'target') ? (dm2.dstCloud || '') : (dstM2.dstCloud || ''),
            fromSide: sideKey,
          });
          _saveItems(scope, st.items);
          _renderItems();
          _setStatus('✓ 已加入: ' + finalP);
          onLog('+ 已加入传输项: ' + finalP + ' (共 ' + st.items.length + ' 项)', 'ok');
          return;
        }
        if (t && t.classList && t.classList.contains('uni-chk')){
          var boxes = list.querySelectorAll('.uni-chk');
          var checked = list.querySelectorAll('.uni-chk:checked');
          _setStatus('已选 ' + checked.length + ' / ' + boxes.length + ' · ' + ps.cwd);
          _updateSelbar();
          return;
        }
        var a = t;
        while (a && a !== list && !(a.classList && a.classList.contains('uni-dir'))) a = a.parentNode;
        if (!a || a === list) return;
        var name = a.getAttribute('data-name');
        if (!name) return;
        if (_dblOpen && name !== '..') return;   // v5.90.5 · 双击模式: 行内目录单击不进入
        var base = (ps.cwd||'').replace(/\/+$/,'');
        // v4.38.37 · 进入目录后自动把「从本栏加入的传输项」的目标/来源重定位到该目录
        var _navTo = base + '/' + name;
        load(_navTo);
        try { _autoRetarget(sideKey, _navTo + '/'); } catch(_e){}
      });
      // v5.90.5 · 双击模式: 双击目录 = 进入 (含预览模式联动)
      list.addEventListener('dblclick', function(ev){
        if (!window.RPOpenMode || window.RPOpenMode.get() !== 'double') return;
        var t = ev.target;
        var up = t.closest ? t.closest('.uni-dir') : null;
        if (!up || !list.contains(up)) return;
        var dp = up.getAttribute('data-name') || '';
        var dpFull = up.getAttribute('data-path') || ((ps.cwd.replace(/\/+$/, '') || '') + '/' + dp);
        try {
          if (typeof _midTab !== 'undefined' && _midTab === 'preview'){
            var _dmPrevOnly2 = false;
            try { _dmPrevOnly2 = (window.RpUI && window.RpUI.modeOf('dm') === 'preview'); } catch(e){}
            if (!_dmPrevOnly2){
              _previewCtx = { sideKey: sideKey, path: dpFull, name: dp, isDir: true };
              _dmRenderPreview();
            }
          }
        } catch(e){}
        try { load(dpFull); } catch(e){}
        try { _autoRetarget(sideKey, dpFull + '/'); } catch(_e){}
      });

      return {
        pane: pane,
        load: load,
        getCwd: function(){ return ps.cwd; },
        getDesc: function(){ return ps.desc; },
        // v5.14.1 · 供中栏预览构建上一张/下一张导航列表
        getEntries: function(){ return ps.entries || []; },
        setDesc: function(d, initialPath){
          ps.desc = d;
          if (initialPath) ps.cwd = initialPath;
          load(ps.cwd);
        },
        setEntries: function(entries, cwd){ ps.entries = entries || []; if (cwd) ps.cwd = cwd; _render(); },
        getSelMode: function(){ return ps.selMode; },
        destroy: function(){},
      };
    }

    // -- v4.38.34 · 两栏目标目录指示: 每栏显示"从本栏加入的项将传到哪" --
    function _srvLabel(srvId){
      if (!srvId || srvId === 0) return '本机';
      var s = _resolveFromPool(srvId);
      return s ? (s.label || s.host || ('srv#'+srvId)) : ('srv#'+srvId);
    }
    function _mkDstBar(cell){
      var b = document.createElement('div');
      b.className = 'tri-dst-bar';
      b.style.cssText = 'display:flex;align-items:center;gap:4px;padding:2px 8px;background:var(--bg3);border-bottom:1px solid var(--border);font-size:10px;color:var(--text2);overflow:hidden;white-space:nowrap';
      b.innerHTML = '<span style="color:var(--yellow)">📍 目标目录</span>'
        + '<span class="tri-dst-txt" style="flex:1;color:var(--cyan);font-family:monospace;overflow:hidden;text-overflow:ellipsis" title="">-</span>';
      var bodyEl = cell.querySelector('.tri-pane-body');
      if (bodyEl && bodyEl.parentNode) bodyEl.parentNode.insertBefore(b, bodyEl);
      return b;
    }
    var srcDstBar = _mkDstBar(sourceCell);
    var tgtDstBar = _mkDstBar(targetCell);
    function _updateDstBars(){
      try {
        var tCwd = (st.targetPane && st.targetPane.getCwd) ? (st.targetPane.getCwd() || '/') : '/';
        var sCwd = (st.sourcePane && st.sourcePane.getCwd) ? (st.sourcePane.getCwd() || '/') : '/';
        var sTxt = srcDstBar.querySelector('.tri-dst-txt');
        if (sTxt){ sTxt.textContent = _srvLabel(st.targetSrvId) + ':' + tCwd; sTxt.title = '本栏加入项 → ' + _srvLabel(st.targetSrvId) + ':' + tCwd; }
        var tTxt = tgtDstBar.querySelector('.tri-dst-txt');
        if (tTxt){ tTxt.textContent = _srvLabel(st.sourceSrvId) + ':' + sCwd; tTxt.title = '本栏加入项 → ' + _srvLabel(st.sourceSrvId) + ':' + sCwd; }
      } catch(_){}
    }
    setInterval(_updateDstBars, 1000);
    _updateDstBars();

    // -- 方向控制 (内部 + 公共) --
    // v4.38.26 · pane 标题随方向变化
    //   up:    源:本地源路径 / 目标:远端目标路径
    //   down:  源:远端源路径 / 目标:本地目标路径
    //   same:  源:本地A / 目标:本地B
    //   cross: 源:远端A / 目标:远端B
    //   sync:  源:本地/远端(双向) / 目标:本地/远端(双向)
    var _titleMap = {
      up:    { source: '⬆ 本地源路径',     target: '⬆ 远端目标路径',     hint: '⬆ 本机 → 远端' },
      down:  { source: '⬇ 远端源路径',     target: '⬇ 本地目标路径',     hint: '⬇ 远端 → 本机' },
      same:  { source: '⇄ 本地 A 路径',    target: '⇄ 本地 B 路径',      hint: '⇄ 本地 → 本地（同一台机内的两个目录）' },
      cross: { source: '🔁 远端 A 路径',   target: '🔁 远端 B 路径',     hint: '🔁 远端 → 远端（同时连接两台远端服务器）' },
      sync:  { source: '⟳ 双向源',         target: '⟳ 双向目标',         hint: '⟳ 双向同步（src↔dst 互相同步）' },
    };
    function _setDirection(d){
      st.direction = d;
      // 内部 dir-btns 高亮
      var btns = dirBar.querySelectorAll('.tri-dir-btn');
      btns.forEach(function(b){
        if (b.getAttribute('data-dir') === d) b.classList.add('active');
        else b.classList.remove('active');
      });
      var m = _titleMap[d] || _titleMap.up;
      // pane 标题 (v4.38.35 · 标题随来源: "📂 Source · Local" / "🎯 Target · df mount /data")
      var sT = sourceCell.querySelector('.tri-pane-title');
      var tT = targetCell.querySelector('.tri-pane-title');
      if (sT){ sT.textContent = '📂 源 · ' + _srcLabel(st.sourceDesc); sT.title = sT.textContent; }
      if (tT){ tT.textContent = '🎯 目标 · ' + _srcLabel(st.targetDesc); tT.title = tT.textContent; }
      // hint
      var hEl = dirBar.querySelector('.tri-dir-hint');
      if (hEl) hEl.textContent = m.hint;
      onLog('切换传输方向: ' + m.hint, 'info');
      _refreshSrvSel();
      setTimeout(_styleActive, 0);
    }
    // v4.38.26 · 公共 setDirection: 不触发 onLog, 不重复 active
    function setDirection(d){
      st.direction = d;
      var btns = dirBar.querySelectorAll('.tri-dir-btn');
      btns.forEach(function(b){
        if (b.getAttribute('data-dir') === d) b.classList.add('active');
        else b.classList.remove('active');
      });
      var m = _titleMap[d] || _titleMap.up;
      var sT = sourceCell.querySelector('.tri-pane-title');
      var tT = targetCell.querySelector('.tri-pane-title');
      if (sT){ sT.textContent = '📂 源 · ' + _srcLabel(st.sourceDesc); sT.title = sT.textContent; }
      if (tT){ tT.textContent = '🎯 目标 · ' + _srcLabel(st.targetDesc); tT.title = tT.textContent; }
      var hEl = dirBar.querySelector('.tri-dir-hint');
      if (hEl) hEl.textContent = m.hint;
      _refreshSrvSel();
      setTimeout(_styleActive, 0);
    }
    function _refreshSrvSel(){
      // v4.38.24 · 每次刷新都从 SrvPool 取最新（包含临时服务器）
      if (window.SrvPool && window.SrvPool.getSrvList) srvList = window.SrvPool.getSrvList();
      // v4.40.0 P1 · ☁ 远端存储缓存: 为空时主动拉一次 (UniPane cloud 分组数据源)
      if (!(window.__cloudRemotesCache && window.__cloudRemotesCache.length)){
        try {
          if (typeof window.send === 'function'){
            // v1.0.0 · 社区档无"远端存储"键 → 不拉
            if (window.__featInEdition && !window.__featInEdition('cloud')) return;
            window.send({ action: 'remote_list' }, function(d){
              if (d && d.status === 'ok' && d.remotes){
                window.__cloudRemotesCache = d.remotes;
                _refreshSrvSel();  // 重入刷新下拉 (此时 cloud 组已可渲染)
              }
            });
          }
        } catch(_){}
      }
      // v5.50.0 · 统一数据源: 走 SP.serverRows (与连接中心同源), 不再直连 REST /api/servers
      //   (审计报告 #4: 三栏/双栏/预览/DM 服务器列表统一由 server_profiles 提供, REST 仅作旧接口保留)
      if (window.SrvPool && window.SrvPool.getSrvList && !(srvList || []).length
          && window.SP && window.SP.serverRows){
        window.SP.serverRows().then(function(msg){
          var arr = (msg && msg.configs) || [];
          if (!arr.length) return;
          if (window.SrvPool.setSrvList) window.SrvPool.setSrvList(arr);
          srvList = window.SrvPool.getSrvList();
          _refreshSrvSel();  // 重入一次 (此时列表非空, 不再拉取)
        }).catch(function(){});
      }
      var sSel = sourceCell.querySelector('.tri-srv-sel');
      var tSel = targetCell.querySelector('.tri-srv-sel');
      // v4.38.35 · UniPane: 来源下拉 (optgroup 分组 · 本机/服务器/临时/df/云)
      var ctx = { srvList: srvList, showDf: (scope === 'disk_manager'), showCloud: true };
      sSel.innerHTML = _buildSrcOptions(st.sourceDesc, ctx);
      tSel.innerHTML = _buildSrcOptions(st.targetDesc, ctx);
      try { sSel.value = _srcVal(st.sourceDesc); } catch(_){}
      try { tSel.value = _srcVal(st.targetDesc); } catch(_){}
      // 本地侧净化: kind='local' 时隐藏 服务器控件 (连接/临时按钮)
      _applyLocalClean(sourceCell, st.sourceDesc);
      _applyLocalClean(targetCell, st.targetDesc);
    }
    // v4.38.35 · kind='local' 栏隐藏 服务器下拉里的占位 + 连接/临时按钮 仍保留 (下拉里还有本机外的选项)
    //  实际"净化": local 时 🔌 连接 改为"刷新", ✚临时 隐藏
    function _applyLocalClean(cell, desc){
      var connBtn = cell.querySelector('.tri-srv-connect');
      var tempBtn = cell.querySelector('.tri-srv-temp');
      if (desc && desc.kind === 'local'){
        if (connBtn){ connBtn.textContent = '🔄 刷新'; connBtn.title = '刷新本机目录'; }
        if (tempBtn) tempBtn.style.display = 'none';
      } else {
        if (connBtn){ connBtn.textContent = '🔌 连接'; connBtn.title = '连接选中的来源'; }
        if (tempBtn) tempBtn.style.display = '';
      }
    }
    dirBar.querySelectorAll('.tri-dir-btn').forEach(function(b){
      b.style.cssText = 'padding:3px 10px;font-size:12px;border:1px solid var(--border);border-radius:5px;background:var(--bg3);color:var(--text);cursor:pointer';
      b.onclick = function(){ _setDirection(b.getAttribute('data-dir')); };
    });
    // 选中态样式
    function _styleActive(){
      dirBar.querySelectorAll('.tri-dir-btn').forEach(function(b){
        if (b.classList.contains('active')) b.style.background='var(--cyan)', b.style.color='#000', b.style.fontWeight='600';
        else b.style.background='var(--bg3)', b.style.color='var(--text)', b.style.fontWeight='normal';
      });
    }
    _setDirection(initialDirection);
    setTimeout(_styleActive, 0);

    // ═══ v4.66.0 · DM 中间栏 Tab: 传输项 ↔ 文件预览 ═══
    var _midTab = 'list';
    var _previewCtx = null;
    function _dmPreviewConn(sideKey){
      // 预览走 file_read/file_stat 的 SSH 通路: ssh/df 来源用 DM 自身凭据, 本机/共享挂载走本机
      var desc = (sideKey === 'source') ? st.sourceDesc : st.targetDesc;
      if (!desc) return { host:'' };
      if (desc.kind === 'ssh' || desc.kind === 'df') return _dmSshConnAuth();
      return { host:'' };  // local / share 挂载点 → 本机通路
    }
    function _dmSetMidTab(t){
      _midTab = (t === 'preview') ? 'preview' : 'list';
      var listEl = midCell.querySelector('.tri-items-body');
      var tbEl = midCell.querySelector('.tri-items-toolbar');
      var prevEl = midCell.querySelector('.tri-preview');
      midCell.querySelectorAll('.tri-mid-tab').forEach(function(el){
        var on = el.getAttribute('data-tab') === _midTab;
        el.style.color = on ? 'var(--cyan)' : 'var(--text3)';
        el.style.borderBottom = on ? '2px solid var(--cyan)' : '2px solid transparent';
        el.classList.toggle('active', on);
      });
      if (_midTab === 'preview'){
        if (listEl) listEl.style.display = 'none';
        if (tbEl) tbEl.style.display = 'none';
        if (prevEl) prevEl.style.display = 'flex';
        _dmRenderPreview();
      } else {
        if (prevEl) prevEl.style.display = 'none';
        if (listEl) listEl.style.display = '';
        if (tbEl) tbEl.style.display = '';
      }
      try { localStorage.setItem('tri_mid_tab_' + (opts && opts.scope || 'dm'), _midTab); } catch(e){}
    }
    function _dmRenderPreview(){
    // v4.98.0 · DM 中栏预览: 面包屑 + 返回 (任意层级跳转)
    try {
      // v5.3.0 · 未点击任何文件时也渲染面包屑+预览设置 (ctx 为空则用左栏 cwd)
      try {
        if (!_previewCtx){
          var _cwd0 = (ps && ps.cwd) || '/';
          _previewCtx = { sideKey: sideKey, path: _cwd0, name: String(_cwd0).split('/').filter(Boolean).pop() || '', isDir: true };
        }
      } catch(e0){}
      // v5.2.0 · 仅预览模式: 隐藏 DM 中栏面包屑
      try {
        if (window.RpUI && window.RpUI.modeOf('dm') === 'preview'){
          var _c0 = document.querySelector('.dm-preview-crumb');
          if (_c0) _c0.classList.add('rp-pm-only');   // v5.5.0 · class 控制, 保留 ⚙
        }
      } catch(e){}
      var midEl = document.querySelector('.tri-preview');   // v5.0.0 · 用实际存在的预览容器
      var host = midEl && midEl.parentNode;
      if (host && window.RpUI && _previewCtx){
        var crumb = host.querySelector('.dm-preview-crumb');
        if (!crumb){
          crumb = document.createElement('div');
          crumb.className = 'dm-preview-crumb';
          crumb.style.cssText = 'padding:4px 10px;background:var(--bg3);border-bottom:1px solid var(--border);display:flex;align-items:center;gap:4px;flex-wrap:wrap';
          host.insertBefore(crumb, host.firstChild);
        }
        var cur = _previewCtx.path || '';
        var dirP = _previewCtx.isDir ? cur : (cur.replace(/\/[^\/]*$/, '') || '/');
        window.RpUI.mountBreadcrumb(crumb, dirP, {
          onNav: function(p2){
            _previewCtx = { sideKey: _previewCtx.sideKey, path: p2, name: String(p2).split('/').filter(Boolean).pop()||'', isDir: true };
            try { var pn = (_previewCtx.sideKey === 'target') ? targetPane : sourcePane; if (pn && pn.load) pn.load(p2); } catch(e){}
            _dmRenderPreview();
          },
          onBack: function(){
            var up = dirP.replace(/\/[^\/]*$/, '') || '/';
            _previewCtx = { sideKey: _previewCtx.sideKey, path: up, name: String(up).split('/').filter(Boolean).pop()||'', isDir: true };
            try { var pn2 = (_previewCtx.sideKey === 'target') ? targetPane : sourcePane; if (pn2 && pn2.load) pn2.load(up); } catch(e){}
            _dmRenderPreview();
          }
        });
        if (!crumb.querySelector('.rp-pm-btn')){
          try { crumb.appendChild(window.RpUI.settingsButton('dm', '远端磁盘管理 · 中栏预览')); } catch(e){}
        }
        try { crumb.classList.toggle('rp-pm-only', !!(window.RpUI && window.RpUI.modeOf('dm') === 'preview')); } catch(e){}
      }
    } catch(e){ console.warn('[DM] crumb', e); }
      var prevEl = midCell.querySelector('.tri-preview');
      if (!prevEl) return;
      if (!window.FilePreview){
        prevEl.innerHTML = '<div style="padding:14px;color:var(--red);font-size:12px">✗ file_preview.js 未加载</div>';
        return;
      }
      var sideKey = _previewCtx ? _previewCtx.sideKey : 'source';
      var conn = _dmPreviewConn(sideKey);
      // v5.14.1 · 媒体文件构建同目录导航 (上一张/下一张) — DM 中栏此前从未传 _navList → 翻页消失
      var _navList = null, _navIdx = 0, _navDir = null;
      try {
        if (_previewCtx && !_previewCtx.isDir){
          var _nm0 = String(_previewCtx.name || '');
          var _MEDIA = /\.(jpe?g|png|gif|webp|svg|bmp|avif|mp4|mkv|webm|mov|mp3|flac|wav|m4a|ogg)$/i;
          if (_MEDIA.test(_nm0)){
            var _pn0 = (sideKey === 'target') ? st.targetPane : st.sourcePane;
            var _all0 = (_pn0 && typeof _pn0.getEntries === 'function') ? _pn0.getEntries() : [];
            var _med0 = _all0.filter(function(x){ return x && x.type !== 'dir' && _MEDIA.test(x.name || ''); })
                             .sort(function(a, b){ return String(a.name).localeCompare(String(b.name)); });
            if (_med0.length > 1){
              _navList = _med0.map(function(x){ return { name: x.name, path: x.path, size: x.size || 0 }; });
              _navIdx = Math.max(0, _navList.findIndex(function(x){ return x.name === _nm0; }));
              _navDir = String(_previewCtx.path || '').replace(/\/[^\/]*$/, '') || '/';
            }
          }
        }
      } catch(eNav){ console.warn('[DM] navList', eNav); }
      // v5.14.1 · 中栏预览工具条加入/直接传输共用的项构造器 (与列表视图同结构)
      function _mkPreviewItem(p2, entry2){
        var _fty = (entry2 && entry2.type === 'dir') ? 'dir' : 'item';
        var _fp = (_fty === 'dir') ? (String(p2).replace(/\/+$/, '') + '/') : String(p2);
        var _mym = _descMarks(sideKey);
        var _sm = _descMarks('source');
        var _tm = _descMarks('target');
        var _oc = ((sideKey === 'source')
          ? ((st.targetPane && st.targetPane.getCwd) ? (st.targetPane.getCwd() || '/') : '/')
          : ((st.sourcePane && st.sourcePane.getCwd) ? (st.sourcePane.getCwd() || '/') : '/'));
        if (_oc.slice(-1) !== '/') _oc += '/';
        var _b = _fp.replace(/\/+$/,'').split('/').pop() || 'item';
        var _op = (_fty === 'dir') ? (_oc + _b + '/') : (_oc + _b);
        return {
          id: 'ti_' + Date.now() + '_' + Math.random().toString(36).slice(2,6),
          src: (sideKey === 'source') ? _fp : _op,
          dst: (sideKey === 'source') ? _op : _fp,
          type: _fty,
          status: 'pending', ts: Date.now(),
          srcSrv: (sideKey === 'source') ? (_mym.srcSrv || st.sourceSrvId || 0) : (_sm.srcSrv || 0),
          dstSrv: (sideKey === 'target') ? (_mym.dstSrv || st.targetSrvId || 0) : (_tm.dstSrv || 0),
          srcHost: (sideKey === 'source') ? (_mym.srcHost || '') : (_sm.srcHost || ''),
          dstHost: (sideKey === 'target') ? (_mym.dstHost || '') : (_tm.dstHost || ''),
          srcCloud: (sideKey === 'source') ? (_mym.srcCloud || '') : (_sm.srcCloud || ''),
          dstCloud: (sideKey === 'target') ? (_mym.dstCloud || '') : (_tm.dstCloud || ''),
          fromSide: sideKey,
        };
      }
      // v5.0.0 · 目录 → 中栏出目录内容 (列表/缩略图, 可点进子目录或文件)
      try {
        if (_previewCtx && _previewCtx.isDir && !prevEl.__dirHooked){
          prevEl.__dirHooked = true;
        }
      } catch(e){}
      window.FilePreview.render(prevEl, {
        side: conn.host ? 'remote' : 'local',
        conn: conn,
        _isDir: !!(_previewCtx && _previewCtx.isDir),
        _pmScope: 'dm',
        cloudId: (function(){
          try {
            var d = (sideKey === 'target') ? st.targetDesc : st.sourceDesc;
            return (d && d.kind === 'cloud' && d.cloudId != null) ? d.cloudId : null;
          } catch(e){ return null; }
        })(),
        path: _previewCtx ? _previewCtx.path : '',
        name: _previewCtx ? _previewCtx.name : '',
        _navList: _navList,
        _navIdx: _navIdx,
        _navDir: _navDir,
        // v5.14.1 · 项结构对齐列表视图 (status/srcSrv/dstSrv/...) — 旧实现缺 status:'pending'
        //   → _startTransfer 过滤不到 → 表现为"点直接传输没反应/无待传项(全部已完成)"
        onAddTransfer: function(p, entry){
          if (st.items.some(function(it){ return it.src === p; })){ onLog('⚠ 已在传输项中: ' + p, 'warn'); return; }
          st.items.push(_mkPreviewItem(p, entry));
          try { _saveItems(opts && opts.scope, st.items); } catch(e){}
          if (typeof _renderItems === 'function') _renderItems();
          onLog('✓ 已加入传输项: ' + p, 'success');
        },
        // v5.6.0 · 直接传输: 加入传输项后立即发起
        onDirectTransfer: function(p, entry){
          if (!st.items.some(function(it){ return it.src === p; })){
            st.items.push(_mkPreviewItem(p, entry));
            try { _saveItems(opts && opts.scope, st.items); } catch(e){}
            if (typeof _renderItems === 'function') _renderItems();
          }
          onLog('⚡ 直接传输: ' + p, 'info');
          // v5.14.1 · 直接调本实例 _startTransfer — 旧实现 querySelector('.tp-start-btn'...)
          //   找的是别的页面按钮, 且项本身缺 status → 用户看到"点了没反应"
          setTimeout(function(){
            try { _startTransfer(); }
            catch(e){ onLog('✗ 启动传输失败: ' + e.message, 'err'); }
          }, 250);
        },
        onChanged: function(){
          _previewCtx = null;
          _dmRenderPreview();
          try { if (st.sourcePane && st.sourcePane.load) st.sourcePane.load(st.sourcePane.getCwd()); } catch(e){}
          try { if (st.targetPane && st.targetPane.load) st.targetPane.load(st.targetPane.getCwd()); } catch(e){}
        },
      });
    }
    midCell.querySelectorAll('.tri-mid-tab').forEach(function(el){
      el.onclick = function(){ _dmSetMidTab(el.getAttribute('data-tab')); };
    });

    // v4.38.35 · UniPane 实例化 (取代 _initPanes 的 FileBrowser/dmSsh 双轨)
    st.sourcePane = _buildUniPane(sourceCell.querySelector('.tri-pane-body'), 'source');
    st.targetPane = _buildUniPane(targetCell.querySelector('.tri-pane-body'), 'target');
    // v4.38.29 · 创建后自动 load 两栏 (默认根目录), 用户立刻看到文件列表
    setTimeout(function(){
      try {
        if (st.sourcePane && typeof st.sourcePane.load === 'function') st.sourcePane.load('/');
        if (st.targetPane && typeof st.targetPane.load === 'function') st.targetPane.load('/');
      } catch(e){ console.warn('[TransferTri] initial load fail', e); }
      // v4.38.35 · 初次按来源推导方向 (DM: df源+本机目标 -> down)
      //   仅当调用方未显式传 opts.direction 时推导, 避免覆盖用户显式选择 (cross/sync 等)
      try { if (!opts.direction) _updateDirFromDesc(); } catch(_){}
    }, 50);

    // -- 来源下拉变化 · v4.38.35 UniPane 描述符切换 + 自动连接 --
    function _onSrcChange(sideKey){
      var cell = (sideKey === 'source') ? sourceCell : targetCell;
      var sel = cell.querySelector('.tri-srv-sel');
      var desc = _parseSrcVal(sel.value);
      if (sideKey === 'source'){ st.sourceDesc = desc; st.sourceSrvId = (desc.kind === 'ssh') ? desc.srvId : 0; }
      else { st.targetDesc = desc; st.targetSrvId = (desc.kind === 'ssh') ? desc.srvId : 0; }
      // 兼容旧字段: ssh 来源同步 srvId (供传输 _authOf 使用)
      if (window.SrvPool && desc.kind === 'ssh') window.SrvPool.set(scope, sideKey, desc.srvId);
      onLog((sideKey === 'source' ? '源' : '目标') + '来源切换: ' + _srcLabel(desc), 'dim');
      _refreshSrvSel();
      _updateDirFromDesc();   // v4.38.35 · 方向自动推导
      try {
        var pane = (sideKey === 'source') ? st.sourcePane : st.targetPane;
        // v5.4.0 · df 挂载点/共享: 切换来源后应直接进入该挂载点 (旧实现固定 '/' → EFI 等分区
        //   选完仍显示根目录内容, 用户报"分区内容不匹配/又显示 / 目录")
        var _initP = '/';
        if (desc.kind === 'df' && desc.mount) _initP = desc.mount;
        else if (desc.kind === 'share' && desc.mount) _initP = desc.mount;
        if (pane && pane.setDesc) pane.setDesc(desc, _initP);
      } catch(err){ console.warn('[tri] setDesc fail', err); }
    }
    sourceCell.querySelector('.tri-srv-sel').onchange = function(){ _onSrcChange('source'); };
    targetCell.querySelector('.tri-srv-sel').onchange = function(){ _onSrcChange('target'); };

    // v4.38.35 · 来源 label (日志/标题用)
    function _srcLabel(desc){
      if (!desc || desc.kind === 'local') return '本机';
      if (desc.kind === 'ssh'){
        var s = _resolveFromPool(desc.srvId);
        return s ? (s.label || s.host || ('srv#'+desc.srvId)) : ('srv#'+desc.srvId);
      }
      if (desc.kind === 'df'){
        var mounts = _getDfMounts();
        return 'df:' + (mounts.host || '?') + (desc.mount ? (':' + desc.mount) : '');
      }
      // v5.14.1 · 网络共享挂载点 (本机通路) — 旧实现落到了兜底 '?'
      if (desc.kind === 'share'){
        var _sm = String(desc.mount || '').replace(/\/+$/, '');
        return '🔗共享:' + (_sm.split('/').pop() || _sm || '?');
      }
      // v4.38.36 · cloud 标签用名称 (整串 UUID 过长会撑爆 pane 标题, 见 bug B)
      if (desc.kind === 'cloud'){
        var cs = _getCloudRemotes();
        for (var i=0;i<cs.length;i++){
          if (String(cs[i].uuid || cs[i].id) === String(desc.cloudId)){
            return '☁' + (cs[i].label || cs[i].name || ('remote#'+(cs[i].id||'?')));
          }
        }
        var idS = String(desc.cloudId || '');
        return '☁' + (idS.length > 8 ? idS.slice(0,8) + '…' : idS);
      }
      return '?';
    }
    // v4.38.35 · 方向自动推导: 左local+右ssh/df/cloud=up / 左ssh+右local=down / 双local=same / 双远端=cross
    //   sync 保持显式 (用户手动选); 推导只发生在"用户没显式锁定方向"时 -- 简化: 每次来源变化都推导, sync 除外
    function _updateDirFromDesc(){
      if (st.direction === 'sync') return;
      var sk = (st.sourceDesc && st.sourceDesc.kind) || 'local';
      var tk = (st.targetDesc && st.targetDesc.kind) || 'local';
      var sRemote = (sk !== 'local');
      var tRemote = (tk !== 'local');
      var d = (sRemote && tRemote) ? 'cross' : (sRemote ? 'down' : (tRemote ? 'up' : 'same'));
      if (d !== st.direction){
        setDirection(d);
        onLog('↔ 方向自动推导: ' + _srcLabel(st.sourceDesc) + ' -> ' + _srcLabel(st.targetDesc) + ' = ' + d, 'info');
      }
    }

    // -- 连接按钮：触发对应 pane 重新 load --
    function _connect(sideKey){
      // v4.38.35 · UniPane: 统一 load 当前目录 (凭据由描述符解析)
      var pane = (sideKey === 'source') ? st.sourcePane : st.targetPane;
      var desc = (sideKey === 'source') ? st.sourceDesc : st.targetDesc;
      if (!pane || typeof pane.load !== 'function') return;
      var cwd = (pane.getCwd && pane.getCwd()) || '/';
      onLog('🔌 正在连接 ' + _srcLabel(desc) + ' ' + cwd + ' ...', 'info');
      pane.load(cwd);
    }
    sourceCell.querySelector('.tri-srv-connect').onclick = function(){ _connect('source'); };
    targetCell.querySelector('.tri-srv-connect').onclick = function(){ _connect('target'); };


    // -- 选中加入传输 --
    // v4.38.34 · _dirArrow: 彩色方向箭头 (依据 src/dst 远端标记 + fromSide)
    // v4.38.35 · 远端判定: "N:" 前缀 | srcSrv/dstSrv 非零 | srcHost/dstHost (df 挂载) | srcCloud/dstCloud (远端存储)
    function _dirArrow(it){
      var srcRemote = /^-?\d+:/.test(it.src || '') || (it.srcSrv > 0) || !!it.srcHost || !!it.srcCloud;
      var dstRemote = /^-?\d+:/.test(it.dst || '') || (it.dstSrv > 0) || !!it.dstHost || !!it.dstCloud;
      if (st.direction === 'sync') return { icon: '⟳', color: 'var(--yellow)', title: '双向同步' };
      if (srcRemote && dstRemote) return { icon: '⇄', color: 'var(--purple)', title: '远端 -> 远端' };
      if (srcRemote && !dstRemote) return { icon: '⬅', color: 'var(--cyan)', title: '远端 -> 本地 (下载)' };
      if (!srcRemote && dstRemote) return { icon: '➡', color: 'var(--green)', title: '本地 -> 远端 (上传)' };
      return { icon: '->', color: 'var(--text3)', title: '同机复制' };
    }
    // v4.38.35 · 侧来源描述符 -> 项的远端标记 (df/cloud 带 host)
    function _descMarks(sideKey){
      var desc = (sideKey === 'source') ? st.sourceDesc : st.targetDesc;
      var marks = {};
      if (desc && desc.kind === 'ssh'){ marks[sideKey === 'source' ? 'srcSrv' : 'dstSrv'] = desc.srvId; }
      else if (desc && (desc.kind === 'df')){
        marks[sideKey === 'source' ? 'srcHost' : 'dstHost'] = desc.host || _getDfMounts().host || '';
      }
      // v4.40.0 P1 · 远端存储: 项带 srcCloud/dstCloud (cloudId) -> _runOne 走 remote_download/upload
      else if (desc && desc.kind === 'cloud'){
        marks[sideKey === 'source' ? 'srcCloud' : 'dstCloud'] = desc.cloudId || '';
      }
      return marks;
    }
    function _addToItems(path, fromSide){
      if (!path){ onLog('⚠ 选中加入：路径为空', 'warn'); return; }
      if (st.items.some(function(it){ return it.src === path; })){ onLog('⚠ 已在传输项中: ' + path, 'warn'); return; }
      var srcMarks = _descMarks('source');
      var dstMarks = _descMarks('target');
      // v4.38.36 · bug C 修复: dst 不能等于 src (旧逻辑 dst:path -> "自己拷自己")
      //   - 从源侧加入: dst = 目标栏当前目录 + 文件名 (目标栏是目录锚点)
      //   - 从目标侧加入: src = 源栏当前目录 + 文件名
      var baseName = path.replace(/\/+$/,'').split('/').pop() || 'item';
      var otherCwd = (fromSide === 'source')
        ? ((st.targetPane && st.targetPane.getCwd) ? (st.targetPane.getCwd() || '/') : '/')
        : ((st.sourcePane && st.sourcePane.getCwd) ? (st.sourcePane.getCwd() || '/') : '/');
      if (otherCwd.slice(-1) !== '/') otherCwd += '/';
      var otherPath = otherCwd + baseName;
      st.items.push({
        id: 'ti_' + Date.now() + '_' + Math.random().toString(36).slice(2,6),
        src: (fromSide === 'source') ? path : otherPath,
        dst: (fromSide === 'source') ? otherPath : path,
        type: 'item', status: 'pending',
        // v4.40.1 bugfix · 标记归属固定: src 字段永远取源侧描述符, dst 字段永远取目标侧描述符
        //   旧代码用 fromSide 条件导致: 源侧勾选+目标=云 时 dstCloud 丢失 -> 云上传误走 local 复制
        srcSrv: srcMarks.srcSrv || st.sourceSrvId || 0,
        dstSrv: dstMarks.dstSrv || st.targetSrvId || 0,
        srcHost: srcMarks.srcHost || '',
        dstHost: dstMarks.dstHost || '',
        srcCloud: srcMarks.srcCloud || '',
        dstCloud: dstMarks.dstCloud || '',
        fromSide: fromSide || 'source',  // v4.38.34 · 记录加入侧
        ts: Date.now(),
      });
      _saveItems(scope, st.items);
      _renderItems();
      onLog('+ 已加入传输项: ' + path + ' -> ' + otherPath + ' (共 ' + st.items.length + ' 项)', 'ok');
    }
    function _srvPath(srvId, p){
      if (!srvId || srvId === 0 || srvId === '0') return p;
      // 远端路径前缀: srvId=2 → "2:/path"
      return srvId + ':' + p;
    }
    // v4.38.35 · 更新某侧 UniPane 的底部 selbar 计数 (供外部按钮调用后刷新)
    function _updateSelbarIfAny(cell){
      var list = cell.querySelector('.uni-list');
      var selbar = cell.querySelector('.dm-ssh-selbar');
      if (!list || !selbar) return;
      var boxes = list.querySelectorAll('.uni-chk:checked');
      selbar.style.display = (boxes.length > 0) ? 'inline-flex' : 'none';
      var cnt = selbar.querySelector('.dm-ssh-selcount');
      if (cnt) cnt.textContent = '✓ 已选 ' + boxes.length + ' 项';
    }
    sourceCell.querySelector('.tri-add-sel').onclick = function(){
      // v4.38.35 · UniPane: 优先把勾选项加入 (含描述符标记); 无勾选则加当前目录
      if (st.sourcePane && st.sourcePane.pane){
        var checked = st.sourcePane.pane.querySelectorAll('.uni-chk:checked');
        if (checked.length){
          var srcMarks = _descMarks('source');
          var dstMarks = _descMarks('target');
          // v4.38.36 · bug C 修复: dst 不再等于 src; 目标侧标记 (dstSrv/dstHost) 也带上
          var tgtCwd = (st.targetPane && st.targetPane.getCwd) ? (st.targetPane.getCwd() || '/') : '/';
          if (tgtCwd.slice(-1) !== '/') tgtCwd += '/';
          var added = 0;
          checked.forEach(function(c){
            var p = c.getAttribute('data-path');
            if (!p) return;
            var ty = c.getAttribute('data-type');
            var finalP = (ty === 'dir') ? (p.replace(/\/+$/,'') + '/') : p;
            var baseName = finalP.replace(/\/+$/,'').split('/').pop() || 'item';
            var dstP = (ty === 'dir') ? (tgtCwd + baseName + '/') : (tgtCwd + baseName);
            if (!st.items.some(function(it){ return it.src === finalP; })){
              st.items.push({
                id: 'ti_' + Date.now() + '_' + Math.random().toString(36).slice(2,6),
                src: finalP, dst: dstP,   // v4.38.36 · dst = 目标栏 cwd + 文件名
                type: (ty === 'dir') ? 'dir' : 'item',
                status: 'pending',
                srcSrv: srcMarks.srcSrv || 0, dstSrv: dstMarks.dstSrv || 0,
                srcHost: srcMarks.srcHost || '', dstHost: dstMarks.dstHost || '',
                // v4.40.0 P1 · 远端存储标记
                srcCloud: srcMarks.srcCloud || '', dstCloud: dstMarks.dstCloud || '',
                ts: Date.now(),
                fromSide: 'source',
              });
              added++;
            }
          });
          if (added){
            _saveItems(scope, st.items);
            _renderItems();
            checked.forEach(function(c){ c.checked = false; });
            _updateSelbarIfAny(sourceCell);
            onLog('+ 已加入 ' + added + ' 个勾选项 (共 ' + st.items.length + ' 项)', 'ok');
            return;
          }
          onLog('⚠ 勾选项均已存在', 'warn'); return;
        }
      }
      var cwd = st.sourcePane.getCwd() || '/';
      _addToItems(cwd, 'source');
    };
    targetCell.querySelector('.tri-add-sel').onclick = function(){
      // v4.38.35 · UniPane: 勾选项优先 (含目标侧标记)
      if (st.targetPane && st.targetPane.pane){
        var checked = st.targetPane.pane.querySelectorAll('.uni-chk:checked');
        if (checked.length){
          var dstMarks = _descMarks('target');
          var srcMarks = _descMarks('source');
          // v4.38.36 · bug C 修复: src 不再等于 path 本身; 取源栏 cwd + 文件名; 源侧标记也带上
          var srcCwd = (st.sourcePane && st.sourcePane.getCwd) ? (st.sourcePane.getCwd() || '/') : '/';
          if (srcCwd.slice(-1) !== '/') srcCwd += '/';
          var added = 0;
          checked.forEach(function(c){
            var p = c.getAttribute('data-path');
            if (!p) return;
            var ty = c.getAttribute('data-type');
            var finalP = (ty === 'dir') ? (p.replace(/\/+$/,'') + '/') : p;
            var baseName = finalP.replace(/\/+$/,'').split('/').pop() || 'item';
            var srcP = (ty === 'dir') ? (srcCwd + baseName + '/') : (srcCwd + baseName);
            if (!st.items.some(function(it){ return it.src === srcP; })){
              st.items.push({
                id: 'ti_' + Date.now() + '_' + Math.random().toString(36).slice(2,6),
                src: srcP, dst: finalP,   // v4.38.36 · src = 源栏 cwd + 文件名
                type: (ty === 'dir') ? 'dir' : 'item',
                status: 'pending',
                srcSrv: srcMarks.srcSrv || 0, dstSrv: dstMarks.dstSrv || 0,
                srcHost: srcMarks.srcHost || '', dstHost: dstMarks.dstHost || '',
                // v4.40.0 P1 · 远端存储标记
                srcCloud: srcMarks.srcCloud || '', dstCloud: dstMarks.dstCloud || '',
                ts: Date.now(),
                fromSide: 'target',
              });
              added++;
            }
          });
          if (added){
            _saveItems(scope, st.items);
            _renderItems();
            checked.forEach(function(c){ c.checked = false; });
            _updateSelbarIfAny(targetCell);
            onLog('+ 已加入 ' + added + ' 个勾选项 (共 ' + st.items.length + ' 项)', 'ok');
            return;
          }
          onLog('⚠ 勾选项均已存在', 'warn'); return;
        }
      }
      var cwd = st.targetPane.getCwd() || '/';
      _addToItems(cwd, 'target');
    };

    // -- 渲染传输项列表 --
    function _renderItems(){
      var body = midCell.querySelector('.tri-items-body');
      body.innerHTML = '';
      if (!st.items.length){
        body.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text3)">（暂无传输项 · 在源/目标栏选目录后点 [+ ➕ 选中加入]）</div>';
        midCell.querySelector('.tri-items-count').textContent = '0 项';
        return;
      }
      st.items.forEach(function(it, idx){
        var row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:5px 6px;border-bottom:1px dashed var(--border);font-size:12px';
        var statusIcon = {
          pending: '⏳', running: '🔄', ok: '✅', err: '❌', retry: '🔁',
          abort: '⏹', skip: '⏭',
        }[it.status] || '⏳';
        var statusColor = {
          pending: 'var(--text3)', running: 'var(--cyan)',
          ok: 'var(--green)', err: 'var(--red)', retry: 'var(--yellow)',
          abort: 'var(--red)', skip: 'var(--text3)',
        }[it.status] || 'var(--text3)';
        // v4.38.34 · 彩色方向箭头: ➡绿(上传) ⬅青(下载) ⇄紫(远端->远端) ⟳黄(双向) ->灰(同机)
        var ar = _dirArrow(it);
        row.innerHTML =
          '<span style="font-family:monospace;color:var(--text3);min-width:24px">'+(idx+1)+'.</span>' +
          '<span style="color:var(--text2);font-size:10px;border:1px solid var(--border);border-radius:3px;padding:0 3px" title="加入侧">'+(it.fromSide === 'target' ? '右' : '左')+'</span>' +
          '<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+_esc(it.src)+'">'+_esc(it.src)+'</span>' +
          '<span class="ti-arrow" style="color:'+ar.color+';font-weight:700;font-size:13px;min-width:26px;text-align:center" title="'+_esc(ar.title)+'">'+ar.icon+'</span>' +
          '<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+_esc(it.dst)+'">'+_esc(it.dst)+'</span>' +
          '<span style="color:'+statusColor+';min-width:24px;text-align:center" title="'+_esc(it.status||'pending')+'">'+statusIcon+'</span>' +
          (it.status === 'err'
            ? '<button class="btn btn-sm ti-retry" data-id="'+it.id+'" style="padding:0 6px;font-size:10px;color:var(--yellow)" title="重试该项">🔁</button>'
            : '') +
          '<button class="btn btn-sm ti-del" data-id="'+it.id+'" style="padding:0 6px;font-size:10px;color:var(--red)" title="删除该项">✕</button>';
        body.appendChild(row);
      });
      midCell.querySelector('.tri-items-count').textContent = st.items.length + ' 项';
      body.querySelectorAll('.ti-del').forEach(function(b){
        b.onclick = function(){
          var id = b.getAttribute('data-id');
          st.items = st.items.filter(function(x){ return x.id !== id; });
          _saveItems(scope, st.items);
          _renderItems();
          onLog('🗑 已删除一项传输项', 'dim');
        };
      });
      body.querySelectorAll('.ti-retry').forEach(function(b){
        b.onclick = function(){
          var id = b.getAttribute('data-id');
          var it = st.items.find(function(x){ return x.id === id; });
          if (it){ it.status = 'pending'; _saveItems(scope, st.items); _renderItems(); onLog('🔁 重试: ' + it.src, 'info'); }
        };
      });
    }
    _renderItems();

    // -- 清空 --
    midCell.querySelector('.tri-clear').onclick = function(){
      if (!st.items.length) return;
      st.items = [];
      _saveItems(scope, st.items);
      _renderItems();
      onLog('🗑 已清空传输项', 'warn');
    };

    // -- 开始传输 --
    midCell.querySelector('.tri-start').onclick = function(){
      _startTransfer();
    };
    // -- v4.41.0 P3-2 · 中止: 真调后端 kill (杀当前 WS 连接正在运行的 fonrivc)
    midCell.querySelector('.tri-abort').onclick = function(){
      var running = st.items.filter(function(it){ return it.status === 'running'; });
      if (!running.length){ onLog('⏹ 当前无运行中的传输项', 'warn'); return; }
      var btn = midCell.querySelector('.tri-abort');
      if (btn) btn.disabled = true;
      onLog('⏹ 中止请求已发出 (' + running.length + ' 项运行中) ...', 'warn');
      running.forEach(function(it){ it.status = 'abort'; });
      _saveItems(scope, st.items);
      _renderItems();
      if (typeof window.send === 'function'){
        // v6.3.33 · 同上: 纯时间戳 id 并发撞号(批量中止) → 补随机后缀
        window.send({ action: 'kill', req_id: 'abort_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6) }, function(){}, true);
      }
    };

    // -- v4.41.4 · ⇪ 桥接到跨模块自动备份 (FlowMini, scope 随所在页面: transfer/disk_manager) --
    //   项 src 本地 (srcSrv=0 无 srcHost/srcCloud) -> local 源
    //   项 src SSH 远端 (srcSrv>0 或 srcHost)      -> rsync 源 + ext_auth (SrvPool/表单解析)
    //   项 dst ☁ 远端存储 (dstCloud=cloudId)       -> 勾选对应 remote_ids
    //   项 dst SSH 远端 -> FlowMini 目标仅支持 ☁ 云端, 该类项跳过并提示
    midCell.querySelector('.tri-to-flow').onclick = function(){
      if (!st.items.length){ onLog('⚠ 传输项为空, 无法桥接', 'warn'); return; }
      // v4.41.4 · 本页 mini: disk_manager 页有自己的 FlowMini 卡片 (v4.41.4 注入), 传输页用 transfer scope
      var miniScope = (scope === 'disk_manager') ? 'disk_manager' : 'transfer';
      var miniRoot = document.getElementById('flowMini_root_' + miniScope);
      if (!miniRoot){
        // v4.41.4 · 兜底: DM 页卡片未注入时尝试即时注入
        if (window.FlowMini && FlowMini.autoInjectAll) { try { FlowMini.autoInjectAll(); } catch(_){} }
        miniRoot = document.getElementById('flowMini_root_' + miniScope);
      }
      if (!miniRoot){ onLog('⚠ 未找到『跨模块自动备份』卡片, 请刷新页面', 'err'); return; }
      // 展开 mini 卡片
      var body = miniRoot.querySelector('.section-body');
      if (body && body.style.display === 'none'){
        var hd = miniRoot.querySelector('.section-header');
        if (hd && typeof toggleSection === 'function') toggleSection(hd);
        else body.style.display = '';
      }
      var localPaths = [], rsyncPaths = [], remoteIds = [];
      var skipped = [];
      st.items.forEach(function(it){
        var srcRemote = (it.srcSrv > 0) || !!it.srcHost || !!it.srcCloud || /^-?\d+:/.test(it.src || '');
        var dstCloudId = it.dstCloud || '';
        if (dstCloudId){
          var rid = parseInt(dstCloudId, 10);
          if (rid && remoteIds.indexOf(rid) < 0) remoteIds.push(rid);
        }
        if (it.srcCloud){
          skipped.push(it.src + ' (☁ 云源暂不支持, 请用 rsync/本地源)');
        } else if (srcRemote){
          // SSH 远端源: 记路径, flow_mini 保存时需提供 ext_auth (服务器下拉/页头连接)
          if (rsyncPaths.indexOf(it.src) < 0) rsyncPaths.push(it.src);
        } else {
          if (localPaths.indexOf(it.src) < 0) localPaths.push(it.src);
        }
        if (!dstCloudId && ((it.dstSrv > 0) || !!it.dstHost)){
          skipped.push(it.dst + ' (SSH 目标暂不支持, 自动备份目标仅 ☁ 远端存储)');
        }
      });
      var allPaths = localPaths.concat(rsyncPaths);
      if (!allPaths.length){ onLog('⚠ 无可桥接项: ' + (skipped.length ? skipped.join('; ') : '传输项为空'), 'warn'); return; }
      // 填充 mini: 优先 rsync (有远端源则切 rsync), 否则 local
      var srcSel = document.getElementById('flowMini_srcType_' + miniScope);
      var useRsync = rsyncPaths.length > 0;
      if (srcSel){
        srcSel.value = useRsync ? 'rsync' : 'local';
        if (window.FlowMini && FlowMini.onSrcTypeChange) FlowMini.onSrcTypeChange(miniScope);
      }
      var ta = document.getElementById('flowMini_paths_' + miniScope);
      if (ta){
        var cur = (ta.value || '').split(/\r?\n/).map(function(s){ return s.trim(); }).filter(Boolean);
        allPaths.forEach(function(p){ if (cur.indexOf(p) < 0) cur.push(p); });
        ta.value = cur.join('\n');
        ta.scrollIntoView({behavior:'smooth', block:'center'});
        ta.style.boxShadow = '0 0 0 2px var(--accent,#3498db)';
        setTimeout(function(){ ta.style.boxShadow = ''; }, 1600);
      }
      // 勾选远端
      if (remoteIds.length){
        document.querySelectorAll('#flowMini_remotes_' + miniScope + ' input.flowMiniRm').forEach(function(cb){
          var v = parseInt(cb.value, 10);
          if (remoteIds.indexOf(v) >= 0) cb.checked = true;
        });
      }
      var msg = '⇪ 已桥接 ' + allPaths.length + ' 个源路径到跨模块自动备份'
              + (useRsync ? ' (rsync 远端源 x' + rsyncPaths.length + ')' : '')
              + (remoteIds.length ? ' + ☁ 远端 ' + remoteIds.length + ' 个已勾选' : ' · 请在下方勾选目标远端')
              + ' · 选择调度后可保存为定时自动备份';
      onLog(msg, 'ok');
      if (skipped.length) onLog('⚠ 跳过 ' + skipped.length + ' 项: ' + skipped.join('; '), 'warn');
      if (typeof window.toast === 'function') toast(msg, 'success', 3500);
      miniRoot.scrollIntoView({behavior:'smooth', block:'center'});
    };

    // -- v4.40.2 P2 · 传输审计 (dry-run 差异清单) --
    // v4.40.2 · _authOf 提升到外层: 审计与传输共用 (原在 _startTransfer 内部)
    function _authOf(srvId){
      // v4.38.34 · per-item 凭据: srvId=0 -> 本机 (127.0.0.1, 凭据取 dm/transfer form);
      //   否则 SrvPool (含临时)
      var s = _resolveFromPool(srvId);
      if (s && s.host && srvId) return { host: s.host, port: s.port||22, user: s.user||'root', auth_type: s.auth_type||'pass', password: s.password||'', key: s.key||'', passphrase: s.passphrase||'' };
      // srvId=0 (本机) 或解析失败: 用 127.0.0.1 + 表单凭据 (getSrvAuth 已处理编码/fallback)
      var a = { host: '127.0.0.1', port: 22, user: 'root', auth_type: 'pass', password: '', key: '', passphrase: '' };
      try {
        if (typeof window.getSrvAuth === 'function'){
          var g = window.getSrvAuth();
          if (g && g.host){
            a.auth_type = g.auth_type || 'pass';
            a.password = g.password || '';
            a.key = g.key || '';
            a.passphrase = g.passphrase || '';
            a.user = g.user || 'root';
            a.port = g.port || 22;
          }
        }
      } catch(_){}
      return a;
    }

    midCell.querySelector('.tri-audit').onclick = function(){
      var pending = st.items.filter(function(it){ return it.status === 'pending' || it.status === 'retry' || it.status === 'err'; });
      if (!pending.length){ onLog('⚠ 无待审计项', 'warn'); return; }
      // v4.41.0 P3-4 · ☁ 云审计支持: 含云标记的项走 cloud 对比 (remote list_dir 递归),
      //   纯 ssh 项走 rsync dry-run; SSH↔云 混合项不支持 -> 明确报错
      var sshItems   = pending.filter(function(it){ return !(it.srcCloud || it.dstCloud); });
      var cloudItems = pending.filter(function(it){ return (it.srcCloud || it.dstCloud); });
      if (!pending.length){ onLog('⚠ 无待审计项', 'warn'); return; }
      var all = sshItems.concat(cloudItems);
      onLog('🔍 审计 ' + all.length + ' 项差异 (dry-run, 不实际传输) ...', 'info');
      var btn = midCell.querySelector('.tri-audit');
      if (btn){ btn.disabled = true; btn.textContent = '🔍 审计中...'; }
      var done = 0;
      var agg = { new: 0, update: 0, delete: 0, skip: 0, total: 0, dir: 0, files: [] };
      var failed = [];
      // v4.41.0 P3-7 · sync 双向审计汇总 (bidirectional 回包时聚合到面板)
      var syncAgg = null;
      all.forEach(function(it, i){
        // 云项: 直接发 cloud 审计 (本机<->云, 不支持 SSH 混合)
        if (it.srcCloud || it.dstCloud){
          if (it.srcSrv > 0 || it.dstSrv > 0 || it.srcHost || it.dstHost){
            done++;
            failed.push({ it: it, msg: 'SSH↔☁ 混合传输暂不支持审计' });
            onLog('✗ [' + (i+1) + '/' + all.length + '] 审计失败: SSH↔☁ 混合暂不支持', 'err');
            if (done >= all.length){ finishAudit(); }
            return;
          }
          var srcC = it.srcCloud ? _getCloudById(it.srcCloud) : null;
          var dstC = it.dstCloud ? _getCloudById(it.dstCloud) : null;
          var _rid2 = function(c){ return (c && (c.id || c.remote_id)) || 0; };
          var cPayload = {
            action: 'transfer_audit',
            direction: st.direction,
            src: it.src, dst: it.dst,
            src_cloud_rid: srcC ? _rid2(srcC) : 0,
            src_cloud_path: it.src,
            dst_cloud_rid: dstC ? _rid2(dstC) : 0,
            dst_cloud_path: it.dst,
            req_id: 'auditc_' + scope + '_' + i + '_' + Date.now()
          };
          window.send(cPayload, function(res){
            done++;
            if (res && res.status === 'ok'){
              var s = res.summary || {};
              agg.new += (s.new||0); agg.update += (s.update||0); agg.delete += (s.delete||0);
              agg.skip += (s.skip||0); agg.dir += (s.dir||0);
              agg.total += (s.total||0);
              if (res.bidirectional) syncAgg = res.bidirectional;
              (res.changes || []).forEach(function(c){ agg.files.push(c); });
              onLog('✓ [' + (i+1) + '/' + all.length + '] ☁ ' + it.src + ' -> ' + it.dst + ' : 新增' + (s.new||0) + ' 更新' + (s.update||0) + ' 跳过' + (s.skip||0), 'ok');
            } else {
              failed.push({ it: it, msg: (res && res.msg) || '审计失败' });
              onLog('✗ [' + (i+1) + '/' + all.length + '] ☁ 审计失败: ' + ((res && res.msg) || ''), 'err');
            }
            if (done >= all.length){ finishAudit(); }
          });
          return;
        }
        // 复用 _runOne 的方向解析: 直接调用 _runOne 内的逻辑不易抽出, 这里内联同款判定
        var m = /^(-?\d+):(.*)$/.exec(it.src || '');
        var _srcRem = !!m || (it.srcSrv > 0) || !!it.srcHost;
        var _dstRem = /^(-?\d+):/.test(it.dst || '') || (it.dstSrv > 0) || !!it.dstHost;
        var dir = (_srcRem && !_dstRem) ? 'down' : ((_dstRem && !_srcRem) ? 'up' : st.direction);
        if (!_srcRem && !_dstRem && (dir === 'up' || dir === 'down' || dir === 'same' || dir === 'sync')) dir = 'local';
        if (dir === 'same') dir = 'up';
        if (dir === 'cross'){
          dir = /^\/var\/lib\/fonriv_mounts\//.test(it.dst || '') ? 'down' : 'cross';
        }
        var srcPath = m ? m[2] : it.src;
        var dm2 = /^(-?\d+):(.*)$/.exec(it.dst || '');
        var dstPath = dm2 ? dm2[2] : it.dst;
        // 目录项补尾斜杠 (与 _runOne 一致)
        if ((it.type === 'dir') && srcPath && srcPath.slice(-1) !== '/') srcPath += '/';
        if ((it.type === 'dir') && dstPath && dstPath.slice(-1) !== '/') dstPath += '/';
        var auth = null;
        if (it.srcSrv > 0 || it.dstSrv > 0){
          var _srvId = (it.srcSrv > 0) ? it.srcSrv : it.dstSrv;
          var _s = _resolveFromPool(_srvId);
          if (_s && _s.host) auth = { host: _s.host, port: _s.port||22, user: _s.user||'root', auth_type: _s.auth_type||'pass', password: _s.password||'', key: _s.key||'', passphrase: _s.passphrase||'' };
        }
        if (!auth && (it.srcHost || it.dstHost)){
          auth = _dmSshConnAuth();
        }
        if (!auth){
          auth = _authOf(it.srcSrv || it.dstSrv || 0);
        }
        var payload = {
          action: 'transfer_audit',
          direction: dir,
          src: srcPath, dst: dstPath,
          host: (auth && auth.host) || '', port: (auth && auth.port) || 22,
          user: (auth && auth.user) || 'root',
          auth_type: (auth && auth.auth_type) || 'pass',
          password: (auth && auth.password) || '',
          key: (auth && auth.key) || '',
          passphrase: (auth && auth.passphrase) || '',
          req_id: 'audit_' + scope + '_' + i + '_' + Date.now()
        };
        window.send(payload, function(res){
          done++;
          if (res && res.status === 'ok' && res.summary){
            var s = res.summary;
            agg.new += (s.new||0); agg.update += (s.update||0); agg.delete += (s.delete||0);
            agg.skip += (s.skip||0); agg.dir += (s.dir||0);
            agg.total += (s.total||0);
            if (res.bidirectional) syncAgg = res.bidirectional;
            (res.changes || []).forEach(function(c){ agg.files.push(c); });
            onLog('✓ [' + (i+1) + '/' + all + '] ' + srcPath + ' -> ' + dstPath + ' : 新增' + (s.new||0) + ' 更新' + (s.update||0) + ' 跳过' + (s.skip||0), 'ok');
          } else {
            failed.push({ it: it, msg: (res && res.msg) || '审计失败' });
            onLog('✗ [' + (i+1) + '/' + all + '] 审计失败: ' + ((res && res.msg) || ''), 'err');
          }
          if (done >= all.length){ finishAudit(); }
        });
      });
      function finishAudit(){
        if (btn){ btn.disabled = false; btn.textContent = '🔍 审计'; }
        _showAuditResult(agg, failed, syncAgg);
      }
    };

    // -- 审计结果面板 (差异清单) --
    // v4.41.0 P3-1 · 面板新增「✅ 确认并传输」: 审计通过后直接复用 _startTransfer 发起真实传输
    // v4.41.0 P3-8 · 面板新增「💾 导出报告」: 生成 CSV/HTML 差异清单下载
    // v4.41.0 P3-7 · sync 双向审计: 传 syncAgg {summary_up, summary_down, changes_up, changes_down, conflicts}
    function _showAuditResult(agg, failed, syncAgg){
      var overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:99999;display:flex;align-items:center;justify-content:center';
      var box = document.createElement('div');
      box.style.cssText = 'background:var(--bg1,#1e1e28);border:1px solid var(--border,#333);border-radius:10px;width:min(880px,94vw);max-height:86vh;display:flex;flex-direction:column;overflow:hidden';
      var head = document.createElement('div');
      head.style.cssText = 'padding:10px 14px;border-bottom:1px solid var(--border,#333);display:flex;align-items:center;gap:8px;font-weight:600';
      head.innerHTML = '<span style="color:var(--cyan)">🔍 传输审计结果</span>' +
        '<span style="color:var(--text3);font-size:12px">dry-run · 不实际传输</span>' +
        '<span style="flex:1"></span>' +
        '<button class="audit-export" style="padding:2px 10px;font-size:12px" title="导出差异清单 CSV">💾 导出报告</button>' +
        '<button class="audit-go" style="padding:2px 10px;font-size:12px;background:var(--green);color:#000" title="关闭面板并按审计结果开始真实传输">✅ 确认并传输</button>' +
        '<button class="audit-close" style="padding:2px 10px;font-size:12px">✕ 关闭</button>';
      box.appendChild(head);
      var body = document.createElement('div');
      body.style.cssText = 'flex:1;min-height:0;overflow:auto;padding:10px 14px;font-family:monospace;font-size:12px';
      var lines = [];
      lines.push('<div style="margin-bottom:8px;font-weight:600">📊 汇总: ' +
        '新增 <span style="color:var(--green)">' + agg.new + '</span> · ' +
        '更新 <span style="color:var(--orange)">' + agg.update + '</span> · ' +
        '删除 <span style="color:var(--red)">' + agg.delete + '</span> · ' +
        '跳过 <span style="color:var(--text3)">' + agg.skip + '</span> · ' +
        '目录 <span style="color:var(--text3)">' + agg.dir + '</span> · ' +
        '共 <span style="color:var(--cyan)">' + agg.total + '</span> 项</div>');
      // v4.41.0 P3-7 · sync 双向审计视图: 源→目标 / 目标→源 + 冲突高亮
      if (syncAgg && (syncAgg.summary_up || syncAgg.summary_down)){
        var su = syncAgg.summary_up || {}, sd = syncAgg.summary_down || {};
        lines.push('<div style="margin-bottom:6px;padding:6px 8px;background:rgba(120,120,255,.08);border:1px solid rgba(120,120,255,.25);border-radius:6px">' +
          '<div style="font-weight:600;color:var(--cyan)">⟳ 双向审计 (sync)</div>' +
          '<div>源→目标: 新增 <span style="color:var(--green)">' + (su.new||0) + '</span> · 更新 <span style="color:var(--orange)">' + (su.update||0) + '</span> · 跳过 <span style="color:var(--text3)">' + (su.skip||0) + '</span></div>' +
          '<div>目标→源: 新增 <span style="color:var(--green)">' + (sd.new||0) + '</span> · 更新 <span style="color:var(--orange)">' + (sd.update||0) + '</span> · 跳过 <span style="color:var(--text3)">' + (sd.skip||0) + '</span></div>' +
          (syncAgg.conflicts && syncAgg.conflicts.length ?
            '<div style="margin-top:4px;color:var(--red);font-weight:600">⚡ 冲突 ' + syncAgg.conflicts.length + ' 项 (两侧都修改):</div>' +
            syncAgg.conflicts.slice(0, 50).map(function(c){
              return '<div style="color:var(--red);margin-left:8px">⚡ ' + _esc(c.path) + ' <span style="color:var(--text3)">(源→目标:' + c.up + ' · 目标→源:' + c.down + ')</span></div>';
            }).join('') +
            (syncAgg.conflicts.length > 50 ? '<div style="color:var(--text3)">… 其余 ' + (syncAgg.conflicts.length - 50) + ' 项省略</div>' : '')
          : '') +
          '</div>');
      }
      if (!agg.files.length && !failed.length && !syncAgg){
        lines.push('<div style="color:var(--text3)">✓ 无差异, 源与目标完全一致</div>');
      }
      var MAX = 300;
      var shown = 0;
      agg.files.forEach(function(c){
        if (shown >= MAX) return;
        shown++;
        var icon = c.action === 'new' ? '🆕' : (c.action === 'update' ? '✏️' : (c.action === 'delete' ? '🗑' : '📁'));
        var color = c.action === 'new' ? 'var(--green)' : (c.action === 'update' ? 'var(--orange)' : 'var(--text3)');
        lines.push('<div style="color:' + color + '">' + icon + ' ' + _esc(c.action) + '  ' + _esc(c.path) + '</div>');
      });
      if (agg.files.length > MAX) lines.push('<div style="color:var(--text3)">… 其余 ' + (agg.files.length - MAX) + ' 项省略</div>');
      failed.forEach(function(f){
        lines.push('<div style="color:var(--red)">✗ ' + _esc(f.it.src) + ' -> ' + _esc(f.it.dst) + ': ' + _esc(f.msg) + '</div>');
      });
      body.innerHTML = lines.join('');
      box.appendChild(body);
      overlay.appendChild(box);
      document.body.appendChild(overlay);
      overlay.onclick = function(e){ if (e.target === overlay) overlay.remove(); };
      box.querySelector('.audit-close').onclick = function(){ overlay.remove(); };
      // v4.41.0 P3-1 · ✅ 确认并传输: 关面板 + 直接开始真实传输 (复用审计时的同一批待传项)
      var goBtn = box.querySelector('.audit-go');
      if (goBtn) goBtn.onclick = function(){
        overlay.remove();
        _startTransfer();
      };
      // v4.41.0 P3-8 · 💾 导出报告: 生成 CSV (含汇总+逐项差异) 并下载
      var expBtn = box.querySelector('.audit-export');
      if (expBtn) expBtn.onclick = function(){
        try {
          var esc = function(s){ return '"' + String(s==null?'':s).replace(/"/g,'""') + '"'; };
          var csv = ['\ufeff传输审计报告'];
          csv.push('生成时间,' + new Date().toLocaleString());
          csv.push('汇总,新增=' + agg.new + ',更新=' + agg.update + ',删除=' + agg.delete + ',跳过=' + agg.skip + ',目录=' + agg.dir + ',共=' + agg.total + ' 项');
          csv.push('');
          csv.push('动作,路径,大小(B),修改时间');
          agg.files.forEach(function(c){
            csv.push(esc(c.action) + ',' + esc(c.path) + ',' + (c.size||0) + ',' + (c.mtime||''));
          });
          failed.forEach(function(f){
            csv.push(esc('FAIL'), esc(f.it.src + ' -> ' + f.it.dst), 0, esc(f.msg));
          });
          var blob = new Blob([csv.join('\r\n')], { type: 'text/csv;charset=utf-8' });
          var a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = 'transfer_audit_' + new Date().toISOString().slice(0,19).replace(/[:T]/g,'-') + '.csv';
          document.body.appendChild(a); a.click();
          setTimeout(function(){ URL.revokeObjectURL(a.href); try{ document.body.removeChild(a); }catch(_){} }, 500);
          onLog('💾 审计报告已导出 CSV (' + (agg.files.length + failed.length) + ' 行差异)', 'ok');
        } catch(e){
          onLog('✗ 导出失败: ' + e, 'err');
        }
      };
      onLog('🔍 审计完成: 新增' + agg.new + ' 更新' + agg.update + ' 跳过' + agg.skip + (failed.length ? ' 失败' + failed.length : ''), failed.length ? 'err' : 'ok');
    }

    function _startTransfer(){
      if (!st.items.length){ onLog('⚠ 传输项为空', 'warn'); return; }
      var pending = st.items.filter(function(it){ return it.status === 'pending' || it.status === 'retry' || it.status === 'err'; });
      if (!pending.length){ onLog('⚠ 无待传项 (全部已完成)', 'warn'); return; }
      onLog('▶ 开始传输 ' + pending.length + ' 项 ...', 'info');
      pending.forEach(function(it){ it.status = 'running'; });
      _saveItems(scope, st.items);
      _renderItems();
      // v4.38.34 · 逐条传输: 后端 handle_rsync 只收单条 src/dst + host 凭据
      //   每项按其 srcSrv/dstSrv 解析方向与目标服务器, sync 方向跑两遍 (up + down)
      var idx = 0, okN = 0, errN = 0;
      var startBtn = midCell.querySelector('.tri-start');
      var abortBtn = midCell.querySelector('.tri-abort');
      if (startBtn) startBtn.disabled = true;
      // v4.41.0 P3-2 · 传输期间启用中止按钮
      if (abortBtn){ abortBtn.disabled = false; abortBtn.title = '中止当前传输'; }
      function _runOne(it, dirOverride, cb, pathSwap){
        // v4.38.34 · 方向解析:
        //   DM (dmSshSource): 源=SSH 远端(扫描主机) -> 默认 down, host=dm 表单
        //   普通模式: src 带 "N:" 前缀 -> down; 否则 up
        //   pathSwap=true (sync 第二遍): 交换 src/dst
        var m = /^(-?\d+):(.*)$/.exec(it.src || '');
        // v4.38.35 · 方向按项的远端标记推导: src远端->down / dst远端->up / 双远端走 st.direction
        // v4.40.0 P1 · 远端存储: srcCloud/dstCloud 视为远端
        var _srcRem = !!m || (it.srcSrv > 0) || !!it.srcHost || !!it.srcCloud;
        var _dstRem = /^(-?\d+):/.test(it.dst || '') || (it.dstSrv > 0) || !!it.dstHost || !!it.dstCloud;
        var dir = dirOverride || ((_srcRem && !_dstRem) ? 'down' : ((_dstRem && !_srcRem) ? 'up' : st.direction));
        // v4.38.41 · 双本机 (src/dst 都本机) -> direction='local', 不走 SSH
        //   避免 rsync src root@127.0.0.1:dst 触发 ssh_askpass 错误
        //   sync 第二遍 pathSwap 也走 local (双本机 sync 两端都是本机)
        // v4.40.0 P1 · 含 cloud 的项不做双本机转换 (cloud 是远端, 走下载/上传)
        if (!_srcRem && !_dstRem && !it.srcCloud && !it.dstCloud && (dir === 'up' || dir === 'down' || dir === 'same' || dir === 'sync')){
          dir = 'local';
        }
        // v4.38.35 · 后端 v4.38.38 起支持 cross(双远端 SSH 互传):
        //   same(双本机)->up  (本地 -> 127.0.0.1:dst)
        //   cross(双远端)->cross 保留(后端 SSH 到远端执行本地 rsync, src/dst 都远端真实路径)
        //   双远端但 dst 是本机 DM 挂载点(/var/lib/fonriv_mounts/) -> 仍走 down(本机接收),
        //     后端会检测只读挂载并明确报错
        if (dir === 'same') dir = 'up';
        else if (dir === 'cross'){
          // dst 是本机 DM 挂载点路径 -> 走 down (本机接收), 后端检测只读会明确报错
          if (/^\/var\/lib\/fonriv_mounts\//.test(it.dst || '')){
            dir = 'down';
          } else {
            dir = 'cross';  // 保留, 后端 SSH 远端执行
          }
        }
        var srcPath = m ? m[2] : it.src;
        var dm2 = /^(-?\d+):(.*)$/.exec(it.dst || '');
        var dstPath = dm2 ? dm2[2] : it.dst;
        if (pathSwap){ var _t = srcPath; srcPath = dstPath; dstPath = _t; }
        // v4.38.34 · 目录传输加尾斜杠: rsync "src/ dst/" = 内容同步, 避免套娃 (dst/dir_name/)
        if ((it.type === 'dir') && srcPath && srcPath.slice(-1) !== '/') srcPath += '/';
        if ((it.type === 'dir') && dstPath && dstPath.slice(-1) !== '/') dstPath += '/';
        var auth;
        // v4.38.35 · UniPane: 按项的远端标记取凭据
        //   srcSrv/dstSrv>0 -> SrvPool; srcHost/dstHost (df) -> DM 主机凭据; 都无 -> 本机
        if (it.srcSrv > 0 || it.dstSrv > 0){
          var _srvId = (it.srcSrv > 0) ? it.srcSrv : it.dstSrv;
          var _s = _resolveFromPool(_srvId);
          if (_s && _s.host){
            auth = { host: _s.host, port: _s.port||22, user: _s.user||'root', auth_type: _s.auth_type||'pass', password: _s.password||'', key: _s.key||'', passphrase: _s.passphrase||'' };
          }
        }
        if (!auth && (it.srcHost || it.dstHost)){
          auth = _dmSshConnAuth();   // df 挂载/DM 扫描主机
        }
        if (!auth){
          auth = _authOf(it.srcSrv || it.dstSrv || 0);   // 本机 -> 127.0.0.1 + 表单凭据
        }
        if (!auth || !auth.host){
          // v4.38.41 · local(双本机) 不需要 SSH 凭据
          // v4.40.0 P1 · ☁ 远端存储项也不要求 SSH 凭据 (走 remote_download/upload)
          if (dir !== 'local' && !it.srcCloud && !it.dstCloud){ it.status = 'err'; onLog('✗ 无法解析凭据: ' + it.src, 'err'); cb(false); return; }
          auth = { host: '', port: 0, user: '', auth_type: 'pass', password: '', key: '', passphrase: '' };
        }
        onLog('▶ [' + (idx+1) + '/' + pending.length + '] ' + (dir==='down'?'⬇':(dir==='cross'?'⇄':(dir==='local'?'⇂':'⬆'))) + ' ' + srcPath + ' -> ' + (dir==='local' ? dstPath : (auth.host + ':' + dstPath)), 'info');
        // v4.40.0 P1 · ☁ 远端存储通路 (remote_download / remote_upload · 不走 SSH rsync)
        if (it.srcCloud || it.dstCloud){
          _runCloud(it, srcPath, dstPath, pathSwap, function(okC){
            cb(okC, dir);
          });
          return;
        }
        if (typeof window.send !== 'function'){ it.status = 'err'; cb(false); return; }
        // v4.38.34 · sync 双向: 加 --update (跳过接收端更新的文件), 避免第二遍覆盖第一遍
        var flags = ['-a', '-v', '-z', '--progress', '--partial'];
        if (st.direction === 'sync') flags.push('--update');
        window.send({
          action: 'rsync',
          direction: dir,
          host: auth.host, port: auth.port, user: auth.user,
          src: srcPath, dst: dstPath,
          flags: flags,
          auth_type: auth.auth_type, password: auth.password, key: auth.key, passphrase: auth.passphrase,
        }, function(d){
          // v4.38.34 · 终态: type:'finish' status:'success'/'error' (v4.38.34 send streamMode 已放行 finish)
          var ok = d && (d.status === 'ok' || d.status === 'success');
          if (!ok) onLog('✗ [' + (idx+1) + '] ' + (d && d.msg || '未知错误'), 'err');
          cb(ok, dir);
        }, true);  // streamMode=true: 接收 log/progress 流
      }
      // v4.40.0 P1 · ☁ 远端存储单条传输 (remote_download / remote_upload)
      //   云->本机: 直接下载到 dstPath; 本机->云: 直接上传 srcPath; 云->云: 下载到 /tmp 再上传
      //   sync 第二遍 pathSwap=true: srcCloud/dstCloud 标记对调
      // v4.41.0 P3-5 · ☁ 整目录传输: 本机<->云 目录走 remote_upload_dir / remote_download_dir
      function _runCloudDir(it, srcPath, dstPath, pathSwap, cbC){
        var srcCid = pathSwap ? (it.dstCloud || '') : (it.srcCloud || '');
        var dstCid = pathSwap ? (it.srcCloud || '') : (it.dstCloud || '');
        var srcC = srcCid ? _getCloudById(srcCid) : null;
        var dstC = dstCid ? _getCloudById(dstCid) : null;
        var _rid = function(c){ return (c && (c.id || c.remote_id)) || 0; };
        var _rkey = function(p){ return String(p || '').replace(/^\/+|\/+$/g, ''); };
        var rid = _rid(srcC || dstC);
        var action = srcC ? 'remote_download_dir' : 'remote_upload_dir';
        var payload = {
          action: action,
          remote_id: rid,
          req_id: 'cldir_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        };
        if (srcC){ payload.remote_dir = _rkey(srcPath); payload.local_dir = dstPath.replace(/\/+$/,''); }
        else { payload.local_dir = srcPath.replace(/\/+$/,''); payload.remote_dir = _rkey(dstPath); }
        onLog('  ↳ ☁ 目录' + (srcC ? '下载' : '上传') + ' ' + _rkey(srcC ? srcPath : dstPath) + ' (' + payload.local_dir + ')', 'info');
        openWs(function(wsC4){
          var hC4 = function(e){
            var dC4;
            try { dC4 = JSON.parse(e.data); } catch(_){ return; }
            if (!dC4 || dC4.type !== 'remote_dir_result' || dC4.req_id !== payload.req_id) return;
            try { wsC4.removeEventListener('message', hC4); } catch(_){}
            if (dC4.status === 'ok'){
              onLog('✓ ☁ 目录传输完成: ' + dC4.ok + ' 成功 / ' + dC4.fail + ' 失败', dC4.fail ? 'err' : 'ok');
              cbC(dC4.fail === 0);
            } else {
              onLog('✗ ☁ 目录传输失败: ' + (dC4.msg || ''), 'err');
              cbC(false);
            }
          };
          wsC4.addEventListener('message', hC4);
          wsC4.send(JSON.stringify(payload));
        });
      }
      function _runCloud(it, srcPath, dstPath, pathSwap, cbC){
        // v4.41.0 P3-5 · ☁ 整目录传输支持 (本机<->云; 云->云目录暂不支持)
        if (it.type === 'dir'){
          var srcCid = pathSwap ? (it.dstCloud || '') : (it.srcCloud || '');
          var dstCid = pathSwap ? (it.srcCloud || '') : (it.dstCloud || '');
          if (srcCid && dstCid){
            onLog('✗ ☁ 云->云整目录传输暂不支持 (请先下载到本机再上传): ' + srcPath, 'err');
            cbC(false); return;
          }
          _runCloudDir(it, srcPath, dstPath, pathSwap, cbC);
          return;
        }
        var srcCid = pathSwap ? (it.dstCloud || '') : (it.srcCloud || '');
        var dstCid = pathSwap ? (it.srcCloud || '') : (it.dstCloud || '');
        var srcC = srcCid ? _getCloudById(srcCid) : null;
        var dstC = dstCid ? _getCloudById(dstCid) : null;
        var _rid = function(c){ return (c && (c.id || c.remote_id)) || 0; };
        var _rkey = function(p){ return String(p || '').replace(/^\//, ''); };
        // 下载阶段 (srcCid): tmpP 为 null 时直接落到 dstPath (云->本机)
        function _dl(tmpOnly, next){
          if (!srcCid){ next(null); return; }
          var rid = _rid(srcC);
          if (!rid){ onLog('✗ 无法解析云配置 remote_id: ' + srcCid, 'err'); cbC(false); return; }
          var reqId = 'cldl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
          var localP = tmpOnly
            ? ('/tmp/fonriv_cloud_dl/' + String(srcC.name || srcC.label || ('r' + rid)).replace(/[\/\\]/g, '_') + '/' + _rkey(srcPath))
            : dstPath;
          onLog('  ↳ ☁ 下载 ' + (srcC.name || srcC.label || ('r#' + rid)) + ':' + _rkey(srcPath) + ' -> ' + localP, 'info');
          openWs(function(wsC2){
            var hC2 = function(e){
              var dC2;
              try { dC2 = JSON.parse(e.data); } catch(_){ return; }
              if (!dC2 || dC2.type !== 'remote_download_result' || dC2.req_id !== reqId) return;
              try { wsC2.removeEventListener('message', hC2); } catch(_){}
              if (dC2.status === 'ok'){ next(localP); }
              else { onLog('✗ ☁ 下载失败: ' + (dC2.msg || dC2.error || ''), 'err'); cbC(false); }
            };
            wsC2.addEventListener('message', hC2);
            wsC2.send(JSON.stringify({
              action: 'remote_download', remote_id: rid,
              remote_key: _rkey(srcPath), local_path: localP, req_id: reqId,
            }));
          });
        }
        // 上传阶段 (dstCid): 上传 localSrc 到远端 dstPath
        function _up(localSrc, next){
          if (!dstCid){ next(null); return; }
          var rid = _rid(dstC);
          if (!rid){ onLog('✗ 无法解析云配置 remote_id: ' + dstCid, 'err'); cbC(false); return; }
          var reqId = 'clup_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
          onLog('  ↳ ☁ 上传 ' + localSrc + ' -> ' + (dstC.name || dstC.label || ('r#' + rid)) + ':' + _rkey(dstPath), 'info');
          openWs(function(wsC3){
            var hC3 = function(e){
              var dC3;
              try { dC3 = JSON.parse(e.data); } catch(_){ return; }
              if (!dC3 || dC3.type !== 'result' || dC3.req_id !== reqId) return;
              try { wsC3.removeEventListener('message', hC3); } catch(_){}
              if (dC3.status === 'ok'){ next(null); }
              else { onLog('✗ ☁ 上传失败: ' + (dC3.msg || ''), 'err'); cbC(false); }
            };
            wsC3.addEventListener('message', hC3);
            wsC3.send(JSON.stringify({
              action: 'remote_upload', remote_id: rid,
              local_path: localSrc, remote_key: _rkey(dstPath), req_id: reqId,
            }));
          });
        }
        if (srcCid && dstCid){
          // 云->云: 下载到 /tmp 再上传
          _dl(true, function(tmpP){
            if (!tmpP){ cbC(false); return; }
            _up(tmpP, function(){ cbC(true); });
          });
          return;
        }
        if (srcCid){
          // 云->本机: 直接落到 dstPath
          _dl(false, function(finalP){
            onLog('✓ ☁ 下载完成: ' + finalP, 'ok');
            cbC(true);
          });
          return;
        }
        // 本机->云: 直接上传 srcPath
        _up(srcPath, function(){
          onLog('✓ ☁ 上传完成: ' + _rkey(dstPath), 'ok');
          cbC(true);
        });
      }
      function _next(){
        if (idx >= pending.length){
          if (startBtn) startBtn.disabled = false;
          if (abortBtn){ abortBtn.disabled = true; abortBtn.title = '中止'; }
          _saveItems(scope, st.items);
          _renderItems();
          onLog((errN ? '✗ 传输结束: ' + okN + ' 成功 / ' + errN + ' 失败' : '✓ 传输完成 (' + okN + ' 项)'), errN ? 'err' : 'ok');
          // v5.17.0 · 传输后刷新两侧栏 (含 token 缓存失效 + 延迟补刷)
          //   旧实现 DM 页传输完不刷新, 用户需手点 🔄; 目标区(右栏)尤其明显
          try {
            var _changed = (pending || []).map(function(x){ return x.dst || x.src; }).filter(Boolean);
            if (typeof window.refreshAllPanes === 'function'){
              window.refreshAllPanes(_changed);
            } else {
              try { if (st.sourcePane && st.sourcePane.load) st.sourcePane.load(st.sourcePane.getCwd()); } catch(_){}
              try { if (st.targetPane && st.targetPane.load) st.targetPane.load(st.targetPane.getCwd()); } catch(_){}
            }
          } catch(e2){ console.warn('[DM] post-transfer refresh', e2); }
          return;
        }
        var it = pending[idx];
        // v4.41.0 P3-2 · 用户已中止的项直接跳过 (不发起传输)
        if (it.status === 'abort'){
          idx++; _saveItems(scope, st.items); _renderItems(); _next();
          return;
        }
        var isSync = (st.direction === 'sync');
        _runOne(it, null, function(ok, firstDir){
          // v4.41.0 P3-2 · 中止的项保持 abort 状态, 不覆盖成 err
          var aborted = (it.status === 'abort');
          if (isSync && ok){
            // sync 第二遍: 反方向 + 交换路径 (双向各同步一次, --update 保护较新文件)
            // v4.38.41 · local(双本机) 第二遍也是 local, 不反转
            var secondDir = (firstDir === 'local') ? 'local' : (firstDir === 'up' ? 'down' : 'up');
            _runOne(it, secondDir, function(ok2){
              it.status = aborted ? 'abort' : ((ok && ok2) ? 'ok' : 'err');
              if (!aborted){ if (ok && ok2) okN++; else errN++; }
              idx++; _saveItems(scope, st.items); _renderItems(); _next();
            }, true);
          } else {
            it.status = aborted ? 'abort' : (ok ? 'ok' : 'err');
            if (!aborted){ if (ok) okN++; else errN++; }
            idx++; _saveItems(scope, st.items); _renderItems(); _next();
          }
        });
      }
      _next();
    }

    // -- 拖拽 grip --
    // v4.38.36 · 线性化重写 (对齐文件传输页 tp-grip 方案):
    //   拖拽期间以 px 直算 (dx 1:1 对应列宽变化, 手感线性), mouseup 时再回写 fr 比例持久化
    var _triDrag = null;
    (function _initGrips(){
      var grips = grid.querySelectorAll('.tri-grip');
      grips.forEach(function(grip){ grip.style.display = 'none'; });  // v6.16.12 · 取消左右拖拽条
      grips.forEach(function(grip){
        grip.addEventListener('mousedown', function(ev){
          ev.preventDefault();
          // 抓取拖拽瞬间的各列实际像素 (computed style 已把 fr 算成 px)
          var gridW = grid.getBoundingClientRect().width;
          var cs = getComputedStyle(grid).gridTemplateColumns;
          var colsPx = cs.split(' ').map(function(s){ var v = parseFloat(s); return isNaN(v) ? 0 : v; });
          _triDrag = { startX: ev.clientX, side: grip.getAttribute('data-side'), startCols: colsPx.slice(), gridW: gridW };
          document.body.style.cursor = 'col-resize';
          ev.stopPropagation();
        });
      });
      document.addEventListener('mousemove', function(e){
        if (!_triDrag) return;
        var dx = e.clientX - _triDrag.startX;
        var c = _triDrag.startCols.slice();  // [left, 6, mid, 6, right]
        var MIN = 80;  // 最小列宽
        if (_triDrag.side === 'left'){
          // 拖左 grip: left 增减 dx, mid 反向, right 不变
          var maxLeft = _triDrag.gridW - c[4] - 12 - MIN;
          if (c[0] + dx > maxLeft) dx = maxLeft - c[0];
          if (c[0] + dx < MIN) dx = MIN - c[0];
          c[0] += dx; c[2] -= dx;
        } else {
          // 拖右 grip: right 增减 dx, mid 反向, left 不变
          var maxRight = _triDrag.gridW - c[0] - 12 - MIN;
          if (c[4] - dx > maxRight) dx = c[4] - maxRight;
          if (c[4] - dx < MIN) dx = c[4] - MIN;
          c[2] += dx; c[4] -= dx;
        }
        grid.style.gridTemplateColumns = c[0].toFixed(1) + 'px ' + c[1] + 'px ' + c[2].toFixed(1) + 'px ' + c[3] + 'px ' + c[4].toFixed(1) + 'px';
      });
      document.addEventListener('mouseup', function(){
        if (!_triDrag) return;
        // px -> fr 回写持久化 (总比例 3.2 = 1+1.2+1 初始)
        var cs = grid.style.gridTemplateColumns.split(' ');
        var pxL = parseFloat(cs[0]) || 0, pxM = parseFloat(cs[2]) || 0, pxR = parseFloat(cs[4]) || 0;
        var total = pxL + pxM + pxR;
        if (total > 0){
          st.widths = { left: +(pxL/total*3.2).toFixed(3), mid: +(pxM/total*3.2).toFixed(3), right: +(pxR/total*3.2).toFixed(3) };
          try { localStorage.setItem('tri_widths_' + scope, JSON.stringify(st.widths)); } catch(e){}
          // 恢复 fr 显示 (消除 px 累积误差)
          grid.style.gridTemplateColumns = '1.2fr 0px 1.5fr 0px 1.2fr';  // v6.16.12 · 取消拖拽(固定自适应)
        }
        _triDrag = null;
        document.body.style.cursor = '';
      });
      // 恢复宽度
      try {
        var saved = localStorage.getItem('tri_widths_' + scope);
        if (saved){
          var w = JSON.parse(saved);
          if (w.left && w.mid && w.right){
            grid.style.gridTemplateColumns = '1.2fr 0px 1.5fr 0px 1.2fr';  // v6.16.12 · 不套用历史比例
            st.widths = w;
          }
        }
      } catch(e){}
    })();

    // -- 公开 API --
    var ret = {
      el: wrap,
      scope: scope,
      setDirection: setDirection,  // v4.38.26 · 公共方向切换
      setSrvList: function(list){
        srvList = list || [];
        _refreshSrvSel();
      },
      // v4.39.3 · 外部刷新 df 下拉分组 (shares 挂载/卸载后调用)
      refreshServers: function(){
        _refreshSrvSel();
      },
      setSourceFromExternal: function(path){
        if (st.sourcePane){
          st.sourcePane.load(path);
          onLog('外部同步: 源栏已跳转到 ' + path, 'info');
        }
      },
      // v4.38.35 · setSideDesc: 外部设置侧来源描述符 (df 表 ⬅➡ 按钮用)
      setSideDesc: function(sideKey, desc, initialPath){
        if (sideKey === 'source'){ st.sourceDesc = desc; st.sourceSrvId = (desc.kind === 'ssh') ? desc.srvId : 0; }
        else { st.targetDesc = desc; st.targetSrvId = (desc.kind === 'ssh') ? desc.srvId : 0; }
        _refreshSrvSel();
        _updateDirFromDesc();
        var pane = (sideKey === 'source') ? st.sourcePane : st.targetPane;
        if (pane && pane.setDesc) pane.setDesc(desc, initialPath || '/');
        onLog('↔ ' + (sideKey === 'source' ? '源' : '目标') + '来源已设: ' + _srcLabel(desc), 'info');
      },
      // v4.38.28 · setPath: 外部调用跳到指定 side (local/remote) 的 path
      setPath: function(side, path){
        var pane = (side === 'remote' || side === 'target') ? st.targetPane : st.sourcePane;
        if (pane && typeof pane.load === 'function'){
          pane.load(path);
          onLog('外部同步: ' + side + ' 栏已跳转到 ' + path, 'info');
        }
      },
      getState: function(){ return st; },
      getItems: function(){ return st.items.slice(); },
      setItems: function(items){
        st.items = items || [];
        _saveItems(scope, st.items);
        _renderItems();
      },
      addItem: function(src, dst, opts){
        st.items.push({
          id: 'ti_' + Date.now() + '_' + Math.random().toString(36).slice(2,6),
          src: src, dst: dst,
          type: (opts && opts.type) || 'item',
          status: 'pending',
          srcSrv: st.sourceSrvId, dstSrv: st.targetSrvId,
          ts: Date.now(),
        });
        _saveItems(scope, st.items);
        _renderItems();
      },
      destroy: function(){
        try { st.sourcePane && st.sourcePane.destroy(); } catch(_){}
        try { st.targetPane && st.targetPane.destroy(); } catch(_){}
        try { hostEl.removeChild(wrap); } catch(_){}
      },
    };
    // v4.38.26 · 注册到 window._triInstances[scope], setDirection 外部可调
    try {
      if (!window._triInstances) window._triInstances = {};
      // 同 scope 已有实例,先 destroy 旧实例
      if (window._triInstances[scope]) {
        try { window._triInstances[scope].destroy(); } catch(_){}
      }
      window._triInstances[scope] = ret;
    } catch(_){}

    return ret;
  }

  window.TransferTri = {
    create: create,
    // v4.38.28 · 静态 setPath: 通过 scope 找到实例, 跳到指定 side 的 path
    setPath: function(scope, side, path){
      try {
        var inst = window._triInstances && window._triInstances[scope];
        if (inst && typeof inst.setPath === 'function'){
          inst.setPath(side, path);
          return true;
        }
      } catch(e){ console.warn('[TransferTri.setPath]', e); }
      return false;
    },
  };
})();
