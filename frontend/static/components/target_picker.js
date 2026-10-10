/* ============================================================================
 * target_picker.js · v5.15.0 · 通用目标/源位置选择器
 * 把任意"保存路径"文本输入框升级为完整位置选择: 本机 / 已存服务器 / df挂载点 / 网络共享 / 远端存储
 * 用法:
 *   TargetPicker.attach('backupDst', { kinds:['local','server','share','df','cloud'], placeholder:'...' })
 *   var v = TargetPicker.val('backupDst');   // {kind, path, remote_id, server}
 *   var p = TargetPicker.enrich(params, 'backupDst');  // 按 kind 合并 SSH 凭据 / cloud 上传目标
 * 依赖: window.send, share_list / db_config_list / remote_list
 * ========================================================================== */
(function(g){
  'use strict';

  function $(id){ return document.getElementById(id); }
  function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g,function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function rpc(action, data){
    return new Promise(function(resolve){
      try { g.send(Object.assign({action:action}, data||{}), function(r){ resolve(r||{}); }); }
      catch(e){ resolve({status:'error', msg:String(e)}); }
    });
  }
  // v6.16.13 · 目标类型按功能键裁剪: cloud→cloud 键; df→disk 键(远端/本机磁盘管理, 非社区功能)
  function _kindsByEdition(kinds){
    try{
      var lf = window.__licFeat;                 // license_get 填充的白名单; 非数组=未拉取 → 不裁
      if (!Array.isArray(lf)) return kinds;
      return kinds.filter(function(k){
        if (k === 'cloud') return lf.indexOf('cloud') >= 0;
        if (k === 'df')    return lf.indexOf('disk') >= 0;
        return true;                             // local / server / share 恒可用
      });
    }catch(e){ return kinds; }
  }


  var KINDS = [
    // v5.87.0 · 顺序按用户指定: 本机 / df挂载点 / 网络共享 / 已存服务器 / 远端存储
    ['local',  '💾 本机路径',   '备份/导出到本控制面所在机器的目录'],
    ['df',     '💽 df 挂载点',  '本机已挂载的磁盘/分区 (含远端主机挂载)'],
    ['share',  '🌐 网络共享',   '写入已挂载的 SMB/NFS 共享 (本机挂载点)'],
    ['server', '🖥 已存服务器', '写入已保存连接的 Linux 服务器目录 (SSH)'],
    ['cloud',  '☁ 远端存储',    'S3/OSS/COS/Seafile 等 (产物由跨模块流程或直接上传)'],
  ];
  var _cache = { servers: [], shares: [], df: [], clouds: [], loaded: false };

  function _cfg(inputId){
    var el = $(inputId);
    if (!el) return null;
    var c = el.__tpCfg;
    if (!c){ // attach 未执行 (直接 val) → 尽力推断
      c = { kinds: ['local'] };
    }
    return c;
  }

  async function _loadData(){
    if (_cache.loaded) return _cache;
    var results = await Promise.all([
      window.SP.serverRows(),
      rpc('share_list', {}),
      (window.__featInEdition && !window.__featInEdition('cloud')) ? Promise.resolve({ status:'ok', remotes: [] }) : rpc('remote_list', {}),
      rpc('mounts_list', {}),      // v5.16.0 · 真实系统挂载点 (含 / 与数据盘)
    ]);
    var cfgR = results[0], shrR = results[1], remR = results[2], mntR = results[3];
    _cache.servers = (cfgR && cfgR.status === 'ok') ? (cfgR.configs || cfgR.items || []).filter(function(s){ return s.host; }) : [];
    _cache.shares = (shrR && shrR.status === 'ok') ? (shrR.shares || []) : [];
    // v5.16.0 · 真实挂载点 (本机所有可写实挂载); 失败时退回 share_list 的 df_mounts
    _cache.df = (mntR && mntR.status === 'ok') ? (mntR.mounts || [])
                                              : ((shrR && shrR.status === 'ok') ? (shrR.df_mounts || []) : []);
    _cache.clouds = (remR && remR.status === 'ok') ? (remR.remotes || remR.items || []) : [];
    // v5.16.0 · 仅在核心数据真的拿到时才缓存 (WS 未就绪时的空结果不再被永久缓存 → 下次自动重试)
    var _sharesOk = !!(shrR && shrR.status === 'ok');
    var _mountsOk = !!(mntR && mntR.status === 'ok');
    _cache.loaded = (_sharesOk && _mountsOk);
    return _cache;
  }
  g.__tpInvalidate = function(){ _cache.loaded = false; };

  /* ── attach: 把 .browse-row 里的文本输入升级为 [类型][上下文][路径][📁] ── */
  async function attach(inputId, opts){
    opts = opts || {};
    var el = $(inputId);
    if (!el || el.__tpAttached) return;
    var row = el.closest('.browse-row') || el.parentElement;
    if (!row) return;
    el.__tpAttached = true;
    // v6.16.13 · 功能裁剪(容器备份/备份配置里的 df 挂载点与远端存储属非社区能力):
    //   license 白名单在手时, community 档不再出现 df/cloud 两种目标。
    el.__tpCfg = { kinds: _kindsByEdition(opts.kinds || ['local','server','share','df','cloud']),
                   allowServerPush: opts.allowServerPush !== false };
    var kinds = el.__tpCfg.kinds;
    // 上下文 select (服务器/共享/df/云 专用)
    var ctx = document.createElement('select');
    ctx.className = 'input';
    ctx.style.cssText = 'max-width:170px;flex:0 0 auto;display:none;font-size:11px';
    ctx.setAttribute('data-tp-ctx', inputId);
    ctx.onchange = function(){ _syncKind(inputId); _syncCtx(inputId); };
    // 类型 select
    var kindSel = document.createElement('select');
    kindSel.className = 'input';
    kindSel.style.cssText = 'max-width:150px;flex:0 0 auto;font-size:11px';
    kindSel.setAttribute('data-tp-kind', inputId);
    kindSel.innerHTML = KINDS.filter(function(k){ return kinds.indexOf(k[0]) >= 0; })
      .map(function(k){ return '<option value="'+k[0]+'" title="'+esc(k[2])+'">'+k[1]+'</option>'; }).join('');
    kindSel.onchange = function(){ _syncKind(inputId); };
    // v5.16.0 · "🔍 测试" 按钮: 实测目标可写性 (以服务进程身份)
    var testBtn = document.createElement('button');
    testBtn.type = 'button';
    testBtn.className = 'btn btn-sm';
    testBtn.style.cssText = 'flex:0 0 auto;font-size:11px;white-space:nowrap';
    testBtn.textContent = '🔍 测试';
    testBtn.title = '测试该保存位置是否可写 (含可用空间)';
    testBtn.onclick = function(ev){ ev.preventDefault(); ev.stopPropagation(); test(inputId, testBtn); };
    row.insertBefore(kindSel, el);
    row.insertBefore(ctx, el);
    row.appendChild(testBtn);
    // v6.16.13 · 功能裁剪的时序兜底: license_get 白名单可能晚于面板初始化到达(实测容器备份页
    //   首个选择器因此漏裁 df/cloud)。白名单到位后重建 kind 下拉(保留已选值)并重同步上下文。
    if (!Array.isArray(window.__licFeat)){
      (function _retryKinds(n){
        setTimeout(function(){
          if (Array.isArray(window.__licFeat)){
            try {
              var keep = kindSel.value;
              var ks = _kindsByEdition(el.__tpCfg.kinds);
              kindSel.innerHTML = KINDS.filter(function(k){ return ks.indexOf(k[0]) >= 0; })
                .map(function(k){ return '<option value="'+k[0]+'" title="'+esc(k[2])+'">'+k[1]+'</option>'; }).join('');
              if (ks.indexOf(keep) >= 0) kindSel.value = keep;
              _syncKind(inputId); _syncCtx(inputId);
            } catch(e){ console.warn('[tp] kind re-filter', e); }
          } else if (n < 12){
            _retryKinds(n + 1);
          }
        }, 600);
      })(0);
    }
    el.setAttribute('data-tp-path', inputId);
    await _loadData();
    await _fillCtx(inputId);
    var initKind = opts.kind || 'local';
    if (kinds.indexOf(initKind) >= 0) kindSel.value = initKind;
    _syncKind(inputId);
    // v5.17.0 · 让 📁 按钮按"当前类型"浏览并选择目标目录 (选中后回填相对子路径)
    _bindBrowse(inputId);
  }

  /* ── _bindBrowse: 接管 📁 按钮 → 按当前类型打开目录浏览器 ── */
  function _bindBrowse(inputId){
    var el = $(inputId);
    if (!el) return;
    var row = el.closest('.browse-row') || el.parentElement;
    if (!row) return;
    var btn = null;
    Array.prototype.forEach.call(row.querySelectorAll('button'), function(b){
      if (btn) return;
      if ((b.getAttribute('onclick') || '').indexOf('openDirBrowser') >= 0) btn = b;
    });
    if (!btn){
      btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-sm';
      btn.textContent = '📁';
      row.appendChild(btn);
    }
    btn.__tpBrowse = true;
    btn.removeAttribute('onclick');
    btn.title = '浏览并选择目标目录 (按当前类型: 本机 / df挂载点 / 网络共享 / 服务器)';
    btn.onclick = function(ev){ ev.preventDefault(); ev.stopPropagation(); _browse(inputId); };
    if (!el.__tpBrowseHooked){
      el.__tpBrowseHooked = true;
      // 直连本地/挂载点时, 手输也可直接点 📥 同步 (保持原页面按钮行为不变)
    }
  }

  /* ── _browse: 内联展开的文件选择面板 (取代模态目录浏览器) ──
   * v5.18.0 · 在保存路径下方就地展开, 选完自动收起并回填相对子路径 (少两次交互)。 */
  var _openPanels = {};
  /* v5.18.0 · 目录列举: 直挂 WS 监听 (list_dir 返回 type='dir_result', 普通 rpc 的 result 匹配收不到 → 面板会卡在"加载中") */
  function _listDir(path, mode, auth){
    return new Promise(function(resolve){
      var _ow = g.openWs || (typeof openWs === 'function' ? openWs : null);
      if (!_ow){ resolve({ status: 'error', msg: 'WebSocket 未就绪' }); return; }
      var reqId = 'tpl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
      var done = false;
      var finish = function(r){ if (done) return; done = true; resolve(r || {}); };
      var timer = setTimeout(function(){ finish({ status: 'error', msg: '目录读取超时' }); }, 20000);
      _ow(function(ws){
        var h = function(e){
          var d; try { d = JSON.parse(e.data); } catch(_){ return; }
          if (!d || d.req_id !== reqId) return;
          if (d.type === 'log' || d.type === 'progress') return;
          clearTimeout(timer);
          try { ws.removeEventListener('message', h); } catch(_){}
          finish(d);
        };
        ws.addEventListener('message', h);
        var payload = (mode === 'remote')
          ? Object.assign({ action: 'list_remote_dir', path: path, req_id: reqId }, auth)
          : { action: 'list_dir', path: path, req_id: reqId };
        _rpSendWhenReady(ws, payload, undefined, function(){ try { console.warn('[ws] 发送失败'); } catch(_){} })
      });
    });
  }

  function _tpEsc(s){
    return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  /* v5.27.0 · 面包屑: 逐级可点的路径导航 */
function _crumbHtml(cur){
  var parts = String(cur || '/').split('/').filter(Boolean);
  var html = '<span class="tp-crumb" data-p="/" style="cursor:pointer;color:var(--cyan)">/ </span>';
  var acc = '';
  parts.forEach(function(seg){
    acc += '/' + seg;
    html += '<span class="tp-crumb" data-p="' + _tpEsc(acc) + '" style="cursor:pointer;color:var(--cyan)">' + _tpEsc(seg) + '</span>'
          + '<span style="color:var(--text3)">/</span>';
  });
  return html;
}
function _bindCrumbs(box, load){
  box.querySelectorAll('.tp-crumb').forEach(function(cEl){
    cEl.onclick = function(){ load(cEl.getAttribute('data-p') || '/'); };
  });
}
/* 行模板: 整行单击=进入; 行尾绿色「选定此目录」=选该行 (v5.27.0) */
function _rowHtml(full, name, mtime, pickLabel){
  return '<div class="tpib-dir" data-path="' + _tpEsc(full) + '" style="display:flex;align-items:center;gap:6px;padding:4px 7px;border-radius:5px;cursor:pointer">'
    + '<span style="color:var(--purple)">📁</span>'
    + '<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:monospace">' + _tpEsc(name) + '</span>'
    + '<span style="color:var(--text3);font-size:10px">' + _tpEsc(mtime || '') + '</span>'
    + '<span class="tpib-pick-row" style="color:var(--green);font-weight:600;font-size:11px;cursor:pointer;white-space:nowrap">' + (pickLabel || '✓ 选定此目录') + '</span>'
    + '</div>';
}
function _bindRow(dEl, onEnter, onPick){
  dEl.onmouseenter = function(){ dEl.style.background = 'var(--bg3)'; };
  dEl.onmouseleave = function(){ dEl.style.background = ''; };
  dEl.onclick = function(ev){
    var isPick = ev.target.classList.contains('tpib-pick-row');
    if (isPick) ev.stopPropagation();
    if (isPick) onPick(); else onEnter();     // 单击行=进入; 绿字=选定
  };
}

async function _browse(inputId){
    var el = $(inputId);
    if (!el) return;
    var row = el.closest('.browse-row') || el.parentElement;
    if (!row) return;
    if (_openPanels[inputId]){
      try { _openPanels[inputId].remove(); } catch(_){}
      delete _openPanels[inputId];
      return;
    }
    var v = val(inputId);
    var mode = 'local', auth = null, startPath = '/';
    if (v.kind === 'server'){
      await _loadData();
      var srv = _cache.servers.find(function(x){ return Number(x.id) === Number(v.server); });
      if (!srv){ if (g.toast) g.toast('请先选择服务器', 'warn'); return; }
      mode = 'remote';
      auth = { host: srv.host, port: srv.port || 22, user: srv.user || 'root',
               auth_type: srv.auth_type || 'pass',
               password: (srv.auth_type || 'pass') === 'pass' ? (srv.auth_value || '') : '',
               key: (srv.auth_type || 'pass') === 'pass' ? '' : (srv.auth_value || ''),
               passphrase: srv.auth_passphrase || srv.passphrase || '' };
      startPath = v.path || '/';
    } else if (v.kind === 'df' || v.kind === 'share'){
      var ctx = document.querySelector('[data-tp-ctx="' + inputId + '"]');
      startPath = (ctx ? String(ctx.value || '') : '').replace(/\/+$/, '') || '/';
    } else if (v.kind === 'cloud'){
      if (g.toast) g.toast('☁ 云端存储无需选择目录 — 选好 remote 后产物会整目录上传', 'info', 4200);
      return;
    } else {
      startPath = String(el.value || '').trim() || '/';
    }
    var host = row.parentElement || row;
    var box = document.createElement('div');
    box.className = 'tp-inline-browser';
    box.style.cssText = 'margin-top:6px;border:1px solid var(--cyan);border-radius:8px;background:var(--bg);overflow:hidden';
    box.innerHTML =
      '<div style="display:flex;align-items:center;gap:6px;padding:5px 8px;background:var(--bg3);border-bottom:1px solid var(--border);font-size:11px">' +
        '<button class="btn btn-sm tpib-up" style="padding:1px 6px;font-size:10px" title="上级目录">⬆</button>' +
        '<button class="btn btn-sm tpib-ref" style="padding:1px 6px;font-size:10px" title="刷新">🔄</button>' +
        '<span class="tpib-crumb" style="flex:1;min-width:0;overflow-x:auto;white-space:nowrap;font-family:monospace;font-size:11px"></span>' +
        '<button class="btn btn-sm btn-primary tpib-pick" style="padding:1px 8px;font-size:10px" title="选定当前目录">✓ 选定当前</button>' +
        '<button class="btn btn-sm tpib-close" style="padding:1px 6px;font-size:10px">✕</button>' +
      '</div>' +
      '<div class="tpib-list" style="max-height:220px;overflow:auto;font-size:11px;padding:3px 4px"></div>';
    host.appendChild(box);
    _openPanels[inputId] = box;
    var listEl = box.querySelector('.tpib-list');
    var pathEl = box.querySelector('.tpib-path');
    var cur = startPath;
    var crumbEl = box.querySelector('.tpib-crumb');
    function load(p){
      cur = p || '/';
      crumbEl.innerHTML = _crumbHtml(cur);
      crumbEl.title = cur;
      _bindCrumbs(box, load);
      listEl.innerHTML = '<div style="padding:8px;color:var(--text3)">⏳ 加载 ' + _tpEsc(cur) + ' …</div>';
      _listDir(cur, mode, auth)
        .then(function(r){
          if (!box.isConnected) return;
          if (!r || (r.status !== 'ok' && r.status !== 'success')){
            listEl.innerHTML = '<div style="padding:8px;color:var(--red)">✗ ' + _tpEsc((r && r.msg) || '读取失败') + '</div>';
            return;
          }
          var ents = (r.entries || r.files || []);
          var dirs = ents.filter(function(e){ return e && (e.type === 'dir' || e.is_dir); })
                         .sort(function(a, b){ return String(a.name).localeCompare(String(b.name)); });
          // v5.27.0 · 过滤解析成 '/' 的脏行 (否则行内「选定此目录」会选中根, 写出 '//')
          dirs = dirs.filter(function(d){
            var full = d.path || ((cur.replace(/\/+$/, '') || '') + '/' + d.name);
            return full.replace(/\/+$/, '') !== '' && full !== '/';
          });
          if (!dirs.length){
            listEl.innerHTML = '<div style="padding:8px;color:var(--text3)">（此目录无子目录 — 可直接点「✓ 选定此目录」）</div>';
            return;
          }
          listEl.innerHTML = dirs.map(function(d){
            var full = d.path || ((cur.replace(/\/+$/, '') || '') + '/' + d.name);
            return _rowHtml(full, d.name, d.mtime);
          }).join('');
          listEl.querySelectorAll('.tpib-dir').forEach(function(dEl){
            var p2 = dEl.getAttribute('data-path');
            _bindRow(dEl, function(){ load(p2); }, function(){ pick(p2); });   // 单击=进入 · 绿字=选定
          });
        });
    }
    function pick(explicit){
      var _clean = function(x){ return String(x || '/').replace(/\/+$/, '') || '/'; };
      var curC = _clean(explicit || cur);          // v5.27.0: 支持行内「选定此目录」直接选该行
      var startC = _clean(startPath);
      var _close = function(){ try { box.remove(); } catch(_){} delete _openPanels[inputId]; };
      // ① v5.27.0 · FIX 前导斜杠丢失: 本机/服务器模式回填**绝对路径** (带前导 /, 尾部 /),
      //    此前回填相对子路径 → 备份产物落到程序安装目录下 (用户实测踩到)。
      //    df/share 挂载点模式保持相对子路径 (输入框与挂载点下拉配套, 语义不变)。
      if (mode !== 'df' && mode !== 'share'){
        el.value = (curC === '/') ? '/' : curC + '/';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        if (g.toast) g.toast('✓ 目标目录: ' + curC + '/', 'success', 3600);
        _close();
        return;
      }
      if (startC === '/' || curC === startC || curC.indexOf(startC + '/') === 0){
        var rel = (curC === startC) ? '' : curC.slice(startC.length);
        rel = rel.replace(/^\/+/, '').replace(/\/+$/, '');
        el.value = rel;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        if (g.toast) g.toast('✓ 目标目录: ' + curC, 'success', 3600);
        _close();
        return;
      }
      // ② 选到了当前挂载点之外 — 若正好是另一个已知挂载点, 自动切换 (避免拼出 /a/b/a 这种错路径)
      var v2 = val(inputId);
      if (v2.kind === 'df' || v2.kind === 'share'){
        var hit = (_cache.df || []).find(function(m){ return _clean(m.mount) === curC; });
        if (hit){
          var ctx = document.querySelector('[data-tp-ctx="' + inputId + '"]');
          if (ctx){
            var opt = Array.prototype.find.call(ctx.options, function(o){ return _clean(o.value) === curC; });
            if (opt){ ctx.value = opt.value; }
          }
          el.value = '';
          el.dispatchEvent(new Event('input', { bubbles: true }));
          if (g.toast) g.toast('✓ 已切换目标位置到: ' + curC, 'success', 3600);
          _close();
          return;
        }
      }
      // ③ 既非当前根也非已知挂载点 → 明确提示, 不改动字段 (防止静默写错路径)
      if (g.toast){
        g.toast('⚠ 所选目录 ' + curC + ' 不属于当前位置 ' + startC + ' — 未改动。'
                + '如需其他位置请先在上面切换类型/挂载点', 'warn', 6000);
      }
      _close();
    }
    box.querySelector('.tpib-up').onclick = function(){
      load(cur.replace(/\/+$/, '').split('/').slice(0, -1).join('/') || '/');
    };
    box.querySelector('.tpib-ref').onclick = function(){ load(cur); };
    box.querySelector('.tpib-pick').onclick = function(){ pick(); };   // v5.27.0: 包一层, 防止 event 被当成路径参数
    box.querySelector('.tpib-close').onclick = function(){
      try { box.remove(); } catch(_){}
      delete _openPanels[inputId];
    };
    load(startPath);
  }

  async function _fillCtx(inputId){
    var ctx = document.querySelector('[data-tp-ctx="'+inputId+'"]');
    var kind = _kindOf(inputId);
    if (!ctx) return;
    await _loadData();
    // v5.16.0 · 重填前记住当前选择, 重填后尽力恢复 (否则每次刷新列表都会丢掉用户选的挂载点)
    var prevVal = String(ctx.value || '');
    var h = '';
    if (kind === 'server'){
      h = _cache.servers.length
        ? _cache.servers.map(function(s){ return '<option value="'+s.id+'" data-host="'+esc(s.host)+'">'+esc(s.name||('#'+s.id))+' · '+esc(s.host)+'</option>'; }).join('')
        : '<option value="">(无已存服务器 — 先到「文件传输」保存连接)</option>';
    } else if (kind === 'df'){
      // v5.16.0 · 真实系统挂载点 (排除只读), 标注文件系统/可用空间/是否网络共享
      var _ms = _cache.df.filter(function(m){ return !m.readonly; });
      h = _ms.length
        ? '<option value="">— 选择挂载点 —</option>' + _ms.map(function(m){
            var gb = m.avail ? ((m.avail / 1073741824).toFixed(0) + 'G可用') : '';
            var tag = m.is_share ? '🔗' : '💽';
            var lab = (m.label ? (m.label + ' · ') : '') + m.mount;
            return '<option value="'+esc(m.mount)+'" data-fs="'+esc(m.fstype||'')+'">'
                 + tag + ' ' + esc(lab) + ' · ' + esc(gb) + (m.use_pct ? (' ('+esc(m.use_pct)+')') : '') + '</option>';
          }).join('')
        : '<option value="">(未发现可写挂载点)</option>';
    } else if (kind === 'share'){
      h = _cache.shares.length
        ? '<option value="">— 选择共享 —</option>' + _cache.shares.map(function(s){
            var mt = (s.mount_point || s.mount || ('/var/lib/fonriv_mounts/shares/' + s.uuid));
            return '<option value="'+esc(mt)+'">'+esc(s.name||s.uuid||'')+' · '+esc(s.proto||'')+(s.last_status==='mounted'?' ●':' ○')+'</option>';
          }).join('')
        : '<option value="">(无已配置共享 — 先到「网络共享」添加)</option>';
    } else if (kind === 'cloud'){
      h = _cache.clouds.length
        ? _cache.clouds.map(function(r){ return '<option value="'+(r.id||r.remote_id||'')+'" data-name="'+esc(r.name||'')+'">'+esc(r.name||'')+' ('+esc(r.provider||'?')+')</option>'; }).join('')
        : '<option value="">(无远端存储 — 先到「远端存储」添加)</option>';
    }
    ctx.innerHTML = h;
    // 恢复原选择 (值仍在新列表中才恢复; 首次自动选中唯一/首个有效项)
    if (prevVal){
      var still = Array.prototype.some.call(ctx.options, function(o){ return o.value === prevVal; });
      if (still) ctx.value = prevVal;
    }
    if (!ctx.value){
      var firstReal = Array.prototype.filter.call(ctx.options, function(o){ return o.value; })[0];
      if (firstReal) ctx.value = firstReal.value;
    }
  }

  function _kindOf(inputId){
    var ks = document.querySelector('[data-tp-kind="'+inputId+'"]');
    return ks ? (ks.value || 'local') : 'local';
  }

  function _syncKind(inputId){
    var kind = _kindOf(inputId);
    var el = $(inputId);
    var ctx = document.querySelector('[data-tp-ctx="'+inputId+'"]');
    if (!el) return;
    var isCtx = (kind === 'server' || kind === 'df' || kind === 'share' || kind === 'cloud');
    if (ctx) ctx.style.display = isCtx ? '' : 'none';
    // v5.16.0 · 切换类型时归一输入框内容 (避免把"本机绝对路径"当子路径拼到挂载点后面)
    var prev = el.__tpKind || 'local';
    if (prev !== kind){
      var cur = String(el.value || '').trim();
      if (kind === 'df' || kind === 'share'){
        var mount = ctx ? String(ctx.value || '').replace(/\/+$/, '') : '';
        if (cur && mount && cur.indexOf(mount) === 0){
          el.value = cur.slice(mount.length).replace(/^\/+/, '');       // 已是该挂载点下的路径 → 保留为子路径
        } else if (cur && cur.charAt(0) === '/'){
          el.value = '';                                               // 其他绝对路径 → 清空, 只留挂载点根
        }
      } else if (kind === 'local' && cur && cur.charAt(0) !== '/'){
        el.value = '';                                                 // 从 df/共享 切回本机 → 清掉子路径
      } else if (kind === 'cloud'){
        el.value = '';                                                 // 云端只需选 remote, 无路径概念
      }
      el.__tpKind = kind;
    }
    el.placeholder = (kind === 'local') ? '/path/to/dir' :
                     (kind === 'cloud') ? '(选择远端存储即可, 无需路径)' :
                     '该位置下的子路径 (可留空 = 直接用该位置根目录)';
    _fillCtx(inputId);
  }

  /* ── val: 解析为 {kind, path, remote_id, server} ── */
  function val(inputId){
    var kind = _kindOf(inputId);
    var el = $(inputId);
    var ctx = document.querySelector('[data-tp-ctx="'+inputId+'"]');
    var sub = el ? String(el.value || '').trim().replace(/^\/+/, '') : '';
    var out = { kind: kind, path: '', remote_id: 0, server: null };
    if (kind === 'local'){
      out.path = el ? String(el.value || '').trim() : '';
      if (out.path && out.path.slice(-1) !== '/') out.path += '/';
    } else if (kind === 'server'){
      var opt = ctx && ctx.selectedOptions ? ctx.selectedOptions[0] : null;
      out.server = opt ? Number(ctx.value) : 0;
      out.path = '/' + sub;
    } else if (kind === 'df' || kind === 'share'){
      var mount = ctx ? String(ctx.value || '').replace(/\/+$/, '') : '';
      out.path = (mount ? mount : '') + (sub ? '/' + sub : '');
      if (!out.path) out.path = '';
    } else if (kind === 'cloud'){
      out.remote_id = ctx ? (parseInt(ctx.value, 10) || 0) : 0;
      out.path = sub;
    }
    return out;
  }

  /* ── enrich: 把选择合并进待发参数 (SSH 凭据 / cloud 上传标记) ── */
  async function enrich(params, inputId){
    var v = val(inputId);
    if (v.kind === 'server' && v.server){
      await _loadData();
      var s = _cache.servers.find(function(x){ return Number(x.id) === Number(v.server); });
      if (s){
        params.host = s.host;
        params.port = s.port || 22;
        params.user = s.user || 'root';
        params.auth_type = s.auth_type || 'pass';
        if ((s.auth_type || 'pass') === 'pass') params.password = s.auth_value || s.password || '';
        else params.key = s.auth_value || s.key || '';
        params.passphrase = s.passphrase || '';
      }
      params.dest_dir = v.path;
    } else if (v.kind === 'cloud'){
      params.upload_remote_id = v.remote_id;   // 备份完成后由页面触发上传
      params.dest_dir = params.dest_dir || '/var/backups/fonriv_db';
    } else {
      if (v.path) params.dest_dir = v.path;
    }
    return params;
  }

  /* ── localPath: 只要"本机可写绝对路径"的旧接口 (备份/导出落盘用) ──
   * 返回 {path, cloud, warn}: local/df/share → 解析后的本机路径;
   * cloud → path 保持 fallback, cloud=remote_id (调用方可选做备份后上传);
   * server → path 保持 fallback 并给 warn (备份在本机执行, 产物需经传输/流程推送) */
  function localPath(inputId, fallback){
    var v = val(inputId);
    if (v.kind === 'server'){
      return { path: fallback, cloud: 0,
               warn: '⚠ 备份在本机执行: 已保留本机路径 ' + fallback + '; 该服务器位置请用「☁️ 跨模块自动备份」推送' };
    }
    if (v.kind === 'cloud'){
      return { path: fallback, cloud: v.remote_id, warn: '' };
    }
    return { path: v.path || fallback, cloud: 0, warn: '' };
  }

  /* ── pickLocal: 供"本机落盘"类页面直接取路径 (含一次性指引提示) ── */
  function pickLocal(inputId, fallback){
    var el = $(inputId);
    if (!el || !el.__tpAttached) return (el ? String(el.value || '').trim() : '') || fallback;
    var r = localPath(inputId, fallback);
    if (r.warn && g.toast){
      // 同一输入框每次切换只提示一次, 避免刷屏
      var key = inputId + ':' + (val(inputId).kind);
      if (el.__tpWarned !== key){ el.__tpWarned = key; g.toast(r.warn, 'warn', 6000); }
    }
    return r.path || fallback;
  }

  /* ── autoAttach: 备份/导出类页面的保存路径与目录源集中挂载 ── */
  var AUTO_FIELDS = [
    // [inputId, {kinds, 说明}]
    ['backupDst',   { tag: 'vzdump 本地保存路径' }],
    ['restoreDir',  { tag: 'vzdump 恢复目录源' }],
    ['vdLocalDir',  { tag: 'vzdump 本地目录' }],
    ['abLocalDst',  { tag: '一键备份本地目标' }],
    ['lvmLocalDir', { tag: 'LVM 本地目录' }],
    ['zfsLocalDir', { tag: 'ZFS 本地目录' }],
    ['kbDestEtcd',  { tag: 'K8s etcd 备份目录' }],
    ['kbDestDocker',{ tag: 'K8s docker 备份目录' }],
    ['kbDestPv',    { tag: 'K8s PV 备份目录' }],
    ['kbVerifyDir', { tag: 'K8s 校验目录' }],
    ['batchLocalDst', { tag: '批量备份保存路径' }],
    ['pbsLocalDir', { tag: 'PBS 本地下载目录' }],
    ['agExpDest',   { tag: '摆渡包输出目录' }],
    ['agImpDest',   { tag: '摆渡解包目录' }],
  ];

  async function autoAttach(){
    for (var i = 0; i < AUTO_FIELDS.length; i++){
      var id = AUTO_FIELDS[i][0];
      if (!$(id)) continue;
      try { await attach(id, { kinds: ['local','server','share','df','cloud'] }); }
      catch(e){ console.warn('[TargetPicker] attach', id, e); }
    }
  }

  /* ── _syncCtx: 挂载点/服务器切换时迁移输入框里的子路径 ── */
  function _syncCtx(inputId){
    var el = $(inputId);
    var ctx = document.querySelector('[data-tp-ctx="'+inputId+'"]');
    if (!el || !ctx) return;
    var kind = _kindOf(inputId);
    if (kind !== 'df' && kind !== 'share') return;
    var cur = String(el.value || '').trim();
    if (!cur) return;
    // 输入框里若残留旧挂载点绝对路径 → 转成相对新挂载点的子路径
    if (cur.charAt(0) === '/'){
      var newMount = String(ctx.value || '').replace(/\/+$/, '');
      if (newMount && cur.indexOf(newMount) === 0){
        el.value = cur.slice(newMount.length).replace(/^\/+/, '');
      } else {
        el.value = '';   // 与当前挂载点无关的绝对路径 → 清空
      }
    }
  }

  /* ── test: 目标可写性实测 (服务进程身份, 含可用空间) ── */
  async function test(inputId, btn){
    var v = val(inputId);
    var payload = { kind: v.kind, path: v.path };
    if (v.kind === 'server'){
      await _loadData();
      var s = _cache.servers.find(function(x){ return Number(x.id) === Number(v.server); });
      if (!s){ if (g.toast) g.toast('请先选择服务器', 'warn'); return; }
      payload.host = s.host; payload.port = s.port || 22; payload.user = s.user || 'root';
      payload.auth_type = s.auth_type || 'pass';
      if ((s.auth_type || 'pass') === 'pass') payload.password = s.auth_value || s.password || '';
      else payload.key = s.auth_value || s.key || '';
      payload.passphrase = s.auth_passphrase || s.passphrase || '';
    } else if (v.kind === 'cloud'){
      if (!v.remote_id){ if (g.toast) g.toast('请先选择远端存储', 'warn'); return; }
      payload.remote_id = v.remote_id;
    } else if (!v.path){
      if (g.toast) g.toast('请先填写/选择路径', 'warn'); return;
    }
    var old = btn ? btn.textContent : '';
    if (btn){ btn.disabled = true; btn.textContent = '⏳ 测试中'; }
    var r = await rpc('target_test', payload);
    if (btn){ btn.disabled = false; btn.textContent = old || '🔍 测试'; }
    var ok = r.status === 'ok';
    // 结果就地显示在输入框右侧 (不依赖各页面自己的结果容器)
    var el = $(inputId);
    var host = (el && el.closest('.browse-row')) || (el && el.parentElement);
    if (host){
      var box = host.querySelector('.tp-test-result');
      if (!box){ box = document.createElement('span'); box.className = 'tp-test-result'; box.style.cssText = 'font-size:11px;white-space:nowrap'; host.appendChild(box); }
      box.style.color = ok ? 'var(--green)' : 'var(--red)';
      box.textContent = (r.msg || '');
      clearTimeout(box.__t);
      box.__t = setTimeout(function(){ if (box) box.textContent = ''; }, 12000);
    }
    if (g.toast) g.toast((ok ? '✓ ' : '✗ ') + (r.msg || ''), ok ? 'success' : 'err', 5200);
    return r;
  }

  /* ── runPush: 备份完成后把产物送到所选目标 (服务器 rsync push / 云端上传) ──
   * 返回 {ok, msg}。本机/df/共享 无需推送 (直接落盘) → 返回 {ok:true, skipped:true}。 */
  async function runPush(inputId, localDir, opts){
    opts = opts || {};
    var v = val(inputId);
    var log = typeof opts.onLog === 'function' ? opts.onLog : function(){};
    if (v.kind === 'local' || v.kind === 'df' || v.kind === 'share'){
      return { ok: true, skipped: true };
    }
    var src = String(localDir || '').replace(/\/+$/, '');
    if (!src){ return { ok: false, msg: '无本机落盘目录可推送' }; }
    if (v.kind === 'server'){
      await _loadData();
      var s = _cache.servers.find(function(x){ return Number(x.id) === Number(v.server); });
      if (!s){ return { ok: false, msg: '未找到所选服务器档案' }; }
      var dst = (v.path || '/').replace(/\/+$/, '') + '/';
      log('📤 推送到服务器 ' + (s.name || s.host) + ':' + dst + ' …');
      return await new Promise(function(resolve){
        try {
          g.send({
            action: 'rsync', direction: 'up',
            host: s.host, port: s.port || 22, user: s.user || 'root',
            auth_type: s.auth_type || 'pass',
            password: (s.auth_type || 'pass') === 'pass' ? (s.auth_value || s.password || '') : '',
            key: (s.auth_type || 'pass') === 'pass' ? '' : (s.auth_value || s.key || ''),
            passphrase: s.auth_passphrase || s.passphrase || '',
            src: src + '/', dst: dst,
            flags: ['-a', '-v', '-z', '--partial'],
          }, function(d){
            var ok = d && (d.status === 'success' || d.status === 'ok');
            log((ok ? '✓ ' : '✗ ') + '服务器推送' + (ok ? '完成' : ('失败: ' + ((d && d.msg) || ''))));
            resolve({ ok: ok, msg: (d && d.msg) || '' });
          }, true);
        } catch(e){ resolve({ ok: false, msg: String(e) }); }
      });
    }
    if (v.kind === 'cloud'){
      if (!v.remote_id) return { ok: false, msg: '未选择远端存储' };
      var sub = String(v.path || '').replace(/^\/+|\/+$/g, '');
      log('☁ 上传到远端存储 #' + v.remote_id + (sub ? ('/' + sub) : '') + ' …');
      var reqId = 'tpu_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
      return await new Promise(function(resolve){
        try {
          var _ow = g.openWs || (typeof openWs === 'function' ? openWs : null);
          if (!_ow){ resolve({ ok: false, msg: 'WS 未就绪' }); return; }
          _ow(function(ws){
            var h = function(e){
              var d; try { d = JSON.parse(e.data); } catch(_){ return; }
              if (!d || d.type !== 'remote_dir_result' || d.req_id !== reqId) return;
              try { ws.removeEventListener('message', h); } catch(_){}
              var ok = d.status === 'ok';
              log((ok ? '✓ ' : '✗ ') + '云端上传: ' + (ok ? (d.ok + ' 成功 / ' + d.fail + ' 失败') : (d.msg || '')));
              resolve({ ok: ok && !d.fail, msg: ok ? '' : (d.msg || '') });
            };
            ws.addEventListener('message', h);
            _rpSendWhenReady(ws, { action: 'remote_upload_dir', remote_id: v.remote_id,
                                     local_dir: src, remote_dir: sub, req_id: reqId }, undefined, function(){ try { console.warn('[ws] 发送失败'); } catch(_){} })
          });
        } catch(e){ resolve({ ok: false, msg: String(e) }); }
      });
    }
    return { ok: false, msg: '不支持的目标类型: ' + v.kind };
  }

  /* ── openInlineFor: 通用内联目录选择面板 (供跨模块自动备份等复用) ──
   * anchorEl: 面板挂靠的元素 (通常是输入框/textarea), opts: {mode:'local'|'remote', auth, startPath, onPick} */
  function openInlineFor(anchorEl, opts){
    opts = opts || {};
    if (!anchorEl) return;
    var key = 'inline_' + (anchorEl.id || Math.random().toString(36).slice(2, 8));
    var row = anchorEl.closest('.browse-row') || anchorEl.parentElement || anchorEl;
    if (_openPanels[key]){
      try { _openPanels[key].remove(); } catch(_){}
      delete _openPanels[key];
      return;
    }
    var mode = opts.mode || 'local';
    var auth = opts.auth || null;
    var startPath = String(opts.startPath || anchorEl.value || '/').trim() || '/';
    var host = row.parentElement || row;
    var box = document.createElement('div');
    box.className = 'tp-inline-browser';
    box.style.cssText = 'margin-top:6px;border:1px solid var(--cyan);border-radius:8px;background:var(--bg);overflow:hidden';
    box.innerHTML =
      '<div style="display:flex;align-items:center;gap:6px;padding:5px 8px;background:var(--bg3);border-bottom:1px solid var(--border);font-size:11px">' +
        '<button class="btn btn-sm tpib-up" style="padding:1px 6px;font-size:10px" title="上级目录">⬆</button>' +
        '<button class="btn btn-sm tpib-ref" style="padding:1px 6px;font-size:10px" title="刷新">🔄</button>' +
        '<span class="tpib-crumb" style="flex:1;min-width:0;overflow-x:auto;white-space:nowrap;font-family:monospace;font-size:11px"></span>' +
        '<button class="btn btn-sm tpib-add" style="padding:1px 8px;font-size:10px" title="把勾选的目录/文件追加到源路径(支持多选)">＋ 加入选中</button>' +
        '<button class="btn btn-sm btn-primary tpib-pick" style="padding:1px 8px;font-size:10px" title="选定当前目录">＋ 选用当前</button>' +
        '<button class="btn btn-sm tpib-close" style="padding:1px 6px;font-size:10px">✕</button>' +
      '</div>' +
      '<div class="tpib-list" style="max-height:220px;overflow:auto;font-size:11px;padding:3px 4px"></div>';
    host.appendChild(box);
    _openPanels[key] = box;
    var listEl = box.querySelector('.tpib-list');
    var pathEl = box.querySelector('.tpib-path');
    var cur = startPath;
    var crumbEl = box.querySelector('.tpib-crumb');
    function load(p){
      cur = p || '/';
      crumbEl.innerHTML = _crumbHtml(cur);
      crumbEl.title = cur;
      _bindCrumbs(box, load);
      listEl.innerHTML = '<div style="padding:8px;color:var(--text3)">⏳ 加载 ' + _tpEsc(cur) + ' …</div>';
      _listDir(cur, mode, auth).then(function(r){
        if (!box.isConnected) return;
        if (!r || (r.status !== 'ok' && r.status !== 'success')){
          listEl.innerHTML = '<div style="padding:8px;color:var(--red)">✗ ' + _tpEsc((r && r.msg) || '读取失败') + '</div>';
          return;
        }
        // v5.77.0 修(用户报"只能看文件夹, 不能选文件"): 原实现**硬过滤掉文件**
        //   (filter type==='dir'), 而"跨模块自动备份"的源路径既可能是目录也可能是文件
        //   → 现在目录/文件都列, 且都能勾选多选(单个也能一键选定)。
        var ents = (r.entries || r.files || []);
        var isDirFn = function(e){ return !!(e && (e.type === 'dir' || e.is_dir)); };
        var byName = function(a, b){ return String(a.name).localeCompare(String(b.name)); };
        var fullOf = function(e){ return e.path || ((cur.replace(/\/+$/, '') || '') + '/' + e.name); };
        var dirs = ents.filter(isDirFn).filter(function(d){
          var full = fullOf(d);
          return full.replace(/\/+$/, '') !== '' && full !== '/';
        }).sort(byName);
        var files = ents.filter(function(e){ return e && !isDirFn(e); }).sort(byName);
        if (!dirs.length && !files.length){
          listEl.innerHTML = '<div style="padding:8px;color:var(--text3)">（此目录为空 — 可直接「＋ 选用当前」）</div>';
          return;
        }
        var _sz = function(n){
          n = +n || 0; var u = ['B', 'KB', 'MB', 'GB', 'TB'], i = 0;
          while (n >= 1024 && i < u.length - 1){ n /= 1024; i++; }
          return (n < 10 ? Math.round(n * 10) / 10 : Math.round(n)) + u[i];
        };
        var rowOf = function(e, kind){
          var full = fullOf(e), isD = (kind === 'dir');
          return '<div class="tpib-dir" data-path="' + _tpEsc(full) + '" data-kind="' + kind + '"'
            + ' style="display:flex;align-items:center;gap:6px;padding:4px 7px;border-radius:5px;cursor:pointer">'
            + '<input type="checkbox" class="tpib-ck" data-path="' + _tpEsc(full) + '" data-kind="' + kind + '"'
            + ' style="margin:0;cursor:pointer;flex:0 0 auto" title="勾选后可「＋ 加入选中」(支持多选)">'
            + '<span>' + (isD ? '📁' : '📄') + '</span>'
            + '<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:monospace">'
            + _tpEsc(e.name) + '</span>'
            + (isD ? '' : '<span style="color:var(--text3);font-size:10px">' + _sz(e.size) + '</span>')
            + '<span class="tpib-pick-row" style="color:var(--green);font-weight:600;font-size:11px;cursor:pointer;white-space:nowrap">'
            + (isD ? '✓ 选定此目录' : '✓ 选用此文件') + '</span>'
            + '</div>';
        };
        listEl.innerHTML = dirs.map(function(d){ return rowOf(d, 'dir'); }).join('')
                         + files.map(function(f){ return rowOf(f, 'file'); }).join('');
        listEl.querySelectorAll('.tpib-dir').forEach(function(dEl){
          var p2 = dEl.getAttribute('data-path');
          _bindRow(dEl, function(){
            if (dEl.getAttribute('data-kind') === 'file'){ done(p2); return; }   // 文件: 单击即选用
            load(p2);                                                            // 目录: 单击进入
          }, function(){ done(p2); });
        });
        listEl.querySelectorAll('.tpib-ck').forEach(function(ck){
          ck.onclick = function(ev){ ev.stopPropagation(); updCount(); };
        });
        updCount();
      });
    }
    function done(p){
      var pick = p || cur;
      if (mode === 'local' && !/^\//.test(pick)) pick = '/' + pick;   // 保险: 本机模式必须绝对
      try { box.remove(); } catch(_){}
      delete _openPanels[key];
      if (typeof opts.onPick === 'function') opts.onPick(pick);
    }
    function updCount(){
      var n = listEl.querySelectorAll('.tpib-ck:checked').length;
      var b = box.querySelector('.tpib-add');
      if (b){ b.textContent = '＋ 加入选中' + (n ? (' (' + n + ')') : ''); b.style.opacity = n ? '1' : '.65'; }
    }
    // 空值保护: 「＋ 加入选中」只存在于本函数构造的内联面板(另一个"选目标目录"的选择器没有它)
    var addBtn = box.querySelector('.tpib-add');
    if (addBtn){
      addBtn.onclick = function(){
        var picked = [];
        listEl.querySelectorAll('.tpib-ck:checked').forEach(function(ck){ picked.push(ck.dataset.path); });
        if (!picked.length){ if (typeof toast === 'function') toast('先勾选目录或文件(支持多选)', 'warn', 2000); return; }
        picked.forEach(function(p2){ if (typeof opts.onPick === 'function') opts.onPick(p2); });
        listEl.querySelectorAll('.tpib-ck:checked').forEach(function(ck){ ck.checked = false; });
        updCount();
      };
    }
box.querySelector('.tpib-up').onclick = function(){ load(cur.replace(/\/+$/, '').split('/').slice(0, -1).join('/') || '/'); };
    box.querySelector('.tpib-ref').onclick = function(){ load(cur); };
    box.querySelector('.tpib-pick').onclick = function(){ done(); };   // v5.27.0: 同上
    box.querySelector('.tpib-close').onclick = function(){ try { box.remove(); } catch(_){} delete _openPanels[key]; };
    load(startPath);
  }

  g.TargetPicker = { attach: attach, val: val, enrich: enrich, localPath: localPath,
                     pickLocal: pickLocal, autoAttach: autoAttach, test: test, runPush: runPush,
                     _loadData: _loadData, openInlineFor: openInlineFor };
  // v5.15.0 · 兼容旧调用点 (vzdump.js 直接引用)
  g._vdPickPath = pickLocal;

  document.addEventListener('DOMContentLoaded', function(){
    setTimeout(function(){ try { autoAttach(); } catch(e){ console.warn(e); } }, 2600);
  });
})(window);
