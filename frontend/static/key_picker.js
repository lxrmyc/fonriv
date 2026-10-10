/* v5.90.2 · 密钥/位置选择器 KeyPicker (全站共用)
 * 背景(用户报): ① 选"密钥"后输入框只是一个掩码框/预填 ~/.ssh/id_rsa, 没有真正的选文件入口
 *   → 拿着控制机上不存在的路径去连, 文件管理里列不出文件与目录;
 *   ② 连接中心把"密码"和"密钥"塞在同一个输入区, 语义不清;
 *   ③ 密钥选择器与备份中心的"备份保存路径"选择器两套位置口径, 用户要求统一。
 * 设计(用户拍板):
 *   位置口径与 TargetPicker 对齐 —— 💻 本机 / 💽 df 挂载点 / 🌐 网络共享 / 🖥 已存服务器 /
 *   ☁ 远端存储 (+ 粘贴密钥内容), 这样"文件保存"和"文件选择"可以调用同一个选择器:
 *     KeyPicker.open(onPick, {mode:'file'})   选文件 (密钥: 服务器/云端会取回到控制机缓存)
 *     KeyPicker.open(onPick, {mode:'dir'})    选目录 (保存路径语义)
 *     KeyPicker.pickInto('authValue')         静态按钮/输入框直接调用
 *     KeyPicker.pickDirInto('backupDst')      保存路径输入框
 *   从服务器/云端取: 下载到控制机缓存目录(0700/0600)再用 —— 后端 key_cache_* 已做
 *   防泄漏/劫持护栏(64KB上限 + PRIVATE KEY 嗅探 + sha256展示 + 可清理)。
 * 集成方式:
 *   KeyPicker.pickInto(inputId, opts)         给输入框选值
 *   KeyPicker.attach(inputEl, opts)           给输入框挂 📁 按钮 (幂等)
 *   KeyPicker.autoWatch()                     扫描全站"认证=密钥"的输入框自动挂按钮
 */
(function (g) {
  'use strict';

  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function $(id){ return document.getElementById(id); }
  function rpc(a, d){
    return new Promise(function(res){
      try { g.send(Object.assign({action: a}, d || {}), function(r){ res(r || {}); }); }
      catch(e){ res({status:'error', msg:String(e)}); }
    });
  }
  function toast(m, t, ms){ try { if (g.toast) g.toast(m, t, ms || 2600); } catch(_){} }
  /* 目录类 action (list_remote_dir / remote_ls) 的响应 type 不在 app.js send() 白名单里
     (app.js v4.96.0 注释: 这类请求要用 rpcDirAction) → 用错助手会永远等不到回调, 表现为
     "点列出没反应/一直转圈"。这里统一走 rpcDirAction, 退化时才用普通 send。 */
  function rpcRaw(a, d, ms){
    if (typeof g.rpcDirAction === 'function') return g.rpcDirAction(a, d, ms || 20000);
    return rpc(a, d);
  }
  function trimSlash(p){ return String(p || '/').replace(/\/+$/, '') || '/'; }

  /* 位置类型顺序与 TargetPicker 一致: 本机 / df挂载点 / 网络共享 / 已存服务器 / 远端存储 */
  var LOC_TABS_ALL = [['local','💻 本机'],['df','💽 df 挂载点'],['share','🌐 网络共享'],
                  ['server','🖥 已存服务器'],['cloud','☁ 远端存储']];
  // v6.16.2 批18 · 社区版隐藏未随包来源 (df 挂载点=disk 键 / 远端存储=cloud 键); 网络共享保留
  var _isComm = (window.__licFeatEdition || 'community') === 'community';
  var LOC_TABS = _isComm
    ? LOC_TABS_ALL.filter(function(x){ return x[0] !== 'df' && x[0] !== 'cloud'; })
    : LOC_TABS_ALL;

  var _box = null, _opts = {}, _onPick = null;
  function close(){
    if (_box){ try { _box.remove(); } catch(_){} _box = null; }
  }

  /* ════════════ 弹窗 ════════════ */
  function open(onPick, opts){
    close();
    opts = opts || {};
    _opts = { mode: opts.mode || 'file',           // file | dir
              kinds: opts.kinds || ['local','df','share','server','cloud'],
              title: opts.title || null,
              startKind: opts.startKind || null };
    _onPick = onPick || function(){};
    var isFile = _opts.mode !== 'dir';
    var tabs = LOC_TABS.filter(function(t){ return _opts.kinds.indexOf(t[0]) >= 0; });
    if (isFile) tabs = tabs.concat([['paste','📋 粘贴内容']]);
    var title = _opts.title || (isFile ? '🔑 选择密钥文件' : '📁 选择目录');

    var b = document.createElement('div');
    _box = b;
    b.id = 'kpModal';
    // v5.90.2 · z-index 13500: 必须高于连接中心档案编辑器弹窗(12000) 与面板其它弹窗(13000),
    //   否则从编辑器里点 🔑 打开的选择器会被压在下面 —— 用户表现为"点了没反应"
    // v5.90.5 · 层级改为动态: 从目录浏览器(dirBrowseModal)里点 🔑 时, kp 要压在它上面;
    //   反过来 kp 里点「浏览」打开的目录浏览器由下方 handler 抬到 kp 之上 —— 谁后打开谁在上
    var _kpZ = 13500;
    try {
      var _dm0 = document.getElementById('dirBrowseModal');
      if (_dm0 && _dm0.style.display !== 'none' && _dm0.style.zIndex){
        _kpZ = Math.max(_kpZ, (parseInt(_dm0.style.zIndex, 10) || 0) + 100);
      }
    } catch(_){}
    b.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:'+_kpZ+';display:flex;align-items:center;justify-content:center';
    b.innerHTML =
      '<div style="background:var(--bg2);border:1px solid var(--border);border-radius:10px;min-width:560px;max-width:94vw;max-height:86vh;display:flex;flex-direction:column;padding:16px 18px;box-shadow:0 20px 60px rgba(0,0,0,0.5)">'
      + '<div style="font-size:14.5px;font-weight:600;margin-bottom:2px">' + esc(title) + '</div>'
      + '<div style="font-size:10.5px;color:var(--text3);margin-bottom:10px">'
      +   (isFile ? '密钥取自服务器/云端时会下载到控制机缓存目录 (0600, 可在下方清理); sha256 会展示供比对'
                 : '位置口径与备份中心的保存路径一致 (本机 / df挂载点 / 网络共享 / 已存服务器 / 远端存储)')
      + '</div>'
      + '<div style="display:flex;gap:2px;border-bottom:1px solid var(--border);margin-bottom:10px;flex-wrap:wrap">'
      +   tabs.map(function(t,i){
            return '<span class="kp-tab" data-k="'+t[0]+'" style="padding:5px 10px;font-size:12px;cursor:pointer;border-bottom:2px solid '+(i===0?'var(--blue)':'transparent')+';color:'+(i===0?'var(--blue)':'var(--text3)')+'">'+t[1]+'</span>';
          }).join('')
      + '</div>'
      + '<div style="flex:1;overflow:auto;min-height:200px">'
      /* 💻 本机 */
      + '<div class="kp-pane" data-k="local" style="display:flex;flex-direction:column;gap:8px">'
      +   '<div class="browse-row"><input class="input" id="kpLocalPath" placeholder="/root/.ssh/id_ed25519 或任意本机路径" style="flex:1;font-family:monospace;font-size:12px">'
      +     '<button class="btn btn-sm" id="kpLocalBrowse" title="浏览控制机目录">📁 浏览</button></div>'
      +   '<button class="btn btn-sm btn-primary" id="kpLocalUse" style="align-self:flex-start">✓ 使用此路径</button>'
      + '</div>'
      /* 💽 df 挂载点 */
      + '<div class="kp-pane" data-k="df" style="display:none;flex-direction:column;gap:8px">'
      +   '<select class="input" id="kpDfSel" style="font-size:12px"></select>'
      +   '<div class="browse-row"><input class="input" id="kpDfSub" placeholder="该挂载点下的子路径 (可留空 = 挂载点根)" style="flex:1;font-family:monospace;font-size:12px">'
      +     '<button class="btn btn-sm" id="kpDfBrowse">📁 浏览</button></div>'
      +   '<div id="kpDfInfo" style="font-size:10.5px;color:var(--text3)"></div>'
      +   '<button class="btn btn-sm btn-primary" id="kpDfUse" style="align-self:flex-start">✓ 使用此位置</button>'
      + '</div>'
      /* 🌐 网络共享 */
      + '<div class="kp-pane" data-k="share" style="display:none;flex-direction:column;gap:8px">'
      +   '<select class="input" id="kpShSel" style="font-size:12px"></select>'
      +   '<div class="browse-row"><input class="input" id="kpShSub" placeholder="共享内的子路径 (可留空 = 共享根)" style="flex:1;font-family:monospace;font-size:12px">'
      +     '<button class="btn btn-sm" id="kpShBrowse">📁 浏览</button></div>'
      +   '<div id="kpShInfo" style="font-size:10.5px;color:var(--text3)"></div>'
      +   '<button class="btn btn-sm btn-primary" id="kpShUse" style="align-self:flex-start">✓ 使用此位置</button>'
      + '</div>'
      /* 🖥 已存服务器 */
      + '<div class="kp-pane" data-k="server" style="display:none;flex-direction:column;gap:8px">'
      +   '<select class="input" id="kpSrvSel" style="font-size:12px"></select>'
      +   '<div class="browse-row"><input class="input" id="kpSrvPath" placeholder="/root/.ssh/  (点「列出」浏览)" style="flex:1;font-family:monospace;font-size:12px">'
      +     '<button class="btn btn-sm" id="kpSrvList">📂 列出</button></div>'
      +   '<div id="kpSrvFiles" style="min-height:60px;max-height:220px;overflow:auto;border:1px solid var(--border);border-radius:6px;font-size:11.5px;padding:4px">'
      +     (isFile ? '选择服务器 → 点「列出」→ 点文件即取回并缓存到控制机' : '选择服务器 → 点「列出」→ 进入目录后点「选用当前目录」') + '</div>'
      +   '<button class="btn btn-sm btn-primary" id="kpSrvUse" style="align-self:flex-start;display:' + (isFile ? 'none' : '') + '">✓ 选用当前目录</button>'
      + '</div>'
      /* ☁ 远端存储 */
      + '<div class="kp-pane" data-k="cloud" style="display:none;flex-direction:column;gap:8px">'
      +   '<select class="input" id="kpCloudSel" style="font-size:12px"></select>'
      +   '<div class="browse-row"><input class="input" id="kpCloudPath" placeholder="远端存储内的路径" style="flex:1;font-family:monospace;font-size:12px">'
      +     '<button class="btn btn-sm" id="kpCloudList">📂 列出</button></div>'
      +   '<div id="kpCloudFiles" style="min-height:60px;max-height:220px;overflow:auto;border:1px solid var(--border);border-radius:6px;font-size:11.5px;padding:4px">'
      +     (isFile ? '选择远端存储 → 点「列出」→ 点文件即取回并缓存到控制机' : '选择远端存储 → 点「列出」→ 进入目录后点「选用当前目录」') + '</div>'
      +   '<button class="btn btn-sm btn-primary" id="kpCloudUse" style="align-self:flex-start;display:' + (isFile ? 'none' : '') + '">✓ 选用当前目录</button>'
      + '</div>'
      /* 📋 粘贴内容 (仅文件/密钥模式) */
      + (isFile ?
        '<div class="kp-pane" data-k="paste" style="display:none;flex-direction:column;gap:8px">'
      +   '<textarea class="input" id="kpPaste" rows="6" placeholder="-----BEGIN OPENSSH PRIVATE KEY----- ..." style="font-family:monospace;font-size:11px"></textarea>'
      +   '<div style="display:flex;gap:6px;align-items:center"><input class="input" id="kpPasteName" placeholder="保存名(可选, 如 id_ed25519)" style="flex:1;font-size:12px">'
      +     '<button class="btn btn-sm btn-primary" id="kpPasteSave">✓ 保存并使用</button></div>'
      + '</div>' : '')
      + '</div>'
      + '<div style="display:flex;gap:8px;align-items:center;margin-top:12px;border-top:1px solid var(--border);padding-top:8px">'
      +   '<span id="kpCacheInfo" style="font-size:10.5px;color:var(--text3);flex:1"></span>'
      +   '<button class="btn btn-sm" id="kpCacheClear">🧹 清理缓存</button>'
      +   '<button class="btn" id="kpCancel">取消</button>'
      + '</div></div>';
    document.body.appendChild(b);
    b.onclick = function(ev){ if (ev.target === b) close(); };
    b.querySelector('#kpCancel').onclick = close;

    function pick(path, note){
      if (!path){ toast('未选择任何路径', 'warn'); return; }
      close();
      if (note) toast(note, 'success', 3600);
      try { _onPick && _onPick(path); } catch(e){ console.warn('[KeyPicker] onPick', e); }
    }
    _pickDone = pick;

    /* tab 切换 */
    b.querySelectorAll('.kp-tab').forEach(function(t){
      t.onclick = function(){
        var k = t.getAttribute('data-k');
        b.querySelectorAll('.kp-tab').forEach(function(x){ x.style.borderBottomColor='transparent'; x.style.color='var(--text3)'; });
        t.style.borderBottomColor='var(--blue)'; t.style.color='var(--blue)';
        b.querySelectorAll('.kp-pane').forEach(function(p){ p.style.display = p.getAttribute('data-k')===k ? 'flex' : 'none'; });
        if (k === 'df') loadDf();
        if (k === 'share') loadShares();
        if (k === 'server') loadServers();
        if (k === 'cloud') loadClouds();
      };
    });
    if (_opts.startKind){
      var st = b.querySelector('.kp-tab[data-k="'+_opts.startKind+'"]');
      if (st) st.onclick();
    }

    /* ── 💻 本机 ── */
    // v5.90.5 · 从 kp 里打开目录浏览器: 把 dirBrowseModal 抬到 kp 之上, 修复"点浏览没反应"(实际被压住)
    function _liftDirBrowser(){
      try {
        var dm = document.getElementById('dirBrowseModal');
        if (dm) dm.style.zIndex = String((parseInt(b.style.zIndex, 10) || _kpZ) + 100);
      } catch(_){}
    }
    b.querySelector('#kpLocalBrowse').onclick = function(){
      var inp = $('kpLocalPath');
      if (typeof g.openDirBrowser === 'function'){ g.openDirBrowser(inp, inp.value || (isFile ? '~/.ssh' : '/'), 'local'); _liftDirBrowser(); }
      else inp.placeholder = '请直接输入控制机上的路径';
    };
    b.querySelector('#kpLocalUse').onclick = function(){
      var v = ($('kpLocalPath').value || '').trim();
      if (!v){ toast('请填写本机路径', 'warn'); return; }
      pick(v);
    };

    /* ── 💽 df 挂载点 ── */
    var _dfRows = [];
    function loadDf(){
      var sel = $('kpDfSel');
      if (_dfRows.length) return;
      sel.innerHTML = '<option>加载中…</option>';
      rpc('mounts_list', {}).then(function(r){
        if (r.status !== 'ok'){ sel.innerHTML = '<option value="">✗ ' + esc(r.msg || '读取挂载点失败') + '</option>'; return; }
        _dfRows = (r.mounts || []).filter(function(m){ return !m.readonly; });
        if (!_dfRows.length){ sel.innerHTML = '<option value="">(无可用挂载点)</option>'; return; }
        sel.innerHTML = _dfRows.map(function(m){
          var av = m.avail ? (' · 可用 ' + Math.round(m.avail / 1073741824 * 10) / 10 + 'G') : '';
          return '<option value="'+esc(m.mount)+'">'+esc(m.mount)+' · '+esc(m.fstype || '')+av+'</option>';
        }).join('');
        dfInfo();
      });
    }
    function dfInfo(){
      var m = _dfRows.find(function(x){ return x.mount === $('kpDfSel').value; }) || {};
      $('kpDfInfo').textContent = m.mount ? ('挂载点 ' + m.mount + ' · ' + (m.fstype || '') + (m.is_share ? ' · 网络共享挂载' : '')) : '';
    }
    b.querySelector('#kpDfSel').onchange = dfInfo;
    b.querySelector('#kpDfBrowse').onclick = function(){
      var m = _dfRows.find(function(x){ return x.mount === $('kpDfSel').value; });
      if (!m){ toast('请先选择挂载点', 'warn'); return; }
      var sub = ($('kpDfSub').value || '').replace(/^\/+/, '');
      var start = trimSlash(m.mount) + (sub ? '/' + sub : '');
      var tmp = document.createElement('input');
      tmp.value = '';
      if (typeof g.openDirBrowser === 'function'){
        g.openDirBrowser(tmp, start, 'local');
        _liftDirBrowser();
        var t = setInterval(function(){
          if (tmp.value){
            clearInterval(t);
            $('kpDfSub').value = String(tmp.value).slice(trimSlash(m.mount).length).replace(/^\/+/, '');
          } else if (!document.getElementById('dirBrowseModal') || document.getElementById('dirBrowseModal').style.display === 'none'){
            clearInterval(t);
          }
        }, 400);
      }
    };
    b.querySelector('#kpDfUse').onclick = function(){
      var m = _dfRows.find(function(x){ return x.mount === $('kpDfSel').value; });
      if (!m){ toast('请先选择挂载点', 'warn'); return; }
      var sub = ($('kpDfSub').value || '').replace(/^\/+/, '').replace(/\/+$/, '');
      pick(trimSlash(m.mount) + (sub ? '/' + sub : ''));
    };

    /* ── 🌐 网络共享 ── */
    var _shRows = [];
    function loadShares(){
      var sel = $('kpShSel');
      if (_shRows.length) return;
      sel.innerHTML = '<option>加载中…</option>';
      rpc('share_list', {}).then(function(r){
        if (r.status !== 'ok'){ sel.innerHTML = '<option value="">✗ ' + esc(r.msg || '读取共享失败') + '</option>'; return; }
        _shRows = (r.shares || []).filter(function(s){ return s.mounted && (s.mnt || s.uuid); });
        if (!_shRows.length){ sel.innerHTML = '<option value="">(无已挂载共享 — 先到「网络共享」挂载)</option>'; return; }
        sel.innerHTML = _shRows.map(function(s){
          return '<option value="'+esc(s.mnt || '')+'">'+esc(s.name || s.host || s.uuid)+' · '+esc(s.proto || '')+' · '+esc(s.mnt || '')+'</option>';
        }).join('');
        shInfo();
      });
    }
    function shInfo(){
      var s = _shRows.find(function(x){ return (x.mnt || '') === $('kpShSel').value; }) || {};
      $('kpShInfo').textContent = s.mnt ? ('共享挂载点 ' + s.mnt + ' · ' + (s.host || '') + ' · ' + (s.rw_label || s.rw || '')) : '';
    }
    b.querySelector('#kpShSel').onchange = shInfo;
    b.querySelector('#kpShBrowse').onclick = function(){
      var s = _shRows.find(function(x){ return (x.mnt || '') === $('kpShSel').value; });
      if (!s){ toast('请先选择共享', 'warn'); return; }
      var sub = ($('kpShSub').value || '').replace(/^\/+/, '');
      var start = trimSlash(s.mnt) + (sub ? '/' + sub : '');
      var tmp = document.createElement('input');
      tmp.value = '';
      if (typeof g.openDirBrowser === 'function'){
        g.openDirBrowser(tmp, start, 'local');
        _liftDirBrowser();
        var t = setInterval(function(){
          if (tmp.value){
            clearInterval(t);
            $('kpShSub').value = String(tmp.value).slice(trimSlash(s.mnt).length).replace(/^\/+/, '');
          } else if (!document.getElementById('dirBrowseModal') || document.getElementById('dirBrowseModal').style.display === 'none'){
            clearInterval(t);
          }
        }, 400);
      }
    };
    b.querySelector('#kpShUse').onclick = function(){
      var s = _shRows.find(function(x){ return (x.mnt || '') === $('kpShSel').value; });
      if (!s){ toast('请先选择共享', 'warn'); return; }
      var sub = ($('kpShSub').value || '').replace(/^\/+/, '').replace(/\/+$/, '');
      pick(trimSlash(s.mnt) + (sub ? '/' + sub : ''));
    };

    /* ── 🖥 已存服务器 (密钥: 取回缓存; 目录: 返回 host:path) ── */
    async function loadServers(){
      var sel = $('kpSrvSel');
      if (sel.options.length) return;
      sel.innerHTML = '<option>加载中…</option>';
      var rows = [];
      try {
        if (g.SP && g.SP.serverRows){ var r = await g.SP.serverRows(); rows = (r && (r.configs || r.rows)) || []; }
      } catch(_){}
      if (!rows.length){
        try { var r2 = await rpc('sp_list', {}); rows = (r2.profiles || []).map(function(p){
          return {name: p.name, host: p.hostname, port: p.ssh_port, user: p.ssh_user}; }); } catch(_){}
      }
      sel.innerHTML = rows.length
        ? rows.map(function(s){ return '<option value="'+esc(s.host)+'|'+esc(s.port || 22)+'">'+esc(s.name || s.host)+' · '+esc(s.host)+'</option>'; }).join('')
        : '<option value="">(无已存服务器 — 请到「连接中心」添加)</option>';
    }
    var _srvCur = '';
    function srvTarget(){
      var v = String($('kpSrvSel').value || '').split('|');
      return { host: v[0], port: v[1] || 22 };
    }
    b.querySelector('#kpSrvList').onclick = async function(){
      var t = srvTarget();
      if (!t.host){ toast('请先选择服务器', 'warn'); return; }
      var box = $('kpSrvFiles');
      box.innerHTML = '<div style="color:var(--text3);padding:6px">⏳ 列出中…</div>';
      var path = trimSlash(($('kpSrvPath').value || '/').trim()) + '/';
      var r = await rpcRaw('list_remote_dir', {host: t.host, port: t.port, path: path});
      if (r.status !== 'ok'){ box.innerHTML = '<div style="color:var(--red);padding:6px">✗ ' + esc(r.msg || '列出失败') + '</div>'; return; }
      _srvCur = path;
      $('kpSrvPath').value = path;
      var entries = r.entries || [];
      var dirs = entries.filter(function(e){ return e.type === 'dir'; });
      var files = entries.filter(function(e){ return e.type !== 'dir'; });
      box.innerHTML =
        (path !== '/' ? '<div class="kp-up" style="padding:4px 6px;cursor:pointer;color:var(--cyan)">⬆ ..</div>' : '')
        + dirs.map(function(e){ return '<div class="kp-dir" data-p="'+esc(e.path)+'" style="padding:4px 6px;cursor:pointer">📁 '+esc(e.name)+'</div>'; }).join('')
        + (files.length ? files.map(function(e){ return '<div class="kp-file" data-p="'+esc(e.path)+'" style="padding:4px 6px;cursor:pointer">📄 '+esc(e.name)+'</div>'; }).join('') : '<div style="color:var(--text3);padding:6px">(此目录无文件)</div>');
      box.querySelectorAll('.kp-dir, .kp-up').forEach(function(el){
        el.onclick = function(){
          var p = el.getAttribute('data-p') || _srvCur.replace(/[^/]+\/$/, '');
          $('kpSrvPath').value = p;
          b.querySelector('#kpSrvList').onclick();
        };
      });
      box.querySelectorAll('.kp-file').forEach(function(el){
        el.onclick = async function(){
          var fp = el.getAttribute('data-p');
          if (!isFile){ $('kpSrvPath').value = _srvCur; return; }
          el.textContent = '⏳ 取回中…';
          var fr = await rpc('key_cache_fetch', {src_kind:'server', host: t.host, port: t.port, path: fp});
          if (fr.status !== 'ok'){ el.textContent = '✗ ' + (fr.msg || '取回失败'); toast(fr.msg || '取回失败', 'err', 5000); return; }
          pick(fr.path, '✓ 已缓存到控制机 · ' + String(fr.sha256 || '').slice(0, 12));
        };
      });
    };
    b.querySelector('#kpSrvUse').onclick = function(){
      var t = srvTarget();
      if (!t.host){ toast('请先选择服务器', 'warn'); return; }
      var p = ($('kpSrvPath').value || _srvCur || '/').trim();
      pick(t.host + ':' + trimSlash(p));
    };

    /* ── ☁ 远端存储 ── */
    var _cloudRid = 0, _cloudCur = '';
    async function loadClouds(){
      // v1.0.0 · 社区档无"远端存储"键 → 直接空列表(不打扰后端)
      if (window.__featInEdition && !window.__featInEdition('cloud')){ return; }
      var sel = $('kpCloudSel');
      if (sel.options.length > 1) return;
      sel.innerHTML = '<option>加载中…</option>';
      var r = await rpc('remote_list', {});
      var remotes = (r.remotes || r.list || []);
      sel.innerHTML = remotes.length
        ? remotes.map(function(x){
            var nm = x.name || x.bucket || ('#' + (x.id || x.remote_id));
            return '<option value="'+(x.id || x.remote_id || 0)+'">'+esc(nm)+' · '+esc(x.provider || x.kind || '')+'</option>';
          }).join('')
        : '<option value="">(无远端存储 — 请到「远端存储」添加)</option>';
      _cloudRid = parseInt(sel.value, 10) || 0;
    }
    b.querySelector('#kpCloudSel').onchange = function(){ _cloudRid = parseInt($('kpCloudSel').value, 10) || 0; };
    b.querySelector('#kpCloudList').onclick = async function(){
      if (!_cloudRid){ toast('请先选择远端存储', 'warn'); return; }
      var box = $('kpCloudFiles');
      box.innerHTML = '<div style="color:var(--text3);padding:6px">⏳ 列出中…</div>';
      var path = ($('kpCloudPath').value || '').trim();
      var r = await rpcRaw('remote_ls', {remote_id: _cloudRid, path: path});
      if (r.status !== 'ok'){
        box.innerHTML = '<div style="color:var(--red);padding:6px">✗ ' + esc(r.msg || '列出失败') + '</div>';
        return;
      }
      var base = trimSlash((r.path != null) ? String(r.path) : path);
      var entries = r.entries || [];
      _cloudCur = base;
      var _child = function(nm){ return (base === '/' ? '' : base) + '/' + nm; };
      box.innerHTML =
        (base ? '<div class="kp-up" style="padding:4px 6px;cursor:pointer;color:var(--cyan)">⬆ ..</div>' : '')
        + entries.filter(function(e){ return !e.__up; }).map(function(e){
            var isDir = !!(e.is_dir || e.type === 'dir');
            var full = e.path || _child(e.name);
            return '<div class="kp-'+(isDir ? 'dir' : 'file')+'" data-p="'+esc(full)+'" style="padding:4px 6px;cursor:pointer">'
                   + (isDir ? '📁 ' : '📄 ') + esc(e.name) + (e.size ? (' · ' + Math.round(e.size / 1024) + 'KB') : '') + '</div>';
          }).join('')
        + (entries.length ? '' : '<div style="color:var(--text3);padding:6px">(此路径无内容)</div>');
      box.querySelectorAll('.kp-up').forEach(function(el){
        el.onclick = function(){
          $('kpCloudPath').value = base.replace(/\/?[^/]*$/, '').replace(/\/+$/, '');
          b.querySelector('#kpCloudList').onclick();
        };
      });
      box.querySelectorAll('.kp-dir').forEach(function(el){
        el.onclick = function(){ $('kpCloudPath').value = el.getAttribute('data-p'); b.querySelector('#kpCloudList').onclick(); };
      });
      box.querySelectorAll('.kp-file').forEach(function(el){
        el.onclick = async function(){
          var fp = el.getAttribute('data-p');
          if (!isFile){ $('kpCloudPath').value = _cloudCur; return; }
          el.textContent = '⏳ 下载中…';
          var fr = await rpc('key_cache_fetch', {src_kind:'cloud', remote_id: _cloudRid, key: fp});
          if (fr.status !== 'ok'){ el.textContent = '✗ ' + (fr.msg || '下载失败'); toast(fr.msg || '下载失败', 'err', 5000); return; }
          pick(fr.path, '✓ 已缓存到控制机 · ' + String(fr.sha256 || '').slice(0, 12));
        };
      });
    };
    b.querySelector('#kpCloudUse').onclick = function(){
      if (!_cloudRid){ toast('请先选择远端存储', 'warn'); return; }
      var nm = $('kpCloudSel').selectedOptions && $('kpCloudSel').selectedOptions[0]
               ? $('kpCloudSel').selectedOptions[0].textContent : String(_cloudRid);
      pick('cloud:' + nm.replace(/\s*·.*$/, '') + ':' + trimSlash($('kpCloudPath').value || ''));
    };

    /* ── 📋 粘贴内容 ── */
    var pasteBtn = b.querySelector('#kpPasteSave');
    if (pasteBtn){
      pasteBtn.onclick = async function(){
        var content = $('kpPaste').value || '';
        if (content.indexOf('PRIVATE KEY') < 0){ toast('内容不像私钥 (缺 PRIVATE KEY 头)', 'warn'); return; }
        var r = await rpc('key_cache_put', {content: content, name: $('kpPasteName').value || ''});
        if (r.status !== 'ok'){ toast(r.msg || '保存失败', 'err'); return; }
        pick(r.path, '✓ 已保存到控制机缓存 · ' + String(r.sha256 || '').slice(0, 12));
      };
    }

    /* ── 缓存信息 + 清理 ── */
    async function cacheInfo(){
      var r = await rpc('key_cache_list', {});
      var el = $('kpCacheInfo');
      if (r.status === 'ok' && el){
        el.textContent = (r.items || []).length
          ? '缓存目录 ' + (r.dir || '') + ' · ' + r.items.length + ' 个密钥 (0600)'
          : '缓存目录为空 (从服务器/云端取回的密钥会放这里, 0600)';
      }
    }
    cacheInfo();
    b.querySelector('#kpCacheClear').onclick = async function(){
      if (!g.confirm('清理控制机上全部缓存密钥文件? (正在使用的连接不受影响)')) return;
      var r = await rpc('key_cache_clear', {});
      toast(r.msg || '已清理', r.status === 'ok' ? 'success' : 'err');
      cacheInfo();
    };
  }

  var _pickDone = function(){};

  /* ════════════ 对外 API ════════════ */
  function _apply(inputEl, path, opts){
    if (!inputEl) return;
    inputEl.value = path;
    try { inputEl.dispatchEvent(new Event('input', {bubbles:true})); } catch(_){}
    inputEl.__kpOpts = opts || {mode:'file'};
  }

  function attach(inputEl, opts){
    if (!inputEl || inputEl.__kpArmed) return;
    inputEl.__kpArmed = true;
    inputEl.__kpOpts = opts || {mode:'file'};
    var wrap = inputEl.closest('.browse-row') || inputEl.parentNode;
    if (!wrap) return;
    var btn = document.createElement('button');
    btn.className = 'btn btn-sm kp-btn';
    btn.type = 'button';
    btn.title = '选择密钥 (本机 / df挂载点 / 网络共享 / 已存服务器 / 远端存储 / 粘贴内容) — 从服务器/云端取会缓存到控制机(0600)';
    btn.textContent = '🔑';
    btn.onclick = function(ev){
      ev.preventDefault();
      open(function(path){ _apply(inputEl, path); }, inputEl.__kpOpts);
    };
    wrap.appendChild(btn);
  }

  function pickInto(inputId, opts){
    var el = $(inputId);
    if (!el){ toast('找不到输入框 ' + inputId, 'warn'); return; }
    open(function(path){ _apply(el, path, opts); }, opts || {mode:'file'});
  }
  function pickDirInto(inputId, opts){
    var o = Object.assign({mode:'dir', kinds:['local','df','share','server','cloud']}, opts || {});
    var el = $(inputId);
    if (!el){ toast('找不到输入框 ' + inputId, 'warn'); return; }
    open(function(path){ _apply(el, path, o); }, o);
  }

  /* ── 全站自动接线: 认证=密钥 的输入框自动挂按钮 ── */
  var _PAIRS = [];
  function _collectPairs(){
    _PAIRS = [];
    var PF = g.PANEL_FIELDS || {};
    Object.keys(PF).forEach(function(pk){
      var f = PF[pk];
      if (f && f.at && f.av) _PAIRS.push({at: f.at, av: f.av});
    });
    _PAIRS.push({cls: 'tri-tmp-auth', clsVal: 'tri-tmp-val'});
    _PAIRS.push({cls: 'tp-tmp-auth',  clsVal: 'tp-tmp-val'});
  }
  function _isKeySel(sel){
    return String(sel.value || '').toLowerCase().indexOf('key') >= 0;
  }
  function _scan(){
    _PAIRS.forEach(function(p){
      if (p.at){
        var sel = $(p.at), inp = $(p.av);
        if (sel && inp && _isKeySel(sel)) attach(inp);
      } else if (p.cls){
        document.querySelectorAll('select.' + p.cls).forEach(function(sel){
          if (!_isKeySel(sel)) return;
          var cell = sel.closest('div');
          var inp = cell ? cell.querySelector('input.' + p.clsVal) : null;
          if (inp) attach(inp);
        });
      }
    });
  }
  function autoWatch(){
    _collectPairs();
    _scan();
    setInterval(function(){ try { _scan(); } catch(_){} }, 2000);
    if (typeof MutationObserver !== 'undefined'){
      try {
        new MutationObserver(function(){ setTimeout(_scan, 100); }).observe(document.body, {childList: true, subtree: true});
      } catch(_){}
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function(){ setTimeout(autoWatch, 1200); });
  else setTimeout(autoWatch, 1200);

  g.KeyPicker = { open: open, attach: attach, autoWatch: autoWatch,
                  pickInto: pickInto, pickDirInto: pickDirInto };
})(window);
