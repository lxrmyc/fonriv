/* v6.3.9 · 任务中心(统一视图) —— 分析报告 ② 落地
 *
 * 背景: 任务/进度此前散在各面板(流程运行、后台作业、传输审计、定时计划),
 *   想知道"现在系统在忙什么"要翻四五个页面 —— 参考 QVMConsole 的「任务中心」做法收口到一处。
 *
 * 纪律:
 *  · **只用已验证形状的真源**: `fonr_job_list`(后台作业) / `flow_runs`(流程运行历史)。
 *    其它来源(action 名或形状未证实)一律不猜 —— 不为了凑数编数据。
 *  · 字段一律**防御式渲染**: 取不到就显示 `—`, 绝不把 undefined 画成 0/空成功。
 *  · 空/失败一律走公共三态组件 `rpState`(加载 ⏳ / 空 📭 / 失败 ✗ + 重试)。
 *  · 打开期间 3s 自刷, **页面失焦即暂停**(与顶栏状态条同口径), 关闭即停。
 */
(function (g) {
  'use strict';

  var TIMER = null;
  var ERR = { jobs: '', runs: '' };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function box() { return document.getElementById('taskHubBody'); }
  function st() { return (g.rpState ? g.rpState : function (o) { return '<div>' + esc(o.msg || '') + '</div>'; }); }
  function fmtTime(v) {
    if (!v) return '—';
    if (typeof v === 'number') { try { return new Date(v < 1e12 ? v * 1000 : v).toLocaleString(); } catch (e) { return '—'; } }
    var s = String(v);
    return s.length > 19 ? s.slice(0, 19).replace('T', ' ') : s;
  }
  function badge(state) {
    var s = String(state || '').toLowerCase();
    var col = 'var(--text3)';
    if (s.indexOf('run') >= 0 || s.indexOf('progress') >= 0) col = 'var(--blue)';
    else if (s.indexOf('ok') >= 0 || s.indexOf('success') >= 0 || s.indexOf('done') >= 0 || s.indexOf('complet') >= 0) col = 'var(--green)';
    else if (s.indexOf('fail') >= 0 || s.indexOf('err') >= 0) col = 'var(--red)';
    else if (s.indexOf('wait') >= 0 || s.indexOf('pend') >= 0 || s.indexOf('queue') >= 0) col = 'var(--orange)';
    return '<span class="th-bd" style="color:' + col + '">● ' + esc(state || '—') + '</span>';
  }

  function row(o) {
    var pct = (o.pct == null || isNaN(Number(o.pct))) ? null : Math.max(0, Math.min(100, Math.round(Number(o.pct))));
    return '<div class="th-row">'
      + '<span class="th-nm" title="' + esc(o.name) + '">' + esc(o.name) + '</span>'
      + badge(o.state)
      + '<span class="th-t">' + esc(fmtTime(o.time)) + '</span>'
      + '<span class="th-p">' + (pct == null ? '—' : (pct + '%')) + '</span>'
      + '</div>';
  }

  function section(title, items, err, emptyMsg) {
    var h = '<div class="th-h">' + title + '<span class="th-n">' + (items ? items.length : 0) + '</span></div>';
    if (err) return h + st()({ state: 'error', msg: err, retry: 'TaskHub.render(true)' });
    if (!items || !items.length) return h + st()({ state: 'empty', msg: emptyMsg || '暂无记录' });
    return h + items.map(row).join('');
  }

  function render(force) {
    var b = box();
    if (!b) return Promise.resolve();
    var jobs = g.__rpHubJobs, runs = g.__rpHubRuns;
    if (jobs == null && runs == null && !force) {
      b.innerHTML = st()({ state: 'loading', msg: '正在读取任务…' });
    }
    /* 功能裁剪: 后台作业(fonrvfs)/流程运行(flow) 属非社区功能键, 社区版不请求不显示 */
    var _lic = function(f){ return !(typeof window.licenseFeatEnabled === 'function' && !window.licenseFeatEnabled(f)); };
    if (!_lic('fonrvfs')) ERR.jobs = '__HIDE__';
    if (!_lic('flow')) ERR.runs = '__HIDE__';
    var p1 = new Promise(function (res) {
      if (ERR.jobs === '__HIDE__'){ g.__rpHubJobs = []; return res(); }
      g.send({ action: 'fonr_job_list' }, function (r) {
        if (r && r.status === 'ok' && Array.isArray(r.jobs)) { g.__rpHubJobs = r.jobs; ERR.jobs = ''; }
        else ERR.jobs = '读取后台作业失败: ' + ((r && r.msg) || '无响应');
        res();
      });
    });
    var p2 = new Promise(function (res) {
      if (ERR.runs === '__HIDE__'){ g.__rpHubRuns = []; return res(); }
      g.send({ action: 'flow_runs' }, function (r) {
        if (r && r.status === 'ok' && Array.isArray(r.runs)) { g.__rpHubRuns = r.runs; ERR.runs = ''; }
        else ERR.runs = '读取流程运行失败: ' + ((r && r.msg) || '无响应');
        res();
      });
    });
    return Promise.all([p1, p2]).then(function () {
      var j = (g.__rpHubJobs || []).map(function (x) {
        x = x || {};
        return { name: x.name || x.title || x.kind || x.id || '(未命名作业)',
                 state: x.status || x.state || '', time: x.created_at || x.started_at || x.ts || '',
                 pct: (x.pct != null ? x.pct : x.progress) };
      });
      var u = (g.__rpHubRuns || []).map(function (x) {
        x = x || {};
        return { name: x.flow_name || x.name || ('流程 ' + (x.flow_id || x.id || '')),
                 state: x.status || x.result || x.state || '', time: x.started_at || x.created_at || x.ts || '',
                 pct: (x.pct != null ? x.pct : x.progress) };
      });
      b.innerHTML = section('⚙ 后台作业', j, ERR.jobs, '暂无后台作业')
                  + section('🧩 流程运行', u, ERR.runs, '暂无流程运行记录')
                  + '<div class="th-foot">数据源: fonr_job_list / flow_runs · 每 3s 自刷(页面失焦暂停)</div>';
    });
  }

  function open() {
    var ov = document.getElementById('taskHubOv');
    if (ov) { ov.remove(); stop(); return; }
    ov = document.createElement('div');
    ov.id = 'taskHubOv';
    ov.className = 'th-ov';
    ov.innerHTML = '<div class="th-card">'
      + '<div class="th-top"><span>🗂 任务中心</span>'
      + '<span><button class="btn btn-xs" onclick="TaskHub.render(true)">🔄 刷新</button> '
      + '<button class="btn btn-xs" onclick="TaskHub.close()">✕</button></span></div>'
      + '<div id="taskHubBody" class="th-body"></div></div>';
    ov.addEventListener('click', function (e) { if (e.target === ov) g.TaskHub.close(); });
    document.body.appendChild(ov);
    render(true);
    start();
  }
  function start() {
    stop();
    TIMER = setInterval(function () {
      if (document.hidden) return;             // 失焦暂停(与顶栏状态条同口径)
      render(false);
    }, 3000);
  }
  function stop() { if (TIMER) { clearInterval(TIMER); TIMER = null; } }
  function close() {
    stop();
    var ov = document.getElementById('taskHubOv');
    if (ov) ov.remove();
  }

  g.TaskHub = { open: open, close: close, render: render };
})(window);
