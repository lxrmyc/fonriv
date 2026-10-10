/* v4.81.0 · PWA 响应式适配 (manifest + 移动端布局) */
(function(g){
  'use strict';
  var MANIFEST = { name: "Fonriv", short_name: "Fonriv", start_url: "/", display: "standalone",
                   background_color: "#0d1117", theme_color: "#1f6feb" };

  function isMobile(){ return window.innerWidth < 768; }

  function injectManifest(){
    if (document.querySelector('link[rel="manifest"]')) return;
    var blob = new Blob([JSON.stringify(MANIFEST)], { type: 'application/json' });
    var link = document.createElement('link');
    link.rel = 'manifest';
    link.href = URL.createObjectURL(blob);
    document.head.appendChild(link);
  }

  function injectViewport(){
    if (document.querySelector('meta[name=viewport]')) return;
    var meta = document.createElement('meta');
    meta.name = 'viewport';
    meta.content = 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no';
    document.head.appendChild(meta);
  }

  function injectMobileStyle(){
    if (document.getElementById('pwaMobileStyle')) return;
    var st = document.createElement('style');
    st.id = 'pwaMobileStyle';
    st.textContent = [
      // 手机: 侧栏折叠 + 三栏改纵向 + 主菜单缩小
      '@media (max-width: 768px) {',
      '  .sidebar { position: fixed !important; left: -260px !important; top: 0; bottom: 0; z-index: 9999; width: 260px !important; transition: left .2s; }',
      '  .sidebar.mobile-open { left: 0 !important; }',
      '  .main-tabs .tab { padding: 4px 8px !important; font-size: 11px !important; }',
      '  .topbar .logo { font-size: 14px !important; }',
      '  .sub-tabs { padding: 4px 8px !important; }',
      '  .sub-tabs .sub-tab { padding: 3px 8px !important; font-size: 11px !important; }',
      '  .dpb-pane, .tp-mid { min-width: 100% !important; }',
      '  .content { padding: 4px !important; }',
      '  .panel { padding: 8px !important; }',
      '  .section { margin-bottom: 8px !important; }',
      '  .form-row { flex-direction: column !important; }',
      '  .field { min-width: 100% !important; }',
      '}',
      '.mobile-menu-toggle { display: none !important; }',
      '@media (max-width: 768px) {',
      '  .mobile-menu-toggle { display: block !important; position: fixed; bottom: 16px; right: 16px; z-index: 10000;',
      '    width: 48px; height: 48px; border-radius: 50%; background: var(--accent, #1f6feb); color: #fff;',
      '    border: none; font-size: 20px; cursor: pointer; box-shadow: 0 4px 12px rgba(0,0,0,.3); }',
      '}',
    ].join('\n');
    document.head.appendChild(st);
  }

  function injectToggle(){
    if (document.querySelector('.mobile-menu-toggle')) return;
    var btn = document.createElement('button');
    btn.className = 'mobile-menu-toggle';
    btn.textContent = '☰';
    btn.onclick = function(){
      var sb = document.getElementById('sidebar');
      if (sb) sb.classList.toggle('mobile-open');
    };
    document.body.appendChild(btn);
    // 点击侧栏外关闭
    document.addEventListener('click', function(ev){
      var sb = document.getElementById('sidebar');
      if (sb && sb.classList.contains('mobile-open') && !sb.contains(ev.target) && ev.target !== btn){
        sb.classList.remove('mobile-open');
      }
    });
  }

  function init(){
    injectManifest();
    injectViewport();
    injectMobileStyle();
    if (isMobile()) injectToggle();
    window.addEventListener('resize', function(){
      if (isMobile()) injectToggle();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  g.PWA = { isMobile: isMobile, init: init };
})(window);
