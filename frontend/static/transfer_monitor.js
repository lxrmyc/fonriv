/* v5.37.0 · 统一传输监控 (TransferMonitor)
 * 数据源: 后端 transfer.progress 事件总线 (ws.py 拦截全部 56 处 progress 广播)
 * 职责:
 *   ① 会话聚合: 所有页面/用户的传输按 action+req 聚成会话 (名称/进度/速度/文件)
 *   ② 统一喂养 recordSpeed → 侧栏速度/累计 (替代原先 6 处分散上报)
 *   ③ 左侧「📦 传输监控」会话列表渲染 (#tmSessions)
 *   ④ 核心 run 况完整版: TransferMonitor.summary() 供 core_status 渲染
 * 会话生命周期: 8s 无新事件 → 结束; 再 30s → 移除
 */
(function(g){
'use strict';
function $id(x){ return document.getElementById(x); }

const ACTION_NAMES = {
  rsync_start:'文件传输', rsync:'文件传输', transfer:'文件传输',
  vzdump_start:'PVE 备份', vzdump:'PVE 备份', pve_backup:'PVE 备份',
  auto_backup:'一键备份', batch_backup:'批量备份',
  platform_execute_backup:'平台备份',
  remote_upload:'云上传', remote_download:'云下载', remote_transfer:'云端传输',
  docker_backup:'容器备份', db_backup:'数据库备份', dbbackup:'数据库备份',
  restic_backup:'Restic 备份', lvm_export:'LVM 导出', zfs_export:'ZFS 导出',
  rbd_export:'RBD 导出', pbs_backup:'PBS 备份', flow:'跨模块流程',
  auto_restore:'备份恢复', auto_restore_browse:'恢复浏览'
};
function actionName(a){
  if(!a) return '传输';
  if(ACTION_NAMES[a]) return ACTION_NAMES[a];
  for (var k in ACTION_NAMES){ if(a.indexOf(k)===0) return ACTION_NAMES[k]; }
  return a.length>18 ? a.slice(0,18)+'…' : a;
}

let _sessions = {};      // key → {name, user, pct, speed, file, text, ts, startedAt}
let _timer = null;
const IDLE_END = 8000, REMOVE_AFTER = 38000;

function _keyOf(d){
  return (d.action||'?') + '|' + (d.task_id || d.req_id || d._req_id || '');
}
function fmtSpeed(s){
  if(!s) return '';
  return String(s).replace(/\s+/g,' ');
}
function _render(){
  const el = $id('tmSessions');
  if(el) el.innerHTML = _html();
  const cEl = $id('tmCount');
  if(cEl) cEl.textContent = active().length || '';
}
function _html(){
  const act = active();
  const done = _doneList();
  if(!act.length && !done.length){
    /* v1.0.0 · i18n: 渲染时就翻译(此块由 WS 事件周期性重绘, 等 DOM 兜底会闪一帧中文) */
    return '<div style="font-size:10px;color:var(--text3);padding:2px 0">' +
      ((typeof window.t === 'function') ? window.t('暂无传输会话') : '暂无传输会话') + '</div>';
  }
  let h = '';
  act.forEach(function(s){
    h += '<div style="margin-bottom:6px">'
      + '<div style="display:flex;align-items:center;gap:4px;font-size:11px">'
      + '<span style="color:var(--cyan);flex-shrink:0">▶</span>'
      + '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text)" title="'+String(s.name).replace(/"/g,'')+'">'+String(s.name).replace(/</g,'&lt;')+'</span>'
      + '<span style="color:var(--cyan);font-size:10.5px;flex-shrink:0">'+(s.speed||'')+'</span></div>'
      + '<div style="height:3px;background:var(--bg3);border-radius:2px;overflow:hidden;margin:2px 0">'
      + '<div style="height:100%;background:var(--cyan);width:'+(s.pct||0)+'%;transition:width .4s"></div></div>'
      + '<div style="display:flex;justify-content:space-between;font-size:9.5px;color:var(--text3)">'
      + '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+String(s.file||s.text||'').replace(/"/g,'')+'">'+String(s.file||s.text||'').replace(/</g,'&lt;')+'</span>'
      + '<span style="flex-shrink:0">'+Math.round(s.pct||0)+'%</span></div></div>';
  });
  done.forEach(function(s){
    h += '<div style="display:flex;align-items:center;gap:4px;font-size:10.5px;color:var(--text3);margin-bottom:3px">'
      + '<span style="color:'+(s.pct>=100?'var(--green)':'var(--yellow)') + '">✔</span>'
      + '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+String(s.name).split('<').join('&lt;')+'</span>'
      + '<span>'+Math.round(s.pct||0)+'%</span></div>';
  });
  return h;
}
function active(){
  const now = Date.now();
  return Object.values(_sessions).filter(function(s){ return now - s.ts < IDLE_END; });
}
function _doneList(){
  const now = Date.now();
  return Object.values(_sessions).filter(function(s){
    return now - s.ts >= IDLE_END && now - s.ts < REMOVE_AFTER;
  });
}

function onProgress(d){
  // ① 统一喂养侧栏速度/累计 (全站唯一入口)
  if(d.speed && typeof g.recordSpeed === 'function'){
    try { g.recordSpeed(d.speed); } catch(e){}
  }
  // ② 会话聚合
  const k = _keyOf(d);
  const now = Date.now();
  if(!_sessions[k]) _sessions[k] = { startedAt: now };
  const s = _sessions[k];
  s.name = actionName(d.action) + (d.user && d.user !== (g.currentUser && g.currentUser.username) ? ' · ' + d.user : '');
  s.user = d.user || '';
  s.pct = (typeof d.pct === 'number') ? d.pct : (parseFloat(d.pct) || s.pct || 0);
  s.speed = d.speed || s.speed || '';
  s.file = d.file || s.file || '';
  s.text = d.text || s.text || '';
  s.ts = now;
  // 清理过期会话
  Object.keys(_sessions).forEach(function(kk){
    if(now - _sessions[kk].ts > REMOVE_AFTER) delete _sessions[kk];
  });
  _render();
}

function summary(){
  return { active: active(), done: _doneList(),
           total: Object.keys(_sessions).length };
}

function hook(){
  const EB = g.EventBus;
  if(!EB || EB.__tmHooked) return;
  EB.__tmHooked = true;
  EB.on('transfer.progress', onProgress);
  if(_timer) clearInterval(_timer);
  _timer = setInterval(_render, 2000);
}

g.TransferMonitor = { summary: summary, hook: hook, onProgress: onProgress,
                      get sessions(){ return _sessions; } };
document.addEventListener('DOMContentLoaded', function(){
  setTimeout(hook, 1600);
});
})(window);
