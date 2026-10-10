/* v5.19.1 · 核心运行状况 (Transfer Fabric 可视化 · 第一期)
 * 板块: 核心概览 / 端点与连接 / 宿主机资源 / 任务健康 / 容错回退
 * 依赖: window.send, backend/core_fabric/vitals.py + resilience.py
 */
(function(g){
  'use strict';
  function $(id){ return document.getElementById(id); }
  function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function toast(m,k,ms){ if (typeof g.toast==='function') g.toast(m,k,ms||2800); }
  function rpc(action, data, t){
    return new Promise(function(resolve){
      try {
        var done = false;
        var timer = setTimeout(function(){ if (!done){ done = true; resolve({status:'error', msg:'请求超时'}); } }, t || 60000);
        g.send(Object.assign({action: action}, data || {}), function(r){
          if (done) return; done = true; clearTimeout(timer); resolve(r || {});
        });
      } catch(e){ resolve({status:'error', msg:String(e)}); }
    });
  }
  function fmtB(n){
    n = Number(n)||0;
    var u=['B','KB','MB','GB','TB'], i=0;
    while (n>=1024 && i<u.length-1){ n/=1024; i++; }
    return (i? n.toFixed(1): n) + ' ' + u[i];
  }
  function bar(pct, color){
    pct = Math.max(0, Math.min(100, Number(pct)||0));
    var c = color || (pct>=90 ? 'var(--red)' : (pct>=75 ? 'var(--orange)' : 'var(--green)'));
    return '<div style="height:8px;background:var(--bg4);border-radius:4px;overflow:hidden;min-width:90px">'+
      '<div style="height:100%;width:'+pct+'%;background:'+c+'"></div></div>';
  }
  function card(inner, extra){
    return '<div style="border:1px solid var(--border);border-radius:8px;padding:10px 12px;background:var(--bg)">'+inner+'</div>';
  }
  function kv(k, v, color){
    return '<div style="display:flex;gap:8px;font-size:12px;line-height:1.9">'+
      '<span style="color:var(--text3);min-width:92px">'+esc(k)+'</span>'+
      '<span style="color:'+(color||'var(--text2)')+';word-break:break-all">'+v+'</span></div>';
  }

  var _tab = 'overview';
  var _loaded = {};

  function tab(name){
    _tab = name;
    ['overview','endpoints','host','tasks','resilience','engines','security','plugins'].forEach(function(k){
      var el = $('csTab-' + k);
      if (el) el.style.display = (k === name) ? '' : 'none';
    });
    document.querySelectorAll('[data-cstab]').forEach(function(b){
      b.classList.toggle('active', b.getAttribute('data-cstab') === name);
    });
    if (!_loaded[name]) loadTab(name);
    // v5.82.0 · 品牌名设置已移除, 引擎页不再加载品牌输入   // 品牌输入挂在引擎页旁 (仅首次)
  }

  function loadTab(name){
    _loaded[name] = true;
    if (name === 'overview') return loadOverview();
    if (name === 'endpoints') return loadEndpoints();
    if (name === 'host') return loadHost();
    if (name === 'tasks') return loadTasks();
    if (name === 'resilience') return loadResilience();
    if (name === 'engines') return loadEngines();
    if (name === 'security') return loadSecurity();
    if (name === 'plugins') return loadPlugins();
  }

  /* v1.0.0 · i18n: 服务运行时长 —— 后端给 uptime_sec, 这里按界面语言成文 */
  function _upTxt(svc){
    var s = svc && svc.uptime_sec;
    if (s == null) return esc((svc && svc.uptime) || '-');
    var d = Math.floor(s / 86400), hh = Math.floor((s % 86400) / 3600), mm = Math.floor((s % 3600) / 60);
    var en = (typeof currentLang === 'function') && currentLang() === 'en';
    if (en) return d ? (d + 'd ' + hh + 'h') : (hh ? (hh + 'h ' + mm + 'm') : (mm + 'm'));
    return d ? (d + '天 ' + hh + '小时') : (hh + '小时 ' + mm + '分');
  }

  /* ── 顶部结论 + 告警 ── */
  async function loadSelfcheck(){
    var box = $('csConclusion'), alertsBox = $('csAlerts');
    if (box) box.innerHTML = '<span style="color:var(--text3)">⏳ 自检中…</span>';
    var r = await rpc('vitals_selfcheck', {}, 90000);
    if (!box) return;
    if (r.status !== 'ok'){
      box.innerHTML = '<span style="color:var(--red)">✗ ' + esc(r.msg || '自检失败') + '</span>';
      return;
    }
    var c = r.conclusion || 'ok';
    var cl = c === 'ok' ? 'var(--green)' : (c === 'warn' ? 'var(--orange)' : 'var(--red)');
    var icon = c === 'ok' ? '🟢 系统正常' : (c === 'warn' ? '🟡 有告警' : '🔴 存在问题');
    var svc = r.service || {};
    var disks = r.disk_usage || {};
    box.innerHTML =
      '<span style="color:'+cl+';font-weight:700;font-size:13px">'+icon+'</span>'+
      '<span style="color:var(--text3)">服务</span><span style="color:var(--text2)">'+esc(svc.unit||'-')+' · '+esc(svc.active||'?')+
        (svc.uptime ? (' · ' + (typeof t === 'function' ? t('已运行') : '已运行') + ' ' + _upTxt(svc)) : '')+'</span>'+
      '<span style="color:var(--text3)">实例</span><span style="color:var(--text2);font-family:monospace">'+esc(r.instance_id||'-')+'</span>'+
      '<span style="color:var(--text3)">日志占用</span><span style="color:var(--text2)">'+fmtB(disks.runs_bytes)+' / '+disks.runs_files+' 文件</span>'+
      '<span style="flex:1"></span>'+
      '<button class="btn btn-sm" onclick="CoreStatus.refreshAll()">↻ 重新自检</button>';
    if (alertsBox){
      var al = r.alerts || [];
      alertsBox.innerHTML = al.length
        ? al.map(function(a){
            var col = a.level === 'err' ? 'var(--red)' : 'var(--orange)';
            /* v1.0.0 · i18n: 挂载点/原始版本串等**数据**前缀渲染, 可翻译的固定文案只放 msg */
            return '<div style="padding:5px 10px;border-left:3px solid '+col+';background:var(--bg3);border-radius:5px;margin-bottom:4px;font-size:12px">'+
              '<b style="color:'+col+'">'+esc(a.item||'')+'</b> <span style="color:var(--text2)">'+
              (a.mount ? (esc(a.mount)+' ') : '') + (a.extra ? (esc(a.extra)+' ') : '') +
              esc(a.msg||'')+'</span></div>';
          }).join('')
        : '<div style="font-size:12px;color:var(--green)">✓ 无告警</div>';
    }
  }

  /* ── 板块1: 核心概览 ── */
  async function loadOverview(){
    var box = $('csOverview');
    if (box) box.innerHTML = '<div style="color:var(--text3);font-size:12px">⏳ 读取…</div>';
    var r = await rpc('vitals_overview', {});
    if (!box) return;
    if (r.status !== 'ok'){ box.innerHTML = '<div style="color:var(--red);font-size:12px">✗ '+esc(r.msg||'失败')+'</div>'; return; }
    var h = '';
    // 统计卡
    h += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;margin-bottom:12px">';
    [[r.module_count, '核心模块', 'core_fabric/*.py'],
     [r.kind_count, '端点类型', '统一 Endpoint 抽象'],
     [(r.engines||[]).length, '引擎注册', '含规划中项'],
     [r.actions_total, 'WS 动作总数', '含页面与后台动作'],
     [r.routes_total, '路由条目', 'ROUTE_NO_TASK + TASK'],
     [r.jobs_registered, 'schema 注册', '带参数校验的 job'],
     [r.feature_groups, '功能分组', 'features.json']].forEach(function(x){
      h += card('<div style="font-size:22px;font-weight:700;color:var(--cyan)">'+esc(String(x[0]))+'</div>'+
                '<div style="font-size:12px">'+esc(x[1])+'</div>'+
                '<div style="font-size:10px;color:var(--text3)">'+esc(x[2])+'</div>');
    });
    h += '</div>';
    // v5.35.0 · 连接中心实时状态卡 (档案/会话/保险库/分组 — 新架构核心指标)
    try {
      var pr = await rpc('sp_list', {}), cs = await rpc('conn_list', {}), cv = await rpc('cred_list', {});
      if (pr.status === 'ok'){
        var _ps = pr.profiles || [];
        var _on = _ps.filter(function(p){ return p.status === 'online'; }).length;
        var _conn = (cs.sessions || []).filter(function(s){ return s.state === 'connected'; }).length;
        var _star = _ps.filter(function(p){ return p.is_starred; }).length;
        h += '<div style="font-size:11px;color:var(--text3);margin:8px 0 4px">🔌 连接中心 (单一真相源架构)</div>';
        h += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px">';
        h += card('<div style="font-size:22px;font-weight:700;color:var(--cyan)">'+_ps.length+'</div><div style="font-size:12px">服务器档案</div><div style="font-size:10px;color:var(--text3)">server_profiles · '+esc(String((pr.groups||[]).length))+' 分组</div>');
        h += card('<div style="font-size:22px;font-weight:700;color:'+(_on?'var(--green)':'var(--text3)')+'">'+_on+'</div><div style="font-size:12px">在线 / 探测</div><div style="font-size:10px;color:var(--text3)">健康巡检 + sp_probe</div>');
        h += card('<div style="font-size:22px;font-weight:700;color:'+(_conn?'var(--green)':'var(--text3)')+'">'+_conn+'</div><div style="font-size:12px">活跃会话</div><div style="font-size:10px;color:var(--text3)">ControlMaster 复用</div>');
        h += card('<div style="font-size:22px;font-weight:700;color:var(--cyan)">'+((cv.creds||[]).length)+'</div><div style="font-size:12px">保险库凭据</div><div style="font-size:10px;color:var(--text3)">Fernet 共享凭据</div>');
        h += card('<div style="font-size:22px;font-weight:700;color:#f5c518">'+_star+'</div><div style="font-size:12px">⭐ 星标服务器</div><div style="font-size:10px;color:var(--text3)">多层分组树</div>');
        h += '</div>';
        // v5.37.0 · 传输活动完整卡 (所有页面传输会话, 与侧栏同源事件总线)
        try {
          var tm = window.TransferMonitor && window.TransferMonitor.summary();
          if (tm){
            var _act = tm.active || [];
            h += '<div style="font-size:11px;color:var(--text3);margin:8px 0 4px">📡 传输活动 (全部页面实时聚合)</div>';
            h += '<div style="border:1px solid var(--border);border-radius:8px;overflow:hidden">';
            if(!_act.length){
              h += '<div style="padding:10px;font-size:11px;color:var(--text3)">当前无活跃传输 — 任意页面发起传输后此处实时显示</div>';
            } else {
              h += '<table style="width:100%;border-collapse:collapse;font-size:11.5px"><thead><tr style="background:var(--bg3)">'
                + '<th style="text-align:left;padding:5px 8px">类型</th><th style="text-align:left;padding:5px 8px">用户</th>'
                + '<th style="text-align:left;padding:5px 8px">当前文件</th><th style="width:120px;padding:5px 8px">进度</th>'
                + '<th style="text-align:right;padding:5px 8px">速度</th></tr></thead><tbody>';
              _act.forEach(function(s){
                h += '<tr style="border-top:1px dashed var(--border)">'
                  + '<td style="padding:5px 8px;font-weight:600">'+String(s.name).split('<').join('&lt;')+'</td>'
                  + '<td style="padding:5px 8px;color:var(--text3)">'+String(s.user||'-').split('<').join('&lt;')+'</td>'
                  + '<td style="padding:5px 8px;font-family:monospace;font-size:10.5px;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+String(s.file||'').split('"').join('&quot;')+'">'+String(s.file||s.text||'-').split('<').join('&lt;')+'</td>'
                  + '<td style="padding:5px 8px"><div style="display:flex;align-items:center;gap:6px"><div style="flex:1;height:4px;background:var(--bg3);border-radius:2px;overflow:hidden"><div style="height:100%;background:var(--cyan);width:'+(s.pct||0)+'%"></div></div><span style="font-size:10px">'+Math.round(s.pct||0)+'%</span></div></td>'
                  + '<td style="padding:5px 8px;text-align:right;color:var(--cyan)">'+(s.speed||'-')+'</td></tr>';
              });
              h += '</tbody></table>';
            }
            h += '</div>';
          }
        } catch(e) { console.warn('[core_status] transfer card fail', e); }
      }
    } catch(e) { console.warn('[core_status] connhub card fail', e); }
    // v5.56.0 C1 · 流式预览/播放在途流量与并发 (阶段C 带宽治理可观测量)
    try {
      var _st = await rpc('fonr_stream_stats', {});
      if (_st && _st.status === 'ok'){
        var _fb = function(n){ n = +n || 0; var u = ['B','KB','MB','GB','TB'], i = 0;
          while (n >= 1024 && i < u.length - 1){ n /= 1024; i++; } return (n < 10 ? n.toFixed(1) : Math.round(n)) + u[i]; };
        h += '<div style="font-size:11px;color:var(--text3);margin:14px 0 6px">🎬 流式预览流量 (后端中转字节 · 并发闸)</div>';
        h += '<table style="width:100%;border-collapse:collapse;font-size:12px">'
          + '<tr><td style="padding:4px 8px;color:var(--text3)">并发上限</td>'
          + '<td style="padding:4px 8px">' + (_st.limit ? (_st.limit + ' 路') : '不限') + '</td>'
          + '<td style="padding:4px 8px;color:var(--text3)">当前在途</td>'
          + '<td style="padding:4px 8px;color:' + ((_st.in_flight || 0) ? 'var(--cyan)' : 'var(--text3)') + '">'
          + (_st.in_flight || 0) + ' 路 · ' + _fb(_st.in_flight_bytes) + '</td></tr>'
          + '<tr><td style="padding:4px 8px;color:var(--text3)">累计中转</td>'
          + '<td style="padding:4px 8px">' + _fb(_st.bytes_total) + ' / ' + (_st.opened || 0) + ' 次</td>'
          + '<td style="padding:4px 8px;color:var(--text3)">峰值 / 拒绝</td>'
          + '<td style="padding:4px 8px">' + (_st.peak || 0) + ' 路 / <span style="color:'
          + ((_st.rejected || 0) ? 'var(--yellow)' : 'var(--text3)') + '">' + (_st.rejected || 0) + ' 次</span></td></tr>'
          + '</table>';
      }
    } catch(e) { console.warn('[core_status] stream card fail', e); }
    // 分层架构
    h += '<div style="font-size:11px;color:var(--text3);margin:6px 0 6px">分层架构 (每层为真实模块, ✗ 表示文件缺失)</div>';
    h += '<table style="width:100%;border-collapse:collapse;font-size:12px">';
    (r.layers||[]).forEach(function(L, i){
      h += '<tr style="border-bottom:1px dashed var(--border)">'+
        '<td style="padding:5px 8px;width:26px;color:var(--text3)">'+i+'</td>'+
        '<td style="padding:5px 8px;font-weight:600;color:'+(L.ok?'var(--text)':'var(--red)')+'">'+esc(L.layer)+'</td>'+
        '<td style="padding:5px 8px;font-size:11px;color:var(--text3)">'+esc(L.desc)+'</td>'+
        '<td style="padding:5px 8px;font-family:monospace;font-size:11px">'+
          (L.files||[]).map(function(f){ return (f.ok?'<span style="color:var(--green)">✓</span> ':'<span style="color:var(--red)">✗</span> ')+esc(f.file); }).join(' · ')+
        '</td></tr>';
    });
    h += '</table>';
    // 路由模式
    h += '<div style="font-size:11px;color:var(--text3);margin:14px 0 6px">路由自适应状态</div>';
    h += '<table style="width:100%;border-collapse:collapse;font-size:12px">'+
      '<tr style="color:var(--text3);font-size:11px"><td style="padding:4px 8px">模式</td><td>说明</td><td style="width:76px">状态</td></tr>';
    (r.routes||[]).forEach(function(x){
      h += '<tr style="border-bottom:1px dashed var(--border)">'+
        '<td style="padding:4px 8px;font-weight:600">'+esc(x.mode)+'</td>'+
        '<td style="padding:4px 8px;font-size:11px;color:var(--text3)">'+esc(x.desc)+'</td>'+
        '<td style="padding:4px 8px">'+(x.implemented
            ? '<span style="color:var(--green)">✓ 已实现</span>'
            : '<span style="color:var(--orange)">✗ 规划中</span>')+'</td></tr>';
    });
    h += '</table>';
    // 引擎 + 模块
    h += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:14px">';
    h += '<div><div style="font-size:11px;color:var(--text3);margin-bottom:6px">引擎注册</div>'+
      (r.engines||[]).map(function(e){
        /* v6.13.0 · 批13(用户报 multi-stream 还是"规划中"): 引擎已实现 → 按**真实探测**呈现:
           planned 仅历史兼容; 未安装给原因(title)与可选「安装组件」 */
        var okSt = (e.installed !== undefined) ? e.installed : !!e.available;
        var st = e.planned ? '<span style="color:var(--orange)">◻</span>'
              : (okSt ? '<span style="color:var(--green)">◉</span>'
                      : '<span style="color:var(--orange)" title="'+esc(e.reason||e.hint||'')+'">◻</span>');
        var tail = e.planned ? ' <span style="font-size:10px;color:var(--orange)">规划中</span>'
                 : (!okSt ? ' <span style="font-size:10px;color:var(--orange)" title="'+esc(e.reason||e.hint||'')+'">未安装</span>'
                          + (e.install === 'quic' ? ' <button class="btn btn-xs" onclick="CoreStatus.quicInstall()" title="安装 aioquic 组件(venv pip), 解锁多流并发传输">⬇ 安装组件</button>' : '')
                          : '');
        return '<div style="font-size:12px;padding:3px 0">'+st+' <b>'+esc(e.name)+'</b>'+tail+'</div>';
      }).join('')+'</div>';
    h += '<div><div style="font-size:11px;color:var(--text3);margin-bottom:6px">核心模块 ('+r.module_count+')</div>'+
      '<div style="font-size:11px;font-family:monospace;color:var(--text2);max-height:150px;overflow:auto">'+
      (r.modules||[]).map(function(m){ return esc(m.name)+' <span style="color:var(--text3)">('+fmtB(m.size)+')</span>'; }).join('<br>')+
      '</div></div>';
    h += '</div>';
    box.innerHTML = h;
  }

  /* ── 板块2: 端点与连接 ── */
  async function loadEndpoints(){
    var box = $('csEndpoints');
    if (box) box.innerHTML = '<div style="color:var(--text3);font-size:12px">⏳ 探测端点…</div>';
    var r = await rpc('vitals_endpoints', {}, 90000);
    if (!box) return;
    if (r.status !== 'ok'){ box.innerHTML = '<div style="color:var(--red);font-size:12px">✗ '+esc(r.msg||'失败')+'</div>'; return; }
    var h = '<div style="font-size:12px;color:var(--text3);margin-bottom:8px">共 '+r.total+' 个端点 · 点击分组展开明细</div>';
    // 方向统计
    var ds = r.direction_stats || {};
    var dkeys = Object.keys(ds);
    if (dkeys.length){
      h += '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">';
      dkeys.forEach(function(k){
        h += card('<div style="font-size:11px;color:var(--text3)">'+esc(k)+'</div>'+
                  '<div style="font-size:14px;font-weight:600;color:var(--cyan)">'+ds[k].count+' 次</div>'+
                  '<div style="font-size:10px;color:var(--text3)">'+fmtB(ds[k].bytes)+'</div>');
      });
      h += '</div>';
    }
    (r.groups||[]).forEach(function(grp, gi){
      h += '<div style="border:1px solid var(--border);border-radius:8px;margin-bottom:8px;overflow:hidden">'+
        '<div class="cs-grp" data-g="'+gi+'" style="display:flex;align-items:center;gap:8px;padding:7px 10px;background:var(--bg3);cursor:pointer;font-size:12px">'+
          '<span class="cs-caret" style="color:var(--text3)">▸</span>'+
          '<b>'+esc(grp.label)+'</b>'+
          '<span style="color:var(--cyan)">'+grp.count+'</span>'+
          '<span style="flex:1"></span>'+
          '<span style="font-size:11px;color:var(--text3)">'+esc(grp.note||'')+'</span>'+
        '</div>'+
        '<div class="cs-grpbody" data-gb="'+gi+'" style="display:none;padding:6px 10px">';
      if (!(grp.items||[]).length){
        h += '<div style="font-size:12px;color:var(--text3)">（无配置）</div>';
      } else {
        h += '<table style="width:100%;border-collapse:collapse;font-size:12px">';
        grp.items.forEach(function(it){
          var on = it.online === true ? '<span style="color:var(--green)">● 在线</span>'
                 : it.online === false ? '<span style="color:var(--red)">● 离线</span>'
                 : '<span style="color:var(--text3)">○ 未探测</span>';
          h += '<tr style="border-bottom:1px dashed var(--border)">'+
            '<td style="padding:4px 6px;font-weight:600">'+esc(it.name||'')+'</td>'+
            '<td style="padding:4px 6px;font-family:monospace;font-size:11px;color:var(--cyan)">'+esc(it.target||'')+'</td>'+
            '<td style="padding:4px 6px;font-size:11px;color:var(--text3)">'+esc(it.detail||'')+'</td>'+
            '<td style="padding:4px 6px;width:70px">'+on+'</td>'+
            '<td style="padding:4px 6px;font-size:10px;color:var(--text3)">'+((it.caps||[]).join(' · '))+'</td>'+
            '</tr>';
        });
        h += '</table>';
      }
      h += '</div></div>';
    });
    box.innerHTML = h;
    box.querySelectorAll('.cs-grp').forEach(function(el){
      el.onclick = function(){
        var gi = el.getAttribute('data-g');
        var b = box.querySelector('[data-gb="'+gi+'"]');
        if (!b) return;
        var open = b.style.display !== 'none';
        b.style.display = open ? 'none' : '';
        var c = el.querySelector('.cs-caret');
        if (c) c.textContent = open ? '▸' : '▾';
      };
    });
  }

  /* ── 板块6: 宿主机资源 ── */
  async function loadHost(){
    var box = $('csHost');
    if (box) box.innerHTML = '<div style="color:var(--text3);font-size:12px">⏳ 采样中 (约 1 秒)…</div>';
    var r = await rpc('vitals_host', {}, 60000);
    if (!box) return;
    if (r.status !== 'ok'){ box.innerHTML = '<div style="color:var(--red);font-size:12px">✗ '+esc(r.msg||'失败')+'</div>'; return; }
    var cpu = r.cpu||{}, mem = r.mem||{}, net = r.net||{}, pr = r.process||{};
    var h = '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px;margin-bottom:12px">';
    h += card('<div style="font-size:12px;margin-bottom:4px">CPU <span style="color:var(--text3);font-size:10px">('+esc(String(cpu.cores))+' 核 · 阈值 '+esc(String(cpu.threshold))+'%)</span></div>'+
              '<div style="display:flex;align-items:center;gap:8px"><b style="font-size:16px">'+esc(String(cpu.pct))+'%</b>'+bar(cpu.pct)+'</div>'+
              '<div style="font-size:11px;color:var(--text3);margin-top:4px">负载 '+esc(String(cpu.load1))+' / '+esc(String(cpu.load5))+' / '+esc(String(cpu.load15))+'</div>');
    h += card('<div style="font-size:12px;margin-bottom:4px">内存 <span style="color:var(--text3);font-size:10px">(阈值 '+esc(String(mem.threshold))+'%)</span></div>'+
              '<div style="display:flex;align-items:center;gap:8px"><b style="font-size:16px">'+esc(String(mem.pct))+'%</b>'+bar(mem.pct)+'</div>'+
              '<div style="font-size:11px;color:var(--text3);margin-top:4px">可用 '+fmtB(mem.avail)+' / 共 '+fmtB(mem.total)+
              (mem.swap_pct ? (' · Swap '+esc(String(mem.swap_pct))+'%') : '')+'</div>');
    h += card('<div style="font-size:12px;margin-bottom:4px">网络 <span style="color:var(--text3);font-size:10px">(采样瞬时)</span></div>'+
              '<div style="font-size:14px;font-weight:600;color:var(--cyan)">↓ '+esc(String(net.rx_mbps))+' Mb/s</div>'+
              '<div style="font-size:14px;font-weight:600;color:var(--purple)">↑ '+esc(String(net.tx_mbps))+' Mb/s</div>');
    h += card('<div style="font-size:12px;margin-bottom:4px">本进程</div>'+
              '<div style="font-size:14px;font-weight:600">'+fmtB(pr.rss)+'</div>'+
              '<div style="font-size:11px;color:var(--text3);margin-top:4px">已运行 '+Math.round((pr.uptime_sec||0)/60)+' 分钟</div>');
    h += '</div>';

    h += '<div style="font-size:11px;color:var(--text3);margin:10px 0 6px">磁盘挂载点 ('+((r.disks||[]).length)+')</div>';
    h += '<table style="width:100%;border-collapse:collapse;font-size:12px">'+
      '<tr style="color:var(--text3);font-size:11px"><td style="padding:4px 8px">挂载点</td><td>类型</td><td style="width:150px">使用率</td>'+
      '<td>已用/共</td><td>可用</td></tr>';
    (r.disks||[]).forEach(function(d){
      h += '<tr style="border-bottom:1px dashed var(--border)">'+
        '<td style="padding:4px 8px;font-family:monospace">'+esc(d.mount)+'</td>'+
        '<td style="padding:4px 8px;font-size:11px;color:var(--text3)">'+esc(d.fstype)+'</td>'+
        '<td style="padding:4px 8px"><div style="display:flex;align-items:center;gap:6px">'+
          '<span style="font-size:11px;width:44px;color:'+(d.pct>=90?'var(--red)':(d.pct>=75?'var(--orange)':'var(--text2)'))+'">'+esc(String(d.pct))+'%</span>'+
          bar(d.pct)+'</div></td>'+
        '<td style="padding:4px 8px;font-size:11px;color:var(--text3)">'+fmtB(d.used)+' / '+fmtB(d.total)+'</td>'+
        '<td style="padding:4px 8px;font-size:11px;color:'+(d.pct>=90?'var(--red)':'var(--text2)')+'">'+fmtB(d.free)+'</td>'+
        '</tr>';
    });
    h += '</table>';
    var al = r.alerts || [];
    h += '<div style="margin-top:12px">' + (al.length
      ? al.map(function(a){
          var col = a.level === 'err' ? 'var(--red)' : 'var(--orange)';
          return '<div style="padding:5px 10px;border-left:3px solid '+col+';background:var(--bg3);border-radius:5px;margin-bottom:4px;font-size:12px">'+
            '<b style="color:'+col+'">'+esc(a.item)+'</b> <span style="color:var(--text2)">'+esc(a.msg)+'</span></div>';
        }).join('')
      : '<div style="font-size:12px;color:var(--green)">✓ 资源使用正常, 无告警</div>') + '</div>';
    box.innerHTML = h;
  }

  /* ── 任务健康 ── */
  async function loadTasks(){
    var box = $('csTasks');
    if (box) box.innerHTML = '<div style="color:var(--text3);font-size:12px">⏳ 读取…</div>';
    var r = await rpc('vitals_selfcheck', {}, 90000);
    if (!box) return;
    if (r.status !== 'ok'){ box.innerHTML = '<div style="color:var(--red);font-size:12px">✗ '+esc(r.msg||'失败')+'</div>'; return; }
    var t = r.tasks || {};
    var h = '';
    h += '<div style="font-size:12px;margin-bottom:8px">运行中 <b style="color:var(--cyan)">'+((t.running||[]).length)+'</b> · '+
         '疑似卡死 <b style="color:'+(((t.stalled||[]).length)?'var(--red)':'var(--text2)')+'">'+((t.stalled||[]).length)+'</b>'+
         ' <span style="color:var(--text3);font-size:11px">(判定阈值 '+esc(String(t.stall_threshold_sec))+' 秒无输出)</span></div>';
    var recent = t.recent_24h || {};
    var rk = Object.keys(recent);
    if (rk.length){
      h += '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">';
      rk.forEach(function(k){
        h += card('<div style="font-size:11px;color:var(--text3)">'+esc(k)+'</div>'+
                  '<div style="font-size:14px;font-weight:600">'+recent[k]+'</div>');
      });
      h += '</div>';
    }
    if ((t.stalled||[]).length){
      h += '<div style="font-size:11px;color:var(--red);margin-bottom:4px">卡死任务 (可点上方「检测并终止」处置)</div>'+
        '<table style="width:100%;border-collapse:collapse;font-size:12px">'+
        '<tr style="color:var(--text3);font-size:11px"><td style="padding:4px 8px">任务</td><td>PID</td><td>空闲</td></tr>';
      (t.stalled||[]).forEach(function(x){
        h += '<tr style="border-bottom:1px dashed var(--border)">'+
          '<td style="padding:4px 8px;font-family:monospace">'+esc(x.task_id)+'</td>'+
          '<td style="padding:4px 8px">'+esc(String(x.pid||'-'))+'</td>'+
          '<td style="padding:4px 8px;color:var(--red)">'+esc(String(x.idle_sec||'-'))+'s</td></tr>';
      });
      h += '</table>';
    } else {
      h += '<div style="font-size:12px;color:var(--green)">✓ 未发现卡死任务</div>';
    }
    if ((t.running||[]).length){
      h += '<div style="font-size:11px;color:var(--text3);margin:10px 0 4px">运行中任务</div>'+
        '<table style="width:100%;border-collapse:collapse;font-size:12px">'+
        '<tr style="color:var(--text3);font-size:11px"><td style="padding:4px 8px">任务</td><td>PID</td><td>已运行</td><td>最后输出</td></tr>';
      (t.running||[]).forEach(function(x){
        h += '<tr style="border-bottom:1px dashed var(--border)">'+
          '<td style="padding:4px 8px;font-family:monospace">'+esc(x.task_id)+'</td>'+
          '<td style="padding:4px 8px">'+esc(String(x.pid||'-'))+'</td>'+
          '<td style="padding:4px 8px;color:var(--text3)">'+esc(String(x.age_sec||'-'))+'s</td>'+
          '<td style="padding:4px 8px;color:var(--text3)">'+esc(String(x.idle_sec||'-'))+'s 前</td></tr>';
      });
      h += '</table>';
    }
    box.innerHTML = h;
  }

  async function killStalled(force){
    if (force){
      var ok = (typeof g._showC2Modal === 'function')
        ? await new Promise(function(res){
            g._showC2Modal({ title: '⚠ 终止卡死任务', danger: true, okText: '终止',
              body: '将向超过阈值无输出的任务发送 SIGTERM/SIGKILL。\n\n确定继续?',
              onOk: function(){ res(true); } });
            setTimeout(function(){ res(false); }, 30000);
          })
        : (g.confirm && g.confirm('确定终止卡死任务?'));
      if (!ok) return;
    }
    toast(force ? '⏳ 检测并终止中…' : '⏳ 检测中…', 'info', 3000);
    var r = await rpc('vitals_kill_stalled', { force: force ? 1 : 0 }, 90000);
    toast((r.status==='ok' ? '' : '✗ ') + (r.msg || '完成'), r.status==='ok' ? 'success' : 'err', 5200);
    _loaded.tasks = false;
    loadTasks();
  }

  /* ── 容错回退 ── */
  async function loadResilience(){
    var box = $('csResilience');
    if (box) box.innerHTML = '<div style="color:var(--text3);font-size:12px">⏳ 读取…</div>';
    var r = await rpc('vitals_resilience', {});
    if (!box) return;
    if (r.status !== 'ok'){ box.innerHTML = '<div style="color:var(--red);font-size:12px">✗ '+esc(r.msg||'失败')+'</div>'; return; }
    var live = r.live || {};
    var h = '<div style="font-size:12px;margin-bottom:10px">本进程累计尝试 <b>'+esc(String(live.total_attempts||0))+'</b> 次 · '+
            '其中发生降级 <b style="color:'+((live.with_fallback)?'var(--orange)':'var(--text2)')+'">'+esc(String(live.with_fallback||0))+'</b> 次'+
            (live.fallback_ratio ? (' ('+esc(String(live.fallback_ratio))+'%)') : '')+
            ' <span style="color:var(--text3);font-size:11px">降级 = 首选方法失败后自动改用后备方法 (优先保证任务完成)</span></div>';
    h += '<div style="font-size:11px;color:var(--text3);margin-bottom:6px">内置回退策略</div>';
    h += '<table style="width:100%;border-collapse:collapse;font-size:12px">'+
      '<tr style="color:var(--text3);font-size:11px"><td style="padding:4px 8px">范围</td><td>回退链</td><td style="width:80px">状态</td></tr>';
    (r.strategies||[]).forEach(function(x){
      h += '<tr style="border-bottom:1px dashed var(--border)">'+
        '<td style="padding:4px 8px;font-weight:600;white-space:nowrap">'+esc(x.scope)+'</td>'+
        '<td style="padding:4px 8px;font-size:11px;color:var(--text2)">'+
          (x.chain||[]).map(function(c,i){ return (i? '<span style="color:var(--text3)"> → </span>':'')+esc(c); }).join('')+
          (x.note ? ('<div style="color:var(--orange);font-size:10px;margin-top:2px">'+esc(x.note)+'</div>') : '')+
        '</td>'+
        '<td style="padding:4px 8px">'+(x.implemented
          ? '<span style="color:var(--green)">✓ 已实现</span>'
          : '<span style="color:var(--orange)">◻ 部分</span>')+'</td></tr>';
    });
    h += '</table>';
    var rec = live.recent || [];
    if (rec.length){
      h += '<div style="font-size:11px;color:var(--text3);margin:12px 0 6px">最近回退记录</div>'+
        '<table style="width:100%;border-collapse:collapse;font-size:11px">'+
        '<tr style="color:var(--text3)"><td style="padding:3px 6px">时间</td><td>范围</td><td>方法</td><td>结果</td><td>耗时</td><td>原因/消息</td></tr>';
      rec.slice(0, 20).forEach(function(x){
        h += '<tr style="border-bottom:1px dashed var(--border)">'+
          '<td style="padding:3px 6px;color:var(--text3)">'+esc(x.ts)+'</td>'+
          '<td style="padding:3px 6px">'+esc(x.scope)+'</td>'+
          '<td style="padding:3px 6px">'+esc(x.label)+'</td>'+
          '<td style="padding:3px 6px;color:'+(x.ok?'var(--green)':'var(--red)')+'">'+(x.ok?'✓':'✗')+'</td>'+
          '<td style="padding:3px 6px;color:var(--text3)">'+esc(String(x.ms))+'ms</td>'+
          '<td style="padding:3px 6px;color:var(--text3)">'+esc((x.msg||x.why||'').slice(0,80))+'</td></tr>';
      });
      h += '</table>';
    } else {
      h += '<div style="font-size:12px;color:var(--text3);margin-top:10px">（本进程暂无回退记录 — 未发生降级）</div>';
    }
    box.innerHTML = h;
  }

  /* ── 板块3: 引擎与路由 ── */
  /* v6.13.0 · 批13: 多流传输组件(aioquic)一键安装 —— 装完 loadEngines() 立即反映可用 */
  async function quicInstall(){
    var ok = await rpConfirm({ title: '安装多流传输组件', danger: true, okText: '安装', cancelText: '取消',
      body: '将在应用自带的 venv 里执行 pip install aioquic(约 10-30MB 依赖; 需联网)。\n'
          + '安装后「多流并发传输」引擎即可用(弱网/跨网场景)。\n继续?' });
    if (!ok) return;
    var r = await rpc('quic_install_start', { confirm: true });
    if (!r || r.status !== 'ok'){ toast((r && r.msg) || '启动失败', 'err', 6000); return; }
    toast(r.msg || '已开始安装', 'info', 6000);
    var t = setInterval(async function(){
      var st = await rpc('quic_install_status', {});
      if (!st || st.state === 'running') return;
      clearInterval(t);
      if (st.state === 'ok'){ toast('✓ 多流传输组件已安装: ' + (st.version || ''), 'ok', 7000); loadEngines(); }
      else toast('✗ 组件安装失败: ' + (st.error || '未知'), 'err', 9000);
    }, 1500);
  }
  async function loadEngines(){
    var box = $('csEngines');
    if (box) box.innerHTML = '<div style="color:var(--text3);font-size:12px">⏳ 探测引擎与工具版本…</div>';
    var r = await rpc('vitals_engines', {}, 90000);
    if (!box) return;
    if (r.status !== 'ok'){ box.innerHTML = '<div style="color:var(--red);font-size:12px">✗ '+esc(r.msg||'失败')+'</div>'; return; }
    var h = '<div style="font-size:11px;color:var(--text3);margin-bottom:6px">引擎能力矩阵</div>';
    h += '<table style="width:100%;border-collapse:collapse;font-size:12px">'+
      '<tr style="color:var(--text3);font-size:11px"><td style="padding:4px 8px">引擎</td><td>状态</td><td>版本</td>'+
      '<td>压缩</td><td>加密</td><td>断点续传</td><td>校验</td><td>并发</td><td>说明</td></tr>';
    (r.engines||[]).forEach(function(e){
      var okSt = (e.installed !== undefined) ? e.installed : !!e.available;
      var st = e.planned ? '<span style="color:var(--orange)">◻ 规划中</span>'
             : (okSt ? '<span style="color:var(--green)">✓ '+(e.block ? '块级已备' : '已注册')+'</span>'
                     : '<span style="color:var(--orange)" title="'+esc(e.reason||e.hint||'')+'">◻ 未安装</span>'
                       + (e.install === 'quic' ? ' <button class="btn btn-xs" onclick="CoreStatus.quicInstall()">⬇ 安装组件</button>' : ''));
      var c = e.caps || {};
      var yn = function(v){ return v === true ? '<span style="color:var(--green)">✓</span>'
                     : (v === false ? '<span style="color:var(--text3)">—</span>'
                     : (typeof v === 'string' ? '<span style="font-size:10px;color:var(--text3)">'+esc(v)+'</span>'
                                              : '<span style="color:var(--text3)">—</span>')); };
      h += '<tr style="border-bottom:1px dashed var(--border)">'+
        '<td style="padding:4px 8px;font-weight:600">'+esc(e.name)+'</td>'+
        '<td style="padding:4px 8px">'+st+'</td>'+
        '<td style="padding:4px 8px;font-size:10px;color:var(--text3)">'+esc(String(e.version||'').slice(0,34))+'</td>'+
        '<td style="padding:4px 8px">'+yn(c.compress)+'</td>'+
        '<td style="padding:4px 8px;font-size:10px;color:var(--text3)">'+esc(c.encrypt||'')+'</td>'+
        '<td style="padding:4px 8px">'+yn(c.resume)+'</td>'+
        '<td style="padding:4px 8px;font-size:10px;color:var(--text3)">'+esc(c.verify||'')+'</td>'+
        '<td style="padding:4px 8px;font-size:10px;color:var(--text3)">'+esc(c.concurrency||'')+'</td>'+
        '<td style="padding:4px 8px;font-size:10px;color:var(--text3)">'+esc(c.note||'')+'</td></tr>';
    });
    h += '</table>';
    // 路由矩阵
    h += '<div style="font-size:11px;color:var(--text3);margin:14px 0 6px">路由模式矩阵</div>';
    h += '<table style="width:100%;border-collapse:collapse;font-size:12px">'+
      '<tr style="color:var(--text3);font-size:11px"><td style="padding:4px 8px">模式</td><td>适用场景</td><td>实现方式</td><td>代码</td><td style="width:80px">状态</td></tr>';
    (r.routes||[]).forEach(function(x){
      h += '<tr style="border-bottom:1px dashed var(--border)">'+
        '<td style="padding:4px 8px;font-weight:600">'+esc(x.mode)+'</td>'+
        '<td style="padding:4px 8px;font-size:11px;color:var(--text2)">'+esc(x.scene)+'</td>'+
        '<td style="padding:4px 8px;font-size:11px;color:var(--text3)">'+esc(x.how)+'</td>'+
        '<td style="padding:4px 8px;font-size:10px;font-family:monospace;color:var(--text3)">'+esc(x.file||'-')+'</td>'+
        '<td style="padding:4px 8px">'+(x.implemented
            ? '<span style="color:var(--green)">✓ 已实现</span>'
            : '<span style="color:var(--orange)">✗ 规划中</span>')+'</td></tr>';
    });
    h += '</table>';
    var st2 = r.settings || {};
    if (Object.keys(st2).length){
      h += '<div style="font-size:11px;color:var(--text3);margin:14px 0 6px">引擎相关系统设置</div><div style="display:flex;gap:8px;flex-wrap:wrap">';
      Object.keys(st2).forEach(function(k){
        h += card('<div style="font-size:10px;color:var(--text3)">'+esc(k)+'</div><div style="font-size:13px;font-weight:600;color:var(--cyan)">'+esc(String(st2[k]))+'</div>');
      });
      h += '</div>';
    }
    // v5.89.1 · 删除此前的"懒加载"块: 它内部 `box2.innerHTML=''` 会清空刚渲染的能力矩阵,
    //   且 __cached/_append 写了无人读(下面 541 起已单独异步拉取命令清单并 append) → 首次进入
    //   引擎与路由页只见命令清单、能力矩阵消失。此处直接渲染矩阵, 命令清单由下方异步追加。
    box.innerHTML = h;
    // 单独异步拉取命令清单区块 (不阻塞主矩阵)
    if (!loadEngines._cmdLoaded){
      loadEngines._cmdLoaded = true;
      rpc('vitals_commands', {}, 120000).then(function(cr){
        if (cr.status !== 'ok' || !box.isConnected) return;
        var h2 = '<div style="font-size:11px;color:var(--text3);margin:16px 0 6px">命令清单 (build() 真实展开 · 共 '+cr.total+' 条)</div>';
        h2 += '<table style="width:100%;border-collapse:collapse;font-size:11px">'+
          '<tr style="color:var(--text3);font-size:10px"><td style="padding:3px 8px">引擎</td><td>场景</td><td>参数数</td><td>命令</td></tr>';
        (cr.cases||[]).forEach(function(cm){
          h2 += '<tr style="border-bottom:1px dashed var(--border)">'+
            '<td style="padding:3px 8px;font-weight:600">'+esc(cm.engine)+'</td>'+
            '<td style="padding:3px 8px;color:var(--text2)">'+esc(cm.label)+'</td>'+
            '<td style="padding:3px 8px;color:var(--cyan)">'+cm.count+'</td>'+
            '<td style="padding:3px 8px;font-family:monospace;font-size:10px;color:var(--text3);word-break:break-all">'+esc(cm.cmd)+'</td></tr>';
        });
        h2 += '</table>';
        Object.keys(cr.flags_doc||{}).forEach(function(eng){
          h2 += '<div style="font-size:11px;color:var(--text3);margin:10px 0 4px">'+esc(eng)+' 常用参数 (用户可配置项)</div>'+
            '<div style="display:flex;gap:5px;flex-wrap:wrap">'+
            (cr.flags_doc[eng]||[]).map(function(f2){ return '<span style="padding:2px 8px;border:1px solid var(--border);border-radius:9px;font-size:10px;font-family:monospace">'+esc(f2)+'</span>'; }).join('')+
            '</div>';
        });
        var host2 = document.createElement('div');
        host2.innerHTML = h2;
        box.appendChild(host2);
      });
    }
  }

  /* ── 板块4: 安全与权限 ── */
  async function loadSecurity(){
    var box = $('csSecurity');
    if (box) box.innerHTML = '<div style="color:var(--text3);font-size:12px">⏳ 读取…</div>';
    var r = await rpc('vitals_security', {}, 90000);
    if (!box) return;
    if (r.status !== 'ok'){ box.innerHTML = '<div style="color:var(--red);font-size:12px">✗ '+esc(r.msg||'失败')+'</div>'; return; }
    var h = '<div style="font-size:11px;color:var(--text3);margin-bottom:6px">三层安全架构</div>';
    (r.layers||[]).forEach(function(L){
      var wired = L.wired || {};
      var wk = Object.keys(wired);
      h += '<div style="border:1px solid var(--border);border-radius:8px;padding:8px 10px;margin-bottom:6px;background:var(--bg)">'+
        '<div style="display:flex;align-items:center;gap:8px"><b style="font-size:12px">'+esc(L.level)+'</b>'+
        (L.implemented ? '<span style="color:var(--green);font-size:11px">✓ 已实现</span>' : '<span style="color:var(--orange);font-size:11px">✗ 未实现</span>')+
        '<span style="flex:1"></span><span style="font-size:10px;color:var(--text3)">'+esc(L.scope)+'</span></div>'+
        '<div style="font-size:11px;color:var(--text2);margin-top:4px">算法: '+esc(L.algo)+'</div>'+
        (wk.length ? '<div style="font-size:10px;margin-top:4px">接线: ' + wk.map(function(k){
            return esc(k)+' '+(wired[k] ? '<span style="color:var(--green)">✓</span>' : '<span style="color:var(--orange)">未接入</span>');
          }).join(' · ') + '</div>' : '')+
        (L.note ? '<div style="font-size:10px;color:var(--orange);margin-top:4px">'+esc(L.note)+'</div>' : '')+
        '</div>';
    });
    /* v1.0.0 · 社区版: 无远程授权/到期概念 —— 原"授权与激活 + 实例ID(分叉锚点)"卡片已移除 */
    var fe = r.features || {};
    h += '<div style="font-size:11px;color:var(--text3);margin:12px 0 6px">功能分组 ('+(fe.groups||0)+' 组)</div>';
    // 用户权限矩阵
    h += '<div style="font-size:11px;color:var(--text3);margin:12px 0 6px">用户权限分配 ('+((r.users||[]).length)+' 个账号)</div>';
    h += '<table style="width:100%;border-collapse:collapse;font-size:12px">'+
      '<tr style="color:var(--text3);font-size:11px"><td style="padding:4px 8px">账号</td><td>角色</td><td>权限范围</td></tr>';
    (r.users||[]).forEach(function(u){
      if (u.error){ h += '<tr><td colspan="3" style="padding:4px 8px;color:var(--red)">'+esc(u.error)+'</td></tr>'; return; }
      h += '<tr style="border-bottom:1px dashed var(--border)">'+
        '<td style="padding:4px 8px;font-family:monospace">'+esc(u.username)+
          (u.is_admin ? ' <span style="color:var(--cyan);font-size:10px">管理员</span>' : '')+'</td>'+
        '<td style="padding:4px 8px;font-size:11px;color:var(--text3)">'+esc(u.role||'')+'</td>'+
        '<td style="padding:4px 8px;font-size:11px;color:var(--text2)">'+esc(u.perm_note||'')+
          ((u.perms||[]).length ? '<div style="font-size:10px;color:var(--text3)">'+esc((u.perms||[]).join(' · '))+'</div>' : '')+
        '</td></tr>';
    });
    h += '</table>';
    if ((r.stub_users||[]).length){
      h += '<div style="margin-top:8px;padding:6px 10px;border-left:3px solid var(--orange);background:var(--bg3);border-radius:5px;font-size:11px">'+
        '⚠ 检测到 '+r.stub_users.length+' 个疑似测试残留账号: '+esc(r.stub_users.join(', '))+
        ' — 可在「用户管理」中删除 (本页不自动清理)</div>';
    }
    box.innerHTML = h;
  }

  /* ── 板块5: 插件与模块 ── */
  async function loadPlugins(){
    var box = $('csPlugins');
    if (box) box.innerHTML = '<div style="color:var(--text3);font-size:12px">⏳ 探测外部工具 (含版本)…</div>';
    var r = await rpc('vitals_plugins', {}, 120000);
    if (!box) return;
    if (r.status !== 'ok'){ box.innerHTML = '<div style="color:var(--red);font-size:12px">✗ '+esc(r.msg||'失败')+'</div>'; return; }
    var sm = r.summary || {};
    var h = '<div style="font-size:12px;margin-bottom:8px">外部工具/插件: 共 <b>'+esc(String(sm.tools_total))+'</b> 项 · '+
            '已安装 <b style="color:var(--green)">'+esc(String(sm.installed))+'</b> · '+
            '缺失 <b style="color:var(--orange)">'+esc(String(sm.missing))+'</b>'+
            ((r.missing_required||[]).length ? ' · <span style="color:var(--red)">必需项缺失: '+esc(r.missing_required.join(', '))+'</span>' : ' <span style="color:var(--green)">必需项齐备</span>')+
            '</div>';
    h += '<table style="width:100%;border-collapse:collapse;font-size:12px">'+
      '<tr style="color:var(--text3);font-size:11px"><td style="padding:4px 8px;width:150px">工具</td><td>用途</td>'+
      '<td style="width:70px">状态</td><td>版本 / 路径</td></tr>';
    (r.tools||[]).forEach(function(t){
      h += '<tr style="border-bottom:1px dashed var(--border)">'+
        '<td style="padding:4px 8px;font-family:monospace;font-weight:600">'+esc(t.name)+
          (t.required ? ' <span style="color:var(--red);font-size:10px">必需</span>' : '')+'</td>'+
        '<td style="padding:4px 8px;font-size:11px;color:var(--text2)">'+esc(t.desc)+'</td>'+
        '<td style="padding:4px 8px">'+(t.installed
          ? '<span style="color:var(--green)">✓</span>'
          : '<span style="color:'+(t.required?'var(--red)':'var(--text3)')+'">—</span>')+'</td>'+
        '<td style="padding:4px 8px;font-size:10px;color:var(--text3)">'+esc((t.version||t.path||'').slice(0,56))+'</td>'+
        '</tr>';
    });
    h += '</table>';
    h += '<div style="font-size:11px;color:var(--text3);margin:14px 0 6px">功能分组 ('+((r.feature_groups||[]).length)+')</div>';
    h += '<div style="display:flex;gap:6px;flex-wrap:wrap">'+
      (r.feature_groups||[]).map(function(g){
        return '<span style="padding:2px 9px;border:1px solid var(--border);border-radius:10px;font-size:11px">'+esc(g.label||g.key)+'</span>';
      }).join('')+'</div>';
    h += '<div style="font-size:11px;color:var(--text3);margin:14px 0 6px">页面入口 ('+((r.pages||[]).length)+')</div>';
    h += '<div style="font-size:11px;color:var(--text2);line-height:1.9">'+
      (r.pages||[]).map(function(pg){ return esc(pg.label); }).join(' · ')+'</div>';
    h += '<div style="font-size:11px;color:var(--text3);margin:14px 0 6px">前端面板文件 ('+((r.panel_files||[]).length)+')</div>';
    h += '<div style="font-size:10px;color:var(--text3);font-family:monospace;max-height:110px;overflow:auto">'+
      (r.panel_files||[]).join(' · ')+'</div>';
    box.innerHTML = h;
  }

  function reloadPlugins(){ _loaded.plugins = false; loadPlugins(); }

  /* v5.82.0 · 品牌名设置功能按用户要求移除; 品牌固定 Fonriv */

  function refreshAll(){
    _loaded = {};
    loadSelfcheck();
    loadTab(_tab);
  }

  g.CoreStatus = { tab: tab, refreshAll: refreshAll, killStalled: killStalled, reloadPlugins: reloadPlugins, quicInstall: quicInstall };
  document.addEventListener('DOMContentLoaded', function(){
    setTimeout(function(){
      try { if (typeof window.currentUser !== 'undefined' && window.currentUser){ loadSelfcheck(); } } catch(e){}
    }, 2600);
  });
})(window);
