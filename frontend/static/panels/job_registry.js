/* v5.21.0 · G4 任务注册表消费 (系统设置): /api/jobs/schema → 表格 + schema 自动渲染表单 + 试运行
 * 依赖 window.send / toast · 注册表真源 backend/core_fabric/job_registry.py
 * 设计文档: docs/Transfer-Fabric-统一方案-v2 · "前端表单由 schema 自动渲染"
 */
(function(g){
  'use strict';
  function $(id){ return document.getElementById(id); }
  function esc(s){ return String(s==null?'':String(s)).replace(/[&<>"']/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }

  var SCHEMA = null;   // action → {schema, page, desc, danger, feature}

  function token(){
    try { return localStorage.getItem('auth_token') || ''; } catch(e){ return ''; }
  }

  function load(force){
    var body = $('jrBody');
    if (!body) return;
    if (SCHEMA && !force){ render(); return; }
    body.innerHTML = '<span style="color:var(--text3)">⏳ 拉取 /api/jobs/schema …</span>';
    fetch('/api/jobs/schema', { headers: { 'X-Auth-Token': token() }, cache: 'no-store' })
      .then(function(r){ return r.ok ? r.json() : r.json().then(function(j){ throw new Error(j.detail || ('HTTP ' + r.status)); }); })
      .then(function(d){
        SCHEMA = d.jobs || {};
        render();
      })
      .catch(function(e){
        body.innerHTML = '<span style="color:var(--red)">✗ 拉取失败: ' + esc(e.message || e) + '</span>';
      });
  }

  function render(){
    var body = $('jrBody');
    var acts = Object.keys(SCHEMA).sort();
    var badge = $('jrCount');
    if (badge) badge.textContent = acts.length + ' 个任务';
    if (!acts.length){
      body.innerHTML = '<span style="color:var(--orange)">注册表为空 (0 个任务)</span>';
      return;
    }
    var rows = acts.map(function(a){
      var j = SCHEMA[a];
      var nFields = Object.keys(j.schema || {}).length;
      return '<tr>'
        + '<td><b style="font-family:monospace">' + esc(a) + '</b></td>'
        + '<td>' + esc(j.desc || '') + '</td>'
        + '<td>' + esc(j.page || '') + '</td>'
        + '<td>' + (j.danger ? '<span style="color:var(--red)">⚠ 危险</span>' : '<span style="color:var(--text3)">常规</span>') + '</td>'
        + '<td>' + nFields + '</td>'
        + '<td><button class="btn btn-sm" onclick="JobRegistry.tryRun(\'' + esc(a) + '\')">▶ 试运行</button></td>'
        + '</tr>';
    }).join('');
    body.innerHTML =
      '<div style="font-size:11px;color:var(--text3);margin-bottom:6px">共 ' + acts.length
      + ' 个注册任务 · 新增 action 只需一个 @register_job, 此处表单与调用自动可用</div>'
      + '<table class="user-table" style="width:100%;font-size:12px"><thead><tr>'
      + '<th>Action</th><th>说明</th><th>面板</th><th>风险</th><th>参数</th><th style="width:90px">操作</th>'
      + '</tr></thead><tbody>' + rows + '</tbody></table>'
      + '<div id="jrRunBox" style="display:none;margin-top:10px;border-top:1px dashed var(--border);padding-top:10px"></div>';
  }

  /* schema 类型 → 控件: string/path→text · int→number · bool→checkbox · select→下拉 · endpoint→kind+JSON */
  function fieldHtml(key, def){
    var t = def.type || 'string';
    var label = esc(def.label || key) + (def.required ? ' <span style="color:var(--red)">*</span>' : '');
    var id = 'jr_f_' + key;
    var ctrl;
    if (t === 'select'){
      var opts = (def.options || []).map(function(o){
        return '<option value="' + esc(o) + '"' + (String(def.default) === String(o) ? ' selected' : '') + '>' + esc(o) + '</option>';
      }).join('');
      ctrl = '<select id="' + id + '" class="input" style="width:100%">' + (def.required ? '' : '<option value="">(不填)</option>') + opts + '</select>';
    } else if (t === 'bool'){
      ctrl = '<select id="' + id + '" class="input" style="width:100%">'
           + '<option value=""' + (def.default ? '' : ' selected') + '>(不填)</option>'
           + '<option value="true">true</option><option value="false">false</option></select>';
    } else if (t === 'int'){
      ctrl = '<input id="' + id + '" class="input" style="width:100%" type="number"'
           + (def.min != null ? ' min="' + def.min + '"' : '') + (def.max != null ? ' max="' + def.max + '"' : '')
           + ' value="' + (def.default != null ? esc(def.default) : '') + '" placeholder="' + (def.min != null || def.max != null ? (def.min + '~' + def.max) : '整数') + '">';
    } else if (t === 'endpoint'){
      ctrl = '<input id="' + id + '" class="input" style="width:100%" placeholder=\'{"kind":"local","path":"/data"}\'>'
           + '<div style="font-size:11px;color:var(--text3);margin-top:2px">JSON 对象, 必含 kind</div>';
    } else {
      ctrl = '<input id="' + id + '" class="input" style="width:100%" placeholder="' + esc(def.placeholder || (def.default != null ? String(def.default) : '')) + '">';
    }
    return '<div style="margin-bottom:8px"><label style="font-size:12px;color:var(--text2)">' + label + '</label>' + ctrl + '</div>';
  }

  function collect(action){
    var j = SCHEMA[action], params = {}, missing = [];
    Object.keys(j.schema || {}).forEach(function(k){
      var el = $('jr_f_' + k);
      if (!el) return;
      var v = (el.value || '').trim();
      if (!v) { if (j.schema[k].required) missing.push(j.schema[k].label || k); return; }
      if (j.schema[k].type === 'int'){ v = parseInt(v, 10); if (isNaN(v)) v = 0; }
      if (j.schema[k].type === 'bool'){ v = (v === 'true'); }
      if (j.schema[k].type === 'endpoint'){
        try { v = JSON.parse(v); } catch(e){ missing.push((j.schema[k].label || k) + ' 不是合法 JSON'); return; }
      }
      params[k] = v;
    });
    return { params: params, missing: missing };
  }

  function tryRun(action){
    if (!SCHEMA) return;
    var j = SCHEMA[action];
    var box = $('jrRunBox');
    if (!box) return;
    box.style.display = 'block';
    var fields = Object.keys(j.schema || {}).map(function(k){ return fieldHtml(k, j.schema[k]); }).join('')
      || '<div style="font-size:12px;color:var(--text3);margin-bottom:8px">(无参数 — 直接运行)</div>';
    box.innerHTML =
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">'
      + '<b style="font-size:13px;font-family:monospace">' + esc(action) + '</b>'
      + '<span style="font-size:11px;color:var(--text3)">' + esc(j.desc || '') + '</span>'
      + '<span style="flex:1"></span>'
      + '<button class="btn btn-sm" onclick="JobRegistry.closeRun()">收起</button></div>'
      + fields
      + '<div style="display:flex;gap:8px;align-items:center">'
      + '<button class="btn btn-sm" id="jrDoRun" style="background:var(--blue,#2563eb);color:#fff">▶ 运行 ' + esc(action) + '</button>'
      + (j.danger ? '<span style="font-size:11px;color:var(--red)">⚠ 该任务标记为危险, 运行前会二次确认</span>' : '')
      + '</div>'
      + '<pre id="jrOut" style="margin-top:8px;max-height:260px;overflow:auto;font-size:11.5px;background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:8px;white-space:pre-wrap;color:var(--text2)">(结果将显示在这里)</pre>';
    $('jrDoRun').onclick = function(){ run(action); };
    box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function run(action){
    var j = SCHEMA[action];
    var c = collect(action);
    var out = $('jrOut');
    if (c.missing.length){
      out.textContent = '✗ 缺少必填/非法字段: ' + c.missing.join(', ');
      return;
    }
    var go = function(){
      out.textContent = '⏳ 已发送 ' + action + ' …';
      try {
        g.send(Object.assign({ action: action }, c.params), function(r){
          try {
            out.textContent = JSON.stringify(r, null, 2);
          } catch(e){ out.textContent = String(r); }
        });
      } catch(e){ out.textContent = '✗ ' + e; }
    };
    if (j.danger && g.confirm){
      g.confirm('⚠ 任务 ' + action + ' 标记为危险操作, 确定运行?') ? go() : (out.textContent = '(已取消)');
    } else go();
  }

  function closeRun(){
    var box = $('jrRunBox');
    if (box){ box.style.display = 'none'; box.innerHTML = ''; }
  }

  g.JobRegistry = { load: load, reload: function(){ load(true); }, tryRun: tryRun, closeRun: closeRun };

  document.addEventListener('DOMContentLoaded', function(){
    // 懒加载: 设置面板首次激活时拉取 (DOMContentLoaded 时刻用户多半尚未登录)
    var panel = document.getElementById('panel-settings');
    if (panel && 'MutationObserver' in window){
      new MutationObserver(function(muts){
        if (panel.classList.contains('active') && !SCHEMA) load();
      }).observe(panel, { attributes: true, attributeFilter: ['class'] });
    }
    setTimeout(function(){
      try { if (!SCHEMA && typeof window.currentUser !== 'undefined' && window.currentUser) load(); } catch(e){}
    }, 3000);
  });
})(window);
