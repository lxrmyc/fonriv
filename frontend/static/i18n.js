/* ============================================================================
 * i18n.js · v4.74.0 · 全量国际化内核
 *
 * 设计要点 (一次到位, 后续只加词条不改代码):
 *   1) 以「中文原文」作为字典 key —— 调用点无需发明 key, 未翻译时原样返回中文,
 *      界面永不空白; 新增文案只需在 i18n_<lang>.js 里补一行。
 *   2) DOM 自动翻译: 扫描文本节点与 placeholder/title/alt/aria-label/value,
 *      命中字典即替换并记住原文(可切回中文)。
 *   3) 动态内容: MutationObserver + 面板切换后 applyI18n() 兜底。
 *   4) 语言持久化: localStorage(rp_lang) + 可选同步到后端用户偏好。
 *
 * API:
 *   t(str, params)      → 翻译字符串 (支持 {n} / {0} 占位)
 *   applyI18n(root)     → 翻译子树 (默认整个文档)
 *   setLang(code)       → 切换语言并全局重译
 *   currentLang() / LANGS / on(fn)
 * ========================================================================== */
(function(g){
  'use strict';

  var KEY = 'rp_lang';
  var LANGS = [
    { code: 'zh', label: '简体中文', flag: '🇨🇳', dict: null },
    { code: 'en', label: 'English',  flag: '🇺🇸', dict: 'I18N_EN' },
    { code: 'ja', label: '日本語',    flag: '🇯🇵', dict: 'I18N_JA' },
    { code: 'ko', label: '한국어',    flag: '🇰🇷', dict: 'I18N_KO' },
    { code: 'fr', label: 'Français', flag: '🇫🇷', dict: 'I18N_FR' },   // v5.39.0
    { code: 'de', label: 'Deutsch',  flag: '🇩🇪', dict: 'I18N_DE' },   // v5.39.0
    { code: 'es', label: 'Español',  flag: '🇪🇸', dict: 'I18N_ES' },   // v5.39.0
  ];
  var _lang = 'zh';
  var _dict = null;          // 当前语言字典 { 中文: 译文 }
  var _listeners = [];
  var _origText = new WeakMap();   // 节点 → 原始文本 (切回中文用)

  function _dictOf(code){
    var l = null;
    LANGS.forEach(function(x){ if (x.code === code) l = x; });
    if (!l || !l.dict) return null;
    var d = g[l.dict];
    return (d && typeof d === 'object') ? d : null;
  }

  function currentLang(){
    try { return localStorage.getItem(KEY) || 'zh'; } catch(e){ return 'zh'; }
  }

  // ── 翻译核心 ──
  function t(str, params){
    var s = (str == null) ? '' : String(str);
    if (!_dict || !s) return _applyParams(s, params);
    // 精确匹配
    var hit = _dict[s];
    if (hit == null){
      // 去首尾空白后匹配, 保留原空白
      var lead = s.match(/^\s*/)[0], tail = s.match(/\s*$/)[0];
      var core = s.trim();
      if (core && _dict[core] != null) hit = lead + _dict[core] + tail;
    }
    // v5.90.4 · 数字兜底: 运行时拼数字的文案(如 "共 5 项 · 已选 2 项")精确匹配永远未命中。
    //   把「独立数字段」(前后都不是字母/数字, 避免误伤 AES-256 / SHA256 / v5.90 / S3 等标识符)
    //   替换为 {n} 后再查字典; 命中且 {n} 段数与原数字段一致时按顺序回填。段数不一致放弃。
    if (hit == null){
      var nums = [], tpl = _numTpl(s, nums);
      if (nums.length){
        var thit = _dict[tpl];
        if (thit == null){
          var tl = tpl.match(/^\s*/)[0], tt = tpl.match(/\s*$/)[0];
          var tc = tpl.trim();
          if (tc && _dict[tc] != null) thit = _dict[tc];
          if (thit != null){   // 保留原首尾空白
            thit = tl + thit + tt;
          }
        }
        if (thit != null){
          var ph = thit.match(/\{n\}/g);
          if (ph && ph.length === nums.length){
            var i = 0;
            hit = thit.replace(/\{n\}/g, function(){ return nums[i++]; });
          }
        }
      }
    }
    if (hit == null) return _applyParams(s, params);
    return _applyParams(hit, params);
  }
  // 数字段 → {n} 模板 (仅统计「独立」数字: 前后字符都不是字母/数字/下划线)。
  //   可选单位后缀 d/h/m/s (如 4d 12h 时长) 一并归入 {n}, 回填时原样带出。
  function _numTpl(s, nums){
    return s.replace(/[0-9][0-9.,:]*[dhms]?(?![A-Za-z0-9_])/g, function(m, off, full){
      var before = off > 0 ? full.charAt(off - 1) : '';
      if (/[A-Za-z0-9_]/.test(before)) return m;
      if (nums) nums.push(m);
      return '{n}';
    });
  }
  function _applyParams(s, params){
    if (!params) return s;
    return s.replace(/\{(\w+)\}/g, function(m, k){
      return (params[k] != null) ? String(params[k]) : m;
    });
  }

  // 判断是否值得翻译 (含中文且不太长, 排除纯符号/代码)
  function _worthTranslate(s){
    if (!s) return false;
    var c = s.trim();
    if (!c || c.length > 300) return false;
    if (!/[\u4e00-\u9fff]/.test(c)) return false;
    return true;
  }

  var ATTRS = ['placeholder', 'title', 'alt', 'aria-label'];
  function _translateEl(el){
    if (!el || el.nodeType !== 1) return;
    // 跳过脚本/样式/输入框内容/已标记忽略
    var tag = (el.tagName || '').toUpperCase();
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEXTAREA' || tag === 'PRE') return;
    if (el.hasAttribute && el.hasAttribute('data-i18n-ignore')) return;
    ATTRS.forEach(function(a){
      var v = el.getAttribute && el.getAttribute(a);
      if (v && _worthTranslate(v)){
        if (!el.hasAttribute('data-i18n-orig-' + a)){
          el.setAttribute('data-i18n-orig-' + a, v);
        }
        var orig = el.getAttribute('data-i18n-orig-' + a);
        var tr = t(orig);
        if (tr && tr !== v) el.setAttribute(a, tr);
      }
    });
  }
  function _translateNode(node){
    if (!node || node.nodeType !== 3) return;
    var p = node.parentNode;
    if (!p) return;
    var ptag = (p.tagName || '').toUpperCase();
    if (ptag === 'SCRIPT' || ptag === 'STYLE' || ptag === 'TEXTAREA' || ptag === 'PRE') return;
    if (p.hasAttribute && p.hasAttribute('data-i18n-ignore')) return;
    var cur = node.nodeValue;
    if (!_worthTranslate(cur)) return;
    var known = _origText.get(node);
    var src = (known != null) ? known : cur;
    if (known == null) _origText.set(node, cur);
    var tr = t(src);
    if (tr && tr !== cur) node.nodeValue = tr;
  }

  function applyI18n(root){
    var r = root || document.body;
    if (!r) return;
    if (!_dict){          // 中文 = 源语言, 只需把之前翻过的还原
      _restoreAll();
      return;
    }
    _translateEl(r);
    if (r.nodeType === 3){ _translateNode(r); return; }
    if (r.querySelectorAll){
      var walker = document.createTreeWalker(r, NodeFilter.SHOW_TEXT, null);
      var n;
      while ((n = walker.nextNode())) _translateNode(n);
      r.querySelectorAll('[placeholder],[title],[alt],[aria-label]').forEach(_translateEl);
    }
  }
  function _restoreAll(){
    // 还原被翻译过的文本与属性
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    var n;
    while ((n = walker.nextNode())){
      var o = _origText.get(n);
      if (o != null && n.nodeValue !== o) n.nodeValue = o;
    }
    ATTRS.forEach(function(a){
      document.querySelectorAll('[data-i18n-orig-' + a + ']').forEach(function(el){
        var o = el.getAttribute('data-i18n-orig-' + a);
        if (o != null && el.getAttribute(a) !== o) el.setAttribute(a, o);
      });
    });
  }

  // ── 切换语言 ──
  function setLang(code){
    var valid = false;
    LANGS.forEach(function(l){ if (l.code === code) valid = true; });
    if (!valid) code = 'zh';
    try { localStorage.setItem(KEY, code); } catch(e){}
    _lang = code;
    _dict = _dictOf(code);
    document.documentElement.setAttribute('lang', code === 'zh' ? 'zh-CN' : code);
    // 正文还原为中文后再按新语言翻译 (避免二次翻译)
    _restoreAll();
    if (_dict) applyI18n(document.body);
    // v5.90.4 · 运行中切换语言也必须装上动态兜底观察器:
    //   此前观察器只在 init() (localStorage 已是非 zh) 时安装 →
    //   「zh 会话里切到 English」后, 懒渲染面板/下拉/toast 等动态内容永远不会被自动翻译。
    _ensureObserver();
    // 菜单标签等数据驱动内容重渲染
    try { if (typeof g.rerenderNav === 'function') g.rerenderNav(); } catch(e){}
    _applyDocTitleI18n();
    _listeners.forEach(function(fn){ try { fn(code); } catch(e){} });
    // 同步到后端用户偏好 (非阻塞)
    try {
      if (typeof g.send === 'function') g.send({ action: 'ui_lang_set', lang: code }, function(){});
    } catch(e){}
    return code;
  }

  function on(fn){ if (typeof fn === 'function') _listeners.push(fn); }

  // ── 初始化 ──
  var _moInstalled = false;
  function _ensureObserver(){
    if (_moInstalled || !_dict) return;   // zh = 源语言, 无需观察
    try {
      var mo = new MutationObserver(function(muts){
        /* v1.0.0 · FIX(英文界面残留中文): 原来只盯 childList 的**新增节点** —— 应用里大量
           动态状态是"就地改写已有节点的文本/属性"(CPU 百分比、连接状态 title、卡片副标题…),
           既不新增节点也没有其它节点变更 → 永远等不到重译, 界面就停在中文。
           现在: 新增节点仍走整页兜底; characterData/属性变更只翻译**受影响的那个节点**(轻量,
           不会因仪表盘高频刷新而整页重走)。翻译写入值相同则不再触发变更 → 不会自激循环。 */
        var needFull = false, targets = [];
        muts.forEach(function(m){
          if (m.type === 'childList'){
            if (m.addedNodes && m.addedNodes.length) needFull = true;
          } else if (m.removedNodes && m.removedNodes.length){
            /* 忽略删除 */
          } else {
            targets.push(m.target);
          }
        });
        if (needFull){ _schedule(); return; }
        for (var i = 0; i < targets.length; i++){
          var t = targets[i];
          try {
            if (t.nodeType === 3) _translateNode(t);
            else if (t.nodeType === 1) _translateEl(t);
          } catch(e){}
        }
      });
      mo.observe(document.body, { childList: true, subtree: true,
                                  characterData: true,
                                  attributes: true, attributeFilter: ATTRS });
      _moInstalled = true;
    } catch(e){}
  }
  function init(){
    _lang = currentLang();
    _dict = _dictOf(_lang);
    document.documentElement.setAttribute('lang', _lang === 'zh' ? 'zh-CN' : _lang);
    if (_dict){
      applyI18n(document.body);
      // 动态内容兜底 (面板重渲染/弹窗插入)
      _ensureObserver();
    }
    _applyDocTitleI18n();
  }
  /* v5.90.5 · 浏览器标签页标题翻译: index.html 模板标题形如 "<品牌> v<版本> - 后缀",
     字典就绪后/切语言时把最后一个 " - " 之后的段落替换为当前语言的译文 (zh 时原样返回=不动) */
  function _applyDocTitleI18n(){
    try {
      var t0 = document.title || '';
      var i = t0.lastIndexOf(' - ');
      if (i > 0) document.title = t0.slice(0, i) + ' - ' + t('运维高级传输同步工具');
    } catch(_){}
  }
  var _timer = null;
  function _schedule(){
    if (_timer) return;
    _timer = setTimeout(function(){
      _timer = null;
      try { applyI18n(document.body); } catch(e){}
    }, 120);
  }

  g.t = t;
  g.applyI18n = applyI18n;
  g.setLang = setLang;
  g.currentLang = currentLang;
  g.i18nOn = on;
  // v5.82.0 · 仅对外提供中文/英文(其余词典尚未完善); 词典保留, 已选其他语言者不受影响
  g.LANGS = LANGS.filter(function(l){ return l.code === 'zh' || l.code === 'en'; });
  g.I18N = { t: t, apply: applyI18n, setLang: setLang, current: currentLang, langs: LANGS };

  if (document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
