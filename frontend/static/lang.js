/* v4.73.0 · 界面语言切换 (骨架; v4.74.0 接入完整 i18n 字典) */
(function(g){
  'use strict';
  // v5.39.0 · 与 i18n.js LANGS 同步 (新语言只需两边各加一行)
  var LANGS = [
    { code: 'zh', label: '简体中文', flag: '🇨🇳' },
    { code: 'en', label: 'English',  flag: '🇺🇸' },
    { code: 'ja', label: '日本語',    flag: '🇯🇵' },
    { code: 'ko', label: '한국어',    flag: '🇰🇷' },
    { code: 'fr', label: 'Français', flag: '🇫🇷' },
    { code: 'de', label: 'Deutsch',  flag: '🇩🇪' },
    { code: 'es', label: 'Español',  flag: '🇪🇸' },
  ];
  function current(){
    try { return localStorage.getItem('rp_lang') || 'zh'; } catch(e){ return 'zh'; }
  }
  function closeMenu(){
    var m = document.getElementById('rpLangMenu');
    if (m) m.remove();
    document.removeEventListener('mousedown', _outside);
  }
  function _outside(ev){
    var m = document.getElementById('rpLangMenu');
    if (m && !m.contains(ev.target)) closeMenu();
  }
  function toggleLangMenu(ev){
    if (ev && ev.stopPropagation) ev.stopPropagation();
    if (document.getElementById('rpLangMenu')){ closeMenu(); return; }
    var btn = document.getElementById('langToggleBtn');
    var r = btn ? btn.getBoundingClientRect() : { left: 100, bottom: 40 };
    var cur = current();
    var m = document.createElement('div');
    m.id = 'rpLangMenu';
    m.style.cssText = 'position:fixed;z-index:100003;background:var(--bg2);border:1px solid var(--border);'+
      'border-radius:8px;box-shadow:0 10px 32px rgba(0,0,0,.45);padding:4px;min-width:160px;font-size:12px';
    /* v6.16.2 批24 · 菜单用过滤后的对外语言表(中/英) —— 此前用原始 LANGS, 7 种语言全露(用户实测反馈) */
    m.innerHTML = (g.LANGS || LANGS).map(function(l){
      var on = (l.code === cur);
      return '<div class="rp-lang-item" data-code="'+l.code+'" style="padding:6px 12px;border-radius:5px;cursor:pointer;'+
        'display:flex;align-items:center;gap:8px;color:'+(on?'var(--green)':'var(--text)')+'">'+
        '<span>'+l.flag+'</span><span style="flex:1">'+l.label+'</span>'+
        (on ? '<span>✓</span>' : '')+'</div>';
    }).join('');
    document.body.appendChild(m);
    var mr = m.getBoundingClientRect();
    m.style.left = Math.max(4, Math.min(r.left - 60, window.innerWidth - mr.width - 8)) + 'px';
    m.style.top = Math.max(4, r.bottom + 6) + 'px';
    m.querySelectorAll('.rp-lang-item').forEach(function(el){
      el.onmouseenter = function(){ el.style.background = 'var(--bg3)'; };
      el.onmouseleave = function(){ el.style.background = ''; };
      el.onclick = function(e){
        e.stopPropagation();
        var code = el.getAttribute('data-code');
        closeMenu();
        // v4.74.0 · 走 i18n 内核切换 (DOM 全量重译 + 菜单重渲染 + 后端偏好同步)
        if (typeof g.setLang === 'function'){
          g.setLang(code);
          var L = null;
          (g.LANGS || []).forEach(function(x){ if (x.code === code) L = x; });
          if (typeof g.toast === 'function') g.toast('✓ ' + (L ? L.label : code), 'success', 2000);
        }
      };
    });
    setTimeout(function(){ document.addEventListener('mousedown', _outside); }, 0);
  }
  g.toggleLangMenu = toggleLangMenu;
  g.currentLang = current;
  // v5.82.0 · 与 i18n.js 同步: 仅对外提供中文/英文(此处曾覆盖 i18n.js 的过滤 → 下拉仍是 7 种)
  g.LANGS = LANGS.filter(function(x){ return x.code === 'zh' || x.code === 'en'; });
  // v6.16.2 批21 · 个性化页「默认语言」下拉(#pLang)只提供 中/英(与对外口径一致, 其余语言隐藏)
  function _fillPLang(){
    const sel = document.getElementById('pLang');
    if (!sel) return;
    sel.innerHTML = g.LANGS.map(function(x){
      return '<option value="' + x.code + '"' + (currentLang() === x.code ? ' selected' : '') + '>' + x.label + '</option>';
    }).join('');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _fillPLang);
  else _fillPLang();
  /* i18n.js 无公开订阅口 → 包装全局 setLang, 切换语言后同步下拉选中项 */
  const _prevSetLang = g.setLang;
  g.setLang = function(code){ const r = _prevSetLang ? _prevSetLang(code) : undefined; try { _fillPLang(); } catch(e){} return r; };
})(window);
