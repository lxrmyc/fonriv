// v4.15.24 · Scope 标签规则前端模块
(function(g){
  'use strict';

  var DEFAULTS = [
    ['vzdump备份', 'vzdump'],
    ['PVE备份',    'pve,proxmox,qm-,vm备份,虚拟机'],
    ['LVM快照',    'lvm,逻辑卷,vgs,lvs'],
    ['数据库备份', 'mysql,mariadb,postgres,数据库'],
    ['归档打包',   'archive,归档,tar,zst']
  ];

  var STATE = { rows: [] };  // [[tag, kws], ...]

  function rpc(action, data){
    return new Promise(function(resolve){
      try { window.send(Object.assign({action: action}, data || {}), function(r){ resolve(r || {}); }); }
      catch(e){ resolve({status: 'error', msg: String(e)}); }
    });
  }

  function esc(s){
    return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  function _msg(text, isErr){
    var el = document.getElementById('scopeRulesMsg');
    if (!el) return;
    el.textContent = text || '';
    el.style.color = isErr ? 'var(--red)' : 'var(--text3)';
  }

  function _render(){
    var host = document.getElementById('scopeRulesList');
    if (!host) return;
    if (!STATE.rows.length){
      host.innerHTML = '<div style="color:var(--text3);font-size:12px">（无规则 · 将用内置默认）</div>';
      return;
    }
    host.innerHTML = STATE.rows.map(function(r, idx){
      var tag = r[0] || '';
      var kws = r[1] || '';
      return '<div style="display:grid;grid-template-columns:32px 200px 1fr 90px;gap:6px;align-items:center">'
        +   '<div style="text-align:center;color:var(--text3);font-size:11px">#'+(idx+1)+'</div>'
        +   '<input type="text" class="rm-input" value="'+esc(tag)+'" placeholder="标签名 · 如 PVE备份" '
        +        'oninput="ScopeRules._onInput('+idx+',0,this.value)">'
        +   '<input type="text" class="rm-input" value="'+esc(kws)+'" placeholder="关键字（逗号分隔） · 如 pve,proxmox,qm-" '
        +        'oninput="ScopeRules._onInput('+idx+',1,this.value)">'
        +   '<div style="display:flex;gap:2px">'
        +     '<button class="btn btn-sm" title="上移" onclick="ScopeRules.move('+idx+',-1)"'
        +        (idx===0?' disabled':'')+'>▲</button>'
        +     '<button class="btn btn-sm" title="下移" onclick="ScopeRules.move('+idx+',1)"'
        +        (idx===STATE.rows.length-1?' disabled':'')+'>▼</button>'
        +     '<button class="btn btn-sm" title="删除" style="background:var(--red);color:#fff" '
        +        'onclick="ScopeRules.remove('+idx+')">✖</button>'
        +   '</div>'
        + '</div>';
    }).join('');
  }

  function _onInput(idx, col, val){
    if (!STATE.rows[idx]) return;
    STATE.rows[idx][col] = val;
  }

  async function load(){
    try {
      var r = await rpc('setting_get', {key: 'scope_tag_rules'});
      var raw = (r && r.settings && r.settings.scope_tag_rules) || '';
      var parsed = null;
      if (raw){
        try { parsed = JSON.parse(raw); } catch(e){ parsed = null; }
      }
      if (Array.isArray(parsed) && parsed.every(function(x){ return Array.isArray(x) && x.length>=2; })){
        STATE.rows = parsed.map(function(x){ return [String(x[0]||''), String(x[1]||'')]; });
      } else {
        STATE.rows = DEFAULTS.map(function(x){ return x.slice(); });
      }
      _render();
      _msg('已加载 · 共 '+STATE.rows.length+' 条规则', false);
    } catch(e){
      _msg('加载失败: '+e, true);
    }
  }

  async function save(){
    // 过滤空行
    var cleaned = STATE.rows
      .map(function(r){ return [String(r[0]||'').trim(), String(r[1]||'').trim()]; })
      .filter(function(r){ return r[0] && r[1]; });
    if (!cleaned.length){
      if (!(await rpConfirm({ title:'保存空规则', okText:'继续', body:'规则为空，保存后将使用内置默认。继续？' }))) return;
    }
    try {
      var payload = cleaned.length ? JSON.stringify(cleaned) : '';
      var r = await rpc('setting_set', {key:'scope_tag_rules', value: payload});
      if (r && r.status === 'ok'){
        _msg('✓ 已保存 '+cleaned.length+' 条规则（下次 flow 运行生效）', false);
        STATE.rows = cleaned;
        _render();
      } else {
        _msg('保存失败: '+(r && r.msg || '未知错误'), true);
      }
    } catch(e){
      _msg('保存失败: '+e, true);
    }
  }

  async function reset(){
    if (!(await rpConfirm({ title:'恢复内置默认规则？', danger:true, okText:'恢复默认', body:'未保存的修改将丢失。' }))) return;
    STATE.rows = DEFAULTS.map(function(x){ return x.slice(); });
    _render();
    _msg('已恢复默认 · 记得点『💾 保存规则』写入', false);
  }

  function addRow(){
    STATE.rows.push(['', '']);
    _render();
  }

  function remove(idx){
    STATE.rows.splice(idx, 1);
    _render();
  }

  function move(idx, delta){
    var j = idx + delta;
    if (j < 0 || j >= STATE.rows.length) return;
    var t = STATE.rows[idx];
    STATE.rows[idx] = STATE.rows[j];
    STATE.rows[j] = t;
    _render();
  }

  g.ScopeRules = {
    load: load, save: save, reset: reset,
    addRow: addRow, remove: remove, move: move,
    _onInput: _onInput
  };

  // 切到 settings tab 时懒加载
  try {
    document.addEventListener('tab-switched', function(e){
      if (e && e.detail && e.detail.tab === 'settings'){
        load();
      }
    });
  } catch(e){ /* ignore */ }
})(window);
