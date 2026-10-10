/*
 * frontend/static/panels/toast.js · v3.4.0
 *
 * 结构占位模块示例（v3.4.0 · panels 拆分模板）
 * ----------------------------------------------------------------------
 * 抽出 app.js 里最独立、无外部依赖的 4 个 toast 函数：
 *   toast(msg, level, duration)
 *   toastOk / toastErr / toastWarn
 *
 * 这是 v3.4.0 拆分战役的"第一块砖"——展示：
 *   1) 通过 <script src="/static/panels/toast.js"> 前置加载
 *   2) 全局 window.toast/toastOk/toastErr/toastWarn 挂载
 *   3) app.js 里的旧定义改为兜底（若模块未加载才用）
 *   4) 后续 users.js / pve.js / lvm.js ... 按此模板继续拆
 *
 * 加载顺序（见 index.html）：
 *   panels/toast.js  → app.js  → downloads.js  → server-auth-panel.js
 */
(function(){
  if (typeof window === 'undefined') return;
  // 若已有更新版本，尊重
  if (window.__toastModuleLoaded) return;
  window.__toastModuleLoaded = 'v3.4.0';

  function toast(msg, level, duration){
    level = level || 'info';
    duration = duration || 3000;
    // v4.44.1 · FIX: 接入底部运行日志 dock —— toast 是全局消息主通道，
    //   此前 bldAppend 全前端零调用导致 dock 从未有过日志。级别映射:
    //   success→ok / info→info / warn→warn / error→err
    try {
      if (typeof bldAppend === 'function'){
        var _m = { success:'ok', info:'info', warn:'warn', error:'err' }[level] || 'info';
        bldAppend(msg, _m);
      }
    } catch(e){ /* dock 未就绪时静默 */ }
    var wrap = document.getElementById('toastWrap');
    if(!wrap){ try{ console.log('['+level+']', msg); }catch(e){} return; }
    var el = document.createElement('div');
    el.className = 'toast toast-' + level;
    el.textContent = msg;
    wrap.appendChild(el);
    setTimeout(function(){
      el.style.transition = 'opacity .3s, transform .3s';
      el.style.opacity = '0'; el.style.transform = 'translateX(20px)';
      setTimeout(function(){ if(el.parentNode) el.parentNode.removeChild(el); }, 350);
    }, duration);
  }
  function toastOk(m){ toast(m, 'success'); }
  function toastErr(m){ toast(m, 'error', 5000); }
  function toastWarn(m){ toast(m, 'warn', 4000); }

  window.toast = toast;
  window.toastOk = toastOk;
  window.toastErr = toastErr;
  window.toastWarn = toastWarn;
})();
