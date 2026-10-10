/* v5.10.0 · 统一日志页 (L1 索引 + L2 明细懒加载)
 * 数据源: GET /api/runs (L1 索引) + GET /api/runs/{run_id}/detail (L2 JSONL)
 */
(function(g){
  'use strict';

  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function gv(id){ var e = document.getElementById(id); return e ? e.value.trim() : ''; }

  function _authQ(){
    try {
      var tk = localStorage.getItem('auth_token') || '';
      return tk ? '?token=' + encodeURIComponent(tk) : '';
    } catch(e){ return ''; }
  }

  var ST_COLORS = { ok:'var(--green)', running:'var(--cyan)', failed:'var(--red)',
                    cancelled:'var(--text3)', partial:'var(--orange)' };

  function fmtT(ts){
    if (!ts) return '—';
    var d = new Date(ts * 1000);
    return d.toLocaleDateString().slice(5) + ' ' + d.toLocaleTimeString();
  }
  function fmtDur(a, b){
    if (!a || !b || b <= a) return '—';
    var s = Math.round(b - a);
    if (s < 60) return s + 's';
    return Math.floor(s/60) + 'm' + (s%60) + 's';
  }
  function badge(st){
    var c = ST_COLORS[st] || 'var(--text3)';
    return '<span style="color:' + c + ';font-weight:600">● ' + esc(st || '?') + '</span>';
  }

  async function refresh(){
    var tb = document.getElementById('rlTable');
    if (!tb) return;
    var status = gv('rlStatus'), kind = gv('rlKind');
    var q = [];
    if (status) q.push('status=' + encodeURIComponent(status));
    if (kind) q.push('kind=' + encodeURIComponent(kind));
    try {
      var r = await (await fetch('/api/runs' + (q.length ? '?' + q.join('&') : '') + _authQ())).json();
      if (r.status !== 'ok'){ tb.innerHTML = '<div style="color:var(--red);font-size:12px;padding:8px">✗ ' + esc(r.msg || '查询失败') + '</div>'; return; }
      var runs = r.runs || [];
      if (!runs.length){ tb.innerHTML = rpState({ state: 'empty', msg: '暂无任务记录' }); return; }
      var h = '<table style="width:100%;font-size:11px;border-collapse:collapse">' +
        '<tr style="color:var(--text3);text-align:left"><th style="padding:4px 8px">时间</th><th>类型</th><th>任务</th>' +
        '<th>源 → 目标</th><th>引擎</th><th>状态</th><th>耗时</th><th></th></tr>';
      runs.forEach(function(x, i){
        var dst = x.dst ? esc(x.dst) : '<span style="color:var(--orange)">未指定</span>';
        h += '<tr data-run="' + esc(x.run_id) + '" style="border-top:1px solid var(--line);cursor:pointer" ' +
             'onmouseover="this.style.background=\'var(--bg3)\'" onmouseout="this.style.background=\'\'">' +
          '<td style="padding:4px 8px">' + fmtT(x.started_ts) + '</td>' +
          '<td>' + esc(x.kind || '') + '</td>' +
          '<td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(x.label || x.run_id) + '</td>' +
          '<td style="max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text3)">' +
            esc((x.src || '—') + ' → ' + dst) + '</td>' +
          '<td>' + esc(x.engine || '') + '</td>' +
          '<td>' + badge(x.status) + '</td>' +
          '<td>' + fmtDur(x.started_ts, x.finished_ts) + '</td>' +
          '<td style="white-space:nowrap">' +
            '<button class="btn btn-sm" style="padding:1px 8px;font-size:10px;color:var(--cyan)" ' +
            'title="串起 Planner 决策 → Executor 执行 → Ledger 对账 → 操作日志" ' +
            'onclick="event.stopPropagation();RunLogPage.showTrace(\'' + esc(x.run_id) + '\')">🔗 链路</button> ' +
            '<button class="btn btn-sm" style="padding:1px 8px;font-size:10px" ' +
            'onclick="event.stopPropagation();RunLogPage.showDetail(\'' + esc(x.run_id) + '\')">📄 明细</button></td>' +
          '</tr>';
      });
      h += '</table>';
      tb.innerHTML = h;
    } catch(e){
      tb.innerHTML = '<div style="color:var(--red);font-size:12px;padding:8px">✗ ' + esc(String(e)) + '</div>';
    }
  }

  async function showDetail(runId){
    var wrap = document.getElementById('rlDetail');
    var title = document.getElementById('rlDetailTitle');
    var body = document.getElementById('rlDetailBody');
    if (!wrap || !body) return;
    wrap.style.display = 'block';
    title.textContent = '明细: ' + runId;
    body.innerHTML = '<div style="color:var(--text3);padding:10px">⏳ 加载明细…</div>';
    try {
      var r = await (await fetch('/api/runs/' + encodeURIComponent(runId) + '/detail?limit=3000' + _authQ())).json();
      var lines = (r.detail || []).map(function(d){
        var c = d.level === 'WARN' ? 'var(--orange)' : d.level === 'ERROR' ? 'var(--red)' : 'var(--text2)';
        return '<div style="color:' + c + '">' +
          '<span style="color:var(--text3)">' + esc(new Date((d.ts||0)*1000).toLocaleTimeString()) + '</span> ' +
          '<b>[' + esc(d.event || '') + ']</b> ' + esc(d.msg || '') +
          (d.bytes != null ? ' <span style="color:var(--text3)">(' + d.bytes + 'B)</span>' : '') + '</div>';
      });
      body.innerHTML = lines.join('') || '<div style="color:var(--text3)">该任务没有明细记录</div>';
      body.scrollTop = 0;
    } catch(e){
      body.innerHTML = '<div style="color:var(--red)">✗ ' + esc(String(e)) + '</div>';
    }
  }

  /* ── v5.19.4 · 链路回溯: 一次任务从决策到落账的全过程 ── */
  function _rpc(action, data, t){
    return new Promise(function(resolve){
      var done = false;
      var timer = setTimeout(function(){ if(!done){ done = true; resolve({status:'error', msg:'请求超时'}); } }, t||90000);
      try {
        g.send(Object.assign({action:action}, data||{}), function(r){
          if (done) return; done = true; clearTimeout(timer); resolve(r||{});
        });
      } catch(e){ if(!done){ done=true; clearTimeout(timer); resolve({status:'error', msg:String(e)}); } }
    });
  }
  function _dur(sec){
    if (sec == null) return '—';
    if (sec < 60) return sec + 's';
    return Math.floor(sec/60) + 'm' + Math.round(sec%60) + 's';
  }
  async function showTrace(runId){
    var wrap = document.getElementById('rlDetail');
    var title = document.getElementById('rlDetailTitle');
    var body = document.getElementById('rlDetailBody');
    if (!wrap || !body) return;
    wrap.style.display = 'block';
    title.textContent = '🔗 链路回溯: ' + runId;
    body.innerHTML = '<div style="color:var(--text3);padding:10px">⏳ 回溯中…</div>';
    var r = await _rpc('run_trace', { run_id: runId });
    if (r.status !== 'ok'){
      body.innerHTML = '<div style="color:var(--red);padding:10px">✗ ' + esc(r.msg||'回溯失败') + '</div>';
      return;
    }
    var sm = r.summary || {};
    var h = '';
    // 概要卡
    h += '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:10px;font-size:11px">';
    var cards = [
      ['任务', esc(sm.label || sm.kind || '')],
      ['引擎', esc(sm.engine || '—')],
      ['状态', '<span style="color:' + (sm.status==='ok'?'var(--green)':(sm.status==='failed'?'var(--red)':'var(--text2)')) + '">' + esc(sm.status||'') + '</span>'],
      ['耗时', _dur(sm.duration)],
      ['阶段', sm.stage_count + ' 个'],
      ['明细事件', sm.event_count + ' 条'],
      ['操作日志', sm.op_count + ' 条'],
    ];
    cards.forEach(function(c){
      h += '<div style="border:1px solid var(--border);border-radius:6px;padding:5px 10px;background:var(--bg)">' +
           '<div style="color:var(--text3);font-size:10px">' + c[0] + '</div><div style="font-size:12px">' + c[1] + '</div></div>';
    });
    h += '</div>';
    // 覆盖度徽章 (哪些阶段真的发生了)
    h += '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px">';
    [['Planner 决策', sm.has_plan], ['L2 加密', sm.has_l2], ['Ledger 对账', sm.has_verify], ['降级重试', sm.has_fallback]].forEach(function(x){
      h += '<span style="padding:2px 9px;border-radius:10px;font-size:11px;border:1px solid ' +
           (x[1] ? 'var(--green)' : 'var(--border)') + ';color:' + (x[1] ? 'var(--green)' : 'var(--text3)') + '">' +
           (x[1] ? '✓ ' : '○ ') + x[0] + '</span>';
    });
    h += '</div>';
    if (sm.src || sm.dst){
      h += '<div style="font-size:11px;font-family:monospace;color:var(--text2);margin-bottom:10px">' +
           esc(sm.src||'') + ' → ' + esc(sm.dst||'') + '</div>';
    }
    // 阶段时间线
    var stages = r.stages || [];
    if (stages.length){
      h += '<div style="font-size:11px;color:var(--text3);margin-bottom:6px">执行链路 (按阶段)</div>';
      stages.forEach(function(st, i){
        var isLast = i === stages.length - 1;
        h += '<div style="display:flex;gap:10px;margin-bottom:8px">';
        h += '<div style="display:flex;flex-direction:column;align-items:center;flex:0 0 18px">' +
             '<div style="width:9px;height:9px;border-radius:50%;background:var(--cyan);margin-top:4px"></div>' +
             (isLast ? '' : '<div style="flex:1;width:1px;background:var(--border);margin-top:3px"></div>') + '</div>';
        h += '<div style="flex:1;min-width:0;border:1px solid var(--border);border-radius:6px;padding:6px 10px;background:var(--bg)">' +
             '<div style="font-size:12px;font-weight:600">' + esc(st.label) + ' <span style="color:var(--text3);font-weight:400;font-size:10px">' + esc(st.desc||'') + '</span></div>';
        (st.events||[]).forEach(function(e){
          var lv = String(e.level||'').toUpperCase();
          var c = lv === 'ERROR' ? 'var(--red)' : (lv === 'WARN' ? 'var(--orange)' : 'var(--text2)');
          h += '<div style="font-size:11px;color:' + c + ';margin-top:3px">' +
               '<span style="color:var(--text3)">' + esc(new Date((e.ts||0)*1000).toLocaleTimeString()) + '</span> ' +
               esc(e.msg || '') +
               (e.bytes != null ? ' <span style="color:var(--text3)">(' + e.bytes + 'B)</span>' : '') + '</div>';
        });
        h += '</div></div>';
      });
    } else {
      h += '<div style="font-size:12px;color:var(--text3)">该任务无阶段明细 (可能已被轮转清理)</div>';
    }
    // 关联操作日志
    if ((r.ops||[]).length){
      h += '<div style="font-size:11px;color:var(--text3);margin:12px 0 6px">关联操作日志 (' + r.ops.length + ' 条)</div>' +
           '<div style="font-size:10px;font-family:monospace;max-height:150px;overflow:auto;background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:6px 8px">' +
           (r.ops||[]).map(function(l){ return esc(l); }).join('<br>') + '</div>';
    }
    body.innerHTML = h;
    body.scrollTop = 0;
  }

  /* 独立 modal (FileOps.modal 在其闭包内, 这里自带一份) */
  function _modal(title, bodyHtml, width){
    var old = document.getElementById('rlModal'); if (old) old.remove();
    var m = document.createElement('div');
    m.id = 'rlModal';
    m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:100000;display:flex;align-items:center;justify-content:center';
    m.innerHTML =
      '<div style="background:var(--bg2);border:1px solid var(--border);border-radius:10px;width:'+(width||'860px')+';max-width:94vw;max-height:88vh;display:flex;flex-direction:column;box-shadow:0 18px 50px rgba(0,0,0,0.45)">'+
      '<div style="padding:9px 14px;border-bottom:1px solid var(--border);display:flex;align-items:center">'+
        '<span style="font-weight:600;font-size:13px;color:var(--text)">'+esc(title)+'</span>'+
        '<button style="margin-left:auto;background:none;border:none;color:var(--text3);font-size:16px;cursor:pointer" onclick="this.closest(\'#rlModal\').remove()">✕</button></div>'+
      '<div class="rlm-body" style="flex:1;overflow:auto;padding:12px 14px;min-height:0">'+bodyHtml+'</div></div>';
    document.body.appendChild(m);
    m.addEventListener('mousedown', function(ev){ if (ev.target === m) m.remove(); });
    return m;
  }

  /* ── v5.19.5 · 跨任务关联树 (flow → 子任务) ── */
  async function showTree(flowId){
    var m = _modal('🌳 跨任务关联树 · flow#' + flowId,
                   '<div style="font-size:12px;color:var(--text3);padding:10px">⏳ 加载…</div>');
    var r = await _rpc('trace_tree', { flow_id: flowId }, 90000);
    var body = m.querySelector('.rlm-body') || m;
    if (r.status !== 'ok'){
      body.innerHTML = '<div style="color:var(--red);font-size:12px;padding:10px">✗ ' + esc(r.msg||'加载失败') + '</div>';
      return;
    }
    var sm = r.summary || {};
    var h = '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">';
    [['子任务', sm.total], ['成功', sm.ok], ['失败', sm.failed],
     ['总跨度', sm.span != null ? _dur(sm.span) : '—']].forEach(function(c){
      h += '<div style="border:1px solid var(--border);border-radius:6px;padding:5px 12px;background:var(--bg)">'+
        '<div style="font-size:10px;color:var(--text3)">'+c[0]+'</div><div style="font-size:14px;font-weight:600">'+c[1]+'</div></div>';
    });
    h += '</div>';
    if (!(r.children||[]).length){
      h += '<div style="font-size:12px;color:var(--text3)">该 flow 暂无关联的任务记录 (flow 引擎自 v5.19.5 起写入统一日志)</div>';
    } else {
      h += '<div style="font-size:11px;color:var(--text3);margin-bottom:6px">按启动时序 (点击行可看单任务链路)</div>';
      h += '<table style="width:100%;border-collapse:collapse;font-size:11px">'+
        '<tr style="color:var(--text3)"><td style="padding:3px 6px">时间</td><td>类型</td><td>任务</td><td>引擎</td><td>状态</td><td>耗时</td><td>阶段</td><td></td></tr>';
      (r.children||[]).forEach(function(c){
        var stCol = c.status==='ok'||c.status==='success' ? 'var(--green)' : (c.status==='failed' ? 'var(--red)' : 'var(--text3)');
        var stages = [];
        if (c.stages.plan) stages.push('<span style="color:var(--cyan)" title="Planner">P</span>');
        if (c.stages.l2) stages.push('<span style="color:var(--purple)" title="L2 加密">🔐</span>');
        if (c.stages.verify) stages.push('<span style="color:var(--green)" title="Ledger 对账">✓</span>');
        if (c.stages.fallback) stages.push('<span style="color:var(--orange)" title="降级重试">↩</span>');
        h += '<tr style="border-bottom:1px dashed var(--border)">'+
          '<td style="padding:3px 6px;color:var(--text3)">'+esc(new Date((c.started_ts||0)*1000).toLocaleTimeString())+'</td>'+
          '<td style="padding:3px 6px">'+esc(c.kind||'')+'</td>'+
          '<td style="padding:3px 6px;max-width:170px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+esc(c.label||'')+'">'+esc(c.label||c.run_id)+'</td>'+
          '<td style="padding:3px 6px">'+esc(c.engine||'')+'</td>'+
          '<td style="padding:3px 6px;color:'+stCol+'">'+esc(c.status||'')+'</td>'+
          '<td style="padding:3px 6px;color:var(--text3)">'+_dur(c.duration)+'</td>'+
          '<td style="padding:3px 6px;text-align:center">'+(stages.join(' ')||'<span style="color:var(--text3)">—</span>')+'</td>'+
          '<td style="padding:3px 6px"><button class="btn btn-sm" style="padding:1px 6px;font-size:10px;color:var(--cyan)" onclick="this.closest(\'.modal-backdrop\').remove();RunLogPage.showTrace(\''+esc(c.run_id)+'\')">🔗 链路</button></td></tr>';
      });
      h += '</table>';
    }
    body.innerHTML = h;
  }

  g.RunLogPage = { refresh: refresh, showDetail: showDetail, showTrace: showTrace, showTree: showTree };
  document.addEventListener('DOMContentLoaded', function(){
    // 行点击 → 明细 (事件委托)
    document.addEventListener('click', function(ev){
      var tr = ev.target && ev.target.closest ? ev.target.closest('tr[data-run]') : null;
      if (tr && !ev.target.closest('button')) g.RunLogPage.showDetail(tr.getAttribute('data-run'));
    });
  });
})(window);
