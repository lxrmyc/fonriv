/*
 * frontend/static/panels/shares.js · v4.39.0 Phase 2a
 *
 * 网络共享面板：SMB / NFS / AFP / WebDAV
 *   - 挂载到本机 /var/lib/fonriv_mounts/shares/<uuid>
 *   - 挂载后是本机路径，传输走 direction='local'
 *   - 表格 CRUD + 挂载/卸载/测试
 *
 * 依赖: app.js 的 send() (WS 单发)
 */
(function(){
  if (typeof window === 'undefined') return;
  if (window.Shares) return;

  var $ = function(id){ return document.getElementById(id); };
  var _shares = [];        // 配置列表
  var _editingUuid = null; // 编辑中的 uuid
  var _PROTO_LABEL = {
    smb: '🖥 SMB', nfs: '📂 NFS', afp: '🍏 AFP', webdav: '🌐 WebDAV'
  };
  var _DEFAULT_PORT = { smb:'445', nfs:'2049', afp:'548', webdav:'443' };

  function _esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }

  function _fmtTime(s){
    if (!s) return '-';
    return s.length > 16 ? s.slice(5) : s;  // 去掉年份前缀，显示 MM-DD HH:MM:SS
  }

  // v4.39.3 · 将后端返回的本机 df 共享挂载点合并进 __dmDfMounts，
  //   并刷新文件传输页(TriPaneTransfer)与 DM 三栏(TransferTri) 的 df 下拉分组。
  //   后端在 share_mount / share_umount 成功后返回 df_mounts: [{mount,source,avail,...}]
  function _syncDfMounts(d){
    try {
      if (!d || !d.df_mounts) return;
      var existing = window.__dmDfMounts || { host: '127.0.0.1', ts: 0, mounts: [] };
      // 去重: 移除已有的 SHARE_MOUNT_ROOT 命名空间挂载点 (可能已过期)，再追加新的
      var SR = '/var/lib/fonriv_mounts/shares/';
      var keep = [];
      (existing.mounts || []).forEach(function(m){
        if (m && m.mount && m.mount.indexOf(SR) === 0) return; // 共享挂载点: 由后端 df_mounts 重新提供
        keep.push(m);
      });
      (d.df_mounts || []).forEach(function(m){
        if (m && m.mount) keep.push({ mount: m.mount, source: m.source||'', avail: m.avail||'', use_pct: m.use_pct||'' });
      });
      window.__dmDfMounts = { host: '127.0.0.1', ts: Date.now(), mounts: keep };
      // 刷新文件传输页 df 下拉
      try { if (window.TriPaneTransfer && typeof window.TriPaneTransfer.refreshServers === 'function') window.TriPaneTransfer.refreshServers(); } catch(_){}
      // 刷新 DM 三栏 df 下拉 (源/目标)
      try {
        if (window._triInstances && typeof window._triInstances === 'object'){
          for (var k in window._triInstances){
            var tri = window._triInstances[k];
            if (tri && typeof tri.refreshServers === 'function') tri.refreshServers();
          }
        }
      } catch(_){}
    } catch(_){}
  }

  // 协议切换 -> 显隐字段 + 填默认端口
  function syncFields(){
    var proto = ($('shProto')||{}).value || 'smb';
    // 默认端口提示
    var portEl = $('shPort');
    if (portEl && !portEl.value){
      portEl.placeholder = _DEFAULT_PORT[proto] || '';
    }
    // SMB 专属：域/工作组 + 版本
    var showSmb = (proto === 'smb');
    var dF = $('shDomainField'); if (dF) dF.style.display = showSmb ? '' : 'none';
    var vF = $('shVersField');  if (vF) vF.style.display = showSmb ? '' : 'none';
    // NFS/AFP/WebDAV 隐藏域和版本
    // 认证行：NFS 可能 guest（无认证），但仍保留字段
    // 共享名标签
    var sf = $('shShareField');
    if (sf){
      var lbl = sf.querySelector('label');
      if (lbl){
        if (proto === 'nfs') lbl.textContent = '导出路径';
        else if (proto === 'webdav') lbl.textContent = 'URL 路径';
        else lbl.textContent = '共享名';
      }
      var inp = sf.querySelector('input');
      if (inp){
        inp.placeholder = (proto === 'nfs') ? '/mnt/nfs_share' :
                          (proto === 'webdav') ? 'dav/share' : 'backup';
      }
    }
    // 提示
    var hint = $('shFormHint');
    if (hint){
      if (proto === 'smb') hint.textContent = 'SMB: Windows 共享 / NAS 默认协议。需 cifs-utils。';
      else if (proto === 'nfs') hint.textContent = 'NFS: Linux/Unix 共享。需 nfs-common。NFS v4 较常见。';
      else if (proto === 'afp') hint.textContent = 'AFP: macOS Time Machine 等用。需 afpfs-ng（URL 内联凭据）。';
      else if (proto === 'webdav') hint.textContent = 'WebDAV: Nextcloud/ownCloud 等。需 davfs2（挂载时自动写 /etc/davfs2/secrets）。';
    }
  }

  // 清空表单
  function reset(){
    ['shName','shHost','shPort','shShare','shUser','shAuthValue','shDomain','shPath','shOpts','shUid','shGid'].forEach(function(id){
      var el = $(id); if(el){ if(id==='shUid'||id==='shGid') el.value='0'; else el.value=''; }
    });
    var p = $('shProto'); if(p) p.value = 'smb';
    var c = $('shColor'); if(c) c.value = 'var(--blue)';
    var v = $('shVers'); if(v) v.value = '';
    var r = $('shRo'); if(r) r.value = '0';
    _editingUuid = null;
    var t = $('shFormTitle'); if(t) t.textContent = '✏️ 新建共享';
    var s = $('shSaveBtn'); if(s){ s.textContent = '💾 新增'; }
    var cb = $('shCancelBtn'); if(cb) cb.style.display = 'none';
    syncFields();
  }

  function newShare(){ reset(); $('shName') && $('shName').focus(); }

  // 编辑：载入到表单
  function edit(uuid){
    // v5.93.0 · 返回是否命中: 连接中心「引用式编辑」据此判断表单是否真的载入了(未命中要报错, 不能静默)
    var s = _shares.filter(function(x){ return x.uuid === uuid; })[0];
    if (!s) return false;
    _editingUuid = uuid;
    $('shName').value = s.name || '';
    $('shProto').value = s.proto || 'smb';
    $('shColor').value = s.color || 'var(--blue)';
    $('shHost').value = s.host || '';
    $('shPort').value = (s.port && s.port !== _DEFAULT_PORT[s.proto]) ? s.port : '';
    $('shShare').value = s.share || '';
    $('shUser').value = s.user || '';
    $('shAuthValue').value = '';  // 不回显密码
    $('shAuthValue').placeholder = '留空不修改';
    $('shDomain').value = s.domain || '';
    $('shVers').value = s.vers || '';
    $('shRo').value = String(s.ro || 0);
    $('shUid').value = s.uid || '0';
    $('shGid').value = s.gid || '0';
    $('shPath').value = s.path || '';
    $('shOpts').value = s.opts || '';
    var t = $('shFormTitle'); if(t) t.textContent = '✏️ 编辑: ' + (s.name || uuid.slice(0,8));
    var sb = $('shSaveBtn'); if(sb){ sb.textContent = '💾 保存'; }
    var cb = $('shCancelBtn'); if(cb) cb.style.display = '';
    syncFields();
    $('shFormBox') && $('shFormBox').scrollIntoView({behavior:'smooth'});
    return true;
  }

  function cancelEdit(){ reset(); }

  // 收集表单 -> data
  function _collect(){
    var data = {
      name: ($('shName').value||'').trim(),
      proto: ($('shProto').value||'smb').trim(),
      color: ($('shColor').value||'var(--blue)').trim(),
      host: ($('shHost').value||'').trim(),
      port: ($('shPort').value||'').trim(),
      share: ($('shShare').value||'').trim(),
      user: ($('shUser').value||'').trim(),
      auth_value: ($('shAuthValue').value||'').trim(),
      domain: ($('shDomain').value||'').trim(),
      vers: ($('shVers').value||'').trim(),
      ro: ($('shRo').value === '1') ? 1 : 0,
      uid: ($('shUid').value||'0').trim(),
      gid: ($('shGid').value||'0').trim(),
      path: ($('shPath').value||'').trim(),
      opts: ($('shOpts').value||'').trim(),
    };
    if (_editingUuid) data.uuid = _editingUuid;
    return data;
  }

  function save(){
    var data = _collect();
    if (!data.name){ toastErr && toastErr('名称不能为空'); return; }
    if (!data.host){ toastErr && toastErr('主机不能为空'); return; }
    if (!data.share){ toastErr && toastErr('共享名/路径不能为空'); return; }
    // 后端要求字段平铺（data.get("name")），用 Object.assign 平铺
    var payload = Object.assign({ action:'share_save' }, data);
    send(payload, function(d){
      if (d && d.status === 'ok'){
        toastOk && toastOk(d.msg || '已保存');
        reset();
        refresh(true);
      } else {
        toastErr && toastErr((d && d.msg) || '保存失败');
      }
    });
  }

  // 表单测试（先临时存再测，或直接传参测试）
  function testForm(){
    var data = _collect();
    if (!data.host || !data.share){
      toastErr && toastErr('请先填写主机和共享名');
      return;
    }
    // 先保存（如果是新建）再测，或直接提示先保存
    if (!_editingUuid){
      toastErr && toastErr('请先保存配置，再测试');
      return;
    }
    send({ action:'share_test', uuid:_editingUuid }, function(d){
      if (d && d.status === 'ok'){
        toastOk && toastOk('连通: ' + (d.msg||'').slice(0,60));
      } else {
        toastErr && toastErr('测试失败: ' + ((d && d.msg) || '').slice(0,120));
      }
    });
  }

  async function del(uuid){
    if (!(await rpConfirm({ title:'删除共享配置', danger:true, okText:'删除', body:'确认删除此共享配置？' }))) return;
    send({ action:'share_delete', uuid:uuid }, function(d){
      if (d && d.status === 'ok'){
        toastOk && toastOk('已删除');
        refresh(true);
      } else {
        toastErr && toastErr((d && d.msg) || '删除失败');
      }
    });
  }

  function mount(uuid){
    send({ action:'share_mount', uuid:uuid }, function(d){
      _syncDfMounts(d);  // v4.39.3 · 更新 __dmDfMounts + 刷新 df 下拉
      if (d && d.status === 'ok'){
        toastOk && toastOk(d.msg || '已挂载');
        if (d.mnt) toastOk && toastOk('挂载点: ' + d.mnt);
        // v4.40.0 · 只读/读写检测结果提示
        if (d.rw_label){
          if (d.rw === 'rw'){
            toastOk && toastOk('✏️ 可读写: 可正常上传/写入');
          } else if (d.rw === 'ro'){
            toastErr && toastErr('🔒 实际只读: ' + (d.rw_reason || '服务器限制') + ' · 仅可下载/读取');
          } else {
            toastWarn && toastWarn('⚠ 读写状态未知: ' + (d.rw_reason || ''));
          }
          try { addLog('网络共享 ' + (d.msg||'') + ' · 读写检测: ' + d.rw_label + (d.rw_reason ? ' (' + d.rw_reason + ')' : ''), d.rw === 'rw' ? 'success' : 'warn'); } catch(_){}
        }
        refresh(true);
      } else {
        toastErr && toastErr('挂载失败: ' + ((d && d.msg) || '').slice(0,150));
        refresh(true);
      }
    });
  }

  function umount(uuid){
    send({ action:'share_umount', uuid:uuid }, function(d){
      _syncDfMounts(d);  // v4.39.3 · 更新 __dmDfMounts + 刷新 df 下拉
      if (d && d.status === 'ok'){
        toastOk && toastOk(d.msg || '已卸载');
        refresh(true);
      } else {
        toastErr && toastErr('卸载失败: ' + ((d && d.msg) || '').slice(0,150));
        refresh(true);
      }
    });
  }

  function testById(uuid){
    send({ action:'share_test', uuid:uuid }, function(d){
      if (d && d.status === 'ok'){
        toastOk && toastOk('连通: ' + (d.msg||'').slice(0,60));
      } else {
        toastErr && toastErr('测试失败: ' + ((d && d.msg) || '').slice(0,120));
      }
    });
  }

  // 渲染列表表格 (v6.1.4 · webui wui-tbl 口径, 与数据总览共享表同款)
  function _renderList(list){
    var box = $('shListBox');
    if (!box) return;
    if (!list || list.length === 0){
      box.innerHTML = rpState({ state: 'empty', msg: '暂无共享配置', hint: '点右上「＋ 新建」添加' });
      return;
    }
    var html = '<table class="wui-tbl" style="width:100%">'
      + '<thead><tr>'
      + '<th>名称</th>'
      + '<th>协议</th>'
      + '<th>主机:共享</th>'
      + '<th>模式</th>'
      + '<th>实际读写</th>'
      + '<th>状态</th>'
      + '<th>最近挂载</th>'
      + '<th class="r">操作</th>'
      + '</tr></thead><tbody>';
    list.forEach(function(s){
      var proto = _PROTO_LABEL[s.proto] || s.proto || '';
      var hostShare = _esc(s.host || '') + ':' + _esc(s.share || '');
      var mode = (s.ro ? '🔒只读' : '✏️读写');
      var mounted = !!s.mounted;
      // v4.40.0 · 实际读写状态 (挂载后真实写入探测; ro=实际只读 · rw=可写 · unknown=未知)
      var rwCell = '';
      if (mounted){
        if (s.rw === 'rw') rwCell = '<span style="color:var(--green)" title="实际写入探测通过 · 可正常上传">✏️ 读写</span>';
        else if (s.rw === 'ro') rwCell = '<span style="color:var(--red)" title="' + _esc(s.rw_reason || '服务器限制只读') + '">🔒 只读</span>';
        else rwCell = '<span style="color:var(--text3)" title="未能探测 (网络超时等)">❓ 未知</span>';
      } else {
        rwCell = '<span style="color:var(--text3)">—</span>';
      }
      var stIcon = mounted ? '<span class="dot on"></span>已挂载'
                 : (s.last_status === 'fail' ? '<span class="dot off"></span>失败' : '<span class="dot off"></span>未挂载');
      var stCell = '<span style="display:inline-flex;align-items:center;gap:5px">' + stIcon + '</span>';
      var mnt = s.mnt || ('/var/lib/fonriv_mounts/shares/' + (s.uuid||''));
      var ops = '';
      if (mounted){
        ops += '<button class="btn btn-sm" onclick="Shares.umount(\''+_esc(s.uuid)+'\')" style="padding:1px 8px;font-size:11px">⬇ 卸载</button> ';
        // 复制挂载点路径到传输
        ops += '<button class="btn btn-sm" onclick="Shares._copyMnt(\''+_esc(mnt)+'\')" style="padding:1px 8px;font-size:11px" title="复制挂载点路径">📋 路径</button>';
      } else {
        ops += '<button class="btn btn-sm btn-primary" onclick="Shares.mount(\''+_esc(s.uuid)+'\')" style="padding:1px 8px;font-size:11px">⬆ 挂载</button> ';
      }
      ops += ' <button class="btn btn-sm" onclick="Shares.testById(\''+_esc(s.uuid)+'\')" style="padding:1px 8px;font-size:11px">🔗 测试</button>';
      ops += ' <button class="btn btn-sm" onclick="Shares.edit(\''+_esc(s.uuid)+'\')" style="padding:1px 8px;font-size:11px">✏️</button>';
      ops += ' <button class="btn btn-sm" onclick="Shares.del(\''+_esc(s.uuid)+'\')" style="padding:1px 8px;font-size:11px;color:var(--red)">🗑</button>';
      html += '<tr>'
        + '<td><span style="color:'+(s.color||'var(--blue)')+'">●</span> '+_esc(s.name||'')+'</td>'
        + '<td><span class="sh-bd">'+proto+'</span></td>'
        + '<td class="mono">'+hostShare+'</td>'
        + '<td>'+mode+'</td>'
        + '<td>'+rwCell+'</td>'
        + '<td>'+stCell+'</td>'
        + '<td style="color:var(--text3)">'+_fmtTime(s.last_mounted_at)+'</td>'
        + '<td class="r" style="white-space:nowrap">'+ops+'</td>'
        + '</tr>';
      if (mounted){
        html += '<tr><td colspan="8" style="padding:2px 14px 8px;font-size:11px;color:var(--cyan);font-family:ui-monospace,monospace">└ 挂载点 '+_esc(mnt)+'</td></tr>';
      }
    });
    html += '</tbody></table>';
    box.innerHTML = html;
  }

  function _copyMnt(mnt){
    try {
      navigator.clipboard.writeText(mnt);
      toastOk && toastOk('已复制: ' + mnt);
    } catch(e){
      toastErr && toastErr('复制失败: ' + e.message);
    }
  }

  /* v5.93.0 · 收口到 RPList(用户要求: 空结果缓存统一):
     旧实现失败即把列表区清空、空结果即 `_shares=[]` → 用户看到"共享列表消失又回来"。
     现在: 单次空/失败先短重试; 仍失败则保留上次成功列表并显式提示; 真删光了(三次都空)才接受空。 */
  async function refresh(fresh){
    var box = $('shListBox');
    // v6.16.14 · fresh=true: 写操作(新建/编辑/删除/挂载)后强制另起请求 ——
    //   否则会并入飞行中的旧请求, 拿到写之前的旧列表(用户实测: "提示已创建但列表不显示")
    var r = await RPList.load('shares', 'share_list', {},
                              {pick:'shares', acceptSettledEmpty:true, fresh:!!fresh});
    if (!box) return;
    if (!r || !r.ok){
      box.innerHTML = '<div style="color:var(--red);font-size:12px">读取失败: '+esc(r && r.err || '未知原因')+'</div>'
        + '<div style="margin-top:6px"><button class="btn btn-xs" onclick="Shares.refresh()">🔄 重试</button></div>';
      return;
    }
    _shares = r.data || [];
    try { window.__sharesCache = _shares.slice(); } catch(_){}
    _syncDfMounts(r.raw || {});   // v4.39.3 · share_list 也带 df_mounts, 同步刷新 df 下拉
    _renderList(_shares);
    if (r.stale && box.firstChild){
      box.insertAdjacentHTML('afterbegin', '<div style="font-size:10.5px;color:var(--yellow);padding:2px 4px">'
        + '⚠ 本次未取到最新列表('+esc(r.err || '')+'), 显示的是上次成功结果</div>');
    }
  }

  function pluginCheck(){
    send({ action:'share_plugin_check' }, function(d){
      var box = $('shPluginBox');
      var list = $('shPluginList');
      if (!box || !list) return;
      if (!d || d.status !== 'ok'){
        list.innerHTML = '<div style="color:var(--red);font-size:12px">'+(d && d.msg || '检测失败')+'</div>';
        box.style.display = '';
        return;
      }
      var checks = d.checks || [];
      var html = '<table class="dm-table" style="width:100%;font-size:12px;border-collapse:collapse">'
        + '<thead><tr style="background:var(--bg3);color:var(--text2)">'
        + '<th style="padding:6px 8px;text-align:left">协议</th>'
        + '<th style="padding:6px 8px;text-align:left">二进制</th>'
        + '<th style="padding:6px 8px;text-align:left">状态</th>'
        + '<th style="padding:6px 8px;text-align:left">安装包 ('+_esc(d.pkg_mgr||'?')+')'
        + '<th style="padding:6px 8px;text-align:left">操作</th>'
        + '</tr></thead><tbody>';
      checks.forEach(function(c){
        var st = c.installed ? '<span style="color:var(--green)">✓ 已安装</span>' : '<span style="color:var(--red)">✗ 未安装</span>';
        var installCmd = '';
        if (!c.installed){
          var pkg = c.apt_pkg || '';
          var mgr = d.pkg_mgr || 'apt';
          if (mgr === 'apt') installCmd = 'sudo apt-get install -y ' + pkg;
          else if (mgr === 'dnf') installCmd = 'sudo dnf install -y ' + pkg;
          else if (mgr === 'zypper') installCmd = 'sudo zypper install -y ' + pkg;
          else if (mgr === 'pacman') installCmd = 'sudo pacman -S --noconfirm ' + pkg;
        }
        var act = c.installed ? '-' : '<button class="btn btn-sm" onclick="Shares._install(\''+_esc(pkg)+'\',\''+_esc(installCmd)+'\')" style="padding:1px 6px;font-size:10px">一键安装</button>';
        html += '<tr style="border-bottom:1px solid var(--border)">'
          + '<td style="padding:6px 8px">'+_esc(c.proto.toUpperCase())+'</td>'
          + '<td style="padding:6px 8px;font-family:monospace">'+_esc(c.bin)+'</td>'
          + '<td style="padding:6px 8px">'+st+'</td>'
          + '<td style="padding:6px 8px;font-family:monospace">'+_esc(c.apt_pkg)+'</td>'
          + '<td style="padding:6px 8px">'+act+'</td>'
          + '</tr>';
      });
      html += '</tbody></table>';
      list.innerHTML = html;
      box.style.display = '';
    });
  }

  async function _install(pkg, cmd){
    if (!(await rpConfirm({ title:'安装依赖', danger:true, okText:'继续', body:'将在本机执行:\n' + cmd + '\n\n确认安装 ' + pkg + ' ?' }))) return;
    // 复用 disk_plugin_install 的本机安装逻辑? 不行那是远端 SSH。
    // 这里用 terminal_open 在本机执行? 不行 terminal 是 SSH。
    // 直接提示用户在终端执行，或调用 system shell?
    // 简单方案: 提示复制命令到终端执行
    rpPrompt({ title:'请在服务器终端执行以下命令安装依赖（需 root）', defaultName: cmd, okText:'知道了' });
  }

  /* v5.98.7 · 同上(网络共享): 会话就绪/重连后若列表为空则补拉一次 */
  try {
    window.addEventListener('rp-ws-ready', function(){
      try { if (!(_shares && _shares.length)) refresh(); } catch(e){}
    });
  } catch(e){}

  window.Shares = {
    refresh: refresh,
    newShare: newShare,
    edit: edit,
    cancelEdit: cancelEdit,
    reset: reset,
    save: save,
    testForm: testForm,
    del: del,
    mount: mount,
    umount: umount,
    testById: testById,
    pluginCheck: pluginCheck,
    syncFields: syncFields,
    _copyMnt: _copyMnt,
    _install: _install,
    __version: 'v4.39.0',
  };

  /* ═══ v5.51.0 · P1-9 统一入口提示 ═══
     云存储/网络共享已纳入「连接中心 · 统一资源目录」(一处探测/挂载/查看能力),
     本页保留为字段编辑与能力详情页; 顶部横幅给出跳转入口。 */
  function _hubBanner(panelId, kind, text){
    try {
      var host = document.getElementById(panelId);
      if (!host || host.querySelector('.hub-banner')) return;
      var d = document.createElement('div');
      d.className = 'hub-banner';
      d.style.cssText = 'margin:8px 0;padding:6px 10px;border:1px dashed var(--border);border-radius:6px;'
        + 'font-size:11px;color:var(--text3);display:flex;gap:8px;align-items:center;flex-wrap:wrap';
      d.innerHTML = '<span>' + text + '</span>'
        + '<button class="btn btn-sm" style="padding:1px 8px;font-size:10px" '
        + 'onclick="try{switchTab(\'conn_center\');setTimeout(function(){'
        + 'window.ConnCenter&&ConnCenter.filterKind&&ConnCenter.filterKind(\'' + kind + '\');},700);}catch(e){}">'
        + '\uD83D\uDD17 前往连接中心</button>';
      host.insertBefore(d, host.firstChild);
    } catch(e){}
  }
  function _installHubBanner(){
    var panelId = 'panel-shares';
    _hubBanner(panelId, 'share', '📁 网络共享已纳入「连接中心 · 统一资源目录」— 挂载/卸载一处管理; 本页保留为字段编辑与能力详情。');
    try {
      var host = document.getElementById(panelId);
      if (host && window.MutationObserver){
        new MutationObserver(function(){ _hubBanner(panelId, 'share', '📁 网络共享已纳入「连接中心 · 统一资源目录」— 挂载/卸载一处管理; 本页保留为字段编辑与能力详情。'); })
          .observe(host, {attributes:true, attributeFilter:['class']});
      }
    } catch(e){}
  }
  if (document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', function(){ setTimeout(_installHubBanner, 2500); });
  } else {
    setTimeout(_installHubBanner, 2500);
  }
})();
