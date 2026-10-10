/* 本机依赖与插件面板 (v5.20.0)
 *
 * 部署第一步: 扫描本机缺什么、一键装齐。
 * 后端: deps_scan / deps_install (backend/deps.py 是唯一依赖清单来源)。
 *
 * 为什么安装能成功而手工 apt 会失败: 服务通常以 root 运行, 后端 geteuid()==0
 * 即直接执行 apt-get; 非 root 时后端会要求 sudo 免密并明确报错, 不做静默降级。
 */
(function (g) {
  'use strict';

  var STATE = { scan: null, running: false };

  function $id(x) { return document.getElementById(x); }
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function log(msg, level) {
    var el = $id('depsLog');
    if (!el) return;
    el.style.display = '';
    var color = level === 'error' ? '#ff8f8f' : (level === 'warn' ? '#e8b44a' : '#c8d2e0');
    var d = document.createElement('div');
    d.style.color = color;
    d.textContent = msg;
    el.appendChild(d);
    el.scrollTop = el.scrollHeight;
  }
  function clearLog() {
    var el = $id('depsLog');
    if (el) { el.innerHTML = ''; el.style.display = 'none'; }
  }

  var LEVEL_CN = { required: '必需', recommended: '推荐', optional: '可选' };
  var LEVEL_COLOR = { required: 'var(--red)', recommended: 'var(--orange)', optional: 'var(--text3)' };

  function render(sc) {
    STATE.scan = sc;
    var tb = $id('depsTableBody');
    var wrap = $id('depsTableWrap');
    var badge = $id('depsBadge');
    var sum = $id('depsSummary');
    if (!tb) return;
    // v6.16.2 批20 · 社区版不显示具体依赖表格: render() 此前 display='' 会覆盖 index.html 的
    //   data-hide-editions(扫描一次表格就复活) —— 这里按档位显式压制(用户实测: 按钮下方仍列出
    //   rsync 传输引擎/SSH 密码认证/rclone 对象存储引擎 三项)
    var isCommEarly = (window.__licFeatEdition || 'community') === 'community';

    var rows = '';
    sc.items.forEach(function (it) {
      var st = it.installed
        ? '<span style="color:var(--green)">✓</span>'
        : '<span style="color:' + (it.level === 'required' ? 'var(--red)' : 'var(--text3)') + '">—</span>';
      // 已装的也可重装/升级 (仅当可自动安装)
      var btn = it.auto_installable
        ? '<button class="btn btn-sm" style="padding:1px 6px;font-size:10px" onclick="Deps.installOne(\'' + esc(it.id) + '\')">'
          + (it.installed ? '重装' : '安装') + '</button>'
        : '<span style="color:var(--text3);font-size:10px">' + (it.needs_repo ? '需加源' : '—') + '</span>';
      // v5.31.1 · 勾选列 (支持任意单选/多选 → 「安装选定」)
      var chk = it.auto_installable
        ? '<input type="checkbox" class="depsChk" data-id="' + esc(it.id) + '">'
        : '';
      rows += '<tr>'
        + '<td style="width:26px">' + chk + '</td>'
        + '<td>' + (it.installed ? '✅' : '') + '</td>'
        + '<td><b>' + esc(it.label) + '</b>'
        +   (it.note ? '<div style="color:var(--text3);font-size:10px">' + esc(it.note) + '</div>' : '') + '</td>'
        + '<td><span style="color:' + (LEVEL_COLOR[it.level] || '') + '">' + (LEVEL_CN[it.level] || it.level) + '</span></td>'
        + '<td>' + st + '</td>'
        + '<td style="font-family:monospace;font-size:10px">' + esc(it.version || '') + '</td>'
        + '<td style="font-size:10px;color:var(--text3)">' + esc(it.source || '—') + '</td>'
        + '<td>' + btn + '</td>'
        + '</tr>';
    });
    tb.innerHTML = rows;
    if (wrap) wrap.style.display = isCommEarly ? 'none' : '';

    var missReq = sc.missing_required || [], missRec = sc.missing_recommended || [];
    var okAll = missReq.length === 0;
    if (badge) {
      badge.textContent = sc.installed_count + '/' + sc.total + ' 已装'
        + (missReq.length ? (' · 缺必需 ' + missReq.length) : ' · 必需项齐备');
      badge.style.color = missReq.length ? 'var(--red)' : 'var(--green)';
    }
    // v6.16.2 · 社区版不展示具体软件包清单(用户 2026-10-10 定): 只报数量 + 一键安装
    if (sum) {
      if (isCommEarly) {
        sum.innerHTML = (sc.has_priv
            ? '<span style="color:var(--green)">✓ 安装权限就绪 (' + esc(sc.priv) + ')</span>'
            : '<span style="color:var(--red)">⚠ 缺少安装权限 (' + esc(sc.priv) + ') —— 请用 root 账号或配置 sudo 免密</span>')
          + '<br/>'
          + (missReq.length
              ? '<span style="color:var(--red)">缺 ' + missReq.length + ' 个必需依赖</span>'
              : '<span style="color:var(--green)">✓ 必需依赖已齐备</span>')
          + (missRec.length ? ('<span style="color:var(--orange)"> · 另有 ' + missRec.length + ' 个推荐组件未装</span>') : '')
          + '<br/><span style="color:var(--text3);font-size:10px">点「⚡ 一键安装缺失依赖」自动安装运行所需的全部依赖与插件。</span>';
      } else {
        sum.innerHTML = '发行版 <b>' + esc(sc.distro) + '</b> · 包管理器 <b>' + esc(sc.pkg_mgr || '未识别')
          + '</b> · 权限 <b style="color:' + (sc.has_priv ? 'var(--green)' : 'var(--red)') + '">'
          + esc(sc.priv) + '</b><br/>'
          + (missReq.length
              ? '<span style="color:var(--red)">缺必需: ' + esc(missReq.join(', ')) + '</span>'
              : '<span style="color:var(--green)">✓ 必需依赖已齐备</span>')
          + (missRec.length ? ('<br/><span style="color:var(--orange)">缺推荐: ' + esc(missRec.join(', ')) + '</span>') : '');
      }
    }
  }

  /* 扫描。silent=true 时失败只做轻提示 (用于面板自动扫描, 不干扰用户)。
   *
   * 为什么要 retry: 实测切到系统设置那一刻会并发发出多个面板请求
   * (vitals/runs/shares/…), 期间本请求偶发拿不到响应。接口本身很快
   * (WS 直连实测 5/5 次 0.6~0.8s), 所以重试一次即可稳定拿到结果。
   */
  function doScan(cb, silent, _try) {
    _try = _try || 1;
    send({ action: 'deps_scan' }, function (r) {
      if (!r || r.status !== 'ok') {
        if (_try < 3) {
          setTimeout(function () { doScan(cb, silent, _try + 1); }, 1500);
          return;
        }
        if (silent) {
          var b = $id('depsBadge');
          if (b) { b.textContent = '未扫描 — 点「🔍 扫描依赖」重试'; b.style.color = 'var(--text3)'; }
        } else {
          log('✗ 扫描未响应 (已重试 3 次)。请点「🔍 扫描依赖」重试; 若持续失败请查看服务端日志', 'error');
        }
        if (cb) cb(null);
        return;
      }
      render(r);
      if (cb) cb(r);
    });
  }

  /* 带流式日志的安装。
   *
   * 不用通用 send(): 它① 只识别 log/progress 两种 type, 不认 deps_log;
   * ② 硬编码 30s 超时 —— 而装依赖动辄数分钟, 必然误报超时并提前回调。
   * 因此这里自管 WS (与 docker.js 的 rpcLong 同思路), 超时按 30 分钟给。
   */
  function runInstall(payload) {
    if (STATE.running) { log('⏳ 已有安装在进行中, 请等待完成', 'warn'); return; }
    STATE.running = true;
    clearLog();
    log('▶ 开始安装 …');

    var _ow = window.openWs || (typeof openWs === 'function' ? openWs : null);
    if (!_ow) { log('✗ WebSocket 未就绪', 'error'); STATE.running = false; return; }

    var reqId = 'deps_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    var done = false;
    var timer = setTimeout(function () {
      if (done) return;
      done = true; STATE.running = false;
      log('✗ 安装超时 (超过 30 分钟)', 'error');
    }, 30 * 60 * 1000);

    payload = Object.assign({ confirm: true, req_id: reqId }, payload || {});

    _ow(function (ws) {
      var h = function (e) {
        var d;
        try { d = JSON.parse(e.data); } catch (_) { return; }
        if (!d) return;
        // 流式日志: 后端 deps_log
        if (d.type === 'deps_log') {
          log(d.msg || '', d.level || 'info');
          return;
        }
        // 普通 log 也一并收 (便于复用后端既有推送)
        if ((d.type === 'log' || d.type === 'progress') && d.msg) {
          if (d.req_id === reqId || !d.req_id) log(d.msg, d.level || 'info');
          return;
        }
        // ⚠ 只认 type==='result' 作为终态。ws.py 有个 req_id 回填机制:
        //   后端主动推送的 event/heartbeat 只要没带 req_id, 就会被塞上"当前请求"的 req_id
        //   (见 ws.py _send_json_with_req)。若只判断 req_id 相等, 心跳会被误当成安装结果。
        // 终态判定: **只认 deps_result 标记**。
        //   不用 req_id —— ws.py 的 _send_json_with_req 会给任何不带 req_id 的推送
        //   盖上"当前请求"的 req_id, 于是安装期间并发的心跳/其它面板结果会被当成
        //   安装完成 (实测: 装到一半被误判结束, 还额外触发一次扫描)。
        if (d.deps_result !== true) return;
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { ws.removeEventListener('message', h); } catch (_) {}
        STATE.running = false;
        var lv = d.status === 'ok' ? 'info' : (d.status === 'warn' ? 'warn' : 'error');
        log(((d.status === 'ok' ? '✅ ' : '⚠ ') + (d.msg || '')), lv);
        if (d.installed && d.installed.length) log('  成功: ' + d.installed.join(', '));
        if (d.failed && d.failed.length) log('  失败: ' + d.failed.join(', '), 'error');
        if (window.toast) {
          toast((d.status === 'ok' ? '✓ ' : '⚠ ') + (d.msg || '').slice(0, 140),
                d.status === 'ok' ? 'success' : (d.status === 'warn' ? 'warn' : 'err'), 6000);
        }
        if (d.scan) {
          render(Object.assign({ has_priv: STATE.scan ? STATE.scan.has_priv : true,
                                 priv: STATE.scan ? STATE.scan.priv : '' }, d.scan));
        } else {
          doScan();
        }
      };
      ws.addEventListener('message', h);
      _rpSendWhenReady(ws, payload, undefined, function(){ try { console.warn('[ws] 发送失败'); } catch(_){} })
    });
  }

  function install(mode) {
    if (!STATE.scan) { doScan(function (sc) { if (sc) install(mode); }); return; }
    var onlyMiss = $id('depsOnlyMissing');
    var only = onlyMiss ? onlyMiss.checked : true;
    var ids;
    if (only) {
      // 让后端按 mode 自己挑 (它知道哪些已装) —— 这里只传 mode
      ids = null;
    } else {
      ids = STATE.scan.items.filter(function (i) {
        return i.auto_installable && (
          mode === 'all' ? true : (mode === 'recommended' ? i.level !== 'optional' : i.level === 'required'));
      }).map(function (i) { return i.id; });
    }
    var n = only
      ? '缺失的' + (mode === 'all' ? '全部' : (mode === 'recommended' ? '必需+推荐' : '必需')) + '依赖'
      : ((ids || []).length + ' 项依赖');
    if (!window.confirm('将安装 ' + n + ' (服务端以本机权限执行 apt/yum/apk/pip)。\n\n继续?')) return;
    var p = { action: 'deps_install', mode: mode };
    if (ids) p.ids = ids;
    runInstall(p);
  }

  /* v5.31.1 · 安装选定 (勾选任意多项, 后端按 ids 精确安装/重装) */
  function installSelected() {
    var ids = [];
    Array.prototype.forEach.call(document.querySelectorAll('.depsChk'), function (c) {
      if (c.checked) ids.push(c.getAttribute('data-id'));
    });
    if (!ids.length) { if (window.toast) toast('请先勾选要安装的依赖', 'warn'); return; }
    var names = ids.slice(0, 8).join(', ') + (ids.length > 8 ? (' … 等 ' + ids.length + ' 项') : '');
    if (!window.confirm('将安装/重装选定的 ' + ids.length + ' 项依赖:\n' + names + '\n\n(服务端以本机权限执行 apt/yum/apk/pip)\n继续?')) return;
    runInstall({ action: 'deps_install', ids: ids });
  }
  function checkAll(on) {
    Array.prototype.forEach.call(document.querySelectorAll('.depsChk'), function (c) { c.checked = !!on; });
  }
  function checkMissing() {
    var miss = (STATE.scan && (STATE.scan.missing_required || []).concat(STATE.scan.missing_recommended || [])) || [];
    Array.prototype.forEach.call(document.querySelectorAll('.depsChk'), function (c) {
      c.checked = miss.indexOf(c.getAttribute('data-id')) >= 0;
    });
  }

  function installOne(id) {
    if (!window.confirm('安装/重装依赖: ' + id + ' ?')) return;
    runInstall({ action: 'deps_install', ids: [id] });
  }

  /* 打开系统设置面板时自动扫一次 */
  function autoScanIfVisible() {
    var p = document.getElementById('panel-settings');
    if (p && p.classList.contains('active')) doScan();
  }

  var origSwitch;
  document.addEventListener('DOMContentLoaded', function () {
    // 挂到 switchTab 后自动扫描 (仅一次)
    if (typeof window.switchTab === 'function' && !window.__depsHooked) {
      origSwitch = window.switchTab;
      window.switchTab = function (t) {
        var r = origSwitch.apply(this, arguments);
        // 自动扫描: 静默模式 (失败不刷错误), 且已有结果就不重复扫
        if (t === 'settings') {
          setTimeout(function () { if (!STATE.scan) doScan(null, true); }, 800);
        }
        return r;
      };
      window.__depsHooked = true;
    }
  });

  g.Deps = { scan: doScan, install: install, installOne: installOne, state: STATE,
             installSelected: installSelected, checkAll: checkAll, checkMissing: checkMissing };
})(window);
