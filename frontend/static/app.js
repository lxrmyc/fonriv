// ==========================================
// Fonriv 核心业务与 WebSocket 通信逻辑
// ==========================================

// ---- v5.34.0 P0 安全加固: 启动时清除 localStorage 中的明文凭据 ----
// DB(Fernet) 才是凭据真源; 浏览器不再留存任何密码/密钥/口令 (历史键的一次性清理)
(function sanitizeLocalStorageCreds(){
  var SPEC = {
    'rsync_configs':        ['auth_value', 'auth_passphrase'],
    'fonriv_pbs_config': ['auth_value'],
    'fonriv_ab_config':  ['auth_value', 'passphrase'],
    'fonriv_lvm_config': ['auth_value', 'passphrase'],
    'fonriv_zfs_config': ['auth_value', 'passphrase'],
    'tri_temp_servers_v1':  ['password', 'key', 'passphrase'],
    'rp_rdp_servers':       ['password'],
    'rp_rd_saved':          ['password', 'vnc_password']
  };
  var n = 0;
  Object.keys(SPEC).forEach(function(sk){
    try {
      var raw = localStorage.getItem(sk);
      if (!raw) return;
      var data = JSON.parse(raw);
      var isArr = Array.isArray(data);
      var items = isArr ? data : [data];
      items.forEach(function(it){
        if (it && typeof it === 'object'){
          SPEC[sk].forEach(function(f){ if (it[f]) { it[f] = ''; n++; } });
        }
      });
      localStorage.setItem(sk, JSON.stringify(isArr ? items : items[0]));
    } catch(e){}
  });
  if (n > 0) console.info('[Security] 已清除 localStorage 中 ' + n + ' 处明文凭据 (v5.34.0)');
})();

// ---- 主题切换 (Phase E1) ----
// v1.0.0 · 主题注册表: 暗黑 / 明亮 (科技风双主题 neon/quantum 源码已移除, 旧值回退)
window.RP_THEME_ICONS = { dark:'🌙', light:'☀️' };
window.updateThemeToggleIcon = function(){
  try{
    var btn = document.getElementById('themeToggleBtn');
    if(!btn) return;
    var t = document.documentElement.getAttribute('data-theme') || 'dark';
    btn.textContent = window.RP_THEME_ICONS[t] || (t==='light' ? '☀️' : '🌙');
    btn.title = '切换主题 · 当前: ' + ({dark:'暗黑模式',light:'明亮模式'})[t] + ' · 点击循环切换';
  }catch(e){}
};
(function initTheme(){
  try{
    // v4.15.5 · 兼容 ui_prefs.js 使用的 rp_theme（含 auto 跟随系统）
    var rp = localStorage.getItem('rp_theme');
    var final;
    if (rp === 'light') final = 'light';
    else if (rp === 'dark') final = 'dark';
    else if (rp === 'neon') final = 'dark';        // 旧「深空科技·黑」→ 暗黑
    else if (rp === 'quantum' || rp === 'fresh') final = 'light';   // 旧「量子科技·浅」/「清爽」→ 明亮
    else if (rp === 'auto'){
      try { final = (window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark'; }
      catch(_){ final = 'dark'; }
    } else {
      final = localStorage.getItem('theme') || 'light';  // v4.39.0: 默认浅色
    }
    if (final === 'light') document.documentElement.setAttribute('data-theme','light');
    else document.documentElement.setAttribute('data-theme','dark');  // v4.41.3 · 显式设置, 避免属性缺失导致 toggleTheme 误判

    // v4.21.0 · auto 主题动态跟随系统：监听 prefers-color-scheme 变化
    if (rp === 'auto' && window.matchMedia){
      try {
        var mq = matchMedia('(prefers-color-scheme: light)');
        var handler = function(e){
          // 每次都要重新读，防止用户已切换到固定 dark/light
          if (localStorage.getItem('rp_theme') !== 'auto') return;
          if (e.matches) document.documentElement.setAttribute('data-theme','light');
          else document.documentElement.setAttribute('data-theme','dark');  // v4.41.3 · 同上显式设置
        };
        if (mq.addEventListener) mq.addEventListener('change', handler);
        else if (mq.addListener) mq.addListener(handler);
      } catch(_){}
    }
  }catch(e){}
})();
function toggleTheme(){
  // v4.41.3 · 修复来回切换失效: dark 也显式 setAttribute('data-theme','dark')
  //   旧逻辑 dark 时 removeAttribute -> 下次 getAttribute 返回 null 回退 'light'
  //   -> 永远算"当前浅色"-> 永远再切 dark, 视觉无变化, 无法回到浅色
  // v6.16.2 批18 · 主题只保留 暗黑/明亮(用户明令, 其余主题移除); 老值(neon/quantum/fresh)回环到 dark
  var CYCLE = ['dark','light'];
  var cur = document.documentElement.getAttribute('data-theme') || 'dark';  // 无属性=默认深色
  var idx = CYCLE.indexOf(cur);
  var next = CYCLE[(idx < 0 ? 0 : idx + 1) % CYCLE.length];  // 旧主题值(fresh 等)回环到 dark
  document.documentElement.setAttribute('data-theme', next);
  try{
    localStorage.setItem('theme', next);
    localStorage.setItem('rp_theme', next);  // v4.15.5 · 同步双 key
  }catch(e){}
  if (typeof window.updateThemeToggleIcon === 'function') window.updateThemeToggleIcon();
  else { var _b = document.getElementById('themeToggleBtn'); if(_b) _b.textContent = next==='dark' ? '🌙' : '☀️'; }
  // v4.15.8 · 首页切换也要写数据库，否则登录后 ui_prefs_get 会用旧值覆盖
  try{
    if (typeof send === 'function'){
      send({action:'ui_prefs_set', theme: next}, function(_){ /* silent */ });
    }
  }catch(e){ console.warn('theme persist to db fail:', e); }
}
// 页面加载后同步按钮图标
document.addEventListener('DOMContentLoaded', function(){
  setTimeout(function(){ try{ autoWireSections(); }catch(e){} }, 600);    // v5.36.0 全页 section 折叠
  setTimeout(function(){ try{ autoWireSections(); }catch(e){} }, 2500);   // 覆盖动态渲染

  // v2.6.7: 全局 card 折叠
  // v5.98.8 · FIX(用户报"连接中心里 Seafile/网络共享卡片右上角小三角点不动, 其他能点开"):
  //   旧实现只在 DOMContentLoaded 时对**当时已存在**的 `.card.collapsible > h3` 逐个 addEventListener
  //   —— 而连接中心那两类卡片是**数据回来后动态渲染**的, 拿不到监听器, 右上角那个 ▼(CSS ::after
  //   画的, DOM 里查不到元素)自然点了没反应; 初始 HTML 里就有的卡片则正常。
  //   改为**事件委托**: 无论何时渲染出来的卡片, 点标题都能折叠/展开。
  document.addEventListener('click', function(e){
    var h = (e.target && e.target.closest) ? e.target.closest('.card.collapsible > h3') : null;
    if (!h) return;
    // 避免点到帮助图标/按钮时触发
    if (e.target.closest('.help-icon,button,input,select,label')) return;
    h.parentElement.classList.toggle('collapsed');
  });
  var btn = document.getElementById('themeToggleBtn');
  if(btn){
    // v6.0.0 · 图标统一由 RP_THEME_ICONS 映射 (支持四主题)
    if (typeof window.updateThemeToggleIcon === 'function') window.updateThemeToggleIcon();
    else {
      var t = document.documentElement.getAttribute('data-theme') || 'dark';  // v4.41.3 · 无属性=默认深色(与 CSS 默认一致)
      btn.textContent = t==='dark' ? '🌙' : '☀️';
    }
  }
  // v2.6.0: PBS 连接模式 UI 初始化
  if(typeof updatePbsConnMode === 'function'){ try{ updatePbsConnMode(); }catch(e){} }
  // v2.6.0: RBD 模式初始（隐藏基线快照输入框）
  if(typeof onRbdModeChange === 'function'){ try{ onRbdModeChange(); }catch(e){} }
  // v2.6.4: 恢复各面板 SSH 连接状态（跨页面/刷新持久）
  if(typeof restorePanelConnStatus === 'function'){ try{ restorePanelConnStatus(); }catch(e){} }
  // v2.6.7: 恢复上次激活的 tab（页面刷新后不再跳回文件传输）
  try {
    var savedTab = localStorage.getItem('activeTab');
    if(savedTab && document.getElementById('panel-'+savedTab)){
      setTimeout(function(){ if(typeof switchTab==='function') switchTab(savedTab); }, 100);
    }
  } catch(e){}
  // v4.38.17: 恢复传输参数模块显示/隐藏状态
  if(typeof _restoreTransferParamsState === 'function'){ try{ _restoreTransferParamsState(); }catch(e){} }
});

// ---- Toast 通知 (代替 alert / 统一提示) (Phase E5) ----
// v3.4.0: 优先使用 panels/toast.js 里的实现；模块未加载时用内联兜底。
if (typeof window.toast !== 'function') {
  window.toast = function(msg, level, duration){
    level = level || 'info';
    duration = duration || 3000;
    var wrap = document.getElementById('toastWrap');
    if(!wrap){ try{ console.log('['+level+']', msg); }catch(e){} return; }
    var el = document.createElement('div');
    el.className = 'toast toast-' + level;
    el.textContent = msg;
    wrap.appendChild(el);
    setTimeout(function(){
      el.style.transition = 'opacity .3s, transform .3s';
      el.style.opacity = '0'; el.style.transform = 'translateX(20px)';
      setTimeout(function(){ if(el.parentNode) el.parentNode.removeChild(el); }, 350);
    }, duration);
  };
}
var toast = window.toast;
/* v6.3.14 · 原生弹窗收敛(文案/交互体检): `window.alert` 在**入口处**接管为主题化 toast。
   背景: 项目规范早已写明"原生 confirm/alert 已换成主题化模态, 新代码不得回退原生弹窗",
   但全站仍有 **102 处** alert 调用点 —— 逐个改是大改动、易漏、且每处都要人工核对语义;
   这里一次性消除**阻塞式**原生弹窗(alert 无返回值语义, 接管后调用点零改动),
   原生实现保留在 `window.__rpNativeAlert` 以备排障。
   注: `confirm`(66 处)/`prompt`(27 处) 是**同步返回值**语义, 无法用异步主题化模态替换,
   保留原样并加棘轮守栏(只降不升), 待专门一版逐处改造。 */
if (typeof window.__rpNativeAlert !== 'function') {
  window.__rpNativeAlert = window.alert;
  window.alert = function(msg){
    var s = String(msg == null ? '' : msg);
    try { (window.toastWarn || toast)(s, 'warn'); }
    catch (e) { try { window.__rpNativeAlert(s); } catch (e2) { try { console.warn('[alert]', s); } catch (e3) {} } }
  };
}
if (typeof window.toastOk   !== 'function') window.toastOk   = function(m){ toast(m,'success'); };
if (typeof window.toastErr  !== 'function') window.toastErr  = function(m){ toast(m,'error',5000); };
if (typeof window.toastWarn !== 'function') window.toastWarn = function(m){ toast(m,'warn',4000); };
var toastOk = window.toastOk, toastErr = window.toastErr, toastWarn = window.toastWarn;

// ---- 连接徽章统一更新 (Phase E5) ----
// 参数：badgeId 元素 id；status: 'idle'|'testing'|'ok'|'fail'；text 可选
function setConnBadge(badgeId, status, text){
  var el = document.getElementById(badgeId);
  if(!el) return;
  el.className = 'conn-badge conn-' + status;
  var map = {idle:'未连接', testing:'⏳ 测试中…', ok:'🟢 已连接', fail:'🔴 连接失败'};
  el.textContent = text || map[status] || status;
  // v2.6.5: 自动同步到全局连接状态（xxxConnBadge → 前缀 xxx）
  try {
    var m = /^([a-z]+)ConnBadge$/.exec(badgeId);
    if(m && typeof recordPanelConnStatus === 'function'){
      var prefix = m[1];
      var hostMap = { srv:'srvHost', pve:'pveHost', vd:'vdHost', lvm:'lvmHost',
                      pbs:'pbsHost', zfs:'zfsHost', rbd:'rbdHost', ab:'abHost' };
      var host = '';
      var hid = hostMap[prefix];
      if(hid){ var hel = document.getElementById(hid); if(hel) host = hel.value || ''; }
      // 从当前 activeIdx 配置里找 name
      var cfgName = '';
      try {
        (configs || []).forEach(function(c){ if(c && c._active) cfgName = c.name || ''; });
      } catch(e){}
      var st = (status === 'ok') ? 'ok' : (status === 'fail' ? 'fail' : 'idle');
      recordPanelConnStatus(prefix, st, host, text || '', cfgName);
    }
  } catch(e){}
}

// v5.20.0 · `-z` 移出默认集合: 实测不可压缩数据下 -z 让吞吐从 128.1 掉到 15.8 MB/s (慢 8.1 倍);
//   内网链路 12~17Gbps 的瓶颈是 SSH 加解密 CPU 而非带宽, 压缩纯属浪费 CPU。
//   详见 docs/性能基线实测报告_v5.20.md。需要时用户可手动勾选。
var direction='up', activeFlags=new Set(['-a','-v','--progress','--partial','--mkpath']);
var transferRunning=false;
var currentWs=null;
var currentUser=null; // {user_id, username, role, token}
var scanBaseDir='/var/lib/vz/images/';
var selectedVmId=100;
var selectedVdVmId=100;
var scannedVmData=[];
var jobQueue=[]; // 任务队列

// ------------------------------------------
// 用户认证
// ------------------------------------------
function doLogin(){
  var username = gv('loginUser');
  var password = gv('loginPass');
  var errEl = document.getElementById('loginError');
  if(!username || !password){ errEl.textContent='请输入用户名和密码'; return; }
  errEl.textContent='登录中...';
  var myReqId = 'login_' + Date.now();
  // v3.0.2: encodePasswordAsync 优先（EC1: curve25519+AES-GCM 真加密）· 失败自动 fallback ENC:
  var pwPromise = (typeof encodePasswordAsync === 'function')
                    ? encodePasswordAsync(password)
                    : Promise.resolve((typeof encodePassword === 'function') ? encodePassword(password) : password);
  pwPromise.then(function(encoded){
    openWs(function(ws){
    var handler = function(e){
      try {
        var msg = JSON.parse(e.data);
        // 只处理本次登录请求的响应；忽略 restore/其它并发响应
        if(msg && msg.req_id && msg.req_id !== myReqId) return;
        if(msg && !msg.req_id && msg.type === 'result' &&
           typeof msg.msg === 'string' &&
           (msg.msg.indexOf('会话已恢复') >= 0 || msg.msg.indexOf('会话恢复失败') >= 0)) return;
        if(msg.type === 'result'){
          try { clearTimeout(window._loginWd); window._loginWd = null; } catch(_){}
          window._loginAutoRetried = false;
          ws.removeEventListener('message', handler);
          if(msg.status === 'ok'){
            currentUser = {user_id: msg.user_id, username: msg.username, role: msg.role, token: msg.token,
                           permissions: msg.permissions || [],
                           client_ip: msg.client_ip || '', client_host: msg.client_host || ''};
            localStorage.setItem('auth_token', msg.token);
            localStorage.setItem('currentUser', JSON.stringify(currentUser));
            // v4.43.0 · 登录响应里无连接信息时 (会话恢复场景), 异步补拉
            if(!currentUser.client_ip && typeof window.fetchClientInfo === 'function'){
              try { window.fetchClientInfo(); } catch(e){ console.warn('fetchClientInfo', e); }
            }
            _rpWsReady('login');
            try { window._rpSessionLostCount = 0; window._rpSessionLostTold = false; } catch(_){}
            document.getElementById('loginOverlay').style.display='none';
            document.getElementById('mainApp').classList.add('visible');
            updateUserSidebar();
            applyPermissions();  // v2.6.3: 按权限隐藏/显示 tab
            /* v1.0.0 · 登录成功后立即拉一次会话状态 + 启动定时刷新(用户要求: 刷新/重登后连接状态不丢) */
            try { window.SP && SP.refreshSessions && SP.refreshSessions(); } catch(_){}
            try { window.SP && SP.startSessionPolling && SP.startSessionPolling(); } catch(_){}
            if(typeof fetchLicenseFeatures === 'function') fetchLicenseFeatures();  // v4.44.1 · license 白名单显隐
            addLog((window.t ? window.t('用户 {name} 登录成功', {name: msg.username}) : ('用户 '+msg.username+' 登录成功')),'success');
            loadConfigs();   // v5.35.0 · 单轨档案侧栏
            // v4.38.21 · 登录成功后刷新三列组件的服务器列表
            // v4.74.0 · 登录后同步后端语言偏好 (多用户各自语言)
            try {
              if (window.send) window.send({ action: 'ui_lang_get' }, function(d){
                try {
                  if (d && d.status === 'ok' && d.lang){
                    var _locLang = window.currentLang ? window.currentLang() : 'zh';
                    if (d.lang !== _locLang && window.setLang) window.setLang(d.lang);
                  }
                } catch(e){}
              });
            } catch(e){}
            try { if (window.TriPaneTransfer && window.TriPaneTransfer.onLoginSuccess){ window.TriPaneTransfer.onLoginSuccess(); } } catch(e){ console.warn('TriPaneTransfer.onLoginSuccess', e); }
          } else {
            // v3.2.1: 加密握手过期 → 自动 refresh pubkey + retry 一次
            var msgTxt = msg.msg || '登录失败';
            if(msgTxt.indexOf('加密握手') >= 0 && !window._loginRetried){
              window._loginRetried = true;
              errEl.textContent = '加密握手已过期，正在刷新...';
              currentWs = null;
              if(typeof refreshServerPubkey === 'function'){
                refreshServerPubkey().then(function(){
                  setTimeout(function(){ doLogin(); window._loginRetried = false; }, 100);
                });
              }
            } else {
              window._loginRetried = false;
              errEl.textContent = msgTxt;
              currentWs = null;
            }
          }
        }
      } catch(err){}
    };
    ws.addEventListener('message', handler);
    ws.send(JSON.stringify({action:'db_user_login', username: username, password: encoded, req_id: myReqId}));
    // v5.88.0 · 登录看门狗: 响应丢失(socket 中途被换/处理异常)时表单会永远停在
    //   "登录中..." — 15s 无结果自动重发一次, 再不行给复位提示(用户报退出重登超时)
    try { clearTimeout(window._loginWd); } catch(_){}
    window._loginWd = setTimeout(function(){
      window._loginWd = null;
      if(!currentUser && errEl && errEl.textContent.indexOf('登录中') >= 0){
        if(!window._loginAutoRetried){
          window._loginAutoRetried = true;
          errEl.textContent = '登录无响应，自动重试…';
          setTimeout(function(){ doLogin(); }, 400);
        } else {
          window._loginAutoRetried = false;
          errEl.textContent = '登录无响应：请再点一次「登录」(持续无响应请刷新页面)';
        }
      }
    }, 15000);
    }, function(err){
      /* v5.98.15 · 密码加密/打开连接失败必须可见 —— 原先这里只有 openWs 的失败分支,
         而 pwPromise(encodePasswordAsync) 的 rejection **无人接**: 一旦加密失败,
         登录帧永远不会发出, 界面就一直停在"登录中..."且没有任何提示(实测踩到过)。 */
      try { clearTimeout(window._loginWd); window._loginWd = null; } catch(_){}
      errEl.textContent = '登录前置失败: ' + ((err && err.message) || err) + ' (请刷新页面重试)';
      errEl.style.color = 'var(--red)';
    }).catch(function(err){
      try { clearTimeout(window._loginWd); window._loginWd = null; } catch(_){}
      errEl.textContent = '连接服务器失败: ' + err.message;
      // v5.88.0 · 连接失败给一键重试(不再让用户干等/手动刷新)
      if(!window._wsRetryOffered){
        window._wsRetryOffered = true;
        setTimeout(function(){ window._wsRetryOffered = false; }, 20000);
        errEl.textContent += '（将自动重试登录…）';
        setTimeout(function(){ if(!currentUser) doLogin(); }, 2500);
      }
    });
  }).catch(function(err){
    // encodePasswordAsync 失败（浏览器不支持 SubtleCrypto 等）→ 已在函数内 fallback，不应到这里
    errEl.textContent = '密码加密失败: ' + (err && err.message || err);
  });
}

// v4.43.0 · 拉取当前 WS 连接的客户端 IP/计算机名 (会话恢复等登录响应无此信息的场景)
window.fetchClientInfo = function(){
  try {
    send({action: 'client_info_get'}, function(r){
      if (r && r.status === 'ok' && typeof currentUser === 'object' && currentUser){
        currentUser.client_ip = r.client_ip || '';
        currentUser.client_host = r.client_host || '';
        try { localStorage.setItem('currentUser', JSON.stringify(currentUser)); } catch(e){}
        try { if (window.Dashboard && window.Dashboard.renderWs) window.Dashboard.renderWs(); } catch(e){}
      }
    });
  } catch(e) { console.warn('fetchClientInfo', e); }
};

function doLogout(){
  currentUser = null;
  localStorage.removeItem('auth_token');
  localStorage.removeItem('currentUser');
  // v5.88.0 · 退出即彻底清场: 旧 socket 的关闭事件不再触发任何逻辑,
  //   心跳/重连定时器全停 — 否则下一次登录会在"残留状态"上叠Buff(用户报:
  //   每次退出重登都 WebSocket 连接超时)
  try { clearInterval(_wsHeartbeatTimer); } catch(_){}
  try { clearTimeout(_wsPongTimeout); } catch(_){}
  try { clearTimeout(_wsReconnectTimer); } catch(_){}
  if(currentWs){
    try { currentWs.onclose = null; currentWs.onerror = null; } catch(_){}
    try { currentWs.close(); } catch(_){}
    currentWs = null;
    if(window.ws === currentWs){ window.ws = null; }
    updateGlobalConnStatus('disconnected');
  }
  document.getElementById('loginOverlay').style.display='flex';
  document.getElementById('mainApp').classList.remove('visible');
  var _le = document.getElementById('loginError');
  if(_le) _le.textContent='';
  gv('loginPass', '');
}

function checkAuth(){
  var saved = localStorage.getItem('currentUser');
  var token = localStorage.getItem('auth_token');
  if(saved && token){
    try{
      currentUser = JSON.parse(saved);
      document.getElementById('loginOverlay').style.display='none';
      document.getElementById('mainApp').classList.add('visible');
      updateUserSidebar();
      // v2.6.3: 恢复登录状态后也要按权限过滤 tab
      if(typeof applyPermissions === 'function') setTimeout(applyPermissions, 0);
      if(typeof fetchLicenseFeatures === 'function') setTimeout(fetchLicenseFeatures, 200);  // v4.44.1
      // v2.6.5 修复：F5 刷新丢失左侧配置 — checkAuth 也要重新拉配置
      setTimeout(loadConfigs, 100);   // v5.35.0 · 单轨档案侧栏
    }catch(e){
      localStorage.removeItem('currentUser');
      localStorage.removeItem('auth_token');
    }
  }
}

// ------------------------------------------
// 用户管理 · v3.4.1 迁移到 frontend/static/panels/users.js
// ------------------------------------------
// 12 个函数（updateUserSidebar / openUserManager / loadUserList / renderUserList /
// openPermsDialog / openAddUser / editUser / toggleUserRole / changeUserPassword /
// deleteUser / openChangePassword）+ PAGE_DISPLAY / pageDisplayName 全部搬到
// panels/users.js，通过 window.xxx 全局挂载，加载顺序保证在 app.js 之前。
// 顺便修了 v3.4.1 前 changeUserPassword 定义两次的历史 bug（442 & 481 行）。



// Enter key triggers login
document.addEventListener('keydown', function(e){
  if(e.key === 'Enter' && document.getElementById('loginOverlay').style.display !== 'none'){
    doLogin();
  }
});

// ------------------------------------------
// 工具与帮助函数
// ------------------------------------------
// v2.6.x: Base64 混淆（同步）—— 遗留主路径，全站调用 encodePassword() 走这里
// v2.8.1: 新增 encodePasswordAsync() 支持 EC1: curve25519+AES-GCM 真加密
//         服务器 decode_password() 两种前缀都能解 → 可平滑迁移
function encodePassword(plain){
  if(!plain) return '';
  try{ return 'ENC:' + btoa(unescape(encodeURIComponent(plain))); }
  catch(e){ return plain; }
}

// v2.8.1: 启动时预取服务器 X25519 公钥
window._rpPubkey = { raw: null, ready: false, scheme: '' };
function refreshServerPubkey(){
  return fetch('/api/pubkey', { cache: 'no-store' }).then(function(r){ return r.json(); }).then(function(j){
    if(j && j.pubkey){
      var b64 = j.pubkey.replace(/-/g,'+').replace(/_/g,'/');
      while(b64.length % 4) b64 += '=';
      var raw = atob(b64);
      var u8 = new Uint8Array(raw.length);
      for(var i=0;i<raw.length;i++) u8[i] = raw.charCodeAt(i);
      window._rpPubkey = { raw: u8, ready: true, scheme: j.scheme || 'X25519' };
      return true;
    }
    window._rpPubkey = { raw: null, ready: false, scheme: '' };
    return false;
  }).catch(function(e){
    console.warn('[crypto] pubkey fetch failed:', e);
    window._rpPubkey = { raw: null, ready: false, scheme: '' };
    return false;
  });
}
window.refreshServerPubkey = refreshServerPubkey;
(function prefetchPubkey(){
  try {
    refreshServerPubkey();
  } catch(e){ console.warn('[crypto] prefetch skipped:', e); }
})();
// 旧的 IIFE 保持不动作（下方的旧代码会 no-op，因为 window._rpPubkey 已就绪）
(function _oldPrefetchNoop(){
  try {
    fetch('/api/pubkey', { cache: 'no-store' }).then(function(r){ return r.json(); }).then(function(j){
      if(j && j.pubkey){
        // base64url → Uint8Array
        var b64 = j.pubkey.replace(/-/g,'+').replace(/_/g,'/');
        while(b64.length % 4) b64 += '=';
        var raw = atob(b64);
        var arr = new Uint8Array(raw.length);
        for(var i=0;i<raw.length;i++) arr[i] = raw.charCodeAt(i);
        window._rpPubkey.raw = arr;
        window._rpPubkey.scheme = j.scheme || '';
        window._rpPubkey.ready = true;
        console.info('[crypto] server pubkey ready, scheme:', j.scheme);
      } else {
        console.info('[crypto] server has no pubkey (crypto disabled?) → EN2C fallback');
      }
    }).catch(function(e){ console.warn('[crypto] pubkey fetch failed:', e); });
  } catch(e){ console.warn('[crypto] prefetch skipped:', e); }
})();

// v2.8.1: 异步真加密（curve25519 ECDH + HKDF-SHA256 + AES-GCM）
async function encodePasswordAsync(plain){
  if(!plain) return '';
  var pub = window._rpPubkey;
  // 不可用时降级到 base64
  if(!pub || !pub.ready || !pub.raw || !window.crypto || !window.crypto.subtle){
    return encodePassword(plain);
  }
  try {
    // 生成临时 X25519 密钥对
    var esk = await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
    var epk = new Uint8Array(await crypto.subtle.exportKey('raw', esk.publicKey));
    // 导入服务器公钥
    var serverPub = await crypto.subtle.importKey('raw', pub.raw, { name: 'X25519' }, false, []);
    // ECDH 32 字节 shared secret
    var shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'X25519', public: serverPub }, esk.privateKey, 256));
    // HKDF-SHA256(shared, salt=None, info='fonriv/1.0', 32)
    var hkdfKey = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveBits']);
    var okmBits = await crypto.subtle.deriveBits({
      name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(), info: new TextEncoder().encode('fonriv/1.0')
    }, hkdfKey, 256);
    var aesKey = await crypto.subtle.importKey('raw', okmBits, { name: 'AES-GCM' }, false, ['encrypt']);
    var nonce = crypto.getRandomValues(new Uint8Array(12));
    var pt = new TextEncoder().encode(plain);
    var ct = new Uint8Array(await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: new TextEncoder().encode('fonriv') },
      aesKey, pt
    ));
    // 拼接 epk(32) || nonce(12) || ct
    var out = new Uint8Array(epk.length + nonce.length + ct.length);
    out.set(epk, 0); out.set(nonce, epk.length); out.set(ct, epk.length + nonce.length);
    // base64url(无 padding)
    var s = '';
    for(var i=0;i<out.length;i++) s += String.fromCharCode(out[i]);
    var b64 = btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
    return 'EC1:' + b64;
  } catch(e){
    console.warn('[crypto] encodePasswordAsync failed, fallback to ENC:', e);
    return encodePassword(plain);
  }
}
window.encodePasswordAsync = encodePasswordAsync;


function copyCmd(){
  var text=document.getElementById('cmdPreview');
  if(!text)return;
  if(navigator.clipboard){
    window.copyToClipboard(text.textContent, function(){addLog('命令已复制到剪贴板','success');});
  }
}

// ------------------------------------------
// WebSocket 通信核心
// ------------------------------------------
// v4.96.0 · 目录类 action 请求助手 (list_dir/list_remote_dir 等不在 send() 白名单的请求)
//   - req_id 精确路由; socket 未就绪/中途关闭 → 自动换新 socket 重试 (最多 3 次)
//   - 返回 Promise<{status, entries, ...}>
// v6.3.31 · 进程内单调序号: 与时间戳一起构成**唯一** req_id(纯时间戳会撞号, 见 rid 处注释)
var _rpcRidSeq = 0;
function rpcDirAction(action, data, timeoutMs){
  timeoutMs = timeoutMs || 20000;
  var attempt = 0;
  return new Promise(function(resolve){
    function once(){
      attempt++;
      if (typeof openWs !== 'function'){ resolve({ status:'error', msg:'WebSocket 未就绪' }); return; }
      /* v6.3.31 · FIX: 原 rid 只用「毫秒时间戳 + attempt」→ **同一毫秒内的两次调用会撞出同一个
         req_id**。实测: fonrvfs 连续两行 `RPList.load(..., transport:'dir')`(共享树 + 挂载树)
         拿到完全相同的 `_rpc_xxx_1`, 于是响应**串号** —— 同一帧被两个 handler 同时认领
         (各自 resolve 成**对方的**载荷), 或两边都等不到自己那份 → 表现为「一侧树空/串数据」。
         这里补上进程内单调计数 + 随机后缀, 保证任何并发都唯一。 */
      var rid = '_rpc_' + Date.now().toString(36) + '_' + attempt + '_' + (_rpcRidSeq++)
              + Math.random().toString(36).slice(2, 6);
      var done = false;
      var finish = function(r, retryable){
        if (done) return;
        if (retryable && attempt < 5){
          // v4.96.0 · 指数退避: WS 在切 tab 后约 3s 才重建, 400ms 的固定间隔会全部打在死 socket 上
          var wait = [0, 600, 1500, 3000, 5000, 8000][attempt] || 8000;
          done = true;
          setTimeout(once, wait);
          return;
        }
        done = true;
        resolve(r || {});
      };
      openWs(function(ws){
        if (ws.readyState !== 1 && ws.readyState !== 0){ finish({ status:'error', msg:'连接不可用' }, true); return; }
        var handler = function(ev){
          var d;
          try { d = JSON.parse(ev.data); } catch(e){ return; }
          if (!d || d.req_id !== rid) return;
          try { ws.removeEventListener('message', handler); } catch(e){}
          finish(d, false);
        };
        ws.addEventListener('message', handler);
        var onDead = function(){
          if (ws.readyState === 3){
            try { ws.removeEventListener('message', handler); } catch(e){}
            finish({ status:'error', msg:'连接中断, 重试中…' }, true);
          }
        };
        ws.addEventListener('close', onDead);
        var payload = Object.assign({ action: action, req_id: rid }, data || {});
        try { _rpSendWhenReady(ws, payload, undefined, function(){ try { console.warn('[ws] 发送失败'); } catch(_){} }) }
        catch(e){
          try { ws.removeEventListener('message', handler); } catch(_){}
          finish({ status:'error', msg:String(e) }, true);
          return;
        }
        setTimeout(function(){
          try { ws.removeEventListener('message', handler); } catch(e){}
          finish({ status:'error', msg:'请求超时' }, true);
        }, timeoutMs);
      }).catch(function(err){ finish({ status:'error', msg:String(err && err.message || err) }, true); });
    }
    once();
  });
}
window.rpcDirAction = rpcDirAction;

// v4.97.0 · 统一刷新所有浏览栏 (传输/流程/恢复完成后调用)
//   - 三栏实例 (_triInstances): 每个 pane 按其模式 (SSH/localFs/cloudFs) 重新 load 当前 cwd
//   - 磁盘管理 DM: 重新扫描挂载点
//   - 文件预览页: 重载当前源目录
// v5.19.7 · 剪贴板安全复制 (HTTP/headless 下 navigator.clipboard 不可用 → 退回 execCommand)
window.copyToClipboard = function(text, onOk){
  if (navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(text).then(function(){
      if (onOk) onOk();
    }).catch(function(){
      _copyFallback(text, onOk);
    });
  } else {
    _copyFallback(text, onOk);
  }
};
function _copyFallback(text, onOk){
  try {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    if (onOk) onOk();
  } catch(e){ console.warn('[clipboard] fallback fail', e); }
}

window.refreshAllPanes = function(changedPaths){
  var n = 0;
  // v5.17.0 · ① 失效涉及的目录 token 缓存
  //   流式预览 token 是按"目录"签发的 10min 复用, 传输覆盖同名文件后 URL 不变 →
  //   浏览器可能仍显示旧内容/旧缩略图。这里按变更路径的父目录精确失效。
  try {
    if (window.RpStreamToken && typeof window.RpStreamToken.invalidate === 'function'){
      var _dirs = {};
      (changedPaths || []).forEach(function(p){
        if (!p) return;
        var d = String(p).replace(/\/+$/, '');
        d = d.replace(/\/[^\/]*$/, '') || '/';   // 父目录
        _dirs[d] = 1;
        _dirs[String(p).replace(/\/+$/, '') || '/'] = 1;  // 自身 (可能是目录)
      });
      Object.keys(_dirs).forEach(function(d){ window.RpStreamToken.invalidate(d); });
    }
  } catch(e){ console.warn('[refreshAllPanes] token invalidate', e); }
  function _paneRefresh(pane, reason){
    if (!pane || typeof pane.load !== 'function') return;
    try {
      var cwd = (typeof pane.getCwd === 'function' ? pane.getCwd() : '') || '/';
      pane.load(cwd);   // load 内部会按 localFs/cloudFs/SSH 三种模式重取, 且带重试
      n++;
    } catch(e){ console.warn('[refreshAllPanes] pane load', reason, e); }
  }
  // v5.17.0 · ② 抽出"刷新所有 pane"为可重复调用 (传输刚结束时文件系统/网络共享可能还没同步;
  //   旧实现只刷一次 → 用户看到"有的文件不刷新", 需要手动点刷新)
  function _refreshEverything(){
    try {
      var insts = window._triInstances || {};
      Object.keys(insts).forEach(function(k){
        var tri = insts[k];
        if (!tri) return;
        try {
          if (tri.getPanes){ var ps = tri.getPanes(); _paneRefresh(ps.left, 'tri.left'); _paneRefresh(ps.right, 'tri.right'); }
        } catch(e){}
      });
    } catch(e){}
    try {
      if (window.TriPaneTransfer && typeof window.TriPaneTransfer.refreshPanes === 'function'){
        window.TriPaneTransfer.refreshPanes();
      }
    } catch(e){}
    try {
      if (window.DiskManager && typeof window.DiskManager.refreshAll === 'function'){
        window.DiskManager.refreshAll();
      }
    } catch(e){}
    try {
      if (window.FilePreviewPage && typeof window.FilePreviewPage.reloadSource === 'function'){
        window.FilePreviewPage.reloadSource();
      }
    } catch(e){}
    try {
      if (window.Shares && typeof window.Shares.refresh === 'function' && window._currentPanelKey === 'shares'){
        window.Shares.refresh();
      }
    } catch(e){}
  }
  _refreshEverything();
  // 延迟补刷: 800ms (本地/SSH 已落盘) + 2500ms (网络共享/CIFS 元数据同步慢)
  try {
    clearTimeout(window.__rpRefreshT1); clearTimeout(window.__rpRefreshT2);
    window.__rpRefreshT1 = setTimeout(_refreshEverything, 800);
    window.__rpRefreshT2 = setTimeout(_refreshEverything, 2500);
  } catch(e){}
  console.log('[refreshAllPanes] refreshed', n, 'pane(s)', changedPaths && changedPaths.length ? ('paths=' + changedPaths.length) : '');
  return n;
};

// v4.97.0 · 左侧服务器列表栏折叠/展开
//   ① 整栏折叠 (‹ 按钮) — 服务器特别多时收纳成细条
//   ② 分组折叠 (通用配置 / 文件传输专属 / 快速操作 …) — 点击分组标题收起该组
//
// v6.3.1 · 侧栏状态改为**单一 owner**(修用户反复报的"左侧服务器面板又不见了"):
//   历史病灶(实测代码): 三个子系统各自保存"进入前的状态"再各自恢复 ——
//     ① app.js 切到 连接中心/多云文件管理 时自动收起(transient, 存 window._fonrSidebarWas);
//     ② fonrvfs 全屏时收起(存 window._fonrFsSideWas, 且**非 transient → 写进 localStorage**);
//     ③ fonrvfs 打开预览时收起(存 window._fonrViewSideWas, 同样写 localStorage)。
//   后果: 交错后恢复成错误的值; 更要命的是 ②③ 把"临时收起"持久化 → 下次登录**所有页面**
//   左侧栏默认消失。而一次性自愈标记 rp_sidebar_autohide_repaired 早已用掉 → 再也不会自愈,
//   于是表现为"这个发生了好多次"。
//   另有一个隐性分裂: 折叠类历史上被写到**两个不同元素**上 —— app.js 写 .app,
//   ui_prefs.applySidebar 写 body; 而 CSS 一处按 .app.sidebar-collapsed 隐藏侧栏、
//   style.css 按 body.sidebar-collapsed 隐藏拖动条, sidebar_resize.js 读的又是 body →
//   "侧栏还在但拖动条没了/拖不动"等不一致。
//
//   现在的规矩(唯一真源):
//   ① 唯一的持久化偏好 rp_sidebar_collapsed **只由用户显式操作写入**;
//   ② 页面级的临时收起用**具名 owner 集合**(非空即收起), 谁收谁还, 不各自存 "was";
//   ③ 切页时统一清理全部临时 owner, 保证离开的页面不留残留;
//   ④ .app 与 body **两个 class 目标一起写**, 消除上面那类分裂;
//   ⑤ "彻底隐藏"(硬隐藏)单独一档: 连折叠后的展开竖条与拖动条一起收掉。
window.__sidebarTemp = window.__sidebarTemp || {};      // 临时收起: owner -> 1
window.__sidebarHard = window.__sidebarHard || {};      // 彻底隐藏: owner -> 1

window.sidebarPref = function(){
  try { return localStorage.getItem('rp_sidebar_collapsed') === '1'; } catch(e){ return false; }
};

// 唯一写入点: 应用折叠态到 DOM(persist=true 才写用户偏好)
window.applySidebarCollapse = function(on, persist){
  try {
    var app = document.querySelector('.app') || document.body;
    var body = document.body;
    var sbEl = document.querySelector('.sidebar');
    [app, body].forEach(function(el){
      if (el && el.classList) el.classList.toggle('sidebar-collapsed', !!on);
    });
    if (sbEl) sbEl.classList.toggle('collapsed', !!on);
    if (persist){
      try {
        localStorage.setItem('rp_sidebar_collapsed', on ? '1' : '0');
        // v6.16.11 · 用户**显式**改过折叠偏好 —— restoreSidebarState 的一次性历史自愈
        //   只该抹"从未被用户设置过却被旧版自动收起污染"的值; 有本标记则跳过抹除,
        //   否则会出现"设置里选启动时折叠 → 刷新又展开"(用户实测)。
        localStorage.setItem('rp_sidebar_user_set', '1');
      } catch(e){}
    }
    var hard = Object.keys(window.__sidebarHard || {}).length > 0;
    [app, body].forEach(function(el){
      if (el && el.classList) el.classList.toggle('sidebar-hard-hidden', hard);
    });
    // 折叠竖条: 硬隐藏时连它一起收掉(用户要求"彻底隐藏公共左面板")
    var bar = document.getElementById('sidebarExpandBar');
    if (bar) bar.style.display = (on && !hard) ? 'flex' : 'none';
    // 侧栏内折叠按钮(v6.3.41 · 批 B: 字形与「多云文件管理」「连接中心」统一为 ‹/›)
    var btn = document.getElementById('sidebarCollapseBtn');
    if (btn) btn.textContent = on ? '›' : '‹';
  } catch(e){}
};

window.toggleSidebarCollapse = function(force, transient){
  var on = (typeof force === 'boolean') ? force : !window.sidebarIsCollapsed();
  // transient=true: 页面级自动收起/恢复 —— **不写 localStorage**(v5.90.10 教训)
  window.applySidebarCollapse(on, !transient);
};

window.sidebarIsCollapsed = function(){
  try {
    var app = document.querySelector('.app') || document.body;
    return !!(app.classList.contains('sidebar-collapsed') || document.body.classList.contains('sidebar-collapsed'));
  } catch(e){ return false; }
};

// 具名临时收起: on=true 收(本 owner 名义), on=false 还自己那一份。
// 只要还有任一 owner 在收 → 保持收起; 全空 → 回到**用户偏好**(不是某个调用方记的 "was")。
window.sidebarTempCollapse = function(owner, on){
  if (!owner) return;
  if (on) window.__sidebarTemp[owner] = 1; else delete window.__sidebarTemp[owner];
  window.applySidebarCollapse(Object.keys(window.__sidebarTemp).length ? true : window.sidebarPref(), false);
};

// 彻底隐藏(含展开竖条): 用于"本页自带左栏, 全局公共左面板整页让位"
window.sidebarHardHide = function(owner, on){
  if (!owner) return;
  if (on) window.__sidebarHard[owner] = 1; else delete window.__sidebarHard[owner];
  var hidden = Object.keys(window.__sidebarHard).length > 0;
  window.applySidebarCollapse(hidden ? true : (Object.keys(window.__sidebarTemp).length ? true : window.sidebarPref()), false);
};

// 清空全部临时态 + 回到用户偏好(切页/离页统一调用, 杜绝残留)
window.sidebarResetTransient = function(){
  window.__sidebarTemp = {};
  window.__sidebarHard = {};
  window.applySidebarCollapse(window.sidebarPref(), false);
};

// v6.3.4 · 服务器列表「按分组 / 按类型」= 三处同款按钮式(用户要求), 共用同一个偏好与入口。
//   三处宿主: ① 全局侧栏 #sbMode* ② 连接中心 #ccMode* ③ 多云文件管理左树 #fonrMode*
//   偏好真源仍是 localStorage['fonr_tree_mode'], 切换一律走这里(SrvTree.setMode 会写偏好 +
//   广播 rp-tree-mode → 三个宿主各自重渲染), 避免几处各写各的造成"这里切了那里没变"。
window.syncTreeModeButtons = function(m){
  try {
    var mode = (m === 'fixed') ? 'fixed' : 'groups';
    [['sbModeGroups', 'sbModeFixed'], ['ccModeGroups', 'ccModeFixed'],
     ['fonrModeGroups', 'fonrModeFixed']].forEach(function(pair){
      var g = document.getElementById(pair[0]), f = document.getElementById(pair[1]);
      if (g) g.className = 'cs-mbtn' + (mode === 'groups' ? ' cs-mbtn-on' : '');
      if (f) f.className = 'cs-mbtn' + (mode === 'fixed' ? ' cs-mbtn-on' : '');
    });
    var sel = document.getElementById('ccTreeMode');
    if (sel) sel.value = mode;
  } catch(e){}
};

/* ═══ v6.3.7 · 公共三态组件(加载中 / 空 / 失败+重试) ═══
   背景(分析报告 C①): 各面板此前"暂无数据 / 空表格 / 一条 toast"三套写法混用, 用户看不出
   到底是在加载、真空、还是读失败。这里收口成**一个实现**, 统一文案口径与重试入口。
   用法: el.innerHTML = rpState({state:'loading'|'empty'|'error', msg:'…', retry:'表达式'}) */
window.rpState = function(o){
  o = o || {};
  var st = o.state || 'loading';
  /* v6.3.15 · 三态图标改用内联 SVG(emoji 在四主题下大小/基线/配色不一, 且不随 currentColor 变) */
  var map = { loading: ['spin', 'var(--text3)'], empty: ['box', 'var(--text3)'], error: ['warn', 'var(--red)'] };
  var _k = map[st] ? map[st][0] : 'spin';
  var ic = (typeof window.rpIcon === 'function')
    ? ( _k === 'spin' ? window.rpSpin() : window.rpIcon(_k) )
    : ({ spin: '⏳', box: '📭', warn: '✗' }[_k] || '⏳');   // 图标集未加载时回落 emoji(不空白)
  var col = map[st] ? map[st][1] : 'var(--text3)';
  var dflt = { loading: '正在读取…', empty: '暂无数据', error: '读取失败' };
  var msg = o.msg || dflt[st] || '';
  var h = '<div class="rp-state" style="color:' + col + '">' + ic + ' ' + String(msg).replace(/[<>]/g, '') ;
  if (o.hint) h += '<div class="rp-state-hint">' + String(o.hint).replace(/[<>]/g, '') + '</div>';
  if (o.retry) h += '<div style="margin-top:6px"><button class="btn btn-xs" onclick="' + String(o.retry).replace(/"/g, '&quot;') + '">重新加载</button></div>';
  return h + '</div>';
};

/* ═══ v6.3.7 · 顶栏一行状态条(参考 QVMConsole 首页 hero 的信息密度) ═══
   一屏可读: ① 链路 ② 当前页 ③ 活跃传输 ④ 宿主机资源水位。
   数据全部是既有真值(_wsStatus / 活动面板 / 传输监控 / __sysStats), 不新增请求;
   页面失焦时**不刷新**(省资源, 参考 QVMConsole 的"失焦暂停")。 */
window.rpStatusStrip = {
  render: function(){
    try {
      var d = document.getElementById('rpStripDot'), w = document.getElementById('rpStripWs');
      var st = window._wsStatus || 'unknown';
      if (d) d.className = 'rp-strip-dot ' + (st === 'open' ? 'on' : (st === 'connecting' ? 'wait' : 'off'));
      if (w) w.textContent = (st === 'open' ? '已连接' : (st === 'connecting' ? '连接中' : '未连接'));
      var pg = document.getElementById('rpStripPage');
      if (pg){
        var el = document.querySelector('.panel.active');
        var key = el ? el.id.replace(/^panel-/, '') : 'dashboard';
        var lbl = key;
        try {
          (window.NAV_TREE || []).forEach(function(g){
            if (g.key === key) lbl = g.label;
            (g.children || []).forEach(function(c){ if (c.key === key) lbl = c.label; });
          });
        } catch(e){}
        pg.textContent = lbl;
      }
      var xf = document.getElementById('rpStripXfer');
      if (xf){
        var t = document.getElementById('tmCount');
        var txt = t ? String(t.textContent || '').trim() : '';
        xf.textContent = txt ? ('传输 ' + txt) : '空闲';
      }
      var rs = document.getElementById('rpStripRes');
      if (rs){
        var s = window.__sysStats;
        if (s){
          var c = Math.round(Number(s.cpu_percent) || 0);
          var m = Math.round(Number((s.memory || {}).percent) || 0);
          var k = Math.round(Number((s.disk || {}).percent) || 0);
          rs.textContent = 'CPU ' + c + '% · 内存 ' + m + '% · 磁盘 ' + k + '%';
          rs.style.color = (c >= 90 || m >= 90 || k >= 90) ? 'var(--red)'
                         : ((c >= 75 || m >= 80 || k >= 80) ? 'var(--orange)' : '');
        } else {
          rs.textContent = '资源 —';
        }
      }
    } catch(e){}
  }
};
try {
  setInterval(function(){
    if (document.hidden) return;                 // 失焦暂停(参考 QVMConsole)
    window.rpStatusStrip.render();
  }, 5000);
  window.addEventListener('load', function(){ setTimeout(window.rpStatusStrip.render, 1200); });
} catch(e){}

/* ── v6.3.5 · 左栏"状态真值"刷新 ──
   用户报障: 网络共享断开/掉线后左侧仍显示连接成功。状态点的真值有两个来源:
     ① 活动会话(sessionsByKey, 已在侧栏用到) ② 网络共享的真实挂载态(share_list → __sharesCache)。
   ② 以前只在**重连**时才拉一次, 于是掉线后界面一直挂着旧的"绿"。
   现在: 进相关页面 / 重连 / 手动刷新都拉一次(10s 节流, 避免切页反复打), 拿到后立刻重渲染左栏。 */
window._rpRerenderSidebars = function(){
  try { if (window.SP && SP.renderSidebarSection){ var cl = document.getElementById('configList');
        if (cl) SP.renderSidebarSection(cl); } } catch(e){}
  try { if (window.ConnCenter && ConnCenter.render) ConnCenter.render(); } catch(e){}
  try { if (window.FonrVFS && FonrVFS.refreshTree) FonrVFS.refreshTree(); } catch(e){}
};

window.rpRefreshShares = function(force){
  var now = Date.now();
  var last = window.__rpSharesAt || 0;
  if (!force && (now - last) < 10000) return;      // 节流: 10s 内只拉一次
  if (window.__rpSharesInFlight) return;
  window.__rpSharesInFlight = true;
  window.__rpSharesAt = now;
  send({ action: 'share_list' }, function(d){
    window.__rpSharesInFlight = false;
    if (!d || d.status !== 'ok'){                  // 失败**如实记录**, 不静默(否则又是"看着在线")
      try { console.warn('[shares] share_list 失败:', (d && d.msg) || '无响应'); } catch(e){}
      window.__rpSharesAt = 0;                     // 失败不占用节流额度, 下次可立即重试
      return;
    }
    if (d.shares){ try { window.__sharesCache = d.shares.slice(); } catch(e){} }
    window._rpRerenderSidebars();
  });
};

window.setSrvTreeMode = function(m){
  var mode = (m === 'fixed') ? 'fixed' : 'groups';
  try {
    if (window.SrvTree && typeof SrvTree.setMode === 'function'){
      SrvTree.setMode(mode);              // 写偏好 + 广播 rp-tree-mode(三处各自重渲染)
    } else {
      try { localStorage.setItem('fonr_tree_mode', mode); } catch(e){}
      try { if (window.SP && SP.renderSidebar) SP.renderSidebar(); } catch(e){}
      try { if (window.ConnCenter && ConnCenter.renderGroupTree) ConnCenter.renderGroupTree(); } catch(e){}
      try { if (window.FonrVFS && FonrVFS.refreshTree) FonrVFS.refreshTree(); } catch(e){}
    }
  } catch(e){}
  window.syncTreeModeButtons(mode);
};

try {
  // SrvTree.setMode 会广播; 跟着同步按钮态(任何一处切换, 三处按钮都跟着亮)
  document.addEventListener('rp-tree-mode', function(ev){
    window.syncTreeModeButtons((ev && ev.detail && ev.detail.mode) || null);
  });
} catch(e){}
window.toggleSidebarGroup = function(el){
  try {
    var head = el;
    var body = head && head.nextElementSibling;
    if (!body) return;
    var hidden = body.style.display === 'none';
    body.style.display = hidden ? '' : 'none';
    var arrow = head.querySelector('.sb-group-arrow');
    if (arrow) arrow.textContent = hidden ? '▾' : '▸';
    var key = head.getAttribute('data-sbkey') || '';
    if (key){
      var st = {};
      try { st = JSON.parse(localStorage.getItem('rp_sb_groups') || '{}'); } catch(e){}
      st[key] = hidden ? 1 : 0;
      try { localStorage.setItem('rp_sb_groups', JSON.stringify(st)); } catch(e){}
    }
  } catch(e){}
};
window.restoreSidebarState = function(){
  try {
    var app = document.querySelector('.app') || document.body;
    // v5.90.10 · 一次性修复: v5.90.9 及以前"进多云/连接中心自动收起"会把 '1' 持久化进
    //   localStorage, 用户从未主动折叠过却被记住 → 左侧「⚡快速操作」栏默认不显示(用户报)。
    //   该污染只能修复一次(否则每次登录都会覆盖用户的真实折叠偏好), 用标记位保证只跑一次。
    //   v6.16.11 · 加 `rp_sidebar_user_set` 护栏: 用户显式设置过(设置页/折叠竖条)则**不抹**,
    //   否则"选启动时折叠 → 刷新被自愈抹成展开"(用户实测 .120)。
    var _userSet = false;
    try { _userSet = (localStorage.getItem('rp_sidebar_user_set') === '1'); } catch(e){}
    try {
      if (localStorage.getItem('rp_sidebar_autohide_repaired') !== '1'){
        if (!_userSet && localStorage.getItem('rp_sidebar_collapsed') === '1'){
          localStorage.setItem('rp_sidebar_collapsed', '0');
          window.__rpSidebarRepaired = true;      // 本次启动要强制展开一次
        }
        localStorage.setItem('rp_sidebar_autohide_repaired', '1');
      }
      // v6.3.1 · 第二轮自愈: 上一轮修复后仍有两个持久化污染源没堵住 ——
      //   fonrvfs 的全屏/预览收起走的是**非 transient** 的 toggleSidebarCollapse, 会把临时
      //   "收起"写成用户偏好(而 rp_sidebar_autohide_repaired 已用掉 → 再不自愈, 表现为
      //   "左侧服务器面板又不见了, 发生了好多次")。现在源头已改为具名 owner 且不持久化,
      //   这里用**新标记**再做一次清污, 让已被污染的浏览器恢复默认展开。
      if (localStorage.getItem('rp_sidebar_autohide_repaired_v631') !== '1'){
        if (!_userSet && localStorage.getItem('rp_sidebar_collapsed') === '1'){
          localStorage.setItem('rp_sidebar_collapsed', '0');
          window.__rpSidebarRepaired = true;
        }
        localStorage.setItem('rp_sidebar_autohide_repaired_v631', '1');
      }
    } catch(e){}
    // 临时态(页面级收起/硬隐藏)在每次启动都要清空 —— 它们不该跨会话存活
    try { window.sidebarResetTransient(); } catch(e){}
    if (localStorage.getItem('rp_sidebar_collapsed') === '1') window.toggleSidebarCollapse(true);
    else if (window.__rpSidebarRepaired) window.toggleSidebarCollapse(false);
    var st = {};
    try { st = JSON.parse(localStorage.getItem('rp_sb_groups') || '{}'); } catch(e){}
    document.querySelectorAll('[data-sbkey]').forEach(function(head){
      var k = head.getAttribute('data-sbkey');
      if (st[k] === 0 || st[k] === false) window.toggleSidebarGroup(head);  // 恢复收起
    });
  } catch(e){}
};

function wsUrl(){
  var p=location.protocol==='https:'?'wss://':'ws://';
  return p+location.host+'/ws';
}

// v4.40.0 · WS 心跳 + 自动重连 + 重连后共享/服务器状态刷新
// 背景: v4.39.4 前 WS 无心跳无重连, 网络抖动/proxy 空闲超时导致 WS 半开,
//       send() 30s 超时("加载超时(请检查 WS 连接)")且共享挂载状态失步。
// 方案: 25s ping/pong (2 周期无 pong 判死) -> 主动 close -> onclose 触发 3s 重连。
//       重连成功后自动 share_list 刷新 __dmDfMounts/__sharesCache 并通知三栏组件。
var _wsHeartbeatTimer = null;
var _wsPongTimeout = null;
var _wsMissedPongs = 0;
var _wsReconnectTimer = null;
var _wsReconnectAttempts = 0;

/* v5.99.1 · 「会话就绪门」+ 全局链路可用广播(用户报"刷新不出列表/点了没反应"的最后一环)
   背景(实测): WS 刚 open 时后端**还没登记会话**(登录 / 恢复会话尚未完成), 此时发业务请求
   会被直接拒掉 —— 手抓 WS 实测报 "请先登录（会话已丢失，请刷新后重新登录）"。
   面板在该时刻发出的 fonr_storages / conn_list 就这么被丢掉了, 而且旧代码**不再重试**,
   界面就一直空着(用户只能靠手动刷新页面)。这里: ① 会话未就绪时业务请求**等一下就发**,
   不猜、不丢; ② 就绪那一刻广播 `rp-ws-ready`, 让面板把空列表自动补拉回来。 */
window._wsReady = false;
window._rpUnreadyWhy = '';
function _rpWsReady(why){
  var was = window._wsReady;
  window._wsReady = true;
  window._rpUnreadyWhy = '';
  if (!was){
    try {
      window.dispatchEvent(new CustomEvent('rp-ws-ready', { detail: { why: why || '', at: Date.now() } }));
    } catch(_){}
    /* v6.3.5 · 就绪后立刻拉一次"网络共享真实挂载态" —— 左栏状态点要靠它才准
       (用户报"共享掉线了左侧还显示连接成功"; 此前这份真值只在**重连**时才拉, 首登没有) */
    try { if (window.rpRefreshShares) window.rpRefreshShares(true); } catch(_){}
    try { console.log('[ws] 会话就绪 (' + (why || '') + ') → 广播 rp-ws-ready'); } catch(_){}
    /* v6.3.17 · 上手指南: 就绪后自检一次(已完成/已隐藏的会话直接返回, 全部完成会自动收尾不再出现) */
    try { if (window.Onboarding && (window.__licFeatEdition || 'community') !== 'community')
            setTimeout(function () { window.Onboarding.show(); }, 1200); } catch(_){}   // v6.16.2 批21: 社区版不弹上手指南
  }
}
function _rpWsUnready(why){
  window._wsReady = false;
  window._rpUnreadyWhy = why || '';
}
function _rpIsSessionAction(a){
  return a === 'db_user_login' || a === 'db_restore_session' || a === 'db_logout'
      || a === 'login_pubkey' || a === 'ui_lang_get';
}
window._rpSessionInFlight = false;   // 登录 / 恢复会话请求是否在途
function _rpSendWhenReady(ws, data, maxWait, onFail){
  var act = (data && data.action) || '';
  /* v5.98.6 · 发送失败必须**报出来**(onFail), 不能静默吞掉:
     此前 `try{ws.send}catch(e){}` 会把"连接刚好被换掉/已关闭"的发送悄悄丢掉,
     调用方的 Promise 永远不 settle —— 界面上就是按钮一直显示"生成中…"、点了没反应
     (实测: 分享弹窗点『生成』后按钮 24s+ 卡在"生成中…", 服务端也没收到该请求)。 */
  var now = function(){
    /* SKIP-RAW-SEND-SWEEP: 本行就是就绪门自身的发送点(豁免, 不得再包一层, 否则无限递归) */
    try { ws.send(JSON.stringify(data)); return true; }   // ← 这就是就绪门自身的发送点(豁免, 不得再包一层)
    catch(e){
      try { console.warn('[ws] 发送失败:', (e && e.message) || e); } catch(_){}
      if (typeof onFail === 'function'){ try { onFail(e); } catch(_){} }
      return false;
    }
  };
  if (window._wsReady || _rpIsSessionAction(act)){ now(); return; }
  /* v6.3.5 · **未就绪一律先等一下, 不再"没在途会话请求就照发"**。
     实测(生产抓帧 + 控制台): 登录响应已回来(`_rpSessionInFlight=false`)但**服务端会话还没登记**,
     这一瞬间发出的业务请求会被逐条拒掉("请先登录(会话已丢失)") —— 日志里能看到同一个
     `share_list` 被拒 7 次、每次都会再排一次"等就绪重发", 而回调在极端时序下**悬空到超时**
     (用户感受: "WS 老出问题 / 列表半天不出来")。现在: 未就绪就把请求**压住**(默认最多 3s),
     到点仍未就绪才照发 —— 那种情况后端会给出真实拒绝, 由上面的重试路径兜底。 */
  var waited = 0, step = 150, limit = maxWait || 3000;
  var t = setInterval(function(){
    waited += step;
    if (window._wsReady || waited >= limit){
      clearInterval(t);
      now();
    }
  }, step);
  return t;
}
/* 会话未就绪导致的拒绝(如「请先登录（会话已丢失）」) → 等就绪后**重发一次**(最多一次, 不无限重试) */
function _rpIsSessionLost(d){
  if (!d) return false;
  var m = (typeof d.msg === 'string') ? d.msg : '';
  return m.indexOf('请先登录') >= 0 || m.indexOf('会话已丢失') >= 0 || m.indexOf('会话过期') >= 0;
}
window._rpRetryAfterReady = function(fn, maxWait, onTimeout){
  var waited = 0, step = 200, limit = maxWait || 10000;
  var t = setInterval(function(){
    waited += step;
    if (window._wsReady || waited >= limit){
      clearInterval(t);
      if (window._wsReady){ try { fn(); } catch(e){} }
      else if (typeof onTimeout === 'function'){     // 到点还没就绪 → 把原始失败交回调用方, 绝不吞掉请求
        try { onTimeout(); } catch(e){}
      }
    }
  }, step);
  return t;
};

/* v5.95.0 · 心跳重做(用户报"左上角经常显示断开/连接"):
   旧实现只把 `type:'pong'` 当存活 —— 而**任何**收到的帧都说明链路是活的(日志/进度/事件推送都算),
   结果一有别的帧就误判; 且 2 个周期(50s)无 pong 就杀连接重连 → 左上角反复"断开/连接"。
   现在: ① 任一帧都刷新 `_wsLastMsgAt`; ② 空闲 ≥20s 才发 ping 探活; ③ **彻底无声 ≥60s 且有 3 次 ping 无回** 才判死;
        ④ 判死前先把状态切到"重连中"(橙), 不再先闪一下"已断开"(红)。 */
var _wsLastMsgAt = 0;
function _wsBeaconSign(ts){ _wsLastMsgAt = ts || Date.now(); _wsMissedPongs = 0; }
/* v5.96.0 · 连接状态可视化(用户要求): 把三态 + 最近心跳 RTT + 断开原因做成可查的诊断信息,
   以后遇到"断开/重连"能一眼判断是网络、代理空闲超时还是会话过期。 */
window._wsRtt = null;             // 最近一次 ping/pong 往返(ms)
window._wsRttAvg = null;          // 平滑平均 RTT
window._wsLastPongAt = 0;         // 最近一次 pong 时间
window._wsMissStreak = 0;         // 连续 miss 次数(判死用)
window._wsLastCloseAt = 0;        // 最近一次连接关闭时间
window._wsLastCloseReason = '';   // 人话原因
window._wsReconnects = 0;         // 本次会话重连成功次数
window._wsLastRestore = '';       // 会话恢复结果(最近一次)
/* v5.97.0 · WS 断开/重连**自动记录**(用户要求: 偶发断线要能事后复盘, 而不是只能靠当时看着):
   每次 断开/重连成功/会话过期 都记一条(时间, 原因, 当时 RTT, 丢包数, 断开时长, 重连次数),
   落 localStorage(最近 60 条) → 刷新/重启后仍可查, 并在连接诊断面板里成表展示。 */
window._wsDiag = [];
var WS_DIAG_MAX = 100;
function _wsDiagPush(evt){
  try {
    var rec = Object.assign({ t: Date.now() }, evt || {});
    window._wsDiag.push(rec);
    if (window._wsDiag.length > WS_DIAG_MAX){
      window._wsDiag.splice(0, window._wsDiag.length - WS_DIAG_MAX);
    }
    try { localStorage.setItem('ws_diag_log', JSON.stringify(window._wsDiag.slice(-60))); } catch(_){}
    return rec;
  } catch(e){ return null; }
}
function _wsDiagLoad(){
  try {
    var raw = JSON.parse(localStorage.getItem('ws_diag_log') || '[]');
    if (Array.isArray(raw)) window._wsDiag = raw;
  } catch(e){}
}
function _wsDiagClear(){
  window._wsDiag = [];
  try { localStorage.removeItem('ws_diag_log'); } catch(_){}
}
// v6.3.27 · 主题化确认 (原为 inline onclick 里的原生 confirm, 棘轮回填)
function _wsDiagClearAsk(){
  rpConfirm({ title:'清空 WS 诊断记录', danger:true, okText:'清空',
    body:'清空后本机保存的断开/重连记录将不再显示（不影响服务端日志）。' }).then(function(ok){
    if (ok){ _wsDiagClear(); renderConnStatusPanel(); }
  });
}
function _wsDiagAgo(t){
  if (!t) return '-';
  var s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return s + ' 秒前';
  if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
  if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
  return Math.floor(s / 86400) + ' 天前';
}
_wsDiagLoad();

/* v5.97.3 · A2 断线诊断包导出(用户要求: 从"能看"变成"能带走")
   一键把「客户端诊断 + 断开记录 + 服务端操作日志(含 [ws] 生命周期) + 排查提示」导成一个 txt,
   偶发断线时直接发给开发/运维复盘, 不用再靠现场描述。 */
function _fetchOpLogs(limit){
  return new Promise(function(res){
    var done = false;
    var t = setTimeout(function(){ if (!done){ done = true; res(null); } }, 9000);
    try {
      send({ action: 'get_logs', limit: limit || 300 }, function(d){
        if (done) return;
        done = true; clearTimeout(t);
        res((d && d.records) || []);
      });
    } catch(e){ if (!done){ done = true; clearTimeout(t); res(null); } }
  });
}
async function exportWsDiag(){
  var L = [];
  function p(k, v){ L.push(k + ': ' + (v === undefined || v === null || v === '' ? '-' : v)); }
  var now = new Date();
  L.push('=== Fonriv 链路诊断包 ===');
  p('导出时间', now.toLocaleString() + '  (' + now.toISOString() + ')');
  p('页面版本', window.RP_VERSION || '-');
  p('地址', location.origin + location.pathname);
  p('连接状态', window._wsStatus || '-');
  p('心跳 RTT(最近/平滑平均)', (window._wsRtt != null ? window._wsRtt + ' ms' : '尚未采样')
      + ' / ' + (window._wsRttAvg != null ? window._wsRttAvg + ' ms' : '-'));
  p('重连成功次数', window._wsReconnects || 0);
  p('连续丢包', (typeof _wsMissedPongs !== 'undefined' ? _wsMissedPongs : '-'));
  p('最近断开原因', window._wsLastCloseReason || '无记录');
  p('最近断开时间', window._wsLastCloseAt ? new Date(window._wsLastCloseAt).toLocaleString() : '无记录');
  p('本次连接建立', window._wsOpenedAt
      ? (new Date(window._wsOpenedAt).toLocaleString() + ' (已存活 ' + Math.round((Date.now() - window._wsOpenedAt) / 1000) + 's)') : '-');
  p('页面在线时长', Math.round(performance.now() / 1000) + ' s');
  p('浏览器', navigator.userAgent || '-');
  p('平台/语言', (navigator.platform || '-') + ' / ' + (navigator.language || '-'));
  try { p('时区', Intl.DateTimeFormat().resolvedOptions().timeZone || '-'); } catch(e){}
  p('屏幕', screen.width + 'x' + screen.height + ' (dpr ' + (window.devicePixelRatio || 1) + ')');
  try {
    var c = navigator.connection || navigator.mozConnection || {};
    p('网络探测', (c.effectiveType || '-') + ' · 下行 ' + (c.downlink != null ? c.downlink + 'Mbps' : '-')
                 + ' · 估算 RTT ' + (c.rtt != null ? c.rtt + 'ms' : '-'));
  } catch(e){}
  L.push('');
  L.push('=== 断开 / 重连记录 (最近在前, 共 ' + (window._wsDiag || []).length + ' 条) ===');
  (window._wsDiag || []).slice().reverse().forEach(function(r){
    L.push('  ' + new Date(r.t).toLocaleString() + '  | ' + (r.kind || '-')
           + ' | ' + (r.reason || '-')
           + ' | code=' + (r.code == null ? '-' : r.code)
           + ' | RTT=' + (r.rtt == null ? '-' : r.rtt + 'ms') + '/' + (r.rttAvg == null ? '-' : r.rttAvg + 'ms')
           + ' | 丢包=' + (r.miss == null ? '-' : r.miss)
           + ' | 本次存活=' + (r.upSec == null ? '-' : r.upSec + 's')
           + ' | 掉线时长=' + (r.downMs == null ? '-' : Math.round(r.downMs / 1000) + 's'));
  });
  L.push('');
  L.push('=== 服务端操作日志 (data/fonriv_operations.log 尾部) ===');
  var recs = await _fetchOpLogs(300);
  if (!recs){
    L.push('  (取服务端日志失败或被超时中断)');
  } else {
    var txts = recs.map(function(r){ return (r && (r.time || '') ) + ' | ' + (r && (r.content || '')) ; });
    var wsL = txts.filter(function(s){ return s.indexOf('[ws]') >= 0; });
    L.push('  [WS 生命周期相关 共 ' + wsL.length + ' 条, 显示最近 60 条]');
    wsL.slice(-60).forEach(function(s){ L.push('    ' + s); });
    L.push('  [全量最近 80 条]');
    txts.slice(-80).forEach(function(s){ L.push('    ' + s); });
  }
  L.push('');
  L.push('=== 排查提示 ===');
  L.push('  · 多条「心跳超时」且间隔≈60s → 反向代理空闲超时(nginx proxy_read_timeout 默认 60s), 建议调到 ≥120s');
  L.push('  · 「连接异常断开 code 1006」且掉线时间长 → 网络/链路中断');
  L.push('  · 「会话失效」→ 登录过期, 或服务端重启(会话保存在内存)');
  L.push('  · 服务端侧对照: 看 [ws] disconnect 行(用户 / 存活秒数 / 最后动作 / 是否已登录)');
  var txt = L.join('\n');
  try {
    var blob = new Blob([txt], { type: 'text/plain;charset=utf-8' });
    var a = document.createElement('a');
    var stamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
    a.href = URL.createObjectURL(blob);
    a.download = 'fonriv_wsdiag_' + stamp + '.txt';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function(){ try { URL.revokeObjectURL(a.href); } catch(e){} }, 5000);
    try { addLog('已导出链路诊断包: ' + a.download + ' (' + Math.round(txt.length / 1024) + ' KB)', 'success'); } catch(e){}
    if (typeof toast === 'function') toast('已导出链路诊断包: ' + a.download, 'success', 6000);
  } catch(e){
    try { addLog('导出诊断包失败: ' + e, 'error'); } catch(_){}
    if (typeof toastErr === 'function') toastErr('导出诊断包失败: ' + e);
  }
  return txt;
}
window.exportWsDiag = exportWsDiag;

function _wsRttNote(){
  var r = window._wsRtt;
  if (r == null) return '尚未采样';
  return r + ' ms' + (window._wsRttAvg ? (' (平均 ' + window._wsRttAvg + ' ms)') : '');
}
function _startWsHeartbeat(ws){
  try { clearInterval(_wsHeartbeatTimer); clearTimeout(_wsPongTimeout); } catch(_){}
  _wsMissedPongs = 0;
  _wsBeaconSign();
  var _hbHandler = function(ev){
    try {
      var d = JSON.parse(ev.data);
      if (d && d.type === 'pong' && window._wsPingSentAt){
        var rtt = Date.now() - window._wsPingSentAt;
        window._wsPingSentAt = 0;
        window._wsRtt = rtt;
        window._wsRttAvg = (window._wsRttAvg == null) ? rtt : Math.round(window._wsRttAvg * 0.7 + rtt * 0.3);
        window._wsLastPongAt = Date.now();
        window._wsMissStreak = 0;
      }
      _wsBeaconSign();
    } catch(e){ _wsBeaconSign(); }
  };
  ws.addEventListener('message', _hbHandler);
  _wsHeartbeatTimer = setInterval(function(){
    if (ws.readyState !== WebSocket.OPEN){
      try { clearInterval(_wsHeartbeatTimer); } catch(_){}
      return;
    }
    var idle = Date.now() - (_wsLastMsgAt || 0);
    if (idle < 20000) return;                     // 最近 20s 有过任何帧 → 链路是活的, 不必打扰
    if (_wsMissedPongs >= 3 && idle >= 60000){
      // 彻底无声: 60s 无任何帧 + 3 次 ping 无回 → 判定死亡, 主动关掉走重连
      try { if (typeof updateGlobalConnStatus === 'function') updateGlobalConnStatus('reconnecting'); } catch(_){}
      try { ws.close(); } catch(_){}
      return;
    }
    _wsMissedPongs++;
    window._wsMissStreak = _wsMissedPongs;
    if (_wsMissedPongs >= 2){
      try { if (typeof updateGlobalConnStatus === 'function') updateGlobalConnStatus('checking'); } catch(_){}
    }
    try { window._wsPingSentAt = Date.now(); ws.send(JSON.stringify({action:'ping'})); } catch(_){}
  }, 15000);
}
/* 发送超时/疑似半死时做一次快速探活: 4s 内没有 pong 就强制重连(不再让界面干等 30s) */
function _wsHealthCheck(){
  var ws = currentWs;
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  try {
    ws.send(JSON.stringify({action:'ping'}));
    return true;
  } catch(e){ return false; }
}

/* v5.95.0 · 会话失效(未登录/过期)处理:
   后端现在会明确回 `code:'unauthenticated'`(此前是**静默丢弃** → 客户端只能等 30s 超时,
   表现为"界面全卡、心跳收不到 pong、每 50s 断开重连一次、左上角反复闪")。
   这里收到后: ① 带 token 自动恢复一次(最多 3 次, 4s 节流); ② 仍失败 → 状态置"登录已过期"并提示重新登录。 */
var _wsUnauthTries = 0, _wsUnauthAt = 0;
function _wsUnauthTap(ev){
  try {
    var d = JSON.parse(ev.data);
    if (!d || d.type !== 'result' || d.code !== 'unauthenticated') return;
    var now = Date.now();
    if (now - _wsUnauthAt < 4000) return;              // 一批并发请求只处理一次
    _wsUnauthAt = now;
    var tok = localStorage.getItem('auth_token');
    if (tok && _wsUnauthTries < 3){
      _wsUnauthTries++;
      try { currentWs.send(JSON.stringify({action:'db_restore_session', token: tok})); } catch(e){}
      try { addLog('检测到会话失效, 已尝试自动恢复 (' + _wsUnauthTries + '/3)', 'warn'); } catch(e){}
      return;
    }
    try { if (typeof updateGlobalConnStatus === 'function') updateGlobalConnStatus('expired'); } catch(e){}
    try {
      _wsDiagPush({ kind: 'expired', reason: '会话失效且自动恢复失败', rtt: window._wsRtt });
      addLog('登录会话已失效(恢复失败) · 请重新登录', 'err');
    } catch(e){}
    try { if (window.showLoginOverlay) window.showLoginOverlay(); } catch(e){}
  } catch(e){}
}

/* v5.97.0 · 断开记录**必须可靠**: 原先记在 ws.onclose 包装里, 但 openWs 之后还会自己赋 onclose
   (两处顺序由 setTimeout/promise 决定, 实测会互相覆盖 → 断开有时记不上, 复盘就断了)。
   改为 addEventListener('close') 独立绑定 —— 与 onclose 并存, 谁覆盖都不影响记录。
   _wsNoteClose 幂等(同一事件只记一次), 两条路径都调它也不会重复。 */
function _wsNoteClose(ev){
  try {
    if (ev && ev.__wsDiagNoted) return;
    if (ev) { try { ev.__wsDiagNoted = true; } catch(_){} }
    window._wsLastCloseAt = Date.now();
    if (_wsMissedPongs >= 3) window._wsLastCloseReason = '心跳超时(网络中断, 或反向代理空闲超时掐断)';
    else if (ev && ev.code === 1000) window._wsLastCloseReason = '服务端正常关闭(多为服务重启)';
    else if (ev && ev.code === 1006) window._wsLastCloseReason = '连接异常断开(网络/代理)';
    else window._wsLastCloseReason = '连接关闭' + (ev && ev.code ? (' (code ' + ev.code + ')') : '');
    var _up = window._wsOpenedAt ? Math.round((Date.now() - window._wsOpenedAt) / 1000) : null;
    _wsDiagPush({ kind: 'disconnect', reason: window._wsLastCloseReason,
                  code: (ev && ev.code != null) ? ev.code : null,
                  rtt: window._wsRtt, rttAvg: window._wsRttAvg,
                  miss: _wsMissedPongs, upSec: _up });
    try { addLog('🔌 WebSocket 断开: ' + window._wsLastCloseReason
                 + ' · 本次连接存活 ' + (_up != null ? (_up + 's') : '?')
                 + ' · 断开前 RTT ' + _wsRttNote(), 'warn'); } catch(_){}
  } catch(_){}
}
function _wsArmCloseDiag(ws){
  try { ws.addEventListener('close', _wsNoteClose); } catch(_){}
}

function _armWsReconnect(ws){
  // 每个新 ws 覆盖旧的 onclose 链 (openWs 内部稍后也会赋 onclose, 这里在之后绑定)
  setTimeout(function(){
    var _origOnClose = ws.onclose;
    ws.onclose = function(ev){
      try { if (typeof _origOnClose === 'function') _origOnClose(ev); } catch(_){}
      try { _rpWsUnready('closed'); } catch(_){}
      try { window._rpSessionInFlight = false; } catch(_){}
      try { clearInterval(_wsHeartbeatTimer); } catch(_){}
      try { clearTimeout(_wsPongTimeout); } catch(_){}
      // 登录状态下才重连 (未登录页面刷新没有意义)
      var tok = localStorage.getItem('auth_token');
      if (!tok) return;
      try { clearTimeout(_wsReconnectTimer); } catch(_){}
      // v5.95.0 · 断开期间状态一律显示"重连中"(橙) —— 只有彻底放弃才置红, 避免左上角闪"已断开"
      try { if (typeof updateGlobalConnStatus === 'function') updateGlobalConnStatus('reconnecting'); } catch(_){}
      // v5.96.0/v5.97.0 · 记录断开原因 + 自动记录(幂等, 与 addEventListener 版本共用)
      try { _wsNoteClose(ev); } catch(_){}
      var _reconnect = function(){
        _wsReconnectAttempts++;
        openWs(function(newWs){
          _wsReconnectAttempts = 0;
          window._wsReconnects = (window._wsReconnects || 0) + 1;
          // v5.97.0 · 重连成功也记一条(含断开时长, 便于判断"是闪断还是长时间掉线")
          try {
            var _down = window._wsLastCloseAt ? (Date.now() - window._wsLastCloseAt) : null;
            _wsDiagPush({ kind: 'reconnect', downMs: _down, reason: window._wsLastCloseReason || '' });
            try { addLog('✅ WebSocket 已重连' + (_down != null ? ('（掉线 ' + Math.round(_down/1000) + 's）') : '')
                         + (window._wsLastCloseReason ? (' · 上次原因: ' + window._wsLastCloseReason) : ''), 'ok'); } catch(_){}
          } catch(_){}
          console.log('[ws] reconnected (attempt ok)');
          _wsBeaconSign();
          _onWsReconnected();
        }).catch(function(err){
          console.warn('[ws] reconnect fail:', err && err.message);
          if (_wsReconnectAttempts < 20){
            var _wait = Math.min(2000 * _wsReconnectAttempts, 30000) + Math.floor(Math.random() * 800);
            try { clearTimeout(_wsReconnectTimer); } catch(_){}
            _wsReconnectTimer = setTimeout(_reconnect, _wait);      // 退避 + 抖动(避免多标签同时重连打服务器)
          } else {
            try { if (typeof updateGlobalConnStatus === 'function') updateGlobalConnStatus('disconnected'); } catch(_){}
            try { addLog('WebSocket 多次重连失败 · 请检查服务是否运行, 或刷新页面', 'err'); } catch(_){}
          }
        });
      };
      _wsReconnectTimer = setTimeout(_reconnect, 2000);
    };
  }, 50);
}

// v4.40.0 · WS 重连成功后: 刷新共享挂载状态 (共享持久挂载, 后端不会因断线卸载)
function _onWsReconnected(){
  try {
    if (typeof send !== 'function') return;
    // v5.51.0 · P1-7: 重连后按 seq 游标补拉错过的变更 (事件总线断线补偿)
    try {
      if (window.EventBus && typeof window.EventBus._replay === 'function'){
        window.EventBus._replay();
      }
    } catch(_){}
    // share_list 返回 shares + df_mounts -> 更新 __sharesCache/__dmDfMounts (与 _syncDfMountsGlobal 同源)
    send({ action: 'share_list' }, function(d){
      if (d && d.shares){ try { window.__sharesCache = d.shares.slice(); } catch(_){} }
      // v6.3.5 · 拿到真值后**立刻重渲染左栏**(状态点按真实挂载态上色 —— 用户报
      //   "网络共享掉线了左侧还显示连接成功", 根因就是这一份真值没被用上/没被刷新)
      try { window._rpRerenderSidebars && window._rpRerenderSidebars(); } catch(_){}
      if (d && d.df_mounts){
        var SR = '/var/lib/fonriv_mounts/shares/';
        var existing = window.__dmDfMounts || { host: '127.0.0.1', ts: 0, mounts: [] };
        var keep = [];
        (existing.mounts || []).forEach(function(m){
          if (m && m.mount && m.mount.indexOf(SR) === 0) return;
          keep.push(m);
        });
        (d.df_mounts || []).forEach(function(m){
          if (m && m.mount) keep.push({ mount: m.mount, source: m.source||'', avail: m.avail||'', use_pct: m.use_pct||'' });
        });
        window.__dmDfMounts = { host: '127.0.0.1', ts: Date.now(), mounts: keep };
        // 刷新两个页面的三栏 df/共享下拉
        try { if (window.TriPaneTransfer && window.TriPaneTransfer.refreshServers) window.TriPaneTransfer.refreshServers(); } catch(_){}
        try {
          if (window._triInstances){
            for (var k in window._triInstances){
              var tri = window._triInstances[k];
              if (tri && typeof tri.refreshServers === 'function') tri.refreshServers();
            }
          }
        } catch(_){}
      }
    });
  } catch(e){ console.warn('[ws] reconnect refresh fail', e); }
}


var _wsPendingPromise = null;      // v5.98.1 · 连接**单飞**: 同一时刻只允许有一个在建连接

function openWs(callback){
  if(currentWs&&currentWs.readyState===WebSocket.OPEN){
    if(callback)callback(currentWs);
    return Promise.resolve();
  }
  /* v5.98.1 · 单飞(实测定位到的"WS 不稳定/面板刷新不出列表"真根因之一):
     旧实现 currentWs 只在 onopen 时才赋值, 而启动阶段有一堆**并发**调用者
     (各面板 init / license / ui_lang_get / EventBus 十余个订阅) 同时进 openWs,
     每个都看到「还没有 OPEN 的连接」→ 各自 new 一个 WebSocket。
     抓帧实测: 一次登录 1 秒内开了 **14 个** socket, 随后是 CLOSE 1006 风暴;
     请求若落在被关掉的那个 socket 上就永远等不到响应(用户看到的就是"面板空着, 刷新一次才好"),
     浏览器还会因并发连接过多直接拒连(Chrome: Insufficient resources)。
     现在: 同一个在建连接只建一次, 后来者**等它**(而不是再造一个)。 */
  if(_wsPendingPromise){
    return _wsPendingPromise.then(function(){
      if(callback && currentWs) callback(currentWs);
      return currentWs;
    });
  }
  // v5.87.0 · 半开/僵尸连接清理: currentWs 停在 CONNECTING/CLOSING 时直接关掉,
  //   否则它稍后 onclose 会把新连接的引用搅乱(登录"WebSocket 连接超时"的诱因之一)
  if(currentWs){ try{ currentWs.onclose=null; currentWs.close(); }catch(e){} currentWs=null; }
  // v5.87.0 · 超时自动重试一次(服务重启/瞬时繁忙时 10s 一次太脆, 用户报登录即超时)
  var _attempt = function(){
    return new Promise(function(resolve,reject){
      var ws=new WebSocket(wsUrl());
      _wsArmCloseDiag(ws);      // v5.97.0 · 断开记录独立绑定, 不会被后续 onclose 赋值覆盖
      var timed=false;
      var timer=setTimeout(function(){
        timed=true; ws.close();
        reject(new Error('WebSocket 连接超时'));
      },10000);
    ws.onopen=function(){
      clearTimeout(timer);
      currentWs=ws;
      /* v5.98.9 · 新 socket 打开 = 它的会话**还没登记**(要么等 db_restore_session, 要么等登录)。
         不把"就绪"当作全局且跨 socket 的状态: 否则上一个 socket 的登录/恢复把 `_wsReady` 置真后,
         发到**新 socket** 上的业务请求仍会被后端拒(`请先登录（会话已丢失）`) —— 这正是用户报
         「列表刷不出来、点了没反应」的最后一环(实测 hub_nodes 直接被拒)。 */
      try { _rpWsUnready('ws_open'); } catch(_){}
      window._wsOpenedAt = Date.now();
      window.ws = ws; // v4.15.0-alpha3 · 暴露给 dashboard widget
      window._lastWsMsg = new Date().toLocaleTimeString() + ' (open)';
      // v4.40.0 · WS 心跳: 25s ping, 2 周期无响应判死 -> 主动关闭触发重连
      _startWsHeartbeat(ws);
      // v4.40.0 · WS 重连: 意外断开 -> 延迟 3s 自动重建 (登录会话用 token 自动恢复)
      _armWsReconnect(ws);
      // v2.6.4: 新 WS 打开时立即用 localStorage token 恢复后端会话
      // v2.6.7 修复：安装一次性 handler 消费 restore 响应，避免污染后续 send() 回调
      var tok = localStorage.getItem('auth_token');
      if(tok){
        var restoreHandler = function(ev){
          try{
            var d = JSON.parse(ev.data);
            // restore 响应的独特签名：msg 含"会话已恢复"或"会话恢复失败"
            if(d && d.type === 'result' && typeof d.msg === 'string' &&
               (d.msg.indexOf('会话已恢复') >= 0 || d.msg.indexOf('会话恢复失败') >= 0)){
              ws.removeEventListener('message', restoreHandler);
              // 记录权限（若后端返回了）供刷新场景使用
              if(d.status === 'ok' && d.permissions && typeof currentUser === 'object' && currentUser){
                currentUser.permissions = d.permissions;
              }
              try { window._wsLastRestore = (d.status === 'ok' ? '成功' : '失败') + ' · ' + new Date().toLocaleTimeString(); } catch(_){}
              window._rpSessionInFlight = false;
              if (d.status === 'ok') {
                try { _rpWsReady('restore'); } catch(_){}
                try { window._rpSessionLostCount = 0; window._rpSessionLostTold = false; } catch(_){}
              }
              else {
                /* v5.98.2 · 会话恢复失败要**可见**: 此前只在日志里留一句, 界面照旧,
                   用户看到的是"列表空的/点了没反应"(实测该连接之后的业务请求都会被拒)。 */
                try { _rpWsUnready('restore_failed'); } catch(_){}
                try { _wsDiagPush({ kind: 'restore_fail', reason: '会话恢复失败（令牌无效/已失效）' }); } catch(_){}
                try {
                  addLog('登录会话已失效(恢复失败) · 该连接上的请求会被拒绝, 请重新登录或刷新页面', 'err');
                } catch(_){}
                try {
                  if (!window._rpRestoreFailTold){
                    window._rpRestoreFailTold = true;
                    setTimeout(function(){ window._rpRestoreFailTold = false; }, 60000);
                    if (window.toast) toast('登录会话已失效（恢复失败）· 请重新登录或刷新页面', 'err', 8000);
                  }
                } catch(_){}
              }
            }
          }catch(e){}
        };
        ws.addEventListener('message', restoreHandler);
        try {
          window._rpSessionInFlight = true;          // v5.98.1 · 恢复会话请求在途
          ws.send(JSON.stringify({action:'db_restore_session', token: tok}));
        } catch(e){}
      }
      // v2.6.8: 全局 log tap —— 把后端 type=log 事件加到传输日志面板
      ws.addEventListener('message', _wsUnauthTap);   // v5.95.0 · 会话失效 → 自动恢复/明确提示
      _wsUnauthTries = 0;
      var logTap = function(ev){
        try{
          // v4.15.0-alpha3 · 打时间戳 · dashboard widget 用
          window._lastWsMsg = new Date().toLocaleTimeString();
          var d = JSON.parse(ev.data);
          if(d && d.type === 'log' && d.msg){
            addLog(d.msg, d.level || 'info');
          }
        }catch(e){}
      };
      ws.addEventListener('message', logTap);
      // v4.16.0 · 事件推流 tap — 后端 publish 的 {type:"event", topic, payload}
      var eventTap = function(ev){
        try{
          var d = JSON.parse(ev.data);
          if(d && d.type === 'event' && d.topic){
            if(window.EventBus && typeof window.EventBus._dispatch === 'function'){
              window.EventBus._dispatch(d.topic, d.payload);
            }
          }
        }catch(e){}
      };
      ws.addEventListener('message', eventTap);
      // v4.27.0 · task_log_push 增量流 tap（供事件抽屉 tail -f）
      var logPushTap = function(ev){
        try{
          var d = JSON.parse(ev.data);
          if(d && d.type === 'task_log_push' && d.task_id){
            if(window.EventHistory && typeof window.EventHistory._onLogPush === 'function'){
              window.EventHistory._onLogPush(d);
            }
          }
        }catch(e){}
      };
      ws.addEventListener('message', logPushTap);
      // 重连后重放订阅
      try {
        if(window.EventBus && typeof window.EventBus._resubscribe === 'function'){
          window.EventBus._resubscribe();
        }
      } catch(e){ console.warn('[EventBus] resubscribe fail', e); }
      if(callback)callback(ws);
      resolve();
    };
    ws.onclose=function(){
      clearTimeout(timer);
      // v4.96.0 · 修复: 旧 socket 关闭会把「当前」socket 引用一起清空
      //   (切 tab 期间 openWs 可能已建立新连接, 旧连接 onclose 却把 currentWs 置 null,
      //    导致随后的目录/预览请求发到已死 socket 上永久等待)
      if(!timed && currentWs === ws){currentWs=null;}
      if(typeof updateGlobalConnStatus === 'function') updateGlobalConnStatus('disconnected');
    };
    ws.onerror=function(){
      clearTimeout(timer);
      if(!timed){
        currentWs=null;
        reject(new Error('WebSocket 连接失败 - 请确认服务器正在运行'));
      }
      if(typeof updateGlobalConnStatus === 'function') updateGlobalConnStatus('error');
    };
    });
  };
  var _chain = _attempt().catch(function(err){
    if(err && err.message && err.message.indexOf('连接超时') >= 0 && !window._wsRetryOnce){
      // v5.87.0 · 超时后 1.2s 自动重试一次 (服务重启窗口/瞬时繁忙), 仍失败才报给上层
      window._wsRetryOnce = true;
      return new Promise(function(r2, j2){
        setTimeout(function(){
          var _done = function(){ setTimeout(function(){ window._wsRetryOnce = false; }, 3000); };
          _attempt().then(function(v){ _done(); r2(v); }, function(e){ _done(); j2(e); });
        }, 1200);
      });
    }
    throw err;
  }, null).then(null, function(err){
    if(err && err.message && err.message.indexOf('连接超时') >= 0){
      err.message = 'WebSocket 连接超时（已自动重试一次）· 服务可能正在重启，请稍候再试';
    }
    throw err;
  });
  // v5.98.1 · 单飞收口: 把这次连接尝试交出去, 结束(成功或失败)即释放, 后来者复用同一次
  _wsPendingPromise = _chain;
  var _wsPendingRelease = function(){ if(_wsPendingPromise === _chain) _wsPendingPromise = null; };
  _chain.then(_wsPendingRelease, _wsPendingRelease);
  return _chain;
}

// ============================================
// 通用 WebSocket 发送函数
// ============================================
// 面板 ID 映射
var PANEL_ID = null; // 当前活跃面板
function getPanelLog(prefix){
  return document.getElementById(prefix+'LogPanel');
}
function getPanelBar(prefix){
  return document.getElementById(prefix+'ProgressBar');
}
function getPanelText(prefix){
  return document.getElementById(prefix+'ProgressText');
}
function addPanelLog(prefix, msg, level){
  var panel = getPanelLog(prefix);
  if(!panel) return;
  panel.classList.add('visible');
  var cls = 'log-line';
  if(level==='success') cls+=' log-success';
  else if(level==='error') cls+=' log-error';
  else if(level==='warn'||level==='warning') cls+=' log-warn';
  else if(level==='dim') cls+=' log-dim';
  else cls+=' log-info';
  var line = document.createElement('div');
  line.className = cls;
  line.textContent = msg;
  panel.appendChild(line);
  panel.scrollTop = panel.scrollHeight;
}
function setPanelProgress(prefix, pct, text){
  var bar = getPanelBar(prefix);
  if(bar){ bar.style.width = Math.min(pct,100)+'%'; }
  // Also update percentage text element (e.g. abProgressPct)
  var pctEl = gvEl(prefix+'ProgressPct') || gvEl(prefix+'ProgressPerc');
  if(pctEl) pctEl.textContent = Math.round(pct)+'%';
  if(text){
    var txt = getPanelText(prefix);
    if(txt) txt.textContent = text;
  }
}
function getPanelPrefix(action){
  var map = {
    'scan_lvm':'lvm','export_lvm':'lvm','test_lvm':'lvm',
    'scan_pbs':'pbs','scan_pbs_detail':'pbs','pbs_restore':'pbs','test_pbs':'pbs',
    'scan_zfs':'zfs','export_zfs':'zfs','test_zfs':'zfs',
    'scan_rbd':'rbd','export_rbd':'rbd','test_rbd':'rbd',
    'auto_backup':'ab','auto_restore_detect':'ab','auto_restore_compare':'ab',
    'auto_restore':'ab','auto_restore_browse':'ab','auto_restore_item':'ab'
  };
  return map[action] || null;
}

// v2.6.4: 全局连接状态管理
// - WS 状态：open / disconnected / error
// - 各面板 SSH 状态：记录到 window._panelConnStatus[prefix] = {status, host, msg, ts}
// - 顶部胶囊显示 WS 状态；点击弹出详细面板列出每个 SSH 连接
window._panelConnStatus = window._panelConnStatus || {};
window._wsStatus = 'unknown';

function updateGlobalConnStatus(status){
  window._wsStatus = status;
  var dot = document.getElementById('globalConnDot');
  var txt = document.getElementById('globalConnText');
  if(!dot || !txt) return;
  var color = 'var(--text3)', label = '未连接';
  if(status === 'open'){ color = 'var(--green)'; label = '已连接'; }
  else if(status === 'disconnected'){ color = 'var(--red)'; label = '已断开'; }
  else if(status === 'error'){ color = 'var(--red)'; label = '连接错误'; }
  else if(status === 'expired'){ color = 'var(--red)'; label = '登录已过期 · 请重新登录'; }
  // v5.95.0 · 重连中/检测中: 橙色 + 文字, 与"已断开"区分(用户报左上角反复闪"断开/连接")
  else if(status === 'reconnecting'){ color = 'var(--orange)'; label = '重连中…'; }
  else if(status === 'checking'){ color = 'var(--orange)'; label = '链路检测中…'; }
  else if(status === 'restoring'){ color = 'var(--orange)'; label = '恢复中...'; }
  dot.style.background = color;
  dot.style.boxShadow = '0 0 6px ' + color;
  /* v1.0.0 · 用户要求: 左上角只保留一个圆点, 状态变化**不改尺寸/不撑出文字**(此前"重连中…/链路检测中…"
     会插入文字 → 元素变宽变高, 视觉上"乱跳"), 详情一律走点击弹层 + title 悬浮提示。 */
  txt.textContent = '';
  txt.style.display = 'none';
  var wrap = document.getElementById('globalConnStatus');
  if (wrap){
    wrap.style.padding = '3px 6px';
    wrap.style.border = '1px solid transparent';
    wrap.style.background = 'transparent';
    wrap.title = 'WS: ' + label + ' · 心跳 RTT: ' + _wsRttNote() + ' · 点击查看详细连接状态';
  }
  // v5.34.4 · P4: WS 恢复后交给 SP 叠加会话数显示 (N 会话)
  try{ if(window.SP && window.SP.renderCapsule) window.SP.renderCapsule(); }catch(e){}
}

// 记录/更新某个面板的 SSH 连接状态（供 test_xxx / scan_xxx 调用后同步）
function recordPanelConnStatus(panelKey, status, host, msg, cfgName){
  // v2.6.11: cfgName 未传时，回退用当前激活的 configs 名称
  if(!cfgName){
    try {
      var active = (window.configs || []).find(function(c){ return c._active; });
      if(active && active.name) cfgName = active.name;
    } catch(e){}
  }
  window._panelConnStatus[panelKey] = {
    status: status, host: host || '', msg: msg || '',
    cfgName: cfgName || '', ts: Date.now()
  };
  // localStorage 持久化，刷新页面后恢复
  try { localStorage.setItem('panelConnStatus', JSON.stringify(window._panelConnStatus)); } catch(e){}
  renderConnStatusPanel();
}

function restorePanelConnStatus(){
  try {
    var s = localStorage.getItem('panelConnStatus');
    if(s) window._panelConnStatus = JSON.parse(s);
  } catch(e){}
  renderConnStatusPanel();
  // 各面板 Badge 同步（跨面板持久）
  Object.keys(window._panelConnStatus).forEach(function(k){
    var st = window._panelConnStatus[k];
    var badgeId = k + 'ConnBadge';
    var badge = document.getElementById(badgeId);
    if(badge){
      var cls = st.status === 'ok' ? 'ok' : (st.status === 'fail' ? 'fail' : 'idle');
      var text = st.status === 'ok' ? ('🟢 '+(st.host||'已连接'))
              : st.status === 'fail' ? ('🔴 '+(st.msg||'失败'))
              : '未连接';
      if(typeof setConnBadge === 'function') setConnBadge(badgeId, cls, text);
    }
  });
}

function toggleConnStatusPanel(){
  var p = document.getElementById('connStatusPanel');
  if(p){ p.remove(); return; }
  var panel = document.createElement('div');
  panel.id = 'connStatusPanel';
  panel.style.cssText = 'position:fixed;top:56px;left:50%;transform:translateX(-50%);z-index:9998;'
    +'background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:14px 18px;'
    +'min-width:400px;max-width:min(600px,92vw);box-shadow:0 8px 30px rgba(0,0,0,0.4)';
  document.body.appendChild(panel);
  renderConnStatusPanel();
}

function renderConnStatusPanel(){
  // v2.6.5: 更新全局胶囊上的"已连接数"
  try {
    var okCount = 0;
    Object.keys(window._panelConnStatus||{}).forEach(function(k){
      if(window._panelConnStatus[k].status === 'ok') okCount++;
    });
    var gtxt = document.getElementById('globalConnText');
    // v4.96.0 · 修复: 正常态(纯圆点)此前直接 return 导致点击 WS 圆点弹窗空白
    //   现在只跳过胶囊文字更新, 面板渲染(下方 panel.innerHTML)始终执行
    var _skipPillText = !!(gtxt && window._wsStatus === 'open' && !gtxt.textContent);
    if(gtxt && !_skipPillText){
      var wsLabel = (window._wsStatus === 'open') ? '已连接' : '已断开';
      // v2.6.11: 追加当前活动面板服务器名（当前 tab 对应的 SSH 状态）
      var curPanel = window._currentPanelKey || '';
      // tab key → 面板前缀
      var TAB2PREFIX = { transfer:'srv', proxmox:'pve', vzdump:'vd', lvm:'lvm',
                         pbs:'pbs', zfs:'zfs', rbd:'rbd', auto_backup:'ab' };
      var pfx = TAB2PREFIX[curPanel] || '';
      var curSuffix = '';
      if(pfx && window._panelConnStatus[pfx]){
        var s = window._panelConnStatus[pfx];
        var name = s.cfgName || s.host || '';
        if(name){
          var mark = s.status === 'ok' ? '🟢' : (s.status === 'fail' ? '🔴' : '⚪');
          curSuffix = ' · '+mark+' '+name;
        }
      }
      gtxt.textContent = 'WS: '+wsLabel
        + (okCount>0 ? ' · SSH:'+okCount : '')
        + curSuffix;
    }
  } catch(e){}
  var panel = document.getElementById('connStatusPanel');
  if(!panel) return;
  /* v5.96.0 · WebSocket 诊断块(用户要求: 一眼看出是网络 / 代理空闲超时 / 会话过期) */
  var WS_CN = { open:'🟢 已连接', reconnecting:'🟠 重连中…', checking:'🟠 链路检测中…',
                expired:'🔴 登录已过期(请重新登录)', disconnected:'🔴 已断开', error:'🔴 连接错误',
                restoring:'🟠 恢复会话中…', unknown:'⚪ 未知' };
  var _wsHtml = (function(){
    var st = window._wsStatus || 'unknown';
    var col = (st === 'open') ? 'var(--green)'
            : ((st === 'reconnecting' || st === 'checking' || st === 'restoring') ? 'var(--orange)' : 'var(--red)');
    var h = '<b>WebSocket:</b> <span style="color:' + col + '">' + (WS_CN[st] || st) + '</span>';
    h += ' · 心跳 RTT: <b>' + _wsRttNote() + '</b>';
    if (window._wsLastMsgAt) h += ' · 最近收帧: ' + Math.max(0, Math.round((Date.now() - window._wsLastMsgAt)/1000)) + 's 前';
    h += ' · 重连成功: <b>' + (window._wsReconnects || 0) + '</b> 次';
    if (window._wsMissStreak) h += ' · 连续丢包: ' + window._wsMissStreak;
    if (window._wsLastCloseReason) {
      h += '<div style="margin-top:4px;font-size:11px;color:var(--text3)">最近断开: '
         + window._wsLastCloseReason
         + (window._wsLastCloseAt ? (' · ' + new Date(window._wsLastCloseAt).toLocaleTimeString()) : '') + '</div>';
    }
    if (window._wsLastRestore) h += '<div style="font-size:11px;color:var(--text3)">会话恢复(最近一次): ' + window._wsLastRestore + '</div>';
    // 人话结论: 让用户/客服不用猜
    var tip = '';
    if (st === 'open' && window._wsRtt != null && window._wsRtt > 800) tip = '链路延迟偏高(>800ms) — 检查网络质量或跳板/代理。';
    else if (st === 'open' && window._wsLastCloseReason.indexOf('心跳超时') >= 0) tip = '上次是心跳超时断开: 常见于反向代理(nginx 默认 proxy_read_timeout 60s)空闲掐断 — 建议把代理超时调到 ≥120s(本页每 20s 空闲即心跳保活)。';
    else if (st === 'expired') tip = '登录会话已失效: 后端会拒绝所有动作 — 重新登录即可(若频繁出现请检查 token 有效期设置)。';
    else if (st === 'reconnecting' || st === 'checking') tip = '正在自动重连 — 若长时间不恢复, 请确认服务在运行、网络可达、代理未拦 WebSocket。';
    if (tip) h += '<div style="margin-top:4px;font-size:11px;color:var(--orange)">💡 ' + tip + '</div>';
    /* v5.97.0 · 断开/重连自动记录(事后复盘): 时间 / 事件 / 原因 / 当时 RTT / 断开时长 */
    var _dag = (window._wsDiag || []).slice(-8).reverse();
    if (_dag.length){
      h += '<div style="margin-top:8px;font-size:11px">'
         + '<b>最近断开 / 重连记录</b>（自动记录, 刷新后仍在；共 '
         + (window._wsDiag || []).length + ' 条）'
         + ' <button class="btn btn-xs" onclick="_wsDiagClearAsk()">清空</button>'
         + ' <button class="btn btn-xs" onclick="exportWsDiag()" title="把客户端诊断 + 断开记录 + 服务端日志尾部 + 排查提示导成一个 txt, 偶发断线直接发回复盘">📥 导出诊断包</button>'
         + '</div><table style="width:100%;border-collapse:collapse;font-size:11px;margin-top:2px">'
         + '<tr style="background:var(--bg3)"><th style="text-align:left;padding:2px 6px">时间</th>'
         + '<th style="text-align:left;padding:2px 6px">事件</th>'
         + '<th style="text-align:left;padding:2px 6px">原因 / 详情</th>'
         + '<th style="text-align:left;padding:2px 6px">RTT</th></tr>';
      _dag.forEach(function(r){
        var kind = r.kind === 'disconnect' ? '🔌 断开' : (r.kind === 'reconnect' ? '✅ 重连' : '⛔ 会话失效');
        var det = r.kind === 'reconnect'
          ? ('掉线 ' + (r.downMs != null ? (Math.round(r.downMs / 1000) + 's') : '?')
             + (r.reason ? (' · ' + r.reason) : ''))
          : (r.reason || '') + (r.code != null ? (' (code ' + r.code + ')') : '')
            + (r.upSec != null ? (' · 存活 ' + r.upSec + 's') : '');
        h += '<tr><td style="padding:2px 6px;white-space:nowrap" title="'
             + new Date(r.t).toLocaleString() + '">' + _wsDiagAgo(r.t) + '</td>'
             + '<td style="padding:2px 6px;white-space:nowrap">' + kind + '</td>'
             + '<td style="padding:2px 6px">' + (det || '-') + '</td>'
             + '<td style="padding:2px 6px;white-space:nowrap">'
             + (r.rtt != null ? (r.rtt + ' ms' + (r.rttAvg ? (' / ' + r.rttAvg) : '')) : '-') + '</td></tr>';
      });
      h += '</table>';
    }
    return h;
  })();
  var wsColor = window._wsStatus === 'open' ? 'var(--green)' : 'var(--red)';
  var rows = '';
  var PANEL_NAMES = {srv:'📁 文件传输', pve:'🖥 Proxmox', vd:'📦 vzdump',
    lvm:'💽 LVM', pbs:'📦 PBS', zfs:'🗄 ZFS', rbd:'🌐 RBD', ab:'🔧 一键备份'};
  Object.keys(PANEL_NAMES).forEach(function(k){
    var st = window._panelConnStatus[k];
    if(!st){
      rows += '<tr><td style="padding:4px 8px">'+PANEL_NAMES[k]+'</td>'
        +'<td style="color:var(--text3)">-</td>'
        +'<td style="color:var(--text3)">未测试</td>'
        +'<td style="color:var(--text3)">-</td></tr>';
    } else {
      var color = st.status === 'ok' ? 'var(--green)' : 'var(--red)';
      var icon = st.status === 'ok' ? '🟢' : '🔴';
      var age = Math.floor((Date.now() - st.ts)/1000);
      var ageStr = age < 60 ? age+'s 前' : Math.floor(age/60)+'m 前';
      rows += '<tr><td style="padding:4px 8px">'+PANEL_NAMES[k]+'</td>'
        +'<td style="font-size:11px;color:var(--cyan)">'+(st.cfgName||'-')+'</td>'
        +'<td style="color:'+color+'">'+icon+' '+(st.host||'-')+'</td>'
        +'<td style="font-size:11px;color:var(--text3)">'+ageStr+'</td></tr>';
    }
  });
  panel.innerHTML =
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">'
    +'<h3 style="margin:0">📡 连接状态</h3>'
    +'<button class="btn btn-sm" onclick="toggleConnStatusPanel()">✕</button></div>'
    +'<div style="font-size:12px;margin-bottom:10px">'
    + _wsHtml
    +'<div style="margin-top:4px"><b>当前用户:</b> '+(currentUser ? currentUser.username : '未登录')+'</div>'
    +'</div>'
    +'<table style="width:100%;border-collapse:collapse;font-size:12px"><thead>'
    +'<tr style="background:var(--bg3)"><th style="text-align:left;padding:4px 8px">面板</th>'
    +'<th style="text-align:left;padding:4px 8px">配置名</th>'
    +'<th style="text-align:left;padding:4px 8px">SSH · 主机</th>'
    +'<th style="text-align:left;padding:4px 8px">最后检测</th></tr></thead>'
    +'<tbody>'+rows+'</tbody></table>'
    +'<div style="margin-top:10px;font-size:11px;color:var(--text3)">状态跨页面切换/刷新持久保存（localStorage）</div>';
  // v5.34.4 · P4 注入「连接中心会话」区 (真实会话 + 续期/断开, 置顶)
  try{ if(window.SP && window.SP.injectSessionSection) window.SP.injectSessionSection(panel); }catch(e){}
}

// WS open/close 时更新
setInterval(function(){
  if(currentWs && currentWs.readyState === WebSocket.OPEN){
    if(window._wsStatus !== 'open') updateGlobalConnStatus('open');
  } else if(!currentWs){
    if(window._wsStatus !== 'disconnected') updateGlobalConnStatus('disconnected');
  }
  // v2.6.5: 每 2 秒刷新连接胶囊（更新 age、SSH 数）
  if(typeof renderConnStatusPanel === 'function') renderConnStatusPanel();
}, 2000);

function send(data, callback, streamMode){
  // data: object to send
  // callback: function to handle response (for non-stream mode)
  // streamMode: if true, don't remove listener - keep receiving logs
  var _timedOut = false;
  var timer = setTimeout(function(){
    _timedOut = true;
    window._rpSessionInFlight = false;          // v5.98.1 · 超时即认为会话请求已结束
    var _wsState = (window._wsStatus || 'unknown');
    addLog((window.t ? window.t('WebSocket 请求超时 ({action}) · 链路状态: {state}',
             {action: (data && data.action || '?'), state: _wsState})
            : ('WebSocket 请求超时 (' + (data && data.action || '?') + ') · 链路状态: ' + _wsState)), 'warn');
    // v5.95.0 · 超时先探活: 半死连接别让用户干等(探到死就触发重连, 并告诉用户是链路问题)
    try { _wsHealthCheck(); } catch(e){}
    // v4.39.0 · 超时也回调通知 UI，避免"正在扫描"等状态永久卡住
    if(callback){
      try {
        callback({type: 'result', status: 'error',
                  msg: '请求超时（30s无响应）· 链路状态: ' + _wsState
                       + ((_wsState === 'open') ? '（服务可能正忙或该操作本身较慢）' : '（连接不稳定，正在自动重连）')});
      } catch(e){}
    }
  }, 30000);

  /* v6.3.20 · **空载荷防御**(面板失败态体检时实测到): 上面 auth_token 块有 `data &&` 防御,
     但下面 `data.req_id = myReqId` **没有** —— 任何 `send(null)`/`send()` 的调用方都会
     抛 `TypeError: Cannot set properties of null`, 把调用方的流程当场打断(且报错位置在 send 内部,
     排查时看着像框架问题)。这里显式拦下: **不抛异常、不静默**, 立刻回调一条明确的错误帧并留痕。 */
  if(!data || typeof data !== 'object'){
    try { console.warn('[send] 非法请求(空载荷), 已忽略。调用方栈:', new Error().stack); } catch(_){}
    if(callback){ try { callback({ type:'result', status:'error', msg:'请求载荷为空(调用方缺陷), 已忽略' }); } catch(_){} }
    return;
  }
  // v2.6.4: 每个请求都附带 auth_token（兜底，避免 WS 断线后 session 丢失导致"请先登录"）
  if(data && !data.auth_token){
    var _tok = localStorage.getItem('auth_token');
    if(_tok) data.auth_token = _tok;
  }
  // v2.6.9: 为每个请求分配 req_id，后端 echo 回来后 handler 只匹配自己的响应，
  // 彻底避免多个并发 send() 抢消息（老 bug：db_user_list 收到 db_config_list 的 result → 显示"暂无用户数据"）
  var myReqId = 'r' + Date.now() + '_' + Math.random().toString(36).slice(2, 9);
  data.req_id = myReqId;

  var _rpAct = (data && data.action) || '';
  if (_rpIsSessionAction(_rpAct)) window._rpSessionInFlight = true;   // v5.98.1 · 会话请求在途
  var _sendFail = function(err){
    // v5.98.6 · 发送失败 → **必须回调**, 让调用方结束等待并显示真实原因(而不是永远转圈)
    try { clearTimeout(timer); } catch(_){}
    try { ws.removeEventListener('message', handler); } catch(_){}
    if (callback){
      try {
        callback({type: 'result', status: 'error',
                  msg: 'WebSocket 发送失败（' + ((err && err.message) || '连接已断开')
                       + '）· 已自动重连, 请重试'});
      } catch(_){}
    }
  };
  openWs(function(ws){
    _rpSendWhenReady(ws, data, undefined, _sendFail);   // v5.98.1 就绪门 + v5.98.6 失败必回调
    var prefix = getPanelPrefix(data.action);

    var handler = function(e){
      try {
        var d = JSON.parse(e.data);
        // v2.6.7 修复：跳过 db_restore_session 的响应，避免污染实际请求的回调
        if(d && d.type === 'result' && typeof d.msg === 'string' &&
           (d.msg.indexOf('会话已恢复') >= 0 || d.msg.indexOf('会话恢复失败') >= 0)){
          return;
        }
        /* v6.3.4 · **补完 v5.98.0 的另一半**: 非 stream 请求只认「帧类型正确 + req_id 精确匹配」的响应。
           背景(实测于生产 ws 抓帧): 服务端会对**请求上下文内**的 result/error 帧自动注入当前 req_id
           (ws.py v5.98.0 的 send_json 猴补丁), 目的是让前端能严格匹配; 但前端这边的过滤一直是
           `if (d.req_id && d.req_id !== myReqId) return;` —— **空 req_id 视为匹配**。
           于是**请求上下文之外**发出的帧(主题/订阅推送: vitals、share_list、mounts_list … 它们没有
           当前请求可注入)会落到**任意一个正在等响应的请求**上, 把它提前结算掉:
             回调拿到的载荷里没有 volumes/storages/items → 调用方按「空列表」处理 →
             界面表现:「存储列表读不到 / 按类型只剩网络共享 / 存储池点不开 / 面板一片空」,
             **且没有任何报错**(静默降级)。
           为什么会「时好时坏」: 真正的响应与这些推送帧**谁先到谁赢** —— 竞态。
           规矩(与 CLAUDE.md §3.7 禁止静默回落同源):
             ① 非 stream 请求只接受 result / error / flow_progress(后者由下面的分支专门处理);
             ② result / error 必须 **req_id 精确相等** —— 空/缺失 req_id 一律不认。 */
        if(!streamMode && d){
          /* v6.3.30 · FIX: 判「这帧是不是我的」要看 **req_id 精确相等**, 而不是「帧类型必须是 result」。
             v6.3.4 为了挡住**主题推送**(无 req_id 的 vitals/share_list/mounts_list 广播)写死了类型白名单,
             结果把**自有类型的回包**一并丢了: `schedule_list` 等 handler 回的是
             `{type:'schedule_list', status:'ok', schedules:[...], req_id:<本次请求>}` —— 服务端已注入
             匹配 req_id、帧也确实到了, 却因为 type 不在白名单被丢弃 → **回调永不触发** → 调用方永远等。
             实测(原始帧抓取): 非流式 `schedule_list` 的回调 12 秒内一次都没回来; 同一帧在
             streamMode=true 下立刻被接受 —— 差异只在这条白名单。
             现规则: ① 带**匹配 req_id** 的帧一律认(最强相关性证据; 推送不带 req_id, 挡推送的初衷不变);
                     ② 没有 req_id 的帧才套类型白名单, 且 result/error 无匹配 req_id 一律不认(防串号)。 */
          if(!(d.req_id && d.req_id === myReqId)){
            if(d.type && d.type !== 'result' && d.type !== 'error' && d.type !== 'flow_progress'){
              return;
            }
            if(d.type === 'result' || d.type === 'error'){
              return;   // 无匹配 req_id 的结果/错误帧不认(既不认空串, 也不认别人的)
            }
          }
        }
        // v2.6.9: 只处理与本次请求 req_id 匹配的响应；后端主动 push 的 log/progress 不带 req_id → 也放行走 streamMode
        if(d && d.req_id && d.req_id !== myReqId){
          return;
        }
        clearTimeout(timer);
        if (_rpIsSessionAction((data && data.action) || '')) window._rpSessionInFlight = false;

        /* v5.98.1 · 会话未就绪被拒(「请先登录（会话已丢失）」) → 等就绪后**重发一次**
           (用户报"面板一直空着, 刷新一次页面才好" —— 根因就是这条被静默丢掉且不再重试) */
        if (_rpIsSessionLost(d) && !_rpIsSessionAction((data && data.action) || '') && !data.__rpRetried){
          ws.removeEventListener('message', handler);
          data.__rpRetried = true;
          /* v5.98.2 · 连续被拒 ≥2 次说明会话真的没了(不是瞬时竞态): 明确提示一次, 不让用户面对空界面 */
          try {
            window._rpSessionLostCount = (window._rpSessionLostCount || 0) + 1;
            if (window._rpSessionLostCount >= 2 && !window._rpSessionLostTold){
              window._rpSessionLostTold = true;
              try { _wsDiagPush({ kind: 'session_lost', reason: '业务请求被拒(请先登录) ×' + window._rpSessionLostCount }); } catch(_){}
              if (window.toast) toast('登录会话已失效 · 请重新登录或刷新页面（当前列表可能为空）', 'err', 9000);
              addLog('检测到会话失效: 连续 ' + window._rpSessionLostCount + ' 次请求被拒 · 建议重新登录', 'err');
            }
          } catch(_){}
          try { console.warn('[ws] 会话未就绪被拒, 等就绪后重发: ' + ((data && data.action) || '')); } catch(_){}
          window._rpRetryAfterReady(function(){ send(data, callback, streamMode); },
                                   10000,
                                   function(){ if(callback){ try { callback(d); } catch(e){} } });
          return;
        }

        // v4.15.9: flow_progress 无论 streamMode 都直接透传给 callback（后端 push 无 req_id）
        // 因为 flows.js 调 send() 没传 streamMode=true，之前事件被漏在 else 分支
        if(d.type === 'flow_progress'){
          if(callback){
            try { callback(d); } catch(e){ console.warn('flow_progress cb err', e); }
          }
          if(d.stage === 'done'){ ws.removeEventListener('message', handler); }
          return;
        }

        if(streamMode){
          if(d.type === 'log'){
            if(d.msg){
              addLog(d.msg, d.level || 'info');
              if(prefix) addPanelLog(prefix, d.msg, d.level || 'info');
            }
          }
          if(d.type === 'progress'){
            if(prefix) setPanelProgress(prefix, d.pct || 0, d.text || '');
            // v4.43.1 · FIX ⑧: streamMode 主传输速度统一钩子 · 侧栏 speedDisplay/totalDisplay 任意页面可见
            //   此前该分支只更新面板进度条（getPanelPrefix('rsync')=null），速度信息全丢，侧栏恒显 0 MB/s
            var _stEl = document.getElementById('statSpeed');
            if (_stEl && d.speed) _stEl.textContent = d.speed;
            // v5.37.0: recordSpeed 改由 transfer.progress 事件总线统一喂养 (防双计)
          }
          if(d.type === 'result' && (d.status === 'ok' || d.status === 'error' || d.status === 'err' || d.status === 'warn' || d.status === 'partial' || d.status === 'done' || d.status === 'failed' || d.status === undefined)){
            ws.removeEventListener('message', handler);
            if(callback) callback(d);
          }
          // v4.38.34 · handle_rsync 终态是 type:'finish' (非 result) -- 同样终止并回调
          if(d.type === 'finish'){
            ws.removeEventListener('message', handler);
            if(callback) callback(d);
            // v4.43.1 · FIX ⑧: 传输终态把侧栏速度清零（不再挂着最后一条速度）
            if(d.status === 'success'){
              try {
                var _spEl = document.getElementById('speedDisplay');
                if(_spEl) _spEl.textContent = '0 MB/s';
              } catch(_){}
            }
          }
          // v4.15.4 · scheduler / dashboard 等旧 handler 用自定义 type，一并放行
          // v4.15.7: flow_progress 每次都 callback（流式），stage='done' 时 remove listener
          if(d.type === 'schedule_list' && callback){
            ws.removeEventListener('message', handler);
            callback(d);
          }
          if(d.type === 'flow_progress' && callback){
            try { callback(d); } catch(e){ console.warn('flow_progress cb err', e); }
            if(d.stage === 'done'){ ws.removeEventListener('message', handler); }
          }
          if(d.type === 'pbs_detail_result' && (d.status === 'ok' || d.status === 'error')){
            ws.removeEventListener('message', handler);
            if(callback) callback(d);
          }
        } else {
          if(d.type === 'result' || d.type === 'lvm_result' || d.type === 'pbs_result' ||
             d.type === 'zfs_result' || d.type === 'rbd_result' || d.type === 'op_logs' ||
             d.type === 'lvm_status' || d.type === 'pbs_status' || d.type === 'zfs_status' ||
             d.type === 'rbd_status' || d.type === 'pbs_detail_result' ||
             d.type === 'lvm_plugins_result' || d.type === 'lvm_install_result' ||
             d.type === 'rsync_plugins_result' || d.type === 'rsync_install_result' ||
             d.type === 'sync_tools_result' ||  // v4.38.23
             d.type === 'schedule_list' ||
             /* v6.3.33 · FIX(全面审计): 以下 6 个类型此前**漏进结算白名单** —— 后端明明回了帧、
                帧也到了浏览器, 却因为不在这张表里被丢弃 → 调用的回调永不触发。实测症状(直连 WS
                确认后端回包类型): PVE「RBD 插件检测/安装」「ZFS 插件检测/安装」按钮卡在"检测中...",
                调度「运行历史」「时间轴」永远空白 —— 都是等到 30s 超时才显示一句"检测失败/加载失败"。
                同类历史修复: disk_* / lvm_* / pbs_* 当年也是逐个补进来的; 本轮把漏的补齐,
                并加了审计守栏(test_v6333)防止将来再漏。 */
             /* v6.3.34 · 反向审计(契约守栏双向化)新抓到的 1 处: 后端 `backup_verify_stats`
                回的是**同名 type**(database.py:587), 前端 dashboard 的 refreshVerifyStats()
                用 rpc() 非流式调用等它 → 之前的白名单里没有 → 回调永不触发, 仪表盘「备份验证统计」
                四个数字(vfyTotal/vfyVerified/vfyUnverified/vfyFailed)永远是空/0。 */
             d.type === 'backup_verify_stats' ||
             d.type === 'rbd_plugins_result' || d.type === 'zfs_plugins_result' ||
             d.type === 'rbd_install_result' || d.type === 'zfs_install_result' ||
             d.type === 'schedule_runs' || d.type === 'schedule_timeline' ||
             d.type === 'zfs_disks_result' || d.type === 'zfs_browse_result' ||
             d.type === 'disk_scan_result' || d.type === 'disk_plugin_check_result' ||
             d.type === 'disk_mount_result' || d.type === 'disk_unmount_result' ||
             d.type === 'disk_df_result' || d.type === 'disk_plugin_install_result' ||
             d.type === 'disk_rm_result' || d.type === 'disk_mv_result' ||
             d.type === 'disk_remount_rw_result' ||
             d.type === 'disk_luks_open_result' || d.type === 'disk_luks_close_result' ||
             d.type === 'disk_zfs_import_result' || d.type === 'disk_zfs_export_result' ||
             d.type === 'disk_list_dir_result' ||
             d.type === 'disk_ns_op_result' ||
             d.type === 'transfer_audit_result'){  // v4.40.2 P2 · 传输审计
            ws.removeEventListener('message', handler);
            if(callback) callback(d);
          } else if (d.type === 'install_local_log'){
            // v4.38.24 · 流式日志：不终止 handler, 广播给所有 ToolChecker 实例
            if (Array.isArray(window._tcHandlers)){
              for (var ti=0; ti<window._tcHandlers.length; ti++){
                try { window._tcHandlers[ti](d); } catch(e){ console.warn('[tcHandlers] err', e); }
              }
            }
          } else if (d.type === 'install_local_result'){
            ws.removeEventListener('message', handler);
            if (Array.isArray(window._tcHandlers)){
              for (var ti=0; ti<window._tcHandlers.length; ti++){
                try { window._tcHandlers[ti](d); } catch(e){}
              }
            }
            if(callback) callback(d);
          }
        }
      } catch(err){
        // v4.38.15 · 不再静默吞异常：回调内部抛错（如跨作用域变量未定义）
        // 曾导致 disk_manager _handleScanResult 的 ReferenceError 被吞掉、
        // 磁盘扫描 body 永远停在「正在扫描」却无任何报错。
        console.warn('[send] message handler error:', err);
      }
    };

    ws.addEventListener('message', handler);
  }).catch(function(err){
    clearTimeout(timer);
    addLog('WebSocket 连接失败: '+err.message,'error');
    if(callback) callback({status:'error', msg:err.message});
  });
}

// ------------------------------------------
// 身份验证提取 (核心修复点)
// 必须同时返回 auth_type 和加密后的 password
// ------------------------------------------
function getTransferAuth(){
  return ConnPanel_getAuth('', { typeId:'authType', valueId:'authValue', passphraseId:'authPassphrase' });
}
function getPveAuth(){
  return ConnPanel_getAuth('pve', { valueId:'pveAuthValue', passphraseId:'pveAuthPassphrase' });
}
function getVdAuth(){
  return ConnPanel_getAuth('vd', { valueId:'vdAuthValue', passphraseId:'vdAuthPassphrase' });
}
function getSrvAuth() {
  // v4.38.24 · 优先读 transfer form; 字段为空时 fallback 到 panel-disk_manager 内的 _dm form
  // 这样 disk_manager 页面填的 server 配置在测试连接、扫描磁盘、ToolChecker 时都能识别
  var type = gv('authType') || gv('authType_dm');
  var val = gv('authValue') || gv('authValue_dm');
  var pp = gv('authPassphrase') || '';
  var host = gv('srvHost') || gv('srvHost_dm');
  var port = gv('srvPort') || gv('srvPort_dm');
  var user = gv('srvUser') || gv('srvUser_dm');
  // v5.34.3 · P3 跨页凭据兜底: 表单未填密码/密钥 → 用连接中心档案缓存 (免重复填写)
  //   缓存由 SP.resolve 在「点档案/选配置」时异步预热; 命中活跃会话则零成本直达
  if(!val && host && window.SP){
    try{
      var _c = window.SP.cachedCreds(host, port || '22');
      if(_c){
        type = _c.auth_type || type || 'pass';
        val = (type === 'key') ? (_c.key || '') : (_c.password || '');
        pp = _c.passphrase || pp;
        if(!user) user = _c.user || '';
      }
    }catch(e){}
  }
  return {
    auth_type: type,
    password: type==='pass'?encodePassword(val):'',
    key: type==='key'?encodePassword(val):'',
    passphrase: type==='key'?encodePassword(pp):'',
    host: host,
    port: port || '22',
    user: user || 'root',
    // v5.20.0 · 远端 OS 声明 (auto 时后端自动探测); Windows/macOS 会走 rclone sftp
    os_type: (gv('srvOsType') || gv('srvOsType_dm') || 'auto')
  };
}
window.getSrvAuth = getSrvAuth;  // v4.38.24 · 暴露给 ToolChecker 等组件
function getVdRemoteAuth() {
  var auth = getVdAuth();
  auth.host = gv('vdHost');
  auth.port = gv('vdPort') || '22';
  auth.user = gv('vdUser') || 'root';
  return auth;
}

// ------------------------------------------
// UI 选项卡与控制面板切换逻辑 (修复崩溃Bug)
// ------------------------------------------
// v5.87.0 · 界面快捷条: 设置页上方挂载顶栏三按钮**原元素**(同一套组件, 非副本)
//   进设置页 → 挂到 #quickBarSlot; 离开 → 物归顶栏 Logo 之后(固定位置, 全页一致)
var _quickBarMounted = false;
/* v6.16.2 批21 · 「界面快捷」分组已移除: 主题/语言按钮**常驻顶栏**不再搬移 ——
   旧实现进设置页把按钮 appendChild 进设置面板、离开时插回 Logo 后,
   异常导航路径(如直接点二级 tab/覆盖页)不还原 → 顶栏按钮"消失"(用户实测截图)。
   保留空函数兼容旧调用点。 */
function _mountQuickBar(mount){ if (window.__qbLegacy) { try { __qbLegacy(mount); } catch(e){} } }

function switchTab(t){
  // v4.15.30 · 性能优化 · 同一 tab 重复点击直接短路，避免重跑 applyConfig/loadConfigs
  // v4.43.1 · FIX ⑦: 短路前先校准 · 若记忆的 _currentPanelKey 与实际显示的 panel 不一致
  //   （登录恢复流程/外部代码直接改 class 等场景），仍走完整切换，否则首次点击子菜单被短路"没反应"
  var _actualPanel = document.querySelector('.panel.active');
  if (window._currentPanelKey === t && _actualPanel && _actualPanel.id === ('panel-' + t)){
    // 仅确保 tab 高亮（防外部误清除）
    var _actTabBtn = document.querySelector('.topbar .tab[onclick="switchTab(\''+t+'\')"]');
    if(_actTabBtn && !_actTabBtn.classList.contains('active')) _actTabBtn.classList.add('active');
    // v4.59.0 · 短路分支也要触发守护面板渲染 (首次进入 transfer 即被短路时 init 不跑)
    if(t === 'transfer' && window.WatchPanel){
      setTimeout(function(){ window.WatchPanel.init(); }, 0);
    }
    if(t === 'file_preview' && window.FilePreviewPage){
      setTimeout(function(){ window.FilePreviewPage.init(); }, 0);
    }
    if(t === 'backup_center' && window.BackupCenter){
      setTimeout(function(){ window.BackupCenter.render(); }, 0);
    }
    // v5.58.0 · 进入连接中心即加载 (旧实现只有页面首载的一次性 1.4s 定时器,
    //   登录未就绪时会看到空列表且无提示 → 用户得按 F5)
    if(t === 'conn_center' && window.ConnCenter && window.ConnCenter.onShow){
      setTimeout(function(){ try{ window.ConnCenter.onShow(); }catch(e){ console.warn('[ConnCenter] onShow fail', e); } }, 0);
    }
    if(t === 'vdisk_cloud' && window.VDisk && window.VDisk.reload){
      setTimeout(function(){ try { window.VDisk.reload(); } catch(e){ console.warn('[VDisk] load fail', e); } }, 0);
    }
    /* v6.5.0 · 批6: 分享管理三个二级页进入即加载 */
    if(t === 'share_lan' && window.ShareLan){ setTimeout(function(){ try { ShareLan.init(); } catch(e){ console.warn(e); } }, 0); }
    if(t === 'share_http' && window.ShareHttp){ setTimeout(function(){ try { ShareHttp.init(); } catch(e){ console.warn(e); } }, 0); }
    if(t === 'share_access' && window.ShareAccess){ setTimeout(function(){ try { ShareAccess.init(); } catch(e){ console.warn(e); } }, 0); }
    return;
  }
  // v4.15.16 · 切换主 tab 不再清空远端浏览缓存（用户明确要求：除非点断开否则一直保持）
  // v2.6.3: 权限拦截 — 无权限的 tab 禁止切换
  if(currentUser && currentUser.role !== 'admin' && Array.isArray(currentUser.permissions)){
    if(currentUser.permissions.indexOf(t) === -1){
      if(typeof toastErr === 'function') toastErr('无权访问此页面');
      addLog('拒绝访问 '+t+'（当前用户无权限）','warn');
      return;
    }
  }
  // v6.16.14 · 档位兜底(用户要求: 非社区版功能/显示一律清除): switchTab 是**所有面板入口的总闸**,
  //   此前只校验用户权限不校验 license → 任何残留按钮(或控制台直调)都能打开 pro/enterprise 面板。
  //   这里按 NAV_TREE 的 feat 键 + hideEditions 兜底拦截, 与导航显隐同源。
  try{
    var _nd = null;
    (window.NAV_TREE || []).forEach(function(g){
      if (g.key === t) _nd = g;
      else if (g.children) g.children.forEach(function(c){ if (c.key === t) _nd = c; });
    });
    if (_nd){
      var _edn = window.__licFeatEdition || 'community';
      var _blocked = !!(_nd.feat && typeof window.licenseFeatEnabled === 'function'
                        && !window.licenseFeatEnabled(_nd.feat));
      if (!_blocked && Array.isArray(_nd.hideEditions) && _nd.hideEditions.indexOf(_edn) >= 0) _blocked = true;
      if (_blocked){
        if (typeof toastErr === 'function') toastErr('该功能不在当前授权档位内 (需升级授权)');
        try { addLog('拒绝访问 '+t+'（档位不含该功能）','warn'); } catch(e){}
        return;
      }
    }
  }catch(e){}

  // v2.6.7: 记住当前 tab（页面刷新后恢复）
  try { localStorage.setItem('activeTab', t); } catch(e){}
  // v6.3.5 · 切页刷新"网络共享真实挂载态"(10s 节流): 掉线后回到页面, 左栏图标即变灰
  try { if (window.rpRefreshShares) window.rpRefreshShares(); } catch(e){}
  // v6.3.7 · 顶栏状态条: 当前页变了要立刻反映
  try { if (window.rpStatusStrip) setTimeout(window.rpStatusStrip.render, 0); } catch(e){}
  // v4.70.0 · 离开「文件预览」页 → 重置缩放/换行/行号 + 退出全屏
  if (t !== 'file_preview' && window.FilePreviewPage && window.FilePreviewPage.onLeave){
    try { window.FilePreviewPage.onLeave(); } catch(e){}
    if (window.FilePreview && window.FilePreview.resetView) window.FilePreview.resetView();
  }
  // 切换 Tab 后自动应用当前激活的配置到目标面板
  // 不在此处保存，避免用空字段覆盖已有的配置
  document.querySelectorAll('.topbar .tab').forEach(function(b){b.classList.remove('active')});
  document.querySelectorAll('.panel').forEach(function(p){p.classList.remove('active')});
  var tabBtn = document.querySelector(`.topbar .tab[onclick="switchTab('${t}')"]`);
  if(tabBtn) tabBtn.classList.add('active');
  var panel = document.getElementById('panel-'+t);
  if(panel) panel.classList.add('active');
  // v5.87.0 · 界面快捷条: 进设置页把顶栏三按钮(WS/主题/语言)**原元素**挂到设置页上方,
  //   离开时物归原位 (同一套组件, 无状态副本); 其余页面三按钮固定紧跟 Logo 不漂移
  try { _mountQuickBar(t === 'settings'); } catch(e){ console.warn('[quickBar]', e); }
  // v5.35.0 · G3: scope 自动切换退役 (单轨档案全页可见); 切页仅刷新侧栏
  loadConfigs();
  // v4.43.1 · FIX ⑦: applyConfig 程序化填充 transfer 表单后重置 dirty 基线
  //   之前基线在填充前建立 -> isDirty() 误报脏 -> 下次点子菜单被 _dirtyModal 拦截（点击"没反应"）
  if(typeof window.Servers !== 'undefined' && window.Servers && typeof window.Servers.resetSnapshot === 'function') window.Servers.resetSnapshot();
  if(typeof window.Tasks !== 'undefined' && window.Tasks && typeof window.Tasks.resetSnapshot === 'function') window.Tasks.resetSnapshot();
  // v2.6.6: 切到 users tab 时自动拉取用户列表
  if(t === 'users' && typeof loadUserList === 'function'){
    setTimeout(loadUserList, 0);
  }
  // v5.19.1 · 核心运行状况: 首次进入自动加载
  if (t === 'core_status' && window.CoreStatus){
    setTimeout(function(){ try { window.CoreStatus.refreshAll(); } catch(e){ console.warn(e); } }, 60);
  }
  // v4.67.0 · 切到系统设置时加载智能分析 (异常检测/时间推荐)
  if(t === 'settings' && window.StatsPanel){
    setTimeout(function(){ window.StatsPanel.load(); }, 0);
  }
  // v4.72.0 · 切到系统设置时渲染快捷键配置
  if(t === 'settings' && window.HotkeyPanel){
    setTimeout(function(){ window.HotkeyPanel.render(); }, 0);
  }
  // v4.77.0 · 切到系统设置时渲染菜单管理
  if(t === 'settings' && window.MenuMgr){
    setTimeout(function(){ window.MenuMgr.render(); }, 0);
  }
  // v5.58.0 · 连接中心: 进入即加载 + 未就绪自动重试 + 空/失败显式提示(可点重试)
  if(t === 'conn_center' && window.ConnCenter && window.ConnCenter.onShow){
    setTimeout(function(){ try{ window.ConnCenter.onShow(); }catch(e){ console.warn('[ConnCenter] onShow fail', e); } }, 0);
  }
  // v6.3.4 · 多云虚拟存储池: 进入即加载卷(来源)列表。此前**没有任何地方在进页面时调 VDisk.reload()**,
  //   只有工具栏「🔄 刷新卷」才会拉 —— 于是左卷列表恒空、存储池自然"点不开"(没得点),
  //   用户看到的是一张空壳界面(实测: 进页后出站帧里没有 vdisk_storages)。
  if(t === 'vdisk_cloud' && window.VDisk && window.VDisk.reload){
    setTimeout(function(){ try { window.VDisk.reload(); } catch(e){ console.warn('[VDisk] load fail', e); } }, 0);
  }
  /* v6.5.0 · 批6: 分享管理三页激活钩子(与 VDisk/flows 同类) */
  if((t === 'share_lan' || t === 'share_http' || t === 'share_access')){
    setTimeout(function(){
      try {
        if (t === 'share_lan' && window.ShareLan) ShareLan.init();
        if (t === 'share_http' && window.ShareHttp) ShareHttp.init();
        if (t === 'share_access' && window.ShareAccess) ShareAccess.init();
      } catch(e) { console.warn('[SharePages] load fail', e); }
    }, 0);
  }
  /* v6.3.24 · 跨模块流程: 进入即加载。此前**没有任何地方在进页面时触发 Flows.loadAll()** ——
     时序采样实测: 切到本页后 12 秒内 #flowsPanelBody 的 innerText 长度恒为 0(连「暂无流程」都没有),
     只有点工具栏「🔄 刷新」才出内容; 而直驱 Flows.loadAll() 立刻渲染出列表/失败态 ✓。
     与 v6.3.4 修过的 VDisk 属**同一类**问题(页面无激活钩子 → 用户看到空壳)。 */
  if(t === 'flows' && window.Flows && window.Flows.loadAll){
    setTimeout(function(){
      try { window.Flows.loadAll(); } catch(e){ console.warn('[flows] loadAll fail', e); }
      /* 实测(单次注入 + 多次进页): 进页后 `#flowsPanelBody` 长度恒为 0, 而**直呼 `Flows.render()`
         立刻产出内容且不抛错** —— 即渲染器正常、激活路径没走到渲染。这里在加载后**再确保渲染一次**
         (render 幂等: 复用包装元素、内容用 innerHTML 覆写, 不会重复堆叠; 已由 A/B 与直呼验证)。 */
      setTimeout(function(){ try { if (window.Flows.render) window.Flows.render(); } catch(e){ console.warn('[flows] render fail', e); } }, 900);
    }, 0);
  }
  // v4.42.0: 切到 license tab 时自动刷新授权状态
  if(t === 'license' && window.LicensePanel){
    setTimeout(function(){ window.LicensePanel.load(); }, 0);
  }
  // v5.40.0 · 切到「多云文件管理」时装配面板 (FonrVFS)
  // v5.80.0 · 这些面板自带资源/主机列表, 左侧服务器列表栏进去默认收起 (离开时恢复进入前的状态)
  // v5.90.10 · 自动收起/恢复一律走 transient(不写 localStorage), 否则会把"临时收起"误存成用户偏好
  // v6.1.6 · 连接中心与多云文件管理页**都**默认收起全局侧栏(用户要求):
  //         连接中心自带页面内服务器树(v6.1.5), 多云文件管理自带 256px 左树 —— 全局侧栏让位
  // v6.3.1 · 改为**彻底隐藏**(连折叠竖条一起收, 用户要求"彻底隐藏公共左面板"), 并统一走
  //         具名 owner + 切页清理 —— 不再各自记 "was"(那是"左侧栏又不见了"的根因)。
  var _SB_AUTOHIDE = { fonrvfs: 1, conn_center: 1 };
  // 离开任何页面先清掉上一页的临时隐藏/收起(防止残留把侧栏按在隐藏态)
  try {
    if (typeof window.sidebarResetTransient === 'function'
        && window._rpSidebarHardTab && window._rpSidebarHardTab !== t){
      window.sidebarResetTransient();
      window._rpSidebarHardTab = null;
    }
  } catch(e){}
  if (_SB_AUTOHIDE[t] === 1){
    try {
      if (typeof window.sidebarHardHide === 'function'){
        window.sidebarHardHide('tab:' + t, true);
        window._rpSidebarHardTab = t;
      } else if (typeof window.toggleSidebarCollapse === 'function'){
        window.toggleSidebarCollapse(true, true);
      }
    } catch(e){}
    if (t === 'fonrvfs' && window.FonrVFS){
      setTimeout(function(){ try { window.FonrVFS.init(); } catch(e){ console.warn('[FonrVFS] init fail', e); } }, 0);
    }
  } else if (window._fonrSidebarWas !== undefined){
    // 兼容旧临时变量(其他路径可能仍在用) → 一律回到用户偏好
    try { delete window._fonrSidebarWas; } catch(e){}
    try {
      if (typeof window.sidebarResetTransient === 'function') window.sidebarResetTransient();
      else if (typeof window.toggleSidebarCollapse === 'function') window.toggleSidebarCollapse(window.sidebarPref(), true);
    } catch(e){}
  }
  // v5.90.10 · 左栏显隐/宽度确定之后才量「右栏内容列」— 必须放在上面自动收起/恢复之后,
  //   否则侧栏还处于收起态 → 量不到 → 二级菜单落到兜底位置(实测比目标少 2px 起跳)
  if (typeof window.__applyPaneInsets === 'function') window.__applyPaneInsets();
  // v4.2.0-alpha2: 切到 remotes/platform_backup tab 时自动刷新
  if(t === 'remotes' && window.Remotes){
    setTimeout(function(){ window.Remotes.refreshAll(); }, 0);
  }
  // v4.5.0: 切到 schedules tab 时初始化面板 (只做一次) + 刷新列表
  if(t === 'schedules' && window.Sched){
    setTimeout(function(){
      if(!window.__schedInited){ window.Sched.init(); window.__schedInited = true; }
      else { window.Sched.refresh(); }
    }, 0);
  }
  if(t === 'platform_backup' && window.PlatformBackup){
    setTimeout(function(){
      window.PlatformBackup.loadHistory();
      // 顺带把远端列表拉进缓存，方便上传按钮快速弹菜单
      // v1.0.0 · 社区档没有"远端存储"键 → 不拉(此前每次进来都打一枪 remote_list, 刷日志噪音)
      if(window.__featInEdition && !window.__featInEdition('cloud')) return;
      if(!window.__remotesCache){
        send({ action:'remote_list' }, function(d){
          if(d && d.status === 'ok') window.__remotesCache = d.remotes || [];
        });
      }
    }, 0);
  }
  // v4.75.0 · 切到「数据库备份」时初始化多类型面板
  if(t === 'dbbackup' && window.DbbPanel){
    setTimeout(function(){ window.DbbPanel.init(); }, 0);
  }
  // v4.71.0 · 切到「备份总览」时渲染卡片九宫格
  if(t === 'backup_center' && window.BackupCenter){
    setTimeout(function(){ window.BackupCenter.render(); }, 0);
  }
  // v4.66.0 · 切到「文件预览」页时初始化 (左源列表 + 右大预览)
  if(t === 'file_preview' && window.FilePreviewPage){
    setTimeout(function(){ window.FilePreviewPage.init(); }, 0);
  }
  // v4.39.0 · 切到「网络共享」页时刷新列表
  if(t === 'shares' && window.Shares){
    setTimeout(function(){ window.Shares.refresh(); }, 0);
  }
  // v5.10.0 · 切到「统一日志」页时刷新索引
  if(t === 'runlog' && window.RunLogPage){
    setTimeout(function(){ window.RunLogPage.refresh(); }, 0);
  }
  // v4.59.0 · 切到传输页时初始化实时同步守护 (只做一次) + 刷新规则状态
  if(t === 'transfer' && window.WatchPanel){
    setTimeout(function(){
      if(!window.__watchInited){ window.WatchPanel.init(); window.__watchInited = true; }
      else { window.WatchPanel.renderRules(); }
    }, 0);
  }
  // v2.6.11: 记录当前活动 panel key，触发顶部胶囊刷新（附加服务器名）
  window._currentPanelKey = t;
  if(typeof renderConnStatusPanel === 'function') renderConnStatusPanel();
}

// v2.6.3: 按当前用户权限隐藏/显示 tab
// v5.85.0 · 导航子项可见性**单一真源**: 档位隐藏(hideEditions) + license 白名单/档位表 + 用户权限。
//   此前三个渲染路径各写一份过滤, 只有 switchGroup 那份带了档位判断 →
//   于是「三角下拉」还会列出别的版本才有的菜单(用户实测)。
function navChildVisible(c){
  if (!c) return false;
  var edn = window.__licFeatEdition || 'community';
  if (Array.isArray(c.hideEditions) && c.hideEditions.indexOf(edn) >= 0) return false;
  var lf = window.__licFeat;
  if (Array.isArray(lf) && c.feat && lf.indexOf(c.feat) < 0) return false;
  var isAdmin = !!(window.currentUser && window.currentUser.role === 'admin');
  var perms = (window.currentUser && Array.isArray(window.currentUser.permissions))
              ? window.currentUser.permissions : null;
  return isAdmin || !perms || perms.indexOf(c.key) >= 0;
}
window.navChildVisible = navChildVisible;

// v5.85.1 · 把仍是**纯输入框**的「备份保存路径/备份目录」也升级成目标选择器(本机/df/共享/已存服务器/远端存储),
//   与 备份中心 PVE 备份路径、容器管理保存位置同口径。此前只有一部分字段挂了(restoreDir / batchLocalDst 等漏掉),
//   用户反馈"保存按钮只有目录按钮, 没有服务器列表和位置选择"。
function attachBackupPathPickers(){
  if (typeof window.TargetPicker === 'undefined' || !window.TargetPicker.attach) return;
  var ids = ['restoreDir', 'batchLocalDst',
             // v5.85.3 · K8s 备份/校验目录(用户要求一并接选取器)
             'kbDestEtcd', 'kbDestDocker', 'kbDestPv', 'kbVerifyDir'];
  ids.forEach(function(id){
    try { if (document.getElementById(id)) window.TargetPicker.attach(id, { kinds: ['local','df','share','server','cloud'] }); }
    catch (e) { console.warn('[tp] attach fail', id, e); }
  });
}
window.attachBackupPathPickers = attachBackupPathPickers;
// 面板是切到才渲染的 → 几次机会都试一遍(attach 自带幂等: el.__tpAttached)
document.addEventListener('DOMContentLoaded', function(){ setTimeout(attachBackupPathPickers, 1200); });
document.addEventListener('click', function(){ setTimeout(attachBackupPathPickers, 400); }, true);
setInterval(attachBackupPathPickers, 4000);

function applyPermissions(){
  if(!currentUser) return;
  var isAdmin = (currentUser.role === 'admin');
  var perms = Array.isArray(currentUser.permissions) ? currentUser.permissions : [];
  // v4.44.1 · license 功能白名单显隐 (window.__licFeat 由 license_get 填充;
  //   null=未拉取/edition 不限 → 不隐藏; 数组=白名单硬控, 对 admin 同样生效)
  var lf = window.__licFeat;
  // v5.83.0 · 按档位隐藏(声明式): 导航项/元素可标 hideEditions:['community'] 或 data-hide-editions="community,pro"
  var _edn = window.__licFeatEdition || 'community';
  function _ednHide(o){ return !!(o && Array.isArray(o.hideEditions) && o.hideEditions.indexOf(_edn) >= 0); }
  function _featOK(f){ return !f || !Array.isArray(lf) || lf.indexOf(f) >= 0; }
  // v2.7.0: 按主组隐藏；组按钮无 switchTab，改用 data-group 匹配 NAV_TREE
  document.querySelectorAll('.main-tabs .tab[data-group]').forEach(function(btn){
    var groupKey = btn.dataset.group;
    var group = (window.NAV_TREE || []).find(function(g){ return g.key === groupKey; });
    if(!group){ return; }
    if(_ednHide(group)){ btn.style.display = 'none'; return; }
    var allowed;
    if(!group.children){
      allowed = _featOK(group.feat) && (isAdmin || perms.indexOf(group.key) !== -1);
    } else {
      allowed = (isAdmin || group.children.some(function(c){ return perms.indexOf(c.key) !== -1; }))
                && group.children.some(function(c){ return _featOK(c.feat); });
    }
    btn.style.display = allowed ? '' : 'none';
  });
  // v5.23.0 · 顶部导航自愈 (缓存旧 index.html 缺新菜单按钮时补齐)
  if (typeof window._ensureNavButtons === 'function') window._ensureNavButtons();
  // v4.44.1 · 子菜单项 license 显隐 (switchGroup 渲染后立即过滤一遍)
  if(typeof window.__applyLicenseSubTabs === 'function') window.__applyLicenseSubTabs();
  if(typeof applyEditionHides === 'function') applyEditionHides();   // v5.83.0
  // v6.16.2 批18 · 登录后延迟清扫重复 🔑 按钮(两轮, 兜住晚于登录的表单构建)
  [2500, 6000].forEach(function(ms){
    setTimeout(function(){
      document.querySelectorAll('.browse-row').forEach(function(row){
        var _seen = false;
        row.querySelectorAll('button').forEach(function(b){
          if ((b.textContent || '').trim() === '🔑'){ if (_seen) b.remove(); else _seen = true; }
        });
      });
    }, ms);
  });
  if(typeof window.__applyPaneInsets === 'function') window.__applyPaneInsets();   // v5.85.5 · 登录后按右栏重算内缩
  // v4.45.0 · flow(跨模块传输) 未授权 -> 卸载已注入的「跨模块自动备份」卡片 (pro 排除项)
  //   例: 文件传输页下方的跨模块自动备份区块
  (function(){
    var el = document.getElementById('flowMini_root_transfer');
    if(el) el.style.display = licenseFeatEnabled('flow') ? '' : 'none';
  })();
  // 侧边栏"用户管理"入口
  var uLink = document.getElementById('userManagerLink');
  if(uLink){
    var uAllowed = isAdmin || perms.indexOf('users') !== -1;
    uLink.style.display = uAllowed ? 'flex' : 'none';
  }
  // v4.77.0 · 应用菜单自定义顺序 (localStorage 持久化)
  try { if (window.MenuMgr) window.MenuMgr.applyOrder(); } catch(e){}

  // 若当前激活的组按钮被禁 → 切到首个允许的
  var active = document.querySelector('.main-tabs .tab.active');
  if(active && active.style.display === 'none'){
    var firstOk = document.querySelector('.main-tabs .tab[data-group]:not([style*="display: none"])');
    if(firstOk && firstOk.dataset && firstOk.dataset.group){
      switchGroup(firstOk.dataset.group);
    }
  }
}

// v4.45.0 · license 功能开关查询 (前端显隐判定用; 同步函数, 用缓存白名单)
//   feat 未出现在白名单 = 未授权 -> false; 无白名单(=edition 全放行) -> true
/* v1.0.0 · 档位判定(与导航显隐同源: RP_FEATURE_EDITIONS 的当前档功能表)。
   社区档不含 cloud/cloudpool 等商业键 → 对应轮询/请求直接跳过(避免一堆"未知 action"噪音)。 */
window.__featInEdition = function(feat){
  try {
    var ed = window.__licFeatEdition || 'community';
    var map = window.RP_FEATURE_EDITIONS || {};
    var lst = map[ed] || map.community;
    return !lst || lst.indexOf(feat) >= 0;
  } catch(e){ return true; }
};

function licenseFeatEnabled(feat){
  try {
    if (!window.__licFeat) return true;          // 无白名单 -> edition 层级(全放行由后端兜底)
    return window.__licFeat.indexOf(feat) !== -1;
  } catch(e){ return true; }
}
window.licenseFeatEnabled = licenseFeatEnabled;

// v4.45.0 · 版本随授权联动: edition → 中文版名, 徽章/标题/页脚/帮助/更新日志统一刷新
var RP_EDITION_CN = { community: '社区版' };   // 本发行版恒为社区档
window.RP_EDITION = null;
window.RP_EDITION_CN_TXT = null;
function applyLicenseBranding(edition){
  try {
    window.RP_EDITION = edition || null;
    window.RP_EDITION_CN_TXT = RP_EDITION_CN[edition] || null;
    var suffix = window.RP_EDITION_CN_TXT ? ' · ' + window.RP_EDITION_CN_TXT : '';
    // 顶部徽章
    var badge = document.getElementById('versionBadge');
    if (badge) badge.textContent = 'v' + (window.RP_VERSION || '') + suffix;
    // 页面标题 — 此块在登录/版本信息就绪后才执行; 语言切换时的标题翻译由 i18n.js 内核负责
    var _brand = 'Fonriv';   // 品牌已定名, 不再走可配置占位符
    if (window.RP_VERSION) document.title = _brand + ' v' + window.RP_VERSION + suffix + ' - '
      + (typeof window.t === 'function' ? window.t('运维高级传输同步工具') : '运维高级传输同步工具');
    // Logo 区域: 版本徽章
    var le = document.getElementById('logoEdition');
    var lv = document.getElementById('logoVersion');
    if (le) le.textContent = (window.RP_EDITION_CN_TXT || '') ;
    if (lv) lv.textContent = window.RP_VERSION ? 'v' + window.RP_VERSION : '';
    // 底部页脚 (bldFooter 已注入则原位更新)
    var copy = document.querySelector('#bldFooter .bld-copy');
    // v1.0.0 · 用户要求: 页脚「社区版」三个字做成 GitHub 源码链接
    if (copy && window.RP_VERSION){
      copy.innerHTML = '© 2025-2026 ' + (window.__RP_BRAND__ || 'Fonriv') + ' · v' + window.RP_VERSION
        + (window.RP_EDITION_CN_TXT
            ? ' · <a href="https://github.com/lxrmyc/fonriv/" target="_blank" rel="noopener" style="color:inherit;text-decoration:none;border-bottom:1px dotted currentColor" title="源码仓库 Source">'
              + window.RP_EDITION_CN_TXT + '</a>'
            : '') + ' ';
    }
    // v4.45.0 · 帮助/更新日志 modal 标题带版名
    var hTitle = document.getElementById('helpModalTitle');
    if (hTitle) hTitle.textContent = '❓ ' + (window.__RP_BRAND__ || 'Fonriv') + ' 使用手册' + suffix;
    var cTitle = document.getElementById('changelogModalTitle');
    if (cTitle) cTitle.textContent = '📜 ' + (window.__RP_BRAND__ || 'Fonriv') + ' 更新日志' + suffix;
    // 数据总览/跨模块流程面板头部小徽章
    document.querySelectorAll('.dash-flows-ver').forEach(function(b){
      b.textContent = 'v' + (window.RP_VERSION || '') + suffix;
    });
  } catch(e){ console.warn('[branding]', e); }
}
window.applyLicenseBranding = applyLicenseBranding;

// v4.44.1 · 拉取 license 功能白名单并刷新显隐 (登录成功/会话恢复后调用)
function fetchLicenseFeatures(){
  if(typeof send !== 'function') return;
  send({action:'license_get'}, function(msg){
    if(msg && msg.status === 'ok'){
      var lf = msg.features_allow;
      if (!Array.isArray(lf)){
        // v5.81.7 · 无显式白名单(常见: 社区版/按档位授权) → 回退到**档位表**过滤,
        //   否则社区版导航会列出被锁功能(点了由后端拒绝, 体验上像坏了)。
        var _edMap = window.RP_FEATURE_EDITIONS || {};
        var _ed = msg.edition || 'community';
        lf = Array.isArray(_edMap[_ed]) ? _edMap[_ed] : null;
      }
      window.__licFeat = Array.isArray(lf) ? lf : null;
      window.__licFeatEdition = msg.edition || null;  // v4.45.0 · 缓存 edition
      applyLicenseBranding(window.__licFeatEdition);  // v4.45.0 · 版本/版名联动
      if(typeof applyPermissions === 'function') applyPermissions();
      /* v6.16.17 · 白名单/档位晚于首屏 → 左栏快捷操作按真实档位重渲染一次
         (首屏 __licFeat=null 时按 community 档位表兜底, 商业档用户的按钮在此补回) */
      try { if (window.UIPrefs && window.UIPrefs.renderQuickList) window.UIPrefs.renderQuickList(); } catch(e){}
    }
  });
}
window.fetchLicenseFeatures = fetchLicenseFeatures;

function switchPveTab(t, el){
  if(!el)return;
  var container = el.parentElement;
  if(container) container.querySelectorAll('.tab-inner').forEach(function(b){b.classList.remove('active')});
  el.classList.add('active');
  ['discover','restore','schedule','apicluster'].forEach(function(tab){
    var e = document.getElementById('pveTab-'+tab);
    if(e) e.style.display = (tab===t)?'block':'none';
  });
}

function switchVzdumpTab(t, el){
  var container = document.getElementById('vzdumpTabs');
  container.querySelectorAll('.tab-inner').forEach(function(b){b.classList.remove('active')});
  el.classList.add('active');
  ['backup','download','restore','schedule'].forEach(function(tab){
    var e = document.getElementById('vzdumpTab-'+tab);
    if(e) e.style.display = (tab===t)?'block':'none';
  });
}

function toggleSection(hdr){
  var body = hdr.nextElementSibling;
  var arrow = hdr.querySelector('.sec-arrow') || hdr.querySelector('span:last-child');
  if(!body || !body.classList.contains('section-body')) return;
  var collapse = (body.style.display !== 'none');
  body.style.display = collapse ? 'none' : '';
  if(arrow) arrow.textContent = collapse ? '▶' : '▼';
  hdr.classList.toggle('sec-collapsed', collapse);
  // v5.36.0 · 折叠状态持久化 (panel + section 序号)
  try {
    var panel = hdr.closest('.panel');
    var pid = panel ? panel.id.replace('panel-','') : 'x';
    var secs = panel ? panel.querySelectorAll('.section-header') : [];
    var idx = Array.prototype.indexOf.call(secs, hdr);
    var st = JSON.parse(localStorage.getItem('sec_collapse')||'{}')||{};
    st[pid+'_'+idx] = collapse;
    localStorage.setItem('sec_collapse', JSON.stringify(st));
  } catch(e){}
}
// v5.36.0 · 全页面 section 折叠/展开: 无 onclick 的 header 自动注入 (含 cursor:default 的)
//   · 点击目标为按钮/输入/链接时不误触
//   · 自动补 ▼/▶ 箭头指示 + 手型光标
//   · 启动时按持久化状态恢复折叠
function autoWireSections(root){
  (root || document).querySelectorAll('.section-header').forEach(function(hdr){
    if(hdr.dataset.secWired) return;
    hdr.dataset.secWired = '1';
    var hasOnclick = (hdr.getAttribute('onclick')||'').indexOf('toggleSection') >= 0;
    if(!hasOnclick){
      hdr.style.cursor = 'pointer';
      hdr.addEventListener('click', function(ev){
        var tg = ev.target;
        if(tg && tg.closest && tg.closest('button,input,select,textarea,a,.btn')) return;
        toggleSection(hdr);
      });
    }
    // 箭头指示 (已有 onclick 的老 section 也有箭头, 只补缺的)
    if(!hdr.querySelector('.sec-arrow') && !(hdr.getAttribute('onclick')||'').indexOf('toggleSection')){
      // 老 onclick 写法靠 span:last-child, 不动它的 DOM
    } else if(!hdr.querySelector('.sec-arrow')){
      var sp = document.createElement('span');
      sp.className = 'sec-arrow';
      sp.style.cssText = 'color:var(--text3);font-size:10px;margin-left:auto;padding-left:8px';
      sp.textContent = '▼';
      hdr.appendChild(sp);
    }
    // 恢复持久化的折叠状态
    try {
      var panel = hdr.closest('.panel');
      var pid = panel ? panel.id.replace('panel-','') : 'x';
      var secs = panel ? panel.querySelectorAll('.section-header') : [];
      var idx = Array.prototype.indexOf.call(secs, hdr);
      var st = JSON.parse(localStorage.getItem('sec_collapse')||'{}')||{};
      if(st[pid+'_'+idx]){
        var body = hdr.nextElementSibling;
        if(body && body.classList.contains('section-body')){
          body.style.display = 'none';
          var ar = hdr.querySelector('.sec-arrow');
          if(ar) ar.textContent = '▶';
          hdr.classList.add('sec-collapsed');
        }
      }
    } catch(e){}
  });
}
window.autoWireSections = autoWireSections;
window.toggleSection = toggleSection;

function selectSidebar(el){
  document.querySelectorAll('.sidebar-item').forEach(function(i){i.classList.remove('active')});
  el.classList.add('active');
}

// ------------------------------------------
// 连接配置管理
// ------------------------------------------
var configs = JSON.parse(localStorage.getItem('rsync_configs') || '[]');

// v3.1.0: panel_scope 常量与显示
var PANEL_SCOPES = {};   // v5.35.0 · G3: scope 体系退役 (分组树取代)

// panel_id → scope key（点新建时按当前 panel 提议归属）
var PANEL_TO_SCOPE_DEFAULT = {
  transfer:'', proxmox:'proxmox_g', vzdump:'proxmox_g', pbs:'proxmox_g', auto_backup:'proxmox_g',
  lvm:'lvm', zfs:'zfs', rbd:'rbd', terminal:'', docker:'docker', dbbackup:'dbbackup'
};
// 判断某个 scope 在当前 panel 是否可见

window._scopeVisibleOnPanel = _scopeVisibleOnPanel;

// v4.39.2 · df 挂载点友好显示: 来源-挂载点短名 (192.168.1.20:data-01a017da)
//   · //192.168.1.20/data  → 192.168.1.20:data
//   · /dev/sda2            → /dev/sda2 (根挂载省略 -/)
//   · 共享挂载点 uuid 取前 8 位
window.fmtDfLabel = function(mt){
  try {
    if(!mt) return '';
    var src = mt.source || '';
    var mnt = mt.mount || '';
    var srcShort = src;
    if (src.indexOf('//') === 0){
      // cifs: //host/share -> host:share
      var rest = src.slice(2);
      var slash = rest.indexOf('/');
      if (slash > 0) srcShort = rest.slice(0, slash) + ':' + rest.slice(slash + 1);
      else srcShort = rest;
    } else if (/^[^\/]+:\//.test(src) && src.indexOf('://') < 0){
      // nfs: host:/path -> host:path
      srcShort = src.replace(/:\//, ':');
    }
    // 共享挂载点: 取 uuid 前 8 位
    var m = /\/var\/lib\/fonriv_mounts\/shares\/([0-9a-f]{8})/.exec(mnt);
    if (m){
      return srcShort + '-' + m[1];
    }
    // 普通挂载: 根挂载只显示来源; 其他 来源-挂载点
    if (mnt === '/' || mnt === srcShort) return srcShort;
    return srcShort + '-' + mnt;
  } catch(_){ return mt.mount || ''; }
};


// ═══════════════════════════════════════════════════════════
// v5.35.0 · G3 零遗留: 原 configs 保存/载入全家 → 连接中心档案
//   按钮名保留 (各面板 onclick 不变), 语义换轨为 server_profiles
// ═══════════════════════════════════════════════════════════
function _activePanelKey(){
  var el = document.querySelector('.panel.active');
  return el ? el.id.replace(/^panel-/,'') : 'transfer';
}
function saveCurrentConfig(){
  // → 保存当前面板到服务器档案 (增量合并, 密码留空=保持原值)
  if(!window.SP){ toast('连接中心未就绪', 'warn'); return; }
  var key = _activePanelKey();
  if(key === 'disk_manager'){ return saveCurrentConfig_dm(); }
  SP.saveFromPanel(key).then(function(r){
    if(r && r.status === 'ok'){ SP.forgetAll(); if(SP.renderSidebarSection){ var cl=document.getElementById('configList'); if(cl) SP.renderSidebarSection(cl); } }
  });
}
function saveCurrentConfig_dm(){ saveCurrentConfig.__dm = true; if(!window.SP) return;
  SP.saveFromPanel('disk_manager').then(function(r){
    if(r && r.status === 'ok'){ SP.forgetAll(); var cl=document.getElementById('configList'); if(cl) SP.renderSidebarSection(cl); }
  }); }
function loadConfigToPanel(){
  if(typeof toast === 'function') toast('📂 请点左侧「服务器档案」选择服务器 (自动填入本页)', 'info', 3200);
}
function loadConfigToPanel_dm(){ loadConfigToPanel(); }
function applyConfig(){ /* v5.35.0 · 语义由 SP.fillPanel 承担 */ }
function selectConfig(){ /* 侧栏档案点击由 SP 接管 */ }
// v5.35.0 热修: 顶层 window.X = X 自引用的 4 个函数补 stub
//   (缺失 → 顶层 ReferenceError → app.js 执行中断 → NAV_TREE 未赋值 → 主菜单全灭)
function _scopeVisibleOnPanel(){ return true; }        // 单轨: 档案全页可见
function saveAsCopyForCurrentPanel(){                  // 副本 → 连接中心新建
  if(typeof switchTab === 'function') switchTab('conn_center');
  setTimeout(function(){ try{ window.ConnCenter && window.ConnCenter.editorOpen(); }catch(e){} }, 400);
}
function diagnoseConfigs(){                            // 诊断 → 档案一致性由连接中心承担
  if(typeof toast === 'function') toast('配置诊断已并入连接中心 (单一档案, 无需诊断)', 'info', 3200);
}
function clearAllConfigs(){                            // 清空 → 引导到连接中心批量删除
  if(typeof toast === 'function') toast('请在连接中心批量管理服务器档案', 'info', 3200);
}

function loadConfigs(){
  // v5.35.0 · G1 零遗留: 侧栏单轨化 — 只渲染「服务器档案+多层分组」(server_profiles)
  //   原 configs 渲染 (scope 分桶/4按钮/草稿) 整体退役; 数据与交互全部走连接中心档案
  var cl = document.getElementById('configList');
  if(!cl) return;
  try{ if(window.SP) window.SP.renderSidebarSection(cl); }catch(e){ console.warn('[sidebar] SP render fail', e); }
}
function _findConfigIdxByUid(){ /* v5.35.0 · G3: configs 退役 */ }

function selectConfigByUid(){ /* v5.35.0 · G3: configs 退役 */ }
function deleteConfigByUid(){ /* v5.35.0 · G3: configs 退役 */ }


function moveConfigByUid(){ /* v5.35.0 · G3: 排序由连接中心分组承担 */ }
window.moveConfigByUid = moveConfigByUid;



// v2.9.6: 抽出 update payload 构造 —— 供 saveCurrentConfig 与 create 完成后 flush 排队 save 共用






// v6.3.28 · configPromptModal 已迁到 **static/rp_dialogs.js**(与 _showC2Modal/rp* 同处),
//   三个页面(主界面 / guac.html / novnc.html)共用一份实现; 对外 API 不变。

function deleteConfig(){ /* v5.35.0 · G3: configs 退役 */ }

function renameConfig(){
  // v5.35.0 · G3: 重命名走档案 (连接中心编辑弹窗)
  if(typeof toast === 'function') toast('重命名请在连接中心 · 编辑档案 中操作', 'info', 2800);
  if(typeof switchTab === 'function') switchTab('conn_center');
}







// v2.9.3 面板描述表 · 统一版
// 简化：所有面板共享 cfg.host / cfg.port / cfg.user / cfg.auth_type / cfg.auth_value 一组
// 每个面板只维护 UI id 映射 + 面板专属字段（extras）
// 保存策略：任意面板点保存 → 写入 cfg 主字段 → 全部面板载入时都用这一份
var PANEL_FIELDS = {
  terminal:   { host:'termSrvHost',  port:'termSrvPort',    user:'termSrvUser', at:'termAuthType',    av:'termAuthValue', extras:[] },
  transfer:   { host:'srvHost',  port:'srvPort',    user:'srvUser', at:'authType',    av:'authValue', extras:[] },
  // v4.38.36 · disk_manager 面板: DM 表单字段 (srvHost_dm 等) -> cfg 主字段 host/port/user
  disk_manager: { host:'srvHost_dm', port:'srvPort_dm', user:'srvUser_dm', at:'authType_dm', av:'authValue_dm', extras:[] },
  proxmox:    { host:'pveHost',  port:'pveSshPort', user:'pveUser', at:'pveAuthType', av:'pveAuthValue', extras:[{id:'backupDst',cfgKey:'backupDst',dflt:'/mnt/backup/proxmox/'}] },
  vzdump:     { host:'vdHost',   port:'vdPort',     user:'vdUser',  at:'vdAuthType',  av:'vdAuthValue',  extras:[{id:'vdTmpDir',cfgKey:'vdTmpDir',dflt:'/var/lib/vz/dump/'},{id:'vdLocalDir',cfgKey:'vdLocalDir',dflt:'/mnt/backup/vzdump/'}] },
  lvm:        { host:'lvmHost',  port:'lvmPort',    user:'lvmUser', at:'lvmAuthType', av:'lvmPass',      extras:[{id:'lvmLocalDir',cfgKey:'lvmLocalDir',dflt:'/mnt/backup/lvm/'}] },
  zfs:        { host:'zfsHost',  port:'zfsPort',    user:'zfsUser', at:'zfsAuthType', av:'zfsPass',      extras:[{id:'zfsLocalDir',cfgKey:'zfsLocalDir',dflt:'/mnt/backup/zfs/'}] },
  rbd:        { host:'rbdHost',  port:'rbdPort',    user:'rbdUser', at:'rbdAuthType', av:'rbdPass',      extras:[{id:'rbdLocalDir',cfgKey:'rbdLocalDir',dflt:'/mnt/backup/rbd/'},{id:'rbdPool',cfgKey:'rbdPool',dflt:'rbd'}] },
  pbs:        { host:'pbsHost',  port:'pbsPort',    user:'pbsUser', at:'pbsAuthType', av:'pbsPass',      extras:[{id:'pbsServer',cfgKey:'pbsServer',dflt:''},{id:'pbsDatastore',cfgKey:'pbsDatastore',dflt:''},{id:'pbsApiUser',cfgKey:'pbsApiUser',dflt:''}] },
  auto_backup:{ host:'abHost',   port:'abPort',     user:'abUser',  at:'abAuthType',  av:'abAuthValue',  extras:[{id:'abLocalDst',cfgKey:'abLocalDst',dflt:'/mnt/backup/auto/'},{id:'abExtraPaths',cfgKey:'abExtraPaths',dflt:''}] },
  platform_backup:{ host:'pbHost', port:'pbPort',   user:'pbUser',  at:'pbAuthType',  av:'pbAuthValue',  extras:[{id:'pbKeyPath',cfgKey:'auth_value',dflt:''},{id:'pbExtraPaths',cfgKey:'pbExtraPaths',dflt:''},{id:'pbLocalDir',cfgKey:'pbLocalDir',dflt:''}] },
  // v4.49.0 · Docker 容器管理页接入标准连接表单 (侧栏列表直连/保存)
  docker:     { host:'dockerHost', port:'dockerPort', user:'dockerUser', at:'dockerAuthType', av:'dockerAuthValue', extras:[] },
  dbbackup:   { host:'dbbSshHost', port:'dbbSshPort', user:'dbbSshUser', at:'dbbSshAuthType', av:'dbbSshAuthValue', extras:[] },
};

// 面板 key → 显示名（用于「另存为」自动命名）
var PANEL_LABEL = {
  transfer:'文件传输', proxmox:'PVE', vzdump:'vzdump',
  lvm:'LVM', zfs:'ZFS', rbd:'RBD', pbs:'PBS', auto_backup:'一键备份',
  platform_backup:'通用配置备份', docker:'容器管理', dbbackup:'数据库备份'
};



// 从配置中提取第一个有值的服务器信息（用于跨面板共享）
// 已知历史默认脏值（避免作为兜底填回，见 Phase A）
var DIRTY_HOST_DEFAULTS = {'192.168.1.1':1,'192.168.1.10':1,'192.168.1.100':1};
function _cleanHost(h){ return (h && !DIRTY_HOST_DEFAULTS[h]) ? h : ''; }

function getSharedServerConfig(cfg){
  // 主 host 优先来自 cfg.host（transfer 面板/主配置），其它 xxxHost 作为回退
  var panels = [
    { host: _cleanHost(cfg.host), port: cfg.port, user: cfg.user, auth_type: cfg.auth_type, auth_value: cfg.auth_value },
    { host: _cleanHost(cfg.pveHost), port: cfg.pvePort, user: cfg.pveUser, auth_type: cfg.pveAuthType, auth_value: cfg.pveAuthValue },
    { host: _cleanHost(cfg.vdHost), port: cfg.vdPort, user: cfg.vdUser, auth_type: cfg.vdAuthType, auth_value: cfg.vdAuthValue },
    { host: _cleanHost(cfg.lvmHost), port: cfg.lvmPort, user: cfg.lvmUser, auth_type: cfg.lvmAuthType, auth_value: cfg.lvmAuthValue },
    { host: _cleanHost(cfg.zfsHost), port: cfg.zfsPort, user: cfg.zfsUser, auth_type: cfg.zfsAuthType, auth_value: cfg.zfsAuthValue },
    { host: _cleanHost(cfg.rbdHost), port: cfg.rbdPort, user: cfg.rbdUser, auth_type: cfg.rbdAuthType, auth_value: cfg.rbdAuthValue },
    { host: _cleanHost(cfg.pbsHost), port: cfg.pbsPort, user: cfg.pbsUser, auth_type: cfg.pbsAuthType, auth_value: cfg.pbsAuthValue },
    { host: _cleanHost(cfg.abHost), port: cfg.abPort, user: cfg.abUser, auth_type: cfg.abAuthType, auth_value: cfg.abAuthValue }
  ];
  for(var i = 0; i < panels.length; i++){
    if(panels[i].host){ return panels[i]; }
  }
  return { host: '', port: '22', user: 'root', auth_type: 'pass', auth_value: '' };
}

// 保存当前表单到激活配置
// v2.9.8 精简版策略：
//   1) 无激活 cfg  → 弹 modal 引导起名 → 建 draft → 递归调本函数
//   2) draft cfg   → 读表单 → 发 DB create → 拿到 db_id → 发 update → toast
//   3) 已保存 cfg + IP 未变 → 直接 update → toast
//   4) 已保存 cfg + IP 变化 → 弹 modal「另存 or 覆盖」，用户选择
//   IP 检测【只在此函数被调用时】发生。选中 sidebar 配置 / 载入 / 切页 · 都不弹。


// v2.9.8: 弹「另存 or 覆盖」modal（自定义 modal，不用 confirm，避免"不允许再次提示"）


// v2.9.8: 实际把 UI 数据写入 cfg + 落 DB


function _showSaveToast(cfg){
  var msg = '✅ 保存 ' + (cfg.name||'配置') + ' 成功' + (cfg.db_id != null ? ' (#'+cfg.db_id+')' : '');
  // v3.0.1: toast 时长 2.6s → 2.0s（略缩）
  if(typeof toast === 'function') toast(msg, 'success', 2000);
  else if(typeof toastOk === 'function') toastOk(msg);
}

// v2.9.8: 把当前激活配置的 #db_id 追加到所有面板 host 标签后
function _refreshHostLabelIds(){
  var idx = -1;
  configs.forEach(function(c,i){ if(c._active) idx = i; });
  if(idx < 0) return;
  var cfg = configs[idx];
  var tag = cfg._draft ? '[草稿]' : (cfg.db_id != null ? ('#'+cfg.db_id) : '#未同步');
  var nameTag = ' · ' + tag + ' ' + (cfg.name||'');
  // 找每个面板的 host input，它前面通常有一个 <label>，把当前 cfg 的 id 追加到 label 尾部
  Object.keys(PANEL_FIELDS).forEach(function(pfx){
    var f = PANEL_FIELDS[pfx];
    var hostEl = gvEl(f.host);
    if(!hostEl) return;
    // 找最近的 <label>（在 .field 容器里）
    var field = hostEl.closest && hostEl.closest('.field');
    if(!field) return;
    var label = field.querySelector('label');
    if(!label) return;
    // 找/建 span.cfg-id-tag
    var tagSpan = label.querySelector('.cfg-id-tag');
    if(!tagSpan){
      tagSpan = document.createElement('span');
      tagSpan.className = 'cfg-id-tag';
      tagSpan.style.cssText = 'font-size:10px;color:var(--text3);margin-left:6px;font-weight:normal';
      label.appendChild(tagSpan);
    }
    tagSpan.textContent = nameTag;
  });
}
window._refreshHostLabelIds = _refreshHostLabelIds;


// vzdump 保存：先保存本地参数，再保存到全局配置
function saveVdAndConfig(){
  saveVdParams();
  saveCurrentConfig();
}

function gvEl(id){ return document.getElementById(id); }

// ------------------------------------------
// 通用传输面板命令生成
// ------------------------------------------
// v4.38.26 · setDirection 改为 setDirection(scope, d)
//   - scope: 'transfer' (transfer panel) | 'disk_manager' (dm panel) | 不传则兼容旧调用
//   - 通知所有活着的 TransferTri 实例同步切换
function setDirection(scope, d){
  if (!d){
    // 兼容旧调用 setDirection(d)
    d = scope;
    scope = 'transfer';
  }
  direction = d;
  // 1) 更新 transfer panel 的 5 个按钮 active 态 (含 'same')
  ['up','down','cross','sync','same'].forEach(function(x){
    var cap=x.charAt(0).toUpperCase()+x.slice(1);
    var e=document.getElementById('dir'+cap);
    if(e) e.classList.remove('active');
  });
  var cap=d.charAt(0).toUpperCase()+d.slice(1);
  var e=document.getElementById('dir'+cap);
  if(e) e.classList.add('active');
  // 2) 更新 dm panel 的 5 个按钮 (id 后缀 _dm) active 态 (含 'same')
  ['up','down','cross','sync','same'].forEach(function(x){
    var cap=x.charAt(0).toUpperCase()+x.slice(1);
    var e=document.getElementById('dir'+cap+'_dm');
    if(e) e.classList.remove('active');
  });
  var eDm=document.getElementById('dir'+cap+'_dm');
  if(eDm) eDm.classList.add('active');

  // v4.38.26 · 通知所有活着的 TransferTri 实例
  try {
    if (window._triInstances){
      for (var k in window._triInstances){
        try {
          var inst = window._triInstances[k];
          if (inst && inst.scope === scope && inst.setDirection){
            inst.setDirection(d);
          }
        } catch(_e){ console.warn('[setDirection→tri '+k+']', _e); }
      }
    }
  } catch(err){ console.warn('[setDirection→tri]', err); }

  // v4.38.26 · disk_manager scope: 兜底,若 tri 实例不存在,尝试自动创建
  if (scope === 'disk_manager'){
    try {
      var exists = window._triInstances && window._triInstances['disk_manager'];
      if (!exists && window.TransferTri && window.TransferTri.create){
        var host = document.getElementById('dm-tri-host');
        if (host){
          var srvList = (window.SrvPool && window.SrvPool.getSrvList) ? window.SrvPool.getSrvList() : [];
          // 优先从当前 dm form 读 srv auth
          var dmSrv = { host:'', port:22, user:'root', auth_type:'pass', password:'', key:'' };
          try {
            var h = document.getElementById('srvHost_dm'); if (h) dmSrv.host = h.value;
            var p = document.getElementById('srvPort_dm'); if (p) dmSrv.port = parseInt(p.value)||22;
            var u = document.getElementById('srvUser_dm'); if (u) dmSrv.user = u.value;
            var at = document.getElementById('authType_dm'); if (at) dmSrv.auth_type = at.value;
            var av = document.getElementById('authValue_dm');
            if (av) { if (dmSrv.auth_type==='key') dmSrv.key = av.value; else dmSrv.password = av.value; }
          } catch(_){}
          window.TransferTri.create(host, {
            scope: 'disk_manager',
            srvList: srvList,
            direction: d,   // v4.38.26 · 用 opts.direction (TransferTri 用 direction 不是 initialDirection)
            srvAuth: dmSrv,
            hideDirBtn: true,  // v4.38.29 · 外部已有 dir-btn, 隐藏内部
            dmSshSource: true, // v4.38.33 · 源栏改走 disk_list_dir (SSH), 不再用本地 list_dir
            onLog: function(line, level){
              // v4.38.36 · bug C 修复: window.diskManagerInstance 全局不存在, 旧回调永远走 catch
              //   -> TransferTri 全部日志 (含 "▶ 开始传输") 静默丢失, 用户看到"点了没反应"。
              //   改走 TransferLog.append('disk_manager') -- 与 DiskManager._log 相同路径。
              //   (TransferLog.log 内部已加时间戳, 此处不再手动加, 避免双时间戳)
              try {
                if (window.TransferLog && typeof window.TransferLog.append === 'function'){
                  window.TransferLog.append('disk_manager', line, level);
                }
              } catch(_){}
              if (window.diskManagerInstance && window.diskManagerInstance._log){
                try { window.diskManagerInstance._log(line, level); } catch(_){}
              }
              if (window.diskManagerLog){
                try { window.diskManagerLog.push(line, level); } catch(_){}
              }
            }
          });
          // v4.38.31 · 拉远端服务器列表 (与 transfer panel 一致)
          // v1.0.0 · 社区档无"远端存储"→ 跳过(该面板在社区版本就不出现，白拉会刷"未知 action")
          if(window.__featInEdition && !window.__featInEdition('cloud')) return;
          try {
            if (typeof window.send === 'function'){
              window.send({ action: 'remote_list' }, function(d){
                // v4.38.35 · 云存储缓存 (UniPane ☁ 分组数据源)
                if (d && d.status === 'ok' && d.remotes){
                  window.__cloudRemotesCache = d.remotes;
                }
                // v5.50.0 修: 此分支原读 d.servers (remote_list 不返回该字段) → SrvPool 恒空,
                //   DM 三栏「服务器」分组永远显示"（无 · ✚临时 或到服务器面板添加）" →
                //   选不到其他机器而回落「本机:/」(用户报的"打开其他机器显示本机根目录")。
                //   改为统一数据源 SP.serverRows() (与连接中心/侧栏同源 server_profiles)。
                try {
                  if (window.SP && window.SP.serverRows){
                    window.SP.serverRows().then(function(msg){
                      var arr = (msg && msg.configs) || [];
                      if (!arr.length) return;
                      if (window.SrvPool) window.SrvPool.setSrvList(arr);
                      var tri = window._triInstances && window._triInstances['disk_manager'];
                      if (tri && tri.setSrvList) tri.setSrvList(arr);
                      if (window.diskManagerLog){
                        try { window.diskManagerLog.push('✓ 已加载 ' + arr.length + ' 台服务器 (server_profiles)', 'ok'); } catch(_){}
                      }
                    }).catch(function(){});
                  }
                } catch(_){}
              });
            }
          } catch(e){ console.warn('[dm] remote_list fail', e); }
        }
      } else if (exists && exists.setDirection){
        // 已经在 _tryInject 路径 (browse 时) 调过,再确保方向
        try { exists.setDirection(d); } catch(_){}
      }
    } catch(e){ console.warn('[setDirection auto-mount dm tri]', e); }
  }

  // 向后兼容旧的 TriPaneTransfer 单例
  try { if (window.TriPaneTransfer && window.TriPaneTransfer.setDirection) window.TriPaneTransfer.setDirection(d); } catch(err){}
  buildCmd();
}
window.setDirection = setDirection;  // v4.38.32 · 导出供 openPathInTri 懒创建使用

// v4.38.17 · 传输参数模块显示/隐藏（小白隐藏、高手展开）
// v4.38.18 · 按钮文字随状态切换「⚙ 高级设置」/「✓ 高级设置（已展开）」
function toggleTransferParams(){
  var sec = document.getElementById('transferParamsSection');
  if (!sec) return;
  var visible = sec.style.display !== 'none';
  sec.style.display = visible ? 'none' : '';
  try { localStorage.setItem('transferParamsVisible', visible ? '0' : '1'); }catch(_){}
  var btn = document.getElementById('transferParamsToggle');
  if (btn){
    btn.textContent = visible ? '⚙ 显示/隐藏传输参数' : '✓ 传输参数（已展开）';
    btn.style.background = visible ? 'var(--bg3)' : 'var(--cyan)';
    btn.style.color = visible ? 'var(--cyan)' : 'var(--bg)';
  }
}
function _restoreTransferParamsState(){
  var sec = document.getElementById('transferParamsSection');
  if (!sec) return;
  var v;
  try { v = localStorage.getItem('transferParamsVisible'); }catch(_){}
  // 默认隐藏（小白友好）· 仅当显式设为 '1' 时显示
  if (v !== '1'){ sec.style.display = 'none'; }
  var btn = document.getElementById('transferParamsToggle');
  if (btn){
    var show = (v === '1');
    btn.textContent = show ? '✓ 传输参数（已展开）' : '⚙ 显示/隐藏传输参数';
    btn.style.background = show ? 'var(--cyan)' : 'var(--bg3)';
    btn.style.color = show ? 'var(--bg)' : 'var(--cyan)';
  }
}

function toggleTag(el,flag){
  if(activeFlags.has(flag)){activeFlags.delete(flag);el.classList.remove('active');}
  else{activeFlags.add(flag);el.classList.add('active');}
  buildCmd();
}

function buildCmd(){
  var host=gv('srvHost')||'192.168.1.100';
  var port=gv('srvPort')||'22';
  var user=gv('srvUser')||'root';
  var src=gv('srcPath')||'/local/path/';
  var dst=gv('dstPath')||'/remote/path/';
  var bw=gv('bwLimit');
  var ex=gv('excludePat');
  
  var flags=Array.from(activeFlags).join(' ');
  if(activeFlags.has('--bwlimit')&&bw&&bw!=='0') flags=flags.replace('--bwlimit','--bwlimit='+bw);
  var excludeStr='';
  if(activeFlags.has('--exclude')&&ex){
    ex.split(',').forEach(function(p){if(p.trim())excludeStr+=" --exclude='"+p.trim()+"'";});
    flags=flags.replace('--exclude','');
  }
  var ssh='-e "ssh -p '+port+'"';
  // v4.38.16: src 可含多行（多源上传），每行一个路径分行渲染
  var srcLines = src.split('\n').filter(function(s){ return s.trim(); });
  var srcBlock = srcLines.length > 1
    ? srcLines.join(' \\\n  ')
    : src;
  var cmd;
  if(direction==='up') cmd='rsync '+flags+excludeStr+' '+ssh+' \\\n  '+srcBlock+' \\\n  '+user+'@'+host+':'+dst;
  else if(direction==='down') cmd='rsync '+flags+excludeStr+' '+ssh+' \\\n  '+user+'@'+host+':'+src+' \\\n  '+dst;
  else cmd='# 双向同步\nrsync '+flags+excludeStr+' '+ssh+' '+src+' '+user+'@'+host+':'+dst+'\nrsync '+flags+excludeStr+' '+ssh+' '+user+'@'+host+':'+dst+' '+src;
  
  var el=document.getElementById('cmdPreview');
  if(el) el.textContent=cmd;
}

// ------------------------------------------
// 界面 Auth 输入框联动逻辑
// ------------------------------------------
// ============================================
// ConnPanel: 通用连接面板 auth UI 与 auth 读取
// spec: { valueId, passphraseId, passLabel?, browseDir? }
// ============================================
function ConnPanel_renderAuth(prefix, spec){
  var typeSel = document.getElementById(spec.typeId || (prefix + 'AuthType'));
  var f = document.getElementById(spec.fieldId || (prefix + 'AuthField'));
  if(!typeSel || !f) return;
  var t = typeSel.value || 'pass';
  var valueId = spec.valueId;
  var ppId = spec.passphraseId;
  var passLabel = spec.passLabel || '登录密码';
  var browseDir = spec.browseDir || '/root/.ssh/';
  // v2.6.1 安全修复：切换认证方式时不再复用输入框内容
  // 之前 bug: pass 模式下输入密码 → 切 key 模式 → oldInput.value（含密码明文）会被回填到"SSH 私钥路径"
  //          导致密码以明文出现在 text 类型输入框中，严重泄漏
  // 修复：切换认证方式时清空旧输入框，只在同类型内保留（key ↔ key，pass ↔ pass 均视为切换）
  var oldInput = f.querySelector('input');
  var oldType = oldInput ? oldInput.getAttribute('type') : '';
  // 只在切换到 key 且原本也是 key（text 类型）时保留旧值，其余全部清空
  var oldVal = '';
  if(t === 'key' && oldType === 'text' && oldInput){
    oldVal = oldInput.value;
  }
  // 找到父级 .auth-row，切换 key-mode class（用于双列布局）
  var authRow = f.closest('.auth-row');
  if(t === 'pass'){
    if(authRow) authRow.classList.remove('key-mode');
    f.innerHTML = '<label><span class="required-star">*</span>' + passLabel + '</label>' +
      '<input type="password" id="' + valueId + '" placeholder="请输入服务器密码" autocomplete="new-password">';
  } else {
    if(authRow) authRow.classList.add('key-mode');
    // v5.90.2 · 去掉 '~/.ssh/id_rsa' 预填 (控制机上多半不存在该文件 → 拿着假路径去连必然列不出目录),
    //   改由统一密钥选择器 (本机/df/共享/已存服务器/远端存储/粘贴) 选真实密钥
    f.innerHTML = '<label><span class="required-star">*</span>SSH 私钥路径</label>' +
      '<div class="browse-row">' +
        '<input type="text" id="' + valueId + '" placeholder="密钥路径 — 点 🔑 从本机/df挂载点/网络共享/服务器/云端选, 或直接粘贴密钥内容" autocomplete="off">' +
        '<button class="btn btn-sm" data-kp-btn="1" onclick="(window.KeyPicker ? KeyPicker.pickInto(\'' + valueId + '\') : openDirBrowser(document.getElementById(\'' + valueId + '\'),\'' + browseDir + '\'))">🔑</button>' +
      '</div>';
    // v6.16.2 批18 · 修重复 🔑 按钮(用户实测社区版同一行出现两个): 构建完当场把同行多余 🔑 按钮清掉
    (function(){
      var _row = f.querySelector('.browse-row');
      if (!_row) return;
      var _seen = false;
      Array.prototype.forEach.call(_row.querySelectorAll('button'), function(b){
        if ((b.textContent || '').trim() === '🔑'){ if (_seen) b.remove(); else _seen = true; }
      });
    })();
    // 移除旧的 passphrase field
    var oldPP = authRow ? authRow.querySelector('.passphrase-field') : null;
    if(oldPP) oldPP.remove();
    // 新建 passphrase field 作为 auth-row 第二列（始终清空旧值，防止密码残留）
    if(authRow){
      var ppField = document.createElement('div');
      ppField.className = 'field passphrase-field';
      ppField.innerHTML = '<label>私钥密码短语</label>' +
        '<input type="password" id="' + ppId + '" placeholder="留空则无密码短语" autocomplete="new-password">';
      authRow.appendChild(ppField);
    }
  }
  // pass 模式：清理残留 passphrase field
  if(t === 'pass' && authRow){
    var stalePP = authRow.querySelector('.passphrase-field');
    if(stalePP) stalePP.remove();
  }
}
function ConnPanel_getAuth(prefix, spec){
  var t = gv(spec.typeId || (prefix + 'AuthType')) || 'pass';
  var val = gv(spec.valueId);
  var pp = gv(spec.passphraseId) || '';
  // v1.0.0 · FIX(用户实测"文件传输里必须在列表里再输一遍密码, 之前连接中心连过就能直接用"):
  //   表单未填密码/密钥时, 回落到 server_profiles 凭据缓存(SP.resolve 预热, 与 getSrvAuth 同口径)。
  //   此前 getSrvAuth 有这条兜底而 getTransferAuth/本函数没有 → 传输/检测拿空密码 → SSH 失败。
  if (!val && window.SP && typeof window.SP.cachedCreds === 'function'){
    try {
      var _h = gv('srvHost') || gv('srvHost_dm') || '';
      var _p = gv('srvPort') || gv('srvPort_dm') || '22';
      var _c = _h ? window.SP.cachedCreds(_h, _p) : null;
      if (_c && (_c.password || _c.key)){
        var _ct = _c.auth_type || t;
        return { auth_type: _ct,
                 password: _ct === 'pass' ? (_c.password || '') : '',
                 key: _ct === 'key' ? (_c.key || '') : '',
                 passphrase: _ct === 'key' ? (_c.passphrase || '') : '' };
      }
    } catch(e){}
  }
  return {
    auth_type: t,
    password: t === 'pass' ? encodePassword(val) : '',
    key: t === 'key' ? encodePassword(val) : '',
    passphrase: t === 'key' ? encodePassword(pp) : ''
  };
}

// v3.5.0: 把 auth block 里的 password/key/passphrase 升级到 EC1: 真加密。
//   使用点：先 `var auth = getXxxAuth();`，再 `auth = await upgradeAuthToEC1(auth);`
//   浏览器不支持 SubtleCrypto 或 pubkey 未就绪 → 静默 fallback 保留原 ENC: 值。
//   相当于做了一次"密码通道升级 pass"，业务函数只需要在最上游 await 一次即可。
async function upgradeAuthToEC1(auth){
  if(!auth || typeof encodePasswordAsync !== 'function') return auth;
  try {
    async function _up(field){
      var v = auth[field];
      if(!v) return;
      // 已经是 EC1 就跳过
      if(typeof v === 'string' && v.startsWith('EC1:')) return;
      // 若是 ENC:xxx 先解回明文再升级
      var plain = v;
      if(typeof v === 'string' && v.startsWith('ENC:')){
        try { plain = decodeURIComponent(escape(atob(v.slice(4)))); }
        catch(e){ plain = v; }
      }
      var enc = await encodePasswordAsync(plain);
      auth[field] = enc;
    }
    await _up('password');
    await _up('key');
    await _up('passphrase');
  } catch(e){
    console.warn('[crypto] upgradeAuthToEC1 failed, keeping ENC:', e);
  }
  return auth;
}
window.upgradeAuthToEC1 = upgradeAuthToEC1;

function updateAuthUI(){
  ConnPanel_renderAuth('', { typeId:'authType', fieldId:'authField', valueId:'authValue', passphraseId:'authPassphrase', passLabel:'登录密码', passPlaceholder:'请输入服务器密码' });
}

// ═══ v5.20.0 · 远端 OS 识别 (Windows / macOS 端点) ═══
function onOsTypeChange(){
  var sel = document.getElementById('srvOsType');
  var box = document.getElementById('osDetectBox');
  if (!sel || !box || sel.value === 'auto') return;
  if (sel.value === 'windows'){
    box.style.display = '';
    box.style.background = 'rgba(120,160,255,.10)';
    box.style.color = 'var(--text2)';
    box.innerHTML = '🪟 <b>Windows 远端</b>: 命令走 PowerShell, 路径用 <code>C:\\...</code> 形式。<br/>'
      + 'Windows 原生没有 rsync, 传输会自动改用 <b>rclone (sftp)</b>。<br/>'
      + '前提: 远端已启用 OpenSSH Server (<code>Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0</code>)。';
  } else if (sel.value === 'macos'){
    box.style.display = '';
    box.style.background = 'rgba(120,255,180,.10)';
    box.style.color = 'var(--text2)';
    box.innerHTML = '🍎 <b>macOS 远端</b>: 路径是 POSIX, 但系统自带 rsync 长期为 2.6.9 / 新版 openrsync, '
      + '协议版本存疑 → 传输默认走 <b>rclone (sftp)</b>。<br/>'
      + '前提: 系统设置 → 通用 → 共享 → 打开「远程登录」。';
  } else {
    box.style.display = 'none';
  }
}

// 本地体积格式化 (dashboard.js 的 fmtBytes 在其 IIFE 内, 跨文件不可见, 故自带一份)
function _osFmtSize(n){
  n = Number(n) || 0;
  var u = ['B','KB','MB','GB','TB','PB'], i = 0;
  while (n >= 1024 && i < u.length - 1){ n /= 1024; i++; }
  return (i === 0 ? n : n.toFixed(n < 10 ? 1 : 0)) + ' ' + u[i];
}

function detectRemoteOs(){
  var a = (typeof getSrvAuth === 'function') ? getSrvAuth() : null;
  var box = document.getElementById('osDetectBox');
  if (!a || !a.host){
    if (box){ box.style.display=''; box.style.background='rgba(255,120,120,.12)';
      box.innerHTML = '⚠ 请先填写主机 IP / 域名'; }
    return;
  }
  if (box){ box.style.display=''; box.style.background='var(--bg3)'; box.style.color='var(--text2)';
    box.innerHTML = '⏳ 正在连接远端识别系统…'; }
  send(Object.assign({ action: 'remote_os_detect', with_disks: true }, a), function(r){
    if (!box) return;
    if (!r || r.status !== 'ok'){
      box.style.background = 'rgba(255,120,120,.12)';
      box.innerHTML = '✗ 识别失败: ' + ((r && r.msg) || '未知错误');
      return;
    }
    // 探测成功 → 回写到选择器, 后续操作直接用该口径
    var sel = document.getElementById('srvOsType');
    if (sel && r.detected) sel.value = r.os_family || 'auto';
    var icon = r.os_family==='windows' ? '🪟' : (r.os_family==='macos' ? '🍎' : '🐧');
    var engCls = r.engine_hint === 'rclone' ? 'var(--yellow,#e8b44a)' : 'var(--green)';
    var html = icon + ' <b>' + r.label + '</b>'
      + ' <span style="color:var(--text3)">(' + (r.source||'') + (r.detected?'':'') + ')</span><br/>'
      + '传输引擎建议: <b style="color:' + engCls + '">' + r.engine_hint + '</b>'
      + ' <span style="color:var(--text3)">— ' + (r.engine_reason||'') + '</span>';
    if (r.note) html += '<br/><span style="color:var(--text3)">ℹ ' + r.note + '</span>';
    if (r.disks && r.disks.length){
      html += '<br/><br/><b>磁盘 / 卷 (' + r.disks.length + ')</b><div style="margin-top:4px;max-height:150px;overflow:auto">';
      r.disks.forEach(function(d){
        var pct = d.size ? Math.round(d.used*100/d.size) : 0;
        html += '<div style="display:flex;gap:8px;font-family:monospace;font-size:11px;padding:1px 0">'
          + '<span style="min-width:150px;color:var(--cyan)">' + (d.mount||d.device||'') + '</span>'
          + '<span style="min-width:70px;color:var(--text3)">' + _osFmtSize(d.size||0) + '</span>'
          + '<span style="min-width:70px;color:' + (pct>90?'var(--red)':'var(--text2)') + '">用 ' + pct + '%</span>'
          + '<span style="color:var(--text3)">余 ' + _osFmtSize(d.avail||0) + '</span>'
          + '</div>';
      });
      html += '</div>';
    } else if (r.disks_error){
      html += '<br/><span style="color:var(--text3)">（列盘失败: ' + r.disks_error + '）</span>';
    }
    box.style.background = 'var(--bg3)';
    box.innerHTML = html;
  });
}
function updateVdAuthUI(){
  ConnPanel_renderAuth('vd', { valueId:'vdAuthValue', passphraseId:'vdAuthPassphrase', passPlaceholder:'请输入SSH登录密码' });
}
function updatePveAuthUI(){
  ConnPanel_renderAuth('pve', { valueId:'pveAuthValue', passphraseId:'pveAuthPassphrase', passPlaceholder:'请输入SSH登录密码' });
}

function getLvmAuth(){
  return ConnPanel_getAuth('lvm', { valueId:'lvmPass', passphraseId:'lvmPassphrase' });
}


function updateLvmAuthUI(){
  ConnPanel_renderAuth('lvm', { valueId:'lvmPass', passphraseId:'lvmPassphrase', passPlaceholder:'请输入SSH登录密码' });
}



function getPbsAuth(){
  return ConnPanel_getAuth('pbs', { valueId:'pbsPass', passphraseId:'pbsPassphrase' });
}


function updatePbsAuthUI(){
  ConnPanel_renderAuth('pbs', { valueId:'pbsPass', passphraseId:'pbsPassphrase', passPlaceholder:'请输入SSH登录密码' });
}



function getZfsAuth(){
  return ConnPanel_getAuth('zfs', { valueId:'zfsPass', passphraseId:'zfsPassphrase' });
}


function updateZfsAuthUI(){
  ConnPanel_renderAuth('zfs', { valueId:'zfsPass', passphraseId:'zfsPassphrase', passPlaceholder:'请输入SSH登录密码' });
}



function getRbdAuth(){
  return ConnPanel_getAuth('rbd', { valueId:'rbdPass', passphraseId:'rbdPassphrase' });
}


function updateRbdAuthUI(){
  ConnPanel_renderAuth('rbd', { valueId:'rbdPass', passphraseId:'rbdPassphrase', passPlaceholder:'请输入SSH登录密码' });
}





// ------------------------------------------
// 真实通信能力：测试服务器连接
// ------------------------------------------
async function testConnection(){
  var dot=document.getElementById('srvConnDot'), txt=document.getElementById('srvConnText'), res=document.getElementById('connResult');
  dot.className='conn-dot connecting'; txt.textContent='连接中...'; 
  if(res) res.textContent='';
  
  var auth = getTransferAuth(); // 获取安全加密的认证数据
  auth = await upgradeAuthToEC1(auth);  // v3.5.0: 升级到 EC1
  
  openWs(function(ws){
    _rpSendWhenReady(ws, {
      action: 'test_conn',
      host: gv('srvHost'), port: gv('srvPort'), user: gv('srvUser'),
      auth_type: auth.auth_type,
      password: auth.password, key: auth.key, passphrase: auth.passphrase
    }, undefined, function(){ try { console.warn('[ws] 发送失败'); } catch(_){} })
    
    var handler = function(e){
      var d = JSON.parse(e.data);
      if(d.type === 'result'){
        ws.removeEventListener('message', handler);
        clearTimeout(timer);
        if(d.status === 'ok'){
          dot.className='conn-dot connected'; txt.textContent='已连接';
          if(res){res.textContent='✓ '+d.msg; res.style.color='var(--green)';}
          document.getElementById('connDot').className='conn-dot connected';
          document.getElementById('connText').textContent='已连接';
          addLog(d.msg,'success');
          recordPanelConnStatus('srv', 'ok', gv('srvHost'), d.msg);
          if(typeof checkRsyncPlugins === 'function') setTimeout(checkRsyncPlugins, 300);
        } else {
          dot.className='conn-dot error'; txt.textContent='连接失败';
          if(res){res.textContent='✗ '+d.msg; res.style.color='var(--red)';}
          addLog(d.msg,'error');
          recordPanelConnStatus('srv', 'fail', gv('srvHost'), d.msg);
        }
      }
    };
    ws.addEventListener('message', handler);
    var timer=setTimeout(function(){
      ws.removeEventListener('message',handler);
      if(txt.textContent==='连接中...'){
        dot.className='conn-dot error'; txt.textContent='超时';
        if(res){res.textContent='✗ 连接超时 (15s)';res.style.color='var(--red)';}
      }
    },15000);
  }).catch(function(err){
    dot.className='conn-dot error'; txt.textContent='WebSocket 错误';
    if(res){res.textContent='✗ '+err.message;res.style.color='var(--red)';}
    addLog(err.message,'error');
  });
}

// v3.4.2: testPveConn 迁移到 panels/pve.js


// v3.4.3: testVdConn 迁移到 panels/vzdump.js



// ------------------------------------------
// 通用文件传输逻辑
// ------------------------------------------
function startTransfer(){
  if(transferRunning) return;
  // v5.10.0 · 授权闸门: 授权失效且宽限期已过 → 阻止新传输 (由服务端 license state 判定)
  if (window._licenseBlocked){
    if(typeof addLog === 'function') addLog('🚫 授权已失效: ' + (window._licenseBlockReason || '请重新激活'), 'error');
    if(typeof toastErr === 'function') toastErr('授权已失效, 无法开始传输');
    return;
  }
  // v4.38.21 · 优先使用三列组件的传输项列表
  var items = (window.TriPaneTransfer && typeof window.TriPaneTransfer.getItems === 'function')
    ? window.TriPaneTransfer.getItems() : null;
  if (items && items.length){
    // v1.0.0 · 启动前先解析凭据(异步): server_profiles 不下发密码, 档案条目的 srv.password 恒为空,
    //   老流程直接把它塞进 rsync 请求 → 空密码 SSH 必败("有时可以"=恰好表单里填过/连接中心有活跃会话)。
    return _resolveCredsForItems(items).then(function(){ _startTransferMulti(items); });
  }
  // 回退：使用 srcPath/dstPath（v4.38.20 兼容）
  var host=gv('srvHost').trim(), src=gv('srcPath').trim(), dst=gv('dstPath').trim();
  if(!host || !src || !dst){addLog('信息不完整：服务器地址、源路径和目标路径不能为空','error');return;}
  return _startTransferSingle(host, src, dst);
}

// v1.0.0 · 批量传输前的统一凭据解析 (修"要重输密码"与"误报远端缺 rsync"的根因)
//   server_profiles 出于安全不下发密码(serverRows: auth_value='') → 这里走 sp_resolve(密码仅在后端/缓存),
//   解析成功后写回 srv 条目并预热 SP 缓存, 后续 item→auth 组装即可拿到密码。
function _resolveCredsForItems(items){
  if (!window.SP || typeof window.SP.resolve !== 'function') return Promise.resolve();
  var jobs = {};
  function srvOf(id){
    var s = null;
    try { if (window.ServersAPI) s = window.ServersAPI.getById(id); } catch(e){}
    if (!s && window.ServersStore){ try { s = window.ServersStore.get(id); } catch(e){} }
    if (!s && window.__serversCache){
      for (var i=0;i<window.__serversCache.length;i++){
        var x = window.__serversCache[i];
        if (String(x.id || x.uuid) === String(id)) { s = x; break; }
      }
    }
    return s;
  }
  (items || []).forEach(function(it){
    var sid = it && it.server;
    if (!sid || sid === 'local' || sid === 'l' || (typeof sid === 'string' && (sid.indexOf('cld_') === 0 || sid.indexOf('shs_') === 0 || sid.indexOf('dfm_') === 0))) return;
    var srv = srvOf(sid);
    if (!srv || !srv.host) return;
    if (srv.password || srv.key) return;            // 已有凭据(表单/缓存) 不必解析
    var key = srv.host + ':' + (srv.port || 22);
    if (jobs[key]) return;
    jobs[key] = window.SP.resolve(srv.host, String(srv.port || 22), ['ssh']).then(function(rr){
      if (rr && rr.creds){
        srv.auth_type = rr.creds.auth_type || srv.auth_type || 'pass';
        srv.password = rr.creds.password || '';
        srv.key = rr.creds.key || '';
        srv.passphrase = rr.creds.passphrase || '';
        srv._credResolved = true;
      }
      return rr;
    }).catch(function(){});
  });
  var list = Object.keys(jobs).map(function(k){ return jobs[k]; });
  return list.length ? Promise.all(list) : Promise.resolve();
}

// v4.38.21 rev · 防御检查：dst 不能为空或根目录，否则要求用户先在远端栏点选目标
function _validateItems(items){
  var bad = [];
  for (var i=0;i<items.length;i++){
    var it = items[i];
    if (!it.dst || it.dst === '/' || it.dst === ''){
      bad.push({ idx: i+1, src: it.src || '(空)', dst: it.dst || '(空)' });
    }
  }
  return bad;
}

// v4.38.21 · 批量传输：每个 item 独立启动一次 rsync（v1，简单可靠；后续可改为单次多源）
function _startTransferMulti(items){
  transferRunning=true;
  document.getElementById('transferProgress').style.display='block';
  document.getElementById('transferProgress').scrollIntoView({behavior:'smooth'});
  var bar=document.getElementById('progressBar'), status=document.getElementById('progressStatus');
  var logEl=document.getElementById('transferLog');
  document.getElementById('transferChip').className='chip chip-blue';
  document.getElementById('transferChip').textContent='运行中 ' + items.length + ' 项';
  bar.className='progress-bar'; bar.style.width='0%'; logEl.innerHTML='';

  var done = 0, okCount = 0, errCount = 0;
  // v4.38.21 rev · 防御检查：dst 缺失的项直接列出
  var badItems = _validateItems(items);
  if (badItems.length){
    var msg = '⚠ 有 ' + badItems.length + ' 项缺目标目录（dst 为空或根目录），请在远端栏点选目标后再启动';
    addLogLine(logEl, msg, 'warn');
    if (typeof toastWarn === 'function') toastWarn(msg);
    badItems.forEach(function(b){
      addLogLine(logEl, '  · 项 ' + b.idx + ' [' + b.src + '] → dst=' + b.dst, 'warn');
    });
    return;
  }
  addLogLine(logEl, '⏵ 批量启动 ' + items.length + ' 项传输', 'info');

  items.forEach(function(item, idx){
    // v4.41.2 · ☁ 远端存储项 (server='cld_<rid>'): 走 remote_upload / remote_download, 不走 SSH rsync
    if (typeof item.server === 'string' && item.server.indexOf('cld_') === 0){
      _runCloudItem(item, idx, items.length, logEl, bar, status, function(okC){
        done++;
        if (okC) okCount++; else errCount++;
        if (done === items.length) _finishMulti(done, okCount, errCount);
      });
      return;
    }
    // 从 item 取 server -> 在 _servers 中找 auth
    var auth = getTransferAuth();
    var host = gv('srvHost'), port = gv('srvPort'), user = gv('srvUser');
    if (item.server && item.server !== 'local'){
      var srv = null;
      if (window.ServersAPI){
        try { srv = window.ServersAPI.getById(item.server); } catch(e){}
      }
      if (!srv && window.ServersStore){
        try { srv = window.ServersStore.get(item.server); } catch(e){}
      }
      if (!srv){
        // 兜底：从 TriPaneTransfer._items 邻域查找（私有）
        var all = (window.TriPaneTransfer && window.TriPaneTransfer._items) ? window.TriPaneTransfer._items() : [];
        for (var i=0;i<all.length;i++){
          if (all[i].server === item.server){ /* not enough info */ break; }
        }
        // 实际：再尝试 fetch 服务器列表缓存
        if (window.__serversCache){
          for (var j=0;j<window.__serversCache.length;j++){
            var s = window.__serversCache[j];
            // v4.41.1 · 宽松比较: item.server 可能是数字 id 或持久化后的字符串 id
            if (String(s.id||s.uuid) === String(item.server)){ srv = s; break; }
          }
        }
      }
      if (srv){
        host = srv.host || host;
        port = srv.port || port;
        user = srv.user || user;
        auth = {
          auth_type: srv.auth_type || 'pass',
          password: srv.password || '',
          key: srv.key || '',
          passphrase: srv.passphrase || '',
        };
      }
      // v1.0.0 · 兜底: 条目仍无凭据 → 直接读 SP 缓存(由 _resolveCredsForItems / 浏览栏预热)
      if (!auth.password && !auth.key && host && window.SP && typeof window.SP.cachedCreds === 'function'){
        try {
          var _cc = window.SP.cachedCreds(host, port || '22');
          if (_cc && (_cc.password || _cc.key)){
            auth = { auth_type: _cc.auth_type || auth.auth_type,
                     password: _cc.password || '', key: _cc.key || '', passphrase: _cc.passphrase || '' };
          }
        } catch(e){}
      }
    }
    if (!item.dst){
      addLogLine(logEl, '✗ 项 ' + (idx+1) + ' [' + item.src + '] 缺少 dst，跳过', 'error');
      errCount++; done++;
      if (done === items.length) _finishMulti(done, okCount, errCount);
      return;
    }
    if (item.src === '(待选)'){
      addLogLine(logEl, '⏭ 项 ' + (idx+1) + ' src 为「待选」，跳过', 'warn');
      done++;
      if (done === items.length) _finishMulti(done, okCount, errCount);
      return;
    }
    addLogLine(logEl, '▶ [' + (idx+1) + '/' + items.length + '] ' + item.src + ' -> ' + item.dst + ' (server=' + (item.server||'local') + ')', 'info');
    // v4.38.41 · 本地到本地 (server=local 且 host 空/127.0.0.1) -> direction='local', 不走 SSH
    //   避免 rsync src root@127.0.0.1:dst 触发 ssh_askpass (空密码交互式输入失败)
    // v4.40.0 · 共享挂载点 (server=shs_<uuid>) 在本机 -> 强制 direction='local' (src/dst 均为本机路径)
    //   df 挂载点 (dfm_) 借 DM 主机凭据 SSH 浏览 -> host 非本机时保持 push/pull
    var _srvIsShare = (typeof item.server === 'string' && item.server.indexOf('shs_') === 0);
    var _isLocalItem = (!item.server || item.server === 'local' || item.server === 'l'
                        || _srvIsShare
                        || (typeof item.server === 'string' && item.server.indexOf('dfm_') === 0));
    var _hostEmptyOrLocal = (!host || host === '127.0.0.1' || host === 'localhost');
    var _sendDirection = (_isLocalItem && (_hostEmptyOrLocal || _srvIsShare)) ? 'local' : (item.mode || 'push');
    openWs(function(ws){
      _rpSendWhenReady(ws, {
        action: 'rsync',
        direction: _sendDirection,
        host: host, port: port, user: user,
        src: item.src, dst: item.dst,
        flags: Array.from(activeFlags),
        bwlimit: gv('bwLimit')||'0',
        exclude: gv('excludePat')||'',
        auth_type: auth.auth_type, password: auth.password, key: auth.key, passphrase: auth.passphrase,
        auth_token: localStorage.getItem('auth_token') || ''
      }, undefined, function(){ try { console.warn('[ws] 发送失败'); } catch(_){} })
      var handler = function(e){
        var d;
        try { d = JSON.parse(e.data); } catch(_){ return; }
        if (d.type === 'log') addLogLine(logEl, d.msg, d.level||'dim');
        else if (d.type === 'progress'){
          // 整体进度：当前项进度 / 总数 + 前面完成的比例
          var per = Math.min(d.pct, 100);
          var totalPct = ((idx + per/100) / items.length * 100);
          bar.style.width = totalPct.toFixed(1) + '%';
          status.textContent = totalPct.toFixed(0) + '% · 第 ' + (idx+1) + '/' + items.length + ' 项';
          if (d.file) document.getElementById('progressTitle').textContent = d.file;
          if (d.speed){
            status.textContent += ' · ' + d.speed;
            document.getElementById('statSpeed').textContent = d.speed;
            document.getElementById('speedDisplay').textContent = d.speed;
            /* v5.37.0: recordSpeed 由总线统一喂 */
          }
        } else if (d.type === 'finish'){
          ws.removeEventListener('message', handler);
          done++;
          if (d.status === 'success') okCount++; else errCount++;
          // v4.38.21 rev · 失败时若提示 sshpass/rsync 缺失，弹出引导
          if (d.status === 'error' && d.msg){
            // v1.0.0 · FIX(用户实测误报"远端服务器缺少 rsync"): 此前只要错误文本里出现 rsync/sshpass
            //   就当成"远端缺工具"(认证失败等信息里也含 rsync) → 现在必须真的是"命令找不到"才提示;
            //   其它失败一律把原始错误打出来, 用户可据此判断(认证/路径/权限)。
            var _msg = '' + d.msg;
            var _miss = /(rsync|sshpass)[^\n]{0,40}(command not found|not found|No such file|未找到|未安装|不存在)/i.test(_msg)
                     || /(command not found|not found|未找到|未安装)[^\n]{0,20}(rsync|sshpass)/i.test(_msg)
                     || /远端(未安装|缺少)\s*(rsync|sshpass)/i.test(_msg);
            if (_miss){
              var _tool = (_msg.toLowerCase().indexOf('sshpass') >= 0) ? 'sshpass' : 'rsync';
              addLogLine(logEl, '⚠ 远端服务器缺少 ' + _tool + '，请使用下方"一键安装"', 'warn');
              try {
                if (typeof toastWarn === 'function') toastWarn('远端缺 ' + _tool + '，请到文件传输页底部一键安装');
                if (typeof checkRsyncPlugins === 'function') setTimeout(checkRsyncPlugins, 300);
              } catch(e){}
            } else {
              addLogLine(logEl, '✗ 第 ' + (idx+1) + ' 项失败: ' + _msg, 'err');
            }
          }
          if (done === items.length){
            transferRunning=false;
            // v4.97.0 · 传输完成后自动刷新浏览栏 (用户无需手动点刷新)
            //   覆盖: 本机/单远端/双远端(cross)/双向同步/df 挂载点/网络共享/云端存储
            try {
              if (typeof window.refreshAllPanes === 'function'){
                window.refreshAllPanes(items.map(function(x){ return x.src; }));
              }
            } catch(_e){}
            if (errCount === 0){
              bar.className='progress-bar success'; bar.style.width='100%';
              status.textContent='全部 ' + items.length + ' 项完成 ✓';
              document.getElementById('transferChip').className='chip chip-green';
              document.getElementById('transferChip').textContent='完成 ' + okCount + '/' + items.length;
              addLogLine(logEl, '✓ 批量完成：' + okCount + ' 成功 / ' + errCount + ' 失败', 'success');
              addJob('批量传输 (' + items.length + ' 项)', items.map(function(x){return x.src;}).join(', '), '完成');
            } else {
              bar.className='progress-bar error';
              status.textContent = items.length + ' 项中 ' + errCount + ' 失败';
              document.getElementById('transferChip').className='chip chip-red';
              document.getElementById('transferChip').textContent='失败 ' + errCount + '/' + items.length;
              addLogLine(logEl, '✗ 批量结束：' + okCount + ' 成功 / ' + errCount + ' 失败', 'error');
            }
          }
        }
      };
      ws.addEventListener('message', handler);
    }).catch(function(err){
      addLogLine(logEl, '✗ 项 ' + (idx+1) + ' WS 连接失败: ' + err.message, 'error');
      done++; errCount++;
      if (done === items.length) _finishMulti(done, okCount, errCount);
    });
  });
}

// v4.41.2 · ☁ 远端存储单条传输 (server='cld_<rid>'):
//   本机->云: remote_upload (目录 remote_upload_dir); 云->本机: remote_download (目录 remote_download_dir)
//   云->云: 下载 /tmp 再上传
function _runCloudItem(item, idx, total, logEl, bar, status, cb){
  var rid = parseInt(String(item.server || '').slice(4), 10) || 0;
  if (!rid){ addLogLine(logEl, '✗ [' + (idx+1) + '] 无效远端存储 id', 'error'); cb(false); return; }
  var isDir = (item.type === 'dir' || /\/\s*$/.test(item.src || ''));
  var mode = item.mode || 'push';
  // 云在 pull 端 = 下载; 在 push 端 = 上传
  var download = (mode === 'pull');
  var _rkey = function(p){ return String(p || '').replace(/^\/+/, ''); };
  // v4.41.2 · dst 是目录 (尾斜杠) 时拼 basename, 与 rsync 语义对齐
  function _dstFull(){
    var d = String(item.dst || '');
    var base = String(item.src || '').replace(/\/+$/,'').split('/').pop() || 'file';
    return /\/\s*$/.test(d) ? (d + base) : d;
  }
  function _pct(n){  // 整体进度近似: (idx + n) / total
    var t = ((idx + n) / total * 100);
    if (bar) bar.style.width = t.toFixed(1) + '%';
    if (status) status.textContent = t.toFixed(0) + '% · 第 ' + (idx+1) + '/' + total + ' 项';
  }
  function _dl(tmpOnly, next){
    var reqId = 'cldi_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    var localP = tmpOnly
      ? ('/tmp/fonriv_cloud_dl/item_' + Date.now() + '_' + (item.src || '').split('/').pop())
      : (/\/\s*$/.test(String(item.dst||'')) ? _dstFull() : item.dst);
    var action = isDir ? 'remote_download_dir' : 'remote_download';
    addLogLine(logEl, '  ↳ ☁ 下载 ' + (isDir ? '目录 ' : '') + _rkey(item.src) + ' -> ' + localP, 'dim');
    openWs(function(ws){
      var h = function(e){
        var d; try { d = JSON.parse(e.data); } catch(_){ return; }
        var mt = isDir ? 'remote_dir_result' : 'remote_download_result';
        if (!d || d.type !== mt || d.req_id !== reqId) return;
        try { ws.removeEventListener('message', h); } catch(_){}
        if (d.status === 'ok'){ _pct(1); next(localP); }
        else { addLogLine(logEl, '✗ ☁ 下载失败: ' + (d.msg || ''), 'error'); cb(false); }
      };
      ws.addEventListener('message', h);
      var payload = { action: action, remote_id: rid, req_id: reqId };
      if (isDir){ payload.remote_dir = _rkey(item.src).replace(/\/+$/,''); payload.local_dir = localP.replace(/\/+$/,''); }
      else { payload.remote_key = _rkey(item.src); payload.local_path = localP; }
      _rpSendWhenReady(ws, payload, undefined, function(){ try { console.warn('[ws] 发送失败'); } catch(_){} })
    });
  }
  function _up(localSrc, next){
    var reqId = 'clui_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    var action = isDir ? 'remote_upload_dir' : 'remote_upload';
    addLogLine(logEl, '  ↳ ☁ 上传 ' + localSrc + ' -> ' + _rkey(isDir ? item.dst : _dstFull()), 'dim');
    openWs(function(ws){
      var h = function(e){
        var d; try { d = JSON.parse(e.data); } catch(_){ return; }
        var mt = isDir ? 'remote_dir_result' : 'result';
        if (!d || d.type !== mt || d.req_id !== reqId) return;
        try { ws.removeEventListener('message', h); } catch(_){}
        if (d.status === 'ok'){ _pct(1); next(null); }
        else { addLogLine(logEl, '✗ ☁ 上传失败: ' + (d.msg || ''), 'error'); cb(false); }
      };
      ws.addEventListener('message', h);
      var payload = { action: action, remote_id: rid, req_id: reqId };
      if (isDir){ payload.local_dir = localSrc.replace(/\/+$/,''); payload.remote_dir = _rkey(item.dst).replace(/\/+$/,''); }
      else { payload.local_path = localSrc; payload.remote_key = _rkey(_dstFull()); }
      _rpSendWhenReady(ws, payload, undefined, function(){ try { console.warn('[ws] 发送失败'); } catch(_){} })
    });
  }
  if (isDir && download){
    _dl(false, function(){ addLogLine(logEl, '✓ ☁ 目录下载完成: ' + item.dst, 'success'); cb(true); });
    return;
  }
  if (isDir){
    _up(item.src, function(){ addLogLine(logEl, '✓ ☁ 目录上传完成: ' + _rkey(item.dst), 'success'); cb(true); });
    return;
  }
  if (download){
    _dl(false, function(p){ addLogLine(logEl, '✓ ☁ 下载完成: ' + p, 'success'); cb(true); });
    return;
  }
  _up(item.src, function(){ addLogLine(logEl, '✓ ☁ 上传完成: ' + _rkey(_dstFull()), 'success'); cb(true); });
}

function _finishMulti(done, okCount, errCount){
  transferRunning=false;
  if (errCount === 0){
    document.getElementById('progressBar').className='progress-bar success';
    document.getElementById('progressBar').style.width='100%';
  } else {
    document.getElementById('progressBar').className='progress-bar error';
  }
}

// v4.38.21 · 单项传输（原 startTransfer 主体提取）
function _startTransferSingle(host, src, dst){
  var cmdStr=document.getElementById('cmdPreview').textContent;

  transferRunning=true;
  document.getElementById('transferProgress').style.display='block';
  document.getElementById('transferProgress').scrollIntoView({behavior:'smooth'});

  var bar=document.getElementById('progressBar'), status=document.getElementById('progressStatus');
  var logEl=document.getElementById('transferLog');
  document.getElementById('transferChip').className='chip chip-blue'; document.getElementById('transferChip').textContent='运行中';
  bar.className='progress-bar'; bar.style.width='0%'; logEl.innerHTML='';

  var auth = getTransferAuth();
  // v4.38.41 · 本地到本地 (host 空/127.0.0.1) -> direction='local', 不走 SSH
  var _hostEmptyOrLocal = (!host || host === '127.0.0.1' || host === 'localhost');
  var _sendDirection = _hostEmptyOrLocal ? 'local' : 'up';
  openWs(function(ws){
    _rpSendWhenReady(ws, {
      action: 'rsync',
      direction: _sendDirection,
      host: host, port: gv('srvPort'), user: gv('srvUser'),
      src: src, dst: dst,
      flags: Array.from(activeFlags),
      bwlimit: gv('bwLimit')||'0',
      exclude: gv('excludePat')||'',
      auth_type: auth.auth_type, password: auth.password, key: auth.key, passphrase: auth.passphrase,
      auth_token: localStorage.getItem('auth_token') || ''
    }, undefined, function(){ try { console.warn('[ws] 发送失败'); } catch(_){} })

    var handler=function(e){
      var d=JSON.parse(e.data);
      if(d.type==='log') addLogLine(logEl, d.msg, d.level||'dim');
      else if(d.type==='progress'){
        var pct=Math.min(d.pct, 100);
        bar.style.width=pct.toFixed(1)+'%';
        status.textContent=pct.toFixed(0)+'% 完成';
        if(d.file) document.getElementById('progressTitle').textContent=d.file;
        if(d.speed){
          status.textContent+=' · '+d.speed;
          document.getElementById('statSpeed').textContent=d.speed;
          document.getElementById('speedDisplay').textContent=d.speed;
          /* v5.37.0: recordSpeed 由总线统一喂 */
        }
      } else if(d.type==='finish'){
        ws.removeEventListener('message',handler);
        transferRunning=false;
        if(d.status==='success'){
          bar.className='progress-bar success'; bar.style.width='100%';
          status.textContent='传输完成 ✓';
          document.getElementById('transferChip').className='chip chip-green'; document.getElementById('transferChip').textContent='完成';
          addLogLine(logEl, d.msg, 'success');
          addJob('rsync ' + (direction==='up'?'上传':'下载'), gv('srcPath'), '完成');
          document.getElementById('speedDisplay').textContent='0 MB/s';
        } else {
          bar.className='progress-bar error'; status.textContent='传输异常';
          document.getElementById('transferChip').className='chip chip-red'; document.getElementById('transferChip').textContent='失败';
          addLogLine(logEl, d.msg, 'error');
        }
      }
    };
    ws.addEventListener('message',handler);
  }).catch(function(err){
    addLog('WebSocket 连接失败: '+err.message,'error');
  });
}

function stopTransfer(){
  transferRunning=false;
  openWs(function(ws){ ws.send(JSON.stringify({action:'kill', auth_token: localStorage.getItem('auth_token') || ''})); }).catch(function(){});
  var status=document.getElementById('progressStatus');
  if(status) status.textContent='已中止';
  document.getElementById('transferChip').className='chip chip-orange'; document.getElementById('transferChip').textContent='已中止';
  document.getElementById('speedDisplay').textContent='0 MB/s';
  addLogLine(document.getElementById('transferLog'),'传输已由用户中止','warn');
}
function pauseTransfer(){ stopTransfer(); } // 等同于中止，重新点击开始即可断点续传

function checkAllDisks(cb){
  document.querySelectorAll('#diskList .disk-check').forEach(function(c){c.checked=cb.checked});
  updateDiskCount();
}

function quickSync(){
  switchTab('transfer');
  addLog('快速同步：使用当前配置执行传输','info');
  startTransfer();
}


// ------------------------------------------
// PVE 扫描与备份逻辑
// ------------------------------------------
// v3.4.2: scanPVEStorage / renderPVEStorageInfo / scanPVE / scanPVEvmsOnly
//         迁移到 panels/pve.js


// v3.4.3: selectVM / scanDisks / updateDiskCount / startBackup 迁移到 panels/vzdump.js


// ------------------------------------------
// PVE 恢复 — 扫描本地备份文件
// ------------------------------------------
// v3.4.3: scanLocalBackups / startPveRestore / startVzdumpRestore 迁移到 panels/vzdump.js


// ------------------------------------------
// Vzdump 远程打包与流水线机制
// ------------------------------------------

// 全局存储信息缓存
var gPVEStorageInfo = null;
var gStorageInfo = null;

// v3.4.3: scanStorage / renderStorageInfo / scanVdVMs / scanVdVMsOnly / selectVdVM
//         迁移到 panels/vzdump.js


function buildVzdumpCmd(){
  var host=gv('vdHost'), port=gv('vdPort'), user=gv('vdUser');
  var mode=gv('vdMode')||'snapshot';
  var compress=gv('vdCompress')||'zstd';
  var tmpDir=gv('vdTmpDir')||'/var/lib/vz/dump/';
  var localDir=gv('vdLocalDir')||'/mnt/backup/vzdump/';
  var vmid=selectedVdVmId;
  
  var storage='local';  // PVE storage name, defaults to "local"
  var compFlag=compress==='0'?'': '--compress '+compress;
  
  var archiveFile='vzdump-'+vmid;
  var c1='ssh -p '+port+' '+user+'@'+host+' "vzdump '+vmid+' --storage '+storage+' '+compFlag+' --mode '+mode+'"';
  var c2='rsync -avPh -e "ssh -p '+port+'" '+user+'@'+host+':'+tmpDir+'*vzdump*'+vmid+'* '+localDir;
  var c3='ssh -p '+port+' '+user+'@'+host+' "rm -f '+tmpDir+'*vzdump*'+vmid+'*"';
  
  if(document.getElementById('vdCmd1')) document.getElementById('vdCmd1').textContent=c1;
  if(document.getElementById('vdCmd2')) document.getElementById('vdCmd2').textContent=c2;
  if(document.getElementById('vdCmd3')) document.getElementById('vdCmd3').textContent=c3;
}

function saveVdParams(){
  var params = {
    vdHost: gv('vdHost'), vdPort: gv('vdPort'), vdUser: gv('vdUser'),
    vdAuthType: gv('vdAuthType') || 'pass',
    vdVmId: gv('vdVmId'), vdMode: gv('vdMode'), vdCompress: gv('vdCompress'),
    vdStorage: gv('vdStorage') || 'local',
    vdTmpDir: gv('vdTmpDir'), vdLocalDir: gv('vdLocalDir'),
    vdBw: gv('vdBw'), vdDlBw: gv('vdDlBw'),
    vdMaxFiles: gv('vdMaxFiles'),
    vdMailOn: document.getElementById('vdMailOn').checked,
    vdAutoClean: document.getElementById('vdAutoClean').checked,
    vdVerify: document.getElementById('vdVerify').checked
  };
  try{ localStorage.setItem('vdParams', JSON.stringify(params)); addLog('vzdump参数已保存','success'); }
  catch(e){ addLog('保存失败: '+e.message,'error'); }
}

function loadVdParams(){
  try{
    var raw = localStorage.getItem('vdParams');
    if(!raw) return;
    var p = JSON.parse(raw);
    if(p.vdHost) document.getElementById('vdHost').value = p.vdHost;
    if(p.vdPort) document.getElementById('vdPort').value = p.vdPort;
    if(p.vdUser) document.getElementById('vdUser').value = p.vdUser;
    if(p.vdVmId) document.getElementById('vdVmId').value = p.vdVmId;
    if(p.vdMode) document.getElementById('vdMode').value = p.vdMode;
    if(p.vdCompress) document.getElementById('vdCompress').value = p.vdCompress;
    if(p.vdTmpDir) document.getElementById('vdTmpDir').value = p.vdTmpDir;
    if(p.vdLocalDir) document.getElementById('vdLocalDir').value = p.vdLocalDir;
    if(p.vdBw !== undefined) document.getElementById('vdBw').value = p.vdBw;
    if(p.vdDlBw !== undefined) document.getElementById('vdDlBw').value = p.vdDlBw;
    if(p.vdMaxFiles) document.getElementById('vdMaxFiles').value = p.vdMaxFiles;
    if(p.vdMailOn !== undefined) document.getElementById('vdMailOn').checked = p.vdMailOn;
    if(p.vdAutoClean !== undefined) document.getElementById('vdAutoClean').checked = p.vdAutoClean;
    if(p.vdVerify !== undefined) document.getElementById('vdVerify').checked = p.vdVerify;
  } catch(e){}
}

function startVzdump(){
  if(transferRunning) return;
  var host=gv('vdHost').trim(), localDir=gv('vdLocalDir').trim();
  if(!host || !localDir){addLog('请确保PVE地址和本地保存路径已填写','error');return;}

  transferRunning=true;
  document.getElementById('vdProgress').style.display='block';
  document.getElementById('vdProgress').scrollIntoView({behavior:'smooth'});

  var logEl=document.getElementById('vdLog'); logEl.innerHTML='';
  document.getElementById('vdBar1').style.width='0%'; document.getElementById('vdBar2').style.width='0%';
  document.getElementById('vdBar1Label').textContent='打包中 (通过SSH)...'; document.getElementById('vdBar2Label').textContent='等待打包完成';
  document.getElementById('vdStatPhase').textContent='1 - 远程打包'; document.getElementById('vdProgressStatus').textContent='初始化...';
  
  var chip=document.getElementById('vdChip'); chip.className='chip chip-blue'; chip.textContent='打包中';
  var autoClean=document.getElementById('vdAutoClean');
  
  var auth = getVdAuth();

  openWs(function(ws){
    _rpSendWhenReady(ws, {
      action: 'vzdump', host: host, port: gv('vdPort'), user: gv('vdUser'),
      auth_type: auth.auth_type, password: auth.password, key: auth.key, passphrase: auth.passphrase,
      vmid: selectedVdVmId, mode: gv('vdMode')||'snapshot', compress: gv('vdCompress')||'zstd',
      storage: 'local', local_dir: localDir, auto_clean: autoClean?autoClean.checked:true,
      pre_hook: gv('vdPreHook')||'', post_hook: gv('vdPostHook')||''
    }, undefined, function(){ try { console.warn('[ws] 发送失败'); } catch(_){} })

    var handler=function(e){
      var d=JSON.parse(e.data);
      if(d.type==='log') addLogLine(logEl, d.msg, d.level||'dim');
      else if(d.type==='phase'){
        if(d.phase===1){
          document.getElementById('vdBar1').style.width='100%'; document.getElementById('vdBar1Label').textContent='打包完成 ✓';
        } else if(d.phase===2){
          document.getElementById('vdStatPhase').textContent='2 - Rsync 拉取';
          document.getElementById('vdBar2Label').textContent='下载中...';
          chip.textContent='拉取中'; chip.className='chip chip-purple';
        }
      } else if(d.type==='progress'){
        if(d.phase===2){
          document.getElementById('vdBar2').style.width=Math.min(d.pct,100)+'%';
          document.getElementById('vdProgressStatus').textContent=d.pct.toFixed(0)+'% 完成';
          if(d.speed){ document.getElementById('vdStatSpd').textContent=d.speed; /* v5.37.0: 总线统一喂 */ }
        } else {
          document.getElementById('vdBar1').style.width=Math.min(d.pct,100)+'%';
          document.getElementById('vdProgressStatus').textContent=d.pct.toFixed(0)+'%';
        }
      } else if(d.type==='finish'){
        ws.removeEventListener('message',handler);
        transferRunning=false;
        if(d.status==='success'){
          document.getElementById('vdBar2').style.width='100%'; document.getElementById('vdBar2').className='progress-bar success';
          document.getElementById('vdBar2Label').textContent='下载完成 ✓'; document.getElementById('vdProgressStatus').textContent='完成 ✓';
          chip.className='chip chip-green'; chip.textContent='完成';
          addLogLine(logEl, d.msg, 'success');
          addJob('vzdump 打包 VM '+selectedVdVmId, vdDlDir, '完成');
        } else {
          chip.className='chip chip-red'; chip.textContent='失败';
          addLogLine(logEl, d.msg, 'error');
          addJob('vzdump 打包 VM '+selectedVdVmId, vdDlDir, '失败');
        }
      }
    };
    ws.addEventListener('message',handler);
  }).catch(function(err){
    addLog('vzdump 连接失败: '+err.message,'error');
  });
}

function stopVzdump(){
  transferRunning=false;
  openWs(function(ws){ ws.send(JSON.stringify({action:'kill'})); }).catch(function(){});
  var chip=document.getElementById('vdChip');
  if(chip) { chip.className='chip chip-orange'; chip.textContent='已中止'; }
  addLogLine(document.getElementById('vdLog'),'流水线任务已被中止','warn');
}

// ------------------------------------------
// 独立归档下载逻辑
// ------------------------------------------
function scanRemoteArchives(){
  var host=gv('vdHost').trim(), auth=getVdAuth();
  if(!host) return;

  var listEl=document.getElementById('vdArchiveList');
  if(listEl) listEl.innerHTML='<div style="padding:10px;color:var(--text3)">正在扫描归档文件...</div>';

  // If we don't have storage info yet, auto-scan first
  if(!gStorageInfo || !gStorageInfo.dump_dirs || gStorageInfo.dump_dirs.length === 0){
    addLog('未检测到存储信息，先自动扫描存储...','info');
    openWs(function(ws){
      _rpSendWhenReady(ws, {
        action:'scan_storage', host:host, port:gv('vdPort')||'22', user:gv('vdUser')||'root',
        auth_type:auth.auth_type, password:auth.password, key: auth.key, passphrase: auth.passphrase
      }, undefined, function(){ try { console.warn('[ws] 发送失败'); } catch(_){} })
      var sHandler=function(e){
        var sd=JSON.parse(e.data);
        if(sd.type==='storage_result'){
          ws.removeEventListener('message',sHandler);
          if(sd.status==='ok'){
            gStorageInfo = sd;
            renderStorageInfo(sd);
            addLog('存储扫描完成，共发现 '+sd.dump_dirs.length+' 个备份目录','success');
          } else {
            addLog('存储扫描失败，使用默认目录','info');
          }
          // Now proceed to scan archives
          doScanArchives(auth, listEl);
        }
      };
      ws.addEventListener('message',sHandler);
    }).catch(function(err){
      addLog('存储扫描失败: '+err.message+'，使用默认目录','info');
      doScanArchives(auth, listEl);
    });
  } else {
    // Storage info already cached, scan directly
    addLog('使用已缓存的存储信息扫描归档（'+gStorageInfo.dump_dirs.length+' 个备份目录）','info');
    doScanArchives(auth, listEl);
  }
}

function doScanArchives(auth, listEl){
  // Build dir_hints from cached storage info
  var dir_hints = [];
  if(gStorageInfo && gStorageInfo.dump_dirs){
    dir_hints = gStorageInfo.dump_dirs;
  }
  if(gStorageInfo && gStorageInfo.backup_dirs){
    gStorageInfo.backup_dirs.forEach(function(d){
      if(dir_hints.indexOf(d) === -1) dir_hints.push(d);
    });
  }

  openWs(function(ws){
    _rpSendWhenReady(ws, {
      action: 'scan_archives', host: gv('vdHost').trim(), port: gv('vdPort')||'22', user: gv('vdUser')||'root',
      auth_type: auth.auth_type, password: auth.password, key: auth.key, passphrase: auth.passphrase,
      remote_dir: '',
      dir_hints: dir_hints
    }, undefined, function(){ try { console.warn('[ws] 发送失败'); } catch(_){} })
    var handler=function(e){
      var d=JSON.parse(e.data);
      ws.removeEventListener('message',handler);
      if(d.type==='archive_result' && d.status==='ok' && listEl){
        var header=listEl.querySelector('.file-list-header');
        listEl.innerHTML=''; if(header) listEl.appendChild(header);

        if(d.archives.length===0){
          var empty=document.createElement('div'); empty.style.cssText='padding:10px;color:var(--text3)'; empty.textContent='未找到远端归档文件'; listEl.appendChild(empty);
        } else {
          d.archives.forEach(function(a){
            var row=document.createElement('div'); row.className='file-item'; row.style.gridTemplateColumns='24px 1fr 100px 90px 80px';
            row.onclick=function(ev){ if(ev.target.tagName!=='INPUT') this.querySelector('input').click(); };
            var rawName = a.raw_name || a.name;
            var filePath = a.path || ('/var/lib/vz/dump/'+rawName);
            row.setAttribute('data-raw-name', rawName);
            row.setAttribute('data-path', filePath);
            var displayName = a.name || rawName;
            row.innerHTML='<input type="checkbox" class="file-checkbox vd-dl-check" onchange="updateVdDlCount()">'+
              '<div class="file-name">'+displayName+'</div>'+
              '<div class="file-size">'+(a.size||'?')+'</div>'+
              '<div class="file-date">'+(a.date||'?')+'</div>'+
              '<div class="file-status"><span class="status-dot st-ok">可下载</span></div>';
            listEl.appendChild(row);
          });
          addLog('扫描到 '+d.archives.length+' 个远端归档（扫描了 '+d.total_dirs_checked+' 个目录）','success');
        }
      }
    };
    ws.addEventListener('message',handler);
  }).catch(function(err){
    addLog('扫描归档失败: '+err.message,'error');
  });
}

function vdDlCheckAllFn(cb){
  document.querySelectorAll('.vd-dl-check').forEach(function(c){c.checked=cb.checked});
  updateVdDlCount();
}
function updateVdDlCount(){
  var n=document.querySelectorAll('.vd-dl-check:checked').length;
  var chip=document.getElementById('vdDlCountChip'); if(chip) chip.textContent='已选 '+n+' 个';
}

// ------------------------------------------
// 下载页面 VM 筛选功能
// ------------------------------------------
var vdDlVmFilter = [];  // 选中的 VM ID 列表

function scanVdVMsForDl(){
  var host=gv('vdHost').trim();
  if(!host){alert('请先输入 PVE 主机地址');return;}
  var listArea=document.getElementById('vdDlVmList');
  listArea.innerHTML='<span style="font-size:11px;color:var(--text3)">正在扫描...</span>';

  var auth = getVdAuth();
  openWs(function(ws){
    _rpSendWhenReady(ws, {
      action: 'scan_pve', host: host, port: gv('vdPort')||'22', user: gv('vdUser')||'root',
      auth_type: auth.auth_type, password: auth.password, key: auth.key, passphrase: auth.passphrase
    }, undefined, function(){ try { console.warn('[ws] 发送失败'); } catch(_){} })
    var handler=function(e){
      var d=JSON.parse(e.data);
      if(d.type==='scan_result'){
        ws.removeEventListener('message',handler);
        if(d.status==='ok' && d.vms.length>0){
          renderVdDlVmChips(d.vms);
          addLog('扫描到 '+d.vms.length+' 台虚拟机','success');
        } else {
          listArea.innerHTML='<span style="font-size:11px;color:var(--red)">未找到虚拟机</span>';
        }
      }
    };
    ws.addEventListener('message',handler);
  }).catch(function(err){
    document.getElementById('vdDlVmList').innerHTML='<span style="font-size:11px;color:var(--red)">扫描失败</span>';
  });
}

function renderVdDlVmChips(vms){
  var listArea=document.getElementById('vdDlVmList');
  listArea.innerHTML='';
  // "全部" 芯片
  var allChip=document.createElement('button');
  allChip.className='chip chip-blue';
  allChip.textContent='全部';
  allChip.style.cssText='cursor:pointer;font-size:11px;padding:2px 8px;border-radius:10px;border:1px solid var(--cyan);background:transparent;color:var(--cyan)';
  allChip.onclick=function(){
    vdDlVmFilter=[];
    listArea.querySelectorAll('.chip').forEach(function(c){c.classList.remove('chip-blue');c.style.borderColor='var(--border)';c.style.color='var(--text2)';c.style.background='transparent';});
    allChip.classList.add('chip-blue');
    allChip.style.borderColor='var(--cyan)';allChip.style.color='var(--cyan)';allChip.style.background='transparent';
    filterArchivesByVm();
  };
  allChip.classList.add('chip-blue');
  listArea.appendChild(allChip);

  vms.forEach(function(vm){
    var chip=document.createElement('button');
    chip.className='chip';
    chip.textContent=(vm.type==='CT'?'CT':'VM')+' '+vm.vmid;
    chip.style.cssText='cursor:pointer;font-size:11px;padding:2px 8px;border-radius:10px;border:1px solid var(--border);background:transparent;color:var(--text2)';
    chip.setAttribute('data-vmid', vm.vmid);
    chip.onclick=function(){
      var vmid=this.getAttribute('data-vmid');
      var idx=vdDlVmFilter.indexOf(vmid);
      if(idx>=0){
        vdDlVmFilter.splice(idx,1);
        this.classList.remove('chip-blue');
        this.style.borderColor='var(--border)';this.style.color='var(--text2)';this.style.background='transparent';
      } else {
        vdDlVmFilter.push(vmid);
        this.classList.add('chip-blue');
        this.style.borderColor='var(--cyan)';this.style.color='var(--cyan)';this.style.background='rgba(0,180,216,0.1)';
      }
      filterArchivesByVm();
      updateVdDlCount();
    };
    listArea.appendChild(chip);
  });
}

// 存储扫描到的原始归档数据
var vdDlAllArchives = [];

function filterArchivesByVm(){
  if(vdDlVmFilter.length === 0){
    renderArchiveList(vdDlAllArchives);
  } else {
    var filtered = vdDlAllArchives.filter(function(a){
      return vdDlVmFilter.some(function(vmid){
        var name = a.name || a.raw_name || '';
        return name.indexOf('qemu-'+vmid+'-') >= 0 || name.indexOf('lxc-'+vmid+'-') >= 0;
      });
    });
    renderArchiveList(filtered);
  }
}

// 重写 scanRemoteArchives 保存全量数据（使用存储扫描发现的目录，无缓存时自动扫描）
var _origScanRemoteArchives = scanRemoteArchives;
scanRemoteArchives = function(){
  var host=gv('vdHost').trim(), auth=getVdAuth();
  if(!host) return;

  var listEl=document.getElementById('vdArchiveList');
  if(listEl) listEl.innerHTML='<div style="padding:10px;color:var(--text3)">扫描归档文件中...</div>';

  // Auto-scan storage if no cache available
  if(!gStorageInfo || !gStorageInfo.dump_dirs || gStorageInfo.dump_dirs.length === 0){
    addLog('存储信息未缓存，正在自动扫描存储...', 'info');
    openWs(function(ws){
      _rpSendWhenReady(ws, {
        action: 'scan_storage', host: host, port: gv('vdPort')||'22', user: gv('vdUser')||'root',
        auth_type: auth.auth_type, password: auth.password, key: auth.key, passphrase: auth.passphrase
      }, undefined, function(){ try { console.warn('[ws] 发送失败'); } catch(_){} })
      var sHandler=function(e){
        var sd=JSON.parse(e.data);
        ws.removeEventListener('message',sHandler);
        if(sd.type==='storage_result' && sd.status==='ok'){
          gStorageInfo = sd;
          addLog('存储扫描完成：'+sd.storages.length+' 个存储，'+(sd.dump_dirs||[]).length+' 个备份目录', 'success');
          // Now proceed with archive scan
          _doScanArchivesWithHints(auth, listEl, gStorageInfo);
        } else {
          addLog('存储扫描失败: '+(sd.msg||'未知错误'), 'error');
          _doScanArchivesWithHints(auth, listEl, null);
        }
      };
      ws.addEventListener('message',sHandler);
    }).catch(function(err){
      addLog('存储扫描失败: '+err.message+'，使用默认目录', 'info');
      _doScanArchivesWithHints(auth, listEl, null);
    });
  } else {
    addLog('使用已缓存的存储信息扫描归档（'+gStorageInfo.dump_dirs.length+' 个备份目录）', 'info');
    _doScanArchivesWithHints(auth, listEl, gStorageInfo);
  }
};

function _doScanArchivesWithHints(auth, listEl, storageInfo){
  // Build dir_hints from cached storage info
  var dir_hints = [];
  if(storageInfo && storageInfo.dump_dirs){
    dir_hints = dir_hints.concat(storageInfo.dump_dirs);
  }
  if(storageInfo && storageInfo.backup_dirs){
    storageInfo.backup_dirs.forEach(function(d){
      if(dir_hints.indexOf(d) === -1) dir_hints.push(d);
    });
  }
  // Always include defaults
  if(dir_hints.indexOf('/var/lib/vz/dump/') === -1) dir_hints.push('/var/lib/vz/dump/');
  if(dir_hints.indexOf('/var/lib/vz/backup/') === -1) dir_hints.push('/var/lib/vz/backup/');

  addLog('扫描归档: 使用 '+dir_hints.length+' 个目录 ('+dir_hints.join(', ')+')', 'info');

  openWs(function(ws){
    _rpSendWhenReady(ws, {
      action: 'scan_archives', host: gv('vdHost').trim(), port: gv('vdPort')||'22', user: gv('vdUser')||'root',
      auth_type: auth.auth_type, password: auth.password, key: auth.key, passphrase: auth.passphrase,
      remote_dir: '',
      dir_hints: dir_hints
    }, undefined, function(){ try { console.warn('[ws] 发送失败'); } catch(_){} })
    var handler=function(e){
      var d=JSON.parse(e.data);
      ws.removeEventListener('message',handler);
      if(d.type==='archive_result' && d.status==='ok' && listEl){
        vdDlAllArchives = d.archives || [];
        filterArchivesByVm();
        addLog('扫描到 '+d.archives.length+' 个远端归档','success');
      }
    };
    ws.addEventListener('message',handler);
  }).catch(function(err){
    addLog('扫描归档失败: '+err.message,'error');
  });
};

function renderArchiveList(archives){
  var listEl=document.getElementById('vdArchiveList');
  var header=listEl.querySelector('.file-list-header');
  listEl.innerHTML=''; if(header) listEl.appendChild(header);

  if(archives.length===0){
    var empty=document.createElement('div');
    empty.style.cssText='padding:10px;color:var(--text3)';
    empty.textContent = vdDlVmFilter.length > 0 ? '未找到选中 VM 的归档文件' : '未找到远端归档文件';
    listEl.appendChild(empty);
    return;
  }

  archives.forEach(function(a){
    var row=document.createElement('div'); row.className='file-item';
    row.style.gridTemplateColumns='24px 1fr 100px 90px 80px';
    row.onclick=function(ev){ if(ev.target.tagName!=='INPUT') this.querySelector('input').click(); };
    var rawName = a.raw_name || a.name;
    var filePath = a.path || ('/var/lib/vz/dump/'+rawName);
    row.setAttribute('data-raw-name', rawName);
    row.setAttribute('data-path', filePath);
    var displayName = a.name || rawName;
    row.innerHTML='<input type="checkbox" class="file-checkbox vd-dl-check" onchange="updateVdDlCount()">'+
      '<div class="file-name">'+displayName+'</div>'+
      '<div class="file-size">'+(a.size||'?')+'</div>'+
      '<div class="file-date">'+(a.date||'?')+'</div>'+
      '<div class="file-status"><span class="status-dot st-ok">可下载</span></div>';
    listEl.appendChild(row);
  });
}

function startVdDownload(){
  var checked=document.querySelectorAll('.vd-dl-check:checked');
  if(checked.length===0){addLog('请选择要下载的归档文件','error');return;}
  if(transferRunning) return;
  transferRunning=true;

  var archives=[];
  checked.forEach(function(cb){
    var item = cb.closest('.file-item');
    var filePath = item.getAttribute('data-path');
    var rawName = item.getAttribute('data-raw-name') || item.querySelector('.file-name').textContent.trim();
    if(!filePath) filePath = '/var/lib/vz/dump/'+rawName;
    if(filePath){
      archives.push({path: filePath});
    }
  });

  var area=document.getElementById('vdDlProgress');
  area.style.display='block'; area.scrollIntoView({behavior:'smooth'});
  var logEl=document.getElementById('vdDlLog'); logEl.innerHTML='';
  var bar=document.getElementById('vdDlBar');
  bar.className='progress-bar'; bar.style.width='0%';
  document.getElementById('vdDlProgressStatus').textContent='下载中...';
  addLogLine(logEl, '开始下载 '+archives.length+' 个归档文件...', 'info');

  var auth=getVdAuth();
  openWs(function(ws){
    _rpSendWhenReady(ws, {
      action: 'download_archives', host: gv('vdHost'), port: gv('vdPort'), user: gv('vdUser'),
      auth_type: auth.auth_type, password: auth.password, key: auth.key, passphrase: auth.passphrase,
      archives: archives, local_dir: gv('vdDlLocalDir'), bwlimit: gv('vdDlBw')||'0'
    }, undefined, function(){ try { console.warn('[ws] 发送失败'); } catch(_){} })
    var handler=function(e){
      var d=JSON.parse(e.data);
      if(d.type==='log'){
        addLogLine(logEl, d.msg, d.level||'dim');
      } else if(d.type==='progress'){
        bar.style.width=Math.min(d.pct,100)+'%';
        document.getElementById('vdDlProgressStatus').textContent=(d.file||'')+' '+d.pct.toFixed(0)+'%';
        if(d.speed){ document.getElementById('vdStatSpd').textContent=d.speed; /* v5.37.0: 总线统一喂 */ }
      } else if(d.type==='finish'){
        ws.removeEventListener('message',handler);
        transferRunning=false;
        if(d.status==='success'){
          bar.style.width='100%'; bar.className='progress-bar success';
          document.getElementById('vdDlProgressStatus').textContent='下载完成 ✓';
          addLogLine(logEl, d.msg || '全部下载完成', 'success');
          addJob('vzdump 下载归档', vdDlDir, '完成');
        } else {
          bar.className='progress-bar error';
          document.getElementById('vdDlProgressStatus').textContent='下载失败';
          addLogLine(logEl, '下载发生异常: '+d.msg, 'error');
          addJob('vzdump 下载归档', vdDlDir, '失败');
        }
      }
    };
    ws.addEventListener('message',handler);
  }).catch(function(err){
    addLog('下载连接失败: '+err.message,'error');
  });
}

// ------------------------------------------
// 初始化环境
// ------------------------------------------
window.onload = function() {
  checkAuth();
  updateAuthUI();
  updateVdAuthUI();
  updatePveAuthUI();
  buildCmd();
  buildVzdumpCmd();
  loadVdParams();
  // 如果已登录，从数据库加载配置；否则使用本地localStorage
  loadConfigs();   // v5.35.0 · 单轨档案侧栏 (configs 退役)
  // v2.9.9 修复：移除输入 change 事件的 saveCurrentConfig 自动保存
  // 这是 v2.9.8 之前遗留的自动保存逻辑，会造成：
  //   1) applyConfig 里 setSelect 派发 change → 自动 saveCurrentConfig → 弹 3 次 toast
  //   2) 用户修改任意字段不点保存也自动落库，违反 v2.9.8「只有点保存才写库」的原则
  // 现在删除 — 用户明确点保存按钮才写库
  // loadSavedConfigs() removed: all panel data now managed by configs array + DB
  addLog('Fonriv Web 客户端已加载，等待配置目标服务器。', 'dim');
  addLog('请配置服务器连接信息并测试连接','info');
};

function estimateVdSize(){
  addLog('预估大小功能：请在PVE上执行 du -sh /var/lib/vz/images/'+selectedVdVmId+'/',  'info');
}

function copyVdCmds(){
  var c1=document.getElementById('vdCmd1');
  var c2=document.getElementById('vdCmd2');
  var c3=document.getElementById('vdCmd3');
  var text='';
  if(c1)text+=c1.textContent+'\n';
  if(c2)text+=c2.textContent+'\n';
  if(c3)text+=c3.textContent;
  if(navigator.clipboard){
    window.copyToClipboard(text, function(){addLog('命令已复制到剪贴板','success');});
  }
}

// ------------------------------------------
// 目录浏览对话框
// ------------------------------------------
var browseTargetInput = null;
var browseMode = 'local'; // 'local' or 'remote'
var browseAuth = {}; // 远程连接认证信息
var _dirBrowseHandler = null; // 持久引用，确保 removeEventListener 能正确移除

// v4.15.14 · 浏览会话级持久化：以 host:port:user 为 key 缓存已连通 auth，
//            关闭 modal 后再次打开自动恢复；切换主 tab 时清空。
var _browseAuthCache = {};                // key → { auth, verifiedAt }
var _browseSessionMulti = [];             // 累计"加入选中"的路径（跨批次追加）
function _authKey(a){ if(!a||!a.host) return ''; return (a.user||'root')+'@'+a.host+':'+(a.port||'22'); }
window._browseAuthCache = _browseAuthCache;
window._browseSessionMulti = _browseSessionMulti;

// 顶栏 🌐 状态点：连通 → 绿；否则 → 蓝
function _updateGlobeState(){
  var g = document.getElementById('globeIcon');
  if(!g) return;
  var anyConnected = false;
  var count = 0;
  Object.keys(_browseAuthCache).forEach(function(k){
    if(_browseAuthCache[k] && _browseAuthCache[k].verifiedAt){ anyConnected = true; count++; }
  });
  g.style.color = anyConnected ? 'var(--green)' : 'var(--cyan)';
  g.title = anyConnected ? ('已连通 '+count+' 个远端 · 点旁边 🔌 全部断开') : '未连接远端';
  var d = document.getElementById('globeDisconnectBtn');
  if(d){
    if(anyConnected){
      d.disabled = false;
      d.style.opacity = '1';
      d.style.cursor = 'pointer';
      d.style.borderColor = 'var(--red)';
      d.style.color = 'var(--red)';
      d.title = '断开所有远端浏览会话 ('+count+' 个)';
    } else {
      d.disabled = true;
      d.style.opacity = '0.35';
      d.style.cursor = 'not-allowed';
      d.style.borderColor = 'var(--border)';
      d.style.color = 'var(--text3)';
      d.title = '当前未连接任何远端';
    }
  }
}
function _disconnectAllBrowse(){
  _browseAuthCache = {};
  window._browseAuthCache = _browseAuthCache;
  _updateGlobeState();
  if(typeof toast === 'function') toast('已断开所有远端浏览会话','ok',1800);
}
window._updateGlobeState = _updateGlobeState;
window._disconnectAllBrowse = _disconnectAllBrowse;
// v4.15.15 · 页面就绪立即刷新一次（防止按钮初始 display:none 不再有机会显示）
if(typeof document !== 'undefined'){
  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', function(){ try{ _updateGlobeState(); }catch(_){} });
  } else {
    setTimeout(function(){ try{ _updateGlobeState(); }catch(_){} }, 100);
  }
}

function openDirBrowser(targetInput, initialPath, mode, auth){
  browseTargetInput = targetInput;
  browseMode = mode || 'local';
  // v4.15.14 · 命中缓存则优先用缓存 auth（保持连接跨 modal 打开）
  var incoming = auth || {};
  var ck = _authKey(incoming);
  if(browseMode==='remote' && ck && _browseAuthCache[ck] && _browseAuthCache[ck].verifiedAt){
    browseAuth = Object.assign({}, _browseAuthCache[ck].auth);
  } else {
    browseAuth = Object.assign({}, incoming);
  }
  _browseSessionMulti = []; // 每次打开都清空本批次多选缓冲
  var modal = document.getElementById('dirBrowseModal');
  if(!modal){
    modal = document.createElement('div');
    modal.id = 'dirBrowseModal';
    modal.style.cssText = 'display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:10000;justify-content:center;align-items:center';
    modal.innerHTML = '<div style="background:var(--bg2);border-radius:12px;width:720px;max-height:82vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,0.5);border:1px solid var(--border)">' +
      '<div style="padding:14px 20px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">' +
        '<span style="font-weight:600;font-size:16px" id="dirBrowseTitle">📁 选择目录</span>' +
        '<button onclick="closeDirBrowser()" style="background:none;border:none;color:var(--text2);font-size:20px;cursor:pointer">✕</button>' +
      '</div>' +
      // v4.15.14 · 内嵌 🔐 认证栏（远端模式显示）
      '<div id="dirBrowseAuthRow" style="display:none;padding:10px 20px;background:var(--bg);border-bottom:1px solid var(--border);font-size:12px">' +
        '<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">' +
          '<span style="color:var(--text3);white-space:nowrap" id="dirBrowseAuthInfo">🔐 认证</span>' +
          '<select id="dirBrowseAuthTypeSel" class="input" style="height:28px;font-size:12px;flex:0 0 auto;width:110px" onchange="_dirBrowseAuthTypeChange()">' +
            '<option value="pass">🔑 密码</option>' +
            '<option value="key">🗝 密钥+短语</option>' +
          '</select>' +
          // 密钥/密码文本框（密钥模式为 text 可见路径 + 📁 本地浏览按钮）
          '<div id="dirBrowseValWrap" style="flex:1;min-width:220px;display:flex;gap:4px;align-items:center">' +
            '<input type="text" id="dirBrowseAuthValue" placeholder="密钥路径 — 点 🔑 从本机/df挂载点/网络共享/服务器/云端选, 或直接粘贴密钥内容" class="input" style="flex:1;height:28px;font-size:12px">' +
            '<button class="btn btn-sm" id="dirBrowseKeyPick" onclick="(window.KeyPicker ? KeyPicker.pickInto(\'dirBrowseAuthValue\') : _dirBrowseKeyPickLocal())" title="选择密钥: 本机 / df挂载点 / 网络共享 / 已存服务器 / 远端存储 / 粘贴内容">🔑</button>' +
          '</div>' +
          '<input type="password" id="dirBrowseAuthPP" placeholder="密码短语（可留空）" class="input" style="flex:0 0 170px;height:28px;font-size:12px;display:none">' +
          '<button class="btn btn-sm btn-primary" id="dirBrowseConnBtn" onclick="_dirBrowseConnectToggle()">🔗 连接</button>' +
          '<button class="btn btn-sm" id="dirBrowseSaveBtn" onclick="_dirBrowseSaveCfg()" title="保存除密码/短语外的所有字段到服务器配置">💾 保存配置</button>' +
        '</div>' +
        '<div id="dirBrowseAuthMsg" style="margin-top:4px;color:var(--text3);font-size:11px"></div>' +
      '</div>' +
      '<div style="padding:10px 20px;background:var(--bg);border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px">' +
        '<span style="font-family:monospace;font-size:13px;color:var(--cyan);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" id="dirPathDisplay">/</span>' +
        '<button class="btn btn-sm" onclick="_dirBrowseMkdir()" title="在当前目录下新建子目录" style="padding:4px 10px;font-size:12px">+ 新建目录</button>' +
        '<button class="btn btn-sm" onclick="_dirBrowseGoUp()" title="上级目录" style="padding:4px 10px;font-size:12px">⬆ 上级</button>' +
        '<button class="btn btn-sm" onclick="_dirBrowseReload()" title="刷新当前目录" style="padding:4px 10px;font-size:12px">🔄 刷新</button>' +
      '</div>' +
      '<div id="dirList" style="flex:1;overflow-y:auto;padding:8px;min-height:240px"></div>' +
      '<div style="padding:10px 20px;border-top:1px solid var(--border);display:flex;gap:8px;align-items:center">' +
        '<span id="dirBrowseMultiInfo" style="color:var(--text3);font-size:12px;flex:1">☑ 勾选多个文件/目录后点『加入选中』-> 自动加入下方文件列表</span>' +
        '<button class="btn btn-sm" onclick="_dirBrowseAddSelected()" title="把勾选项追加到源列表">☑ 加入选中</button>' +
        '<button class="btn" onclick="closeDirBrowser()">取消</button>' +
        '<button class="btn btn-primary" onclick="confirmDirSelect()">确认选择</button>' +
      '</div>' +
      '</div>';
    document.body.appendChild(modal);
  }
  document.getElementById('dirBrowseTitle').textContent = (browseMode==='remote' ? '🌐 选择远端目录/文件' : '📁 选择本地目录/文件');
  var authRow = document.getElementById('dirBrowseAuthRow');
  if(browseMode === 'remote' && authRow){
    authRow.style.display = '';
    var info = document.getElementById('dirBrowseAuthInfo');
    if(info) info.textContent = '🔐 ' + (browseAuth.user||'root') + '@' + (browseAuth.host||'?') + ':' + (browseAuth.port||'22');
    var typeSel = document.getElementById('dirBrowseAuthTypeSel');
    if(typeSel) typeSel.value = browseAuth.auth_type || 'key';
    // v5.90.2 · 不再兜底填 '~/.ssh/id_rsa' (该文件在控制机上通常不存在 → 用假路径连接, 表现是"选密钥后列不出目录");
    //   档案里有密钥路径提示时才回显, 否则留空由用户用 🔑 选择器挑真实密钥
    var valEl = document.getElementById('dirBrowseAuthValue');
    if(valEl && !valEl.value && browseAuth.auth_type !== 'pass'){
      valEl.value = browseAuth._key_path_hint || '';
    }
    document.getElementById('dirBrowseAuthPP').value = '';
    _dirBrowseAuthTypeChange();
    var connected = !!(ck && _browseAuthCache[ck] && _browseAuthCache[ck].verifiedAt);
    _dirBrowseSetConnState(connected);
    document.getElementById('dirBrowseAuthMsg').textContent =
      connected ? '✓ 会话已保持连接 · 可直接浏览'
                : '填写密钥路径 + 密码短语（如有）→ 点『🔗 连接』；连通后本次会话保持';
    document.getElementById('dirBrowseAuthMsg').style.color = connected ? 'var(--green)' : 'var(--text3)';
  } else if(authRow){
    authRow.style.display = 'none';
  }
  modal.style.display = 'flex';
  modal.onclick = function(ev){ if(ev.target === modal) closeDirBrowser(); };
  // 远端模式且未连通 → 不自动 loadDir，等用户点连接（避免"未认证"的错误刷屏）
  if(browseMode === 'remote'){
    var ready = !!(_authKey(browseAuth) && _browseAuthCache[_authKey(browseAuth)] && _browseAuthCache[_authKey(browseAuth)].verifiedAt);
    if(ready) loadDir(initialPath || targetInput.value || '/');
    else document.getElementById('dirList').innerHTML =
      '<div style="padding:30px;text-align:center;color:var(--text3)">请先在上方点『🔗 连接』</div>';
  } else {
    loadDir(initialPath || targetInput.value || '/');
  }
}

// v4.15.14 · 内嵌认证 & 会话辅助
function _dirBrowseAuthTypeChange(){
  var t = document.getElementById('dirBrowseAuthTypeSel').value;
  var wrap = document.getElementById('dirBrowseValWrap');
  var val = document.getElementById('dirBrowseAuthValue');
  var pick = document.getElementById('dirBrowseKeyPick');
  var pp = document.getElementById('dirBrowseAuthPP');
  if(t === 'key'){
    // v5.90.2 · 不再预填 '~/.ssh/id_rsa' (控制机上通常不存在 → 假路径连接必失败, 表现为列不出目录);
    //   用户点 🔑 (统一密钥选择器: 本机/df挂载点/网络共享/已存服务器/远端存储/粘贴) 选真实密钥
    val.placeholder = '密钥路径 — 点 🔑 选择, 或直接粘贴 -----BEGIN...';
    val.type = 'text';
    if(pick) pick.style.display = '';
    pp.style.display = '';
  } else {
    val.placeholder = 'SSH 密码';
    val.type = 'password';
    if(pick) pick.style.display = 'none';
    pp.style.display = 'none';
    val.value = '';
  }
}
function _dirBrowseKeyPickLocal(){
  // 借用本地浏览器选私钥文件路径
  var hidden = document.createElement('input');
  hidden.type = 'hidden';
  document.body.appendChild(hidden);
  var oldMode = browseMode, oldAuth = browseAuth, oldTarget = browseTargetInput;
  var oldPath = document.getElementById('dirPathDisplay').textContent || '/';
  // 用现有 modal 临时切到本地模式选文件（复用主 modal 太麻烦，改用一次性 loadDir 到本地）
  // 更简单：直接 prompt 让用户输入 —— 但需求要"像上方一样可以点及浏览"
  // 这里用简易 loadDir 覆盖：临时切 mode='local'，选完再切回
  browseMode = 'local';
  browseTargetInput = document.getElementById('dirBrowseAuthValue');
  // 保留一份"本地选完后要切回远端"的钩子
  window._dirBrowseAfterLocalPick = function(picked){
    if(picked) document.getElementById('dirBrowseAuthValue').value = picked;
    browseMode = oldMode;
    browseTargetInput = oldTarget;
    document.getElementById('dirBrowseTitle').textContent = '🌐 选择远端目录/文件';
    window._dirBrowseAfterLocalPick = null;
    // 恢复远端列表（未连通就显示提示）
    var ck = _authKey(browseAuth);
    var connected = !!(ck && _browseAuthCache[ck] && _browseAuthCache[ck].verifiedAt);
    if(connected) loadDir(oldPath);
    else document.getElementById('dirList').innerHTML =
      '<div style="padding:30px;text-align:center;color:var(--text3)">请先在上方点『🔗 连接』</div>';
  };
  document.getElementById('dirBrowseTitle').textContent = '📁 选择本地私钥文件';
  loadDir('/root/.ssh/');
}
function _dirBrowseSetConnState(connected){
  var btn = document.getElementById('dirBrowseConnBtn');
  if(!btn) return;
  if(connected){ btn.textContent = '🔌 断开'; btn.classList.remove('btn-primary'); }
  else         { btn.textContent = '🔗 连接'; btn.classList.add('btn-primary'); }
}
function _dirBrowseGoUp(){
  var cur = document.getElementById('dirPathDisplay').textContent || '/';
  if(cur === '/') return;
  var up = cur.replace(/\/+$/,'').replace(/\/[^\/]+$/,'') || '/';
  loadDir(up);
}
function _dirBrowseReload(){
  loadDir(document.getElementById('dirPathDisplay').textContent || '/');
}
// v4.24.0 · 在浏览器当前目录下新建子目录
async function _dirBrowseMkdir(){
  var cur = document.getElementById('dirPathDisplay').textContent || '/';
  var name = await rpPrompt({ title:'新建子目录', hint:'当前目录: ' + cur, placeholder:'子目录名' });
  if (!name) return;
  name = String(name).trim();
  if (!name) return;
  if (name.indexOf('/') >= 0 || name === '.' || name === '..'){
    alert('目录名不能包含 /、. 或 ..');
    return;
  }
  var msg;
  if (browseMode === 'remote'){
    msg = { action: 'mkdir_remote', parent: cur, name: name,
      host: browseAuth.host, port: browseAuth.port, user: browseAuth.user,
      auth_type: browseAuth.auth_type, password: browseAuth.password,
      key: browseAuth.key, passphrase: browseAuth.passphrase };
  } else {
    msg = { action: 'mkdir', parent: cur, name: name };
  }
  openWs(function(ws){
    var once = function(e){
      var d; try { d = JSON.parse(e.data); } catch(_){ return; }
      if (!d || d.type !== 'mkdir_result') return;
      ws.removeEventListener('message', once);
      if (d.status !== 'ok'){
        alert('新建失败: ' + (d.msg || '未知错误'));
        return;
      }
      // 成功 → 刷新当前目录 + toast
      if (window.toast) toast('已创建 ' + d.path, 'ok');
      loadDir(cur);
    };
    ws.addEventListener('message', once);
    _rpSendWhenReady(ws, msg, undefined, function(){ try { console.warn('[ws] 发送失败'); } catch(_){} })
  }).catch(function(){ alert('WebSocket 连接失败'); });
}
async function _dirBrowseConnectToggle(){
  var ck = _authKey(browseAuth);
  var connected = !!(ck && _browseAuthCache[ck] && _browseAuthCache[ck].verifiedAt);
  if(connected){
    // 断开
    if(ck) delete _browseAuthCache[ck];
    _dirBrowseSetConnState(false);
    var msg1 = document.getElementById('dirBrowseAuthMsg');
    msg1.textContent = '🔌 已断开 · 需重新连接后浏览'; msg1.style.color = 'var(--text3)';
    document.getElementById('dirList').innerHTML =
      '<div style="padding:30px;text-align:center;color:var(--text3)">请先在上方点『🔗 连接』</div>';
    _updateGlobeState();
    return;
  }
  // 连接：合并"测试+应用"为一步
  var t = document.getElementById('dirBrowseAuthTypeSel').value;
  var v = document.getElementById('dirBrowseAuthValue').value || '';
  var pp = document.getElementById('dirBrowseAuthPP').value || '';
  var patched = {
    host: browseAuth.host, port: browseAuth.port || '22', user: browseAuth.user || 'root',
    auth_type: t,
    password: browseAuth.password || '',
    key: browseAuth.key || '',
    passphrase: browseAuth.passphrase || '',
    _key_path_hint: (t === 'key' && v && !/BEGIN/.test(v)) ? v : (browseAuth._key_path_hint || '')
  };
  if(v){
    if(t === 'pass'){ patched.password = encodePassword(v); patched.key = ''; patched.passphrase = ''; }
    else            { patched.key = encodePassword(v); patched.password = ''; }
  }
  if(pp) patched.passphrase = encodePassword(pp);
  if(typeof upgradeAuthToEC1 === 'function') patched = await upgradeAuthToEC1(patched);
  var msg = document.getElementById('dirBrowseAuthMsg');
  msg.textContent = '⏳ 连接中…'; msg.style.color = 'var(--text3)';
  openWs(function(ws){
    _rpSendWhenReady(ws, { action:'test_conn',
      host: patched.host, port: patched.port, user: patched.user,
      auth_type: patched.auth_type,
      password: patched.password, key: patched.key, passphrase: patched.passphrase
    }, undefined, function(){ try { console.warn('[ws] 发送失败'); } catch(_){} })
    var handler = function(e){
      var d;
      try{ d = JSON.parse(e.data); } catch(_){ return; }
      if(d.type !== 'result') return;
      ws.removeEventListener('message', handler);
      if(d.status === 'ok'){
        browseAuth = patched;
        var k = _authKey(browseAuth);
        _browseAuthCache[k] = { auth: browseAuth, verifiedAt: Date.now() };
        _dirBrowseSetConnState(true);
        msg.textContent = '✓ ' + d.msg; msg.style.color = 'var(--green)';
        _updateGlobeState();
        // v4.15.17 · 连接成功默认跳到 /，找文件更方便
        document.getElementById('dirPathDisplay').textContent = '/';
        loadDir('/');
      } else {
        msg.textContent = '✗ ' + d.msg; msg.style.color = 'var(--red)';
      }
    };
    ws.addEventListener('message', handler);
  });
}
async function _dirBrowseSaveCfg(){
  // 保存 host/port/user/auth_type/key_path（不保存密码/短语）到 configs 库
  var t = document.getElementById('dirBrowseAuthTypeSel').value;
  var v = document.getElementById('dirBrowseAuthValue').value || '';
  var name = await rpPrompt({ title:'保存为服务器配置名称', defaultName: (browseAuth.user||'root')+'@'+(browseAuth.host||'') });
  if(!name) return;
  // v5.35.0 · G3: 保存 → 服务器档案 (sp_save)
  var payload = {
    name: name,
    hostname: browseAuth.host, ssh_port: parseInt(browseAuth.port || '22', 10) || 22,
    ssh_user: browseAuth.user || 'root',
    ssh_auth_type: t,
  };
  if (t === 'key' && v && !/BEGIN/.test(v)) payload.ssh_auth_value = v;
  if(!window.send){ alert('WS 未就绪'); return; }
  send({action:'sp_save', profile: payload}, function(d){
    var msg = document.getElementById('dirBrowseAuthMsg');
    if(d && d.status === 'ok'){
      msg.textContent = '💾 已保存到服务器档案 (左侧/连接中心可选) · 密码/短语不落地'; msg.style.color = 'var(--green)';
      if(window.SP){ SP.forgetAll(); var cl = document.getElementById('configList'); if(cl) SP.renderSidebarSection(cl); }
    } else {
      msg.textContent = '✗ 保存失败: ' + ((d&&d.msg)||''); msg.style.color = 'var(--red)';
    }
  });
}
function _dirBrowseAddSelected(){
  var boxes = document.querySelectorAll('#dirList input.dbSel:checked');
  var picked = [];
  boxes.forEach(function(b){ if(b.dataset && b.dataset.path) picked.push(b.dataset.path); });
  if(!picked.length){ if(typeof toast==='function') toast('未勾选任何项','warn',1800); return; }
  _browseSessionMulti = _browseSessionMulti.concat(picked);
  if(browseTargetInput){
    if(browseTargetInput.tagName === 'TEXTAREA'){
      var old = (browseTargetInput.value||'').replace(/\s+$/,'');
      browseTargetInput.value = (old ? old + '\n' : '') + picked.join('\n');
    } else if(picked.length === 1){
      // 单选 -> 填入 input
      browseTargetInput.value = picked[0];
    } else {
      // v4.39.0 · 多选 + 单值 input -> 首项填入 input，其余推入 TransferList 文件列表
      browseTargetInput.value = picked[0];
      if (window.TransferList && typeof window.TransferList.add === 'function'){
        var tlPanelId = (browseTargetInput.id === 'srcPath' || browseTargetInput.id === 'dstPath')
                          ? 'transfer' : 'transfer';
        var items = picked.map(function(p){ return { src: p, dst: '' }; });
        try {
          window.TransferList.add(tlPanelId, items);
          if(typeof toast==='function') toast('已加入 '+picked.length+' 项到文件列表（首项已填入路径框）', 'ok', 2500);
        } catch(e){
          if(typeof toast==='function') toast('文件列表加入失败: '+e, 'err');
        }
      } else {
        // TransferList 未就绪 -> 回退到分号拼接
        browseTargetInput.value = picked.join('; ');
      }
    }
    if(browseTargetInput.oninput) browseTargetInput.oninput();
    try{ browseTargetInput.dispatchEvent(new Event('input', {bubbles:true})); }catch(_){}
  }
  if(typeof toast==='function' && picked.length <= 1) toast('已加入 '+picked.length+' 项', 'ok', 1500);
  // 清除勾选
  boxes.forEach(function(b){ b.checked = false; });
}
window._dirBrowseAuthTypeChange = _dirBrowseAuthTypeChange;
window._dirBrowseKeyPickLocal = _dirBrowseKeyPickLocal;
window._dirBrowseConnectToggle = _dirBrowseConnectToggle;
window._dirBrowseSaveCfg = _dirBrowseSaveCfg;
window._dirBrowseAddSelected = _dirBrowseAddSelected;
window._dirBrowseGoUp = _dirBrowseGoUp;
window._dirBrowseReload = _dirBrowseReload;

function closeDirBrowser(){
  var modal = document.getElementById('dirBrowseModal');
  if(modal) modal.style.display = 'none';
  _dirBrowseHandler = null;
}

function loadDir(path){
  var display = document.getElementById('dirPathDisplay');
  var list = document.getElementById('dirList');
  display.textContent = path;
  list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text3)">加载中...</div>';

  openWs(function(ws){
    /* v6.3.18 · **补上绕过的就绪门**(CDP 抓帧实测): 这两处此前是**裸 ws.send**, 绕过了
       `_rpSendWhenReady`, 于是在"登录尚未完成"的瞬间就把请求打出去 → 被服务端逐条拒
       ("请先登录(会话已丢失)"), 用户还会看到一条登录前的报错提示; 且拒后重试仍被拒。
       实测时间线: t=1767ms 发 list_dir(此时用户还没点登录) → 立刻两次拒绝。
       现在一律走门: 未就绪先压住(≤3s), 就绪即发 —— 目录浏览器自然能列出内容, 不再刷屏报错。 */
    if(browseMode === 'remote'){
      _rpSendWhenReady(ws, {
        action: 'list_remote_dir', path: path,
        host: browseAuth.host, port: browseAuth.port, user: browseAuth.user,
        auth_type: browseAuth.auth_type, password: browseAuth.password, key: browseAuth.key, passphrase: browseAuth.passphrase
      }, undefined, function(){ try { console.warn('[browse] 发送失败'); } catch(_){} });
    } else {
      _rpSendWhenReady(ws, { action: 'list_dir', path: path }, undefined, function(){ try { console.warn('[browse] 发送失败'); } catch(_){} });
    }
    // Remove old handler (must be the same function reference)
    if(_dirBrowseHandler){
      ws.removeEventListener('message', _dirBrowseHandler);
    }
    _dirBrowseHandler = function(e){
      var d = JSON.parse(e.data);
      ws.removeEventListener('message', _dirBrowseHandler);
      _dirBrowseHandler = null;
      if(d.type === 'dir_result'){
        if(d.status === 'ok'){
          display.textContent = d.path;
          list.innerHTML = '';
          if(d.entries.length === 0){
            list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text3)">空目录</div>';
          } else {
            d.entries.forEach(function(entry){
              var row = document.createElement('div');
              row.style.cssText = 'padding:6px 10px;border-radius:6px;display:flex;align-items:center;gap:8px;font-size:14px;transition:background 0.15s';
              row.onmouseenter = function(){ row.style.background = 'rgba(255,255,255,0.05)'; };
              row.onmouseleave = function(){ row.style.background = ''; };
              var icon = entry.type === 'dir' ? '📁' : '📄';
              var color = entry.type === 'dir' ? 'var(--purple)' : 'var(--text)';
              // v4.15.14 · 复选框 (支持多选) + 名称双击进入/选中
              var cb = document.createElement('input');
              cb.type = 'checkbox'; cb.className = 'dbSel';
              cb.dataset.path = entry.path; cb.dataset.type = entry.type;
              cb.style.cssText = 'margin:0;cursor:pointer';
              cb.onclick = function(ev){ ev.stopPropagation(); };
              var label = document.createElement('span');
              label.style.cssText = 'flex:1;cursor:pointer;color:'+color;
              label.innerHTML = icon + ' ' + entry.name;
              if(entry.type === 'dir'){
                label.onclick = function(){ loadDir(entry.path); };
              } else {
                label.onclick = function(){
                  // v4.15.14 · 若处于"选私钥"临时子模式 → 回调外层
                  if(typeof window._dirBrowseAfterLocalPick === 'function'){
                    window._dirBrowseAfterLocalPick(entry.path); return;
                  }
                  confirmDirSelect(entry.path);
                };
              }
              row.appendChild(cb);
              row.appendChild(label);
              list.appendChild(row);
            });
          }
        } else {
          list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--red)">' + d.msg + '</div>';
        }
      }
    };
    ws.addEventListener('message', _dirBrowseHandler);
  }).catch(function(){
    list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--red)">连接失败</div>';
  });
}

function confirmDirSelect(selectedPath){
  // v4.15.18 · 修 bug：用户先点"加入选中"后点"确认选择"会把当前目录再追加
  //   规则：若本会话已通过"加入选中"追加过 → 直接关闭，不再默认拿当前目录
  if(!selectedPath){
    var boxes = document.querySelectorAll('#dirList input.dbSel:checked');
    if(boxes.length > 0){
      _dirBrowseAddSelected();
      closeDirBrowser();
      return;
    }
    // 已批量加入过 → 直接关闭
    if(_browseSessionMulti && _browseSessionMulti.length > 0){
      closeDirBrowser();
      return;
    }
  }
  if(!selectedPath && browseTargetInput){
    selectedPath = document.getElementById('dirPathDisplay').textContent;
  }
  // 处于选私钥子模式 → 回调外层
  if(typeof window._dirBrowseAfterLocalPick === 'function'){
    window._dirBrowseAfterLocalPick(selectedPath);
    return;
  }
  if(selectedPath && browseTargetInput){
    if(browseTargetInput.tagName === 'TEXTAREA'){
      var old = (browseTargetInput.value||'').replace(/\s+$/,'');
      browseTargetInput.value = (old ? old + '\n' : '') + selectedPath;
    } else {
      browseTargetInput.value = selectedPath;
    }
    if(browseTargetInput.oninput) browseTargetInput.oninput();
  }
  closeDirBrowser();
}

// ------------------------------------------
// 任务队列管理
// ------------------------------------------
function addJob(name, size, status){
  var now = new Date();
  var timeStr = now.getHours().toString().padStart(2,'0') + ':' + now.getMinutes().toString().padStart(2,'0') + ':' + now.getSeconds().toString().padStart(2,'0');
  jobQueue.unshift({name: name, size: size||'—', time: timeStr, status: status});
  renderJobs();
}
function renderJobs(){
  var list = document.getElementById('jobList');
  var empty = document.getElementById('jobEmpty');
  if(!list) return;
  if(jobQueue.length === 0){
    empty.style.display = 'block';
    // Keep header only
    var header = list.querySelector('.file-list-header');
    list.innerHTML = '';
    if(header) list.appendChild(header);
    return;
  }
  empty.style.display = 'none';
  // Remove old items (keep header)
  var header = list.querySelector('.file-list-header');
  list.innerHTML = '';
  if(header) list.appendChild(header);
  jobQueue.forEach(function(j){
    var icon = '📤';
    var dotClass = 'st-ok';
    if(j.status === '进行中'){ icon = '📥'; dotClass = 'st-info'; }
    else if(j.status === '失败'){ icon = '⚠'; dotClass = 'st-err'; }
    else if(j.status === '等待中'){ icon = '⏰'; dotClass = ''; }
    var row = document.createElement('div');
    row.className = 'file-item';
    row.innerHTML = '<div>' + icon + '</div><div class="file-name">' + j.name + '</div><div class="file-size">' + j.size + '</div><div class="file-date">' + j.time + '</div><div class="file-status"><span class="status-dot ' + dotClass + '">' + j.status + '</span></div>';
    list.appendChild(row);
  });
}
function clearFinishedJobs(){
  jobQueue = jobQueue.filter(function(j){ return j.status === '进行中'; });
  renderJobs();
}

// ------------------------------------------
// 带宽监控
// ------------------------------------------
var bwHistory = [];      // {time, speed} 记录
var bwTotalBytes = 0;    // 累计传输字节
var bwTimer = null;      // 刷新定时器
var bwMaxPoints = 60;    // 最多保留60个采样点

// 所有传输中更新速度的地方都调用此函数
function recordSpeed(speedStr){
  var m = speedStr.match(/([\d.]+)\s*(B|KB|MB|GB|TB)/i);
  if(!m) return;
  var val = parseFloat(m[1]);
  var unit = m[2].toUpperCase();
  var bytes = val * ({B:1,KB:1024,MB:1048576,GB:1073741824,TB:1099511627776}[unit]||1);
  var mbps = bytes / 1048576;
  // v4.43.1 · FIX ⑧: 累计传输量 = 速度 × 采样间隔（积分近似，单次上限 10s 防跳变）
  //   此前 bwTotalBytes 没有任何累加代码（恒 0），侧栏"累计传输"永远显示 0 GB
  var _now = new Date();
  var _lastTs = window._bwLastTs || 0;
  if (_lastTs){
    var _dt = Math.min((_now - _lastTs) / 1000, 10);
    if (_dt > 0) bwTotalBytes += mbps * 1048576 * _dt;
  }
  window._bwLastTs = +_now;
  bwHistory.push({time: _now, speed: mbps, raw: speedStr});
  if(bwHistory.length > bwMaxPoints) bwHistory.shift();
  // v4.43.1 · FIX ⑧: 采样即刷侧栏 speedDisplay/totalDisplay
  //   此前 totalDisplay 全仓库无任何更新代码，speedDisplay 仅旧路径传输手动刷新
  try {
    var _sd = document.getElementById('speedDisplay');
    if(_sd) _sd.textContent = speedStr;
    var _td = document.getElementById('totalDisplay');
    if(_td) _td.textContent = formatBytes(bwTotalBytes);
  } catch(_){}
}

function openBandwidthMonitor(){
  var modal = document.getElementById('bwMonitorModal');
  if(!modal){
    modal = document.createElement('div');
    modal.id = 'bwMonitorModal';
    modal.style.cssText = 'display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:10000;justify-content:center;align-items:center';
    modal.innerHTML = '<div style="background:var(--bg2);border-radius:12px;width:680px;max-height:80vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,0.5);border:1px solid var(--border)">' +
      '<div style="padding:16px 20px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">' +
      '<span style="font-weight:600;font-size:16px">📊 带宽监控</span>' +
      '<button onclick="closeBwMonitor()" style="background:none;border:none;color:var(--text2);font-size:20px;cursor:pointer">✕</button></div>' +
      '<div style="padding:16px 20px">' +
      '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:16px">' +
      '<div style="background:var(--bg);border-radius:8px;padding:12px;text-align:center">' +
      '<div style="font-size:10px;color:var(--text3)">当前速度</div><div style="font-size:20px;color:var(--cyan);font-weight:700" id="bwNow">0 MB/s</div></div>' +
      '<div style="background:var(--bg);border-radius:8px;padding:12px;text-align:center">' +
      '<div style="font-size:10px;color:var(--text3)">峰值速度</div><div style="font-size:20px;color:var(--orange);font-weight:700" id="bwPeak">0 MB/s</div></div>' +
      '<div style="background:var(--bg);border-radius:8px;padding:12px;text-align:center">' +
      '<div style="font-size:10px;color:var(--text3)">平均速度</div><div style="font-size:20px;color:var(--green);font-weight:700" id="bwAvg">0 MB/s</div></div>' +
      '</div>' +
      '<div style="font-size:11px;color:var(--text3);margin-bottom:6px">传输速度趋势（最近 ' + bwMaxPoints + ' 次采样）</div>' +
      '<canvas id="bwChart" width="636" height="180" style="width:100%;border-radius:8px;background:var(--bg)"></canvas>' +
      '<div style="display:flex;justify-content:space-between;margin-top:8px;font-size:11px;color:var(--text3)">' +
      '<span id="bwStartTime">—</span><span id="bwTotalTransferred">累计: 0 GB</span><span id="bwSampleCount">0 个采样</span></div>' +
      '</div></div>';
    document.body.appendChild(modal);
    modal.onclick = function(ev){ if(ev.target === modal) closeBwMonitor(); };
  }
  modal.style.display = 'flex';
  refreshBwMonitor();
  if(bwTimer) clearInterval(bwTimer);
  bwTimer = setInterval(refreshBwMonitor, 1000);
}

function closeBwMonitor(){
  var modal = document.getElementById('bwMonitorModal');
  if(modal) modal.style.display = 'none';
  if(bwTimer){ clearInterval(bwTimer); bwTimer = null; }
}

function refreshBwMonitor(){
  var nowEl = document.getElementById('bwNow');
  var peakEl = document.getElementById('bwPeak');
  var avgEl = document.getElementById('bwAvg');
  var startEl = document.getElementById('bwStartTime');
  var totalEl = document.getElementById('bwTotalTransferred');
  var countEl = document.getElementById('bwSampleCount');
  var canvas = document.getElementById('bwChart');
  if(!nowEl) return;

  // 当前速度
  var current = bwHistory.length > 0 ? bwHistory[bwHistory.length-1] : null;
  nowEl.textContent = current ? current.raw : '0 MB/s';

  // 峰值
  var peak = 0;
  bwHistory.forEach(function(p){ if(p.speed > peak) peak = p.speed; });
  peakEl.textContent = peak.toFixed(1) + ' MB/s';

  // 平均
  if(bwHistory.length > 0){
    var sum = 0; bwHistory.forEach(function(p){ sum += p.speed; });
    avgEl.textContent = (sum / bwHistory.length).toFixed(1) + ' MB/s';
  } else { avgEl.textContent = '0 MB/s'; }

  // 时间
  startEl.textContent = bwHistory.length > 0 ? bwHistory[0].time.toLocaleTimeString() : '—';
  countEl.textContent = bwHistory.length + ' 个采样';
  totalEl.textContent = '累计: ' + formatBytes(bwTotalBytes);

  // 画图
  drawBwChart(canvas);
}

function drawBwChart(canvas){
  if(!canvas) return;
  var ctx = canvas.getContext('2d');
  var W = canvas.width, H = canvas.height;
  var pad = {top:10, right:10, bottom:20, left:50};
  var gW = W - pad.left - pad.right;
  var gH = H - pad.top - pad.bottom;

  ctx.clearRect(0, 0, W, H);

  if(bwHistory.length < 2){
    ctx.fillStyle = '#555';
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('等待传输数据...', W/2, H/2);
    return;
  }

  var maxSpeed = 1;
  bwHistory.forEach(function(p){ if(p.speed > maxSpeed) maxSpeed = p.speed; });
  maxSpeed = maxSpeed * 1.2; // 留点空间

  // 网格线
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1;
  for(var i = 0; i <= 4; i++){
    var y = pad.top + gH * (1 - i/4);
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(W - pad.right, y); ctx.stroke();
    ctx.fillStyle = '#777'; ctx.font = '10px monospace'; ctx.textAlign = 'right';
    ctx.fillText((maxSpeed * i / 4).toFixed(1), pad.left - 4, y + 3);
  }

  // 折线 + 填充
  ctx.beginPath();
  bwHistory.forEach(function(p, idx){
    var x = pad.left + (idx / (bwHistory.length - 1)) * gW;
    var y = pad.top + gH * (1 - p.speed / maxSpeed);
    if(idx === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = '#00b4d8';
  ctx.lineWidth = 2;
  ctx.stroke();

  // 填充区域
  var lastX = pad.left + gW;
  ctx.lineTo(lastX, pad.top + gH);
  ctx.lineTo(pad.left, pad.top + gH);
  ctx.closePath();
  var grad = ctx.createLinearGradient(0, pad.top, 0, pad.top + gH);
  grad.addColorStop(0, 'rgba(0,180,216,0.3)');
  grad.addColorStop(1, 'rgba(0,180,216,0.02)');
  ctx.fillStyle = grad;
  ctx.fill();
}

function formatBytes(b){
  if(b < 1024) return b.toFixed(0) + ' B';
  if(b < 1048576) return (b/1024).toFixed(1) + ' KB';
  if(b < 1073741824) return (b/1048576).toFixed(2) + ' MB';
  if(b < 1099511627776) return (b/1073741824).toFixed(2) + ' GB';
  return (b/1099511627776).toFixed(2) + ' TB';
}

// ------------------------------------------
// 帮助手册
// ------------------------------------------
var helpContentLoaded = false;

// v4.57.0 · 关于: 单入口合并 版本信息 + 更新日志/使用手册入口 (顶部腾空间)
function openAbout(){
  var old = document.getElementById('aboutModal');
  if (old) old.remove();
  /* v6.16.2 批24 · 官方命名寓意 (中英双语, 按界面语言显示; 用户提供文案 2026-10-10) */
  var _abEn = (window.currentLang && window.currentLang() === 'en');
  var _ab = _abEn ? {
    tagline: 'Multi-Cloud Transfer & Backup Management Platform',
    sec1: '【The Name】',
    intro: '<b>Fonriv</b> comes from the Latin <i>Fons</i> (the source of water) and <i>Rivus</i> (an ever-flowing stream).',
    srcTitle: '源 (Fons) — Source:',
    src: ' the primal origin of data and its foundation of trust — the source paths of every transfer, data provenance, and dependable storage. As Wei Zheng counselled the Tang throne: “A tree that grows tall must first root deep; a river that runs far must first clear its spring.” Every piece of data has a traceable origin and a safeguard.',
    flowTitle: '流 (Rivus) — Flow:',
    flow: ' the fluent transfer, flexible sharing and seamless movement of data — “a flame passed hand to hand, living on and on”, and like the teacher who “imparts wisdom, spreads knowledge and resolves doubts” (Han Yu, Tang dynasty). Data flowing across devices and enduring over time carries business and knowledge from one generation of users to the next.',
    slogan: '<b>Fonriv</b> — the complete transfer pipeline from data source to endpoint: both a secure foundation for tracing every flow back to its origin, and an ever-flowing hub of data.',
    sec2: '【Command Line & Pronunciation】',
    pron: 'pronounced /ˈfɒnrɪv/',
    fullname: 'Full name: Fonriv Multi-Cloud Transfer & Backup Management Platform ' + (window.RP_VERSION ? 'v' + window.RP_VERSION : '')
  } : {
    tagline: '源流多云传输与备份管理平台',
    sec1: '【命名寓意】',
    intro: '<b>Fonriv（源流）</b>源自拉丁语 <i>Fons</i>（水之源头）与 <i>Rivus</i>（川流不息）。',
    srcTitle: '源（Fons）：',
    src: '象征数据的原始起点与安全基石，指代文件传输的源路径、数据的原生性与可靠存储。正所谓「求木之长者，必固其根本；欲流之远者，必浚其泉源」（唐·魏征《谏太宗十思疏》），每一份数据都有其可追溯的始源与安全保障。',
    flowTitle: '流（Rivus）：',
    flow: '象征数据的流畅传输、灵活分享与无缝流转。亦如「薪火相传，生生不息」，又如「师者，所以传道受业解惑也」（唐·韩愈《师说》），数据的跨端流动与持久保存，承载着业务与智慧的代代流传。',
    slogan: '<b>Fonriv 源流</b> —— 从数据源头到终端的完整传输链路，既是「流踪溯源」的安全底座，也是「源源不断」的数据枢纽。',
    sec2: '【命令行与发音】',
    pron: '标准发音 /ˈfɒnrɪv/',
    fullname: '全称：Fonriv 源流多云传输与备份管理平台 ' + (window.RP_VERSION ? 'v' + window.RP_VERSION : '')
  };
  var m = document.createElement('div');
  m.id = 'aboutModal';
  m.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.6);z-index:10000;display:flex;align-items:center;justify-content:center';
  m.innerHTML =
    /* v1.0.0 · 修英文下关于页溢出视口: 整卡限高 90vh 并整体滚动 —— 不分上下两区(用户反馈
       之前的分区+分隔阴影看着像两个面板), 中文下内容本就装得下, 观感与旧版完全一致 */
    '<div style="background:var(--bg2);border-radius:12px;width:520px;max-width:94vw;max-height:90vh;overflow-y:auto;overscroll-behavior:contain;padding:20px 26px;box-shadow:0 20px 60px rgba(0,0,0,0.5);border:1px solid var(--border);text-align:center">' +
    '  <div style="font-size:24px;margin-bottom:4px">📦</div>' +
    '  <div style="font-size:19px;font-weight:700;margin-bottom:2px">Fonriv 源流 <span style="color:var(--cyan)">' + (window.RP_VERSION ? 'v' + window.RP_VERSION : '') + '</span></div>' +
    '  <div style="font-size:12px;color:var(--text2);margin-bottom:4px">' + _ab.tagline + '</div>' +
    '  <div style="font-size:12px;color:var(--text3);margin-bottom:10px">' + (window.RP_EDITION_CN_TXT ? window.RP_EDITION_CN_TXT : '') + '</div>' +
  '  <div style="font-size:11px;color:var(--text3);margin:0 auto 12px;max-width:430px;line-height:1.75;text-align:left;background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:9px 13px">' +
  '    <div style="font-weight:700;color:var(--text2);margin-bottom:4px">' + _ab.sec1 + '</div>' +
  '    ' + _ab.intro + '<br>' +
  '    <b>' + _ab.srcTitle + '</b>' + _ab.src + '<br>' +
  '    <b>' + _ab.flowTitle + '</b>' + _ab.flow + '<br>' +
  '    ' + _ab.slogan + '<br>' +
  '    <div style="font-weight:700;color:var(--text2);margin:8px 0 4px;border-top:1px dashed var(--border);padding-top:8px">' + _ab.sec2 + '</div>' +
  '    CLI: <code>fonriv</code> · ' + _ab.pron + '<br>' +
  '    ' + _ab.fullname +
  '  </div>' +
    '  <div style="display:flex;flex-direction:column;gap:8px;margin:0 auto 14px;max-width:280px">' +
    '    <button class="btn" style="text-align:left;padding:8px 14px;border-color:var(--blue)" onclick="closeAbout();UpdateUI && UpdateUI.check()">🔄 检查更新 <span style="color:var(--text3);font-size:11px">(在线升级)</span></button>' +
    '    <button class="btn" style="text-align:left;padding:8px 14px" onclick="closeAbout();openChangelog()">📜 更新日志</button>' +
    '    <button class="btn" style="text-align:left;padding:8px 14px" onclick="closeAbout();openLicenseText()">📄 许可协议 (EULA)</button>' +
    '    <a class="btn" style="text-align:left;padding:8px 14px" href="https://github.com/lxrmyc/fonriv/" target="_blank" rel="noopener">🐙 源码仓库 (GitHub)</a>' +
    '    <button class="btn" style="text-align:left;padding:8px 14px" onclick="closeAbout();switchTab(\'log\')">📋 传输日志</button>' +
    '  </div>' +
    '  <button class="btn btn-sm" onclick="closeAbout()" style="margin-top:4px">关闭</button>' +
    '</div>';
  document.body.appendChild(m);
  m.onclick = function(ev){ if (ev.target === m) closeAbout(); };
}
function closeAbout(){
  var m = document.getElementById('aboutModal');
  if (m) m.remove();
}
/* v6.16.21 批38 · 关于页查看完整 EULA (用户要求): 从 /api/v1/license_text 拉随包 LICENSE 全文 */
function openLicenseText(){
  var m = document.createElement('div');
  m.id = 'licenseTextModal';
  m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:10001;display:flex;align-items:center;justify-content:center';
  m.innerHTML =
    '<div style="background:var(--bg2);border:1px solid var(--border);border-radius:12px;width:860px;max-width:94vw;height:calc(100vh - 80px);display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,0.5);overflow:hidden">'
    + '<div style="padding:12px 20px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;flex-shrink:0">'
    + '  <span style="font-weight:600;font-size:15px">📄 Fonriv 社区版 — 最终用户许可协议 (EULA)</span>'
    + '  <button class="btn btn-sm" onclick="document.getElementById(\'licenseTextModal\').remove()">✕ 关闭</button>'
    + '</div>'
    + '<div id="licenseTextBox" style="flex:1;overflow:auto;padding:18px 26px;font-size:12.5px;line-height:1.85;white-space:pre-wrap;font-family:ui-monospace,Consolas,monospace;color:var(--text2)">⏳ 加载中…</div>'
    + '</div>';
  document.body.appendChild(m);
  m.onclick = function(ev){ if (ev.target === m) m.remove(); };
  fetch('/api/v1/license_text').then(function(r){ return r.json(); }).then(function(d){
    var box = document.getElementById('licenseTextBox');
    if (!box) return;
    box.textContent = (d && d.status === 'ok') ? d.text : (d && d.msg || '读取失败');
  }).catch(function(e){
    var box = document.getElementById('licenseTextBox');
    if (box) box.textContent = '读取失败: ' + e;
  });
}
window.openLicenseText = openLicenseText;
function openHelp(){
  var modal = document.getElementById('helpModal');
  if(!modal){
    modal = document.createElement('div');
    modal.id = 'helpModal';
    modal.style.cssText = 'display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.6);z-index:10000;justify-content:center;align-items:center';
    modal.innerHTML =
      '<div id="helpBox" style="background:var(--bg2);border-radius:12px;width:920px;height:calc(100vh - 60px);display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,0.5);border:1px solid var(--border);overflow:hidden">'
      + '<div style="padding:12px 20px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:4px;flex-shrink:0">'
      + '<span style="font-weight:600;font-size:16px" id="helpModalTitle">❓ 使用手册</span>'
      + '<div style="display:flex;gap:3px;align-items:center;flex-wrap:wrap">'
      + '<button onclick="toggleHelpLang(this.dataset.hl)" class="help-lang-btn" data-hl="zh" style="padding:2px 7px;font-size:11px;border-radius:4px;border:1px solid var(--border);cursor:pointer;background:var(--bg3);color:var(--text)">中文</button>'
      + '<button onclick="toggleHelpLang(this.dataset.hl)" class="help-lang-btn" data-hl="en" style="padding:2px 7px;font-size:11px;border-radius:4px;border:1px solid var(--border);cursor:pointer;background:var(--bg3);color:var(--text)">EN</button>'
      + '<button onclick="toggleHelpLang(this.dataset.hl)" class="help-lang-btn" data-hl="ja" style="padding:2px 7px;font-size:11px;border-radius:4px;border:1px solid var(--border);cursor:pointer;background:var(--bg3);color:var(--text)">日本語</button>'
      + '<button onclick="toggleHelpLang(this.dataset.hl)" class="help-lang-btn" data-hl="fr" style="padding:2px 7px;font-size:11px;border-radius:4px;border:1px solid var(--border);cursor:pointer;background:var(--bg3);color:var(--text)">FR</button>'
      + '<button onclick="toggleHelpLang(this.dataset.hl)" class="help-lang-btn" data-hl="de" style="padding:2px 7px;font-size:11px;border-radius:4px;border:1px solid var(--border);cursor:pointer;background:var(--bg3);color:var(--text)">DE</button>'
      + '<button onclick="toggleHelpLang(this.dataset.hl)" class="help-lang-btn" data-hl="es" style="padding:2px 7px;font-size:11px;border-radius:4px;border:1px solid var(--border);cursor:pointer;background:var(--bg3);color:var(--text)">ES</button>'
      + '<span style="width:1px;height:16px;background:var(--border);margin:0 3px"></span>'
      + '<button onclick="toggleHelpMaximize()" id="helpMaxBtn" title="最大化 / 还原" style="background:none;border:none;color:var(--text2);font-size:18px;cursor:pointer;padding:2px 8px">⛶</button>'
      + '<button onclick="closeHelp()" style="background:none;border:none;color:var(--text2);font-size:20px;cursor:pointer">✕</button>'
      + '</div></div>'
      + '<div id="helpBody" style="flex:1 1 0;min-height:0;overflow-y:scroll;padding:16px 24px;font-size:13.5px;line-height:1.8;color:var(--text2);pointer-events:auto"></div>'
      + '</div>';
    document.body.appendChild(modal);
    modal.addEventListener('click', function(ev){
      if(ev.target === modal) closeHelp();
    });
  }
  modal.style.display = 'flex';
  if(!helpContentLoaded){
    loadHelpContent();
    helpContentLoaded = true;
  }
}

function toggleHelpMaximize(){
  var box = document.getElementById('helpBox');
  if(!box) return;
  var body = document.getElementById('helpBody');
  var isMax = box.dataset.max === '1';
  if(isMax){
    box.style.width = '920px';
    box.style.height = 'calc(100vh - 60px)';
    box.style.borderRadius = '12px';
    if(body) body.style.padding = '16px 24px';
    box.dataset.max = '0';
    var b = document.getElementById('helpMaxBtn');
    if(b) b.textContent = '\u26F6';
  } else {
    box.style.width = '100vw';
    box.style.height = '100vh';
    box.style.borderRadius = '0';
    if(body) body.style.padding = '16px 40px';
    box.dataset.max = '1';
    var b = document.getElementById('helpMaxBtn');
    if(b) b.textContent = '\uD83D\uDDF5';
  }
}

function toggleHelpLang(lang){
  lang = lang || 'zh';
  var body = document.getElementById('helpBody');
  if(!body) return;
  var target = body.querySelector('[data-help-lang="' + lang + '"]');
  if(!target) lang = 'zh';
  document.querySelectorAll('#helpModal .help-lang-btn').forEach(function(b){
    var on = b.getAttribute('data-hl') === lang;
    b.style.background = on ? 'var(--bg3)' : '';
    b.style.color = on ? 'var(--cyan)' : 'var(--text3)';
    b.style.fontWeight = on ? '600' : '400';
    b.style.borderColor = on ? 'var(--cyan)' : 'var(--border)';
  });
  body.querySelectorAll('[data-help-lang]').forEach(function(el){
    el.style.display = (el.getAttribute('data-help-lang') === lang) ? '' : 'none';
  });
  try { localStorage.setItem('help_lang', lang); } catch(e){}
}
window.toggleHelpLang = toggleHelpLang;
window.toggleHelpMaximize = toggleHelpMaximize;

function closeHelp(){
  var modal = document.getElementById('helpModal');
  if(modal) modal.style.display = 'none';
}

// ------------------------------------------
// 更新日志 modal（从 /api/version 拉取）
// ------------------------------------------
function closeHelp(){
  var modal = document.getElementById('helpModal');
  if(modal) modal.style.display = 'none';
}

// ------------------------------------------
// 更新日志 modal（从 /api/version 拉取）
// ------------------------------------------
var changelogLoaded = false;
var changelogData = null;

function openChangelog(){
  var modal = document.getElementById('changelogModal');
  if(!modal){
    modal = document.createElement('div');
    modal.id = 'changelogModal';
    modal.style.cssText = 'display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.6);z-index:10000;justify-content:center;align-items:center';
    modal.innerHTML =
      '<div style="background:var(--bg2);border-radius:12px;width:820px;max-height:88vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,0.5);border:1px solid var(--border)">' +
      '<div style="padding:14px 20px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">' +
      '<span style="font-weight:600;font-size:16px" id="changelogModalTitle">📜 Fonriv 更新日志' + (window.RP_EDITION_CN_TXT ? ' · ' + window.RP_EDITION_CN_TXT : '') + '</span>' +
      '<button onclick="closeChangelog()" style="background:none;border:none;color:var(--text2);font-size:20px;cursor:pointer">✕</button></div>' +
      '<div id="changelogBody" style="padding:20px 28px;overflow-y:auto;flex:1;font-size:13px;line-height:1.7;color:var(--text2)">加载中...</div></div>';
    document.body.appendChild(modal);
    modal.onclick = function(ev){ if(ev.target === modal) closeChangelog(); };
  }
  modal.style.display = 'flex';
  if(!changelogLoaded){
    loadChangelog();
  } else if(changelogData){
    renderChangelog(changelogData);
  }
}

function closeChangelog(){
  var modal = document.getElementById('changelogModal');
  if(modal) modal.style.display = 'none';
}

function loadChangelog(){
  var body = document.getElementById('changelogBody');
  if(!body) return;
  fetch('/api/version').then(function(r){ return r.json(); }).then(function(data){
    changelogData = data;
    changelogLoaded = true;
    renderChangelog(data);
    // 顺便同步 badge
    var badge = document.getElementById('versionBadge');
    if(badge && data.version) badge.textContent = 'v' + data.version;
  }).catch(function(err){
    body.innerHTML = '<div style="color:var(--red);padding:12px">加载更新日志失败: ' + (err && err.message || err) + '</div>';
  });
}

function renderChangelog(data){
  var body = document.getElementById('changelogBody');
  if(!body) return;
  var cat_color = {
    '重构': 'var(--purple)', '功能': 'var(--cyan)', '修复': 'var(--yellow)',
    '优化': 'var(--green)', '初始': 'var(--text3)'
  };
  /* v5.98.4 · /api/version 只回最近 40 条(此前整份历史 949 KB 拖慢首屏与响应写出):
     这里如实标出"已显示最近 N 条/共 M 条", 并给一个『加载全部历史』按钮按页取全量。 */
  var _total = (data.changelog_total != null) ? data.changelog_total : (data.changelog||[]).length;
  var _shown = (data.changelog||[]).length;
  var html = '<div style="text-align:center;margin-bottom:24px">' +
    '<div style="font-size:28px;font-weight:700;color:var(--cyan);margin-bottom:4px">Fonriv v' + (data.version||'') + '</div>' +
    '<div style="color:var(--text3);font-size:12px">' +
      (data.changelog_truncated ? ('已显示最近 ' + _shown + ' 个版本 · 共 ' + _total + ' 个')
                                : ('共 ' + _total + ' 个版本历史')) +
      (data.changelog_truncated ? ' <a href="javascript:void(0)" id="changelogAllBtn" style="color:var(--cyan)">加载全部历史</a>' : '') +
    '</div>' +
    '</div>';
  (data.changelog || []).forEach(function(entry, i){
    var color = cat_color[entry.category] || 'var(--cyan)';
    html += '<div style="border-left:3px solid ' + color + ';padding:8px 14px;margin-bottom:16px;background:var(--bg);border-radius:0 8px 8px 0">' +
      '<div style="display:flex;align-items:baseline;gap:12px;margin-bottom:6px">' +
      '<span style="font-size:15px;font-weight:700;color:var(--text)">v' + entry.version + '</span>' +
      '<span style="font-size:11px;color:' + color + ';border:1px solid ' + color + ';border-radius:3px;padding:1px 6px">' + entry.category + '</span>' +
      '<span style="font-size:11px;color:var(--text3)">' + entry.date + '</span>' +
      '</div>' +
      '<div style="font-size:13px;color:var(--text);margin-bottom:6px">' + escapeHtml(entry.summary || '') + '</div>';
    if(entry.details && entry.details.length){
      html += '<ul style="margin:4px 0 0;padding-left:20px;font-size:12px;color:var(--text2)">';
      entry.details.forEach(function(d){
        html += '<li style="margin:2px 0">' + escapeHtml(d) + '</li>';
      });
      html += '</ul>';
    }
    html += '</div>';
  });
  body.innerHTML = html;
  var _all = document.getElementById('changelogAllBtn');
  if(_all){
    _all.onclick = function(){
      _all.textContent = '加载中…';
      fetch('/api/changelog?limit=5000').then(function(r){ return r.json(); }).then(function(d2){
        renderChangelog({version: data.version, changelog: d2.changelog || [],
                         changelog_total: d2.total, changelog_truncated: false});
      }).catch(function(err){
        _all.textContent = '加载失败, 点击重试';
        try { console.warn('changelog load fail', err); } catch(_){}
      });
    };
  }
}

function escapeHtml(s){
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ============================================
// LVM-thin 管理功能
// ============================================
var gLvmVolumes = [];
var gLvmVmVolumes = {};

// v3.4.4: LVM 面板 10 函数（testLvm / checkLvmPlugins / installLvmPlugin /
//         _rerenderLvmPluginsTable / scanLvm / renderLvmTable / filterLvmTable /
//         toggleLvmSelectAll / getSelectedLvmVolumes / exportLvm）迁移到 panels/lvm.js
function showDownloadJumpToast(localDir){
  if(!localDir) return;
  if(typeof toastOk === 'function'){
    toastOk('文件已保存至: '+localDir+' — 可切换到"本地下载"面板查看');
  }
  // 也放一个持久提示按钮（如果有全局 toast 系统）
  try {
    var wrap = document.getElementById('toastWrap') || document.querySelector('.toast-wrap');
    if(wrap){
      var t = document.createElement('div');
      t.className = 'toast toast-info';
      t.style.cursor = 'pointer';
      t.innerHTML = '💾 <b>点击前往本地下载</b><br><span style="font-size:11px;color:var(--text3)">'+localDir+'</span>';
      t.onclick = function(){
        if(typeof switchTab === 'function') switchTab('downloads');
        if(typeof dlOpenPath === 'function') dlOpenPath(localDir);
        t.remove();
      };
      wrap.appendChild(t);
      setTimeout(function(){ if(t.parentNode) t.remove(); }, 15000);
    }
  } catch(e){}
}

// ============================================
// PBS 备份管理
// ============================================
var gPbsStores = [];
var gPbsBackups = [];

// v3.4.7: PBS 面板 5 函数（testPbs / scanPbs / _showPbsDetail / renderPbsTable / usePbsStore）迁移到 panels/pbs.js

// v3.4.4: saveLvmConfig 迁移到 panels/lvm.js


// v3.4.7: savePbsConfig 迁移到 panels/pbs.js


// v3.4.5: saveZfsConfig 迁移到 panels/zfs.js


// v3.4.8: saveAbConfig 迁移到 panels/auto_backup.js


// v3.4.6: saveRbdConfig 迁移到 panels/rbd.js


function loadSavedConfigs(){
  try{
    var lvm=JSON.parse(localStorage.getItem('fonriv_lvm_config'));
    if(lvm){gv('lvmHost',lvm.host);gv('lvmPort',lvm.port);gv('lvmUser',lvm.user);
      if(lvm.auth_type)document.getElementById('lvmAuthType').value=lvm.auth_type;
      updateLvmAuthUI();
      var f=document.getElementById('lvmAuthField');
      if(f&&lvm.auth_type==='key'&&lvm.key_path){var inp=f.querySelector('input');inp.value=lvm.key_path;}
      if(lvm.local_dir)document.getElementById('lvmLocalDir').value=lvm.local_dir;}
    var pbs=JSON.parse(localStorage.getItem('fonriv_pbs_config'));
    if(pbs){gv('pbsHost',pbs.host);gv('pbsPort',pbs.port);gv('pbsUser',pbs.user);
      if(pbs.auth_type)document.getElementById('pbsAuthType').value=pbs.auth_type;
      updatePbsAuthUI();
      // v5.34.0: 密码不再从 localStorage 回填; 密钥路径仍回填 (非敏感)
      var f=document.getElementById('pbsAuthField');
      if(f&&pbs.auth_type==='key'&&pbs.key_path){var inp=f.querySelector('input');inp.value=pbs.key_path;}}
    var zfs=JSON.parse(localStorage.getItem('fonriv_zfs_config'));
    if(zfs){gv('zfsHost',zfs.host);gv('zfsPort',zfs.port);gv('zfsUser',zfs.user);
      if(zfs.auth_type)document.getElementById('zfsAuthType').value=zfs.auth_type;
      updateZfsAuthUI();
      var f=document.getElementById('zfsAuthField');
      if(f&&zfs.auth_type==='key'&&zfs.key_path){var inp=f.querySelector('input');inp.value=zfs.key_path;}
      if(zfs.local_dir)document.getElementById('zfsLocalDir').value=zfs.local_dir;
      if(zfs.mode)document.getElementById('zfsExportMode').value=zfs.mode;
      if(zfs.snapshot_tag)document.getElementById('zfsSnapshotTag').value=zfs.snapshot_tag;}
    var rbd=JSON.parse(localStorage.getItem('fonriv_rbd_config'));
    if(rbd){gv('rbdHost',rbd.host);gv('rbdPort',rbd.port);gv('rbdUser',rbd.user);
      if(rbd.auth_type)document.getElementById('rbdAuthType').value=rbd.auth_type;
      updateRbdAuthUI();
      var f=document.getElementById('rbdAuthField');
      if(f&&rbd.auth_value){var inp=f.querySelector('input');inp.value=rbd.auth_value;}
      if(rbd.pool)document.getElementById('rbdPool').value=rbd.pool;
      if(rbd.local_dir)document.getElementById('rbdLocalDir').value=rbd.local_dir;}
  }catch(e){console.warn('loadSavedConfigs error:',e);}
}







// v2.6.0/v2.6.2: PBS 连接模式（PVE vs 直连 PBS）UI 联动
// v3.4.7: PBS 面板 10 函数（updatePbsConnMode → togglePbsCheckAll）迁移到 panels/pbs.js


// ============================================
// ZFS 存储管理
// ============================================
var gZfsDatasets = [];

// v3.4.5: ZFS 面板 16 函数迁移到 panels/zfs.js


// ============================================
// Ceph RBD 管理
// ============================================
var gRbdImages = [];

// v3.4.6: RBD 面板 8 函数迁移到 panels/rbd.js


// ============================================
// 一键自动备份
// ============================================
// v3.4.8: Auto-backup 面板 15 函数迁移到 panels/auto_backup.js


// ============================================
// 操作日志加载
// ============================================
function loadOpLogs(){
  send({ action:'get_logs', limit:200 }, function(d){
    if(d.type === 'op_logs'){
      var el = document.getElementById('opLogArea');
      if(!el) return;
      var records = d.records || [];
      el.innerHTML = records.map(function(r){
        var content = r.content || '';
        var cls = 'log-line';
        if(content.indexOf('错误') > -1 || content.indexOf('fail') > -1 || content.indexOf('Error') > -1) cls += ' log-error';
        else if(content.indexOf('成功') > -1 || content.indexOf('耗时') > -1) cls += ' log-success';
        else if(content.indexOf('扫描') > -1) cls += ' log-info';
        return '<div class="'+cls+'"><span style="color:#888;font-size:11px">'+r.time+'</span> '+content+'</div>';
      }).join('');
      el.scrollTop = el.scrollHeight;
      var count = document.getElementById('opLogCount');
      if(count) count.textContent = '共 '+records.length+' 条记录';
    }
  });
}

function clearOpLogs(){
  send({ action:'clear_logs' }, function(d){
    addLog('操作日志已清除','success');
    loadOpLogs();
  });
}

function downloadOpLogs(){
  send({ action:'get_logs', limit:1000 }, function(d){
    if(d.type === 'op_logs'){
      var text = d.records.map(function(r){ return r.time+' | '+r.content; }).join('\n');
      var blob = new Blob([text], {type:'text/plain'});
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'fonriv_logs_'+new Date().toISOString().slice(0,10)+'.txt';
      a.click();
      URL.revokeObjectURL(a.href);
    }
  });
}


function loadHelpContent(){
  var body = document.getElementById('helpBody');
  if(!body) return;
  var html = (typeof helpHTML !== 'undefined') ? helpHTML : '';
  // v5.89.1 · 手册版本串动态化 (项目规范: 版本号禁止硬编码, 一律取 window.RP_VERSION)
  if(html) html = html.replace(/\{\{VER\}\}/g, window.RP_VERSION || '');
  if(!html){
    body.innerHTML = '<p style="color:var(--text3);padding:20px">本发行版不含使用手册；使用说明见随包 README 与官网 www.fonriv.com。</p>';
    return;
  }
  body.innerHTML = html;
  // v5.39.2 · TOC 跳转 (匹配 id= 属性)
  body.addEventListener('click', function(e){
    var a = e.target.closest('a[href^="#"]');
    if(!a) return;
    e.preventDefault();
    var id = a.getAttribute('href').substring(1);
    var target = document.getElementById(id);
    if(target) target.scrollIntoView({behavior:'smooth', block:'start'});
  });
  // 恢复上次语言
  try {
    var saved = localStorage.getItem('help_lang');
    toggleHelpLang(saved || 'zh');
  } catch(e){ toggleHelpLang('zh'); }
}

// ==================== 本地下载模块 ====================
// v2.8.0: 已抽出到 /static/downloads.js，避免 app.js 无止境膨胀
// 该文件在 index.html 里通过 <script src="/static/downloads.js"> 加载


// ============================================
// v2.6.10: rsync / sshpass 插件检测 & 安装（文件传输页）
// ============================================
function checkRsyncPlugins(){
  var host = gv('srvHost');
  if(!host){ toastWarn('请先填服务器主机地址'); return; }
  var info = document.getElementById('rsyncPluginsInfo');
  var box  = document.getElementById('rsyncPluginsBox');
  if(info) info.textContent = '检测中...';
  if(box)  box.innerHTML = '';
  var auth = getTransferAuth();
  send({ action:'check_rsync_plugins', host:host, port:gv('srvPort')||'22', user:gv('srvUser')||'root',
    auth_type:auth.auth_type, password:auth.password, key:auth.key, passphrase:auth.passphrase }, function(d){
    if(!d || d.type !== 'rsync_plugins_result'){ if(info) info.textContent = '检测失败'; return; }
    if(d.status !== 'ok'){
      if(info) info.innerHTML = '<span style="color:var(--red)">✗ '+(d.msg||'检测失败')+'</span>';
      return;
    }
    if(info) info.innerHTML = '系统: <b>'+(d.os||'unknown')+'</b> · 包管理器: <b>'+(d.pkg_manager||'apt')+'</b>'
      + (d.version ? ' · <span style="color:var(--text3)">'+d.version+'</span>' : '');
    var html = '<table style="width:100%;font-size:12px"><thead><tr style="background:var(--bg3)">'
      + '<th style="text-align:left;padding:4px 8px">插件</th><th style="text-align:left">说明</th>'
      + '<th style="text-align:center">状态</th><th style="text-align:right">操作</th></tr></thead><tbody>';
    (d.plugins || []).forEach(function(p, i){
      var status = p.installed
        ? '<span class="chip chip-green" style="font-size:10px">✓ 已安装</span>'
        : '<span class="chip chip-red" style="font-size:10px">✗ 未安装</span>';
      var action = p.installed
        ? '<span style="color:var(--text3);font-size:11px">—</span>'
        : '<button class="btn btn-sm btn-primary" onclick="installRsyncPlugin('+i+')">⬇ 一键安装</button>';
      html += '<tr><td style="padding:4px 8px;font-family:monospace">'+p.name+'</td>'
        + '<td style="color:var(--text2);font-size:11px">'+p.description+'</td>'
        + '<td style="text-align:center">'+status+'</td>'
        + '<td style="text-align:right">'+action+'</td></tr>';
    });
    html += '</tbody></table>';
    if(box) box.innerHTML = html;
    window._rsyncPlugins = d.plugins || [];
  });
}

/* v5.20.0 · 安装后复检 (带重试)。
 * 为什么需要: 安装刚结束时 apt 可能仍在收尾, 立刻复检会读到过时状态, 界面上
 * 表现为"装成功了却显示未安装"。这里最多重试 4 次 (2s 间隔), 并在最后一次
 * 明确提示"若仍显示未安装请手动点检测", 不把不确定状态伪装成失败。 */
function _recheckAfterInstall(name, attempt){
  setTimeout(function(){
    var box = document.getElementById('rsyncPluginsBox');
    var txt = box ? (box.innerText || '') : '';
    // 目标插件已显示"已安装"就算成功, 不再重试
    if (txt.indexOf('✗ 未安装') === -1) return;
    if (attempt >= 4){
      var info = document.getElementById('rsyncPluginsInfo');
      if (info && txt.indexOf('✗ 未安装') !== -1){
        info.innerHTML = '<span style="color:var(--orange)">⚠ '+name
          + ' 安装命令已执行, 但复检仍显示未安装 — 请点「🔍 检测」再看一次, '
          + '或登录目标机核对 dpkg 输出</span>';
      }
      return;
    }
    checkRsyncPlugins();
    _recheckAfterInstall(name, attempt + 1);
  }, 2000);
}

async function installRsyncPlugin(idx){
  var p = (window._rsyncPlugins || [])[idx];
  if(!p){ toastErr('插件信息丢失，请重新检测'); return; }
  if(!(await rpConfirm({ title:'远端安装插件', okText:'执行', body:'将在远端服务器执行：\n\n' + p.install_cmd + '\n\n继续？（需要 sudo 权限）' }))) return;
  var host = gv('srvHost');
  var auth = getTransferAuth();
  addLog('正在安装 '+p.name+' ...', 'info');
  addPanelLog('transfer', '⏳ 开始安装 '+p.name+' ('+p.install_cmd+')', 'info');
  toastOk('开始安装 '+p.name);
  send({ action:'install_rsync_plugin', host:host, port:gv('srvPort')||'22', user:gv('srvUser')||'root',
    auth_type:auth.auth_type, password:auth.password, key:auth.key, passphrase:auth.passphrase,
    install_cmd:p.install_cmd }, function(d){
    if(!d || d.type !== 'rsync_install_result'){ toastErr('安装响应异常'); return; }
    if(d.status === 'ok'){
      addLog('✅ '+p.name+' 安装成功', 'success');
      addPanelLog('transfer', '✅ '+p.name+' 安装成功', 'success');
      toastOk(p.name+' 安装成功');
      // 复检带重试: 安装后 apt 可能仍在收尾 (dpkg 触发器/服务启动), 此时立刻复检
      // 会拿到过时状态 —— 实测出现"刚装完却显示 rsync 与 sshpass 双双未安装",
      // 用户会以为失败而反复点。改为间隔重试, 直到状态改善或到上限。
      _recheckAfterInstall(p.name, 0);
    } else {
      addLog('❌ '+p.name+' 安装失败: '+d.msg, 'error');
      addPanelLog('transfer', '❌ '+p.name+' 安装失败: '+d.msg, 'error');
      toastErr(p.name+' 安装失败');
    }
  });
}


// ============================================
// v2.7.0: 主界面 IA 重构 · 顶部主组 + 主区二级 pill tabs
// ============================================
window.NAV_TREE = [
  { key: 'dashboard',  label: '📊 数据总览',    children: null, feat: 'dashboard' },
  { key: 'conn_center', label: '🔌 连接中心',   children: null, feat: 'connhub' },

  { key: 'files_g',   label: '📁 文件与传输', children: [
      { key: 'fonrvfs',      label: '🗂 多云文件管理', feat: 'fonrvfs' },
      { key: 'vdisk_cloud', label: '💠 多云虚拟存储池', feat: 'fonrvfs' },   // v5.98.19 · P1 统一虚拟根
      { key: 'transfer',     label: '📂 文件传输', feat: 'rsync' },
      { key: 'file_preview', label: '👁 文件预览',     feat: 'rsync' },
  ]},

  { key: 'storage_g', label: '☁️ 云存储与容器', children: [
      { key: 'shares',       label: '🌐 网络共享',     feat: 'share' },
      { key: 'disk_manager', label: '💽 远端磁盘管理', feat: 'disk' },
      { key: 'remotes',      label: '☁️ 远端存储',     feat: 'cloud' },
      { key: 'truenas',      label: '🗄 TrueNAS 控制面板', feat: 'cloud' },
      { key: 'docker',       label: '📦 容器管理',     feat: 'docker' },
      { key: 'cloudpool',    label: '🧩 存储池', feat: 'cloudpool' },   // v5.99.2 · CloudPool V2
  ]},

  /* v6.5.0 · 批6(用户要求): 分享管理独立主菜单(放「云存储与容器」后), 三个二级页 ——
     局域网(SMB/NFS) / HTTP 链接 / SMB 账号与文件权限(OMV 式: 账号是跨共享资源, 单列一页)。 */
  { key: 'share_g', label: '🔗 分享管理', children: [
      { key: 'share_lan',    label: '🖥 局域网文件分享', feat: 'share_mgmt' },
      { key: 'share_http',   label: '🌐 HTTP 链接分享', feat: 'share_mgmt' },
      { key: 'share_access', label: '🔐 SMB 账号与权限', feat: 'share_mgmt' },
  ]},

  { key: 'remote_ops', label: '🖥 远程运维', children: [
      { key: 'rdp_console',  label: '🖥 远程桌面 (RDP)', feat: 'rdp' },   // v5.83.0: 归商业键(社区版不再出现)
      { key: 'vnc_direct',   label: '🖥 VNC 直链 (Linux)', feat: 'rsync' },
      { key: 'pve_console',  label: '🦠 PVE 虚拟控制台',   feat: 'pve_console' },  // v6.16.2 批20: 独立键(pro), 社区版隐藏
      { key: 'terminal',     label: '⌨ Web 终端 (SSH)',  feat: 'terminal' },
  ]},

  { key: 'backup_g',   label: '🗄 备份中心', children: [
      { key: 'backup_center',   label: '🗄 备份总览',      feat: null },
      { key: 'disk_image',      label: '💽 磁盘镜像备份',  feat: 'disk' },  // v6.16.2 批18: 挂 disk 键(企业档), 社区版不再出现
      { key: 'proxmox',         label: '🖥 PVE 节点连接',  feat: 'pve' },
      { key: 'vzdump',          label: '📦 vzdump 打包',   feat: 'vzdump' },
      { key: 'pbs',             label: '📦 PBS 备份',      feat: 'pbs' },
      { key: 'auto_backup',     label: '🔧 PVE 配置备份',  feat: 'pve' },
      { key: 'platform_backup', label: '🐧 通用配置备份',  feat: 'pve' },
      { key: 'lvm',             label: '💽 LVM',           feat: 'lvm' },
      { key: 'zfs',             label: '🗄 ZFS',           feat: 'zfs' },
      { key: 'rbd',             label: '🌐 Ceph RBD',      feat: 'rbd' },
      { key: 'restic',          label: '🗄 restic 去重备份', feat: 'restic' },
      { key: 'dbbackup',        label: '🗄 数据库备份',    feat: 'dbbackup' },
      { key: 'k8s_backup',      label: '📦 K8s/容器备份',  feat: 'k8s_backup' },
  ]},

  { key: 'auto_g',    label: '🔧 自动化', children: [
      { key: 'flows',         label: '🔗 跨模块流程', feat: 'flow' },
      { key: 'ai_assistant',  label: '🤖 AI 助手',    feat: 'ai' },
      { key: 'schedules',     label: '⏰ 定时计划',   feat: 'schedule' },
      { key: 'jobs',          label: '⏱ 任务队列' },
      { key: 'log',           label: '📋 传输日志' },
      { key: 'runlog',        label: '📜 统一日志' },
  ]},

  { key: 'system_g',  label: '👥 系统', children: [
      { key: 'core_status', label: '💠 核心运行状况', feat: null, hideEditions: ['community'] },   // v5.83.0: 社区版不提供
      { key: 'settings',    label: '⚙ 系统设置',     feat: null },
      { key: 'personalize', label: '🎨 个性化',       feat: null },
      { key: 'license',     label: '🔓 授权与许可',   feat: null },
      { key: 'users',       label: '👥 用户管理',     feat: null },
      { key: 'security',    label: '🛡 安全中心',     feat: null },
      { key: 'sysconf',     label: '💾 系统配置备份', feat: null },
      { key: 'airgap',      label: '✈ Air-Gap 摆渡', feat: 'airgap' },  // v6.16.2 批18: 挂独立键(企业档), 社区版不再出现
      { key: 'downloads',   label: '💾 本地下载',     feat: null },
  ]},
];
// 反向索引 子tab key -> 父组 key
window.NAV_PARENT = {};
// v5.40.0 · 自动构建: 遍历 NAV_TREE 填充 NAV_PARENT
(function(){
  window.NAV_TREE.forEach(function(g){
    if (g.children) g.children.forEach(function(c){ window.NAV_PARENT[c.key] = g.key; });
    else window.NAV_PARENT[g.key] = g.key;
  });
})();

// v5.23.0 · 顶部导航自愈: NAV_TREE 里的一级组若在 #mainTabs 没有按钮 (浏览器缓存了
//   旧版 index.html 时会发生), 动态补齐。插到「关于」按钮之前; 权限/授权显隐仍由 applyPermissions 统一处理。
(function(){
  function _ensureNavButtons(){
    var tabs = document.getElementById('mainTabs');
    if (!tabs) return;
    var aboutBtn = Array.from(tabs.querySelectorAll('button')).find(function(b){ return (b.textContent||'').indexOf('关于') >= 0; });
    (window.NAV_TREE || []).forEach(function(g){
      if (!tabs.querySelector('button[data-group="' + g.key + '"]')){
        var b = document.createElement('button');
        b.className = 'tab';
        b.dataset.group = g.key;
        b.setAttribute('onclick', "switchGroup('" + g.key + "')");
        b.textContent = g.label || g.key;
        if (aboutBtn) tabs.insertBefore(b, aboutBtn); else tabs.appendChild(b);
      }
    });
  }
  if (document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', _ensureNavButtons);
  } else {
    _ensureNavButtons();
  }
  window._ensureNavButtons = _ensureNavButtons;
})();

// v4.15.5 · 全站编辑脏检查：改用三按钮 modal · prompt→confirm 太反人类
function _showDirtyModal(onSave, onDiscard, onCancel){
  var old = document.getElementById('_dirtyModal');
  if (old) old.remove();
  var m = document.createElement('div');
  m.id = '_dirtyModal';
  m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:10001;display:flex;align-items:center;justify-content:center';
  m.innerHTML =
    '<div style="background:var(--bg2);border:1px solid var(--border);border-radius:10px;min-width:360px;max-width:90vw;padding:22px 24px;box-shadow:0 20px 60px rgba(0,0,0,0.5)">'
    + '<div style="font-size:16px;font-weight:600;margin-bottom:10px">⚠️ 当前编辑未保存</div>'
    + '<div style="color:var(--text2);font-size:13px;margin-bottom:20px">请问要保存刚才的修改，还是丢弃后继续切换？</div>'
    + '<div style="display:flex;gap:8px;justify-content:flex-end">'
    +   '<button class="btn" id="_dirtyBtnCancel">取消</button>'
    +   '<button class="btn" id="_dirtyBtnDiscard" style="background:var(--red,#e74c3c);color:#fff">丢弃</button>'
    +   '<button class="btn btn-primary" id="_dirtyBtnSave">💾 保存</button>'
    + '</div></div>';
  document.body.appendChild(m);
  function close(){ m.remove(); }
  document.getElementById('_dirtyBtnSave').onclick    = function(){ close(); try{onSave&&onSave();}catch(e){console.warn(e);} };
  document.getElementById('_dirtyBtnDiscard').onclick = function(){ close(); try{onDiscard&&onDiscard();}catch(e){console.warn(e);} };
  document.getElementById('_dirtyBtnCancel').onclick  = function(){ close(); try{onCancel&&onCancel();}catch(e){console.warn(e);} };
  m.onclick = function(ev){ if(ev.target===m){ close(); try{onCancel&&onCancel();}catch(e){} } };
}

function _dirtyGuardOK(nextKey){
  try {
    // v5.84.0 · 用户要求: 服务器连接已统一在「连接中心」保存 → 文件管理/服务器表单不再弹
    //   "当前编辑未保存, 保存还是丢弃?" (所有版本)。Remotes/Sched/Tasks 的脏检查保留。
    var mods = [window.Remotes, window.Sched, window.Tasks];
    for (var i=0; i<mods.length; i++){
      var m = mods[i];
      if (m && typeof m.isDirty === 'function' && m.isDirty()){
        // 有脏数据：先阻塞本次切换，弹 modal，用户点了动作后再重新触发
        _showDirtyModal(
          function(){ // 保存
            if (typeof m.save === 'function'){
              try {
                var p = m.save();
                if (p && typeof p.then === 'function'){
                  p.then(function(){ _resumeNav(nextKey); },
                         function(e){ console.warn('save fail:', e); });
                  return;
                }
              } catch(e){ console.warn(e); }
            }
            _resumeNav(nextKey);
          },
          function(){ // 丢弃
            if (typeof m.cancelEdit === 'function'){
              try { m.cancelEdit(); } catch(e){ console.warn(e); }
            }
            _resumeNav(nextKey);
          },
          null // 取消 -> 什么都不做，保持在原页
        );
        return false;
      }
    }
  } catch(e){ console.warn('dirtyGuard err', e); }
  return true;
}

// 用户在脏检查 modal 里点了『保存 / 丢弃』之后，触发继续切换
function _resumeNav(nextKey){
  if (!nextKey) return;
  try {
    // 判定 nextKey 是主组还是子 tab
    var isGroup = (window.NAV_TREE || []).some(function(g){ return g.key === nextKey; });
    if (isGroup && typeof switchGroup === 'function') switchGroup(nextKey);
    else if (typeof switchTab === 'function') switchTab(nextKey);
  } catch(e){ console.warn('resumeNav err', e); }
}

// v4.75.0 · 居中布局由 CSS (.sub-tabs-pills) 承担, 保留空函数兼容 resize 调用
function _anchorSubBar(groupKey){}

function switchGroup(groupKey){
  // v4.13.4 · 编辑脏检查：切走前问一下
  if (!_dirtyGuardOK(groupKey)) return;
  // v6.3.5 · 主组切换(数据总览等)同样刷新共享真实挂载态(10s 节流)
  try { if (window.rpRefreshShares) window.rpRefreshShares(); } catch(e){}
  var group = window.NAV_TREE.find(function(g){ return g.key === groupKey; });
  if(!group){ console.warn('unknown group', groupKey); return; }
  // v4.15.31 · 性能优化：同一 group 二次点击直接跳过 subBar 重建，只切到记忆子项
  //   subBar 用 data-group 缓存判断，无需 innerHTML 重建
  var subBar = document.getElementById('subTabs');
  var _cachedGroup = subBar && subBar.dataset ? subBar.dataset.group : null;
  var _sameGroup = (_cachedGroup === groupKey);
  // 权限过滤子项（非 admin）· v4.44.1 加 license 白名单过滤
  var isAdmin = (window.currentUser && window.currentUser.role === 'admin');
  var perms = (window.currentUser && Array.isArray(window.currentUser.permissions))
              ? window.currentUser.permissions : null;
  // v5.85.0 · 统一走 navChildVisible(单一真源), 不再各自实现一遍过滤
  var visibleChildren = group.children ? group.children.filter(navChildVisible) : null;
  // 高亮主按钮（仅在 group 变化时刷 · 减少 forEach 开销）
  window._currentParentGroup = groupKey;
  // v5.85.5 · 子菜单条会被重建 → 组名留左/条目右移的内缩每次都要重算
  if (typeof window.__applyPaneInsets === 'function') window.__applyPaneInsets();   // v5.90.6 · 同步重算, 消除先左对齐再跳右的闪烁
  if (!_sameGroup){
    document.querySelectorAll('.main-tabs .tab').forEach(function(b){
      b.classList.toggle('active', b.dataset && b.dataset.group === groupKey);
    });
  }
  // v5.81.8 · 改组在当前版位下**没有可用子项**(如社区版点云存储与容器): 隐藏子菜单条,
  //   否则会把上一个组的子项残留显示在这里(实测在社区版出现)
  if(group.children && visibleChildren && visibleChildren.length === 0){
    if(subBar){ subBar.style.display = 'none'; subBar.dataset.group = ''; }
    return;
  }
  // 无子项组 → 直连 panel
  if(!group.children){
    if(subBar){ subBar.style.display = 'none'; subBar.dataset.group = ''; }
    switchTab(groupKey);
    return;
  }
  // 有子项但无权限可见项：提示无权访问
  if(visibleChildren.length === 0){
    if(subBar) subBar.style.display = 'none';
    if(typeof toastErr === 'function') toastErr('该分组内无可访问项');
    return;
  }
  // v4.15.31 · 只有新 group 才重建 subBar innerHTML；同 group 只切子项
  if (subBar && !_sameGroup){
    subBar.style.display = 'flex';
    var pillsHtml = visibleChildren.map(function(c){
      return '<button class="sub-tab" data-sub="'+c.key+'" onclick="switchTab(\''+c.key+'\')">'+c.label+'</button>';
    }).join('');
    // v4.72.0 · 二级菜单标签改为「组名」(原「二级菜单」无信息量)
    var groupLabel = (group.label || '').replace(/▾\s*$/, '').trim();
    // v4.75.0 · 三段式: 左标签 | pill 行(flex:1 居中+自动换行) | 右收起钮
    subBar.innerHTML =
        '<span class="sub-tabs-label" title="当前分组">'+ groupLabel +'</span>'
      + '<span class="sub-tabs-sep">▸</span>'
      + '<span class="sub-tabs-pills">'+ pillsHtml +'</span>'
      + '<span class="sub-tabs-toggle" onclick="toggleSubTabs()" title="折叠/展开二级菜单">'
      +   '<span class="arrow">▼</span><span class="sub-tabs-toggle-text">收起</span>'
      + '</span>';
    subBar.dataset.group = groupKey;
    /* v6.11.0 · 批11(用户要求): **整条二级菜单空白区**都可单击折叠/展开 ——
       点一下隐藏, 再点一下展开。仅排除交互元素本身(页签/收起钮/链接/输入类),
       否则会抢走正常点击。委托绑定一次(重建 innerHTML 不影响)。 */
    if (!subBar.__foldAnyBound){
      subBar.__foldAnyBound = true;
      subBar.addEventListener('click', function(ev){
        var t = ev.target;
        if (t && t.closest && t.closest('.sub-tab, .sub-tabs-toggle, button, a, input, select, textarea, label')) return;
        toggleSubTabs();
      });
      subBar.title = '单击空白处折叠 / 再点一下展开二级菜单';
    }
  // v5.90.9 · 「视图」下拉已移入多云文件管理左树头部(#fonrTreeModeSel, 与连接中心同位置) — pills 注入取消
  //   (此前注入在 pills 尾部且初值不回填, 下拉显示"按分组"而实际模式是"按类型", 切了也没反应)

    // v5.90.10 · 消除"先向左跳再回位": 新 pills 元素裸渲染(margin 空 → 贴最左)一帧后才被
    //   异步回调补 margin。修复: ① 重建时先继承上一次的内缩值作初值; ② innerHTML 之后**同一次
    //   同步任务里**立即重算(此前 applyPaneInsets 在重建之前调用, 对新元素无效)。
    var _newPills = subBar.querySelector('.sub-tabs-pills');
    if (_newPills && window.__fonrSubbarML) _newPills.style.marginLeft = window.__fonrSubbarML;
    if (typeof window.__applyPaneInsets === 'function') window.__applyPaneInsets();

    // 恢复上次折叠状态
    try {
      if(localStorage.getItem('subTabsCollapsed') === '1'){
        subBar.classList.add('collapsed');
        var t = subBar.querySelector('.sub-tabs-toggle-text');
        if(t) t.textContent = '展开';
      }
    } catch(e){}
  } else if (subBar){
    subBar.style.display = 'flex';
  }
  // 打开子组第一个（或记住上次的）
  var last = null;
  try { last = localStorage.getItem('lastSub_' + groupKey); } catch(e){}
  var validLast = visibleChildren.some(function(c){ return c.key === last; }) ? last : null;
  var target = validLast || visibleChildren[0].key;
  switchTab(target);
}

// v2.8.0: 折叠/展开二级菜单
function toggleSubTabs(){
  var bar = document.getElementById('subTabs');
  if(!bar) return;
  bar.classList.toggle('collapsed');
  var collapsed = bar.classList.contains('collapsed');
  try { localStorage.setItem('subTabsCollapsed', collapsed ? '1' : '0'); } catch(e){}
  var t = bar.querySelector('.sub-tabs-toggle-text');
  if(t) t.textContent = collapsed ? '展开' : '收起';
}

// v4.44.1 · license 白名单变化后重算当前 subBar 子项可见性 (applyPermissions 回调)
function __applyLicenseSubTabs(){
  var subBar = document.getElementById('subTabs');
  if(!subBar || !subBar.dataset || !subBar.dataset.group) return;
  var group = (window.NAV_TREE || []).find(function(g){ return g.key === subBar.dataset.group; });
  if(!group || !group.children) return;
  subBar.querySelectorAll('.sub-tab').forEach(function(btn){
    var ck = btn.dataset.sub;
    var child = group.children.find(function(c){ return c.key === ck; });
    if(!child) return;
    // v5.85.0 · 与 switchGroup/下拉 共用同一判定
    if(!navChildVisible(child)) btn.style.display = 'none';
  });
}

// v5.83.0 · 声明式档位隐藏: 带 data-hide-editions="community,pro" 的元素在对应档位隐藏(如安全中心的
//   部分区块、系统设置里的任务注册表、侧栏自定义快捷操作在新版社区版不提供)
function applyEditionHides(){
  var edn = window.__licFeatEdition || 'community';
  document.querySelectorAll('[data-hide-editions]').forEach(function(el){
    var list = (el.getAttribute('data-hide-editions') || '').split(',').map(function(s){ return s.trim(); });
    el.style.display = (list.indexOf(edn) >= 0) ? 'none' : '';
  });
}
window.applyEditionHides = applyEditionHides;
window.__applyLicenseSubTabs = __applyLicenseSubTabs;

// 覆写 switchTab：同步主组高亮 + sub-tab 高亮 + 记忆
(function(){
  var _orig = window.switchTab;
  if(!_orig){ console.error('switchTab not defined before nav override'); return; }
  // v4.15.31 · 缓存 tab / sub-tab 节点，避免每次切页都 querySelectorAll
  var _tabsCache = null, _subCache = null, _lastParentG = null, _lastTabKey = null;
  function getTabs(){
    if (!_tabsCache || !_tabsCache.length){
      _tabsCache = document.querySelectorAll('.main-tabs .tab');
    }
    return _tabsCache;
  }
  window.switchTab = function(tabKey){
    // v4.13.4 · 脏检查（子项切换也拦一下）
    if (!_dirtyGuardOK(tabKey)) return;
    _orig(tabKey);
    var parentG = window.NAV_PARENT[tabKey] || tabKey;
    // 主 tab 高亮：仅在父组变化时刷
    if (parentG !== _lastParentG){
      getTabs().forEach(function(b){
        if(b.dataset) b.classList.toggle('active', b.dataset.group === parentG);
      });
      _lastParentG = parentG;
    } else {
      // v4.71.0 · 兜底: 原 switchTab 会清掉 .topbar .tab 的 active(含主菜单),
      //   而父组未变时上面的分支被跳过 → 主菜单高亮丢失(卡片跳转场景必现)。
      //   此处检测并在缺失时补回。
      var _actMain = document.querySelector('.main-tabs .tab.active');
      if (!_actMain || (_actMain.dataset && _actMain.dataset.group !== parentG)){
        getTabs().forEach(function(b){
          if(b.dataset) b.classList.toggle('active', b.dataset.group === parentG);
        });
        _lastParentG = parentG;
      }
    }
    // sub-tab 高亮：仅在 tabKey 变化时刷（每次都是当前 subBar 里的 sub-tab，随 subBar 重建失效重查）
    if (tabKey !== _lastTabKey){
      if (!_subCache || !_subCache.length || !document.contains(_subCache[0])){
        _subCache = document.querySelectorAll('#subTabs .sub-tab');
      }
      _subCache.forEach(function(b){
        b.classList.toggle('active', b.dataset && b.dataset.sub === tabKey);
      });
      _lastTabKey = tabKey;
    }
    // 记住父组当前子项，避免二次点主组重置
    if(window.NAV_PARENT[tabKey]){
      try { localStorage.setItem('lastSub_' + window.NAV_PARENT[tabKey], tabKey); } catch(e){}
    }
    // 若切到无子项组（如 transfer），隐藏 sub bar
    var g = window.NAV_TREE.find(function(x){ return x.key === parentG; });
    var subBar = document.getElementById('subTabs');
    if(subBar){
      if(g && !g.children){ subBar.style.display = 'none'; }
      else if(g && g.children){ subBar.style.display = 'flex'; }
    }
  };
})();

// 页面加载后：如果 activeTab 记忆的是子项，展开对应父组
// v4.72.0 · 窗口尺寸变化 / 侧栏宽度调整后重新锚定二级菜单
window.addEventListener('resize', function(){
  try { _anchorSubBar(window._currentParentGroup || ''); } catch(e){}
});
// 记录当前主组供 resize 使用
document.addEventListener('DOMContentLoaded', function(){ window._currentParentGroup = window._currentParentGroup || ''; });

document.addEventListener('DOMContentLoaded', function(){
  var t = null;
  try { t = localStorage.getItem('activeTab'); } catch(e){}
  if(!t) return;
  var parentG = window.NAV_PARENT[t];
  if(parentG){
    // 延迟执行以确保 currentUser & applyPermissions 已就绪
    setTimeout(function(){ switchGroup(parentG); }, 100);
  }
});


// ============================================
// v2.9.0: 定时计划（真实调度）
// ============================================
function _cronExprForKind(kind){
  return document.getElementById(kind === 'pve' ? 'pveSchedCron' : 'vdSchedCron').value.trim();
}

function previewCron(cronId, targetId){
  var expr = document.getElementById(cronId).value.trim();
  var out  = document.getElementById(targetId);
  if(!expr){ if(out) out.textContent = '请先填 cron 表达式'; return; }
  // 简单本地正则校验（5 字段）
  var parts = expr.split(/\s+/);
  if(parts.length !== 5){
    if(out) out.innerHTML = '<span style="color:var(--red)">✗ cron 表达式必须是 5 个字段（分 时 日 月 周）</span>';
    return;
  }
  // 用后端算下次执行（服务端有 croniter）
  send({ action:'schedule_create', name:'__preview__', cron_expr:expr, action_type:'noop' }, function(m){
    // 我们不真建，用 create + delete；但为了简单，直接靠 list 的 next_run 展示
    // → 更简单：只前端展示"cron 表达式合法，请保存后在下方列表看下次触发时间"
  });
  // 简单静态提示（避免打扰后端）
  if(out) out.innerHTML = '<span style="color:var(--green)">✓ Cron 表达式合法（5 字段）· 保存后在下方列表可看到下次触发时间</span>';
}

async function saveScheduledTask(kind){
  var name, cron, action, params;
  // v2.9.1: 找到当前激活的 config 并把其 db_id 塞给 scheduler → 后端派发时从 DB 补齐完整字段
  var active = (configs || []).find(function(c){ return c._active; });
  var configId = active && active.db_id;
  var configName = active && active.name;

  if(kind === 'pve'){
    name = gv('pveSchedName').trim();
    cron = gv('pveSchedCron').trim();
    action = 'pve_backup_scheduled';
    params = {
      source: 'pve',
      config_id: configId,
      config_name: configName,
      // 手动填一些常用参数（前端 PVE 页面若有选择的 vm_ids 可以塞入，这里先留空由 handler 默认）
      vm_ids: 'all',
      dest: gv('backupDst') || '/mnt/backup/proxmox/'
    };
  } else if(kind === 'vzdump'){
    name = gv('vdSchedName').trim();
    cron = gv('vdSchedCron').trim();
    action = 'vzdump_scheduled';
    params = {
      source: 'vzdump',
      config_id: configId,
      config_name: configName,
      vmids: gv('vdSchedVmids') || 'all',
      retain: gv('vdSchedRetain') || '5',
      mode: gv('vdSchedMode') || 'local',
      tmp_dir: gv('vdTmpDir') || '/var/lib/vz/dump/',
      local_dir: gv('vdLocalDir') || '/mnt/backup/vzdump/'
    };
  } else {
    alert('未知计划类型: ' + kind); return;
  }
  if(!name){ alert('请填任务名称'); return; }
  if(!cron){ alert('请填 cron 表达式'); return; }
  if(!configId && !configName){
    if(!(await rpConfirm({ title:'未关联连接配置', okText:'继续保存', body:'当前无激活的左侧「连接配置」，定时任务将无法自动填充服务器信息。\n继续保存吗？（后续可编辑）' }))) return;
  }
  send({ action:'schedule_create', name:name, cron_expr:cron, action_type:action, params:params }, function(m){
    if(m && m.status === 'ok'){
      addLog('✅ 定时任务已保存: '+name+' · cron: '+cron+' · id='+m.id+' · 关联配置: '+(configName||'无'), 'success');
      if(typeof toastOk === 'function') toastOk('定时任务已保存 (id='+m.id+')');
      loadSchedList(kind);
    } else {
      addLog('❌ 保存定时任务失败: '+(m && m.msg || '未知错误'), 'error');
      alert('保存失败: '+(m && m.msg || '未知'));
    }
  });
}

function loadSchedList(kind){
  send({ action:'schedule_list' }, function(m){
    if(!m || m.status !== 'ok') return;
    var listId = kind === 'pve' ? 'pveSchedList' : 'vdSchedList';
    var box = document.getElementById(listId);
    if(!box) return;
    var filter = kind === 'pve' ? 'pve_backup_scheduled' : 'vzdump_scheduled';
    var rows = (m.schedules || []).filter(function(s){ return s.action === filter; });
    if(!rows.length){
      box.innerHTML = '<div style="color:var(--text3);font-size:12px;padding:10px">尚无已保存的定时任务</div>';
      return;
    }
    box.innerHTML = '<h4 style="margin:8px 0;font-size:13px">已保存的定时任务</h4>'
      + '<table style="width:100%;font-size:12px;border-collapse:collapse">'
      + '<thead><tr style="background:var(--bg3)"><th style="padding:6px;text-align:left">#</th><th style="padding:6px;text-align:left">名称</th><th style="padding:6px">Cron</th><th style="padding:6px">下次执行</th><th style="padding:6px">最近</th><th style="padding:6px">状态</th><th style="padding:6px">操作</th></tr></thead><tbody>'
      + rows.map(function(s){
          var status = s.last_status === 'ok' ? '<span style="color:var(--green)">✓ ok</span>'
                     : s.last_status === 'error' ? '<span style="color:var(--red)">✗ 失败</span>'
                     : '<span style="color:var(--text3)">未运行</span>';
          var enBadge = s.enabled ? '<span class="chip chip-green" style="font-size:10px">启用</span>' : '<span class="chip chip-red" style="font-size:10px">禁用</span>';
          return '<tr style="border-bottom:1px solid var(--border)">'
            + '<td style="padding:6px">'+s.id+'</td>'
            + '<td style="padding:6px">'+escapeHtml(s.name)+' '+enBadge+'</td>'
            + '<td style="padding:6px;font-family:monospace">'+escapeHtml(s.cron_expr)+'</td>'
            + '<td style="padding:6px;color:var(--cyan)">'+(s.next_run||'-')+'</td>'
            + '<td style="padding:6px;color:var(--text3);font-size:11px">'+(s.last_run||'从未')+'</td>'
            + '<td style="padding:6px">'+status+'</td>'
            + '<td style="padding:6px">'
            +   '<button class="btn btn-sm" onclick="runSchedNow('+s.id+',\''+kind+'\')" title="立即执行一次">▶</button> '
            +   '<button class="btn btn-sm" onclick="toggleSched('+s.id+','+(s.enabled?0:1)+',\''+kind+'\')" title="启用/禁用">'+(s.enabled?'⏸':'▶')+'</button> '
            +   '<button class="btn btn-sm btn-danger" onclick="deleteSched('+s.id+',\''+kind+'\')">🗑</button>'
            + '</td>'
            + '</tr>';
        }).join('')
      + '</tbody></table>';
  });
}

function escapeHtml(s){ return String(s||'').replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }

async function runSchedNow(id, kind){
  if(!(await rpConfirm({ title:'立即执行定时任务 #'+id, okText:'立即执行' }))) return;
  send({ action:'schedule_run_now', id:id }, function(m){
    if(m && m.status === 'ok'){
      addLog('▶ 已派发定时任务 #'+id, 'info');
      if(typeof toastOk === 'function') toastOk('已派发');
      setTimeout(function(){ loadSchedList(kind); }, 1200);
    } else {
      addLog('派发失败: '+(m && m.msg || ''), 'error');
    }
  });
}

function toggleSched(id, enable, kind){
  send({ action:'schedule_update', id:id, enabled:enable ? 1 : 0 }, function(m){
    if(m && m.status === 'ok'){
      addLog('定时任务 #'+id+' '+(enable?'已启用':'已禁用'), 'info');
      loadSchedList(kind);
    }
  });
}

async function deleteSched(id, kind){
  if(!(await rpConfirm({ title:'删除定时任务 #'+id, danger:true, okText:'删除', body:'确认删除定时任务 #'+id+'？此操作不可撤销' }))) return;
  send({ action:'schedule_delete', id:id }, function(m){
    if(m && m.status === 'ok'){
      addLog('🗑 定时任务 #'+id+' 已删除', 'warn');
      loadSchedList(kind);
    }
  });
}

// 切到 pve/vzdump schedule tab 时自动刷列表
(function(){
  var origSwitchPve = window.switchPveTab;
  if(typeof origSwitchPve === 'function'){
    window.switchPveTab = function(t, el){
      origSwitchPve(t, el);
      if(t === 'schedule') setTimeout(function(){ loadSchedList('pve'); }, 100);
    };
  }
  var origSwitchVd = window.switchVzdumpTab;
  if(typeof origSwitchVd === 'function'){
    window.switchVzdumpTab = function(t, el){
      origSwitchVd(t, el);
      if(t === 'schedule') setTimeout(function(){ loadSchedList('vzdump'); }, 100);
    };
  }
})();


// v2.9.3: 「另存为副本」—— 当前面板配置作为新配置保存，名称自动加当前面板后缀



window.saveAsCopyForCurrentPanel = saveAsCopyForCurrentPanel;


// ============================================
// v2.9.4: 诊断 + 一键清空
// ============================================



window.diagnoseConfigs = diagnoseConfigs;
window.clearAllConfigs = clearAllConfigs;


// v2.9.6: 新建配置模式视觉引导
function enterNewConfigMode(cfg){
  try {
    document.body.classList.add('new-config-mode');
    // 每个 panel 顶部插入或更新 banner
    var idText = cfg.db_id != null ? ('#' + cfg.db_id)
                                    : (cfg._pending_db ? '#等待分配...' : '#未同步');
    var bannerHtml = '📝 <b>新建模式</b>：正在为配置 [<b>'+ escHtml(cfg.name) +'</b>] ('+idText+') 填写信息。' +
                     '<span style="color:var(--text3)">填完后点击底部绿色的「💾 保存配置」按钮完成新建。</span>';
    document.querySelectorAll('.panel').forEach(function(panel){
      var b = panel.querySelector('#newConfigBanner');
      if(!b){
        b = document.createElement('div');
        b.id = 'newConfigBanner';
        panel.insertBefore(b, panel.firstChild);
      }
      b.innerHTML = bannerHtml;
    });
  } catch(e){ console.warn('enterNewConfigMode failed:', e); }
}

function clearNewConfigMode(){
  document.body.classList.remove('new-config-mode');
}

// v4.38.24 · panel-disk_manager 内的服务器连接配置 form (id 后缀 _dm) 走包装函数
// 做法：把 _dm form 的值复制到 panel-transfer 内的主 form,再调原函数；反之亦然
function _dmCopyToMain(){
  var pairs = [
    ['srvHost_dm','srvHost'],['srvPort_dm','srvPort'],['srvUser_dm','srvUser'],
    ['authType_dm','authType'],['authValue_dm','authValue'],['transferRemember_dm','transferRemember'],
  ];
  pairs.forEach(function(p){
    var a = document.getElementById(p[0]);
    var b = document.getElementById(p[1]);
    if(a && b){
      if(a.type === 'checkbox') b.checked = a.checked;
      else b.value = a.value;
    }
  });
}
function _dmCopyFromMain(){
  var pairs = [
    ['srvHost','srvHost_dm'],['srvPort','srvPort_dm'],['srvUser','srvUser_dm'],
    ['authType','authType_dm'],['authValue','authValue_dm'],['transferRemember','transferRemember_dm'],
  ];
  pairs.forEach(function(p){
    var a = document.getElementById(p[0]);
    var b = document.getElementById(p[1]);
    if(a && b){
      if(a.type === 'checkbox') b.checked = a.checked;
      else b.value = a.value;
    }
  });
  if(typeof updateAuthUI_dm === 'function') updateAuthUI_dm();
}
// 当 disk_manager 切换到激活面板时,从主 form 同步最新值
function _dmRefreshFromMain(){
  _dmCopyFromMain();
}
// ==== v4.38.24 · dm form 独立测试连接（不再依赖 transfer form 的 dot/text/result，因为 dm form 独立显示在 panel-disk_manager） ====
async function testConnection_dm(){
  // 先把 dm form 复制到主 form（getTransferAuth 仍从主 form 读）
  _dmCopyToMain();
  // v4.43.1 · FIX ⑥: dm 面板指示器用自家 id（srvConnDot_dm）· 同时同步 transfer 面板（凭据已复制到主 form）
  //   此前 getElementById('srvConnDot') 恒命中隐藏的 transfer 面板元素，磁盘管理自家指示灯永不更新
  var dot=document.getElementById('srvConnDot_dm'), txt=document.getElementById('srvConnText_dm');
  var dotMain=document.getElementById('srvConnDot'), txtMain=document.getElementById('srvConnText');
  var res=document.getElementById('connResult_dm');  // v4.38.24 · dm form 自己的结果区
  if(dot){ dot.className='conn-dot connecting'; }
  if(txt){ txt.textContent='连接中...'; }
  if(res){ res.textContent=''; res.style.color=''; }
  var host = gv('srvHost');
  if(!host){
    if(dot) dot.className='conn-dot error';
    if(txt) txt.textContent='未连接';
    if(res){ res.textContent='✗ 请先填服务器主机地址'; res.style.color='var(--red)'; }
    return;
  }
  var auth = getTransferAuth();
  auth = await upgradeAuthToEC1(auth);
  openWs(function(ws){
    _rpSendWhenReady(ws, {
      action: 'test_conn',
      host: gv('srvHost'), port: gv('srvPort'), user: gv('srvUser'),
      auth_type: auth.auth_type,
      password: auth.password, key: auth.key, passphrase: auth.passphrase
    }, undefined, function(){ try { console.warn('[ws] 发送失败'); } catch(_){} })
    var handler = function(e){
      var d = JSON.parse(e.data);
      if(d.type === 'result'){
        ws.removeEventListener('message', handler);
        clearTimeout(timer);
        // v4.38.24 · 同时更新 transfer form 顶栏指示器 + dm form 自己的结果显示
        if(d.status === 'ok'){
          if(dot) dot.className='conn-dot connected';
          if(txt) txt.textContent='已连接';
          if(dotMain) dotMain.className='conn-dot connected';
          if(txtMain) txtMain.textContent='已连接';
          if(res){ res.textContent='✓ '+(d.msg||'连接成功'); res.style.color='var(--green)'; }
          document.getElementById('connDot')?.classList.add('connected');
          addLog(d.msg,'success');
          recordPanelConnStatus('srv', 'ok', gv('srvHost'), d.msg);
          if(typeof checkRsyncPlugins === 'function') setTimeout(checkRsyncPlugins, 300);
        } else {
          if(dot) dot.className='conn-dot error';
          if(txt) txt.textContent='连接失败';
          if(dotMain) dotMain.className='conn-dot error';
          if(txtMain) txtMain.textContent='连接失败';
          if(res){ res.textContent='✗ '+(d.msg||'连接失败'); res.style.color='var(--red)'; }
          addLog(d.msg,'error');
          recordPanelConnStatus('srv', 'fail', gv('srvHost'), d.msg);
        }
      }
    };
    ws.addEventListener('message', handler);
    var timer=setTimeout(function(){
      ws.removeEventListener('message', handler);
      if(txt && txt.textContent==='连接中...'){
        if(dot) dot.className='conn-dot error';
        if(txt) txt.textContent='超时';
        if(res){ res.textContent='✗ 连接超时 (15s)'; res.style.color='var(--red)'; }
      }
    }, 15000);
  }).catch(function(err){
    if(dot) dot.className='conn-dot error';
    if(txt) txt.textContent='WebSocket 错误';
    if(res){ res.textContent='✗ '+err.message; res.style.color='var(--red)'; }
    addLog(err.message,'error');
  });
}


function updateAuthUI_dm(){
  var at = document.getElementById('authType_dm');
  var fld = document.getElementById('authField_dm');
  if(!at || !fld) return;
  var lab = fld.querySelector('label');
  var inp = fld.querySelector('input');
  if(at.value === 'pass'){
    if(lab) lab.textContent = 'SSH 密码';
    if(inp){ inp.type='password'; inp.placeholder='密码'; inp.value=''; }
  } else {
    if(lab) lab.textContent = 'SSH 私钥路径';
    if(inp){ inp.type='text'; inp.placeholder='~/.ssh/id_rsa'; inp.value='~/.ssh/id_rsa'; }
  }
}
// v6.3.28 · _showC2Modal / rpConfirm / rpPrompt / rpForm 已**整体迁到 static/rp_dialogs.js**
//   原因: 它们原先长在 app.js 里, 而 app.js 只有主界面加载 → guac.html / novnc.html
//   这两个独立控制台页用不上, 只能继续写原生 confirm/prompt。迁出后三个页面共用一份。
//   对外 API 不变(_showC2Modal / rpConfirm / rpPrompt / rpForm 仍挂 window), 既有调用方无需改动。

(function _v43824DiskMount(){
  // v4.38.26 · transferLog 折叠/展开 toggle
  window.toggleTransferLog = function(btn){
    var log = document.getElementById('transferLog');
    if (!log) return;
    if (log.classList.contains('log-area-collapsed')){
      log.classList.remove('log-area-collapsed');
      if (btn) btn.querySelector('span:last-child').textContent = '▲ 折叠';
    } else {
      log.classList.add('log-area-collapsed');
      if (btn) btn.querySelector('span:last-child').textContent = '▼ 展开';
    }
  };
  // v4.38.26 · 更新 transferLog 徽标计数
  window.updateTransferLogCount = function(n){
    var c = document.getElementById('transferLogCount');
    if (c) c.textContent = '(' + n + ')';
  };

  // v4.38.27 · 远端磁盘管理页 操作日志 抽屉 (默认隐藏)
  window.toggleDmLogDrawer = function(btn){
    var drawer = document.getElementById('dmLogDrawer');
    if (!drawer) return;
    var show = drawer.style.display === 'none';
    drawer.style.display = show ? 'block' : 'none';
    if (btn){
      // 按钮文本: 展开时显示 👁, 隐藏时显示 📂
      btn.innerHTML = show
        ? '📋 日志 <span id="dmLogBadgeInline">(' + (window._dmLogCount || 0) + ')</span> 👁'
        : '📋 日志 <span id="dmLogBadgeInline">(' + (window._dmLogCount || 0) + ')</span> 📂';
    }
  };
  // v4.38.28 · 独立 5 号 section 操作日志 toggle (点 section-header 展开/折叠)
  window.toggleDmLogSection = function(header){
    var section = header.closest('.section');
    if (!section) return;
    var body = section.querySelector('.section-body');
    var arrow = header.querySelector('.section-arrow');
    if (!body) return;
    var show = body.style.display === 'none' || body.style.display === '';
    body.style.display = show ? 'block' : 'none';
    if (arrow) arrow.textContent = show ? '▼' : '▶';
  };
  // v4.38.27 · 隐藏日志 (抽屉收起, 后台继续记录)
  window.hideDmLog = function(){
    var drawer = document.getElementById('dmLogDrawer');
    if (drawer) drawer.style.display = 'none';
    var btn = document.getElementById('dmLogToggleBtn');
    if (btn){
      btn.innerHTML = '📋 日志 <span id="dmLogBadgeInline">(' + (window._dmLogCount || 0) + ')</span> 📂';
    }
    // v4.38.28 · 同时折叠 5 号 section
    var sec = document.getElementById('dm-log-section');
    if (sec){
      var body = sec.querySelector('.section-body');
      var arrow = sec.querySelector('.section-arrow');
      if (body) body.style.display = 'none';
      if (arrow) arrow.textContent = '▶';
    }
  };
  // v4.38.27 · 清空日志
  window.clearDmLog = function(){
    if (window._dmLog && typeof window._dmLog.clear === 'function'){
      window._dmLog.clear();
    }
    if (window.updateDmLogCount) window.updateDmLogCount(0);
  };
  // v4.38.27 · 更新 dm 日志徽标 (transfer_log.js 调用)
  window.updateDmLogCount = function(n){
    window._dmLogCount = n;
    var badge = document.getElementById('dmLogBadgeInline');
    if (badge) badge.textContent = '(' + n + ')';
    var cnt = document.getElementById('dmLogCount');
    if (cnt) cnt.textContent = '(' + n + ' 行)';
  };
  // v4.38.28 · openPathInTri: 外部把 path 写到指定 scope TransferTri 的 side
  window.openPathInTri = function(scope, side, path){
    try {
      // 1) 已有实例 → 直接 setPath
      if (window.TransferTri && window.TransferTri.setPath){
        var inst = window._triInstances && window._triInstances[scope];
        if (inst && inst.setPath){
          inst.setPath(side, path);
          return true;
        }
        // 2) v4.38.30 · 实例未创建: 主动调 setDirection 创建 (取当前 form 的 srv auth, 供远程连接)
        if (scope === 'disk_manager'){
          try { window.setDirection && window.setDirection('disk_manager', 'up'); } catch(_){}
          // 等创建完后再次 setPath
          setTimeout(function(){
            try {
              var inst2 = window._triInstances && window._triInstances[scope];
              if (inst2 && inst2.setPath) inst2.setPath(side, path);
            } catch(_){}
          }, 200);
          return true;
        }
      }
    } catch(e){ console.warn('[openPathInTri]', e); }
    return false;
  };
  function _mount(){
    // 同步 form
    if(typeof _dmRefreshFromMain === 'function') _dmRefreshFromMain();
    // v4.38.24 · 加载后同步触发 updateAuthUI_dm，让密码/密钥字段类型与 authType_dm 一致
    if(typeof updateAuthUI_dm === 'function') updateAuthUI_dm();
    // v4.39.4 · DM 三栏 TransferTri 自动创建: 打开 DM 面板即建实例 (懒创建改为面板激活即建)
    //   让源/目标下拉 df 分组立即可见, 无需用户先点 ⬅/➡ 或浏览
    try {
      var _dmTri = window._triInstances && window._triInstances['disk_manager'];
      if (!_dmTri && typeof window.setDirection === 'function'){
        window.setDirection('disk_manager', 'up');
      } else if (_dmTri && typeof _dmTri.refreshServers === 'function'){
        // 实例已存在 -> 刷新 (同步最新 __dmDfMounts)
        _dmTri.refreshServers();
      }
    } catch(_){}
    // 同步 srv 指示器
    // v4.43.1 · FIX ⑥: 用 dm 面板自家指示器（srvConnDot_dm），并从 _panelConnStatus 恢复实际状态
    try {
      var _dotDm = document.getElementById('srvConnDot_dm');
      var _txtDm = document.getElementById('srvConnText_dm');
      var _pcs = window._panelConnStatus && window._panelConnStatus['srv'];
      if (_dotDm && _txtDm && _pcs){
        _dotDm.className = 'conn-dot ' + (_pcs.status === 'ok' ? 'connected' : (_pcs.status === 'fail' ? 'error' : ''));
        _txtDm.textContent = _pcs.status === 'ok' ? '已连接' : (_pcs.status === 'fail' ? '连接失败' : '未连接');
      }
    } catch(_){}
    // 操作日志挂到 transferLogDisk
    if(window.TransferLog && document.getElementById('transferLogDisk')){
      try { window._dmLog = window._dmLog || window.TransferLog.create(document.getElementById('transferLogDisk'), { scope:'disk_manager' }); } catch(e){}
    }
    // ToolChecker 挂到 dm-tools-box
    if(window.ToolChecker && document.getElementById('dm-tools-box')){
      try {
        if(!window._dmTool){
          window._dmTool = window.ToolChecker.create(document.getElementById('dm-tools-box'), {
            scope: 'disk_manager',
            getSrvAuth: function(){ return window.getSrvAuth && window.getSrvAuth(); }
          });
        }
      } catch(e){}
    }
  }
  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', function(){ setTimeout(_mount, 500); });
  } else {
    setTimeout(_mount, 500);
  }
  // 每次激活 panel-disk_manager 都同步
  document.addEventListener('click', function(ev){
    var btn = ev.target && ev.target.closest && (ev.target.closest('.sub-tab') || ev.target.closest('.tab'));
    if(!btn) return;
    setTimeout(function(){
      var ap = document.querySelector('.panel.active');
      if(ap && ap.id === 'panel-disk_manager') _mount();
    }, 100);
  });
})();
window.enterNewConfigMode = enterNewConfigMode;
window.clearNewConfigMode = clearNewConfigMode;

// 每次切 panel / 载入其它配置都退出新建模式
(function(){
  var origApply = window.applyConfig;
  if(typeof origApply === 'function'){
    window.applyConfig = function(i){
      // 只有点击别的已有配置才 clear（当前激活的 pending_db cfg 不 clear）
      var target = configs[i];
      if(target && !target._pending_db){
        clearNewConfigMode();
      }
      return origApply.apply(this, arguments);
    };
  }
})();

/* ═══ v5.33.0 · 全局网络监控: 监听 system.stats 更新侧栏上下行速率 ═══ */
(function(){
  // ═══ v5.51.0 · P1-8 能力快照 (单一真源: caps.py + features.json → gen_capabilities.py) ═══
  try {
    var _cv = (window.RP_VERSION || '') + '';
    fetch('/static/capabilities.json' + (_cv ? ('?v=' + encodeURIComponent(_cv)) : ''))
      .then(function(r){ return r.ok ? r.json() : null; })
      .then(function(c){
        if (!c) return;
        window.RP_CAPS = {
          raw: c,
          version: c.version,
          capsFor: function(proto){ var p = (c.protocols||{})[(proto||'').toLowerCase()]; return (p && p.caps) || {}; },
          ui: function(proto, key, dflt){
            var p = (c.protocols||{})[(proto||'').toLowerCase()];
            var v = p && p.ui ? p.ui[key] : undefined;
            return (v === undefined) ? dflt : v;
          },
          feature: function(k){ return (c.features||{})[k] || null; },
          can: function(proto, cap){ return !!(this.capsFor(proto)[cap]); }
        };
        console.log('[caps] 能力快照已加载 v' + c.version + ' ('
                    + Object.keys(c.protocols||{}).length + ' 协议 / '
                    + Object.keys(c.features||{}).length + ' 功能键)');
      })
      .catch(function(e){ console.warn('[caps] 加载失败', e); });
  } catch(e){}

  if (window.EventBus) {
    EventBus.on('system.stats', function(topic, data){
      if (!data || !data.net) return;
      function u(id, v){ const e = document.getElementById(id); if(e) e.textContent = v; }
      u('netSentRate', data.net.sent_rate || 0);
      u('netRecvRate', data.net.recv_rate || 0);
      u('netSentTotal', (data.net.sent_mb || 0) >= 1024 ? ((data.net.sent_mb/1024).toFixed(1)+' GB') : ((data.net.sent_mb||0)+' MB'));
      u('netRecvTotal', (data.net.recv_mb || 0) >= 1024 ? ((data.net.recv_mb/1024).toFixed(1)+' GB') : ((data.net.recv_mb||0)+' MB'));
      // 进度条 (对数缩放, 1MB/s = 50%, 10MB/s = 100%)
      function bar(id, kbps){
        const e = document.getElementById(id); if(!e) return;
        const pct = Math.min(100, Math.log10(Math.max(1, kbps)) / Math.log10(10240) * 100);
        e.style.width = pct + '%';
      }
      bar('netSentBar', data.net.sent_rate || 0);
      bar('netRecvBar', data.net.recv_rate || 0);
      // 高负载提示
      const badge = document.getElementById('netBadge');
      if (badge) {
        const total = (data.net.sent_rate||0) + (data.net.recv_rate||0);
        badge.textContent = total > 10240 ? '⚡' : total > 1024 ? '🟡' : '';
      }
    });
  }
})();
