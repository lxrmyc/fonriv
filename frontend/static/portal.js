/* v5.65.0 · F1 **传送门 (Ctrl+G)** —— 全局快速跳转: 主机 / 存储 / 路径 / 面板动作。
 *
 * 设计要点:
 *   · 数据分两侧但**同源**: 主机/存储/最近路径由后端 `portal_search` 给(它复用 hub/VFS/fonr_recent),
 *     面板动作由本文件从 `window.NAV_TREE` 取(只有前端知道自己的面板);
 *   · 打分规则与后端 `backend/portal.py::fuzzy_score` **必须一致**(改一处要同步另一处);
 *   · 执行复用既有入口: 面板 → switchTab, 主机 → SP.fillByGuid, 存储/路径 → FonrVFS.openPath;
 *   · 最近使用: 面板/主机/存储记 localStorage, 路径类额外写服务端 fonr_recent(portal_hit)。
 */
(function (g) {          // 与 server_profile.js 一致: 形参 g = window
  'use strict';

  var MAX_RECENT = 20;
  var state = { open: false, items: [], index: 0, seq: 0, box: null, input: null, list: null };

  /* ── 打分: 与 backend/portal.py::fuzzy_score 保持同一套规则 ── */
  var SEP = ' _-/:\\|.、,，()[]{}<>';
  function fuzzyScore(query, text) {
    var q = String(query || '').trim().toLowerCase();
    var t = String(text || '').trim().toLowerCase();
    if (!q) return 1;
    if (!t) return 0;
    if (t === q) return 1200;
    if (t.indexOf(q) === 0) return 1000;
    for (var i = 1; i < t.length; i++) {
      if (SEP.indexOf(t.charAt(i - 1)) >= 0 && t.indexOf(q, i) === i) return 700;
    }
    var pos = t.indexOf(q);
    if (pos >= 0) return 400 + Math.max(0, 60 - pos);
    var idx = 0, gaps = 0, last = -1;
    for (var k = 0; k < q.length; k++) {
      var j = t.indexOf(q.charAt(k), idx);
      if (j < 0) return 0;
      if (last >= 0) gaps += j - last - 1;
      last = j; idx = j + 1;
    }
    if (gaps > q.length * 4) return 0;
    return Math.max(50, 200 - gaps * 3);
  }

  function scoreItem(q, it) {
    var best = 0;
    ['label', 'sub', 'path'].forEach(function (k) {
      if (it[k]) best = Math.max(best, fuzzyScore(q, it[k]));
    });
    return best;
  }

  /* ── 面板动作候选: 来自 NAV_TREE(含二级) ── */
  // v6.16.14 · 档位裁剪(用户要求: Ctrl+G 传送门清除非社区版条目):
  //   ① 子项 feat 未授权 → 不列; ② hideEditions 命中当前档位(如「核心运行状况」社区隐藏) → 不列;
  //   ③ **组节点**: 若其子项全部被裁掉(如「分享管理」整组 pro) → 组节点本身也不列。
  function _itemAllowed(it, node) {
    try {
      var edn = window.__licFeatEdition || 'community';
      if (it.feat && window.licenseFeatEnabled && !window.licenseFeatEnabled(it.feat)) return false;
      if (node && Array.isArray(node.hideEditions) && node.hideEditions.indexOf(edn) >= 0) return false;
    } catch (e) { /* 取不到就不隐藏, 交给 switchTab 自己判断 */ }
    return true;
  }
  function panelItems() {
    var out = [];
    (window.NAV_TREE || []).forEach(function (grp) {
      var _kids = [];
      if (grp.children && grp.children.length) {
        grp.children.forEach(function (c) {
          var it = { kind: 'panel', label: c.label || c.key, sub: '面板 · ' + (grp.label || ''),
                     target: { type: 'panel', panel: c.key }, feat: c.feat || grp.feat };
          if (_itemAllowed(it, c)) _kids.push(it);
        });
      }
      var _grpIt = { kind: 'panel', label: grp.label || grp.key, sub: '面板',
                     target: { type: 'panel', panel: grp.key }, feat: grp.feat };
      var _grpOk = _itemAllowed(_grpIt, grp);
      // 组节点: 有子项但**全部被档位裁掉**时(如「分享管理」整组 pro) → 组节点也不列
      if (grp.children && grp.children.length && _kids.length === 0) _grpOk = false;
      out = out.concat(_kids);
      if (_grpOk) out.push(_grpIt);
    });
    return out;
  }

  /* ── 最近使用(localStorage) ── */
  function recentKey() { return 'rp_portal_recent_' + (window.RP_USER || window.RP_USERNAME || 'u'); }
  function readRecent() {
    try { return JSON.parse(localStorage.getItem(recentKey()) || '[]') || []; } catch (e) { return []; }
  }
  function pushRecent(it) {
    try {
      var rows = readRecent().filter(function (r) {
        return JSON.stringify(r.target) !== JSON.stringify(it.target);
      });
      rows.unshift({ label: it.label, sub: it.sub, kind: it.kind, target: it.target, ts: Date.now() });
      localStorage.setItem(recentKey(), JSON.stringify(rows.slice(0, MAX_RECENT)));
    } catch (e) { /* 存不下就算了, 不影响跳转 */ }
  }

  function rpc(action, data) {
    return new Promise(function (res) {
      // 入口与 app.js 一致: window.send(data, cb)
      if (typeof g.send !== 'function') { res({ status: 'error', msg: '未找到 WS 发送入口 window.send' }); return; }
      try {
        g.send(Object.assign({ action: action }, data || {}), function (r) { res(r || {}); });
      } catch (e) { res({ status: 'error', msg: String(e) }); }
    });
  }

  /* ── DOM ── */
  function build() {
    if (state.box) return;
    var box = document.createElement('div');
    box.className = 'rp-portal-bg';
    box.innerHTML =
      '<div class="rp-portal" role="dialog" aria-label="传送门">' +
      '  <div class="rp-portal-top">' +
      '    <span class="rp-portal-ico">⌘</span>' +
      '    <input id="rpPortalInput" class="rp-portal-input" placeholder="跳转到主机 / 存储 / 路径 / 面板…"' +
      '           autocomplete="off" spellcheck="false">' +
      '    <span class="rp-portal-hint">Esc 关闭</span>' +
      '  </div>' +
      '  <div id="rpPortalList" class="rp-portal-list"></div>' +
      '  <div class="rp-portal-foot"><span>↑↓ 选择</span><span>Enter 跳转</span>' +
      '    <span class="rp-portal-dim" id="rpPortalStat"></span></div>' +
      '</div>';
    document.body.appendChild(box);
    state.box = box;
    state.input = box.querySelector('#rpPortalInput');
    state.list = box.querySelector('#rpPortalList');
    box.addEventListener('mousedown', function (e) { if (e.target === box) close(); });
    state.input.addEventListener('input', function () { doSearch(state.input.value); });
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c];
    });
  }

  function render() {
    var l = state.list;
    if (!l) return;
    if (!state.items.length) {
      l.innerHTML = '<div class="rp-portal-empty">' + (state.input.value.trim()
        ? '没有匹配项 —— 换个关键词，或检查该资源是否已加入连接中心' : '输入关键词开始搜索') + '</div>';
      return;
    }
    var html = '', lastKind = '';
    state.items.forEach(function (it, i) {
      if (it.kind !== lastKind) {
        lastKind = it.kind;
        html += '<div class="rp-portal-sec">' + ({ host: '🖥 主机', storage: '☁ 存储',
          path: '🕘 最近路径', panel: '🧭 面板' }[it.kind] || it.kind) + '</div>';
      }
      html += '<div class="rp-portal-item' + (i === state.index ? ' on' : '') +
        '" data-i="' + i + '"><span class="rp-portal-lb">' + esc(it.label) + '</span>' +
        '<span class="rp-portal-sb">' + esc(it.sub || '') + '</span></div>';
    });
    l.innerHTML = html;
    var on = l.querySelector('.rp-portal-item.on');
    if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest' });
    Array.prototype.forEach.call(l.querySelectorAll('.rp-portal-item'), function (el) {
      el.addEventListener('click', function () { run(state.items[+el.dataset.i]); });
      el.addEventListener('mouseenter', function () { state.index = +el.dataset.i; paint(); });
    });
    var stat = state.box.querySelector('#rpPortalStat');
    if (stat) {
      var c = { host: 0, storage: 0, path: 0, panel: 0 };
      state.items.forEach(function (x) { c[x.kind] = (c[x.kind] || 0) + 1; });
      stat.textContent = '主机 ' + c.host + ' · 存储 ' + c.storage + ' · 路径 ' + c.path + ' · 面板 ' + c.panel;
    }
  }

  function paint() {
    var l = state.list;
    if (!l) return;
    var els = l.querySelectorAll('.rp-portal-item');
    Array.prototype.forEach.call(els, function (el, i) {
      el.classList.toggle('on', i === state.index);
    });
    var on = l.querySelector('.rp-portal-item.on');
    if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest' });
  }

  function setItems(items) {
    state.items = items;
    state.index = 0;
    render();
  }

  function doSearch(q) {
    var my = ++state.seq;
    var local = panelItems().map(function (it) {
      var s = scoreItem(q, it);
      if (s > 0) { it.score = s; return it; }
      return null;
    }).filter(Boolean);
    // 空查询: 最近优先 + 面板兜底
    if (!q.trim()) {
      var rec = readRecent().map(function (r) {
        return { kind: r.kind, label: r.label, sub: '最近使用 · ' + (r.sub || ''), target: r.target, score: 900 };
      });
      setItems(rec.concat(local).slice(0, 40));
    } else {
      setItems(local.sort(byScore).slice(0, 30));
    }
    rpc('portal_search', { q: q }).then(function (r) {
      if (my !== state.seq) return;                       // 旧响应丢弃(避免乱序覆盖)
      var data = (r && r.items) || [];
      var merged = state.items.slice();
      data.forEach(function (it) { merged.push(it); });
      merged.sort(byScore);
      setItems(merged.slice(0, 60));
    });
  }

  function byScore(a, b) {
    if ((b.score || 0) !== (a.score || 0)) return (b.score || 0) - (a.score || 0);
    var la = String(a.label || '').length, lb = String(b.label || '').length;
    if (la !== lb) return la - lb;
    return String(a.label || '').localeCompare(String(b.label || ''));
  }

  /* ── 执行(全部复用既有入口) ── */
  function run(it) {
    if (!it || !it.target) return;
    var t = it.target;
    pushRecent(it);
    rpc('portal_hit', { target: t, label: it.label });
    close();
    setTimeout(function () {
      try {
        if (t.type === 'panel') {
          if (window.switchTab) window.switchTab(t.panel);
        } else if (t.type === 'host') {
          if (window.switchTab) window.switchTab('transfer');
          if (window.SP && SP.fillByGuid) SP.fillByGuid('transfer', t.guid);
        } else if (t.type === 'storage') {
          if (window.FonrVFS && FonrVFS.openPath) FonrVFS.openPath(t.storage_id, '');
        } else if (t.type === 'path') {
          if (window.FonrVFS && FonrVFS.openPath) FonrVFS.openPath(t.storage_id, t.path);
        }
      } catch (e) {
        if (window.toast) window.toast('跳转失败: ' + e, 'error', 3000);
      }
    }, 60);
  }

  function open() {
    build();
    state.box.classList.add('on');
    state.open = true;
    state.input.value = '';
    doSearch('');
    setTimeout(function () { try { state.input.focus(); } catch (e) {} }, 30);
  }

  function close() {
    if (!state.box) return;
    state.box.classList.remove('on');
    state.open = false;
  }

  /* v5.84.0 · 注册为快捷键动作(默认 Ctrl+G), 由 hotkeys.js 统一分发 → 用户可自行改键/禁用 */
  try {
    if (window.Hotkeys && typeof window.Hotkeys.bind === 'function') {
      window.Hotkeys.bind('portal', function () { if (state.open) close(); else open(); return true; });
    }
  } catch (e) { console.warn('[portal] hotkey bind fail', e); }

  /* ── 键位(面板内导航保留) ── */
  document.addEventListener('keydown', function (e) {
    var k = (e.key || '').toLowerCase();
    // v5.84.0 · Ctrl+G 已移交快捷键系统统一分发(个性化 → 快捷键 里可改键), 此处不再自行监听
    if (!state.open) return;
    if (k === 'escape') { e.preventDefault(); close(); }
    else if (k === 'arrowdown') {
      e.preventDefault();
      if (state.items.length) { state.index = (state.index + 1) % state.items.length; paint(); }
    } else if (k === 'arrowup') {
      e.preventDefault();
      if (state.items.length) { state.index = (state.index - 1 + state.items.length) % state.items.length; paint(); }
    } else if (k === 'home') { e.preventDefault(); state.index = 0; paint(); }
    else if (k === 'end') { e.preventDefault(); state.index = Math.max(0, state.items.length - 1); paint(); }
    else if (k === 'enter') {
      e.preventDefault();
      run(state.items[state.index]);
    }
  }, true);

  /* ── 顶栏提示 chip ── v5.40.0 · 移除注入(用户要求顶栏清理, Ctrl+G 键位保留) ── */

  window.Portal = { open: open, close: close, toggle: function () { state.open ? close() : open(); },
                    _fuzzyScore: fuzzyScore, _items: function () { return state.items; } };
})(window);
