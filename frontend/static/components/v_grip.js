// v4.38.37 · VGrip · 通用竖向拖拽 grip（上下拖动调整区域高度）
// 用法: VGrip.attach(targetEl, { key: 'tri_transfer', min: 240, max: 900, persist: true })
//   - 在 targetEl 下方插入一条 8px 高的水平拖拽条（像窗口底边拖拽调大小）
//   - 拖拽实时以 px 改变 targetEl 的 height（线性 1:1）
//   - mouseup 时写 localStorage: rp_vgrip_<key>（持久化）
//   - 初始化时若 localStorage 有保存值则直接应用
// 依赖: 无（原生 DOM）
(function(){
  'use strict';

  var _drags = {};  // key -> {grip, target, startY, startH}

  function _esc(s){ return String(s).replace(/"/g,'&quot;'); }

  function _makeGrip(key){
    var g = document.createElement('div');
    g.className = 'vgrip vgrip-' + _esc(key);
    g.style.cssText = 'height:8px;margin:2px 0;cursor:row-resize;position:relative;user-select:none;flex:0 0 auto';
    g.title = '上下拖动调整上方区域高度';
    g.innerHTML = '<div style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:36px;height:3px;background:var(--border);border-radius:2px"></div>';
    g.addEventListener('mouseenter', function(){ g.firstElementChild.style.background = 'var(--cyan)'; });
    g.addEventListener('mouseleave', function(){ if (!_drags[key]) g.firstElementChild.style.background = 'var(--border)'; });
    return g;
  }

  function attach(target, opts){
    if (!target || !target.parentNode) return null;
    opts = opts || {};
    var key = opts.key || ('vg_' + (target.id || Math.random().toString(36).slice(2,8)));
    var min = opts.min || 220;
    var max = opts.max || 1200;

    // 幂等: 已有同 key grip 先移除
    var old = target.parentNode.querySelector('.vgrip-' + _esc(key));
    if (old) old.remove();

    var grip = _makeGrip(key);
    // v4.38.38 · grip 放 target 下方 (像窗口底边), 拖拽向上 = 缩小, 向下 = 放大
    var next = target.nextSibling;
    if (next) target.parentNode.insertBefore(grip, next);
    else target.parentNode.appendChild(grip);

    // 恢复保存的高度
    try {
      var saved = localStorage.getItem('rp_vgrip_' + key);
      if (saved){
        var h = parseInt(saved, 10);
        if (!isNaN(h) && h >= min && h <= max) target.style.height = h + 'px';
      }
    } catch(e){}

    grip.addEventListener('mousedown', function(ev){
      ev.preventDefault();
      ev.stopPropagation();
      _drags[key] = { grip: grip, target: target, startY: ev.clientY, startH: target.getBoundingClientRect().height, min: min, max: max };
      document.body.style.cursor = 'row-resize';
      grip.firstElementChild.style.background = 'var(--cyan)';
    });

    return { grip: grip, key: key };
  }

  // 全局拖拽事件（单例，attach 多个目标共用）
  document.addEventListener('mousemove', function(e){
    for (var key in _drags){
      var d = _drags[key];
      if (!d) continue;
      var dy = e.clientY - d.startY;
      var h = d.startH + dy;
      if (h < d.min) h = d.min;
      if (h > d.max) h = d.max;
      d.target.style.height = h + 'px';
    }
  });
  document.addEventListener('mouseup', function(){
    for (var key in _drags){
      var d = _drags[key];
      if (!d) continue;
      var h = Math.round(d.target.getBoundingClientRect().height);
      try { localStorage.setItem('rp_vgrip_' + key, String(h)); } catch(e){}
      d.grip.firstElementChild.style.background = 'var(--border)';
      delete _drags[key];
    }
    document.body.style.cursor = '';
  });

  window.VGrip = { attach: attach };
})();
