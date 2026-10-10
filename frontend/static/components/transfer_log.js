/* ============================================================================
 * transfer_log.js · v4.38.23
 * 操作日志组件：每三列一个独立实例，避免共享 log-area 互串
 *  - 工厂: TransferLog.create(hostEl, opts={scope})
 *  - 暴露: log(text, level) / clear() / setAutoScroll(bool) / el
 *  - 样式与现有 .log-area 一致
 * ========================================================================== */
(function(){
  'use strict';

  function create(hostEl, opts){
    opts = opts || {};
    var scope = opts.scope || 'transfer';
    var maxLines = opts.maxLines || 500;

    var box = document.createElement('div');
    box.className = 'tl-log';
    box.setAttribute('data-scope', scope);
    box.style.cssText = 'margin-top:8px;border:1px solid var(--border);border-radius:6px;background:var(--bg1);font-size:11.5px';

    box.innerHTML =
      '<div style="display:flex;align-items:center;gap:6px;padding:4px 10px;border-bottom:1px solid var(--border);background:var(--bg2)">' +
        '<span style="color:var(--text2);flex:1;font-weight:600">📋 操作日志</span>' +
        '<span class="tl-log-count" style="color:var(--text3);font-size:10px">0 行</span>' +
        '<button class="btn btn-sm tl-log-clear" style="padding:1px 8px;font-size:11px" title="清空当前日志">🧹 清空</button>' +
        '<label style="font-size:10px;color:var(--text3);cursor:pointer;display:flex;align-items:center;gap:3px">' +
          '<input type="checkbox" class="tl-log-auto" checked> 自动滚动' +
        '</label>' +
      '</div>' +
      '<div class="tl-log-body" style="max-height:200px;overflow:auto;padding:6px 10px;font-family:monospace;color:var(--text2);line-height:1.55"></div>';

    hostEl.appendChild(box);

    var bodyEl = box.querySelector('.tl-log-body');
    var countEl = box.querySelector('.tl-log-count');
    var clearBtn = box.querySelector('.tl-log-clear');
    var autoEl = box.querySelector('.tl-log-auto');

    function _ts(){
      var d = new Date();
      return [d.getHours(), d.getMinutes(), d.getSeconds()]
        .map(function(n){ return String(n).padStart(2,'0'); })
        .join(':');
    }

    function log(text, level){
      if (text == null) return;
      var line = String(text);
      if (!line.trim()) return;
      var lvl = level || 'info';
      var colorMap = {
        ok:'var(--green)', success:'var(--green)',
        err:'var(--red)', error:'var(--red)',
        warn:'var(--yellow)', warning:'var(--yellow)',
        info:'var(--cyan)', dim:'var(--text3)',
      };
      var iconMap = {
        ok:'✓', success:'✓',
        err:'✗', error:'✗',
        warn:'⚠', warning:'⚠',
        info:'·', dim:'·',
      };
      var d = document.createElement('div');
      d.className = 'log-line ' + lvl;
      d.style.cssText = 'color:'+(colorMap[lvl]||'var(--text2)');
      d.textContent = '[' + _ts() + '] ' + (iconMap[lvl]||'·') + ' ' + line;
      bodyEl.appendChild(d);
      // 上限
      while (bodyEl.childElementCount > maxLines){
        bodyEl.removeChild(bodyEl.firstChild);
      }
      countEl.textContent = bodyEl.childElementCount + ' 行';
      // v4.38.26 · 同步外部徽标 (transferLogCount)
      try { if (typeof window.updateTransferLogCount === 'function') window.updateTransferLogCount(bodyEl.childElementCount); } catch(_){}
      // v4.38.27 · 同步 dm 日志徽标 (dmLogBadgeInline + dmLogCount)
      try {
        if (scope === 'disk_manager' || scope === 'dm'){
          if (typeof window.updateDmLogCount === 'function') window.updateDmLogCount(bodyEl.childElementCount);
        }
      } catch(_){}
      if (autoEl.checked) bodyEl.scrollTop = bodyEl.scrollHeight;
    }

    function clear(){
      bodyEl.innerHTML = '';
      countEl.textContent = '0 行';
    }

    function setAutoScroll(v){
      autoEl.checked = !!v;
    }

    clearBtn.onclick = clear;

    // 初次插入"等待操作..."
    log('操作日志已就绪 (scope=' + scope + ')', 'dim');

    return { log: log, clear: clear, setAutoScroll: setAutoScroll, el: box };
  }

  // v4.38.28 · 静态 append: DiskManager._log 不用持有实例句柄, 直接走 scope
  //   - scope='disk_manager' 或 'dm' 才发 (其他 scope 不属于本组件)
  //   - 如果该 scope 已有实例, 直接 log; 否则缓存到 pendingLog, 待实例创建时 replay
  var _pendingLog = {};
  function append(scope, text, level){
    scope = scope || 'dm';
    if (scope !== 'disk_manager' && scope !== 'dm') return;
    if (window._dmLog && typeof window._dmLog.log === 'function'){
      window._dmLog.log(text, level);
    } else {
      _pendingLog[scope] = _pendingLog[scope] || [];
      _pendingLog[scope].push([text, level || 'info']);
    }
  }
  function flushPending(scope){
    var arr = _pendingLog[scope];
    if (!arr) return;
    if (window._dmLog && typeof window._dmLog.log === 'function'){
      for (var i=0;i<arr.length;i++) window._dmLog.log(arr[i][0], arr[i][1]);
    }
    _pendingLog[scope] = [];
  }
  window.TransferLog = { create: create, append: append, flushPending: flushPending };
})();
