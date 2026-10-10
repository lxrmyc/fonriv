/* ============================================================================
 * tool_checker.js · v4.38.24
 * 同步工具检测组件（rsync / sshpass / ssh / scp / qemu-img / vzdump）
 *  v4.38.24 新增:
 *   - 缺失工具一键安装（基于 sudo 探测 + 白名单 + 二次确认弹窗）
 *   - 远端 rsync 插件检测（handle_check_rsync_plugins）+ 一键安装 handle_install_rsync_plugin
 *   - C2 样式：按钮统一蓝/红/黄/绿配色 + 二次确认弹窗
 * 工厂模式: ToolChecker.create(hostEl, opts)
 *  opts: { scope:'transfer'|'disk_manager', onLog, getSrvAuth (远端插件检测用), onConfirm }
 * ========================================================================== */
(function(){
  'use strict';

  var TOOLS_META = [
    {key:'rsync',    label:'rsync (核心)', required:true},
    {key:'sshpass',  label:'sshpass',      required:false},
    {key:'ssh',      label:'ssh',          required:true},
    {key:'scp',      label:'scp',          required:false},
    {key:'qemu-img', label:'qemu-img',     required:false},
    {key:'vzdump',   label:'vzdump',       required:false},
    {key:'rclone',   label:'rclone (传输引擎 rclone 档)', required:false},
  ];
  // 工具名 → apt 包名 (白名单)
  var PKG_MAP = {
    'rsync':'rsync','sshpass':'sshpass','ssh':'openssh-client',
    'scp':'openssh-client','qemu-img':'qemu-utils','vzdump':'proxmox-backup',
  };

  function _log(scope, text, level){
    if (scope && scope.onLog) scope.onLog(text, level || 'info');
    if (typeof addLog === 'function') addLog(text, level || 'info');
  }

  // v4.38.24 · C2 二次确认弹窗（取代原生 confirm，统一样式 + 显示命令详情 + 防误触）
  function _showConfirm(opts){
    // opts: {title, body, danger, onOk(text, password), okText, cancelText, needPassword}
    if (typeof window._showC2Modal === 'function') {
      return window._showC2Modal(opts);
    }
    // 兜底：原生 confirm
    if (window.confirm((opts.title||'确认') + '\n\n' + (opts.body||''))) {
      try { opts.onOk && opts.onOk('', ''); } catch(e){}
    }
  }

  function create(hostEl, opts){
    opts = opts || {};
    var scopeId = opts.scope || 'transfer';
    var onLog = opts.onLog || function(){};
    var st = { tools:{}, missing:[], fix:'', checked:false,
               is_root:false, has_sudo:false, sudo_fix:'',
               installing:false, lastInstallOk:false,
               remotePlugins:null, remotePluginChecking:false };

    var box = document.createElement('div');
    box.className = 'tc-box';
    box.setAttribute('data-scope', scopeId);
    box.style.cssText = 'display:flex;flex-direction:column;gap:6px;padding:8px 10px;margin:6px 0;border:1px solid var(--border);border-radius:6px;background:var(--bg2);font-size:12px';

    box.innerHTML =
      '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">'+
        '<span style="color:var(--cyan);font-weight:600">🔧 同步工具:</span>'+
        '<span class="tc-status" style="color:var(--text3)">未检测</span>'+
        '<span class="tc-detail" style="flex:1;font-size:11px;color:var(--text3);font-family:monospace"></span>'+
        '<button class="btn btn-sm tc-btn-check" style="padding:1px 8px;font-size:11px;background:var(--blue);color:#fff">🔄 重新检测</button>'+
        '<button class="btn btn-sm tc-btn-install" style="padding:1px 8px;font-size:11px;display:none;background:var(--orange);color:#fff">🔧 一键安装</button>'+
        '<button class="btn btn-sm tc-btn-remote" style="padding:1px 8px;font-size:11px;display:none;background:var(--purple);color:#fff">🌐 远端插件</button>'+
      '</div>'+
      '<div class="tc-perm" style="font-size:10px;color:var(--text3);display:flex;align-items:center;gap:6px"></div>'+
      '<div class="tc-remote" style="font-size:11px;display:none;border-top:1px dashed var(--border);padding-top:6px"></div>'+
      '<div class="tc-log" style="font-size:11px;display:none;max-height:160px;overflow-y:auto;background:var(--bg);border:1px solid var(--border);border-radius:4px;padding:4px 8px;font-family:monospace;white-space:pre-wrap"></div>';

    hostEl.appendChild(box);

    var statusEl    = box.querySelector('.tc-status');
    var detailEl    = box.querySelector('.tc-detail');
    var btnCheck    = box.querySelector('.tc-btn-check');
    var btnInstall  = box.querySelector('.tc-btn-install');
    var btnRemote   = box.querySelector('.tc-btn-remote');
    var permEl      = box.querySelector('.tc-perm');
    var remoteEl    = box.querySelector('.tc-remote');
    var logEl       = box.querySelector('.tc-log');

    function _appendLog(line, level){
      if (logEl.style.display === 'none') logEl.style.display = 'block';
      var t = (new Date()).toTimeString().slice(0,8);
      var c = level === 'error' ? 'var(--red)' : (level === 'warn' ? 'var(--yellow)' : (level === 'ok' ? 'var(--green)' : 'var(--text)'));
      var d = document.createElement('div');
      d.style.cssText = 'color:'+c;
      d.textContent = '['+t+'] ' + line;
      logEl.appendChild(d);
      logEl.scrollTop = logEl.scrollHeight;
    }

    function _render(){
      if (!st.checked){
        statusEl.textContent = '未检测';
        statusEl.style.color = 'var(--text3)';
        detailEl.textContent = '';
        btnInstall.style.display = 'none';
        permEl.textContent = '';
        return;
      }
      var parts = [];
      var missing = st.missing || [];
      for (var i=0;i<TOOLS_META.length;i++){
        var m = TOOLS_META[i];
        var ok = st.tools[m.key];
        if (ok) parts.push('<span style="color:var(--green)">✓ '+m.label+'</span>');
        else parts.push('<span style="color:var(--red)">✗ '+m.label+'</span>');
      }
      statusEl.innerHTML = parts.join(' ');
      if (st.rsync_ver) statusEl.innerHTML += ' <span style="color:var(--text3);font-size:10px">('+st.rsync_ver+')</span>';

      if (missing.length){
        detailEl.innerHTML = '<span style="color:var(--yellow)">缺: '+missing.join(', ')+'</span> '+
          (st.fix ? '<span style="color:var(--text3);font-size:10px">修复: '+st.fix+'</span>' : '');
        // 一键安装按钮：有缺失 + (root 或 sudo) → 显示
        if (st.is_root || st.has_sudo){
          btnInstall.style.display = '';
          btnInstall.disabled = st.installing;
          btnInstall.textContent = st.installing ? '⏳ 安装中...' : '🔧 一键安装 ('+missing.length+')';
          btnInstall.style.background = 'var(--orange)';
        } else {
          btnInstall.style.display = 'none';
        }
        // 权限状态行
        if (st.is_root){
          permEl.innerHTML = '<span style="color:var(--green)">🔓 root 权限</span> · 可直接安装';
        } else if (st.has_sudo){
          permEl.innerHTML = '<span style="color:var(--green)">🔓 sudo 免密可用</span> · 一键安装可用';
        } else {
          permEl.innerHTML = '<span style="color:var(--red)">🔒 无 root 且无 sudo</span> · '+
            '<span style="color:var(--text3)">需配置 sudo 免密或用 root 账号</span>';
        }
      } else {
        detailEl.textContent = '全部就绪 ✓';
        detailEl.style.color = 'var(--green)';
        btnInstall.style.display = 'none';
        permEl.innerHTML = '<span style="color:var(--green)">✓ 工具就绪</span>';
      }
      // 远端插件按钮：只在本机全部就绪时显示
      btnRemote.style.display = (typeof opts.getSrvAuth === 'function' && st.missing.length === 0) ? '' : 'none';
    }

    function check(){
      btnCheck.disabled = true;
      btnCheck.textContent = '⏳ 检测中...';
      statusEl.textContent = '检测中...';
      statusEl.style.color = 'var(--text3)';
      if (typeof window.send !== 'function'){
        _log(opts, '✗ window.send 未定义', 'err');
        btnCheck.disabled = false; btnCheck.textContent = '🔄 重新检测';
        return;
      }
      window.send({ action:'check_sync_tools', params:{} }, function(d){
        btnCheck.disabled = false; btnCheck.textContent = '🔄 重新检测';
        st.checked = true;
        var r = d && (d.sync_tools_result || d);
        if (d && (d.status === 'ok' || d.status === 'success')){
          st.tools = r.tools || {};
          st.missing = r.missing || [];
          st.fix = r.fix || '';
          st.rsync_ver = r.rsync_ver || '';
          st.is_root = r.is_root || false;
          st.has_sudo = r.has_sudo || false;
          st.sudo_fix = r.sudo_fix || '';
          _render();
          if (st.missing.length){
            _log(opts, '⚠ 同步工具缺失: '+st.missing.join(', '), 'warn');
            if (st.fix) _log(opts, '  修复: '+st.fix, 'info');
          } else {
            _log(opts, '✓ 同步工具检测全部就绪', 'ok');
          }
        } else {
          _log(opts, '✗ 同步工具检测失败: '+(d && (d.msg||d.message) || '未知'), 'err');
        }
      });
    }

    // v4.38.24 · 一键安装（白名单 + 二次确认弹窗 + 流式日志）
    function _doInstall(){
      if (st.installing) return;
      if (!st.missing.length) return;
      if (!st.is_root && !st.has_sudo){
        _showConfirm({
          title: '⚠ 权限不足',
          body: '本机不是 root 也没检测到 sudo 免密，无法一键安装。\n\n'+st.sudo_fix+'\n\n点确定仅复制命令到剪贴板。',
          danger: true, okText: '复制命令', cancelText: '取消',
          onOk: function(){
            if (navigator.clipboard) navigator.clipboard.writeText(st.fix).catch(function(){});
            _appendLog('命令已复制到剪贴板: '+st.fix, 'info');
          }
        });
        return;
      }
      // 把工具名转 apt 包名
      var pkgs = st.missing.map(function(k){ return PKG_MAP[k] || k; }).filter(function(p){return p;});
      // 二次确认弹窗
      _showConfirm({
        title: '🔧 确认安装 '+pkgs.length+' 个包',
        body: '将执行:\n  '+(st.is_root ? 'apt-get install -y' : 'sudo -n apt-get install -y')+' '+pkgs.join(' ')+'\n\n本机: '+(st.is_root ? 'root' : 'sudo 免密')+'\n安装过程会实时显示日志。\n\n⚠ 安装会修改系统包状态，请确认无误。',
        danger: false, okText: '开始安装', cancelText: '取消',
        onOk: function(_, pwd){
          st.installing = true;
          btnInstall.disabled = true; btnInstall.textContent = '⏳ 安装中...';
          _appendLog('▶ 申请安装: '+pkgs.join(' '), 'info');
          window.send({
            action:'install_local_tools',
            params:{ packages: pkgs, confirm: true, password: pwd || '' }
          }, function(d){
            st.installing = false;
            // 真正的 result 在 _handleInstallMessage 异步处理（流式 log）
            if (d && d.status === 'error' && d.msg && d.msg.indexOf('确认') < 0){
              _appendLog('✗ 安装未开始: '+d.msg, 'error');
            }
          });
        }
      });
    }

    // v4.38.24 · 远端插件检测（SSH 远端服务器 rsync/sshpass 状态）
    function _checkRemotePlugins(){
      if (typeof opts.getSrvAuth !== 'function'){
        _appendLog('✗ opts.getSrvAuth 未定义，无法检测远端', 'error');
        return;
      }
      var srv = opts.getSrvAuth() || {};
      if (!srv.host){
        _showConfirm({ title:'⚠ 未配置服务器', body:'请先在「服务器连接配置」区填主机/用户/密码，再点「远端插件」。', danger:false, okText:'知道了', cancelText:'', onOk:function(){} });
        return;
      }
      st.remotePluginChecking = true;
      btnRemote.disabled = true; btnRemote.textContent = '⏳ 远端检测中...';
      _appendLog('▶ 远端插件检测: '+srv.host+':'+(srv.port||22), 'info');
      window.send({ action:'check_rsync_plugins', params:{
        host: srv.host, port: srv.port || 22, user: srv.user,
        auth_type: srv.auth_type, password: srv.password, key: srv.key, passphrase: srv.passphrase
      }}, function(d){
        st.remotePluginChecking = false;
        btnRemote.disabled = false; btnRemote.textContent = '🌐 远端插件';
        var r = d && (d.rsync_plugins_result || d);
        if (d && (d.status === 'ok' || d.status === 'success') && r && r.plugins){
          st.remotePlugins = r;
          _renderRemote();
        } else {
          _appendLog('✗ 远端插件检测失败: '+(d && (d.msg||d.message) || '未知'), 'error');
        }
      });
    }

    function _renderRemote(){
      if (!st.remotePlugins) return;
      remoteEl.style.display = 'block';
      var p = st.remotePlugins;
      var lines = ['<div style="font-size:11px;margin-bottom:4px"><b>远端: '+st.remotePlugins.os+' · '+st.remotePlugins.pkg_manager+'</b>'+(p.version?' · '+p.version:'')+'</div>'];
      (p.plugins||[]).forEach(function(plugin){
        var dot = plugin.installed ? '✓' : '✗';
        var col = plugin.installed ? 'var(--green)' : 'var(--red)';
        var btn = plugin.installed
          ? '<span style="color:var(--text3);font-size:10px">已装</span>'
          : '<button class="btn btn-sm tc-rp-install" data-pkg="'+plugin.name+'" data-cmd="'+encodeURIComponent(plugin.install_cmd)+'" style="padding:1px 6px;font-size:10px;background:var(--orange);color:#fff">一键装</button>';
        lines.push('<div style="display:flex;align-items:center;gap:6px;margin:2px 0"><span style="color:'+col+';width:14px">'+dot+'</span><span style="flex:1">'+plugin.name+'</span><span style="color:var(--text3);font-size:10px">'+plugin.description+'</span>'+btn+'</div>');
      });
      remoteEl.innerHTML = lines.join('');
      // 绑定一键装按钮
      Array.from(remoteEl.querySelectorAll('.tc-rp-install')).forEach(function(btn){
        btn.onclick = function(){
          var pkgName = btn.getAttribute('data-pkg');
          var cmd = decodeURIComponent(btn.getAttribute('data-cmd'));
          _showConfirm({
            title:'🌐 远端安装: '+pkgName,
            body:'将 SSH 到远端执行:\n  '+cmd+'\n\n请确认远端服务器可达且有权限。',
            danger:false, okText:'开始远程安装', cancelText:'取消',
            onOk: function(_, pwd){
              var srv = opts.getSrvAuth() || {};
              _appendLog('▶ 远端安装 '+pkgName+': '+cmd, 'info');
              window.send({ action:'install_rsync_plugin', params:{
                host: srv.host, port: srv.port||22, user: srv.user,
                auth_type: srv.auth_type, password: srv.password||pwd,
                key: srv.key, passphrase: srv.passphrase,
                plugin: pkgName
              }}, function(d){
                _appendLog('远端安装请求已发，结果见操作日志', 'info');
              });
            }
          });
        };
      });
    }

    // v4.38.24 · 处理流式安装日志
    function _handleInstallMessage(d){
      if (d && d.type === 'install_local_log'){
        _appendLog(d.msg||'', d.level||'info');
        return true;
      }
      // v5.91.1 · 远端插件一键装的流式日志与结果也落到这个终端面板里(以前只写全局操作日志,
      //   面板空白 → 用户只看到一句"请求已发", 以为直接成功了)
      if (d && d.type === 'rsync_install_log'){
        _appendLog(d.msg||'', d.level||'info');
        return true;
      }
      if (d && d.type === 'rsync_install_result'){
        var ok = (d.status === 'ok' || d.status === 'success');
        _appendLog((ok ? '✅ ' : '✗ ') + (d.msg||''), ok ? 'ok' : 'error');
        if (d.recheck) _appendLog('复查: ' + String(d.recheck).replace(/\n/g, ' | '), ok ? 'ok' : 'warn');
        if (ok) setTimeout(_checkRemotePlugins, 600);
        return true;
      }
      if (d && d.type === 'install_local_result'){
        st.installing = false;
        if (d.status === 'ok'){
          _appendLog('✅ 安装成功: '+(d.packages||[]).join(', '), 'ok');
          st.lastInstallOk = true;
          // 自动重新检测
          setTimeout(check, 500);
        } else {
          _appendLog('✗ 安装失败: '+(d.msg||'未知'), 'error');
        }
        btnInstall.disabled = false; btnInstall.textContent = '🔧 一键安装';
        return true;
      }
      return false;
    }

    btnCheck.onclick = check;
    btnInstall.onclick = _doInstall;
    btnRemote.onclick  = _checkRemotePlugins;

    // 注册安装消息处理器
    if (typeof window._tcHandlers === 'undefined') window._tcHandlers = [];
    window._tcHandlers.push(_handleInstallMessage);

    // v4.38.24 · 不再自动检测（用户要求：只在点「🔄 检测」时才显示过程和结果，避免页面一打开就一直停在「检测中」）
    // 初始 render 状态 = 「未检测」

    return {
      check: check,
      _handleInstallMessage: _handleInstallMessage,  // 暴露给 app.js 的 sync handler
      isReady: function(){
        if (!st.checked) return null;
        return st.tools.rsync === true;
      },
      getTools: function(){ return st.tools; },
      getMissing: function(){ return st.missing; },
      getFix: function(){ return st.fix; },
      el: box,
    };
  }

  window.ToolChecker = { create: create };
})();
