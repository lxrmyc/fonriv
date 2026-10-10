/* v5.19.2 · 系统配置备份/恢复 前端
 * 依赖: window.send / toast / modal · 后端 handlers/sysconf.py
 */
(function(g){
  'use strict';
  function $(id){ return document.getElementById(id); }
  function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function toast(m,k,ms){ if (typeof g.toast==='function') g.toast(m,k,ms||3200); }
  function fmtB(n){
    n = Number(n)||0;
    var u=['B','KB','MB','GB'], i=0;
    while (n>=1024 && i<u.length-1){ n/=1024; i++; }
    return (i? n.toFixed(1): n) + ' ' + u[i];
  }
  function rpc(action, data, t){
    return new Promise(function(resolve){
      var done = false;
      var timer = setTimeout(function(){ if (!done){ done = true; resolve({status:'error', msg:'请求超时'}); } }, t||120000);
      try {
        g.send(Object.assign({action:action}, data||{}), function(r){
          if (done) return; done = true; clearTimeout(timer); resolve(r||{});
        });
      } catch(e){ if(!done){ done=true; clearTimeout(timer); resolve({status:'error', msg:String(e)}); } }
    });
  }
  function say(id, ok, msg){
    var el = $(id); if (!el) return;
    el.style.color = ok === null ? 'var(--text3)' : (ok ? 'var(--green)' : 'var(--red)');
    el.innerHTML = esc(msg||'').replace(/\n/g,'<br>');
  }

  var _lastExport = null;

  async function exportConf(mask){
    say('scExpResult', null, '⏳ 正在生成配置快照…');
    var r = await rpc('sysconf_export', { mask_secret: mask ? 1 : 0 });
    if (r.status !== 'ok'){ say('scExpResult', false, r.msg||'导出失败'); return; }
    _lastExport = r.content_b64;
    var sum = r.summary || {};
    var sm = $('scExpSummary');
    if (sm){
      sm.innerHTML = Object.keys(sum).map(function(k){
        return '<div>· '+esc(k)+' <b style="color:var(--cyan)">'+sum[k]+'</b> 条</div>';
      }).join('') || '（无数据）';
    }
    // 触发下载
    try {
      var bin = atob(r.content_b64);
      var bytes = new Uint8Array(bin.length);
      for (var i=0;i<bin.length;i++) bytes[i] = bin.charCodeAt(i);
      var blob = new Blob([bytes], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = r.filename || 'fonriv_config.json';
      document.body.appendChild(a); a.click();
      setTimeout(function(){ URL.revokeObjectURL(a.href); try{a.remove();}catch(_){ } }, 500);
    } catch(e){ console.warn('[sysconf] download', e); }
    // 导入框预填 (便于本机回灌或立即改到别处)
    var ta = $('scImpText');
    if (ta && !ta.value) ta.value = r.content_b64;
    say('scExpResult', true, '✓ ' + (r.msg||'已导出') + ' · 文件已下载' + (mask ? ' (已脱敏)' : ''));
    toast('✓ 配置已导出并下载', 'success', 3600);
  }

  function _importPayload(){
    var ta = $('scImpText');
    var v = ta ? String(ta.value || '').trim() : '';
    if (!v) return null;
    // 支持直接粘贴 JSON 或 base64
    if (v.charAt(0) === '{') return { content: v };
    return { content_b64: v };
  }

  async function previewImport(){
    var pl = _importPayload();
    if (!pl){ say('scImpResult', false, '请先粘贴导出的 JSON 内容'); return; }
    say('scImpResult', null, '⏳ 分析中…');
    var r = await rpc('sysconf_preview', pl);
    if (r.status !== 'ok'){ say('scImpResult', false, r.msg||'预览失败'); return; }
    var meta = r.meta || {};
    var h = '<div style="color:var(--text3);margin-bottom:6px">来源: ' + esc(meta.app||'?') +
            ' v' + esc(meta.version||'?') + ' · 导出于 ' + esc(meta.exported_at||'?') + '</div>';
    h += '<table style="width:100%;border-collapse:collapse;font-size:11px">' +
      '<tr style="color:var(--text3)"><td style="padding:3px 6px">配置组</td><td>新增</td><td>覆盖</td><td>合计</td><td>说明</td></tr>';
    (r.plan||[]).forEach(function(p){
      h += '<tr style="border-bottom:1px dashed var(--border)">' +
        '<td style="padding:3px 6px">' + esc(p.label||p.table) + '</td>' +
        '<td style="padding:3px 6px;color:var(--green)">+' + (p.new||0) + '</td>' +
        '<td style="padding:3px 6px;color:var(--orange)">~' + (p.overwrite||0) + '</td>' +
        '<td style="padding:3px 6px">' + (p.total||0) + '</td>' +
        '<td style="padding:3px 6px;color:var(--red);font-size:10px">' + esc(p.error||'') + '</td></tr>';
    });
    h += '</table>';
    var el = $('scImpResult');
    if (el){ el.style.color = 'var(--text2)'; el.innerHTML = h; }
  }

  async function doImport(){
    var pl = _importPayload();
    if (!pl){ say('scImpResult', false, '请先粘贴导出的 JSON 内容'); return; }
    var mode = ($('scImpMode')||{}).value || 'merge';
    var go = async function(){
      say('scImpResult', null, '⏳ 导入中…');
      var r = await rpc('sysconf_import', Object.assign({ mode: mode }, pl), 180000);
      say('scImpResult', r.status === 'ok', (r.status==='ok'?'✓ ':'⚠ ') + (r.msg||''));
      if (r.status === 'ok'){
        toast('✓ 配置导入完成', 'success', 4200);
        setTimeout(function(){ try { location.reload(); } catch(_){} }, 1500);
      }
    };
    var warn = mode === 'replace'
      ? '⚠ replace 模式会**先清空对应配置表**再导入, 本机该项配置将全部被替换。\n\n确定继续?'
      : '将按 ' + mode + ' 策略导入配置 (同名条目会按策略处理)。\n\n确定继续?';
    if (typeof g._showC2Modal === 'function'){
      g._showC2Modal({ title: '⚠ 导入系统配置', danger: mode === 'replace', okText: '导入', body: warn, onOk: go });
    } else if (g.confirm && g.confirm(warn)){ go(); }
  }

  async function dbBackup(){
    say('scExpResult', null, '⏳ 正在备份系统数据库…');
    var r = await rpc('sysdb_backup', {}, 300000);
    toast((r.status==='ok'?'✓ ':'✗ ') + (r.msg||''), r.status==='ok'?'success':'err', 5200);
    if (r.status === 'ok') refresh();
  }

  async function refresh(){
    var box = $('scDbList');
    if (box) box.innerHTML = '<div style="font-size:12px;color:var(--text3)">⏳ 加载…</div>';
    var r = await rpc('sysdb_list', {});
    if (!box) return;
    if (r.status !== 'ok'){ box.innerHTML = '<div style="font-size:12px;color:var(--red)">✗ '+esc(r.msg||'失败')+'</div>'; return; }
    var fs = r.files || [];
    if (!fs.length){
      box.innerHTML = rpState({ state: 'empty', msg: '暂无数据库备份 — 点上方「💾 立即备份数据库」创建' });
      return;
    }
    var h = '<div style="font-size:11px;color:var(--text3);margin-bottom:6px">存放目录: <span style="font-family:monospace">'+esc(r.dir)+'</span></div>';
    h += '<table style="width:100%;border-collapse:collapse;font-size:12px">'+
      '<tr style="color:var(--text3);font-size:11px"><td style="padding:4px 6px">文件</td><td>时间</td><td style="text-align:right">大小</td><td>校验</td><td style="width:120px">操作</td></tr>';
    fs.forEach(function(f){
      var isPre = f.name.indexOf('pre_restore_') === 0;
      h += '<tr style="border-bottom:1px dashed var(--border)">'+
        '<td style="padding:4px 6px;font-family:monospace;font-size:11px;color:'+(isPre?'var(--orange)':'var(--cyan)')+'">'+esc(f.name)+'</td>'+
        '<td style="padding:4px 6px;font-size:11px;color:var(--text3)">'+esc(f.mtime)+'</td>'+
        '<td style="padding:4px 6px;text-align:right;font-size:11px">'+fmtB(f.size)+'</td>'+
        '<td style="padding:4px 6px;font-size:11px;color:'+(f.has_sha?'var(--green)':'var(--text3)')+'">'+(f.has_sha?'✓ sha256':'—')+'</td>'+
        '<td style="padding:4px 6px"><button class="btn btn-sm" style="color:var(--red);font-size:10px;padding:1px 6px" '+
          'onclick="SysConf.dbRestore(\''+esc(f.path).replace(/\\/g,'\\\\')+'\',\''+esc(f.name)+'\')">♻ 恢复</button></td></tr>';
    });
    h += '</table>';
    box.innerHTML = h;
  }

  function dbRestore(path, name){
    var go = async function(){
      say('scExpResult', null, '⏳ 正在恢复…');
      var r = await rpc('sysdb_restore', { path: path, confirm: 1 }, 300000);
      toast((r.status==='ok'?'✓ ':'✗ ') + (r.msg||''), r.status==='ok'?'success':'err', 9000);
      say('scExpResult', r.status === 'ok', r.msg || '');
    };
    var body = '将从 ' + name + ' 恢复系统数据库:\n\n' +
               '· 当前**全部数据**会被该备份覆盖 (用户/任务历史/配置)\n' +
               '· 执行前系统会自动把当前库留底为 pre_restore_*.db\n' +
               '· 恢复后必须到「系统设置 → 后台服务」重启服务才完全生效\n\n确定继续?';
    if (typeof g._showC2Modal === 'function'){
      g._showC2Modal({ title: '⚠ 恢复系统数据库', danger: true, okText: '恢复', body: body, onOk: go });
    } else if (g.confirm && g.confirm(body)){ go(); }
  }

  g.SysConf = { refresh: refresh, exportConf: exportConf, previewImport: previewImport,
                doImport: doImport, dbBackup: dbBackup, dbRestore: dbRestore };
  document.addEventListener('DOMContentLoaded', function(){
    setTimeout(function(){
      try { if (typeof window.currentUser !== 'undefined' && window.currentUser) refresh(); } catch(e){}
    }, 2600);
  });
})(window);
