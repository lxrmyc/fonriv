/* v4.48.0 P4 · Docker 容器管理面板 (旗舰专属 · feat=docker)
 * 依赖 window.send / switchTab · 与 backend/handlers/docker.py 对应
 */
(function(g){
  'use strict';

  var STATE = { host:null, port:'22', user:'root', auth:null,
                containers:[], images:[], scanned:false };

  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function $(id){ return document.getElementById(id); }

  function rpc(action, data){
    return new Promise(function(resolve){
      try { window.send(Object.assign({action: action}, data || {}), function(r){ resolve(r || {}); }); }
      catch(e){ resolve({status: 'error', msg: String(e)}); }
    });
  }

  /* v5.19.0 · 长任务 RPC: send() 固定 30s 超时, 镜像/容器归档是分钟级 → 直挂 WS 自管超时 */
  function rpcLong(action, data, timeoutMs){
    return new Promise(function(resolve){
      var _ow = window.openWs || (typeof openWs === 'function' ? openWs : null);
      if (!_ow){ resolve({ status: 'error', msg: 'WebSocket 未就绪' }); return; }
      var reqId = 'dkl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
      var done = false;
      var finish = function(r){ if (done) return; done = true; resolve(r || {}); };
      var timer = setTimeout(function(){ finish({ status: 'error', msg: '任务超时 (超过 ' + Math.round((timeoutMs||0)/60000) + ' 分钟)' }); }, timeoutMs || 600000);
      _ow(function(ws){
        var h = function(e){
          var d; try { d = JSON.parse(e.data); } catch(_){ return; }
          if (!d) return;
          // 流式日志透传到面板日志区 (批量备份时用户能看到进度)
          if (d.type === 'log' || d.type === 'progress'){
            if (d.msg){ try { if (typeof addLog === 'function') addLog('🐳 ' + d.msg, d.level || 'info'); } catch(_){} }
            return;
          }
          if (d.req_id !== reqId) return;
          clearTimeout(timer);
          try { ws.removeEventListener('message', h); } catch(_){}
          finish(d);
        };
        // v5.88.0 · WS 中途断开: 长任务仍在后台执行, 别让前端干等到超时才报"失败"
        //   (实测用户报"备份失败也不知道在哪" — 实为 socket 断了收不到结果, 产物已落盘)
        var oc = function(){
          clearTimeout(timer);
          try { ws.removeEventListener('message', h); } catch(_){}
          finish({ status: 'error', code: 'ws_closed',
                   msg: '连接中断 · 任务仍在后台执行, 完成后会弹出通知 (产物目录见运行日志)' });
        };
        ws.addEventListener('close', oc, { once: true });
        ws.addEventListener('message', h);
        _rpSendWhenReady(ws, Object.assign({ action: action, req_id: reqId }, data || {}), undefined, function(){ try { console.warn('[ws] 发送失败'); } catch(_){} })
      });
    });
  }

  // 从 configs 拉服务器列表填充目标下拉 (复用已保存凭据)
  var _servers = null;
  async function loadServers(){
    if (_servers) return _servers;
    var r = await window.SP.serverRows();
    _servers = ((r && r.configs) || []).filter(function(c){ return c.host; });
    return _servers;
  }

  function selServer(){
    var sel = $('dockerSrv');
    var id = sel ? parseInt(sel.value, 10) : 0;
    return (_servers || []).find(function(s){ return s.id === id; }) || null;
  }

  // 组装 SSH 参数: v4.49.0 · 读标准连接表单 (与左侧服务器列表联动)
  function sshParams(){
    var g = function(id){ var el = document.getElementById(id); return el ? el.value : ''; };
    var at = g('dockerAuthType') || 'pass';
    return {
      host: g('dockerHost').trim(),
      port: g('dockerPort').trim() || '22',
      user: g('dockerUser').trim() || 'root',
      auth_type: at,
      password: at === 'pass' ? g('dockerAuthValue') : '',
      key: at === 'key' ? g('dockerAuthValue') : '',
      passphrase: ''
    };
  }

  // v4.49.0 · 认证方式切换 (密码/密钥)
  function updateAuthUI(){
    var at = (document.getElementById('dockerAuthType')||{}).value || 'pass';
    var fld = document.getElementById('dockerAuthField');
    var inp = document.getElementById('dockerAuthValue');
    if (!fld || !inp) return;
    var lab = fld.querySelector('label');
    if (at === 'key'){
      if (lab) lab.textContent = 'SSH 私钥路径';
      // v5.90.2 · 去掉 '~/.ssh/id_rsa' 预填 (假路径会导致连接/列目录失败)
      inp.type = 'text'; inp.placeholder = '密钥路径 — 点 🔑 从本机/df挂载点/网络共享/服务器/云端选';
    } else {
      if (lab) lab.textContent = '密码';
      inp.type = 'password'; inp.placeholder = 'SSH 密码';
    }
  }

  // v4.49.0 · 保存当前连接到服务器列表 (复用 app.js 通用保存)
  function saveConfig(){
    if (typeof window.saveCurrentConfig === 'function') window.saveCurrentConfig();
    else if (window.toast) toast('保存组件未加载','warn',2000);
  }

  function _resultBox(){ return document.getElementById('dockerConnResult'); }

  // v4.49.0 · 插件检测 (docker/daemon/compose + 发行版)
  async function check(){
    var p = sshParams();
    var box = _resultBox();
    if (!p.host){ if (window.toast) toast('请先填写主机','warn',2200); return; }
    if (box) box.textContent = '⏳ 检测中...';
    var r = await rpc('docker_check', p);
    var sec = document.getElementById('dockerCheckSection');
    var body = document.getElementById('dockerCheckBody');
    if (r.status !== 'ok'){
      if (box) box.innerHTML = '<span style="color:var(--red)">✗ ' + esc(r.msg || '检测失败') + '</span>';
      if (sec && body) { sec.style.display = ''; body.innerHTML = '<span style="color:var(--red)">✗ ' + esc(r.msg || '连接失败') + '</span>'; }
      return;
    }
    var d = r.docker || {}, c = r.compose || {};
    var ok = d.installed && !d.server_error;
    if (box) box.innerHTML = ok ? '<span style="color:var(--green)">✓ docker ' + esc(d.version) + '</span>'
                                : '<span style="color:var(--orange)">⚠ ' + esc(d.server_error || '不可用') + '</span>';
    if (sec && body){
      sec.style.display = '';
      body.innerHTML =
        '<div style="display:grid;grid-template-columns:140px 1fr;gap:4px 12px;max-width:560px">'
        + '<span style="color:var(--text3)">目标机</span><span>' + esc(r.host || '') + ' · ' + esc((r.os || '').split('|')[0]) + '</span>'
        + '<span style="color:var(--text3)">docker CLI</span><span>' + (d.installed ? '<b style="color:var(--green)">✓ 已安装</b>' : '<b style="color:var(--red)">✗ 未安装</b>') + '</span>'
        + '<span style="color:var(--text3)">daemon</span><span>' + (d.version ? '<b style="color:var(--green)">✓ 运行中 v' + esc(d.version) + '</b>' : '<b style="color:var(--orange)">⚠ ' + esc(d.server_error || '不可达') + '</b>') + '</span>'
        + '<span style="color:var(--text3)">compose v2</span><span>' + (c.v2 ? '<b style="color:var(--green)">✓ 可用</b>' : '<span style="color:var(--text3)">✗ 未安装</span>') + (c.v1_binary ? ' <span style="color:var(--text3)">(检测到旧版 docker-compose)</span>' : '') + '</span>'
        + '</div>'
        + (!d.installed ? '<div style="margin-top:8px"><button class="btn btn-sm btn-primary" onclick="Docker.install()">🔧 一键安装 Docker</button></div>' : '')
        + (d.installed && d.server_error ? '<div style="margin-top:8px;color:var(--orange);font-size:11px">CLI 已装但 daemon 未运行，可在目标机执行: systemctl enable --now docker</div>' : '');
    }
  }

  // v4.49.0 · 一键安装 docker (二次确认; root SSH)
  async function install(){
    var p = sshParams();
    if (!p.host){ if (window.toast) toast('请先填写主机','warn',2200); return; }
    if ((p.user || 'root') !== 'root'){ if (window.toast) toast('一键安装需要 root 账号 SSH','warn',3000); return; }
    var go = function(){
      var btn = document.getElementById('dockerInstallBtn');
      if (btn){ btn.disabled = true; btn.textContent = '⏳ 安装中(最长10分钟)...'; }
      if (window.toast) toast('⏳ 开始安装 docker @ ' + p.host, 'info', 3000);
      rpc('docker_install', p).then(function(r){
        if (btn){ btn.disabled = false; btn.textContent = '🔧 一键安装 Docker'; }
        var sec = document.getElementById('dockerCheckSection');
        var body = document.getElementById('dockerCheckBody');
        if (sec && body){
          sec.style.display = '';
          body.innerHTML = '<div style="color:' + (r.status === 'ok' ? 'var(--green)' : 'var(--red)') + ';font-weight:600">' + esc(r.msg || (r.status === 'ok' ? '安装成功' : '安装失败')) + '</div>'
            + (r.output_tail ? '<pre style="max-height:200px;overflow:auto;font-size:11px;background:var(--bg);padding:8px;border-radius:6px;margin-top:6px">' + esc(r.output_tail) + '</pre>' : '');
        }
        if (window.toast) toast(r.status === 'ok' ? '✓ ' + r.msg : '✗ ' + (r.msg || '失败'), r.status === 'ok' ? 'success' : 'err', 4000);
      });
    };
    if (!(await rpConfirm({
      title: '⚠️ 一键安装 Docker',
      body: '将在 ' + esc(p.host) + ' 上通过系统包管理器安装 docker 并设置开机自启。\n安装过程最长 10 分钟，期间请勿关闭页面。',
      danger: true, okText: '开始安装'
    }))) return;
    go();
  }

  // v4.55.1 · 测试 SSH 连接 (到目标机)
  function _log(msg, level){
    var log = $('dockerLog');
    if (!log) return;
    var t = new Date().toLocaleTimeString();
    var c = level === 'err' ? 'var(--red)' : level === 'ok' ? 'var(--green)' : 'var(--text2)';
    log.insertAdjacentHTML('beforeend',
      '<div style="color:'+c+'"><span style="color:var(--text3)">['+t+']</span> '+esc(msg)+'</div>');
    log.scrollTop = log.scrollHeight;
  }

  async function testConn(){
    var p = sshParams();
    if (!p.host){ if (window.toast) toast('请先选择服务器或填写主机','warn',2200); return; }
    _log('⏳ 测试 SSH 连接 ' + p.host + ' ...');
    var r = await rpc('test_conn', p);
    if (r.status === 'ok' || /CONNECTED/.test(r.msg || '')){
      _log('✓ SSH 连接正常 · ' + p.host, 'ok');
    } else {
      _log('✗ ' + ((r.msg || '连接失败') + '').slice(0, 80), 'err');
    }
  }

  async function scan(){
    var box = $('dockerBody');
    var p = sshParams();
    if (!p.host){ if (window.toast) toast('请先填写主机或点击左侧服务器列表','warn',2400); return; }
    try { window.EventBus && window.EventBus._resubscribe && window.EventBus._resubscribe(); } catch(_){}   // v5.88.0 · 登录后补订阅备份完成事件
    _log('⏳ 扫描 ' + p.host + ' ...');
    box.innerHTML = '<div style="color:var(--text3);font-size:12px;padding:10px">⏳ 扫描 ' + esc(p.host) + ' ...</div>';
    var r = await rpc('docker_scan', p);
    if (r.status !== 'ok'){
      box.innerHTML = '<div style="color:var(--red);font-size:12px;padding:10px">✗ ' + esc(r.msg || '扫描失败') + '</div>';
      return;
    }
    STATE.containers = r.containers || [];
    STATE.images = r.images || [];
    STATE.scanned = true;
    render(p.host, r.docker || {}, r.warnings || []);
  }

  function _statePill(st){
    var map = { running:['▶ 运行中','var(--green)'], exited:['⏹ 已停止','var(--text3)'],
                paused:['⏸ 暂停','var(--orange)'], created:['○ 已创建','var(--text3)'],
                restarting:['↻ 重启中','var(--orange)'], dead:['✗ dead','var(--red)'] };
    var m = map[st] || [st || '?', 'var(--text3)'];
    return '<span style="color:' + m[1] + ';font-size:11px">' + esc(m[0]) + '</span>';
  }

  function render(host, docker, warnings){
    var box = $('dockerBody');
    var html = '';
    html += '<div style="display:flex;gap:14px;align-items:center;font-size:12px;margin-bottom:10px;flex-wrap:wrap">'
      + '<span>主机: <b>' + esc(host) + '</b></span>'
      + (docker.version ? '<span style="color:var(--green)">✓ Docker Server v' + esc(docker.version) + '</span>'
                        : '<span style="color:var(--orange)">⚠ ' + esc(docker.server_error || 'daemon 不可达') + '</span>')
      + '<button class="btn btn-sm" style="margin-left:auto" onclick="Docker.scan()">🔄 重新扫描</button>'
      + '</div>';
    (warnings || []).forEach(function(w){
      html += '<div style="color:var(--orange);font-size:11px;margin-bottom:6px">⚠ ' + esc(w) + '</div>';
    });

    // 容器表
    html += '<div style="font-weight:600;font-size:13px;margin:8px 0 6px">📦 容器 (' + STATE.containers.length + ')</div>';
    if (!STATE.containers.length){
      html += '<div style="color:var(--text3);font-size:12px;padding:8px">无容器</div>';
    } else {
      html += '<table class="user-table" style="width:100%"><thead><tr>'
        + '<th>名称</th><th>镜像</th><th>状态</th><th>端口</th><th>操作</th></tr></thead><tbody>';
      STATE.containers.forEach(function(c){
        var running = c.state === 'running';
        html += '<tr>'
          + '<td><b>' + esc(c.name) + '</b><div style="font-size:10px;color:var(--text3)">' + esc(c.id) + '</div></td>'
          + '<td style="font-size:11px">' + esc(c.image) + '</td>'
          + '<td>' + _statePill(c.state) + '<div style="font-size:10px;color:var(--text3)">' + esc(c.status) + '</div></td>'
          + '<td style="font-size:10px;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + esc(c.ports) + '">' + esc(c.ports || '-') + '</td>'
          + '<td style="white-space:nowrap">'
          + (running
              ? '<button class="btn btn-sm" title="停止" onclick="Docker.act(\'' + esc(c.name) + '\',\'stop\')">⏹</button> '
                + '<button class="btn btn-sm" title="重启" onclick="Docker.act(\'' + esc(c.name) + '\',\'restart\')">↻</button> '
                + '<button class="btn btn-sm" title="暂停" onclick="Docker.act(\'' + esc(c.name) + '\',\'pause\')">⏸</button> '
              : '<button class="btn btn-sm" title="启动" onclick="Docker.act(\'' + esc(c.name) + '\',\'start\')">▶</button> ')
          + '<button class="btn btn-sm" title="日志" onclick="Docker.logs(\'' + esc(c.name) + '\')">📋</button> '
          // v5.19.0 · 容器备份 (export 文件系统快照 / commit 完整镜像)
          + '<button class="btn btn-sm" style="color:var(--green)" title="备份容器 (导出为 tar)" onclick="Docker.backupContainer(\'' + esc(c.name) + '\')">💾</button> '
          // v5.84.0 · 该链接把产物目录接入「跨模块自动备份」(企业档 flow) → 未授权/社区版不显示
          + ((typeof licenseFeatEnabled === 'function' && !licenseFeatEnabled('flow')) ? ''
              : '<button class="btn btn-sm" style="color:var(--cyan)" title="把容器备份产物目录加入跨模块自动备份 (定时上传到远端/云)" onclick="Docker.flowAdd(\'container\',\'' + esc(c.name) + '\')">🔗</button> ')
          + '<button class="btn btn-sm" style="color:var(--red)" title="删除容器(不可恢复)" onclick="Docker.rm(\'' + esc(c.name) + '\')">🗑</button>'
          + '</td></tr>';
      });
      html += '</tbody></table>';
    }

    // 镜像表
    html += '<div style="font-weight:600;font-size:13px;margin:14px 0 6px">🖼 镜像 (' + STATE.images.length + ')'
      + ' <button class="btn btn-sm" style="margin-left:6px" onclick="Docker.images()">🔄</button>'
      // v5.19.0 · 镜像才是 GB 级实体 (卷常仅几百 KB) — 提供批量归档
      + ' <button class="btn btn-sm" style="margin-left:6px;color:var(--green)" title="把全部镜像 docker save 归档到本机目录" onclick="Docker.backupAllImages()">💾 全部镜像备份</button>'
      // v5.89.0 · 导入: 备份产物的还原入口 (所有版本)
      + ' <button class="btn btn-sm" style="margin-left:6px;color:var(--cyan)" title="导入镜像归档 (docker load) 或容器文件系统导出 (docker import)" onclick="Docker.importDialog()">📥 导入</button>'
      + ' <span style="font-size:11px;color:var(--text3);margin-left:6px">镜像通常 GB 级 · 卷多为空壳 (几十 KB), 备份意义有限</span>'
      + '</div>';
    if (!STATE.images.length){
      html += '<div style="color:var(--text3);font-size:12px;padding:8px">无镜像</div>';
    } else {
      html += '<table class="user-table" style="width:100%"><thead><tr>'
        + '<th>仓库</th><th>标签</th><th>ID</th><th>大小</th><th>构建时间</th><th>操作</th></tr></thead><tbody>';
      STATE.images.slice(0, 50).forEach(function(m){
        var full = (m.repo && m.tag && m.tag !== '<none>') ? (m.repo + ':' + m.tag) : (m.id || m.repo);
        html += '<tr><td style="font-size:11px">' + esc(m.repo) + '</td>'
          + '<td style="font-size:11px">' + esc(m.tag) + '</td>'
          + '<td style="font-size:11px;font-family:monospace">' + esc(m.id) + '</td>'
          + '<td style="font-size:11px">' + esc(m.size) + '</td>'
          + '<td style="font-size:11px">' + esc(m.created) + '</td>'
          + '<td style="white-space:nowrap"><button class="btn btn-sm" style="color:var(--green)" title="备份该镜像 (docker save)" onclick="Docker.backupImage(\'' + esc(full) + '\')">💾 备份</button> '
          // v5.86.0 · 与容器行同口径: 该链接把产物目录接入「跨模块自动备份」(企业档 flow) → 未授权/社区版不显示
          + ((typeof licenseFeatEnabled === 'function' && !licenseFeatEnabled('flow')) ? ''
              : '<button class="btn btn-sm" style="color:var(--cyan)" title="把镜像备份产物目录加入跨模块自动备份" onclick="Docker.flowAdd(\'image\',\'' + esc(full) + '\')">🔗</button>') + '</td></tr>';
      });
      html += '</tbody></table>';
      if (STATE.images.length > 50) html += '<div style="color:var(--text3);font-size:11px">… 其余 ' + (STATE.images.length - 50) + ' 个略</div>';
    }
    box.innerHTML = html;
  }

  // ═══ v5.19.0 · 容器/镜像备份 ═══
  // v5.20.0 · 备份保存位置统一走 TargetPicker (与数据库备份/远端磁盘管理同口径)。
  //   旧实现用 window.prompt 问一个目录, 默认写本机 /var/backups —— 用户反馈
  //   "只能备份到本机 / 备份不成功 / 没有进度 / 日志不提示"。现在:
  //     · 本机 / df 挂载点 / 共享 → 产物直接落该路径
  //     · 服务器 / 云端        → 先归档到本机目录, 完成后自动投递过去
  function _attachDest(){
    if (typeof TargetPicker === 'undefined') return;
    // v5.87.0 · kinds 顺序与「备份配置」标签文案一致: 本机/df/共享/服务器/云端
    try { TargetPicker.attach('dkDest', { kinds: ['local','df','share','server','cloud'] }); }
    catch(e){ console.warn('[docker] TargetPicker attach', e); }
  }
  function _destUi(on){
    var w = document.getElementById('dkBarWrap'), b = document.getElementById('dkBar');
    var t = document.getElementById('dkProgressText');
    if (w) w.style.display = on ? '' : 'none';
    if (t) t.style.display = on ? '' : 'none';
    if (!on && b) b.style.width = '0%';
  }
  function _destBar(pct, text){
    var b = document.getElementById('dkBar'), t = document.getElementById('dkProgressText');
    if (b) b.style.width = Math.max(0, Math.min(100, pct)) + '%';
    if (t && text != null) t.textContent = text;
  }
  function _destLog(m, lv){
    try { if (typeof addLog === 'function') addLog('🐳 ' + m, lv || 'info'); } catch(_){}
  }
  // 读取保存位置; 返回 {dest_dir, deliver}  deliver = '' | 'server' | 'cloud'
  // v5.88.0 · inputId 参数: 行级备份弹窗里也有一套选择器, 与主卡 dkDest 同逻辑
  function _backupDest(kind, inputId){
    inputId = inputId || 'dkDest';
    var def = (kind === 'image') ? '/var/backups/docker_images'
            : (kind === 'container') ? '/var/backups/docker_containers'
            : '/var/backups/docker_volumes';
    var box = document.getElementById(inputId);
    var cur = (box && box.value || '').trim();
    if (box && !cur){ box.value = def; cur = def; }
    var out = { dest_dir: cur || def, deliver: '' };
    if (typeof TargetPicker === 'undefined') return out;
    try {
      var pv = TargetPicker.val(inputId);
      if (pv.kind === 'cloud'){
        if (!pv.remote_id){ toast('⚠ 请先在下拉里选择一个远端存储', 'warn'); return null; }
        out.deliver = 'cloud';
      } else if (pv.kind === 'server'){
        if (!pv.server){ toast('⚠ 请先在下拉里选择一台服务器', 'warn'); return null; }
        out.deliver = 'server';
      } else if (pv.path){
        out.dest_dir = pv.path;     // 本机 / df 挂载点 / 共享 → 直接落盘
      }
    } catch(eTp){ console.warn('[docker] dest picker', eTp); }
    return out;
  }
  // 归档完成后投递到所选目标
  async function _deliverArtifact(dest, what){
    if (!dest || !dest.deliver) return;
    if (!window.TargetPicker){ _destLog('⚠ 投递组件不可用, 产物保留在本机 ' + dest.dest_dir, 'warn'); return; }
    _destBar(95, '正在投递到' + (dest.deliver === 'cloud' ? '远端存储' : '服务器') + ' …');
    _destLog('📤 投递 ' + dest.dest_dir + ' → ' + (dest.deliver === 'cloud' ? '远端存储' : '服务器'));
    try {
      var pr = await TargetPicker.runPush('dkDest', dest.dest_dir, {
        onLog: function(m){ _destLog(m); }
      });
      if (pr && pr.ok){ _destBar(100, '✓ 投递完成'); _destLog('✓ ' + what + ' 已投递到所选位置', 'success'); }
      else { _destLog('✗ 投递失败 (产物仍在本机 ' + dest.dest_dir + '): ' + ((pr && pr.msg) || ''), 'error'); }
    } catch(e){
      _destLog('✗ 投递异常 (产物仍在本机): ' + (e && e.message || e), 'error');
    }
  }

  function _offerFlow(destDir, what){
    if (typeof window._showC2Modal !== 'function') return;
    window._showC2Modal({
      title: '✓ ' + what + ' 完成',
      body: '产物已保存到:\n' + destDir + '\n\n是否把**这份产物**加入「跨模块自动备份」(定时上传到远端存储/云)?',
      okText: '加入自动备份',
      onOk: function(){
        var root = document.getElementById('flowMini_root_docker');
        if (!root){ if (window.toast) toast('未找到跨模块卡片, 请刷新页面', 'warn'); return; }
        var hd = root.querySelector('.section-header');
        var bd = root.querySelector('.section-body');
        if (bd && bd.style.display === 'none' && hd && typeof toggleSection === 'function') toggleSection(hd);
        var ta = root.querySelector('textarea, input[type=text]');
        if (ta){
          var cur = ta.value || '';
          if (cur.indexOf(destDir) < 0){
            ta.value = cur ? (cur.replace(/\s*$/, '') + '\n' + destDir) : destDir;
            ta.dispatchEvent(new Event('input', { bubbles: true }));
          }
          if (window.toast) toast('✓ 已把 ' + destDir + ' 加入跨模块自动备份源', 'success', 4200);
          try { ta.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch(_){}
        }
      },
    });
  }
  // v5.20.0 · 直接加入跨模块自动备份 (无需先备份一次)
  //   把"该类产物的落盘目录"写进跨模块卡片的源路径列表, 定时任务即可上传到远端/云。
  function flowAdd(kind, name){
    var box = document.getElementById('dkDest');
    var base = (box && box.value || '').trim()
            || (kind === 'image' ? '/var/backups/docker_images' : '/var/backups/docker_containers');
    var root = document.getElementById('flowMini_root_docker');
    if (!root){
      toast('未找到「跨模块自动备份」卡片, 请刷新页面后重试', 'warn', 5000);
      return;
    }
    var hd = root.querySelector('.section-header');
    var bd = root.querySelector('.section-body');
    if (bd && bd.style.display === 'none' && hd && typeof toggleSection === 'function') toggleSection(hd);
    var ta = root.querySelector('textarea, input[type=text]');
    if (!ta){ toast('未找到源路径输入框', 'warn'); return; }
    var cur = ta.value || '';
    if (cur.indexOf(base) >= 0){
      toast('ℹ ' + base + ' 已在跨模块自动备份源里', 'info', 4000);
    } else {
      ta.value = cur ? (cur.replace(/\s*$/, '') + '\n' + base) : base;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      toast('✓ 已把 ' + base + ' 加入跨模块自动备份源 (' + name + ')', 'success', 5000);
    }
    _destLog('🔗 ' + kind + ' ' + name + ' → 自动备份源已含 ' + base);
    try { ta.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch(_){}
  }
  // 测试保存位置是否可写 / 可达
  async function testDest(){
    var dest = _backupDest('container');
    if (!dest) return;
    _destLog('🔗 测试保存位置: ' + dest.dest_dir +
             (dest.deliver ? (' (投递到' + (dest.deliver === 'cloud' ? '远端存储' : '服务器') + ')') : ' (本机/挂载点)'));
    if (!dest.deliver){
      var p = sshParams();
      p.host = p.host || ''; p.path = dest.dest_dir;
      try {
        var r = await rpcLong('target_test', p, 60000);
        _destLog((r && r.status === 'ok' ? '✓ ' : '✗ ') + ((r && r.msg) || '测试完成'),
                 (r && r.status === 'ok') ? 'success' : 'error');
        if (window.toast) toast((r && r.status === 'ok' ? '✓ ' : '✗ ') + ((r && r.msg) || ''), (r && r.status === 'ok') ? 'success' : 'err', 5200);
      } catch(e){ _destLog('✗ 测试异常: ' + (e && e.message || e), 'error'); }
      return;
    }
    if (window.TargetPicker && typeof TargetPicker.test === 'function'){
      try { await TargetPicker.test('dkDest', { onLog: function(m){ _destLog(m); } }); }
      catch(e){ _destLog('✗ 测试异常: ' + (e && e.message || e), 'error'); }
    }
  }
  function openDest(){
    var dest = _backupDest('container');
    if (!dest) return;
    if (dest.deliver){ toast('ℹ 当前目标是远端, 产物归档后会自动投递过去', 'info', 4000); }
    if (typeof openDirBrowser === 'function') openDirBrowser(document.getElementById('dkDest'));
  }

  /* v5.88.0 · 行级「💾 备份」按钮 → 备份保存路径弹窗 (用户要求: 容器/镜像列表里的备份按钮
   *   点开即选 保存路径, 与 📦 备份配置 卡片同一套 TargetPicker 组件, 默认带出卡片当前值) */
  function _backupDialog(kind, name, onGo){
    var old = document.getElementById('dkRowModal'); if (old) old.remove();
    var isCtr = (kind === 'container');
    var isVol = (kind === 'volume');   // v6.16.13 · 卷备份与容器/镜像同口径(用户要求)
    var defPath = '/var/backups/docker_' + (isCtr ? 'containers' : (isVol ? 'volumes' : 'images'));
    try {
      var main = _backupDest(kind);   // 主卡当前值作默认
      if (main && main.dest_dir) defPath = main.dest_dir;
    } catch(_){}
    var m = document.createElement('div');
    m.id = 'dkRowModal';
    m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:10001;display:flex;align-items:center;justify-content:center';
    m.innerHTML =
      '<div style="background:var(--bg2);border:1px solid var(--border);border-radius:10px;min-width:460px;max-width:92vw;padding:18px 20px;box-shadow:0 20px 60px rgba(0,0,0,0.5)">'
      + '<div style="font-size:15px;font-weight:600;margin-bottom:4px">💾 备份' + (isCtr ? '容器' : (isVol ? '卷' : '镜像')) + '</div>'
      + '<div style="font-size:12px;color:var(--cyan);margin-bottom:12px;word-break:break-all">' + esc(name) + '</div>'
      + '<div class="field" style="margin-bottom:10px">'
      +   '<label>备份保存路径 <span style="font-size:11px;color:var(--text3);font-weight:400">可选 本机 / df挂载点 / 网络共享 / 已存服务器 / 远端存储 (服务器与云端在备份完成后自动投递)</span></label>'
      +   '<div class="browse-row">'
      +     '<input class="input" id="dkRowDest" value="' + esc(defPath) + '" style="flex:1;min-width:220px;font-family:monospace">'
      +     '<button class="btn btn-sm" onclick="openDirBrowser(document.getElementById(\'dkRowDest\'))">📁</button>'
      +   '</div>'
      + '</div>'
      + (isCtr
          ? '<div class="field" style="margin-bottom:10px"><label>备份模式</label>'
            + '<select id="dkRowMode" style="width:100%">'
            + '<option value="export" selected>export · 导出容器文件系统 (体积小, docker import 恢复)</option>'
            + '<option value="commit">commit · 提交为镜像完整归档 (含镜像层, docker load 恢复)</option>'
            + '</select></div>'
          : '')
      + '<div class="field" style="margin-bottom:14px"><label>压缩</label>'
      +   '<select id="dkRowGz" style="width:100%"><option value="1" selected>gzip 压缩 (推荐, 体积小)</option><option value="0">不压缩 (速度快)</option></select></div>'
      + '<div style="display:flex;gap:8px;justify-content:flex-end">'
      +   '<button class="btn" id="dkRowCancel">取消</button>'
      +   '<button class="btn btn-primary" id="dkRowGo">🚀 开始备份</button>'
      + '</div></div>';
    document.body.appendChild(m);
    var close = function(){ m.remove(); };
    m.onclick = function(ev){ if (ev.target === m) close(); };
    m.querySelector('#dkRowCancel').onclick = close;
    if (typeof TargetPicker !== 'undefined'){
      try { TargetPicker.attach('dkRowDest', { kinds: ['local','df','share','server','cloud'] }); }
      catch(e){ console.warn('[docker] row picker attach', e); }
    }
    m.querySelector('#dkRowGo').onclick = function(){
      var dest = _backupDest(kind, 'dkRowDest');
      if (!dest){ return; }   // 选择器已 toast 具体原因
      var mode = isCtr ? (m.querySelector('#dkRowMode').value) : 'export';
      var gz = m.querySelector('#dkRowGz').value === '1';
      close();
      onGo(dest, mode, gz);
    };
  }

  async function backupContainer(name){
    _backupDialog('container', name, async function(dest, mode, gz){
      _destUi(true); _destBar(3, '准备归档容器 ' + name + ' …');
      _destLog('开始备份容器 ' + name + ' → ' + dest.dest_dir + ' (' + mode + ')');
      var p = sshParams();
      p.name = name; p.dest_dir = dest.dest_dir; p.mode = mode; p.compress = gz;
      if (window.toast) toast('⏳ 正在备份容器 ' + name + ' (' + mode + ') …', 'info', 4000);
      var r = await rpcLong('docker_container_backup', p, 3600000);
      if (r.status === 'ok'){
        _destBar(90, '✓ 本机归档完成');
        _destLog('✓ ' + (r.msg || '容器归档完成') + (r.path ? ('  →  ' + r.path) : ''), 'success');
        if (window.toast) toast('✓ ' + (r.msg || '完成') + (r.path ? ('\n📁 ' + r.path) : ''), 'success', 9000);
        await _deliverArtifact(dest, '容器 ' + name);
        _offerFlow(r.path || (r.dest_dir || dest.dest_dir), '容器 ' + name + ' 备份');
      } else {
        _destBar(0, ''); _destUi(false);
        _destLog('✗ ' + (r.msg || '备份失败'), 'error');
        if (window.toast) toast('✗ ' + (r.msg || '备份失败'), 'err', 6000);
      }
    });
  }
  async function backupImage(image){
    _backupDialog('image', image, async function(dest, _mode, gz){
      _destUi(true); _destBar(2, '准备归档镜像 ' + image + ' (GB 级可能数分钟) …');
      _destLog('开始备份镜像 ' + image + ' → ' + dest.dest_dir);
      var p = sshParams();
      p.image = image; p.dest_dir = dest.dest_dir; p.compress = gz;
      if (window.toast) toast('⏳ 正在备份镜像 ' + image + ' (GB 级可能需数分钟) …', 'info', 6000);
      var r = await rpcLong('docker_image_backup', p, 3600000);
      if (r.status === 'ok'){
        _destBar(90, '✓ 本机归档完成');
        _destLog('✓ ' + (r.msg || '镜像归档完成') + (r.path ? ('  →  ' + r.path) : ''), 'success');
        if (window.toast) toast('✓ ' + (r.msg || '完成') + (r.path ? ('\n📁 ' + r.path) : ''), 'success', 9000);
        await _deliverArtifact(dest, '镜像 ' + image);
        // v5.31.1 · FIX: 原来传的是 dest_dir (整个目录) → 跨模块自动备份会把
        //   /var/backups/docker_images 下**所有**镜像都传一遍, 与用户"只备份选中的这个镜像"
        //   的意图不符。后端已返回产物全路径 r.path, 这里改传该文件。
        _offerFlow(r.path || (r.dest_dir || dest.dest_dir), '镜像 ' + image + ' 备份');
      } else {
        _destBar(0, ''); _destUi(false);
        _destLog('✗ ' + (r.msg || '备份失败'), 'error');
        if (window.toast) toast('✗ ' + (r.msg || '备份失败'), 'err', 6000);
      }
    });
  }
  // v6.16.13 · 卷备份 (用户 2026-10-11 要求: 卷列表的备份按钮换成"容器与镜像里那种"——
  //   统一走 TargetPicker 选目标 + 进度条 + 实时日志 + 服务器/云端自动投递 + 跨模块自动备份入口)
  async function backupVolume(name){
    _backupDialog('volume', name, async function(dest, _mode, _gz){
      _destUi(true); _destBar(2, '准备打包卷 ' + name + ' …');
      _destLog('开始备份卷 ' + name + ' → ' + dest.dest_dir);
      var p = sshParams();
      p.volume = name; p.dest_dir = dest.dest_dir;
      if (window.toast) toast('⏳ 正在备份卷 ' + name + ' …', 'info', 6000);
      var r = await rpcLong('docker_volume_backup', p, 1800000);
      if (r.status === 'ok'){
        _destBar(90, '✓ 本机归档完成');
        _destLog('✓ ' + (r.msg || '卷备份完成') + (r.path ? ('  →  ' + r.path) : ''), 'success');
        if (window.toast) toast('✓ ' + (r.msg || '完成') + (r.path ? ('\n📁 ' + r.path) : ''), 'success', 9000);
        await _deliverArtifact(dest, '卷 ' + name);
        _offerFlow(r.path || dest.dest_dir, '卷 ' + name + ' 备份');
      } else {
        _destBar(0, ''); _destUi(false);
        _destLog('✗ ' + (r.msg || '备份失败'), 'error');
        if (window.toast) toast('✗ ' + (r.msg || '备份失败'), 'err', 6000);
      }
    });
  }

  async function backupAllImages(){
    var dest = _backupDest('image');
    if (!dest) return;
    _destUi(true); _destBar(2, '准备批量归档全部镜像 (可能数分钟) …');
    _destLog('开始批量备份全部镜像 → ' + dest.dest_dir);
    var p = sshParams();
    p.dest_dir = dest.dest_dir; p.compress = true;
    if (window.toast) toast('⏳ 批量备份全部镜像 (可能数分钟, 见实时日志) …', 'info', 6000);
    var r = await rpcLong('docker_images_backup_all', p, 7200000);
    if (r.status === 'ok'){
      _destBar(90, '✓ 本机归档完成');
      _destLog('✓ ' + (r.msg || '批量归档完成'), 'success');
      if (window.toast) toast('✓ ' + (r.msg || '完成'), 'success', 6000);
      await _deliverArtifact(dest, '批量镜像');
      _offerFlow(r.dest_dir || dest.dest_dir, '批量镜像备份');
    } else if (window.toast){
      toast('✗ ' + (r.msg || '失败'), 'err', 5200);
    }
  }

  // ═══ v5.89.0 · 容器/镜像导入 (所有版本) ═══
  //   备份产物的还原入口: save 归档 / commit 模式容器备份 → docker load;
  //   export 模式容器备份 → docker import <tag>。
  //   来源两类: 控制机本机文件 (跨机导入时后端流式经 SSH 管道, 不在远端落临时文件)
  //            目标主机已有路径 (产物已在被管机上, 不重复传输)
  function importDialog(){
    var old = document.getElementById('dkImpModal'); if (old) old.remove();
    var defDir = '/var/backups/docker_images';
    try { var main = _backupDest('image'); if (main && main.dest_dir) defDir = main.dest_dir; } catch(_){}
    var m = document.createElement('div');
    m.id = 'dkImpModal';
    m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:10001;display:flex;align-items:center;justify-content:center';
    m.innerHTML =
      '<div style="background:var(--bg2);border:1px solid var(--border);border-radius:10px;min-width:520px;max-width:92vw;padding:18px 20px;box-shadow:0 20px 60px rgba(0,0,0,0.5)">'
      + '<div style="font-size:15px;font-weight:600;margin-bottom:4px">📥 导入容器/镜像</div>'
      + '<div style="font-size:11px;color:var(--text3);margin-bottom:12px;line-height:1.7">'
      +   '镜像归档 (镜像备份 / commit 模式容器备份) → <b>docker load</b>；'
      +   '容器文件系统导出 (export 模式容器备份) → <b>docker import</b>。默认自动识别，识别不准可手动指定。</div>'
      + '<div class="field" style="margin-bottom:10px"><label>归档文件来源</label>'
      +   '<select id="dkImpKind" style="width:100%" onchange="Docker.importKindChange()">'
      +   '<option value="local" selected>本机文件 (控制机) — 跨机导入时自动流式经 SSH 传输</option>'
      +   '<option value="remote">目标主机上已有路径 — 不重复传输</option>'
      +   '</select></div>'
      + '<div class="field" style="margin-bottom:10px">'
      +   '<label>归档文件 <span style="font-size:11px;color:var(--text3);font-weight:400">支持 .tar / .tar.gz / .tgz</span></label>'
      +   '<div class="browse-row">'
      +     '<input class="input" id="dkImpPath" value="" placeholder="' + esc(defDir) + '/xxx.tar.gz" style="flex:1;min-width:240px;font-family:monospace">'
      +     '<button class="btn btn-sm" id="dkImpPick" onclick="Docker.importPick()">📁</button>'
      +   '</div></div>'
      + '<div class="field" style="margin-bottom:10px"><label>导入方式</label>'
      +   '<select id="dkImpMode" style="width:100%">'
      +   '<option value="auto" selected>自动识别 (推荐)</option>'
      +   '<option value="load">镜像归档 → docker load</option>'
      +   '<option value="import">容器文件系统 → docker import</option>'
      +   '</select></div>'
      + '<div class="field" style="margin-bottom:14px">'
      +   '<label>镜像标签 <span style="font-size:11px;color:var(--text3);font-weight:400">仅 docker import 需要；留空则按文件名自动推导</span></label>'
      +   '<input class="input" id="dkImpTag" placeholder="myapp:restored" style="width:100%;font-family:monospace"></div>'
      + '<div style="display:flex;gap:8px;justify-content:flex-end">'
      +   '<button class="btn" id="dkImpCancel">取消</button>'
      +   '<button class="btn btn-primary" id="dkImpGo">🚀 开始导入</button>'
      + '</div></div>';
    document.body.appendChild(m);
    var close = function(){ m.remove(); };
    m.onclick = function(ev){ if (ev.target === m) close(); };
    m.querySelector('#dkImpCancel').onclick = close;
    m.querySelector('#dkImpGo').onclick = function(){
      var kind = m.querySelector('#dkImpKind').value;
      var path = (m.querySelector('#dkImpPath').value || '').trim();
      var mode = m.querySelector('#dkImpMode').value;
      var tag = (m.querySelector('#dkImpTag').value || '').trim();
      if (!path){ if (window.toast) toast('⚠ 请填写归档文件路径', 'warn'); return; }
      close();
      doImport(kind, path, mode, tag);
    };
  }

  function importKindChange(){
    var sel = document.getElementById('dkImpKind');
    var inp = document.getElementById('dkImpPath');
    if (!sel || !inp) return;
    inp.placeholder = (sel.value === 'remote')
      ? '/var/backups/docker_images/xxx.tar.gz (目标主机上的路径)'
      : '/var/backups/docker_images/xxx.tar.gz (控制机上的路径)';
  }

  function importPick(){
    var inp = document.getElementById('dkImpPath');
    if (!inp) return;
    if (typeof window.openDirBrowser !== 'function'){ if (window.toast) toast('目录浏览器未就绪', 'warn'); return; }
    var sel = document.getElementById('dkImpKind');
    var kind = sel ? sel.value : 'local';
    var cur = (inp.value || '').trim();
    var dir = '/var/backups/docker_images';
    if (cur) dir = cur.replace(/\/[^/]*$/, '') || '/';
    if (kind === 'remote'){
      var auth = sshParams();
      if (!auth.host){ if (window.toast) toast('⚠ 请先在页面选择/填写目标服务器', 'warn'); return; }
      window.openDirBrowser(inp, dir, 'remote', auth);
    } else {
      window.openDirBrowser(inp, dir, 'local');
    }
  }

  async function doImport(kind, path, mode, tag){
    _destUi(true); _destBar(3, '准备导入 …');
    _destLog('开始导入 ' + (kind === 'remote' ? '(目标机路径) ' : '(本机文件) ') + path
             + ' · 方式 ' + mode + (tag ? (' · 标签 ' + tag) : ''));
    var p = sshParams();
    p.src_kind = kind; p.src_path = path; p.mode = mode; p.tag = tag;
    if (window.toast) toast('⏳ 正在导入 (GB 级可能数分钟, 见实时日志) …', 'info', 6000);
    var r = await rpcLong('docker_import', p, 3600000);
    if (r.status === 'ok'){
      _destBar(100, '✓ 导入完成');
      _destLog('✓ ' + (r.msg || '导入完成'), 'success');
      if (window.toast) toast('✓ ' + (r.msg || '导入完成'), 'success', 9000);
      try { await images(); } catch(_){}
    } else {
      _destBar(0, ''); _destUi(false);
      _destLog('✗ ' + (r.msg || '导入失败'), 'error');
      if (window.toast) toast('✗ ' + (r.msg || '导入失败'), 'err', 7000);
    }
  }

  async function act(name, op){
    var p = sshParams(); p.name = name; p.op = op;
    if (window.toast) toast('⏳ ' + op + ' ' + name + ' ...', 'info', 1500);
    var r = await rpc('docker_action', p);
    if (r.status === 'ok'){
      if (window.toast) toast('✓ ' + name + ' ' + op + ' · ' + (r.msg || 'ok'), 'success', 2200);
    } else {
      if (window.toast) toast('✗ ' + (r.msg || op + ' 失败'), 'err', 3000);
    }
    scan();
  }

  function rm(name){
    // 主题化确认: 删除容器不可恢复
    rpConfirm({
      title: '⚠️ 删除容器',
      body: '确定删除容器 ' + esc(name) + ' 吗？\n容器内未持久化的数据将丢失 (rm -f)',
      danger: true, okText: '删除'
    }).then(function(ok){ if (ok) act(name, 'rm'); });
  }

  async function logs(name){
    var p = sshParams(); p.name = name; p.lines = 200;
    if (typeof window._showC2Modal === 'function'){
      window._showC2Modal({
        title: '📋 日志 · ' + name,
        body: '<i style="color:var(--text3)">加载中…</i>',
        okText: '关闭', cancelText: '关闭',
        onOk: function(){}, onCancel: function(){},
      });
    }
    var r = await rpc('docker_logs', p);
    var txt = (r.status === 'ok') ? r.logs : ('✗ ' + (r.msg || '拉取失败'));
    var pre = document.getElementById('c2Modal') ? document.querySelector('#c2Modal div[style*="white-space"]') : null;
    if (pre){
      pre.innerHTML = '<pre style="max-height:60vh;overflow:auto;font-size:11px;margin:0;white-space:pre-wrap">' + esc(txt) + '</pre>';
    } else if (typeof window._showC2Modal !== 'function'){
      alert(txt.slice(0, 3000));
    }
  }

  async function images(){
    var p = sshParams();
    var r = await rpc('docker_images', p);
    if (r.status === 'ok'){
      STATE.images = r.images || [];
      render(p.host, {version:'·'}, []);
      if (window.toast) toast('✓ 镜像已刷新 (' + STATE.images.length + ')', 'success', 1800);
    } else if (window.toast) toast('✗ ' + (r.msg || '失败'), 'err', 3000);
  }

  async function init(){
    _attachDest();   // v5.20.0 · 把「备份保存位置」输入框升级为目标选择器
    _ensureEvtSub(); // v5.88.0 · 备份完成事件 → 全局通知 (WS 断线收不到结果时也能知道产物在哪)
    var sel = $('dockerSrv');
    if (sel && !sel.options.length){
      var servers = await loadServers();
      sel.innerHTML = '<option value="">-- 选择服务器 (凭据复用) --</option>'
        + servers.map(function(s){
            return '<option value="' + s.id + '">' + esc(s.name || '') + ' · ' + esc(s.host) + '</option>';
          }).join('');
    }
  }

  /* v5.88.0 · 备份完成事件订阅: 后端归档完成即 publish('docker.image.backup'/'docker.container.backup')
   *   → 即使发起请求的 WS 已断(收不到 result), 重连后的任何页面也会收到事件并 toast 产物路径 */
  var _evtSubDone = false;
  function _ensureEvtSub(){
    if (_evtSubDone || !window.EventBus || typeof window.EventBus.on !== 'function') return;
    _evtSubDone = true;
    window.EventBus.on('docker.image.backup', function(p){
      if (p && p.ok !== false && p.path){
        _destLog('✓ 镜像备份完成: ' + p.path + ' (' + Math.round((p.size||0)/1048576) + ' MB)', 'success');
        if (window.toast) window.toast('✓ 镜像备份完成\n📁 ' + p.path + ' · ' + Math.round((p.size||0)/1048576) + ' MB', 'success', 12000);
      }
    });
    window.EventBus.on('docker.container.backup', function(p){
      if (p && p.ok !== false && p.path){
        _destLog('✓ 容器备份完成: ' + p.path + ' (' + Math.round((p.size||0)/1048576) + ' MB)', 'success');
        if (window.toast) window.toast('✓ 容器备份完成\n📁 ' + p.path + ' · ' + Math.round((p.size||0)/1048576) + ' MB', 'success', 12000);
      }
    });
    // v5.89.0 · 导入完成事件: 与备份同口径 — WS 断线收不到 result 时也能知道导入结果
    window.EventBus.on('docker.image.imported', function(p){
      if (p && p.ok !== false){
        _destLog('✓ 导入完成: ' + (p.src || '') + ' → ' + (p.mode === 'import' ? ('docker import ' + (p.tag || '')) : 'docker load'), 'success');
      }
    });
    // 扫描/登录后再补一次订阅 (页面加载时未登录的订阅会被服务端拒绝)
    setTimeout(function(){ try { window.EventBus._resubscribe && window.EventBus._resubscribe(); } catch(_){} }, 8000);
  }

  g.Docker = {
    backupContainer: backupContainer, backupImage: backupImage, backupAllImages: backupAllImages,
    backupVolume: backupVolume,   // v6.16.13 · 供「容器资源管理」卷列表复用同一套备份流程
    // v5.89.0 · 容器/镜像导入 (所有版本): 备份产物的还原入口
    importDialog: importDialog, importKindChange: importKindChange, importPick: importPick,
    doImport: doImport,
    // v5.20.0 · 备份保存位置 (目标可选) + 直接加入跨模块自动备份
    flowAdd: flowAdd, testDest: testDest, openDest: openDest, attachDest: _attachDest,
    // v5.18.0 · 暴露标准连接参数解析 → 资源管理(docker_x)必须复用同一套,
    //   否则字段名/认证方式不一致会导致空口令 → Permission denied (publickey,password)
    sshParams: sshParams,
    scan: scan, act: act, rm: rm, logs: logs, images: images,
               check: check, install: install, updateAuthUI: updateAuthUI, saveConfig: saveConfig, testConn: testConn };
  document.addEventListener('DOMContentLoaded', init);
})(window);
