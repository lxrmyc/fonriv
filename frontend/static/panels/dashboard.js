/* v4.14.0-alpha1 · 数据总览面板
 *
 * WS 协议：
 *   send({action:'dashboard_overview'}, cb) -> {status, kpi, by_type, retention_30d, remote_count}
 *   send({action:'dashboard_timeline', days:30}, cb) -> {status, days, timeline:[{date,total,ok,failed,bytes}]}
 */
(function(){
  'use strict';

  function rpc(action, data){
    return new Promise(function(resolve){
      try { window.send(Object.assign({action:action}, data||{}), resolve); }
      catch(e){ console.warn('rpc failed', action, e); resolve({status:'err', msg:String(e)}); }
    });
  }

  function esc(s){
    return String(s==null?'':s).replace(/[&<>"']/g, function(c){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
    });
  }

  function fmtBytes(n){
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n/1024).toFixed(1) + ' KB';
    if (n < 1073741824) return (n/1048576).toFixed(1) + ' MB';
    if (n < 1099511627776) return (n/1073741824).toFixed(2) + ' GB';
    return (n/1099511627776).toFixed(2) + ' TB';
  }

  function fmtDuration(sec){
    sec = Number(sec) || 0;
    if (sec < 60) return sec.toFixed(1) + ' 秒';
    if (sec < 3600) return (sec/60).toFixed(1) + ' 分钟';
    return (sec/3600).toFixed(2) + ' 小时';
  }

  function typeLabel(t){
    var m = {
      'rsync':'📁 rsync','platform_backup':'🐧 平台备份',
      'auto_backup':'⚙ 一键备份','lvm':'💽 LVM','zfs':'🗄 ZFS',
      'rbd':'🌐 Ceph RBD','pbs':'📚 PBS','vzdump':'📦 vzdump',
    };
    return m[t] || ('📦 ' + t);
  }

  var LAST = { kpi:null, by_type:[], retention:{}, timeline:[], hourly:null, sys:null };

  /* v6.1.0 · webui 参考稿口径的资源行 (res-row: 图标 + 名称/数值 + 5px 进度条) */
  function _resRow(icon, key, val, percent, color){
    var pct = Math.max(0, Math.min(100, Number(percent) || 0));
    return '<div class="res-row">'
      + '<span class="res-ic">'+icon+'</span>'
      + '<div class="res-body">'
      + '<div class="res-hd"><span class="res-key">'+esc(key)+'</span><span class="res-val"'+(color?' style="color:'+color+'"':'')+'>'+esc(val)+'</span></div>'
      + '<div class="res-bg"><div class="res-fill" style="width:'+pct.toFixed(1)+'%;'+(color?'background:'+color:'')+'"></div></div>'
      + '</div></div>';
  }

  function renderSysStats(s){
    if (!s) return;
    LAST.sys = s;
    var host = document.getElementById('dashSysBars');
    if (!host) return;
    var mem = s.memory || {}, disk = s.disk || {}, cpu = s.cpu_percent || 0;
    var la = s.load || [0,0,0];
    var cores = Math.max(1, (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 1);
    var laPct = Math.min(100, la[0] / cores * 100);
    host.innerHTML = [
      _resRow('⚡', 'CPU · '+cores+'核', cpu.toFixed(1)+'%', cpu,
              cpu>=80?'var(--red)':(cpu>=50?'var(--orange)':'var(--green)')),
      _resRow('💾', '内存', fmtBytes(mem.used||0)+' / '+fmtBytes(mem.total||0), mem.percent||0,
              (mem.percent||0)>=90?'var(--red)':((mem.percent||0)>=70?'var(--orange)':'var(--blue)')),
      _resRow('💿', '磁盘 /', fmtBytes(disk.used||0)+' / '+fmtBytes(disk.total||0), disk.percent||0,
              (disk.percent||0)>=90?'var(--red)':((disk.percent||0)>=70?'var(--orange)':'var(--purple)')),
      _resRow('📡', 'Load1', la[0].toFixed(2)+' / '+cores+'核', laPct,
              laPct>=100?'var(--red)':(laPct>=70?'var(--orange)':'var(--blue)')),
    ].join('');
    var meta = document.getElementById('dashSysMeta');
    if (meta){
      var up = Math.max(0, s.uptime_sec||0);
      var days = Math.floor(up/86400), hours = Math.floor((up%86400)/3600);
      /* v1.0.0 · i18n: 时长是数据, 整句走 t() 参数(数字模板兜不住自由组合的 d/h) */
      meta.textContent = (typeof window.t === 'function')
        ? window.t('已运行 {d}d {h}h', {d: days, h: hours})
        : ('已运行 '+days+'d '+hours+'h');
    }
  }

  function renderKpi(kpi, remoteCount){
    var host = document.getElementById('dashKpi');
    if (!host) return;
    /* v6.1.3 · 用户指定效果图: 备份统计改 webui 口径"一排四卡"(置于 SSH 服务器/系统状态 主网格上方),
       原 3 个二级指标(平均大小/最近时间/最活跃类型)并入副文本行, 不再单占一行 */
    var avgSize = kpi.avg_backup_bytes ? fmtBytes(kpi.avg_backup_bytes) : '-';
    var lastBk = kpi.last_backup_at ? kpi.last_backup_at.slice(5, 16) : '无';
    var topType = kpi.most_active_type || '-';
    var typeMap = {rsync:'📁 rsync', vzdump:'📦 vzdump', lvm:'🧊 LVM', zfs:'🏊 ZFS',
                   rbd:'💿 RBD', pbs:'🏛 PBS', platform_backup:'🐧 平台', auto_backup:'⚡ 自动'};
    var okRate = kpi.total ? Math.round(kpi.ok / kpi.total * 100) : 0;
    var cards = [
      { key:'total', ic:'🗄', label:'备份总数', value: kpi.total,
        sub: '✓ '+kpi.ok+' · ✗ '+kpi.failed+' · 最近 '+lastBk,
        color:'var(--blue)', bar: okRate },
      { key:'ok', ic:'✅', label:'成功率', value: kpi.success_rate+'%',
        sub: kpi.running ? '▶ 运行中 '+kpi.running : '最活跃 '+(typeMap[topType]||topType),
        color: kpi.success_rate>=95?'var(--green)':(kpi.success_rate>=80?'var(--orange)':'var(--red)'),
        bar: Math.max(0, Math.min(100, kpi.success_rate||0)) },
      { key:'bytes', ic:'📦', label:'累计备份', value: fmtBytes(kpi.total_bytes),
        sub: kpi.total_files+' 文件 · 平均 '+avgSize, color:'var(--purple)', bar: 0 },
      { key:'avg', ic:'⏱', label:'平均耗时', value: fmtDuration(kpi.avg_duration_sec),
        sub: '远端 '+remoteCount+' 个', color:'var(--cyan)', bar: 0 },
    ];
    host.innerHTML = cards.map(function(c){
      return '<div class="kpi">'
        + '<div class="kpi-hd"><span class="kpi-ic">' + c.ic + '</span>' + esc(c.label) + '</div>'
        + '<div class="kpi-v" style="color:' + c.color + '">' + esc(c.value) + '</div>'
        + '<div class="kpi-s">' + esc(c.sub) + '</div>'
        + '<canvas class="dashSpark" data-key="'+ c.key +'" width="140" height="26" '
          + 'style="width:100%;height:26px;max-width:140px;opacity:.8"></canvas>'
        + '<div class="kpi-bar"><i style="width:'+ (c.bar||0) +'%"></i></div>'
        + '</div>';
    }).join('');
    _drawSparks();
  }

  function _drawSparks(){
    // 若已有 hourly 数据则立即画；否则拉一次
    if (LAST.hourly){ _paintSparks(LAST.hourly); return; }
    rpc('dashboard_hourly').then(function(r){
      if (r && r.status === 'ok'){
        LAST.hourly = r.hourly || [];
        _paintSparks(LAST.hourly);
      }
    });
  }

  function _paintSparks(hourly){
    var cvs = document.querySelectorAll('#dashKpi canvas.dashSpark');
    if (!cvs.length || !hourly || !hourly.length) return;
    for (var i=0; i<cvs.length; i++){
      var c = cvs[i];
      var key = c.getAttribute('data-key');
      var series = hourly.map(function(b){
        if (key === 'ok') return b.ok;
        if (key === 'total') return b.total;
        return b.total;   // bytes/avg 目前用 total 兜底（后端未按小时聚合字节）
      });
      _drawSpark(c, series, key === 'ok' ? '#7ee787' : (key === 'total' ? '#79c0ff' : '#a5d6ff'));
    }
  }

  function _drawSpark(canvas, data, color){
    var ctx = canvas.getContext('2d');
    var w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    var mx = Math.max.apply(null, data.concat([1]));
    ctx.strokeStyle = color; ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (var i=0; i<data.length; i++){
      var x = (i / (data.length - 1)) * (w - 2) + 1;
      var y = h - ((data[i] / mx) * (h - 4)) - 2;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    // 填色底
    ctx.lineTo(w-1, h); ctx.lineTo(1, h); ctx.closePath();
    ctx.fillStyle = color + '22'; ctx.fill();
  }


  function renderByType(list){
    var host = document.getElementById('dashByType');
    if (!host) return;
    if (!list || !list.length){
      host.innerHTML = rpState({ state: 'empty', msg: '暂无数据' });
      return;
    }
    var maxCount = list.reduce(function(m,x){return Math.max(m, x.count||0);}, 1);
    host.innerHTML = list.map(function(t){
      var pct = Math.round((t.count||0) * 100 / maxCount);
      return '<div style="display:flex;align-items:center;gap:8px;padding:5px 0">'
        + '<div style="width:120px">'+ esc(typeLabel(t.type)) +'</div>'
        + '<div style="flex:1;background:var(--bg3);border-radius:4px;height:8px;overflow:hidden">'
        + '<div style="background:var(--blue);height:100%;width:'+ pct +'%"></div>'
        + '</div>'
        + '<div style="width:70px;text-align:right;color:var(--text2)">'+ (t.count||0) +'</div>'
        + '<div style="width:90px;text-align:right;color:var(--text3);font-size:11px">'+ fmtBytes(t.bytes) +'</div>'
        + '</div>';
    }).join('');
  }

  function renderRetention(r){
    var host = document.getElementById('dashRetention');
    if (!host) return;
    host.innerHTML = ''
      + '<div style="display:flex;justify-content:space-between;padding:5px 0"><span style="color:var(--text2)">执行次数</span><b>'+ (r.runs||0) +'</b></div>'
      + '<div style="display:flex;justify-content:space-between;padding:5px 0"><span style="color:var(--text2)">清理记录</span><b>'+ (r.records||0) +'</b></div>'
      + '<div style="display:flex;justify-content:space-between;padding:5px 0"><span style="color:var(--text2)">释放空间</span><b style="color:var(--green)">'+ fmtBytes(r.bytes) +'</b></div>'
      + '<div style="margin-top:8px;text-align:right"><a onclick="switchTab(\'settings\')" style="color:var(--blue);cursor:pointer;font-size:12px">→ 查看详情</a></div>';
  }

  function drawTimeline(timeline, days){
    var cvs = document.getElementById('dashTimeline');
    var empty = document.getElementById('dashTimelineEmpty');
    if (!cvs) return;
    if (!timeline || !timeline.length){
      cvs.style.display = 'none';
      if (empty) empty.style.display = '';
      return;
    }
    cvs.style.display = '';
    if (empty) empty.style.display = 'none';

    var dpr = window.devicePixelRatio || 1;
    var cssW = cvs.clientWidth || 900, cssH = cvs.clientHeight || 190;
    /* v6.3.15 · 统一图表底座: 清屏/尺寸/DPR 一律走 rpChart(全站一张图看起来才像一套) */
    var _rc = window.rpChart ? rpChart.clear(cvs) : null;
    if (_rc) { cssW = _rc.w; cssH = _rc.h; }
    var ctx = _rc ? _rc.ctx : cvs.getContext('2d');
    if (!_rc) {
      cvs.width = cssW * dpr; cvs.height = cssH * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);
    }

    // 填充完整日期序列
    var series = [];
    var end = new Date();
    for (var i = days - 1; i >= 0; i--){
      var d = new Date(end.getFullYear(), end.getMonth(), end.getDate() - i);
      var key = d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
      var b = timeline.find(function(x){ return x.date === key; });
      series.push({ date: key, ok: b ? b.ok : 0, failed: b ? b.failed : 0, total: b ? b.total : 0 });
    }
    var maxV = Math.max.apply(null, series.map(function(x){return x.total;}).concat([1]));
    var pad = { l: 40, r: 12, t: 12, b: 26 };
    var chartW = cssW - pad.l - pad.r;
    var chartH = cssH - pad.t - pad.b;

    var css = getComputedStyle(document.documentElement);
    var _P = window.rpChart ? rpChart.pal() : null;
    var text3  = _P ? _P.text : (css.getPropertyValue('--text3').trim() || '#888');
    var green  = _P ? _P.c2   : (css.getPropertyValue('--green').trim() || '#4ade80');
    var red    = _P ? _P.c3   : (css.getPropertyValue('--red').trim()   || '#f87171');
    var border = _P ? _P.grid : (css.getPropertyValue('--border').trim() || '#333');

    /* v6.3.15 · 坐标框 / 横向网格 / Y 刻度 / X 标签统一交给 rpChart.axes
       (此前各图自己画, 网格透明度、刻度取整、标签间距都不一致) */
    var _labelStep = Math.max(1, Math.ceil(series.length / 10));
    var _plot = window.rpChart ? rpChart.axes(ctx, cssW, cssH, {
      pad: pad, yMax: maxV, yTicks: 4,
      xLabels: series.map(function(s){ return s.date.slice(5); }),
      labelEvery: _labelStep
    }) : null;
    if (_plot) {
      pad = { l: _plot.x0, t: _plot.y0, r: cssW - _plot.x1, b: cssH - _plot.y1 };
      chartW = _plot.w; chartH = _plot.h;
    } else {
      // 图标/图表底座未加载时的**原实现兜底**(不静默跳过绘制)
      ctx.strokeStyle = border; ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(pad.l, pad.t);
      ctx.lineTo(pad.l, pad.t+chartH);
      ctx.lineTo(pad.l+chartW, pad.t+chartH);
      ctx.stroke();
      ctx.fillStyle = text3; ctx.font = '10px sans-serif';
      for (var k = 0; k <= 4; k++){
        var val = Math.round(maxV * k / 4);
        var y = pad.t + chartH - (chartH * k / 4);
        ctx.fillText(String(val), 4, y+3);
        if (k > 0){
          ctx.strokeStyle = border; ctx.globalAlpha = 0.25;
          ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(pad.l+chartW, y); ctx.stroke();
          ctx.globalAlpha = 1;
        }
      }
    }

    // 堆叠柱：绿=ok / 红=failed
    var barW = chartW / series.length * 0.72;
    var gap  = chartW / series.length * 0.28;
    series.forEach(function(s, i){
      var x = pad.l + i * (barW + gap) + gap/2;
      var hOk = (s.ok / maxV) * chartH;
      var hFail = (s.failed / maxV) * chartH;
      // ok（下）
      ctx.fillStyle = green;
      ctx.fillRect(x, pad.t + chartH - hOk, barW, hOk);
      // failed（上叠）
      if (hFail > 0){
        ctx.fillStyle = red;
        ctx.fillRect(x, pad.t + chartH - hOk - hFail, barW, hFail);
      }
    });

    // X label 稀疏(走 rpChart.axes 时已统一绘制, 不重复画)
    if (!_plot) {
      ctx.fillStyle = text3;
      var step = _labelStep;
      series.forEach(function(s, i){
        if (i % step !== 0 && i !== series.length - 1) return;
        var x = pad.l + i * (barW + gap) + gap/2 + barW/2;
        ctx.fillText(s.date.slice(5), x - 12, pad.t + chartH + 16);
      });
    }

    // Legend
    ctx.fillStyle = green; ctx.fillRect(pad.l, 2, 10, 6);
    ctx.fillStyle = text3; ctx.fillText('成功', pad.l + 14, 8);
    ctx.fillStyle = red;   ctx.fillRect(pad.l + 46, 2, 10, 6);
    ctx.fillStyle = text3; ctx.fillText('失败', pad.l + 60, 8);
  }

  function getRangeParams(){
    var daysSel = document.getElementById('dashDays');
    var val = daysSel ? daysSel.value : '30';
    if (val === 'custom'){
      var sd = document.getElementById('dashStartDate');
      var ed = document.getElementById('dashEndDate');
      return { start_date: sd ? sd.value : '', end_date: ed ? ed.value : '', days: 0 };
    }
    return { days: parseInt(val, 10) || 30, start_date: '', end_date: '' };
  }

  function onRangeChange(){
    var sel = document.getElementById('dashDays');
    var custom = document.getElementById('dashCustomRange');
    if (!sel || !custom) return;
    if (sel.value === 'custom'){
      custom.style.display = 'flex';
    } else {
      custom.style.display = 'none';
      refresh();
    }
  }

  async function refresh(){
    var params = getRangeParams();
    var days = params.days || 30;
    var overviewArgs = {};
    var timelineArgs = {};
    if (params.start_date && params.end_date){
      overviewArgs = { start_date: params.start_date, end_date: params.end_date };
      timelineArgs = { start_date: params.start_date, end_date: params.end_date };
    } else {
      timelineArgs = { days: days };
    }
    var [ov, tl, fs, dev] = await Promise.all([
      rpc('dashboard_overview', overviewArgs),
      rpc('dashboard_timeline', timelineArgs),
      (_isComm() ? Promise.resolve(null) : rpc('flow_run_stats', { days: days })),   // v6.16.2 批20: 社区版不发请求
      rpc('dashboard_devices', {}),      // v5.98.25 · 设备一览
    ]);
    /* v6.3.6 · 设备一览偶发返回 0 台(实测同会话 0/0/7 波动, 服务端 DB 确有 7 行 —
       疑与服务端该 action 的连接/时序有关, 待查)。这里做一次**有界重试**: 只在"0 台"时
       重取一次, 避免总览 SSH 区(含连接状态徽标)整块空着; 仍为 0 就如实渲染空状态。 */
    /* v6.3.12 · 触发条件收紧: 只在**该段整个缺失**(ssh 段没有或 count 为 null)时补取,
       **不再**因为 count===0 就重取/回退 —— 服务端如实报 0 时必须照实显示(否则等于用另一个
       语义的值覆盖真值, 违反「未知/空不得替换」)。真正的"偶发 0"根因(失败被渲染成 0)已在
       渲染层修掉, 这里的兜底只防"整段缺失"。 */
    if (dev && dev.status === 'ok' && (!dev.ssh || dev.ssh.count == null)){
      try {
        var dev2 = await rpc('dashboard_devices', {});
        if (dev2 && dev2.status === 'ok' && dev2.ssh && dev2.ssh.count != null) dev = dev2;
      } catch(e){}
    }
    /* v6.3.6 · 仍为 0 但**没有错误** → 回退到与左栏**同一个真源** `sp_list`
       (server_profiles 单一真源; 实测 dashboard_devices 的 ssh 段偶发返回 0 且 errors 为空)。
       目标: 总览的 SSH 区域与其"已连接/未连接"状态不因这条偶发空值而整块空着。 */
    /* 注: 不管 dev.errors 有没有内容都回退 —— 只要"没拿到服务器"就用同源 sp_list 兜住,
       否则总览 SSH 区会整块空着(用户看到的是"还没有服务器档案", 与左栏的 7 台自相矛盾)。 */
    if (dev && dev.status === 'ok' && (!dev.ssh || dev.ssh.count == null)){
      try {
        var sp = await rpc('sp_list', {});
        var profs = (sp && sp.status === 'ok' && sp.profiles) || [];
        if (profs.length){
          var items = profs.map(function(p){
            return { guid: p.guid, name: p.name || p.hostname || '', host: p.hostname || '',
                     port: p.ssh_port || 22, user: p.ssh_user || 'root',
                     os_type: p.os_type || '', arch: p.arch || '',
                     protocols_mask: p.protocols_mask || [], kind: p.kind || '',
                     kind_label: p.os_type || 'Linux', status: p.status || '',
                     latency_ms: p.last_latency_ms, via: 'sp_list' };
          });
          var on = items.filter(function(x){ return String(x.status || '').toLowerCase() === 'online'; }).length;
          dev = Object.assign({}, dev, { ssh: { count: items.length, items: items, online: on } });
        }
      } catch(e){ console.warn('[dashboard] ssh fallback', e); }
    }
    if (dev && dev.status === 'ok') renderDevices(dev);
    else if (dev) renderDevices(_devFail(dev.msg || dev.error));
    // v5.98.26 · 硬件扫描: 首次会真扫(服务端缓存 60s, 之后秒回), 不阻塞主刷新
    scanHw(false).catch(function(e){ console.warn('[dashboard] hw scan', e); });
    if (ov && ov.status === 'ok'){
      LAST.kpi = ov.kpi;
      LAST.by_type = ov.by_type || [];
      LAST.retention = ov.retention_30d || {};
      renderKpi(ov.kpi, ov.remote_count || 0);
      renderByType(ov.by_type || []);
      renderRetention(ov.retention_30d || {});
    }
    if (tl && tl.status === 'ok'){
      LAST.timeline = tl.timeline || [];
      drawTimeline(tl.timeline || [], days);
    }
    if (fs && fs.status === 'ok' && fs.stats){
      renderFlowStats(fs.stats, days);
    }
    renderWs();
    // v6.3.6 · 智能存储池状态(不阻塞主刷新) · v6.16.2 批18: 社区版不展示该区块也不发请求
    if ((window.__licFeatEdition || 'community') !== 'community')
      loadPools().catch(function(e){ console.warn('[dashboard] pools', e); });
    // v4.39.0 · 刷新引用一致性卡片
    refreshGraph();
  }

  // ============ v4.15.25 · Flow 运行报表 ============
  function _fmtBytes(n){
    n = Number(n)||0;
    if (n < 1024) return n+' B';
    if (n < 1048576) return (n/1024).toFixed(1)+' KB';
    if (n < 1073741824) return (n/1048576).toFixed(1)+' MB';
    if (n < 1099511627776) return (n/1073741824).toFixed(2)+' GB';
    return (n/1099511627776).toFixed(2)+' TB';
  }
  function _fmtSec(s){
    s = Number(s)||0;
    if (s < 60) return s.toFixed(1)+'s';
    if (s < 3600) return Math.floor(s/60)+'m'+Math.round(s%60)+'s';
    return Math.floor(s/3600)+'h'+Math.floor((s%3600)/60)+'m';
  }

  function renderFlowStats(stats, days){
    var meta = document.getElementById('dashFlowStatsMeta');
    if (meta) meta.textContent = '近 '+days+' 天 · 共 '+stats.total_runs+' 次运行';

    // KPI 卡
    var okRate = stats.total_runs > 0
      ? (stats.ok_runs * 100 / stats.total_runs).toFixed(1)
      : '—';
    var failRate = stats.total_runs > 0
      ? (stats.fail_runs * 100 / stats.total_runs).toFixed(1)
      : '—';
    var cells = [
      { label:'总运行',   value: stats.total_runs+' 次', color:'var(--text2)' },
      { label:'成功率',   value: okRate+' %',            color:'var(--green)' },
      { label:'失败率',   value: failRate+' %',
        color: (stats.fail_runs>0 ? 'var(--red)' : 'var(--text3)') },
      { label:'总上传',   value: _fmtBytes(stats.total_bytes), color:'var(--accent)' },
    ];
    var host = document.getElementById('dashFlowStatsKpi');
    if (host){
      host.innerHTML = cells.map(function(c){
        return '<div style="padding:8px;background:var(--bg2);border:1px solid var(--border);border-radius:var(--radius);text-align:center">'
          + '<div style="font-size:11px;color:var(--text3);margin-bottom:3px">'+esc(c.label)+'</div>'
          + '<div style="font-size:15px;color:'+c.color+';font-weight:600">'+esc(c.value)+'</div>'
          + '</div>';
      }).join('');
    }

    // 柱状图（按天 ok/fail）
    _drawFlowStatsChart(stats.by_day || []);

    // TOP 慢
    var slowHost = document.getElementById('dashFlowStatsTopSlow');
    if (slowHost){
      if (!stats.top_slow || !stats.top_slow.length){
        slowHost.innerHTML = rpState({ state: 'empty', msg: '暂无完成的运行' });
      } else {
        slowHost.innerHTML = stats.top_slow.map(function(r, i){
          return '<div style="display:flex;justify-content:space-between;padding:3px 6px;'
            + (i%2 ? 'background:var(--bg2);' : '') + 'border-radius:3px">'
            + '<span style="max-width:60%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'
            + '#'+r.flow_id+' '+esc(r.flow_name)+'</span>'
            + '<span style="color:var(--text3)">'+_fmtSec(r.avg_sec)+' · '+r.runs+' 次</span>'
            + '</div>';
        }).join('');
      }
    }

    // TOP 字节
    var bHost = document.getElementById('dashFlowStatsTopBytes');
    if (bHost){
      if (!stats.top_bytes || !stats.top_bytes.length){
        bHost.innerHTML = rpState({ state: 'empty', msg: '暂无字节传输' });
      } else {
        bHost.innerHTML = stats.top_bytes.map(function(r, i){
          return '<div style="display:flex;justify-content:space-between;padding:3px 6px;'
            + (i%2 ? 'background:var(--bg2);' : '') + 'border-radius:3px">'
            + '<span style="max-width:60%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'
            + '#'+r.flow_id+' '+esc(r.flow_name)+'</span>'
            + '<span style="color:var(--text3)">'+_fmtBytes(r.bytes)+' · '+r.runs+' 次</span>'
            + '</div>';
        }).join('');
      }
    }
  }

  function _drawFlowStatsChart(byDay){
    var c = document.getElementById('dashFlowStatsChart');
    if (!c || !c.getContext) return;
    var ctx = c.getContext('2d');
    var w = c.clientWidth || 600;
    var h = c.clientHeight || 150;
    c.width = w; c.height = h;
    ctx.clearRect(0,0,w,h);
    if (!byDay.length){
      ctx.fillStyle = getComputedStyle(document.body).getPropertyValue('--text3') || '#888';
      ctx.font = '12px sans-serif';
      ctx.fillText('近 N 天无 flow 运行记录', 12, h/2);
      return;
    }
    var pad = { l:30, r:8, t:10, b:22 };
    var innerW = w - pad.l - pad.r;
    var innerH = h - pad.t - pad.b;
    var maxV = 1;
    byDay.forEach(function(r){ maxV = Math.max(maxV, (r.ok||0) + (r.fail||0)); });
    var bw = innerW / byDay.length;
    // 坐标轴
    var textCol = getComputedStyle(document.body).getPropertyValue('--text3') || '#888';
    ctx.strokeStyle = getComputedStyle(document.body).getPropertyValue('--border') || '#333';
    ctx.beginPath();
    ctx.moveTo(pad.l, pad.t);
    ctx.lineTo(pad.l, pad.t+innerH);
    ctx.lineTo(pad.l+innerW, pad.t+innerH);
    ctx.stroke();
    ctx.fillStyle = textCol; ctx.font = '10px sans-serif';
    ctx.fillText('0', 8, pad.t+innerH+3);
    ctx.fillText(String(maxV), 8, pad.t+8);
    // 柱
    byDay.forEach(function(r, i){
      var x = pad.l + i*bw + 2;
      var totalH = ((r.ok||0)+(r.fail||0)) * innerH / maxV;
      var okH = (r.ok||0) * innerH / maxV;
      var failH = totalH - okH;
      // 成功
      ctx.fillStyle = '#67c23a';
      ctx.fillRect(x, pad.t+innerH - okH - failH, bw-4, okH);
      // 失败
      if (failH > 0){
        ctx.fillStyle = '#f56c6c';
        ctx.fillRect(x, pad.t+innerH - failH, bw-4, failH);
      }
      // 日期标签（只标首/尾/中）
      if (i === 0 || i === byDay.length-1 || i === Math.floor(byDay.length/2)){
        ctx.fillStyle = textCol;
        var lbl = String(r.date || '').slice(5); // MM-DD
        ctx.fillText(lbl, x, pad.t+innerH+14);
      }
    });
  }

  // ---- v4.39.0 · 引用一致性健康卡片 ----
  async function refreshGraph(){
    var r = await rpc('graph_integrity', {sub_action: 'check'});
    if (r && r.status === 'ok' && r.report){
      renderGraph(r.report);
    } else {
      var host = document.getElementById('dashGraphReport');
      if (host) host.innerHTML = '<div style="color:var(--text3)">查询失败</div>';
    }
  }

  function renderGraph(report){
    var host = document.getElementById('dashGraphReport');
    if (!host) return;
    var healthy = report.healthy || [];
    var dangling = report.dangling || [];
    var orphans = report.orphans || [];
    var summary = report.summary || {};
    var total = report.total_refs || 0;

    var meta = document.getElementById('dashGraphMeta');
    if (meta) meta.textContent = '· ' + total + ' 引用';

    // 状态指示
    var statusColor = dangling.length > 0 ? 'var(--red)' : (orphans.length > 0 ? 'var(--yellow)' : 'var(--green)');
    var statusText = dangling.length > 0 ? '⚠ 发现 ' + dangling.length + ' 个悬空引用' :
                     (orphans.length > 0 ? '● 健康 · ' + orphans.length + ' 个孤立实体' : '✓ 全部健康');

    var html = '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:8px">';
    html += _graphCell('总引用', total, 'var(--text)', 'all');
    html += _graphCell('健康', summary.healthy_count || healthy.length, 'var(--green)', 'healthy');
    html += _graphCell('悬空', summary.dangling_count || dangling.length, dangling.length > 0 ? 'var(--red)' : 'var(--text3)', 'dangling');
    html += _graphCell('孤立', summary.orphan_count || orphans.length, orphans.length > 0 ? 'var(--yellow)' : 'var(--text3)', 'orphans');
    html += '</div>';
    html += '<div style="font-size:12px;color:' + statusColor + ';padding:4px 0">' + esc(statusText) + '</div>';
    // v4.41.4 · 点击数字查看对应明细: 全量列表 + 当前 tab 高亮 + 切换 (默认悬空>孤立>健康)
    var defaultTab = dangling.length > 0 ? 'dangling' : (orphans.length > 0 ? 'orphans' : 'healthy');
    html += '<div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap">'
      + '<button class="btn btn-sm dgTab" data-tab="healthy" style="padding:1px 10px;font-size:11px">✓ 健康引用</button>'
      + '<button class="btn btn-sm dgTab" data-tab="dangling" style="padding:1px 10px;font-size:11px">⚠ 悬空引用</button>'
      + '<button class="btn btn-sm dgTab" data-tab="orphans" style="padding:1px 10px;font-size:11px">● 孤立实体</button>'
      + '<span style="flex:1"></span>'
      + '<span id="dgListInfo" style="font-size:11px;color:var(--text3);align-self:center"></span>'
      + '</div>';
    html += '<div id="dgListHost" style="max-height:180px;overflow-y:auto;margin-top:4px;border:1px solid var(--border);border-radius:6px;background:var(--bg2)"></div>';
    // 明细数据随身携带 (避免闭包外再查一次)
    html += '<script type="application/json" id="dgData">' + esc(JSON.stringify(report)) + '</scr' + 'ipt>';

    host.innerHTML = html;

    // v4.41.4 · 渲染某一 tab 的明细列表
    function _renderTab(tab){
      var listHost = document.getElementById('dgListHost');
      var info = document.getElementById('dgListInfo');
      if (!listHost) return;
      var rows = [];
      var title = '';
      if (tab === 'healthy'){ rows = healthy; title = '健康引用 (目标实体存在)'; }
      else if (tab === 'dangling'){ rows = dangling; title = '悬空引用 (目标实体已不存在)'; }
      else if (tab === 'orphans'){ rows = orphans; title = '孤立实体 (无任何引用指向)'; }
      else { rows = healthy.concat(dangling); title = '全部引用'; }
      var inner = '<div style="padding:4px 8px;font-size:11px;color:var(--text3);border-bottom:1px solid var(--border);position:sticky;top:0;background:var(--bg2)">'
        + esc(title) + ' · ' + rows.length + ' 条</div>';
      if (!rows.length){
        inner += '<div style="padding:10px;text-align:center;color:var(--text3);font-size:12px">（无）</div>';
      } else {
        rows.forEach(function(d){
          if (tab === 'orphans' || !d.source_table){
            // 孤立实体: 只有一张表+uuid
            inner += '<div style="display:flex;justify-content:space-between;padding:3px 6px;border-bottom:1px dashed var(--border);font-size:12px">'
              + '<span style="color:var(--yellow)">' + esc(d.table || d.entity_table || '') + '#' + esc(String(d.uuid || d.entity_uuid || '').slice(0,12)) + '</span>'
              + '<span style="color:var(--text3);font-size:11px">' + esc(d.name || d.title || '无引用指向') + '</span>'
              + '</div>';
          } else {
            var kind = d.ref_kind || '';
            var kindColor = kind.indexOf('required') >= 0 ? 'var(--red)' : 'var(--yellow)';
            inner += '<div style="display:flex;justify-content:space-between;padding:3px 6px;border-bottom:1px dashed var(--border);font-size:12px">'
              + '<span style="color:var(--text2)">' + esc(d.source_table) + '#' + esc(String(d.source_uuid).slice(0,8))
              + ' -> ' + esc(d.target_table) + '#' + esc(String(d.target_uuid).slice(0,12)) + '</span>'
              + '<span style="color:' + kindColor + ';font-size:11px">' + esc(d.source_field || '') + ' · ' + esc(kind) + '</span>'
              + '</div>';
          }
        });
      }
      listHost.innerHTML = inner;
      if (info) info.textContent = '显示 ' + rows.length + ' / ' + (total || rows.length) + ' 条';
      // tab 按钮高亮
      host.querySelectorAll('.dgTab').forEach(function(b){
        var on = (b.getAttribute('data-tab') === tab);
        b.style.background = on ? 'var(--blue)' : 'var(--bg2)';
        b.style.color = on ? '#fff' : 'var(--text2)';
        b.style.borderColor = on ? 'var(--blue)' : 'var(--border)';
      });
    }
    // 点击统计数字 -> 切 tab
    host.querySelectorAll('.dgCell').forEach(function(c){
      c.style.cursor = 'pointer';
      c.onclick = function(){ _renderTab(c.getAttribute('data-tab') || 'healthy'); };
    });
    host.querySelectorAll('.dgTab').forEach(function(b){
      b.onclick = function(){ _renderTab(b.getAttribute('data-tab')); };
    });
    _renderTab(defaultTab);
  }

  function _graphCell(label, value, color, tab){
    return '<div class="dgCell" data-tab="' + esc(tab || 'healthy') + '" style="padding:8px;background:var(--bg2);border-radius:6px;text-align:center;cursor:pointer;border:1px solid transparent" title="点击查看明细">'
      + '<div style="font-size:20px;font-weight:700;color:' + color + '">' + esc(String(value)) + '</div>'
      + '<div style="font-size:10px;color:var(--text3)">' + esc(label) + '</div>'
      + '</div>';
  }


  // ══════════════════════════════════════════════════════════════════
  // v5.98.25 · 设备一览(用户要求: 数据总览要能看到 SSH / 网络共享 / 远端磁盘 /
  //   云存储 / 容器 这些设备的信息)
  //   数据一律来自既有单一真源(server_profiles / share_list / remote_list /
  //   本机 lsblk+docker), 后端分段落采集; 某段失败**如实显示错误**, 不填零。
  // ══════════════════════════════════════════════════════════════════
  var DEV_LAST = null;
  var HWDATA = {};        // guid → 硬件扫描结果(v5.98.26)

  function _pctColor(p){
    if (p == null) return 'var(--text3)';
    return p >= 90 ? 'var(--red)' : (p >= 80 ? 'var(--orange)' : 'var(--green)');
  }
  function _short(s, n){ s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '…' : s; }
  /* v6.1.0 · webui 口径的协议徽章 (srv-proto + wui-bd-* 色系) */
  var _BD_CLS = {ssh:'wui-bd-ssh', pve:'wui-bd-pve', pve_api:'wui-bd-pve', rdp:'wui-bd-rdp', vnc:'wui-bd-rdp',
                 docker:'wui-bd-smb', truenas:'wui-bd-pve', remote_storage:'wui-bd-s3', s3:'wui-bd-s3',
                 seafile:'wui-bd-sea', smb:'wui-bd-smb', nfs:'wui-bd-smb', database:'wui-bd-rdp', pbs:'wui-bd-loc'};
  function _protoBadges(it){
    var mask = it.protocols_mask || [];
    if (mask.indexOf('ssh') < 0) mask = ['ssh'].concat(mask);
    var M = {pve_api:'PVE', rdp:'RDP', vnc:'VNC', docker:'DOCKER', truenas:'NAS',
             remote_storage:'S3', database:'DB', seafile:'Seafile', smb:'SMB', nfs:'NFS', s3:'S3', pbs:'PBS'};
    return mask.slice(0, 4).map(function(m){
      return '<span class="srv-proto si-bd ' + (_BD_CLS[m] || 'wui-bd-loc') + '">' + esc(M[m] || String(m).toUpperCase()) + '</span>';
    }).join('');
  }
  /* webui 状态点 (class 驱动, 便于统一辉光) */
  function _wDot(st){
    st = String(st || '').toLowerCase();
    var cls = (st === 'online' || st === 'up' || st === 'ok') ? 'on'
            : ((st === 'offline' || st === 'down') ? 'off' : 'warn');
    return '<span class="dot ' + cls + '" title="' + esc(st || '未探测') + '"></span>';
  }
  function _ago(ts){
    if (!ts) return '—';
    var t = Date.parse(String(ts).replace(' ', 'T'));
    if (isNaN(t)) return esc(String(ts).slice(0, 16));
    var s0 = Math.max(0, (Date.now() - t) / 1000);
    if (s0 < 60) return '刚刚';
    if (s0 < 3600) return Math.floor(s0 / 60) + ' 分钟前';
    if (s0 < 86400) return Math.floor(s0 / 3600) + ' 小时前';
    return Math.floor(s0 / 86400) + ' 天前';
  }

  /* v6.1.0 · 设备一览(dev-cards) + SSH 卡片网格(srv-grid) + 网络共享表(wui-tbl) — webui 参考稿 tab-dash */
  function renderDevices(d){
    var box = document.getElementById('dashDevices');
    if (!box) return;
    DEV_LAST = d || {};
    d = d || {};
    var errs = d.errors || {};
    /* v6.16.2 批20 · 会话竞态类错误("请先登录/会话已丢失" —— 登录瞬间发出的请求被拒)归一为
       "未配置"空态: 社区版新装首屏给添加引导而不是满屏红字(用户明令); 其它真失败仍如实显示 */
    var _sessErr = function(e){ e = String(e || ''); return e.indexOf('请先登录') >= 0 || e.indexOf('会话已') >= 0; };
    ['ssh','shares','cloud','containers','disks'].forEach(function(k){
      if (errs[k] && _sessErr(errs[k])){ delete errs[k]; if (!d[k]) d[k] = {}; if (d[k].count == null) d[k].count = 0; }
    });
    var ssh = d.ssh || {}, sh = d.shares || {}, dk = d.disks || {}, cl = d.cloud || {}, ct = d.containers || {};
    // v6.3.12 · "未知 ≠ 0": 只有确实拿到该段数据(count 有值)才显示数字, 否则显示 "—"
    var known = function (sec, errs2) { return sec && sec.count != null && !errs2; };

    // ── 设备一览: 5 张统计卡 (dev-cards), 点击跳对应页面
    /* v6.3.43 · 批 C(用户要求): 5 张卡各自带 key, 由 `devCards` 偏好**单独开关**
       (此前只能整块"设备一览"开/关 —— 想只关掉"容器"做不到)。 */
    var cards = [
      {k:'ssh',       ic:'🐧', cnt: errs.ssh ? '—' : (ssh.count != null ? ssh.count : '—'), lbl:'SSH 服务器',
       sub: errs.ssh ? '读取失败, 点击重试'
            : (ssh.count == null ? '读取中…'
               : (ssh.count ? ((ssh.online||0) + ' 在线 · ' + (ssh.count - ssh.online) + ' 待确认') : '未配置')),
       tgt:'conn_center', err:errs.ssh},
      {k:'share', ic:'🔗', cnt: errs.shares ? '—' : (sh.count != null ? sh.count : '—'), lbl:'网络共享',
       sub: errs.shares ? '读取失败, 点击重试' : (sh.count == null ? '读取中…'
            : (sh.mounted != null ? sh.mounted + ' 个已挂载' : '')), tgt:'shares', err:errs.shares},
      {k:'disk', ic:'💿', cnt: errs.disks ? '—' : (dk.local_total != null ? dk.local_total : (dk.local || []).length),
       lbl:'本机磁盘', sub:'含分区/卷', tgt:'disk_manager', err:errs.disks},
      {k:'cloud', ic:'☁️', cnt: errs.cloud ? '—' : (cl.count != null ? cl.count : '—'), lbl:'云存储',
       sub: errs.cloud ? '读取失败, 点击重试' : (cl.count == null ? '读取中…' : '对象存储/云盘'),
       tgt:'remotes', err:errs.cloud},
      {k:'container', ic:'🐳', cnt: errs.containers ? '—' : (ct.docker ? (ct.running || 0) : '—'), lbl:'容器',
       sub: ct.docker ? ('共 ' + (ct.total || 0) + ' 个 · 镜像 ' + (ct.images == null ? '?' : ct.images)) : (ct.note || ''),
       tgt:'docker', err:errs.containers},
    ];
    var _dc = _loadPrefs().devCards || {};              // v6.3.43 · 单卡开关
    var _dcComm = _isComm();                            // v6.16.2 批20 · 云存储卡(企业功能)社区版不渲染
    box.innerHTML = cards.filter(function(c){ return !(_dcComm && c.k === 'cloud') && _dc[c.k] !== false; }).map(function(c){
      return '<div class="dev-card" onclick="switchTab(\'' + c.tgt + '\')" title="' + (c.err ? '读取失败: ' + esc(c.err) : '打开对应页面') + '">'
        + '<div class="dev-ic">' + c.ic + '</div>'
        + '<div class="dev-count">' + esc(String(c.cnt)) + '</div>'
        + '<div class="dev-lbl">' + esc(c.lbl) + '</div>'
        + '<div class="dev-sub">' + esc(c.sub || '') + '</div>'
        + '</div>';
    }).join('');

    // ── SSH 服务器卡片网格 (srv-grid / srv-card)
    var grid = document.getElementById('dashSrvGrid');
    var title = document.getElementById('dashSshTitle');
    var hwOk = Object.keys(HWDATA).filter(function(k){ return HWDATA[k] && HWDATA[k].ok; }).length;
    if (title){
      /* v6.3.12 · 标题也不得"未知当 0": 没数据说"读取中…", 失败说"读取失败", 只有拿到真值才报台数 */
      var _sshSub = errs.ssh ? ('读取失败: ' + esc(errs.ssh) + ' · 点卡片重试')
                 : (ssh.count == null ? '读取中…'
                    : ('· ' + ssh.count + ' 台 · ' + (ssh.online || 0) + ' 在线'
                       + (hwOk ? ' · 已扫硬件 ' + hwOk + ' 台' : '')));
      title.innerHTML = '🐧 SSH 服务器 <span class="sub">' + _sshSub + '</span>';
    }
    if (grid){
      if (errs.ssh){
        grid.innerHTML = '<div style="grid-column:1/-1;color:var(--red);font-size:11.5px;padding:4px 0">读取失败: ' + esc(errs.ssh) + '</div>';
      } else {
        var items = ssh.items || [];
        if (!items.length){
          grid.innerHTML = '<div style="grid-column:1/-1">' + rpState({ state: 'empty', msg: '还没有服务器档案',
            hint: '去「连接中心」添加, 或用侧栏头部 ＋⁺ 恢复被移除的项' }) + '</div>';
        } else {
          grid.innerHTML = items.map(_srvCard).join('');
        }
      }
    }

    // ── 网络共享表 (wui-tbl: 名称/协议/状态/可用/已用%)
    var shTitle = document.getElementById('dashSharesTitle');
    var shBody = document.getElementById('dashSharesBody');
    if (shTitle) {
      /* v6.3.13 · 同源 bug 第三处: 该标题**完全不看 `errs.shares`** —— 读取失败照样写"0 个 · 0 已挂载",
         用户看到的"共享没了"其实是"没读到"(§3.7 静默回落)。与 SSH 标题同一契约: 未知说读取中, 失败说读取失败。 */
      var _shSub = errs.shares ? ('读取失败: ' + esc(errs.shares))
                 : (sh.count == null ? '读取中…' : ('· ' + sh.count + ' 个 · ' + (sh.mounted || 0) + ' 已挂载'));
      shTitle.innerHTML = '🔗 网络共享 <span class="sub">' + _shSub + '</span>';
    }
    if (shBody){
      if (errs.shares){
        shBody.innerHTML = '<tr><td colspan="5" style="color:var(--red);font-size:11.5px">读取失败: ' + esc(errs.shares) + '</td></tr>';
      } else if (!(sh.items || []).length){
        shBody.innerHTML = '<tr><td colspan="5">' + rpState({ state: 'empty', msg: '还没有网络共享' }) + '</td></tr>';
      } else {
        shBody.innerHTML = (sh.items || []).map(function(it){
          var usedPct = (it.size && it.used != null) ? Math.round(it.used * 100 / it.size) : null;
          var usedCol = usedPct == null ? 'var(--text3)' : (usedPct >= 90 ? 'var(--red)' : (usedPct >= 80 ? 'var(--orange)' : 'var(--text2)'));
          return '<tr>'
            + '<td style="color:var(--text);font-weight:500">' + esc(it.name || '') + '</td>'
            + '<td><span class="si-bd wui-bd-smb">' + esc(String(it.protocol || 'SMB').toUpperCase()) + '</span></td>'
            + '<td>' + (it.mounted ? '<span style="color:var(--green);font-size:11px">● 已挂载</span>'
                        : (it.path_exists ? '<span style="color:var(--orange);font-size:11px">○ 未挂载</span>'
                                          : '<span style="color:var(--text3);font-size:11px">— 无挂载点</span>')) + '</td>'
            + '<td class="r mono">' + (it.free != null ? fmtBytes(it.free) : '—') + '</td>'
            + '<td class="r mono" style="color:' + usedCol + '">' + (usedPct != null ? usedPct + '%' : '—') + '</td>'
            + '</tr>';
        }).join('');
      }
    }

    var meta = document.getElementById('dashDevicesMeta');
    if (meta) {
      var errN = Object.keys(errs).length;
      meta.textContent = errN ? errN + ' 段读取失败 · ' + new Date().toLocaleTimeString()
                              : '硬件扫描: ' + hwOk + '/' + (ssh.count || 0) + ' 台成功 · ' + new Date().toLocaleTimeString();
      meta.style.color = errN ? 'var(--orange)' : 'var(--text3)';
    }
  }

  /* 单台 SSH 服务器卡片 (webui srv-card): 状态点+名称 / host·os·延迟 / 协议徽章 / 4 格指标或错误 */
  /* v6.3.6 · 该服务器当前是否有活动会话(与左栏状态点同一真值: conn_list → __rpSessions) */
  function _sessOn(it){
    try {
      var arr = window.__rpSessions || [];
      var host = String(it.host || ''), port = String(it.port || 22);
      for (var i = 0; i < arr.length; i++){
        var s = arr[i] || {};
        if (String(s.host || '') === host && String(s.port || 22) === port) return true;
      }
    } catch(e){}
    return false;
  }

  function _srvCard(it){
    var hw = HWDATA[it.guid || ''];
    var lat = it.probe && it.probe.ok && it.probe.ms != null ? it.probe.ms + 'ms'
            : (it.latency_ms != null ? it.latency_ms + 'ms' : null);
    var meta = esc((it.host || '') + ':' + (it.port || '')) + ' · ' + esc(it.kind_label || 'Linux')
             + (lat ? ' · ' + esc(lat) : '');
    var body = '';
    if (!hw){
      body = '<div class="srv-err-msg" style="color:var(--text3)">未扫描 — 点上方「硬件扫描」</div>';
    } else if (!hw.ok){
      body = '<div class="srv-err-msg">⚠️ 扫描失败：' + esc(_short(hw.err || '未知原因', 40)) + '</div>';
    } else {
      var c = hw.cpu || {}, m = hw.mem || {}, ds = hw.disks || [], cn = hw.containers || {};
      var worst = null;
      (ds || []).forEach(function(x){ if (x.pct != null && (worst == null || x.pct > worst.pct)) worst = x; });
      function cell(lbl, val, warnAt, critAt){
        var v = (val == null || val === '') ? '?' : val;
        var num = parseFloat(v);
        var cls = (!isNaN(num) && num >= (critAt || 90)) ? ' crit' : ((!isNaN(num) && num >= (warnAt || 80)) ? ' warn' : '');
        return '<div class="srv-m"><div class="srv-m-lbl">' + lbl + '</div><div class="srv-m-val' + cls + '">' + esc(String(v)) + '</div></div>';
      }
      body = '<div class="srv-metrics">'
        + cell('CPU', c.usage_pct == null ? '?' : c.usage_pct + '%', 80, 90)
        + cell('内存', m.pct == null ? '?' : m.pct + '%', 80, 90)
        + cell('磁盘', worst ? worst.pct + '%' : '?', 80, 90)
        + cell('容器', !cn.docker ? '无' : ((cn.running || 0) + ' 运行'))
        + '</div>';
    }
    var _on = _sessOn(it);
    return '<div class="srv-card' + (hw && hw.ok === false ? ' err' : '') + '">'
      + '<div class="srv-top">' + _wDot(it.status) + '<div class="srv-name">' + esc(it.name || it.host || '') + '</div>'
      /* v6.3.6 · 连接/断开状态(用户要求): 有活动会话=已连接(绿), 否则=未连接(灰) */
      + '<span class="srv-conn' + (_on ? ' on' : '') + '" title="' + (_on ? '当前有活动会话(已连接)' : '当前无活动会话(未连接)') + '">'
      + (_on ? '● 已连接' : '○ 未连接') + '</span>'
      + '</div>'
      + '<div class="srv-meta">' + meta + '</div>'
      + '<div class="srv-protos">' + _protoBadges(it) + '</div>'
      + body
      + '</div>';
  }

  async function scanHw(refresh){
    var meta = document.getElementById('dashDevicesMeta');
    if (meta) meta.textContent = '⏳ 正在扫描服务器硬件 …';
    var r = await rpc('server_hw_scan', refresh ? { refresh: true } : {});
    if (r && r.status === 'ok') {
      (r.items || []).forEach(function(it){ if (it && it.guid) HWDATA[it.guid] = it; });
      if (DEV_LAST) renderDevices(DEV_LAST);
      if (meta) meta.textContent = '硬件扫描: ' + (r.ok_count || 0) + '/' + (r.scanned || 0) + ' 台成功 · '
        + new Date().toLocaleTimeString();
      return r;
    }
    if (meta) meta.textContent = '硬件扫描失败: ' + ((r && r.msg) || '未知');
    return r;
  }

  /* v6.3.12 · **失败态单一实现**(第二个同源 bug 就在这里: refreshDevices 也曾只塞 `errors['设备一览']`,
     渲染层读不到 `errors.ssh` 就按 0 渲染成"0 台")。任何失败路径都必须经此函数, 保证键名与渲染层一致。 */
  var _DEV_SECTIONS = ['ssh', 'shares', 'disks', 'cloud', 'containers'];
  function _devFail(msg){
    var m = msg || '读取失败';
    var e = { '设备一览': m };
    _DEV_SECTIONS.forEach(function (k) { e[k] = m; });
    return { status: 'error', errors: e };
  }

  async function refreshDevices(probe){
    var r = await rpc('dashboard_devices', probe ? { probe: true } : {});
    if (r && r.status === 'ok') renderDevices(r);
    else renderDevices(_devFail(r && (r.msg || r.error)));
  }

  // ---- v4.15.0-alpha3 · WebSocket 状态 widget ----
  function _wsStateName(ws){
    if (!ws) return 'DOWN';
    switch(ws.readyState){
      case 0: return 'CONNECTING';
      case 1: return 'OPEN';
      case 2: return 'CLOSING';
      case 3: return 'CLOSED';
      default: return '?';
    }
  }
  function renderWs(){
    var host = document.getElementById('dashWs');
    if (!host) return;
    // v4.43.0 · 连接信息缺失 (页面刷新会话恢复场景) -> 异步补拉一次
    var _cu = window.currentUser;
    if (_cu && !_cu.client_ip && !_cu._clientInfoFetching){
      _cu._clientInfoFetching = true;
      rpc('client_info_get').then(function(r){
        _cu._clientInfoFetching = false;
        if (r && r.status === 'ok'){
          _cu.client_ip = r.client_ip || '';
          _cu.client_host = r.client_host || '';
          try { localStorage.setItem('currentUser', JSON.stringify(_cu)); } catch(e){}
          renderWs();
        }
      }).catch(function(){ _cu._clientInfoFetching = false; });
    }
    var ws = window.ws || window._ws || null;
    var state = _wsStateName(ws);
    var color = (state === 'OPEN') ? 'var(--green)' :
                (state === 'CONNECTING' ? 'var(--orange)' : 'var(--red)');
    var url = ws && ws.url ? ws.url : '(未连接)';
    var user = (window.currentUser && window.currentUser.username) ? window.currentUser.username : '匿名';
    var role = (window.currentUser && window.currentUser.role) || '-';
    var lastPing = (window._lastWsPing || window._lastWsMsg || '');
    var cip = (window.currentUser && window.currentUser.client_ip) || '';
    var chost = (window.currentUser && window.currentUser.client_host) || '';
    var cells = [
      { label:'状态',    value: state },
      { label:'URL',     value: url.replace(/^wss?:\/\//,'') },
      { label:'用户',    value: user + ' · ' + role },
      { label:'连接 IP', value: cip || '-' },
      { label:'计算机名', value: chost || '-' },
      { label:'最近消息', value: lastPing || '-' },
    ];
    host.innerHTML = cells.map(function(c, i){
      return '<div class="wui-ws-c"><div class="wui-ws-cl">'+ esc(c.label) +'</div>'
        + '<div class="wui-ws-cv"'+(i===0?' style="color:'+color+';font-weight:600"':'')+'>'+ esc(c.value) +'</div></div>';
    }).join('');
    var dotEl = document.getElementById('dashWsDot');
    if (dotEl) dotEl.style.color = color;
    var meta = document.getElementById('dashWsMeta');
    if (meta){
      meta.textContent = 'readyState=' + (ws ? ws.readyState : '-') + ' · ' + new Date().toLocaleTimeString();
    }
  }

  /* ── v4.15.0-alpha3 · Widget 显隐 (localStorage 持久化) ─────────────────────────
     v6.3.43 · 批 C: 改成**单一真源**驱动 + 补两个实测缺陷 ——
       ① `DEFAULT_WIDGETS` 漏了 v6.3.6 新增的 `pools` → 合并后 `p.pools === undefined`
          → 智能存储池**永远默认隐藏**(页面上做了这个区块却看不到, 用户反馈"没有显示");
       ② 菜单复选框是**手写 HTML**, 与 WIDGET_MAP 各维护一份 → 新增 widget 两处都得改, 必漏。
     现在 WIDGET_DEFS 一份清单同时驱动: 默认值 / 菜单渲染 / 显隐应用。
     另: DEV_CARDS 让"设备一览"里的 5 张卡(SSH/共享/本机磁盘/云存储/容器)**可以单独开关**。 */
  var WIDGET_KEY = 'rp_dashboard_widgets_v1';
  /* v6.16.2 批20 · 社区版: 隐藏未开放功能的区块选项(智能存储池/Flow 运行报表)与云存储设备卡 */
  function _isComm(){ return (window.__licFeatEdition || 'community') === 'community'; }
  var WIDGET_DEFS = [
    ['ws',        'dashWsWidget',        '🔌 WebSocket 状态'],
    ['kpi',       'dashKpi',             '📊 KPI'],
    ['system',    'dashSystemStats',     '🖥 系统状态'],
    ['devices',   'dashDevicesWidget',   '🧩 设备一览'],
    ['pools',     'dashPoolWidget',      '🧊 智能存储池'],
    ['shares',    'dashSharesWidget',    '🔗 网络共享'],
    ['ssh',       'dashSshWidget',       '🐧 SSH 服务器'],
    ['timeline',  'dashTimelineWidget',  '📈 时间线'],
    ['bytype',    'dashByTypeWidget',    '📦 按类型分布'],
    ['retention', 'dashRetentionWidget', '🗑 保留策略'],
    ['verify',    'dashVerifyWidget',    '✅ 完整性校验'],
    ['graph',     'dashGraphWidget',     '🔗 引用一致性'],
    ['flowstats', 'dashFlowStatsWidget', '📈 Flow 运行报表'],
  ];
  var DEV_CARDS = [
    ['ssh',       '🐧 SSH 服务器'],
    ['share',     '🔗 网络共享'],
    ['disk',      '💿 本机磁盘'],
    ['cloud',     '☁️ 云存储'],
    ['container', '🐳 容器'],
  ];
  function _defWidgets(){
    var o = {};
    WIDGET_DEFS.forEach(function(d){ o[d[0]] = true; });
    o.devCards = {};
    DEV_CARDS.forEach(function(c){ o.devCards[c[0]] = true; });
    return o;
  }
  function _loadPrefs(){
    try {
      var d = _defWidgets();
      var raw = localStorage.getItem(WIDGET_KEY);
      if (!raw) return d;
      var p = JSON.parse(raw) || {};
      var o = Object.assign({}, d, p);
      // devCards 是**嵌套对象**, 必须深合并 —— 否则老偏好(没有新键)会把新卡整组吞掉
      o.devCards = Object.assign({}, d.devCards, p.devCards || {});
      return o;
    } catch(e){ return _defWidgets(); }
  }
  function _savePrefs(p){
    try { localStorage.setItem(WIDGET_KEY, JSON.stringify(p)); } catch(e){ console.warn(e); }
  }
  function applyWidgetPrefs(p){
    p = p || _loadPrefs();
    var _comm = _isComm();
    WIDGET_DEFS.forEach(function(d){
      var el = document.getElementById(d[1]);
      if (!el) return;
      if (_comm && (d[0] === 'pools' || d[0] === 'flowstats')){ el.style.display = 'none'; return; }   // v6.16.2 批20
      el.style.display = p[d[0]] ? '' : 'none';
    });
    /* 设备卡片的单卡开关: 只用**上次拿到的数据**重渲染 —— 首屏 DEV_LAST 还是 null 时
       绝不能空参调用 renderDevices(), 否则会把卡片刷成"—"(把"还没到"伪装成"没有")。 */
    try { if (DEV_LAST) renderDevices(DEV_LAST); } catch(e){}
  }
  function renderWidgetMenu(){
    var box = document.getElementById('dashWidgetMenu');
    if (!box) return;
    var p = _loadPrefs();
    var h = '<div style="color:var(--text2);margin-bottom:4px">选择显示的预览元素(自动保存到本地):</div>'
          + '<div style="display:flex;gap:12px;flex-wrap:wrap">';
    var _comm = _isComm();
    WIDGET_DEFS.forEach(function(d){
      if (_comm && (d[0] === 'pools' || d[0] === 'flowstats')) return;   // v6.16.2 批20: 社区版无此功能, 不出选项
      h += '<label><input type="checkbox" data-widget="' + d[0] + '"'
         + (p[d[0]] ? ' checked' : '') + '> ' + d[2] + '</label>';
    });
    h += '</div><div style="color:var(--text2);margin:8px 0 4px">「设备一览」内的卡片(可单独开关):</div>'
       + '<div style="display:flex;gap:12px;flex-wrap:wrap">';
    DEV_CARDS.forEach(function(c){
      if (_comm && c[0] === 'cloud') return;                              // v6.16.2 批20: 云存储卡(企业功能)不出选项
      h += '<label><input type="checkbox" data-devcard="' + c[0] + '"'
         + (p.devCards[c[0]] ? ' checked' : '') + '> ' + c[1] + '</label>';
    });
    h += '</div>';
    box.innerHTML = h;
    box.querySelectorAll('input[data-widget]').forEach(function(cb){
      cb.onchange = function(){ p[cb.getAttribute('data-widget')] = cb.checked; _savePrefs(p); applyWidgetPrefs(p); };
    });
    box.querySelectorAll('input[data-devcard]').forEach(function(cb){
      cb.onchange = function(){ p.devCards[cb.getAttribute('data-devcard')] = cb.checked; _savePrefs(p); applyWidgetPrefs(p); };
    });
  }
  function openWidgetMenu(){
    var box = document.getElementById('dashWidgetMenu');
    if (!box) return;
    if (box.style.display === 'none'){ renderWidgetMenu(); box.style.display = ''; }
    else { box.style.display = 'none'; }
  }

  /* ═══ v6.3.6 · 智能存储池状态(用户要求: 存储池状态也放进数据总览) ═══
     数据源: cpool_list(池与成员) + cpool_capacity(§12.3 容量口径, 分项如实呈现)。
     容量取不到就说"未知", **绝不把 Provisioned 当真实剩余**。 */
  async function loadPools(){
    var box = document.getElementById('dashPools');
    var meta = document.getElementById('dashPoolMeta');
    var title = document.getElementById('dashPoolTitle');
    if (!box) return;
    box.innerHTML = '<div style="grid-column:1/-1;font-size:11.5px;color:var(--text3)">⏳ 正在读取存储池 …</div>';
    var r = await rpc('cpool_list');
    if (!r || r.status !== 'ok'){
      box.innerHTML = '<div style="grid-column:1/-1;font-size:11.5px;color:var(--red)">✗ 读取失败: '
        + esc((r && r.msg) || '无响应') + '</div>';
      if (meta) meta.textContent = '';
      return;
    }
    var pools = r.pools || [];
    if (title) title.innerHTML = '🧊 智能存储池 <span class="sub">· ' + pools.length + ' 个</span>';
    if (!pools.length){
      box.innerHTML = '<div style="grid-column:1/-1">' + rpState({ state: 'empty', msg: '还没有存储池',
            hint: '去「存储池」页新建' }) + '</div>';
      if (meta) meta.textContent = '';
      return;
    }
    var htmls = [];
    for (var i = 0; i < pools.length; i++){
      var p = pools[i] || {};
      var cap = null;
      try {
        var cr = await rpc('cpool_capacity', { pool_id: p.id });
        if (cr && cr.status === 'ok') cap = cr.capacity || null;
      } catch(e){}
      var st = String(p.status || '');
      var stCol = (st === 'ACTIVE') ? 'var(--green)' : (st ? 'var(--orange)' : 'var(--text3)');
      var memCnt = p.member_count != null ? p.member_count
                 : ((p.members || []).length || null);
      var capTxt = '容量未知';
      if (cap){
        var free = cap.free_bytes, usable = cap.usable_bytes, unknown = cap.unknown_bytes;
        if (free != null && usable != null){
          capTxt = fmtBytes(free) + ' 可用 / ' + fmtBytes(usable);
          var pct = usable > 0 ? Math.round((usable - free) * 100 / usable) : null;
          if (pct != null) capTxt += ' (' + pct + '%)';
        } else if (unknown){
          capTxt = '容量未知(成员未探针 · Unknown ' + fmtBytes(unknown) + ')';
        }
      }
      htmls.push('<div class="dev-card">'
        + '<div class="dev-ic">🧊</div>'
        + '<div class="dev-main">'
        + '<div class="dev-nm">' + esc(p.name || p.id || '') + '</div>'
        + '<div class="dev-sub">状态 <span style="color:' + stCol + '">' + esc(st || '?') + '</span>'
        + (memCnt != null ? ' · 成员 ' + memCnt + ' 个' : '')
        + ' · ' + esc(capTxt) + '</div>'
        + '</div></div>');
    }
    box.innerHTML = htmls.join('');
    if (meta) meta.textContent = '更新于 ' + new Date().toLocaleTimeString();
  }

  window.Dashboard = {
    loadPools:      function(){ return loadPools(); },       // v6.3.6 · 存储池状态卡
    /* v6.3.6 · 由侧栏在 `sp_list` 到手后调用: 若总览 SSH 区还是空的, 用**同一份档案**
       补渲染(实测 dashboard_devices 的 ssh 段在首屏并发高峰时偶发返回 0; 这份是真源且已在手)。
       这样"SSH 区域 + 连接/断开状态"不会因为那一次抖动而整块空着。 */
    patchSshFromProfiles: function(profs){
      try {
        var grid = document.getElementById('dashSrvGrid');
        if (!grid || grid.querySelector('.srv-card')) return false;
        var arr = profs || [];
        if (!arr.length) return false;
        var items = arr.map(function(p){
          return { guid: p.guid, name: p.name || p.hostname || '', host: p.hostname || '',
                   port: p.ssh_port || 22, user: p.ssh_user || 'root', os_type: p.os_type || '',
                   protocols_mask: p.protocols_mask || [], kind: p.kind || '',
                   kind_label: p.os_type || 'Linux', status: p.status || '',
                   latency_ms: p.last_latency_ms, via: 'sp_list' };
        });
        renderDevices({ status: 'ok', ssh: { count: items.length, items: items,
                      online: items.filter(function(x){ return String(x.status||'').toLowerCase()==='online'; }).length },
                      shares: (LAST.devices && LAST.devices.shares) || null,
                      disks: (LAST.devices && LAST.devices.disks) || null,
                      cloud: (LAST.devices && LAST.devices.cloud) || null,
                      containers: (LAST.devices && LAST.devices.containers) || null,
                      errors: {} });
        return true;
      } catch(e){ console.warn('[dashboard] patchSsh', e); return false; }
    },
    refreshDevices: function(){ return refreshDevices(false); },
    probeDevices:   function(){ return refreshDevices(true); },
    scanServerHw:   function(){ return scanHw(true); },     // v5.98.26 · 强制重扫
    loadServerHw:   function(){ return scanHw(false); },    // 走服务端 60s 缓存
    refresh: refresh,
    renderWs: renderWs,
    openWidgetMenu: openWidgetMenu,
    applyWidgetPrefs: applyWidgetPrefs,
    onRangeChange: onRangeChange,
    refreshGraph: refreshGraph,
    _last: LAST,
  };

  // 挂载：切到 dashboard tab 自动刷新
  document.addEventListener('DOMContentLoaded', function(){
    var sel = document.getElementById('dashDays');
    if (sel) sel.onchange = onRangeChange;
    // 首次显隐 · widget 面板
    applyWidgetPrefs();
    // WS 状态定时轮询（v4.17.1 · 从 3s 放宽到 15s，事件也会触发刷新）
    setInterval(function(){
      var p = document.getElementById('panel-dashboard');
      if (p && p.classList.contains('active')) renderWs();
    }, 15000);
    // 首次若默认 active 是 dashboard，直接拉一次
    setTimeout(function(){
      var p = document.getElementById('panel-dashboard');
      if (p && p.classList.contains('active')) refresh();
    }, 200);
    // hook switchTab
    var oldSwitch = window.switchTab;
    if (typeof oldSwitch === 'function'){
      window.switchTab = function(t){
        var ret = oldSwitch.apply(this, arguments);
        try { if (t === 'dashboard') refresh(); } catch(e){ console.warn(e); }
        return ret;
      };
    }
    // v4.16.2 · 订阅 flow.run.finished / schedule.run.finished
    //          → dashboard 可见时增量刷新报表卡片
    if (window.EventBus){
      var _refPending = false;
      function _schedRefresh(){
        if (_refPending) return;
        _refPending = true;
        setTimeout(function(){
          _refPending = false;
          var p = document.getElementById('panel-dashboard');
          if (p && p.classList.contains('active')){
            try { refresh(); } catch(e){ console.warn('[dashboard] event refresh', e); }
          }
        }, 300);
      }
      window.EventBus.on('flow.run.finished', _schedRefresh);
      window.EventBus.on('schedule.run.finished', _schedRefresh);
      // v4.17.2 · retention.applied → dashboard 报表刷新（保留卡片依赖数据）
      window.EventBus.on('retention.applied', _schedRefresh);
      // v4.20.0 · task/backup 完成也刷新（KPI + by_type + timeline 都依赖）
      window.EventBus.on('task.finished', _schedRefresh);
      window.EventBus.on('pve.backup.finished', _schedRefresh);
      window.EventBus.on('platform.backup.finished', _schedRefresh);
      window.EventBus.on('remote.upload.finished', _schedRefresh);
      // v4.17.1 · 心跳 tick → 面板可见时刷新 WS 状态卡片
      window.EventBus.on('system.heartbeat', function(){
        var p = document.getElementById('panel-dashboard');
        if (p && p.classList.contains('active')){
          try { renderWs(); } catch(e){}
        }
      });
      // v4.23.0 · system.stats → 系统状态卡
      window.EventBus.on('system.stats', function(payload){
        try { renderSysStats(payload); } catch(e){ console.warn(e); }
      });
    }
    // v4.23.0 · 首次拉一次系统状态快照
    setTimeout(function(){
      rpc('system_stats').then(function(r){
        if (r && r.status === 'ok' && r.stats) renderSysStats(r.stats);
      });
    }, 500);

    // v4.38.0 · 备份验证统计
    window.refreshVerifyStats = function(){
      rpc('backup_verify_stats').then(function(r){
        if (r && r.status === 'ok'){
          var el = function(id){ return document.getElementById(id); };
          if (el('vfyTotal')) el('vfyTotal').textContent = r.total || 0;
          if (el('vfyVerified')) el('vfyVerified').textContent = r.verified || 0;
          if (el('vfyUnverified')) el('vfyUnverified').textContent = r.unverified || 0;
          if (el('vfyFailed')) el('vfyFailed').textContent = r.failed || 0;
        }
      });
    };

    // v4.38.0 · 批量验证所有备份
    window.batchVerifyBackups = function(){
      rpc('db_backup_list').then(async function(r){
        if (!r || r.status !== 'ok' || !r.backups || !r.backups.length){
          if (window.toast) window.toast('无备份记录可验证', 'warn');
          return;
        }
        var ids = r.backups.map(function(b){ return b.id; }).filter(Boolean);
        if (!ids.length){ if (window.toast) window.toast('无有效备份 ID', 'warn'); return; }
        if (!(await rpConfirm({ title:'批量验证备份', okText:'开始验证', body:'将对 '+ids.length+' 个备份执行 SHA256 验证，继续？' }))) return;
        if (window.toast) window.toast('开始批量验证 '+ids.length+' 个备份...', 'info');

        var ws = window.currentWs;
        function handler(event){
          try {
            var d = JSON.parse(event.data);
            if (d.type === 'batch_verify_done'){
              if (window.toast) window.toast('验证完成: '+d.ok+' 成功, '+d.failed+' 失败', d.failed ? 'warn' : 'ok');
              if (ws) ws.removeEventListener('message', handler);
              window.refreshVerifyStats();
            }
          } catch(e){}
        }
        if (ws) ws.addEventListener('message', handler);

        window.send({action:'backup_verify_batch', backup_ids:ids}, function(d){
          if (ws) ws.removeEventListener('message', handler);
          window.refreshVerifyStats();
        });
      });
    };

    // 首次加载验证统计
    setTimeout(window.refreshVerifyStats, 800);
  });
})();
