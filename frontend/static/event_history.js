/* v4.22.0 · 事件历史分页查询 */
(function(){
  'use strict';
  var STATE = { page:1, page_size:100, total:0, events:[] };

  function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":"&#39;"}[c]; }); }

  function fmtTs(t){
    var d = new Date(t * 1000);
    var pad = function(n){ return n<10 ? '0'+n : n; };
    return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())+' '
         + pad(d.getHours())+':'+pad(d.getMinutes())+':'+pad(d.getSeconds());
  }

  function _topicColor(t){
    if (!t) return '#8b949e';
    if (t.indexOf('audit.') === 0)    return '#e3b341';
    if (t.indexOf('flow.') === 0)     return '#79c0ff';
    if (t.indexOf('task.') === 0)     return '#7ee787';
    if (t.indexOf('storage.') === 0)  return '#a5d6ff';
    if (t.indexOf('download.') === 0) return '#a5d6ff';
    if (t.indexOf('system.') === 0)   return '#8b949e';
    if (t.indexOf('user.') === 0)     return '#ffa657';
    if (t.indexOf('pve.') === 0)      return '#d2a8ff';
    if (t.indexOf('platform.') === 0) return '#d2a8ff';
    if (t.indexOf('remote.') === 0)   return '#f0883e';
    if (t.indexOf('schedule.') === 0) return '#56d364';
    if (t.indexOf('retention.') === 0)return '#f85149';
    return '#c9d1d9';
  }

  function renderList(){
    var box = document.getElementById('evHistList');
    if (!box) return;
    if (!STATE.events.length){
      box.innerHTML = '<div style="color:var(--text3);text-align:center;padding:20px">无记录</div>';
      return;
    }
    var html = [];
    for (var i=0; i<STATE.events.length; i++){
      var e = STATE.events[i];
      var payload = e.payload ? JSON.stringify(e.payload) : '';
      if (payload.length > 200) payload = payload.slice(0, 200) + '…';
      html.push('<div class="ev-row" data-idx="' + i + '" style="padding:2px 4px;border-bottom:1px solid var(--border);white-space:pre-wrap;word-break:break-all;cursor:pointer" onclick="EventHistory.openDrawer(' + i + ')" title="点击查看详情">'
        + '<span style="color:var(--text3)">' + fmtTs(e.ts) + '</span> '
        + '<span style="color:' + _topicColor(e.topic) + ';font-weight:bold">' + esc(e.topic) + '</span> '
        + '<span style="color:var(--text2)">' + esc(payload) + '</span>'
        + '</div>');
    }
    box.innerHTML = html.join('');
  }

  // v4.25.0 · 事件详情侧边抽屉
  function openDrawer(idx){
    var e = STATE.events[idx];
    if (!e) return;
    var el = document.getElementById('evDrawer');
    if (!el){
      el = document.createElement('div');
      el.id = 'evDrawer';
      el.style.cssText = 'position:fixed;top:0;right:0;bottom:0;width:560px;max-width:90vw;background:var(--bg2);border-left:1px solid var(--border);box-shadow:-8px 0 24px rgba(0,0,0,0.35);z-index:10001;display:flex;flex-direction:column;transform:translateX(100%);transition:transform 0.2s ease';
      el.innerHTML =
        '<div style="padding:12px 16px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;background:var(--bg3)">'
        + '<span id="evDrawerTitle" style="font-weight:600;font-size:14px">事件详情</span>'
        + '<button onclick="EventHistory.closeDrawer()" style="background:none;border:none;color:var(--text2);font-size:20px;cursor:pointer">✕</button>'
        + '</div>'
        + '<div id="evDrawerBody" style="flex:1;overflow-y:auto;padding:14px 16px;font-size:12px"></div>'
        + '<div id="evDrawerFooter" style="padding:10px 16px;border-top:1px solid var(--border);background:var(--bg3);display:flex;gap:8px;flex-wrap:wrap"></div>';
      document.body.appendChild(el);
    }
    var payload = e.payload || {};
    var payloadStr = '';
    try { payloadStr = JSON.stringify(payload, null, 2); }
    catch(_){ payloadStr = String(payload); }

    var kv = [
      ['时间', fmtTs(e.ts)],
      ['Topic', esc(e.topic)],
      ['Event ID', e.id != null ? e.id : '-'],
    ];
    // 若 payload 里有 task_id / flow_id / host / status 等常用字段，也提取到顶栏
    var quick = ['task_id','flow_id','host','status','error','name','id','path','size'];
    for (var k=0; k<quick.length; k++){
      var v = payload[quick[k]];
      if (v !== undefined && v !== null && v !== '') kv.push([quick[k], String(v)]);
    }

    var kvHtml = kv.map(function(kv){
      return '<div style="display:flex;padding:3px 0;border-bottom:1px dashed var(--border)">'
        + '<span style="color:var(--text3);width:88px;flex-shrink:0">' + kv[0] + '</span>'
        + '<span style="color:var(--text);font-family:monospace;word-break:break-all">' + esc(kv[1]) + '</span>'
        + '</div>';
    }).join('');

    document.getElementById('evDrawerTitle').innerHTML =
      '<span style="color:' + _topicColor(e.topic) + '">●</span> ' + esc(e.topic);
    document.getElementById('evDrawerBody').innerHTML =
      '<div style="margin-bottom:12px">' + kvHtml + '</div>'
      + '<div style="color:var(--text3);margin-bottom:4px">📄 完整 payload</div>'
      + '<pre style="background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:10px;overflow:auto;max-height:50vh;font-size:11px;line-height:1.5;color:var(--text)">'
      + esc(payloadStr) + '</pre>'
      + '<div id="evDrawerContext" style="margin-top:12px">'
      +   '<div style="color:var(--text3);margin-bottom:4px">🔗 关联事件（±10 条 · 按 topic 前缀）</div>'
      +   '<div style="color:var(--text3);font-size:11px">加载中…</div>'
      + '</div>';

    // 底部动作
    var actions = [
      '<button class="btn btn-sm" onclick="EventHistory.copyPayload()">📋 复制 JSON</button>',
    ];
    if (payload.task_id){
      actions.push('<button class="btn btn-sm" onclick="EventHistory.showLogTail(\'' + esc(payload.task_id) + '\')">📜 日志尾</button>');
      actions.push('<button class="btn btn-sm" onclick="EventHistory._filterBy(\'task_id\',\'' + esc(payload.task_id) + '\')">🔎 同 task 事件</button>');
    }
    if (payload.flow_id){
      actions.push('<button class="btn btn-sm" onclick="EventHistory._filterBy(\'flow_id\',\'' + esc(payload.flow_id) + '\')">🔎 同 flow 事件</button>');
    }
    if (payload.host){
      actions.push('<button class="btn btn-sm" onclick="EventHistory._filterBy(\'host\',\'' + esc(payload.host) + '\')">🔎 同 host 事件</button>');
    }
    document.getElementById('evDrawerFooter').innerHTML = actions.join('');

    // 缓存当前 payload 供复制/上下文
    window.__evDrawerPayload = payloadStr;
    window.__evDrawerEvent = e;

    // 加载关联事件（前缀 topic 匹配，取当前 e.ts 前后各 10 条）
    var topicPrefix = String(e.topic || '').split('.')[0] + '.';
    window.send({
      /* v6.3.33 · FIX(全面审计): 后端**没有** event_history_query 这个动作, 真实动作是
         `event_log_query`(参数完全一致: topic_like/since_ts/until_ts/page/page_size)。
         此前发的是个不存在的名字 → 后端静默丢弃 → 事件抽屉里"关联事件"永远不显示
         (回调不触发, 既不报错也无空态文案)。 */
      action: 'event_log_query',
      topic_like: topicPrefix + '%',
      since_ts: e.ts - 3600,
      until_ts: e.ts + 3600,
      page: 1, page_size: 20,
    }, function(r){
      var ctxEl = document.getElementById('evDrawerContext');
      if (!ctxEl) return;
      if (!r || r.status !== 'ok'){
        ctxEl.innerHTML = '<div style="color:var(--red);font-size:11px">加载关联事件失败</div>';
        return;
      }
      var evs = r.events || [];
      var html = '<div style="color:var(--text3);margin-bottom:4px">🔗 关联事件（' + topicPrefix + '* · ±1h · 共 ' + evs.length + ' 条）</div>';
      if (!evs.length){
        html += '<div style="color:var(--text3);font-size:11px">无</div>';
      } else {
        html += '<div style="max-height:220px;overflow-y:auto;border:1px solid var(--border);border-radius:4px;background:var(--bg)">';
        evs.forEach(function(x){
          var isSelf = (x.id === e.id);
          html += '<div style="padding:3px 8px;border-bottom:1px solid var(--border);font-size:11px;'
            + (isSelf ? 'background:rgba(74,222,128,0.15);' : '')
            + '"><span style="color:var(--text3)">' + fmtTs(x.ts) + '</span> '
            + '<span style="color:' + _topicColor(x.topic) + '">' + esc(x.topic) + '</span>'
            + (isSelf ? ' <b style="color:var(--green)">← 当前</b>' : '')
            + '</div>';
        });
        html += '</div>';
      }
      ctxEl.innerHTML = html;
    });

    // 展开动画
    setTimeout(function(){ el.style.transform = 'translateX(0)'; }, 10);
  }
  function closeDrawer(){
    // v4.27.0 · 关抽屉时清理 tail -f 订阅
    try { if (_tailState && _tailState.taskId) _closeTail(); } catch(_){}
    var el = document.getElementById('evDrawer');
    if (el) el.style.transform = 'translateX(100%)';
  }
  function copyPayload(){
    var s = window.__evDrawerPayload || '';
    if (!s) return;
    if (navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(s).then(function(){
        if (window.toast) toast('已复制 payload','ok'); else alert('已复制');
      });
    } else {
      var ta = document.createElement('textarea');
      ta.value = s; document.body.appendChild(ta); ta.select();
      try{ document.execCommand('copy'); alert('已复制'); }catch(_){}
      ta.remove();
    }
  }
  function _filterBy(field, value){
    // 用 topic 输入框做粗过滤（保留原表单）
    var topicInp = document.getElementById('evHistTopic');
    if (topicInp) topicInp.value = ''; // 保留原 topic，转而用 FTS
    // 若有 FTS 输入框优先用
    var ftsInp = document.getElementById('evHistFts');
    if (ftsInp){
      ftsInp.value = value;
      closeDrawer();
      ftsSearch();
    } else {
      closeDrawer();
      alert('未找到 FTS 输入框，请在 FTS 里搜索: ' + value);
    }
  }

  function renderPager(){
    var p = document.getElementById('evHistPager');
    var total = STATE.total, size = STATE.page_size, cur = STATE.page;
    var pages = Math.max(1, Math.ceil(total / size));
    var html = '共 <b>' + total + '</b> 条 · 第 ' + cur + ' / ' + pages + ' 页 · ';
    if (cur > 1) html += '<button class="btn btn-sm" onclick="EventHistory.query(' + (cur-1) + ')">« 上一页</button> ';
    if (cur < pages) html += '<button class="btn btn-sm" onclick="EventHistory.query(' + (cur+1) + ')">下一页 »</button>';
    p.innerHTML = html;
  }

  function query(page){
    page = page || 1;
    var topic = document.getElementById('evHistTopic').value.trim();
    var since_sec = parseInt(document.getElementById('evHistSince').value, 10);
    var since_ts = since_sec > 0 ? (Date.now()/1000 - since_sec) : null;
    // 主题 LIKE：若不含 % 且非空，自动追加 %
    var topic_like = null;
    if (topic){
      topic_like = topic.indexOf('%') >= 0 ? topic
                 : (topic.slice(-1) === '.' ? topic + '%' : topic + '%');
    }
    var msg = { action:'event_log_query', page:page, page_size:STATE.page_size };
    if (topic_like) msg.topic_like = topic_like;
    if (since_ts != null) msg.since_ts = since_ts;
    document.getElementById('evHistSummary').textContent = '查询中…';
    window.send(msg, function(r){
      r = r || {};
      if (r.status !== 'ok'){
        document.getElementById('evHistSummary').textContent = '查询失败: ' + (r.msg||'');
        return;
      }
      STATE.page = r.page; STATE.total = r.total; STATE.events = r.events || [];
      document.getElementById('evHistSummary').textContent =
        '共 ' + r.total + ' 条 · 显示 ' + STATE.events.length + ' 条';
      renderList();
      renderPager();
    });
  }

  function exportCSV(){
    if (!STATE.events.length){ window.toast && toast('无数据可导出', 'warn'); return; }
    var lines = ['ts,topic,payload'];
    for (var i=0; i<STATE.events.length; i++){
      var e = STATE.events[i];
      var p = e.payload ? JSON.stringify(e.payload).replace(/"/g, '""') : '';
      lines.push('"' + fmtTs(e.ts) + '","' + e.topic + '","' + p + '"');
    }
    var blob = new Blob([lines.join('\n')], {type:'text/csv;charset=utf-8'});
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'event_history_' + Date.now() + '.csv';
    a.click();
  }

  async function ftsSearch(){
    var q = (document.getElementById('evHistFts') || {}).value;
    if (!q) q = await rpPrompt({ title:'全文搜索', hint:'在事件 payload 中搜索的关键字' });
    if (!q) return;
    var topic = document.getElementById('evHistTopic').value.trim();
    var since_sec = parseInt(document.getElementById('evHistSince').value, 10);
    var msg = { action:'event_log_fts_search', query:q, limit:200 };
    if (topic){
      msg.topic_like = topic.indexOf('%') >= 0 ? topic : (topic + '%');
    }
    if (since_sec > 0) msg.since_ts = Date.now()/1000 - since_sec;
    document.getElementById('evHistSummary').textContent = 'FTS 搜索中…';
    window.send(msg, function(r){
      r = r || {};
      if (r.status !== 'ok'){
        document.getElementById('evHistSummary').textContent = 'FTS 失败: ' + (r.msg||'');
        return;
      }
      STATE.page = 1; STATE.total = r.count; STATE.events = r.events || [];
      document.getElementById('evHistSummary').textContent =
        'FTS 命中 ' + r.count + ' 条（关键字：'+ q +'）';
      renderList();
      var p = document.getElementById('evHistPager');
      if (p) p.innerHTML = '（FTS 模式 · 无分页）';
    });
  }

  // v4.28.0 · 分级着色规则
  // 命中即整行套 class · 由 CSS 变量色驱动 · 保序：error > warn > success > info
  var _LEVEL_RULES = [
    { level:'error', color:'#ff6b6b',
      re: /\b(error|err|fail(ed|ure)?|fatal|panic|denied|refused|traceback|exception|no such|cannot|permission denied|connection (refused|reset|closed)|timed? ?out|abort(ed)?)\b/i },
    { level:'warn',  color:'#ffb454',
      re: /\b(warn(ing)?|deprecat(ed|ion)|retry(ing)?|skipp?ed|missing|not found|unable)\b/i },
    { level:'ok',    color:'#7ee787',
      re: /\b(success(ful|fully)?|complete[d]?|done|ok|✓|✔|finished|__DONE__ rc=0)\b/i },
    { level:'info',  color:'#79c0ff',
      re: /\b(executing|starting|开始|连接|执行命令|scanning|compress(ing)?|uploading)\b/i },
  ];
  function _classifyLine(line){
    if (line == null) return null;
    for (var i=0;i<_LEVEL_RULES.length;i++){
      if (_LEVEL_RULES[i].re.test(line)) return _LEVEL_RULES[i];
    }
    return null;
  }

  // v4.26.0 · 拉取 task_log 尾并在抽屉中央区展示
  // v4.27.0 · 升级为 tail -f · subscribe 后收到 task_log_push 增量追加
  // v4.28.0 · 分级着色 · 查看完整 db 日志
  var _tailState = { taskId:null, preEl:null, followEl:null, follow:true, onlyErr:false };
  function _tailAppendLine(line){
    if (!_tailState.preEl) return;
    // 允许 null（finished 标记）
    if (line == null) return;
    var rule = _classifyLine(line);
    var span = document.createElement('span');
    if (rule){
      span.style.color = rule.color;
      if (rule.level === 'error') span.style.fontWeight = '600';
      span.setAttribute('data-lvl', rule.level);
    } else {
      span.setAttribute('data-lvl', 'plain');
    }
    // v4.29.0 · 「只看错误」模式下即时隐藏非 error/warn 的新增行
    if (_tailState.onlyErr && !(rule && (rule.level === 'error' || rule.level === 'warn'))){
      span.style.display = 'none';
    }
    span.appendChild(document.createTextNode(line + '\n'));
    _tailState.preEl.appendChild(span);
    // 保留最多 ~2000 节点（避免抽屉卡）
    while (_tailState.preEl.childNodes.length > 2000){
      _tailState.preEl.removeChild(_tailState.preEl.firstChild);
    }
    if (_tailState.follow){
      _tailState.preEl.scrollTop = _tailState.preEl.scrollHeight;
    }
  }
  function _onLogPush(d){
    if (!_tailState.taskId || d.task_id !== _tailState.taskId) return;
    if (d.line != null) _tailAppendLine(d.line);
    if (d.finished){
      var h = document.getElementById('evDrawerLogTitle');
      if (h) h.innerHTML = (h.innerHTML || '') + ' <span style="color:var(--text3);font-size:10px">· 已结束</span>';
    }
  }
  function _closeTail(){
    var box = document.getElementById('evDrawerLogTail');
    if (box) box.remove();
    if (_tailState.taskId){
      try { window.send({ action:'task_log_unsubscribe', task_id:_tailState.taskId }); } catch(_){}
    }
    _tailState = { taskId:null, preEl:null, followEl:null, follow:true, onlyErr:false };
  }
  function _toggleOnlyErr(){
    _tailState.onlyErr = !_tailState.onlyErr;
    var btn = document.getElementById('evDrawerLogOnlyErr');
    if (btn){
      btn.textContent = _tailState.onlyErr ? '⚡ 显示全部' : '⚡ 只看错误';
      btn.style.background = _tailState.onlyErr ? 'var(--red)' : '';
      btn.style.color = _tailState.onlyErr ? '#fff' : '';
    }
    if (!_tailState.preEl) return;
    // 遍历所有 span · 依 data-lvl 决定 display
    var kids = _tailState.preEl.childNodes;
    var kept = 0, total = 0;
    for (var i=0;i<kids.length;i++){
      var n = kids[i];
      if (n.nodeType !== 1) continue;  // 只处理 element
      total++;
      var lvl = n.getAttribute && n.getAttribute('data-lvl');
      if (_tailState.onlyErr && !(lvl === 'error' || lvl === 'warn')){
        n.style.display = 'none';
      } else {
        n.style.display = '';
        kept++;
      }
    }
    // 计数提示（写到 title 上，避免污染主标题）
    var head = document.getElementById('evDrawerLogTitle');
    if (head){
      var mark = head.querySelector('[data-flt]');
      if (mark) mark.remove();
      if (_tailState.onlyErr){
        var m = document.createElement('span');
        m.setAttribute('data-flt','1');
        m.style.cssText = 'color:var(--red);font-weight:normal;font-size:10px;margin-left:6px';
        m.textContent = '· 已过滤 (' + kept + '/' + total + ')';
        head.appendChild(m);
      }
    }
    if (_tailState.follow) _tailState.preEl.scrollTop = _tailState.preEl.scrollHeight;
  }
  function _toggleFollow(){
    _tailState.follow = !_tailState.follow;
    var btn = document.getElementById('evDrawerLogFollow');
    if (btn) btn.textContent = _tailState.follow ? '⏸ 暂停跟随' : '▶ 继续跟随';
    if (_tailState.follow && _tailState.preEl){
      _tailState.preEl.scrollTop = _tailState.preEl.scrollHeight;
    }
  }
  function showLogTail(taskId){
    var body = document.getElementById('evDrawerBody');
    if (!body) return;
    // 若已开着同 task 直接聚焦、不同 task 则先关旧订阅
    if (_tailState.taskId && _tailState.taskId !== taskId){ _closeTail(); }
    var box = document.getElementById('evDrawerLogTail');
    if (!box){
      box = document.createElement('div');
      box.id = 'evDrawerLogTail';
      box.style.cssText = 'margin-bottom:14px;padding:8px;background:var(--bg);border:1px solid var(--border);border-radius:6px';
      body.insertBefore(box, body.firstChild);
    }
    box.innerHTML =
      '<div id="evDrawerLogHead" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">'
      + '<span id="evDrawerLogTitle" style="color:var(--cyan);font-weight:600">📜 tail -f · <span style="color:var(--text3);font-weight:normal">task_id=' + esc(taskId) + '</span></span>'
      + '<span>'
      + '<button class="btn btn-sm" id="evDrawerLogFollow" onclick="EventHistory._toggleFollow()">⏸ 暂停跟随</button> '
      + '<button class="btn btn-sm" id="evDrawerLogOnlyErr" onclick="EventHistory._toggleOnlyErr()" title="只保留 error/warn 行 · 再点还原">⚡ 只看错误</button> '
      + '<button class="btn btn-sm" onclick="EventHistory.showFullDbLog(\'' + esc(taskId) + '\')" title="拉取 tasks.log_output 全量落盘日志">📚 完整 db 日志</button> '
      + '<button class="btn btn-sm" onclick="EventHistory._copyLog()" title="复制日志">📋</button> '
      + '<button onclick="EventHistory._closeTail()" style="background:none;border:none;color:var(--text3);cursor:pointer;font-size:14px;margin-left:4px">✕</button>'
      + '</span></div>'
      + '<pre id="evDrawerLogPre" style="background:#0d1117;color:#c9d1d9;border-radius:4px;padding:10px;margin:0;'
      + 'overflow:auto;max-height:40vh;font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-all">加载中…</pre>';
    _tailState.taskId = taskId;
    _tailState.preEl = document.getElementById('evDrawerLogPre');
    _tailState.follow = true;
    // 订阅（返回 snapshot 用于首屏）
    window.send({ action:'task_log_subscribe', task_id: taskId }, function(r){
      if (!r || r.status !== 'ok'){
        if (_tailState.preEl){
          _tailState.preEl.textContent = '订阅失败：' + (r && r.msg || '未知错误');
        }
        return;
      }
      // 清掉「加载中…」
      if (_tailState.preEl) _tailState.preEl.textContent = '';
      window.__evDrawerLog = '';
      var lines = r.lines || [];
      for (var i=0;i<lines.length;i++){
        var ln = lines[i] && lines[i].line;
        if (ln != null){
          _tailAppendLine(ln);
          window.__evDrawerLog += (window.__evDrawerLog ? '\n' : '') + ln;
        }
      }
      if (r.finished){
        var h = document.getElementById('evDrawerLogTitle');
        if (h) h.innerHTML = (h.innerHTML || '') + ' <span style="color:var(--text3);font-size:10px">· 已结束</span>';
      }
    });
  }
  function _copyLog(){
    // v4.27.0 · 从 pre 元素实时抓，避免 tail -f 期间只复制首屏
    var s = '';
    if (_tailState.preEl){ s = _tailState.preEl.innerText || ''; }
    if (!s) s = window.__evDrawerLog || '';
    if (!s) return;
    if (navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(s).then(function(){
        if (window.toast) toast('已复制日志','ok'); else alert('已复制');
      });
    } else {
      var ta = document.createElement('textarea');
      ta.value = s; document.body.appendChild(ta); ta.select();
      try{ document.execCommand('copy'); alert('已复制'); }catch(_){}
      ta.remove();
    }
  }

  // v4.28.0 · 覆盖层弹出完整 db.log_output（tail=0 = 全量）
  function showFullDbLog(taskId){
    // 覆盖层 · 单例 · 复用同一 id
    var m = document.getElementById('evDbLogModal');
    if (m) m.remove();
    m = document.createElement('div');
    m.id = 'evDbLogModal';
    m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.65);z-index:10000;display:flex;align-items:center;justify-content:center;padding:24px';
    m.innerHTML =
      '<div style="background:var(--bg2);border:1px solid var(--border);border-radius:8px;width:min(1000px,92vw);max-height:88vh;display:flex;flex-direction:column;overflow:hidden">'
      + '<div style="padding:12px 14px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">'
      + '<span style="color:var(--cyan);font-weight:600">📚 完整 db 日志 · <span style="color:var(--text3);font-weight:normal;font-size:12px">task_id=' + esc(taskId) + '</span> <span id="evDbLogMeta" style="color:var(--text3);font-weight:normal;font-size:11px"></span></span>'
      + '<span>'
      + '<button class="btn btn-sm" onclick="EventHistory._copyFullDbLog()" title="复制">📋</button> '
      + '<button class="btn btn-sm" onclick="EventHistory._closeFullDbLog()">✕ 关闭</button>'
      + '</span></div>'
      + '<pre id="evDbLogPre" style="flex:1;margin:0;padding:12px;background:#0d1117;color:#c9d1d9;font-size:12px;line-height:1.5;overflow:auto;white-space:pre-wrap;word-break:break-all">加载中…</pre>'
      + '</div>';
    m.addEventListener('click', function(e){ if (e.target === m) _closeFullDbLog(); });
    document.body.appendChild(m);
    window.send({ action:'task_log_tail', task_id: taskId, tail: 0 }, function(r){
      var pre = document.getElementById('evDbLogPre');
      var meta = document.getElementById('evDbLogMeta');
      if (!pre) return;
      if (!r || r.status !== 'ok'){
        pre.textContent = '拉取失败：' + (r && r.msg || '未知错误');
        pre.style.color = 'var(--red)';
        return;
      }
      var log = r.log || '(空)';
      if (meta){
        meta.textContent = '· ' + (r.task_type || '') + ' · ' + (r.task_status || '')
          + ' · ' + (r.log_bytes || 0) + ' B · ' + (r.finished_at || r.started_at || '');
      }
      // 分级渲染
      pre.textContent = '';
      var arr = log.split(/\r?\n/);
      var frag = document.createDocumentFragment();
      for (var i=0;i<arr.length;i++){
        var ln = arr[i];
        var rule = _classifyLine(ln);
        var sp = document.createElement('span');
        if (rule){
          sp.style.color = rule.color;
          if (rule.level === 'error') sp.style.fontWeight = '600';
        }
        sp.appendChild(document.createTextNode(ln + '\n'));
        frag.appendChild(sp);
      }
      pre.appendChild(frag);
      window.__evDbFullLog = log;
    });
  }
  function _closeFullDbLog(){
    var m = document.getElementById('evDbLogModal');
    if (m) m.remove();
  }
  function _copyFullDbLog(){
    var s = window.__evDbFullLog || '';
    var pre = document.getElementById('evDbLogPre');
    if (pre) s = pre.innerText || s;
    if (!s) return;
    if (navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(s).then(function(){
        if (window.toast) toast('已复制','ok'); else alert('已复制');
      });
    } else {
      var ta = document.createElement('textarea');
      ta.value = s; document.body.appendChild(ta); ta.select();
      try{ document.execCommand('copy'); alert('已复制'); }catch(_){}
      ta.remove();
    }
  }

  window.EventHistory = { query:query, exportCSV:exportCSV, ftsSearch:ftsSearch,
    openDrawer:openDrawer, closeDrawer:closeDrawer, copyPayload:copyPayload, _filterBy:_filterBy,
    showLogTail:showLogTail, _copyLog:_copyLog,
    _onLogPush:_onLogPush, _closeTail:_closeTail, _toggleFollow:_toggleFollow,
    _toggleOnlyErr:_toggleOnlyErr,
    showFullDbLog:showFullDbLog, _closeFullDbLog:_closeFullDbLog, _copyFullDbLog:_copyFullDbLog,
    _classifyLine:_classifyLine };
})();
