/* ============================================================================
 * file_preview_page.js · v4.66.0 · 独立「文件预览」页
 *  左侧: 源列表 (本机 / 服务器 / df挂载点 / 网络共享 / 远端存储) + 路径栏 + 文件列表
 *  右侧: 大预览区 (FilePreview 渲染)
 *  单击左侧文件 → 右侧预览; 预览工具栏 ➕ 加入传输 → 写入文件传输页三栏传输列表
 * ========================================================================== */
(function(g){
  'use strict';

  function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g,function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function $(id){ return document.getElementById(id); }
  function toast(m,k,ms){ if (typeof g.toast==='function') g.toast(m,k,ms||2600); }
  // v4.66.0 · 直连 WS 监听: list_dir/remote_ls 的回包 type(dir_result/remote_ls_result)
  //   不在 app.js send() 白名单内, 走 send() 回调永远不触发 → 用自建监听 + req_id 精确路由
  var _seq = 0;
  function rpc(action, data, timeoutMs){
    // v4.96.0 · 目录类请求优先走全局带重试助手 (抗切 tab 时的 socket 竞态)
    if (typeof window.rpcDirAction === 'function') return window.rpcDirAction(action, data, timeoutMs);
    return new Promise(function(resolve){
      if (typeof g.openWs !== 'function'){ resolve({ status:'error', msg:'WebSocket 未就绪' }); return; }
      var rid = '_fpp_' + (++_seq) + '_' + Date.now().toString(36);
      var done = false;
      var finish = function(r){ if (!done){ done = true; resolve(r || {}); } };
      g.openWs(function(ws){
        var handler = function(ev){
          var d;
          try { d = JSON.parse(ev.data); } catch(e){ return; }
          if (!d || d.req_id !== rid) return;
          try { ws.removeEventListener('message', handler); } catch(e){}
          finish(d);
        };
        ws.addEventListener('message', handler);
        var payload = Object.assign({ action: action, req_id: rid }, data || {});
        var tok = localStorage.getItem('auth_token');
        if (tok && !payload.auth_token) payload.auth_token = tok;
        try { _rpSendWhenReady(ws, payload, undefined, function(){ try { console.warn('[ws] 发送失败'); } catch(_){} }) }
        catch(e){ try { ws.removeEventListener('message', handler); } catch(_){}  finish({ status:'error', msg:String(e) }); }
        setTimeout(function(){
          try { ws.removeEventListener('message', handler); } catch(e){}
          finish({ status:'error', msg:'请求超时' });
        }, timeoutMs || 25000);
      }).catch(function(err){ finish({ status:'error', msg: String(err && err.message || err) }); });
    });
  }
  function fmtB(b){
    b = Number(b)||0;
    var u=['B','KB','MB','GB','TB'], i=0;
    while (b>=1024 && i<u.length-1){ b/=1024; i++; }
    return (i? b.toFixed(1): b) + ' ' + u[i];
  }

  var ST = {
    filter: '',                // v4.71.0 · 搜索过滤关键字 (支持 * ? 通配)
    sortKey: 'name',           // name | size | mtime | type
    sortAsc: true,             // 升序
    multiMode: false,          // 多选模式
    selected: {},              // { path: true }
    clipboard: null,           // { paths:[], op:'copy', side, tunc } 跨目录/跨源剪贴板
    src: { kind:'local' },     // 当前源描述符
    cwd: '/',
    entries: [],
    loading: false,
    loadId: 0,
    inited: false,
    cur: null,                 // 当前预览文件 { side, path, name, conn }
  };

  // ── 源清单 ──
  function _srvList(){
    try {
      var l = (g.SrvPool && g.SrvPool.getSrvList) ? g.SrvPool.getSrvList() : null;
      if (l && l.length) return l;
    } catch(e){}
    return (g.__srvListCache || []);
  }
  /* v1.0.0 · 用户报"源列表不刷新出 SSH 服务器": 此前只读 SrvPool(仅传输/DM 面板会填) →
     从别的页进预览时列表恒空。这里回落到**档案真源**(server_profiles, SP.serverRows) 并缓存。 */
  function _ensureSrvList(){
    var cur = _srvList();
    if (cur.length) return Promise.resolve(cur);
    if (!(g.SP && g.SP.serverRows)) return Promise.resolve([]);
    return g.SP.serverRows().then(function(d){
      var rows = (d && d.configs) || [];
      g.__srvListCache = rows.map(function(r){
        var nm = String(r.name || '').trim(), host = String(r.host || '').trim();
        return { srv_id: r.id, label: (nm && host && nm !== host) ? (nm + ' · ' + host) : (nm || host),
                 host: host, port: r.port, user: r.user, auth_type: r.auth_type,
                 guid: r._guid || r.uuid || '' };
      });
      return g.__srvListCache;
    }).catch(function(){ return []; });
  }
  function _dfMounts(){
    try { var c = g.__dmDfMounts; return (c && c.mounts && c.mounts.length) ? c.mounts : []; }
    catch(e){ return []; }
  }
  function _dfHost(){
    try { return (g.__dmDfMounts && g.__dmDfMounts.host) || ''; } catch(e){ return ''; }
  }
  function _shares(){
    try { return (g.__sharesCache && g.__sharesCache.length) ? g.__sharesCache : []; }
    catch(e){ return []; }
  }
  function _clouds(){
    try { return (g.__cloudRemotesCache && g.__cloudRemotesCache.length) ? g.__cloudRemotesCache : []; }
    catch(e){ return []; }
  }
  var SHARE_ROOT = '/var/lib/fonriv_mounts/shares/';

  // 源描述符 -> { side, conn } (side='remote' 时 conn 供 file_* WS 使用)
  function _srcConn(){
    var d = ST.src;
    if (!d || d.kind === 'local' || d.kind === 'share' || d.kind === 'df-local') return { side: 'local', conn: {} };
    if (d.kind === 'ssh' || d.kind === 'df'){
      var s = d.srv || {};
      var conn = {
        host: s.host || '', port: String(s.port || '22'), user: s.user || 'root',
        auth_type: s.auth_type || 'pass', password: s.password || '',
        key: s.key || '', passphrase: s.passphrase || '',
      };
      return { side: conn.host ? 'remote' : 'local', conn: conn };
    }
    // v5.4.0 · 云端来源: 带 cloudId (预览层据此走 remote_read_raw)
    if (d.kind === 'cloud'){
      var cid = (d.cloudId != null) ? d.cloudId : null;
      return { side: 'local', conn: {}, cloudId: cid };
    }
    return { side: 'local', conn: {} };
  }

  function _srcLabel(){
    var d = ST.src;
    if (!d) return '本机';
    if (d.kind === 'local') return '💻 本机';
    if (d.kind === 'ssh') return '🖥 ' + (d.srv ? (d.srv.label || d.srv.host) : '服务器');
    if (d.kind === 'df') return '📊 ' + (d.mount || '挂载点');
    if (d.kind === 'share') return '🌐 ' + (d.name || d.uuid || '共享');
    if (d.kind === 'cloud') return '☁ ' + (d.name || d.cloudId || '远端存储');
    return '源';
  }

  // v4.71.0 · 搜索过滤: 支持 * ? 通配 (无通配符时按子串匹配)
  function _matchFilter(name, q){
    if (!q) return true;
    var s2 = String(name || '');
    var query = String(q).trim();
    if (!query) return true;
    if (query.indexOf('*') >= 0 || query.indexOf('?') >= 0){
      var re = '^' + query.replace(/[.+^${}()|[\]\\]/g, '\\$&')
                           .replace(/\*/g, '.*').replace(/\?/g, '.') + '$';
      try { return new RegExp(re, 'i').test(s2); } catch(e){}
    }
    return s2.toLowerCase().indexOf(query.toLowerCase()) >= 0;
  }
  function _cmp(a, b){
    var d = 0;
    var ad = (a.type === 'dir'), bd = (b.type === 'dir');
    if (ad !== bd) return ad ? -1 : 1;          // 目录始终在前
    var k = ST.sortKey;
    if (k === 'size') d = (Number(a.size||0) - Number(b.size||0));
    else if (k === 'mtime') d = String(a.mtime||'').localeCompare(String(b.mtime||''));
    else if (k === 'type'){
      var ea = String(a.name||'').split('.').pop().toLowerCase();
      var eb = String(b.name||'').split('.').pop().toLowerCase();
      d = ea.localeCompare(eb) || String(a.name||'').localeCompare(String(b.name||''));
    } else d = String(a.name||'').localeCompare(String(b.name||''), 'zh');
    return ST.sortAsc ? d : -d;
  }

  // ── 文件列表加载 (多通路) ──
  function _load(p){
    var listEl = $('fpPageList');
    if (!listEl) return;
    ST.cwd = p || '/';
    var pathInput = $('fpPagePath');
    if (pathInput) pathInput.value = ST.cwd;
    listEl.innerHTML = '<div style="padding:14px;text-align:center;color:var(--text3);font-size:12px">⏳ 加载 ' + esc(ST.cwd) + ' …</div>';
    var myId = ++ST.loadId;
    var d = ST.src || { kind:'local' };

    var done = function(entries, cwd){
      if (myId !== ST.loadId) return;
      ST.entries = entries || [];
      ST.cwd = cwd || ST.cwd;
      _renderList();
    };

    if (d.kind === 'cloud'){
      var cp = String(ST.cwd || '/').replace(/^\/+|\/+$/g, '');
      rpc('remote_ls', { remote_id: d.cloudId, path: cp }).then(function(r){
        if (r.status !== 'ok'){ done([]); toast('✗ ' + (r.msg || '远端存储读取失败'), 'err'); return; }
        var entries = (r.entries || []).map(function(en){
          return { name: en.name, type: en.is_dir ? 'dir' : 'file', size: en.size || 0,
                   path: '/' + (cp ? cp + '/' : '') + en.name };
        });
        done(entries, '/' + cp);
      });
      return;
    }

    var useLocal = (d.kind === 'local' || d.kind === 'share' || d.kind === 'df-local');
    var payload = { path: ST.cwd };
    var action = 'list_dir';
    function _doList(){
      rpc(action, payload).then(function(r){
        if (r.status !== 'ok' && r.status !== 'success'){
          done([]);
          toast('✗ ' + (r.msg || '读取失败'), 'err');
          return;
        }
        done(r.entries || [], r.path || ST.cwd);
      });
    }
    if (!useLocal){
      var cc = _srcConn();
      if (cc.side !== 'remote'){
        // v1.0.0 · 选中的是远端源却没有 host → 明确提示(此前静默列本机文件, 用户以为"没生效")
        useLocal = true;
        try { toast('⚠ 该来源缺少主机地址, 已回落到本机浏览', 'warn', 3200); } catch(e){}
      } else {
        action = 'list_remote_dir';
        payload = Object.assign({ path: ST.cwd }, cc.conn);
        // v1.0.0 · 档案密码不下发(SP.serverRows 的 auth_value 恒为空) → 先解析一次再列目录,
        //   否则空密码 SSH 必失败(与传输页/连接中心同一口径, 走 SP.resolve 缓存)
        if (!payload.password && !payload.key && g.SP && typeof g.SP.resolve === 'function'){
          g.SP.resolve(payload.host, payload.port || '22', ['ssh']).then(function(rr){
            if (rr && rr.creds){
              payload.auth_type = rr.creds.auth_type || payload.auth_type;
              payload.password = rr.creds.password || '';
              payload.key = rr.creds.key || '';
              payload.passphrase = rr.creds.passphrase || '';
            }
            _doList();
          }).catch(function(){ _doList(); });
          return;
        }
      }
    }
    _doList();
  }

  // v4.97.0 · 左栏视图模式 (列表/图标/详情/相册), 记忆到 localStorage
  var _VIEW = (function(){ try { return localStorage.getItem('fpp_view') || 'list'; } catch(e){ return 'list'; } })();
  var _IMG_RE = /\.(jpe?g|png|gif|webp|svg|bmp|avif)$/i;
  var _AV_RE = /\.(mp4|mkv|webm|mov|mp3|flac|wav|m4a|ogg)$/i;
  function setView(v){
    _VIEW = v;
    try { localStorage.setItem('fpp_view', v); } catch(e){}
    document.querySelectorAll('.fpp-vm').forEach(function(b){
      var on = b.getAttribute('data-vm') === v;
      b.style.background = on ? 'var(--cyan)' : 'transparent';
      b.style.color = on ? '#000' : 'var(--text2)';
    });
    _renderList();
  }
  function _thumbHtml(p, name){
    if (!_IMG_RE.test(name || '')) return '';
    var isCloud = (ST.src || {}).kind === 'cloud';
    return '<div data-fpp-th="'+esc(p)+'" style="width:100%;height:74px;border-radius:5px;background:var(--bg3);display:flex;align-items:center;justify-content:center;font-size:22px">' + (isCloud ? '🖼' : '⏳') + '</div>';
  }
  // 图片缩略图: 本地走 stream token; 云/共享走占位
  function _fillThumbs(){
    var isCloud = (ST.src || {}).kind === 'cloud';
    if (isCloud) return;
    var els = document.querySelectorAll('[data-fpp-th]');
    if (!els.length) return;
    // v5.1.0 · 目录级 token 一次签发 → 批量出图
    rpc('file_stream_token', { path: ST.cwd || '/' }).then(function(tk){
      els.forEach(function(el){
        if (!el.isConnected) return;
        var p = el.getAttribute('data-fpp-th');
        if (tk.status === 'ok' && tk.token){
          el.outerHTML = '<img loading="lazy" src="/api/file/stream?path=' + encodeURIComponent(p) +
                         '&st=' + encodeURIComponent(tk.token) + '" style="width:100%;height:74px;object-fit:cover;border-radius:5px" onerror="this.style.display=\'none\'">';
        } else {
          el.innerHTML = '🖼';
        }
      });
    });
  }

  // v4.97.0 · 图标/相册/详情视图的统一打开语义 (目录进入 · 文件预览)
  // v5.0.0 · 打开目录: 右栏列出该目录内容 + 左栏进入 (列表视图与宫格视图共用)
  function _openDir(p, name){
    // v5.90.5 · 双击模式: 单击不进入 (".." 除外, 恒单击返回上级); 双击由统一委托处理
    if ((!window.RPOpenMode || window.RPOpenMode.get() === 'double') && name !== '..') return;
    // v5.1.0 · 「仅预览」模式: 目录不进右栏
    try { if (window.RpUI && window.RpUI.modeOf('preview') === 'preview'){ _load(p); return; } } catch(e){}
    var cc2 = _srcConn();
    _load(p);   // 左栏进入该目录
    setTimeout(function(){
      try {
        var pv2 = $('fpPagePreview');
        if (pv2 && g.FilePreview){
          var _onAdd = function(pp){
            try { if (g.TriPaneTransfer && g.TriPaneTransfer.addItem) g.TriPaneTransfer.addItem({ src: pp }); } catch(e){}
          };
          g.FilePreview.render(pv2, {
            side: cc2.side, conn: cc2.conn, cloudId: cc2.cloudId, path: p, name: name || '', _isDir: true, _pmScope: 'preview',
            onAddTransfer: _onAdd,
            onChanged: function(){ try { _load(ST.cwd); } catch(e){} },
          });
        }
      } catch(e){}
    }, 350);
  }

  function _fppOpen(el, force){
    var p = el.getAttribute('data-path');
    var t = el.getAttribute('data-type');
    if (ST.multiMode && (el.getAttribute('data-name') || '') !== '..'){
      ST.selected[p] = !ST.selected[p]; _renderList(); _updateSelBar(); return;
    }
    if (t === 'dir'){ _openDir(p, el.getAttribute('data-name') || ''); return; }
    // v5.90.5 · 双击模式: 单击文件只选中 (高亮后返回); 双击(force)才预览
    if (!force && (!window.RPOpenMode || window.RPOpenMode.get() === 'double')
        && (el.getAttribute('data-name') || '') !== '..'){
      try {
        document.querySelectorAll('#fpPageList .fpp-item').forEach(function(x){
          x.classList.remove('fpp-sel'); x.style.background = '';
        });
        el.classList.add('fpp-sel'); el.style.background = 'var(--bg3)';
      } catch(e){}
      return;
    }
    // v4.98.0 · 与列表视图走完全相同的通路 (含 _srcConn 的连接信息)
    //   旧实现强制 side:'local' 且丢 conn → 远端/云/共享 文件点开就报错
    var nm = String(p).split('/').filter(Boolean).pop() || p;
    var cc = _srcConn();
    ST.cur = { side: cc.side, path: p, name: nm, conn: cc.conn, cloudId: cc.cloudId,
               _size: Number(el.getAttribute('data-size') || 0) };
    _renderPreview();
    var pv = $('fpPagePreview');
    if (pv){ try { pv.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch(e){} }
    // 选中态
    try {
      document.querySelectorAll('#fpPageList .fpp-item').forEach(function(x){
        x.classList.remove('fpp-sel'); x.style.background = '';
      });
      el.classList.add('fpp-sel'); el.style.background = 'var(--bg3)';
    } catch(e){}
  }

  // v5.90.5 · 双击模式: 双击 .fpp-item 目录=进入 / 文件=预览 (列表与宫格统一委托)
  document.addEventListener('dblclick', function(ev){
    if (!window.RPOpenMode || window.RPOpenMode.get() !== 'double') return;
    var el = ev.target && ev.target.closest ? ev.target.closest('.fpp-item') : null;
    if (!el || !el.closest('#panel-file_preview')) return;
    var p = el.getAttribute('data-path') || '';
    var nm = el.getAttribute('data-name') || '';
    if (!p) return;
    if ((el.getAttribute('data-type') || '') === 'dir'){ _openDir(p, nm); return; }
    _fppOpen(el, true);
  });

  // v5.90.5 · 打开方式偏好挂到面包屑工具行 (文件预览页)
  (function(){
    var _mounted = false;
    function _mount(){
      if (_mounted) return;
      var bar = document.getElementById('fpPageCrumb');
      if (bar && window.RPOpenMode){
        var s = window.RPOpenMode.select('');
        s.style.cssText = 'margin-left:auto;padding:1px 4px;font-size:10.5px;background:var(--bg2);color:var(--text2);border:1px solid var(--border);border-radius:4px;max-width:140px';
        bar.appendChild(s);
        _mounted = true;
        clearInterval(_iv);
      }
    }
    var _iv = setInterval(_mount, 1500);
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _mount);
    else _mount();
  })();

  function _renderList(){
    var listEl = $('fpPageList');
    if (!listEl) return;
    // v4.98.0 · 面包屑同步
    try {
      var cb = $('fpPageCrumb');
      // v5.5.0 · 仅预览: 用 class 隐藏面包屑片段, 保留 ⚙ 预览设置按钮
      var _pmOnly2 = false;
      try { _pmOnly2 = (window.RpUI && window.RpUI.modeOf('preview') === 'preview'); } catch(e){}
      if (cb) cb.classList.toggle('rp-pm-only', _pmOnly2);
      if (cb && window.RpUI){
        window.RpUI.mountBreadcrumb(cb, ST.cwd || '/', {
          onNav: function(p2){ _load(p2); },
          onBack: function(){ _load((ST.cwd || '/').replace(/\/[^\/]*$/, '') || '/'); }
        });
        if (!cb.querySelector('.rp-pm-btn')){
          try { cb.appendChild(window.RpUI.settingsButton('preview', '文件预览 · 右栏预览')); } catch(e){}
        }
        try { cb.classList.toggle('rp-pm-only', _pmOnly2); } catch(e){}
      }
    } catch(e){}
    var allEntries = (ST.entries || []).slice();
    allEntries.sort(_cmp);
    var entries = allEntries.filter(function(e){ return _matchFilter(e.name, ST.filter); });
    // 过滤统计
    var statEl = $('fpPageStat');
    if (statEl && ST.filter){
      statEl.textContent = _srcLabel() + ' · 匹配 ' + entries.length + ' / ' + allEntries.length + ' 项 (过滤: ' + ST.filter + ')';
    }
    if (!entries.length){
      listEl.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text3);font-size:12px">' +
        (allEntries.length ? ('无匹配项 (共 ' + allEntries.length + ' 项)') : '（空目录）') + '</div>';
      return;
    }
    // v4.97.0 · 四种视图渲染 (列表/图标/详情/相册)
    var _items = entries.map(function(e, i){
      var isDir = (e.type === 'dir');
      var full = e.path || ((ST.cwd === '/' ? '' : ST.cwd.replace(/\/+$/,'')) + '/' + e.name);
      var _sel = !!ST.selected[full];
      var chk = (ST.multiMode && e.name !== '..') ? '<input type="checkbox" class="fpp-chk" data-path="'+esc(full)+'"'+(_sel?' checked':'')+' style="flex:0 0 auto;width:13px;height:13px;cursor:pointer">' : '';
      var base = 'class="fpp-item' + (_sel ? ' fpp-multi-sel' : '') + '" data-i="'+i+'" data-path="'+esc(full)+'" data-type="'+esc(e.type||'file')+'" data-name="'+esc(e.name||'')+'" data-size="'+Number(e.size||0)+'" data-mtime="'+esc(e.mtime||'')+'"';
      if (_VIEW === 'icon'){
        return '<div '+base+' style="width:104px;padding:6px;border-radius:6px;display:flex;flex-direction:column;align-items:center;gap:3px;font-size:11px;cursor:pointer;text-align:center">'+
          _thumbHtml(full, e.name).replace('height:74px','height:58px') +
          (('' + _thumbHtml(full, e.name)) ? '' : '<span style="font-size:30px;line-height:58px">'+(isDir?'📁':'📄')+'</span>') +
          '<span style="max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:'+(isDir?'var(--purple)':'var(--text)')+'">'+esc(e.name)+'</span></div>';
      }
      if (_VIEW === 'detail'){
        var ext2 = isDir ? '—' : (e.name.indexOf('.') > 0 ? e.name.split('.').pop().toUpperCase() : '—');
        return '<div '+base+' style="display:flex;align-items:center;gap:6px;padding:4px 8px;border-radius:4px;cursor:pointer;font-size:12px;border-bottom:1px solid var(--line)">'+
          chk + '<span style="flex:0 0 auto">'+(isDir?'📁':'📄')+'</span>'+
          '<span style="flex:2;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:'+(isDir?'var(--purple)':'var(--text)')+'">'+esc(e.name)+'</span>'+
          '<span style="flex:0 0 48px;color:var(--text3);font-size:10px">'+(isDir?'目录':'文件')+'</span>'+
          '<span style="flex:0 0 52px;color:var(--text3);font-size:10px;text-align:right">'+(isDir?'—':fmtB(e.size))+'</span>'+
          '<span style="flex:0 0 44px;color:var(--text3);font-size:10px;text-align:right">'+ext2+'</span></div>';
      }
      if (_VIEW === 'gallery'){
        var isImg = !isDir && _IMG_RE.test(e.name||'');
        var isAV = !isDir && _AV_RE.test(e.name||'');
        if (!isDir && !isImg && !isAV) return '';
        return '<div '+base+' style="width:124px;padding:5px;border-radius:6px;cursor:pointer;display:flex;flex-direction:column;gap:3px;font-size:11px">'+
          (_thumbHtml(full, e.name) || ('<div style="width:100%;height:74px;border-radius:5px;background:var(--bg3);display:flex;align-items:center;justify-content:center;font-size:24px">'+(isDir?'📁':(isAV?'🎬':'📄'))+'</div>')) +
          '<span style="max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:'+(isDir?'var(--purple)':'var(--text)')+'">'+(isDir?'📁 ':'')+esc(e.name)+'</span></div>';
      }
      // list
      return '<div '+base+' style="display:flex;align-items:center;gap:6px;padding:4px 8px;border-radius:4px;cursor:pointer;font-size:12px">'+
        chk + '<span style="flex:0 0 auto">'+(isDir?'📁':'📄')+'</span>'+
        '<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:'+(isDir?'var(--purple)':'var(--text)')+'">'+esc(e.name)+'</span>'+
        (isDir?'':'<span style="color:var(--text3);font-size:10px;flex:0 0 auto">'+fmtB(e.size)+'</span>')+
        '</div>';
    }).filter(function(x){ return x; });
    if (_VIEW === 'icon' || _VIEW === 'gallery'){
      listEl.innerHTML = '<div style="display:flex;flex-wrap:wrap;gap:8px;padding:8px">' +
        (_items.join('') || '<div style="color:var(--text3);font-size:12px;padding:8px">' + (_VIEW === 'gallery' ? '本目录没有图片/音视频' : '空目录') + '</div>') + '</div>';
      _fillThumbs();
      listEl.querySelectorAll('.fpp-item').forEach(function(el){
        el.onclick = function(){ _fppOpen(el); };
      });
      return;
    }
    if (_VIEW === 'detail'){
      listEl.innerHTML = '<div style="padding:2px 4px"><div style="display:flex;gap:6px;font-size:10px;color:var(--text3);padding:4px 8px;border-bottom:1px solid var(--border)"><span style="flex:2">名称</span><span style="flex:0 0 48px">类型</span><span style="flex:0 0 52px;text-align:right">大小</span><span style="flex:0 0 44px;text-align:right">格式</span></div>' + _items.join('') + '</div>';
    } else {
      listEl.innerHTML = _items.join('');
    }
    if (_VIEW === 'icon' || _VIEW === 'detail'){
      listEl.querySelectorAll('.fpp-item').forEach(function(el){
        el.onclick = function(){ _fppOpen(el); };
      });
      return;
    }
    listEl.querySelectorAll('.fpp-item').forEach(function(el){
      el.onmouseenter = function(){ el.style.background = 'var(--bg3)'; };
      el.onmouseleave = function(){ el.style.background = el.classList.contains('fpp-sel') ? 'var(--bg3)' : ''; };
      el.onclick = function(ev){
        var p = el.getAttribute('data-path');
        var t = el.getAttribute('data-type');
        // v4.71.0 · 多选模式: 点击切换勾选 (Ctrl/Shift 追加), 不导航
        // 多选: '..' 父目录条目不参与勾选 (点击它仍用于返回上级)
        if (ST.multiMode){
          var nmUl = el.getAttribute('data-name') || '';
          if (nmUl !== '..'){
            if (ev && ev.target && ev.target.classList && ev.target.classList.contains('fpp-chk')){
              ST.selected[p] = ev.target.checked;
            } else {
              ST.selected[p] = !ST.selected[p];
            }
            _renderList(); _updateSelBar();
            return;
          }
        }
        listEl.querySelectorAll('.fpp-item').forEach(function(x){ x.classList.remove('fpp-sel'); x.style.background=''; });
        el.classList.add('fpp-sel'); el.style.background = 'var(--bg3)';
        if (t === 'dir'){ _openDir(p, el.getAttribute('data-name') || ''); return; }
        // v5.90.5 · 双击模式: 单击文件只选中(上方已高亮), 不预览 (".." 除外)
        if ((!window.RPOpenMode || window.RPOpenMode.get() === 'double')
            && (el.getAttribute('data-name') || '') !== '..') return;
        var nm = String(p).split('/').filter(Boolean).pop() || p;
        var cc = _srcConn();
        ST.cur = { side: cc.side, path: p, name: nm, conn: cc.conn, cloudId: cc.cloudId,
                   _size: Number(el.getAttribute('data-size') || 0) };
        _renderPreview();
        // v4.69.0 · 保证预览区始终可见 (页面/容器若被滚动, 自动拉回)
        var pv = $('fpPagePreview');
        if (pv){
          try { pv.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch(e){}
          pv.scrollTop = 0;
        }
      };
      el.oncontextmenu = function(ev){
        ev.preventDefault();
        var p = el.getAttribute('data-path');
        var t = el.getAttribute('data-type');
        if (t === 'dir') return;
        if (typeof g.FileOps !== 'undefined' && g.FileOps.showMenu){
          var cc = _srcConn();
          g.FileOps.showMenu(ev, cc.side, p, t, {
            load: function(){ _load(ST.cwd); },
            getCwd: function(){ return ST.cwd; },
            isCloudFs: function(){ return (ST.src||{}).kind === 'cloud'; },
            isLocalFs: function(){ return cc.side === 'local'; },
          });
        }
      };
    });
  }

  // ── v4.71.0 · 多选批量操作 ──
  function _selPaths(){
    return Object.keys(ST.selected).filter(function(k){ return ST.selected[k]; });
  }
  function _updateSelBar(){
    var bar = $('fpSelBar');
    if (!bar) return;
    var n = _selPaths().length;
    bar.style.display = ST.multiMode ? 'flex' : 'none';
    var cnt = $('fpSelCount');
    if (cnt) cnt.textContent = '已选 ' + n + ' 项';
  }
  function _toggleMulti(on){
    ST.multiMode = (on === undefined) ? !ST.multiMode : !!on;
    if (!ST.multiMode) ST.selected = {};
    var b = $('fpPageMulti');
    if (b){
      b.textContent = ST.multiMode ? '☑ 多选中' : '☐ 多选';
      b.style.background = ST.multiMode ? 'var(--green)' : '';
      b.style.color = ST.multiMode ? '#fff' : '';
      b.style.borderColor = ST.multiMode ? 'var(--green)' : '';
    }
    _renderList(); _updateSelBar();
  }
  function _batchDelete(){
    var ps = _selPaths();
    if (!ps.length){ if (typeof toast === 'function') toast('⚠ 请先勾选文件', 'err'); return; }
    var cc = _srcConn();
    if (!g.confirm || !g.confirm('确定删除选中的 ' + ps.length + ' 项？\n此操作不可恢复！')) return;
    var done = 0, fail = 0, left = ps.length;
    ps.forEach(function(p){
      rpc('file_delete', Object.assign({path: p}, cc.conn)).then(function(r){
        if (r.status === 'ok') done++; else fail++;
        if (--left === 0){
          if (typeof toast === 'function'){
            toast('✓ 已删除 ' + done + ' 项' + (fail ? (' · 失败 ' + fail) : ''), fail ? 'warn' : 'success', 3600);
          }
          ST.selected = {}; _load(ST.cwd);
        }
      });
    });
  }
  function _batchAddTransfer(){
    var ps = _selPaths();
    if (!ps.length){ if (typeof toast === 'function') toast('⚠ 请先勾选文件', 'err'); return; }
    var ok = 0;
    ps.forEach(function(p){
      try {
        if (g.TriPaneTransfer && typeof g.TriPaneTransfer.addItem === 'function' && g.TriPaneTransfer.addItem({ src: p })) ok++;
      } catch(e){}
    });
    if (typeof toast === 'function'){
      toast(ok ? ('✓ 已加入传输列表 ' + ok + ' 项 (请到文件传输页查看)') : '⚠ 未找到传输列表 (请先打开文件传输页)',
            ok ? 'success' : 'warn', 3800);
    }
  }
  function _batchCompress(){
    var ps = _selPaths();
    if (!ps.length){ if (typeof toast === 'function') toast('⚠ 请先勾选文件', 'err'); return; }
    if (g.FileOps && g.FileOps.compress) g.FileOps.compress('local', ps.length === 1 ? ps[0] : ps[0], null, {
      load: function(){ _load(ST.cwd); }, getCwd: function(){ return ST.cwd; }
    });
  }
  // 全选 / 反选 / 清空
  function _selAll(){
    (ST.entries || []).filter(function(e){
      return e.name !== '..' && _matchFilter(e.name, ST.filter);
    }).forEach(function(e){
      var full = e.path || ((ST.cwd === '/' ? '' : ST.cwd.replace(/\/+$/,'')) + '/' + e.name);
      ST.selected[full] = true;
    });
    _renderList(); _updateSelBar();
  }
  function _selNone(){ ST.selected = {}; _renderList(); _updateSelBar(); }

  // ── v4.71.0 · 复制 / 粘贴 ──
  function _copySel(){
    var ps = _selPaths();
    if (!ps.length){ if (typeof toast === 'function') toast('⚠ 请先勾选文件', 'err'); return; }
    var cc = _srcConn();
    ST.clipboard = { paths: ps.slice(), side: cc.side, conn: cc.conn, src: _srcLabel() };
    if (typeof toast === 'function'){
      toast('已复制 ' + ps.length + ' 项 (切到目标目录后按 Ctrl+V 粘贴)', 'info', 4000);
    }
  }
  function _pasteHere(){
    var cb = ST.clipboard;
    if (!cb || !cb.paths || !cb.paths.length){ if (typeof toast === 'function') toast('⚠ 剪贴板为空', 'err'); return; }
    var cc = _srcConn();
    // 同源同管道 → 直接 cp; 跨源/远端 → 交给传输引擎 (rsync)
    var sameSide = (cb.side === cc.side) &&
      ((cb.conn.host || '') === (cc.conn.host || ''));
    if (sameSide){
      var okN = 0, left = cb.paths.length;
      cb.paths.forEach(function(p){
        var base = String(p).replace(/\/+$/, '').split('/').pop();
        var dst = (ST.cwd === '/' ? '' : ST.cwd.replace(/\/+$/, '')) + '/' + base;
        rpc('file_copy', Object.assign({src: p, dst: dst}, cc.conn)).then(function(r){
          if (r.status === 'ok') okN++;
          if (--left === 0){
            if (typeof toast === 'function'){
              toast(okN ? ('✓ 已粘贴 ' + okN + ' 项') : '✗ 粘贴失败', okN ? 'success' : 'err', 3600);
            }
            _load(ST.cwd);
          }
        });
      });
      return;
    }
    // 跨源: 走传输列表
    var added = 0;
    cb.paths.forEach(function(p){
      try { if (g.TriPaneTransfer && g.TriPaneTransfer.addItem({ src: p, dst: ST.cwd, server: cb.conn.host ? cb.side : 'local' })) added++; } catch(e){}
    });
    if (typeof toast === 'function'){
      toast(added ? ('跨源粘贴: 已加入传输列表 ' + added + ' 项, 请到文件传输页执行')
                  : '⚠ 跨源粘贴需在文件传输页操作', added ? 'info' : 'warn', 4200);
    }
  }

  // ── v4.71.0 · 存储分析 (当前目录占用 Top N) ──
  function _storageAnalyze(){
    var cc = _srcConn();
    var m = document.createElement('div');
    m.id = 'fpAnalyzeModal';
    m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:100000;display:flex;align-items:center;justify-content:center';
    m.innerHTML = '<div style="background:var(--bg2);border:1px solid var(--border);border-radius:10px;width:720px;max-width:94vw;max-height:88vh;display:flex;flex-direction:column">'+
      '<div style="padding:9px 14px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px">'+
      '<b style="font-size:13px">📊 存储分析 · '+esc(ST.cwd)+'</b><span style="flex:1"></span>'+
      '<button class="btn btn-sm" onclick="document.getElementById(\'fpAnalyzeModal\').remove()">关闭</button></div>'+
      '<div id="fpAnalyzeBody" style="flex:1;overflow:auto;padding:10px 14px;font-size:12px;color:var(--text3)">⏳ 统计中 (大目录可能较慢)…</div></div>';
    document.body.appendChild(m);
    m.addEventListener('mousedown', function(ev){ if (ev.target === m) m.remove(); });
    // 本机: du 直接算; 远端: 通过 file_exec 类通路 (用 dir_size action)
    rpc('dir_size', Object.assign({path: ST.cwd, top: 15}, cc.conn)).then(function(r){
      var body = document.getElementById('fpAnalyzeBody');
      if (!body) return;
      if (r.status !== 'ok'){
        body.innerHTML = '✗ ' + esc(r.msg || '统计失败');
        return;
      }
      var total = Number(r.total || 0);
      var items = r.items || [];
      function fmt(n){
        n = Number(n) || 0;
        var u = ['B','KB','MB','GB','TB'], i = 0;
        while (n >= 1024 && i < u.length-1){ n /= 1024; i++; }
        return (i ? n.toFixed(1) : n) + ' ' + u[i];
      }
      var html = '<div style="margin-bottom:8px;color:var(--text2)">当前目录总计 <b>'+fmt(total)+'</b> · 条目 '+items.length+'</div>';
      var mx = items.length ? Number(items[0].size || 1) : 1;
      html += items.map(function(it){
        var pct = Math.max(1, Math.round(Number(it.size||0) / mx * 100));
        return '<div style="margin-bottom:6px">'+
          '<div style="display:flex;gap:8px;font-size:11px;color:var(--text2)">'+
            '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+esc(it.name)+'">'+
            (it.is_dir ? '📁 ' : '📄 ') + esc(it.name)+'</span>'+
            '<span style="color:var(--text3)">'+fmt(it.size)+(it.is_dir ? ' ('+ (it.count||0) +' 文件)' : '')+'</span></div>'+
          '<div style="height:6px;background:var(--bg4);border-radius:3px;margin-top:3px">'+
            '<div style="height:100%;width:'+pct+'%;background:'+(it.is_dir?'var(--purple)':'var(--cyan)')+';border-radius:3px"></div></div>'+
        '</div>';
      }).join('');
      body.innerHTML = html;
    });
  }

  // ── v4.71.0 · 文件校验 (MD5/SHA256) ──
  function _checksum(path){
    var cc = _srcConn();
    var algo = g.prompt('选择算法 (md5 / sha1 / sha256 / sha512):', 'sha256');
    if (!algo) return;
    algo = String(algo).trim().toLowerCase();
    if (['md5','sha1','sha256','sha512'].indexOf(algo) < 0){
      if (typeof toast === 'function') toast('⚠ 不支持的算法', 'err');
      return;
    }
    var m = document.createElement('div');
    m.id = 'fpSumModal';
    m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:100000;display:flex;align-items:center;justify-content:center';
    m.innerHTML = '<div style="background:var(--bg2);border:1px solid var(--border);border-radius:10px;width:680px;max-width:94vw">'+
      '<div style="padding:9px 14px;border-bottom:1px solid var(--border);display:flex;align-items:center">'+
      '<b style="font-size:13px">🔐 文件校验 ('+algo.toUpperCase()+')</b><span style="flex:1"></span>'+
      '<button class="btn btn-sm" onclick="document.getElementById(\'fpSumModal\').remove()">关闭</button></div>'+
      '<div id="fpSumBody" style="padding:12px 14px;font-size:11px;word-break:break-all;color:var(--text3)">⏳ 计算中…</div></div>';
    document.body.appendChild(m);
    m.addEventListener('mousedown', function(ev){ if (ev.target === m) m.remove(); });
    rpc('file_checksum', Object.assign({path: path, algo: algo}, cc.conn)).then(function(r){
      var body = document.getElementById('fpSumBody');
      if (!body) return;
      if (r.status !== 'ok'){ body.innerHTML = '✗ ' + esc(r.msg || '计算失败'); return; }
      body.innerHTML = '<div style="color:var(--text3);font-size:11px">'+esc(path)+'</div>'+
        '<div style="font-family:monospace;font-size:13px;color:var(--cyan);margin:8px 0;user-select:all">'+esc(r.checksum||'')+'</div>'+
        '<div style="color:var(--text3);font-size:11px">大小 '+
        (function(n){ n=Number(n)||0; var u=['B','KB','MB','GB']; var i=0; while(n>=1024&&i<u.length-1){n/=1024;i++;} return (i?n.toFixed(1):n)+u[i]; })(r.size)+
        '</div>'+
        '<div style="display:flex;gap:6px;margin-top:10px">'+
          '<button class="btn btn-sm" id="fpSumCopy">📋 复制校验值</button>'+
          '<button class="btn btn-sm" id="fpSumCmp">🔍 与本地文件比对</button></div>'+
        '<div id="fpSumCmpMsg" style="font-size:11px;color:var(--text3);margin-top:6px"></div>';
      var cp = document.getElementById('fpSumCopy');
      if (cp) cp.onclick = function(){
        if (navigator.clipboard) navigator.clipboard.writeText(r.checksum||'').then(function(){
          if (typeof toast === 'function') toast('✓ 已复制');
        });
      };
      var cm = document.getElementById('fpSumCmp');
      if (cm) cm.onclick = function(){
        var local = g.prompt('本地文件路径 (用于比对):', '');
        if (!local) return;
        rpc('file_checksum', {path: local, algo: algo}).then(function(r2){
          var msg = document.getElementById('fpSumCmpMsg');
          if (!msg) return;
          if (r2.status !== 'ok'){ msg.textContent = '✗ 本地文件读取失败: ' + (r2.msg||''); return; }
          var same = (String(r2.checksum).toLowerCase() === String(r.checksum).toLowerCase());
          msg.style.color = same ? 'var(--green)' : 'var(--red)';
          msg.textContent = same ? '✓ 校验值一致 (文件相同)' : '✗ 校验值不同 (文件不一致)';
        });
      };
    });
  }

  // ── v4.71.0 · 拖拽上传 (小文件走 base64 file_write; 大文件分块) ──
  var _UPLOAD_CHUNK = 2 * 1024 * 1024;   // 2MB/块
  function _uploadFiles(fileList){
    var cc = _srcConn();
    var files = Array.prototype.slice.call(fileList);
    var done = 0, fail = 0;
    if (typeof toast === 'function'){
      toast('⏳ 上传 ' + files.length + ' 个文件到 ' + ST.cwd + ' …', 'info', 4000);
    }
    var next = function(i){
      if (i >= files.length){
        if (typeof toast === 'function'){
          toast('✓ 上传完成 ' + done + ' 个' + (fail ? (' · 失败 ' + fail) : ''), fail ? 'warn' : 'success', 4200);
        }
        _load(ST.cwd);
        return;
      }
      var f = files[i];
      var base = (ST.cwd === '/' ? '' : String(ST.cwd).replace(/\/+$/, ''));
      var target = base + '/' + f.name;
      var reader = new FileReader();
      reader.onload = function(){
        var b64 = String(reader.result).split(',')[1] || '';
        // 直接传 base64 由后端解码落盘 (content_b64 模式)
        rpc('file_write_b64', Object.assign({path: target, content_b64: b64, append: false}, cc.conn))
          .then(function(r){
            if (r.status === 'ok') done++; else { fail++; console.warn('upload fail', f.name, r.msg); }
            next(i + 1);
          });
      };
      reader.onerror = function(){ fail++; next(i + 1); };
      reader.readAsDataURL(f);
    };
    next(0);
  }

  // ── 预览 ──
  function _renderPreview(){
    var host = $('fpPagePreview');
    if (!host) return;
    if (!g.FilePreview){ host.innerHTML = '<div style="padding:16px;color:var(--red)">✗ file_preview.js 未加载</div>'; return; }
    var c = ST.cur;
    g.FilePreview.render(host, {
      side: c ? c.side : 'local',
      conn: c ? c.conn : {},
      cloudId: (c && c.cloudId != null) ? c.cloudId : ((_srcConn() || {}).cloudId),
      path: c ? c.path : '',
      name: c ? c.name : '',
      onAddTransfer: function(p){
        var ok = false;
        try {
          if (g.TriPaneTransfer && typeof g.TriPaneTransfer.addItem === 'function') ok = g.TriPaneTransfer.addItem({ src: p });
        } catch(e){}
        if (!ok){
          try {
            var insts = g._triInstances || {};
            for (var k in insts){
              if (insts[k] && typeof insts[k].addItem === 'function'){ ok = insts[k].addItem({ src: p }); if (ok) break; }
            }
          } catch(e){}
        }
        toast(ok ? '✓ 已加入「文件传输」页的传输列表' : '⚠ 未找到传输列表 (请先打开文件传输页)',
              ok ? 'success' : 'warn', 3200);
      },
      toggleFull: _toggleFull,
      onChanged: function(){ ST.cur = null; _renderPreview(); _load(ST.cwd); },
    });
  }

  // ── 源下拉 ──
  function _renderSrcSelect(){
    var sel = $('fpPageSrc');
    if (!sel) return;
    // v1.0.0 · 先确保服务器列表有数据(档案真源), 再渲染 (此前为空时列表里没有 SSH 服务器)
    return _ensureSrvList().then(function(){ _renderSrcSelectNow(); }).catch(function(){ _renderSrcSelectNow(); });
  }
  function _renderSrcSelectNow(){
    var sel = $('fpPageSrc');
    if (!sel) return;
    var html = '<optgroup label="💻 本机/本地磁盘"><option value="local">💻 本机 (: 根目录)</option></optgroup>';
    var srvs = _srvList();
    if (srvs.length){
      html += '<optgroup label="🖥 服务器 (SSH)">';
      srvs.forEach(function(s, i){
        var val = 'srv:' + (s.srv_id != null ? s.srv_id : i);
        html += '<option value="'+esc(String(val))+'">🖥 '+esc(s.label || (s.host + ':' + (s.port||22)))+'</option>';
      });
      html += '</optgroup>';
    }
    /* v1.0.0 · 社区版去掉「df 挂载点」组: 该数据来自远端磁盘管理(DM)的残留缓存
       (window.__dmDfMounts), 社区档没有 DM 面板 → 只会显示过期条目(用户报"里面还残留 DF 挂载点")。 */
    var sh = _shares();
    if (sh.length){
      html += '<optgroup label="🌐 网络共享">';
      sh.forEach(function(s){
        html += '<option value="share:'+esc(s.uuid||'')+'">🌐 '+esc(s.name||s.share||s.uuid)+'</option>';
      });
      html += '</optgroup>';
    }
    /* v1.0.0 · 社区版去掉「☁ 远端存储」组 (远端存储为商业能力, 社区档无入口) */
    sel.innerHTML = html;
    // v1.0.0 · 残留选择(df:/cloud:)在新列表里不存在 → 回落本机, 避免"显示本机却带着旧远端描述"
    if (ST.value && (/^df:/.test(String(ST.value)) || /^cloud:/.test(String(ST.value)))){
      ST.value = 'local';
    }
    sel.value = ST.value || 'local';
    if (sel.value !== (ST.value || 'local')){ ST.value = sel.value || 'local'; }
  }

  function _resolveSrc(val){
    if (!val || val === 'local') return { kind:'local' };
    var m;
    /* v1.0.0 · FIX(用户报"文件预览选了服务器还列本机文件"): 原来只认**纯数字** id
       (/^srv:(-?\d+)$/), 而档案(server_profiles)的 id 是 guid → 不匹配 → 落到函数末尾
       的 `return {kind:'local'}` → 静默按本机列目录。改为接受任意 id(下面按 String 比较)。 */
    if ((m = /^srv:(.+)$/.exec(val))){
      var id = m[1];
      var list = _srvList();
      var found = null;
      for (var i=0;i<list.length;i++){
        if (String(list[i].srv_id != null ? list[i].srv_id : i) === String(id)){ found = list[i]; break; }
      }
      return { kind:'ssh', srvId: id, srv: found || {} };
    }
    if ((m = /^df:(.+)$/.exec(val))){
      var mount = m[1];
      var host = _dfHost();
      // df 挂载点: 若 host 是本机 -> 本机通路; 否则走 SSH 浏览该挂载路径
      var isLocalHost = !host || host === '127.0.0.1' || host === 'localhost' || host === '::1';
      if (isLocalHost) return { kind:'df-local', mount: mount };
      return { kind:'df', mount: mount, srv: { host: host, port: 22, user: 'root', auth_type: 'pass', password: '' } };
    }
    if ((m = /^share:(.+)$/.exec(val))){
      var uid = m[1];
      var shares = _shares();
      var s = null;
      for (var j=0;j<shares.length;j++){ if (String(shares[j].uuid) === String(uid)){ s = shares[j]; break; } }
      return { kind:'share', uuid: uid, name: s ? s.name : uid };
    }
    if ((m = /^cloud:(.+)$/.exec(val))){
      var cid = m[1];
      var cls = _clouds();
      var c = null;
      for (var k2=0;k2<cls.length;k2++){
        if (String(cls[k2].uuid||'') === String(cid) || String(cls[k2].id) === String(cid)){ c = cls[k2]; break; }
      }
      return { kind:'cloud', cloudId: cid, name: c ? c.name : cid };
    }
    return { kind:'local' };
  }

  function _initialPath(d){
    if (!d) return '/';
    if (d.kind === 'share' && d.uuid) return SHARE_ROOT + d.uuid;
    if (d.kind === 'df-local' && d.mount) return d.mount;
    if (d.kind === 'df' && d.mount) return d.mount;
    return '/';
  }

  // ── 初始化 ──
  // v4.69.0 · 左栏滚动条样式 (细/主题色, 悬停加深)
  function _injectStyle(){
    if (document.getElementById('fppStyle')) return;
    var st = document.createElement('style');
    st.id = 'fppStyle';
    st.textContent = [
      // v4.96.0 · 滚动条高对比: 滑块 --text3 + hover 青色, 宽 12px, 不再隐形
      '#fpPageList::-webkit-scrollbar{width:12px;height:12px}',
      '#fpPageList::-webkit-scrollbar-track{background:var(--bg2);border-radius:6px}',
      '#fpPageList::-webkit-scrollbar-thumb{background:var(--text3);border-radius:6px;border:2px solid var(--bg2)}',
      '#fpPageList::-webkit-scrollbar-thumb:hover{background:var(--cyan)}',
      '#fpPageList{scrollbar-width:thin;scrollbar-color:var(--text3) var(--bg2)}',
      '.fpp-item{min-height:24px}',
      '.fpp-item.fpp-sel{background:var(--bg3);outline:1px solid var(--cyan)}',
      '#fpPagePreview .fp-body,#fpPagePreview pre{max-height:100%}',
    ].join('\n');
    document.head.appendChild(st);
  }

  function init(){
    _injectStyle();
    // v4.98.0 · 左栏/右栏之间可拖动调宽 (DOM 插入后再挂, 带重试)
    try {
      (function _mountGrip(tries){
        var cols = document.querySelector('.fpp-cols');
        var c1 = cols && cols.children[0], c2 = cols && cols.children[1];
        if (cols && c1 && c2 && window.RpUI && !cols.__rpGrip){
          cols.__rpGrip = true;
          cols.style.display = 'flex';
          window.RpUI.makeResizable(cols, [c1, c2], { key: 'rp_fpp_cols', minPx: 240 });
          return;
        }
        if ((tries || 0) < 12) setTimeout(function(){ _mountGrip((tries || 0) + 1); }, 250);
      })(0);
    } catch(e){}
    // v4.97.0 · 视图按钮: 事件委托 (DOM 后插入也能生效) + 初始高亮
    try {
      if (!document.__fppVmBound){
        document.__fppVmBound = true;
        document.addEventListener('click', function(ev){
          var b = ev.target && ev.target.closest ? ev.target.closest('.fpp-vm') : null;
          if (!b) return;
          ev.preventDefault(); ev.stopPropagation();
          setView(b.getAttribute('data-vm'));
        }, true);
      }
      setTimeout(function(){
        document.querySelectorAll('.fpp-vm').forEach(function(b){
          var on = b.getAttribute('data-vm') === _VIEW;
          b.style.background = on ? 'var(--cyan)' : 'transparent';
          b.style.color = on ? '#000' : 'var(--text2)';
        });
      }, 50);
    } catch(e){}
    _injectFullStyle();
    // v4.70.0 · 每次进入页面重置缩放/换行/行号 (切页不记忆)
    if (g.FilePreview && g.FilePreview.resetView) g.FilePreview.resetView();
    try { localStorage.setItem('fpp_appfull', '0'); } catch(e){}
    setTimeout(_syncFullBtn, 60);
    var root = $('panel-file_preview');
    if (!root) return;
    // 首次构建骨架
    if (!root.dataset.built){
      root.dataset.built = '1';
      root.innerHTML =
        '<div style="padding:12px">'+
          '<div style="display:flex;gap:8px;align-items:center;margin-bottom:10px;flex-wrap:wrap">'+
            '<span style="font-size:13px;font-weight:600">👁 文件预览</span>'+
            '<span style="font-size:11px;color:var(--text3)">左选源 → 浏览文件 → 单击即预览; 预览区可 ➕ 加入传输列表 (右键更多操作)</span>'+
            '<span style="flex:1"></span>'+
            // v4.70.0 · 全屏 (两栏区域占满视口)
            '<button class="btn btn-sm" id="fpPageFull" title="全屏显示下方两栏 (Esc 退出)">⛶ 全屏</button>'+
            '<button class="btn btn-sm" id="fpPageRefresh">↻ 刷新</button>'+
          '</div>'+
          // v4.69.0 · 固定高度: 使左栏 overflow:auto 真正生效 (独立滚动条),
          //   右栏同步固定 → 页面本体不滚动, 预览始终在可见区域
          '<div class="fpp-cols" style="display:flex;gap:2px;align-items:stretch;height:calc(100vh - 200px);min-height:420px;overflow:hidden">'+
            // 左栏: 源 + 文件列表
            '<div style="flex:0 0 340px;display:flex;flex-direction:column;border:1px solid var(--border);border-radius:8px;background:var(--bg2);overflow:hidden">'+
              '<div style="padding:8px 10px;background:var(--bg3);border-bottom:1px solid var(--border);font-size:12px;font-weight:600;color:var(--text2)">📚 源列表</div>'+
              '<div style="padding:6px 8px;border-bottom:1px solid var(--border)">'+
                '<select class="input" id="fpPageSrc" style="width:100%;font-size:12px"></select>'+
              '</div>'+
              '<div style="padding:5px 8px;background:var(--bg);border-bottom:1px solid var(--border);display:flex;gap:4px;align-items:center">'+
                '<input class="input" id="fpPagePath" value="/" style="flex:1;font-family:monospace;font-size:11px;min-width:0">'+
                '<button class="btn btn-sm" id="fpPageGo" style="padding:2px 7px;font-size:11px">前往</button>'+
                '<button class="btn btn-sm" id="fpPageUp" style="padding:2px 7px;font-size:11px" title="上级目录">⬆</button>'+
              '</div>'+
              // v4.71.0 · 搜索过滤 + 排序
              '<div style="padding:4px 8px;border-bottom:1px solid var(--border);background:var(--bg);display:flex;gap:4px;align-items:center">'+
                '<input class="input" id="fpFilter" placeholder="🔍 过滤 (支持 *.log)" style="flex:1;font-size:11px;min-width:0;height:24px">'+
                '<select class="input" id="fpSort" style="width:78px;font-size:10px;height:24px" title="排序字段">'+
                  '<option value="name">名称</option><option value="size">大小</option>'+
                  '<option value="mtime">时间</option><option value="type">类型</option>'+
                '</select>'+
                '<button class="btn btn-sm" id="fpSortDir" title="切换升/降序" style="padding:1px 6px;font-size:11px;height:24px">↑</button>'+
              '</div>'+
              // v4.97.0 · 左栏视图切换 (列表/图标/详情/相册)
              '<div style="padding:4px 8px;border-bottom:1px solid var(--border);display:flex;gap:4px;align-items:center;background:var(--bg)">'+
                '<span style="font-size:10px;color:var(--text3)">视图</span>'+
                '<span style="display:inline-flex;gap:2px;background:var(--bg3);border:1px solid var(--border);border-radius:6px;padding:2px">'+
                  ['list:☰:列表','icon:▦:图标','detail:📋:详情','gallery:🖼:相册'].map(function(v){
                    var p2 = v.split(':');
                    return '<button class="btn btn-sm fpp-vm" data-vm="'+p2[0]+'" title="'+p2[2]+'视图" style="padding:2px 8px;font-size:12px;border:none;background:transparent;color:var(--text2);cursor:pointer">'+p2[1]+'</button>';
                  }).join('')+
                '</span>'+
              '</div>'+
              // v4.71.0 · 新建 / 多选 / 分析 / 校验
              '<div style="padding:4px 8px;border-bottom:1px solid var(--border);display:flex;gap:4px;background:var(--bg);flex-wrap:wrap">'+
                '<button class="btn btn-sm" id="fpPageMkdir" style="padding:1px 7px;font-size:10px;flex:1;min-width:64px" title="在当前目录新建文件夹">📁 新建目录</button>'+
                '<button class="btn btn-sm" id="fpPageMkfile" style="padding:1px 7px;font-size:10px;flex:1;min-width:64px" title="在当前目录新建文本文件">📄 新建文件</button>'+
                '<button class="btn btn-sm" id="fpPageMulti" style="padding:1px 7px;font-size:10px;flex:1;min-width:56px" title="多选批量操作">☐ 多选</button>'+
                '<button class="btn btn-sm" id="fpPageAnalyze" style="padding:1px 7px;font-size:10px;flex:1;min-width:56px" title="当前目录空间占用分析">📊 分析</button>'+
              '</div>'+
              // v4.71.0 · 批量操作条 (多选模式显示)
              '<div id="fpSelBar" style="display:none;padding:4px 8px;border-bottom:1px solid var(--green);background:var(--green-bg);gap:4px;align-items:center;flex-wrap:wrap;font-size:10px">'+
                '<span id="fpSelCount" style="color:var(--green);font-weight:600">已选 0 项</span>'+
                '<span style="flex:1"></span>'+
                '<button class="btn btn-sm" id="fpSelAll" style="padding:1px 6px;font-size:10px">全选</button>'+
                '<button class="btn btn-sm" id="fpSelNone" style="padding:1px 6px;font-size:10px">清空</button>'+
                '<button class="btn btn-sm" id="fpSelCopy" style="padding:1px 6px;font-size:10px" title="复制到剪贴板 (目标目录 Ctrl+V)">📋 复制</button>'+
                '<button class="btn btn-sm" id="fpSelPaste" style="padding:1px 6px;font-size:10px" title="粘贴剪贴板内容到当前目录">📥 粘贴</button>'+
                '<button class="btn btn-sm" id="fpSelAdd" style="padding:1px 6px;font-size:10px;background:var(--green);color:#fff;border-color:var(--green)">➕ 加入传输</button>'+
                '<button class="btn btn-sm" id="fpSelSum" style="padding:1px 6px;font-size:10px" title="对选中项计算校验值">🔐 校验</button>'+
                '<button class="btn btn-sm" id="fpSelDel" style="padding:1px 6px;font-size:10px;color:var(--red)">🗑 删除</button>'+
              '</div>'+
              '<div id="fpPageList" class="fpp-list" style="flex:1 1 0;overflow-y:auto;overflow-x:hidden;min-height:0;padding:4px 4px 8px"></div>'+
              '<div id="fpPageStat" style="padding:4px 10px;background:var(--bg);border-top:1px solid var(--border);font-size:10px;color:var(--text3)"></div>'+
            '</div>'+
            // 右栏: 大预览区
            '<div style="flex:1;min-width:0;display:flex;flex-direction:column;border:1px solid var(--border);border-radius:8px;background:var(--bg2);overflow:hidden">'+
              '<div style="padding:8px 10px;background:var(--bg3);border-bottom:1px solid var(--border);font-size:12px;font-weight:600;color:var(--text2)">👁 预览区</div>'+
              // v5.3.0 · 面包屑 + 预览设置 移到右栏 (预览区顶部)
              '<div id="fpPageCrumb" style="padding:4px 10px;background:var(--bg3);border-bottom:1px solid var(--border);display:flex;align-items:center;gap:4px;flex-wrap:wrap;min-height:26px"></div>'+
              '<div id="fpPagePreview" style="flex:1 1 0;min-height:0;overflow:hidden;display:flex;flex-direction:column"></div>'+
            '</div>'+
          '</div>'+
        '</div>';
      $('fpPageRefresh').onclick = function(){ _load(ST.cwd || '/'); _renderSrcSelect(); _renderPreview(); };
      $('fpPageGo').onclick = function(){ _load($('fpPagePath').value || '/'); };
      $('fpPageUp').onclick = function(){
        var c = ST.cwd || '/';
        if (c === '/') return;
        var parts = c.replace(/\/$/,'').split('/'); parts.pop();
        _load(parts.join('/') || '/');
      };
      $('fpPagePath').onkeydown = function(ev){ if (ev.key === 'Enter') _load($('fpPagePath').value || '/'); };
      // v4.70.0 · 新建目录 / 新建文本文件
      $('fpPageMkdir').onclick = function(){ _createEntry('dir'); };
      $('fpPageMkfile').onclick = function(){ _createEntry('file'); };
      // v4.71.0 · 搜索/排序/多选/分析
      $('fpFilter').oninput = function(){ ST.filter = this.value; _renderList(); _updateSelBar(); };
      $('fpSort').onchange = function(){ ST.sortKey = this.value; _renderList(); };
      $('fpSortDir').onclick = function(){
        ST.sortAsc = !ST.sortAsc;
        this.textContent = ST.sortAsc ? '↑' : '↓';
        _renderList();
      };
      $('fpPageMulti').onclick = function(){ _toggleMulti(); };
      $('fpPageAnalyze').onclick = function(){ _storageAnalyze(); };
      $('fpSelAll').onclick = _selAll;
      $('fpSelNone').onclick = _selNone;
      $('fpSelCopy').onclick = _copySel;
      $('fpSelPaste').onclick = _pasteHere;
      $('fpSelAdd').onclick = _batchAddTransfer;
      $('fpSelSum').onclick = function(){
        var ps = _selPaths();
        if (!ps.length){ if (typeof toast === 'function') toast('⚠ 请先勾选文件', 'err'); return; }
        // 只对文件计算 (目录会被 sha256sum 拒绝)
        var filePath = '';
        var byPath = {};
        (ST.entries || []).forEach(function(en){
          var full = en.path || ((ST.cwd === '/' ? '' : ST.cwd.replace(/\/+$/,'')) + '/' + en.name);
          byPath[full] = en;
        });
        for (var i = 0; i < ps.length; i++){
          var en2 = byPath[ps[i]];
          if (!en2 || en2.type !== 'dir'){ filePath = ps[i]; break; }
        }
        if (!filePath){
          if (typeof toast === 'function') toast('⚠ 选中的都是目录, 校验仅支持文件 (可在右键菜单对单个文件校验)', 'warn', 4200);
          return;
        }
        if (ps.length > 1 && typeof toast === 'function'){
          toast('校验仅针对单个文件, 已选取第一个文件', 'info', 3000);
        }
        _checksum(filePath);
      };
      $('fpSelDel').onclick = _batchDelete;
      // 快捷键 Ctrl+F 聚焦过滤框 / Ctrl+V 粘贴
      if (g.Hotkeys && g.Hotkeys.bind){
        g.Hotkeys.bind('focusSearch', function(){
          if (g._currentPanelKey !== 'file_preview') return false;
          var f = $('fpFilter'); if (f){ f.focus(); f.select(); return true; }
          return false;
        });
      }
      document.addEventListener('keydown', function(ev){
        if (g._currentPanelKey !== 'file_preview') return;
        var t = ev.target || {};
        var tag = (t.tagName || '').toUpperCase();
        if ((ev.ctrlKey || ev.metaKey) && (ev.key === 'v' || ev.key === 'V') &&
            tag !== 'INPUT' && tag !== 'TEXTAREA' && ST.clipboard){
          ev.preventDefault(); _pasteHere();
        }
      });
      // v4.70.0 · 全屏切换 (优先浏览器原生全屏)
      $('fpPageFull').onclick = function(){ _toggleFull(); };
      document.addEventListener('fullscreenchange', _syncFullBtn);
      // v4.71.0 · 拖拽上传: 从桌面拖文件进列表 → 上传到当前目录
      (function(){
        var list = $('fpPageList');
        if (!list) return;
        var stop = function(ev){ ev.preventDefault(); ev.stopPropagation(); };
        list.addEventListener('dragover', function(ev){
          stop(ev); list.style.outline = '2px dashed var(--green)'; list.style.outlineOffset = '-4px';
        });
        list.addEventListener('dragleave', function(ev){ stop(ev); list.style.outline = ''; });
        list.addEventListener('drop', function(ev){
          stop(ev); list.style.outline = '';
          var files = ev.dataTransfer && ev.dataTransfer.files;
          if (!files || !files.length) return;
          _uploadFiles(files);
        });
      })();
      // Esc 退出应用内全屏 (原生全屏由浏览器处理)
      document.addEventListener('keydown', function(ev){
        if (ev.key === 'Escape'){
          var bx = document.querySelector('#panel-file_preview .fpp-cols');
          if (bx && bx.classList.contains('fpp-appfull')){
            bx.classList.remove('fpp-appfull');
            try { localStorage.setItem('fpp_appfull', '0'); } catch(e){}
            _syncFullBtn();
          }
        }
      });
      $('fpPageSrc').onchange = function(){
        ST.value = this.value;
        ST.src = _resolveSrc(this.value);
        ST.cur = null;
        _renderPreview();
        _load(_initialPath(ST.src));
        _updateStat();
      };
    }
    _renderSrcSelect();
    if (!ST.inited){
      ST.inited = true;
      ST.src = _resolveSrc(ST.value || 'local');
      _load(_initialPath(ST.src));
      _renderPreview();
    }
    _updateStat();
  }

  // ── v4.70.0 · 新建目录 / 新建文本文件 ──
  function _createEntry(kind){
    var cc = _srcConn();
    var isDir = (kind === 'dir');
    var name = g.prompt(isDir ? '新建目录名 (可多级, 如 a/b):' : '新建文件名 (如 notes.txt):',
                        isDir ? '新建文件夹' : '新建文本.txt');
    if (!name) return;
    name = String(name).trim().replace(/^\/+/, '');
    if (!name){ if (typeof toast === 'function') toast('⚠ 名称不能为空', 'err'); return; }
    if (!isDir && name.indexOf('.') < 0) name += '.txt';
    var base = (ST.cwd === '/' ? '' : String(ST.cwd).replace(/\/+$/, ''));
    var full = base + '/' + name;
    if (isDir){
      rpc('file_mkdir', Object.assign({path: full}, cc.conn)).then(function(r){
        if (typeof toast === 'function'){
          toast(r.status === 'ok' ? '✓ 目录已创建: ' + name : '✗ ' + (r.msg || '创建失败'),
                r.status === 'ok' ? 'success' : 'err', 3200);
        }
        if (r.status === 'ok') _load(ST.cwd);
      });
      return;
    }
    // 文件: 可先填内容
    var content = g.prompt('文件初始内容 (可留空):', '');
    if (content == null) content = '';
    rpc('file_write', Object.assign({path: full, content: content}, cc.conn)).then(function(r){
      if (typeof toast === 'function'){
        toast(r.status === 'ok' ? '✓ 文件已创建: ' + name : '✗ ' + (r.msg || '创建失败'),
              r.status === 'ok' ? 'success' : 'err', 3200);
      }
      if (r.status === 'ok'){
        _load(ST.cwd);
        // 新建后自动选中并进入编辑态
        setTimeout(function(){
          ST.cur = { side: cc.side, path: full, name: name, conn: cc.conn };
          _renderPreview();
          var pv = $('fpPagePreview');
          if (pv && g.FilePreview && g.FilePreview.editInline) g.FilePreview.editInline(pv, ST.cur);
        }, 900);
      }
    });
  }

  // ── v4.70.0 · 全屏 (两栏区域占满视口) ──
  function _toggleFull(){
    var box = document.querySelector('#panel-file_preview .fpp-cols');
    if (!box) return;
    if (document.fullscreenElement){
      try { document.exitFullscreen(); } catch(e){}
      return;
    }
    // v4.70.0 · 原生全屏需真实用户手势; 不可用时(或被拒绝)自动回退到应用内全屏
    var box2 = box;
    var settled = false;
    var fallback = function(){
      if (settled) return;
      settled = true;
      var on = box2.classList.toggle('fpp-appfull');
      try { localStorage.setItem('fpp_appfull', on ? '1' : '0'); } catch(e){}
      _syncFullBtn();
    };
    if (box.requestFullscreen){
      try {
        var pr = box.requestFullscreen();
        if (pr && typeof pr.then === 'function'){
          pr.then(function(){ settled = true; _syncFullBtn(); }).catch(function(){ fallback(); });
        }
        setTimeout(fallback, 400);   // 400ms 内未进入原生全屏 → 应用内全屏兜底
      } catch(e){ fallback(); }
    } else { fallback(); }
  }
  function _isFull(){
    var box = document.querySelector('#panel-file_preview .fpp-cols');
    return !!document.fullscreenElement || !!(box && box.classList.contains('fpp-appfull'));
  }
  function _syncFullBtn(){
    var on = _isFull();
    var b = $('fpPageFull');
    if (b){
      b.textContent = on ? '⛶ 退出全屏' : '⛶ 全屏';
      b.style.background = on ? 'var(--green)' : '';
      b.style.color = on ? '#fff' : '';
      b.style.borderColor = on ? 'var(--green)' : '';
    }
    // v4.70.1 · 预览区工具栏的"全屏"按钮同步同态 (用户要求退出全屏按钮放在"加入传输"前)
    if (g.FilePreview && g.FilePreview.syncFullBtns) g.FilePreview.syncFullBtns(on);
  }
  // 应用内全屏样式 (兜底)
  function _injectFullStyle(){
    if (document.getElementById('fppFullStyle')) return;
    var st = document.createElement('style');
    st.id = 'fppFullStyle';
    st.textContent = [
      '.fpp-cols.fpp-appfull{position:fixed !important;inset:0 !important;z-index:99998;'+
        'height:100vh !important;padding:10px;background:var(--bg);margin:0 !important}',
    ].join('\n');
    document.head.appendChild(st);
  }
  // 页面离开时退出应用内全屏 (切 tab 不残留)
  function _onLeave(){
    var box = document.querySelector('#panel-file_preview .fpp-cols');
    if (box && box.classList.contains('fpp-appfull')){
      box.classList.remove('fpp-appfull');
      try { localStorage.setItem('fpp_appfull', '0'); } catch(e){}
      _syncFullBtn();
    }
    if (document.fullscreenElement){ try { document.exitFullscreen(); } catch(e){} }
  }

  function _updateStat(){
    var el = $('fpPageStat');
    if (!el) return;
    var cc = _srcConn();
    el.textContent = _srcLabel() + (cc.side === 'remote' ? (' · ' + cc.conn.user + '@' + cc.conn.host) : ' · 本机通路') +
      ' · ' + (ST.entries || []).length + ' 项';
  }

  g.FilePreviewPage = {
    // v4.97.0 · 供传输完成后自动刷新
    reloadSource: function(){ try { _renderList(); } catch(e){} }, init: init, load: _load, onLeave: _onLeave, createEntry: _createEntry,
                        toggleFull: _toggleFull, isFull: _isFull,
                        refreshSources: function(){ _renderSrcSelect(); } };
})(window);
