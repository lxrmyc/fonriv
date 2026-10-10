/* v4.19.0 · EventLog · 全局事件流（内嵌到「传输日志」面板 · 主题订阅）
 *
 * 特性：
 *   · localStorage 记忆开关状态（rp_evlog_enabled）
 *   · 关闭时：不订阅 · 不缓冲 · 面板显示提示 · 面板隐藏时无副作用
 *   · 启用时：订阅 * · 环形缓冲 500 条 · 主题过滤 · 暂停 · 导出 JSON
 *   · 分组配色（flow/schedule/retention/user/remote/pve/platform/system 不同头色）
 *
 * v4.19.0 · 内嵌 panel-log 页面 + 用户可开关（替代之前的悬浮抽屉）
 * v4.19.1 · 后端持久缓冲（暂未实装 · rpc:event_log_recent 占位）
 * v4.19.2/3 · 见 event_bus 侧改动
 */
(function(){
  'use strict';

  var LS_KEY = 'rp_evlog_enabled';
  var MAX_ROWS = 500;
  var _buf = [];
  var _paused = false;
  var _filter = '';
  var _since = 0;         // v4.21.0 · 时间范围（秒 · 0=全部）
  var _enabled = false;
  var _handler = null;   // EventBus 上注册的 handler 引用（便于 off）

  function _esc(s){
    return String(s).replace(/[&<>"']/g, function(c){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
    });
  }

  function _tsShort(d){
    var pad = function(n){ return n<10 ? '0'+n : ''+n; };
    return pad(d.getHours())+':'+pad(d.getMinutes())+':'+pad(d.getSeconds());
  }

  function _topicColor(topic){
    if (topic.indexOf('flow.') === 0) return '#58a6ff';
    if (topic.indexOf('schedule.') === 0) return '#d29922';
    if (topic.indexOf('retention.') === 0) return '#bc8cff';
    if (topic.indexOf('user.') === 0) return '#f778ba';
    if (topic.indexOf('remote.') === 0) return '#3fb950';
    if (topic.indexOf('pve.') === 0) return '#ff7b72';
    if (topic.indexOf('platform.') === 0) return '#ffa657';
    if (topic.indexOf('system.') === 0) return '#8b949e';
    if (topic.indexOf('bandwidth.') === 0) return '#79c0ff';
    if (topic.indexOf('audit.') === 0) return '#e3b341';  // v4.21.0
    if (topic.indexOf('task.') === 0) return '#56d4dd';
    if (topic.indexOf('storage.') === 0) return '#a5d6ff';
    if (topic.indexOf('download.') === 0) return '#a5d6ff';
    return '#c9d1d9';
  }

  function _readPref(){
    try { return localStorage.getItem(LS_KEY) === '1'; }
    catch(e){ return false; }
  }
  function _writePref(v){
    try { localStorage.setItem(LS_KEY, v ? '1' : '0'); } catch(e){}
  }

  function _getEl(id){ return document.getElementById(id); }

  function _updateUI(){
    var chk = _getEl('evLogEnabled');
    if (chk) chk.checked = _enabled;
    ['evLogFilter','evLogPause','evLogExport','evLogClear','evLogSince'].forEach(function(id){
      var el = _getEl(id);
      if (el) el.disabled = !_enabled;
    });
    var empty = _getEl('evLogEmpty');
    var list = _getEl('evLogList');
    var cnt = _getEl('evLogCount');
    if (!_enabled){
      if (empty) empty.style.display = 'block';
      if (list){ list.style.display = 'none'; list.innerHTML = ''; }
      if (cnt) cnt.textContent = '未启用';
      return;
    }
    if (empty) empty.style.display = 'none';
    if (list) list.style.display = 'block';
    _render();
  }

  function _globToRe(g){
    var re = '^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&')
                    .replace(/\*/g, '.*').replace(/\?/g, '.') + '$';
    try { return new RegExp(re, 'i'); } catch(e){ return null; }
  }

  function _matchFilter(topic){
    if (!_filter) return true;
    // v4.21.0 · 逗号分隔 → OR；! 前缀 → 排除；* ? 通配；纯文本 → substring
    var parts = _filter.split(',').map(function(s){ return s.trim(); }).filter(Boolean);
    if (!parts.length) return true;
    var incs = [], excs = [];
    parts.forEach(function(p){
      if (p.charAt(0) === '!') excs.push(p.slice(1));
      else incs.push(p);
    });
    // 排除优先
    for (var i=0; i<excs.length; i++){
      var ex = excs[i];
      if (ex.indexOf('*')>=0 || ex.indexOf('?')>=0){
        var reE = _globToRe(ex); if (reE && reE.test(topic)) return false;
      } else if (topic.toLowerCase().indexOf(ex.toLowerCase()) >= 0) return false;
    }
    // 包含（OR）
    if (!incs.length) return true;
    for (var j=0; j<incs.length; j++){
      var it = incs[j];
      if (it.indexOf('*')>=0 || it.indexOf('?')>=0){
        var reI = _globToRe(it); if (reI && reI.test(topic)) return true;
      } else if (topic.toLowerCase().indexOf(it.toLowerCase()) >= 0) return true;
    }
    return false;
  }

  function _updateTopicList(){
    var dl = _getEl('evLogTopics');
    if (!dl) return;
    var seen = {};
    // 常见主题前缀 + buf 里已见的主题
    ['flow.*','schedule.*','retention.*','user.*','remote.*','pve.*',
     'platform.*','system.*','task.*','remote.upload.*','storage.download.*',
     'storage.upload.*','download.*']
      .forEach(function(t){ seen[t] = 1; });
    _buf.forEach(function(r){ seen[r.topic] = 1; });
    dl.innerHTML = Object.keys(seen).sort().map(function(t){
      return '<option value="'+_esc(t)+'">';
    }).join('');
  }

  function _render(){
    var list = _getEl('evLogList');
    var cnt = _getEl('evLogCount');
    if (!list || !_enabled) return;
    _updateTopicList();
    // v4.21.0 · 时间范围过滤
    var cutoff = _since > 0 ? (Date.now() - _since * 1000) : 0;
    var rows = _buf.filter(function(r){
      if (cutoff && r.ts.getTime() < cutoff) return false;
      return _matchFilter(r.topic);
    });
    if (cnt){
      cnt.textContent = '显示 ' + rows.length + ' / 缓冲 ' + _buf.length + '/' + MAX_ROWS
                      + (_paused ? ' · ⏸ 已暂停' : '');
    }
    list.innerHTML = rows.slice(-200).reverse().map(function(r, i){
      var color = _topicColor(r.topic);
      var payloadStr = '';
      var payloadFull = '';
      try {
        payloadStr = JSON.stringify(r.payload);
        payloadFull = JSON.stringify(r.payload, null, 2);
      } catch(e){ payloadStr = String(r.payload); payloadFull = payloadStr; }
      var short = payloadStr;
      if (short && short.length > 200) short = short.slice(0, 200) + '…';
      return '<div class="evrow" data-idx="'+i+'" style="padding:3px 6px;border-bottom:1px solid rgba(255,255,255,.04);cursor:pointer">'
        + '<span style="color:var(--text3)">' + _esc(_tsShort(r.ts)) + '</span> '
        + '<span style="color:' + color + ';font-weight:600">' + _esc(r.topic) + '</span> '
        + '<span style="color:var(--text2)">' + _esc(short) + '</span>'
        + '<pre class="evfull" style="display:none;margin:4px 0 4px 20px;padding:6px 10px;background:var(--bg1);border-radius:4px;color:var(--text2);white-space:pre-wrap;word-break:break-all;font-size:11px">'
        + _esc(payloadFull) + '</pre>'
        + '</div>';
    }).join('');
    // 事件委托：点击行切换展开
    if (!list._clickWired){
      list._clickWired = true;
      list.addEventListener('click', function(ev){
        var row = ev.target.closest('.evrow');
        if (!row) return;
        var pre = row.querySelector('.evfull');
        if (pre) pre.style.display = (pre.style.display === 'none') ? 'block' : 'none';
      });
    }
  }

  function _push(topic, payload){
    if (!_enabled || _paused) return;
    _buf.push({ ts: new Date(), topic: topic, payload: payload });
    if (_buf.length > MAX_ROWS) _buf = _buf.slice(-MAX_ROWS);
    // 面板可见时即时刷；不可见时下次打开自动 render
    var panel = _getEl('panel-log');
    if (panel && panel.classList.contains('active')) _render();
  }

  function setEnabled(v){
    v = !!v;
    if (v === _enabled) return;
    _enabled = v;
    _writePref(v);
    if (v){
      // 订阅（首次订阅会通知后端）
      if (!_handler){
        _handler = function(topic, payload){ _push(topic, payload); };
        if (window.EventBus) window.EventBus.on('*', _handler);
      }
      // v4.19.1 · 拉一次后端保留的最近事件（如果后端支持）
      try {
        if (window.send){
          window.send({ action: 'event_log_recent', limit: 100 }, function(r){
            if (r && r.status === 'ok' && Array.isArray(r.events)){
              r.events.forEach(function(e){
                // 后端 ts 是 unix 秒（float），转 JS ms
                var tms = e.ts ? (e.ts > 1e12 ? e.ts : e.ts * 1000) : Date.now();
                _buf.push({ ts: new Date(tms), topic: e.topic, payload: e.payload });
              });
              if (_buf.length > MAX_ROWS) _buf = _buf.slice(-MAX_ROWS);
              _render();
            }
          });
        }
      } catch(e){}
    } else {
      // 取消订阅 + 清缓冲
      if (_handler && window.EventBus){
        window.EventBus.off(_handler);
      }
      _handler = null;
      _buf = [];
      _paused = false;
    }
    _updateUI();
  }

  function _wireControls(){
    var filter = _getEl('evLogFilter');
    if (filter && !filter._wired){
      filter._wired = true;
      filter.oninput = function(){
        // 保留大小写与通配符原样（匹配处会做 case-insensitive）
        _filter = this.value.trim();
        _render();
      };
    }
    var pause = _getEl('evLogPause');
    if (pause && !pause._wired){
      pause._wired = true;
      pause.onclick = function(){
        _paused = !_paused;
        this.textContent = _paused ? '▶ 继续' : '⏸ 暂停';
        _render();
      };
    }
    var clear = _getEl('evLogClear');
    if (clear && !clear._wired){
      clear._wired = true;
      clear.onclick = function(){
        _buf = [];
        _render();
      };
    }
    var exp = _getEl('evLogExport');
    if (exp && !exp._wired){
      exp._wired = true;
      exp.onclick = function(){
        try {
          var data = _buf.map(function(r){
            return { ts: r.ts.toISOString(), topic: r.topic, payload: r.payload };
          });
          // v4.19.3 · Shift+点 → Markdown 表格；否则 JSON
          if (window.event && window.event.shiftKey){
            var md = '| 时间 | 主题 | Payload |\n|---|---|---|\n';
            data.forEach(function(r){
              var p = JSON.stringify(r.payload).replace(/\|/g,'\\|');
              md += '| ' + r.ts + ' | `' + r.topic + '` | `' + p + '` |\n';
            });
            _download(md, 'event_log_' + Date.now() + '.md', 'text/markdown');
          } else {
            _download(JSON.stringify(data, null, 2),
                      'event_log_' + new Date().toISOString().replace(/[:.]/g,'-') + '.json',
                      'application/json');
          }
        } catch(e){ alert('导出失败: '+e); }
      };
      exp.title = '导出 JSON（Shift+点导出 Markdown）';
    }
    // v4.21.0 · 时间范围下拉
    var since = _getEl('evLogSince');
    if (since && !since._wired){
      since._wired = true;
      since.onchange = function(){
        _since = parseInt(this.value, 10) || 0;
        _render();
      };
    }
  }

  function _download(text, filename, mime){
    var blob = new Blob([text], {type: mime});
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(function(){ URL.revokeObjectURL(a.href); a.remove(); }, 100);
  }

  window.EventLog = {
    setEnabled: setEnabled,
    isEnabled: function(){ return _enabled; },
    push: _push,   // 兼容旧 API
  };

  function _init(){
    if (!window.EventBus){ setTimeout(_init, 100); return; }
    _wireControls();
    // 恢复上次的开关状态
    var want = _readPref();
    if (want){
      setEnabled(true);
    } else {
      _enabled = false;
      _updateUI();
    }
    // 每次进入 panel-log 时补一次 UI（可能是首次渲染）
    var log = _getEl('panel-log');
    if (log){
      // 简单 MutationObserver：class 变化时重刷
      new MutationObserver(function(){
        if (log.classList.contains('active')){
          _wireControls();
          _updateUI();
        }
      }).observe(log, { attributes:true, attributeFilter:['class'] });
    }
  }
  if (document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', _init);
  } else {
    _init();
  }
})();
