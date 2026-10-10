/* v4.16.0 · EventBus · WebSocket 事件订阅前端总线
 *
 * 用法：
 *   EventBus.on('flow.updated', function(payload){ ... });
 *   EventBus.on('flow.*',      function(topic, payload){ ... });
 *   EventBus.off(handler);
 *
 * 内部：
 *   · 首次 on 时通过 rpc('subscribe', {topic}) 通知后端
 *   · 后端 push type=event → app.js 的 eventTap → EventBus._dispatch
 *   · WS 重连时 app.js 触发 EventBus._resubscribe 重放所有主题
 */
(function(){
  'use strict';

  // topic → [handler, ...]
  var _handlers = Object.create(null);
  // topic → 已通知后端订阅
  var _subscribed = Object.create(null);

  function _rpc(action, data){
    return new Promise(function(resolve){
      try { window.send(Object.assign({action:action}, data||{}), resolve); }
      catch(e){ resolve({status:'err', msg:String(e)}); }
    });
  }

  function _topicMatches(sub, actual){
    // fnmatch: * 匹配任意（不含点也可含点）
    if (sub === actual) return true;
    if (sub.indexOf('*') < 0 && sub.indexOf('?') < 0) return false;
    var re = '^' + sub.replace(/[.+^${}()|[\]\\]/g, '\\$&')
                       .replace(/\*/g, '.*')
                       .replace(/\?/g, '.') + '$';
    return new RegExp(re).test(actual);
  }

  /* v6.11.0 · 批11: off→unsubscribe 加 1.5s 防抖。
     实测操作日志里「订阅主题」刷了 1000+ 条 —— 页面重渲染常见的 off(旧 handler)+on(新 handler)
     成对抖动, 每次都真发一轮 subscribe/unsubscribe WS 往返; 防抖后窗口内重订阅直接复用
     (后端订阅保持, 前端语义不变: 无 handler 的 topic 不派发)。 */
  var _offTimers = Object.create(null);

  function on(topic, fn){
    if (!topic || typeof fn !== 'function') return;
    (_handlers[topic] = _handlers[topic] || []).push(fn);
    if (_offTimers[topic]){            // 防抖窗口内重新注册 → 取消退订, 无需重新订阅
      clearTimeout(_offTimers[topic]);
      delete _offTimers[topic];
      _subscribed[topic] = true;
      return;
    }
    if (!_subscribed[topic]){
      _subscribed[topic] = true;
      _rpc('subscribe', {topic: topic}).then(function(r){
        if (!r || r.status !== 'ok'){
          console.warn('[EventBus] subscribe fail', topic, r);
        }
      });
    }
  }

  function off(fn){
    // 简单 API：按 handler 引用移除；如果一个 topic 无 handler 就**延迟**退订(防抖)
    Object.keys(_handlers).forEach(function(t){
      var arr = _handlers[t];
      var idx = arr.indexOf(fn);
      if (idx >= 0) arr.splice(idx, 1);
      if (!arr.length){
        delete _handlers[t];
        if (_subscribed[t] && !_offTimers[t]){
          delete _subscribed[t];
          _offTimers[t] = setTimeout(function(){
            delete _offTimers[t];
            if (!_handlers[t]){        // 窗口内没有重新注册 → 真的退订
              _rpc('unsubscribe', {topic: t});
            }
          }, 1500);
        }
      }
    });
  }

  function _dispatch(topic, payload){
    _noteSeq(payload);   // v5.51.0 · 记录游标, 供断线补拉
    Object.keys(_handlers).forEach(function(sub){
      if (_topicMatches(sub, topic)){
        _handlers[sub].forEach(function(fn){
          try {
            // 通配符 handler 传 (topic, payload)；精确 handler 传 (payload)
            if (sub.indexOf('*') >= 0 || sub.indexOf('?') >= 0){
              fn(topic, payload);
            } else {
              fn(payload);
            }
          } catch(e){ console.warn('[EventBus] handler err', sub, e); }
        });
      }
    });
  }

  function _resubscribe(){
    // WS 重连时把所有 topic 重新订阅一遍
    Object.keys(_subscribed).forEach(function(t){
      _rpc('subscribe', {topic: t});
    });
  }

  /* v5.51.0 · P1-7 断线补偿
   *   每个事件信封带 seq (后端 events.py 单调递增) → 记录 last_seq;
   *   重连后调 events_replay{since_seq} 把错过的变更补发一遍, 页面不再停在旧状态。 */
  var _lastSeq = 0;
  var _replaying = false;

  function _noteSeq(payload){
    try {
      var s = payload && payload.seq;
      if (typeof s === 'number' && s > _lastSeq) _lastSeq = s;
    } catch(e){}
  }

  function _replay(){
    if (_replaying) return Promise.resolve({skipped: true});
    _replaying = true;
    return _rpc('events_replay', {since_seq: _lastSeq, limit: 500}).then(function(r){
      _replaying = false;
      if (!r || r.status !== 'ok'){ console.warn('[EventBus] replay fail', r); return r; }
      var evs = r.events || [];
      if (typeof r.seq === 'number' && r.seq > _lastSeq) _lastSeq = r.seq;
      evs.forEach(function(e){
        if (e && e.topic) _dispatch(e.topic, e.payload);
      });
      if (evs.length) console.log('[EventBus] 断线补拉 ' + evs.length + ' 条事件 (seq ' + _lastSeq + ')');
      return {replayed: evs.length, seq: _lastSeq};
    }).catch(function(e){ _replaying = false; console.warn('[EventBus] replay err', e); });
  }

  function _seq(){ return _lastSeq; }

  window.EventBus = {
    on: on,
    off: off,
    _dispatch: _dispatch,
    _resubscribe: _resubscribe,
    _replay: _replay,        // v5.51.0 · P1-7 断线补拉 (app.js 重连后调用)
    _lastSeq: _seq,
    _debug: function(){
      return {
        topics: Object.keys(_handlers),
        subscribed: Object.keys(_subscribed),
        counts: Object.keys(_handlers).reduce(function(o,t){ o[t]=_handlers[t].length; return o; }, {})
      };
    }
  };
})();
