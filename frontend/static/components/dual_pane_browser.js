/* ============================================================================
 * dual_pane_browser.js · v4.38.21
 * 文件浏览助手库（v4.38.21 重构）：
 *  - 暴露 window.FileBrowser 作为可复用 API
 *  - createPane(opts) 返回一个 pane 元素 + 控制句柄
 *  - 与 tri_pane_transfer.js 配合（被三列组件调用）
 *  - 保留独立运行能力（v4.38.20 行为：构建 #dualPaneBrowser 容器）
 * ========================================================================== */
(function(){
  'use strict';

  // ==========================================================================
  // 工具
  // ==========================================================================
  function _esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function _fmtSize(b){
    if (!b || b < 0) return '';
    var u = ['B','KB','MB','GB','TB']; var i = 0;
    while (b >= 1024 && i < u.length-1){ b /= 1024; i++; }
    return b.toFixed(b<10&&i>0?1:0) + ' ' + u[i];
  }
  // v5.0.0 · 直连 WS 请求助手 (复用全局 rpcDirAction, 带 socket 重试)
  function rpcRemote(action, data, timeoutMs){
    if (typeof window.rpcDirAction === 'function') return window.rpcDirAction(action, data, timeoutMs || 15000);
    return Promise.resolve({ status: 'error', msg: 'rpcDirAction 不可用' });
  }

  function _remoteAuth(){
    if (typeof getSrvAuth === 'function') return getSrvAuth();
    return { host:'', port:'22', user:'root', auth_type:'pass', password:'', key:'', passphrase:'' };
  }

  // ==========================================================================
  // 单栏创建 · 返回 {pane, load, render, addTo, setStatus, getState}
  // ==========================================================================
  function createPane(opts){
    opts = opts || {};
    var side      = opts.side      || 'local';
    var title     = opts.title     || (side === 'local' ? '📁 本地文件' : '🌐 远端文件');
    var onAdd     = opts.onAdd     || null;  // function(path, entry)
    var onAddedBatch = opts.onAddedBatch || null;  // function(paths[])
    var showSelMode = opts.showSelMode !== false;  // 默认 true
    var initialPath = opts.initialPath || '/';
    var emptyHint = opts.emptyHint || null;  // function() → HTML string（远端未连时显示）
    var onCwdChange = opts.onCwdChange || null;  // v4.38.21 rev · function(newCwd) cwd 变更回调
    var onTargetSelect = opts.onTargetSelect || null;  // v4.38.21 rev · 远端栏：用户点目录设为目标
    var onFileOpen = opts.onFileOpen || null;   // v4.66.0 · 单击文件 → 预览回调(path, entry); 未设则退回 addTo
    var onDirOpen = opts.onDirOpen || null;     // v4.66.0 · 进入目录前的回调(path)
    // v4.96.0 · cross 远端-远端: 每栏独立凭据 (覆盖全局 getSrvAuth)
    var authOverride = opts.authOverride || null;   // function() -> {host,port,user,auth_type,password,key,passphrase}
    var onDropTransfer = opts.onDropTransfer || null;  // v4.93.0 · A1 跨栏拖拽: function(srcPath, srcSide, targetSide)

    var st = {
      path: initialPath,
      cwd: initialPath,
      entries: [],
      loading: false,
      connected: side === 'local',
      selectMode: false,
      viewMode: (function(){ try { return localStorage.getItem('dpb_view_' + side) || 'list'; } catch(e){ return 'list'; } })(),  // v4.93.0 · list|icon|detail|gallery
      authOverride: authOverride,  // v4.96.0 · 本栏专属凭据 (cross 双远端)
    };
    var api = null;  // v4.58.0 · 右键菜单需要 pane 句柄 (load/addTo/isCloudFs)

    var pane = document.createElement('div');
    pane.className = 'dpb-pane';
    pane.setAttribute('data-side', side);
    pane.style.cssText = 'display:flex;flex-direction:column;border:1px solid var(--border);border-radius:8px;background:var(--bg2);overflow:hidden;min-width:0';

    pane.innerHTML =
      '<div style="padding:6px 10px;background:var(--bg3);border-bottom:1px solid var(--border);display:flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:var(--text2)">' +
        '<span>'+title+'</span>' +
        '<span style="flex:1"></span>' +
        (side === 'remote'
          ? '<button class="btn btn-sm dpb-conn" style="padding:2px 8px;font-size:11px">🔗 连接</button>'
          : (showSelMode
              ? '<button class="btn btn-sm dpb-selmode" style="padding:2px 8px;font-size:11px;background:var(--bg3);color:var(--cyan);border:1px solid var(--cyan)" title="切换到选择模式：勾选文件/目录后批量加入">☐ 选择</button>'
              : '')) +
        '<button class="btn btn-sm dpb-up"   style="padding:2px 8px;font-size:11px" title="上级目录">⬆</button>' +
        '<button class="btn btn-sm dpb-reload" style="padding:2px 8px;font-size:11px" title="刷新">🔄</button>' +
      '</div>' +
      '<div class="dpb-pathbar" style="padding:4px 10px;background:var(--bg);border-bottom:1px solid var(--border);display:flex;align-items:center;gap:4px;font-size:11px">' +
        '<span style="color:var(--text3);white-space:nowrap">路径</span>' +
        '<input type="text" class="dpb-path-input" style="flex:1;background:var(--bg3);border:1px solid var(--border);border-radius:4px;color:var(--cyan);font-family:monospace;font-size:11px;padding:3px 6px;min-width:0" value="'+_esc(initialPath)+'" />' +
        '<button class="btn btn-sm dpb-go" style="padding:2px 8px;font-size:11px">前往</button>' +
        // v4.93.0 · A1 四视图切换 (v4.96.0 放大+文字标签, 提高可发现性)
        '<span style="font-size:10px;color:var(--text3);flex:0 0 auto">视图</span>' +
        '<span class="dpb-viewmodes" style="display:inline-flex;gap:2px;background:var(--bg3);border:1px solid var(--border);border-radius:6px;padding:2px;flex:0 0 auto">' +
          ['list:☰:列表','icon:▦:图标','detail:📋:详情','gallery:🖼:相册'].map(function(v){
            var p = v.split(':');
            return '<button class="btn btn-sm dpb-vm dpb-vm-'+p[0]+'" data-vm="'+p[0]+'" title="'+p[2]+'视图 (点击切换)" style="padding:3px 8px;font-size:13px;border:none;background:'+(st.viewMode===p[0]?'var(--cyan)':'transparent')+';color:'+(st.viewMode===p[0]?'#000':'var(--text2)')+';cursor:pointer">'+p[1]+'</button>';
          }).join('') +
        '</span>' +
        // v5.17.0 · 原 ⭐收藏/📁▾收藏夹 收敛到右键菜单 (收藏是低频操作, 不该占工具栏);
        //   位置改放高频目标区操作: 新建目录 / 新建文件
        '<button class="btn btn-sm dpb-mkdir" style="padding:2px 8px;font-size:11px" title="在此目录新建文件夹">📁＋</button>' +
        '<button class="btn btn-sm dpb-mkfile" style="padding:2px 8px;font-size:11px" title="在此目录新建文件">📄＋</button>' +
        '<span class="dpb-favwrap" style="display:none">'+
          '<button class="btn btn-sm dpb-fav" style="padding:2px 8px;font-size:11px" title="收藏当前路径">⭐</button>'+
          '<button class="btn btn-sm dpb-favmenu" style="padding:2px 8px;font-size:11px" title="收藏夹">📁▾</button>'+
          '<div class="dpb-favdrop" style="display:none"></div>'+
        '</span>' +
      '</div>' +
      '<div class="dpb-list" style="flex:1 1 0;overflow:auto;min-height:0;padding:4px;height:0"></div>' +
      '<div class="dpb-status" style="padding:3px 10px;background:var(--bg);border-top:1px solid var(--border);font-size:10px;color:var(--text3);display:flex;align-items:center;gap:6px">' +
        '<span class="dpb-status-text" style="flex:1"></span>' +
        '<span class="dpb-selbar" style="display:none;gap:4px">' +
          '<span class="dpb-selcount" style="color:var(--green);font-weight:600">已选 0 项</span>' +
          '<button class="btn btn-sm dpb-seladd" style="padding:1px 6px;font-size:10px;background:var(--green);color:#fff">➕ 全部加入</button>' +
          '<button class="btn btn-sm dpb-selclr" style="padding:1px 6px;font-size:10px">清空</button>' +
          '<button class="btn btn-sm dpb-seldone" style="padding:1px 6px;font-size:10px">✓ 完成</button>' +
        '</span>' +
      '</div>';

    var pathInput = pane.querySelector('.dpb-path-input');
    var listEl    = pane.querySelector('.dpb-list');
    var statusEl  = pane.querySelector('.dpb-status-text');

    function setStatus(msg, isErr){
      if (!statusEl) return;
      statusEl.textContent = msg || '';
      statusEl.style.color = isErr ? 'var(--red)' : 'var(--text3)';
    }

    function setConnState(connected){
      st.connected = !!connected;
      var btn = pane.querySelector('.dpb-conn');
      if (btn){
        if (connected){ btn.textContent = '✓ 已连接'; btn.style.color = 'var(--green)'; btn.style.borderColor = 'var(--green)'; }
        else { btn.textContent = '🔗 连接'; btn.style.color = ''; btn.style.borderColor = ''; }
      }
    }

    function toggleSelectMode(){
      st.selectMode = !st.selectMode;
      var btn = pane.querySelector('.dpb-selmode');
      if (btn){
        if (st.selectMode){ btn.textContent = '✓ 选择中'; btn.style.background='var(--green)'; btn.style.color='#fff'; btn.style.borderColor='var(--green)'; }
        else { btn.textContent = '☐ 选择'; btn.style.background='var(--bg3)'; btn.style.color='var(--cyan)'; btn.style.borderColor='var(--cyan)'; }
      }
      render();
    }

    function _onItemCheckChange(item){
      var cb = item.querySelector('.dpb-item-check');
      if (cb && cb.checked){
        var checked = pane.querySelectorAll('.dpb-item-check:checked');
        var idx = Array.prototype.indexOf.call(checked, cb);
        var bg = (idx % 2 === 0) ? 'rgba(58,157,93,0.28)' : 'rgba(58,134,213,0.28)';
        item.classList.add('dpb-selected');
        item.style.background = bg;
      } else {
        item.classList.remove('dpb-selected');
        item.style.background = '';
      }
      updateSelbar();
    }

    function updateSelbar(){
      var bar = pane.querySelector('.dpb-selbar');
      var cnt = pane.querySelector('.dpb-selcount');
      var boxes = pane.querySelectorAll('.dpb-item-check:checked');
      if (bar) bar.style.display = (boxes.length > 0 || st.selectMode) ? 'inline-flex' : 'none';
      if (cnt) cnt.textContent = '已选 ' + boxes.length + ' 项';
    }

    function addTo(path, silent){
      if (typeof onAdd === 'function'){
        onAdd(path, null);
      }
      if (!silent){
        setStatus('✓ 已加入: ' + path);
        // 不再 flash textarea
      }
    }

    function addChecked(){
      var checks = pane.querySelectorAll('.dpb-item-check:checked');
      if (!checks.length){ setStatus('⚠ 请先勾选文件/目录', true); return; }
      var added = [];
      checks.forEach(function(c){
        var item = c.closest('.dpb-item');
        var p = item ? item.getAttribute('data-path') : '';
        var t = item ? item.getAttribute('data-type') : '';
        if (p){
          var finalPath = (t === 'dir' ? p + '/' : p);
          if (typeof onAdd === 'function') onAdd(finalPath, null);
          added.push(finalPath);
        }
      });
      if (added.length && typeof onAddedBatch === 'function') onAddedBatch(added);
      setStatus('✓ 已批量加入 ' + added.length + ' 项');
      checks.forEach(function(c){ c.checked = false; });
      pane.querySelectorAll('.dpb-item.dpb-selected').forEach(function(it){ it.classList.remove('dpb-selected'); });
      updateSelbar();
    }

    function clearSel(){
      pane.querySelectorAll('.dpb-item-check').forEach(function(c){ c.checked = false; });
      pane.querySelectorAll('.dpb-item').forEach(function(it){ it.classList.remove('dpb-selected'); });
      updateSelbar();
    }

    function goUp(){
      var cwd = st.cwd || '/';
      if (cwd === '/') return;
      var parts = cwd.replace(/\/$/,'').split('/');
      parts.pop();
      load(parts.join('/') || '/');
    }

    function load(p){
      p = p || '/';
      // v4.64.0 · 收藏高亮
      try {
        var _fl = JSON.parse(localStorage.getItem('dpb_favs_' + side) || '[]');
        var _fb = pane.querySelector('.dpb-fav');
        if (_fb) _fb.style.color = (_fl.indexOf(p) >= 0) ? 'var(--yellow)' : '';
      } catch(e){}
      st.loading = true;
      st.cwd = p;
      st.entries = [];
      // v4.38.23 · req_id 区分请求 · 避免多 pane 互相劫持 dir_result
      st.loadId = (st.loadId || 0) + 1;
      var myLoadId = st.loadId;
      var myReqId = '_dpb_' + side + '_' + myLoadId + '_' + Date.now().toString(36);

      // v4.38.23 · 显式清理旧 handler（避免 listener 累积导致 dir_result 被劫持）
      if (st._activeHandler && st._activeWs){
        try { st._activeWs.removeEventListener('message', st._activeHandler); } catch(_){}
      }
      st._activeHandler = null;
      st._activeWs = null;

      if (pathInput) pathInput.value = p;
      listEl.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text3);font-size:12px">⏳ 加载中...</div>';
      setStatus('加载 '+p+' ...');
      if (typeof onCwdChange === 'function'){
        try { onCwdChange(p); } catch(e){ console.warn('[dpb] onCwdChange', e); }
      }

      if (typeof openWs !== 'function'){
        st.loading = false;
        setStatus('✖ WebSocket 未就绪', true);
        return;
      }
      // v4.96.0 · 改用全局带重试的 rpcDirAction:
      //   旧实现裸 ws.send + 自建 handler, 切 tab / WS 重连期间 socket 被替换 -> 响应丢失,
      //   表现为远端栏永远停在「加载 / ...」且无文件 (用户报的「只能显示 / 且没有文件」根因)
      // v4.40.0 · localFs 模式 (remote pane 浏览本机挂载点/路径 · 走 list_dir · 不走 SSH)
      var useLocalFs = (side === 'remote' && st.localFs) || side === 'local';
      // v4.41.2 · cloudFs 模式 (remote pane 浏览 ☁ 远端存储 · 走 remote_ls · 不走 SSH)
      var useCloudFs = (side === 'remote' && st.cloudFs && st.cloudFs.on);
      var act, payload, isCloudReq = false;
      if (useCloudFs){
        var cPath = (p || '/').replace(/^\/+|\/+$/g, '');  // cwd '/a/b' -> 'a/b'
        act = 'remote_ls';
        payload = { remote_id: st.cloudFs.rid, path: cPath };
        isCloudReq = true;
      } else if (side === 'remote' && !useLocalFs){
        var auth = (st.authOverride && typeof st.authOverride === 'function') ? st.authOverride() : _remoteAuth();
        if (!auth.host){
          st.loading = false;
          setConnState(false);
          render();
          setStatus('⚠ 请先填写远端主机', true);
          return;
        }
        act = 'list_remote_dir';
        payload = { path: p, host: auth.host, port: auth.port, user: auth.user,
                    auth_type: auth.auth_type, password: auth.password, key: auth.key, passphrase: auth.passphrase };
      } else {
        act = 'list_dir';
        payload = { path: p };
      }
      st._activeWs = null;
      st._activeHandler = null;
      var _call = (typeof window.rpcDirAction === 'function')
        ? window.rpcDirAction(act, payload, 20000)
        : Promise.resolve({ status: 'error', msg: 'rpcDirAction 不可用' });
      _call.then(function(d){
        if (myLoadId !== st.loadId) return;   // 已被更新的加载取代
        st.loading = false;
        if (d && (d.status === 'ok' || d.status === 'success')){
          if (isCloudReq){
            var cp2 = String(d.path || p || '').replace(/^\/+|\/+$/g, '');
            st.cwd = '/' + cp2;
            st.entries = (d.entries || []).map(function(en){
              return { name: en.name, type: en.is_dir ? 'dir' : 'file',
                       size: en.size || 0, path: (cp2 ? '/' + cp2 + '/' : '/') + en.name };
            });
          } else {
            st.cwd = d.path || p;
            st.entries = d.entries || [];
          }
          if (side === 'remote'){ setConnState(true); }
          render();
          setStatus(st.entries.length + ' 项 · ' + st.cwd);
        } else {
          if (side === 'remote'){ setConnState(false); }
          render();
          setStatus('✖ ' + ((d && (d.msg || d.message)) || '加载失败'), true);
        }
      });
    }

    // v4.38.23 · 销毁：清理所有 WS handler，防止内存泄漏与劫持
    function destroy(){
      if (st._activeHandler && st._activeWs){
        try { st._activeWs.removeEventListener('message', st._activeHandler); } catch(_){}
      }
      st._activeHandler = null;
      st._activeWs = null;
      st.loading = false;
    }

    // v4.66.0 · 预览模式下标记当前选中文件 (高亮 + 供上层读取)
    function markSelected(p, itemEl){
      st.selectedPath = p;
      try {
        listEl.querySelectorAll('.dpb-item').forEach(function(it){ it.style.outline = ''; });
        if (itemEl) itemEl.style.outline = '1px solid var(--cyan)';
      } catch(_){}
    }
    // v4.66.0 · 双栏互斥高亮清理 (同一时刻只高亮最近点击的文件)
    function clearSelected(){
      st.selectedPath = null;
      try { listEl.querySelectorAll('.dpb-item').forEach(function(it){ it.style.outline = ''; }); } catch(_){}
    }

    function render(){
      if (pathInput) pathInput.value = st.cwd;
      if (side === 'remote' && !st.connected){
        var hint = emptyHint ? emptyHint() : '🌐 远端文件浏览<br><span style="font-size:11px">请先在上方填写远端主机信息，然后点 <b>🔗 连接</b></span>';
        listEl.innerHTML = '<div style="padding:30px 20px;text-align:center;color:var(--text3);font-size:12px;line-height:1.8">'+hint+'</div>';
        return;
      }
      var entries = st.entries || [];
      if (!entries.length){
        listEl.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text3);font-size:12px">空目录</div>';
        return;
      }
      entries.sort(function(a,b){
        if ((a.type==='dir') !== (b.type==='dir')) return a.type==='dir' ? -1 : 1;
        return (a.name||'').localeCompare(b.name||'');
      });
      var html = '';
      var selMode = !!st.selectMode;
      var vm = st.viewMode || 'list';
      var IMG_RE = /\.(jpe?g|png|gif|webp|svg|bmp|avif)$/i;
      for (var i=0;i<entries.length;i++){
        var e = entries[i];
        var isDir = e.type === 'dir';
        var icon = isDir ? '📁' : '📄';
        var nameColor = isDir ? 'var(--purple)' : 'var(--text)';
        var sz = isDir ? '' : '<span style="color:var(--text3);font-size:10px;margin-left:6px">'+_fmtSize(e.size)+'</span>';
        var p = e.path || (st.cwd.replace(/\/$/,'') + '/' + e.name);
        var checkBox = selMode ? '<input type="checkbox" class="dpb-item-check" style="flex:0 0 auto;cursor:pointer;width:14px;height:14px;margin:0">' : '';
        var addBtn = selMode ? '' : '<button class="btn btn-sm dpb-add" style="padding:1px 6px;font-size:10px;flex:0 0 auto" title="加入传输列表">➕</button>';
        if (vm === 'list'){
          html += '<div class="dpb-item" data-path="'+_esc(p)+'" data-type="'+_esc(e.type)+'" data-size="'+Number(e.size||0)+'" data-side="'+side+'" style="padding:4px 8px;border-radius:5px;display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer;transition:background 0.12s">'
            + checkBox
            + '<span style="flex:0 0 auto">'+icon+'</span>'
            + '<span class="dpb-name" style="flex:1;min-width:0;color:'+nameColor+';overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+_esc(e.name)+'</span>'
            + sz
            + addBtn
            + '</div>';
        } else if (vm === 'icon'){
          // v4.93.0 · A1 图标视图: 网格大图标 (本地图片直接缩略图)
          var thumb = '';
          // v5.0.0 · 缩略图统一走 stream token (旧用 /api/download+会话token, 会话一变即 403 → 部分图不显示)
          if (!isDir && IMG_RE.test(e.name)){
            thumb = '<div data-rp-thumb="'+_esc(p)+'" style="width:100%;height:56px;border-radius:4px;background:var(--bg3);display:flex;align-items:center;justify-content:center;font-size:20px">⏳</div>';
          }
          html += '<div class="dpb-item" data-path="'+_esc(p)+'" data-type="'+_esc(e.type)+'" data-side="'+side+'" style="width:96px;padding:6px;border-radius:6px;display:flex;flex-direction:column;align-items:center;gap:3px;font-size:11px;cursor:pointer;text-align:center">'
            + (thumb || '<span style="font-size:30px;line-height:56px">'+icon+'</span>')
            + '<span class="dpb-name" style="max-width:100%;color:'+nameColor+';overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+_esc(e.name)+'</span>'
            + '</div>';
        } else if (vm === 'detail'){
          // v4.93.0 · A1 详情视图: 表格列 (名称/类型/大小/扩展)
          var ext = isDir ? '—' : (e.name.indexOf('.') > 0 ? e.name.split('.').pop().toUpperCase() : '—');
          html += '<div class="dpb-item" data-path="'+_esc(p)+'" data-type="'+_esc(e.type)+'" data-side="'+side+'" style="display:flex;align-items:center;gap:6px;font-size:12px;padding:4px 8px;border-radius:5px;cursor:pointer;border-bottom:1px solid var(--line)">'
            + checkBox
            + '<span style="flex:0 0 auto">'+icon+'</span>'
            + '<span class="dpb-name" style="flex:2;min-width:0;color:'+nameColor+';overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+_esc(e.name)+'</span>'
            + '<span style="flex:0 0 52px;color:var(--text3);font-size:10px">'+(isDir?'目录':'文件')+'</span>'
            + '<span style="flex:0 0 46px;color:var(--text3);font-size:10px;text-align:right">'+(isDir?'—':_fmtSize(e.size))+'</span>'
            + '<span style="flex:0 0 40px;color:var(--text3);font-size:10px;text-align:right">'+ext+'</span>'
            + addBtn
            + '</div>';
        } else {
          // v4.93.0 · A1 相册视图: 仅媒体文件网格 (本地缩略图/远端占位), 目录与其他文件弱化
          var isImg = !isDir && IMG_RE.test(e.name);
          var isAV = !isDir && /\.(mp4|mkv|webm|mov|mp3|flac|wav|m4a|ogg)$/i.test(e.name);
          if (!isImg && !isAV && !isDir) continue;
          var gThumb = '';
          if (isImg){
            gThumb = '<div data-rp-thumb="'+_esc(p)+'" style="width:100%;height:78px;border-radius:5px;background:var(--bg3);display:flex;align-items:center;justify-content:center;font-size:26px">⏳</div>';
          } else {
            gThumb = '<div style="width:100%;height:78px;border-radius:5px;background:var(--bg3);display:flex;align-items:center;justify-content:center;font-size:26px">'+(isDir?'📁':(isAV?'🎬':'📄'))+'</div>';
          }
          html += '<div class="dpb-item" data-path="'+_esc(p)+'" data-type="'+_esc(e.type)+'" data-side="'+side+'" style="width:118px;padding:5px;border-radius:6px;display:flex;flex-direction:column;gap:3px;font-size:11px;cursor:pointer">'
            + gThumb
            + '<span class="dpb-name" style="max-width:100%;color:'+nameColor+';overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+_esc(e.name)+'</span>'
            + '</div>';
        }
      }
      if (vm === 'icon' || vm === 'gallery'){
        listEl.innerHTML = '<div style="display:flex;flex-wrap:wrap;gap:8px;padding:10px">'+ (html || '<div style="color:var(--text3);font-size:12px;padding:10px">'+(vm==='gallery'?'本目录没有图片/音视频文件':'空目录')+'</div>') +'</div>';
        // v5.0.0 · 缩略图填充: 本机逐文件 stream token; 远端用目录级 token 拼 URL
        (function _fillThumbs(){
          var phs = listEl.querySelectorAll('[data-rp-thumb]');
          if (!phs.length) return;
          var _h = vm === 'icon' ? 56 : 78;
          function _set(el, src){
            if (!el.isConnected) return;
            el.outerHTML = '<img loading="lazy" src="'+src+'" style="width:100%;height:'+_h+'px;object-fit:cover;border-radius:5px" '+
                           'onerror="this.style.display=&#39;none&#39;;this.parentNode&&(this.parentNode.style.display=&#39;&#39;)">';
          }
          if (side === 'remote' && !(st.localFs)){
            // 远端: 目录级 token 一次签发
            rpcRemote('file_remote_stream_token', { path: st.cwd, host: (_remoteAuth().host||''),
                       port: _remoteAuth().port, user: _remoteAuth().user, auth_type: _remoteAuth().auth_type,
                       password: _remoteAuth().password, key: _remoteAuth().key, passphrase: _remoteAuth().passphrase })
              .then(function(tk){
                phs.forEach(function(el){
                  if (tk.status !== 'ok' || !tk.token){ el.textContent = '🖼'; return; }
                  var p2 = el.getAttribute('data-rp-thumb');
                  _set(el, '/api/file/remote_stream?path=' + encodeURIComponent(p2) + '&rst=' + encodeURIComponent(tk.token));
                });
              });
            return;
          }
          // v5.1.0 · 本机: 目录级 token 一次签发 (旧逐文件签发几十次, 部分超时 → 图不显示)
          rpcRemote('file_stream_token', { path: st.cwd }).then(function(tk){
            phs.forEach(function(el){
              var p2 = el.getAttribute('data-rp-thumb');
              if (tk.status === 'ok' && tk.token){
                _set(el, '/api/file/stream?path=' + encodeURIComponent(p2) + '&st=' + encodeURIComponent(tk.token));
              } else {
                el.textContent = '🖼';
              }
            });
          });
        })();
      } else if (vm === 'detail'){
        listEl.innerHTML = '<div style="padding:2px 0"><div style="display:flex;gap:6px;font-size:10px;color:var(--text3);padding:4px 8px;border-bottom:1px solid var(--border)"><span style="flex:2">名称</span><span style="flex:0 0 52px">类型</span><span style="flex:0 0 46px;text-align:right">大小</span><span style="flex:0 0 40px;text-align:right">格式</span></div>'+html+'</div>';
      } else {
        listEl.innerHTML = html;
      }

      var items = listEl.querySelectorAll('.dpb-item');
      for (var j=0;j<items.length;j++){
        (function(item){
          var p = item.getAttribute('data-path');
          var t = item.getAttribute('data-type');
          var sd = item.getAttribute('data-side');
          item.onmouseenter = function(){ if (!item.classList.contains('dpb-selected')) item.style.background = 'rgba(255,255,255,0.06)'; };
          item.onmouseleave = function(){ if (!item.classList.contains('dpb-selected')) item.style.background = ''; };
          var nameEl = item.querySelector('.dpb-name');
          // v4.96.0 · 按元素构造条目 (旧实现把循环变量 e / 事件对象 ev 当 entry 传,
          //   导致目录被识别为文件 → 预览走文本通道报错)
          var entryObj = { type: t, name: nameEl ? nameEl.textContent : '',
                           path: p, size: Number(item.getAttribute('data-size') || 0) };
          // v5.90.5 · 打开方式偏好: single=单击进入(默认) / double=双击进入, 单击不动作(Ctrl 多选走勾选框)
          var _dblOpen = (!window.RPOpenMode || window.RPOpenMode.get() === 'double');
          var _isUp = (entryObj.name === '..');   // ".." 恒为单击返回上级
          function _dpbDirActivate(){
            if (typeof onDirOpen === 'function'){ try { onDirOpen(p, entryObj); } catch(_){} }
            if (sd === 'remote' && typeof onTargetSelect === 'function'){
              onTargetSelect(p + '/');  // 设目标，load 在 onCwdChange 后会触发
            }
            // v4.96.0 · 预览模式下点击目录 → 中栏渲染目录浏览 (缩略图/列表)
            if (typeof onFileOpen === 'function'){ markSelected(p, item); try { onFileOpen(p, entryObj); } catch(_){} }
            load(p);  // 进入该目录
          }
          nameEl.onclick = function(){
            if (sd === 'local' && st.selectMode){
              var cb = item.querySelector('.dpb-item-check');
              if (cb) cb.checked = !cb.checked;
              _onItemCheckChange(item);
              return;
            }
            // v4.38.22 rev · 单击目录 = 进入该目录 (v5.90.5: 双击模式下改双击进入, ".." 除外)
            if (t === 'dir'){
              if (_dblOpen && !_isUp) return;
              _dpbDirActivate();
              return;
            }
            // v4.66.0 · 文件: 预览模式下走 onFileOpen, 否则加入传输列表 (双击模式下改双击)
            if (_dblOpen) return;
            if (typeof onFileOpen === 'function'){ markSelected(p, item); onFileOpen(p, entryObj); return; }
            addTo(p);
          };
          item.ondblclick = function(ev){
            // v5.90.5 · 双击模式: 目录进入 / 文件预览或加入; 单击模式保持原状(单击已生效, 不重复)
            if (!_dblOpen) return;
            if (ev.target && ev.target.classList && (ev.target.classList.contains('dpb-item-check') || ev.target.classList.contains('dpb-add'))) return;
            if (t === 'dir'){ _dpbDirActivate(); return; }
            if (typeof onFileOpen === 'function'){ markSelected(p, item); onFileOpen(p, entryObj); return; }
            addTo(p);
          };
          item.onclick = function(ev){
            if (ev.target === nameEl) return;
            if (ev.target && ev.target.classList && ev.target.classList.contains('dpb-item-check')) return;
            if (ev.target && ev.target.classList && ev.target.classList.contains('dpb-add')) return;
            if (sd === 'local' && st.selectMode){
              var cb = item.querySelector('.dpb-item-check');
              if (cb){ cb.checked = !cb.checked; _onItemCheckChange(item); }
              return;
            }
            // 同上：单击目录 = 进入并设为目标 (v5.90.5: 双击模式下改双击进入, ".." 除外)
            if (t === 'dir'){
              if (_dblOpen && !_isUp) return;
              _dpbDirActivate();
              return;
            }
            // v4.66.0 · 同上: 预览模式单击文件 → 预览 (双击模式下改双击)
            if (_dblOpen) return;
            if (typeof onFileOpen === 'function'){ markSelected(p, item); onFileOpen(p, entryObj); return; }
            addTo(p);
          };
          var addEl = item.querySelector('.dpb-add');
          if (addEl) addEl.onclick = function(ev){
            ev.stopPropagation();
            addTo(t === 'dir' ? p + '/' : p);
          };
          var cb = item.querySelector('.dpb-item-check');
          if (cb) cb.onchange = function(){ _onItemCheckChange(item); };
          // v4.87.0 · A1 跨栏拖拽: 文件可拖拽
          if (!isDir) {
            item.setAttribute('draggable', 'true');
            item.addEventListener('dragstart', function(ev) {
              ev.dataTransfer.setData('text/rp-src-path', p);
              ev.dataTransfer.setData('text/rp-src-side', side);
              ev.dataTransfer.effectAllowed = 'copy';
            });
          }
          // v4.58.0 · 右键菜单: 预览/编辑/压缩/解压/重命名/删除/属性 (FileOps)
          item.oncontextmenu = function(ev){
            if (typeof window.FileOps !== 'undefined' && window.FileOps.showMenu){
              window.FileOps.showMenu(ev, sd, p, t, api);
            }
          };
        })(items[j]);
      }
      updateSelbar();
    }

    // ---- 事件绑定 ----
    // v4.93.0 · A1 四视图切换按钮
    pane.addEventListener('click', function(ev){
      var b = ev.target.closest ? ev.target.closest('.dpb-vm') : null;
      if (!b) return;
      st.viewMode = b.getAttribute('data-vm') || 'list';
      try { localStorage.setItem('dpb_view_' + side, st.viewMode); } catch(e){}
      pane.querySelectorAll('.dpb-vm').forEach(function(x){
        var on = x.getAttribute('data-vm') === st.viewMode;
        x.style.background = on ? 'var(--cyan)' : 'transparent';
        x.style.color = on ? '#000' : 'var(--text3)';
      });
      render();
    });
    // v4.93.0 · A1 跨栏拖拽 drop 目标: 接收对侧拖来的文件 → 发起传输
    listEl.addEventListener('dragover', function(ev){
      if (ev.dataTransfer.types && Array.prototype.indexOf.call(ev.dataTransfer.types, 'text/rp-src-path') >= 0){
        ev.preventDefault();
        ev.dataTransfer.dropEffect = 'copy';
        listEl.style.outline = '2px dashed var(--cyan)';
        listEl.style.outlineOffset = '-4px';
      }
    });
    listEl.addEventListener('dragleave', function(){ listEl.style.outline = ''; });
    listEl.addEventListener('drop', function(ev){
      listEl.style.outline = '';
      var srcPath = ev.dataTransfer.getData('text/rp-src-path');
      var srcSide = ev.dataTransfer.getData('text/rp-src-side');
      if (!srcPath) return;  // 非跨栏拖拽 (如桌面文件上传) 交由默认处理
      ev.preventDefault();
      if (srcSide === side){ setStatus('⚠ 拖到对侧栏才能发起跨栏传输', true); return; }
      if (typeof onDropTransfer === 'function'){
        onDropTransfer(srcPath, srcSide, side);
        setStatus('✓ 已发起传输: ' + srcPath);
      } else {
        setStatus('⚠ 当前布局不支持跨栏拖拽传输', true);
      }
    });
    if (pathInput) pathInput.onkeydown = function(ev){ if (ev.key === 'Enter') load(pathInput.value || '/'); };
    var goBtn = pane.querySelector('.dpb-go'); if (goBtn) goBtn.onclick = function(){ load(pathInput.value || '/'); };
    var upBtn = pane.querySelector('.dpb-up'); if (upBtn) upBtn.onclick = goUp;
    var reBtn = pane.querySelector('.dpb-reload'); if (reBtn) reBtn.onclick = function(){ load(st.cwd); };

    // v5.17.0 · 新建目录 / 新建文件 (取代工具栏收藏位; 直接作用于当前栏目录)
    var mkdirBtn = pane.querySelector('.dpb-mkdir');
    if (mkdirBtn) mkdirBtn.onclick = function(){
      var cur = (st.cwd || '/').replace(/\/+$/, '') || '/';
      if (window.FileOps && window.FileOps._mkdirIn){ window.FileOps._mkdirIn(side, cur, api); return; }
      var nm = window.prompt('新建文件夹名称:');
      if (!nm) return;
      send({ action: 'file_mkdir', path: cur + '/' + nm }, function(r){
        setStatus(r && r.status === 'ok' ? '✓ 已创建 ' + nm : ('✗ ' + ((r && r.msg) || '失败')), !(r && r.status === 'ok'));
        if (r && r.status === 'ok') load(cur);
      });
    };
    var mkfileBtn = pane.querySelector('.dpb-mkfile');
    if (mkfileBtn) mkfileBtn.onclick = function(){
      var cur = (st.cwd || '/').replace(/\/+$/, '') || '/';
      if (window.FileOps && window.FileOps._mkfileIn){ window.FileOps._mkfileIn(side, cur, api); return; }
      var nm = window.prompt('新建文件名:');
      if (!nm) return;
      send({ action: 'file_mkfile', path: cur + '/' + nm, content: '' }, function(r){
        setStatus(r && r.status === 'ok' ? '✓ 已创建 ' + nm : ('✗ ' + ((r && r.msg) || '失败')), !(r && r.status === 'ok'));
        if (r && r.status === 'ok') load(cur);
      });
    };

    // ── v4.64.0 · 收藏夹 (localStorage, 按 side 分组) ──
    var _favKey = 'dpb_favs_' + side;
    function _favs(){ try { return JSON.parse(localStorage.getItem(_favKey) || '[]'); } catch(e){ return []; } }
    function _saveFavs(list){ try { localStorage.setItem(_favKey, JSON.stringify(list)); } catch(e){} }
    function _renderFavDrop(){
      var drop = pane.querySelector('.dpb-favdrop');
      if (!drop) return;
      var list = _favs();
      if (!list.length){
        drop.innerHTML = '<div style="padding:8px 10px;font-size:11px;color:var(--text3)">暂无收藏<br>点 ⭐ 收藏当前路径</div>';
        return;
      }
      drop.innerHTML = list.map(function(f, i){
        return '<div class="dpb-favitem" data-i="'+i+'" style="display:flex;align-items:center;gap:4px;padding:5px 8px;border-radius:5px;cursor:pointer;font-size:11px">'+
          '<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:monospace;color:var(--cyan)">'+_esc(f)+'</span>'+
          '<span class="dpb-favdel" data-i="'+i+'" style="color:var(--red);cursor:pointer;padding:0 3px" title="删除收藏">✕</span></div>';
      }).join('');
      drop.querySelectorAll('.dpb-favitem').forEach(function(el){
        el.onmouseenter = function(){ el.style.background = 'var(--bg3)'; };
        el.onmouseleave = function(){ el.style.background = ''; };
        el.onclick = function(ev){
          if (ev.target.classList.contains('dpb-favdel')){
            var i = parseInt(ev.target.getAttribute('data-i'), 10);
            var l2 = _favs(); l2.splice(i, 1); _saveFavs(l2); _renderFavDrop();
            ev.stopPropagation();
            return;
          }
          var f2 = _favs()[parseInt(el.getAttribute('data-i'), 10)];
          if (f2){ drop.style.display = 'none'; load(f2); }
        };
      });
    }
    var favBtn = pane.querySelector('.dpb-fav');
    if (favBtn) favBtn.onclick = function(){
      var cur = st.cwd || '/';
      var list = _favs();
      var idx = list.indexOf(cur);
      if (idx >= 0){ list.splice(idx, 1); favBtn.style.color = ''; setStatus('已取消收藏 ' + cur); }
      else { list.unshift(cur); favBtn.style.color = 'var(--yellow)'; setStatus('⭐ 已收藏 ' + cur); }
      _saveFavs(list);
      _renderFavDrop();
    };
    var favMenuBtn = pane.querySelector('.dpb-favmenu');
    if (favMenuBtn) favMenuBtn.onclick = function(ev){
      ev.stopPropagation();
      var drop = pane.querySelector('.dpb-favdrop');
      if (!drop) return;
      _renderFavDrop();
      drop.style.display = drop.style.display === 'none' ? 'block' : 'none';
    };
    document.addEventListener('click', function(ev){
      var drop = pane.querySelector('.dpb-favdrop');
      if (drop && drop.style.display !== 'none' &&
          !drop.contains(ev.target) && ev.target !== favMenuBtn && !(favMenuBtn && favMenuBtn.contains(ev.target))){
        drop.style.display = 'none';
      }
    });
    if (side === 'remote'){
      var connBtn = pane.querySelector('.dpb-conn');
      if (connBtn) connBtn.onclick = function(){
        setConnState(false);
        render();
        load('/');
      };
    } else if (showSelMode){
      var selBtn = pane.querySelector('.dpb-selmode');
      if (selBtn) selBtn.onclick = toggleSelectMode;
    }
    var selAdd = pane.querySelector('.dpb-seladd'); if (selAdd) selAdd.onclick = addChecked;
    var selClr = pane.querySelector('.dpb-selclr'); if (selClr) selClr.onclick = clearSel;
    var selDone = pane.querySelector('.dpb-seldone'); if (selDone) selDone.onclick = toggleSelectMode;

    api = {
      pane: pane,
      side: side,
      load: load,
      render: render,
      addTo: addTo,
      addChecked: addChecked,
      clearSel: clearSel,
      goUp: goUp,
      toggleSelectMode: toggleSelectMode,
      setStatus: setStatus,
      setConnState: setConnState,
      destroy: destroy,  // v4.38.23 · 显式销毁，清理 WS handler
      getState: function(){ return st; },
      getCwd: function(){ return st.cwd; },
      // v5.0.0 · 暴露当前目录条目 (供中栏翻页构建同目录列表)
      getEntries: function(){ return (st.entries || []).slice(); },
      // v5.4.0 · 暴露本栏有效凭据与云标识 (供预览层使用该栏自己的连接信息)
      getAuth: function(){
        // v5.4.0 · 只有"远端 SSH 栏"才返回凭据; 本机栏/共享挂载点栏必须返回 {} 
        //   (否则预览层会以为文件在远端, 走 SSH 读取 → 本地文件反而读不到)
        try {
          if (side !== 'remote') return {};
          if (st.localFs) return {};                  // 共享挂载点/本机路径浏览
          if (st.cloudFs && st.cloudFs.on) return {};  // 云端走 cloudId
          if (st.authOverride && typeof st.authOverride === 'function') return st.authOverride() || {};
          if (typeof getSrvAuth === 'function') return getSrvAuth() || {};
        } catch(e){}
        return {};
      },
      getCloudId: function(){ try { return (st.cloudFs && st.cloudFs.on) ? st.cloudFs.rid : null; } catch(e){ return null; } },
      isCloud: function(){ try { return !!(st.cloudFs && st.cloudFs.on); } catch(e){ return false; } },
      getEntries: function(){ return st.entries.slice(); },
      // v4.40.0 · localFs 模式: remote pane 切换为浏览本机路径 (list_dir · 不走 SSH)
      //   setLocalFs(true, mountPath) -> 后续 load() 均走本机 list_dir
      setLocalFs: function(on, initPath){
        st.localFs = !!on;
        if (st.localFs && side === 'remote'){ setConnState(true); }
        if (initPath) { try { load(initPath); } catch(e){ console.warn('[dpb] setLocalFs load', e); } }
      },
      isLocalFs: function(){ return !!st.localFs; },
      // v4.41.2 · cloudFs 模式: remote pane 浏览 ☁ 远端存储 (remote_ls · 不走 SSH)
      //   setCloudFs(true, rid, initPath) -> 后续 load() 均走云通路; setCloudFs(false) 恢复 SSH
      setCloudFs: function(on, rid, initPath){
        st.cloudFs = on ? { on: true, rid: rid || 0 } : null;
        if (st.cloudFs && side === 'remote'){ setConnState(true); }
        if (st.cloudFs && initPath != null){ try { load(initPath || '/'); } catch(e){ console.warn('[dpb] setCloudFs load', e); } }
      },
      isCloudFs: function(){ return !!(st.cloudFs && st.cloudFs.on); },
      getCloudRid: function(){ return st.cloudFs ? st.cloudFs.rid : 0; },
      // v4.66.0 · 动态切换"单击文件"行为: 传函数=预览模式, 传 null=加入传输模式
      setFileOpenHandler: function(fn){ onFileOpen = (typeof fn === 'function') ? fn : null; },
      // v4.96.0 · cross 双远端: 设置本栏专属凭据
      setAuthOverride: function(fn){ st.authOverride = (typeof fn === 'function') ? fn : null; },
      setDirOpenHandler: function(fn){ onDirOpen = (typeof fn === 'function') ? fn : null; },
      getSelectedPath: function(){ return st.selectedPath || ''; },
      clearSelected: clearSelected,
      // 高级：让上层直接回填条目数据
      setEntries: function(entries, cwd){
        st.entries = entries || [];
        st.cwd = cwd || st.cwd;
        if (side === 'remote') setConnState(true);
        render();
      },
    };
    return api;
  }

  // ==========================================================================
  // v4.38.20 兼容：保留独立运行（#dualPaneBrowser 容器）
  // ==========================================================================
  var _built = false;
  var _legacy = { local: null, remote: null };

  function _buildLegacy(){
    var host = document.getElementById('dualPaneBrowser');
    if (!host) return;
    host.innerHTML = '';
    var lp = createPane({
      side: 'local',
      title: '📁 本地文件',
      onAdd: function(p){
        // 兼容：加入 #srcPath
        var t = document.getElementById('srcPath');
        if (t){
          var cur = (t.value || '').trim();
          var lines = cur ? cur.split(/\n+/) : [];
          if (lines.indexOf(p) === -1){
            t.value = cur ? cur + '\n' + p : p;
          }
          t.dispatchEvent(new Event('input'));
          t.style.transition = 'background 0.3s';
          t.style.background = 'rgba(58,157,93,0.2)';
          setTimeout(function(){ t.style.background = ''; }, 600);
        }
      },
    });
    var rp = createPane({
      side: 'remote',
      title: '🌐 远端文件',
      onAdd: function(p){
        var t = document.getElementById('dstPath');
        if (t){
          t.value = p;
          t.dispatchEvent(new Event('input'));
        }
      },
    });
    host.appendChild(lp.pane);
    host.appendChild(rp.pane);
    _legacy.local = lp;
    _legacy.remote = rp;
    _built = true;
  }

  window.FileBrowser = {
    createPane: createPane,
    // 兼容 v4.38.20
    init: function(){
      if (_built) return;
      _buildLegacy();
    },
    refreshLocal: function(){ if (_legacy.local) _legacy.local.load(_legacy.local.getCwd() || '/'); },
    refreshRemote: function(){ if (_legacy.remote) _legacy.remote.load(_legacy.remote.getCwd() || '/'); },
    loadLocal: function(p){ if (_legacy.local) _legacy.local.load(p || '/'); },
    loadRemote: function(p){ if (_legacy.remote) _legacy.remote.load(p || '/'); },
    // 兼容旧 API
  };
  window.DualPaneBrowser = {
    init: window.FileBrowser.init,
    refreshLocal: window.FileBrowser.refreshLocal,
    refreshRemote: window.FileBrowser.refreshRemote,
    loadLocal: window.FileBrowser.loadLocal,
    loadRemote: window.FileBrowser.loadRemote,
  };

  // 自动初始化（DOMContentLoaded 后） · 仅当 #dualPaneBrowser 存在
  document.addEventListener('DOMContentLoaded', function(){
    setTimeout(function(){
      try {
        if (document.getElementById('dualPaneBrowser')){
          window.FileBrowser.init();
        }
      } catch(e){ console.warn('[FileBrowser] init', e); }
    }, 500);
  });

  // 兼容 v4.38.20 的 MutationObserver（当 #panel-transfer 激活时加载本地栏）
  (function(){
    var _localLoaded = false;
    function _ensureLocal(){
      if (_localLoaded) return;
      if (typeof openWs !== 'function') return;
      _localLoaded = true;
      try { window.FileBrowser.loadLocal('/'); } catch(e){}
    }
    function _check(panel){
      if (panel && panel.classList && panel.classList.contains('active')){
        try { window.FileBrowser.init(); }catch(e){}
        setTimeout(_ensureLocal, 400);
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
      }, 600);
    });
  })();
})();
