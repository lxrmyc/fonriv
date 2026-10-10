/* ============================================================================
 * file_preview.js · v4.66.0 · 内联文件预览渲染器 (可嵌入任意容器)
 *  - FilePreview.render(host, opts) 把预览渲染到指定容器 (非模态)
 *  - 支持: 文本/代码(带编辑) · 图片 · PDF · 音频 · 视频 · 压缩包列表 · 未知类型
 *  - 工具栏: 加入传输 / 编辑 / 下载 / 重命名 / 删除 / 压缩 / 解压 / 属性
 *  - 依赖: window.FileOps (rpc/工具) · window.send · window.toast
 *  opts = { side:'local'|'remote', path, name, onAddTransfer(path,entry),
 *           onChanged(), height }
 * ========================================================================== */
(function(g){
  'use strict';

  // v5.17.0 · 目录级 stream token 共享缓存
  //   问题: 左栏缩略图 + 中栏预览各自对同一目录重复签发 token → WS 请求排队 → "点图片很慢";
  //   且 token 服务端 TTL 为 900s, 完全没有必要每次点击都重新签发。
  //   这里做 10 分钟本地复用 (跨组件共享 window.__rpStreamTok), 并允许显式失效。
  var _TOK_TTL_MS = 10 * 60 * 1000;
  function getDirToken(dir, cb){
    dir = String(dir || '/');
    window.__rpStreamTok = window.__rpStreamTok || {};
    var e = window.__rpStreamTok[dir];
    if (e && e.token && (Date.now() - e.ts) < _TOK_TTL_MS){ try { cb(e.token, true); } catch(_){} return; }
    rpc('file_stream_token', { path: dir }).then(function(r){
      if (r && r.status === 'ok' && r.token){
        window.__rpStreamTok[dir] = { token: r.token, ts: Date.now() };
        try { cb(r.token, false); } catch(_){}
      } else { try { cb('', false); } catch(_){} }
    });
  }
  function invalidateDirToken(dir){
    try {
      if (dir && window.__rpStreamTok) delete window.__rpStreamTok[String(dir)];
      else window.__rpStreamTok = {};
    } catch(_){}
  }
  window.RpStreamToken = { get: getDirToken, invalidate: invalidateDirToken };

  // v5.16.0 · base64 → 文本 (UTF-8 安全)。旧实现用 atob() 得到 latin1 字符串,
  //   中文/emoji 会变成乱码 ('ä½ å¥½'), 云端文本预览与分块预览都受影响。
  function b64ToText(b64){
    try {
      var bin = atob(b64 || '');
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      if (typeof TextDecoder === 'function') return new TextDecoder('utf-8').decode(bytes);
      return bin;
    } catch(e){ return ''; }
  }
  function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g,function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function toast(msg, kind, ms){ if (typeof g.toast==='function') g.toast(msg, kind, ms||2600); }

  function rpc(action, data){
    return new Promise(function(resolve){
      try { g.send(Object.assign({action:action}, data||{}), function(r){ resolve(r||{}); }); }
      catch(e){ resolve({status:'error', msg:String(e)}); }
    });
  }
  // v4.96.0 · 目录类请求: 委托给 app.js 的 rpcDirAction (带 socket 重试, 抗切 tab 竞态)
  function rpcWS(action, data, timeoutMs){
    if (typeof window.rpcDirAction === 'function') return window.rpcDirAction(action, data, timeoutMs);
    // 兜底: 退化为基础实现
    return new Promise(function(resolve){
      if (typeof g.openWs !== 'function'){ resolve({ status:'error', msg:'WebSocket 未就绪' }); return; }
      var rid = '_fpv_' + Date.now().toString(36);
      g.openWs(function(ws){
        var handler = function(ev){
          var d; try { d = JSON.parse(ev.data); } catch(e){ return; }
          if (!d || d.req_id !== rid) return;
          try { ws.removeEventListener('message', handler); } catch(e){}
          resolve(d);
        };
        ws.addEventListener('message', handler);
        try { _rpSendWhenReady(ws, Object.assign({action:action, req_id:rid}, data||{}), undefined, function(){ try { console.warn('[ws] 发送失败'); } catch(_){} }) } catch(e){ resolve({status:'error',msg:String(e)}); }
        setTimeout(function(){ resolve({ status:'error', msg:'请求超时' }); }, timeoutMs || 25000);
      }).catch(function(err){ resolve({ status:'error', msg:String(err&&err.message||err) }); });
    });
  }

  var IMG = {jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',gif:'image/gif',webp:'image/webp',
             svg:'image/svg+xml',bmp:'image/bmp',ico:'image/x-icon'};
  var AUDIO = {mp3:1,flac:1,wav:1,ogg:1,m4a:1,aac:1};
  var VIDEO = {mp4:1,mkv:1,webm:1,avi:1,mov:1,m4v:1};
  var ARCHIVE = ['.tar.gz','.tgz','.tar.bz2','.tbz2','.tbz','.tar.xz','.txz',
                 '.tar.zst','.tzst','.tar.lz4','.tar','.zip','.jar','.war','.apk','.7z','.rar'];
  var TEXT = ['txt','md','json','yaml','yml','xml','html','htm','css','js','ts','py','sh','bash',
              'conf','cfg','ini','env','log','csv','sql','go','rs','java','c','h','cpp','hpp','rb',
              'php','pl','lua','toml','properties','service','timer','desktop','list','rules','out',
              'gitignore','editorconfig','makefile','cmake','lock','pub','pem','crt','patch','diff'];

  function ext(n){ var p=String(n||'').toLowerCase().split('.'); return p.length>1?p[p.length-1]:''; }
  function isImg(n){ return !!IMG[ext(n)]; }
  function isAudio(n){ return !!AUDIO[ext(n)]; }
  function isVideo(n){ return !!VIDEO[ext(n)]; }
  function isArchive(n){
    var l = String(n||'').toLowerCase();
    for (var i=0;i<ARCHIVE.length;i++){ if (l.lastIndexOf(ARCHIVE[i])>=0 && l.endsWith(ARCHIVE[i])) return true; }
    return false;
  }
  function isText(n){ var e=ext(n); return !e || TEXT.indexOf(e)>=0; }
  function fmtB(b){
    b = Number(b)||0;
    var u=['B','KB','MB','GB','TB'], i=0;
    while (b>=1024 && i<u.length-1){ b/=1024; i++; }
    return (i? b.toFixed(1): b) + ' ' + u[i];
  }
  function kindOf(name){
    if (isImg(name)) return '图片';
    if (isAudio(name)) return '音频';
    if (isVideo(name)) return '视频';
    if (/\.pdf$/i.test(name)) return 'PDF';
    if (isArchive(name)) return '压缩包';
    if (isText(name)) return '文本';
    return '二进制';
  }

  var _cur = null;   // { host, opts, kind, mode }
  var _syncFullBtns = null;
  // v4.87.0 · A2 多标签编辑
  var _editTabs = [];    // [{id, name, path, side, domId, dirty}]
  var _activeTab = -1;   // v4.70.1 · 宿主全屏状态变化时同步工具栏按钮

  // v4.70.0 · 视图状态记忆: 换文件不重置, 切换页面时 resetView() 恢复默认
  //   zoomMode: 'fit' = 适应窗口(默认) | 'zoom' = 按 zoomScale 固定倍率
  var VIEW = { zoomMode: 'fit', zoomScale: 1, wrap: false, lineNo: true };
  function resetView(){
    VIEW.zoomMode = 'fit'; VIEW.zoomScale = 1; VIEW.wrap = false; VIEW.lineNo = true;
  }
  function currentView(){ return { zoomMode: VIEW.zoomMode, zoomScale: VIEW.zoomScale,
                                   wrap: VIEW.wrap, lineNo: VIEW.lineNo }; }

  function _toolbar(){
    return '' +
      // v1.0.0 · 用户要求: 一行放不下就**换行**(取消横向滚动), 且上下两行的按钮/图标对齐
      '<div class="fp-toolbar" style="display:flex;align-items:center;align-content:center;gap:6px;row-gap:4px;padding:5px 10px;background:var(--bg3);'+
      'border-bottom:1px solid var(--border);flex-wrap:wrap;min-height:28px;font-size:11px">'+
        '<span class="fp-name" style="font-weight:600;color:var(--text);font-family:monospace;overflow:hidden;'+
        'text-overflow:ellipsis;white-space:nowrap;max-width:34%;flex:0 1 auto"></span>'+
        '<span class="fp-kind" style="font-size:10px;padding:1px 6px;border-radius:8px;background:var(--bg2);color:var(--cyan);border:1px solid var(--border)"></span>'+
        '<span style="flex:1;min-width:6px"></span>'+
        '<button class="btn btn-sm fp-btn-full" title="全屏 / 退出全屏 (快捷键 F11 或 Ctrl+Shift+F)" style="padding:1px 8px;font-size:10px;flex:0 0 auto">⛶ 全屏</button>'+
        '<button class="btn btn-sm fp-btn-add" title="把此文件加入传输列表" style="padding:1px 8px;font-size:10px;flex:0 0 auto;background:var(--green);color:#fff;border-color:var(--green)">➕ 加入传输</button>'+
        // v5.6.0 · 直接传输: 加入队列后立即发起 (省去再去中栏点"开始传输")
        '<button class="btn btn-sm fp-btn-direct" title="把此文件加入传输列表并立即开始传输" style="padding:1px 8px;font-size:10px;flex:0 0 auto;background:var(--accent,#3498db);color:#fff;border-color:var(--accent,#3498db)">⚡ 直接传输</button>'+
        '<button class="btn btn-sm fp-btn-edit" style="padding:1px 8px;font-size:10px;flex:0 0 auto">✏️ 编辑</button>'+
        '<button class="btn btn-sm fp-btn-dl" style="padding:1px 8px;font-size:10px;flex:0 0 auto">⬇ 下载</button>'+
        '<button class="btn btn-sm fp-btn-arch" style="padding:1px 8px;font-size:10px;flex:0 0 auto">📦 浏览包</button>'+
        '<button class="btn btn-sm fp-btn-extract" style="padding:1px 8px;font-size:10px;flex:0 0 auto">📤 解压</button>'+
        '<button class="btn btn-sm fp-btn-zip" style="padding:1px 8px;font-size:10px;flex:0 0 auto">🗜 压缩</button>'+
        '<button class="btn btn-sm fp-btn-ren" style="padding:1px 8px;font-size:10px;flex:0 0 auto">✏️ 重命名</button>'+
        '<button class="btn btn-sm fp-btn-info" style="padding:1px 8px;font-size:10px;flex:0 0 auto">ℹ️ 属性</button>'+
        '<button class="btn btn-sm fp-btn-del" style="padding:1px 8px;font-size:10px;flex:0 0 auto;color:var(--red)">🗑 删除</button>'+
      '</div>';
  }

  // ── 主入口 ──
  function render(host, opts){
    // v4.70.1 · 每次渲染都是全新视图 → 清掉上一次的编辑态标记
    //   (此前 _editing 残留导致编辑按钮的 isEditing() 守卫直接 return, 表现为"保存后不能再编辑")
    _editing = null;
    if (!host) return;
    if (!opts || !opts.path){
      host.innerHTML = '<div style="padding:24px 16px;text-align:center;color:var(--text3);font-size:12px;line-height:2">'+
        '📄 在左侧或右侧栏<b>单击文件</b>即可在此预览<br>'+
        '<span style="font-size:11px">支持 文本/代码 · 图片 · PDF · 音频 · 视频 · 压缩包<br>预览后可直接 ➕ 加入传输列表</span></div>';
      _cur = null;
      return;
    }
    var name = opts.name || String(opts.path).split('/').filter(Boolean).pop() || '';
    var kind = kindOf(name);
    _cur = { host: host, opts: opts, kind: kind, name: name };

    host.innerHTML = _toolbar() +
      '<div class="fp-body" style="flex:1;overflow:auto;padding:10px;min-height:0;display:flex;flex-direction:column"></div>';
    host.querySelector('.fp-name').textContent = name;
    host.querySelector('.fp-kind').textContent = kind;
    // 按类型显隐工具按钮
    var show = { arch: isArchive(name), extract: isArchive(name), edit: isText(name) && !isArchive(name) };
    // v5.6.0 · 直接传输按钮: 仅在调用方提供 onDirectTransfer 时显示 (目录/无传输上下文隐藏)
    try {
      var db = host.querySelector('.fp-btn-direct');
      if (db) db.style.display = (typeof opts.onDirectTransfer === 'function') ? '' : 'none';
    } catch(e){}
    ['arch','extract','edit'].forEach(function(k){
      var b = host.querySelector('.fp-btn-' + (k === 'arch' ? 'arch' : k === 'extract' ? 'extract' : 'edit'));
      if (b) b.style.display = show[k] ? '' : 'none';
    });
    _bindToolbar(host, opts);

    var body = host.querySelector('.fp-body');
    // v4.97.0 · 目录内导航: ⬅返回目录 + ‹上一张/下一张› (图片/音频/视频)
    if (opts._navList && opts._navList.length > 1){
      var bar = document.createElement('div');
      bar.style.cssText = 'display:flex;align-items:center;gap:8px;padding:5px 10px;background:var(--bg3);border-bottom:1px solid var(--border);font-size:11px;flex:0 0 auto';
      var idx = opts._navIdx || 0;
      bar.innerHTML =
        '<button class="btn btn-sm fp-nav-back" style="padding:2px 9px;font-size:11px">⬅ 返回目录</button>' +
        '<span class="fp-nav-pos" style="color:var(--text3);min-width:64px;text-align:center">' + (idx+1) + ' / ' + opts._navList.length + '</span>' +
        '<span style="flex:1"></span>' +
        '<span style="color:var(--text3)">点图片左/右侧翻页 · ← → 键 · Esc 返回目录</span>';
      host.insertBefore(bar, body);
      function _go(delta){
        var n = (opts._navIdx || 0) + delta;
        if (n < 0) n = opts._navList.length - 1;
        if (n >= opts._navList.length) n = 0;
        var e2 = opts._navList[n];
        var p2 = e2.path || ((opts._navDir || '').replace(/\/$/, '') + '/' + e2.name);
        // v5.1.0 · 同类型图片/音视频 → 原地换 src (不整块重渲染, 避免"页面刷新"感与闪烁)
        try {
          var curImg = host.querySelector('.fp-img');
          var curVid = host.querySelector('video, audio');
          var MEDIA_IMG = /\.(jpe?g|png|gif|webp|svg|bmp|avif)$/i;
          var MEDIA_AV = /\.(mp4|mkv|webm|mov|mp3|flac|wav|m4a|ogg)$/i;
          var curName = (opts.name || '');
          if (curImg && MEDIA_IMG.test(curName) && MEDIA_IMG.test(e2.name || '')){
            opts._navIdx = n; opts.path = p2; opts.name = e2.name; opts._size = e2.size || 0;
            var posEl = host.querySelector('.fp-nav-pos');
            if (posEl) posEl.textContent = (n + 1) + ' / ' + opts._navList.length;
            var nmEl = host.querySelector('.fp-name');
            if (nmEl) nmEl.textContent = e2.name;
            var cb = _connOf(opts);
            if (cb && cb.host){
              rpc('file_read_raw', Object.assign({ path: p2 }, cb)).then(function(r2){
                if (r2.status === 'ok' && curImg.isConnected){
                  curImg.src = 'data:image/*;base64,' + r2.content_b64;
                  curImg.dataset.zoom = 1; curImg.style.width = ''; curImg.style.transform = ''; curImg.style.marginLeft = ''; curImg.style.marginTop = '';
                  curImg.style.cursor = 'auto';
                }
              });
            } else {
              getDirToken(String(p2 || '').replace(/\/[^\/]*$/, '') || '/', function(tok2){
                if (tok2 && curImg.isConnected){
                  curImg.src = '/api/file/stream?path=' + encodeURIComponent(p2) + '&st=' + encodeURIComponent(tok2);
                  curImg.dataset.zoom = 1; curImg.style.width = ''; curImg.style.transform = ''; curImg.style.marginLeft = ''; curImg.style.marginTop = '';
                  curImg.style.cursor = 'auto';
                }
              });
            }
            return;
          }
          if (curVid && MEDIA_AV.test(e2.name || '')){
            // 音视频: 仅换 src, 保留控件 vs 重建 (视频需重新加载元数据 → 轻量重建)
          }
        } catch(_eNav){}
        render(host, Object.assign({}, opts, {
          path: p2, name: e2.name, _size: e2.size || 0, _isDir: false,
          _navList: opts._navList, _navIdx: n, _navDir: opts._navDir,
        }));
      }
      bar.querySelector('.fp-nav-back').onclick = function(){
        render(host, { path: opts._navDir, name: (opts._navDir||'').split('/').filter(Boolean).pop()||'',
                       side: opts.side, conn: opts.conn, _isDir: true,
                       onAddTransfer: opts.onAddTransfer, onDirectTransfer: opts.onDirectTransfer, onChanged: opts.onChanged });
      };
      host._fpGo = _go;   // v5.0.0 · 供图片左右点击区调用
      host._fpNavKeys = function(ev){
        if (ev.key === 'ArrowLeft'){ _go(-1); return true; }
        if (ev.key === 'ArrowRight'){ _go(1); return true; }
        if (ev.key === 'Escape'){ render(host, { path: opts._navDir, side: opts.side, conn: opts.conn, _isDir: true,
                                                 name: (opts._navDir||'').split('/').filter(Boolean).pop()||'',
                                                 onAddTransfer: opts.onAddTransfer, onDirectTransfer: opts.onDirectTransfer, onChanged: opts.onChanged }); return true; }
        return false;
      };
    } else {
      host._fpNavKeys = null;
    }
    // v4.70.0 · 预览区任意位置右键 → 与工具栏一致的功能菜单
    host.oncontextmenu = function(ev){
      if (ev.target && ev.target.closest && ev.target.closest('input,textarea')) return;
      _previewContextMenu(ev, host, { side: opts.side, path: opts.path, name: name,
                                      conn: opts.conn, onAddTransfer: opts.onAddTransfer,
                                      onDirectTransfer: opts.onDirectTransfer,
                                      onChanged: opts.onChanged });
    };
    // v4.96.0 · 目录 → 目录浏览视图 (缩略图/列表切换), 由上层传入 _isDir 标记
    // v5.4.0 · 云端文件: 文本/图片已单独处理; 其余类型给明确提示 (避免落到本地通路报"文件不存在")
    if (opts.cloudId != null && !opts._isDir && !isText(name) && !isImg(name)){
      body.innerHTML = '<div style="padding:22px 16px;text-align:center;color:var(--text3);font-size:12px;line-height:2">'+
        '☁ 云端文件 (无法内联预览该类型)<br>'+
        '<span style="font-size:11px">' + esc(name) + '<br>可点上方 ⬇ 下载 或 ➕ 加入传输列表 后查看</span></div>';
      ['arch','extract','edit'].forEach(function(k){ var bb = host.querySelector('.fp-btn-' + k); if (bb) bb.style.display = 'none'; });
      return;
    }
    if (opts._isDir){
      host.querySelector('.fp-kind').textContent = '目录';
      return _renderDir(body, opts);
    }
    if (isImg(name)) return _renderImage(body, opts, name);
    if (opts.path && opts.cloudId != null && isText(name)) return _renderTextCloud(body, opts, name);
    if (isAudio(name)) return _renderMedia(body, opts, name, 'audio');
    if (isVideo(name)) return _renderMedia(body, opts, name, 'video');
    if (/\.pdf$/i.test(name)) return _renderPdf(body, opts, name);
    if (isArchive(name)) return _renderArchive(body, opts, name);
    if (isText(name)) return _renderText(body, opts, name);
    return _renderUnknown(body, opts, name);
  }

  // ── v4.96.0 · 目录浏览视图: 缩略图网格(图片) + 列表两种方式 ──
  var _DIR_IMG_RE = /\.(jpe?g|png|gif|webp|svg|bmp|avif)$/i;
  function _renderDir(body, opts){
    // v5.2.0 · 仅预览模式: 目录视图整体不渲染 (由调用方门控, 这里再兜一层)
    try {
      var _scope = opts._pmScope || null;
      if (_scope && window.RpUI && window.RpUI.modeOf(_scope) === 'preview'){
        body.innerHTML = '<div style="padding:20px;color:var(--text3);font-size:12px;text-align:center">👁 当前为「仅预览」模式<br><span style="font-size:11px">请在左侧列表单击文件进行预览 (可在 ⚙ 预览设置 中改为「目录浏览 + 预览」)</span></div>';
        return;
      }
    } catch(e){}
    var conn = _connOf(opts);
    var self_ = body;
    body.innerHTML = '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap">' +
      // v4.97.0 · 从图片大图返回目录
      '<button class="btn btn-sm fp-dir-back" style="display:none;padding:2px 9px;font-size:11px">⬅ 返回目录</button>' +
      // v5.17.0 · 目录浏览+预览模式: 预览区的"返回上级目录" (原实现只能在图片大图态回同目录, 进了子目录就出不去)
      '<button class="btn btn-sm fp-dir-up" style="display:none;padding:2px 9px;font-size:11px" title="返回上一级目录">⬅ 上级目录</button>' +
      '<span style="font-size:12px;color:var(--text2);font-family:monospace;overflow:hidden;text-overflow:ellipsis">' + esc(opts.path) + '</span>' +
      '<span style="flex:1"></span>' +
      '<span class="fp-dir-vm" style="display:inline-flex;gap:2px;background:var(--bg3);border:1px solid var(--border);border-radius:6px;padding:2px">' +
      '<button class="btn btn-sm fp-dir-thumb" style="padding:3px 10px;font-size:12px;border:none;background:var(--cyan);color:#000;cursor:pointer">🖼 缩略图</button>' +
      '<button class="btn btn-sm fp-dir-list" style="padding:3px 10px;font-size:12px;border:none;background:transparent;color:var(--text2);cursor:pointer">📋 列表</button>' +
      '</span></div>' +
      '<div class="fp-dir-body" style="flex:1;overflow:auto;min-height:0;color:var(--text3);font-size:12px">⏳ 读取目录…</div>';
    var dbody = body.querySelector('.fp-dir-body');
    var vm = 'thumb';  // thumb | list
    var entries = [];
    // v5.17.0 · 上级目录按钮: 非根目录时显示
    var _upBtn = body.querySelector('.fp-dir-up');
    if (_upBtn){
      var _curP = String(opts.path || '').replace(/\/+$/, '');
      var _parentP = _curP.split('/').slice(0, -1).join('/') || '/';
      if (_curP && _curP !== '/'){
        _upBtn.style.display = '';
        _upBtn.onclick = function(){
          var cc = _connOf(opts);
          render(body.parentElement || body, {
            path: _parentP, name: _parentP.split('/').filter(Boolean).pop() || '',
            side: opts.side, conn: cc, cloudId: opts.cloudId,
            _isDir: true, _pmScope: opts._pmScope,
            onAddTransfer: opts.onAddTransfer, onDirectTransfer: opts.onDirectTransfer,
            onChanged: opts.onChanged,
          });
        };
      }
    }

    function listEntries(){
      // v5.5.0 · 云端目录必须走 remote_ls (旧实现按 conn.host 判定 → 云端 key 落到本机 list_dir,
      //   后端上溯到祖先目录 → 整棵导航树跑到本机 FS, 出现 /etc→/home/... 错乱)
      var action = (opts.cloudId != null) ? 'remote_ls'
                 : (conn.host ? 'list_remote_dir' : 'list_dir');
      // v5.7.0 · remote_ls 必须带 remote_id (旧实现漏传 → 目标为云端时预览报"缺少 remote_id")
      var _cloudPayload = (opts.cloudId != null) ? { remote_id: opts.cloudId } : {};
      rpcWS(action, Object.assign({ path: opts.path }, _cloudPayload, opts.cloudId != null ? {} : conn)).then(function(r){
        if (!self_.isConnected) return;
        if (r.status !== 'ok' && r.status !== 'success'){
          dbody.innerHTML = '<span style="color:var(--red)">✗ ' + esc(r.msg || '读取失败') + '</span>';
          return;
        }
        entries = (r.entries || r.files || []).map(function(e){
          if (!e) return e;
          if (e.is_dir !== undefined && e.type === undefined) e.type = e.is_dir ? 'dir' : 'file';
          if (e.type !== undefined && e.is_dir === undefined) e.is_dir = (e.type === 'dir');
          // 云端条目 path 可能是相对 key → 补全成完整 key 便于后续预览
          if (opts.cloudId != null && !e.path) e.path = (opts.path ? String(opts.path).replace(/\/+$/,'') + '/' : '') + e.name;
          return e;
        });
        renderEntries();
      });
    }
    function thumbSrc(p){
      if (conn.host) return '';  // 远端: 异步签发 token
      try {
        var tk = localStorage.getItem('auth_token') || '';
        return '/api/download?path=' + encodeURIComponent(p) + '&token=' + encodeURIComponent(tk);
      } catch(e){ return ''; }
    }
    function openItem(e){
      var p = e.path || (opts.path.replace(/\/$/, '') + '/' + e.name);
      if (e.type === 'dir'){
        render(body.parentElement, { path: p, name: e.name, side: opts.side, conn: opts.conn, _isDir: true, onAddTransfer: opts.onAddTransfer, onDirectTransfer: opts.onDirectTransfer, onChanged: opts.onChanged });
        return;
      }
      // v4.97.0 · 文件 → 单文件预览; 图片/音视频附带同目录导航列表 (支持上/下一张)
      var MEDIA_RE = /\.(jpe?g|png|gif|webp|svg|bmp|avif|mp4|mkv|webm|mov|mp3|flac|wav|m4a|ogg)$/i;
      var navList = null, navIdx = 0;
      if (MEDIA_RE.test(e.name || '')){
        navList = entries.filter(function(x){ return x.type !== 'dir' && MEDIA_RE.test(x.name || ''); })
                         .sort(function(a, b){ return String(a.name).localeCompare(String(b.name)); });
        navIdx = Math.max(0, navList.findIndex(function(x){ return x.name === e.name; }));
      }
      render(body.parentElement, { path: p, name: e.name, side: opts.side, conn: opts.conn, _size: e.size || 0,
                                   _navList: navList, _navIdx: navIdx, _navDir: opts.path,
                                   onAddTransfer: opts.onAddTransfer, onDirectTransfer: opts.onDirectTransfer, onChanged: opts.onChanged });
    }
    function renderEntries(){
      var sorted = entries.slice().sort(function(a, b){
        if ((a.type === 'dir') !== (b.type === 'dir')) return a.type === 'dir' ? -1 : 1;
        return String(a.name).localeCompare(String(b.name));
      });
      if (vm === 'thumb'){
        var media = sorted.filter(function(e){ return e.type === 'dir' || _DIR_IMG_RE.test(e.name || '') || /\.(mp4|mkv|webm|mp3|flac|wav)$/i.test(e.name || ''); });
        if (!media.length){ dbody.innerHTML = '<span style="color:var(--text3)">本目录没有可预览的图片/音视频, 请切到列表视图</span>'; return; }
        dbody.innerHTML = '<div style="display:flex;flex-wrap:wrap;gap:10px">' + media.map(function(e, i){
          var p = e.path || (opts.path.replace(/\/$/, '') + '/' + e.name);
          var isD = e.type === 'dir';
          var isImg = !isD && _DIR_IMG_RE.test(e.name || '');
          var thumb = isD ? '📁'
            : (isImg ? '' : '🎬');
          var imgTag = isImg
            ? '<div data-rt="'+i+'" style="width:100%;height:82px;border-radius:6px;background:var(--bg3);display:flex;align-items:center;justify-content:center">⏳</div>'
            : '';
          return '<div data-di="'+i+'" style="width:128px;cursor:pointer;padding:5px;border-radius:8px;border:1px solid var(--line);background:var(--bg)">' +
            '<div style="width:100%;height:82px;border-radius:6px;background:var(--bg3);display:flex;align-items:center;justify-content:center;font-size:26px;overflow:hidden">' + (imgTag || thumb) + '</div>' +
            '<div style="font-size:10px;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text2)" title="'+esc(e.name)+'">' + (isD ? '📁 ' : '') + esc(e.name) + '</div></div>';
        }).join('') + '</div>';
        // v5.1.0 · 目录级 token 一次签发 → 批量出图 (逐文件签发会部分超时导致图不显示)
        (function(){
          var els = dbody.querySelectorAll('[data-rt]');
          if (!els.length) return;
          function _tok(){
            if (conn.host){
              return rpcWS('file_remote_stream_token', Object.assign({ path: opts.path }, conn));
            }
            return rpcWS('file_stream_token', { path: opts.path });
          }
          // v5.17.0 · 改用共享缓存 (同目录 10min 内不再重复签发; 旧实现每次渲染都签发 → 排队)
          _tok().then(function(tk){
            try {
              if (tk && tk.status === 'ok' && tk.token && !conn.host){
                window.__rpStreamTok = window.__rpStreamTok || {};
                window.__rpStreamTok[String(opts.path || '/')] = { token: tk.token, ts: Date.now() };
              }
            } catch(_){}
            els.forEach(function(el){
              var e = media[parseInt(el.getAttribute('data-rt'), 10)];
              if (!el.isConnected) return;
              if (!e || e.type === 'dir'){ el.innerHTML = '📁'; return; }
              var p2 = e.path || (opts.path.replace(/\/$/, '') + '/' + e.name);
              if (tk.status === 'ok' && tk.token){
                var url = conn.host
                  ? '/api/file/remote_stream?path=' + encodeURIComponent(p2) + '&rst=' + encodeURIComponent(tk.token)
                  : '/api/file/stream?path=' + encodeURIComponent(p2) + '&st=' + encodeURIComponent(tk.token);
                el.outerHTML = '<img loading="lazy" src="' + url + '" style="width:100%;height:82px;object-fit:cover;border-radius:6px" onerror="this.style.display=\'none\'">';
              } else {
                el.outerHTML = '<div style="width:100%;height:82px;display:flex;align-items:center;justify-content:center;font-size:22px">🖼</div>';
              }
            });
          });
        })();

        dbody.querySelectorAll('[data-di]').forEach(function(el){
          el.style.cursor = 'pointer';
          el.onclick = function(){ openItem(media[parseInt(el.getAttribute('data-di'), 10)]); };
          // v4.97.0 · 缩略图/名称任一处点击都进预览, 更符合直觉
          el.querySelectorAll('img,div').forEach(function(ch){ ch.onclick = el.onclick; });
        });
      } else {
        dbody.innerHTML = '<div>' + sorted.map(function(e, i){
          var p = e.path || (opts.path.replace(/\/$/, '') + '/' + e.name);
          var isD = e.type === 'dir';
          return '<div data-li="'+i+'" style="display:flex;align-items:center;gap:8px;padding:4px 8px;border-radius:5px;cursor:pointer;font-size:12px;border-bottom:1px solid var(--line)">' +
            '<span>'+(isD?'📁':'📄')+'</span>' +
            '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:'+(isD?'var(--purple)':'var(--text)')+'">'+esc(e.name)+'</span>' +
            '<span style="color:var(--text3);font-size:10px">'+(isD?'目录':(e.size? fmtB(e.size):''))+'</span></div>';
        }).join('') + '</div>';
        dbody.querySelectorAll('[data-li]').forEach(function(el){
          el.onclick = function(){ openItem(sorted[parseInt(el.getAttribute('data-li'), 10)]); };
        });
      }
    }
    var bt = body.querySelector('.fp-dir-thumb'), bl = body.querySelector('.fp-dir-list');
    function setVm(m){
      vm = m;
      bt.style.background = m === 'thumb' ? 'var(--cyan)' : 'transparent';
      bt.style.color = m === 'thumb' ? '#000' : 'var(--text2)';
      bl.style.background = m === 'list' ? 'var(--cyan)' : 'transparent';
      bl.style.color = m === 'list' ? '#000' : 'var(--text2)';
      renderEntries();
    }
    bt.onclick = function(){ setVm('thumb'); };
    bl.onclick = function(){ setVm('list'); };
    listEntries();
  }

  // v5.4.0 · 云端文本预览 (remote_read_raw → 只读展示, 不提供编辑)
  function _renderTextCloud(body, opts, name){
    body.innerHTML = '<div style="color:var(--text3);font-size:12px;padding:14px">⏳ 云端读取…</div>';
    rpc('remote_read_raw', { remote_id: opts.cloudId, remote_key: opts.path, max_size: 20*1024*1024 })
      .then(function(r){
        if (!body.isConnected) return;
        if (r.status !== 'ok'){
          body.innerHTML = '<div style="color:var(--red);font-size:12px;padding:14px">✗ ' + esc(r.msg || '云端读取失败') + '</div>';
          return;
        }
        var txt = '';
        txt = b64ToText(r.content_b64);
        if (!txt) txt = '(二进制内容, 无法以文本显示)';
        body.innerHTML = '<pre class="fp-cloud-text" style="flex:1;min-height:0;overflow:auto;margin:0;padding:8px 10px;' +
          'background:var(--bg);border:1px solid var(--border);border-radius:6px;font-family:ui-monospace,monospace;font-size:12px;white-space:pre-wrap">' + esc(txt) + '</pre>';
      });
  }

  function _connOf(opts){
    // v4.66.0 · opts.conn 优先 (DM 等页面自带凭据, 不依赖全局 getSrvAuth)
    if (opts && opts.conn && opts.conn.host) return opts.conn;
    // v5.4.0 · 云端 (Seafile/S3/WebDAV) 走 remote_* 通路, 不带 SSH host
    if (opts && opts.cloudId != null) return { cloudId: opts.cloudId, _cloud: true };
    if (typeof g.FileOps !== 'undefined' && g.FileOps.connFor) return g.FileOps.connFor(opts.side);
    return {};
  }

  function _bindToolbar(host, opts){
    // v5.6.0 · 直接传输
    try {
      var dbtn = host.querySelector('.fp-btn-direct');
      if (dbtn) dbtn.onclick = function(){
        if (typeof opts.onDirectTransfer === 'function'){
          opts.onDirectTransfer(opts.path, opts.name, { side: opts.side, size: opts._size });
        }
      };
    } catch(e){}
    var conn = _connOf(opts);
    var q = function(sel){ return host.querySelector(sel); };
    var fullB = q('.fp-btn-full');
    if (fullB){
      fullB.onclick = function(){
        if (typeof opts.toggleFull === 'function') opts.toggleFull();
        else if (g.FilePreviewPage && g.FilePreviewPage.toggleFull) g.FilePreviewPage.toggleFull();
      };
      // 与宿主全屏状态同步 (按钮变绿 + 文案)
      _syncFullBtns = function(on){
        fullB.textContent = on ? '⛶ 退出全屏' : '⛶ 全屏';
        fullB.style.background = on ? 'var(--green)' : '';
        fullB.style.color = on ? '#fff' : '';
        fullB.style.borderColor = on ? 'var(--green)' : '';
      };
      _syncFullBtns(!!(g.FilePreviewPage && g.FilePreviewPage.isFull && g.FilePreviewPage.isFull()));
    }
    var addB = q('.fp-btn-add');
    if (addB) addB.onclick = function(){
      if (typeof opts.onAddTransfer === 'function') opts.onAddTransfer(opts.path, {name: _cur && _cur.name});
      else toast('⚠ 当前环境不支持加入传输', 'warn');
    };
    var editB = q('.fp-btn-edit');
    if (editB) editB.onclick = function(){ _startEdit(host, opts); };
    var dlB = q('.fp-btn-dl');
    if (dlB) dlB.onclick = function(){
      if (conn.host){ toast('远端文件请用 ➕ 加入传输 下载到本机', 'info', 3000); return; }
      var tok = localStorage.getItem('auth_token') || '';
      var a = document.createElement('a');
      a.href = '/api/download?path=' + encodeURIComponent(opts.path) + '&token=' + encodeURIComponent(tok);
      a.download = _cur ? _cur.name : '';
      document.body.appendChild(a); a.click(); a.remove();
    };
    var archB = q('.fp-btn-arch');
    if (archB) archB.onclick = function(){ g.FileOps.archiveList(opts.side, opts.path); };
    var extB = q('.fp-btn-extract');
    if (extB) extB.onclick = function(){ g.FileOps.extract(opts.side, opts.path, null, _arcPw); if (opts.onChanged) opts.onChanged(); };
    var zipB = q('.fp-btn-zip');
    if (zipB) zipB.onclick = function(){ g.FileOps.compress(opts.side, opts.path, 'tar.gz', null); if (opts.onChanged) opts.onChanged(); };
    var renB = q('.fp-btn-ren');
    if (renB) renB.onclick = function(){ g.FileOps.rename(opts.side, opts.path, { load: function(){ if (opts.onChanged) opts.onChanged(); }, getCwd: function(){ return ''; } }); };
    var infoB = q('.fp-btn-info');
    if (infoB) infoB.onclick = function(){ g.FileOps.statModal(opts.side, opts.path); };
    var delB = q('.fp-btn-del');
    if (delB) delB.onclick = function(){
      g.FileOps.del(opts.side, opts.path, { load: function(){ if (opts.onChanged) opts.onChanged(); }, getCwd: function(){ return ''; } });
    };
  }

  // ── 文本 (v4.70.0 · 换行/行号开关 + 大文件提示) ──
  function _renderText(body, opts, name){
    body.innerHTML = '<div style="color:var(--text3);font-size:12px;padding:10px">⏳ 加载中…</div>';
    rpc('file_read', Object.assign({path: opts.path}, _connOf(opts))).then(function(r){
      if (!body.isConnected) return;
      if (r.status !== 'ok'){
        body.innerHTML = '<div style="color:var(--orange);font-size:12px;padding:10px;line-height:1.8">' +
          esc(r.msg || '读取失败') + '<br><span style="color:var(--text3);font-size:11px">' +
          '可点工具栏 ✏️ 编辑 或 ⬇ 下载 查看</span></div>';
        return;
      }
      var content = String(r.content || '');
      var allLines = content.split('\n');
      var lineCount = allLines.length;
      body.innerHTML =
        '<div class="fp-textbar" style="display:flex;align-items:center;gap:8px;margin-bottom:4px;font-size:10px;color:var(--text3)">'+
          '<span>' + lineCount + ' 行 · ' + fmtB(r.size) + ' · 只读预览 (点 ✏️ 编辑 可修改保存)</span>'+
          '<span style="flex:1"></span>'+
          '<button class="btn btn-sm fp-wrap-btn" style="padding:1px 7px;font-size:10px" title="切换自动换行">↵ 换行</button>'+
          '<button class="btn btn-sm fp-lineno-btn" style="padding:1px 7px;font-size:10px" title="切换行号"># 行号</button>'+
        '</div>'+
        // v4.70.1 · 单一滚动容器: 行号与正文同容器 → 天然同步滚动, 不会分裂成两块
        '<div class="fp-textbox" style="flex:1;min-height:0;overflow:auto;'+
        'background:var(--bg);border:1px solid var(--border);border-radius:6px">'+
          '<div style="display:flex;min-width:100%;width:max-content;min-height:100%">'+
            // gutter: white-space:pre 保证行号竖向排列; sticky 让横向滚动时行号留在左侧
            '<div class="fp-gutter" style="position:sticky;left:0;z-index:1;flex:0 0 auto;padding:8px 8px 8px 8px;'+
            'text-align:right;white-space:pre;background:var(--bg);'+
            'font-family:ui-monospace,Consolas,monospace;font-size:12px;line-height:1.6;color:var(--text3);'+
            'border-right:1px solid var(--border);user-select:none"></div>'+
            '<pre class="fp-textpre" style="flex:1 0 auto;margin:0;padding:8px;overflow:visible;'+
            'font-family:ui-monospace,Consolas,monospace;font-size:12px;line-height:1.6;color:var(--text2);'+
            'white-space:pre"></pre>'+
          '</div>'+
        '</div>';

      var pre = body.querySelector('.fp-textpre');
      var gutter = body.querySelector('.fp-gutter');
      var wrapBtn = body.querySelector('.fp-wrap-btn');
      var lnBtn = body.querySelector('.fp-lineno-btn');

      // 行号栏内容 (与正文同样行高 → 天然对齐)
      var _nums = allLines.map(function(_l, i){ return String(i + 1); });
      gutter.textContent = _nums.join('\n');            // white-space:pre → 竖向排列
      gutter.style.minWidth = String(_nums.length).length + 'ch';  // 宽度随位数
      pre.textContent = content;

      function applyText(){
        var wrap = VIEW.wrap, showNo = VIEW.lineNo;
        pre.style.whiteSpace = wrap ? 'pre-wrap' : 'pre';
        pre.style.wordBreak = wrap ? 'break-all' : 'normal';
        // 换行时正文宽度自适应容器 (不再横向滚动), 行号栏仍固定左侧
        pre.style.width = wrap ? '100%' : '';
        pre.style.minWidth = wrap ? '0' : '';
        gutter.style.display = showNo ? '' : 'none';
        // 开关按钮激活态 (绿色)
        [[wrapBtn, wrap], [lnBtn, showNo]].forEach(function(pair){
          var b = pair[0], on = pair[1];
          if (!b) return;
          b.style.background = on ? 'var(--green)' : '';
          b.style.color = on ? '#fff' : '';
          b.style.borderColor = on ? 'var(--green)' : '';
          b.style.fontWeight = on ? '700' : '';
        });
      }
      // 单容器滚动 → 行号与正文天然同步 (无需手动 sync)
      wrapBtn.onclick = function(){ VIEW.wrap = !VIEW.wrap; applyText(); };
      lnBtn.onclick = function(){ VIEW.lineNo = !VIEW.lineNo; applyText(); };
      applyText();
    });
  }

  // ── A3 相册墙 (按目录懒加载) ──
  function galleryWall(side, dirPath){
    var conn = _connOf({side: side});
    var m = modal({ title: '🖼 相册墙 · ' + dirPath, width: 'auto', full: false,
      body: '<div style="text-align:center;color:var(--text3);padding:20px">⏳ 加载…</div>' });
    var listAction = conn.host ? 'list_remote_dir' : 'list_dir';
    rpc(listAction, {'path': dirPath}).then(function(r) {
      var body = m.querySelector('.fops-body');
      if (!body || !m.isConnected) return;
      var entries = r.entries || [];
      var imgs = entries.filter(function(e) { return isImg(e.name); });
      if (!imgs.length) { body.innerHTML = '<div style="text-align:center;color:var(--text3);padding:20px">此目录无图片</div>'; return; }
      var html = '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px">';
      imgs.forEach(function(img, i) {
        var src = conn.host ? '' : '/api/file/stream?path=' + encodeURIComponent(dirPath + '/' + img.name) + '&st=TBD';
        html += '<div class="fp-gal" data-i="' + i + '" style="cursor:pointer;border-radius:6px;overflow:hidden;background:var(--bg)">';
        html += '<img data-src="' + esc(img.name) + '" style="width:100%;height:120px;object-fit:cover;display:block">';
        html += '<div style="padding:4px;font-size:10px;color:var(--text3);text-align:center;overflow:hidden;text-overflow:ellipsis">' + esc(img.name) + '</div></div>';
      });
      html += '</div>';
      body.innerHTML = html;
      // 幻灯片模式: 点击图片 → 全屏
      body.querySelectorAll('.fp-gal').forEach(function(el, i) {
        el.onclick = function() { _slideshow(imgs, i, dirPath); };
      });
    });
  }

  function _slideshow(imgs, idx, dirPath) {
    var overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.92);z-index:200000;display:flex;align-items:center;justify-content:center;flex-direction:column';
    function show(i) {
      var img = imgs[i];
      overlay.innerHTML = '<div style="position:absolute;top:10px;right:16px;color:#fff;font-size:14px;cursor:pointer" onclick="this.parentElement.remove()">✕</div>' +
        '<div style="position:absolute;top:10px;left:16px;color:#fff;font-size:13px">' + esc(img.name) + ' (' + (i+1) + '/' + imgs.length + ')</div>' +
        '<div style="position:absolute;left:10px;top:50%;transform:translateY(-50%);color:#fff;font-size:30px;cursor:pointer;padding:10px" onclick="window._ssNav(-1)">‹</div>' +
        '<div style="position:absolute;right:10px;top:50%;transform:translateY(-50%);color:#fff;font-size:30px;cursor:pointer;padding:10px" onclick="window._ssNav(1)">›</div>' +
        '<img id="ssImg" style="max-width:92vw;max-height:88vh;object-fit:contain">';
      var imgEl = overlay.querySelector('#ssImg');
      // 加载图片 (简化: 走 file_read_raw)
      var conn = {};
      rpc('file_read_raw', {'path': dirPath + '/' + img.name}).then(function(r) {
        if (r.status === 'ok') {
          var ext2 = img.name.split('.').pop().toLowerCase();
          var mime2 = {'jpg':'image/jpeg','jpeg':'image/jpeg','png':'image/png','gif':'image/gif','webp':'image/webp'}[ext2] || 'image/png';
          imgEl.src = 'data:' + mime2 + ';base64,' + r.content_b64;
        }
      });
      window._ssNav = function(d) {
        var ni = (idx + d + imgs.length) % imgs.length;
        show_idx = ni;
        overlay.remove(); _slideshow_inline(imgs, ni, dirPath);
      };
    }
    function _slideshow_inline(imgs, i, dir2) {
      var overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.92);z-index:200000;display:flex;align-items:center;justify-content:center;flex-direction:column';
      document.body.appendChild(overlay);
    }
    show(idx);
    document.body.appendChild(overlay);
  }

  // ── 图片 (缩放 + 适应) ──
  function _renderImage(body, opts, name){
    var conn = _connOf(opts);
    body.innerHTML = '<div style="color:var(--text3);font-size:12px;padding:10px">⏳ 加载中…</div>';
    var mime = IMG[ext(name)] || 'application/octet-stream';
    // v5.4.0 · 云端图片: remote_read_raw → dataURL
    if (opts.cloudId != null){
      rpc('remote_read_raw', { remote_id: opts.cloudId, remote_key: opts.path, max_size: 30*1024*1024 }).then(function(r){
        if (!body.isConnected) return;
        if (r.status !== 'ok'){
          body.innerHTML = '<div style="color:var(--red);font-size:12px;padding:10px">✗ ' + esc(r.msg || '云端读取失败') + '</div>';
          return;
        }
        _imgHtml(body, 'data:' + mime + ';base64,' + r.content_b64);
      });
      return;
    }
    if (!conn.host){
      // 本机: 走流端点 (大图友好)
      // v5.17.0 · 用父目录 token (共享缓存, 10min 复用) — 单文件 token 每次点击都要签发, 是"点图慢"主因
      var _pdir = String(opts.path || '').replace(/\/[^\/]*$/, '') || '/';
      getDirToken(_pdir, function(tok){
        if (!body.isConnected) return;
        if (!tok){
          body.innerHTML = '<div style="color:var(--red);font-size:12px;padding:10px">✗ 预览令牌获取失败, 请刷新重试</div>';
          return;
        }
        _imgHtml(body, '/api/file/stream?path=' + encodeURIComponent(opts.path) + '&st=' + encodeURIComponent(tok));
      });
    } else {
      rpc('file_read_raw', Object.assign({path: opts.path}, conn)).then(function(r){
        if (!body.isConnected) return;
        if (r.status !== 'ok'){
          body.innerHTML = '<div style="color:var(--red);font-size:12px;padding:10px">✗ ' + esc(r.msg||'失败') + '</div>';
          return;
        }
        _imgHtml(body, 'data:' + mime + ';base64,' + r.content_b64);
      });
    }
    function _imgHtml(el, src){
      // v5.4.0 · 缩放控件保持独立一行 (并入顶部工具条的改动会引起控件定位问题, 已回退)
      el.innerHTML =
        '<div class="fp-zoombar" style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--text3)">'+
          '<button class="btn btn-sm fp-zoom-out" style="padding:1px 7px;font-size:10px">－</button>'+
          '<span class="fp-zoom-val" style="min-width:42px;text-align:center;display:inline-block"></span>'+
          '<button class="btn btn-sm fp-zoom-in" style="padding:1px 7px;font-size:10px">＋</button>'+
          '<button class="btn btn-sm fp-zoom-fit" style="padding:1px 7px;font-size:10px">适应窗口</button>'+
          '<button class="btn btn-sm fp-exif-btn" style="padding:1px 7px;font-size:10px">ℹ EXIF</button>'+
          '<span style="flex:1"></span><span class="fp-img-size"></span></div>'+
        '<div class="fp-imgbox" style="flex:1;position:relative;overflow:auto;text-align:center;background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:6px">'+
          '<img class="fp-img" src="'+src+'" style="transition:transform .12s">'+
        '</div>';
      // v5.14.0 · EXIF 摘要弹窗 (仅本机文件; 远端给明确提示)
      el.querySelector('.fp-exif-btn').onclick = function(){
        var conn = _connOf(opts) || {};
        rpc('file_exif', Object.assign({ path: opts.path }, conn)).then(function(r){
          var rows = '';
          if (r.status === 'ok'){
            var kv = [['路径', r.path], ['尺寸', (r.width||'?') + ' × ' + (r.height||'?') + ' px'],
                      ['格式', (r.format||'?') + ' · ' + (r.mode||'')], ['大小', (r.size||0) + ' B'],
                      ['修改时间', r.mtime || '']];
            var ex = r.exif || {};
            Object.keys(ex).forEach(function(k){ kv.push([k, String(ex[k])]); });
            rows = kv.map(function(p){
              return '<tr><td style="padding:3px 10px;color:var(--text3);white-space:nowrap;vertical-align:top">'+esc(p[0])+'</td>'+
                     '<td style="padding:3px 10px;font-family:monospace;font-size:11px;word-break:break-all;user-select:all">'+esc(p[1])+'</td></tr>';
            }).join('');
            rows = '<table style="width:100%;border-collapse:collapse;font-size:12px">' + rows + '</table>';
          } else {
            rows = '<div style="color:var(--orange);font-size:12px">' + esc(r.msg || '解析失败') + '</div>';
          }
          modal({ title: 'ℹ EXIF — ' + (opts.name || ''), width: '520px', body: rows,
                  actions: '<button class="btn btn-sm" onclick="this.closest(\'.modal-backdrop\').remove()">关闭</button>' });
        });
      };
      var img = el.querySelector('.fp-img');
      var _scope = el;
      var val = _scope.querySelector('.fp-zoom-val');
      var fitBtn = _scope.querySelector('.fp-zoom-fit');
      var box = el.querySelector('.fp-imgbox');
      // v4.70.0 · 依据记忆的视图状态渲染 (换图不丢)
      function apply(){
        var fit = (VIEW.zoomMode === 'fit');
        // 适应窗口: 约束在容器内; 固定倍率: 允许滚动 + transform 缩放
        img.style.maxWidth = fit ? '100%' : 'none';
        img.style.maxHeight = fit ? '100%' : 'none';
        img.style.transform = fit ? 'none' : 'scale(' + VIEW.zoomScale + ')';
        img.style.transformOrigin = 'top center';
        box.style.textAlign = fit ? 'center' : 'left';
        val.textContent = fit ? '适应' : Math.round(VIEW.zoomScale * 100) + '%';
        // "适应窗口" 激活态 → 绿色高亮
        fitBtn.style.background = fit ? 'var(--green)' : '';
        fitBtn.style.color = fit ? '#fff' : '';
        fitBtn.style.borderColor = fit ? 'var(--green)' : '';
        fitBtn.style.fontWeight = fit ? '700' : '';
      }
      img.onload = function(){
        var sz = _scope.querySelector('.fp-img-size');
        if (sz) sz.textContent = img.naturalWidth + '×' + img.naturalHeight;
        apply();
      };
      _scope.querySelector('.fp-zoom-in').onclick = function(){
        VIEW.zoomMode = 'zoom';
        VIEW.zoomScale = Math.min(6, (VIEW.zoomMode === 'zoom' ? VIEW.zoomScale : 1) * 1.25);
        apply();
      };
      _scope.querySelector('.fp-zoom-out').onclick = function(){
        VIEW.zoomMode = 'zoom';
        VIEW.zoomScale = Math.max(0.1, VIEW.zoomScale / 1.25);
        apply();
      };
      fitBtn.onclick = function(){
        VIEW.zoomMode = 'fit';
        // v5.1.0 · 复位平移 (旧实现只改缩放, marginLeft/Top 残留 → 图片不居中)
        try { if (img.__rpResetPan) img.__rpResetPan(); img.style.marginLeft = ''; img.style.marginTop = ''; } catch(e){}
        VIEW.zoomScale = 1;
        try { img.dataset.zoom = 1; } catch(e){}
        apply();
      };
      apply();
      // v5.0.0 · Windows 风格翻页: 图片左右两侧半透明点击区 (悬停浮现箭头)
      try {
        var navList = (opts && opts._navList) || null;
        // host 不在 _renderImage 作用域内 → 从 DOM 反查承载容器
        var _hostEl = (el.closest && el.closest('.tp-preview, #fpPagePreview, .tri-preview, .fp-host')) || el.parentElement;
        if (navList && navList.length > 1 && _hostEl && _hostEl._fpGo){
          ['prev','next'].forEach(function(sideName){
            var isPrev = (sideName === 'prev');
            var zone = document.createElement('div');
            zone.className = 'fp-navzone fp-navzone-' + sideName;
            zone.title = isPrev ? '上一张 (←)' : '下一张 (→)';
            zone.style.cssText = 'position:absolute;top:0;bottom:0;' + (isPrev ? 'left:0' : 'right:0') +
              ';width:22%;min-width:70px;max-width:180px;cursor:pointer;z-index:5;display:flex;align-items:center;' +
              'justify-content:' + (isPrev ? 'flex-start' : 'flex-end') + ';padding:0 10px;opacity:0;transition:opacity .15s;' +
              'background:linear-gradient(' + (isPrev ? '90deg' : '270deg') + ',rgba(0,0,0,.38),rgba(0,0,0,0))';
            zone.innerHTML = '<span style="font-size:34px;color:#fff;text-shadow:0 2px 8px rgba(0,0,0,.7);pointer-events:none">' +
                             (isPrev ? '‹' : '›') + '</span>';
            zone.onmouseenter = function(){ zone.style.opacity = '1'; };
            zone.onmouseleave = function(){ zone.style.opacity = '0'; };
            zone.onclick = function(ev){ ev.stopPropagation(); _hostEl._fpGo(isPrev ? -1 : 1); };
            box.appendChild(zone);
          });
        }
      } catch(e){ console.warn('[fp] navzone', e); }
      // v4.98.0 · 放大后可抓手拖动平移 (鼠标变手型, 上下左右拖)
      try {
        if (window.RpUI && !img.__rpPanBound){   // v4.98.0 · 按图片对象绑定 (原为全局开关, 第二张图失效)
          img.__rpPanBound = true;
          var _origApply = apply;
          apply = function(){
            _origApply();
            var z = (VIEW.zoomMode === 'fit') ? 1 : (VIEW.zoomScale || 1);
            img.dataset.zoom = z;
            img.style.cursor = (z > 1.001) ? 'grab' : 'auto';
            // 平移用 margin 实现, 与 transform 缩放共存
            img.style.cursor = (z > 1.001) ? 'grab' : 'auto';
          };
          (function(){
            var ox = 0, oy = 0, dragging = false, sx = 0, sy = 0;
            function _z(){ return parseFloat(img.dataset.zoom || '1') || 1; }
            function _apply(){ img.style.marginLeft = ox + 'px'; img.style.marginTop = oy + 'px'; }
            img.addEventListener('mousedown', function(ev){
              if (_z() <= 1.001) return;
              dragging = true; sx = ev.clientX - ox; sy = ev.clientY - oy;
              img.style.cursor = 'grabbing'; ev.preventDefault();
            });
            document.addEventListener('mousemove', function(ev){
              if (!dragging) return;
              ox = ev.clientX - sx; oy = ev.clientY - sy; _apply();
            });
            document.addEventListener('mouseup', function(){
              if (dragging){ dragging = false; img.style.cursor = (_z() > 1.001) ? 'grab' : 'auto'; }
            });
            // 双击复位平移
            img.addEventListener('dblclick', function(){
              ox = 0; oy = 0; _apply();
            });
            img.__rpResetPan = function(){ ox = 0; oy = 0; _apply(); };
          })();
        }
      } catch(e){ console.warn('[fp] image pan', e); }
      apply();
    }
  }

  // ── 音视频 (Range 流式) ──
  // v4.93.0 · A5 base64 兜底: 流播 token 不可用时整段加载 (≤50MB)
  function _renderRemoteBase64(body, opts, name, kind){
    var conn2 = _connOf(opts);
    rpc('file_read_raw', Object.assign({path: opts.path, max_size: 50*1024*1024}, conn2)).then(function(r) {
      if (!body.isConnected) return;
      if (r.status !== 'ok') {
        body.innerHTML = '<div style="color:var(--red);font-size:12px;padding:16px">✗ ' + esc(r.msg || '加载失败') +
          '<br><span style="color:var(--text3)">或点 ➕ 加入传输 下载后播放</span></div>';
        return;
      }
      var ext2 = ext(name);
      var mime2 = {'mp4':'video/mp4','webm':'video/webm','mkv':'video/x-matroska','avi':'video/x-msvideo',
                   'mov':'video/quicktime','mp3':'audio/mpeg','flac':'audio/flac','wav':'audio/wav','ogg':'audio/ogg','m4a':'audio/mp4'}[ext2] || 'application/octet-stream';
      var dataUrl = 'data:' + mime2 + ';base64,' + (r.content_b64 || '');
      if (kind === 'audio' || ['mp3','flac','wav','ogg','m4a'].indexOf(ext2) >= 0) {
        body.innerHTML = '<div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px">'+
          '<div style="font-size:40px">🎵</div>'+
          '<audio controls src="'+dataUrl+'" style="width:92%;max-width:520px"></audio></div>';
      } else {
        body.innerHTML = '<video controls src="'+dataUrl+'" style="width:100%;flex:1;min-height:0;border-radius:6px;background:#000"></video>';
      }
    });
  }

  function _renderMedia(body, opts, name, kind){
    var conn = _connOf(opts);
    if (conn.host){
      // v4.93.0 · A5 远端音视频: Range 流播 (file_remote_stream_token → /api/file/remote_stream), 失败退回 base64
      body.innerHTML = '<div style="color:var(--text3);font-size:12px;padding:20px;text-align:center">⏳ 建立远端流播…</div>';
      rpc('file_remote_stream_token', Object.assign({path: opts.path}, conn)).then(function(tk) {
        if (!body.isConnected) return;
        if (tk.status !== 'ok' || !tk.token){
          body.innerHTML = '<div style="color:var(--text3);font-size:12px;padding:20px;text-align:center">⏳ 流播不可用, 转为整段加载 (≤50MB)…</div>';
          _renderRemoteBase64(body, opts, name, kind);
          return;
        }
        var ext2 = ext(name);
        var src = '/api/file/remote_stream?path=' + encodeURIComponent(opts.path) + '&rst=' + encodeURIComponent(tk.token);
        if (kind === 'audio' || ['mp3','flac','wav','ogg','m4a'].indexOf(ext2) >= 0) {
          body.innerHTML = '<div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px">'+
            '<div style="font-size:40px">🎵</div>'+
            '<audio controls src="'+src+'" style="width:92%;max-width:520px"></audio>'+
            '<div style="font-size:10px;color:var(--text3)">⚡ Range 流播 · 拖动进度条按需读取, 免下载</div></div>';
        } else {
          body.innerHTML = '<div style="flex:1;min-height:0;display:flex;flex-direction:column">'+
            '<video controls src="'+src+'" style="width:100%;flex:1;min-height:0;border-radius:6px;background:#000"></video>'+
            '<div style="font-size:10px;color:var(--text3);padding:4px 8px">⚡ Range 流播 · 拖动进度条按需读取, 免下载</div></div>';
        }
      });
      return;
    }
    body.innerHTML = '<div style="color:var(--text3);font-size:12px;padding:10px">⏳ 准备流…</div>';
    rpc('file_stream_token', {path: opts.path}).then(function(r){
      if (!body.isConnected) return;
      if (r.status !== 'ok'){
        body.innerHTML = '<div style="color:var(--red);font-size:12px;padding:10px">✗ ' + esc(r.msg||'失败') + '</div>';
        return;
      }
      var src = '/api/file/stream?path=' + encodeURIComponent(opts.path) + '&st=' + encodeURIComponent(r.token);
      if (kind === 'audio'){
        body.innerHTML = '<div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px">'+
          '<div style="font-size:40px">🎵</div>'+
          '<audio controls autoplay src="'+src+'" style="width:92%;max-width:520px"></audio>'+
          '<div style="font-size:11px;color:var(--text3)">流式播放 (HTTP Range · 无需完整下载)</div></div>';
      } else {
        body.innerHTML = '<video controls autoplay src="'+src+'" style="width:100%;flex:1;min-height:0;border-radius:6px;background:#000"></video>'+
          '<div style="font-size:11px;color:var(--text3);margin-top:4px;text-align:center">流式播放 · 支持拖动进度 (Range 请求)</div>';
      }
    });
  }

  // ── PDF ──
  function _renderPdf(body, opts, name){
    var conn = _connOf(opts);
    body.innerHTML = '<div style="color:var(--text3);font-size:12px;padding:10px">⏳ 加载中…</div>';
    if (!conn.host){
      rpc('file_stream_token', {path: opts.path}).then(function(r){
        if (!body.isConnected) return;
        if (r.status !== 'ok'){ body.innerHTML = '<div style="color:var(--red);font-size:12px;padding:10px">✗ '+esc(r.msg||'失败')+'</div>'; return; }
        body.innerHTML = '<iframe src="/api/file/stream?path='+encodeURIComponent(opts.path)+'&st='+encodeURIComponent(r.token)+
          '" style="flex:1;min-height:0;width:100%;border:1px solid var(--border);border-radius:6px;background:#fff"></iframe>'+
          '<div style="font-size:11px;color:var(--text3);margin-top:4px;text-align:center">浏览器原生渲染 · 支持搜索 (Ctrl+F)</div>';
      });
    } else {
      rpc('file_read_raw', Object.assign({path: opts.path, max_size: 50*1024*1024}, conn)).then(function(r){
        if (!body.isConnected) return;
        if (r.status !== 'ok'){ body.innerHTML = '<div style="color:var(--red);font-size:12px;padding:10px">✗ '+esc(r.msg||'失败')+'</div>'; return; }
        body.innerHTML = '<iframe src="data:application/pdf;base64,'+r.content_b64+
          '" style="flex:1;min-height:0;width:100%;border:1px solid var(--border);border-radius:6px;background:#fff"></iframe>';
      });
    }
  }

  // ── 压缩包 (列表 + 点击提取) ──
  var _arcPw = '';   // v4.69.0 · 最近解锁的归档密码 (会话内复用)
  function _renderArchive(body, opts, name, password){
    var conn = _connOf(opts);
    body.innerHTML = '<div style="color:var(--text3);font-size:12px;padding:10px">⏳ 读取目录…</div>';
    rpc('file_archive_list', Object.assign({archive_path: opts.path, password: password || ''}, conn)).then(function(r){
      if (!body.isConnected) return;
      if (r.status !== 'ok'){
        // 加密归档 → 就地输入密码
        if (r.need_password || /密码|password|加密|encrypted/i.test(r.msg||'')){
          body.innerHTML = '<div style="padding:14px;font-size:12px;line-height:1.9;color:var(--orange)">🔒 该压缩包已加密<br>'+
            '<div style="display:flex;gap:6px;margin-top:8px">'+
            '<input class="input fp-arcpw" type="password" placeholder="请输入密码" style="flex:1">'+
            '<button class="btn btn-sm btn-primary fp-arcpwgo">🔓 解锁</button></div></div>';
          var go = function(){
            var inp = body.querySelector('.fp-arcpw');
            var pw = inp ? inp.value : '';
            if (!pw) return;
            _arcPw = pw;
            _renderArchive(body, opts, name, pw);
          };
          body.querySelector('.fp-arcpwgo').onclick = go;
          var i2 = body.querySelector('.fp-arcpw');
          if (i2) i2.onkeydown = function(ev){ if (ev.key === 'Enter') go(); };
          return;
        }
        body.innerHTML = '<div style="color:var(--red);font-size:12px;padding:10px">✗ ' + esc(r.msg||'读取失败') + '</div>';
        return;
      }
      _arcPw = password || '';
      var lines = String(r.files||'').split('\n').filter(Boolean);
      // v5.14.0 · 树状视图: 路径构建为可折叠目录树 (点击文件仍可单独提取)
      var root = { dirs: {}, files: [] };
      lines.forEach(function(l){
        var p = l.trim(); if (!p) return;
        var parts = p.replace(/\/+$/, '').split('/').filter(Boolean);
        var node = root;
        for (var i = 0; i < parts.length - 1 && i < 32; i++){
          if (!node.dirs[parts[i]]) node.dirs[parts[i]] = { dirs: {}, files: [] };
          node = node.dirs[parts[i]];
        }
        node.files.push({ name: parts[parts.length - 1] || p, full: p });
      });
      function _countAll(n){
        var c = n.files.length;
        Object.keys(n.dirs).forEach(function(k){ c += _countAll(n.dirs[k]); });
        return c;
      }
      function _treeHtml(node, depth){
        var h = '';
        Object.keys(node.dirs).sort().forEach(function(dn){
          var child = node.dirs[dn];
          h += '<div class="fp-arc-dir" data-open="0" style="display:flex;align-items:center;gap:4px;font-size:11px;line-height:1.8;color:var(--text);padding:1px 5px;border-radius:3px;cursor:pointer" title="点击折叠/展开">'+
               '<span class="fp-arc-caret" style="display:inline-block;width:10px;color:var(--text3)">▸</span>📁 ' + esc(dn) + '/'+
               '<span style="color:var(--text3);font-size:10px">' + _countAll(child) + ' 项</span></div>'+
               '<div class="fp-arc-children" style="display:none;' + (depth < 6 ? 'padding-left:14px;' : '') + 'border-left:1px dashed var(--border);margin-left:4px">' +
               _treeHtml(child, depth + 1) + '</div>';
        });
        node.files.sort(function(a, b){ return a.name < b.name ? -1 : 1; }).forEach(function(f){
          h += '<div class="fp-arcline" data-m="'+esc(f.full)+'" style="font-size:11px;line-height:1.7;color:var(--text2);'+
            'padding:1px 5px 1px ' + (14 + (depth ? 0 : 0)) + 'px;border-radius:3px;cursor:pointer" title="点击提取该文件">📄 '+esc(f.name)+'</div>';
        });
        return h;
      }
      body.innerHTML = '<div style="font-size:10px;color:var(--text3);margin-bottom:4px">'+
        '共 ' + r.count + ' 项 · 目录可折叠 · 点击文件可单独提取</div>'+
        '<div style="flex:1;overflow:auto;background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:6px">'+
        _treeHtml(root, 0) + '</div>';
      body.querySelectorAll('.fp-arc-dir').forEach(function(el){
        el.onclick = function(ev){
          ev.stopPropagation();
          var open = el.getAttribute('data-open') === '1';
          var children = el.nextElementSibling;
          if (children) children.style.display = open ? 'none' : '';
          el.setAttribute('data-open', open ? '0' : '1');
          var caret = el.querySelector('.fp-arc-caret');
          if (caret) caret.textContent = open ? '▸' : '▾';
        };
      });
      body.querySelectorAll('.fp-arcline').forEach(function(el){
        el.onclick = function(){
          var member = el.getAttribute('data-m');
          if (!member || member.endsWith('/')) return;
          if (!g.confirm('提取包内文件:\n' + member + '\n到同目录 _extracted 文件夹?')) return;
          rpc('file_archive_extract_one', Object.assign({archive_path: opts.path, member: member, password: _arcPw||''}, conn)).then(function(x){
            toast(x.status==='ok' ? '✓ '+x.msg : '✗ '+(x.msg||'提取失败'), x.status==='ok'?'success':'err', 3600);
          });
        };
      });
    });
  }

  // ── 未知/二进制 ──
  function _renderUnknown(body, opts, name){
    var conn = _connOf(opts);
    rpc('file_stat', Object.assign({path: opts.path}, conn)).then(function(r){
      if (!body.isConnected) return;
      if (r.status !== 'ok'){
        body.innerHTML = '<div style="color:var(--red);font-size:12px;padding:10px">✗ '+esc(r.msg||'失败')+'</div>';
        return;
      }
      body.innerHTML = '<div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;color:var(--text2);font-size:12px">'+
        '<div style="font-size:36px">📦</div>'+
        '<div>此类型不支持在线预览</div>'+
        '<table style="font-size:11px;color:var(--text3);border-collapse:collapse">'+
          '<tr><td style="padding:2px 8px">大小</td><td style="padding:2px 8px;color:var(--text2)">'+fmtB(r.size)+'</td></tr>'+
          '<tr><td style="padding:2px 8px">MIME</td><td style="padding:2px 8px;color:var(--text2)">'+esc(r.mime||'-')+'</td></tr>'+
          '<tr><td style="padding:2px 8px">权限</td><td style="padding:2px 8px;color:var(--text2)">'+esc(r.perms||'-')+'</td></tr>'+
        '</table>'+
        '<div style="font-size:11px;color:var(--text3)">可点工具栏 ➕ 加入传输 或 ⬇ 下载</div></div>';
    });
  }

  // ── v4.70.0 · 预览区右键菜单 (与工具栏功能一致 + 预览专属项) ──
  function _previewContextMenu(ev, host, opts){
    ev.preventDefault();
    var old = document.getElementById('fpCtxMenu');
    if (old) old.remove();
    var conn = _connOf(opts);
    var name = opts.name || String(opts.path||'').split('/').filter(Boolean).pop() || '';
    var arr = [
      { t: '➕ 加入传输列表', fn: function(){ if (typeof opts.onAddTransfer === 'function') opts.onAddTransfer(opts.path, {name: name}); } },
      // v5.6.0 · 直接传输 (加入队列并立即开始)
      { t: '⚡ 直接传输到目标', fn: function(){ if (typeof opts.onDirectTransfer === 'function') opts.onDirectTransfer(opts.path, name, { side: opts.side, size: opts._size }); else if (typeof g.toast === 'function') g.toast('当前环境不支持直接传输', 'warn'); } },
      { t: '⬇ 下载到本机', fn: function(){
          if (conn.host){ if (typeof g.toast === 'function') g.toast('远端文件请用 ➕ 加入传输 下载到本机', 'info', 3000); return; }
          var tok = localStorage.getItem('auth_token') || '';
          var a = document.createElement('a');
          a.href = '/api/download?path=' + encodeURIComponent(opts.path) + '&token=' + encodeURIComponent(tok);
          a.download = name; document.body.appendChild(a); a.click(); a.remove();
        } },
      { sep: 1 },
    ];
    if (isText(name) && !isArchive(name)) arr.push({ t: '✏️ 编辑 (原地)', fn: function(){ _startEdit(host, opts); } });
    if (isImg(name)) {
      arr.push({ t: '🖼 适应窗口', fn: function(){ VIEW.zoomMode = 'fit'; _rerender(host, opts); } });
      arr.push({ t: '🔍 放大', fn: function(){
        VIEW.zoomScale = Math.min(6, (VIEW.zoomMode === 'zoom' ? VIEW.zoomScale : 1) * 1.25);
        VIEW.zoomMode = 'zoom'; _rerender(host, opts); } });
      arr.push({ t: '🔎 缩小', fn: function(){
        VIEW.zoomScale = Math.max(0.1, VIEW.zoomScale / 1.25); VIEW.zoomMode = 'zoom'; _rerender(host, opts); } });
    }
    if (isText(name) && !isArchive(name)) {
      arr.push({ t: (VIEW.wrap ? '☑ ' : '☐ ') + '自动换行', fn: function(){ VIEW.wrap = !VIEW.wrap; _rerender(host, opts); } });
      arr.push({ t: (VIEW.lineNo ? '☑ ' : '☐ ') + '显示行号', fn: function(){ VIEW.lineNo = !VIEW.lineNo; _rerender(host, opts); } });
    }
    if (isArchive(name)) {
      arr.push({ t: '📦 浏览压缩包内容', fn: function(){ if (g.FileOps) g.FileOps.archiveList(opts.side, opts.path); } });
      arr.push({ t: '📤 解压到同目录', fn: function(){ if (g.FileOps) g.FileOps.extract(opts.side, opts.path, null); } });
    }
    arr.push({ sep: 1 });
    arr.push({ t: '📋 复制完整路径', fn: function(){
        if (window.copyToClipboard) window.copyToClipboard(opts.path,
          function(){ if (window.toast) toast('✓ 已复制'); });
        else if (navigator.clipboard) navigator.clipboard.writeText(opts.path).then(function(){
          if (typeof g.toast === 'function') g.toast('✓ 已复制路径');
        });
      } });
    arr.push({ t: '⭐ 收藏此路径', fn: function(){ _favPath(opts.path); } });
    arr.push({ sep: 1 });
    arr.push({ t: '🗜 压缩…', fn: function(){ if (g.FileOps) g.FileOps.compress(opts.side, opts.path, null, null); } });
    arr.push({ t: '✏️ 重命名', fn: function(){ if (g.FileOps) g.FileOps.rename(opts.side, opts.path, {load:function(){ if (opts.onChanged) opts.onChanged(); }, getCwd:function(){ return ''; }}); } });
    arr.push({ t: 'ℹ️ 属性', fn: function(){ if (g.FileOps) g.FileOps.statModal(opts.side, opts.path); } });
    arr.push({ t: '🗑 删除…', danger: 1, fn: function(){
        if (g.FileOps) g.FileOps.del(opts.side, opts.path, {load:function(){ if (opts.onChanged) opts.onChanged(); }, getCwd:function(){ return ''; }});
      } });

    var m = document.createElement('div');
    m.id = 'fpCtxMenu';
    m.style.cssText = 'position:fixed;z-index:100002;background:var(--bg2);border:1px solid var(--border);'+
      'border-radius:8px;box-shadow:0 10px 32px rgba(0,0,0,0.45);padding:4px;min-width:200px;font-size:12px';
    m.innerHTML = arr.map(function(it, i){
      if (it.sep) return '<div style="height:1px;background:var(--border);margin:3px 6px"></div>';
      return '<div class="fp-mi" data-i="'+i+'" style="padding:6px 12px;border-radius:5px;cursor:pointer;'+
             'color:'+(it.danger?'var(--red)':'var(--text)')+';white-space:nowrap">'+it.t+'</div>';
    }).join('');
    document.body.appendChild(m);
    var rct = m.getBoundingClientRect();
    m.style.left = Math.max(4, Math.min(ev.clientX, g.innerWidth - rct.width - 8)) + 'px';
    m.style.top = Math.max(4, Math.min(ev.clientY, g.innerHeight - rct.height - 8)) + 'px';
    m.querySelectorAll('.fp-mi').forEach(function(el){
      el.onmouseenter = function(){ el.style.background = 'var(--bg3)'; };
      el.onmouseleave = function(){ el.style.background = ''; };
      el.onclick = function(){
        m.remove();
        var fn = arr[parseInt(el.getAttribute('data-i'), 10)].fn;
        if (fn) fn();
      };
    });
    setTimeout(function(){
      var close = function(e2){
        var mm = document.getElementById('fpCtxMenu');
        if (mm && !mm.contains(e2.target)){ mm.remove(); document.removeEventListener('mousedown', close); }
      };
      document.addEventListener('mousedown', close);
    }, 0);
  }
  function _rerender(host, opts){
    if (window.FilePreview && host) window.FilePreview.render(host, opts);
  }
  function _favPath(p){
    try {
      var key = 'dpb_favs_local';
      var list = JSON.parse(localStorage.getItem(key) || '[]');
      if (list.indexOf(p) < 0){ list.unshift(p); localStorage.setItem(key, JSON.stringify(list)); }
      if (typeof g.toast === 'function') g.toast('⭐ 已收藏 ' + p);
    } catch(e){}
  }

  // ── v4.70.0 · 原地编辑 (预览区内编辑, 浅绿编辑态) ──
  var _editing = null;   // { host, opts, orig }

  // v4.70.1 · 编辑统一入口: 默认原地编辑, >2MB 走分块只读预览 (v4.93.0 · A2)
  var _INLINE_MAX = 2 * 1024 * 1024;
  function _startEdit(host, opts){
    if (!host || !window.FileOps) return;
    var sz = Number(opts._size || 0);
    if (sz && sz > _INLINE_MAX){
      _chunkedView(host, opts);
      return;
    }
    editInline(host, opts);
  }

  // v4.93.0 · A2 大文件分块加载: 每块 512KB 追加渲染, 只读 (编辑仍限 ≤2MB 防半截写入)
  var _CHUNK_SIZE = 512 * 1024;
  function _chunkedView(host, opts){
    var conn = (typeof g.FileOps.connFor === 'function') ? g.FileOps.connFor(opts.side) : (opts.conn || {});
    var total = Number(opts._size || 0);
    host.innerHTML =
      '<div class="fp-editbar" style="display:flex;align-items:center;gap:8px;padding:5px 10px;'+
      'background:var(--bg3);border-bottom:1px solid var(--border);color:var(--text);font-size:11px">'+
        '<span style="color:var(--cyan);font-weight:700">📖 分块预览</span>'+
        '<span style="color:var(--text3)">' + fmtB(total) + ' · 只读 (编辑支持 ≤2MB)</span>'+
        '<span id="fpChunkStatus" style="color:var(--text3)">已加载 0%</span>'+
        '<span style="flex:1"></span>'+
        '<button class="btn btn-sm" id="fpChunkMore" style="padding:1px 10px;font-size:10px">⏬ 加载后续 512KB</button>'+
        '<button class="btn btn-sm" id="fpChunkAll" style="padding:1px 10px;font-size:10px">⏭ 加载全部</button>'+
        '<button class="btn btn-sm" id="fpChunkEdit" style="padding:1px 10px;font-size:10px">✏️ 强制编辑</button>'+
      '</div>'+
      '<textarea class="fp-chunked" readonly spellcheck="false" style="flex:1;min-height:0;border:none;outline:none;resize:none;'+
      'background:var(--bg);color:var(--text);font-family:ui-monospace,Consolas,monospace;font-size:12px;'+
      'line-height:1.6;padding:8px 10px;white-space:pre;overflow:auto"></textarea>';
    var ta = host.querySelector('.fp-chunked');
    var stEl = host.querySelector('#fpChunkStatus');
    var loaded = 0, loading = false;
    function pct(){ return total ? Math.min(100, Math.round(loaded / total * 100)) : 100; }
    function pull(chunkLen){
      if (loading) return;
      loading = true;
      rpc('file_read_range', Object.assign({path: opts.path, offset: loaded, length: chunkLen || _CHUNK_SIZE}, conn))
        .then(function(r){
          loading = false;
          if (r.status !== 'ok'){
            ta.value += '\n✗ ' + (r.msg || '读取失败'); return;
          }
          var bin = b64ToText(r.data);
          ta.value += bin;
          loaded = (r.offset || loaded) + (r.length || bin.length);
          if (typeof r.total_size === 'number' && r.total_size) total = r.total_size;
          stEl.textContent = r.eof ? '✓ 已加载全部 ' + fmtB(loaded) : '已加载 ' + pct() + '%';
          var more = host.querySelector('#fpChunkMore');
          if (more) { more.disabled = r.eof; more.style.opacity = r.eof ? 0.4 : 1; }
        });
    }
    host.querySelector('#fpChunkMore').onclick = function(){ pull(_CHUNK_SIZE); };
    host.querySelector('#fpChunkAll').onclick = function(){
      // 逐块顺序拉全 (2MB 上限保护: 超过 20MB 提示用下载)
      if (total > 20 * 1024 * 1024){ toast('⚠ 文件超过 20MB, 请使用下载或分块查看', 'warn', 3000); return; }
      (function next(){ if (!loading && loaded < total && ta.isConnected) pull(Math.min(_CHUNK_SIZE * 4, total - loaded)), setTimeout(next, 60); })();
    };
    host.querySelector('#fpChunkEdit').onclick = function(){
      g.FileOps.edit(opts.side, opts.path);
    };
    pull(_CHUNK_SIZE);
  }
  function isEditing(){ return !!_editing; }
  function editInline(host, opts){
    if (!host || !window.FileOps) return;
    var conn = (typeof g.FileOps.connFor === 'function') ? g.FileOps.connFor(opts.side) : (opts.conn || {});
    // v4.80.0 · Monaco 可用时用语法高亮编辑器
    // v4.87.0 · 多标签: 添加或切换到已有 tab
    if (!_editTabs.find(function(t){ return t.path === (opts.path||''); })){
      _editTabs.push({ id: _editTabs.length, name: opts.name || '', path: opts.path || '',
                       side: opts.side || 'local', domId: '', dirty: false });
    }
    var useMonaco = typeof g.MonacoEditor === 'object' && typeof g.MonacoEditor.open === 'function';
    host.innerHTML =
      '<div class="fp-editbar" style="display:flex;align-items:center;gap:8px;padding:5px 10px;'+
      'background:var(--green-bg);border-bottom:1px solid var(--green);color:var(--text);font-size:11px">'+
        '<span style="color:var(--green);font-weight:700">✏️ 编辑中</span>'+
        (useMonaco ? '<span style="font-size:10px;color:var(--cyan)">⚡ Monaco</span>' : '')+
        '<span id="fpEditStatus" style="color:var(--text3)"></span>'+
        '<span style="flex:1"></span>'+
        '<span style="color:var(--text3);font-size:10px">Ctrl+S 保存 · Esc 取消</span>'+
        '<button class="btn btn-sm" id="fpEditSave" style="padding:1px 8px;font-size:10px;flex:0 0 auto;background:var(--green);color:#fff;border-color:var(--green)">💾 保存</button>'+
        '<button class="btn btn-sm" id="fpEditCancel" style="padding:1px 8px;font-size:10px;flex:0 0 auto">✕ 取消</button>'+
      '</div>'+
      // v4.93.0 · A2 多标签编辑栏
      '<div class="fp-edittabs" style="display:flex;gap:2px;padding:3px 8px 0;background:var(--bg3);overflow-x:auto"></div>'+
      '<div style="flex:1;min-height:0;display:flex;overflow:hidden;border-left:3px solid var(--green)">'+
      (useMonaco
        ? '<div class="fp-editor" style="flex:1;min-width:0;background:var(--green-bg)"></div>'
        : '<textarea class="fp-editor" spellcheck="false" style="flex:1;min-width:0;border:none;outline:none;resize:none;'+
          'background:var(--green-bg);color:var(--text);font-family:ui-monospace,Consolas,monospace;font-size:12px;'+
          'line-height:1.6;padding:8px 10px;white-space:pre;overflow:auto">⏳ 读取中…</textarea>')+
      '</div>';
    var ta = host.querySelector('.fp-editor');
    var status = host.querySelector('#fpEditStatus');
    // v4.93.0 · A2 多标签: 渲染 + 切换/关闭
    function _tabEntry(){ return _editTabs.find(function(t){ return t.path === (opts.path||''); }); }
    function _markDirty(){
      var t = _tabEntry(); if (t) t.dirty = true;
      _renderEditTabs();
    }
    function _renderEditTabs(){
      var bar = host.querySelector('.fp-edittabs');
      if (!bar) return;
      bar.innerHTML = _editTabs.map(function(t, i){
        var active = t.path === (opts.path||'');
        return '<span data-ti="'+i+'" style="display:inline-flex;align-items:center;gap:4px;padding:3px 8px;border-radius:5px 5px 0 0;font-size:10px;cursor:pointer;white-space:nowrap;'+
          'background:'+(active?'var(--green-bg)':'var(--bg2)')+';color:'+(active?'var(--text)':'var(--text3)')+';border:1px solid '+(active?'var(--green)':'var(--border)')+';border-bottom:none">'+
          (t.dirty?'<b style="color:var(--orange)">●</b>':'')+esc(t.name||t.path)+
          '<i data-close="1" style="font-style:normal;color:var(--text3);padding:0 2px">✕</i></span>';
      }).join('');
      bar.querySelectorAll('[data-ti]').forEach(function(el){
        var t = _editTabs[parseInt(el.getAttribute('data-ti'), 10)];
        if (!t) return;
        el.onclick = function(ev){
          if (ev.target && ev.target.getAttribute && ev.target.getAttribute('data-close')){
            _editTabs = _editTabs.filter(function(x){ return x !== t; });
            if (t.path === (opts.path||'')){ exitEdit(); render(host, null); }
            else _renderEditTabs();
            return;
          }
          if (t.path !== (opts.path||'')){
            editInline(host, {path: t.path, name: t.name, side: t.side, conn: conn});
          }
        };
      });
    }
    _renderEditTabs();
    rpc('file_read', Object.assign({path: opts.path}, conn)).then(function(r){
      if (!host.isConnected || !ta) return;
      if (r.status !== 'ok'){
        ta.value = '✗ ' + (r.msg || '读取失败');
        ta.readOnly = true;
        return;
      }
      if (typeof g.MonacoEditor === 'object' && g.MonacoEditor.open){
        // v4.80.0 · Monaco 模式
        var lang = g.MonacoEditor.langFromName(opts.name || opts.path || '');
        var domId = g.MonacoEditor.open(ta.parentElement, {
          value: r.content || '', name: opts.name || opts.path || '',
          onSave: function(val){ ta.value = val; if (saveFn) saveFn(); },
        });
        ta.style.display = 'none';
      } else {
        ta.value = r.content || '';
      }
      _editing = { host: host, opts: opts, orig: ta.value, conn: conn };
      if (status) status.textContent = (conn.host ? '远端 ' : '本机 ') + fmtB(r.size);
            var saveFn;
      function save(){
        var curVal = ta.value;
        if (typeof g.MonacoEditor === 'object'){
          // Monaco 模式: 从 editor 读取最新值
          var eds = g.MonacoEditor.editors || g.MonacoEditor._editors || {};
          for (var k in eds){ if (eds[k]) { try { curVal = eds[k].getValue(); } catch(e){} } }
        }
        var st2 = host.querySelector('#fpEditStatus');
        if (st2) st2.textContent = '⏳ 保存中…';
        rpc('file_write', Object.assign({path: opts.path, content: curVal}, conn)).then(function(w){     var st3 = host.querySelector('#fpEditStatus');
          if (st3){
            st3.textContent = (w.status === 'ok') ? '✓ 已保存 ' + new Date().toLocaleTimeString() : '✗ ' + (w.msg || '失败');
            st3.style.color = (w.status === 'ok') ? 'var(--green)' : 'var(--red)';
          }
          if (w.status === 'ok' && _editing) _editing.orig = ta.value;
          if (w.status === 'ok'){ var t2 = _tabEntry(); if (t2){ t2.dirty = false; _renderEditTabs(); } }
          if (typeof g.toast === 'function'){
            g.toast(w.status === 'ok' ? '✓ 已保存到 ' + (conn.host || '本机') : '✗ ' + (w.msg || '保存失败'),
                    w.status === 'ok' ? 'success' : 'err');
          }
        });
      }
      function cancel(){
        if (ta.value !== _editing.orig){
          if (!g.confirm || !g.confirm('有未保存的修改，确定放弃？')) return;
        }
        exitEdit();
        render(host, opts);
      }
      host.querySelector('#fpEditSave').onclick = save;
      host.querySelector('#fpEditCancel').onclick = cancel;
      ta.addEventListener('keydown', function(e){
        if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')){ e.preventDefault(); save(); }
        else if (e.key === 'Escape'){ e.preventDefault(); cancel(); }
      });
      // v4.93.0 · A2 脏标记: textarea 输入即标记; Monaco 模式轮询比对
      ta.addEventListener('input', _markDirty);
      var _poll = setInterval(function(){
        if (!host.isConnected || !_editing){ clearInterval(_poll); return; }
        try {
          var cur = ta.value;
          var eds2 = (typeof g.MonacoEditor === 'object') ? (g.MonacoEditor.editors || g.MonacoEditor._editors) : null;
          if (eds2){
            for (var k in eds2){
              if (eds2[k]) { cur = eds2[k].getValue(); break; }
            }
          }
          if (_editing && cur !== _editing.orig){
            var t = _tabEntry();
            if (t && !t.dirty){ t.dirty = true; _renderEditTabs(); }
          }
        } catch(e){}
      }, 1200);
      ta.focus();
    });
  }
  function exitEdit(){
    _editing = null;
    if (typeof g.MonacoEditor === 'object' && g.MonacoEditor.destroy) g.MonacoEditor.destroy();
  }

  function clear(host){
    _editing = null;
    if (host) render(host, null);
  }

  // ── v4.87.0 · B2 Visual Diff (Monaco Diff Editor) ──
  function visualDiff(sideA, pathA, sideB, pathB){
    if (typeof g.MonacoEditor !== 'object' || !g.MonacoEditor.isLoaded()){
      toast('⚠ Monaco 未加载, 请刷新页面后重试', 'warn'); return;
    }
    var connA = connFor(sideA), connB = connFor(sideB);
    // 读两侧文件
    Promise.all([
      rpc('file_read', Object.assign({path: pathA}, connA)),
      rpc('file_read', Object.assign({path: pathB}, connB)),
    ]).then(function(results){
      var va = results[0].status === 'ok' ? (results[0].content || '') : '(读取失败)';
      var vb = results[1].status === 'ok' ? (results[1].content || '') : '(读取失败)';
      // 创建全屏 diff 弹窗
      var overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;background:var(--bg);z-index:200000;display:flex;flex-direction:column';
      overlay.innerHTML =
        '<div style="display:flex;align-items:center;gap:8px;padding:8px 14px;border-bottom:1px solid var(--border);background:var(--bg2)">'+
        '<b style="font-size:13px">📊 Visual Diff</b>'+
        '<span style="font-size:11px;color:var(--text3)">左: '+esc(pathA)+' · 右: '+esc(pathB)+'</span>'+
        '<span style="flex:1"></span>'+
        '<button class="btn btn-sm" onclick="this.closest(&quot;.fp-diff-overlay&quot;).remove()" style="font-size:11px">✕ 关闭</button></div>'+
        '<div id="fpDiffContainer" style="flex:1;min-height:0"></div>';
      overlay.className = 'fp-diff-overlay';
      document.body.appendChild(overlay);
      // Monaco Diff Editor
      _ensureLoaded(function(){
        if (typeof monaco === 'undefined') return;
        var lang = langFromName(pathA);
        var editor = monaco.editor.createDiffEditor(document.getElementById('fpDiffContainer'), {
          theme: _getTheme(), automaticLayout: true, readOnly: true,
          renderSideBySide: true, minimap: { enabled: false },
        });
        editor.setModel({
          original: monaco.editor.createModel(va, lang),
          modified: monaco.editor.createModel(vb, lang),
        });
      });
    });
  }

  // v4.97.0 · ← → / Esc 翻页 (仅当预览区挂着导航上下文时生效)
  document.addEventListener('keydown', function(ev){
    // v5.0.0 · 修复方向键不生效: 原条件要求 activeElement 在预览容器内 (实际多为 body),
    //   改为「找出当前可见且带导航上下文的预览容器」, 输入框/编辑态除外
    try {
      var ae = document.activeElement;
      if (ae && ae.tagName && /INPUT|TEXTAREA|SELECT/.test(ae.tagName)) return;
      if (ae && ae.isContentEditable) return;
      var hosts = document.querySelectorAll('.tp-preview, #fpPagePreview, .fp-host, .tri-preview');
      for (var i = 0; i < hosts.length; i++){
        var h = hosts[i];
        if (!h || !h._fpNavKeys) continue;
        if (!h.offsetParent) continue;              // 不可见 → 跳过
        var r = h.getBoundingClientRect();
        if (r.width < 40 || r.height < 40) continue;
        if (h._fpNavKeys(ev)){ ev.preventDefault(); ev.stopPropagation(); return; }
      }
    } catch(e){}
  }, true);
  g.FilePreview = { render: render, clear: clear, editInline: editInline, isEditing: isEditing,
                    _startEdit: _startEdit,
                    visualDiff: visualDiff,
                    exitEdit: exitEdit, kindOf: kindOf, isText: isText, isImg: isImg,
                    isArchive: isArchive, isAudio: isAudio, isVideo: isVideo, fmtB: fmtB,
                    resetView: resetView, currentView: currentView, VIEW: VIEW,
                    syncFullBtns: function(on){ if (_syncFullBtns) _syncFullBtns(!!on); } };
})(window);
