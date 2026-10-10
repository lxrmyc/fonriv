/* v5.19.0 · 后台服务管理 (设置页): 状态查询 + 一键重启
 * 依赖 window.send / toast · 后端 service_status / service_restart
 */
(function(g){
  'use strict';
  function $(id){ return document.getElementById(id); }
  function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function rpc(action, data){
    return new Promise(function(resolve){
      try { g.send(Object.assign({action: action}, data || {}), function(r){ resolve(r || {}); }); }
      catch(e){ resolve({status: 'error', msg: String(e)}); }
    });
  }
  function say(ok, msg){
    var el = $('svcMsg'); if (!el) return;
    el.style.color = ok === null ? 'var(--text3)' : (ok ? 'var(--green)' : 'var(--red)');
    el.textContent = msg || '';
  }
  async function refresh(){
    var badge = $('svcStatusBadge'), body = $('svcStatusBody');
    if (badge) badge.textContent = '查询中…';
    var r = await rpc('service_status', {});
    if (r.status !== 'ok'){
      if (badge){ badge.textContent = '⚠ 不可用'; badge.style.color = 'var(--orange)'; }
      if (body) body.innerHTML = '<span style="color:var(--orange)">' + esc(r.msg || '查询失败') + '</span>';
      return;
    }
    var active = (r.active_state === 'active');
    if (badge){
      badge.textContent = (active ? '● 运行中' : ('○ ' + (r.active_state || '未知')));
      badge.style.color = active ? 'var(--green)' : 'var(--red)';
    }
    if (body){
      body.innerHTML =
        '服务单元: <b style="font-family:monospace">' + esc(r.unit) + '</b>'
        + ' · 主进程 PID <b>' + esc(r.pid || '-') + '</b>'
        + (r.uptime ? (' · 已运行 <b>' + esc(r.uptime) + '</b>') : '')
        + '<br>启动时间: ' + esc(r.since || '-')
        + (r.restarts && r.restarts !== '0' ? (' · <span style="color:var(--orange)">自动重启 ' + esc(r.restarts) + ' 次</span>') : '');
    }
  }
  function restart(){
    var go = async function(){
      say(null, '⏳ 正在下发重启指令…');
      var r = await rpc('service_restart', { unit: 'fonriv', delay: 2 });
      if (r.status === 'ok'){
        say(true, r.msg || '✓ 已下发重启指令');
        if (g.toast) g.toast('🔁 后台服务重启中 — 约 10 秒后请刷新页面', 'success', 8000);
        // 轮询探测服务恢复 (最多 60s)
        var n = 0;
        var iv = setInterval(function(){
          n++;
          fetch('/api/version?_=' + Date.now(), { cache: 'no-store' })
            .then(function(x){ return x.ok ? x.json() : null; })
            .then(function(d){
              if (d && d.version){
                clearInterval(iv);
                say(true, '✓ 服务已恢复 (v' + d.version + ') — 请刷新页面');
                if (g.toast) g.toast('✓ 服务已恢复 v' + d.version, 'success', 5000);
                refresh();
              }
            })
            .catch(function(){});
          if (n > 30) clearInterval(iv);
        }, 2000);
      } else {
        say(false, '✗ ' + (r.msg || '重启失败'));
      }
    };
    if (typeof g._showC2Modal === 'function'){
      g._showC2Modal({
        title: '⚠ 重启后台服务',
        body: '将重启 fonriv 服务:\n· 所有连接会短暂断开 (约 5~15 秒)\n· 正在进行的传输任务会被中断\n· 服务恢复后需要刷新页面\n\n确定继续?',
        danger: true, okText: '重启',
        onOk: go,
      });
    } else if (g.confirm && g.confirm('确定重启后台服务? 传输中的任务会被中断。')){ go(); }
  }
  g.SvcMgmt = { refresh: refresh, restart: restart };
  document.addEventListener('DOMContentLoaded', function(){
    setTimeout(function(){
      try { if (typeof window.currentUser !== 'undefined' && window.currentUser) refresh(); } catch(e){}
    }, 2400);
  });
})(window);
