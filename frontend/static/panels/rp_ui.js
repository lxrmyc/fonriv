/* v4.98.0 · 前端 UI 增强三件套
 *   ① 面包屑 + 返回  (中栏/预览区通用, 可点击跳转任意层级)
 *   ② 栏宽拖动分隔条 (相邻两栏之间, 双击复位)
 *   ③ 图片平移     (缩放后鼠标变抓手, 可上下左右拖动)
 */
(function(g){
  'use strict';

  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }

  /* ══════════ ① 面包屑 + 返回 ══════════ */
  // 渲染 HTML: path='/a/b/c' -> [⬅] [🏠/] a › b › c
  function breadcrumbHtml(path, opts){
    opts = opts || {};
    var p = String(path || '/');
    var segs = p.split('/').filter(function(x){ return x !== ''; });
    var h = '<div class="rpc-crumb" style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;font-size:11px;font-family:monospace;min-width:0">';
    if (opts.showBack !== false && segs.length){
      h += '<button class="btn btn-sm rpc-crumb-back" style="padding:1px 8px;font-size:11px" title="返回上级目录">⬅ 返回</button>';
    }
    h += '<span class="rpc-crumb-seg" data-path="/" style="cursor:pointer;color:var(--cyan);padding:0 3px" title="根目录">🏠</span>';
    segs.forEach(function(seg, i){
      var sub = '/' + segs.slice(0, i + 1).join('/');
      h += '<span style="color:var(--text3)">›</span>';
      h += '<span class="rpc-crumb-seg" data-path="' + esc(sub) + '" style="cursor:pointer;color:var(--cyan);padding:0 3px;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + esc(sub) + '">' + esc(seg) + '</span>';
    });
    h += '</div>';
    return h;
  }
  // 绑定: onNav(path) / onBack()
  function bindBreadcrumb(root, handlers){
    if (!root) return;
    handlers = handlers || {};
    root.querySelectorAll('.rpc-crumb-seg').forEach(function(el){
      el.onclick = function(ev){
        ev.stopPropagation();
        if (typeof handlers.onNav === 'function') handlers.onNav(el.getAttribute('data-path') || '/');
      };
    });
    var bk = root.querySelector('.rpc-crumb-back');
    if (bk) bk.onclick = function(ev){
      ev.stopPropagation();
      if (typeof handlers.onBack === 'function') handlers.onBack();
    };
  }
  // 用面包屑替换一个容器里的纯文本路径 (三栏/DM/预览页统一入口)
  function mountBreadcrumb(host, path, handlers){
    if (!host) return;
    var segs = String(path || '/').split('/').filter(Boolean);
    host.style.display = 'flex';
    host.style.alignItems = 'center';
    host.style.gap = '4px';
    host.style.flexWrap = 'wrap';
    host.innerHTML = breadcrumbHtml(path, {});
    bindBreadcrumb(host, handlers || {});
    return segs;
  }

  /* ══════════ ② 栏宽拖动 ══════════ */
  // 在 container 内相邻列之间插入可拖动分隔条; cols=[elA, elB, ...], 拖动改变相邻两列宽度
  function makeResizable(container, cols, opts){
    if (!container || !cols || cols.length < 2) return;
    // v5.1.0 · 校验: 给出的列必须都是该容器的直接子元素, 否则放弃 (误传会压扁布局)
    try {
      for (var i0 = 0; i0 < cols.length; i0++){
        if (!cols[i0] || cols[i0].parentNode !== container) return;
      }
    } catch(e){ return; }
    opts = opts || {};
    var minPx = opts.minPx || 160;
    var KEY = opts.key || ('rp_cols_' + (container.id || 'anon'));
    // v5.1.0 · 不再恢复"记忆宽度": 跨页面/跨布局恢复会把列压扁 (实测左栏被挤到 70px)
    //   只在本次会话内通过拖动调整, 刷新后回到自然布局
    try { localStorage.removeItem(KEY); } catch(e){}
    // 所有列都设最小宽度, 防止 flex 把某一列压没
    cols.forEach(function(c, i){
      if (!c) return;
      c.style.minWidth = minPx + 'px';
      if (i === cols.length - 1){ c.style.flex = '1 1 auto'; }
    });
    function _save(){ /* v5.1.0 · 不再持久化列宽 (跨页面恢复会压扁列) */ }
    for (var i = 0; i < cols.length - 1; i++){
      (function(idx){
        var a = cols[idx], b = cols[idx + 1];
        if (!a || !b) return;
        var grip = document.createElement('div');
        grip.className = 'rpc-grip';
        grip.title = '拖动调整宽度 · 双击复位';
        // v5.3.0 · 分隔条收窄到 3px (此前 6px 视觉过宽)
        grip.style.cssText = 'flex:0 0 3px;cursor:col-resize;background:var(--border);border-radius:2px;align-self:stretch;transition:background .15s';
        grip.onmouseenter = function(){ grip.style.background = 'var(--cyan)'; };
        grip.onmouseleave = function(){ if (!grip.__dragging) grip.style.background = 'var(--border)'; };
        b.parentNode.insertBefore(grip, b);   // 插到 b 之前 = a 与 b 之间
        var dragging = false, startX = 0, wa = 0, wb = 0;
        grip.addEventListener('mousedown', function(ev){
          dragging = true; grip.__dragging = true;
          startX = ev.clientX;
          wa = a.getBoundingClientRect().width;
          wb = b.getBoundingClientRect().width;
          document.body.style.cursor = 'col-resize';
          document.body.style.userSelect = 'none';
          ev.preventDefault();
        });
        document.addEventListener('mousemove', function(ev){
          if (!dragging) return;
          var d = ev.clientX - startX;
          // v5.2.0 · 钳制: 左列 ≥minPx, 且右列 ≥ minPx; 再用容器宽兜底上限 (修"拖动过大")
          var cw = container.getBoundingClientRect().width;
          var gapTotal = 0;
          try { gapTotal = Math.max(0, cw - cols.reduce(function(t, c){ return t + (c ? c.getBoundingClientRect().width : 0); }, 0)); } catch(e){}
          // v5.3.0 · 再加 60% 容器宽上限 (源列表/浏览栏不该占据大半屏)
          var maxA = Math.min(wa + wb - minPx, cw - minPx - gapTotal, cw * 0.6);
          var na = Math.max(minPx, Math.min(maxA, wa + d));
          a.style.flex = '0 0 ' + na + 'px';
          a.style.width = na + 'px';
          b.style.flex = '1 1 auto';
          b.style.width = '';
          b.style.minWidth = minPx + 'px';
        });
        document.addEventListener('mouseup', function(){
          if (!dragging) return;
          dragging = false; grip.__dragging = false;
          document.body.style.cursor = '';
          document.body.style.userSelect = '';
          grip.style.background = 'var(--border)';
          // v5.1.0 · 兜底: 任一列被压到 minPx 以下 → 全部还原自然布局
          try {
            var bad = cols.some(function(c){ return c && c.getBoundingClientRect().width < minPx - 4; });
            if (bad){
              cols.forEach(function(c){ if (c){ c.style.flex = ''; c.style.width = ''; c.style.minWidth = minPx + 'px'; } });
            }
          } catch(e){}
          try { window.dispatchEvent(new Event('resize')); } catch(e){}
        });
        grip.addEventListener('dblclick', function(){
          cols.forEach(function(c){
            if (!c) return;
            c.style.flex = ''; c.style.width = ''; c.style.minWidth = '';
          });
          try { localStorage.removeItem(KEY); } catch(e){}
          try { g.dispatchEvent(new Event('resize')); } catch(e){}
        });
      })(i);
    }
  }

  /* ══════════ ③ 图片平移 (缩放后抓手拖动) ══════════ */
  function attachPan(img, wrapper){
    if (!img || img.__rpPan) return;
    img.__rpPan = true;
    var ox = 0, oy = 0, dragging = false, sx = 0, sy = 0;
    wrapper = wrapper || img.parentElement;
    function zoomed(){
      var z = parseFloat(img.dataset.zoom || '1') || 1;
      return z > 1.001;
    }
    function apply(){
      img.style.transform = 'translate(' + ox + 'px,' + oy + 'px)';
    }
    function cursor(){
      img.style.cursor = zoomed() ? 'grab' : 'auto';
    }
    img.addEventListener('mousedown', function(ev){
      if (!zoomed()) return;
      dragging = true; sx = ev.clientX - ox; sy = ev.clientY - oy;
      img.style.cursor = 'grabbing';
      ev.preventDefault();
    });
    document.addEventListener('mousemove', function(ev){
      if (!dragging) return;
      ox = ev.clientX - sx; oy = ev.clientY - sy;
      apply();
    });
    document.addEventListener('mouseup', function(){ if (dragging){ dragging = false; cursor(); } });
    // 滚轮缩放 (以光标为中心) + 双击复位
    wrapper.addEventListener('wheel', function(ev){
      if (!ev.ctrlKey && !ev.metaKey && !zoomed() && parseFloat(img.dataset.zoom||'1') <= 1) {
        // 未缩放时滚轮交给容器滚动
        return;
      }
      ev.preventDefault();
      var z = parseFloat(img.dataset.zoom || '1') || 1;
      z = z * (ev.deltaY < 0 ? 1.15 : 0.87);
      z = Math.max(0.2, Math.min(8, z));
      img.dataset.zoom = z;
      img.style.maxWidth = 'none';
      img.style.maxHeight = 'none';
      img.style.width = (img.naturalWidth * z) + 'px';
      img.style.transformOrigin = '0 0';
      if (z <= 1.001){ ox = 0; oy = 0; img.style.transform = ''; }
      apply();
      cursor();
    }, { passive: false });
    img.addEventListener('dblclick', function(){
      img.dataset.zoom = 1;
      ox = 0; oy = 0;
      img.style.width = ''; img.style.maxWidth = ''; img.style.maxHeight = '';
      img.style.transform = '';
      cursor();
    });
    img.addEventListener('load', cursor);
    cursor();
    return { reset: function(){ img.dataset.zoom = 1; ox = 0; oy = 0; apply(); cursor(); } };
  }

  /* ══════════ ④ 预览模式 (仅预览 / 目录浏览+预览) ══════════ */
  var _pmCache = null;
  function rpc(a, d){
    return new Promise(function(res){
      try { window.send(Object.assign({action: a}, d || {}), function(r){ res(r || {}); }); }
      catch(e){ res({ status:'error', msg:String(e) }); }
    });
  }
  function modeOf(scope){
    if (_pmCache && _pmCache[scope]) return _pmCache[scope];
    try { return localStorage.getItem('rp_pm_' + scope) || 'browse'; } catch(e){ return 'browse'; }
  }
  function loadModes(){
    return rpc('preview_mode_get', {}).then(function(r){
      if (r && r.status === 'ok'){
        _pmCache = { transfer: r.transfer, dm: r.dm, preview: r.preview };
        ['transfer','dm','preview'].forEach(function(k){
          try { localStorage.setItem('rp_pm_' + k, _pmCache[k]); } catch(e){}
        });
      }
      return _pmCache;
    });
  }
  function setMode(scope, mode){
    // 本地立即生效 (界面即时响应), 同时写入后端持久化
    _pmCache = _pmCache || {};
    _pmCache[scope] = mode;
    try { localStorage.setItem('rp_pm_' + scope, mode); } catch(e){}
    return rpc('preview_mode_set', { scope: scope, mode: mode }).then(function(r){
      try { g.dispatchEvent(new CustomEvent('rp-preview-mode-changed', { detail: { scope: scope, mode: mode } })); } catch(e){}
      return r;
    });
  }
  // 设置按钮: 弹小面板 (两个选项 + 说明)
  function settingsButton(scope, label){
    var btn = document.createElement('button');
    btn.className = 'btn btn-sm rp-pm-btn';
    btn.style.cssText = 'padding:2px 9px;font-size:11px';
    function _paint(){
      var m = modeOf(scope);
      btn.textContent = '⚙ 预览设置: ' + (m === 'preview' ? '仅预览' : '目录浏览+预览');
      btn.title = '点击切换该区域的预览方式 · ' + (label || '');
    }
    btn.onclick = function(ev){
      ev.stopPropagation();
      // 就地弹选择
      var wrap = document.createElement('div');
      wrap.style.cssText = 'position:fixed;z-index:300000;background:var(--bg2);border:1px solid var(--border);border-radius:8px;box-shadow:0 12px 40px rgba(0,0,0,.5);padding:8px;min-width:250px';
      var r0 = btn.getBoundingClientRect();
      wrap.style.left = Math.max(8, Math.min(window.innerWidth - 262, r0.left)) + 'px';
      wrap.style.top = (r0.bottom + 6) + 'px';
      wrap.innerHTML =
        '<div style="font-size:11px;color:var(--text3);padding:2px 6px 6px">' + esc(label || '预览方式') + '</div>' +
        '<div class="rp-pm-opt" data-m="preview" style="padding:7px 9px;border-radius:6px;cursor:pointer;font-size:12px' + (modeOf(scope)==='preview'?';background:var(--bg3)':'') + '">' +
          '<b>仅预览</b><div style="font-size:10px;color:var(--text3)">中间/右侧只作预览区, 不显示目录列表 (点左栏文件即预览)</div></div>' +
        '<div class="rp-pm-opt" data-m="browse" style="padding:7px 9px;border-radius:6px;cursor:pointer;font-size:12px;margin-top:2px' + (modeOf(scope)==='browse'?';background:var(--bg3)':'') + '">' +
          '<b>目录浏览 + 预览</b><div style="font-size:10px;color:var(--text3)">可显示目录与文件列表(缩略图/列表), 单击图片进入预览</div></div>';
      document.body.appendChild(wrap);
      function _close(ev2){
        if (wrap.contains(ev2.target)) return;
        wrap.remove(); document.removeEventListener('click', _close, true);
      }
      setTimeout(function(){ document.addEventListener('click', _close, true); }, 0);
      wrap.querySelectorAll('.rp-pm-opt').forEach(function(o){
        o.onclick = function(){
          var m = o.getAttribute('data-m');
          setMode(scope, m).then(function(r){
            _paint();
            if (window.toast) toast((r && r.msg) || '已保存', 'success', 2200);
          });
          wrap.remove();
        };
      });
    };
    setTimeout(_paint, 0);
    return btn;
  }

  g.RpUI = { breadcrumbHtml: breadcrumbHtml, bindBreadcrumb: bindBreadcrumb,
             mountBreadcrumb: mountBreadcrumb, makeResizable: makeResizable, attachPan: attachPan,
             modeOf: modeOf, loadModes: loadModes, setMode: setMode, settingsButton: settingsButton };
  var PreviewModeSetting = {
    load: function(){
      loadModes().then(function(m){
        try {
          if (m){
            var a = document.getElementById('pmTransfer'); if (a) a.value = m.transfer || 'browse';
            var b = document.getElementById('pmDm'); if (b) b.value = m.dm || 'browse';
            var c = document.getElementById('pmPreview'); if (c) c.value = m.preview || 'browse';
          }
        } catch(e){}
      });
    },
    save: function(scope, mode){
      setMode(scope, mode).then(function(r){
        var el = document.getElementById('pmResult');
        if (el) el.innerHTML = '<span style="color:var(--green)">' + esc((r && r.msg) || '已保存') + '</span>';
      });
    },
    saveAll: function(){
      var m1 = (document.getElementById('pmTransfer') || {}).value || 'browse';
      var m2 = (document.getElementById('pmDm') || {}).value || 'browse';
      var m3 = (document.getElementById('pmPreview') || {}).value || 'browse';
      Promise.all([setMode('transfer', m1), setMode('dm', m2), setMode('preview', m3)]).then(function(){
        var el = document.getElementById('pmResult');
        if (el) el.innerHTML = '<span style="color:var(--green)">✓ 三项已保存</span>';
      });
    },
  };
  g.PreviewModeSetting = PreviewModeSetting;
  // 启动时同步一次模式
  document.addEventListener('DOMContentLoaded', function(){
    setTimeout(loadModes, 2500);
    setTimeout(function(){ PreviewModeSetting.load(); }, 3000);
  });
})(window);

/* ══════════════════════════════════════════════════════════════════════════
 * v5.90.5 · 打开方式偏好 (rp_open_mode) — 全站文件列表统一口径:
 *   single = 单击进入文件夹 / 单击文件即预览 (传统默认)
 *   double = 双击进入文件夹, 单击=选中 (Ctrl 多选)
 * 存 localStorage('rp_open_mode'), 同源可复用于: 多云文件管理 / 文件传输三栏
 * (dual_pane_browser) / DM 三栏与远端磁盘管理 (transfer_tri) / 文件预览页。
 * 用户要求在各面板均可切换: FonrVFS 设置 + 三栏工具栏各挂一个 RPOpenMode.select()。
 * ══════════════════════════════════════════════════════════════════════════ */
(function(g){
  'use strict';
  var KEY = 'rp_open_mode';
  function get(){
    try { return localStorage.getItem(KEY) === 'double' ? 'double' : 'single'; }
    catch(e){ return 'single'; }
  }
  function isDbl(){ return get() === 'double'; }
  function set(mode){
    try { localStorage.setItem(KEY, mode === 'double' ? 'double' : 'single'); } catch(e){}
    // 同步页面上所有挂载的选择器, 并广播 (面板按需重渲染)
    document.querySelectorAll('select[data-rp-open-mode]').forEach(function(el){ el.value = get(); });
    try { g.dispatchEvent(new CustomEvent('rp-open-mode-changed', {detail: {mode: get()}})); } catch(e){}
  }
  /* 生成一个挂载好的 <select> (插入即生效); tip 为悬浮说明 */
  function select(cls){
    var s = document.createElement('select');
    s.className = cls || 'btn btn-xs';
    s.setAttribute('data-rp-open-mode', '1');
    s.title = '鼠标左键打开方式: 单击进入 / 双击进入(单击选中, Ctrl 多选)';
    s.style.maxWidth = '150px';
    s.innerHTML = '<option value="single">🖱 单击进入文件夹</option>'
                + '<option value="double">🖱 双击进入文件夹</option>';
    s.value = get();
    s.onchange = function(){ set(s.value); };
    return s;
  }
  /* v1.0.0 · 按钮式切换(用户要求): 4 字标签「单击进入 / 双击进入」, 点一下即在两者间切换。
     与 select() 共用同一偏好, 其它面板切换时会同步本按钮文字。 */
  function button(cls){
    var b = document.createElement('button');
    b.type = 'button';
    b.className = cls || 'btn btn-sm';
    b.setAttribute('data-rp-open-mode-btn', '1');
    b.title = '鼠标左键打开方式: 单击进入 / 双击进入 —— 点击切换 (双击模式下单击=选中, Ctrl 多选)';
    b.style.cssText = 'padding:1px 8px;font-size:10.5px;background:var(--bg2);color:var(--cyan);border:1px solid var(--cyan);white-space:nowrap';
    function paint(){
      var d = (get() === 'double');
      b.textContent = d ? '双击进入' : '单击进入';
      b.dataset.mode = d ? 'double' : 'single';
    }
    paint();
    b.onclick = function(){ set(get() === 'double' ? 'single' : 'double'); paint(); };
    try { g.addEventListener('rp-open-mode-changed', paint); } catch(e){}
    return b;
  }
  g.RPOpenMode = { get: get, set: set, isDbl: isDbl, select: select, button: button };
})(window);
