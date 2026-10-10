/* v6.2.0 · 在线更新前台 (关于 → 检查更新 → 自动更新 → 服务重启 → 自动复查)
 *
 * 流程(用户视角只有两步: 点检查更新 / 点立即更新):
 *   检查 → update_check → 展示 当前/最新/说明
 *   更新 → update_apply(后端下载+sha256 校验+外部脚本替换重启) → 前端轮询 /api/version
 *         直到新版本起来 → 提示刷新页面
 * 升级服务器地址未配置时, 就地弹输入并写入 app_settings.update_server(setting_set)。
 */
(function (g) {
'use strict';

function $(id) { return document.getElementById(id); }
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

var CHECKED = null;      // 最近一次**成功**的检查结果
var LAST_ADDR = { server: '', source: '' };   // v6.3.44 · 批 D: 最近一次**实际使用**的地址(含失败)

function _modal(title, bodyHtml, buttons) {
  var old = $('updModal'); if (old) old.remove();
  var m = document.createElement('div');
  m.id = 'updModal';
  m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:11000;display:flex;align-items:center;justify-content:center';
  m.innerHTML = '<div style="background:var(--bg2);border:1px solid var(--border);border-radius:12px;width:520px;max-width:92vw;max-height:86vh;overflow:auto;padding:20px 24px;box-shadow:0 20px 60px rgba(0,0,0,.5)">'
    + '<div style="font-size:15px;font-weight:700;margin-bottom:12px">' + title + '</div>'
    + '<div id="updBody" style="font-size:12.5px;line-height:1.8;color:var(--text2)">' + bodyHtml + '</div>'
    + '<div id="updBtns" style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px"></div></div>';
  document.body.appendChild(m);
  m.onclick = function (ev) { if (ev.target === m) m.remove(); };
  (buttons || []).forEach(function (b) {
    var el = document.createElement('button');
    el.className = 'btn btn-sm' + (b[2] === 'primary' ? ' btn-primary' : '');
    el.textContent = b[0];
    el.onclick = function () { b[1](); };
    $('updBtns').appendChild(el);
  });
  return m;
}
function _close() { var m = $('updModal'); if (m) m.remove(); }
/* v1.0.0 · FIX(社区版实测: 失败提示只显示 "undefined"): 原实现只写不读, 而调用处
   `_body(_body() + '…')` 依赖**读回**当前内容 → undefined 参与字符串拼接, 提示整段丢失。
   现在无参调用 = 取值(返回当前 HTML)。 */
function _body(html) {
  var b = $('updBody');
  if (!b) return '';
  if (html === undefined) return b.innerHTML;
  b.innerHTML = html;
  return html;
}

function _send(action, params) {
  return new Promise(function (res) {
    try {
      g.send(Object.assign({ action: action }, params || {}), function (m) { res(m || {}); });
    } catch (e) { res({ status: 'error', msg: String(e) }); }
  });
}

function _curVer() { return g.RP_VERSION || '?'; }

/* ── 升级服务器地址输入(未配置时) ── */
function _askServer(cb) {
  /* v6.3.44 · 批 D: 预填**当前生效地址**(含内置默认), 用户不必知道地址也能看懂在用哪个 */
  var cur = LAST_ADDR.server || (CHECKED && CHECKED.server) || '';
  _modal('⚙ 升级服务器', ''
    + '<div style="color:var(--text3);font-size:11.5px;margin-bottom:8px">'
    + '自建升级服务器 = 提供 <b>update.json</b> 与 <b>fonriv-&lt;版本&gt;.tar.gz</b> 的静态 HTTP 目录'
    + '（可用项目根 <code>python3 -m http.server</code> 直接充当，见 scripts/make_update_pkg.sh）<br>'
    + '社区版默认走 <b>GitHub Releases</b>（留空即用）；如需内网分发，可填一个自建静态目录。</div>'
    + '<input id="updSrvInp" class="input" style="width:100%;font-size:12px" value="' + esc(cur) + '" '
    + 'placeholder="http://192.168.1.50:8022 或 http://10.0.0.5/updates">',
    [['取消', _close], ['保存并检查', function () {
      var v = ($('updSrvInp') && $('updSrvInp').value || '').trim();
      /* v6.3.44 · 批 D: 允许留空 = 清除自定义 → 回落**内置默认地址**(不再强制用户填) */
      _send('setting_set', { key: 'update_server', value: v }).then(function (r) {
        if (r.status !== 'ok') { g.toast && toast('✗ 保存失败: ' + (r.msg || ''), 'err'); return; }
        _close();
        g.toast && toast(v ? '✓ 升级服务器已保存' : '✓ 已清除自定义地址, 将走 GitHub Releases', 'success', 2200);
        doCheck();
      });
    }, 'primary']]);
}

/* ── 检查更新 ── */
async function doCheck() {
  _modal('🔄 检查更新', '<div style="text-align:center;padding:10px 0">⏳ 正在连接升级服务器…</div>', [['关闭', _close]]);
  var r = await _send('update_check');
  if (r.status !== 'ok') {
    if (r.server) LAST_ADDR = { server: r.server, source: r.server_source || '' };
    /* v6.3.44 · 批 D: 后端已有**内置默认地址**(DEFAULT_UPDATE_SERVER) → 不再"未配置就弹地址框"
       (用户反馈: "怎么要输入服务器地址了? 用户又不知道地址")。失败时把**用的哪个地址**说清楚,
       并把「⚙ 升级服务器地址」摆在手边, 用户想改随时改。 */
    _body('<div style="color:var(--red)">✗ ' + esc(r.msg || '检查失败') + '</div>');
    _body(_body() + '<div style="margin-top:10px"><button class="btn btn-sm" onclick="UpdateUI.check()">🔄 重试</button>'
      + ' <button class="btn btn-sm" onclick="UpdateUI.server()">⚙ 升级服务器地址</button></div>');
    return;
  }
  CHECKED = r;
  LAST_ADDR = { server: r.server || '', source: r.server_source || '' };
  var rows = '<table style="width:100%;font-size:12.5px;border-collapse:collapse">'
    + _kv('当前版本', 'v' + esc(r.current))
    + _kv('服务器最新', 'v' + esc(r.latest) + (r.published_at ? '（' + esc(r.published_at) + '）' : ''))
    + _kv('检查时间', new Date().toLocaleTimeString())
    + (r.size ? _kv('升级包大小', (r.size / 1048576).toFixed(1) + ' MiB') : '')
    + _kv('升级通道', esc(r.server)
        + (r.server_source === 'github' ? ' <span style="color:var(--text3)">(GitHub Releases)</span>'
         : (r.server_source === 'default' ? ' <span style="color:var(--text3)">(内置默认)</span>' : '')))
    + '</table>';
  if (!r.has_update) {
    _modal('🔄 检查更新', '<div style="text-align:center;padding:8px 0 4px;font-size:20px">✅</div>'
      + '<div style="text-align:center;margin-bottom:10px">已是最新版本 <b>v' + esc(r.current) + '</b></div>' + rows,
      [['关闭', _close]]);
    return;
  }
  var notes = r.notes ? '<div style="background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin-top:12px;max-height:220px;overflow:auto;white-space:pre-wrap">'
    + esc(r.notes) + '</div>' : '';
  _modal('🔄 发现新版本 v' + esc(r.latest),
    '<div style="margin-bottom:6px">发现新版本，可直接 <b>自动更新</b>（下载 → sha256 校验 → 替换代码 → 自动重启服务）。</div>'
    + rows + notes,
    [['取消', _close],
     ['仅下载提示我', function () { _close(); g.toast && toast('升级包地址: ' + r.package_url, 'info', 8000); }],
     ['🚀 立即更新', _apply, 'primary']]);
}
function _kv(k, v) {
  return '<tr><td style="padding:4px 0;color:var(--text3);width:110px">' + k + '</td>'
    + '<td style="padding:4px 0">' + v + '</td></tr>';
}

/* ── 应用更新 + 重启等待 ── */
async function _apply() {
  var r = CHECKED;
  if (!r) { doCheck(); return; }
  if (!g.confirm('确认更新到 v' + r.latest + '?\n\n'
    + '· 将自动下载并校验 sha256（校验不通过绝不应用）\n'
    + '· 替换代码前自动备份当前版本（可回滚）\n'
    + '· 服务将自动重启，期间页面会短暂断开\n\n继续？')) return;
  _modal('🚀 正在更新到 v' + esc(r.latest),
    '<div style="padding:6px 0">⏳ 下载 + 校验 + 应用中，请勿关闭服务…</div>'
    + '<div id="updProg" style="margin-top:10px;color:var(--text3);font-size:11.5px"></div>', []);
  var res = await _send('update_apply');
  if (res.status !== 'ok') {
    _body('<div style="color:var(--red)">✗ ' + esc(res.msg || '更新失败') + '</div>');
    _modal('🚀 更新失败', $('updBody') ? $('updBody').innerHTML : '', [['关闭', _close]]);
    return;
  }
  if (res.applied === false) { _close(); g.toast && toast('✓ ' + (res.msg || '已是最新'), 'success'); return; }
  _body('<div>✅ 下载并校验通过（sha256 ' + esc((res.sha256 || '').slice(0, 12)) + '…）</div>'
    + '<div style="margin-top:6px">⏳ 服务正在替换代码并重启，等待新版本就绪…</div>'
    + '<div id="updProg" style="margin-top:10px;color:var(--text3);font-size:11.5px"></div>');
  _poll(res.version, 0);
}

function _poll(targetVer, n) {
  var el = $('updProg');
  if (n > 90) {   // ~3 分钟
    if (el) el.textContent = '⚠ 等待超时 — 请检查升级服务器/服务端 data/update.log，或手动确认服务状态';
    return;
  }
  if (el) el.textContent = '等待服务重启… (' + (n * 2) + 's)';
  /* 固定 2s 节奏: 重启窗口内 fetch 会**立即失败**(连接被拒), 直接递归会瞬间耗光计数,
     必须等一拍再重试(实测: 不加节流 12s 内就跑完 90 次误报超时) */
  setTimeout(function () {
    fetch('/api/version?_=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var v = String((d && d.version) || '');
        if (v && v === String(targetVer)) {
          _body('<div style="text-align:center;font-size:22px;padding:6px 0">🎉</div>'
            + '<div style="text-align:center">更新完成！已运行 <b>v' + esc(v) + '</b></div>'
            + '<div style="text-align:center;color:var(--text3);font-size:11.5px;margin-top:6px">'
            + '建议刷新页面（Ctrl/Cmd+Shift+R）以加载新前端资源</div>');
          _modal('🎉 更新完成', $('updBody') ? $('updBody').innerHTML : '', [['刷新页面', function () { location.reload(true); }, 'primary'], ['稍后', _close]]);
          return;
        }
        _poll(targetVer, n + 1);   // 旧版本仍在响应(重启未完成) 或服务暂不可用 → 一拍后重试
      })
      .catch(function () { _poll(targetVer, n + 1); });
  }, 2000);
}

g.UpdateUI = { check: doCheck, server: function () { _askServer(); }, state: function () { return CHECKED; } };
})(window);
