/* v4.76.0 · 容器资源管理 (卷/网络/统计/清理/exec)
 * 依赖 window.send / toast / FileOps(可选)
 */
(function(g){
  'use strict';

  function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g,function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function $id(id){ return document.getElementById(id); }
  function toast(m,k,ms){ if (typeof g.toast==='function') g.toast(m,k,ms||2800); }
  function rpc(action, data){
    return new Promise(function(resolve){
      try { g.send(Object.assign({action:action}, data||{}), function(r){ resolve(r||{}); }); }
      catch(e){ resolve({status:'error', msg:String(e)}); }
    });
  }
  function fmtB(n){
    n = Number(n)||0;
    var u=['B','KB','MB','GB','TB'], i=0;
    while (n>=1024 && i<u.length-1){ n/=1024; i++; }
    return (i? n.toFixed(1): n) + ' ' + u[i];
  }
  function base(){
    // v5.18.0 · 修复: 旧实现读 'dockerPass' (该字段不存在, 实际是 dockerAuthValue),
    //   且硬编码 auth_type='pass' 不支持密钥 → 密码恒为空 → 后端退回 publickey →
    //   用户看到 "root@<主机>: Permission denied (publickey,password)" 而全部功能失效。
    //   现直接复用「容器与镜像」区同一套参数解析 (与左侧服务器列表联动、支持密码/密钥)。
    try {
      if (g.Docker && typeof g.Docker.sshParams === 'function'){
        var sp = g.Docker.sshParams();
        if (sp && sp.host) return sp;
      }
    } catch(e){ console.warn('[DockerX] sshParams fallback', e); }
    // 兜底: 按真实字段名自行组装
    var f = function(id){ var e = $id(id); return e ? String(e.value || '').trim() : ''; };
    var at = f('dockerAuthType') || 'pass';
    var av = f('dockerAuthValue');
    return {
      host: f('dockerHost'), port: f('dockerPort') || '22', user: f('dockerUser') || 'root',
      auth_type: at,
      password: at === 'pass' ? av : '',
      key: at === 'key' ? av : '',
      passphrase: '',
    };
  }
  function body(){ return $id('dockerXBody'); }
  function setBody(html){ var b = body(); if (b) b.innerHTML = html; }

  // ── 卷列表 ──
  async function loadVolumes(){
    setBody('<div style="font-size:12px;color:var(--text3);padding:8px">⏳ 加载卷 (含大小统计, 首次较慢)…</div>');
    var r = await rpc('docker_volumes', base());
    if (r.status !== 'ok'){ setBody('<div style="color:var(--red);font-size:12px;padding:8px">✗ '+esc(r.msg||'加载失败')+'</div>'); return; }
    var vols = r.volumes || [];
    if (!vols.length){ setBody('<div style="font-size:12px;color:var(--text3);padding:8px">无卷</div>'); return; }
    setBody('<table style="width:100%;border-collapse:collapse;font-size:12px">'+
      '<tr style="color:var(--text3);font-size:11px;border-bottom:1px solid var(--border)">'+
      '<td style="padding:4px 6px">卷名</td><td style="padding:4px 6px">驱动</td>'+
      '<td style="padding:4px 6px;text-align:right">大小</td><td style="padding:4px 6px">挂载点</td>'+
      '<td style="padding:4px 6px">操作</td></tr>'+
      vols.map(function(v2){
        return '<tr style="border-bottom:1px dashed var(--border)">'+
          '<td style="padding:4px 6px;font-family:monospace;color:var(--cyan);word-break:break-all">'+esc(v2.name)+'</td>'+
          '<td style="padding:4px 6px;font-size:11px;color:var(--text3)">'+esc(v2.driver)+'</td>'+
          '<td style="padding:4px 6px;text-align:right;font-size:11px">'+fmtB(v2.size)+'</td>'+
          '<td style="padding:4px 6px;font-size:10px;color:var(--text3);word-break:break-all;max-width:220px">'+esc(v2.mountpoint||'')+'</td>'+
          '<td style="padding:4px 6px;white-space:nowrap">'+
            '<button class="btn btn-sm" onclick="DockerX.backupVolume(\''+esc(v2.name)+'\')" style="font-size:10px;padding:1px 6px;background:var(--green);color:#fff;border-color:var(--green)">💾 备份</button> '+
            '<button class="btn btn-sm" onclick="DockerX.exec(\''+esc(v2.name)+'\')" style="font-size:10px;padding:1px 6px">⚡</button>'+
          '</td></tr>';
      }).join('') + '</table>');
  }

  async function backupVolume(name){
    // v6.16.13 · 改用「容器与镜像」同一套备份流程(用户要求): 目标选择器(本机/共享/服务器)+进度+实时日志+
    //   服务器/云端自动投递+跨模块自动备份入口。旧实现是裸 prompt: 只能写本机、无进度与日志(用户报过同类问题)。
    if (window.Docker && typeof window.Docker.backupVolume === 'function'){
      return window.Docker.backupVolume(name);
    }
    if (window.toast) toast('✗ 备份组件未就绪(Docker 面板未加载), 请刷新页面后重试', 'err', 6000);
  }

  async function exec(name){
    var cmd = g.prompt('在容器/卷上下文中执行的命令 (默认 sh):', 'ls -la /');
    if (!cmd) return;
    var r = await rpc('docker_exec_cmd', Object.assign(base(), { name: name, cmd: cmd }), 120000);
    var m = document.createElement('div');
    m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:100000;display:flex;align-items:center;justify-content:center';
    m.innerHTML = '<div style="background:var(--bg2);border:1px solid var(--border);border-radius:10px;width:760px;max-width:94vw;max-height:86vh;display:flex;flex-direction:column">'+
      '<div style="padding:8px 14px;border-bottom:1px solid var(--border);display:flex;align-items:center">'+
      '<b style="font-size:13px">⚡ '+esc(name)+'</b><span style="flex:1"></span>'+
      '<button class="btn btn-sm" onclick="this.closest(\'div[id]\').remove()" style="font-size:11px">关闭</button></div>'+
      '<pre style="flex:1;overflow:auto;margin:0;padding:10px;font-size:11px;color:var(--text2);white-space:pre-wrap;word-break:break-all">'+
      esc((r.output||r.msg||'').slice(0,5000))+'</pre></div>';
    m.id = 'dockerExecModal';
    document.body.appendChild(m);
    m.addEventListener('mousedown', function(ev){ if (ev.target === m) m.remove(); });
  }

  // ── 网络 ──
  async function loadNetworks(){
    setBody('<div style="font-size:12px;color:var(--text3);padding:8px">⏳ 加载网络…</div>');
    var r = await rpc('docker_networks', base());
    if (r.status !== 'ok'){ setBody('<div style="color:var(--red);font-size:12px;padding:8px">✗ '+esc(r.msg||'加载失败')+'</div>'); return; }
    var nets = r.networks || [];
    if (!nets.length){ setBody('<div style="font-size:12px;color:var(--text3);padding:8px">无网络</div>'); return; }
    setBody('<table style="width:100%;border-collapse:collapse;font-size:12px">'+
      '<tr style="color:var(--text3);font-size:11px;border-bottom:1px solid var(--border)">'+
      '<td style="padding:4px 6px">网络名</td><td style="padding:4px 6px">驱动</td><td style="padding:4px 6px">范围</td></tr>'+
      nets.map(function(n2){
        return '<tr style="border-bottom:1px dashed var(--border)">'+
          '<td style="padding:4px 6px;font-family:monospace;color:var(--purple)">'+esc(n2.name)+'</td>'+
          '<td style="padding:4px 6px;font-size:11px">'+esc(n2.driver)+'</td>'+
          '<td style="padding:4px 6px;font-size:11px;color:var(--text3)">'+esc(n2.scope)+'</td></tr>';
      }).join('') + '</table>');
  }

  // ── 统计 ──
  async function loadStats(){
    setBody('<div style="font-size:12px;color:var(--text3);padding:8px">⏳ 采集容器资源快照 (约 2 秒)…</div>');
    var r = await rpc('docker_stats', base(), 120000);
    if (r.status !== 'ok'){ setBody('<div style="color:var(--red);font-size:12px;padding:8px">✗ '+esc(r.msg||'加载失败')+'</div>'); return; }
    var rows = r.stats || [];
    if (!rows.length){ setBody('<div style="font-size:12px;color:var(--text3);padding:8px">无运行中容器</div>'); return; }
    setBody('<table style="width:100%;border-collapse:collapse;font-size:12px">'+
      '<tr style="color:var(--text3);font-size:11px;border-bottom:1px solid var(--border)">'+
      '<td style="padding:4px 6px">容器</td><td style="padding:4px 6px;text-align:right">CPU</td>'+
      '<td style="padding:4px 6px;text-align:right">内存</td><td style="padding:4px 6px">网络 IO</td></tr>'+
      rows.map(function(s2){
        return '<tr style="border-bottom:1px dashed var(--border)">'+
          '<td style="padding:4px 6px;font-family:monospace;color:var(--text)">'+esc(s2.name)+'</td>'+
          '<td style="padding:4px 6px;text-align:right;color:'+(parseFloat(s2.cpu)>50?'var(--orange)':'var(--text2)')+'">'+esc(s2.cpu)+'</td>'+
          '<td style="padding:4px 6px;text-align:right;color:var(--text2)">'+esc(s2.mem)+'</td>'+
          '<td style="padding:4px 6px;font-size:10px;color:var(--text3)">'+esc(s2.net)+'</td></tr>';
      }).join('') + '</table>');
  }

  async function prune(kind){
    var labels = { images:'悬空镜像', volumes:'未使用卷', containers:'已停止容器', networks:'未用网络' };
    if (!g.confirm('清理'+(labels[kind]||kind)+'?\n(未使用资源将被删除, 不可恢复)')) return;
    var r = await rpc('docker_prune', Object.assign(base(), { kind: kind, force: 1 }), 300000);
    toast((r.status==='ok'?'✓ ':'✗ ') + (r.msg||'完成').slice(0,140), r.status==='ok'?'success':'err', 4200);
  }

  /* ═══ v5.31.1 · docker compose 配置文件备份 (自动扫描 + 勾选归档) ═══ */
  var _composeFiles = [];
  function _composeBody(html){ var b = $id('dkComposeBody'); if (b) b.innerHTML = html; }
  async function composeScan(){
    _composeBody('<div style="font-size:12px;color:var(--text3);padding:8px">⏳ 扫描 compose 配置 (容器标签 + 常见目录)…</div>');
    var r = await rpc('docker_compose_scan', base());
    if (r.status !== 'ok'){
      _composeBody('<div style="color:var(--red);font-size:12px;padding:8px">✗ ' + esc(r.msg || '扫描失败') + '</div>');
      return;
    }
    _composeFiles = r.files || [];
    if (!_composeFiles.length){
      _composeBody('<div style="font-size:12px;color:var(--text3);padding:8px">未找到 compose 配置文件'
        + (r.scanned_dirs ? (' (已扫描: ' + esc((r.scanned_dirs || []).join(' ')) + ')') : '') + '</div>');
      return;
    }
    var html = '<table style="width:100%;border-collapse:collapse;font-size:12px">'
      + '<tr style="color:var(--text3);font-size:11px;border-bottom:1px solid var(--border)">'
      + '<td style="padding:4px 6px;width:28px"><input type="checkbox" onchange="DockerX.composeAll(this.checked)"></td>'
      + '<td style="padding:4px 6px">配置文件</td><td style="padding:4px 6px;width:130px">compose 工程</td>'
      + '<td style="padding:4px 6px;width:80px">大小</td></tr>';
    _composeFiles.forEach(function(f, i){
      html += '<tr style="border-bottom:1px dashed var(--border)">'
        + '<td style="padding:4px 6px"><input type="checkbox" class="dkComposeChk" data-i="' + i + '"></td>'
        + '<td style="padding:4px 6px;font-family:monospace;font-size:11px">' + esc(f.path) + '</td>'
        + '<td style="padding:4px 6px;font-size:11px;color:var(--text3)">' + esc(f.project || '-') + '</td>'
        + '<td style="padding:4px 6px;font-size:11px;color:var(--text3)">' + ((f.size || 0) ? ((f.size < 1024) ? f.size + ' B' : (f.size / 1024).toFixed(1) + ' KB') : '-') + '</td>'
        + '</tr>';
    });
    _composeBody(html + '</table><div style="font-size:11px;color:var(--text3);margin-top:6px">共 '
      + _composeFiles.length + ' 个 · 勾选后点「💾 备份选定」</div>');
    toast('✓ ' + (r.msg || ('扫描到 ' + _composeFiles.length + ' 个文件')), 'success', 4000);
  }
  function composeAll(on){
    Array.prototype.forEach.call(document.querySelectorAll('.dkComposeChk'), function(c){ c.checked = !!on; });
  }
  async function composeBackup(){
    var picked = [];
    Array.prototype.forEach.call(document.querySelectorAll('.dkComposeChk'), function(c){
      if (c.checked){
        var f = _composeFiles[Number(c.getAttribute('data-i'))];
        if (f) picked.push(f.path);
      }
    });
    if (!picked.length){ toast('请先勾选要备份的 compose 文件', 'warn'); return; }
    var dest = ($id('dkComposeDest') || {}).value || '/var/backups/docker_compose';
    var withEnv = !!($id('dkComposeEnv') || {}).checked;
    toast('⏳ 正在归档 ' + picked.length + ' 个 compose 配置 …', 'info', 4000);
    var d = Object.assign(base(), { files: picked, dest_dir: dest, compress: true, with_env: withEnv });
    var r = await rpc('docker_compose_backup', d);
    if (r.status === 'ok'){
      toast('✓ ' + (r.msg || '备份完成') + (r.path ? ('\n📁 ' + r.path) : ''), 'success', 9000);
      try { if (typeof addLog === 'function') addLog('🐳 compose 备份 → ' + (r.path || dest), 'success'); } catch(_){}
    } else {
      toast('✗ ' + (r.msg || '备份失败'), 'err', 7000);
    }
  }

  g.DockerX = { loadVolumes: loadVolumes, loadNetworks: loadNetworks, loadStats: loadStats,
                 backupVolume: backupVolume, prune: prune, exec: exec,
                 composeScan: composeScan, composeBackup: composeBackup, composeAll: composeAll };
})(window);
