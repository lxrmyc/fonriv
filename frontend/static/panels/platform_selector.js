/*
 * frontend/static/panels/platform_selector.js · v4.0.0-alpha1
 *
 * 平台适配层前端 helper（不改现有 UI，只增加一组全局函数）。
 * 供未来的通用一键备份面板 / auto_backup.js 徽章 调用。
 *
 * 暴露到 window：
 *   PlatformSelector.list(cb)                   -> action=platform_list
 *   PlatformSelector.detect(auth, cb)           -> action=platform_detect
 *   PlatformSelector.badge(el, info)            -> 渲染 <span class="platform-badge">
 *   PlatformSelector.PLATFORMS                  -> 静态元数据缓存（首次 list 后填充）
 *
 * 依赖 (app.js 全局)：send / upgradeAuthToEC1
 */
(function(){
  if (typeof window === 'undefined') return;
  if (window.PlatformSelector) return;

  var _cache = null;    // platform_list 结果缓存
  var _cacheTs = 0;
  var CACHE_MS = 60 * 1000;

  function list(cb){
    var now = Date.now();
    if (_cache && (now - _cacheTs) < CACHE_MS){
      cb && cb({ status:'ok', platforms:_cache, cached:true });
      return;
    }
    send({ action:'platform_list' }, function(d){
      if (d && d.status === 'ok' && Array.isArray(d.platforms)){
        _cache = d.platforms;
        _cacheTs = Date.now();
      }
      cb && cb(d);
    });
  }

  // auth: {host, port, user, auth_type, password, key, passphrase}
  // opts: {with_workloads:bool}
  async function detect(auth, cb, opts){
    opts = opts || {};
    if (!auth || !auth.host){
      cb && cb({ status:'error', msg:'缺少主机地址' });
      return;
    }
    var upgraded = auth;
    try { upgraded = await upgradeAuthToEC1(auth); }
    catch (e){ /* upgradeAuthToEC1 失败静默降级，保持原 auth */ }
    var payload = {
      action: 'platform_detect',
      host: auth.host,
      port: auth.port || '22',
      user: auth.user || 'root',
      auth_type: upgraded.auth_type,
      password: upgraded.password,
      key: upgraded.key,
      passphrase: upgraded.passphrase,
      with_workloads: !!opts.with_workloads,
    };
    send(payload, function(d){ cb && cb(d); });
  }

  // 把 info（platform_detect 的 result 或 {name,display,icon,notes}）渲染成徽章
  function badge(el, info){
    if (!el) return;
    if (!info){ el.textContent = ''; el.className='platform-badge platform-badge--empty'; return; }
    var icon = info.icon || '🐧';
    var display = info.display || info.name || '未知平台';
    var conf = (typeof info.confidence === 'number') ? (' · ' + info.confidence + '%') : '';
    el.textContent = icon + ' ' + display + conf;
    el.className = 'platform-badge platform-badge--' + (info.platform || info.name || 'generic');
    el.title = info.notes || '';
  }

  // auth: {host, port, user, ...}
  // opts: {platform?:string, selected_keys?:string[]}
  async function planBackup(auth, cb, opts){
    opts = opts || {};
    if (!auth || !auth.host){
      cb && cb({ status:'error', msg:'缺少主机地址' });
      return;
    }
    var upgraded = auth;
    try { upgraded = await upgradeAuthToEC1(auth); } catch (e){}
    var payload = {
      action: 'platform_plan_backup',
      host: auth.host,
      port: auth.port || '22',
      user: auth.user || 'root',
      auth_type: upgraded.auth_type,
      password: upgraded.password,
      key: upgraded.key,
      passphrase: upgraded.passphrase,
    };
    if (opts.platform) payload.platform = opts.platform;
    if (opts.selected_keys) payload.selected_keys = opts.selected_keys;
    send(payload, function(d){ cb && cb(d); });
  }

  // opts: {platform?, selected_keys?, compressor?, local_dir?, label?}
  async function executeBackup(auth, cb, opts){
    opts = opts || {};
    if (!auth || !auth.host){
      cb && cb({ status:'error', msg:'缺少主机地址' });
      return;
    }
    var upgraded = auth;
    try { upgraded = await upgradeAuthToEC1(auth); } catch (e){}
    var payload = {
      action: 'platform_execute_backup',
      host: auth.host, port: auth.port || '22', user: auth.user || 'root',
      auth_type: upgraded.auth_type,
      password: upgraded.password,
      key: upgraded.key,
      passphrase: upgraded.passphrase,
    };
    ['platform','selected_keys','compressor','local_dir','label'].forEach(function(k){
      if (opts[k] != null) payload[k] = opts[k];
    });
    // v4.0.0-alpha5: streamMode=true 让进度事件流经全局 addLog
    send(payload, function(d){ cb && cb(d); }, true);
  }

  window.PlatformSelector = {
    list: list,
    detect: detect,
    planBackup: planBackup,
    executeBackup: executeBackup,
    badge: badge,
    get PLATFORMS(){ return _cache || []; },
    _clearCache: function(){ _cache = null; _cacheTs = 0; },
    __version: 'v4.0.0-alpha4'
  };
})();
