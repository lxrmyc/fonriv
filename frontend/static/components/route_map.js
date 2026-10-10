/* v5.66.0 · F2 **跨存储路由可视化** —— 把"这次复制走哪条路/为什么/兜底是什么"画成链路图。
 *
 * 数据面**完全复用**后端既有出入口: `fonr_transport_plan` → `backend/fonrvfs/transport.py::plan()`，
 * 返回 {strategy, label, how, reason, fallbacks[], implemented}。本文件**不判断策略**、不写死任何
 * 通路名称（策略清单的唯一真源在 transport.py 的 STRATEGY_INFO），只负责渲染：
 *   源存储 ──▶ [策略卡: label / how / 为什么] ──▶ 目标存储，下方列兜底链。
 */
(function (g) {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c];
    });
  }

  function sendRpc(action, data) {
    return new Promise(function (res) {
      if (typeof g.send !== 'function') { res({ status: 'error', msg: '未找到 WS 发送入口 window.send' }); return; }
      try { g.send(Object.assign({ action: action }, data || {}), function (r) { res(r || {}); }); }
      catch (e) { res({ status: 'error', msg: String(e) }); }
    });
  }

  /* ── 单行紧凑条(复制前快速提示用) ── */
  function strip(plan) {
    if (!plan) return '';
    return '<span class="rp-route-strip">' + esc(plan.label || plan.strategy || '') +
      (plan.implemented === false ? ' <span class="rp-route-warn">未实现</span>' : '') + '</span>';
  }

  /* ── 完整链路图 ── */
  function html(plan, meta) {
    plan = plan || {};
    meta = meta || {};
    var ok = plan.implemented !== false;
    var h = '';
    h += '<div class="rp-route">';
    // 源
    h += '<div class="rp-route-node"><div class="rp-route-ico">📤</div>' +
      '<div class="rp-route-nm">' + esc(meta.srcLabel || meta.src || '源') + '</div>' +
      (meta.srcSub ? '<div class="rp-route-sb">' + esc(meta.srcSub) + '</div>' : '') + '</div>';
    // 箭头 + 策略卡
    h += '<div class="rp-route-mid"><div class="rp-route-arrow">▶</div>' +
      '<div class="rp-route-card' + (ok ? '' : ' bad') + '">' +
      '<div class="rp-route-lb">' + esc(plan.label || plan.strategy || '未知通路') +
      (ok ? '' : ' <span class="rp-route-warn">未实现</span>') + '</div>' +
      '<div class="rp-route-how">' + esc(plan.how || '') + '</div>' +
      (plan.reason ? '<div class="rp-route-why">为什么: ' + esc(plan.reason) + '</div>' : '') +
      '<div class="rp-route-note">策略键: <code>' + esc(plan.strategy || '') + '</code></div>' +
      '</div></div>';
    // 目标
    h += '<div class="rp-route-node"><div class="rp-route-ico">📥</div>' +
      '<div class="rp-route-nm">' + esc(meta.dstLabel || meta.dst || '目标') + '</div>' +
      (meta.dstSub ? '<div class="rp-route-sb">' + esc(meta.dstSub) + '</div>' : '') + '</div>';
    h += '</div>';
    // 兜底链
    var fb = plan.fallbacks || [];
    h += '<div class="rp-route-fb"><div class="rp-route-fbt">若当前通路不可用，按序兜底:</div>' +
      (fb.length ? '<ol>' + fb.map(function (x) {
        return '<li>' + esc(x.label || x.strategy || x) +
          (x.how ? ' <span class="rp-route-how">' + esc(x.how) + '</span>' : '') +
          (x.reason ? ' <span class="rp-route-why">(' + esc(x.reason) + ')</span>' : '') + '</li>';
      }).join('') + '</ol>' : '<div class="rp-route-why">（无兜底：该场景只有这一条通路）</div>') +
      '</div>';
    return h;
  }

  /* ── 打开模态(自己取 plan) ── */
  function open(opts) {
    opts = opts || {};
    var old = document.getElementById('rpRouteModalBg');
    if (old) old.remove();
    var bg = document.createElement('div');
    bg.id = 'rpRouteModalBg';
    bg.className = 'rp-route-bg';
    bg.innerHTML = '<div class="rp-route-modal"><div class="rp-route-hd">🧭 本次复制的链路图' +
      '<span class="rp-route-close" title="关闭">✕</span></div>' +
      '<div id="rpRouteBody" class="rp-route-body">读取传输策略…</div>' +
      '<div class="rp-route-ft"><span class="rp-route-dim">策略由后端 transport.py 决定（前端不判断、不写死）</span>' +
      '<button class="btn btn-sm" id="rpRouteRefresh">重新判定</button></div></div>';
    document.body.appendChild(bg);
    // ⚠ 踩坑: 这里**不能**用 addEventListener(..., {once:true}) —— once 会在**任何**第一次按键后
    //   摘掉监听(不是"第一次按下 Escape 后"), 于是先按了别的键再按 Esc 就关不掉。改为显式挂/摘。
    var onKey = function (e) { if (e.key === 'Escape') close(); };
    var close = function () {
      document.removeEventListener('keydown', onKey, true);
      bg.remove();
    };
    bg.querySelector('.rp-route-close').onclick = close;
    bg.addEventListener('mousedown', function (e) { if (e.target === bg) close(); });
    document.addEventListener('keydown', onKey, true);

    var load = function () {
      var body = bg.querySelector('#rpRouteBody');
      if (!body) return;
      body.innerHTML = '读取传输策略…';
      sendRpc('fonr_transport_plan', {
        src_storage_id: opts.src || (opts.storages && opts.storages[0]) || '',
        dst_storage_id: opts.dst || (opts.storages && opts.storages[1]) || '',
        src_path: opts.srcPath || '', dst_path: opts.dstPath || '',
        presign: opts.presign !== false
      }).then(function (r) {
        var p = r && r.plan;
        if (!p) {
          body.innerHTML = '<div class="rp-route-err">拿不到传输策略: ' + esc((r && (r.msg || r.status)) || '无返回') +
            '</div><div class="rp-route-why">（不猜通路 —— 请检查源/目标存储是否都已选中）</div>';
          return;
        }
        body.innerHTML = html(p, opts.meta || {});
      });
    };
    bg.querySelector('#rpRouteRefresh').onclick = load;
    load();
    return bg;
  }

  g.RouteMap = { html: html, strip: strip, open: open };
})(window);
