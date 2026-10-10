/* v4.94.0 · 安全中心面板 (G2 rclone crypt / G3 S3 生命周期 / G4 MFA / G5 rclone serve)
 * 后端 security_g.py 自 v4.84 提供全部动作, 本面板补前端 UI
 */
(function(g){
  'use strict';

  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function $(id){ return document.getElementById(id); }
  function gv(id){ var e = $(id); return e ? e.value.trim() : ''; }

  function rpc(action, data){
    return new Promise(function(resolve){
      try { window.send(Object.assign({action: action}, data || {}), function(r){ resolve(r || {}); }); }
      catch(e){ resolve({status: 'error', msg: String(e)}); }
    });
  }
  function say(id, ok, msg){
    var el = $(id); if (!el) return;
    el.innerHTML = '<span style="color:' + (ok === null ? 'var(--text3)' : (ok ? 'var(--green)' : 'var(--red)')) + ';font-size:12px;white-space:pre-wrap">' + esc(msg || '') + '</span>';
  }

  /* ── G2 rclone crypt ── */
  async function cryptCreate(){
    var name = gv('scCryptName'), base = gv('scCryptBase'), pw = gv('scCryptPass');
    if (cryptEditMode){
      if (!base){ toast('底层 remote 必填', 'warn', 2400); return; }
      say('scCryptResult', null, '⏳ 保存修改…');
      var ru = await rpc('g2_crypt_update', { crypt_name: cryptEditMode, remote_base: base,
        password: pw, salt: gv('scCryptSalt'), filename_encryption: gv('scCryptFn') || 'standard',
        directory_encryption: ($('scCryptDir') || {}).checked !== false });
      say('scCryptResult', ru.status === 'ok', ru.msg || '');
      cryptEditCancel(); cryptList();
      return;
    }
    if (!name || !base || !pw){ toast('名称/底层 remote/密码 必填', 'warn', 2400); return; }
    say('scCryptResult', null, '⏳ 创建中…');
    var r = await rpc('g2_crypt_create', { crypt_name: name, remote_base: base, password: pw,
      salt: gv('scCryptSalt'), filename_encryption: gv('scCryptFn') || 'standard',
      directory_encryption: ($('scCryptDir') || {}).checked !== false });
    say('scCryptResult', r.status === 'ok', r.msg || '');
    cryptList();
  }

  async function cryptList(){
    var r = await rpc('g2_crypt_list', {});
    var box = $('scCryptList'); if (!box) return;
    if (r.status !== 'ok'){ box.innerHTML = '<span style="color:var(--red);font-size:12px">✗ 加载失败</span>'; return; }
    var rows = r.remotes || [];
    if (!rows.length){ box.innerHTML = '<span style="color:var(--text3);font-size:12px">rclone.conf 中暂无 remote</span>'; return; }
    var h = '<table style="width:100%;font-size:11px;border-collapse:collapse"><tr style="color:var(--text3);text-align:left"><th style="padding:3px 6px">名称</th><th>类型</th><th>底层</th><th></th></tr>';
    rows.forEach(function(d){
      var isCrypt = d.type === 'crypt';
      h += '<tr style="border-top:1px solid var(--line)"><td style="padding:3px 6px;font-family:monospace">' + esc(d.name) + '</td>' +
        '<td>' + (isCrypt ? '<b style="color:var(--cyan)">crypt 🔐</b>' : esc(d.type || '?')) + '</td>' +
        '<td style="color:var(--text3)">' + esc(d.remote || '') + '</td>' +
        '<td>' + (isCrypt
          ? '<button class="btn btn-sm" style="padding:1px 8px;font-size:10px" onclick="Security.cryptTest(\'' + esc(d.name) + '\')">🧪 测试</button> '
            + '<button class="btn btn-sm" style="padding:1px 8px;font-size:10px" onclick="Security.cryptEdit(\'' + esc(d.name) + '\')">✏️ 编辑</button> '
            + '<button class="btn btn-sm" style="padding:1px 8px;font-size:10px;color:var(--red)" onclick="Security.cryptDel(\'' + esc(d.name) + '\')">🗑</button>'
          : '') + '</td></tr>';
    });
    h += '</table><div style="font-size:10px;color:var(--text3);margin-top:3px">共 ' + rows.length + ' remote · ' + (r.crypt_count || 0) + ' 个 crypt</div>';
    box.innerHTML = h;
  }

  // v5.22.3 · crypt 编辑/删除
  var cryptEditMode = null;
  async function cryptEdit(name){
    var all = await rpc('g2_crypt_list', {});
    var hit = (all.remotes || []).find(function(x){ return x.name === name && x.type === 'crypt'; });
    if (!hit){ toast('未找到 ' + name, 'err', 2400); return; }
    cryptEditMode = name;
    $('scCryptName').value = name; $('scCryptName').disabled = true;
    $('scCryptBase').value = hit.remote || '';
    $('scCryptPass').value = ''; $('scCryptPass').placeholder = '留空 = 不修改密码';
    var cancel = $('scCryptCancel');
    if (cancel) cancel.style.display = '';
    var save = $('scSaveBtn');
    if (save) save.textContent = '💾 保存修改';
    toast('✏️ 编辑 ' + name + ' — 改完点「保存修改」', 'info', 2600);
  }
  function cryptEditCancel(){
    cryptEditMode = null;
    var n = $('scCryptName'); if (n){ n.value=''; n.disabled = false; }
    var b = $('scCryptBase'); if (b) b.value = '';
    var pw = $('scCryptPass'); if (pw){ pw.value=''; pw.placeholder=''; }
    var save = $('scSaveBtn'); if (save) save.textContent = '➕ 创建 crypt remote';
    var cancel = $('scCryptCancel'); if (cancel) cancel.style.display = 'none';
  }
  async function cryptDel(name){
    if (!window.confirm || !window.confirm('确定删除 crypt remote「' + name + '」?\n仅移除本机 rclone.conf 配置, 云端数据不受影响; 删除后已加密数据将无法通过此 remote 读取!')) return;
    var r = await rpc('g2_crypt_delete', { crypt_name: name, confirm: true });
    toast(r.msg || (r.status === 'ok' ? '✓ 已删除' : '✗ 失败'), r.status === 'ok' ? 'success' : 'err', 3600);
    if (cryptEditMode === name) cryptEditCancel();
    cryptList();
  }

  async function cryptTest(name){
    toast('🧪 测试 ' + name + ' …', 'info', 2000);
    var r = await rpc('g2_crypt_test', { crypt_name: name });
    toast(r.msg || (r.status === 'ok' ? '✓ 连通' : '✗ 失败'), r.status === 'ok' ? 'success' : 'err', 3200);
  }

  /* ── G3 S3 lifecycle ── */
  function _s3params(){
    return { bucket: gv('scS3Bucket'), endpoint: gv('scS3Endpoint'),
             access_key: gv('scS3Ak'), secret_key: gv('scS3Sk') };
  }
  async function s3Get(){
    if (!gv('scS3Bucket')){ toast('请填写 bucket', 'warn', 2000); return; }
    var box = $('scS3Rules'); box.innerHTML = '<span style="color:var(--text3);font-size:12px">⏳ 读取规则…</span>';
    var r = await rpc('g3_s3_lifecycle', Object.assign(_s3params(), { sub_action: 'get' }));
    if (r.status !== 'ok'){ box.innerHTML = '<span style="color:var(--red);font-size:12px">✗ ' + esc(r.msg || '失败') + '</span>'; return; }
    var rules = r.rules || [];
    box.innerHTML = rules.length
      ? '<table style="width:100%;font-size:11px;border-collapse:collapse"><tr style="color:var(--text3);text-align:left"><th style="padding:3px 6px">ID</th><th>前缀</th><th>过期(天)</th><th>转储</th><th>状态</th></tr>' +
        rules.map(function(x){
          return '<tr style="border-top:1px solid var(--line)"><td style="padding:3px 6px">' + esc(x.ID || '') + '</td>' +
            '<td>' + esc((x.Filter && x.Filter.Prefix) || '') + '</td>' +
            '<td>' + ((x.Expiration && x.Expiration.Days) || '—') + '</td>' +
            '<td>' + ((x.Transitions && x.Transitions[0] && (x.Transitions[0].StorageClass + '@' + x.Transitions[0].Days)) || '—') + '</td>' +
            '<td>' + esc(x.Status || '') + '</td></tr>';
        }).join('') + '</table>'
      : '<span style="color:var(--text3);font-size:12px">该桶暂无生命周期规则</span>';
  }
  async function s3Put(){
    if (!gv('scS3Bucket')){ toast('请填写 bucket', 'warn', 2000); return; }
    say('scS3Result', null, '⏳ 下发规则…');
    var r = await rpc('g3_s3_lifecycle', Object.assign(_s3params(), {
      sub_action: 'put', prefix: gv('scS3Prefix'),
      expire_days: parseInt(gv('scS3Expire') || '0', 10) || 0,
      transition_days: parseInt(gv('scS3Transition') || '0', 10) || 0,
      storage_class: gv('scS3Class') || '' }));
    say('scS3Result', r.status === 'ok', r.msg || (r.status === 'ok' ? '✓ 规则已下发' : ''));
    s3Get();
  }

  /* ── G3.5 S3 Object Lock (v5.14.0) ── */
  async function olGet(){
    if (!gv('scS3Bucket')){ toast('请填写 bucket', 'warn', 2000); return; }
    var box = $('scOLState'); if (!box) return;
    box.innerHTML = '<span style="color:var(--text3);font-size:12px">⏳ 读取对象锁…</span>';
    var r = await rpc('g3_object_lock', Object.assign(_s3params(), { sub_action: 'get' }));
    if (r.status !== 'ok'){ box.innerHTML = '<span style="color:var(--red);font-size:12px">✗ ' + esc(r.msg || '失败') + '</span>'; return; }
    if (!r.enabled){ box.innerHTML = '<span style="color:var(--text3);font-size:12px">对象锁未启用 (桶需在创建时支持 WORM, 或直接下发默认保留)</span>'; return; }
    var rule = (r.config && r.config.Rule && r.config.Rule.DefaultRetention) || {};
    box.innerHTML = '<span style="color:var(--green);font-size:12px">🟢 已启用 · ' + esc(rule.Mode || '?') +
      ' 保留 ' + esc(String(rule.Days || '?')) + ' 天 (新写入对象默认受保护)</span>';
  }
  async function olSet(){
    if (!gv('scS3Bucket')){ toast('请填写 bucket', 'warn', 2000); return; }
    var days = parseInt(gv('scOLDays') || '0', 10) || 0;
    if (days <= 0){ toast('保留天数必须 > 0', 'warn', 2200); return; }
    var mode = gv('scOLMode') || 'governance';
    if (mode === 'compliance' && !(await rpConfirm({ title:'compliance 模式', danger:true, okText:'确认', body:'compliance 模式在保留期内任何人都无法删除/覆盖 (含 root), 确认?' }))) return;
    say('scOLResult', null, '⏳ 下发对象锁…');
    var r = await rpc('g3_object_lock', Object.assign(_s3params(), { sub_action: 'set', mode: mode, days: days }));
    say('scOLResult', r.status === 'ok', r.msg || '');
    olGet();
  }

  /* ── G4 MFA ── */
  async function mfaStatus(){
    var r = await rpc('mfa_status', {});
    if (r.status !== 'ok') return;
    var el = $('scMfaState'); if (!el) return;
    el.innerHTML = r.mfa_enabled
      ? '<span style="color:var(--green);font-weight:600">✓ MFA 已启用</span>'
      : (r.mfa_pending ? '<span style="color:var(--orange);font-weight:600">⏳ 待验证 6 位码</span>'
                       : '<span style="color:var(--text3)">未启用</span>');
    return r;
  }
  async function mfaSetup(){
    var r = await rpc('mfa_setup', { label: 'Fonriv:' + (gv('scMfaLabel') || 'admin') });
    if (r.status !== 'ok'){ say('scMfaResult', false, r.msg || ''); return; }
    var box = $('scMfaSecret');
    box.style.display = '';
    box.innerHTML = '<div style="font-size:12px;line-height:1.9;padding:8px 10px;background:var(--bg3);border-radius:6px">' +
      'secret: <code style="user-select:all">' + esc(r.secret) + '</code><br>' +
      '<span style="color:var(--text3);font-size:11px">在 Google Authenticator / FreeOTP 中手工输入上述 secret, 或用 otpauth URI:</span><br>' +
      '<code style="font-size:10px;user-select:all;word-break:break-all">' + esc(r.uri) + '</code></div>';
    say('scMfaResult', null, '输入验证器显示的 6 位码后点「验证并启用」');
    mfaStatus();
  }
  async function mfaVerify(){
    var r = await rpc('mfa_verify', { code: gv('scMfaCode') });
    say('scMfaResult', r.status === 'ok', r.msg || '');
    mfaStatus();
  }

  /* ── G1 Air-Gap 摆渡公钥管理 (v5.14.0 · RSA 带外分发) ── */
  async function ferryPubkey(){
    var box = $('scFerryPubs'); if (!box) return;
    say('scFerryResult', null, '⏳ 生成本机密钥对…');
    var r = await rpc('ferry_pubkey', {});
    if (r.status !== 'ok'){ say('scFerryResult', false, r.msg || ''); return; }
    box.style.display = '';
    box.innerHTML = '<div style="font-size:12px;padding:8px 10px;background:var(--bg3);border-radius:6px">' +
      '本机公钥指纹: <b style="color:var(--cyan);user-select:all">' + esc(r.fingerprint) + '</b><br>' +
      '<textarea readonly style="width:100%;height:84px;font-size:10px;font-family:monospace;margin-top:4px;user-select:all">' + esc(r.pub_pem) + '</textarea></div>';
    say('scFerryResult', true, '✓ 公钥已出示 — 带外复制到导入方');
  }
  async function ferryTrust(){
    var pem = gv('scFerryPem');
    if (pem.indexOf('BEGIN PUBLIC KEY') < 0){ toast('请粘贴 PEM 公钥', 'warn', 2200); return; }
    say('scFerryResult', null, '⏳ 录入信任列表…');
    var r = await rpc('ferry_trust', { pub_pem: pem });
    say('scFerryResult', r.status === 'ok', r.msg || '');
  }

  /* ── G5 rclone serve ── */
  /* v6.12.0 · 批12: 探测入口(修复: index.html 此前引用不存在的 SecurityG.loadServeProtos = 死按钮) */
  async function loadServeProtos(){
    var r = await rpc('serve_protos', {});   // v6.12.0 · 批12 FIX: 动作名是 serve_protos(旧引用 g5_serve_protos 恒 error)
    if (!r || r.status !== 'ok') return;
    var sel = $('scServeProto'); if (!sel) return;
    var cur = sel.value;
    var opts = (r.protos || []).map(function(p){
      return '<option value="' + esc(p.id) + '">' + esc(p.label) + (p.desc ? (' — ' + esc(p.desc)) : '') + '</option>';
    }).join('');
    if (opts){
      sel.innerHTML = opts;
      var keep = [].slice.call(sel.options).some(function(o){ return o.value === cur; });
      if (keep) sel.value = cur;
    }
    rcloneInfo();
  }
  /* 组件信息: 版本/来源/可用协议; 未含 s3 时显示「升级组件」按钮 */
  async function rcloneInfo(){
    var r = await rpc('rclone_component_status', {});
    if (!r || r.status !== 'ok') return;
    var el = $('scRcloneVer');
    if (el) el.textContent = 'rclone ' + (r.version || '?')
      + ' · ' + (r.bundled ? '应用内置组件(可随应用升级)' : '系统安装')
      + ' · 可用 serve: ' + ((r.protos || []).join(' / ') || '?');
    var up = $('scRcloneUpBtn');
    if (up) up.style.display = r.has_s3 ? 'none' : '';
  }
  /* 升级: 下载官方最新包到应用组件目录 → 轮询进度 → 成功后刷新协议下拉 */
  async function rcloneUpgrade(){
    var ok = await rpConfirm({ title: '升级 rclone 组件', danger: true, okText: '下载并升级', cancelText: '取消',
      body: '将从官方源 downloads.rclone.org 下载最新 linux-amd64 版(约 30MB)到**应用自己的组件目录**'
          + '(不改系统包, 删除该文件即可回退到系统版)。\n升级后可解锁 serve s3 / ftp / nfs 等新协议。\n继续?' });
    if (!ok) return;
    var r = await rpc('rclone_upgrade_start', { confirm: true });
    if (!r || r.status !== 'ok'){ say('scServeResult', false, (r && r.msg) || '启动失败'); return; }
    say('scServeResult', null, (r.msg) || '已开始');
    var t = setInterval(async function(){
      var st = await rpc('rclone_upgrade_status', {});
      if (!st || st.state === 'running'){
        say('scServeResult', null, '⏳ ' + (((st && st.lines) || []).slice(-1)[0] || '处理中…'));
        return;
      }
      clearInterval(t);
      if (st.state === 'ok'){
        say('scServeResult', true, '✓ rclone 已升级: ' + (st.version || ''));
        toast('✓ rclone 组件已升级: ' + (st.version || '') + ' —— 现在可用 S3/FTP/NFS 等新协议', 'ok', 7000);
        loadServeProtos();
      } else {
        say('scServeResult', false, '✗ 升级失败: ' + (st.error || '未知'));
        toast('✗ rclone 升级失败(详见安全中心)', 'err', 8000);
      }
    }, 1500);
  }
  async function serveStart(){
    var path = gv('scServePath');
    if (!path){ toast('请填写要对外提供的路径', 'warn', 2000); return; }
    say('scServeResult', null, '⏳ 启动中…');
    var r = await rpc('g5_serve_start', { path: path, proto: gv('scServeProto') || 'webdav',
      port: parseInt(gv('scServePort') || '8080', 10) || 8080, mtls: !!($('scServeMtls') || {}).checked,
      name: gv('scServeName') || undefined, user: gv('scServeUser'), pass: gv('scServePass') });
    say('scServeResult', r.status === 'ok', r.msg || '');
    serveStatus();
  }
  async function serveStop(){
    var r = await rpc('g5_serve_stop', { name: gv('scServeName') || ('serve_' + (gv('scServePort') || '8080')) });
    say('scServeResult', r.status === 'ok', r.msg || '');
    serveStatus();
  }
  async function serveStatus(){
    var r = await rpc('g5_serve_status', {});
    var box = $('scServeList'); if (!box || r.status !== 'ok') return;
    var rows = r.running || [];
    box.innerHTML = rows.length
      ? rows.map(function(x){
          /* v6.10.0 · 批10: 显示端口/开机自启/托管方式(systemd 单元, 重启自动拉起) */
          return '<span title="' + esc((x.unit ? ('systemd: ' + x.unit + ' · 开机自启') : '旧式内存实例(重启即丢)')
                                        + (x.path ? (' · ' + x.path) : '')) + '" style="display:inline-flex;align-items:center;gap:4px;padding:2px 8px;margin:2px;border:1px solid var(--line);border-radius:10px;font-size:11px">' +
            (x.running ? '🟢' : '⚪') + ' ' + esc(x.name) +
            (x.port ? (' <span style="color:var(--text3)">:' + esc(String(x.port)) + '</span>') : '') +
            (x.autostart ? ' <span style="font-size:9.5px;color:var(--green)">自启</span>' : '') +
            (x.running ? ' <button class="btn btn-sm" style="padding:0 6px;font-size:10px" onclick="Security.serveStop()">⏹</button>' : '') + '</span>';
        }).join('')
      : '<span style="color:var(--text3);font-size:12px">无运行中的 serve 实例</span>';
  }

  /* ── v5.22.3 · 零信任主机信任 + E2EE 身份 (界面化) ── */
  async function ztRefresh(){
    var r = await rpc('zerotrust', { sub: 'status' });
    var pins = await rpc('zerotrust', { sub: 'pins' });
    var box = $('scZtList'); if (!box) return;
    if (r.status !== 'ok'){ box.innerHTML = '<span style="color:var(--red)">✗ ' + esc(r.msg || '查询失败') + '</span>'; return; }
    var list = (pins && pins.pins) ? pins.pins : {};
    var keys = Object.keys(list);
    box.innerHTML = '已钉死 <b>' + (r.pinned_hosts != null ? r.pinned_hosts : keys.length) + '</b> 台主机'
      + (keys.length
        ? '<table style="width:100%;font-size:11px;border-collapse:collapse;margin-top:4px"><tr style="color:var(--text3);text-align:left"><th style="padding:3px 6px">主机</th><th>指纹 (SHA256)</th><th></th></tr>'
          + keys.map(function(k){
              return '<tr style="border-top:1px solid var(--line)"><td style="padding:3px 6px;font-family:monospace">' + esc(k) + '</td>' +
                '<td style="font-family:monospace;color:var(--text2)">' + esc((list[k].fingerprint || '').slice(0, 32)) + '…</td>' +
                '<td><button class="btn btn-sm" style="padding:1px 8px;font-size:10px;color:var(--red)" onclick="Security.ztUntrust(\'' + esc(k) + '\')">解除</button></td></tr>';
            }).join('') + '</table>'
        : '<div style="margin-top:4px">(尚无钉死记录 — 钉死后传输启用强校验)</div>');
  }
  async function ztTrust(){
    var host = gv('scZtHost'), port = gv('scZtPort') || '22';
    if (!host){ toast('请填写主机地址', 'warn', 2200); return; }
    if (!window.confirm('钉死 ' + host + ':' + port + ' 的 SSH 主机密钥?\n请在可信网络内首次信任; 之后密钥变更将被拒绝并告警。')) return;
    var r = await rpc('zerotrust', { sub: 'trust', host: host, port: parseInt(port, 10) || 22,
      user: gv('scZtUser') || 'root', auth_type: 'pass',
      password: 'ENC:' + btoa(gv('scZtPass') || ''), confirm: true });
    toast(r.msg || (r.status === 'ok' ? '✓ 已钉死' : '✗ 失败'), r.status === 'ok' ? 'success' : 'err', 4200);
    ztRefresh();
  }
  async function ztUntrust(key){
    var sep = key.lastIndexOf(':');
    var host = sep > 0 ? key.slice(0, sep) : key, port = sep > 0 ? parseInt(key.slice(sep+1), 10) || 22 : 22;
    if (!window.confirm('解除 ' + key + ' 的信任? 解除后到该主机的传输退回首连自动接受。')) return;
    var r = await rpc('zerotrust', { sub: 'untrust', host: host, port: port, confirm: true });
    toast(r.msg || (r.status === 'ok' ? '✓ 已解除' : '✗ 失败'), r.status === 'ok' ? 'success' : 'err', 3200);
    ztRefresh();
  }

  var e2eePending = null;   // 已取回未钉死的对端公钥 {host, pub_b64, fingerprint}
  async function e2eeStatus(){
    var r = await rpc('e2ee', { sub: 'status' });
    var box = $('scE2eeId'); if (!box) return;
    if (r.status !== 'ok'){ box.innerHTML = '<span style="color:var(--red)">✗ ' + esc(r.msg || '失败') + '</span>'; return; }
    box.innerHTML = '本机身份指纹: <b style="font-family:monospace">' + esc(r.fingerprint || '-') + '</b>'
      + ' <span style="color:var(--text3);font-size:11px">(与对端核对一致后才应钉死对方公钥)</span>';
  }
  async function e2eePeers(){
    var r = await rpc('e2ee', { sub: 'peers' });
    var box = $('scE2List'); if (!box) return;
    if (r.status !== 'ok'){ box.innerHTML = '<span style="color:var(--red)">✗ ' + esc(r.msg || '失败') + '</span>'; return; }
    var peers = r.peers || {};
    var keys = Object.keys(peers);
    box.innerHTML = keys.length
      ? '已钉死对端: <table style="width:100%;font-size:11px;border-collapse:collapse;margin-top:4px"><tr style="color:var(--text3);text-align:left"><th style="padding:3px 6px">对端</th><th>公钥指纹</th><th></th></tr>'
        + keys.map(function(k){
            return '<tr style="border-top:1px solid var(--line)"><td style="padding:3px 6px;font-family:monospace">' + esc(k) + '</td>' +
              '<td style="font-family:monospace;color:var(--text2)">' + esc(peers[k].fingerprint || '') + '</td>' +
              '<td><button class="btn btn-sm" style="padding:1px 8px;font-size:10px;color:var(--red)" onclick="Security.e2eeUnpin(\'' + esc(k) + '\')">解除</button></td></tr>';
          }).join('') + '</table>'
      : '(尚未钉死任何对端 — relay 暂存加密现为单端模式)';
  }
  async function e2eeExchange(){
    var host = gv('scE2Host');
    if (!host){ toast('请填写对端主机', 'warn', 2200); return; }
    toast('🔑 经 SSH 通道取回 ' + host + ' 身份公钥…', 'info', 2400);
    var r = await rpc('e2ee', { sub: 'exchange', host: host, user: gv('scE2User') || 'root',
      auth_type: 'pass', password: 'ENC:' + btoa(gv('scE2Pass') || '') }, 40000);
    if (r.status !== 'ok'){ toast('✗ ' + (r.msg || '失败'), 'err', 4200); return; }
    e2eePending = { host: host, pub_b64: r.pub_b64, fingerprint: r.fingerprint };
    var box = $('scE2Pending');
    box.innerHTML = '<span style="font-size:12px">对端 <b>' + esc(host) + '</b> 指纹: <b style="font-family:monospace;color:var(--cyan)">'
      + esc(r.fingerprint || '') + '</b> — 请与对端核对一致后 '
      + '<button class="btn btn-sm btn-primary" style="padding:1px 10px;font-size:11px" onclick="Security.e2eePin()">✔ 钉死</button></span>';
  }
  async function e2eePin(){
    if (!e2eePending){ toast('请先取回对端公钥', 'warn', 2200); return; }
    if (!window.confirm('钉死 ' + e2eePending.host + ' 的身份公钥 (指纹 ' + e2eePending.fingerprint + ')?\n请确认已与对端当面/带外核对过指纹。')) return;
    var r = await rpc('e2ee', { sub: 'pin', host: e2eePending.host, pub_b64: e2eePending.pub_b64, confirm: true });
    toast(r.msg || (r.status === 'ok' ? '✓ 已钉死' : '✗ 失败'), r.status === 'ok' ? 'success' : 'err', 4200);
    e2eePending = null; $('scE2Pending').innerHTML = '';
    e2eePeers();
  }
  async function e2eeUnpin(host){
    if (!window.confirm('解除 ' + host + ' 的公钥钉死?')) return;
    var r = await rpc('e2ee', { sub: 'unpin', host: host, confirm: true });
    toast(r.msg || (r.status === 'ok' ? '✓ 已解除' : '✗ 失败'), r.status === 'ok' ? 'success' : 'err', 3200);
    e2eePeers();
  }

  // v5.24.0 · 零信任传输 mTLS 证书状态
  async function mtlsStatus(){
    var out = $('scMtlsResult');
    var r = await rpc('zt_mtls', { sub: 'status' });
    if (out) out.textContent = r.status === 'ok'
      ? '✓ 证书就绪 · CA 指纹 ' + (r.ca_fingerprint || '').slice(0, 24) + '… 客户端: curl --cert client.crt --key client.key --cacert ca.crt'
      : '✗ ' + (r.msg || '失败');
  }

  /* ═══ v5.29.0 · HTTPS / SSL 证书管理 ═══ */
  let httpsServing = false;
  function _httpsMsg(m, isErr){
    var el = $('httpsMsg'); if (!el) return;
    el.textContent = m || '';
    el.style.color = isErr ? 'var(--red)' : (m && m.indexOf('✓') === 0 ? 'var(--green)' : 'var(--text3)');
  }
  async function httpsLoad(){
    var r = await rpc('https_get', {});
    if (r.status !== 'ok'){ _httpsMsg('✗ ' + (r.msg || '读取失败'), true); return; }
    httpsServing = !!r.serving_https;
    var c = r.cfg || {}, info = r.cert || {};
    var badge = $('httpsBadge');
    if (badge){
      if (httpsServing && r.pending_restart) { badge.textContent = 'HTTPS · 待重启变更'; badge.style.background = 'var(--orange)'; badge.style.color = '#fff'; }
      else if (httpsServing) { badge.textContent = 'HTTPS 已生效'; badge.style.background = 'var(--green)'; badge.style.color = '#fff'; }
      else if (c.https_enabled) { badge.textContent = '已配置 · 待重启启用'; badge.style.background = 'var(--orange)'; badge.style.color = '#fff'; }
      else { badge.textContent = 'HTTP 模式'; badge.style.background = 'var(--bg2,#eee)'; badge.style.color = 'var(--text3)'; }
    }
    var ci = $('httpsCertInfo');
    if (ci){
      if (!info.exists){
        ci.innerHTML = '尚未签发证书 — 保存配置后点「立即签发/续期」';
      } else if (info.error){
        ci.innerHTML = '证书解析失败: ' + esc(info.error);
      } else {
        var days = info.days_left;
        var color = days > 30 ? 'var(--green)' : days > 7 ? 'var(--orange)' : 'var(--red)';
        var kind = info.self_signed ? '自签名' : (info.issuer.indexOf("Let's Encrypt") >= 0 ? "Let's Encrypt" : esc(info.issuer.slice(0, 60)));
        ci.innerHTML = '颁发: <b>' + kind + '</b> · 到期 <b>' + esc(info.not_after) + '</b> '
          + '<span style="color:' + color + ';font-weight:700">(剩 ' + days + ' 天)</span>'
          + ' · SAN: ' + esc((info.sans || []).slice(0, 4).join(' '))
          + '<br>证书: <span style="font-family:monospace">' + esc(r.cert_path) + '</span> (私钥 600)';
      }
    }
    $('httpsEnabled').checked = !!c.https_enabled;
    $('httpsMode').value = c.https_mode || 'selfsigned';
    $('httpsDomains').value = c.https_domains || '';
    $('httpsAcmeEmail').value = c.https_acme_email || '';
    $('httpsAcmeStaging').checked = !!c.https_acme_staging;
    $('httpsAutoRenew').checked = !!c.https_auto_renew;
    $('httpsRenewDays').value = c.https_renew_before_days || 30;
    $('httpsPort').value = c.https_port || 8443;
    if (httpsServing && c.redirect_from) _httpsMsg('✓ HTTPS 运行中 · http://…:' + c.redirect_from + ' 自动跳转 :' + (c.https_port || 8443), false);
    httpsModeUI();
  }
  function httpsModeUI(){
    var m = $('httpsMode').value;
    $('httpsAcmeRow').style.display = m === 'acme' ? 'grid' : 'none';   // v6.16.11 · 该行已改 form-row 栅格
    $('httpsUploadRow').style.display = m === 'manual' ? 'block' : 'none';
  }
  async function httpsSave(){
    var r = await rpc('https_set', {
      enabled: $('httpsEnabled').checked,
      mode: $('httpsMode').value,
      domains: $('httpsDomains').value,
      acme_email: $('httpsAcmeEmail').value,
      acme_staging: $('httpsAcmeStaging').checked,
      auto_renew: $('httpsAutoRenew').checked,
      renew_before_days: $('httpsRenewDays').value,
      https_port: $('httpsPort').value,
    });
    _httpsMsg((r.status === 'ok' ? '' : '✗ ') + (r.msg || ''), r.status !== 'ok');
    if (r.status === 'ok') httpsLoad();
  }
  async function httpsIssue(){
    if (httpsServing){ toast('HTTPS 运行中签发将更新证书文件, 建议签发后重启服务加载新证书', 'warn', 5000); }
    _httpsMsg('⏳ 签发中… (ACME 全程约 30~120 秒, 进度见运行日志)');
    var r = await rpc('https_issue', {
      mode: $('httpsMode').value,
      domains: $('httpsDomains').value,
      acme_email: $('httpsAcmeEmail').value,
      acme_staging: $('httpsAcmeStaging').checked,
    });
    _httpsMsg((r.status === 'ok' ? '' : '✗ ') + (r.msg || ''), r.status !== 'ok');
    if (r.status === 'ok') httpsLoad();
  }
  async function httpsUpload(){
    var cp = $('httpsCertPem').value.trim(), kp = $('httpsKeyPem').value.trim();
    if (!cp || !kp){ toast('证书与私钥 PEM 都必填', 'warn'); return; }
    var r = await rpc('https_upload', { cert_pem: cp, key_pem: kp });
    _httpsMsg((r.status === 'ok' ? '' : '✗ ') + (r.msg || ''), r.status !== 'ok');
    if (r.status === 'ok') httpsLoad();
  }

  /* ═══ v5.28.5 · 安全检查 + 端口管理 ═══ */
  async function secCheck(){
    var el = document.getElementById('secScore');
    var fd = document.getElementById('secFindings');
    if (el) el.textContent = '⏳';
    if (fd) fd.innerHTML = '⏳ 扫描中… (端口/SSH/防火墙/文件权限/uid=0)';
    var r = await rpc('sec_check', {});
    if (r.status !== 'ok'){ if(fd) fd.innerHTML = '✗ ' + (r.msg || '失败'); return; }
    if (el){
      var sc = parseInt(r.score) || 0;
      el.textContent = sc;
      el.style.color = sc >= 80 ? 'var(--green)' : sc >= 50 ? 'var(--orange)' : 'var(--red)';
    }
    if (fd){
      if (!(r.findings || []).length){ fd.innerHTML = '✓ 未发现安全问题'; return; }
      fd.innerHTML = (r.findings||[]).map(function(f){
        var color = f.level === 'high' ? 'var(--red)' : 'var(--orange)';
        return '<div style="margin:4px 0;padding:4px 8px;background:var(--bg);border-left:3px solid ' + color + ';border-radius:4px">'
          + '<b style="color:' + color + '">' + (f.level === 'high' ? '⚠ 高危' : '⚡ 建议') + '</b> ' + f.check
          + '<br><span style="color:var(--text3);font-size:11px">→ ' + f.advice + '</span></div>';
      }).join('');
    }
  }
  async function secPorts(){
    var body = document.getElementById('secPortsBody');
    if (!body) return;
    body.innerHTML = '⏳ 扫描中…';
    var r = await rpc('sec_ports', { sub: 'list' });
    var ports = (r && r.ports) || [];
    if (!ports.length){ body.innerHTML = '(未检测到监听端口)'; return; }
    body.innerHTML = '<table style="width:100%;font-size:11px;border-collapse:collapse">'
      + '<tr style="color:var(--text3)"><th style="text-align:left;padding:2px 6px">端口</th><th>进程</th><th>地址</th></tr>'
      + ports.map(function(p){
          var risky = [3306,5432,6379,27017,23,21].indexOf(p.port) >= 0;
          var color = risky ? 'var(--red)' : 'var(--text2)';
          return '<tr><td style="padding:2px 6px;font-family:monospace;color:' + color + '">' + p.port + '</td>'
            + '<td style="font-family:monospace;color:var(--text3)">' + (p.process||'?') + '</td>'
            + '<td style="color:var(--text3)">' + (p.addr||'') + '</td></tr>';
        }).join('')
      + '</table>';
  }
  async function secFirewall(){
    var r = await rpc('sec_ports', { sub: 'firewall' });
    var body = document.getElementById('secPortsBody');
    if (body && r.firewall) body.innerHTML = '<pre style="font-size:11px;white-space:pre-wrap">' + r.firewall + '</pre>';
  }

  g.Security = { cryptCreate: cryptCreate, cryptList: cryptList, cryptTest: cryptTest,
                 secCheck: secCheck, secPorts: secPorts, secFirewall: secFirewall,
                 httpsLoad: httpsLoad, httpsSave: httpsSave, httpsIssue: httpsIssue,
                 httpsUpload: httpsUpload, httpsModeUI: httpsModeUI, mtlsStatus: mtlsStatus,
                 cryptEdit: cryptEdit, cryptDel: cryptDel, cryptEditCancel: cryptEditCancel,
                 ztRefresh: ztRefresh, ztTrust: ztTrust, ztUntrust: ztUntrust,
                 e2eeStatus: e2eeStatus, e2eePeers: e2eePeers, e2eeExchange: e2eeExchange,
                 e2eePin: e2eePin, e2eeUnpin: e2eeUnpin,
                 s3Get: s3Get, s3Put: s3Put, olGet: olGet, olSet: olSet,
                 ferryPubkey: ferryPubkey, ferryTrust: ferryTrust,
                 mfaSetup: mfaSetup, mfaVerify: mfaVerify, mfaStatus: mfaStatus,
                 serveStart: serveStart, serveStop: serveStop, serveStatus: serveStatus,
                 loadServeProtos: loadServeProtos, rcloneInfo: rcloneInfo, rcloneUpgrade: rcloneUpgrade };
  document.addEventListener('DOMContentLoaded', function(){
    var _load = function(){
      if (typeof window.currentUser === 'undefined' || !window.currentUser) return;
      cryptList(); mfaStatus(); serveStatus(); ztRefresh(); e2eeStatus(); e2eePeers(); secCheck(); secPorts(); httpsLoad();
      loadServeProtos();   /* v6.12.0 · 批12: 进入即刷新协议下拉(含升级后的新协议) + 组件状态 */
    };
    // v5.22.3 · 登录时序竞态: 面板激活时刷新 (DOMContentLoaded+定时的老路在慢登录时会空跑)
    var panel = document.getElementById('panel-security');
    if (panel && 'MutationObserver' in window){
      new MutationObserver(function(){
        if (panel.classList.contains('active')) _load();
      }).observe(panel, { attributes: true, attributeFilter: ['class'] });
    }
    setTimeout(_load, 2200);
  });
})(window);
