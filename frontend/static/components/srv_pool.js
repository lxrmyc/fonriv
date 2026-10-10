/* ============================================================================
 * srv_pool.js · v4.38.23
 * 远端服务器连接池：每个 (scope, side) 持有独立的 srvId + auth
 *  - 解决: getSrvAuth() 单 srv 的限制，支持远端-远端传输
 *  - 工厂: SrvPool.set(scope, side, srvId) / SrvPool.get(scope, side) / SrvPool.getAuth(scope, side)
 *  - 监听 srv 列表变化，更新所有 pane
 *  - v4.38.24 · 临时服务器：addTemp(srv) / removeTemp(id) 内存加入 + localStorage 持久化
 * ========================================================================== */
(function(){
  'use strict';

  // v4.38.23 · 全局 srv 列表缓存（从 window.serverList 或 ajax 拉取）
  var _srvList = [];
  var _pool = {};  // { 'scope|side': { srvId, host, port, user, auth_type, password, key, passphrase } }
  var _tempSrvs = [];  // v4.38.24 · 临时服务器（负数 id, localStorage 持久化）
  var _tempNextId = -1;

  // v4.38.24 · 加载临时服务器（localStorage 持久化 key: tri_temp_servers_v1）
  function _loadTemp(){
    try {
      var raw = localStorage.getItem('tri_temp_servers_v1');
      var arr = raw ? JSON.parse(raw) : [];
      _tempSrvs = Array.isArray(arr) ? arr : [];
      // 重新分配负数 id
      _tempNextId = -1;
      for (var i=0;i<_tempSrvs.length;i++){
        if (typeof _tempSrvs[i].srv_id !== 'number' || _tempSrvs[i].srv_id >= 0) _tempSrvs[i].srv_id = _tempNextId--;
      }
    } catch(e){ _tempSrvs = []; }
  }
  function _saveTemp(){
    // v5.34.0 P0: 临时服务器凭据仅存内存, 不落 localStorage (host/user 等非敏感信息可存)
    try {
      var sanitized = _tempSrvs.map(function(s){
        var o = {}; for (var k in s) o[k] = s[k];
        o.password=''; o.key=''; o.passphrase='';
        return o;
      });
      localStorage.setItem('tri_temp_servers_v1', JSON.stringify(sanitized));
    } catch(e){}
  }
  _loadTemp();

  // 默认本机 srv（id=0, host='127.0.0.1'）
  function _localSrv(){
    return { srv_id: 0, label: '本机', host: '127.0.0.1', port: 22, user: 'root', auth_type: 'pass', password: '', key: '', passphrase: '' };
  }

  function _key(scope, side){ return (scope||'-') + '|' + (side||'-'); }

  function _resolveSrv(srvId){
    if (!srvId || srvId === 0 || srvId === '0' || srvId === 'local') return _localSrv();
    // 先查已保存
    // v4.41.1 · 宽松比较: srvId 可能是数字或字符串 (持久化描述符), 统一 String 比较
    for (var i=0;i<_srvList.length;i++){
      if (String(_srvList[i].srv_id) === String(srvId) || String(_srvList[i].id) === String(srvId)) return _srvList[i];
    }
    // 再查临时
    for (var j=0;j<_tempSrvs.length;j++){
      if (String(_tempSrvs[j].srv_id) === String(srvId)) return _tempSrvs[j];
    }
    return _localSrv();
  }

  function set(scope, side, srvId){
    var k = _key(scope, side);
    var srv = _resolveSrv(srvId);
    _pool[k] = {
      srvId: srvId,
      host: srv.host,
      port: srv.port || 22,
      user: srv.user || 'root',
      auth_type: srv.auth_type || 'pass',
      password: srv.password || '',
      key: srv.key || '',
      passphrase: srv.passphrase || '',
    };
  }

  function get(scope, side){
    var k = _key(scope, side);
    if (_pool[k]) return _pool[k];
    // 默认：本机
    set(scope, side, 0);
    return _pool[k];
  }

  function getAuth(scope, side){
    var p = get(scope, side);
    return {
      host: p.host, port: p.port, user: p.user,
      auth_type: p.auth_type, password: p.password, key: p.key, passphrase: p.passphrase,
    };
  }

  function setSrvList(list){
    _srvList = list || [];
  }

  function getSrvList(){
    // v4.38.24 · 合并已保存 + 临时服务器返回（用于 transfer_tri 头部下拉）
    return _srvList.concat(_tempSrvs);
  }

  // v4.38.24 · 临时服务器：addTemp / removeTemp / getTemp
  function addTemp(srv){
    if (!srv || !srv.host) return null;
    var label0 = srv.label || (srv.host + ':' + (srv.port || 22));
    var newSrv = {
      srv_id: _tempNextId--,
      label: label0 + ' ⌚',
      host: srv.host,
      port: srv.port || 22,
      user: srv.user || 'root',
      auth_type: srv.auth_type || 'pass',
      password: srv.password || '',
      key: srv.key || '',
      passphrase: srv.passphrase || '',
      isTemp: true,
    };
    _tempSrvs.push(newSrv);
    _saveTemp();
    return newSrv;
  }
  function removeTemp(srvId){
    _tempSrvs = _tempSrvs.filter(function(s){ return s.srv_id !== srvId; });
    _saveTemp();
  }
  function getTempList(){
    return _tempSrvs.slice();
  }

  window.SrvPool = {
    set: set,
    get: get,
    getAuth: getAuth,
    setSrvList: setSrvList,
    getSrvList: getSrvList,
    addTemp: addTemp,
    removeTemp: removeTemp,
    getTempList: getTempList,
    _localSrv: _localSrv,
  };
})();
