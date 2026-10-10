/*
 * frontend/static/panels/vzdump.js · v3.4.3
 *
 * app.js 拆分战役 · 第 4 块砖（vzdump 打包 + 恢复 + 存储扫描）
 * ----------------------------------------------------------------------
 * 抽出 12 个 vzdump 面板函数：
 *   testVdConn / selectVM / scanDisks / updateDiskCount / startBackup
 *   scanLocalBackups / startPveRestore / startVzdumpRestore
 *   scanStorage / renderStorageInfo / scanVdVMs / scanVdVMsOnly / selectVdVM
 *
 * 全局共享变量（保留在 app.js var 声明，通过 window.xxx 双向读写）：
 *   selectedVmId · scanBaseDir · selectedVdVmId · gStorageInfo · gPVEStorageInfo
 *
 * 依赖（app.js 全局）：
 *   send / addLog / openWs / gv / escHtml / addLogLine / addJob / recordSpeed
 *   getPveAuth / getVdAuth / upgradeAuthToEC1 / recordPanelConnStatus
 *   buildVzdumpCmd （app.js 保留 · selectVdVM 里调）
 *   dlOpenPath （downloads.js · 备份文件跳到下载中心）
 */
(function(){
  if (typeof window === 'undefined') return;
  if (window.__vzdumpModuleLoaded) return;
  window.__vzdumpModuleLoaded = 'v3.5.5';

  async function testVdConn(){
    var auth = getVdAuth();
    auth = await upgradeAuthToEC1(auth);
    var dot=document.getElementById('vdConnDot'), txt=document.getElementById('vdConnText'), res=document.getElementById('vdConnResult');
    dot.className='conn-dot connecting'; txt.textContent='连接中...'; if(res) res.textContent='';

    openWs(function(ws){
      _rpSendWhenReady(ws, {
        action: 'test_conn',
        host: gv('vdHost'), port: gv('vdPort'), user: gv('vdUser'),
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
            recordPanelConnStatus('vd', 'ok', gv('vdHost'), d.msg);
          } else {
            dot.className='conn-dot error'; txt.textContent='失败';
            if(res){res.textContent='✗ '+d.msg; res.style.color='var(--red)';}
            addLog(d.msg,'error');
            recordPanelConnStatus('vd', 'fail', gv('vdHost'), d.msg);
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
      recordPanelConnStatus('vd', 'fail', gv('vdHost'), err.message);
    });
  }

  function selectVM(el,id){
    document.querySelectorAll('#vmListArea .vm-card').forEach(function(c){c.classList.remove('selected')});
    el.classList.add('selected');
    window.selectedVmId = id;
    document.getElementById('diskSectionTitle').textContent='磁盘文件（VM '+id+'）';
    scanDisks(id);
  }

  async function scanDisks(vmid){
    var host=gv('pveHost').trim(), ip=host.split(':')[0], port=host.split(':')[1]||gv('pveSshPort')||'22';
    var diskList=document.getElementById('diskList');
    diskList.innerHTML='<div style="padding:10px;color:var(--text3)">扫描磁盘文件和备份...</div>';

    var auth = getPveAuth();
    auth = await upgradeAuthToEC1(auth);
    var pve_dir = '/var/lib/vz/images/';
    var gInfo = window.gPVEStorageInfo;
    if(gInfo && gInfo.vm_disks_dirs && gInfo.vm_disks_dirs.length > 0){
      pve_dir = gInfo.vm_disks_dirs[0];
    }

    var disk_hints = (gInfo && gInfo.vm_disks_dirs) ? gInfo.vm_disks_dirs.slice() : [];
    var dump_hints = (gInfo && gInfo.dump_dirs) ? gInfo.dump_dirs.slice() : [];
    dump_hints.forEach(function(d){
      if(disk_hints.indexOf(d) === -1) disk_hints.push(d);
    });
    if(disk_hints.indexOf('/var/lib/vz/images/') === -1) disk_hints.push('/var/lib/vz/images/');
    if(disk_hints.indexOf('/var/lib/vz/dump/') === -1) disk_hints.push('/var/lib/vz/dump/');

    openWs(function(ws){
      _rpSendWhenReady(ws, {
        action: 'scan_disks', host: ip, port: port, user: gv('pveUser')||'root', vmid: vmid,
        auth_type: auth.auth_type, password: auth.password, key: auth.key, passphrase: auth.passphrase,
        pve_dir: pve_dir,
        dir_hints: disk_hints,
        type: (window.selectedVmType || 'VM')
      }, undefined, function(){ try { console.warn('[ws] 发送失败'); } catch(_){} })
      var handler=function(e){
        var d=JSON.parse(e.data);
        if(d.type==='disk_result'){
          ws.removeEventListener('message',handler);
          if(d.status==='ok'){
            window.scanBaseDir = d.scan_dir || '/var/lib/vz/images/' + vmid;
            diskList.innerHTML='';
            if(d.disks.length===0){ diskList.innerHTML='<div style="padding:10px;color:var(--orange)">'+(d.msg||'未找到对应的物理磁盘文件 (可能是LVM/ZFS块存储)')+'</div>'; }
            else {
              d.disks.forEach(function(disk){
                var item=document.createElement('div'); item.className='disk-item';
                item.setAttribute('data-raw-name', disk.raw_name || '');
                item.setAttribute('data-path', disk.path || '');
                item.innerHTML='<input type="checkbox" class="disk-check" checked onchange="updateDiskCount()">'+
                  '<div class="disk-name">'+(disk.name||'')+'</div>'+
                  '<div class="disk-meta" style="font-size:10px;color:var(--text3);white-space:nowrap;text-align:right;min-width:130px"><div>'+ (disk.size||'')+'</div><div style="color:var(--text3)">'+(disk.date||'')+'</div></div>';
                diskList.appendChild(item);
              });
            }
            // v4.15.22 · qm/pct config 磁盘条目（LVM/ZFS/Ceph 块存储也能看到）
            if (d.config_disks && d.config_disks.length){
              var box = document.createElement('div');
              box.style.cssText = 'margin-top:8px;padding:8px;border:1px dashed var(--border);border-radius:6px;background:var(--bg2)';
              var rows = d.config_disks.map(function(cd){
                var badge = cd.path
                  ? '<span class="badge" style="background:var(--green);color:#fff;font-size:10px">文件</span>'
                  : '<span class="badge" style="background:var(--orange);color:#fff;font-size:10px">块存储</span>';
                return '<div style="font-family:monospace;font-size:11px;padding:3px 0;border-bottom:1px dotted var(--border)">'
                     +   '<b>'+cd.key+'</b> · '+badge+' · '
                     +   '<span style="color:var(--text2)">'+cd.storage_ref+'</span>'
                     +   (cd.size ? ' · <span style="color:var(--text3)">'+cd.size+'</span>' : '')
                     + '</div>';
              }).join('');
              box.innerHTML = '<div style="font-weight:600;margin-bottom:6px;font-size:12px">📋 qm/pct config 磁盘条目（'+d.config_disks.length+' 项）</div>'+rows;
              diskList.appendChild(box);
            }
            updateDiskCount();
          }
        }
      };
      ws.addEventListener('message',handler);
    }).catch(function(err){
      addLog('扫描磁盘失败: '+err.message,'error');
    });
  }

  function updateDiskCount(){
    var n=document.querySelectorAll('#diskList .disk-check:checked').length;
    var chip=document.getElementById('diskCountChip');
    if(chip) chip.textContent='已选 '+n+' 个';
  }

  async function startBackup(){
    var checked=document.querySelectorAll('#diskList .disk-check:checked');
    if(checked.length===0){addLog('请选择要备份的磁盘文件','error');return;}
    // v5.15.0 · 保存位置选择器: 本机/df挂载点/网络共享 → 直接落盘; 服务器/云端 → 保留本机路径并指引
    var localDir=(window.TargetPicker ? window.TargetPicker.pickLocal('backupDst','/mnt/backup/proxmox/') : gv('backupDst'));
    if(!localDir){addLog('请输入本地保存路径','error');return;}

    var host=gv('pveHost').trim(), ip=host.split(':')[0], port=host.split(':')[1]||gv('pveSshPort')||'22';
    var disks=[];
    var baseDir = window.scanBaseDir || '/var/lib/vz/images/';
    checked.forEach(function(cb){
      var item = cb.closest('.disk-item');
      var rawPath = item.getAttribute('data-path') || '';
      var rawName = item.getAttribute('data-raw-name') || '';
      var finalPath = rawPath;
      if(!finalPath.startsWith('/')){
        finalPath = baseDir + (baseDir.endsWith('/') ? '' : '/') + rawName;
      }
      disks.push({path: finalPath});
    });

    document.getElementById('backupProgress').style.display='block';
    document.getElementById('backupProgress').scrollIntoView({behavior:'smooth'});
    var bar=document.getElementById('backupBar'), logEl=document.getElementById('backupLog');
    bar.className='progress-bar'; bar.style.width='0%'; logEl.innerHTML='';
    var vmId = window.selectedVmId;
    addLogLine(logEl, '开始备份 VM '+vmId+' 磁盘...', 'info');

    var auth = getPveAuth();
    auth = await upgradeAuthToEC1(auth);
    openWs(function(ws){
      _rpSendWhenReady(ws, {
        action: 'pve_backup', host: ip, port: port, user: gv('pveUser')||'root',
        auth_type: auth.auth_type, password: auth.password, key: auth.key, passphrase: auth.passphrase,
        disks: disks, local_dir: localDir
      }, undefined, function(){ try { console.warn('[ws] 发送失败'); } catch(_){} })
      var handler=function(e){
        var d=JSON.parse(e.data);
        if(d.type==='log') addLogLine(logEl, d.msg, d.level||'dim');
        else if(d.type==='progress'){
          bar.style.width=Math.min(d.pct,100).toFixed(1)+'%';
          document.getElementById('backupStatus').textContent=d.file||('传输中 '+d.pct.toFixed(0)+'%');
          if(d.speed){ document.getElementById('bkStatSpd').textContent=d.speed; /* v5.37.0: recordSpeed 由总线统一喂 */ }
        } else if(d.type==='finish'){
          ws.removeEventListener('message',handler);
          if(d.status==='success'){
            bar.style.width='100%'; bar.className='progress-bar success';
            document.getElementById('backupStatus').textContent='备份完成 ✓';
            addLogLine(logEl, d.msg, 'success');
            if(typeof addJob==='function') addJob('PVE 备份 VM '+vmId, localDir, '完成');
            // v5.16.0 · 保存位置为服务器/云端 → 备份完成后自动推送/上传
            if(window.TargetPicker){
              window.TargetPicker.runPush('backupDst', localDir, {
                onLog: function(m){ addLogLine(logEl, m, 'info'); }
              }).then(function(pr){
                if(pr && !pr.skipped){
                  if(pr.ok) addLogLine(logEl, '📤 已投递到所选保存位置', 'success');
                  else addLogLine(logEl, '⚠ 投递失败 (产物仍在本机 '+localDir+'): '+(pr.msg||''), 'error');
                }
              });
            }
          } else {
            document.getElementById('backupStatus').textContent='备份失败';
            addLogLine(logEl, d.msg, 'error');
            if(typeof addJob==='function') addJob('PVE 备份 VM '+vmId, localDir, '失败');
          }
        }
      };
      ws.addEventListener('message',handler);
    }).catch(function(err){
      addLog('备份连接失败: '+err.message,'error');
    });
  }

  function scanLocalBackups(){
    // v5.15.0 · 恢复目录源增强: 支持 df 挂载点 / 网络共享作为产物来源
    var localDir = (window.TargetPicker ? window.TargetPicker.pickLocal('restoreDir', gv('restoreDir').trim()) : gv('restoreDir').trim());
    if(!localDir){ addLog('请输入备份目录','error'); return; }
    var listEl = document.getElementById('restoreFileList');
    listEl.innerHTML='<div style="padding:10px;color:var(--text3)">正在扫描本地文件...</div>';

    openWs(function(ws){
      _rpSendWhenReady(ws, { action: 'scan_local', local_dir: localDir }, undefined, function(){ try { console.warn('[ws] 发送失败'); } catch(_){} })
      var handler=function(e){
        var d=JSON.parse(e.data);
        ws.removeEventListener('message',handler);
        if(d.type==='local_result'){
          var headerHtml='<div class="file-list-header"><div></div><div>文件名</div><div>大小</div><div>备份时间</div><div>状态</div></div>';
          if(d.status==='ok'){
            listEl.innerHTML = headerHtml;
            if(d.files.length===0){ listEl.innerHTML += '<div style="padding:10px;color:var(--text3)">未找到备份文件</div>'; }
            else {
              d.files.forEach(function(f){
                var row=document.createElement('div'); row.className='file-item';
                row.setAttribute('data-raw-name', f.raw_name || f.name);
                var fullPath = localDir.replace(/\/+$/,'') + '/' + (f.raw_name||f.name);
                row.onclick=function(ev){ if(ev.target.tagName!=='INPUT' && ev.target.tagName!=='BUTTON') this.querySelector('input').click(); };
                row.innerHTML='<input type="checkbox" class="file-checkbox restore-check">'+
                  '<div class="file-name">'+f.name+'</div>'+
                  '<div class="file-size">'+(f.size||'')+'</div>'+
                  '<div class="file-date">'+(f.date||'')+'</div>'+
                  '<div class="file-status"><span class="status-dot st-ok">正常</span> '+
                    '<button class="btn" style="font-size:10px;padding:1px 6px;margin-left:4px" onclick="event.stopPropagation();dlOpenPath(\''+fullPath.replace(/'/g,"\\'")+'\')" title="到下载中心">💾</button>'+
                  '</div>';
                listEl.appendChild(row);
              });
              addLog('扫描到 '+d.files.length+' 个备份文件','success');
            }
          } else {
            listEl.innerHTML = headerHtml + '<div style="padding:10px;color:var(--red)">'+d.msg+'</div>';
          }
        }
      };
      ws.addEventListener('message',handler);
    }).catch(function(err){
      addLog('扫描连接失败: '+err.message,'error');
    });
  }

  async function startPveRestore(){
    var checked = document.querySelectorAll('#restoreFileList .restore-check:checked');
    if(checked.length===0){ addLog('请选择要恢复的文件','error'); return; }
    // v5.15.0 · 恢复目录源增强: 支持 df 挂载点 / 网络共享作为产物来源
    var localDir = (window.TargetPicker ? window.TargetPicker.pickLocal('restoreDir', gv('restoreDir').trim()) : gv('restoreDir').trim());
    var vmId = gv('restoreVmId').trim();
    if(!localDir){ addLog('请输入备份目录','error'); return; }

    var host=gv('pveHost').trim(), ip=host.split(':')[0], port=host.split(':')[1]||gv('pveSshPort')||'22';
    var files=[];
    checked.forEach(function(cb){
      var row = cb.closest('.file-item');
      var rawName = row.getAttribute('data-raw-name');
      if(rawName){
        files.push({ path: localDir+'/'+rawName });
      }
    });

    var logEl = document.getElementById('restoreLog');
    var logArea = document.getElementById('restoreProgress');
    logArea.style.display='block';
    logArea.scrollIntoView({behavior:'smooth'});
    logEl.innerHTML='';
    var bar=document.getElementById('restoreBar');
    bar.className='progress-bar'; bar.style.width='0%';
    document.getElementById('restoreStatus').textContent='恢复中...';
    addLogLine(logEl, '开始恢复到 VM '+vmId+'...', 'info');

    var auth = getPveAuth();
    auth = await upgradeAuthToEC1(auth);
    openWs(function(ws){
      _rpSendWhenReady(ws, {
        action: 'pve_restore', host: ip, port: port, user: gv('pveUser')||'root',
        auth_type: auth.auth_type, password: auth.password, key: auth.key, passphrase: auth.passphrase,
        files: files, pve_dir: '/var/lib/vz/images/'+vmId+'/', vmid: vmId
      }, undefined, function(){ try { console.warn('[ws] 发送失败'); } catch(_){} })
      var handler=function(e){
        var d=JSON.parse(e.data);
        if(d.type==='log') addLogLine(logEl, d.msg, d.level||'dim');
        else if(d.type==='progress'){
          bar.style.width=Math.min(d.pct,100).toFixed(1)+'%';
          document.getElementById('restoreStatus').textContent=d.file||('传输中 '+d.pct.toFixed(0)+'%');
        } else if(d.type==='finish'){
          ws.removeEventListener('message',handler);
          var sVmId = window.selectedVmId;
          if(d.status==='success'){
            bar.style.width='100%'; bar.className='progress-bar success';
            document.getElementById('restoreStatus').textContent='恢复完成 ✓';
            addLogLine(logEl, d.msg, 'success');
            if(typeof addJob==='function') addJob('PVE 恢复 VM '+sVmId, '—', '完成');
          } else {
            bar.style.width='100%'; bar.className='progress-bar error';
            document.getElementById('restoreStatus').textContent='恢复失败';
            addLogLine(logEl, d.msg, 'error');
            if(typeof addJob==='function') addJob('PVE 恢复 VM '+sVmId, '—', '失败');
          }
        }
      };
      ws.addEventListener('message',handler);
    }).catch(function(err){
      addLog('恢复连接失败: '+err.message,'error');
    });
  }

  async function startVzdumpRestore(){
    var fileInput = document.getElementById('vdRestoreFile');
    var filePath = fileInput.value.trim();
    if(!filePath){ alert('请先选择本地归档文件路径'); return; }
    var vmId = gv('vdRestoreVmId').trim();
    var storage = gv('vdRestoreStorage');
    var host=gv('vdHost').trim();
    if(!host){ alert('请先配置PVE主机地址'); return; }
    var port=gv('vdPort')||'22', user=gv('vdUser')||'root';

    var logArea = document.getElementById('vdRestoreProgress');
    var logEl = document.getElementById('vdRestoreLog');
    var bar = document.getElementById('vdRestoreBar');
    logArea.style.display = 'block';
    logArea.scrollIntoView({behavior:'smooth'});
    logEl.innerHTML = '';
    bar.className = 'progress-bar';
    bar.style.width = '0%';
    addLogLine(logEl, '开始上传归档 ' + filePath + ' -> VM ' + (vmId||'自动分配'), 'info');

    var auth = getVdAuth();
    auth = await upgradeAuthToEC1(auth);
    openWs(function(ws){
      _rpSendWhenReady(ws, {
        action: 'pve_restore', host: host, port: port, user: user,
        auth_type: auth.auth_type, password: auth.password, key: auth.key, passphrase: auth.passphrase,
        files: [{ path: filePath }], pve_dir: '/var/lib/vz/dump/', vmid: vmId
      }, undefined, function(){ try { console.warn('[ws] 发送失败'); } catch(_){} })
      var handler=function(e){
        var d=JSON.parse(e.data);
        if(d.type==='log') addLogLine(logEl, d.msg, d.level||'dim');
        else if(d.type==='progress'){
          bar.style.width=Math.min(d.pct,100).toFixed(1)+'%';
        } else if(d.type==='finish'){
          ws.removeEventListener('message',handler);
          if(d.status==='success'){
            bar.style.width='100%'; bar.className='progress-bar success';
            addLogLine(logEl, d.msg, 'success');
            if(vmId){
              addLogLine(logEl, '上传完成！如需调用 qmrestore，请在 PVE Shell 中执行:', 'info');
              addLogLine(logEl, '  qmrestore /var/lib/vz/dump/' + filePath.split('/').pop() + ' ' + vmId + ' --storage ' + storage, 'cmd');
            }
          } else {
            bar.className='progress-bar error';
            addLogLine(logEl, d.msg, 'error');
          }
        }
      };
      ws.addEventListener('message',handler);
    }).catch(function(err){
      alert('连接失败: '+err.message);
    });
  }

  async function scanStorage(){
    var host=gv('vdHost').trim();
    if(!host){alert('请先输入 PVE 主机地址');return;}
    var auth = getVdAuth();
    auth = await upgradeAuthToEC1(auth);
    addLog('正在扫描服务器存储配置...','info');

    openWs(function(ws){
      _rpSendWhenReady(ws, {
        action:'scan_storage', host:host, port:gv('vdPort')||'22', user:gv('vdUser')||'root',
        auth_type:auth.auth_type, password:auth.password, key: auth.key, passphrase: auth.passphrase
      }, undefined, function(){ try { console.warn('[ws] 发送失败'); } catch(_){} })
      var handler=function(e){
        var d=JSON.parse(e.data);
        if(d.type==='storage_result'){
          ws.removeEventListener('message',handler);
          if(d.status==='ok'){
            window.gStorageInfo = d;
            renderStorageInfo(d);
            addLog('存储扫描完成：'+d.storages.length+' 个存储，'+d.backup_dirs.length+' 个备份目录，'+d.vm_disks_dirs.length+' 个磁盘目录','success');
          } else {
            addLog('存储扫描失败: '+(d.msg||'未知错误'),'error');
          }
        }
      };
      ws.addEventListener('message',handler);
    }).catch(function(err){
      addLog('存储扫描失败: '+err.message,'error');
    });
  }

  function renderStorageInfo(d){
    var panel = document.getElementById('vdStorageInfo');
    var body = document.getElementById('vdStorageInfoBody');
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
        var statusColor = s.status==='active'?'var(--green)':'var(--red)';
        html += '<tr style="border-bottom:1px solid var(--border)"><td style="padding:3px 6px;color:var(--cyan)">'+escHtml(s.name||'')+'</td><td style="padding:3px 6px">'+escHtml(s.type||'')+'</td><td style="padding:3px 6px;color:'+statusColor+'">'+escHtml(s.status||'')+'</td><td style="padding:3px 6px">'+escHtml(s.content||'')+'</td><td style="padding:3px 6px;color:var(--purple)">'+escHtml(s.path||'-')+'</td><td style="padding:3px 6px;text-align:right">'+escHtml(s.avail||'?')+'</td></tr>';
      });
      html += '</table>';
    }
    if(d.disk_info && d.disk_info.length > 0){
      html += '<div style="font-weight:600;color:var(--text);margin:10px 0 4px">💿 磁盘使用</div>';
      html += '<table style="width:100%;border-collapse:collapse;font-size:11px">';
      html += '<tr style="border-bottom:1px solid var(--border)"><th style="padding:3px 6px;text-align:left;color:var(--text3)">文件系统</th><th style="padding:3px 6px;text-align:right;color:var(--text3)">大小</th><th style="padding:3px 6px;text-align:right;color:var(--text3)">已用</th><th style="padding:3px 6px;text-align:right;color:var(--text3)">可用</th><th style="padding:3px 6px;text-align:right;color:var(--text3)">使用率</th><th style="padding:3px 6px;text-align:left;color:var(--text3)">挂载点</th></tr>';
      d.disk_info.forEach(function(di){
        var pct = parseInt(di.use_pct)||0;
        var pctColor = pct>90?'var(--red)':pct>70?'var(--orange)':'var(--green)';
        html += '<tr style="border-bottom:1px solid var(--border)"><td style="padding:3px 6px">'+escHtml(di.filesystem)+'</td><td style="padding:3px 6px;text-align:right">'+escHtml(di.size)+'</td><td style="padding:3px 6px;text-align:right">'+escHtml(di.used)+'</td><td style="padding:3px 6px;text-align:right">'+escHtml(di.avail)+'</td><td style="padding:3px 6px;text-align:right;color:'+pctColor+'">'+escHtml(di.use_pct)+'</td><td style="padding:3px 6px;color:var(--purple)">'+escHtml(di.mounted)+'</td></tr>';
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

  async function scanVdVMs(){
    var host=gv('vdHost').trim();
    if(!host){addLog('请输入PVE主机地址','error');return;}
    var listArea=document.getElementById('vdVmList');
    listArea.innerHTML='<div style="padding:20px;text-align:center;color:var(--text3)">正在扫描存储和虚拟机...</div>';

    var auth = getVdAuth();
    auth = await upgradeAuthToEC1(auth);
    openWs(function(ws){
      _rpSendWhenReady(ws, {
        action:'scan_storage', host:host, port:gv('vdPort')||'22', user:gv('vdUser')||'root',
        auth_type:auth.auth_type, password:auth.password, key: auth.key, passphrase: auth.passphrase
      }, undefined, function(){ try { console.warn('[ws] 发送失败'); } catch(_){} })
      var storageHandler=function(e){
        var sd=JSON.parse(e.data);
        if(sd.type==='storage_result'){
          ws.removeEventListener('message',storageHandler);
          if(sd.status==='ok'){
            window.gStorageInfo = sd;
            renderStorageInfo(sd);
            addLog('存储扫描完成：'+sd.storages.length+' 个存储，'+sd.dump_dirs.length+' 个备份目录','success');
          }
          scanVdVMsOnly(ws);
        }
      };
      ws.addEventListener('message',storageHandler);
    }).catch(function(err){
      addLog('存储扫描失败，继续扫描VM: '+err.message,'info');
      openWs(function(ws){ scanVdVMsOnly(ws); }).catch(function(err2){
        addLog('扫描完全失败: '+err2.message,'error');
        if(listArea) listArea.innerHTML='<div style="color:var(--red)">连接失败: '+err2.message+'</div>';
      });
    });
  }

  async function scanVdVMsOnly(ws){
    var host=gv('vdHost').trim();
    var listArea=document.getElementById('vdVmList');

    if(!ws){
      openWs(function(newWs){ scanVdVMsOnly(newWs); }).catch(function(err){
        addLog('扫描失败: '+err.message,'error');
      });
      return;
    }

    var auth = getVdAuth();
    auth = await upgradeAuthToEC1(auth);
    _rpSendWhenReady(ws, {
      action: 'scan_pve', host: host, port: gv('vdPort')||'22', user: gv('vdUser')||'root',
      auth_type: auth.auth_type, password: auth.password, key: auth.key, passphrase: auth.passphrase
    }, undefined, function(){ try { console.warn('[ws] 发送失败'); } catch(_){} })
    var handler=function(e){
      var d=JSON.parse(e.data);
      if(d.type==='scan_result'){
        ws.removeEventListener('message',handler);
        if(d.status==='ok'){
          listArea.innerHTML='';
          if(d.vms.length===0){ listArea.innerHTML='<div style="color:var(--orange)">未找到虚拟机</div>'; }
          else {
            d.vms.forEach(function(vm){
              var isRunning=vm.status==='running';
              var badgeClass=isRunning?'vm-running':'vm-stopped';
              var badgeText=isRunning?'运行中':'已停止';
              var avatar=vm.type==='CT'?'📦':'🖥';
              var meta=vm.memory?vm.memory+'MB RAM · '+vm.disk+'GB':'?';

              var card=document.createElement('div'); card.className='vm-card';
              card.onclick=function(){selectVdVM(this,vm.vmid);};
              card.innerHTML='<div class="vm-avatar">'+avatar+'</div>'+
                '<div class="vm-info"><div class="vm-name">'+vm.type+' '+vm.vmid+' · '+vm.name+'</div>'+
                '<div class="vm-meta">'+meta+'</div></div>'+
                '<span class="vm-badge '+badgeClass+'">'+badgeText+'</span>';
              listArea.appendChild(card);
            });
          }
          addLog('发现 '+d.vms.length+' 个虚拟机','success');
        } else {
          listArea.innerHTML='<div style="color:var(--red)">扫描失败: '+d.msg+'</div>';
        }
      }
    };
    ws.addEventListener('message',handler);
  }

  function selectVdVM(el,vmid){
    document.querySelectorAll('#vdVmList .vm-card').forEach(function(c){c.classList.remove('selected')});
    el.classList.add('selected');
    window.selectedVdVmId = vmid;
    if(typeof buildVzdumpCmd==='function') buildVzdumpCmd();
  }

  // v4.15.10: 把选中的磁盘文件路径 push 到 PVE 面板的 flow_mini(proxmox_g) 源目录
  function sendSelectedToFlow(){
    var checked = document.querySelectorAll('#diskList .disk-check:checked');
    if (!checked.length){
      if (window.toast) toast('请先勾选磁盘文件','warn',2000);
      else alert('请先勾选磁盘文件');
      return;
    }
    var baseDir = window.scanBaseDir || '/var/lib/vz/images/';
    var paths = [];
    checked.forEach(function(cb){
      var item = cb.closest('.disk-item');
      var rawPath = item.getAttribute('data-path') || '';
      var rawName = item.getAttribute('data-raw-name') || '';
      var p = rawPath;
      if (!p.startsWith('/')){
        p = baseDir + (baseDir.endsWith('/') ? '' : '/') + rawName;
      }
      if (p) paths.push(p);
    });
    if (!paths.length){
      if (window.toast) toast('未能解析出磁盘路径','warn',2000);
      return;
    }

    // 展开 mini widget · 切源类型为 rsync（PVE 服务器目录）
    var scope = 'proxmox_g';
    var root = document.getElementById('flowMini_root_'+scope);
    if (!root){
      if (window.toast) toast('未找到 PVE 自动备份卡片，请刷新页面','err',2400);
      return;
    }
    // 展开卡片
    var body = root.querySelector('.section-body');
    if (body && body.style.display === 'none'){
      var hd = root.querySelector('.section-header');
      if (hd && typeof toggleSection === 'function') toggleSection(hd);
      else if (body) body.style.display = '';
    }
    var srcSel = document.getElementById('flowMini_srcType_'+scope);
    if (srcSel){
      srcSel.value = 'rsync';
      if (window.FlowMini && FlowMini.onSrcTypeChange) FlowMini.onSrcTypeChange(scope);
    }
    var ta = document.getElementById('flowMini_paths_'+scope);
    if (ta){
      var cur = (ta.value || '').split(/\r?\n/).map(function(s){return s.trim();}).filter(Boolean);
      paths.forEach(function(p){ if (cur.indexOf(p) < 0) cur.push(p); });
      ta.value = cur.join('\n');
      ta.scrollIntoView({behavior:'smooth', block:'center'});
      ta.style.boxShadow = '0 0 0 2px var(--accent,#3498db)';
      setTimeout(function(){ ta.style.boxShadow = ''; }, 1600);
    }
    if (window.toast) toast('已加入 '+paths.length+' 个磁盘到跨模块自动备份 · 下拉页面继续选『目标远端』','success',3000);
  }

  window.Vzdump = window.Vzdump || {};
  window.Vzdump.sendSelectedToFlow = sendSelectedToFlow;

  window.testVdConn = testVdConn;
  window.selectVM = selectVM;
  window.scanDisks = scanDisks;
  window.updateDiskCount = updateDiskCount;
  window.startBackup = startBackup;
  window.scanLocalBackups = scanLocalBackups;
  window.startPveRestore = startPveRestore;
  window.startVzdumpRestore = startVzdumpRestore;
  window.scanStorage = scanStorage;
  window.renderStorageInfo = renderStorageInfo;
  window.scanVdVMs = scanVdVMs;
  window.scanVdVMsOnly = scanVdVMsOnly;
  window.selectVdVM = selectVdVM;
})();
