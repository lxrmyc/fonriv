/* 远程桌面面板 (v5.20.2 · 阶段 4)
 * VNC 直连: 服务端字节桥 (/ws/vnc?mode=raw) → 标准 VNC 服务器
 * PVE VM:   /ws/vnc?mode=pve  → PVE vncwebsocket
 * 保存列表: localStorage (连接配置不含密码, 密码每次输入)
 */
(function (g) {
  'use strict';
  var LS_KEY = 'rp_rd_saved';

  function $id(x) { return document.getElementById(x); }
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  // v5.38.2 · 录制大小格式化
  function fmtSize(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  }
  function loadSaved() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || '[]') || []; }
    catch (e) { return []; }
  }
  function persist(arr) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(arr.slice(0, 20))); } catch (e) {}
  }

  function renderSaved() {
    var box = $id('rdSavedBox');
    if (!box) return;
    var arr = loadSaved();
    if (!arr.length) {
      box.innerHTML = '暂无保存的连接 · 填好上方表单后点「💾 保存当前连接」';
      return;
    }
    var html = '<table class="user-table" style="width:100%;font-size:12px"><thead><tr>' +
      '<th>名称</th><th>目标</th><th style="width:150px">操作</th></tr></thead><tbody>';
    arr.forEach(function (it, i) {
      html += '<tr><td><b>' + esc(it.name || it.host) + '</b></td>' +
        '<td style="font-family:monospace">' + esc(it.host + ':' + it.port) + '</td>' +
        '<td><button class="btn btn-sm" style="color:var(--green)" onclick="RemoteDesk.openSaved(' + i + ')">🖥 连接</button> ' +
        '<button class="btn btn-sm" onclick="RemoteDesk.fill(' + i + ')">✏️ 载入</button> ' +
        '<button class="btn btn-sm" style="color:var(--red)" onclick="RemoteDesk.del(' + i + ')">🗑</button></td></tr>';
    });
    html += '</tbody></table>';
    box.innerHTML = html;
  }

  function openConsole(params) {
    var pwEl = $id('rdPass');
    var pw = (pwEl && pwEl.value) || '';
    if (pw) params.vpassword = pw;
    params.auth_token = (function () {
      try { return localStorage.getItem('auth_token') || ''; } catch (e) { return ''; }
    })();
    if (RemoteDesk.recLicensed()) params.rec = '1';
    var w = window.open('/novnc.html?' + new URLSearchParams(params).toString(), '_blank');
    if (!w && window.toast) toast('浏览器拦截了弹出窗口, 请允许弹窗后重试', 'warn', 5000);
  }


  // ═══════════════════════════════════════════════════════════════════
  // v5.98.17 · 远程运维「连接诊断报告」
  //   用户诉求: 连不上时只看到一句 "✗ 连接失败", 不知道为什么。
  //   这里把**服务端真能查到的证据**一次列全(目标端口/RFB 握手/guacd/FreeRDP/运维日志),
  //   再按证据给结论 —— 不猜、不回落; 查不到的项就写"跳过/未找到"。
  // ═══════════════════════════════════════════════════════════════════
  function _diagModal(res, params) {
    var old = document.getElementById('_rdDiagModal');
    if (old) old.remove();
    var facts = (res && res.facts) || [];
    var rows = facts.map(function (f) {
      var mark = f.ok === true ? '✓' : (f.ok === false ? '✗' : '·');
      var color = f.ok === true ? 'var(--green)' : (f.ok === false ? 'var(--red)' : 'var(--text3)');
      var val = String(f.v == null ? '' : f.v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/\n/g, '<br>');
      return '<div style="display:flex;gap:8px;padding:5px 0;border-bottom:1px dashed var(--border)">'
        + '<span style="color:' + color + ';flex:0 0 14px">' + mark + '</span>'
        + '<span style="flex:0 0 190px;color:var(--text2)">' + (f.k || '') + '</span>'
        + '<span style="flex:1;word-break:break-all;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11.5px">'
        + val + '</span></div>';
    }).join('');
    var p = params || {};
    var psum = Object.keys(p).filter(function (k) { return p[k]; })
      .map(function (k) { return k + '=' + p[k]; }).join(' · ');
    var body = (res && res.verdict) ? String(res.verdict).replace(/\*\*/g, '') : '（服务端未返回结论）';
    var vHtml = body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\*\*(.+?)\*\*/g, '<b style="color:var(--cyan)">$1</b>');
    var text = '【连接诊断报告】\n结论: ' + body + '\n参数: ' + psum + '\n'
      + facts.map(function (f) { return (f.ok === true ? '[OK] ' : f.ok === false ? '[X] ' : '[-] ') + f.k + ': ' + f.v; }).join('\n');
    var m = document.createElement('div');
    m.id = '_rdDiagModal';
    m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:10001;display:flex;align-items:center;justify-content:center';
    m.innerHTML = '<div style="background:var(--bg2);border:1px solid var(--border);border-radius:10px;width:min(860px,94vw);max-height:88vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,0.5)">'
      + '<div style="padding:14px 18px;border-bottom:1px solid var(--border);font-weight:600">🔎 连接诊断报告</div>'
      + '<div style="padding:14px 18px;overflow:auto">'
      +   '<div style="background:rgba(255,255,255,0.03);border-left:3px solid var(--cyan);padding:10px 12px;border-radius:6px;margin-bottom:12px;line-height:1.6">' + vHtml + '</div>'
      +   '<div style="color:var(--text3);font-size:11px;margin-bottom:4px">连接参数</div>'
      +   '<div style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11.5px;margin-bottom:12px;word-break:break-all">' + (psum || '(无)') + '</div>'
      +   '<div style="color:var(--text3);font-size:11px;margin-bottom:2px">实测证据（本机真查）</div>'
      +   rows
      + '</div>'
      + '<div style="padding:12px 18px;border-top:1px solid var(--border);display:flex;gap:8px;justify-content:flex-end">'
      +   '<button class="btn" id="_rdDiagCopy">📋 复制报告</button>'
      +   '<button class="btn btn-primary" id="_rdDiagClose">关闭</button>'
      + '</div></div>';
    document.body.appendChild(m);
    function close() { m.remove(); }
    document.getElementById('_rdDiagClose').onclick = close;
    document.getElementById('_rdDiagCopy').onclick = function () {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(function () {
            if (window.toast) toast('✓ 报告已复制到剪贴板', 'success', 2500);
          }, function () { _fallbackCopy(text); });
        } else { _fallbackCopy(text); }
      } catch (e) { _fallbackCopy(text); }
    };
    function _fallbackCopy(t) {
      try {
        var ta = document.createElement('textarea');
        ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        document.execCommand('copy'); ta.remove();
        if (window.toast) toast('✓ 报告已复制到剪贴板', 'success', 2500);
      } catch (e) {
        if (window.toast) toast('复制失败, 请手动选择文本', 'warn', 3000);
      }
    }
    m.onclick = function (ev) { if (ev.target === m) close(); };
  }

  var RemoteDesk = {
    // v5.98.17 · 诊断: 传参直接跑, 不传则读当前表单
    diag: function (o) {
      var opt = o || {};
      var proto = opt.proto || 'rdp';
      var params = {
        host: opt.host || '', port: String(opt.port || ''), proto: proto,
        flavor: opt.flavor || '', os: opt.os || '', user: opt.user || '',
        security: opt.security || '', source: opt.source || ''
      };
      if (!params.host) {
        // 无参: 按面板推断
        var h = $id('rdHost') || $id('pveCfgHost');
        params.host = ((h || {}).value || '').trim();
        var pt = $id('rdPort') || $id('pveCfgPort');
        params.port = ((pt || {}).value || (proto === 'vnc' ? '5900' : '3389')).trim();
      }
      if (!params.host) { if (window.toast) toast('请先填写目标主机, 再点诊断', 'warn', 3000); return; }
      if (window.toast) toast('⏳ 正在收集诊断证据…', 'info', 2500);
      send({ action: 'remote_diag', host: params.host, port: parseInt(params.port || '0', 10),
             proto: params.proto, flavor: params.flavor }, function (r) {
        if (!r || r.status !== 'ok') {
          if (window.toast) toast('✗ 诊断失败: ' + ((r && r.msg) || '无响应'), 'err', 4000);
          return;
        }
        _diagModal(r, params);
      });
    },
    diagRdp: function () {
      var osSel = $id('rdpOs');
      RemoteDesk.diag({
        proto: 'rdp',
        host: (($id('rdpHost') || $id('rdHost')) || {}).value || '',
        port: (($id('rdpPort') || $id('rdPort')) || {}).value || '3389',
        flavor: ($id('rdpFlavor') || {}).value || '',
        os: (osSel || {}).value || '',
        user: ($id('rdpUser') || $id('rdUser') || {}).value || '',
        security: ($id('rdpSec') || {}).value || '',
        source: '表单'
      });
    },
    diagVnc: function () {
      RemoteDesk.diag({ proto: 'vnc',
        host: (($id('rdHost')) || {}).value || '', port: (($id('rdPort')) || {}).value || '5900',
        source: '表单' });
    },
    diagPve: function () {
      var v = (($id('pveCfgHost')) || {}).value || '';
      RemoteDesk.diag({ proto: 'pve', host: v, port: (($id('pveCfgPort')) || {}).value || '8006',
        user: (($id('pveCfgUser')) || {}).value || '', source: 'PVE 面板' });
    },
    openVnc: function () {
      var host = ($id('rdHost') || {}).value || '';
      var port = ($id('rdPort') || {}).value || '5900';
      if (!host.trim()) { if (window.toast) toast('请填写目标主机', 'warn'); return; }
      openConsole({ mode: 'raw', vhost: host.trim(), vport: port.trim() || '5900' });
    },
    saveCur: function () {
      var arr = loadSaved();
      var it = {
        name: ($id('rdName') || {}).value || '',
        host: (($id('rdHost') || {}).value || '').trim(),
        port: (($id('rdPort') || {}).value || '5900').trim()
      };
      if (!it.host) { if (window.toast) toast('请先填写目标主机', 'warn'); return; }
      if (!it.name) it.name = it.host;
      if (!arr.some(function (x) { return x.host === it.host && x.port === it.port; })) arr.push(it);
      persist(arr);
      renderSaved();
      if (window.toast) toast('✓ 已保存 ' + it.name, 'success', 3500);
    },
    openSaved: function (i) {
      var it = loadSaved()[i];
      if (!it) return;
      var pwEl = $id('rdPass');
      openConsole({ mode: 'raw', vhost: it.host, vport: it.port,
                    vpassword: (pwEl && pwEl.value) || '' });
    },
    fill: function (i) {
      var it = loadSaved()[i];
      if (!it) return;
      $id('rdHost').value = it.host; $id('rdPort').value = it.port;
      $id('rdName').value = it.name || '';
    },
    del: function (i) {
      var arr = loadSaved();
      var it = arr[i];
      if (!it) return;
      if (!window.confirm('删除已保存的连接: ' + (it.name || it.host) + ' ?')) return;
      arr.splice(i, 1); persist(arr); renderSaved();
    },
    pingVnc: function () {
      var host = (($id('rdHost') || {}).value || '').trim();
      var port = parseInt(($id('rdPort') || {}).value || '5900', 10);
      if (!host) { if (window.toast) toast('请填写目标主机', 'warn'); return; }
      if (window.toast) toast('⏳ 探测 ' + host + ':' + port + ' …', 'info', 3000);
      send({ action: 'remote_desk_ping', host: host, port: port }, function (r) {
        if (window.toast) toast((r && r.status === 'ok' ? '✓ ' : '✗ ') + ((r && r.msg) || ''),
          r && r.status === 'ok' ? 'success' : 'err', 5000);
      });
    },
    // ═══ v5.28.0 · PVE 连接配置 ═══
    pveCfgFill: function () {
      RemoteDesk.pveServersRefresh();
      // 从 DB 读回 (用 pve_api_vms 不带参时后端回退; 这里用专用读: 无 → 空)
      var host = $id('pveCfgHost');
      send({ action: 'pve_api_vms' }, function () {});   // 预热 (失败无碍)
    },
    pveAuthMode: function () {
      var m = ($id('pveCfgAuth') || {}).value || 'password';
      var row = $id('pveCfgTokenRow');
      var pw = $id('pveCfgPwField');
      if (row) row.style.display = m === 'token' ? 'flex' : 'none';
      if (pw) pw.parentElement.style.display = m === 'token' ? 'none' : '';
    },
    pveTest: function () {
      var p = {
        host: ($id('pveCfgHost') || {}).value || '',
        port: ($id('pveCfgPort') || {}).value || '8006',
        user: ($id('pveCfgUser') || {}).value || 'root@pam',
        password: ($id('pveCfgPass') || {}).value || '',
        api_token: ($id('pveCfgTokenVal') || {}).value || ''
      };
      if (!p.host) { if (window.toast) toast('请填写 PVE 主机', 'warn'); return; }
      var st = $id('pveCfgState');
      if (st) st.textContent = '⏳ 连接中…';
      send({ action: 'pve_api_vms', host: p.host, port: p.port, user: p.user,
             password: p.password, api_token: p.api_token }, function (r) {
        if (st) st.textContent = (r && r.status === 'ok')
          ? '✓ 连接成功 · ' + ((r.vms || []).length) + ' 台 VM/CT'
          : '✗ ' + ((r && r.msg) || '连接失败');
        if (st) st.style.color = (r && r.status === 'ok') ? 'var(--green)' : 'var(--red)';
      });
    },
    pveSave: function () {
      var p = {
        id: ($id('pveCfgEditId') || {}).value || '',
        name: ($id('pveCfgName') || {}).value || '',
        host: ($id('pveCfgHost') || {}).value || '',
        port: ($id('pveCfgPort') || {}).value || '8006',
        user: ($id('pveCfgUser') || {}).value || 'root@pam',
        password: ($id('pveCfgPass') || {}).value || '',
        token_id: ($id('pveCfgTokenId') || {}).value || '',
        token_value: ($id('pveCfgAuth') || {}).value === 'token' ? (($id('pveCfgTokenVal') || {}).value || '') : ''
      };
      if (!p.host) { if (window.toast) toast('请填写 PVE 主机', 'warn'); return; }
      // v5.31.5 · 走多服务器列表存储 (同步写旧扁平键, 无参回退继续可用)
      send({ action: 'pve_servers', sub: 'save',
             id: p.id, name: p.name, host: p.host, port: p.port, user: p.user,
             password: p.password, token_id: p.token_id, token_value: p.token_value }, function (r) {
        if (window.toast) toast((r && r.msg) || (r && r.status === 'ok' ? '✓ 已保存' : '✗ 失败'),
          r && r.status === 'ok' ? 'success' : 'err', 3200);
        var st = $id('pveCfgState');
        if (st && r.status === 'ok') { st.textContent = '✓ 已保存 — 点「载入 VM 列表」拉取'; st.style.color = 'var(--green)'; }
        if (r.status === 'ok') {
          RemoteDesk.pveServersRefresh();
          // 记住编辑中的 id, 便于再次保存时更新同一条
          if (r.server && $id('pveCfgEditId')) $id('pveCfgEditId').value = r.server.id;
          RemoteDesk.loadPveVms();
        }
      });
    },
    /* ═══ v5.31.5 · PVE 多服务器列表 ═══ */
    pveServersRefresh: function () {
      var box = $id('pveServersBody');
      if (!box) return;
      send({ action: 'pve_servers', sub: 'get' }, function (r) {
        var arr = (r && r.servers) || [];
        RemoteDesk.__pveServers = arr;
        if (!arr.length) {
          box.innerHTML = '<span style="color:var(--text3)">暂无 — 在下方填好连接信息后点「💾 保存连接」</span>';
          return;
        }
        var html = '<table style="width:100%;font-size:12px;border-collapse:collapse">';
        arr.forEach(function (sv) {
          html += '<tr style="border-bottom:1px dashed var(--border)">'
            + '<td style="padding:4px 6px"><b>' + esc(sv.name || sv.host) + '</b>'
            + '<span style="color:var(--text3);font-size:11px"> · ' + esc(sv.host) + ':' + esc(sv.port)
            + ' · ' + esc(sv.user) + (sv.auth_type === 'token' ? ' (token)' : '') + '</span></td>'
            + '<td style="padding:4px 2px;width:150px;text-align:right;white-space:nowrap">'
            + '<button class="btn btn-sm" style="padding:1px 8px;color:var(--green)" onclick="RemoteDesk.pveServerUse(\'' + esc(sv.id) + '\')">▶ 载入</button> '
            + '<button class="btn btn-sm" style="padding:1px 8px" onclick="RemoteDesk.pveServerEdit(\'' + esc(sv.id) + '\')">✏️</button> '
            + '<button class="btn btn-sm" style="padding:1px 8px;color:var(--red)" onclick="RemoteDesk.pveServerDel(\'' + esc(sv.id) + '\')">🗑</button>'
            + '</td></tr>';
        });
        box.innerHTML = html + '</table>';
      });
    },
    pveServerFind: function (id) {
      return (RemoteDesk.__pveServers || []).find(function (x) { return x.id === id; }) || null;
    },
    pveServerUse: function (id) {
      var sv = RemoteDesk.pveServerFind(id);
      if (!sv) { if (window.toast) toast('未找到该条目', 'warn'); return; }
      RemoteDesk.pveServerEdit(id);
      RemoteDesk.loadPveVms();
    },
    pveServerEdit: function (id) {
      var sv = RemoteDesk.pveServerFind(id);
      if (!sv) return;
      var set = function (id2, v) { var e = $id(id2); if (e) e.value = (v == null ? '' : v); };
      set('pveCfgEditId', sv.id); set('pveCfgName', sv.name); set('pveCfgHost', sv.host);
      set('pveCfgPort', sv.port); set('pveCfgUser', sv.user);
      set('pveCfgPass', sv.auth_value || '');          // 供编辑; 留空保存时后端保留旧凭据
      set('pveCfgAuth', sv.auth_type === 'token' ? 'token' : 'password');
      set('pveCfgTokenId', sv.token_id || '');
      set('pveCfgTokenVal', sv.token_value || '');
      RemoteDesk.pveAuthMode();
      if (window.toast) toast('已载入「' + (sv.name || sv.host) + '」到表单', 'info', 2400);
    },
    pveServerDel: function (id) {
      if (!window.confirm('删除这条 PVE 服务器配置?')) return;
      send({ action: 'pve_servers', sub: 'del', id: id }, function (r) {
        if (window.toast) toast((r && r.msg) || (r && r.status === 'ok' ? '✓ 已删除' : '✗ 失败'),
          r && r.status === 'ok' ? 'success' : 'err', 2600);
        RemoteDesk.pveServersRefresh();
      });
    },
    loadPveVms: function () {
      var box = $id('rdPveBox');
      send({ action: 'pve_api_vms' }, function (r) {
        if (!r || r.status !== 'ok' || !(r.vms || []).length) {
          box.innerHTML = '⚠ 无法获取 VM 列表: ' + esc((r && r.msg) || '需要 PVE API 配置') +
            '<br/>替代方案: PVE Web UI → VM → 控制台, 或使用上方 VNC 直连。';
          return;
        }
        var html = '<table class="user-table" style="width:100%;font-size:12px"><thead><tr>' +
          '<th>VMID</th><th>名称</th><th>节点</th><th>状态</th><th style="width:90px">操作</th></tr></thead><tbody>';
        (r.vms || []).forEach(function (v) {
          var run = v.status === 'running';
          html += '<tr><td>' + esc(v.vmid) + '</td><td>' + esc(v.name || '') + '</td><td>' + esc(v.node) + '</td>' +
            '<td>' + (run ? '<span style="color:var(--green)">运行中</span>' : esc(v.status)) + '</td>' +
            '<td>' + (run ? '<button class="btn btn-sm" style="color:var(--green)" onclick="RemoteDesk.openPve(\'' + esc(v.node) + '\',\'' + esc(String(v.vmid)) + '\',\'' + esc(v.type) + '\')">🖥 控制台</button>' : '<span style="color:var(--text3)">未运行</span>') + '</td></tr>';
        });
        html += '</tbody></table>';
        box.innerHTML = html;
      });
    },
    openPve: function (node, vmid, kind) {
      /* v5.31.5 · FIX: PVE vncwebsocket 要求 noVNC 以 vncticket 作为 VNC 密码完成认证。
         原实现直接开 novnc.html, 桥里没有 ticket → 认证失败, 控制台永远"正在连接"。
         现先调 pve_console 取一次性 ticket, 以 vpassword 传给 noVNC。 */
      var tok = '';
      try { tok = localStorage.getItem('auth_token') || ''; } catch (e) {}
      var kk = (kind === 'lxc' ? 'lxc' : 'qemu');
      send({ action: 'pve_console', node: node, vmid: vmid, kind: kk, auth_token: tok }, function (r) {
        if (!r || r.status !== 'ok' || !r.vpassword) {
          if (window.toast) toast('✗ 控制台失败: ' + ((r && r.msg) || '未知'), 'err', 6000);
          // v5.98.17 · 失败即自动出诊断报告(用户诉求: 别只给一句报错)
          try {
            RemoteDesk.diag({ proto: 'pve',
              host: (($id('pveCfgHost')) || {}).value || '',
              port: (($id('pveCfgPort')) || {}).value || '8006',
              user: (($id('pveCfgUser')) || {}).value || '',
              source: '控制台 ' + node + '/' + vmid + '(' + kk + ')' });
          } catch (e) { console.warn('[diag] 自动诊断失败', e); }
          return;
        }
        var q = new URLSearchParams({ node: node, vmid: vmid, kind: kk,
                                      vpassword: r.vpassword, auth_token: tok });
        window.open('/novnc.html?' + q.toString(), '_blank');
      });
    },
    // v5.23.0 · 凭据对接: 从「配置列表」带入 host/用户/密码 (VNC 密码常与 SSH 相同, 也可手改)
    fillFromCfg: function () {
      var sel = $id('rdCfgSel');
      var id = sel ? sel.value : '';
      if (!id) return;
      var list = (window.__rpCfgList || []);
      var cfg = list.find(function (c) { return String(c.id) === String(id) || String(c.uuid) === String(id); });
      if (!cfg) return;
      if ($id('rdHost')) $id('rdHost').value = cfg.host || '';
      if ($id('rdPort')) $id('rdPort').value = '5900';
      try {
        var pw = cfg.auth_value || cfg.password || '';
        if ((pw || '').startsWith('ENC:') && typeof decodePassword === 'function')
          pw = decodePassword(pw);
        if (pw && $id('rdPass')) $id('rdPass').value = pw;
      } catch (e) {}
      if (window.toast) toast('已带入配置「' + (cfg.name || cfg.host) + '」— VNC 密码若与 SSH 不同请手改', 'info', 3600);
    },
    recList: function () {
      var box = $id('rdRecBox');
      // v1.0.0 · 社区档无"会话录制"键(vnc_record) → 不拉录制列表(此前每次进远程桌面都打一枪, 刷"未知 action")
      if (window.__featInEdition && !window.__featInEdition('vnc_record')) return;
      send({ action: 'vnc_rec_list' }, function (r) {
        if (!box) return;
        if (r && r.status === 'error' && /授权|旗舰/.test(r.msg || '')){
          box.innerHTML = '<span style="color:var(--text3);font-size:12px">🔒 ' + esc(r.msg) + '</span>';
          return;
        }
        var arr = (r && r.recordings) || [];
        if (!arr.length){ box.innerHTML = '<span style="color:var(--text3);font-size:12px">暂无录制 — 连接时点「⏺ 录制」开始</span>'; return; }
        var tok = ''; try { tok = localStorage.getItem('auth_token') || ''; } catch (e) {}
        var html = '<table class="user-table" style="width:100%;font-size:12px"><thead><tr>' +
          '<th>文件</th><th>大小</th><th>时间</th><th style="width:130px">操作</th></tr></thead><tbody>';
        arr.forEach(function (x) {
          html += '<tr><td style="font-family:monospace">' + esc(x.file) + '</td>' +
            '<td>' + Math.round((x.size || 0) / 1024) + ' KB</td>' +
            '<td>' + esc(new Date((x.mtime || 0) * 1000).toLocaleString()) + '</td>' +
            '<td><a class="btn btn-sm" style="color:var(--cyan);text-decoration:none" href="/vnc_play.html?f=' + encodeURIComponent(x.file) + '&token=' + encodeURIComponent(tok) + '" target="_blank">▶ 回放</a> ' +
            '<button class="btn btn-sm" style="color:var(--red)" onclick="RemoteDesk.recDel(\'' + esc(x.file) + '\')">🗑</button></td></tr>';
        });
        html += '</tbody></table>';
        box.innerHTML = html;
      });
    },
    recDel: function (f) {
      if (!window.confirm('删除录制 ' + f + ' ?')) return;
      send({ action: 'vnc_rec_delete', file: f, confirm: true }, function (r) {
        if (window.toast) toast((r && r.msg) || (r && r.status === 'ok' ? '已删除' : '失败'),
          r && r.status === 'ok' ? 'success' : 'err', 3000);
        RemoteDesk.recList();
      });
    },
    recLicensed: function () {
      try {
        var lf = window.__licFeat;
        if (lf == null) return true;
        if (Array.isArray(lf)) return lf.indexOf('vnc_record') >= 0;
      } catch (e) {}
      return false;
    },
    cfgListRefresh: function () {
      window.SP.serverRows().then(function (r) {
        if (!r || r.status !== 'ok') return;
        window.__rpCfgList = r.configs || [];
        var sel = $id('rdCfgSel');
        if (!sel) return;
        sel.innerHTML = '<option value="">(选择配置自动带入)</option>' + window.__rpCfgList.map(function (c) {
          return '<option value="' + esc(c.id != null ? c.id : c.uuid) + '">' + esc(c.name || c.host) + ' · ' + esc(c.host || '') + '</option>';
        }).join('');
      });
    },

    // ═══ v5.26.0 · 子页切换 ═══
    showPage: function (n) {
      [1, 2, 3].forEach(function (i) {
        var pg = document.getElementById('rd-page-' + i);
        if (pg) pg.classList.toggle('active', i === n);
        var tb = document.querySelector('.rd-tab[data-rd-page="' + i + '"]');
        if (tb) tb.classList.toggle('active', i === n);
      });
      try { localStorage.setItem('rp_rd_page', String(n)); } catch (e) {}
    },

    // ═══ v5.34.5 · P5: 服务器列表档案化 (server_profiles; localStorage 一次性迁入后清空) ═══
    _srvCache: [],
    _srv: function () { return RemoteDesk._srvCache; },
    _rpc: function (a, d) {
      return new Promise(function (res) {
        try { window.send(Object.assign({ action: a }, d || {}), function (r) { res(r || {}); }); }
        catch (e) { res({ status: 'error', msg: String(e) }); }
      });
    },
    _srvListLoad: async function () {
      // 档案 → 列表条目 (一台服务器同时启用 rdp+vnc → 两条)
      var out = [];
      try {
        var r = await RemoteDesk._rpc('sp_list', {});
        (r.profiles || []).forEach(function (p) {
          var mask = p.protocols_mask || [];
          if (mask.indexOf('rdp') >= 0) out.push({ guid: p.guid, name: p.name || p.hostname, proto: 'rdp',
            host: p.hostname, port: (p._rdpPort || ''), user: '', domain: '', security: 'tls',
            size: '1280x800', gw: 'auto', savePw: p.has_rdp_pw, _p: p });
          if (mask.indexOf('vnc') >= 0) out.push({ guid: p.guid, name: p.name || p.hostname, proto: 'vnc',
            host: p.hostname, port: (p._vncPort || ''), user: '', domain: '', security: '',
            size: '1280x800', gw: 'auto', _p: p });
        });
        // 详情字段 (端口/域/分辨率/密码标记) 需要完整档案 — 逐条拉 (列表规模小)
        var guids = {}; out.forEach(function (e) { guids[e.guid] = 1; });
        var keys = Object.keys(guids);
        for (var i = 0; i < keys.length; i++) {
          var g = await RemoteDesk._rpc('sp_get', { guid: keys[i] });
          if (g.status !== 'ok' || !g.profile) continue;
          var pr = g.profile.protocols || {};
          out.forEach(function (e) {
            if (e.guid !== keys[i]) return;
            var blk = pr[e.proto] || {};
            if (blk.port) e.port = String(blk.port);
            if (e.proto === 'rdp') {
              e.user = blk.rdp_user || ''; e.domain = blk.domain || '';
              e.security = blk.security || 'tls'; e.size = (blk.width || 1280) + 'x' + (blk.height || 800);
              e.gw = blk.gw || 'auto'; e.newsess = !!blk.newsess; e.rec = !!blk.rec;
              /* v5.98.12 · 列表直连必须和表单连接用同一套参数: 补 os/audio,
                 否则列表路径拿不到"远端系统" → 后端按自动挑后端, 实测 Windows 会连不上/黑屏 */
              e.os = blk.os || 'windows'; e.audio = blk.audio || 'local';
              e.flavor = blk.flavor || 'auto'; e.fit = !!blk.fit;   // v5.98.14
              e.savePw = !!blk.rdp_pass; e._blk = blk;
            // v5.38.0 · SFTP 通道凭据 (来自同一档案的 SSH 侧, sp_get 已解密)
            e._ssh = { user: g.profile.ssh_user || '', auth_type: g.profile.ssh_auth_type || 'pass',
                       auth_value: g.profile.ssh_auth_value || '',
                       passphrase: g.profile.ssh_passphrase || '' };
            e._jumpGuid = g.profile.ssh_proxy_jump || '';   // v5.38.1 · 跳板机档案
            } else {
              e.size = (blk.width || 1280) + 'x' + (blk.height || 800);
              e.gw = blk.gw || 'auto'; e.savePw = !!blk.password; e._blk = blk;
            }
          });
        }
      } catch (e) {}
      RemoteDesk._srvCache = out;
      RemoteDesk.srvRefresh();
      return out;
    },
    _srvMigrateLs: async function () {
      // 一次性: localStorage rp_rdp_servers → 档案 (迁移成功后清键)
      try {
        var raw = localStorage.getItem('rp_rdp_servers');
        if (!raw) return;
        var arr = JSON.parse(raw) || [];
        if (!arr.length) { localStorage.removeItem('rp_rdp_servers'); return; }
        var n = 0;
        for (var i = 0; i < arr.length; i++) {
          var it = arr[i]; if (!it || !it.host) continue;
          var blk = { enabled: true, port: it.port || '', gw: it.gw || 'auto',
                      newsess: !!it.newsess, rec: !!it.rec };
          if (it.size) { var sz = String(it.size).split('x'); blk.width = parseInt(sz[0], 10) || 1280; blk.height = parseInt(sz[1], 10) || 800; }
          if (it.password) blk[(it.proto === 'vnc') ? 'password' : 'rdp_pass'] = it.password;
          if (it.proto !== 'vnc') { blk.rdp_user = it.user || ''; blk.domain = it.domain || ''; blk.security = it.security || 'tls'; }
          var prof = { hostname: it.host, name: it.name || it.host, protocols: {} };
          prof.protocols[it.proto || 'rdp'] = blk;
          var ex = await RemoteDesk._rpc('sp_get_by_host', { hostname: it.host, port: 22 });
          if (ex.status === 'ok' && ex.profile) prof.guid = ex.profile.guid;
          var r = await RemoteDesk._rpc('sp_save', { profile: prof });
          if (r.status === 'ok') n++;
        }
        localStorage.removeItem('rp_rdp_servers');
        if (n && window.toast) toast('📥 已把 ' + n + ' 台远程桌面服务器迁入加密档案 (连接中心统一管理)', 'success', 4200);
      } catch (e) {}
    },
    saveServer: async function () {
      var host = ($id('rdpHost') || {}).value || '';
      if (!host.trim()) { if (window.toast) toast('请先填写目标主机', 'warn'); return; }
      var name = ($id('rdpSrvName') || {}).value || '';
      if (!name) name = (($id('rdpUser') || {}).value ? ($id('rdpUser').value + '@') : '') + host.trim();
      var proto = ($id('rdpProto') || {}).value || 'rdp';
      var blk = { enabled: true,
        port: ($id('rdpPort') || {}).value || '',
        gw: ($id('rdpGw') || {}).value || 'auto',
        newsess: !!($id('rdpNewSess') || {}).checked,
        rec: !!($id('rdpRec') || {}).checked };
      var sz = (($id('rdpSize') || {}).value || '1280x800').split('x');
      if (RemoteDesk._fit){        // v5.98.14 · 自适应: 按当前浏览器窗口尺寸连
        sz = [String(window.innerWidth || 1280), String(window.innerHeight || 800)];
      }
      blk.width = parseInt(sz[0], 10) || 1280; blk.height = parseInt(sz[1], 10) || 800;
      if (($id('rdpSrvSavePw') || {}).checked) {
        var pw = ($id('rdpPass') || {}).value || '';
        if (pw) blk[(proto === 'vnc') ? 'password' : 'rdp_pass'] = pw;
      }
      if (proto !== 'vnc') {
        blk.rdp_user = ($id('rdpUser') || {}).value || '';
        blk.domain = ($id('rdpDomain') || {}).value || '';
        blk.security = ($id('rdpSec') || {}).value || 'tls';
        blk.os = ($id('rdpOS') || {}).value || 'windows';   // v5.98.12 · 决定 FreeRDP 代, 列表直连要用
        blk.audio = ($id('rdpAudio') || {}).value || 'local';
        blk.flavor = ($id('rdpFlavor') || {}).value || 'auto';   // v5.98.14 · 显式后端(auto=按系统)
        blk.fit = !!RemoteDesk._fit;                              // v5.98.14 · 自适应分辨率
      }
      var prof = { hostname: host.trim(), name: name, kind: (proto === 'vnc' ? 'linux' : 'windows'),
                   protocols: {} };
      prof.protocols[proto] = blk;
      // 已有同主机档案 → 更新 (保留其 ssh 等其他块; 留空的密码不覆盖 → 先拉全档合并密码槽)
      var ex = await RemoteDesk._rpc('sp_get_by_host', { hostname: host.trim(), port: 22 });
      if (ex.status === 'ok' && ex.profile) {
        prof.guid = ex.profile.guid;
        var oldBlk = (ex.profile.protocols || {})[proto] || {};
        if (!blk.rdp_pass && oldBlk.rdp_pass) blk.rdp_pass = oldBlk.rdp_pass;
        if (!blk.password && oldBlk.password) blk.password = oldBlk.password;
      }
      var r = await RemoteDesk._rpc('sp_save', { profile: prof });
      if (r.status === 'ok') {
        if (window.toast) toast('✓ 已保存「' + name + '」到加密档案', 'success', 3000);
        await RemoteDesk._srvListLoad();
      } else if (window.toast) toast(r.msg || '保存失败', 'err', 3000);
    },
    srvRefresh: function () {
      var box = $id('rdSrvList'); if (!box) return;
      var arr = RemoteDesk._srv();
      var cnt = $id('rdSrvCount'); if (cnt) cnt.textContent = arr.length ? (arr.length + ' 台') : '';
      if (!arr.length) { box.innerHTML = '<span style="color:var(--text3)">暂无 — 填好上面的表单后点「💾 保存当前表单为服务器」</span>'; return; }
      var h = '<table class="user-table" style="width:100%;font-size:12px"><thead><tr>'
        + '<th>名称</th><th>协议</th><th>目标</th><th>账号</th><th>网关</th><th style="width:190px">操作</th></tr></thead><tbody>';
      arr.forEach(function (x, i) {
        h += '<tr><td><b>' + esc(x.name) + '</b>' + (x.savePw ? ' <span title="已保存密码" style="color:var(--green)">🔑</span>' : '') + '</td>'
          + '<td>' + esc((x.proto || 'rdp').toUpperCase()) + '</td>'
          + '<td style="font-family:monospace">' + esc(x.host + ':' + (x.port || (x.proto === 'vnc' ? 5900 : x.proto === 'ssh' ? 22 : 3389))) + '</td>'
          + '<td>' + esc(x.user || '-') + (x.domain ? '@' + esc(x.domain) : '') + '</td>'
          + '<td>' + esc(x.gw === 'auto' || !x.gw ? '自动' : x.gw) + '</td>'
          + '<td><button class="btn btn-sm" style="color:var(--green)" onclick="RemoteDesk.connectServer(' + i + ')">🖥 连接</button> '
          + '<button class="btn btn-sm" onclick="RemoteDesk.loadServer(' + i + ')">✏️ 载入</button> '
          + '<button class="btn btn-sm" style="color:var(--red)" onclick="RemoteDesk.delServer(' + i + ')">🗑</button></td></tr>';
      });
      box.innerHTML = h + '</tbody></table>';
    },
    loadServer: function (i) {
      var it = RemoteDesk._srv()[i]; if (!it) return;
      var set = function (id, v) { var e = $id(id); if (e && v != null) e.value = v; };
      set('rdpProto', it.proto || 'rdp'); set('rdpHost', it.host); set('rdpPort', it.port || '');
      set('rdpUser', it.user || ''); set('rdpDomain', it.domain || '');
      set('rdpSec', it.security || 'tls'); set('rdpSize', it.size || '1280x800');
      set('rdpGw', it.gw || 'auto');
      set('rdpOS', it.os || 'windows');                       // v5.98.12
      set('rdpAudio', it.audio || 'local');                   // v5.98.12
      set('rdpFlavor', it.flavor || 'auto');                  // v5.98.14
      RemoteDesk._fit = !!it.fit;                             // v5.98.14
      if (it.fit && $id('rdpResPreset')) $id('rdpResPreset').value = '__fit';
      // v5.34.5: 密码从档案解密块取 (异步; 已存则回填表单)
      if (it._blk && (it._blk.rdp_pass || it._blk.password)) set('rdpPass', it._blk.rdp_pass || it._blk.password);
      if ($id('rdpNewSess')) $id('rdpNewSess').checked = !!it.newsess;
      if ($id('rdpRec')) $id('rdpRec').checked = !!it.rec;
      RemoteDesk.showPage(1);
      if (window.toast) toast('已载入「' + it.name + '」— 可修改后点连接', 'info', 2600);
    },
    delServer: async function (i) {
      var arr = RemoteDesk._srv(); var it = arr[i]; if (!it) return;
      if (!window.confirm('删除「' + it.name + '」的 ' + (it.proto || 'rdp').toUpperCase() + ' 配置? (SSH 等其他配置保留)')) return;
      // 显式 null 块 = 删除该能力块 (增量合并, 其他块不动)
      var r = await RemoteDesk._rpc('sp_save', { profile: { guid: it.guid,
        protocols: (function () { var o = {}; o[it.proto] = null; return o; })() } });
      if (r.status === 'ok') { if (window.toast) toast('已删除', 'success', 2000); await RemoteDesk._srvListLoad(); }
      else if (window.toast) toast(r.msg || '删除失败', 'err', 3000);
    },
    connectServer: async function (i) {
      var it = RemoteDesk._srv()[i]; if (!it) return;
      var proto = it.proto || 'rdp';
      var port = it.port || (proto === 'vnc' ? '5900' : proto === 'ssh' ? '22' : '3389');
      var sz = (it.size || '1280x800').split('x');
      var params = { proto: proto, host: it.host, port: port, user: it.user || '',
                     domain: it.domain || '', security: it.security || 'tls',
                     width: sz[0] || 1280, height: sz[1] || 800, ignore_cert: '1' };
      /* v5.98.12 · FIX(用户报: 列表里点连接连不上, 而下方表单点连接可以):
         ① 补上"远端系统→FreeRDP 代"与音频等参数(原先只有表单路径带 flavor, 列表路径没带,
            后端按自动挑后端 → Windows 目标实测连不上);
         ② **不再借用表单里的密码** —— 原先列表条目没存密码时会顺手拿表单里那个密码去连,
            那是另一台机器的密码(串台), 会以"认证失败"的形式表现得像"连不上"。 */
      var _os = it.os || 'windows';
      params.flavor = (it.flavor && it.flavor !== 'auto')
        ? it.flavor
        : ((_os === 'windows') ? 'freerdp3' : (_os === 'linux' ? 'freerdp2' : ''));
      if (it.audio) params.audio = it.audio;
      var pw = (it._blk && (it._blk.rdp_pass || it._blk.password)) || '';
      /* v6.16.18 · 列表直连遇到**没存密码**的条目 → 弹框索要(此前静默无密码直连必失败,
         用户表现为「列表点连接不成功, 载入后走表单才行」—— 表单能成是因为密码框还留着手输值)。
         口径: 依旧**不借用**表单密码(v5.98.12 防串台), 缺了就当面问; 提示勾选
         「保存时连密码一起存」后重新保存可下次免输直连。 */
      if (!pw && (proto === 'rdp' || proto === 'vnc')){
        var pv = null;
        try {
          pv = await window.rpForm({
            title: '连接「' + (it.name || it.host) + '」— 输入' + (proto === 'vnc' ? 'VNC' : 'RDP') + '密码',
            hint: '该条目未保存密码。保存表单时勾选「💾 保存时连密码一起存」并重新保存, 下次即可免输直连。',
            okText: '连接', fields: [{ key: 'pw', label: '密码', type: 'password', required: true }] });
        } catch (e) {}
        if (!pv || !pv.pw){
          if (window.toast) toast('已取消连接(未输入密码)', 'info', 3200);
          return;
        }
        pw = pv.pw;
      }
      if (pw) params.password = pw;
      // v5.38.0 · P1.1 SFTP 文件传输: 带 SSH 档案凭据 (RDP 密码 ≠ SSH 密码)
      //   guacd 据此开通文件通道; Windows 无 SSH 时自动降级不影响桌面
      // v6.16.19 · 只在**凭据完整**时开通: 此前只要档案有 ssh_user 就带 sftp='1',
      //   凭据为空(如只存了用户名没存密码, .120 实测) → guacd 的 SSH 通道空密码认证失败
      //   → **整个会话被拖断**(guacd 日志: RDP 握手成功 → "No known host keys provided"(SSH 通道)
      //   → "Password authentication failed" → User disconnected), 用户表现为
      //   「列表连接提示连接已断开, 表单连接正常」—— 表单路径不带 sftp。凭据不完整 → 降级纯 RDP。
      try {
        var ssh = it._ssh || {};
        if (ssh.user && ssh.auth_value){
          params.sftp = '1';
          params.sftp_ssh_user = ssh.user;
          params.sftp_port = String(it._sshPort || 22);
          if (ssh.auth_type === 'key'){
            params.sftp_key = ssh.auth_value || '';
            if (ssh.passphrase) params.sftp_passphrase = ssh.passphrase;
          } else {
            params.sftp_ssh_pass = ssh.auth_value || '';
          }
        }
      } catch(e){}
      // v5.38.1 · P1.2 跳板机: 经 SSH 隧道连目标 (后端建隧道, guacd 连本地转发端口)
      if (it._jumpGuid) params.jump_guid = it._jumpGuid;
      if (it.rec) params.recording = '1';
      if (it.newsess) { params.width = (parseInt(sz[0], 10) || 1280) + 1; params.newsess = '1'; }
      if (it.gw && it.gw !== 'auto') params.gw = it.gw;
      params.auth_token = (function () { try { return localStorage.getItem('auth_token') || ''; } catch (e) { return ''; } })();
      RemoteDesk._openWithTicket(params);   // v6.16.2 批23 · 工单化(凭据不经 URL)
    },

    /* v6.16.2 批23 · 凭据安全: 参数先经已登录 WS 换一次性工单, URL 只带 ticket
       (不再把账号密码拼进 /guac.html 地址 —— 浏览器历史/服务端访问日志双泄漏)。
       先同步 window.open 占位防弹窗拦截, 拿到工单后再导航过去。 */
    _openWithTicket: function (params) {
      let w = null;
      try { w = window.open('', '_blank'); } catch (e) {}
      if (!w && window.toast) { toast('浏览器拦截了弹出窗口, 请允许弹窗后重试', 'warn', 5000); return; }
      send({ action: 'guac_ticket_create', params: params }, function (r) {
        if (r && r.status === 'ok' && r.ticket){
          const q = new URLSearchParams({ ticket: r.ticket, proto: params.proto || 'rdp',
                                          host: params.host || '', port: params.port || '' });
          try { w.location = '/guac.html?' + q.toString(); }
          catch (e) { window.open('/guac.html?' + q.toString(), '_blank'); }
        } else {
          try { w.close(); } catch (e) {}
          if (window.toast) toast('创建控制台工单失败: ' + ((r && r.msg) || '未知'), 'err', 5000);
        }
      });
    },


    // ═══ v5.38.2 · P2 会话录制管理 (列表/转码/播放/下载/删除) ═══
    recOpen: function () {
      var self = this;
      var bg = document.createElement('div');
      bg.id = 'rdRecModal';
      bg.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:12000;display:flex;align-items:center;justify-content:center';
      bg.innerHTML = '<div style="background:var(--bg2);border:1px solid var(--border);border-radius:10px;width:760px;max-width:94vw;max-height:82vh;display:flex;flex-direction:column">'
        + '<div style="padding:10px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px">'
        + '<b style="font-size:13px;flex:1">📹 会话录制</b>'
        + '<span style="font-size:10.5px;color:var(--text3)">连接时勾选「录制」即产生 .guac (服务端取证记录, 不经浏览器)</span>'
        + '<button class="btn btn-sm" onclick="document.getElementById(\'rdRecModal\').remove()">✕</button></div>'
        + '<div id="rdRecBody" style="padding:12px 16px;overflow-y:auto;flex:1;font-size:12px">⏳ 加载…</div></div>';
      bg.onclick = function (e) { if (e.target === bg) bg.remove(); };
      document.body.appendChild(bg);
      self.recRefresh();
    },
    recRefresh: async function () {
      var box = $id('rdRecBody'); if (!box) return;
      var r = await RemoteDesk._rpc('recording_list', {});
      var list = (r && r.recordings) || [];
      if (!list.length) {
        box.innerHTML = rpState({ state: 'empty', msg: '暂无录制文件',
          hint: '连接远程桌面时在「高级」面板勾选「录制」(或已在档案/表单里开启), 会话结束后 .guac 文件会出现在这里' });
        return;
      }
      var h = '<table style="width:100%;border-collapse:collapse"><thead><tr style="background:var(--bg3)">'
        + '<th style="text-align:left;padding:5px 8px">文件</th><th style="text-align:left;padding:5px 8px">大小</th>'
        + '<th style="text-align:left;padding:5px 8px">时间</th><th style="width:220px;padding:5px 8px">操作</th></tr></thead><tbody>';
      list.forEach(function (x) {
        var isWebm = false;   // v5.38.2: 转码产物为 .m4v
        var conv = isWebm || x.converted;
        h += '<tr style="border-top:1px dashed var(--border)">'
          + '<td style="padding:5px 8px;font-family:monospace;font-size:11px">' + esc(x.name) + (isWebm ? ' <span style="color:var(--green)">webm</span>' : '') + '</td>'
          + '<td style="padding:5px 8px;color:var(--text3)">' + fmtSize(x.size) + '</td>'
          + '<td style="padding:5px 8px;color:var(--text3);font-size:11px">' + esc(x.mtime) + '</td>'
          + '<td style="padding:5px 8px">'
          + ''
          + (!conv ? '<button class="btn btn-sm" onclick="RemoteDesk.recConvert(\'' + esc(x.name) + '\')">🎬 转码</button> ' : '')
          + (conv ? '<button class="btn btn-sm" onclick="RemoteDesk.recPlay(\'' + esc(x.name) + '.m4v\')">▶ 播放</button> ' : '')
          + '<button class="btn btn-sm" onclick="RemoteDesk.recDownload(\'' + esc(conv ? x.name + '.m4v' : x.name) + '\')">⬇</button> '
          + '<button class="btn btn-sm" style="color:var(--red)" onclick="RemoteDesk.recDelete(\'' + esc(x.name) + '\')">🗑</button>'
          + '</td></tr>';
      });
      box.innerHTML = h + '</tbody></table>'
        + '<div style="margin-top:10px;color:var(--text3);font-size:11px">💡 .guac 为原始录制（guacd 原生格式）；点「转码」由 guacenc 生成 .webm 后可网页播放。转码大文件可能需要几分钟。</div>';
    },
    recConvert: async function (name) {
      var box = $id('rdRecBody');
      if (box) box.insertAdjacentHTML('afterbegin', '<div style="color:var(--cyan);margin-bottom:6px" id="rdRecMsg">⏳ 转码中 (guacenc, 可能几分钟)…</div>');
      var r = await RemoteDesk._rpc('recording_convert', { name: name });
      if (window.toast) toast(r.msg || '', r.status === 'ok' ? 'success' : 'err', 4200);
      RemoteDesk.recRefresh();
    },
    recPlay: function (name) {
      var tok = '';
      try { tok = localStorage.getItem('auth_token') || ''; } catch (e) {}
      var url = '/api/recordings/' + encodeURIComponent(name) + '?token=' + encodeURIComponent(tok);
      var bg = document.createElement('div');
      bg.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:13000;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:10px';
      bg.innerHTML = '<video src="' + url + '" controls autoplay style="max-width:88vw;max-height:80vh;background:#000;border-radius:8px"></video>'
        + '<div style="color:#c8d2e0;font-size:12px">' + esc(name) + ' <button class="btn btn-sm" onclick="this.closest(\'div\').remove()">关闭</button></div>';
      bg.onclick = function (e) { if (e.target === bg) bg.remove(); };
      document.body.appendChild(bg);
    },
    recDownload: function (name) {
      var tok = '';
      try { tok = localStorage.getItem('auth_token') || ''; } catch (e) {}
      var a = document.createElement('a');
      a.href = '/api/recordings/' + encodeURIComponent(name) + '?token=' + encodeURIComponent(tok);
      a.download = name;
      a.click();
    },
    recDelete: async function (name) {
      if (!window.confirm('删除录制「' + name + '」及其转码文件?')) return;
      var r = await RemoteDesk._rpc('recording_delete', { name: name });
      if (window.toast) toast(r.msg || '', r.status === 'ok' ? 'success' : 'err', 2600);
      RemoteDesk.recRefresh();
    },
    recServerQuota: async function () { return null; },

    // ═══ v5.26.0 · guacd 多后端管理 ═══
    gwRefresh: function () {
      var sel = $id('rdpGw');
      send({ action: 'guacd_status', sub: 'backends' }, function (r) {
        var bks = (r && r.backends) || [];
        if (sel) {
          var keep = sel.value;
          sel.innerHTML = '<option value="auto">自动 (按协议/目标选)</option>' + bks.map(function (b) {
            return '<option value="' + esc(b.id) + '">' + esc(b.name) + ' · ' + esc(b.host + ':' + b.port) +
                   (b.flavor && b.flavor !== 'any' ? ' [' + esc(b.flavor) + ']' : '') + '</option>';
          }).join('');
          sel.value = keep || 'auto';
        }
        var box = $id('rdGwList');
        if (box) {
          if (!bks.length) box.innerHTML = '<span style="color:var(--text3)">(未配置后端 — 用下面按钮部署)</span>';
          else box.innerHTML = '后端: ' + bks.map(function (b) {
            return (b.ok ? '<span style="color:var(--green)">●</span>' : '<span style="color:var(--red)">●</span>')
              + ' ' + esc(b.name) + ' <span style="color:var(--text3)">' + esc(b.host + ':' + b.port)
              + (b.flavor && b.flavor !== 'any' ? ' · ' + esc(b.flavor) : '')
              + (b.version ? ' · ' + esc(String(b.version).replace('VERSION_', '')) : '') + '</span> '
              + '<button class="btn btn-sm" style="padding:1px 6px;font-size:10px" onclick="RemoteDesk.gwEdit(\'' + esc(b.id) + '\')">✏️</button> '
              + '<button class="btn btn-sm" style="padding:1px 6px;font-size:10px;color:var(--red)" onclick="RemoteDesk.gwDel(\'' + esc(b.id) + '\')">🗑</button>';
          }).join('<br>')
          + (r && r.auto_rdp ? '<div style="margin-top:4px;color:var(--text3)">RDP 自动选: <b>' + esc(r.auto_rdp.name)
             + '</b> (' + esc(r.auto_rdp.chosen || '') + ') · VNC 自动选: <b>' + esc((r.auto_vnc || {}).name || '-') + '</b></div>' : '');
        }
      });
    },
    gwEdit: function (id) {
      send({ action: 'guacd_status', sub: 'backends' }, function (r) {
        var b = ((r && r.backends) || []).find(function (x) { return x.id === id; });
        if (!b) return;
        var set = function (i, v) { var e = $id(i); if (e) e.value = v; };
        set('rdGuacd', b.host); set('rdGuacdPort', b.port); set('rdGuacdFlavor', b.flavor || 'any');
        var e = $id('rdGwEditId'); if (!e) {
          e = document.createElement('input'); e.type = 'hidden'; e.id = 'rdGwEditId';
          document.getElementById('panel-remotedesk').appendChild(e);
        }
        e.value = b.id;
        if (window.toast) toast('已载入后端「' + b.name + '」— 改完点「➕ 保存后端」', 'info', 3000);
      });
    },
    gwSave: function () {
      var h = ($id('rdGuacd') || {}).value || '';
      if (!h.trim()) { if (window.toast) toast('请填后端地址', 'warn'); return; }
      var pw = ($id('rdGuacdPort') || {}).value || '4822';
      var fl = ($id('rdGuacdFlavor') || {}).value || 'any';
      var eid = ($id('rdGwEditId') || {}).value || '';
      var nm = ($id('rdGuacdName') || {}).value || '';
      send({ action: 'guacd_status', sub: 'save_backend', id: eid, name: nm,
             host: h.trim(), port: pw, flavor: fl, confirm: true }, function (r) {
        if (window.toast) toast((r && r.msg) || (r && r.status === 'ok' ? '✓ 已保存' : '✗ 失败'),
          r && r.status === 'ok' ? 'success' : 'err', 3600);
        RemoteDesk.gwRefresh();
      });
    },
    gwDel: function (id) {
      if (!window.confirm('删除网关后端 ' + id + ' ? (不影响已装的服务, 只是本产品不再用它)')) return;
      send({ action: 'guacd_status', sub: 'del_backend', id: id, confirm: true }, function (r) {
        if (window.toast) toast((r && r.msg) || '已删除', 'success', 2600);
        RemoteDesk.gwRefresh();
      });
    },

    // ═══ v5.25.0 · RDP/VNC/SSH (guacd 网关) ═══
    // v5.28.0 · 自动识别远端系统 → 推荐 guacd flavor + 安全模式
    rdDetect: function () {
      var host = ($id('rdpHost') || {}).value || '';
      var user = ($id('rdpUser') || {}).value || 'root';
      var pw = ($id('rdpPass') || {}).value || '';
      var port = ($id('rdpPort') || {}).value || '22';
      var out = $id('rdDetectResult');
      if (!host) { if (window.toast) toast('请先填目标主机', 'warn'); return; }
      if (out) out.textContent = '⏳ 正在连接远端识别系统 (SSH)…';
      send({ action: 'remote_os_detect', host: host, port: port, user: user,
             auth_type: 'pass', password: pw, with_disks: false }, function (r) {
        if (!r || r.status !== 'ok') {
          if (out) out.textContent = '✗ ' + ((r && r.msg) || '识别失败') + ' — 将使用默认参数';
          return;
        }
        var icon = r.os_family === 'windows' ? '🪟' : r.os_family === 'macos' ? '🍎' : '🐧';
        var flavor = r.os_family === 'windows' ? 'freerdp3' : 'freerdp2';
        var sec = r.os_family === 'windows' ? 'tls' : 'any';
        var flavorLabel = flavor === 'freerdp3' ? 'FreeRDP 3 后端' : 'FreeRDP 2 后端';
        var secLabel = sec === 'tls' ? 'TLS' : '自动协商';
        if (out) out.innerHTML = icon + ' <b>' + esc(r.label || r.os_family) + '</b>'
          + ' · 建议: <b style="color:var(--cyan)">' + flavorLabel + '</b>'
          + ' + <b style="color:var(--cyan)">' + secLabel + '</b>'
          + ' <span style="color:var(--text3);font-size:10px">(已自动应用, 点连接即用)</span>';
        // 写入隐藏字段供 openGuac 消费
        var fh = $id('rdDetectFlavor'); if (fh) fh.value = flavor;
        var fs = $id('rdDetectSec'); if (fs) fs.value = sec;
      });
    },

    /* ═══ v5.98.14 · 分辨率预设 / RDP 后端选择 / 一键换后端重试 ═══ */
    _fit: false,                      // 自适应(跟随浏览器窗口)
    _effFlavor: function () {
      // 显式选了后端就用它; 否则按远端系统推导(与旧行为一致)
      var f = ($id('rdpFlavor') || {}).value || 'auto';
      if (f !== 'auto') return f;
      var os = ($id('rdpOS') || {}).value || 'windows';
      return (os === 'windows') ? 'freerdp3' : (os === 'linux' ? 'freerdp2' : '');
    },
    resPreset: function () {
      /* v5.98.14 · FIX: HTML 里 onchange="RemoteDesk.resPreset()" 一直在调, 但**该方法从未定义**
         (改分辨率下拉直接抛 JS 错误、什么也不发生)。这里补上, 并顺带支持『自适应』。 */
      var v = ($id('rdpResPreset') || {}).value || '';
      var box = $id('rdpSize');
      if (v === '__custom') { RemoteDesk._fit = false; if (box) box.focus(); return; }
      if (v === '__fit') {
        RemoteDesk._fit = true;
        if (box){
          box.value = (window.innerWidth || 1280) + 'x' + (window.innerHeight || 800);
          box.title = '自适应: 连接时按当前浏览器窗口大小, 窗口尺寸变化会同步远端(需远端支持动态分辨率)';
        }
        return;
      }
      RemoteDesk._fit = false;
      if (box) box.value = v;
    },
    rdpFlavorAuto: function () {
      // 远端系统改了 → 后端选择回到"自动"(跟着系统走), 并说明会挑哪个
      var sel = $id('rdpFlavor');
      if (sel) sel.value = 'auto';
      var f = RemoteDesk._effFlavor();
      if (window.toast) toast('远端系统: ' + (($id('rdpOS') || {}).value || '') + ' → 将使用 ' + (f || '任意') + ' 后端', 'info', 3200);
    },
    rdpRetryBackend: function () {
      /* 用户要求: "一种不成功可以换另一种" —— 一键换另一种 FreeRDP 后端重连 */
      var cur = RemoteDesk._effFlavor();
      var other = (cur === 'freerdp3') ? 'freerdp2' : 'freerdp3';
      var sel = $id('rdpFlavor');
      if (sel) sel.value = other;
      if (window.toast) toast('🔁 已把 RDP 后端换成 ' + other + ' 重连…', 'info', 3600);
      RemoteDesk.openGuac();
    },
    openGuac: function () {
      var host = ($id('rdpHost') || {}).value || '';
      if (!host.trim()) { if (window.toast) toast('请填写目标主机', 'warn'); return; }
      var proto = ($id('rdpProto') || {}).value || 'rdp';
      var port = ($id('rdpPort') || {}).value || (proto === 'rdp' ? '3389' : proto === 'ssh' ? '22' : '5900');
      var sz = (($id('rdpSize') || {}).value || '1280x800').split('x');
      var _os = ($id('rdpOS') || {}).value || 'windows';
      var _aud = ($id('rdpAudio') || {}).value || 'local';
      var params = {
        proto: proto, host: host.trim(), port: port,
        user: ($id('rdpUser') || {}).value || '',
        password: ($id('rdpPass') || {}).value || '',
        domain: ($id('rdpDomain') || {}).value || '',
        security: ($id('rdpSec') || {}).value || 'tls',
        width: sz[0] || 1280, height: sz[1] || 800,
        ignore_cert: '1',
        audio: _aud,
        /* v5.98.14 · 后端优先级: 显式选的『RDP 后端』> 按远端系统推导 */
        flavor: (($id('rdpFlavor') || {}).value && $id('rdpFlavor').value !== 'auto')
                  ? $id('rdpFlavor').value
                  : (_os === 'windows' ? 'freerdp3' : _os === 'linux' ? 'freerdp2' : ''),
        auth_token: (function () { try { return localStorage.getItem('auth_token') || ''; } catch (e) { return ''; } })(),
      };
      if (($id('rdpRec') || {}).checked) params.recording = '1';
      var _gw = ($id('rdpGw') || {}).value || 'auto';
      if (_gw && _gw !== 'auto') params.gw = _gw;
      // v5.28.0 · 自动识别结果覆盖 flavor/security
      var _df = ($id('rdDetectFlavor') || {}).value || '';
      var _ds = ($id('rdDetectSec') || {}).value || '';
      if (_df) params.flavor = _df;
      if (_ds) { params.security = _ds; params.__auto_sec = '1'; }
      if (($id('rdpNewSess') || {}).checked) {
        // xrdp 按 (账号+分辨率) 复用会话: 偏移 1px 即强制新建 (残留息屏会话全黑的解法)
        params.width = (parseInt(sz[0], 10) || 1280) + 1;
        params.newsess = '1';
      }
      if (RemoteDesk._fit) params.fit = '1';   // v5.98.14 · 控制台首帧到达后按容器大小精调
      RemoteDesk._openWithTicket(params);   // v6.16.2 批23 · 工单化(凭据不经 URL)
    },
    guacStatus: function () {
      var out = $id('rdGuacdState');
      if (out) out.textContent = '⏳ 检测 guacd …';
      send({ action: 'guacd_status', sub: 'status' }, function (r) {
        if (!out) return;
        var h = r && r.host ? (r.host + ':' + r.port) : '';
        if (r && r.status === 'ok') {
          out.innerHTML = '<span style="color:var(--green)">' + esc(r.msg) + '</span>';
          if ($id('rdGuacd') && r.host) $id('rdGuacd').value = r.host;
          if ($id('rdGuacdPort') && r.port) $id('rdGuacdPort').value = r.port;
        } else {
          var hint = (r && r.msg) || 'guacd 未就绪';
          var steps = (r && r.plan && r.plan.steps) || [];
          out.innerHTML = '<span style="color:var(--orange)">' + esc(hint) + '</span>'
            + (steps.length ? '<br>可行部署方式: ' + steps.map(function (x) {
                return esc(x.label) + ' → <code>' + esc(x.cmd) + '</code>'; }).join('<br>') : '');
        }
      });
    },
    guacDeploySource: function () {
      if (!window.confirm('源码编译部署 guacd?\n\n· 不安装 docker, 编到 /usr/local 并注册 systemd 服务 guacd\n· 首次约 3~10 分钟 (只此一次)\n· 源码包已随程序入库, **无需联网**\n· 需要程序进程有 root 权限 (以 systemd 运行时即满足)')) return;
      var out = $id('rdGuacdState');
      if (out) out.innerHTML = '<span style="color:var(--cyan)">🔧 源码编译中… (约 3~10 分钟, 日志会陆续打印在「运行日志」; 请勿关闭页面)</span>';
      send({ action: 'guacd_status', sub: 'deploy', kind: 'source', confirm: true }, function (r) {
        if (!out) return;
        out.innerHTML = r && r.status === 'ok'
          ? '<span style="color:var(--green)">' + esc(r.msg || '✓ guacd 源码部署完成') + '</span>'
          : '<span style="color:var(--red)">✗ ' + esc((r && r.msg) || '编译失败') + '</span>';
      });
    },
    guacDeploy: function () {
      if (!window.confirm('在本机启动 guacd 容器 (docker run guacamole/guacd) ?\n\n· 仅监听本机 4822; \n· 若拉取镜像失败会自动尝试国内镜像源;\n· 需要 docker 已安装。')) return;
      var out = $id('rdGuacdState');
      if (out) out.textContent = '🐳 部署中 (拉取镜像可能需要 1~3 分钟)…';
      send({ action: 'guacd_status', sub: 'deploy', kind: 'docker', confirm: true }, function (r) {
        if (!out) return;
        out.innerHTML = r && r.status === 'ok'
          ? '<span style="color:var(--green)">' + esc(r.msg || '✓ guacd 已就绪') + '</span>'
          : '<span style="color:var(--red)">✗ ' + esc((r && r.msg) || '部署失败') + '</span>';
        if (r && r.status === 'ok' && $id('rdGuacd')) $id('rdGuacd').value = r.host || '127.0.0.1';
      });
    },
    guacSave: function () {
      var h = ($id('rdGuacd') || {}).value || '127.0.0.1';
      var pt = ($id('rdGuacdPort') || {}).value || '4822';
      send({ action: 'guacd_status', sub: 'save', host: h, port: pt, confirm: true }, function (r) {
        if (window.toast) toast((r && r.msg) || (r && r.status === 'ok' ? '✓ 已保存' : '✗ 保存失败'),
          r && r.status === 'ok' ? 'success' : 'err', 3600);
        RemoteDesk.guacStatus();
      });
    },
    checkGuacd: function () {
      var v = (($id('rdGuacd') || {}).value || '').trim();
      var out = $id('rdGuacdState');
      if (out) out.value = '检测中…';
      send({ action: 'remote_desk_ping', host: (v.split(':')[0] || '127.0.0.1'), port: parseInt(v.split(':')[1] || '4822', 10) }, function (r) {
        if (out) out.value = (r && r.status === 'ok') ? '✓ 可达 (RDP 支持开发中)' : '✗ 不可达';
      });
    }
  };

  document.addEventListener('DOMContentLoaded', function(){
    renderSaved();
    // v5.23.0 · 面板激活时刷新 (登录时序竞态安全): 首次激活拉配置/VM 列表/录制列表
    // v5.28.0 · 三个子页面板: 各自首次激活时刷新
    ['panel-rdp_console', 'panel-vnc_direct', 'panel-pve_console'].forEach(function (pid) {
      var pn = document.getElementById(pid);
      if (!pn) return;
      var loaded = false;
      function _load(){
        if (loaded) return;
        if (typeof window.currentUser === 'undefined' || !window.currentUser) return;
        loaded = true;
        RemoteDesk.cfgListRefresh();
        RemoteDesk.srvRefresh();
        RemoteDesk.guacStatus();
        if (pid === 'panel-pve_console') RemoteDesk.loadPveVms();
        if (pid === 'panel-rdp_console') RemoteDesk.recList();
      }
      if ('MutationObserver' in window){
        new MutationObserver(function(){
          if (pn.classList.contains('active')) _load();
        }).observe(pn, { attributes: true, attributeFilter: ['class'] });
      }
      setTimeout(_load, 2600);
    });
  });
  // v5.26.0 · 服务器列表 / 子页 / 网关管理 导出
  RemoteDesk.srvRefresh = RemoteDesk.srvRefresh || function(){};
  g.RemoteDesk = RemoteDesk;
})(window);

/* v5.31.5 · PVE 虚拟控制台激活时自动刷新已保存服务器列表 */
(function(){
  function check(){
    var p = document.getElementById('panel-pve_console');
    if (p && p.classList.contains('active') && window.Remotes && typeof RemoteDesk !== 'undefined'
        && RemoteDesk && RemoteDesk.pveServersRefresh){
      try { RemoteDesk.pveServersRefresh(); } catch(e){}
    }
  }
  // v5.34.5 · P5: 远程桌面页激活 → localStorage 一次性迁移 + 档案列表加载
  var _rdSrvLoaded = false;
  function _rdSrvCheck(){
    var p = document.getElementById('panel-rdp_console');
    if (p && p.classList.contains('active') && !_rdSrvLoaded && window.RemoteDesk){
      _rdSrvLoaded = true;
      try { RemoteDesk._srvMigrateLs().then(function(){ RemoteDesk._srvListLoad(); }); } catch(e){}
    }
  }
  document.addEventListener('DOMContentLoaded', function(){
    setTimeout(_rdSrvCheck, 900);
    if (typeof MutationObserver !== 'undefined'){
      var _rdp = document.getElementById('panel-rdp_console');
      if (_rdp) new MutationObserver(function(muts){
        for (var i=0;i<muts.length;i++){
          if (muts[i].attributeName === 'class'){ _rdSrvCheck(); break; }
        }
      }).observe(_rdp, { attributes: true, attributeFilter: ['class'] });
    }
  });
  document.addEventListener('DOMContentLoaded', function(){
    setTimeout(check, 900);
    if (typeof MutationObserver !== 'undefined'){
      var p = document.getElementById('panel-pve_console');
      if (p) new MutationObserver(function(muts){
        for (var i=0;i<muts.length;i++){
          if (muts[i].attributeName === 'class'){ check(); break; }
        }
      }).observe(p, { attributes: true, attributeFilter: ['class'] });
    }
  });
})();
