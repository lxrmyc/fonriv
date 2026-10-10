/* v4.91.0 · F4 流量配额 / 成本管控面板 (系统设置内嵌 section)
 * quota_config GET/SET + quota_usage 查询; 配合 handle_rsync 前置闸门
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

  async function refresh(){
    var host = $('quotaSummary'); if (!host) return;
    var r = await rpc('quota_usage', { days: 30 });
    if (r.status !== 'ok'){ host.innerHTML = '<span style="color:var(--red)">✗ ' + esc(r.msg || '查询失败') + '</span>'; return; }
    var cfgRow = await rpc('quota_config', {});
    var cfg = (cfgRow && cfgRow.cfg) || {};
    if ($('quotaEnabled')) $('quotaEnabled').value = cfg.enabled ? '1' : '0';
    if ($('quotaDaily')) $('quotaDaily').value = cfg.daily_gb || 0;
    if ($('quotaMonthly')) $('quotaMonthly').value = cfg.monthly_gb || 0;
    if ($('quotaCost')) $('quotaCost').value = cfg.cost_per_gb || 0;

    var cur = cfg.currency || '';
    var gateTxt = r.enabled
      ? '<b style="color:var(--green)">闸门已启用</b>'
      : '<b style="color:var(--text3)">仅统计 (闸门关闭)</b>';
    host.innerHTML =
      gateTxt + ' · 今日 <b>' + esc(r.today_human) + '</b>' +
        (r.daily_limit_bytes ? ' / ' + (r.daily_limit_bytes / 1073741824).toFixed(0) + ' GB (剩 ' + esc(r.remain_today) + ')' : '') +
        (r.cost_per_gb ? ' · 估 ' + cur + r.today_cost : '') +
      ' · 本月 <b>' + esc(r.month_human) + '</b>' +
        (r.monthly_limit_bytes ? ' / ' + (r.monthly_limit_bytes / 1073741824).toFixed(0) + ' GB (剩 ' + esc(r.remain_month) + ')' : '') +
        (r.cost_per_gb ? ' · 估 ' + cur + r.month_cost : '');

    var bd = $('quotaByDay'), bu = $('quotaByUser');
    if (bd){
      var days = (r.by_day || []).slice(0, 14);
      bd.innerHTML = days.length
        ? '<div style="font-size:11px;color:var(--text3);margin-bottom:3px">近 ' + days.length + ' 天用量</div>' +
          '<div style="display:flex;align-items:flex-end;gap:3px;height:56px">' +
          days.slice().reverse().map(function(d){
            var max = Math.max.apply(null, days.map(function(x){ return x.bytes || 1; }));
            var h = Math.max(3, Math.round((d.bytes || 0) / max * 50));
            return '<div title="' + esc(d.day) + ' ' + esc(d.bytes_human) + '" style="width:16px;height:' + h +
                   'px;background:var(--cyan);border-radius:2px 2px 0 0;opacity:.85"></div>';
          }).join('') + '</div>' +
          '<div style="font-size:10px;color:var(--text3)">' + esc(days[days.length - 1].day) + ' → ' + esc(days[0].day) + '</div>'
        : '';
    }
    if (bu){
      var us = (r.by_user || []).slice(0, 8);
      bu.innerHTML = us.length
        ? '<table style="width:100%;font-size:11px;border-collapse:collapse"><tr style="color:var(--text3);text-align:left"><th style="padding:2px 6px">用户</th><th>30 天流量</th><th>次数</th></tr>' +
          us.map(function(u){
            return '<tr style="border-top:1px solid var(--line)"><td style="padding:2px 6px">uid ' + esc(u.user_id) + '</td><td>' +
                   esc(u.bytes_human) + '</td><td>' + esc(u.runs) + '</td></tr>';
          }).join('') + '</table>'
        : '';
    }
  }

  async function save(){
    var cfg = {
      enabled: gv('quotaEnabled') === '1',
      daily_gb: parseFloat(gv('quotaDaily') || '0') || 0,
      monthly_gb: parseFloat(gv('quotaMonthly') || '0') || 0,
      cost_per_gb: parseFloat(gv('quotaCost') || '0') || 0,
    };
    var r = await rpc('quota_config', { cfg: cfg });
    if (window.toast) toast(r.status === 'ok' ? '✓ ' + (r.msg || '已保存') : '✗ ' + (r.msg || '保存失败'),
                            r.status === 'ok' ? 'success' : 'err', 2800);
    refresh();
  }

  g.QuotaPanel = { refresh: refresh, save: save };
  document.addEventListener('DOMContentLoaded', function(){
    setTimeout(function(){
      if (typeof window.currentUser !== 'undefined' && window.currentUser) refresh();
    }, 2000);
  });
})(window);
