/* ============================================================================
 * file_ops.js · v4.58.0 · 文件预览/编辑/管理组件
 *  - 右键菜单: 预览/编辑/属性/重命名/删除/压缩/解压/新建目录/复制路径
 *  - 文本编辑: file_read → textarea → Ctrl+S → file_write (原子写回远端)
 *  - 图片预览: file_read_raw → data URL
 *  - 压缩包: file_archive_list 免下载浏览
 *  - 本机路径 conn={} (后端本地执行); 远端 conn=getSrvAuth()
 *  被 dual_pane_browser.js 的 oncontextmenu 调用: FileOps.showMenu(ev, side, path, type, paneHandle)
 * ========================================================================== */
(function(g){
  'use strict';

  function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g,function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function $(id){ return document.getElementById(id); }
  function toast(msg, kind, ms){ if (typeof g.toast==='function') g.toast(msg, kind, ms||2600); }

  function rpc(action, data){
    return new Promise(function(resolve){
      try { g.send(Object.assign({action:action}, data||{}), function(r){ resolve(r||{}); }); }
      catch(e){ resolve({status:'error', msg:String(e)}); }
    });
  }

  var IMAGE_EXTS = {jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',gif:'image/gif',
                    webp:'image/webp',svg:'image/svg+xml',bmp:'image/bmp',ico:'image/x-icon'};
  var TEXT_EXTS = ['txt','md','json','yaml','yml','xml','html','htm','css','js','ts','py','sh','bash',
                   'conf','cfg','ini','env','log','csv','sql','go','rs','java','c','h','cpp','hpp','rb',
                   'php','pl','lua','toml','properties','service','timer','desktop','list','rules',
                   'gitignore','editorconfig','makefile','cmake','lock','pub','key','pem','crt'];
  var ARCHIVE_SIG = ['.tar.gz','.tgz','.tar.bz2','.tbz2','.tbz','.tar.xz','.txz',
                     '.tar.zst','.tzst','.tar.lz4','.tar','.zip','.jar','.war','.apk','.7z','.rar',
                     '.gz','.bz2','.xz','.zst'];

  function ext(name){ var p=String(name||'').toLowerCase().split('.'); return p.length>1?p[p.length-1]:''; }
  function isImage(name){ return !!IMAGE_EXTS[ext(name)]; }
  function isArchive(name){
    var n = String(name||'').toLowerCase();
    for (var i=0;i<ARCHIVE_SIG.length;i++){ if (n.lastIndexOf(ARCHIVE_SIG[i])>=0 && n.endsWith(ARCHIVE_SIG[i])) return true; }
    return false;
  }
  function isText(name){
    var e = ext(name);
    return !e || TEXT_EXTS.indexOf(e)>=0;
  }
  function fmtSize(b){
    if (b==null || isNaN(b)) return '?';
    var u=['B','KB','MB','GB','TB'], i=0;
    while (b>=1024 && i<u.length-1){ b/=1024; i++; }
    return b.toFixed(b<10&&i>0?1:0)+' '+u[i];
  }

  // conn: 本机={} / 远端=getSrvAuth() (含 encodePassword 编码, 后端 SSHTarget 解码)
  function connFor(side){
    if (side==='remote' && typeof g.getSrvAuth==='function'){
      var a = g.getSrvAuth();
      if (a && a.host) return a;
    }
    return {};
  }

  var _lastArchivePw = '';   // v4.69.0 · 最近一次解锁归档成功的密码 (会话内复用)

  function closeMenu(){ var m=$('fopsCtxMenu'); if (m) m.remove(); }
  function closeModal(){ var m=$('fopsModal'); if (m) m.remove(); }

  // ── 模态框骨架 ──
  function modal(opts){
    closeModal();
    var m = document.createElement('div');
    m.id = 'fopsModal';
    m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:100000;display:flex;align-items:center;justify-content:center';
    m.innerHTML =
      '<div style="background:var(--bg2);border:1px solid var(--border);border-radius:10px;width:'+(opts.width||'760px')+';max-width:94vw;'+
      (opts.full?'height:90vh;':'max-height:88vh;')+
      'display:flex;flex-direction:column;box-shadow:0 18px 50px rgba(0,0,0,0.45)">'+
      '<div style="padding:9px 14px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px;min-width:0">'+
        '<span style="font-weight:600;font-size:13px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1">'+esc(opts.title||'')+'</span>'+
        (opts.actions||'')+
        '<button class="fops-close" style="background:none;border:none;color:var(--text3);font-size:16px;cursor:pointer;padding:2px 6px">✕</button>'+
      '</div>'+
      '<div class="fops-body" style="flex:1;overflow:auto;padding:12px 14px;min-height:0">'+(opts.body||'<div style="color:var(--text3);font-size:12px">加载中…</div>')+'</div>'+
      '</div>';
    document.body.appendChild(m);
    m.querySelector('.fops-close').onclick = closeModal;
    m.addEventListener('mousedown', function(ev){ if (ev.target===m) closeModal(); });
    return m;
  }

  // ── 右键菜单 ──
  function showMenu(ev, side, path, type, paneHandle){
    ev.preventDefault(); ev.stopPropagation();
    // localFs 模式: remote pane 实际走本机 list_dir → 文件操作也走本机
    if (paneHandle && paneHandle.isLocalFs && paneHandle.isLocalFs()) side = 'local';
    var cloudFs = paneHandle && paneHandle.isCloudFs && paneHandle.isCloudFs();
    closeMenu();
    var name = path.split('/').filter(Boolean).pop() || path;
    var isDir = type==='dir';

    var items = [];
    if (cloudFs){
      // ☁ 远端存储 (rclone remote): 仅支持进入目录/复制路径
      if (isDir) items.push({t:'📂 进入目录', fn:function(){ paneHandle && paneHandle.load(path); }});
      items.push({t:'📋 复制路径', fn:function(){ copyPath(path); }});
      _renderMenu(ev, items);
      return;
    }
    if (isDir){
      items.push({t:'📂 进入目录', fn:function(){ paneHandle && paneHandle.load(path); }});
      if (!cloudFs){
        items.push({t:'🗂 新建子目录', fn:function(){ mkdirIn(side, path, paneHandle); }});
        items.push({t:'📄 新建文件', fn:function(){ mkfileIn(side, path, paneHandle); }});
        items.push({t:'🗜 压缩… (tar.gz/zip/7z 等)', fn:function(){ compress(side, path, null, paneHandle); }});
        items.push({t:'👯 重复文件检测', fn:function(){ dupScan(side, path); }});
      }
    } else {
      items.push({t: isImage(name)?'🖼 预览图片':'📄 打开/预览', fn:function(){ preview(side, path); }});
      if (isText(name) && !isArchive(name)){
        items.push({t:'✏️ 编辑 (Ctrl+S 保存)', fn:function(){ edit(side, path); }});
      }
      if (isArchive(name)){
        items.push({t:'📦 浏览压缩包内容', fn:function(){ archiveList(side, path); }});
        items.push({t:'📤 解压到同目录', fn:function(){ extract(side, path, paneHandle); }});
      }
      if (/\.(log|out)$/i.test(name)){
        items.push({t:'📜 实时跟踪 (tail -f)', fn:function(){ tailLog(side, path); }});
      }
    }
    if (!cloudFs){
      items.push({sep:1});
      items.push({t:'✏️ 重命名', fn:function(){ rename(side, path, paneHandle); }});
      items.push({t:'🔐 修改权限…', fn:function(){ chmodModal(side, path, paneHandle); }},          // v5.90.5
                {t:'ℹ️ 属性', fn:function(){ statModal(side, path); }});
      items.push({t:'🗑 删除…', danger:1, fn:function(){ del(side, path, paneHandle); }});
    }
    if (isDir && !cloudFs){
      items.push({sep:1});
      items.push({t:'⚔ 双向同步冲突中心', fn:function(){ conflictCenter(); }});
    }
    // v5.17.0 · 栏内导航与收藏 (原工具栏 ⭐/📁▾ 收敛到右键菜单)
    if (!cloudFs && paneHandle){
      items.push({sep:1});
      if (isDir){
        items.push({t:'⬅ 返回上级目录', fn:function(){
          var cur = (paneHandle.getCwd && paneHandle.getCwd()) || path;
          var up = cur.replace(/\/+$/, '').split('/').slice(0, -1).join('/') || '/';
          if (paneHandle.load) paneHandle.load(up);
        }});
      }
      // 目录浏览+预览模式: 从预览态回到目录列表
      try {
        if (window.RpUI && window.RpUI.modeOf && window.RpUI.modeOf('transfer') === 'both'
            && typeof paneHandle.backToDir === 'function'){
          items.push({t:'📂 返回目录 (退出预览)', fn:function(){ paneHandle.backToDir(); }});
        }
      } catch(e){}
      var curFav = ((paneHandle.getCwd && paneHandle.getCwd()) || '').replace(/\/+$/, '') || '/';
      items.push({t: (typeof favIs === 'function' && favIs(side, curFav)) ? '☆ 取消收藏当前路径' : '⭐ 收藏当前路径',
                  fn:function(){ favToggle(side, curFav); }});
      var favs = (typeof favList === 'function') ? favList(side) : [];
      if (favs.length){
        items.push({sep:1});
        items.push({t:'📁 收藏夹 (' + favs.length + ')' , fn:function(){ favPopup(ev, side, paneHandle); }});
      }
    }
    items.push({sep:1});
    // v4.71.0 · 文件校验 (MD5/SHA256...)
    if (!isDir && !cloudFs){
      items.push({t:'🔐 校验 (MD5/SHA256)', fn:function(){ checksum(side, path); }});
    }
    items.push({t:'📋 复制路径', fn:function(){ copyPath(path); }});
    _renderMenu(ev, items);
  }

  // v4.71.0 · 文件校验弹窗 (算法可选 · 可与本地文件比对)
  function checksum(side, path){
    var conn = connFor(side);
    var algo = g.prompt('选择算法 (md5 / sha1 / sha256 / sha512):', 'sha256');
    if (!algo) return;
    algo = String(algo).trim().toLowerCase();
    if (['md5','sha1','sha256','sha512'].indexOf(algo) < 0){ toast('⚠ 不支持的算法', 'err'); return; }
    var m = modal({ title:'🔐 校验 · '+path, width:'680px',
      body:'<div style="font-size:11px;color:var(--text3)">⏳ 计算中…</div>' });
    rpc('file_checksum', Object.assign({path: path, algo: algo}, conn)).then(function(r){
      var body = m.querySelector('.fops-body');
      if (!body || !m.isConnected) return;
      if (r.status !== 'ok'){
        body.innerHTML = '<div style="color:var(--red);font-size:12px">✗ '+esc(r.msg||'计算失败')+'</div>';
        return;
      }
      body.innerHTML =
        '<div style="font-size:11px;color:var(--text3)">算法 '+esc(algo.toUpperCase())+' · 大小 '+fmtSize(r.size)+'</div>'+
        '<div style="font-family:monospace;font-size:13px;color:var(--cyan);margin:10px 0;word-break:break-all;user-select:all">'+esc(r.checksum||'')+'</div>'+
        '<div style="display:flex;gap:6px">'+
          '<button class="btn btn-sm btn-primary" id="fopsSumCopy">📋 复制校验值</button>'+
          '<button class="btn btn-sm" id="fopsSumCmp">🔍 与另一个文件比对</button></div>'+
        '<div id="fopsSumMsg" style="font-size:11px;color:var(--text3);margin-top:8px"></div>';
      var cp = m.querySelector('#fopsSumCopy');
      if (cp) cp.onclick = function(){
        if (window.copyToClipboard) window.copyToClipboard(r.checksum||'', function(){ toast('✓ 已复制'); });
        else if (navigator.clipboard) navigator.clipboard.writeText(r.checksum||'').then(function(){ toast('✓ 已复制'); });
        else toast(r.checksum||'');
      };
      var cm = m.querySelector('#fopsSumCmp');
      if (cm) cm.onclick = function(){
        var other = g.prompt('要比对的'+(conn.host?'远端':'本机')+'文件路径:', path);
        if (!other || other === path) return;
        rpc('file_checksum', Object.assign({path: other, algo: algo}, conn)).then(function(r2){
          var msg = m.querySelector('#fopsSumMsg');
          if (!msg) return;
          if (r2.status !== 'ok'){ msg.textContent = '✗ 读取失败: ' + (r2.msg||''); return; }
          var same = String(r2.checksum).toLowerCase() === String(r.checksum).toLowerCase();
          msg.style.color = same ? 'var(--green)' : 'var(--red)';
          msg.textContent = same ? '✓ 校验值一致 (两个文件相同)' : '✗ 校验值不同 (文件不一致)';
        });
      };
    });
  }

  function copyPath(path){
    if (navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(path).then(function(){ toast('✓ 已复制路径'); },
        function(){ toast('复制失败','err'); });
    } else { toast(path); }
  }

  function _renderMenu(ev, items){
    closeMenu();
    var m = document.createElement('div');
    m.id = 'fopsCtxMenu';
    m.style.cssText = 'position:fixed;z-index:100001;background:var(--bg2);border:1px solid var(--border);'+
      'border-radius:8px;box-shadow:0 10px 32px rgba(0,0,0,0.45);padding:4px;min-width:190px;font-size:12px';
    var html = '';
    for (var i=0;i<items.length;i++){
      var it = items[i];
      if (it.sep){ html += '<div style="height:1px;background:var(--border);margin:3px 6px"></div>'; continue; }
      html += '<div class="fops-mi" data-i="'+i+'" style="padding:6px 12px;border-radius:5px;cursor:pointer;color:'+
              (it.danger?'var(--red)':'var(--text)')+';white-space:nowrap">'+it.t+'</div>';
    }
    m.innerHTML = html;
    document.body.appendChild(m);
    var r = m.getBoundingClientRect();
    var x = Math.min(ev.clientX, g.innerWidth - r.width - 8);
    var y = Math.min(ev.clientY, g.innerHeight - r.height - 8);
    m.style.left = Math.max(4,x)+'px'; m.style.top = Math.max(4,y)+'px';
    m.querySelectorAll('.fops-mi').forEach(function(el){
      el.onmouseenter = function(){ el.style.background = 'var(--bg3)'; };
      el.onmouseleave = function(){ el.style.background = ''; };
      el.onclick = function(){
        closeMenu();
        var fn = items[parseInt(el.getAttribute('data-i'),10)].fn;
        if (fn) fn();
      };
    });
    setTimeout(function(){
      document.addEventListener('mousedown', _menuAutoClose);
      document.addEventListener('keydown', _menuEscClose);
    }, 0);
  }
  function _menuAutoClose(ev){
    var m=$('fopsCtxMenu');
    if (m && !m.contains(ev.target)){
      closeMenu();
      document.removeEventListener('mousedown', _menuAutoClose);
      document.removeEventListener('keydown', _menuEscClose);
    }
  }
  function _menuEscClose(ev){
    if (ev.key==='Escape'){
      closeMenu();
      document.removeEventListener('mousedown', _menuAutoClose);
      document.removeEventListener('keydown', _menuEscClose);
    }
  }

  // ── 预览路由 ──
  function preview(side, path){
    var name = path.split('/').filter(Boolean).pop() || '';
    if (isImage(name)) return imagePreview(side, path);
    if (isArchive(name)) return archiveList(side, path);
    if (/\.pdf$/i.test(name)) return pdfPreview(side, path);
    if (/\.(mp4|mkv|webm|avi|mov|mp3|flac|wav|ogg|m4a)$/i.test(name)) return mediaPreview(side, path);
    if (/\.(log|out)$/i.test(name) || /\.(log)$/i.test(name)){
      // 日志默认仍走编辑(可改), 跟踪走右键菜单「📜 实时跟踪」
      return edit(side, path);
    }
    // v5.83.3 · 其余类型交给**共享预览器**(与多云文件管理页面同一套: 文本/图片/音视频/压缩包/Office/PDF/字体/
    //   二进制十六进制等) → 三栏此前只认图片/压缩包/PDF/媒体, 其它一律进编辑器。文本仍走编辑器(可改)。
    var _fp = (typeof g.FilePreview !== 'undefined') ? g.FilePreview : window.FilePreview;
    if (!(_fp && _fp.isText && _fp.isText(name))) return sharedPreview(side, path, name);
    return edit(side, path);
  }

  // v5.83.3 · 共享预览(与多云文件管理一致), 装进本面板的模态宿主
  function sharedPreview(side, path, name){
    var _fp = (typeof g.FilePreview !== 'undefined') ? g.FilePreview : window.FilePreview;
    if (!_fp || !_fp.render) return edit(side, path);
    var m = modal({ title: '👁 ' + path, width: '960px', full: true });
    var body = m.querySelector('.fops-body');
    if (!body) return;
    body.style.minHeight = '60vh';
    try {
      _fp.render(body, { side: side, path: path, name: name });
    } catch (e) {
      body.innerHTML = '<div style="color:var(--red);padding:14px">预览失败: ' + esc(String(e && e.message || e)) + '</div>';
    }
  }

  // ── PDF 预览 (本机=流端点 iframe; 远端=base64 data URL) ──
  function pdfPreview(side, path){
    var conn = connFor(side);
    var local = !conn.host;
    var m = modal({ title:'📄 '+path, width:'auto', full:false,
      body:'<div style="text-align:center;color:var(--text3);font-size:12px;padding:30px">⏳ 加载中…</div>' });
    var body = m.querySelector('.fops-body');
    if (local){
      rpc('file_stream_token', {path: path}).then(function(r){
        if (!body || !m.isConnected) return;
        if (r.status !== 'ok'){
          body.innerHTML = '<div style="color:var(--red);padding:20px">✗ '+esc(r.msg||'签发失败')+'</div>';
          return;
        }
        var src = '/api/file/stream?path='+encodeURIComponent(path)+'&st='+encodeURIComponent(r.token);
        body.innerHTML = '<iframe src="'+src+'" style="width:74vw;height:calc(88vh - 96px);border:1px solid var(--border);border-radius:6px;background:#fff"></iframe>'+
          '<div style="text-align:center;color:var(--text3);font-size:11px;margin-top:4px">浏览器原生渲染 · 支持搜索</div>';
      });
    } else {
      rpc('file_read_raw', Object.assign({path: path, max_size: 50*1024*1024}, conn)).then(function(r){
        if (!body || !m.isConnected) return;
        if (r.status !== 'ok'){
          body.innerHTML = '<div style="color:var(--red);padding:20px">✗ '+esc(r.msg||'加载失败')+'</div>';
          return;
        }
        body.innerHTML = '<iframe src="data:application/pdf;base64,'+r.content_b64+'" style="width:74vw;height:calc(88vh - 96px);border:1px solid var(--border);border-radius:6px;background:#fff"></iframe>';
      });
    }
  }

  // ── 音视频播放 (本机=Range 流式; 远端=提示下载) ──
  function mediaPreview(side, path){
    var conn = connFor(side);
    var name = path.split('/').filter(Boolean).pop() || '';
    var isAudio = /\.(mp3|flac|wav|ogg|m4a)$/i.test(name);
    var local = !conn.host;
    if (!local){
      return modal({ title:'🎬 '+name, width:'460px',
        body:'<div style="color:var(--text2);font-size:13px;line-height:2">远端音视频流播需在本机有同名文件。<br>当前可点 ➕ 加入传输列表下载后播放。</div>' });
    }
    var m = modal({ title: (isAudio?'🎵 ':'🎬 ')+path, width:'720px',
      body:'<div style="text-align:center;color:var(--text3);font-size:12px;padding:20px">⏳ 准备流…</div>' });
    rpc('file_stream_token', {path: path}).then(function(r){
      var body = m.querySelector('.fops-body');
      if (!body || !m.isConnected) return;
      if (r.status !== 'ok'){
        body.innerHTML = '<div style="color:var(--red);padding:20px">✗ '+esc(r.msg||'签发失败')+'</div>';
        return;
      }
      var src = '/api/file/stream?path='+encodeURIComponent(path)+'&st='+encodeURIComponent(r.token);
      if (isAudio){
        body.innerHTML = '<audio controls autoplay src="'+src+'" style="width:100%;margin-top:20px"></audio>'+
          '<div style="text-align:center;color:var(--text3);font-size:11px;margin-top:8px">流式播放 (Range 请求) · '+esc(name)+'</div>';
      } else {
        body.innerHTML = '<video controls autoplay src="'+src+'" style="width:100%;max-height:calc(88vh - 120px);border-radius:6px;background:#000"></video>'+
          '<div style="text-align:center;color:var(--text3);font-size:11px;margin-top:6px">流式播放 (Range 请求 · 无需完整下载)</div>';
      }
    });
  }

  // ── 日志实时跟踪 (tail -f 模式: 2s 轮询尾部增量 + 级别着色) ──
  var _tailTimers = {};
  function tailLog(side, path){
    var conn = connFor(side);
    var m = modal({ title:'📜 实时跟踪 · '+path+(conn.host?(' · '+conn.user+'@'+conn.host):' · 本机'), width:'960px', full:true,
      body:'<pre id="fopsTailPre" style="height:calc(90vh - 130px);overflow:auto;font-family:ui-monospace,Consolas,monospace;font-size:11px;line-height:1.5;'+
           'background:var(--bg);color:var(--text2);border:1px solid var(--border);border-radius:6px;padding:8px;margin:0;white-space:pre-wrap;word-break:break-all">⏳ 加载中…</pre>'+
           '<div style="display:flex;gap:10px;align-items:center;margin-top:8px;font-size:11px">'+
           '<label style="cursor:pointer;display:inline-flex;align-items:center;gap:4px"><input type="checkbox" id="fopsTailFollow" checked> 跟随更新 (2s)</label>'+
           '<label style="cursor:pointer;display:inline-flex;align-items:center;gap:4px;color:var(--text3)">过滤: <input class="input" id="fopsTailFilter" placeholder="关键词" style="width:140px;height:22px;font-size:11px"></label>'+
           // v5.19.7 · A6 补齐: 级别下拉筛选 (all/info/warn/error/debug)
           '<label style="cursor:pointer;display:inline-flex;align-items:center;gap:4px;color:var(--text3)">级别: <select class="input" id="fopsTailLevel" style="width:86px;height:22px;font-size:11px">'+
             '<option value="all">全部</option><option value="info">INFO+</option>'+
             '<option value="warn">WARN+</option><option value="error">仅错误</option>'+
             '<option value="debug">含 DEBUG</option></select></label>'+
           '<span id="fopsTailStat" style="color:var(--text3)"></span></div>',
      actions:'<button class="btn btn-sm" id="fopsTailClr" style="font-size:11px">清屏</button>' });
    var pre = $('fopsTailPre');
    var clrBtn = $('fopsTailClr');
    if (clrBtn) clrBtn.onclick = function(){ if (pre) pre.textContent = ''; };
    if (!pre) return;
    var seenKeys = _tailTimers[path] || { lastSize: -1 };
    _tailTimers[path] = seenKeys;
    function colorize(line){
      if (/\b(ERROR|ERR|FATAL|CRITICAL|PANIC|FAIL(ED)?)\b/i.test(line)) return 'var(--red)';
      if (/\b(WARN(ING)?|NOTICE)\b/i.test(line)) return 'var(--orange)';
      if (/\b(DEBUG|TRACE)\b/i.test(line)) return 'var(--text3)';
      if (/\b(INFO|OK|SUCCESS)\b/i.test(line)) return 'var(--green)';
      return null;
    }
    // v5.19.7 · 级别判定 (供下拉筛选; colorize 已有同级正则, 复用口径)
    function _levelOf(line){
      if (/\b(ERROR|ERR|FATAL|CRITICAL|PANIC|FAIL(ED)?)\b/i.test(line)) return 'error';
      if (/\b(WARN(ING)?|NOTICE)\b/i.test(line)) return 'warn';
      if (/\b(DEBUG|TRACE)\b/i.test(line)) return 'debug';
      return 'info';
    }
    function _levelPass(line){
      var lv = ($('fopsTailLevel')||{}).value || 'all';
      if (lv === 'all') return true;
      var l = _levelOf(line);
      if (lv === 'error') return l === 'error';
      if (lv === 'warn') return l === 'error' || l === 'warn';
      if (lv === 'info') return l !== 'debug';       // INFO 及以上 (藏 DEBUG)
      if (lv === 'debug') return true;               // 含 DEBUG 全显
      return true;
    }
    function renderChunk(chunk, reset){
      var filter = ($('fopsTailFilter')||{}).value || '';
      var lines = chunk.split('\n');
      var frag = document.createDocumentFragment();
      for (var i=0;i<lines.length;i++){
        var ln = lines[i];
        if (!ln) continue;
        if (filter && ln.indexOf(filter) === -1) continue;
        if (!_levelPass(ln)) continue;   // v5.19.7 · 级别筛选
        var span = document.createElement('span');
        var c = colorize(ln);
        if (c) span.style.color = c;
        span.textContent = ln + '\n';
        frag.appendChild(span);
      }
      if (reset) pre.textContent = '';
      pre.appendChild(frag);
      if (($('fopsTailFollow')||{}).checked) pre.scrollTop = pre.scrollHeight;
    }
    function poll(){
      if (!m.isConnected || !$('fopsTailPre')){ clearInterval(t); return; }
      rpc('file_tail', Object.assign({path: path}, conn)).then(function(r){
        if (!m.isConnected) return;
        if (r.status !== 'ok'){
          pre.textContent = '✗ ' + (r.msg || '读取失败');
          return;
        }
        var st = $('fopsTailStat');
        if (st) st.textContent = '文件 ' + (r.size/1024/1024).toFixed(1) + ' MB · ' + new Date().toLocaleTimeString();
        if (r.size !== seenKeys.lastSize){
          var first = seenKeys.lastSize === -1;
          seenKeys.lastSize = r.size;
          renderChunk(r.chunk || '', first);  // 首次整体替换, 之后尾部刷新
        }
      });
    }
    poll();
    var t = setInterval(poll, 2000);
  }

  // ── 文本编辑器 ──
  function edit(side, path){
    var conn = connFor(side);
    var m = modal({ title:'✏️ 编辑 · '+path+(conn.host?(' · '+conn.user+'@'+conn.host):' · 本机'), width:'900px', full:true,
      body:'<textarea id="fopsEditor" spellcheck="false" style="width:100%;height:calc(90vh - 96px);font-family:ui-monospace,Consolas,monospace;'+
           'font-size:13px;line-height:1.55;background:var(--bg);color:var(--text);border:1px solid var(--border);'+
           'border-radius:6px;padding:10px;white-space:pre;overflow:auto" wrap="off">⏳ 加载中…</textarea>',
      actions:'<span id="fopsSaveStatus" style="font-size:11px;color:var(--text3)"></span>'+
              '<button class="btn btn-sm btn-primary" id="fopsSaveBtn" style="font-size:11px">💾 保存 (Ctrl+S)</button>' });

    var ta = $('fopsEditor');
    var onSave = null;
    rpc('file_read', Object.assign({path: path}, conn)).then(function(r){
      if (!ta || !$('fopsEditor')) return;  // 模态框已被关闭
      if (r.status!=='ok'){
        ta.value = '✗ '+(r.msg||'读取失败');
        ta.readOnly = true;
        return;
      }
      ta.value = r.content || '';
      var st = $('fopsSaveStatus');
      if (st) st.textContent = (conn.host?'远端':'本机')+' · '+fmtSize(r.size || ta.value.length);
      onSave = function(){
        var st2 = $('fopsSaveStatus');
        if (st2) st2.textContent = '⏳ 保存中…';
        rpc('file_write', Object.assign({path: path, content: ta.value}, conn)).then(function(w){
          var st3 = $('fopsSaveStatus');
          if (st3){
            st3.textContent = (w.status==='ok') ? '✓ 已保存 '+new Date().toLocaleTimeString() : '✗ '+(w.msg||'失败');
            st3.style.color = (w.status==='ok') ? 'var(--green)' : 'var(--red)';
          }
          toast(w.status==='ok' ? '✓ 已保存到 '+(conn.host||'本机') : '✗ '+(w.msg||'保存失败'),
                w.status==='ok'?'success':'err');
        });
      };
      var btn = $('fopsSaveBtn');
      if (btn) btn.onclick = function(){ if (onSave) onSave(); };
      ta.addEventListener('keydown', function(e){
        if ((e.ctrlKey||e.metaKey) && (e.key==='s'||e.key==='S')){
          e.preventDefault();
          if (onSave) onSave();
        }
      });
    });
  }

  // ── 图片预览 ──
  function imagePreview(side, path){
    var conn = connFor(side);
    var name = path.split('/').filter(Boolean).pop() || '';
    var mime = IMAGE_EXTS[ext(name)] || 'application/octet-stream';
    var m = modal({ title:'🖼 '+path, width:'auto',
      body:'<div style="text-align:center;color:var(--text3);font-size:12px;padding:20px">⏳ 加载中…</div>' });
    rpc('file_read_raw', Object.assign({path: path}, conn)).then(function(r){
      var body = m.querySelector('.fops-body');
      if (!body) return;
      if (r.status!=='ok'){
        body.innerHTML = '<div style="color:var(--red);font-size:13px;padding:20px;text-align:center">✗ '+esc(r.msg||'加载失败')+'</div>';
        return;
      }
      body.innerHTML = '<img src="data:'+mime+';base64,'+r.content_b64+'" style="max-width:100%;max-height:calc(88vh - 90px);object-fit:contain;border-radius:6px">'+
        '<div style="text-align:center;color:var(--text3);font-size:11px;margin-top:6px">'+fmtSize(r.size)+'</div>';
    });
  }

  // ── 压缩包内容浏览 ──
  function archiveList(side, path, password){
    var conn = connFor(side);
    var m = modal({ title:'📦 '+path, width:'760px',
      body:'<div style="color:var(--text3);font-size:12px;padding:10px">⏳ 读取目录中…</div>',
      actions:'<button class="btn btn-sm" id="fopsExtractBtn" style="font-size:11px">📤 解压到同目录</button>' });
    var btn = m.querySelector('#fopsExtractBtn');
    if (btn) btn.onclick = function(){ extract(side, path, null); };
    rpc('file_archive_list', Object.assign({archive_path: path, password: password||''}, conn)).then(function(r){
      var body = m.querySelector('.fops-body');
      if (!body) return;
      if (r.status!=='ok'){
        // v4.69.0 · 加密归档 → 输入密码重试
        if (r.need_password || /密码|password|加密|encrypted/i.test(r.msg||'')){
          body.innerHTML = '<div style="color:var(--orange);font-size:13px;line-height:1.9">🔒 该归档已加密，需密码才能浏览<br>'+
            '<div style="display:flex;gap:6px;margin-top:8px">'+
            '<input class="input" id="fopsArcPw" type="password" placeholder="请输入密码" style="flex:1">'+
            '<button class="btn btn-sm btn-primary" id="fopsArcPwGo">🔓 解锁</button></div>'+
            '<div id="fopsArcPwMsg" style="font-size:11px;color:var(--text3);margin-top:4px"></div></div>';
          var go = function(){
            var pw = ($('fopsArcPw')||{}).value || '';
            if (!pw){ var msg=$('fopsArcPwMsg'); if (msg) msg.textContent = '请输入密码'; return; }
            closeModal();
            archiveList(side, path, pw);
          };
          var b2 = $('fopsArcPwGo'); if (b2) b2.onclick = go;
          var inp = $('fopsArcPw');
          if (inp) inp.onkeydown = function(ev){ if (ev.key === 'Enter') go(); };
          return;
        }
        body.innerHTML = '<div style="color:var(--red);font-size:13px">✗ '+esc(r.msg||'读取失败')+'</div>';
        return;
      }
      _lastArchivePw = password || '';   // v4.69.0 · 解锁成功 → 会话内复用
      var lines = (r.files||'').split('\n').filter(Boolean);
      body.innerHTML = '<div style="color:var(--text3);font-size:11px;margin-bottom:6px">共 '+r.count+' 项 (最多显示前 200 行) · 点击行提取该文件</div>'+
        '<div style="background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:8px;max-height:60vh;overflow:auto">'+
        lines.map(function(l){
          return '<div class="fops-arcline" data-m="'+esc(l.trim())+'" style="font-size:11px;line-height:1.6;color:var(--text2);'+
                 'padding:1px 4px;border-radius:3px;cursor:pointer" onmouseover="this.style.background=\'var(--bg3)\'" onmouseout="this.style.background=\'\'">'+esc(l)+'</div>';
        }).join('')+'</div>';
      body.querySelectorAll('.fops-arcline').forEach(function(el){
        el.onclick = function(){
          var member = el.getAttribute('data-m');
          if (!member || member.endsWith('/')) return;
          if (!g.confirm('提取包内文件:\n' + member + '\n到压缩包同目录的 _extracted 目录?')) return;
          rpc('file_archive_extract_one', Object.assign({archive_path: path, member: member, password: _lastArchivePw||''}, conn)).then(function(x){
            toast(x.status==='ok' ? '✓ '+x.msg : '✗ '+(x.msg||'提取失败'), x.status==='ok'?'success':'err', 3600);
          });
        };
      });
    });
  }

  // ── 属性 ──
  // v5.90.5 · 🔐 修改权限/属主 (chmod/chown) — 关键系统文件风险提示
  var _FOPS_CRIT_RES = [
    /^\/boot\/(efi|grub|grub2)(\/|$)/i, /^\/boot\/(vmlinuz|initrd|initramfs|system\.map)/i,
    /^\/etc\/(fstab|crypttab)$/i, /^\/etc\/default\/grub$/i, /^\/etc\/grub\.d\//i,
    /^\/etc\/(passwd|shadow|group|gshadow|sudoers)$/i, /^\/etc\/sudoers\//i,
    /^\/etc\/ssh\/sshd_config$/i, /^\/etc\/systemd\/system\//i,
    /^\/lib\/systemd\/system\//i, /^\/usr\/lib\/systemd\/system\//i,
    /^\/etc\/cron/i, /^\/etc\/pam\.d\//i
  ];
  function _fopsModeToOctal(m){
    var t = String(m || '').trim();
    if (/^[0-7]{3,4}$/.test(t)) return t;
    t = t.replace(/^[-bcdlps]/, '');
    if (t.length < 9) return '';
    var out = '';
    for (var i = 0; i < 9; i += 3){
      var v = 0;
      for (var j = 0; j < 3; j++){
        var c = t[i + j];
        v += (c === 'r' ? 4 : c === 'w' ? 2 : (c === 'x' || c === 's' || c === 't') ? 1 : 0);
      }
      out += v;
    }
    return out;
  }
  function chmodModal(side, path, paneHandle){
    var isDir = String(path).split('/').filter(Boolean).length === 0 ? false : undefined;
    var conn = connFor(side);
    var m = modal({ title:'🔐 修改权限 · '+path, width:'540px',
      body:'<div style="color:var(--text3);font-size:12px;padding:8px">⏳ 读取当前属性…</div>' });
    rpc('file_stat', Object.assign({path: path}, conn)).then(function(sr){
      var body = m.querySelector('.fops-body');
      if (!body) return;
      var perms = '', owner = '', group = '';
      if (sr.status === 'ok'){
        perms = sr.perms || ''; owner = sr.owner || '';
        var og = String(owner).split(':'); owner = og[0] || ''; group = og[1] || '';
      }
      var crit = _FOPS_CRIT_RES.some(function(rx){ return rx.test(path); });
      var curOct = _fopsModeToOctal(perms);
      var h = '';
      if (crit){
        h += '<div style="background:rgba(200,40,40,.10);border:1px solid #c0392b;border-radius:6px;padding:8px 10px;color:#c0392b;font-size:12px;margin-bottom:8px">'
          + '⚠️ <b>高风险系统文件</b> — 引导/内核/挂载表/认证等关键路径, 错误的权限或属主可能导致系统'
          + '<b>无法启动或无法登录</b>。除非完全清楚后果, 建议交由专业运维处理。</div>'
          + '<label style="display:block;font-size:12px;margin-bottom:8px;cursor:pointer">'
          + '<input type="checkbox" id="fopsAttrAck"> 我已了解风险并确认要修改</label>';
      }
      h += '<div style="font-size:12px;color:var(--text3);margin-bottom:6px">当前: <span style="font-family:monospace">'
        + esc(perms || '?') + (curOct ? ' (' + curOct + ')' : '') + '</span>'
        + (owner ? ' · 属主 <span style="font-family:monospace">' + esc(owner + (group ? ':' + group : '')) + '</span>' : '') + '</div>'
        + '<div style="display:flex;gap:6px;align-items:center;margin-bottom:8px;font-size:12px">'
        + '权限(八进制) <input class="input" id="fopsAttrMode" style="width:80px;height:26px" value="' + esc(curOct) + '" placeholder="如 644">'
        + '<button class="btn btn-sm" id="fopsA644">644</button>'
        + '<button class="btn btn-sm" id="fopsA755">755</button>'
        + '<button class="btn btn-sm" id="fopsA600">600</button></div>'
        + '<div style="display:flex;gap:6px;align-items:center;font-size:12px;margin-bottom:8px">'
        + '属主 <input class="input" id="fopsAttrOwner" style="width:100px;height:26px" value="' + esc(owner) + '" placeholder="留空不改">'
        + '属组 <input class="input" id="fopsAttrGroup" style="width:100px;height:26px" value="' + esc(group) + '" placeholder="留空不改"></div>'
        + '<div style="font-size:11px;color:var(--text3)">留空的项不会被修改; 修改立即生效。</div>'
        + '<div style="margin-top:10px;display:flex;gap:8px;justify-content:flex-end">'
        + '<button class="btn btn-sm btn-primary" id="fopsAttrApply">✓ 应用</button></div>';
      body.innerHTML = h;
      ['644','755','600'].forEach(function(v){
        var b = body.querySelector('#fopsA' + v);
        if (b) b.onclick = function(){ body.querySelector('#fopsAttrMode').value = v; };
      });
      var applyBtn = body.querySelector('#fopsAttrApply');
      var ack = body.querySelector('#fopsAttrAck');
      function refreshAck(){
        if (!ack || !applyBtn) return;
        applyBtn.disabled = !ack.checked;
        applyBtn.style.opacity = ack.checked ? 1 : .5;
      }
      if (ack) { refreshAck(); ack.onchange = refreshAck; }
      if (applyBtn) applyBtn.onclick = function(){
        var mode = (body.querySelector('#fopsAttrMode').value || '').trim();
        var ow = (body.querySelector('#fopsAttrOwner').value || '').trim();
        var gp = (body.querySelector('#fopsAttrGroup').value || '').trim();
        if (!mode && !ow && !gp){ toast('未填写任何修改项', 'err'); return; }
        if (crit && ack && !ack.checked){ toast('高风险文件: 请先勾选风险确认', 'err'); return; }
        rpc('file_chmod', Object.assign({path: path, mode: mode, owner: ow, group: gp}, conn)).then(function(r){
          toast(r.status==='ok' ? '✓ '+(r.msg||'已应用') : '✗ '+(r.msg||'失败'), r.status==='ok'?'success':'err');
          if (r.status==='ok'){ m.remove(); if (paneHandle && paneHandle.load) paneHandle.load(paneHandle.getCwd()); }
        });
      };
    });
  }

  function statModal(side, path){
    var conn = connFor(side);
    var m = modal({ title:'ℹ️ 属性 · '+path, width:'520px',
      body:'<div style="color:var(--text3);font-size:12px;padding:8px">⏳ 读取中…</div>' });
    rpc('file_stat', Object.assign({path: path}, conn)).then(function(r){
      var body = m.querySelector('.fops-body');
      if (!body) return;
      if (r.status!=='ok'){
        body.innerHTML = '<div style="color:var(--red);font-size:13px">✗ '+esc(r.msg||'读取失败')+'</div>';
        return;
      }
      var rows = [
        ['路径', r.path], ['类型', r.file_type || '-'], ['大小', fmtSize(r.size)+' ('+r.size+' B)'],
        ['权限', r.perms], ['属主', r.owner], ['MIME', r.mime||'-'],
        ['修改时间', r.mtime ? new Date(parseInt(r.mtime,10)*1000).toLocaleString() : '-'],
        ['位置', conn.host ? (conn.user+'@'+conn.host+':'+conn.port) : '本机'],
      ];
      body.innerHTML = '<table style="width:100%;font-size:12px;border-collapse:collapse">'+
        rows.map(function(row){
          return '<tr><td style="padding:5px 10px;color:var(--text3);white-space:nowrap;width:80px;border-bottom:1px solid var(--border)">'+row[0]+'</td>'+
                 '<td style="padding:5px 10px;color:var(--text);word-break:break-all;border-bottom:1px solid var(--border)">'+esc(row[1])+'</td></tr>';
        }).join('')+'</table>';
    });
  }

  // ── 删除 ──
  function del(side, path, paneHandle){
    if (!g.confirm || !g.confirm('确定删除 '+path+' ？\n此操作不可恢复！')) return;
    var conn = connFor(side);
    rpc('file_delete', Object.assign({path: path}, conn)).then(function(r){
      toast(r.status==='ok' ? '✓ 已删除' : '✗ '+(r.msg||'删除失败'), r.status==='ok'?'success':'err');
      if (r.status==='ok' && paneHandle && paneHandle.load) paneHandle.load(paneHandle.getCwd());
    });
  }

  // ── 重命名 ──
  function rename(side, oldPath, paneHandle){
    var newName = g.prompt('新名称 (同目录=改名, 跨目录=移动):', oldPath);
    if (!newName || newName===oldPath) return;
    var conn = connFor(side);
    rpc('file_rename', Object.assign({old_path: oldPath, new_path: newName}, conn)).then(function(r){
      toast(r.status==='ok' ? '✓ 重命名成功' : '✗ '+(r.msg||'失败'), r.status==='ok'?'success':'err');
      if (r.status==='ok' && paneHandle && paneHandle.load) paneHandle.load(paneHandle.getCwd());
    });
  }

  // ── 新建目录 ──
  function mkdirIn(side, parentPath, paneHandle){
    var name = g.prompt('新目录名:');
    if (!name) return;
    var conn = connFor(side);
    rpc('file_mkdir', Object.assign({path: parentPath.replace(/\/$/,'')+'/'+name}, conn)).then(function(r){
      toast(r.status==='ok' ? '✓ 目录已创建' : '✗ '+(r.msg||'失败'), r.status==='ok'?'success':'err');
      if (r.status==='ok' && paneHandle && paneHandle.load) paneHandle.load(paneHandle.getCwd());
    });
  }

  // v5.17.0 · 新建空文件 (目标区高频需求: 先建占位文件/命名再传)
  function mkfileIn(side, parentPath, paneHandle){
    var name = g.prompt('新文件名 (可带路径, 如 sub/a.txt):');
    if (!name) return;
    name = String(name).trim().replace(/^\/+/, '');
    if (!name) return;
    if (name.indexOf('..') >= 0){ toast('⚠ 路径不允许含 ..', 'err'); return; }
    var conn = connFor(side);
    var full = parentPath.replace(/\/$/,'') + '/' + name;
    rpc('file_mkfile', Object.assign({path: full, content: ''}, conn)).then(function(r){
      toast(r.status==='ok' ? '✓ 文件已创建: '+name : '✗ '+(r.msg||'失败'), r.status==='ok'?'success':'err');
      if (r.status==='ok' && paneHandle && paneHandle.load) paneHandle.load(paneHandle.getCwd());
    });
  }

  // ── v5.17.0 · 栏内收藏 (与 dual_pane_browser 共用 localStorage 键 dpb_favs_<side>) ──
  function _favKey(side){ return 'dpb_favs_' + String(side || 'local'); }
  function favList(side){
    try { return JSON.parse(localStorage.getItem(_favKey(side)) || '[]'); } catch(e){ return []; }
  }
  function favSave(side, list){
    try { localStorage.setItem(_favKey(side), JSON.stringify(list || [])); } catch(e){}
    try { if (window.PaneFavs && window.PaneFavs.refresh) window.PaneFavs.refresh(); } catch(e){}
  }
  function favIs(side, path){
    return favList(side).indexOf(String(path || '').replace(/\/+$/, '') || '/') >= 0;
  }
  function favToggle(side, path){
    var p = String(path || '').replace(/\/+$/, '') || '/';
    var list = favList(side);
    var i = list.indexOf(p);
    if (i >= 0){ list.splice(i, 1); toast('☆ 已取消收藏: ' + p, 'info'); }
    else { list.unshift(p); toast('⭐ 已收藏: ' + p, 'success'); }
    favSave(side, list);
  }
  function favPopup(ev, side, paneHandle){
    var list = favList(side);
    var m = modal({ title: '📁 收藏夹 · ' + (side === 'local' ? '本机' : '远端'), width: '520px',
      body: list.length
        ? '<div style="font-size:11px;color:var(--text3);margin-bottom:6px">点击跳转 · ✕ 删除</div>' +
          list.map(function(f, i){
            return '<div style="display:flex;align-items:center;gap:6px;padding:5px 8px;border-radius:5px;border-bottom:1px dashed var(--border)">'+
              '<span class="fops-fav-go" data-i="'+i+'" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:monospace;font-size:11px;color:var(--cyan);cursor:pointer" title="'+esc(f)+'">'+esc(f)+'</span>'+
              '<button class="btn btn-sm fops-fav-del" data-i="'+i+'" style="padding:1px 6px;font-size:10px;color:var(--red)">✕</button></div>';
          }).join('')
        : '<div style="font-size:12px;color:var(--text3)">暂无收藏 — 在右键菜单里点「⭐ 收藏当前路径」</div>' });
    m.querySelectorAll('.fops-fav-go').forEach(function(el){
      el.onclick = function(){
        var f = favList(side)[parseInt(el.getAttribute('data-i'), 10)];
        if (f && paneHandle && paneHandle.load){ paneHandle.load(f); m.remove(); }
      };
    });
    m.querySelectorAll('.fops-fav-del').forEach(function(el){
      el.onclick = function(){
        var i = parseInt(el.getAttribute('data-i'), 10);
        var l2 = favList(side); l2.splice(i, 1); favSave(side, l2);
        m.remove(); favPopup(ev, side, paneHandle);
      };
    });
  }

  // ── 压缩 ──
  var _compressFormats = [
    { key:'targz',  label:'tar.gz (通用)', ext:'.tar.gz',  pw:false },
    { key:'tarbz2', label:'tar.bz2 (兼容老系统)', ext:'.tar.bz2', pw:false },
    { key:'tarxz',  label:'tar.xz (压缩率最高)', ext:'.tar.xz', pw:false },
    { key:'tarzst', label:'tar.zst (现代·快)', ext:'.tar.zst', pw:false },
    { key:'zip',    label:'zip (Windows 友好·支持密码)', ext:'.zip', pw:true },
    { key:'7z',     label:'7z (压缩率最高·支持密码)', ext:'.7z', pw:true }
  ];
  function compress(side, path, format, paneHandle){
    var conn = connFor(side);
    var preset = format || 'targz';
    if (preset === 'tar.gz') preset = 'targz';
    var m = modal({ title:'🗜 压缩 · '+path, width:'560px',
      body:'<div style="display:flex;flex-direction:column;gap:10px;font-size:12px">'+
        '<div><label style="font-size:11px;color:var(--text3)">压缩格式</label>'+
        '<select class="input" id="fopsZipFmt" style="width:100%">'+
        _compressFormats.map(function(f){
          return '<option value="'+f.key+'"'+(f.key===preset?' selected':'')+' data-pw="'+(f.pw?1:0)+'">'+f.label+'</option>';
        }).join('')+'</select></div>'+
        '<div><label style="font-size:11px;color:var(--text3)">压缩级别 (1 最快 / 9 最小)</label>'+
        '<input class="input" id="fopsZipLevel" type="number" min="1" max="9" value="6" style="width:100px"></div>'+
        '<div id="fopsZipPwRow" style="display:none"><label style="font-size:11px;color:var(--text3)">🔒 密码 (可选, 加密后需密码解压)</label>'+
        '<input class="input" id="fopsZipPw" type="password" placeholder="留空 = 不加密" style="width:100%"></div>'+
        '<div style="font-size:11px;color:var(--text3);line-height:1.7">tar 系列不支持密码（如需加密请选 zip / 7z）。7z 加密会同时隐藏文件名。</div>'+
        '</div>',
      actions:'<button class="btn btn-sm btn-primary" id="fopsZipGo">🗜 开始压缩</button>' });
    var sel = m.querySelector('#fopsZipFmt');
    var pwRow = m.querySelector('#fopsZipPwRow');
    var sync = function(){
      var opt = sel.options[sel.selectedIndex];
      pwRow.style.display = (opt && opt.getAttribute('data-pw') === '1') ? '' : 'none';
    };
    sel.onchange = sync; sync();
    m.querySelector('#fopsZipGo').onclick = function(){
      var fmt = sel.value;
      var level = parseInt((m.querySelector('#fopsZipLevel')||{}).value || '6', 10) || 6;
      var pw = (m.querySelector('#fopsZipPw')||{}).value || '';
      closeModal();
      toast('⏳ 压缩中 (大文件/高压缩率可能较慢)…', 'info', 4000);
      rpc('file_compress', Object.assign({path: path, format: fmt, level: level, password: pw}, conn)).then(function(r){
        toast(r.status==='ok' ? '✓ '+r.msg : '✗ '+(r.msg||'压缩失败'), r.status==='ok'?'success':'err', 4600);
        if (r.status==='ok' && paneHandle && paneHandle.load) paneHandle.load(paneHandle.getCwd());
      });
    };
  }

  // ── 解压 ──
  function extract(side, archivePath, paneHandle, password){
    var conn = connFor(side);
    var go = function(p){
      toast('⏳ 解压中…');
      rpc('file_extract', Object.assign({archive_path: archivePath, password: p||''}, conn)).then(function(r){
        if (r.status !== 'ok' && /密码|password|加密|encrypted/i.test(r.msg||'')){
          var np = g.prompt('🔒 该归档已加密，请输入密码:\n' + archivePath, '');
          if (np != null && np !== ''){ go(np); return; }
        }
        toast(r.status==='ok' ? '✓ '+r.msg : '✗ '+(r.msg||'解压失败'), r.status==='ok'?'success':'err', 4200);
        if (r.status==='ok' && paneHandle && paneHandle.load) paneHandle.load(paneHandle.getCwd());
      });
    };
    go(password != null ? password : _lastArchivePw);
  }

  // ── 重复文件检测 (E4 · size 分组 + sha256 精查) ──
  function fmtB(n){
    var b = Number(n) || 0, u = ['B','KB','MB','GB','TB'], i = 0;
    while (b >= 1024 && i < u.length-1){ b /= 1024; i++; }
    return (i ? b.toFixed(1) : b) + ' ' + u[i];
  }
  function dupScan(side, dirPath){
    var conn = connFor(side);
    var m = modal({ title:'👯 重复文件检测 · '+dirPath+(conn.host?(' · '+conn.user+'@'+conn.host):' · 本机'),
      width:'860px',
      body:'<div style="font-size:12px;color:var(--text3);margin-bottom:8px">两层过滤: 同大小才哈希 → sha256 相同判重复。远端零依赖 (find+sha256sum)。</div>'+
           '<div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap;font-size:12px">'+
           '<label style="color:var(--text3)">最小大小: <input class="input" id="dupMin" type="number" value="1024" style="width:90px"> B</label>'+
           '<button class="btn btn-sm btn-primary" id="dupGo">🔍 开始扫描</button>'+
           '<span id="dupStat" style="color:var(--text3)"></span></div>'+
           '<div id="dupResult" style="max-height:56vh;overflow:auto"></div>',
      actions:'' });
    var go = m.querySelector('#dupGo');
    if (go) go.onclick = function(){
      var minSize = parseInt((m.querySelector('#dupMin')||{}).value || '1024', 10) || 1024;
      var res = m.querySelector('#dupResult');
      var stat = m.querySelector('#dupStat');
      if (res) res.innerHTML = '<div style="color:var(--text3);font-size:12px;padding:10px">⏳ 扫描中 (大目录可能需要较长时间)…</div>';
      rpc('dup_scan', Object.assign({path: dirPath, min_size: minSize}, conn)).then(function(r){
        if (!m.isConnected) return;
        if (r.status !== 'ok'){
          if (res) res.innerHTML = '<div style="color:var(--red);font-size:13px;padding:10px">✗ '+esc(r.msg||'失败')+'</div>';
          return;
        }
        var groups = r.groups || [];
        if (stat) stat.textContent = groups.length + ' 组重复 · 可回收 ' + (r.wasted_fmt || '0 B');
        if (!groups.length){
          if (res) res.innerHTML = '<div style="color:var(--green);font-size:13px;padding:10px">✓ 未发现重复文件 (共扫描 '+r.total_files+' 个文件)</div>';
          return;
        }
        var html = '<div style="font-size:11px;color:var(--text3);margin-bottom:6px">每组默认保留修改时间最新的一份, 勾选要删除的副本:</div>';
        groups.forEach(function(g2, gi){
          html += '<div style="border:1px solid var(--border);border-radius:6px;margin-bottom:6px;overflow:hidden">'+
            '<div style="padding:5px 8px;background:var(--bg3);font-size:11px;color:var(--text2)">'+
            '组 '+(gi+1)+' · '+(g2.count)+' 个相同 · 每个 '+fmtB(g2.size)+' · 可回收 <b style="color:var(--orange)">'+fmtB(g2.wasted)+'</b></div>'+
            '<div style="padding:4px 8px">';
          g2.files.forEach(function(f, fi){
            html += '<label style="display:flex;align-items:center;gap:6px;padding:2px 0;font-size:11px;cursor:pointer">'+
              '<input type="checkbox" class="dup-chk" data-g="'+gi+'" value="'+esc(f)+'" style="width:13px;height:13px">'+
              '<span style="font-family:monospace;word-break:break-all;color:'+(fi===0?'var(--green)':'var(--text2)')+'">'+esc(f)+(fi===0?' (建议保留)':'')+'</span></label>';
          });
          html += '</div></div>';
        });
        html += '<button class="btn btn-sm" id="dupDelSel" style="color:var(--red);margin-top:4px">🗑 删除勾选副本</button>';
        if (res) res.innerHTML = html;
        var delBtn = m.querySelector('#dupDelSel');
        if (delBtn) delBtn.onclick = function(){
          var sel = Array.prototype.slice.call(m.querySelectorAll('.dup-chk:checked')).map(function(cb){ return cb.value; });
          if (!sel.length){ toast('⚠ 请先勾选要删除的副本', 'err'); return; }
          if (!g.confirm('确定删除 '+sel.length+' 个重复副本？\n(不可恢复!)')) return;
          rpc('dup_delete', Object.assign({paths: sel}, conn)).then(function(d){
            toast(d.status==='ok' ? '✓ '+d.msg : '✗ '+(d.msg||'失败'), d.status==='ok'?'success':'err', 3000);
            if (d.status==='ok') go.click();
          });
        };
      });
    };
    go && go.click();
  }

  // ── 双向同步冲突中心 (B2 · v4.63.0; v5.14.0 保留本地/远端可执行) ──
  async function conflictCenter(){
    var m = modal({ title:'⚔ 双向同步冲突中心', width:'880px',
      body:'<div style="font-size:11px;color:var(--text3);margin-bottom:8px">双向同步时两边都改过的文件会记录在这里 (默认策略 keep-both: 远端旧版已隔离为 <b>.conflict_时间戳</b> 副本, 同步后自动拉回本地, 两个版本都不丢)。<b style="color:var(--text2)">保留本地/保留远端</b> 会用已存服务器档案对该文件做一次单向覆盖传输并标记解决。</div>'+
           '<div id="scList" style="max-height:62vh;overflow:auto"><div style="color:var(--text3);font-size:12px;padding:10px">⏳ 加载中…</div></div>',
      actions:'<button class="btn btn-sm" id="scRefresh" style="font-size:11px">↻ 刷新</button>' });
    m.querySelector('#scRefresh').onclick = loadList;
    loadList();
    var _scRows = {};
    async function loadList(){
      var r = await rpc('sync_conflict_list', {open_only: false});
      var host = m.querySelector('#scList');
      if (!host || !m.isConnected) return;
      if (r.status !== 'ok'){
        host.innerHTML = '<div style="color:var(--red);font-size:13px">✗ '+esc(r.msg||'加载失败')+'</div>';
        return;
      }
      var rows = r.conflicts || [];
      _scRows = {};
      rows.forEach(function(c){ _scRows[c.id] = c; });
      if (!rows.length){
        host.innerHTML = '<div style="color:var(--green);font-size:13px;padding:10px">✓ 暂无冲突记录。双向同步两边同改同一文件时会自动记录到这里。</div>';
        return;
      }
      host.innerHTML = '<table style="width:100%;border-collapse:collapse;font-size:12px">'+
        '<tr style="color:var(--text3);font-size:11px;border-bottom:1px solid var(--border)">'+
        '<td style="padding:5px 6px">时间</td><td style="padding:5px 6px">冲突文件</td>'+
        '<td style="padding:5px 6px">同步对</td><td style="padding:5px 6px">状态</td>'+
        '<td style="padding:5px 6px">操作</td></tr>'+
        rows.map(function(c){
          var open = !c.resolution;
          var pair = (c.host ? (c.host) : '本机') + ' ↔ ' + (c.src_path || '');
          return '<tr style="border-bottom:1px dashed var(--border)">'+
            '<td style="padding:5px 6px;color:var(--text3);font-size:11px;white-space:nowrap">'+esc(c.created_at)+'</td>'+
            '<td style="padding:5px 6px;font-family:monospace;font-size:11px;word-break:break-all;color:var(--text)">'+esc(c.rel_path)+
            '<div style="font-size:10px;color:var(--text3)">本机 mtime '+esc(c.local_mtime||'?')+' · 远端 '+esc(c.remote_mtime||'?')+' · '+fmtB(c.size)+'</div></td>'+
            '<td style="padding:5px 6px;font-size:10px;color:var(--text3)">'+esc(pair)+'</td>'+
            '<td style="padding:5px 6px;font-size:11px;color:'+(open?'var(--orange)':'var(--text3)')+'">'+(open?'⚔ 未处理':'✓ '+esc(c.resolution))+'</td>'+
            '<td style="padding:5px 6px;white-space:nowrap">'+
            (open ? '<button class="btn btn-sm" onclick="FileOps._scKeep('+c.id+',\'local\')" style="font-size:10px;padding:2px 6px" title="用本地版本覆盖远端">⬆ 保留本地</button> '+
                   '<button class="btn btn-sm" onclick="FileOps._scKeep('+c.id+',\'remote\')" style="font-size:10px;padding:2px 6px" title="用远端版本覆盖本地">⬇ 保留远端</button> '+
                   '<button class="btn btn-sm" onclick="FileOps._scDiff('+c.id+')" style="font-size:10px;padding:2px 6px" title="Monaco 双屏对比两版内容">🔍 Diff</button> '+
            '<button class="btn btn-sm" onclick="FileOps._scResolve('+c.id+')" style="font-size:10px;padding:2px 6px">✓ 已处理</button> ' : '')+
            '<button class="btn btn-sm" onclick="FileOps._scDelete('+c.id+')" style="font-size:10px;padding:2px 6px;color:var(--red)">🗑</button>'+
            '</td></tr>';
        }).join('') + '</table>';
    }
    g.FileOps._scResolve = function(id){
      rpc('sync_conflict_resolve', {id: id, resolution: 'resolved'}).then(function(r){
        toast(r.status==='ok' ? '✓ 已标记解决' : '✗ '+(r.msg||'失败'), r.status==='ok'?'success':'err');
        loadList();
      });
    };
    g.FileOps._scDelete = function(id){
      rpc('sync_conflict_delete', {id: id}).then(function(r){
        toast(r.status==='ok' ? '✓ 记录已删除' : '✗ '+(r.msg||'失败'), r.status==='ok'?'success':'err');
        loadList();
      });
    };
    // v5.19.6 · Visual Diff 接入冲突中心: 本地当前版 vs .conflict_* 隔离副本 (两侧皆本机)
    g.FileOps._scDiff = function(id){
      var c = _scRows[id];
      if (!c){ toast('记录不存在', 'warn'); return; }
      var dir = String(c.src_path || '').replace(/\/+$/, '');
      var base = String(c.rel_path || '').split('/').pop();
      var parent = String(c.rel_path || '').split('/').slice(0, -1).join('/');
      rpc('list_dir', { path: dir + '/' + (parent || '') }).then(function(r){
        var ents = (r && (r.entries || r.files)) || [];
        var cands = ents.filter(function(e){
          var n = e.name || '';
          return n.indexOf(base + '.conflict_') === 0 && !(e.is_dir);
        }).map(function(e){ return e.path || (dir + '/' + parent + '/' + e.name); });
        if (!cands.length){
          toast('⚠ 未找到隔离副本 (' + base + '.conflict_*) — keep-both 副本可能已被清理', 'warn', 5200);
          return;
        }
        var localPath = dir + '/' + c.rel_path;
        var pick = cands[0];
        var finish = function(){
          if (typeof FilePreview !== 'undefined' && typeof FilePreview.visualDiff === 'function'){
            FilePreview.visualDiff('local', pick, 'local', localPath);
          } else {
            toast('⚠ Diff 组件未加载', 'err');
          }
        };
        if (cands.length > 1){
          var body = '<div style="font-size:12px;margin-bottom:8px">发现 '+cands.length+' 个隔离副本, 选择要与当前版本对比的一份:</div>'+
            cands.map(function(p2, i){
              return '<div style="padding:5px 8px;border-bottom:1px dashed var(--border);cursor:pointer;font-family:monospace;font-size:11px;color:var(--cyan)" class="sc-diff-pick" data-i="'+i+'">'+esc(p2.split('/').pop())+'</div>';
            }).join('');
          var m2 = modal({ title: '🔍 选择对比版本', width: '560px', body: body });
          m2.querySelectorAll('.sc-diff-pick').forEach(function(el){
            el.onclick = function(){ pick = cands[parseInt(el.getAttribute('data-i'), 10)]; m2.remove(); finish(); };
          });
        } else { finish(); }
      });
    };

    // v5.14.0 · 保留本地/远端: 按已存服务器档案对该文件做单向覆盖传输, 成功后标记解决
    g.FileOps._scKeep = function(id, side){
      var c = _scRows[id];
      if (!c){ toast('记录不存在', 'warn'); return; }
      var creds = null;
      var list = (typeof window.__serversCache !== 'undefined' && window.__serversCache) || [];
      for (var i = 0; i < list.length; i++){
        if (String(list[i].host || '') === String(c.host || '')){ creds = list[i]; break; }
      }
      if (c.host && !creds){ toast('未找到 ' + esc(c.host) + ' 的已存服务器档案, 请先在三栏连接一次', 'warn', 3800); return; }
      var lp = String(c.src_path || '').replace(/\/+$/, '') + '/' + c.rel_path;
      var rp = String(c.dst_path || '').replace(/\/+$/, '') + '/' + c.rel_path;
      var params = (side === 'local')
        ? { action: 'rsync', direction: 'up', src: lp, dst: rp }
        : { action: 'rsync', direction: 'down', src: rp, dst: lp };
      if (creds){
        params.host = creds.host || '';
        params.port = creds.port || 22;
        params.user = creds.user || 'root';
        params.auth_type = creds.auth_type || 'pass';
        params.password = creds.password || '';
        params.key = creds.key || '';
        params.passphrase = creds.passphrase || '';
      }
      toast('⏳ 正在保留' + (side === 'local' ? '本地' : '远端') + '版本 (单文件传输中)…', 'info', 3200);
      g.send(params, function(fin){
        if (fin && fin.status === 'success'){
          rpc('sync_conflict_resolve', { id: id, resolution: side === 'local' ? 'keep_local' : 'keep_remote' }).then(function(){
            toast('✓ 已保留' + (side === 'local' ? '本地' : '远端') + '版本并标记解决', 'success');
            if (typeof g.refreshAllPanes === 'function') g.refreshAllPanes();
            loadList();
          });
        } else {
          toast('✗ ' + ((fin && fin.msg) || '传输失败'), 'err', 4200);
        }
      });
    };
  }

  g.FileOps = {
    showMenu: showMenu,
    preview: preview, edit: edit, tailLog: tailLog, dupScan: dupScan, conflictCenter: conflictCenter,
    compressFormats: function(){ return _compressFormats.slice(); },
    checksum: checksum,
    imagePreview: imagePreview, archiveList: archiveList,
    statModal: statModal, chmodModal: chmodModal,
    del: del, rename: rename, mkdirIn: mkdirIn,
    // v5.17.0 · 三栏工具栏/右键共用入口
    _mkdirIn: mkdirIn, _mkfileIn: mkfileIn, mkfileIn: mkfileIn,
    favToggle: favToggle, favList: favList, favIs: favIs, favSave: favSave, favPopup: favPopup,
    compress: compress, extract: extract,
    closeMenu: closeMenu, closeModal: closeModal,
    connFor: connFor,
    isImage: isImage, isArchive: isArchive, isText: isText,
  };
})(window);
