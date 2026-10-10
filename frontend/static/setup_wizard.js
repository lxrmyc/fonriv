/* Fonriv · 首次配置向导 (v5.91.6)
 *
 * 背景: 以前首次启动会自动建一个固定弱口令账号并打印在日志里 —— 且会随源码材料被公开。
 * 现在改为: 部署后第一次打开网页 → 由用户自己设超级管理员与界面偏好 → 直接进系统。
 * 后端: GET /api/setup/status (是否还需初始化) / POST /api/setup/init (仅未初始化时可调用)。
 */
(function(){
  'use strict';
  var busy = false;
  function $(id){ return document.getElementById(id); }
  /* v1.0.0 · i18n: 向导里的动态串(报错/按钮/成功卡)必须显式翻译 —— 这些是 textContent 直写,
     不产生 childList 变更之外的信号, 靠 DOM 兜底会闪中文甚至停在中文 */
  function T(s, p){ try { return (typeof window.t === 'function') ? window.t(s, p) : s; } catch(e){ return s; } }
  function showErr(msg){
    var e = $('setupError');
    if (!e) return;
    e.textContent = msg ? T(msg) : '';
    e.style.display = msg ? 'block' : 'none';
  }
  function hint(msg){
    var b = $('setupBtn');
    if (b){ b.disabled = !!msg; b.textContent = msg ? T(msg) : T('完成配置并进入系统'); }
  }

  /* 是否需要首次配置 → 需要就把登录框换成配置向导 */
  async function check(){
    var d = null;
    try {
      var r = await fetch('/api/setup/status', { cache: 'no-store' });
      d = await r.json();
    } catch(e){
      console.warn('[setup] 读取初始化状态失败, 走正常登录流程', e);
      return false;
    }
    if (!d || !d.needs_setup) return false;
    var lo = $('loginOverlay'); if (lo) lo.style.display = 'none';
    var so = $('setupOverlay'); if (so) so.style.display = 'flex';
    try {
      var th = localStorage.getItem('rp_theme');
      if ($('setupTheme') && (th === 'dark' || th === 'light' || th === 'auto')) $('setupTheme').value = th;
      if ($('setupLang')) $('setupLang').value = (localStorage.getItem('rp_lang') === 'en') ? 'en' : 'zh';
    } catch(e){}
    var u = $('setupUser'); if (u) u.focus();
    document.title = T('首次配置') + ' · ' + (d.product || 'Fonriv');
    try { if (window.applyI18n) window.applyI18n(document.body); } catch(e){}
    return true;
  }

  window.setupCheck = check;

  window.setupSubmit = async function(){
    if (busy) return;
    var username = ($('setupUser') && $('setupUser').value || '').trim();
    var pw  = ($('setupPass')  && $('setupPass').value)  || '';
    var pw2 = ($('setupPass2') && $('setupPass2').value) || '';
    var theme = ($('setupTheme') && $('setupTheme').value) || 'light';
    var lang  = ($('setupLang')  && $('setupLang').value)  || 'zh';
    var site  = ($('setupSite')  && $('setupSite').value || '').trim();
    if (!username){ showErr('请填写超级管理员用户名'); return; }
    if (pw.length < 8){ showErr('密码至少 8 位'); return; }
    if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)){ showErr('密码需同时包含字母和数字'); return; }
    if (pw !== pw2){ showErr('两次输入的密码不一致'); return; }
    busy = true; showErr(''); hint('正在创建…');
    try {
      var r = await fetch('/api/setup/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username, password: pw, theme: theme, site_name: site, lang: lang })
      });
      var d = {};
      try { d = await r.json(); } catch(e){}
      if (!r.ok || d.status !== 'ok'){
        busy = false; hint('');
        showErr(d.detail || d.msg || T('配置失败 (HTTP {n})', {n: r.status}));
        return;
      }
      // 本地态: token + 当前用户 + 主题/语言 —— 刷新后由既有"token 恢复会话"机制直接进系统
      try {
        localStorage.setItem('auth_token', d.token);
        localStorage.setItem('currentUser', JSON.stringify({
          user_id: d.user_id, username: d.username, role: d.role,
          token: d.token, permissions: ['*']
        }));
        localStorage.setItem('rp_theme', theme);
        localStorage.setItem('theme', theme);          // 兼容旧 key
        localStorage.setItem('rp_lang', lang);
        localStorage.setItem('help_lang', lang);
      } catch(e){}
      var ov = $('setupOverlay');
      if (ov) ov.innerHTML = '<div class="login-card setup-card">'
        + '<div class="login-title">✓ ' + T('配置完成') + '</div>'
        + '<div class="login-sub">' + T('管理员 {name} · 正在进入系统…', {name: (d.username || username)}) + '</div></div>';
      setTimeout(function(){ location.reload(); }, 700);
    } catch(e){
      busy = false; hint('');
      showErr(T('网络错误: ') + e);
    }
  };

  /* 回车提交 */
  document.addEventListener('keydown', function(e){
    var so = $('setupOverlay');
    if (e.key === 'Enter' && so && so.style.display !== 'none') window.setupSubmit();
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', check);
  else check();
})();
