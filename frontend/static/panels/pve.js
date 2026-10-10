/*
 * frontend/static/panels/pve.js · v3.4.2
 *
 * app.js 拆分战役 · 第 3 块砖（PVE 节点连接 · 存储扫描 · VM 扫描）
 * ----------------------------------------------------------------------
 * 抽出 5 个 PVE 面板函数：
 *   testPveConn / scanPVEStorage / renderPVEStorageInfo / scanPVE / scanPVEvmsOnly
 *
 * 依赖（app.js 全局，users.js 已挂载时不重复）：
 *   window.currentUser / send / addLog / openWs / gv / escHtml
 *   window.getPveAuth / upgradeAuthToEC1 / recordPanelConnStatus
 *   window.selectVM   （vzdump 面板函数，此处不搬，通过 onclick 引用）
 *   window.gPVEStorageInfo · 存储扫描结果，被 vzdump 面板 startBackup 等读取
 */
(function(){
  if (typeof window === 'undefined') return;
  if (window.__pveModuleLoaded) return;
  window.__pveModuleLoaded = 'v3.5.6';

  async function testPveConn(){
    var auth = getPveAuth();
    auth = await upgradeAuthToEC1(auth);
    var dot=document.getElementById('pveConnDot'), txt=document.getElementById('pveConnText'), res=document.getElementById('pveConnResult');
    dot.className='conn-dot connecting'; txt.textContent='连接中...'; if(res) res.textContent='';

    openWs(function(ws){
      _rpSendWhenReady(ws, {
        action: 'test_conn',
        host: gv('pveHost'), port: gv('pveSshPort'), user: gv('pveUser'),
        auth_type: auth.auth_type, password: auth.password, key: auth.key, passphrase: auth.passphrase
      }, undefined, function(){ try { console.warn('[ws] 发送失败'); } catch(_){} })
      var handler = function(e){
        var d = JSON.parse(e.data);
        if(d.type === 'result'){
          ws.removeEventListener('message', handler);
          clearTimeout(timer);
          if(d.status === 'ok'){
            dot.className='conn-dot connected'; txt.textContent='已连接';
            if(res){res.textContent='✓ '+d.msg; res.style.color='var(--green)';}
            addLog(d.msg,'success');
            recordPanelConnStatus('pve', 'ok', gv('pveHost'), d.msg);
          } else {
            dot.className='conn-dot error'; txt.textContent='连接失败';
            if(res){res.textContent='✗ '+d.msg; res.style.color='var(--red)';}
            addLog(d.msg,'error');
            recordPanelConnStatus('pve', 'fail', gv('pveHost'), d.msg);
          }
        }
      };
      ws.addEventListener('message', handler);
      var timer=setTimeout(function(){
        ws.removeEventListener('message',handler);
        dot.className='conn-dot error'; txt.textContent='超时';
        if(res){res.textContent='✗ 连接超时 (15s)';res.style.color='var(--red)';}
      },15000);
    }).catch(function(err){
      dot.className='conn-dot error'; txt.textContent='WebSocket 错误';
      if(res){res.textContent='✗ '+err.message;res.style.color='var(--red)';}
      addLog(err.message,'error');
      recordPanelConnStatus('pve', 'fail', gv('pveHost'), err.message);
    });
  }

  async function scanPVEStorage(){
    var host=gv('pveHost').trim();
    if(!host){alert('请先输入 PVE 主机地址');return;}
    var auth = getPveAuth();
    auth = await upgradeAuthToEC1(auth);
    addLog('正在扫描 PVE 存储配置...','info');

    openWs(function(ws){
      _rpSendWhenReady(ws, {
        action:'scan_storage', host:host, port:gv('pvePort')||'22', user:gv('pveUser')||'root',
        auth_type:auth.auth_type, password:auth.password, key: auth.key, passphrase: auth.passphrase
      }, undefined, function(){ try { console.warn('[ws] 发送失败'); } catch(_){} })
      var handler=function(e){
        var d=JSON.parse(e.data);
        if(d.type==='storage_result'){
          ws.removeEventListener('message',handler);
          if(d.status==='ok'){
            window.gPVEStorageInfo = d;
            renderPVEStorageInfo(d);
            addLog('存储扫描完成：'+d.storages.length+' 个存储，'+d.backup_dirs.length+' 个备份目录，'+d.vm_disks_dirs.length+' 个磁盘目录','success');
          } else {
            addLog('PVE 存储扫描失败: '+(d.msg||'未知错误'),'error');
          }
        }
      };
      ws.addEventListener('message',handler);
    }).catch(function(err){
      addLog('PVE 存储扫描失败: '+err.message,'error');
    });
  }

  function renderPVEStorageInfo(d){
    var panel = document.getElementById('pveStorageInfo');
    var body = document.getElementById('pveStorageInfoBody');
    if(!panel||!body) return;
    panel.style.display='block';

    var html = '';
    if(d.pve_version){
      html += '<div style="margin-bottom:10px;padding:6px 10px;background:var(--green-bg);border-radius:4px;border:1px solid var(--green);color:var(--green)">✓ '+escHtml(d.pve_version)+'</div>';
    }

    if(d.storages && d.storages.length > 0){
      html += '<div style="font-weight:600;color:var(--text);margin:8px 0 4px">📦 存储列表</div>';
      html += '<table style="width:100%;border-collapse:collapse;font-size:11px">';
      html += '<tr style="border-bottom:1px solid var(--border)"><th style="padding:3px 6px;text-align:left;color:var(--text3)">名称</th><th style="padding:3px 6px;text-align:left;color:var(--text3)">类型</th><th style="padding:3px 6px;text-align:left;color:var(--text3)">状态</th><th style="padding:3px 6px;text-align:left;color:var(--text3)">内容</th><th style="padding:3px 6px;text-align:left;color:var(--text3)">路径</th><th style="padding:3px 6px;text-align:right;color:var(--text3)">可用</th></tr>';
      d.storages.forEach(function(s){
        var sc = s.status==='active'?'var(--green)':'var(--red)';
        html += '<tr style="border-bottom:1px solid var(--border)"><td style="padding:3px 6px;color:var(--cyan)">'+escHtml(s.name||'')+'</td><td style="padding:3px 6px">'+escHtml(s.type||'')+'</td><td style="padding:3px 6px;color:'+sc+'">'+escHtml(s.status||'')+'</td><td style="padding:3px 6px">'+escHtml(s.content||'')+'</td><td style="padding:3px 6px;color:var(--purple)">'+escHtml(s.path||'-')+'</td><td style="padding:3px 6px;text-align:right">'+escHtml(s.avail||'?')+'</td></tr>';
      });
      html += '</table>';
    }

    if(d.disk_info && d.disk_info.length > 0){
      html += '<div style="font-weight:600;color:var(--text);margin:10px 0 4px">💿 磁盘使用</div>';
      html += '<table style="width:100%;border-collapse:collapse;font-size:11px">';
      html += '<tr style="border-bottom:1px solid var(--border)"><th style="padding:3px 6px;text-align:left;color:var(--text3)">文件系统</th><th style="padding:3px 6px;text-align:right;color:var(--text3)">大小</th><th style="padding:3px 6px;text-align:right;color:var(--text3)">已用</th><th style="padding:3px 6px;text-align:right;color:var(--text3)">可用</th><th style="padding:3px 6px;text-align:right;color:var(--text3)">使用率</th><th style="padding:3px 6px;text-align:left;color:var(--text3)">挂载点</th></tr>';
      d.disk_info.forEach(function(di){
        var pct = parseInt(di.use_pct)||0;
        var pc = pct>90?'var(--red)':pct>70?'var(--orange)':'var(--green)';
        html += '<tr style="border-bottom:1px solid var(--border)"><td style="padding:3px 6px">'+escHtml(di.filesystem)+'</td><td style="padding:3px 6px;text-align:right">'+escHtml(di.size)+'</td><td style="padding:3px 6px;text-align:right">'+escHtml(di.used)+'</td><td style="padding:3px 6px;text-align:right">'+escHtml(di.avail)+'</td><td style="padding:3px 6px;text-align:right;color:'+pc+'">'+escHtml(di.use_pct)+'</td><td style="padding:3px 6px;color:var(--purple)">'+escHtml(di.mounted)+'</td></tr>';
      });
      html += '</table>';
    }

    if(d.backup_dirs && d.backup_dirs.length > 0){
      html += '<div style="font-weight:600;color:var(--text);margin:10px 0 4px">📂 备份目录</div>';
      d.backup_dirs.forEach(function(dir){ html += '<div style="padding:2px 6px"><code style="color:var(--cyan)">'+escHtml(dir)+'</code></div>'; });
    }
    if(d.vm_disks_dirs && d.vm_disks_dirs.length > 0){
      html += '<div style="font-weight:600;color:var(--text);margin:10px 0 4px">💽 VM 磁盘目录</div>';
      d.vm_disks_dirs.forEach(function(dir){ html += '<div style="padding:2px 6px"><code style="color:var(--purple)">'+escHtml(dir)+'</code></div>'; });
    }

    body.innerHTML = html || '<div style="color:var(--text3)">未检测到存储信息</div>';
  }

  async function scanPVE(){
    var host=gv('pveHost').trim();
    if(!host){alert('请先输入 PVE 主机地址');return;}
    var ip=host.split(':')[0], port=host.split(':')[1]||gv('pveSshPort')||'22';
    var listArea=document.getElementById('vmListArea');
    listArea.innerHTML='<div style="padding:20px;text-align:center;color:var(--text3)">正在扫描存储和虚拟机...</div>';

    var auth = getPveAuth();
    auth = await upgradeAuthToEC1(auth);
    openWs(function(ws){
      _rpSendWhenReady(ws, {
        action:'scan_storage', host:ip, port:port, user:gv('pveUser')||'root',
        auth_type:auth.auth_type, password:auth.password, key: auth.key, passphrase: auth.passphrase
      }, undefined, function(){ try { console.warn('[ws] 发送失败'); } catch(_){} })
      var storageHandler=function(e){
        var sd=JSON.parse(e.data);
        if(sd.type==='storage_result'){
          ws.removeEventListener('message',storageHandler);
          if(sd.status==='ok'){
            window.gPVEStorageInfo = sd;
            renderPVEStorageInfo(sd);
            addLog('存储扫描完成：'+sd.storages.length+' 个存储，'+sd.vm_disks_dirs.length+' 个磁盘目录','success');
          }
          scanPVEvmsOnly(ws);
        }
      };
      ws.addEventListener('message',storageHandler);
    }).catch(function(err){
      addLog('存储扫描失败，继续扫描VM: '+err.message,'info');
      openWs(function(ws){ scanPVEvmsOnly(ws); }).catch(function(err2){
        addLog('扫描完全失败: '+err2.message,'error');
        if(listArea) listArea.innerHTML='<div style="color:var(--red)">连接失败: '+err2.message+'</div>';
      });
    });
  }

  async function scanPVEvmsOnly(ws){
    var host=gv('pveHost').trim(), ip=host.split(':')[0], port=host.split(':')[1]||gv('pveSshPort')||'22';
    var listArea=document.getElementById('vmListArea');
    var auth = getPveAuth();
    auth = await upgradeAuthToEC1(auth);

    if(!ws){
      openWs(function(newWs){ scanPVEvmsOnly(newWs); }).catch(function(err){
        addLog('扫描失败: '+err.message,'error');
      });
      return;
    }

    _rpSendWhenReady(ws, {
      action: 'scan_pve', host: ip, port: port, user: gv('pveUser')||'root',
      auth_type: auth.auth_type, password: auth.password, key: auth.key, passphrase: auth.passphrase
    }, undefined, function(){ try { console.warn('[ws] 发送失败'); } catch(_){} })
    var handler=function(e){
      var d=JSON.parse(e.data);
      if(d.type==='scan_result'){
        ws.removeEventListener('message',handler);
        if(d.status==='ok'){
          listArea.innerHTML='';
          if(d.vms.length===0){ listArea.innerHTML='<div style="color:var(--orange)">未找到虚拟机实例</div>'; }
          else {
            d.vms.forEach(function(vm){
              var isRunning = vm.status==='running';
              var badgeClass = isRunning?'vm-running':'vm-stopped';
              var badgeText = isRunning?'运行中':'已停止';
              var avatar = vm.type==='CT'?'📦':'🖥';
              var mem = vm.memory?vm.memory+'MB':'?';
              var disk = vm.disk?vm.disk+'GB':'?';

              var card = document.createElement('div');
              card.className='vm-card';
              card.onclick=function(){ if(typeof selectVM==='function') selectVM(this,vm.vmid); };
              card.innerHTML='<div class="vm-avatar">'+avatar+'</div>'+
                '<div class="vm-info"><div class="vm-name">'+vm.type+' '+vm.vmid+' - '+vm.name+'</div>'+
                '<div class="vm-meta">'+mem+' RAM · '+disk+' 磁盘</div></div>'+
                '<span class="vm-badge '+badgeClass+'">'+badgeText+'</span>';
              // v5.20.0 · VM/CT 控制台 (noVNC): VM 没装系统/没网络也能看启动界面。
              //   只传 vmid —— 所在节点由后端用 /cluster/resources 反查 (集群下更可靠)。
              var cbtn = document.createElement('button');
              cbtn.className = 'btn btn-sm';
              cbtn.style.cssText = 'padding:2px 8px;font-size:11px;margin-left:6px';
              cbtn.textContent = '🖥 控制台';
              cbtn.title = '在浏览器中打开该 VM/CT 的画面 (无需装客户端)';
              cbtn.onclick = function(ev){
                ev.stopPropagation();
                openConsole(vm);
              };
              card.appendChild(cbtn);
              listArea.appendChild(card);
            });
          }
          addLog('发现 '+d.vms.length+' 个 VM/CT 实例','success');
        } else {
          listArea.innerHTML='<div style="color:var(--red)">扫描失败: '+d.msg+'</div>';
        }
      }
    };
    ws.addEventListener('message',handler);
  }

  // v5.20.0 · 打开 VM/CT 控制台 (noVNC 独立窗口)
  function openConsole(vm){
    var kind = (vm.type === 'CT' || vm.type === 'lxc') ? 'lxc' : 'qemu';
    // 先探可用性: 缺 noVNC 静态资源或 PVE 未配置时给出可读提示, 而不是开一个白窗口
    send({ action: 'pve_console_ready' }, function(r){
      if (!r || r.status !== 'ok'){
        addLog('控制台不可用: ' + ((r && r.msg) || '查询失败'), 'warn');
        return;
      }
      if (!r.novnc_installed){
        addLog('控制台缺少 noVNC 资源: ' + (r.hint || '运行 scripts/fetch_novnc.sh'), 'warn');
        return;
      }
      if (!r.pve_configured){
        addLog('控制台需要先配置 PVE 连接 (设置页 → PVE)', 'warn');
        return;
      }
      var tok = '';
      try { tok = localStorage.getItem('auth_token') || ''; } catch(e){}
      send({ action: 'pve_console_url', vmid: vm.vmid, kind: kind, auth_token: tok },
        function(u){
          if (!u || u.status !== 'ok'){
            addLog('生成控制台地址失败: ' + ((u && u.msg) || '未知错误'), 'error');
            return;
          }
          var w = window.open(u.url, '_blank');
          if (!w) addLog('浏览器拦截了弹出窗口, 请允许弹窗后重试', 'warn');
          else addLog('已打开控制台: ' + (vm.type||'') + ' ' + vm.vmid, 'success');
        });
    });
  }

  window.testPveConn = testPveConn;
  window.scanPVEStorage = scanPVEStorage;
  window.renderPVEStorageInfo = renderPVEStorageInfo;
  window.scanPVE = scanPVE;
  window.scanPVEvmsOnly = scanPVEvmsOnly;
})();
