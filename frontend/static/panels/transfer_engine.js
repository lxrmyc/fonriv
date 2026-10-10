/* v4.50.0 · 传输引擎设置面板 (系统设置页 · auto/rsync/rclone)
 * 依赖 window.send / toast
 */
(function(g){
  'use strict';

  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }

  function rpc(action, data){
    return new Promise(function(resolve){
      try { window.send(Object.assign({action: action}, data || {}), function(r){ resolve(r || {}); }); }
      catch(e){ resolve({status: 'error', msg: String(e)}); }
    });
  }

  var STATE = { loaded: false };

  async function load(){
    var r = await rpc('transfer_engine_get', {});
    if (r.status !== 'ok') return;
    STATE.loaded = true;
    var engine = r.engine || 'auto';
    ['auto', 'rsync', 'rclone'].forEach(function(k){
      var el = document.getElementById('teEngine_' + k);
      if (el) el.checked = (engine === k);
    });
    var n = document.getElementById('teTransfers');
    if (n) n.value = r.transfers || 4;
    // v4.94.0 · B3 按协议独立并发
    var cr = document.getElementById('teConcRsync'); if (cr) cr.value = r.conc_rsync || 4;
    var cf = document.getElementById('teConcSftp'); if (cf) cf.value = r.conc_sftp || 4;
    var c3 = document.getElementById('teConcS3'); if (c3) c3.value = r.conc_s3 || 4;
    var mb = document.getElementById('teAutoMb');
    if (mb) mb.value = (r.auto_threshold_mb != null) ? r.auto_threshold_mb : 1024;
    var se = document.getElementById('teShardsEnable');
    if (se) se.checked = r.shards_enable !== false;
    var smf = document.getElementById('teShardsMinFiles');
    if (smf) smf.value = (r.shards_min_files != null) ? r.shards_min_files : 500;
    _toggleRcloneRow(engine);
    var ar = document.getElementById('teAutoRow');
    if (ar) ar.style.display = (engine === 'auto') ? '' : 'none';
  }

  function _toggleRcloneRow(engine){
    var row = document.getElementById('teRcloneRow');
    if (row) row.style.display = (engine === 'rclone') ? '' : 'none';
  }

  function _curEngine(){
    var k = 'auto';
    ['auto', 'rsync', 'rclone'].forEach(function(x){
      var el = document.getElementById('teEngine_' + x);
      if (el && el.checked) k = x;
    });
    return k;
  }

  function onEngineChange(){
    _toggleRcloneRow(_curEngine());
    var ar = document.getElementById('teAutoRow');
    if (ar) ar.style.display = (_curEngine() === 'auto') ? '' : 'none';
    save();
  }

  async function save(){
    var engine = _curEngine();
    var transfers = parseInt((document.getElementById('teTransfers')||{}).value || '4', 10) || 4;
    var autoMb = parseInt((document.getElementById('teAutoMb')||{}).value || '1024', 10) || 1024;
    var conc = {
      conc_rsync: parseInt((document.getElementById('teConcRsync')||{}).value || '4', 10) || 4,
      conc_sftp: parseInt((document.getElementById('teConcSftp')||{}).value || '4', 10) || 4,
      conc_s3: parseInt((document.getElementById('teConcS3')||{}).value || '4', 10) || 4,
    };
    var r = await rpc('transfer_engine_set', Object.assign({ engine: engine, transfers: transfers, auto_threshold_mb: autoMb,
                                              shards_enable: (document.getElementById('teShardsEnable')||{}).checked !== false,
                                              shards_min_files: parseInt((document.getElementById('teShardsMinFiles')||{}).value || '500', 10) || 500 }, conc));
    if (typeof window.toast === 'function'){
      window.toast(r.status === 'ok' ? ('✓ ' + (r.msg || '已保存')) : ('✗ ' + (r.msg || '保存失败')),
                   r.status === 'ok' ? 'success' : 'err', 2200);
    }
  }

  async function check(){
    var box = document.getElementById('teRcloneStatus');
    if (box) box.textContent = '⏳ 检测中...';
    var r = await rpc('rclone_check', {});
    if (box) box.innerHTML = (r.status === 'ok')
      ? (r.installed ? '<span style="color:var(--green)">✓ ' + esc(r.msg || '已安装') + '</span>'
                     : '<span style="color:var(--orange)">✗ 本机未安装 rclone</span>'
                      + ' <button class="btn btn-sm" style="margin-left:6px" onclick="TransferEngine.install()">🔧 一键安装</button>')
      : '<span style="color:var(--red)">✗ ' + esc(r.msg || '检测失败') + '</span>';
  }

  async function install(){
    var box = document.getElementById('teRcloneStatus');
    var go = async function(){
      if (box) box.textContent = '⏳ 安装中(最长10分钟)...';
      var r = await rpc('rclone_install', {});
      if (box) box.innerHTML = (r.status === 'ok')
        ? '<span style="color:var(--green)">✓ ' + esc(r.msg || '安装成功') + '</span>'
        : '<span style="color:var(--red)">✗ ' + esc(r.msg || '安装失败') + '</span>'
          + (r.output_tail ? '<pre style="max-height:140px;overflow:auto;font-size:11px;background:var(--bg);padding:6px;border-radius:6px;margin-top:4px">' + esc(r.output_tail) + '</pre>' : '');
    };
    if (!(await rpConfirm({
      title: '🔧 一键安装 rclone',
      body: '将通过系统包管理器 (apt/dnf/yum...) 在本机安装 rclone。\n需要服务进程具备 root 或免密 sudo 权限。',
      danger: true, okText: '开始安装'
    }))) return;
    go();
  }

  // ── v4.59.0 · QoS 带宽时间表 ──
  async function loadQos(){
    var r = await rpc('qos_get', {});
    if (r.status !== 'ok' || !r.qos) return;
    var en = document.getElementById('qosEnable');
    if (en) en.checked = !!r.qos.enabled;
    renderQosRows(r.qos.rules || []);
  }

  function renderQosRows(rules){
    var host = document.getElementById('qosRows');
    if (!host) return;
    host.innerHTML = '';
    (rules.length ? rules : []).forEach(function(r){
      addQosRow(r.start, r.end, r.limit);
    });
    if (!rules.length) addQosRow('09:00', '18:00', '2m');
  }

  function addQosRow(start, end, limit){
    var host = document.getElementById('qosRows');
    if (!host) return;
    var div = document.createElement('div');
    div.style.cssText = 'display:flex;gap:6px;align-items:center;margin-bottom:4px';
    div.innerHTML =
      '<input class="input qos-start" type="time" value="' + esc(start || '09:00') + '" style="width:100px">' +
      '<span style="color:var(--text3)">–</span>' +
      '<input class="input qos-end" type="time" value="' + esc(end || '18:00') + '" style="width:100px">' +
      '<input class="input qos-limit" value="' + esc(limit || '') + '" placeholder="限速 如 2m / 空=不限" style="width:150px;font-family:monospace">' +
      '<button class="btn btn-sm" onclick="this.parentElement.remove()" style="color:var(--red);padding:2px 8px">✕</button>';
    host.appendChild(div);
  }

  async function saveQos(){
    var en = (document.getElementById('qosEnable') || {}).checked === true;
    var rows = Array.from(document.querySelectorAll('#qosRows > div')).map(function(div){
      return {
        start: (div.querySelector('.qos-start') || {}).value || '',
        end: (div.querySelector('.qos-end') || {}).value || '',
        limit: ((div.querySelector('.qos-limit') || {}).value || '').trim(),
      };
    }).filter(function(r){ return r.start && r.end; });
    var r = await rpc('qos_set', { enabled: en, rules: rows });
    if (window.toast) toast(r.status === 'ok' ? '✓ ' + r.msg : '✗ ' + (r.msg || '保存失败'),
                            r.status === 'ok' ? 'success' : 'err', 2800);
  }

  g.TransferEngine = { load: load, save: save, check: check, install: install, onEngineChange: onEngineChange,
                       loadQos: loadQos, saveQos: saveQos, addQosRow: addQosRow };
  document.addEventListener('DOMContentLoaded', function(){
    // 延迟加载: 设置页面板激活时才拉取 (send 需要登录后的 WS)
    setTimeout(function(){
      if (typeof window.currentUser !== 'undefined' && window.currentUser){ load(); loadQos(); }
    }, 1500);
  });
})(window);
