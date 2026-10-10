/* v4.67.0 · 智能分析面板 (E1 备份异常检测 + E2 时间推荐)
 * 统计概览: 异常列表 (3σ 偏离) + 推荐执行时段 + 最近运行记录
 */
(function(g){
  'use strict';

  function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g,function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function $(id){ return document.getElementById(id); }
  function toast(m,k,ms){ if (typeof g.toast==='function') g.toast(m,k,ms||2600); }

  function rpc(action, data){
    return new Promise(function(resolve){
      try { g.send(Object.assign({action:action}, data||{}), function(r){ resolve(r||{}); }); }
      catch(e){ resolve({status:'error', msg:String(e)}); }
    });
  }
  function fmtB(b){
    b = Number(b)||0;
    if (!b) return '0 B';
    var u=['B','KB','MB','GB','TB'], i=0;
    while (b>=1024 && i<u.length-1){ b/=1024; i++; }
    return (i? b.toFixed(1): b) + ' ' + u[i];
  }

  async function load(){
    var host = $('statsBody');
    if (!host) return;
    host.innerHTML = '<div style="font-size:12px;color:var(--text3);padding:8px">⏳ 分析中…</div>';
    var r = await rpc('stats_overview', { limit: 30 });
    if (r.status !== 'ok'){
      host.innerHTML = '<div style="font-size:12px;color:var(--red)">✗ ' + esc(r.msg || '加载失败') + '</div>';
      return;
    }
    var anoms = r.anomalies || [];
    var rec = r.recommend || {};
    var recent = r.recent || [];

    var html = '';

    // ── 异常检测 (E1) ──
    html += '<div style="margin-bottom:14px">'+
      '<div style="font-size:12px;font-weight:600;color:var(--text2);margin-bottom:6px">'+
      '⚠ 备份异常检测 (3σ 统计模型)</div>';
    if (!anoms.length){
      html += '<div style="font-size:12px;color:var(--green);padding:6px 0">✓ 未发现异常。'+
        '<span style="color:var(--text3);font-size:11px">每次备份/传输的文件数与体积会与最近 30 次同类任务基线比较, 偏离超过 3σ 自动告警。</span></div>';
    } else {
      html += '<table style="width:100%;border-collapse:collapse;font-size:12px">'+
        '<tr style="color:var(--text3);font-size:11px;border-bottom:1px solid var(--border)">'+
        '<td style="padding:4px 6px">时间</td><td style="padding:4px 6px">类型</td>'+
        '<td style="padding:4px 6px">目标</td><td style="padding:4px 6px">偏差</td>'+
        '<td style="padding:4px 6px">说明</td></tr>'+
        anoms.map(function(a){
          return '<tr style="border-bottom:1px dashed var(--border)">'+
            '<td style="padding:4px 6px;color:var(--text3);font-size:11px;white-space:nowrap">'+esc(a.ts)+'</td>'+
            '<td style="padding:4px 6px;font-size:11px">'+esc(a.kind)+'</td>'+
            '<td style="padding:4px 6px;font-size:11px;color:var(--text3)">'+esc(a.target||'本机')+'</td>'+
            '<td style="padding:4px 6px;color:var(--orange);font-weight:600">'+a.sigma+'σ</td>'+
            '<td style="padding:4px 6px;font-size:11px;color:var(--text2)">'+esc(a.msg)+'</td></tr>';
        }).join('') + '</table>';
    }
    html += '</div>';

    // ── 时间推荐 (E2) ──
    html += '<div style="margin-bottom:14px;border-top:1px solid var(--border);padding-top:10px">'+
      '<div style="font-size:12px;font-weight:600;color:var(--text2);margin-bottom:6px">'+
      '⏰ 智能执行时间推荐</div>';
    if (!rec.ok){
      html += '<div style="font-size:12px;color:var(--text3);padding:4px 0">'+esc(rec.msg||'样本不足')+
        '<br><span style="font-size:11px">完成若干次传输后, 这里会按小时聚合历史速率并推荐最优窗口 (可配合 QoS 时间表使用)。</span></div>';
    } else {
      html += '<div style="font-size:13px;color:var(--green);font-weight:600;padding:4px 0">'+esc(rec.msg)+'</div>'+
        '<div style="font-size:11px;color:var(--text3);margin-top:2px">样本 '+rec.samples+' 次 · 全局均值 '+
        (rec.overall_avg/1048576).toFixed(1)+' MB/s</div>';
      // 小时柱状
      var hs = rec.hourly || [];
      if (hs.length){
        var mx = Math.max.apply(null, hs.map(function(h){ return h.avg_speed; })) || 1;
        html += '<div style="display:flex;align-items:flex-end;gap:2px;height:56px;margin-top:8px">'+
          hs.map(function(h){
            var pct = Math.round((h.avg_speed/mx)*100);
            var on = (rec.hours||[]).indexOf(h.hour) >= 0;
            return '<div title="'+h.hour+':00 · '+(h.avg_speed/1048576).toFixed(1)+' MB/s · '+h.samples+' 次" '+
              'style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%">'+
              '<div style="width:100%;height:'+Math.max(4,pct)+'%;background:'+(on?'var(--green)':'var(--bg4)')+';border-radius:2px"></div>'+
              '<span style="font-size:9px;color:var(--text3);margin-top:2px">'+h.hour+'</span></div>';
          }).join('') + '</div>';
      }
    }
    html += '</div>';

    // ── 最近运行 ──
    html += '<div style="border-top:1px solid var(--border);padding-top:10px">'+
      '<div style="font-size:12px;font-weight:600;color:var(--text2);margin-bottom:6px">📊 最近运行记录 (含速率)</div>';
    if (!recent.length){
      html += '<div style="font-size:12px;color:var(--text3)">暂无记录。完成一次传输或备份后自动统计。</div>';
    } else {
      html += '<div style="max-height:260px;overflow:auto"><table style="width:100%;border-collapse:collapse;font-size:11px">'+
        '<tr style="color:var(--text3);border-bottom:1px solid var(--border)">'+
        '<td style="padding:3px 6px">时间</td><td style="padding:3px 6px">类型</td>'+
        '<td style="padding:3px 6px">目标</td><td style="padding:3px 6px;text-align:right">文件</td>'+
        '<td style="padding:3px 6px;text-align:right">体积</td><td style="padding:3px 6px;text-align:right">速率</td></tr>'+
        recent.map(function(r2){
          return '<tr style="border-bottom:1px dashed var(--border)">'+
            '<td style="padding:3px 6px;color:var(--text3);white-space:nowrap">'+esc(r2.ts)+'</td>'+
            '<td style="padding:3px 6px">'+esc(r2.kind)+'</td>'+
            '<td style="padding:3px 6px;color:var(--text3)">'+esc(r2.target||'本机')+'</td>'+
            '<td style="padding:3px 6px;text-align:right">'+r2.files+'</td>'+
            '<td style="padding:3px 6px;text-align:right">'+fmtB(r2.bytes)+'</td>'+
            '<td style="padding:3px 6px;text-align:right;color:var(--cyan)">'+
            (r2.speed_bps ? (r2.speed_bps/1048576).toFixed(1)+' MB/s' : '-')+'</td></tr>';
        }).join('') + '</table></div>';
    }
    html += '</div>';

    host.innerHTML = html;
  }

  g.StatsPanel = { load: load };
})(window);
