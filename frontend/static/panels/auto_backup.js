/*
 * frontend/static/panels/auto_backup.js · v3.4.8
 *
 * app.js 拆分战役 · 收官砖（一键自动备份 + 恢复面板）
 * ----------------------------------------------------------------------
 * 抽出 15 个函数 + 1 段 event listener：
 *   saveAbConfig / updateAbAuthUI / testAbConn / getAbAuth
 *   toggleAllBackupItems / updateBackupItemCount / getBackupItemSelections
 *   runAutoBackup
 *   getAbRestoreAuth / runRestoreDetect / runRestoreCompare
 *   toggleAllDiffItems / runRestoreSelected / runRestoreAll
 *   runRestoreBrowse / restoreSingleItem
 *
 * 模块级私有：_abDiffData
 *
 * 依赖（app.js 全局）：
 *   send / addLog / gv / addPanelLog / setPanelProgress / getPanelLog
 *   ConnPanel_renderAuth / ConnPanel_getAuth
 */
(function(){
  if (typeof window === 'undefined') return;
  if (window.__autoBackupModuleLoaded) return;
  window.__autoBackupModuleLoaded = 'v3.5.5';

  function saveAbConfig(){
    var cfg={host:gv('abHost'),port:gv('abPort'),user:gv('abUser'),
      auth_type:gv('abAuthType'),local_dst:gv('abLocalDst'),extra_paths:gv('abExtraPaths')};
    // v5.34.0 P0: 凭据不再落 localStorage — 密码/口令仅存内存/侧栏 configs; 密钥路径非敏感
    if(cfg.auth_type==='pass') cfg._has_pw=!!gv('abAuthValue');
    else {
      cfg.key_path=gv('abAuthValue')||'';   // v5.90.2 · 不再兜底 '~/.ssh/id_rsa'(假路径)
      cfg._has_passphrase=!!gv('abAuthPassphrase');
    }
    localStorage.setItem('fonriv_ab_config',JSON.stringify(cfg));
    addLog('一键备份配置已保存 (凭据不落浏览器)','success');
  }

  function updateAbAuthUI(){
    ConnPanel_renderAuth('ab', { valueId:'abAuthValue', passphraseId:'abAuthPassphrase', passLabel:'密码', passPlaceholder:'服务器 root 密码' });
  }

  async function testAbConn(){
    var host = gv('abHost');
    var resEl = document.getElementById('abConnResult');
    if(!host){
      if(resEl){ resEl.textContent = '✗ 请先输入主机地址'; resEl.style.color = 'var(--red)'; }
      return;
    }
    var auth = getAbAuth();
    auth = await upgradeAuthToEC1(auth);
    var lp = getPanelLog('ab'); if(lp){ lp.innerHTML=''; lp.classList.add('visible'); }
    addPanelLog('ab', '测试连接 '+host+'...', 'info');
    setPanelProgress('ab', 0, '测试连接...');
    if(resEl){ resEl.textContent = '测试中...'; resEl.style.color = 'var(--orange)'; }
    send({ action:'test_conn', host:host, port:gv('abPort')||'22', user:gv('abUser')||'root',
      auth_type:auth.auth_type, password:auth.password, key: auth.key, passphrase: auth.passphrase }, function(d){
      setPanelProgress('ab', 100, d.status === 'ok' ? '连接成功 ✓' : '连接失败 ✗');
      addPanelLog('ab', d.msg, d.status === 'ok' ? 'success' : 'error');
      if(resEl){
        resEl.textContent = d.status === 'ok' ? '✓ 连接成功' : '✗ ' + (d.msg || '连接失败');
        resEl.style.color = d.status === 'ok' ? 'var(--green)' : 'var(--red)';
      }
    });
  }

  function getAbAuth(){
    return ConnPanel_getAuth('ab', { valueId:'abAuthValue', passphraseId:'abAuthPassphrase' });
  }

  function toggleAllBackupItems(checked){
    document.querySelectorAll('.ab-item-cb').forEach(function(cb){ cb.checked=checked; });
    updateBackupItemCount();
  }
  function updateBackupItemCount(){
    var n = document.querySelectorAll('.ab-item-cb:checked').length;
    var el = document.getElementById('abItemCount');
    if(el) el.textContent = n;
  }
  function getBackupItemSelections(){
    var items = [];
    document.querySelectorAll('.ab-item-cb').forEach(function(cb){
      items.push(cb.checked);
    });
    return items;
  }
  // Auto-update count on checkbox change (v3.4.8: 保留原挂载点)
  document.addEventListener('change', function(e){
    if(e.target.classList && e.target.classList.contains('ab-item-cb')) updateBackupItemCount();
  });

  async function runAutoBackup(){
    var host = gv('abHost');
    // v5.15.0 · 保存位置选择器: 本机/df挂载点/网络共享 → 直接落盘; 服务器/云端 → 保留本机路径并指引
    var local_dst = (window.TargetPicker ? window.TargetPicker.pickLocal('abLocalDst', gv('abLocalDst')) : gv('abLocalDst'));
    if(!host){ alert('请先输入服务器地址'); return; }
    if(!local_dst){ alert('请先选择本地目标文件夹'); return; }
    var auth = getAbAuth();
    if(auth.auth_type === 'pass' && !gv('abAuthValue')){ alert('请输入密码'); return; }
    auth = await upgradeAuthToEC1(auth);

    setPanelProgress('ab', 0, '准备备份 '+host+'...');
    var lp = getPanelLog('ab'); if(lp){ lp.innerHTML=''; lp.classList.add('visible'); }
    addPanelLog('ab', '开始一键自动备份 → '+host, 'info');
    addPanelLog('ab', '本地目标: '+local_dst, 'info');
    addPanelLog('ab', '正在连接 '+gv('abUser')+'@'+host+'...', 'info');

    send({
      action:'auto_backup',
      host:host,
      port:gv('abPort')||'22',
      user:gv('abUser')||'root',
      auth_type:auth.auth_type,
      password:auth.password,
      key:auth.key,
      passphrase:auth.passphrase,
      local_dst:local_dst,
      extra_paths:gv('abExtraPaths'),
      items: getBackupItemSelections()
    }, function(d){
      if(d.status === 'ok'){
        setPanelProgress('ab', 100, '备份完成 ✓');
        addPanelLog('ab', '✅ 备份完成: '+d.archive, 'success');
        addPanelLog('ab', '保存路径: '+d.archive_path, 'success');
        addPanelLog('ab', '配置项: '+d.items_copied+' 个', 'info');
        addLog('✅ 一键备份完成: '+d.archive, 'success');
        var rf = document.getElementById('abRestoreFile');
        if(rf && d.archive_path) rf.value = d.archive_path;
        // v5.16.0 · 保存位置为服务器/云端 → 备份完成后自动推送/上传
        var _pushDir = (d.archive_path || local_dst || '').replace(/\/[^\/]*$/, '');
        if(window.TargetPicker && _pushDir){
          window.TargetPicker.runPush('abLocalDst', _pushDir, {
            onLog: function(m){ addPanelLog('ab', m, 'info'); }
          }).then(function(pr){
            if(pr && !pr.skipped){
              if(pr.ok) addPanelLog('ab', '📤 已投递到所选保存位置', 'success');
              else addPanelLog('ab', '⚠ 投递失败 (产物仍在本机): '+(pr.msg||''), 'error');
            }
          });
        }
      } else {
        setPanelProgress('ab', 100, '备份失败 ✗');
        addPanelLog('ab', '❌ '+d.msg, 'error');
        addLog('❌ 一键备份失败', 'error');
      }
    }, true);
  }

  // 一键恢复
  var _abDiffData = null;

  async function getAbRestoreAuth(){
    var auth = getAbAuth();
    auth = await upgradeAuthToEC1(auth);
    return {
      host: gv('abHost'),
      port: gv('abPort') || '22',
      user: gv('abUser') || 'root',
      auth_type: auth.auth_type,
      password: auth.password,
      key: auth.key, passphrase: auth.passphrase
    };
  }

  async function runRestoreDetect(){
    var a = await getAbRestoreAuth();
    if(!a.host){ alert('请先输入服务器地址'); return; }
    setPanelProgress('ab', 0, '检测服务器...');
    var lp = getPanelLog('ab'); if(lp){ lp.innerHTML=''; lp.classList.add('visible'); }
    addPanelLog('ab', '正在检测服务器 '+a.host+' ...', 'info');
    send({ action:'auto_restore_detect', host:a.host, port:a.port, user:a.user,
      auth_type:a.auth_type, password:a.password, key:a.key, passphrase:a.passphrase }, function(d){
      if(d.status === 'ok'){
        setPanelProgress('ab', 100, '检测完成 ✓');
        var info = document.getElementById('abDetectInfo');
        var result = document.getElementById('abDetectResult');
        if(info && result){
          var html = '<div style="display:grid;grid-template-columns:1fr 1fr;gap:4px 16px">';
          html += '<div>主机名: <b>'+d.hostname+'</b></div>';
          html += '<div>PVE版本: <b>'+d.pve_version+'</b></div>';
          html += '<div>内核: <b>'+d.kernel+'</b></div>';
          html += '<div>VM数量: <b>'+d.vms.length+'</b></div>';
          html += '<div>LXC数量: <b>'+d.lxcs.length+'</b></div>';
          html += '<div>存储: <b>'+d.storages.length+'</b> 个</div>';
          html += '</div>';
          if(d.is_new_install){
            html += '<div style="margin-top:8px;padding:8px;background:rgba(40,167,69,0.15);border-radius:4px;color:#28a745;font-weight:600">🆕 检测到新安装的 Proxmox，建议执行一键恢复全部配置</div>';
          }
          if(d.vms.length > 0){
            html += '<div style="margin-top:8px;font-size:11px">VM列表: ';
            d.vms.forEach(function(v){ html += '<span style="margin-right:8px">'+v.vmid+'('+v.name+') '+v.status+'</span>'; });
            html += '</div>';
          }
          if(d.lxcs.length > 0){
            html += '<div style="margin-top:4px;font-size:11px">LXC列表: ';
            d.lxcs.forEach(function(v){ html += '<span style="margin-right:8px">'+v.vmid+'('+v.name+') '+v.status+'</span>'; });
            html += '</div>';
          }
          info.innerHTML = html;
          result.style.display = 'block';
        }
        addPanelLog('ab', '✅ 检测完成: '+d.hostname+' ('+d.pve_version+')', 'success');
      } else {
        setPanelProgress('ab', 100, '检测失败 ✗');
        addPanelLog('ab', '❌ '+d.msg, 'error');
      }
    }, true);
  }

  async function runRestoreCompare(){
    var a = await getAbRestoreAuth();
    var archive_path = gv('abRestoreFile');
    if(!a.host){ alert('请先输入服务器地址'); return; }
    if(!archive_path){ alert('请先选择备份文件'); return; }
    setPanelProgress('ab', 0, '对比配置差异...');
    var lp = getPanelLog('ab'); if(lp){ lp.innerHTML=''; lp.classList.add('visible'); }
    addPanelLog('ab', '正在对比备份与服务器配置...', 'info');
    send({ action:'auto_restore_compare', host:a.host, port:a.port, user:a.user,
      auth_type:a.auth_type, password:a.password, key:a.key, passphrase:a.passphrase,
      archive_path:archive_path }, function(d){
      if(d.status === 'ok'){
        setPanelProgress('ab', 100, '对比完成 ✓');
        _abDiffData = d;
        var list = document.getElementById('abDiffList');
        var result = document.getElementById('abDiffResult');
        if(list && result){
          var html = '';
          if(d.diff_items && d.diff_items.length > 0){
            html += '<div style="font-size:12px;font-weight:600;color:var(--text);margin-bottom:4px">系统配置</div>';
            d.diff_items.forEach(function(item){
              var icon = item.diff_type === 'new' ? '🆕' : item.diff_type === 'changed' ? '📝' : '✅';
              var color = item.diff_type === 'same' ? '#666' : item.diff_type === 'new' ? '#28a745' : '#ffc107';
              var checked = item.can_restore ? 'checked' : 'disabled';
              html += '<div style="display:flex;align-items:center;gap:6px;padding:3px 0;font-size:12px">';
              if(item.can_restore) html += '<input type="checkbox" class="ab-diff-cb" data-name="'+item.name+'" '+checked+'>';
              else html += '<input type="checkbox" disabled>';
              html += '<span>'+icon+'</span>';
              html += '<span style="color:'+color+'">'+item.name+'</span>';
              html += '<span style="color:#888;font-size:11px">→ '+item.server_path+'</span>';
              html += '<span style="color:#888;font-size:11px">('+item.description+')</span>';
              html += '</div>';
            });
          }
          if(d.vm_diffs && d.vm_diffs.length > 0){
            html += '<div style="font-size:12px;font-weight:600;color:var(--text);margin:8px 0 4px">虚拟机配置</div>';
            d.vm_diffs.forEach(function(item){
              var icon = item.diff_type === 'new' ? '🆕' : '📝';
              var color = item.diff_type === 'new' ? '#28a745' : '#ffc107';
              html += '<div style="display:flex;align-items:center;gap:6px;padding:3px 0;font-size:12px">';
              html += '<input type="checkbox" class="ab-vm-cb" data-vmid="'+item.vmid+'" checked>';
              html += '<span>'+icon+'</span>';
              html += '<span style="color:'+color+'">VM '+item.vmid+'</span>';
              html += '<span style="color:#888;font-size:11px">('+item.description+')</span>';
              html += '</div>';
            });
          }
          if(d.lxc_diffs && d.lxc_diffs.length > 0){
            html += '<div style="font-size:12px;font-weight:600;color:var(--text);margin:8px 0 4px">LXC 容器配置</div>';
            d.lxc_diffs.forEach(function(item){
              var icon = item.diff_type === 'new' ? '🆕' : '📝';
              var color = item.diff_type === 'new' ? '#28a745' : '#ffc107';
              html += '<div style="display:flex;align-items:center;gap:6px;padding:3px 0;font-size:12px">';
              html += '<input type="checkbox" class="ab-lxc-cb" data-vmid="'+item.vmid+'" checked>';
              html += '<span>'+icon+'</span>';
              html += '<span style="color:'+color+'">LXC '+item.vmid+'</span>';
              html += '<span style="color:#888;font-size:11px">('+item.description+')</span>';
              html += '</div>';
            });
          }
          if(!html) html = '<div style="color:#888;font-size:12px">无差异</div>';
          list.innerHTML = html;
          result.style.display = 'block';
        }
        addPanelLog('ab', '✅ 对比完成: '+d.msg, 'success');
      } else {
        setPanelProgress('ab', 100, '对比失败 ✗');
        addPanelLog('ab', '❌ '+d.msg, 'error');
      }
    }, true);
  }

  function toggleAllDiffItems(checked){
    document.querySelectorAll('.ab-diff-cb:not([disabled])').forEach(function(cb){ cb.checked = checked; });
    document.querySelectorAll('.ab-vm-cb').forEach(function(cb){ cb.checked = checked; });
    document.querySelectorAll('.ab-lxc-cb').forEach(function(cb){ cb.checked = checked; });
  }

  async function runRestoreSelected(){
    var a = await getAbRestoreAuth();
    var archive_path = gv('abRestoreFile');
    if(!a.host){ alert('请先输入服务器地址'); return; }
    if(!archive_path){ alert('请先选择备份文件'); return; }
    var items = [];
    document.querySelectorAll('.ab-diff-cb:checked').forEach(function(cb){ items.push(cb.dataset.name); });
    var vms = [];
    document.querySelectorAll('.ab-vm-cb:checked').forEach(function(cb){ vms.push(cb.dataset.vmid); });
    var lxcs = [];
    document.querySelectorAll('.ab-lxc-cb:checked').forEach(function(cb){ lxcs.push(cb.dataset.vmid); });
    if(items.length === 0 && vms.length === 0 && lxcs.length === 0){ alert('请至少选择一项要恢复的配置'); return; }
    if(!(await rpConfirm({ title:'恢复选中项', danger:true, okText:'恢复', body:'确定要恢复选中的 '+items.length+' 个配置项, '+vms.length+' 个 VM, '+lxcs.length+' 个 LXC？\n\n当前服务器配置将被覆盖（已自动备份）' }))) return;

    setPanelProgress('ab', 0, '恢复中...');
    var lp = getPanelLog('ab'); if(lp){ lp.innerHTML=''; lp.classList.add('visible'); }
    addPanelLog('ab', '开始恢复选中项到 '+a.host+' ...', 'info');
    send({ action:'auto_restore', host:a.host, port:a.port, user:a.user,
      auth_type:a.auth_type, password:a.password, key:a.key, passphrase:a.passphrase,
      archive_path:archive_path, restore_items:items, restore_vms:vms, restore_lxcs:lxcs }, function(d){
      if(d.status === 'ok'){
        setPanelProgress('ab', 100, '恢复完成 ✓');
        addPanelLog('ab', '✅ 恢复完成: 成功 '+d.restored+'/'+d.total+' 项', 'success');
        addLog('✅ 一键恢复完成: 成功 '+d.restored+'/'+d.total+' 项', 'success');
      } else {
        setPanelProgress('ab', 100, '恢复失败 ✗');
        addPanelLog('ab', '❌ '+d.msg, 'error');
        addLog('❌ 一键恢复失败', 'error');
      }
    }, true);
  }

  async function runRestoreAll(){
    var a = await getAbRestoreAuth();
    var archive_path = gv('abRestoreFile');
    if(!a.host){ alert('请先输入服务器地址'); return; }
    if(!archive_path){ alert('请先选择备份文件'); return; }
    if(!(await rpConfirm({ title:'⚠️ 一键恢复全部配置', danger:true, okText:'恢复全部', body:'确定要一键恢复全部配置到 '+a.host+'？\n\n这将覆盖服务器上的所有配置文件！\n当前配置已自动备份到 .bak 文件。' }))) return;

    setPanelProgress('ab', 0, '一键恢复全部...');
    var lp = getPanelLog('ab'); if(lp){ lp.innerHTML=''; lp.classList.add('visible'); }
    addPanelLog('ab', '⚡ 开始一键恢复全部配置到 '+a.host+' ...', 'warn');
    send({ action:'auto_restore', host:a.host, port:a.port, user:a.user,
      auth_type:a.auth_type, password:a.password, key:a.key, passphrase:a.passphrase,
      archive_path:archive_path, restore_all:true }, function(d){
      if(d.status === 'ok'){
        setPanelProgress('ab', 100, '一键恢复完成 ✓');
        addPanelLog('ab', '✅ 一键恢复完成: 成功 '+d.restored+'/'+d.total+' 项', 'success');
        addLog('✅ 一键恢复全部完成: 成功 '+d.restored+'/'+d.total+' 项', 'success');
      } else {
        setPanelProgress('ab', 100, '恢复失败 ✗');
        addPanelLog('ab', '❌ '+d.msg, 'error');
        addLog('❌ 一键恢复失败', 'error');
      }
    }, true);
  }

  async function runRestoreBrowse(){
    var a = await getAbRestoreAuth();
    var archive_path = gv('abRestoreFile');
    if(!archive_path){ alert('请先选择备份文件'); return; }
    setPanelProgress('ab', 0, '扫描备份内容...');
    var lp = getPanelLog('ab'); if(lp){ lp.innerHTML=''; lp.classList.add('visible'); }
    addPanelLog('ab', '正在扫描备份包内容...', 'info');

    var dr = document.getElementById('abDiffResult'); if(dr) dr.style.display='none';
    var de = document.getElementById('abDetectResult'); if(de) de.style.display='none';

    send({ action:'auto_restore_browse', archive_path:archive_path }, function(d){
      if(d.status === 'ok'){
        setPanelProgress('ab', 100, '扫描完成 ✓');
        var info = document.getElementById('abBrowseInfo');
        var list = document.getElementById('abBrowseList');
        var result = document.getElementById('abBrowseResult');
        if(info && list && result){
          info.textContent = '共 ' + (d.config_items ? d.config_items.length : 0) + ' 个配置项, '
            + (d.vm_items ? d.vm_items.length : 0) + ' 个 VM, '
            + (d.lxc_items ? d.lxc_items.length : 0) + ' 个 LXC | 备份文件: ' + archive_path;
          var html = '';

          if(d.config_items && d.config_items.length > 0){
            html += '<div style="font-size:12px;font-weight:600;color:var(--text);margin:8px 0 4px">📁 系统配置</div>';
            d.config_items.forEach(function(item){
              html += '<div style="display:flex;align-items:center;gap:6px;padding:4px 8px;border-radius:4px;margin:2px 0;font-size:12px;';
              html += 'border:1px solid var(--border)">';
              html += '<span style="flex:1">';
              html += '<span style="color:var(--cyan)">'+item.name+'</span> ';
              html += '<span style="color:#888">→ '+item.server_path+' ('+item.file_count+' 文件)</span>';
              html += '</span>';
              html += '<button class="btn btn-sm" style="background:#28a745;padding:2px 8px;font-size:11px" ';
              html += 'onclick="restoreSingleItem(\''+item.name+'\',\'config\')">恢复</button>';
              html += '</div>';
            });
          }

          if(d.vm_items && d.vm_items.length > 0){
            html += '<div style="font-size:12px;font-weight:600;color:var(--text);margin:12px 0 4px">🖥 虚拟机 (QEMU)</div>';
            d.vm_items.forEach(function(item){
              html += '<div style="display:flex;align-items:center;gap:6px;padding:4px 8px;border-radius:4px;margin:2px 0;font-size:12px;';
              html += 'border:1px solid var(--border)">';
              html += '<span style="flex:1">';
              html += '<span style="color:#ffc107">VM '+item.vmid+'</span> ';
              html += '<span style="color:#888">('+item.name+')</span>';
              html += '</span>';
              html += '<button class="btn btn-sm" style="background:#28a745;padding:2px 8px;font-size:11px" ';
              html += 'onclick="restoreSingleItem(\''+item.vmid+'\',\'vm\')">恢复</button>';
              html += '</div>';
            });
          }

          if(d.lxc_items && d.lxc_items.length > 0){
            html += '<div style="font-size:12px;font-weight:600;color:var(--text);margin:12px 0 4px">📦 LXC 容器</div>';
            d.lxc_items.forEach(function(item){
              html += '<div style="display:flex;align-items:center;gap:6px;padding:4px 8px;border-radius:4px;margin:2px 0;font-size:12px;';
              html += 'border:1px solid var(--border)">';
              html += '<span style="flex:1">';
              html += '<span style="color:#6f42c1">LXC '+item.vmid+'</span> ';
              html += '<span style="color:#888">('+item.name+')</span>';
              html += '</span>';
              html += '<button class="btn btn-sm" style="background:#28a745;padding:2px 8px;font-size:11px" ';
              html += 'onclick="restoreSingleItem(\''+item.vmid+'\',\'lxc\')">恢复</button>';
              html += '</div>';
            });
          }

          if(!html) html = '<div style="color:#888;font-size:12px">备份包为空</div>';
          list.innerHTML = html;
          result.style.display = 'block';
        }
        addPanelLog('ab', '✅ 扫描完成: '+d.msg, 'success');
      } else {
        setPanelProgress('ab', 100, '扫描失败 ✗');
        addPanelLog('ab', '❌ '+d.msg, 'error');
      }
    }, true);
  }

  async function restoreSingleItem(item_name, item_type){
    var a = await getAbRestoreAuth();
    var archive_path = gv('abRestoreFile');
    if(!a.host){ alert('请先输入服务器地址'); return; }
    if(!archive_path){ alert('请先选择备份文件'); return; }
    if(!(await rpConfirm({ title:'恢复单项', okText:'恢复', body:'确定要从备份中恢复 ' + item_type + ': ' + item_name + ' 到服务器 ' + a.host + '？' }))) return;

    setPanelProgress('ab', 0, '恢复 '+item_name+'...');
    var lp = getPanelLog('ab'); if(lp){ lp.innerHTML=''; lp.classList.add('visible'); }
    addPanelLog('ab', '开始恢复 '+item_type+': '+item_name, 'info');
    send({ action:'auto_restore_item', host:a.host, port:a.port, user:a.user,
      auth_type:a.auth_type, password:a.password, key:a.key, passphrase:a.passphrase,
      archive_path:archive_path, item_type:item_type, item_name:item_name }, function(d){
      if(d.status === 'ok'){
        setPanelProgress('ab', 100, '恢复完成 ✓');
        addPanelLog('ab', '✅ '+d.msg, 'success');
        addLog('✅ 手动恢复: '+d.msg, 'success');
      } else {
        setPanelProgress('ab', 100, '恢复失败 ✗');
        addPanelLog('ab', '❌ '+d.msg, 'error');
        addLog('❌ 手动恢复失败: '+d.msg, 'error');
      }
    }, true);
  }

  // ---- v4.38.0 · 多节点批量备份 ----
  var _batchConfigs = [];

  function batchLoadConfigs(){
    var list = document.getElementById('batchConfigList');
    if(!list) return;
    list.innerHTML = '<div style="padding:8px;color:var(--text3);text-align:center">⏳ 加载中...</div>';
    window.SP.serverRows().then(function(msg){
      if(msg.status === 'ok' && msg.configs){
        _batchConfigs = msg.configs.filter(function(c){
          return c.ab_host || c.host;
        });
        if(!_batchConfigs.length){
          list.innerHTML = '<div style="padding:8px;color:var(--text3);text-align:center">无含 ab_host 的配置 · 请先在上方保存配置</div>';
          return;
        }
        var html = '';
        _batchConfigs.forEach(function(c){
          var host = c.ab_host || c.host || '';
          var name = c.name || host || '未命名';
          html += '<label style="display:flex;align-items:center;gap:6px;padding:3px 6px;cursor:pointer;border-bottom:1px solid var(--border)">';
          html += '<input type="checkbox" class="batch-cb" data-cid="'+(c.id||'')+'" data-name="'+escHtml(name)+'" data-host="'+escHtml(host)+'">';
          html += '<span style="flex:1">'+escHtml(name)+'</span>';
          html += '<span style="color:var(--text3);font-size:11px">'+escHtml(host)+'</span>';
          html += '</label>';
        });
        list.innerHTML = html;
        list.querySelectorAll('.batch-cb').forEach(function(cb){
          cb.addEventListener('change', batchUpdateCount);
        });
        batchUpdateCount();
      } else {
        list.innerHTML = '<div style="padding:8px;color:var(--red);text-align:center">加载失败</div>';
      }
    });
  }

  function batchSelectAll(state){
    document.querySelectorAll('.batch-cb').forEach(function(cb){ cb.checked = state; });
    batchUpdateCount();
  }

  function batchUpdateCount(){
    var checked = document.querySelectorAll('.batch-cb:checked');
    var el = document.getElementById('batchSelectedCount');
    if(el) el.textContent = checked.length ? '已选 '+checked.length+' 个节点' : '未选择';
  }

  async function batchBackupExecute(){
    var checked = document.querySelectorAll('.batch-cb:checked');
    if(!checked.length){ alert('请至少选择一个节点'); return; }
    var localDst = gv('batchLocalDst');
    if(!localDst){ alert('请填写本地目标文件夹'); return; }
    var configIds = [];
    checked.forEach(function(cb){ configIds.push(cb.getAttribute('data-cid')); });
    if(!(await rpConfirm({ title:'批量备份', okText:'开始备份', body:'确认对 '+configIds.length+' 个节点执行批量备份？\n\n本地路径: '+localDst }))) return;

    var wrap = document.getElementById('batchProgressBarWrap');
    var bar = document.getElementById('batchProgressBar');
    var txt = document.getElementById('batchProgressText');
    var status = document.getElementById('batchStatus');
    if(wrap) wrap.style.display = 'block';
    if(bar) bar.style.width = '0%';
    if(status) status.textContent = '批量备份进行中...';
    addLog('开始批量备份: '+configIds.length+' 个节点', 'info');

    var total = configIds.length;
    var ws = window.currentWs;

    function batchHandler(event){
      try {
        var d = JSON.parse(event.data);
        if(d.type === 'batch_start'){
          if(txt) txt.textContent = '开始: '+total+' 个节点';
        } else if(d.type === 'batch_progress'){
          var pct = Math.round(d.current / d.total * 100);
          if(bar) bar.style.width = pct + '%';
          if(txt) txt.textContent = '['+d.current+'/'+d.total+'] '+d.node+' ('+d.host+') - '+(d.status==='running'?'备份中...':'完成');
        } else if(d.type === 'batch_done'){
          if(bar) bar.style.width = '100%';
          if(txt) txt.textContent = '完成: '+d.success+' 成功, '+d.failed+' 失败';
          if(status) status.textContent = '批量备份完成 ✓';
          if(ws) ws.removeEventListener('message', batchHandler);
        } else if(d.type === 'result' && d.status === 'ok'){
          if(status) status.textContent = d.msg;
          if(ws) ws.removeEventListener('message', batchHandler);
        } else if(d.type === 'result' && d.status === 'error'){
          if(status) status.textContent = '错误: '+d.msg;
          if(ws) ws.removeEventListener('message', batchHandler);
        }
      } catch(e){}
    }
    if(ws) ws.addEventListener('message', batchHandler);

    send({action:'batch_backup', config_ids:configIds, local_dst:localDst}, function(d){
      if(ws) ws.removeEventListener('message', batchHandler);
      if(d.status === 'ok'){
        addLog('✅ 批量备份完成: '+d.msg, 'success');
      } else {
        addLog('❌ 批量备份失败: '+d.msg, 'error');
        if(status) status.textContent = '失败: '+d.msg;
      }
    }, true);
  }

  window.saveAbConfig = saveAbConfig;
  window.updateAbAuthUI = updateAbAuthUI;
  window.testAbConn = testAbConn;
  window.getAbAuth = getAbAuth;
  window.toggleAllBackupItems = toggleAllBackupItems;
  window.updateBackupItemCount = updateBackupItemCount;
  window.getBackupItemSelections = getBackupItemSelections;
  window.runAutoBackup = runAutoBackup;
  window.getAbRestoreAuth = getAbRestoreAuth;
  window.runRestoreDetect = runRestoreDetect;
  window.runRestoreCompare = runRestoreCompare;
  window.toggleAllDiffItems = toggleAllDiffItems;
  window.runRestoreSelected = runRestoreSelected;
  window.runRestoreAll = runRestoreAll;
  window.runRestoreBrowse = runRestoreBrowse;
  window.restoreSingleItem = restoreSingleItem;
  window.batchLoadConfigs = batchLoadConfigs;
  window.batchSelectAll = batchSelectAll;
  window.batchBackupExecute = batchBackupExecute;
})();
