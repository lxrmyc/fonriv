/* v4.22.0 · 告警管道前端（Webhook + SMTP 邮件）*/
(function(){
  'use strict';
  var STATE = { rules: [], smtp: null };

  function rpc(action, data){
    return new Promise(function(resolve){
      try { window.send(Object.assign({action:action}, data||{}), function(r){ resolve(r||{}); }); }
      catch(e){ resolve({status:'error', msg:String(e)}); }
    });
  }

  function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":"&#39;"}[c]; }); }

  function _renderRow(r, idx){
    var typ = r.type || 'webhook';
    var tmpl = r.template || 'generic';
    var isWebhook = typ !== 'email';
    return '<tr data-idx="'+idx+'">'
      + '<td><input class="rm-input" value="'+esc(r.name)+'" data-fld="name" style="width:100%"></td>'
      + '<td><input class="rm-input" value="'+esc(r.topic)+'" data-fld="topic" placeholder="flow.* / watch.* / sync.conflict / task.finished" style="width:100%"></td>'
      + '<td><select class="rm-input" data-fld="type" onchange="Alerting.render()" style="width:100%">'
      +   '<option value="webhook"' + (typ==='webhook'?' selected':'') + '>Webhook</option>'
      +   '<option value="email"'   + (typ==='email'?' selected':'')   + '>邮件</option>'
      + '</select></td>'
      + '<td>'
      +   '<input class="rm-input" value="'+esc(typ==='email' ? (r.email_to||'') : (r.webhook_url||''))+'" '
      +           'data-fld="target" placeholder="'+(typ==='email'?'收件人邮箱':'https://...')+'" style="width:100%">'
      + '</td>'
      + '<td>'
      +   (isWebhook
          ? '<select class="rm-input" data-fld="template" style="width:100%">'
              + ['generic','feishu','dingtalk','wecom','slack'].map(function(t){
                  return '<option value="'+t+'"'+(tmpl===t?' selected':'')+'>'+t+'</option>';
                }).join('')
              + '</select>'
          : '<span style="color:var(--text3)">—</span>')
      + '</td>'
      + '<td><input class="rm-input" type="number" min="0" max="86400" value="'+ (r.silence_sec||0) +'" data-fld="silence_sec" style="width:70px" title="去抖秒（0=不限）"></td>'
      + '<td style="text-align:center"><input type="checkbox" data-fld="enabled"'+(r.enabled!==false?' checked':'')+'></td>'
      + '<td>'
      +   '<button class="btn btn-sm" onclick="Alerting.testRow('+idx+')">✉</button> '
      +   (isWebhook ? '<button class="btn btn-sm" onclick="Alerting.editExtra('+idx+')" title="@成员/签名">⚙</button> ' : '')
      +   '<button class="btn btn-sm" style="background:var(--red);color:#fff" onclick="Alerting.deleteRow('+idx+')">🗑</button>'
      + '</td></tr>';
  }

  function render(){
    var tb = document.getElementById('alertingTableBody');
    if (!tb) return;
    if (!STATE.rules.length){
      tb.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--text3);padding:20px">'
        + '暂无告警规则 · 点右上「+ 新增规则」创建</td></tr>';
      return;
    }
    tb.innerHTML = STATE.rules.map(_renderRow).join('');
  }

  function _collectRow(tr){
    var idx = parseInt(tr.getAttribute('data-idx'), 10);
    var typ = tr.querySelector('[data-fld=type]').value;
    var target = tr.querySelector('[data-fld=target]').value.trim();
    var silEl = tr.querySelector('[data-fld=silence_sec]');
    var tmplEl = tr.querySelector('[data-fld=template]');
    var existing = STATE.rules[idx] || {};
    var r = {
      name: tr.querySelector('[data-fld=name]').value.trim(),
      topic: tr.querySelector('[data-fld=topic]').value.trim(),
      type: typ,
      enabled: tr.querySelector('[data-fld=enabled]').checked,
      silence_sec: silEl ? parseInt(silEl.value, 10) || 0 : 0,
    };
    if (typ === 'email'){
      r.email_to = target;
    } else {
      r.webhook_url = target; r.method = 'POST';
      if (tmplEl) r.template = tmplEl.value;
      // 保留 @成员 / secret 等高级字段
      if (existing.at_mobiles) r.at_mobiles = existing.at_mobiles;
      if (existing.at_all)     r.at_all     = existing.at_all;
      if (existing.secret)     r.secret     = existing.secret;
    }
    return { idx: idx, rule: r };
  }

  function _collectAll(){
    var trs = document.querySelectorAll('#alertingTableBody tr[data-idx]');
    var out = [];
    for (var i=0; i<trs.length; i++){
      var c = _collectRow(trs[i]);
      if (c.rule.name && c.rule.topic && (c.rule.webhook_url || c.rule.email_to)){
        out.push(c.rule);
      }
    }
    return out;
  }

  var Alerting = {
    render: render,

    async editExtra(idx){
      var r = STATE.rules[idx]; if (!r) return;
      var at = await rpPrompt({ title:'@成员手机号（钉钉，多个用逗号分隔，留空清除）', defaultName: r.at_mobiles || '' });
      if (at !== null) r.at_mobiles = at.trim();
      var sec = await rpPrompt({ title:'签名密钥 secret（钉钉/飞书，留空清除）', defaultName: r.secret || '' });
      if (sec !== null) r.secret = sec.trim();
      r.at_all = await rpConfirm({ title:'是否 @全体成员？', body:'确定 = 是；取消 = 否', okText:'是' });
      render();
      await this.save();
    },

    async reload(){
      var r = await rpc('alert_rules_get');
      if (r.status === 'ok'){
        STATE.rules = r.rules || [];
        render();
        window.toast && toast('已加载 ' + STATE.rules.length + ' 条规则', 'ok');
      } else {
        window.toast && toast('加载失败: ' + (r.msg||''), 'err');
      }
      // 拉 SMTP 配置
      var s = await rpc('setting_get', {keys: ['smtp_host','smtp_port','smtp_user','smtp_pass','smtp_from','smtp_ssl']});
      if (s.status === 'ok' && s.settings){
        var st = s.settings;
        document.getElementById('smtpHost').value = st.smtp_host || '';
        document.getElementById('smtpPort').value = st.smtp_port || '465';
        document.getElementById('smtpUser').value = st.smtp_user || '';
        document.getElementById('smtpPass').value = st.smtp_pass || '';
        document.getElementById('smtpFrom').value = st.smtp_from || '';
        document.getElementById('smtpSSL').value = st.smtp_ssl || 'ssl';
      }
    },

    addRule(){
      STATE.rules.push({
        name: '规则' + (STATE.rules.length + 1),
        topic: 'audit.login.failed',
        type: 'webhook',
        webhook_url: '',
        enabled: true,
      });
      render();
    },

    async deleteRow(idx){
      if (!(await rpConfirm({ title:'删除告警规则', body:'删除这条告警规则？', danger:true, okText:'删除' }))) return;
      STATE.rules.splice(idx, 1);
      render();
      await this.save();
    },

    async testRow(idx){
      var trs = document.querySelectorAll('#alertingTableBody tr[data-idx]');
      var tr = trs[idx]; if (!tr) return;
      var c = _collectRow(tr);
      var r = c.rule;
      if (r.type === 'email'){
        if (!r.email_to){ toast('请填收件人', 'warn'); return; }
        var res = await rpc('alert_test_email', {email_to: r.email_to});
        toast(res.status==='ok' ? '邮件发送成功' : ('失败: '+(res.msg||'')),
              res.status==='ok'?'ok':'err');
      } else {
        if (!r.webhook_url){ toast('请填 webhook URL', 'warn'); return; }
        var res2 = await rpc('alert_test', {webhook_url: r.webhook_url, method: r.method || 'POST'});
        toast(res2.status==='ok' ? ('HTTP '+res2.http_code) : ('失败: '+(res2.msg||'')),
              res2.status==='ok'?'ok':'err');
      }
    },

    async save(){
      // 收集当前表格 → 提交
      STATE.rules = _collectAll();
      var r = await rpc('alert_rules_set', {rules: STATE.rules});
      toast(r.status==='ok' ? ('已保存 '+r.saved+' 条（激活 '+r.active+'）') : ('失败: '+(r.msg||'')),
            r.status==='ok'?'ok':'err');
    },

    async saveSMTP(){
      var items = {
        smtp_host: document.getElementById('smtpHost').value.trim(),
        smtp_port: document.getElementById('smtpPort').value.trim() || '465',
        smtp_user: document.getElementById('smtpUser').value.trim(),
        smtp_pass: document.getElementById('smtpPass').value,
        smtp_from: document.getElementById('smtpFrom').value.trim(),
        smtp_ssl:  document.getElementById('smtpSSL').value,
      };
      var r = await rpc('setting_set', {items: items});
      toast(r.status==='ok' ? 'SMTP 配置已保存' : ('失败: '+(r.msg||'')),
            r.status==='ok'?'ok':'err');
    },

    async testSMTP(){
      var to = await rpPrompt({ title:'测试邮件收件人' });
      if (!to) return;
      var r = await rpc('alert_test_email', {email_to: to});
      toast(r.status==='ok' ? '邮件发送成功' : ('失败: '+(r.msg||'')),
            r.status==='ok'?'ok':'err');
    },
  };

  window.Alerting = Alerting;

  // 表格变化 → 自动保存（debounce）
  var _saveTimer = null;
  document.addEventListener('change', function(ev){
    var tb = document.getElementById('alertingTableBody');
    if (!tb) return;
    if (!tb.contains(ev.target)) return;
    if (_saveTimer) clearTimeout(_saveTimer);
    _saveTimer = setTimeout(function(){ Alerting.save(); }, 800);
  });

  // 首次打开 settings 页时加载
  var _loaded = false;
  document.addEventListener('click', function(ev){
    if (!ev.target || !ev.target.getAttribute) return;
    if (ev.target.getAttribute('onclick') === "switchTab('settings')"){
      if (_loaded) return;
      _loaded = true;
      setTimeout(function(){ Alerting.reload(); }, 200);
    }
  });
})();
