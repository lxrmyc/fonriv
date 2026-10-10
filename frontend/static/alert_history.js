/* v4.23.0 · 告警历史前端 */
(function(){
  'use strict';
  var STATE = { page: 1, page_size: 30, total: 0 };

  function rpc(action, data){
    return new Promise(function(resolve){
      try { window.send(Object.assign({action:action}, data||{}), function(r){ resolve(r||{}); }); }
      catch(e){ resolve({status:'error', msg:String(e)}); }
    });
  }
  function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":"&#39;"}[c]; }); }
  function fmtTs(ts){
    try { var d = new Date(ts * 1000);
      return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')
        +' '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0')+':'+String(d.getSeconds()).padStart(2,'0');
    } catch(e){ return String(ts); }
  }

  function render(items){
    var tb = document.getElementById('alertHistoryTableBody');
    if (!tb) return;
    if (!items.length){
      tb.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text3);padding:14px">无匹配记录</td></tr>';
      return;
    }
    tb.innerHTML = items.map(function(r){
      var stColor = r.status==='ok' ? 'var(--green)' : 'var(--red)';
      var stTxt = r.status==='ok' ? '✓ 成功' : '✗ 失败';
      return '<tr>'
        + '<td style="color:var(--text3)">'+fmtTs(r.ts)+'</td>'
        + '<td>'+esc(r.rule_name)+'</td>'
        + '<td><code>'+esc(r.topic)+'</code></td>'
        + '<td>'+esc(r.channel)+'</td>'
        + '<td style="color:'+stColor+'">'+stTxt+'</td>'
        + '<td style="color:var(--text3)" title="'+esc(r.err_msg)+'">'+esc((r.err_msg||'').slice(0,60))+'</td>'
        + '</tr>';
    }).join('');
    var info = document.getElementById('ahPageInfo');
    if (info) info.textContent = STATE.page + ' / ' + Math.max(1, Math.ceil(STATE.total / STATE.page_size));
    var tot = document.getElementById('ahTotal');
    if (tot) tot.textContent = '共 ' + STATE.total + ' 条';
  }

  var AlertHistory = {
    async reload(){
      var rn = document.getElementById('ahRuleName');
      var st = document.getElementById('ahStatus');
      var params = { page: STATE.page, page_size: STATE.page_size };
      if (rn && rn.value.trim()) params.rule_name = rn.value.trim();
      if (st && st.value.trim()) params.status    = st.value.trim();
      var r = await rpc('alert_history_query', params);
      if (r.status !== 'ok'){ toast && toast('查询失败: '+(r.msg||''), 'err'); return; }
      STATE.total = r.total || 0;
      render(r.items || []);
    },
    prev(){ if (STATE.page > 1){ STATE.page--; this.reload(); } },
    next(){
      var maxPage = Math.max(1, Math.ceil(STATE.total / STATE.page_size));
      if (STATE.page < maxPage){ STATE.page++; this.reload(); }
    },
    async purge(){
      if (!(await rpConfirm({ title:'清理告警历史', danger:true, okText:'删除', body:'删除 30 天前的告警历史？' }))) return;
      var r = await rpc('alert_history_purge', {older_than_days: 30});
      toast && toast(r.status==='ok' ? ('已清理 '+r.purged+' 条') : ('失败: '+(r.msg||'')),
                     r.status==='ok'?'ok':'err');
      this.reload();
    },
  };
  window.AlertHistory = AlertHistory;
})();
