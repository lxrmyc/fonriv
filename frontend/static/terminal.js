/*
 * Fonriv · Web 终端 (xterm.js + WebSocket PTY)
 *
 * v4.38.7 新增：
 * - 终端高度自适应（calc(100vh - 380px)，min 320px）
 * - 最大化/还原按钮：折叠侧栏 + 隐藏连接配置区，终端铺满 content
 * - 分离到独立窗口：打开 /terminal.html 纯终端页面
 * - 窗口 resize 时自动 fit xterm
 */

// xterm 配色随界面主题: 浅色(light)用亮色终端, 其余保持深色
function RPXtermTheme(){
  // v6.16.12 · 终端背景色一键切换(用户要求: 白底/黑底, 独立于界面主题, localStorage 记忆)
  try{
    var _bg = localStorage.getItem('term_bg');
    if (_bg === 'light'){
      return { background:'#ffffff', foreground:'#0f172a', cursor:'#2563eb', cursorAccent:'#ffffff',
               selectionBackground:'rgba(37,99,235,.22)' };
    }
    if (_bg === 'dark'){
      return { background:'#0f1117', foreground:'#e8edf5', cursor:'#38bdf8' };
    }
  }catch(e){}
  try{
    var _t = document.documentElement.getAttribute('data-theme');
    if (_t === 'light'){
      return { background:'#ffffff', foreground:'#0f172a', cursor:'#2563eb', cursorAccent:'#ffffff',
               selectionBackground:'rgba(37,99,235,.22)' };
    }
  }catch(e){}
  return { background:'#0f1117', foreground:'#e8edf5', cursor:'#38bdf8' };
}

(function(){
  'use strict';

  // v4.38.5: 在覆盖 window.Terminal 前，先保存 xterm.js 的 Terminal 构造器
  var XTermCtor = (typeof window.Terminal === 'function') ? window.Terminal : null;
  window._XtermTerminal = XTermCtor;

  var term = null;
  var termTaskId = null;
  var wsHandlerInstalled = false;
  var maximized = false;
  var savedSidebarState = null;
  var attaching = false;  // v4.38.9: attach 进行中标志

  // v4.38.9: task_id 持久化到 localStorage（刷新页面后能恢复会话）
  function saveTaskId(id){
    try { localStorage.setItem('term_task_id', id); } catch(e){}
  }
  function clearTaskId(){
    try { localStorage.removeItem('term_task_id'); } catch(e){}
    termTaskId = null;
  }
  function getSavedTaskId(){
    try { return localStorage.getItem('term_task_id') || ''; } catch(e){ return ''; }
  }

  // v4.38.2: 获取终端面板自己的连接配置
  function getTermConn(){
    var t = document.getElementById('termAuthType');
    var type = t ? t.value : 'pass';
    var val = document.getElementById('termAuthValue');
    var pp = document.getElementById('termAuthPassphrase');
    var rawVal = val ? val.value : '';
    var rawPp = pp ? pp.value : '';
    var encVal = (typeof window.encodePassword === 'function') ? window.encodePassword(rawVal) : rawVal;
    var encPp = (typeof window.encodePassword === 'function') ? window.encodePassword(rawPp) : rawPp;
    return {
      host: (document.getElementById('termSrvHost') || {}).value || '',
      port: (document.getElementById('termSrvPort') || {}).value || '22',
      user: (document.getElementById('termSrvUser') || {}).value || 'root',
      auth_type: type,
      password: type === 'pass' ? encVal : '',
      key: type === 'key' ? encVal : '',
      passphrase: type === 'key' ? encPp : '',
    };
  }

  // v4.38.2: 更新认证 UI
  window.updateTermAuthUI = function(){
    var typeSel = document.getElementById('termAuthType');
    var f = document.getElementById('termAuthField');
    if(!typeSel || !f) return;
    var t = typeSel.value || 'pass';
    var authRow = f.closest('.auth-row');
    if(t === 'pass'){
      if(authRow) authRow.classList.remove('key-mode');
      f.innerHTML = '<label><span class="required-star">*</span>登录密码</label><input type="password" id="termAuthValue" placeholder="请输入服务器密码" autocomplete="new-password">';
    } else {
      if(authRow) authRow.classList.add('key-mode');
      f.innerHTML = '<label><span class="required-star">*</span>SSH 私钥路径</label><div class="browse-row"><input type="text" id="termAuthValue" placeholder="~/.ssh/id_rsa" value="~/.ssh/id_rsa" autocomplete="off"><button class="btn btn-sm" onclick="openDirBrowser(document.getElementById(\'termAuthValue\'), \'/root/.ssh/\')">📁</button></div>';
      var oldPP = authRow ? authRow.querySelector('.passphrase-field') : null;
      if(oldPP) oldPP.remove();
      if(authRow){
        var ppField = document.createElement('div');
        ppField.className = 'field passphrase-field';
        ppField.innerHTML = '<label>私钥密码短语</label><input type="password" id="termAuthPassphrase" placeholder="留空则无密码短语" autocomplete="new-password">';
        authRow.appendChild(ppField);
      }
    }
  };

  // v4.38.5: 独立的 WebSocket 消息处理器
  function installWsHandler(){
    if(wsHandlerInstalled) return;
    var ws = window.currentWs;
    if(!ws) return;
    wsHandlerInstalled = true;
    ws.addEventListener('message', function(event){
      try {
        var d = JSON.parse(event.data);
        if(d.type === 'term_started'){
          termTaskId = d.task_id;
          saveTaskId(termTaskId);  // v4.38.9: 持久化 task_id
          attaching = false;
          var st = document.getElementById('termStatus');
          if(st){
            st.textContent = '已连接: ' + (d.host || '');
            st.style.color = 'var(--green)';
          }
          if(term) term.focus();
        } else if(d.type === 'term_out'){
          if(term && d.data) term.write(d.data);
        } else if(d.type === 'term_closed'){
          if(term) term.write('\r\n\x1b[31m--- 终端已关闭 ---\x1b[0m\r\n');
          var st2 = document.getElementById('termStatus');
          if(st2){
            st2.textContent = '已断开';
            st2.style.color = 'var(--text3)';
          }
          clearTaskId();  // v4.38.9: 会话已关闭，清除持久化
        } else if(d.type === 'term_result' && d.status === 'error'){
          // v4.38.9: attach 失败时清除持久化的 task_id
          if(attaching){
            attaching = false;
            clearTaskId();
          }
          var st3 = document.getElementById('termStatus');
          if(st3){
            st3.textContent = '错误: ' + (d.msg || '');
            st3.style.color = 'var(--red)';
          }
        }
      } catch(e){}
    });
  }

  // v4.38.7: 终端尺寸自适应
  function fitTerm(){
    if(!term) return;
    var el = document.getElementById('terminal');
    if(!el) return;
    // 计算 cols/rows 基于容器尺寸
    var cellWidth = 7.2;   // monospace 13px 约 7.2px 宽
    var cellHeight = 17;   // 约 17px 高
    var cols = Math.max(20, Math.floor(el.clientWidth / cellWidth));
    var rows = Math.max(5, Math.floor(el.clientHeight / cellHeight));
    if(term.cols !== cols || term.rows !== rows){
      term.resize(cols, rows);
      if(termTaskId){
        window.send({action:'terminal_resize', task_id: termTaskId, rows: rows, cols: cols});
      }
    }
  }

  // v4.38.7: 最大化/还原
  function applyMaximize(state){
    var panel = document.getElementById('panel-terminal');
    var connSection = panel ? panel.querySelector('.section') : null;  // 连接配置 section
    var sessionSection = document.getElementById('termSessionSection');
    var termEl = document.getElementById('terminal');
    var sb = document.getElementById('sidebar');
    var sbToggle = document.getElementById('sidebarToggleBtn');
    if(state){
      // 保存侧栏当前状态
      if(sb) savedSidebarState = sb.classList.contains('collapsed');
      // 折叠侧栏
      if(sb && !sb.classList.contains('collapsed') && typeof window.toggleSidebar === 'function'){
        window.toggleSidebar();
      }
      // 隐藏连接配置区
      if(connSection) connSection.style.display = 'none';
      // 终端铺满
      if(termEl) termEl.style.height = 'calc(100vh - 120px)';
      if(panel) panel.style.padding = '0';
      if(sessionSection){
        sessionSection.style.margin = '0';
        var body = sessionSection.querySelector('.section-body');
        if(body) body.style.padding = '0';
      }
      maximized = true;
    } else {
      // 还原侧栏
      if(sb && savedSidebarState === false && sb.classList.contains('collapsed') && typeof window.toggleSidebar === 'function'){
        window.toggleSidebar();
      }
      // 显示连接配置区
      if(connSection) connSection.style.display = '';
      // 还原终端高度
      if(termEl) termEl.style.height = 'calc(100vh - 380px)';
      if(panel) panel.style.padding = '';
      if(sessionSection){
        sessionSection.style.margin = '';
        var body2 = sessionSection.querySelector('.section-body');
        if(body2) body2.style.padding = '';
      }
      maximized = false;
    }
    setTimeout(fitTerm, 50);
  }

  // v4.38.7: 监听窗口 resize
  window.addEventListener('resize', function(){
    if(term) setTimeout(fitTerm, 100);
  });

  // v4.38.2: 测试连接
  window.testTermConnection = function(){
    var conn = getTermConn();
    var result = document.getElementById('termConnResult');
    if(!conn.host){
      if(result) result.innerHTML = '<span style="color:var(--red)">请填写主机地址</span>';
      return;
    }
    if(result) result.textContent = '测试中...';
    // v6.16.11 · FIX: 此前借用 enterprise 档的 disk_scan 做连通性探测 → 社区版报
    //   「该功能未授权 (license 不含: disk)」(用户 .120 实测)。改用 test_conn
    //   (rsync 域, 社区档; 参数形状一致: host/port/user/auth_type/password/key/passphrase)。
    window.send({
      action: 'test_conn',
      host: conn.host,
      port: conn.port || 22,
      user: conn.user || 'root',
      auth_type: conn.auth_type,
      password: conn.password || '',
      key: conn.key || '',
      passphrase: conn.passphrase || '',
    }, function(msg){
      if(!msg){
        if(result) result.innerHTML = '<span style="color:var(--red)">无响应</span>';
        return;
      }
      if(msg.status === 'ok'){
        if(result) result.innerHTML = '<span style="color:var(--green)">✓ 连接成功</span>';
        window._lastDiskConn = Object.assign({}, conn, {connected: true, connectedAt: Date.now()});
        var dot = document.getElementById('termConnDot');
        var txt = document.getElementById('termConnText');
        if(dot) dot.style.background = 'var(--green)';
        if(txt) txt.textContent = '已连接';
        setTimeout(function(){ window.Terminal.open(); }, 500);
      } else {
        if(result) result.innerHTML = '<span style="color:var(--red)">✗ ' + (msg.msg || '连接失败') + '</span>';
        var dot2 = document.getElementById('termConnDot');
        var txt2 = document.getElementById('termConnText');
        if(dot2) dot2.style.background = 'var(--red)';
        if(txt2) txt2.textContent = '连接失败';
      }
    });
  };

  // v6.16.12 · 终端背景色切换: 白底/黑底 一键切(记忆在 localStorage.term_bg)
  function _termBgPref(){ try { return localStorage.getItem('term_bg') || ''; } catch(e){ return ''; } }
  function _applyTermBg(){
    var bg = _termBgPref();
    var btn = document.getElementById('termBgBtn');
    var eff = bg || ((document.documentElement.getAttribute('data-theme') === 'light') ? 'light' : 'dark');
    if (btn) btn.textContent = (eff === 'light') ? '🌙 背景' : '☀️ 背景';
    var wrap = document.getElementById('terminal');
    if (wrap) wrap.style.background = (eff === 'light') ? '#ffffff' : '#0f1117';
    try{
      if (term){
        if (term.options && 'theme' in term.options) term.options.theme = RPXtermTheme();
        else if (typeof term.setOption === 'function') term.setOption('theme', RPXtermTheme());
      }
    }catch(e){}
  }
  window.termToggleBg = function(){
    var cur = _termBgPref() || ((document.documentElement.getAttribute('data-theme') === 'light') ? 'light' : 'dark');
    var next = (cur === 'light') ? 'dark' : 'light';
    try { localStorage.setItem('term_bg', next); } catch(e){}
    _applyTermBg();
    try { if (window.toast) toast('✓ 终端背景: ' + (next === 'light' ? '白底' : '黑底'), 'ok'); } catch(e){}
  };
  window.termApplyBg = _applyTermBg;
  // 面板显示/页面就绪时同步按钮图标与容器底色
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function(){ setTimeout(_applyTermBg, 400); });
  else setTimeout(_applyTermBg, 400);

  window.Terminal = {
    open: function(){
      var conn = getTermConn();
      if (!conn || !conn.host){
        alert('请先在上方填写服务器连接配置');
        return;
      }

      var el = document.getElementById('terminal');
      if (!el) return;

      if (!term){
        if(!XTermCtor){
          alert('xterm.js 未加载，请检查 /static/vendor/xterm.min.js');
          return;
        }
        term = new XTermCtor({
          cursorBlink: true,
          fontSize: 13,
          fontFamily: 'monospace',
          theme: RPXtermTheme(),
          rows: 24,
          cols: 80,
        });
        term.open(el);
        term.onData(function(data){
          if (termTaskId){
            window.send({action:'terminal_input', task_id: termTaskId, data: data});
          }
        });
        // v4.38.7: 初始化后 fit 一次
        setTimeout(fitTerm, 50);
      }

      installWsHandler();

      var st = document.getElementById('termStatus');
      if(st){
        st.textContent = '连接中...';
        st.style.color = 'var(--text3)';
      }

      window.send({
        action: 'terminal_open',
        host: conn.host,
        port: conn.port || 22,
        user: conn.user || 'root',
        auth_type: conn.auth_type || 'pass',
        password: conn.password || '',
        key: conn.key || '',
        passphrase: conn.passphrase || '',
        rows: term.rows,
        cols: term.cols,
      });
    },

    close: function(){
      if (termTaskId){
        window.send({action:'terminal_close', task_id: termTaskId});
        clearTaskId();  // v4.38.9: 用户主动断开，清除持久化
      }
      if (term){
        term.write('\r\n\x1b[33m--- 已断开 ---\x1b[0m\r\n');
      }
      var st = document.getElementById('termStatus');
      if(st){
        st.textContent = '已断开';
        st.style.color = 'var(--text3)';
      }
    },

    // v4.38.7: 最大化/还原
    toggleMaximize: function(){
      applyMaximize(!maximized);
      var btn = document.getElementById('termMaxBtn');
      if(btn) btn.textContent = maximized ? '🗗' : '⛶';
    },

    // v4.38.7: 分离到独立窗口
    detach: function(){
      var t = document.getElementById('termAuthType');
      var type = t ? t.value : 'pass';
      var valEl = document.getElementById('termAuthValue');
      var ppEl = document.getElementById('termAuthPassphrase');
      // v4.38.8: 存原始值（未编码），分离窗口回填后可直接自动连接
      var rawConn = {
        host: (document.getElementById('termSrvHost') || {}).value || '',
        port: (document.getElementById('termSrvPort') || {}).value || '22',
        user: (document.getElementById('termSrvUser') || {}).value || 'root',
        auth_type: type,
        rawValue: valEl ? valEl.value : '',
        rawPassphrase: ppEl ? ppEl.value : '',
      };
      try {
        sessionStorage.setItem('term_detach_conn', JSON.stringify(rawConn));
      } catch(e){}
      var w = window.open('/terminal.html', 'rsync_terminal_' + Date.now(),
        'width=900,height=600,menubar=no,toolbar=no,location=no,status=no');
      if(!w){
        alert('弹窗被拦截，请允许弹窗后重试');
      }
    },
  };

  // v4.38.9: 创建 xterm 实例（供 tryAttach 和 open 共用）
  function ensureTerm(){
    if(term) return true;
    var el = document.getElementById('terminal');
    if(!el || !XTermCtor) return false;
    term = new XTermCtor({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'monospace',
      theme: RPXtermTheme(),
      rows: 24,
      cols: 80,
    });
    term.open(el);
    term.onData(function(data){
      if(termTaskId){
        window.send({action:'terminal_input', task_id: termTaskId, data: data});
      }
    });
    setTimeout(fitTerm, 50);
    return true;
  }

  // v4.38.9: 页面加载时自动尝试恢复上次的终端会话
  // 流程：读 localStorage task_id -> 建 WS -> 发 terminal_attach -> 成功则恢复
  function tryAttach(){
    var savedTaskId = getSavedTaskId();
    if(!savedTaskId) return;
    if(typeof window.openWs !== 'function') return;
    window.openWs(function(ws){
      installWsHandler();
      if(!ensureTerm()) return;
      attaching = true;
      var st = document.getElementById('termStatus');
      if(st){
        st.textContent = '恢复会话中...';
        st.style.color = 'var(--text3)';
      }
      window.send({action: 'terminal_attach', task_id: savedTaskId});
    });
  }

  // v4.38.9: 延迟尝试 attach（等主窗口 WS 与 DOM 就绪）
  setTimeout(tryAttach, 800);
})();