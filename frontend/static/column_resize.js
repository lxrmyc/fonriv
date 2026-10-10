/* v5.36.0 · 左右栏宽拖拽 (column_resize)
 * 为固定布局的分栏面板注入竖向拖拽柄, 用户可拖动调整左右宽度 (localStorage 持久化)。
 * 白名单配置驱动 — 避免误伤 flex-wrap / grid 布局。
 * 已有拖拽的页面 (三栏传输 v-grip / 侧栏 sidebar_resize) 不在清单内。
 */
(function(){
  'use strict';
  const KEY = 'col_widths';

  function _widths(){ try { return JSON.parse(localStorage.getItem(KEY)||'{}'); } catch(e){ return {}; } }
  function _saveW(k, v){ const w=_widths(); w[k]=v; try{ localStorage.setItem(KEY, JSON.stringify(w)); }catch(e){} }

  /* 面板配置: panelKey → [ {sel: 容器选择器, side:'left'|'right', edgeSel: 被拖栏, min, max} ]
     edgeSel = 被调整宽度的那个子容器; side = 该栏在 grip 的哪一侧 */
  /* v6.5.0 · 批6: conn_center 配置移除 —— 原 bar 选择器引用的是隐藏兼容节点(nth-child(3)
     是 display:none 的占位 div), grip 从未真正生效; 连接中心改用自己的 #ccGrip(带折叠钮)。 */
  const LAYOUTS = {
  };

  function _makeVGrip(cfg){
    const grip = document.createElement('div');
    grip.className = 'col-resize-grip';
    grip.style.cssText = 'width:6px;cursor:col-resize;background:transparent;border-radius:3px;position:relative;user-select:none;flex-shrink:0;align-self:stretch;margin:0 1px';
    grip.innerHTML = '<div style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:3px;height:36px;border-radius:2px;background:var(--border)"></div>';
    grip.addEventListener('mouseenter', function(){ grip.firstChild.style.background='var(--text3)'; });
    grip.addEventListener('mouseleave', function(){ grip.firstChild.style.background='var(--border)'; });
    grip.addEventListener('mousedown', function(e){
      const pane = document.querySelector(cfg.pane);
      if(!pane) return;
      const startX = e.clientX, startW = pane.offsetWidth;
      document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none';
      const mm = function(e2){
        let w = (cfg.side === 'left') ? (startW + (e2.clientX - startX))
                                      : (startW - (e2.clientX - startX));
        w = Math.max(cfg.min, Math.min(cfg.max, w));
        pane.style.width = w + 'px';
        pane.style.flexShrink = '0';
        e2.preventDefault();
      };
      const mu = function(){
        document.removeEventListener('mousemove', mm); document.removeEventListener('mouseup', mu);
        document.body.style.cursor=''; document.body.style.userSelect='';
        const pane = document.querySelector(cfg.pane);
        if(pane) _saveW(cfg.key, pane.offsetWidth);
      };
      document.addEventListener('mousemove', mm); document.addEventListener('mouseup', mu);
      e.preventDefault();
    });
    return grip;
  }

  function apply(){
    Object.keys(LAYOUTS).forEach(function(pk){
      const panel = document.getElementById('panel-' + pk);
      if(!panel || !panel.classList.contains('active')) return;
      LAYOUTS[pk].forEach(function(cfg){
        if(cfg._done) return;
        const pane = document.querySelector(cfg.pane);
        if(!pane) return;
        const bar = pane.parentNode;
        if(!bar) return;
        // 恢复宽度
        const w = _widths()[cfg.key];
        if(w){
          pane.style.width = w + 'px';
          pane.style.flexShrink = '0';
        }
        // 注入 grip (插到该栏的内侧边缘)
        const grip = _makeVGrip(cfg);
        if(cfg.side === 'left') pane.parentNode.insertBefore(grip, pane.nextSibling);
        else pane.parentNode.insertBefore(grip, pane);
        cfg._done = true;
      });
    });
  }

  function init(){
    apply();
    setTimeout(apply, 1500);
    setTimeout(apply, 4000);
    if (typeof MutationObserver !== 'undefined'){
      const obs = new MutationObserver(function(muts){
        for (const m of muts){
          if (m.attributeName === 'class'){ setTimeout(apply, 300); break; }
        }
      });
      document.querySelectorAll('.panel').forEach(function(p){
        obs.observe(p, { attributes: true, attributeFilter: ['class'] });
      });
    }
  }
  document.addEventListener('DOMContentLoaded', function(){ setTimeout(init, 1800); });
})();
