/* v4.92.0 · PVE API 模式 + D4 集群视图 + D2 存储智能识别 + D3 VM 流水线模板
 *  - PveApi: REST API(8006) 认证 → 集群视图(节点/VM/存储) → 电源/迁移/快照(创建/回滚)
 *  - StoragePolicy: 路径存储栈探测 → 备份通道推荐 (zfs/lvm-thin/rbd/btrfs/dir)
 *  - VmPipeline: vzdump 编排流水线一键模板 (冻结→快照→vzdump→传输→校验→解冻→通知)
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

  function human(n){
    n = parseFloat(n || 0);
    if (n > 1099511627776) return (n / 1099511627776).toFixed(2) + ' TB';
    if (n > 1073741824) return (n / 1073741824).toFixed(1) + ' GB';
    if (n > 1048576) return (n / 1048576).toFixed(1) + ' MB';
    return n + ' B';
  }
  function up(u){ u = parseInt(u || 0); if (!u) return '—';
    var d = Math.floor(u/86400), h = Math.floor(u%86400/3600), m = Math.floor(u%3600/60);
    return (d ? d+'天' : '') + (h ? h+'时' : '') + m + '分'; }

  var g_vms = [];

  // ── PVE API 模式 ──
  function params(){
    return { host: gv('paHost'), api_token: gv('paToken'),
             pve_user: gv('paUser') || 'root@pam', pve_password: gv('paPass') };
  }
  function needAuth(){ if (!gv('paHost')){ if (window.toast) toast('请填写 PVE 主机','warn',2200); return true; }
    if (!gv('paToken') && !gv('paPass')){ if (window.toast) toast('填写 API Token 或密码','warn',2200); return true; }
    return false; }

  async function test(){
    if (needAuth()) return;
    var box = $('paResult'); box.innerHTML = '<span style="color:var(--text3)">⏳ 连接中…</span>';
    var r = await rpc('pve_api_test', params());
    box.innerHTML = '<span style="color:' + (r.status==='ok'?'var(--green)':'var(--red)') + '">' + esc(r.msg||'') + '</span>';
  }

  async function loadCluster(){
    if (needAuth()) return;
    var box = $('paCluster'); box.innerHTML = '<div style="color:var(--text3);font-size:12px">⏳ 拉取集群视图…</div>';
    var r = await rpc('pve_api_cluster', params());
    if (r.status !== 'ok'){ box.innerHTML = '<div style="color:var(--red);font-size:12px">✗ ' + esc(r.msg||'') + '</div>'; return; }
    var h = '<div style="font-size:12px;font-weight:600;margin:6px 0 4px">🖥 节点 (' + (r.nodes||[]).length + ')</div>';
    h += '<table style="width:100%;font-size:11px;border-collapse:collapse"><tr style="color:var(--text3);text-align:left"><th style="padding:3px 6px">节点</th><th>状态</th><th>CPU</th><th>内存</th><th>根盘</th><th>运行时长</th></tr>';
    (r.nodes||[]).forEach(function(n){
      var memPct = n.mem_total ? Math.round(n.mem_used/n.mem_total*100) : 0;
      var dskPct = n.disk_total ? Math.round(n.disk_used/n.disk_total*100) : 0;
      h += '<tr style="border-top:1px solid var(--line)"><td style="padding:3px 6px;color:var(--cyan)">' + esc(n.node) + '</td>' +
        '<td><span style="color:' + (n.status==='online'?'var(--green)':'var(--red)') + '">● ' + esc(n.status) + '</span></td>' +
        '<td>' + (n.cpu_pct||0) + '%</td><td>' + memPct + '% (' + human(n.mem_used) + '/' + human(n.mem_total) + ')</td>' +
        '<td>' + dskPct + '%</td><td>' + up(n.uptime) + '</td></tr>';
    });
    h += '</table>';

    h += '<div style="font-size:12px;font-weight:600;margin:10px 0 4px">📦 VM/CT (' + (r.vms||[]).length + ') <span style="font-weight:400;color:var(--text3)">· 电源/迁移/快照 直接操作</span></div>';
    h += '<table style="width:100%;font-size:11px;border-collapse:collapse"><tr style="color:var(--text3);text-align:left"><th style="padding:3px 6px">VMID</th><th>名称</th><th>类型</th><th>节点</th><th>状态</th><th>操作</th></tr>';
    g_vms = r.vms || [];
    (r.vms||[]).forEach(function(v, i){
      var run = v.status === 'running';
      h += '<tr style="border-top:1px solid var(--line)"><td style="padding:3px 6px;font-family:monospace">' + esc(v.vmid) + '</td>' +
        '<td>' + esc(v.name) + '</td><td>' + (v.type==='lxc'?'CT':'VM') + '</td><td>' + esc(v.node) + '</td>' +
        '<td><span style="color:' + (run?'var(--green)':'var(--text3)') + '">' + (run?'运行':'停止') + '</span></td>' +
        '<td style="white-space:nowrap">' +
        '<button class="btn btn-sm" style="padding:1px 6px;font-size:10px" onclick="PveApi.vmOp(' + i + ',\'start\')">▶</button> ' +
        '<button class="btn btn-sm" style="padding:1px 6px;font-size:10px" onclick="PveApi.vmOp(' + i + ',\'shutdown\')">⏹</button> ' +
        '<button class="btn btn-sm" style="padding:1px 6px;font-size:10px" onclick="PveApi.vmOp(' + i + ',\'reboot\')">↻</button> ' +
        '<button class="btn btn-sm" style="padding:1px 6px;font-size:10px" onclick="PveApi.migrate(' + i + ')">🔀迁移</button> ' +
        '<button class="btn btn-sm" style="padding:1px 6px;font-size:10px" onclick="PveApi.snapshots(' + i + ')">📸快照</button>' +
        '</td></tr>';
    });
    h += '</table>';

    h += '<div style="font-size:12px;font-weight:600;margin:10px 0 4px">💾 存储 (' + (r.storages||[]).length + ')</div>';
    h += '<table style="width:100%;font-size:11px;border-collapse:collapse"><tr style="color:var(--text3);text-align:left"><th style="padding:3px 6px">名称</th><th>类型</th><th>内容</th><th>可用/总量</th></tr>';
    (r.storages||[]).forEach(function(s){
      h += '<tr style="border-top:1px solid var(--line)"><td style="padding:3px 6px;color:var(--cyan)">' + esc(s.storage) + '</td>' +
        '<td>' + esc(s.type) + '</td><td>' + esc(s.content||'') + '</td><td>' + human(s.avail) + ' / ' + human(s.total) + '</td></tr>';
    });
    h += '</table>';
    box.innerHTML = h;
    if (window.toast) toast('✓ 集群视图: ' + (r.nodes||[]).length + ' 节点 / ' + (r.vms||[]).length + ' VM', 'success', 2600);
  }

  async function vmOp(i, op){
    var v = g_vms[i]; if (!v) return;
    if (op === 'stop' || op === 'shutdown'){
      if (!(await rpConfirm({ title:'确认操作', danger:true, okText:'执行', body:'确认 ' + op + ' ' + v.type + '/' + v.vmid + '?' }))) return;
    }
    var r = await rpc('pve_api_vm_op', Object.assign(params(), {node: v.node, vmid: v.vmid, type: v.type, op: op}));
    if (window.toast) toast(r.status==='ok' ? '✓ ' + r.msg : '✗ ' + (r.msg||'失败'), r.status==='ok'?'success':'err', 3000);
  }

  async function migrate(i){
    var v = g_vms[i]; if (!v) return;
    var target = await rpPrompt({ title:'迁移 ' + v.type + '/' + v.vmid + ' (' + v.name + ') 到目标节点', defaultName: v.node });
    if (!target || target === v.node) return;
    var online = v.status === 'running' ? await rpConfirm({ title:'迁移方式', okText:'在线迁移', cancelText:'离线迁移', body:'在线迁移 (不停机)?\n确定 = 在线迁移；取消 = 离线迁移' }) : false;
    var r = await rpc('pve_api_migrate', Object.assign(params(), {node: v.node, vmid: v.vmid, type: v.type, target: target, online: online?1:0}));
    if (window.toast) toast(r.status==='ok' ? '✓ ' + r.msg : '✗ ' + (r.msg||'失败'), r.status==='ok'?'success':'err', 3200);
  }

  async function snapshots(i){
    var v = g_vms[i]; if (!v) return;
    var box = $('paSnapBox'); box.style.display = '';
    box.innerHTML = '<div style="color:var(--text3);font-size:12px">⏳ 加载 ' + esc(v.type) + '/' + esc(v.vmid) + ' 快照…</div>';
    var r = await rpc('pve_api_snapshots', Object.assign(params(), {node: v.node, vmid: v.vmid, type: v.type}));
    if (r.status !== 'ok'){ box.innerHTML = '<div style="color:var(--red);font-size:12px">✗ ' + esc(r.msg||'') + '</div>'; return; }
    window._paSnapTarget = {node: v.node, vmid: v.vmid, type: v.type};
    var h = '<div style="font-size:12px;font-weight:600;margin:4px 0">📸 ' + esc(v.type) + '/' + esc(v.vmid) + ' (' + esc(v.name) + ') 快照</div>';
    h += '<div style="display:flex;gap:6px;align-items:center;margin:4px 0 8px;flex-wrap:wrap">' +
      '<input id="paSnapName" class="input" placeholder="快照名 (如 pre_backup)" style="width:160px;height:26px;font-size:11px">' +
      '<input id="paSnapDesc" class="input" placeholder="描述(可选)" style="width:180px;height:26px;font-size:11px">' +
      (v.type==='qemu' ? '<label style="font-size:11px;color:var(--text2)"><input type="checkbox" id="paSnapRam"> 含内存</label>' : '') +
      '<button class="btn btn-sm btn-primary" style="padding:2px 10px" onclick="PveApi.snapCreate()">➕ 创建快照</button></div>';
    h += '<table style="width:100%;font-size:11px;border-collapse:collapse"><tr style="color:var(--text3);text-align:left"><th style="padding:3px 6px">名称</th><th>时间</th><th>描述</th><th></th></tr>';
    (r.snapshots||[]).forEach(function(s){
      h += '<tr style="border-top:1px solid var(--line)"><td style="padding:3px 6px;font-family:monospace">' + esc(s.name) + '</td>' +
        '<td>' + (s.time ? new Date(s.time*1000).toLocaleString() : '—') + '</td><td>' + esc(s.description||'') + '</td>' +
        '<td><button class="btn btn-sm" style="padding:1px 6px;font-size:10px;color:var(--orange)" onclick="PveApi.snapRollback(\'' + esc(s.name) + '\')">⏪ 回滚</button></td></tr>';
    });
    h += '</table>';
    box.innerHTML = h;
  }

  async function snapCreate(){
    var t = window._paSnapTarget; if (!t) return;
    var name = gv('paSnapName');
    if (!name){ if (window.toast) toast('请填写快照名','warn',2000); return; }
    var r = await rpc('pve_api_snapshot_create', Object.assign(params(), {
      node: t.node, vmid: t.vmid, type: t.type, snapname: name,
      description: gv('paSnapDesc'), include_ram: ($('paSnapRam') && $('paSnapRam').checked) ? 1 : 0 }));
    if (window.toast) toast(r.status==='ok' ? '✓ ' + r.msg : '✗ ' + (r.msg||'失败'), r.status==='ok'?'success':'err', 3200);
  }

  async function snapRollback(name){
    var t = window._paSnapTarget; if (!t) return;
    if (!(await rpConfirm({ title:'回滚快照', danger:true, okText:'回滚', body:'确认回滚到快照 ' + name + '?\n回滚后该时刻之后的数据将丢失!' }))) return;
    var r = await rpc('pve_api_snapshot_rollback', Object.assign(params(), {node: t.node, vmid: t.vmid, type: t.type, snapname: name}));
    if (window.toast) toast(r.status==='ok' ? '✓ ' + r.msg : '✗ ' + (r.msg||'失败'), r.status==='ok'?'success':'err', 3600);
  }

  // ── D2 存储智能识别 (通用一键备份面板内) ──
  async function detectStorage(){
    var path = gv('pbDetectPath');
    if (!path){ if (window.toast) toast('请填写要识别的路径','warn',2000); return; }
    var box = $('pbDetectResult'); box.innerHTML = '<span style="color:var(--text3);font-size:12px">⏳ 探测中…</span>';
    var data = { path: path };
    if (gv('pbHost')) { data.host = gv('pbHost'); data.port = gv('pbPort')||'22'; data.user = gv('pbUser')||'root';
      data.auth_type = $('pbAuthType') ? $('pbAuthType').value : 'pass'; data.password = gv('pbAuthValue'); data.key_path = gv('pbKeyPath'); }
    var r = await rpc('storage_policy_detect', data);
    if (r.status !== 'ok'){ box.innerHTML = '<span style="color:var(--red);font-size:12px">✗ ' + esc(r.msg||'') + '</span>'; return; }
    var kindBadge = {zfs:'🟦', rbd:'🟪', 'lvm-thin':'🟩', lvm:'🟨', btrfs:'🟧', dir:'⬜'}[r.kind] || '⬜';
    box.innerHTML = '<div style="font-size:12px;line-height:1.8;margin-top:6px;padding:8px 10px;background:var(--bg3);border-radius:6px">' +
      kindBadge + ' <b>' + esc(r.kind) + '</b> · 文件系统 <code>' + esc(r.fstype||'?') + '</code> · 设备 <code>' + esc(r.source||'?') + '</code>' +
      (r.zfs_dataset ? ' · 数据集 <code>' + esc(r.zfs_dataset) + '</code>' : '') + '<br>' +
      '→ 推荐: <b style="color:var(--cyan)">' + esc(r.channel) + '</b> · ' + esc(r.reason) + '<br>' +
      '<code style="font-size:10px;color:var(--text3)">' + esc(r.suggest_cmd) + '</code></div>';
  }

  // ── D3 VM 编排流水线模板 (vzdump 面板) ──
  var PIPELINES = [
    { id: 'qemu_snap', name: 'PVE 在线快照保护 (qm snapshot → vzdump → 校验 → 删快照 → 邮件)',
      pre: 'qm snapshot {VMID} rp_pre_backup --vmstate 0',
      post: 'qm delsnapshot {VMID} rp_pre_backup', verify: true, mail: true },
    { id: 'zfs_snap', name: 'ZFS 数据集快照 (zfs snapshot → vzdump → 校验 → 销毁快照 → 邮件)',
      pre: 'zfs snapshot rpool/data@rp_pre_backup',
      post: 'zfs destroy rpool/data@rp_pre_backup', verify: true, mail: true },
    { id: 'lvm_snap', name: 'LVM 快照保护 (lvcreate -s → vzdump → 校验 → lvremove → 邮件)',
      pre: 'lvcreate -s -L 10%FREE -n rp_snap /dev/vg0/data',
      post: 'lvremove -f /dev/vg0/rp_snap', verify: true, mail: true },
    { id: 'mysql_lock', name: 'MySQL 冻结 (FLUSH READ LOCK → vzdump → 校验 → UNLOCK → 邮件)',
      pre: 'mysql -uroot -e "FLUSH TABLES WITH READ LOCK"',
      post: 'mysql -uroot -e "UNLOCK TABLES"', verify: true, mail: true },
    { id: 'pg_backup', name: 'PostgreSQL 热备 (pg_start_backup → vzdump → 校验 → pg_stop_backup → 邮件)',
      pre: 'sudo -u postgres psql -c "SELECT pg_start_backup(\'fonriv\')"',
      post: 'sudo -u postgres psql -c "SELECT pg_stop_backup()"', verify: true, mail: true },
    { id: 'db_freeze_notify', name: '数据库冻结 + Webhook 通知 (锁 → 备份 → 校验 → 解锁 → 通知)',
      pre: 'mysql -uroot -e "FLUSH TABLES WITH READ LOCK"',
      post: 'mysql -uroot -e "UNLOCK TABLES" && curl -s -X POST "$RP_WEBHOOK" -d \'{"event":"backup.finished"}\'', verify: true, mail: false },
  ];
  function applyPipeline(sel){
    var t = PIPELINES[parseInt(sel.value, 10)];
    sel.value = '';
    if (!t) return;
    var pre = $('vdPreHook'), post = $('vdPostHook');
    if (pre) pre.value = t.pre;
    if (post) post.value = t.post;
    if ($('vdVerify')) $('vdVerify').checked = t.verify;
    if ($('vdMailOn')) $('vdMailOn').checked = t.mail;
    if (typeof buildVzdumpCmd === 'function') buildVzdumpCmd();
    if (window.toast) toast('✓ 已套用流水线模板: ' + t.name, 'success', 3000);
  }

  g.PveApi = { test: test, loadCluster: loadCluster, vmOp: vmOp, migrate: migrate,
               snapshots: snapshots, snapCreate: snapCreate, snapRollback: snapRollback };
  g.StoragePolicy = { detect: detectStorage };
  g.VmPipeline = { apply: applyPipeline, list: PIPELINES };
  document.addEventListener('DOMContentLoaded', function(){
    var sel = document.querySelector('select[onchange="VmPipeline.apply(this)"]');
    if (sel){
      PIPELINES.forEach(function(t, i){
        var o = document.createElement('option');
        o.value = String(i); o.textContent = t.name;
        sel.appendChild(o);
      });
    }
  });
})(window);
