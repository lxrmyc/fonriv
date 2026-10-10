/* v6.3.17 · 三步上线引导(参考 QVMConsole 的"三步快速开始")
 *
 * 目的: 空环境/首次登录时, 用户面对一整套企业级侧栏常常不知道**从哪开始**。
 *   这里给一条最短上手路径: ① 添加第一台服务器 → ② 建一个存储池 → ③ 跑一次自动化流程。
 *
 * 纪律:
 *  · **只用已验证形状的真源**: `sp_list.profiles` / `cpool_list.pools` / `flow_runs.runs`
 *    (实现前逐一真实探测过; `share_list`/`schedule_list` 探测超时, 因此**不用**, 不猜)。
 *  · 取不到状态 → 显示**明确的失败态+重试**(rpState), **绝不**把"没读到"当成"未完成"或"已完成"。
 *  · **不打扰**: 全部完成 → 自动标记完成, 此后不再出现; 用户点「不再显示」也永久不再出现;
 *    需要时可在「系统设置 → 🚀 上手指南」重新打开。
 *  · 纯前端, 复用既有 action, **不新增门控/权限**(不碰 license 与用户权限表)。
 */
(function (g) {
  'use strict';

  var KEY = 'rp_onboard_v1';           // 'done' | 'hide'
  var STEPS = [
    { k: 'srv', n: 1, t: '添加第一台服务器', d: '在连接中心录入主机(SSH/Windows/NAS 均可), 之后所有功能都从它出发',
      page: 'conn_center', act: 'sp_list', arr: 'profiles' },
    { k: 'pool', n: 2, t: '建一个存储池', d: '把本机磁盘 / SSH 主机 / 对象存储聚合成统一命名空间',
      page: 'cloudpool', act: 'cpool_list', arr: 'pools' },
    { k: 'flow', n: 3, t: '跑一次自动化流程', d: '用流程编排备份/同步/校验, 跑通一次即完成上手',
      page: 'flows', act: 'flow_runs', arr: 'runs' }
  ];
  var ST = {};        // 各步状态: true=已完成 / false=未完成 / undefined=未读到

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function st() { return (g.rpState ? g.rpState : function (o) { return '<div>' + esc(o.msg || '') + '</div>'; }); }
  function el() { return document.getElementById('rpOnboard'); }
  function flag() { try { return localStorage.getItem(KEY) || ''; } catch (e) { return ''; } }
  function setFlag(v) { try { localStorage.setItem(KEY, v); } catch (e) { /* 隐私模式: 仅本次会话生效 */ } }

  function probe() {
    return STEPS.map(function (s) {
      return new Promise(function (res) {
        var done = false;
        var fin = function (v) { if (!done) { done = true; res({ k: s.k, v: v }); } };
        try {
          g.send({ action: s.act }, function (r) {
            if (r && r.status === 'ok' && Array.isArray(r[s.arr])) fin(r[s.arr].length > 0);
            else fin(undefined);                       // 读失败 → 未知(不冒充未完成)
          });
        } catch (e) { fin(undefined); }
        setTimeout(function () { fin(undefined); }, 9000);   // 有界: 不无限等
      });
    });
  }

  function render() {
    var b = el();
    if (!b) return;
    var known = STEPS.filter(function (s) { return ST[s.k] !== undefined; });
    var doneN = known.filter(function (s) { return ST[s.k]; }).length;
    var failed = STEPS.some(function (s) { return ST[s.k] === undefined; });

    var h = '<div class="ob-top"><span>🚀 上手指南 <span class="ob-n">' + doneN + '/' + STEPS.length + '</span></span>'
          + '<span><button class="btn btn-xs" onclick="Onboarding.close()" title="收起(不改变完成状态)">✕</button></span></div>'
          + '<div class="ob-body">';
    if (failed && doneN === 0) {
      h += st()({ state: 'error', msg: '上手进度读取失败', hint: '这不影响使用, 稍后重试即可',
                  retry: 'Onboarding.refresh(true)' });
    } else {
      STEPS.forEach(function (s) {
        var v = ST[s.k];
        var mark = v === undefined ? '<span class="ob-unk" title="状态未知(读取失败)">?</span>'
                 : (v ? '<span class="ob-ok">✓</span>' : '<span class="ob-todo">○</span>');
        h += '<div class="ob-row' + (v ? ' ob-done' : '') + '">' + mark
           + '<span class="ob-tx"><b>' + s.n + '. ' + esc(s.t) + '</b><span class="ob-d">' + esc(s.d) + '</span></span>'
           + (v ? '' : '<button class="btn btn-xs" onclick="Onboarding.go(\'' + s.page + '\')">去完成</button>')
           + '</div>';
      });
      if (failed) h += '<div class="ob-warn">部分进度读取失败(标 ? 的项), 不影响使用; 可点 🔄 重试。</div>';
    }
    h += '</div><div class="ob-foot">'
      + '<span class="ob-links"><a onclick="Onboarding.go(\'settings\')">去系统设置</a>'
      + ' · <a onclick="Onboarding.dismiss()">不再显示</a> · <a onclick="Onboarding.refresh(true)">🔄 刷新</a></span>'
      + '</div>';
    b.innerHTML = h;
  }

  function mount() {
    var exist = el();
    if (!exist) {
      exist = document.createElement('div');
      exist.id = 'rpOnboard';
      exist.className = 'ob-card';
      document.body.appendChild(exist);
    }
    return exist;
  }

  function show(force) {
    if (!force && flag()) return;                 // 已完成/已隐藏 → 不打扰
    if (force) { mount(); render(); }             // 主动打开: 先显示(带读数状态), 不让用户等
    Promise.all(probe()).then(function (rs) {
      rs.forEach(function (x) { ST[x.k] = x.v; });
      var allDone = STEPS.every(function (s) { return ST[s.k] === true; });
      if (allDone) { setFlag('done'); close(); return; }   // 全部完成 → 自动收尾, 不再打扰
      /* 自动路径:**探完再挂载** —— 已完成的用户不会看到卡片一闪而过(不闪烁/不打扰) */
      if (!force) mount();
      render();
    });
  }

  function close() { var b = el(); if (b) b.remove(); }
  function dismiss() { setFlag('hide'); close(); }
  function go(page) {
    try { switchTab(page); } catch (e) { /* 页面不可用(权限/未加载)时保持引导可见 */ }
    render();
  }
  function refresh(force) { ST = {}; show(true); }

  g.Onboarding = { show: show, close: close, dismiss: dismiss, go: go, refresh: refresh,
                   render: render, STEPS: STEPS, state: function () { return ST; } };
})(window);
