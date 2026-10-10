/* v5.28.3 · 个性化布局: 主菜单/二级菜单位置与字号 · localStorage 持久化 */
(function(g){
  'use strict';
  var KEY = 'rp_personalize';
  var FONT_BASE = 15;                     // v5.90.10 · 主菜单字号基线(与 CSS --menu-main-font 默认一致)
  var SUB_FONT_BASE = 13;                 // v5.91.1 · 二级菜单基线独立调小(用户: 备份中心下会挤成两排)

  /* v5.82.0 · 旧偏好迁移: 已下线的对齐项(右对齐 / 对齐主菜单×2)回落到等价项 */
  function _migrate(cfg){
    var changed = false;
    if (cfg.mainAlign === 'flex-end'){ cfg.mainAlign = 'center'; changed = true; }
    if (['align-main', 'align-main-center', 'flex-end'].indexOf(cfg.subAlign) >= 0){
      cfg.subAlign = 'flex-start'; changed = true;
    }
    // v5.90.10 · 一次性把过小的菜单字号抬到新基线 (用户: 主菜单/二级菜单统一放大)
    //   只在首次执行, 之后用户自己拖滑块调小也会被尊重
    try {
      if (localStorage.getItem('rp_pers_font_upgraded') !== '1'){
        if (typeof cfg.mainFont === 'number' && cfg.mainFont < FONT_BASE){ cfg.mainFont = FONT_BASE; changed = true; }
        if (typeof cfg.subFont === 'number' && cfg.subFont < FONT_BASE){ cfg.subFont = FONT_BASE; changed = true; }
        localStorage.setItem('rp_pers_font_upgraded', '1');
      }
      // v5.91.1 · 二级菜单单独回调小 (用户: 二级菜单再缩小一点, 备份中心下已挤成两排)
      if (localStorage.getItem('rp_pers_subfont_135') !== '1'){
        if (typeof cfg.subFont === 'number' && cfg.subFont > SUB_FONT_BASE){ cfg.subFont = SUB_FONT_BASE; changed = true; }
        //   (13.5 → 13: 备份中心二级菜单 12 项 + 右移对齐后 13.5px 仍会折成两排)
        localStorage.setItem('rp_pers_subfont_135', '1');
      }
    } catch(e){}
    if (changed){ try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch(e){} }
    return cfg;
  }

  function _get(){
    try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch(e){ return {}; }
  }
  /* v5.85.0 · 二级菜单左对齐时以**右栏(内容区)左边界**为起点(用户要求: 别贴到窗口最左,
     要放在左栏(服务器列表)右边)。左栏宽度可变 → 拖动分隔条/改窗宽后重算。
     v5.90.10 · 用户报「按钮位置再往右挪一点, 要和右栏上下对齐」→ 计算口径从"左栏右缘"
     改为"右栏内容列左缘": 多云文件管理/连接中心这类页内自带左栏的页面, 直接量它右侧
     内容列(#fonrPaneA / #ccList)的 left; 其余页面 = 左侧栏右缘 + 主内容区左内边距(16px)。 */
  function contentLeft(){
    var cands = ['#fonrPaneA', '#ccList'];
    for (var i = 0; i < cands.length; i++){
      var el = document.querySelector(cands[i]);
      if (el && el.offsetParent !== null){
        var r = el.getBoundingClientRect();
        if (r.width > 0) return Math.round(r.left);
      }
    }
    var MAIN_PAD = 16;                        // .main > .panel 的左内边距(实测)
    var side = document.querySelector('.sidebar') || document.getElementById('sidebar');
    if (side && side.offsetParent !== null) return Math.round(side.getBoundingClientRect().right) + MAIN_PAD;
    // v5.90.8 · 侧栏隐藏(自动收起/用户折叠)时按**配置宽度**对齐 —
    //   此前量不到就当 0 → 二级菜单贴左, 与侧栏可见时的位置不一致(用户报: 先左后跳/各页不齐)
    var w = parseInt(localStorage.getItem('rp_sidebar_width') || '220', 10);
    return (isNaN(w) ? 220 : w) + 2 + MAIN_PAD;
  }

  function applySubInset(){
    try {
      var paneLeft = contentLeft();
      var cfg = _get();

      // v5.85.4/5 · 通用做法: **先清掉自己写的 margin → 量自然位置 → 只补差值**。
      //   (上一版写成"右栏边界 - 父元素左缘"当 margin → 与元素原有位置叠加, 实测跑到 338/220)
      function insetTo(el, want){
        if (!el) return;
        el.style.marginLeft = '';
        var nat = Math.round(el.getBoundingClientRect().left);
        el.style.marginLeft = (want > 0 && nat < want) ? (want - nat) + 'px' : '';
      }

      // ① 二级菜单: 组名留最左, 只把**条目**移到右栏起点(居中对齐时不缩)
      var sb = document.getElementById('subTabs');
      if (sb){
        sb.style.paddingLeft = '';
        var pills = sb.querySelector('.sub-tabs-pills');
        // v5.85.6 · 注意 _get() 返回**原始对象**: 未设置过时 subAlign 是 undefined(不是 flex-start),
        //   上一版按 === 'flex-start' 判断 → 默认状态下分支从不进入(实测条目仍停在 103)。改为「未显式居中即缩」。
        // v5.90.10 · 记录最终内缩值到 __fonrSubbarML — 二级菜单条重建(switchGroup innerHTML)时
        //   新 pills 元素先继承它, 再同步重算, 消除"先贴最左一帧再跳回"的闪烁(用户实测仍见跳动)。
        if (cfg.subAlign !== 'center'){
          insetTo(pills, paneLeft);
          window.__fonrSubbarML = (pills && pills.style.marginLeft) || '';
        }
        else if (pills){ pills.style.marginLeft = ''; window.__fonrSubbarML = ''; }
      }
      // ② v5.87.0 · 顶栏 WS/主题/语言三按钮**不再内缩**: v5.85.4 的"从右栏起"让三按钮
      //   随左栏宽度/页面状态前后漂移(用户报: 连接中心与文件传输页位置不一样)。
      //   固定紧跟 Logo, 位置恒定; 清掉历史残留的内缩 margin。
      var _wsEl = document.getElementById('globalConnStatus');
      if (_wsEl) _wsEl.style.marginLeft = '';
    } catch (e) {}
  }

  function _save(o){
    try { localStorage.setItem(KEY, JSON.stringify(o)); } catch(e){}
  }

  /* 读取设置并应用到 CSS */
  function apply(){
    var cfg = _migrate(_get());
    // v5.82.0 · 清掉旧版 _alignSubToMain 写在 #subTabs 上的内联 padding-left(不刷新页面时会残留 → 看着仍居中)
    try { var _sb = document.getElementById('subTabs'); if (_sb) _sb.style.paddingLeft = ''; } catch(e){}
    var mainAlign = cfg.mainAlign || 'center';
    var subAlign  = cfg.subAlign  || 'flex-start';
    var mainFont  = cfg.mainFont  || FONT_BASE;
    var subFont   = cfg.subFont   || SUB_FONT_BASE;
    var root = document.documentElement;
    root.style.setProperty('--menu-main-align', mainAlign);
    // v5.85.0 · 主菜单灰底收缩到内容宽度后, 位置改由 body 属性驱动(见 style.css)
    try {
      document.body.dataset.mainAlign = (mainAlign === 'flex-start') ? 'left' : 'center';
    } catch (e) {}
    root.style.setProperty('--menu-sub-align', subAlign);
    applySubInset();
    root.style.setProperty('--menu-main-font', mainFont + 'px');
    root.style.setProperty('--menu-sub-font', subFont + 'px');
  }

  /* v5.80.0 · 默认语言: 选项来自 i18n 的语言清单(单一真源), 值取自当前语言 */
  function fillLang(){
    var sel = document.getElementById('pLang');
    if (!sel) return;
    var langs = (g.LANGS && g.LANGS.length) ? g.LANGS : [{code:'zh', label:'简体中文', flag:'🇨🇳'}];
    if (!sel.options.length){
      langs.forEach(function(l){
        var o = document.createElement('option');
        o.value = l.code; o.textContent = (l.flag ? l.flag + ' ' : '') + l.label;
        sel.appendChild(o);
      });
    }
    var cur = (typeof g.currentLang === 'function') ? g.currentLang() : 'zh';
    sel.value = cur;
  }

  /* UI 表单 ← localStorage */
  function loadUI(){
    var cfg = _migrate(_get());
    fillLang();
    // 主菜单位置
    var ma = document.querySelector('input[name="pMainAlign"][value="' + (cfg.mainAlign || 'center') + '"]');
    if (ma) ma.checked = true;
    // 二级菜单位置
    var sa = document.querySelector('input[name="pSubAlign"][value="' + (cfg.subAlign || 'flex-start') + '"]');
    if (sa) sa.checked = true;
    // 字号
    var mf = document.getElementById('pMainFont'); if (mf) { mf.value = cfg.mainFont || FONT_BASE; }
    var mv = document.getElementById('pMainFontV'); if (mv) mv.textContent = (cfg.mainFont || FONT_BASE) + 'px';
    var sf = document.getElementById('pSubFont'); if (sf) { sf.value = cfg.subFont || SUB_FONT_BASE; }
    var sv = document.getElementById('pSubFontV'); if (sv) sv.textContent = (cfg.subFont || SUB_FONT_BASE) + 'px';
  }

  /* UI 表单 → localStorage → CSS */
  function collect(){
    var cfg = {};
    var ma = document.querySelector('input[name="pMainAlign"]:checked');
    if (ma) cfg.mainAlign = ma.value;
    var sa = document.querySelector('input[name="pSubAlign"]:checked');
    if (sa) cfg.subAlign = sa.value;
    var mf = document.getElementById('pMainFont'); if (mf) cfg.mainFont = parseFloat(mf.value) || FONT_BASE;
    var sf = document.getElementById('pSubFont'); if (sf) cfg.subFont = parseFloat(sf.value) || SUB_FONT_BASE;
    _save(cfg);
    apply();
  }

  /* v6.7.0 · 拖动实时预览(用户报: 拖动时 15px/14px 数值不变 + 卡顿)。
     根因: preview → collect() 每次 input 都**同步写 localStorage + 全量 apply**
     (apply 里 applySubInset 要清 margin→量 rect→写 margin, 逐帧强制布局)。
     现改为轻量预览: 只写两个 CSS 变量 + 刷新数值文案; 落盘/全量 apply 留到 change(拖完)。
     滑块点一下(键盘/单击轨道)也会触发 change, 不会丢持久化。 */
  function _paintFontVals(){
    var mf = document.getElementById('pMainFont');
    var sf = document.getElementById('pSubFont');
    var mv = document.getElementById('pMainFontV');
    var sv = document.getElementById('pSubFontV');
    if (mf && mv) mv.textContent = parseFloat(mf.value) + 'px';
    if (sf && sv) sv.textContent = parseFloat(sf.value) + 'px';
  }
  function preview(){
    var root = document.documentElement;
    var mf = document.getElementById('pMainFont');
    var sf = document.getElementById('pSubFont');
    if (mf) root.style.setProperty('--menu-main-font', (parseFloat(mf.value) || FONT_BASE) + 'px');
    if (sf) root.style.setProperty('--menu-sub-font', (parseFloat(sf.value) || SUB_FONT_BASE) + 'px');
    _paintFontVals();
  }
  function commit(){ collect(); }
  function save(){ collect(); if (g.toast) g.toast('✓ 个性化布局已保存', 'success', 2400); }
  function reset(){
    _save({});
    // 恢复 CSS 默认
    var root = document.documentElement;
    root.style.setProperty('--menu-main-align', 'center');
    try { document.body.dataset.mainAlign = 'center'; } catch (e) {}
    root.style.setProperty('--menu-sub-align', 'flex-start');
    root.style.setProperty('--menu-main-font', FONT_BASE + 'px');
    root.style.setProperty('--menu-sub-font', SUB_FONT_BASE + 'px');
    loadUI();
    if (g.toast) g.toast('✓ 已恢复默认布局', 'success', 2400);
  }

  /* 二级菜单对齐主菜单: 计算主菜单按钮位置, 动态设置 subTabs 左边距 */
  // v5.85.0 · 左栏宽度变化(拖分隔条 / 改窗宽)后重算二级菜单起点
  window.addEventListener('resize', applySubInset);
  document.addEventListener('mouseup', function(){ setTimeout(applySubInset, 60); });
  if (document.readyState !== 'loading') setTimeout(applySubInset, 800);
  else document.addEventListener('DOMContentLoaded', function(){ setTimeout(applySubInset, 800); });

  // v5.85.5 · 供导航流程复用: 切组会重建子菜单条, 内缩必须每次重算
  window.__applyPaneInsets = applySubInset;

  g.Personalize = { apply: apply, loadUI: loadUI, fillLang: fillLang, collect: collect, save: save, preview: preview, commit: commit, reset: reset };

  document.addEventListener('DOMContentLoaded', function(){
    apply();
    setTimeout(function(){
      loadUI();
    }, 500);
  });
})(window);
