/* v4.95.0 · H 模块前端: croc 点对点 (Croc) + 传输可视化回放 (ReplayPanel)
 * Croc → panel-airgap 内嵌区; ReplayPanel → 系统设置·智能分析「🎬 传输回放」按钮
 */
(function(g){
  'use strict';

  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function $(id){ return document.getElementById(id); }
  function gv(id){ var e = $(id); return e ? e.value.trim() : ''; }

  function rpc(action, data){
    return new Promise(function(resolve){
      try { window.send(Object.assign({action: action}, data || {}), function(r){ resolve(r || {}); }); }
      catch(e){ resolve({status: 'error', msg: String(e)}); }
    });
  }
  function say(id, ok, msg){
    var el = $(id); if (!el) return;
    el.innerHTML = '<span style="color:' + (ok === null ? 'var(--text3)' : (ok ? 'var(--green)' : 'var(--red)')) + ';font-size:12px;white-space:pre-wrap">' + esc(msg || '') + '</span>';
  }
  function human(n){
    n = parseFloat(n || 0);
    if (n > 1073741824) return (n/1073741824).toFixed(2) + ' GB';
    if (n > 1048576) return (n/1048576).toFixed(1) + ' MB';
    if (n > 1024) return (n/1024).toFixed(1) + ' KB';
    return n + ' B';
  }

  /* ── croc 点对点 ── */
  async function send(){
    var path = gv('crocSendPath');
    if (!path){ toast('请填写发送路径', 'warn', 2000); return; }
    say('crocResult', null, '⏳ 启动发送…');
    var r = await rpc('croc_send', { path: path, code: gv('crocCode'), passphrase: gv('crocPass') });
    say('crocResult', r.status === 'ok', r.msg || '');
    refresh();
  }
  async function receive(){
    var code = gv('crocCode');
    if (!code){ toast('请填写接收码', 'warn', 2000); return; }
    say('crocResult', null, '⏳ 等待对端…');
    var r = await rpc('croc_receive', { code: code, out_dir: gv('crocOutDir') || '.', passphrase: gv('crocPass') });
    say('crocResult', r.status === 'ok', r.msg || '');
    refresh();
  }
  async function stop(name){
    await rpc('croc_stop', { name: name });
    refresh();
  }
  async function refresh(){
    var r = await rpc('croc_status', {});
    var box = $('crocProcs'); if (!box) return;
    if (r.status !== 'ok'){ box.innerHTML = ''; return; }
    var rows = r.procs || [];
    box.innerHTML = rows.length
      ? rows.map(function(x){
          return '<div style="display:flex;gap:8px;align-items:flex-start;padding:4px 8px;border:1px solid var(--line);border-radius:6px;margin-top:4px">' +
            '<span>' + (x.running ? '🟢' : '⚪') + ' <b>' + esc(x.name) + '</b></span>' +
            '<pre style="flex:1;margin:0;font-size:10px;color:var(--text3);white-space:pre-wrap;max-height:64px;overflow:auto">' + esc(x.tail || '') + '</pre>' +
            (x.running ? '<button class="btn btn-sm" style="padding:0 8px;font-size:10px" onclick="Croc.stop(\'' + esc(x.name) + '\')">⏹</button>' : '') +
            '</div>';
        }).join('')
      : '<div style="color:var(--text3);font-size:11px">无运行中的 croc 实例 · 对方机器需安装 croc (curl https://getcroc.schollz.com | bash)</div>';
  }

  /* ── 传输可视化回放 ── */
  var _events = [], _pos = 0, _timer = null, _playing = false;
  function open(){
    rpc('stats_replay', { days: 7 }).then(function(r){
      if (r.status !== 'ok'){ toast('✗ ' + (r.msg || '查询失败'), 'err', 2600); return; }
      _events = r.events || [];
      _pos = 0;
      var modal = $('replayModal');
      modal.style.display = 'flex';
      $('replayInfo').textContent = _events.length + ' 条传输记录 · 近 7 天 · 共 ' + human(r.total_bytes);
      renderAt(0);
      if (!_events.length) $('replayNow').textContent = '该时段没有传输记录';
      play();
    });
  }
  function renderAt(i){
    var tl = $('replayTimeline'); if (!tl) return;
    var evs = _events.slice(0, i + 1);
    var maxB = Math.max.apply(null, _events.map(function(e){ return e.bytes || 1; }).concat([1]));
    var h = '<div style="position:absolute;left:0;right:0;top:50%;height:2px;background:var(--line)"></div>';
    evs.forEach(function(e, idx){
      var x = Math.max(1, Math.min(98, (idx / Math.max(1, _events.length - 1)) * 100));
      var hpx = 10 + Math.round((e.bytes || 0) / maxB * 40);
      var col = e.status === 'ok' ? 'var(--cyan)' : (e.status === 'partial' ? 'var(--orange)' : 'var(--red)');
      h += '<div title="' + esc(e.ts + ' ' + e.kind + ' ' + human(e.bytes)) + '" style="position:absolute;left:' + x + '%;top:' + (60 - hpx / 2) +
        'px;width:6px;height:' + hpx + 'px;background:' + col + ';border-radius:3px;opacity:' + (idx === i ? 1 : 0.55) + (idx === i ? ';box-shadow:0 0 8px ' + col : '') + '"></div>';
    });
    var cur = _events[i] || null;
    if (cur){
      h += '<div style="position:absolute;left:8px;bottom:4px;font-size:10px;color:var(--text3)">起点: ' + esc(_events[0].ts) + '</div>';
    }
    tl.innerHTML = h;
    var nowEl = $('replayNow');
    if (cur){
      nowEl.textContent = cur.ts + ' · ' + cur.kind + ' · ' + human(cur.bytes) + ' · ' + (cur.files || 0) + ' 文件';
    }
    var seek = $('replaySeek'); if (seek) seek.value = String(Math.round(i / Math.max(1, _events.length - 1) * 100));
  }
  function play(){
    if (!_events.length){ toast('没有可回放的记录', 'warn', 2000); return; }
    _playing = true;
    var btn = $('replayBtn'); if (btn) btn.textContent = '⏸ 暂停';
    if (_timer) clearInterval(_timer);
    _timer = setInterval(function(){
      if (!_playing) return;
      if (_pos >= _events.length - 1){ pause(); return; }
      _pos++;
      renderAt(_pos);
    }, 350);
  }
  function pause(){
    _playing = false;
    var btn = $('replayBtn'); if (btn) btn.textContent = '▶ 播放';
    if (_timer){ clearInterval(_timer); _timer = null; }
  }
  function toggle(){ _playing ? pause() : play(); }
  function seek(v){
    pause();
    _pos = Math.round((parseInt(v, 10) || 0) / 100 * (_events.length - 1));
    renderAt(_pos);
  }
  function stop(){ pause(); }

  g.Croc = { send: send, receive: receive, stop: stop, refresh: refresh };
  g.ReplayPanel = { open: open, toggle: toggle, seek: seek, stop: stop };
  document.addEventListener('DOMContentLoaded', function(){
    setTimeout(function(){
      if (typeof window.currentUser !== 'undefined' && window.currentUser) refresh();
    }, 2400);
  });
})(window);
