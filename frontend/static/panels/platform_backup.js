/*
 * frontend/static/panels/platform_backup.js
 *
 * 通用一键备份面板（v4.25.0 增强）：
 *  - 认证支持密码 / SSH 密钥（含短语）
 *  - 🔌 测试连接
 *  - 🌐 浏览服务器目录 → 追加到额外备份路径
 *  - 通用备份项支持单选/多选 · 默认多选 · 编辑按钮切换
 *  - 额外备份路径 textarea
 *
 * 依赖: window.send / window.openDirBrowser / window.PlatformSelector
 */
(function(){
  if (typeof window === 'undefined') return;

  var $ = function(id){ return document.getElementById(id); };
  var _lastPlan = null;      // 最近扫描结果
  var _lastPlatform = null;  // 最近探测出的平台
  var _planMode = 'multi';   // 'multi' | 'single'
  var _planSel = {};         // key -> bool

  function _auth(){
    var at = ($('pbAuthType')||{}).value || 'pass';
    var a = {
      host: ($('pbHost')||{}).value.trim() || '',
      port: ($('pbPort')||{}).value.trim() || '22',
      user: ($('pbUser')||{}).value.trim() || 'root',
      auth_type: at,
      password: '', key: '', passphrase: '',
    };
    if (at === 'pass'){
      a.password = ($('pbAuthValue')||{}).value || '';
    } else {
      a.key = ($('pbKeyPath')||{}).value.trim() || '';
      a.passphrase = ($('pbKeyPassphrase')||{}).value || '';
    }
    return a;
  }

  function _humanBytes(n){
    if (!n && n !== 0) return '-';
    if (n < 1024) return n + ' B';
    if (n < 1024*1024) return (n/1024).toFixed(1) + ' KB';
    if (n < 1024*1024*1024) return (n/1024/1024).toFixed(2) + ' MB';
    return (n/1024/1024/1024).toFixed(2) + ' GB';
  }

  function _setStatus(msg, kind){
    var el = $('pbStatus'); if (!el) return;
    var color = kind === 'error' ? 'var(--red,#e74c3c)'
              : kind === 'ok'    ? 'var(--green,#2ecc71)'
              : 'var(--text2,#aaa)';
    el.style.color = color;
    el.textContent = msg;
  }
  function _setConn(msg, kind){
    var el = $('pbConnStatus'); if (!el) return;
    var color = kind === 'error' ? 'var(--red,#e74c3c)'
              : kind === 'ok'    ? 'var(--green,#2ecc71)'
              : 'var(--text3)';
    el.style.color = color;
    el.textContent = msg;
  }
  function _setProgress(pct, text){
    var bar = $('pbProgressBar'); var lbl = $('pbProgressText');
    if (bar) bar.style.width = Math.max(0, Math.min(100, pct)) + '%';
    if (lbl) lbl.textContent = text || '';
  }

  // ---------- 认证方式切换 ----------
  function onAuthTypeChange(){
    var at = ($('pbAuthType')||{}).value || 'pass';
    if ($('pbPassRow')) $('pbPassRow').style.display = (at === 'pass') ? '' : 'none';
    if ($('pbKeyRow'))  $('pbKeyRow').style.display  = (at === 'key')  ? '' : 'none';
  }

  // ---------- 测试连接 ----------
  function testConn(){
    var auth = _auth();
    if (!auth.host){ _setConn('缺少主机地址', 'error'); return; }
    if (auth.auth_type === 'pass' && !auth.password){ _setConn('缺少密码', 'error'); return; }
    if (auth.auth_type === 'key'  && !auth.key){ _setConn('缺少私钥路径', 'error'); return; }
    _setConn('测试中...', '');
    window.send(Object.assign({action:'test_conn'}, auth), function(d){
      if (d && d.status === 'ok'){
        _setConn('✓ ' + (d.msg || '连接成功'), 'ok');
      } else {
        _setConn('✗ ' + (d && d.msg || '连接失败'), 'error');
      }
    });
  }

  // ---------- 选择本地私钥 ----------
  function pickLocalKey(){
    if (typeof window.openDirBrowser !== 'function'){
      alert('目录浏览器未就绪'); return;
    }
    var proxy = { value: ($('pbKeyPath')||{}).value || '' };
    Object.defineProperty(proxy, 'value', {
      set: function(v){ if($('pbKeyPath')){ $('pbKeyPath').value = v; } },
      get: function(){ return ($('pbKeyPath')||{}).value || ''; }
    });
    window.openDirBrowser($('pbKeyPath'), '~/.ssh', 'local');
  }

  // ---------- 浏览远端服务器 → 追加到额外路径 ----------
  function browseRemote(){
    var auth = _auth();
    if (!auth.host){ _setStatus('先填写主机地址', 'error'); return; }
    if (typeof window.openDirBrowser !== 'function'){
      alert('目录浏览器未就绪'); return;
    }
    // 使用一个 fake input 承接选择结果 → 追加到 textarea
    var fake = document.createElement('input');
    fake.type = 'text';
    fake._pbCallback = true;
    // openDirBrowser 完成后会写 targetInput.value = 选中路径
    // 通过 setter 拦截
    var _real = '';
    Object.defineProperty(fake, 'value', {
      set: function(v){
        _real = v;
        if (!v) return;
        var ta = $('pbExtraPaths'); if (!ta) return;
        var lines = (ta.value || '').split(/\r?\n/).map(function(s){return s.trim();}).filter(Boolean);
        // 支持多选：openDirBrowser 传的是 \n 分隔
        String(v).split(/\r?\n/).forEach(function(p){
          p = p.trim();
          if (p && lines.indexOf(p) < 0) lines.push(p);
        });
        ta.value = lines.join('\n');
        _setStatus('✓ 已追加 ' + String(v).split(/\r?\n/).length + ' 条路径到额外备份', 'ok');
      },
      get: function(){ return _real; }
    });
    window.openDirBrowser(fake, '/', 'remote', auth);
  }

  // ---------- 探测平台 ----------
  function doDetect(){
    var auth = _auth();
    if (!auth.host){ _setStatus('缺少主机地址', 'error'); return; }
    _setStatus('正在探测平台...', '');
    _setProgress(0, '');
    window.PlatformSelector.detect(auth, function(d){
      if (!d || d.status !== 'ok'){
        _setStatus('探测失败: ' + (d && d.msg || '未知错误'), 'error');
        return;
      }
      _lastPlatform = d;
      var icon = d.icon || '🐧';
      var conf = (typeof d.confidence === 'number') ? (' · 置信度 ' + d.confidence + '%') : '';
      $('pbPlatformBadge').innerHTML =
        '<span style="padding:4px 10px;border-radius:12px;background:var(--bg3,#2a2a2a);' +
        'color:var(--cyan,#00d4ff);font-weight:600">' +
        icon + ' ' + (d.display || d.platform) + '</span>' +
        '<span style="color:var(--text3,#888);font-size:12px;margin-left:8px">' + conf + '</span>';
      _setStatus('✓ 平台探测完成: ' + d.display, 'ok');
    }, { with_workloads: false });
  }

  // ---------- 扫描通用备份项 ----------
  function doPlan(){
    var auth = _auth();
    if (!auth.host){ _setStatus('缺少主机地址', 'error'); return; }
    _setStatus('正在扫描通用备份项...', '');
    _setProgress(0, '');
    var opts = {};
    if (_lastPlatform && _lastPlatform.platform) opts.platform = _lastPlatform.platform;
    window.PlatformSelector.planBackup(auth, function(d){
      if (!d || d.status !== 'ok'){
        _setStatus('扫描失败: ' + (d && d.msg || '未知错误'), 'error');
        return;
      }
      _lastPlan = d.plan;
      // 默认全选
      _planSel = {};
      (d.plan.items || []).forEach(function(it){ _planSel[it.key] = !!it.exists; });
      _planMode = 'multi';
      renderPlan();
      var s = d.plan.summary || {};
      $('pbPlanSummary').textContent = '· ' + s.existing_items + '/' + s.total_items + ' 项存在 · 合计 ' + _humanBytes(s.total_size_bytes);
      $('pbPlanControls').style.display = 'flex';
      _setStatus('✓ 扫描完成 · ' + s.existing_items + '/' + s.total_items +
                 ' 项 · 合计 ' + _humanBytes(s.total_size_bytes) + ' · 默认已全选', 'ok');
      _updateSelInfo();
    }, opts);
  }

  function setPlanMode(mode){
    _planMode = (mode === 'single') ? 'single' : 'multi';
    if (_planMode === 'single'){
      // 保留第一个已勾选项 · 其余置 false
      var kept = false;
      (_lastPlan && _lastPlan.items || []).forEach(function(it){
        if (_planSel[it.key] && !kept){ kept = true; }
        else _planSel[it.key] = false;
      });
    }
    renderPlan();
    _updateSelInfo();
  }
  function togglePlanEdit(){ /* v4.26.0 removed: 单/多选切换即为编辑态 */ }
  function planSelectAll(v){
    if (!_lastPlan) return;
    if (_planMode === 'single' && v){
      // 单选模式全选无意义，只勾第一项
      var first = (_lastPlan.items||[])[0];
      Object.keys(_planSel).forEach(function(k){ _planSel[k] = false; });
      if (first) _planSel[first.key] = true;
    } else {
      (_lastPlan.items || []).forEach(function(it){ _planSel[it.key] = !!v && !!it.exists; });
    }
    renderPlan();
    _updateSelInfo();
  }
  function _onPlanToggle(key){
    if (_planMode === 'single'){
      Object.keys(_planSel).forEach(function(k){ _planSel[k] = (k === key); });
    } else {
      _planSel[key] = !_planSel[key];
    }
    renderPlan();
    _updateSelInfo();
  }
  function _updateSelInfo(){
    if (!_lastPlan){ $('pbPlanSelInfo').textContent = ''; return; }
    var n = 0, sz = 0;
    (_lastPlan.items || []).forEach(function(it){
      if (_planSel[it.key]){ n++; sz += (it.size_bytes || 0); }
    });
    $('pbPlanSelInfo').textContent = '已选 ' + n + ' 项 · ' + _humanBytes(sz);
  }
  function _selectedKeys(){
    var out = [];
    Object.keys(_planSel).forEach(function(k){ if (_planSel[k]) out.push(k); });
    return out;
  }

  function renderPlan(){
    var plan = _lastPlan;
    var box = $('pbPlanBox'); if (!box || !plan) return;
    var items = (plan.items || []);
    var tools = (plan.summary && plan.summary.tools) || {};
    var toolBadges = Object.keys(tools).map(function(t){
      var ok = tools[t];
      return '<span style="padding:2px 8px;border-radius:10px;font-size:11px;margin-right:6px;' +
             'background:' + (ok ? 'rgba(46,204,113,.15)' : 'rgba(231,76,60,.15)') + ';' +
             'color:' + (ok ? '#2ecc71' : '#e74c3c') + '">' +
             (ok ? '✓ ' : '✗ ') + t + '</span>';
    }).join('');

    var rows = items.map(function(it){
      var checked = !!_planSel[it.key];
      var disabled = !it.exists; // v4.26.0: 存在即可勾，不再要求 editing
      var inputType = (_planMode === 'single') ? 'radio' : 'checkbox';
      var boxIn = '<input type="' + inputType + '" name="pbPlanPick" ' +
        (checked ? 'checked ' : '') +
        (disabled ? 'disabled ' : '') +
        'onchange="PlatformBackup._onPlanToggle(\'' + it.key.replace(/\'/g,"\\'") + '\')">';
      var mark = it.exists ? '<span style="color:#2ecc71">✓</span>' : '<span style="color:#888">✗</span>';
      var paths = (it.paths || []).join(' · ');
      return '<tr' + (checked ? ' style="background:rgba(46,204,113,.08)"' : '') + '>' +
        '<td style="padding:6px 8px;text-align:center">' + boxIn + '</td>' +
        '<td style="padding:6px 8px">' + mark + '</td>' +
        '<td style="padding:6px 8px;font-family:monospace">' + (it.key || '') + '</td>' +
        '<td style="padding:6px 8px">' + (it.display || '') + '</td>' +
        '<td style="padding:6px 8px;font-size:11px;color:var(--text3)">' + paths + '</td>' +
        '<td style="padding:6px 8px;text-align:right">' + _humanBytes(it.size_bytes || 0) + '</td>' +
        '<td style="padding:6px 8px;text-align:right;color:var(--text3)">' + (it.count || 0) + '</td>' +
        '</tr>';
    }).join('');

    box.innerHTML =
      '<div style="margin-bottom:8px;font-size:12px">工具可用性: ' + toolBadges + '</div>' +
      '<table style="width:100%;border-collapse:collapse;font-size:12px">' +
        '<thead style="background:var(--bg3,#2a2a2a);color:var(--text2)">' +
          '<tr>' +
            '<th style="padding:6px 8px;width:38px">选</th>' +
            '<th style="padding:6px 8px;text-align:left;width:32px">在</th>' +
            '<th style="padding:6px 8px;text-align:left">key</th>' +
            '<th style="padding:6px 8px;text-align:left">项目</th>' +
            '<th style="padding:6px 8px;text-align:left">路径</th>' +
            '<th style="padding:6px 8px;text-align:right">大小</th>' +
            '<th style="padding:6px 8px;text-align:right">文件数</th>' +
          '</tr>' +
        '</thead>' +
        '<tbody>' + rows + '</tbody>' +
      '</table>';
  }

  // ---------- 立即备份 ----------
  async function doBackup(){
    var auth = _auth();
    if (!auth.host){ _setStatus('缺少主机地址', 'error'); return; }
    var selKeys = _selectedKeys();
    var extra = (($('pbExtraPaths')||{}).value || '').split(/\r?\n/).map(function(s){return s.trim();}).filter(Boolean);
    if (_lastPlan && !selKeys.length && !extra.length){
      _setStatus('请至少选择 1 项通用备份项或填写 1 条额外路径', 'error');
      return;
    }
    if (!(await rpConfirm({ title:'拉取真备份到本地', okText:'开始备份', body:'确认现在从 ' + auth.host + ' 拉一个真备份到本地？\n' +
                 (selKeys.length ? '通用备份项: ' + selKeys.length + ' 项\n' : '') +
                 (extra.length ? '额外路径: ' + extra.length + ' 条\n' : '') +
                 '(仅读取远端，不修改远端任何文件)' }))){
      return;
    }
    var opts = {
      compressor: ($('pbCompressor')||{}).value || 'gzip',
      label: ($('pbLabel')||{}).value || '',
    };
    var localDir = (($('pbLocalDir')||{}).value || '').trim();
    if (localDir) opts.local_dir = localDir;
    if (_lastPlatform && _lastPlatform.platform) opts.platform = _lastPlatform.platform;
    if (selKeys.length) opts.selected_keys = selKeys;
    if (extra.length)   opts.extra_paths   = extra;

    _setStatus('正在执行备份...', '');
    _setProgress(5, '开始...');

    window.PlatformSelector.executeBackup(auth, function(d){
      if (!d || d.status !== 'ok'){
        _setStatus('备份失败: ' + (d && d.msg || '未知错误'), 'error');
        _setProgress(0, '');
        return;
      }
      var b = d.backup || {};
      _setProgress(100, '完成');
      _setStatus('✓ ' + d.msg, 'ok');
      $('pbResultBox').innerHTML =
        '<div style="padding:10px 14px;background:rgba(46,204,113,.08);' +
        'border-left:3px solid #2ecc71;border-radius:4px;font-size:12px;line-height:1.8">' +
          '<div>✓ 备份完成</div>' +
          '<div>本地路径: <code>' + (b.path || '-') + '</code></div>' +
          '<div>大小: ' + _humanBytes(b.size_bytes) + ' · 压缩: ' + b.compressor + '</div>' +
          '<div>耗时: ' + b.duration_sec + ' s</div>' +
          '<div>sha256: <code style="font-size:10px">' + (b.sha256 || '-') + '</code></div>' +
          '<div>项数: ' + b.item_count + ' (path: ' + b.path_items +
                 ', sidecars: ' + ((b.sidecars || []).length) + ')</div>' +
        '</div>';
      loadHistory();
    }, opts);
  }

  // ---------- 备份历史 ----------
  function loadHistory(){
    window.send({ action:'platform_backup_history', limit: 20 }, function(d){
      var box = $('pbHistoryBox'); if (!box) return;
      if (!d || d.status !== 'ok'){
        box.innerHTML = '<div style="color:var(--red,#e74c3c);font-size:12px">'
                       + (d && d.msg || '读取历史失败') + '</div>';
        return;
      }
      var rows = (d.history || []).map(function(r){
        var statusColor = r.status === 'success' ? '#2ecc71'
                        : r.status === 'failed'  ? '#e74c3c' : '#f39c12';
        var uploadBtn = (r.status === 'success' && r.destination)
          ? '<button onclick="PlatformBackup.uploadRow(' + r.id + ')" ' +
              'style="padding:2px 8px;font-size:11px" title="上传到远端存储">☁️ 上传</button>'
          : '';
        return '<tr>' +
          '<td style="padding:4px 8px;color:var(--text3);font-size:11px">' + (r.started_at || '-') + '</td>' +
          '<td style="padding:4px 8px;font-family:monospace">' + (r.source || '-') + '</td>' +
          '<td style="padding:4px 8px;font-size:11px;color:var(--text3)">' + (r.destination || '-') + '</td>' +
          '<td style="padding:4px 8px;text-align:right">' + _humanBytes(r.size_bytes) + '</td>' +
          '<td style="padding:4px 8px;text-align:right;color:var(--text3)">' + (r.file_count || 0) + '</td>' +
          '<td style="padding:4px 8px;color:' + statusColor + '">' + r.status + '</td>' +
          '<td style="padding:4px 8px;text-align:right">' + uploadBtn + '</td>' +
          '</tr>';
      }).join('');
      if (!rows) rows = '<tr><td colspan="7" style="padding:12px;text-align:center;color:var(--text3)">暂无平台备份记录</td></tr>';
      box.innerHTML =
        '<table style="width:100%;border-collapse:collapse;font-size:12px">' +
        '<thead style="background:var(--bg3,#2a2a2a);color:var(--text2)">' +
        '<tr><th style="padding:6px 8px;text-align:left">时间</th>' +
        '<th style="padding:6px 8px;text-align:left">主机</th>' +
        '<th style="padding:6px 8px;text-align:left">路径</th>' +
        '<th style="padding:6px 8px;text-align:right">大小</th>' +
        '<th style="padding:6px 8px;text-align:right">项数</th>' +
        '<th style="padding:6px 8px;text-align:left">状态</th>' +
        '<th style="padding:6px 8px;text-align:right">操作</th></tr></thead>' +
        '<tbody>' + rows + '</tbody></table>';
    });
  }

  // ---------- 上传到远端 ----------
  async function uploadRow(backupId){
    var remotes = window.__remotesCache || [];
    if (!remotes.length){
      window.send({ action:'remote_list' }, function(d){
        if (d && d.status === 'ok'){
          window.__remotesCache = d.remotes || [];
          uploadRow(backupId);
        } else { alert('无法读取远端列表：' + (d && d.msg || '未知错误')); }
      });
      return;
    }
    var opts = remotes.map(function(r, i){
      return (i+1) + '. [' + r.provider + '] ' + r.name + (r.bucket ? ' → ' + r.bucket : '');
    }).join('\n');
    var pick = await rpPrompt({ title:'选择上传目标（输入编号）',
      // hint 走 HTML 渲染, 故先转义再换行 → <br>, 避免远端名里的尖括号被当标签
      hint: opts.replace(/[&<>]/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;'}[c]; }).replace(/\n/g, '<br>'),
      defaultName:'1' });
    if (!pick) return;
    var idx = parseInt(pick, 10) - 1;
    if (isNaN(idx) || idx < 0 || idx >= remotes.length){ alert('无效编号'); return; }
    var remote = remotes[idx];
    if (!(await rpConfirm({ title:'上传到远端', okText:'上传', body:'确认上传 backup #' + backupId + ' → [' + remote.provider + '] ' + remote.name + '?' }))) return;
    _setStatus('上传中 → ' + remote.name + '...', '');
    _setProgress(5, '开始上传...');
    window.send({ action:'remote_upload', backup_id:backupId, remote_id:remote.id },
      function(d){
        if (!d || d.status !== 'ok'){
          _setStatus('✗ ' + (d && d.msg || '上传失败'), 'error');
          _setProgress(0, '');
          return;
        }
        _setProgress(100, '完成');
        _setStatus('✓ ' + d.msg, 'ok');
        if (window.Remotes && window.Remotes.loadHistory) window.Remotes.loadHistory();
      }, true);
  }

  // ---------- 保存当前连接为配置 ----------
  async function saveAsConfig(){
    var auth = _auth();
    if (!auth.host){ _setConn('缺少主机地址', 'error'); return; }
    if (typeof window.saveAsCopyForCurrentPanel === 'function'){
      // 直接复用主 app 的另存为副本 · 会读取当前 activePanel = platform_backup
      window.saveAsCopyForCurrentPanel();
      return;
    }
    // fallback: 无 saveAsCopyForCurrentPanel 时最小实现
    var name = await rpPrompt({ title:'配置名称', defaultName: '通用一键备份 - ' + auth.host });
    if (!name) return;
    var cfg = {
      name: name, color: 'var(--green)',
      host: auth.host, port: auth.port, user: auth.user,
      auth_type: auth.auth_type,
      auth_value: auth.auth_type === 'key' ? auth.key : (($('pbRemember')||{}).checked ? auth.password : ''),
      passphrase: auth.passphrase || '',
      pbExtraPaths: ($('pbExtraPaths')||{}).value || '',
      pbLocalDir: ($('pbLocalDir')||{}).value || '',
    };
    if (Array.isArray(window.configs)){
      window.configs.push(cfg);
      if (typeof window.saveConfigs === 'function') window.saveConfigs();
      if (typeof window.loadConfigs === 'function') window.loadConfigs();
      _setConn('✓ 已保存为配置：' + name, 'ok');
    } else {
      alert('配置系统未就绪');
    }
  }

  // ---------- 选择本地备份目录 ----------
  function pickLocalDir(){
    if (typeof window.openDirBrowser !== 'function'){
      alert('目录浏览器未就绪'); return;
    }
    var target = $('pbLocalDir');
    if (!target) return;
    window.openDirBrowser(target, target.value || '/mnt/backup/', 'local');
  }

  window.PlatformBackup = {
    doDetect: doDetect,
    doPlan: doPlan,
    doBackup: doBackup,
    loadHistory: loadHistory,
    uploadRow: uploadRow,
    onAuthTypeChange: onAuthTypeChange,
    testConn: testConn,
    pickLocalKey: pickLocalKey,
    browseRemote: browseRemote,
    setPlanMode: setPlanMode,
    togglePlanEdit: togglePlanEdit,
    planSelectAll: planSelectAll,
    _onPlanToggle: _onPlanToggle,
    saveAsConfig: saveAsConfig,
    pickLocalDir: pickLocalDir,
    // v4.30.0 · 供 TransferList 组件塞值
    setExtraPaths: function(paths){
      var ta = document.getElementById('pbExtraPaths');
      if (!ta) return false;
      var lines = Array.isArray(paths) ? paths : [String(paths||'')];
      ta.value = lines.filter(Boolean).join('\n');
      try{ ta.dispatchEvent(new Event('input',{bubbles:true})); }catch(_){}
      return true;
    },
    getExtraPaths: function(){
      var ta = document.getElementById('pbExtraPaths');
      if (!ta) return [];
      return (ta.value||'').split(/\r?\n/).map(function(s){return s.trim();}).filter(Boolean);
    },
    __version: 'v4.30.0',
  };
})();
