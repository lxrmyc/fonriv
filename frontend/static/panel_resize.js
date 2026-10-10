/* v5.33.1 · 全局面板内 section-body 高度拖拽调整
 * 自动为所有 max-height + overflow:auto 的 section-body 添加底部拖拽条
 * 用户可上下拖动调整内容区域高度, 高度持久化到 localStorage
 */
(function(){
  'use strict';
  const KEY = 'panel_body_heights';
  function _heights(){ try { return JSON.parse(localStorage.getItem(KEY)||'{}'); } catch(e){ return {}; } }
  function _saveH(k,v){ const h=_heights(); h[k]=v; try{localStorage.setItem(KEY,JSON.stringify(h));}catch(e){} }

  function _makeGrip(el, key){
    const grip = document.createElement('div');
    grip.className = 'pnl-resize-grip';
    grip.style.cssText = 'height:6px;margin:0 0 4px;cursor:row-resize;background:var(--bg3);border-radius:3px;position:relative;user-select:none';
    grip.innerHTML = '<div style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:36px;height:3px;border-radius:2px;background:var(--border)"></div>';
    grip.addEventListener('mouseenter', function(){ grip.firstChild.style.background='var(--text3)'; });
    grip.addEventListener('mouseleave', function(){ grip.firstChild.style.background='var(--border)'; });
    let startY=0, startH=0;
    grip.addEventListener('mousedown', function(e){
      startY=e.clientY; startH=el.offsetHeight;
      document.body.style.cursor='row-resize'; document.body.style.userSelect='none';
      const mm = function(e2){
        const h = Math.max(60, Math.min(1400, startH + (e2.clientY - startY)));
        el.style.maxHeight = h + 'px'; el.style.height = h + 'px';
        if (el.__enableScrollOnDrag){ el.style.overflowY = 'auto'; }
      };
      const mu = function(){
        document.removeEventListener('mousemove',mm); document.removeEventListener('mouseup',mu);
        document.body.style.cursor=''; document.body.style.userSelect='';
        const h = el.offsetHeight; _saveH(key, h);
      };
      document.addEventListener('mousemove',mm); document.addEventListener('mouseup',mu);
      e.preventDefault();
    });
    el.parentNode.insertBefore(grip, el);
    // v5.36.0 · 折叠联动: 前置 body 隐藏时同步隐藏 grip
    try {
      new MutationObserver(function(){
        grip.style.display = (el.style.display === 'none') ? 'none' : '';
      }).observe(el, { attributes: true, attributeFilter: ['style'] });
    } catch(e){}
    return grip;
  }

  function apply(){
    document.querySelectorAll('.section-body').forEach(function(el, idx){
      if (el.dataset.rsInit) return;
      const cs = getComputedStyle(el);
      const scrollable = (cs.overflowY === 'auto' || cs.overflowY === 'scroll' || cs.overflow === 'auto');
      // v5.36.0 · 放宽覆盖: 无滚动的 body 也注入 (拖动时才启用 max-height + 滚动, 初始外观不变)
      if (!scrollable && el.offsetHeight < 120) return;
      if (scrollable && el.offsetHeight < 60) return;
      // 生成唯一 key
      const panel = el.closest('.panel');
      const pid = panel ? panel.id.replace('panel-','') : 'x';
      const key = pid + '_' + Array.prototype.indexOf.call(document.querySelectorAll('.section-body'), el);
      el.dataset.rsInit = '1';
      // 恢复保存的高度
      const h = _heights()[key];
      if (h) { el.style.maxHeight = h + 'px'; el.style.height = h + 'px'; }
      // 添加拖拽条 (拖动时对非滚动 body 启用 overflow)
      if (!scrollable){
        const _origMM = null;
        el.__enableScrollOnDrag = true;
      }
      _makeGrip(el, key);
    });
  }

  // 初始化 (DOM 加载后 + 延迟重试以覆盖动态渲染的面板)
  function init(){
    apply();
    setTimeout(apply, 2000);
    setTimeout(apply, 5000);
    // MutationObserver 监听面板切换
    if (typeof MutationObserver !== 'undefined'){
      const obs = new MutationObserver(function(muts){
        for (const m of muts){
          if (m.attributeName === 'class'){
            setTimeout(apply, 200); break;
          }
        }
      });
      document.querySelectorAll('.panel').forEach(function(p){
        obs.observe(p, { attributes: true, attributeFilter: ['class'] });
      });
    }
  }
  document.addEventListener('DOMContentLoaded', function(){ setTimeout(init, 1500); });
})();
