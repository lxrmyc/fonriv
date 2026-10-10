// v4.24.0 · 告警触发次数排行榜 + 规则导入导出（纯前端 · ES5）
(function(){
  var $ = function(id){ return document.getElementById(id); };
  function rpc(action, extra){
    return new Promise(function(resolve){
      window.openWs(function(ws){
        var once = function(e){
          var d; try{ d = JSON.parse(e.data); }catch(_){ return; }
          if (!d || d.type !== 'result') return;
          ws.removeEventListener('message', once);
          resolve(d);
        };
        ws.addEventListener('message', once);
        _rpSendWhenReady(ws, Object.assign({action: action}, extra||{}), undefined, function(){ try { console.warn('[ws] 发送失败'); } catch(_){} })
      }).catch(function(){ resolve({status:'error', msg:'ws 断开'}); });
    });
  }
  function fmt(ts){
    if (!ts) return '-';
    var d = new Date(ts * 1000);
    return d.toLocaleString('sv-SE').replace(' ', ' ');
  }
  function bar(val, max, color){
    var pct = max > 0 ? Math.round(val * 100 / max) : 0;
    return '<div style="background:var(--bg3);border-radius:2px;overflow:hidden;height:10px;min-width:80px">'+
           '<div style="width:'+pct+'%;background:'+color+';height:100%"></div></div>';
  }
  async function reload(){
    var range = parseInt($('asRange').value, 10) || 0;
    var payload = {};
    if (range > 0) payload.since_ts = (Date.now()/1000) - range;
    var r = await rpc('alert_history_stats', payload);
    var box = $('alertStatsBox');
    if (!r || r.status !== 'ok'){
      box.innerHTML = '<div style="color:var(--red);padding:8px">加载失败: '+ (r&&r.msg||'?') +'</div>';
      return;
    }
    $('asTotal').textContent = '共 '+ r.total +' 次触发（✓ '+ r.ok +' · ✗ '+ r.err +'）';
    var rules = r.by_rule || [];
    var maxTotal = rules.reduce(function(m, x){ return Math.max(m, x.total); }, 1);
    var rulesHtml = rules.length ? rules.map(function(x, i){
      var errRatio = x.total ? Math.round(x.err * 100 / x.total) : 0;
      return '<tr>'+
        '<td style="padding:4px 8px;color:var(--text3);width:34px;text-align:right">#'+(i+1)+'</td>'+
        '<td style="padding:4px 8px;font-weight:600">'+ (x.rule_name||'-') +'</td>'+
        '<td style="padding:4px 8px;width:180px">'+ bar(x.total, maxTotal, 'var(--cyan)') +'</td>'+
        '<td style="padding:4px 8px;text-align:right;font-family:monospace">'+ x.total +'</td>'+
        '<td style="padding:4px 8px;text-align:right;color:var(--green)">'+ x.ok +'</td>'+
        '<td style="padding:4px 8px;text-align:right;color:'+ (x.err? 'var(--red)':'var(--text3)') +'">'+ x.err +'</td>'+
        '<td style="padding:4px 8px;text-align:right;color:'+ (errRatio>50?'var(--red)':errRatio>20?'var(--accent)':'var(--text3)') +'">'+ errRatio +'%</td>'+
        '<td style="padding:4px 8px;color:var(--text3);font-size:11px">'+ fmt(x.last_ts) +'</td>'+
      '</tr>';
    }).join('') : '<tr><td colspan="8" style="text-align:center;color:var(--text3);padding:14px">此范围内无告警触发记录</td></tr>';

    var topics = r.by_topic || [];
    var maxTopic = topics.reduce(function(m, x){ return Math.max(m, x.count); }, 1);
    var topicsHtml = topics.length ? topics.map(function(x, i){
      return '<tr>'+
        '<td style="padding:4px 8px;color:var(--text3);width:34px;text-align:right">#'+(i+1)+'</td>'+
        '<td style="padding:4px 8px;font-family:monospace;font-size:11px">'+ (x.topic||'-') +'</td>'+
        '<td style="padding:4px 8px;width:180px">'+ bar(x.count, maxTopic, 'var(--purple)') +'</td>'+
        '<td style="padding:4px 8px;text-align:right;font-family:monospace">'+ x.count +'</td>'+
      '</tr>';
    }).join('') : '';

    box.innerHTML =
      '<div style="font-size:12px;font-weight:600;color:var(--text2);margin:4px 0">📊 按规则</div>'+
      '<table style="width:100%;font-size:12px;border-collapse:collapse">'+
        '<thead style="color:var(--text3);border-bottom:1px solid var(--border)"><tr>'+
          '<th style="padding:4px 8px;text-align:right">#</th>'+
          '<th style="padding:4px 8px;text-align:left">规则名</th>'+
          '<th style="padding:4px 8px;text-align:left">占比</th>'+
          '<th style="padding:4px 8px;text-align:right">总计</th>'+
          '<th style="padding:4px 8px;text-align:right">成功</th>'+
          '<th style="padding:4px 8px;text-align:right">失败</th>'+
          '<th style="padding:4px 8px;text-align:right">失败率</th>'+
          '<th style="padding:4px 8px;text-align:left">最近触发</th>'+
        '</tr></thead><tbody>'+ rulesHtml +'</tbody></table>'+
      (topicsHtml ?
        '<div style="font-size:12px;font-weight:600;color:var(--text2);margin:14px 0 4px">📡 按主题 (Top 20)</div>'+
        '<table style="width:100%;font-size:12px;border-collapse:collapse">'+
          '<thead style="color:var(--text3);border-bottom:1px solid var(--border)"><tr>'+
            '<th style="padding:4px 8px;text-align:right">#</th>'+
            '<th style="padding:4px 8px;text-align:left">Topic</th>'+
            '<th style="padding:4px 8px;text-align:left">占比</th>'+
            '<th style="padding:4px 8px;text-align:right">次数</th>'+
          '</tr></thead><tbody>'+ topicsHtml +'</tbody></table>'
        : '');
  }
  async function exportRules(){
    var r = await rpc('alert_rules_export', {});
    if (!r || r.status !== 'ok'){
      alert('导出失败: '+ (r&&r.msg||'?'));
      return;
    }
    var txt = JSON.stringify(r.export, null, 2);
    var blob = new Blob([txt], {type:'application/json'});
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'fonriv-alert-rules-'+ new Date().toISOString().slice(0,10) +'.json';
    document.body.appendChild(a); a.click();
    setTimeout(function(){ URL.revokeObjectURL(a.href); a.remove(); }, 500);
    if (window.toast) toast('已导出 '+ (r.export.rules||[]).length +' 条规则', 'ok');
  }
  async function importRules(mode){
    var msg = mode === 'replace'
      ? '替换导入会完全覆盖现有告警规则，确定继续？'
      : '追加导入会按规则名合并，同名规则以导入文件为准，继续？';
    if (!(await rpConfirm({ title: mode === 'replace' ? '替换导入告警规则' : '追加导入告警规则',
      danger: mode === 'replace', okText:'继续', body: msg }))) return;
    var inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'application/json,.json';
    inp.onchange = async function(){
      var f = inp.files && inp.files[0]; if (!f) return;
      var text = await f.text();
      var payload;
      try { payload = JSON.parse(text); }
      catch(e){ alert('JSON 解析失败: '+ e.message); return; }
      if (!payload || !Array.isArray(payload.rules)){
        alert('文件格式错误：应包含 rules 数组');
        return;
      }
      var r = await rpc('alert_rules_import', {import: payload, mode: mode});
      if (!r || r.status !== 'ok'){
        alert('导入失败: '+ (r&&r.msg||'?'));
        return;
      }
      alert('✓ 导入完成\n\n本次导入: '+ r.imported +' 条\n当前总数: '+ r.total +' 条');
      // 刷新告警规则面板（如已打开）
      if (window.Alerting && typeof Alerting.reload === 'function') Alerting.reload();
    };
    inp.click();
  }

  window.AlertStats = {
    reload: reload,
    exportRules: exportRules,
    importRules: importRules,
  };
})();
