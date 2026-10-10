/* 定时计划面板
 * 依赖: window.send / window.toast* / window.NAV
 * 元素约定 (index.html):
 *   #schedListBox / #schedForm 表单字段 (schName, schCron, schAction, schParamsJson, schEnabled)
 *   #schStatus, #schSaveBtn (新增/更新切换)
 *   #schCronPreview 显示下一次执行时间预览
 */
(function(){
  'use strict';

  var Sched = {
    _editingId: null,
    _formSnapshot: '',  // dirty guard
    _list: [],
  };

  function _q(id){ return document.getElementById(id); }
  function _esc(s){ if(s==null) return ''; return String(s).replace(/[&<>"']/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
  }); }

  // 脏检查契约
  function _snapshotForm(){
    try {
      return JSON.stringify({
        name: _q('schName') ? _q('schName').value : '',
        cron: _q('schCron') ? _q('schCron').value : '',
        action: _q('schAction') ? _q('schAction').value : '',
        params: _q('schParamsJson') ? _q('schParamsJson').value : '',
        enabled: _q('schEnabled') ? _q('schEnabled').checked : false,
      });
    } catch(e){ return ''; }
  }
  Sched.isDirty = function(){
    if (!Sched._editingId) return false;
    return Sched._formSnapshot && _snapshotForm() !== Sched._formSnapshot;
  };
  Sched.cancelEdit = async function(){
    if (Sched.isDirty()){
      if (!(await rpConfirm({ title:'放弃当前修改？', danger:true, okText:'放弃' }))) return;
    }
    Sched.reset();
  };

  var ACTION_LABELS = {
    'noop':                        '🧪 noop (占位测试)',
    'pve_backup_scheduled':        '🖥 PVE 备份 (vzdump remote)',
    'vzdump_scheduled':            '📦 vzdump 打包',
    'platform_backup_scheduled':   '🐧 通用一键备份',
    'rsync_scheduled':             '🔄 rsync 传输',
    'remote_upload_scheduled':     '☁ 定时云上传',
    'flow_scheduled':              '🔗 跨模块流程',
    'dbbackup_scheduled':          '🗄 数据库热备份',
  };

  var PRESET_CRONS = [
    { expr: '*/5 * * * *',  label: '每 5 分钟' },
    { expr: '0 * * * *',    label: '每小时' },
    { expr: '0 3 * * *',    label: '每天 03:00' },
    { expr: '0 3 * * 0',    label: '每周日 03:00' },
    { expr: '0 3 1 * *',    label: '每月 1 号 03:00' },
  ];

  Sched.refresh = function(){
    send({ action: 'schedule_list' }, function(d){
      if(!d || d.status !== 'ok'){
        _q('schListBox').innerHTML = '<div style="color:var(--red);font-size:12px">加载失败: '+ _esc(d && d.msg || '?') +'</div>';
        return;
      }
      Sched._list = d.schedules || [];
      Sched._render();
      // v4.10.0: 列表更新同时刷时间轴
      Sched.timelineRefresh();
    });
  };

  Sched._render = function(){
    var box = _q('schListBox');
    if(!box) return;
    if(!Sched._list.length){
      box.innerHTML = '<div style="color:var(--text3);font-size:12px;padding:14px">'
        + '暂无定时任务。'
        + '<button class="btn btn-sm btn-primary" style="margin-left:8px" onclick="Sched.newTask()">＋ 新建任务</button>'
        + '</div>'
        // 最近 30 条运行</div>'
        +     '<button class="btn btn-sm" style="margin-left:auto" onclick="Sched.refreshEmptyLog()">🔄 刷新</button>'
        +   '</div>'
        +   '<div id="schEmptyLog" style="max-height:260px;overflow:auto;font-family:monospace;font-size:11px;background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:8px 10px">'
        +     '<div style="color:var(--text3)">加载中…</div>'
        +   '</div>'
        + '</div>';
      Sched.refreshEmptyLog();
      return;
    }
    var rows = Sched._list.map(function(s){
      var actionLabel = ACTION_LABELS[s.action] || s.action;
      var statusPill = '';
      if(s.last_status === 'ok'){
        statusPill = '<span style="color:var(--green);font-size:11px">● ok</span>';
      } else if(s.last_status === 'error'){
        statusPill = '<span style="color:var(--red);font-size:11px" title="'+ _esc(s.last_msg||'') +'">● error</span>';
      } else {
        statusPill = '<span style="color:var(--text3);font-size:11px">● 未运行</span>';
      }
      var enabled = s.enabled ? '<span style="color:var(--green)">✓ 启用</span>'
                              : '<span style="color:var(--text3)">✗ 禁用</span>';
      return '<tr>'
        + '<td>#'+ s.id +'</td>'
        + '<td><b>'+ _esc(s.name) +'</b><div style="font-size:11px;color:var(--text3)">'+ _esc(actionLabel) +'</div></td>'
        + '<td><code style="font-size:11px">'+ _esc(s.cron_expr) +'</code>'
          + ((s.times && s.times.length)
             ? '<div style="font-size:10px;color:var(--cyan);margin-top:2px">⏱ 多时间段 ×'+ (s.times.length + 1) +': '+ s.times.map(_esc).join(' / ') +'</div>'
             : '') +'</td>'
        + '<td style="font-size:11px">'+ _esc(s.next_run || '-') +'</td>'
        + '<td style="font-size:11px">'+ _esc(s.last_run || '-') +' '+ statusPill +'</td>'
        + '<td>'+ enabled +'</td>'
        + '<td>'
          + '<button class="btn btn-sm" onclick="Sched.runNow('+ s.id +')" title="立即执行一次">▶</button> '
          + '<button class="btn btn-sm" onclick="Sched.showRuns('+ s.id +')" title="运行历史">📜</button> '
          + '<button class="btn btn-sm" onclick="Sched.edit('+ s.id +')">✏️</button> '
          + '<button class="btn btn-sm" onclick="Sched.toggle('+ s.id +','+ (s.enabled?0:1) +')">'
            + (s.enabled ? '⏸ 停' : '▶ 启') +'</button> '
          + '<button class="btn btn-sm" style="color:var(--red)" onclick="Sched.remove('+ s.id +')">🗑</button>'
        + '</td>'
        + '</tr>';
    }).join('');
    box.innerHTML =
      '<table class="user-table" style="width:100%">'
      + '<thead><tr><th>ID</th><th>名称 / Action</th><th>Cron</th><th>下次运行</th><th>上次运行 / 状态</th><th>状态</th><th>操作</th></tr></thead>'
      + '<tbody>'+ rows +'</tbody>'
      + '</table>';
  };

  // type: text|number|select|multiselect|textarea
  var PARAM_SCHEMAS = {
    'noop': [
      { key: 'greet', label: '问候语 (可选)', type: 'text', placeholder: 'hello' },
    ],
    'pve_backup_scheduled': [
      { key: 'config_id', label: '服务器配置 (推荐 · 自动填充连接)', type: 'config_select',
        hint: '选择已保存的配置后自动使用其主机/端口/凭据，下方手填项可留空' },
      { key: 'host',      label: 'PVE 主机 (未选配置时手填)', type: 'text', placeholder: '192.168.x.x' },
      { key: 'port',      label: 'SSH 端口', type: 'text', placeholder: '22', default: '22' },
      { key: 'user',      label: 'SSH 用户', type: 'text', placeholder: 'root',  default: 'root' },
      { key: 'auth_type', label: '认证方式', type: 'select', options: ['pass','key'], default: 'pass' },
      { key: 'password',  label: '密码 (ENC:base64)', type: 'text', placeholder: 'ENC:...' },
      { key: 'vm_ids',    label: 'VM IDs', type: 'text', placeholder: '100,101' },
      { key: 'storage',   label: 'PBS/存储', type: 'text', default: 'local' },
      { key: 'mode',      label: '模式', type: 'select', options: ['snapshot','suspend','stop'], default: 'snapshot' },
      { key: 'compress',  label: '压缩', type: 'select', options: ['zstd','gzip','lzo','none'], default: 'zstd' },
    ],
    'vzdump_scheduled': [
      { key: 'config_id', label: '服务器配置 (推荐 · 自动填充连接)', type: 'config_select',
        hint: '选择已保存的配置后自动使用其主机/端口/凭据，下方手填项可留空' },
      { key: 'host',      label: '主机 (未选配置时手填)', type: 'text' },
      { key: 'port',      label: 'SSH 端口', type: 'text', default: '22' },
      { key: 'user',      label: 'SSH 用户', type: 'text', default: 'root' },
      { key: 'auth_type', label: '认证方式', type: 'select', options: ['pass','key'], default: 'pass' },
      { key: 'password',  label: '密码 (ENC:base64)', type: 'text', placeholder: 'ENC:...' },
      { key: 'vm_ids',    label: 'VM IDs', type: 'text', placeholder: '100,101' },
      { key: 'mode',      label: '模式', type: 'select', options: ['snapshot','suspend','stop'], default: 'snapshot' },
      { key: 'compress',  label: '压缩', type: 'select', options: ['zstd','gzip','lzo','none'], default: 'zstd' },
      { key: 'local_dir', label: '落盘目录 (本机/挂载点/网络共享)', type: 'share_dir_select', default: '/mnt/backup',
        hint: '可直接手填；或从下拉选「网络共享」挂载点自动填入路径前缀' },
    ],
    'platform_backup_scheduled': [
      { key: 'config_id',     label: '配置 (SSH 凭据)', type: 'config_select', required: true,
        hint: '从"配置列表"里选一条，用来登录目标主机' },
      { key: 'platform',      label: '平台', type: 'select', options: ['auto','omv','proxmox','pbs','debian','ubuntu'], default: 'auto',
        hint: 'auto=自动探测' },
      { key: 'selected_keys', label: '备份项', type: 'multiselect',
        options: ['/etc','/root','/home','/var/log','/var/spool/cron','/var/lib/omv','/etc/pve'],
        default: ['/etc','/root'],
        hint: '常见项复选 · 也可手写添加' },
      { key: 'compressor',    label: '压缩', type: 'select', options: ['zstd','gzip','xz','none'], default: 'zstd' },
      { key: 'local_dir',     label: '落盘目录 (本机/挂载点/网络共享)', type: 'share_dir_select', default: '/mnt/backup', required: true },
      { key: 'label',         label: '标签 (可选)', type: 'text', placeholder: '夜间快照' },
    ],
    'rsync_scheduled': [
      { key: 'source',      label: '源路径', type: 'text', required: true,
        placeholder: 'user@host:/path/  或  /local/path/',
        hint: '本地路径或 rsync/ssh 远端；结尾加 / 表示同步目录内容' },
      { key: 'target',      label: '目标路径', type: 'text', required: true,
        placeholder: 'user@host:/path/  或  /local/path/' },
      { key: 'config_id',   label: '配置 (可选)', type: 'config_select',
        hint: '从配置列表补齐 SSH 密码；也可以直接填 password' },
      { key: 'password',    label: 'SSH 密码 (可选)', type: 'text', placeholder: '若源/目标是 ssh 且未选 config_id' },
      { key: 'extra_flags', label: 'rsync 参数', type: 'text', default: '-avz --progress',
        hint: '常用：-avz --progress --delete' },
    ],
    // 数据库热备定时 (MySQL/PG 不停机)
    'dbbackup_scheduled': [
      { key: 'db_type',   label: '数据库类型', type: 'select', options: ['mysql','postgres'], default: 'mysql' },
      { key: 'host',      label: 'SSH 目标机 (空=本机)', type: 'config_select',
        hint: '选择已保存的配置即在该机器上执行备份；不选 = 在本机执行' },
      { key: 'db_host',   label: '数据库地址', type: 'text', default: '127.0.0.1' },
      { key: 'db_port',   label: '数据库端口', type: 'text', default: '' , placeholder: '3306 / 5432' },
      { key: 'db_user',   label: '数据库用户', type: 'text', default: 'root', placeholder: 'root / postgres' },
      { key: 'db_password', label: '数据库密码', type: 'text' },
      { key: 'databases', label: '库名 (逗号分隔, * = 全部)', type: 'text', default: '*' },
      { key: 'dest_dir',  label: '备份目标目录 (本机/挂载点/网络共享)', type: 'share_dir_select', default: '/opt/backups/db', required: true },
      { key: 'compress',  label: 'gzip 压缩 (MySQL)', type: 'select', options: ['1','0'], default: '1' },
      { key: 'keep_days', label: '保留天数 (0 = 永久)', type: 'number', default: 14 },
    ],
    'remote_upload_scheduled': [
      { key: 'remote_id',  label: '远端存储', type: 'remote_select', required: true,
        hint: '从"远端存储"页新建；到点自动上传到该存储' },
      { key: 'local_path', label: '本地路径', type: 'text', required: true,
        placeholder: '/mnt/backup/app.tar.zst 或 /mnt/backup/dir/',
        hint: '文件或目录；目录 + mode=dir 会递归上传' },
      { key: 'remote_dir', label: '远端目录 (可选)', type: 'text',
        placeholder: 'scheduled/backup', hint: '默认传到存储根目录' },
      { key: 'mode',       label: '模式', type: 'select', options: ['file','dir'], default: 'file',
        hint: 'dir: 递归逐文件上传目录' },
    ],
    'flow_scheduled': [
      { key: 'flow_id',     label: '流程 ID', type: 'flow_select', required: true,
        hint: '从"跨模块流程"页面新建；调度时会以 scheduled 触发（走 auto/YYYY-MM-DD 目录）' },
    ],
  };

  // 配置列表缓存 (config_id 下拉用)
  Sched._configs = null;
  Sched._loadConfigs = function(cb){
    if(Sched._configs){ cb && cb(Sched._configs); return; }
    window.SP.serverRows().then(function(r){
      Sched._configs = (r && r.configs) || [];
      cb && cb(Sched._configs);
    });
  };

  // 流程列表缓存 (flow_id 下拉用)
  Sched._flows = null;
  Sched._loadFlows = function(cb){
    if(Sched._flows){ cb && cb(Sched._flows); return; }
    send({ action: 'flow_list' }, function(r){
      Sched._flows = (r && r.flows) || [];
      cb && cb(Sched._flows);
    });
  };

  // 附带多时间段表达式数组 (可视化构建器产出)
  Sched._times = [];   // ['0 3 * * *', '30 9 * * *', ...] 空数组 = 仅用单表达式
  Sched._readForm = function(){
    return {
      name: (_q('schName').value || '').trim(),
      cron_expr: (_q('schCron').value || '').trim() || '* * * * *',
      times: Sched._times.slice(),
      action_type: (_q('schAction').value || '').trim(),
      params: Sched._readWizard(),
      enabled: _q('schEnabled').checked,
    };
  };

  Sched._fillForm = function(s){
    _q('schName').value = s.name || '';
    _q('schCron').value = s.cron_expr || '';
    Sched._times = (s.times && s.times.length) ? s.times.slice() : [];
    Sched._renderTimesBar();
    _q('schAction').value = s.action || 'noop';
    // 先写 JSON 再刷 wizard，保持一致
    _q('schParamsJson').value = JSON.stringify(s.params || {}, null, 2);
    Sched._renderWizard(s.action || 'noop', s.params || {});
    _q('schEnabled').checked = !!s.enabled;
  };

  Sched.reset = function(){
    Sched._editingId = null;
    Sched._formSnapshot = '';
    _q('schName').value = '';
    _q('schCron').value = '';
    Sched._times = [];              // v4.47.0 P2
    Sched._renderTimesBar();
    _q('schAction').value = 'platform_backup_scheduled';
    _q('schParamsJson').value = '';
    _q('schEnabled').checked = true;
    _q('schSaveBtn').textContent = '💾 新增';
    _q('schStatus').textContent = '';
    // v4.8.0: 初始化 wizard 到默认值
    Sched.templateFor('platform_backup_scheduled');
    Sched.cronPreview();
  };

  // 空态新建按钮：reset + 滚到表单 + 聚焦
  Sched.newTask = function(){
    Sched.reset();
    var form = _q('schForm');
    if (form) form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setTimeout(function(){
      var nm = _q('schName'); if (nm) nm.focus();
    }, 300);
  };

  // 空态调度日志：全局最近 30 条运行历史
  Sched.refreshEmptyLog = function(){
    send({ action: 'schedule_runs', id: 0, limit: 30 }, function(r){
      var box = _q('schEmptyLog');
      if(!box) return;
      var runs = (r && r.status === 'ok') ? (r.runs || []) : [];
      if(!runs.length){
        box.innerHTML = '<div style="color:var(--text3)">调度器还没有任何运行记录。创建一个任务并等它触发，或点『▶ 立即执行』试试。</div>';
        return;
      }
      var lines = runs.map(function(x){
        var color = x.status === 'ok' ? 'var(--green,#27ae60)' :
                    x.status === 'error' ? 'var(--red,#e74c3c)' :
                    x.status === 'running' ? 'var(--accent,#3498db)' : 'var(--text2)';
        var name = _esc(x.sched_name || ('#'+x.schedule_id));
        var act = _esc(x.action || '');
        var start = _esc(x.started_at || '-');
        var dur = x.duration_ms ? (' · '+Math.round(x.duration_ms/1000)+'s') : '';
        var trig = x.trigger ? (' · '+ _esc(x.trigger)) : '';
        var msg = x.msg ? (' · '+ _esc((x.msg||'').slice(0,120))) : '';
        return '<div style="border-bottom:1px dashed var(--border);padding:3px 0">'
             + '<span style="color:'+color+';font-weight:600">● '+ _esc(x.status||'?') +'</span> '
             + '<span style="color:var(--text3)">'+ start +'</span> · <b>'+ name +'</b>'
             + ' <span style="color:var(--text3)">('+ act +')</span>' + trig + dur + msg
             + '</div>';
      }).join('');
      box.innerHTML = lines;
    });
  };

  Sched.save = function(){
    var d;
    try { d = Sched._readForm(); }
    catch(e){ _q('schStatus').innerHTML = '<span style="color:var(--red)">'+ _esc(e.message) +'</span>'; return; }
    if(!d.name || !d.cron_expr){
      _q('schStatus').innerHTML = '<span style="color:var(--red)">名称和 cron 必填</span>';
      return;
    }
    var payload = { action: (Sched._editingId ? 'schedule_update' : 'schedule_create'),
                    name: d.name, cron_expr: d.cron_expr,
                    action_type: d.action_type, params: d.params };
    if(d.times.length) payload.times = d.times;   // 多时间段
    // enabled 只有 update 才发（create 默认 enabled=true 后端已处理）
    if(Sched._editingId){
      payload.id = Sched._editingId;
      payload.enabled = d.enabled;
    }
    send(payload, function(r){
      if(r && r.status === 'ok'){
        toastOk(r.msg || '已保存');
        Sched.reset();
        Sched.refresh();
      } else {
        toastErr((r && r.msg) || '保存失败');
      }
    });
  };

  Sched.edit = function(id){
    var s = Sched._list.find(function(x){ return x.id === id; });
    if(!s) return;
    Sched._editingId = id;
    Sched._fillForm(s);
    _q('schSaveBtn').textContent = '💾 更新 #'+ id;
    _q('schStatus').textContent = '编辑中: #' + id;
    Sched.cronPreview();
    Sched._formSnapshot = _snapshotForm();  // 建立基准
    window.scrollTo({ top: _q('schForm').offsetTop, behavior: 'smooth' });
  };

  Sched.toggle = function(id, enabled){
    send({ action: 'schedule_update', id: id, enabled: !!enabled }, function(r){
      if(r && r.status === 'ok'){ toastOk(enabled ? '已启用' : '已禁用'); Sched.refresh(); }
      else toastErr((r&&r.msg)||'失败');
    });
  };

  Sched.remove = async function(id){
    if(!(await rpConfirm({ title:'删除定时任务 #' + id, danger:true, okText:'删除', body:'确定删除定时任务 #' + id + ' ?' }))) return;
    send({ action: 'schedule_delete', id: id }, function(r){
      if(r && r.status === 'ok'){ toastOk('已删除'); Sched.refresh(); }
      else toastErr((r&&r.msg)||'失败');
    });
  };

  Sched.runNow = async function(id){
    if(!(await rpConfirm({ title:'立即执行任务 #' + id + ' ?', okText:'立即执行' }))) return;
    _q('schStatus').innerHTML = '<span style="color:var(--text3)">派发中... #'+ id +'</span>';
    send({ action: 'schedule_run_now', id: id }, function(r){
      if(r && r.status === 'ok'){
        toastOk('执行完成 · ' + (r.msg||'ok'));
        _q('schStatus').innerHTML = '<span style="color:var(--green)">✓ #'+ id +' run · '+ _esc(r.msg||'ok') +'</span>';
        setTimeout(Sched.refresh, 500);
      } else {
        toastErr((r&&r.msg)||'执行失败');
        _q('schStatus').innerHTML = '<span style="color:var(--red)">✗ '+ _esc((r&&r.msg)||'执行失败') +'</span>';
      }
    });
  };

  // v4.6.0: 运行历史抽屉
  Sched.showRuns = function(id){
    var s = Sched._list.find(function(x){ return x.id === id; }) || { name: '#'+id };
    var box = _q('schRunsBox');
    var wrap = _q('schRunsWrap');
    if(!box || !wrap) return;
    wrap.style.display = 'block';
    _q('schRunsTitle').textContent = '📜 运行历史 · #'+ id +' · '+ s.name;
    box.innerHTML = rpState({ state: 'loading', msg: '加载中...' });
    send({ action: 'schedule_runs', id: id, limit: 50 }, function(r){
      if(!r || r.status !== 'ok'){
        box.innerHTML = '<div style="color:var(--red);font-size:12px">加载失败: '+ _esc((r&&r.msg)||'?') +'</div>';
        return;
      }
      var runs = r.runs || [];
      if(!runs.length){
        box.innerHTML = rpState({ state: 'empty', msg: '暂无运行记录。' });
        return;
      }
      var rows = runs.map(function(run){
        var st = run.status;
        var pill = st === 'ok'
          ? '<span style="color:var(--green)">● ok</span>'
          : (st === 'error' ? '<span style="color:var(--red)">● error</span>'
                            : '<span style="color:var(--text3)">● '+ _esc(st) +'</span>');
        var trig = run.trigger === 'manual'
          ? '<span style="color:var(--cyan)">▶ 手动</span>'
          : '<span style="color:var(--text3)">⏰ cron</span>';
        var dur = (run.duration_ms == null) ? '-' : (run.duration_ms + ' ms');
        return '<tr>'
          + '<td>#'+ run.id +'</td>'
          + '<td style="font-size:11px">'+ _esc(run.started_at||'-') +'</td>'
          + '<td style="font-size:11px">'+ _esc(run.ended_at||'-') +'</td>'
          + '<td>'+ dur +'</td>'
          + '<td>'+ trig +'</td>'
          + '<td>'+ pill +'</td>'
          + '<td style="font-size:11px;font-family:monospace;max-width:400px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+ _esc(run.msg||'') +'">'+ _esc(run.msg||'') +'</td>'
          + '</tr>';
      }).join('');
      box.innerHTML =
        '<table class="user-table" style="width:100%">'
        + '<thead><tr><th>Run</th><th>开始</th><th>结束</th><th>耗时</th><th>触发</th><th>状态</th><th>msg</th></tr></thead>'
        + '<tbody>'+ rows +'</tbody>'
        + '</table>';
    });
  };

  Sched.hideRuns = function(){
    var wrap = _q('schRunsWrap');
    if(wrap) wrap.style.display = 'none';
  };

  // ============= v4.10.0: 24h 时间轴 =============
  Sched._tlData = null;
  Sched._tlAutoTimer = null;
  Sched._tlHoverIdx = null;

  Sched.timelineRefresh = function(){
    var hours = parseInt((_q('schTlHoursSel')||{}).value || '12', 10);
    _q('schTlHours').textContent = hours;
    send({ action: 'schedule_timeline', window_hours: hours, future_max: 40 }, function(r){
      if(!r || r.status !== 'ok') return;
      Sched._tlData = r;
      Sched._tlDraw();
    });
  };

  Sched.timelineAutoToggle = function(){
    var on = _q('schTlAuto').checked;
    if(Sched._tlAutoTimer){ clearInterval(Sched._tlAutoTimer); Sched._tlAutoTimer = null; }
    if(on){
      Sched._tlAutoTimer = setInterval(function(){
        // 只在计划面板可见时刷新
        var panel = _q('panel-schedules');
        if(panel && panel.classList.contains('active')) Sched.timelineRefresh();
      }, 30000);
    }
  };

  Sched._tlParseTime = function(s){
    // "YYYY-MM-DD HH:MM:SS" → epoch ms
    if(!s) return null;
    var m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
    if(!m) return null;
    return new Date(+m[1], +m[2]-1, +m[3], +m[4], +m[5], +m[6]).getTime();
  };

  Sched._tlDraw = function(){
    var canvas = _q('schTimelineCanvas');
    var d = Sched._tlData;
    if(!canvas || !d) return;

    var ROW_H = 34;
    var HEADER_H = 28;
    var PAD_L = 140;
    var PAD_R = 20;
    var rows = d.schedules || [];
    if(!rows.length){
      // v6.16.11 · FIX(用户实测: 时间轴空态大字不美观): 旧实现只设 canvas.width=800 缓冲,
      //   而 CSS 是 width:100%;height:auto → 缓冲被拉伸到容器宽(实测可达 1.9x),
      //   12px 文案被放大到 ~22px。这里与有数据分支同口径: 按容器宽 + DPR 精确设
      //   style/缓冲, 文字始终按真实 12px 渲染。
      var _cw = (canvas.parentNode && canvas.parentNode.clientWidth) || 800;
      var _dpr0 = window.devicePixelRatio || 1;
      canvas.style.width = _cw + 'px';
      canvas.style.height = '60px';
      canvas.width = Math.round(_cw * _dpr0);
      canvas.height = Math.round(60 * _dpr0);
      var g = canvas.getContext('2d');
      g.setTransform(_dpr0, 0, 0, _dpr0, 0, 0);
      var _p0 = (window.rpChart && rpChart.pal) ? rpChart.pal() : null;
      g.fillStyle = _p0 ? _p0.text : (getComputedStyle(document.body).getPropertyValue('--text3') || '#888');
      g.font = _p0 ? _p0.font : '12px sans-serif';
      g.fillText('暂无定时任务 · 到下方表单新增一条', 20, 32);
      return;
    }

    // 尺寸
    var css_w = canvas.parentNode.clientWidth || 800;
    var css_h = HEADER_H + rows.length * ROW_H + 10;
    canvas.style.width = css_w + 'px';
    canvas.style.height = css_h + 'px';
    /* v6.3.16 · 统一底座(清屏/DPR/调色板)。**注意本图是甘特式时间线**: 纵轴是时间刻度、
       网格是**竖线**, 因此只取 rpChart 的 clear/pal, **不套 axes()**(那套横向网格+Y 刻度属于
       x/y 柱线图; 强行套用会把图改错)。*/
    var _rc = window.rpChart ? rpChart.clear(canvas) : null;
    var dpr = window.devicePixelRatio || 1;
    var ctx = _rc ? _rc.ctx : canvas.getContext('2d');
    if (!_rc) {
      canvas.width = css_w * dpr; canvas.height = css_h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, css_w, css_h);
    }

    var startMs = Sched._tlParseTime(d.window.start);
    var endMs   = Sched._tlParseTime(d.window.end);
    var nowMs   = Sched._tlParseTime(d.window.now);
    var span    = endMs - startMs;
    var plotL   = PAD_L;
    var plotR   = css_w - PAD_R;
    var plotW   = plotR - plotL;

    function xFor(ms){
      var t = Math.max(startMs, Math.min(endMs, ms));
      return plotL + (t - startMs) / span * plotW;
    }

    /* v6.3.16 · 配色统一走 rpChart.pal()(与其他图表同一套 `--chart-*` 变量);
       原先网格用 `--bg3`、青/黄为写死色值 → 四主题下与其他图不一致 */
    var cssVar = function(n, fb){
      var v = getComputedStyle(document.body).getPropertyValue(n);
      return (v && v.trim()) || fb;
    };
    var _pal = (window.rpChart && rpChart.pal) ? rpChart.pal() : null;
    var C_TEXT  = _pal ? _pal.text : cssVar('--text2', '#ccc');
    var C_TEXT3 = _pal ? _pal.text : cssVar('--text3', '#888');
    var C_GRID  = _pal ? _pal.grid : cssVar('--bg3', '#333');
    var C_GREEN = _pal ? _pal.c2   : cssVar('--green', '#2ecc71');
    var C_RED   = _pal ? _pal.c3   : cssVar('--red', '#e74c3c');
    var C_CYAN  = _pal ? _pal.c4   : cssVar('--cyan', '#3498db');
    var C_YEL   = _pal ? _pal.c1   : '#f1c40f';   // "现在"线: 走主题色而非写死黄

    // 头部：时间刻度 (每 2h 一格 · 40h 以上改 4h)
    var stepHrs = d.window.hours >= 24 ? 4 : 2;
    ctx.strokeStyle = C_GRID;
    ctx.fillStyle = C_TEXT3;
    ctx.font = '11px monospace';
    ctx.lineWidth = 1;
    // 取整到 stepHrs
    var stepMs = stepHrs * 3600 * 1000;
    var t0 = Math.ceil(startMs / stepMs) * stepMs;
    for(var t = t0; t <= endMs; t += stepMs){
      var x = xFor(t);
      ctx.beginPath();
      ctx.moveTo(x, HEADER_H - 4);
      ctx.lineTo(x, css_h - 4);
      ctx.stroke();
      var dt = new Date(t);
      var lbl = ('0'+dt.getHours()).slice(-2) + ':' + ('0'+dt.getMinutes()).slice(-2);
      ctx.fillText(lbl, x + 2, HEADER_H - 8);
    }

    // 现在线
    var nowX = xFor(nowMs);
    ctx.strokeStyle = C_YEL;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(nowX, HEADER_H - 4);
    ctx.lineTo(nowX, css_h - 4);
    ctx.stroke();
    ctx.fillStyle = C_YEL;
    ctx.fillText('现在', nowX + 4, HEADER_H - 12);

    // 每行
    rows.forEach(function(s, i){
      var y = HEADER_H + i * ROW_H + ROW_H / 2;
      // 名字
      ctx.fillStyle = s.enabled ? C_TEXT : C_TEXT3;
      ctx.font = 'bold 12px sans-serif';
      var nm = '#' + s.id + ' ' + (s.name || '');
      if(nm.length > 18) nm = nm.slice(0, 17) + '…';
      ctx.fillText(nm, 6, y + 4);
      ctx.font = '10px monospace';
      ctx.fillStyle = C_TEXT3;
      ctx.fillText((s.cron_expr || ''), 6, y + 16);

      // 行分隔
      ctx.strokeStyle = C_GRID;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(plotL, y + ROW_H/2 - 2);
      ctx.lineTo(plotR, y + ROW_H/2 - 2);
      ctx.stroke();

      // past runs · 圆点
      (s.past || []).forEach(function(p){
        var ms = Sched._tlParseTime(p.started_at); if(!ms) return;
        var x = xFor(ms);
        ctx.fillStyle = (p.status === 'ok') ? C_GREEN : (p.status === 'error' ? C_RED : C_TEXT3);
        ctx.beginPath();
        ctx.arc(x, y, 5, 0, Math.PI * 2);
        ctx.fill();
        // duration bar
        if(p.duration_ms && p.duration_ms > 100){
          var barW = Math.max(2, Math.min(30, (p.duration_ms / (3600 * 1000)) * plotW));
          ctx.fillStyle = ctx.fillStyle; // same color
          ctx.globalAlpha = 0.3;
          ctx.fillRect(x, y - 2, barW, 4);
          ctx.globalAlpha = 1;
        }
      });

      // future · 蓝 ×
      (s.future || []).forEach(function(ts){
        var ms = Sched._tlParseTime(ts); if(!ms) return;
        var x = xFor(ms);
        ctx.strokeStyle = C_CYAN;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x-3, y-3); ctx.lineTo(x+3, y+3);
        ctx.moveTo(x+3, y-3); ctx.lineTo(x-3, y+3);
        ctx.stroke();
      });
    });

    // 存储命中检测数据
    canvas._tlHit = { rows: rows, xFor: xFor, HEADER_H: HEADER_H, ROW_H: ROW_H, plotL: plotL, plotR: plotR };
    canvas.onmousemove = Sched._tlHover;
    canvas.onmouseleave = function(){ Sched._tlTip(null); };
  };

  Sched._tlHover = function(ev){
    var canvas = ev.currentTarget;
    var hit = canvas._tlHit;
    if(!hit) return;
    var rect = canvas.getBoundingClientRect();
    var x = ev.clientX - rect.left;
    var y = ev.clientY - rect.top;
    if(y < hit.HEADER_H || x < hit.plotL || x > hit.plotR){ Sched._tlTip(null); return; }
    var rowIdx = Math.floor((y - hit.HEADER_H) / hit.ROW_H);
    if(rowIdx < 0 || rowIdx >= hit.rows.length){ Sched._tlTip(null); return; }
    var s = hit.rows[rowIdx];
    // 找最近的 past/future
    var best = null; var bestDx = 12;
    (s.past || []).forEach(function(p){
      var ms = Sched._tlParseTime(p.started_at); if(!ms) return;
      var dx = Math.abs(hit.xFor(ms) - x);
      if(dx < bestDx){ bestDx = dx; best = { kind: 'past', s: s, p: p }; }
    });
    (s.future || []).forEach(function(ts){
      var ms = Sched._tlParseTime(ts); if(!ms) return;
      var dx = Math.abs(hit.xFor(ms) - x);
      if(dx < bestDx){ bestDx = dx; best = { kind: 'future', s: s, ts: ts }; }
    });
    if(best) Sched._tlTip(best);
    else Sched._tlTip({ kind: 'row', s: s });
  };

  Sched._tlTip = function(info){
    var el = _q('schTlTip');
    if(!el) return;
    if(!info){
      el.textContent = '绿点=成功 · 红点=失败 · 蓝×=未来触发 · 黄线=现在';
      return;
    }
    if(info.kind === 'past'){
      var p = info.p;
      el.innerHTML = '<b>#' + info.s.id + ' ' + _esc(info.s.name) + '</b> · '
        + _esc(p.started_at) + ' → ' + _esc(p.ended_at || '?')
        + ' · <span style="color:' + (p.status === 'ok' ? 'var(--green)' : 'var(--red)') + '">'
        + _esc(p.status) + '</span> · ' + (p.duration_ms || 0) + 'ms · '
        + _esc(p.trigger || '?') + ' · ' + _esc(p.msg || '');
    } else if(info.kind === 'future'){
      el.innerHTML = '<b>#' + info.s.id + ' ' + _esc(info.s.name) + '</b> · '
        + '<span style="color:var(--cyan)">下次触发 → ' + _esc(info.ts) + '</span>';
    } else {
      el.innerHTML = '<b>#' + info.s.id + ' ' + _esc(info.s.name) + '</b> · '
        + '<code>' + _esc(info.s.cron_expr) + '</code> · '
        + (info.s.enabled ? '<span style="color:var(--green)">启用</span>'
                          : '<span style="color:var(--text3)">禁用</span>');
    }
  };

  // cron 表达式本地简单预览（只做字面校验；真实 next_run 后端算）
  Sched.cronPreview = function(){
    var expr = (_q('schCron').value || '').trim();
    var box = _q('schCronPreview');
    if(!box) return;
    if(!expr && !Sched._times.length){ box.textContent = ''; return; }
    // 预览走后端 croniter: 校验 + 未来 5 次 (含多时间段并集)
    var payload = { action: 'schedule_cron_preview', count: 5 };
    if (Sched._times.length) payload.times = Sched._times.slice();
    else payload.expr = expr;
    send(payload, function(r){
      if(!r || r.status !== 'ok'){
        box.innerHTML = '<span style="color:var(--red)">⚠ 预览失败: '+ _esc((r&&r.msg)||'?') +'</span>';
        return;
      }
      if(!r.valid){
        var bad = (r.invalid||[]).map(function(x){ return '<code>'+_esc(x)+'</code>'; }).join('、');
        box.innerHTML = '<span style="color:var(--red)">⚠ 无效表达式: '+ bad +' (5 段 m h dom mon dow)</span>';
        return;
      }
      var lines = (r.next||[]).map(function(t){ return '<div>▸ '+ _esc(t) +'</div>'; }).join('');
      var multi = Sched._times.length ? ' <span style="color:var(--cyan)">· '+ Sched._times.length +' 个时间段并集</span>' : '';
      box.innerHTML = '<span style="color:var(--green)">✓ 表达式有效'+ multi +' · 未来 5 次运行:</span>'
        + '<div style="margin-top:2px;font-family:monospace">'+ lines +'</div>';
    });
  };

  // ─────────────────────────────────────────────────────────────
  // 多时间段 chips + 可视化 cron 构建器
  // ─────────────────────────────────────────────────────────────

  Sched._renderTimesBar = function(){
    var bar = _q('schTimesBar');
    if(!bar) return;
    if(!Sched._times.length){ bar.style.display = 'none'; bar.innerHTML = ''; return; }
    bar.style.display = 'flex';
    bar.innerHTML = '<span style="color:var(--text3);align-self:center">多时间段:</span>'
      + Sched._times.map(function(e, i){
        return '<span style="display:inline-flex;align-items:center;gap:4px;border:1px solid var(--border);'
          + 'border-radius:10px;padding:1px 8px;background:var(--bg2)">'
          + '<code>'+ _esc(e) +'</code>'
          + '<a href="javascript:void(0)" style="color:var(--red);text-decoration:none" '
          + 'onclick="Sched.removeTime('+ i +')" title="移除">✕</a></span>';
      }).join('')
      + '<a href="javascript:void(0)" onclick="Sched.openCronBuilder()" '
      + 'style="color:var(--cyan);text-decoration:none;align-self:center">+ 添加时间段</a>';
  };

  Sched.removeTime = function(i){
    Sched._times.splice(i, 1);
    Sched._renderTimesBar();
    Sched.cronPreview();
  };

  // 可视化构建器: 打开模态 (mode='main' 主表达式 | 'append' 追加时间段)
  Sched.openCronBuilder = function(mode){
    Sched._cbMode = (mode === 'append') ? 'append' : 'main';
    var old = document.getElementById('schCronBuilderModal');
    if (old) old.remove();
    var fields = [
      { k:'min',  label:'分钟',   hint:'0-59' },
      { k:'hour', label:'小时',   hint:'0-23' },
      { k:'dom',  label:'日',     hint:'1-31' },
      { k:'mon',  label:'月',     hint:'1-12' },
      { k:'dow',  label:'星期',   hint:'0-6 · 0=周日' },
    ];
    // radio 包 <label>(点文字即选中); 输入框启用状态统一由 _cbBuild 同步
    var rows = fields.map(function(f){
      return '<tr>'
        + '<td style="padding:4px 8px;font-size:12px;white-space:nowrap"><b>'+ f.label +'</b> <span style="color:var(--text3);font-size:10px">'+ f.hint +'</span></td>'
        + '<td style="padding:4px"><label style="cursor:pointer;font-size:12px"><input type="radio" name="cbMode_'+ f.k +'" value="every" onchange="Sched._cbBuild()"> 每</label></td>'
        + '<td style="padding:4px"><label style="cursor:pointer;font-size:12px"><input type="radio" name="cbMode_'+ f.k +'" value="step" onchange="Sched._cbBuild()"> 每 N:</label></td>'
        + '<td style="padding:4px;width:74px"><input class="form-input" id="cbStep_'+ f.k +'" type="number" min="1" max="59" value="5" oninput="Sched._cbBuild()" disabled style="width:64px" title="先选左侧「每 N:」再填数字"></td>'
        + '<td style="padding:4px"><label style="cursor:pointer;font-size:12px"><input type="radio" name="cbMode_'+ f.k +'" value="list" onchange="Sched._cbBuild()"> 枚举:</label></td>'
        + '<td style="padding:4px"><input class="form-input" id="cbList_'+ f.k +'" placeholder="如 0,15,30,45 或 1-5" oninput="Sched._cbBuild()" disabled style="width:150px" title="先选左侧「枚举:」再填"></td>'
        + '</tr>';
    }).join('');
    var html = ''
      + '<div id="schCronBuilderModal" style="position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:9999">'
      +   '<div style="background:var(--bg);border:1px solid var(--border);border-radius:10px;min-width:640px;max-width:92vw;max-height:90vh;overflow:auto;padding:16px 20px">'
      +     '<div style="display:flex;align-items:center;margin-bottom:10px">'
      +       '<b style="font-size:14px">🧩 可视化 Cron 构建器</b>'
      +       '<button class="btn btn-sm" style="margin-left:auto" onclick="Sched.closeCronBuilder()">✕ 关闭</button>'
      +     '</div>'
      +     '<div style="display:flex;gap:6px;margin-bottom:8px">'
      +       '<button type="button" id="cbTabEasy" class="btn btn-sm btn-primary" onclick="Sched._cbEasyTab(\'easy\')">🧙 简易模式</button>'
      +       '<button type="button" id="cbTabAdv" class="btn btn-sm" onclick="Sched._cbEasyTab(\'adv\')">⚙ 高级模式</button>'
      +     '</div>'
      +     '<div id="cbEasyWrap" style="border:1px solid var(--border);border-radius:8px;padding:10px 14px;margin-bottom:10px;background:var(--bg2)">'
      +       '<div style="font-weight:600;font-size:13px;margin-bottom:8px">🧙 简易模式 <span style="color:var(--text3);font-weight:400;font-size:11px">— 选频率、选时间点即可，无需懂 cron</span></div>'
      +       '<div style="display:flex;gap:16px;flex-wrap:wrap;font-size:12px;align-items:center;margin-bottom:8px">'
      +         '<span>执行频率:</span>'
      +         '<label style="cursor:pointer"><input type="radio" name="cbEasyFreq" value="daily" checked onchange="Sched._cbEasyRender()"> 每天</label>'
      +         '<label style="cursor:pointer"><input type="radio" name="cbEasyFreq" value="weekly" onchange="Sched._cbEasyRender()"> 每周</label>'
      +         '<label style="cursor:pointer"><input type="radio" name="cbEasyFreq" value="monthly" onchange="Sched._cbEasyRender()"> 每月</label>'
      +         '<label style="cursor:pointer"><input type="radio" name="cbEasyFreq" value="min" onchange="Sched._cbEasyRender()"> 每隔 N 分钟</label>'
      +         '<label style="cursor:pointer"><input type="radio" name="cbEasyFreq" value="hour" onchange="Sched._cbEasyRender()"> 每隔 N 小时</label>'
      +       '</div>'
      +       '<div id="cbEasyFields" style="display:flex;gap:12px;flex-wrap:wrap;font-size:12px;align-items:center;min-height:34px"></div>'
      +       '<div style="margin-top:8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">'
      +         '<span style="color:var(--text3);font-size:12px">生成:</span>'
      +         '<code id="cbEasyExpr" style="font-size:13px;background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:3px 8px"></code>'
      +         '<span id="cbEasyDesc" style="color:var(--green);font-size:12px"></span>'
      +       '</div>'
      +       '<div style="margin-top:8px"><button class="btn btn-sm btn-primary" onclick="Sched._cbEasyApply()">✓ 应用此表达式</button></div>'
      +     '</div>'
      +     '<div id="cbAdvWrap" style="display:none">'
      +     '<div style="font-size:11px;color:var(--text3);margin:6px 0">⚙ 高级模式（5 字段逐项设置，适合特殊需求）</div>'
      +     '<table style="width:100%;border-collapse:collapse;font-size:12px">'
      +       '<thead><tr style="color:var(--text3);font-size:11px;text-align:left">'
      +         '<th style="padding:2px 8px">字段</th><th>每</th><th>步进</th><th></th><th>枚举/范围</th><th></th>'
      +       '</tr></thead><tbody>'+ rows +'</tbody></table></div>'
      +     '<div style="margin-top:10px;display:flex;gap:6px;align-items:center;flex-wrap:wrap">'
      +       '<span style="font-size:12px;color:var(--text3)">生成:</span>'
      +       '<code id="cbExpr" style="font-size:14px;background:var(--bg2);border:1px solid var(--border);border-radius:6px;padding:4px 10px"></code>'
      +       '<button class="btn btn-sm" onclick="Sched._cbUsePreset(\'0 3 * * *\')">每天 03:00</button>'
      +       '<button class="btn btn-sm" onclick="Sched._cbUsePreset(\'0 */2 * * *\')">每 2 小时</button>'
      +       '<button class="btn btn-sm" onclick="Sched._cbUsePreset(\'30 8 * * 1-5\')">工作日 08:30</button>'
      +     '</div>'
      +     '<div id="cbPreview" style="margin-top:8px;font-size:11px;color:var(--text3)">—</div>'
      +     '<div style="margin-top:10px;font-size:11px;color:var(--text2);border:1px dashed var(--border);border-radius:6px;padding:8px 10px;line-height:1.7">'
      +       '<b>📘 使用说明</b>（先点选模式，再填右侧输入框；输入框会自动启用）<br>'
      +       '· <b>每</b> = 每个该单位都触发（如分钟=每 → 每分钟的当前秒都算，即每分钟一次）<br>'
      +       '· <b>每 N</b> = 间隔触发（如小时填 2 → 每 2 小时）<br>'
      +       '· <b>枚举</b> = 指定值，逗号分隔多个，或 a-b 范围（如分钟 0,30 → 每小时的 0 分和 30 分）<br>'
      +       '<b>案例 · 工作日早上 8 点半：</b>分钟=枚举 <code>30</code> · 小时=枚举 <code>8</code> · 日/月=每 · 星期=枚举 <code>1-5</code> → 生成 <code>30 8 * * 1-5</code><br>'
      +       '<b>案例 · 每天 3 点和 21 点两次：</b>主表达式 分钟=枚举 <code>0</code> 小时=枚举 <code>3</code>，应用后点「+ 添加时间段」再建 小时=枚举 <code>21</code> 的一条'
      +     '</div>'
      +     '<div style="margin-top:12px;display:flex;gap:8px">'
      +       '<button class="btn btn-sm btn-primary" onclick="Sched._cbApply()">✓ 应用</button>'
      +       '<button class="btn btn-sm" onclick="Sched.closeCronBuilder()">取消</button>'
      +       (Sched._cbMode === 'append'
          ? '<span style="font-size:11px;color:var(--cyan);align-self:center">模式: 追加为多时间段</span>'
          : '<span style="font-size:11px;color:var(--text3);align-self:center">模式: 编辑主表达式</span>')
      +     '</div>'
      +   '</div>'
      + '</div>';
    document.body.insertAdjacentHTML('beforeend', html);
    // 默认全「每」
    ['min','hour','dom','mon','dow'].forEach(function(k){
      var r = document.querySelector('input[name="cbMode_'+ k +'"][value="every"]');
      if (r) r.checked = true;
    });
    Sched._cbEasyRender();
    Sched._cbBuild();
  };

  Sched.closeCronBuilder = function(){
    var m = document.getElementById('schCronBuilderModal');
    if (m) m.remove();
  };

  // ─────────────────────────────────────────────────────────────
  // 简易模式: 频率+时刻 → 自动生成 cron (人类语言化)
  // ─────────────────────────────────────────────────────────────
  Sched._cbEasyRender = function(){
    var freq = Sched._cbEasyFreq();
    var f = document.getElementById('cbEasyFields');
    if (!f) return;
    var h = '';
    if (freq === 'daily'){
      h = '<label>时间点 (可多个): </label><input type="time" id="cbEasyT0" value="03:00" class="form-input" style="width:110px">'
        + ' <button class="btn btn-sm" type="button" onclick="Sched._cbEasyAddTime()">+ 加时间点</button>';
    } else if (freq === 'weekly'){
      h = '<label>星期: </label>'
        + ['1','2','3','4','5','6','0'].map(function(d, i){
            var cn = ['一','二','三','四','五','六','日'][i];
            return '<label style="cursor:pointer;margin-right:4px"><input type="checkbox" class="cbEasyDow" value="'+d+'"'+(d==='1'?' checked':'')+'>周'+cn+'</label>';
          }).join('')
        + '<label style="margin-left:10px">时间点: </label><input type="time" id="cbEasyT0" value="03:00" class="form-input" style="width:110px">';
    } else if (freq === 'monthly'){
      h = '<label>几号 (1-31, 逗号分隔可多个): </label><input class="form-input" id="cbEasyDom" value="1" style="width:110px">'
        + '<label style="margin-left:10px">时间点: </label><input type="time" id="cbEasyT0" value="03:00" class="form-input" style="width:110px">';
    } else if (freq === 'min'){
      h = '<label>每隔 </label><input class="form-input" id="cbEasyN" type="number" min="1" max="720" value="15" style="width:70px"><label> 分钟</label>';
    } else if (freq === 'hour'){
      h = '<label>每隔 </label><input class="form-input" id="cbEasyHourN" type="number" min="1" max="48" value="2" style="width:70px"><label> 小时, 从第 </label>'
        + '<input class="form-input" id="cbEasyM" type="number" min="0" max="59" value="0" style="width:60px"><label> 分钟开始</label>';
    }
    f.innerHTML = h;
    var inputs = f.querySelectorAll('input, select');
    inputs.forEach(function(el){
      el.addEventListener('change', Sched._cbEasyBuild);
      el.addEventListener('input', Sched._cbEasyBuild);
    });
    Sched._cbEasyBuild();
  };

  Sched._cbEasyFreq = function(){
    var r = document.querySelector('input[name="cbEasyFreq"]:checked');
    return r ? r.value : 'daily';
  };

  Sched._cbEasyAddTime = function(){
    var f = document.getElementById('cbEasyFields');
    var inp = document.createElement('input');
    inp.type = 'time'; inp.value = '00:00'; inp.className = 'form-input cbEasyTime';
    inp.style.width = '110px'; inp.style.marginLeft = '6px';
    inp.addEventListener('change', Sched._cbEasyBuild);
    inp.addEventListener('input', Sched._cbEasyBuild);
    var t0 = document.getElementById('cbEasyT0');
    t0.parentNode.insertBefore(inp, t0.nextSibling);
    Sched._cbEasyBuild();
  };

  Sched._cbEasyBuild = function(){
    var freq = Sched._cbEasyFreq();
    var g = function(id){ var e = document.getElementById(id); return e ? e.value : ''; };
    var expr = '', desc = '';
    if (freq === 'daily'){
      var times = Sched._cbEasyTimes();
      if (!times.length){ desc = '请选择至少一个时间点'; }
      else {
        var mins = times.map(function(t){ return parseInt(t.split(':')[0], 10); });
        expr = (mins.length === 1 ? String(mins[0]) : mins.join(',')) + ' ' +
               (times.length === 1 ? String(times[0].split(':')[1]) :
                 Array.from(new Set(times.map(function(t){ return t.split(':')[1]; }))).join(',')) + ' * * *';
        desc = '每天 ' + times.join(' 和 ');
      }
    } else if (freq === 'weekly'){
      var dows = Array.prototype.map.call(document.querySelectorAll('.cbEasyDow:checked'), function(x){ return x.value; });
      var wt = g('cbEasyT0') || '03:00';
      if (!dows.length){ desc = '请至少选择一个星期'; }
      else {
        expr = parseInt(wt.split(':')[1], 10) + ' ' + parseInt(wt.split(':')[0], 10) + ' * * ' + dows.join(',');
        desc = '每' + (dows.length > 1 ? '周多天' : '周' + ['日','一','二','三','四','五','六'][+dows[0] % 7]) + ' ' + wt;
      }
    } else if (freq === 'monthly'){
      var dom = g('cbEasyDom') || '1';
      var mt = g('cbEasyT0') || '03:00';
      expr = parseInt(mt.split(':')[1], 10) + ' ' + parseInt(mt.split(':')[0], 10) + ' ' + dom + ' * *';
      desc = '每月 ' + dom + ' 号 ' + mt;
    } else if (freq === 'min'){
      var n = parseInt(g('cbEasyN') || '15', 10);
      expr = '*/' + n + ' * * * *';
      desc = '每 ' + n + ' 分钟';
    } else if (freq === 'hour'){
      var hn = parseInt(g('cbEasyHourN') || '2', 10);
      var m0 = parseInt(g('cbEasyM') || '0', 10);
      expr = m0 + ' */' + hn + ' * * *';
      desc = '每 ' + hn + ' 小时 (第 ' + m0 + ' 分)';
    }
    var el = document.getElementById('cbEasyExpr');
    var dv = document.getElementById('cbEasyDesc');
    if (el) el.textContent = expr || '(未生成)';
    if (dv) dv.textContent = desc;
    Sched._cbEasyLastExpr = expr;
  };

  Sched._cbEasyTimes = function(){
    return Array.prototype.map.call(document.querySelectorAll('#cbEasyFields input[type=time]'),
      function(x){ return x.value; }).filter(Boolean).sort();
  };

  Sched._cbEasyApply = function(){
    var expr = Sched._cbEasyLastExpr || (document.getElementById('cbEasyExpr')||{}).textContent || '';
    if (!expr || expr === '(未生成)'){ if (window.toast) toast('表达式未生成，请检查填写','warn',2000); return; }
    Sched._cbApplyFrom(expr);
  };

  Sched._cbEasyTab = function(tab){
    var easy = document.getElementById('cbEasyWrap');
    var adv = document.getElementById('cbAdvWrap');
    var bE = document.getElementById('cbTabEasy');
    var bA = document.getElementById('cbTabAdv');
    if (!easy || !adv) return;
    var isEasy = (tab === 'easy');
    easy.style.display = isEasy ? '' : 'none';
    adv.style.display = isEasy ? 'none' : '';
    if (bE) bE.className = 'btn btn-sm' + (isEasy ? ' btn-primary' : '');
    if (bA) bA.className = 'btn btn-sm' + (isEasy ? '' : ' btn-primary');
    if (!isEasy) Sched._cbBuild();
  };

  // 按当前选中模式统一启用/禁用输入框 (radio 已包 label, 点文字即选中)
  Sched._cbSyncInputs = function(){
    ['min','hour','dom','mon','dow'].forEach(function(k){
      var r = document.querySelector('input[name="cbMode_'+ k +'"]:checked');
      var mode = r ? r.value : 'every';
      var step = document.getElementById('cbStep_'+ k);
      var list = document.getElementById('cbList_'+ k);
      if (step) step.disabled = (mode !== 'step');
      if (list) list.disabled = (mode !== 'list');
    });
  };

  Sched._cbUsePreset = function(expr){
    document.getElementById('cbExpr').textContent = expr;
    Sched._cbApplyFrom(expr);
  };

  // 从表单构建表达式
  Sched._cbBuild = function(){
    Sched._cbSyncInputs();
    var DOW_CN = ['周日','周一','周二','周三','周四','周五','周六'];
    var fields = [
      { k:'min',  cn:'分钟', range:[0,59] },
      { k:'hour', cn:'小时', range:[0,23] },
      { k:'dom',  cn:'日',   range:[1,31] },
      { k:'mon',  cn:'月',   range:[1,12] },
      { k:'dow',  cn:'星期', range:[0,6], cnMap: DOW_CN },
    ];
    var parts = [];
    fields.forEach(function(f){
      var r = document.querySelector('input[name="cbMode_'+ f.k +'"]:checked');
      var mode = r ? r.value : 'every';
      if (mode === 'every'){ parts.push({ v:'*', d:'每'+ f.cn }); return; }
      if (mode === 'step'){
        var s = parseInt((document.getElementById('cbStep_'+ f.k)||{}).value || '0', 10);
        var lo = f.range[0];
        if (!s || s <= lo){ parts.push({ v:'*', d:'每'+ f.cn }); return; }
        parts.push({ v:'*/'+ s, d:'每 '+ s +' '+ f.cn });
        return;
      }
      var list = ((document.getElementById('cbList_'+ f.k)||{}).value || '').trim();
      if (!list){ parts.push({ v:'*', d:'每'+ f.cn }); return; }
      var d = list.split(',').map(function(x){
        x = x.trim();
        var m = x.match(/^(\d+)-(\d+)$/);
        if (m && f.cnMap){
          var a = +m[1], b = +m[2], out = [];
          for (var i = a; i <= b; i++) out.push(f.cnMap[i % 7]);
          return out.join('、');
        }
        if (m) return f.cn +' '+ x;
        if (f.cnMap && /^\d+$/.test(x)) return f.cnMap[(+x) % 7];
        return f.cn +' '+ x;
      }).join('、');
      parts.push({ v: list, d: d });
    });
    var expr = parts.map(function(p){ return p.v; }).join(' ');
    var el = document.getElementById('cbExpr');
    if (el) el.textContent = expr;
    // 实时后端预览
    var pv = document.getElementById('cbPreview');
    if (!pv) return;
    send({ action: 'schedule_cron_preview', expr: expr, count: 3 }, function(r){
      if(!r || r.status !== 'ok' || !r.valid){
        pv.innerHTML = '<span style="color:var(--red)">⚠ ' + _esc((r&&r.msg)||'无效表达式') + '</span>';
        return;
      }
      pv.innerHTML = '<span style="color:var(--green)">✓ 未来 3 次: </span>' + (r.next||[]).map(_esc).join(' · ');
    });
  };

  Sched._cbApply = function(){
    var expr = (document.getElementById('cbExpr')||{}).textContent || '';
    Sched._cbApplyFrom(expr);
  };

  Sched._cbApplyFrom = function(expr){
    if (!expr) return;
    if (Sched._cbMode === 'append'){
      if (Sched._times.indexOf(expr) < 0) Sched._times.push(expr);
      Sched._renderTimesBar();
    } else {
      _q('schCron').value = expr;
    }
    Sched.closeCronBuilder();
    Sched.cronPreview();
  };

  Sched.usePreset = function(expr){
    _q('schCron').value = expr;
    Sched.cronPreview();
  };

  Sched.templateFor = function(actionType){
    // 同步刷 wizard + JSON
    var params = Sched._defaultsFor(actionType);
    _q('schParamsJson').value = JSON.stringify(params, null, 2);
    Sched._renderWizard(actionType, params);
  };

  // v4.8.0: 从 schema 拿到默认 params
  Sched._defaultsFor = function(actionType){
    var schema = PARAM_SCHEMAS[actionType] || [];
    var params = {};
    schema.forEach(function(f){
      if(f['default'] !== undefined){
        // 数组浅拷贝，避免下次污染
        params[f.key] = Array.isArray(f['default']) ? f['default'].slice() : f['default'];
      }
    });
    return params;
  };

  // v4.8.0: 生成 wizard DOM
  Sched._renderWizard = function(actionType, params){
    var host = _q('schParamsWizard');
    if(!host) return;
    var schema = PARAM_SCHEMAS[actionType] || [];
    if(!schema.length){
      host.innerHTML = '<div style="color:var(--text3);font-size:11px">该 action 无可配置参数</div>';
      Sched._syncJsonFromWizard();
      return;
    }
    host.innerHTML = '';
    schema.forEach(function(f){
      var v = (params && params[f.key] !== undefined) ? params[f.key] : f['default'];
      var row = document.createElement('div');
      row.style.cssText = 'display:grid;grid-template-columns:160px 1fr;gap:6px 10px;align-items:center';
      row.innerHTML =
        '<label style="font-size:11px;color:var(--text2)">'+ _esc(f.label)
        + (f.required ? ' <span style="color:var(--red)">*</span>' : '')
        + '</label>'
        + '<div data-field="'+ _esc(f.key) +'"></div>';
      host.appendChild(row);
      var slot = row.querySelector('[data-field]');
      Sched._renderField(slot, f, v);
      if(f.hint){
        var hint = document.createElement('div');
        hint.style.cssText = 'grid-column:2/3;font-size:10px;color:var(--text3);margin-top:-2px';
        hint.textContent = f.hint;
        host.appendChild(hint);
      }
    });
    // 含 host 字段的 action 自动追加「测试 SSH 连接」按钮
    if (schema.some(function(f){ return f.key === 'host'; })){
      var tr = document.createElement('div');
      tr.style.cssText = 'display:grid;grid-template-columns:160px 1fr;gap:6px 10px;align-items:center';
      tr.innerHTML = '<label style="font-size:11px;color:var(--text2)">连接测试</label>'
        + '<div><button type="button" class="btn btn-sm" id="schTestConnBtn">🔗 测试 SSH 连接</button>'
        + '<span id="schTestConnResult" style="font-size:11px;margin-left:8px"></span></div>';
      host.appendChild(tr);
      tr.querySelector('#schTestConnBtn').onclick = function(){ Sched._testWizardConn(); };
    }
    Sched._syncJsonFromWizard();
  };

  // 从 wizard 读连接参数并发起 test_conn
  Sched._testWizardConn = function(){
    var actionType = _q('schAction').value;
    var schema = PARAM_SCHEMAS[actionType] || [];
    var p = { action: 'test_conn', port: '22', user: 'root', auth_type: 'pass' };
    schema.forEach(function(f){
      var slot = _q('schParamsWizard') && _q('schParamsWizard').querySelector('[data-field="'+ f.key +'"]');
      if (!slot) return;
      var el = slot.querySelector('input, select');
      if (el && el.value) p[f.key] = el.value;
    });
    if (!p.host){ if (window.toast) toast('请先填写主机或选择服务器配置','warn',2200); return; }
    if (p.config_id && !p.password){
      // config_id 模式: 后端会解密, 直接透传
    }
    var box = document.getElementById('schTestConnResult');
    if (box) box.textContent = '⏳ 测试中...';
    send({ action: 'test_conn', host: p.host, port: p.port || '22', user: p.user || 'root',
           auth_type: p.auth_type || 'pass', password: p.password || '', key: p.key || '',
           config_id: p.config_id || '' }, function(r){
      if (box) box.innerHTML = (r && r.status === 'ok')
        ? '<span style="color:var(--green)">✓ 连接正常</span>'
        : '<span style="color:var(--red)">✗ ' + _esc((r && r.msg) || '连接失败') + '</span>';
    });
  };

  Sched._renderField = function(slot, f, v){
    var el;
    if(f.type === 'select'){
      el = document.createElement('select');
      el.className = 'form-input';
      (f.options || []).forEach(function(op){
        var o = document.createElement('option'); o.value = op; o.textContent = op;
        if(op === v) o.selected = true;
        el.appendChild(o);
      });
      el.onchange = Sched._syncJsonFromWizard;
      slot.appendChild(el);
    } else if(f.type === 'share_dir_select'){
      // 本机路径手填 + 已挂载网络共享下拉自动填入
      el = document.createElement('div');
      el.style.cssText = 'display:flex;gap:6px;align-items:center;flex-wrap:wrap';
      var inp = document.createElement('input');
      inp.className = 'form-input'; inp.style.flex = '1';
      inp.value = v || ''; inp.placeholder = '/mnt/backup 或共享挂载点路径';
      inp.onchange = Sched._syncJsonFromWizard; inp.oninput = Sched._syncJsonFromWizard;
      el.appendChild(inp);
      var ssel = document.createElement('select');
      ssel.className = 'form-input'; ssel.style.maxWidth = '260px';
      ssel.innerHTML = '<option value="">🌐 选择已挂载共享…</option>';
      ssel.onchange = function(){ if (ssel.value) inp.value = ssel.value; };
      el.appendChild(ssel);
      slot.appendChild(el);
      send({ action: 'share_list' }, function(r){
        var shares = ((r && r.shares) || []).filter(function(s){ return s.last_status === 'mounted'; });
        if (shares.length){
          shares.forEach(function(s){
            var uuid = s.uuid || '';
            var mnt = '/var/lib/fonriv_mounts/shares/' + uuid;
            var o = document.createElement('option');
            o.value = mnt; o.textContent = '🌐 ' + (s.name || uuid) + ' (已挂载)';
            ssel.appendChild(o);
          });
        } else {
          ssel.innerHTML = '<option value="">(无已挂载共享)</option>';
        }
      });
    } else if(f.type === 'config_select'){
      el = document.createElement('select');
      el.className = 'form-input';
      el.innerHTML = '<option value="">加载中...</option>';
      slot.appendChild(el);
      Sched._loadConfigs(function(list){
        el.innerHTML = '<option value="">(未选)</option>' + list.map(function(c){
          var sel = (String(c.id) === String(v)) ? ' selected' : '';
          return '<option value="'+ c.id +'"'+ sel +'>#'+ c.id +' '+ _esc(c.name||'') +' · '+ _esc(c.host||'') +'</option>';
        }).join('');
        el.onchange = Sched._syncJsonFromWizard;
      });
    } else if(f.type === 'flow_select'){
      el = document.createElement('select');
      el.className = 'form-input';
      el.innerHTML = '<option value="">加载中...</option>';
      slot.appendChild(el);
      Sched._loadFlows(function(list){
        el.innerHTML = '<option value="">(未选)</option>' + list.map(function(fl){
          var sel = (String(fl.id) === String(v)) ? ' selected' : '';
          return '<option value="'+ fl.id +'"'+ sel +'>#'+ fl.id +' '+ _esc(fl.name||'') +' · '+ _esc(fl.source_type||'') +'</option>';
        }).join('');
        el.onchange = Sched._syncJsonFromWizard;
      });
    } else if(f.type === 'remote_select'){
      // 定时云上传: 远端存储下拉
      el = document.createElement('select');
      el.className = 'form-input';
      el.innerHTML = '<option value="">加载中...</option>';
      slot.appendChild(el);
      send({ action: 'remote_list' }, function(r){
        var list = (r && r.remotes) || [];
        el.innerHTML = '<option value="">(未选)</option>' + list.map(function(c){
          var sel = (String(c.id) === String(v)) ? ' selected' : '';
          return '<option value="'+ c.id +'"'+ sel +'>#'+ c.id +' '+ _esc(c.name||'') +' · '+ _esc(c.provider||'') +'</option>';
        }).join('');
        el.onchange = Sched._syncJsonFromWizard;
      });
    } else if(f.type === 'multiselect'){
      // checkbox 列 + 追加自定义框
      el = document.createElement('div');
      var cur = Array.isArray(v) ? v.slice() : [];
      var opts = (f.options || []).slice();
      // 用户历史里可能有 schema 里没的项 · 追加显示
      cur.forEach(function(x){ if(opts.indexOf(x) < 0) opts.push(x); });
      el.innerHTML = opts.map(function(op){
        var ck = cur.indexOf(op) >= 0 ? ' checked' : '';
        return '<label style="font-size:11px;margin-right:10px;white-space:nowrap">'
          + '<input type="checkbox" value="'+ _esc(op) +'"'+ ck +'/> '+ _esc(op) +'</label>';
      }).join('')
        + '<div style="margin-top:4px;display:flex;gap:6px">'
        + '<input type="text" class="form-input" placeholder="追加自定义项 (如 /opt/app)" style="flex:1;font-size:11px" data-add="1"/>'
        + '<button type="button" class="btn btn-sm" data-add-btn="1">+ 添加</button>'
        + '</div>';
      slot.appendChild(el);
      el.querySelectorAll('input[type=checkbox]').forEach(function(cb){
        cb.onchange = Sched._syncJsonFromWizard;
      });
      var addBtn = el.querySelector('[data-add-btn]');
      var addIn = el.querySelector('[data-add]');
      addBtn.onclick = function(){
        var val = (addIn.value || '').trim();
        if(!val) return;
        if(el.querySelector('input[type=checkbox][value="'+ val.replace(/"/g,'\\"') +'"]')){
          addIn.value = ''; return;
        }
        var lb = document.createElement('label');
        lb.style.cssText = 'font-size:11px;margin-right:10px;white-space:nowrap';
        lb.innerHTML = '<input type="checkbox" value="'+ _esc(val) +'" checked/> '+ _esc(val);
        var addBox = addIn.parentNode;
        el.insertBefore(lb, addBox);
        lb.querySelector('input').onchange = Sched._syncJsonFromWizard;
        addIn.value = '';
        Sched._syncJsonFromWizard();
      };
    } else {
      // text
      el = document.createElement('input');
      el.type = 'text';
      el.className = 'form-input';
      el.value = (v == null ? '' : String(v));
      if(f.placeholder) el.placeholder = f.placeholder;
      el.oninput = Sched._syncJsonFromWizard;
      slot.appendChild(el);
    }
  };

  // v4.8.0: 从 wizard 读回 params 对象
  Sched._readWizard = function(){
    var actionType = _q('schAction').value;
    var schema = PARAM_SCHEMAS[actionType] || [];
    var host = _q('schParamsWizard');
    var out = {};
    schema.forEach(function(f){
      var slot = host && host.querySelector('[data-field="'+ f.key +'"]');
      if(!slot) return;
      if(f.type === 'select'){
        var sel = slot.querySelector('select');
        if(sel && sel.value !== '') out[f.key] = sel.value;
      } else if(f.type === 'config_select'){
        var sel2 = slot.querySelector('select');
        var vv = sel2 && sel2.value;
        if(vv) out[f.key] = parseInt(vv, 10);
      } else if(f.type === 'share_dir_select'){
        // 取 div 内 input 值
        var sdi = slot.querySelector('input');
        if(sdi && sdi.value.trim()) out[f.key] = sdi.value.trim();
      } else if(f.type === 'flow_select'){
        var sel3 = slot.querySelector('select');
        var vv2 = sel3 && sel3.value;
        if(vv2) out[f.key] = parseInt(vv2, 10);
      } else if(f.type === 'remote_select'){
        // 定时云上传 remote_id
        var sel4 = slot.querySelector('select');
        var vv3 = sel4 && sel4.value;
        if(vv3) out[f.key] = parseInt(vv3, 10);
      } else if(f.type === 'multiselect'){
        var arr = [];
        slot.querySelectorAll('input[type=checkbox]:checked').forEach(function(cb){ arr.push(cb.value); });
        if(arr.length) out[f.key] = arr;
      } else {
        var inp = slot.querySelector('input');
        var v = inp ? inp.value.trim() : '';
        if(v !== '') out[f.key] = v;
      }
    });
    // 保留 JSON 里已存在但 schema 未覆盖的额外字段 (兼容 _owner_user_id 等)
    try {
      var pj = (_q('schParamsJson').value || '').trim();
      if(pj){
        var extra = JSON.parse(pj);
        Object.keys(extra).forEach(function(k){
          var inSchema = schema.some(function(x){ return x.key === k; });
          if(!inSchema && out[k] === undefined) out[k] = extra[k];
        });
      }
    } catch(e){ /* ignore */ }
    return out;
  };

  // wizard 任意字段变化 → 同步到 JSON
  Sched._syncJsonFromWizard = function(){
    var p = Sched._readWizard();
    _q('schParamsJson').value = JSON.stringify(p, null, 2);
  };

  // 手改 JSON 后回填 wizard
  Sched.syncFormFromJson = function(){
    var pj = (_q('schParamsJson').value || '').trim();
    var p = {};
    try { p = pj ? JSON.parse(pj) : {}; }
    catch(e){ toastErr('JSON 解析失败: '+ e.message); return; }
    Sched._renderWizard(_q('schAction').value, p);
    toastOk('已从 JSON 读回');
  };

  Sched.toggleJsonMode = function(){
    var w = _q('schJsonWrap'); var b = _q('schJsonToggle');
    if(!w || !b) return;
    if(w.style.display === 'none'){ w.style.display = 'block'; b.textContent = '▾ 收起 JSON 编辑'; }
    else { w.style.display = 'none'; b.textContent = '▸ 展开 JSON 编辑'; }
  };

  Sched._buildPresetBar = function(){
    var bar = _q('schPresetBar');
    if(!bar) return;
    bar.innerHTML = PRESET_CRONS.map(function(p){
      return '<button type="button" class="btn btn-sm" onclick="Sched.usePreset(\''+ p.expr +'\')" title="'+ p.expr +'">'+ _esc(p.label) +'</button>';
    }).join(' ');
  };

  // v6.16.14 · 功能裁剪(非社区版功能清除): flow/dbbackup/云上传三类任务属
  //   enterprise/pro 能力, 未授权时不进下拉(此前社区版可直接选到, 属功能外溢)。
  var ACT_FEAT = { flow_scheduled:'flow', dbbackup_scheduled:'dbbackup', remote_upload_scheduled:'cloud' };
  Sched._actAllowed = function(k){
    var f = ACT_FEAT[k];
    if (!f) return true;
    return !(typeof window.licenseFeatEnabled === 'function' && !window.licenseFeatEnabled(f));
  };
  Sched._buildActionSelect = function(){
    var sel = _q('schAction');
    if(!sel) return;
    var _cur = sel.value;
    sel.innerHTML = Object.keys(ACTION_LABELS).filter(Sched._actAllowed).map(function(k){
      return '<option value="'+ k +'">'+ _esc(ACTION_LABELS[k]) +'</option>';
    }).join('');
    if (_cur && Array.prototype.some.call(sel.options, function(o){ return o.value === _cur; })) sel.value = _cur;
    sel.value = 'platform_backup_scheduled';
    sel.onchange = function(){ Sched.templateFor(sel.value); };
  };

  Sched.init = function(){
    Sched._buildPresetBar();
    Sched._buildActionSelect();
    var cronIn = _q('schCron');
    if(cronIn){ cronIn.oninput = Sched.cronPreview; }
    // 把时间轴 section 移到表单后面
    try {
      var tl = _q('schTimelineWrap');
      var form = _q('schForm');
      if (tl && form && form.parentNode && tl.nextElementSibling !== null && form.nextSibling !== tl){
        form.parentNode.insertBefore(tl, form.nextSibling);
      }
    } catch(e){ console.warn('[sched] move timeline fail', e); }
    Sched.reset();
    Sched.refresh();
    // v4.10.0: 启动自动刷新时间轴 (30s)
    Sched.timelineAutoToggle();
    window.addEventListener('resize', function(){
      if(Sched._tlData) Sched._tlDraw();
    });
  };

  window.Sched = Sched;

  // 订阅 schedule.* 事件 → 面板可见时增量刷新（合并 200ms）
  document.addEventListener('DOMContentLoaded', function(){
    if (!window.EventBus) return;
    var _pending = false;
    function _schedule(){
      if (_pending) return;
      _pending = true;
      setTimeout(function(){
        _pending = false;
        var p = document.getElementById('panel-schedules');
        if (p && p.classList.contains('active')){
          try { Sched.refresh(); } catch(e){ console.warn('[sched] event refresh', e); }
          // 若时间轴可见，也刷时间轴
          try {
            var tl = document.getElementById('sched-timeline');
            if (tl && tl.offsetParent !== null && Sched.timelineRefresh){
              Sched.timelineRefresh();
            }
          } catch(e){}
        }
      }, 200);
    }
    window.EventBus.on('schedule.*', function(topic, payload){
      console.debug('[sched] event', topic, payload);
      _schedule();
    });
  });
})();
