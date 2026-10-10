/* v4.15.0-alpha2 · Servers/Tasks 编辑契约 dirty guard
 *
 * 补齐 v4.13.4 引入的 dirtyGuard 生态：让 transfer 面板的服务器配置与传输任务
 * 也参与全站切换前"未保存修改"提示。
 *
 * 契约接口（app.js 里 _dirtyGuardOK 会自动兜）：
 *   window.Servers.isDirty()   → bool
 *   window.Servers.save()      → 提交保存（尝试调 saveCurrentConfig）
 *   window.Servers.cancelEdit()→ 放弃（重置 snapshot 并触发 loadConfigToPanel）
 *
 *   window.Tasks.isDirty()     → bool
 *   window.Tasks.save()        → 手动保存 rsync 参数（复用 saveCurrentConfig）
 *   window.Tasks.cancelEdit()  → 重置 snapshot
 *
 * 只跟踪"当前面板 = transfer"的场景；切到其它面板不再拦截。
 */
(function(){
  'use strict';

  function q(id){ return document.getElementById(id); }
  function activePanel(){
    var p = document.querySelector('.panel.active');
    return p ? p.id.replace(/^panel-/, '') : '';
  }

  // ---------- Servers 契约（服务器连接 5 字段）----------
  var SERVER_IDS = ['srvHost','srvPort','srvUser','authType','authValue'];
  var _srvSnap = '';
  function _snapServers(){
    return SERVER_IDS.map(function(id){
      var el = q(id); return el ? (el.value || '') : '';
    }).join('|');
  }
  function _resetServerSnapshot(){ _srvSnap = _snapServers(); }

  window.Servers = {
    isDirty: function(){
      if (activePanel() !== 'transfer') return false;
      // 首次访问 · 建立基线
      if (!_srvSnap){ _srvSnap = _snapServers(); return false; }
      return _snapServers() !== _srvSnap;
    },
    save: function(){
      try {
        if (typeof window.saveCurrentConfig === 'function'){
          window.saveCurrentConfig();
          _resetServerSnapshot();
        } else {
          alert('保存函数未加载，请手动点『💾 保存配置』');
        }
      } catch(e){ console.warn('[Servers.save]', e); }
    },
    cancelEdit: function(){
      _resetServerSnapshot();
    },
    resetSnapshot: _resetServerSnapshot,
  };

  // ---------- Tasks 契约（传输参数：方向/路径/tags/bwlimit/exclude）----------
  var TASK_IDS = ['srcPath','dstPath','bwLimit','excludePat'];
  var _tskSnap = '';
  function _snapTasks(){
    var flags = [].map.call(document.querySelectorAll('.tag[data-flag]'), function(t){
      return (t.classList.contains('active') ? '+' : '-') + (t.getAttribute('data-flag') || '');
    }).join(',');
    var vals = TASK_IDS.map(function(id){
      var el = q(id); return el ? (el.value || '') : '';
    }).join('|');
    return (typeof window.direction === 'string' ? window.direction : '') + '||' + vals + '||' + flags;
  }
  function _resetTaskSnapshot(){ _tskSnap = _snapTasks(); }

  window.Tasks = {
    isDirty: function(){
      if (activePanel() !== 'transfer') return false;
      if (!_tskSnap){ _tskSnap = _snapTasks(); return false; }
      return _snapTasks() !== _tskSnap;
    },
    save: function(){
      try {
        if (typeof window.saveCurrentConfig === 'function'){
          window.saveCurrentConfig();
          _resetTaskSnapshot();
        }
      } catch(e){ console.warn('[Tasks.save]', e); }
    },
    cancelEdit: function(){
      _resetTaskSnapshot();
    },
    resetSnapshot: _resetTaskSnapshot,
  };

  // ---------- 初始化 · 建立首次 snapshot ----------
  function _initSnapshots(){
    // 首次访问 transfer 面板时 snap，避免刚打开就误判 dirty
    _resetServerSnapshot();
    _resetTaskSnapshot();
  }

  // 切到 transfer 面板时刷 snapshot
  document.addEventListener('DOMContentLoaded', function(){
    _initSnapshots();
    var oldSwitchTab = window.switchTab;
    if (typeof oldSwitchTab === 'function'){
      window.switchTab = function(t){
        var r = oldSwitchTab.apply(this, arguments);
        try {
          if (t === 'transfer'){
            // 让 selectConfig / loadConfigToPanel 有机会填值后再 snap
            setTimeout(_initSnapshots, 60);
          }
        } catch(e){ console.warn(e); }
        return r;
      };
    }
    // 载入配置后重建 snapshot
    var oldLoad = window.loadConfigToPanel;
    if (typeof oldLoad === 'function'){
      window.loadConfigToPanel = function(){
        var r = oldLoad.apply(this, arguments);
        setTimeout(_initSnapshots, 60);
        return r;
      };
    }
    // 保存后重建 snapshot
    var oldSave = window.saveCurrentConfig;
    if (typeof oldSave === 'function'){
      window.saveCurrentConfig = function(){
        var r = oldSave.apply(this, arguments);
        setTimeout(_initSnapshots, 60);
        return r;
      };
    }
  });
})();
