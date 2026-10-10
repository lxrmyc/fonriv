/* v1.0.0 · 授权与许可面板（社区版信息页）· 依赖 window.send + rpState/openLicenseText */
(function(g){
  'use strict';

  var STATE = { lic: null };

  // 社区版功能键与分组来自 features_gen.js (真源 scripts/features.json)
  var FEATURE_DESC = (window.RP_FEATURES && Object.keys(window.RP_FEATURES).length)
    ? Object.keys(window.RP_FEATURES).reduce(function(m, k){ m[k] = window.RP_FEATURES[k].label || k; return m; }, {})
    : {};

  var FEATURE_GROUPS = (window.RP_FEATURE_GROUPS && window.RP_FEATURE_GROUPS.length)
    ? window.RP_FEATURE_GROUPS
    : [['📁 基础 / 传输', ['core', 'rsync', 'schedule']], ['🌐 共享 / 远端存储', ['share']],
       ['🖥 终端', ['terminal']], ['🖥 Proxmox 备份', ['pve', 'vzdump']],
       ['📦 容器', ['docker']], ['📊 总览 / 审计', ['dashboard', 'audit']],
       ['🔌 连接中心', ['connhub']]];

  function rpc(action, data){
    return new Promise(function(resolve){
      try { window.send(Object.assign({action: action}, data || {}), function(r){ resolve(r || {}); }); }
      catch(e){ resolve({status: 'error', msg: String(e)}); }
    });
  }

  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }

  function _row(k, v){
    return '<div style="color:var(--text3)">' + k + '</div><div>' + v + '</div>';
  }

  function _render(){
    var host = document.getElementById('licensePanelBody');
    if (!host) return;
    var L = STATE.lic;
    if (!L){ host.innerHTML = rpState({ state: 'loading', msg: '加载中…' }); return; }

    var lim = L.limits || {};
    var profiles = lim.max_profiles ? ('≤ ' + lim.max_profiles + ' 台') : '不限';
    var maxUsers = lim.max_users ? ('≤ ' + lim.max_users + ' 个') : '不限';

    var html = ''
      // ── 状态块 ──
      + '<div style="padding:10px 12px;background:var(--bg2);border-left:3px solid var(--green);border-radius:6px;margin-bottom:12px">'
      +   '<div style="display:grid;grid-template-columns:110px 1fr;gap:4px 12px;font-size:12px;align-items:center">'
      +     _row('版本', '<b style="color:var(--green)">' + esc(L.edition_label || '社区版 (开源 · AGPL-3.0)') + '</b>')
      +     _row('授权', '无需授权激活 · 永久免费')
      +     _row('档案 / 用户', esc(profiles) + ' / ' + esc(maxUsers))
      +   '</div>'
      +   (L.message ? '<div style="font-size:11px;color:var(--text3);margin-top:6px">' + esc(L.message) + '</div>' : '')
      + '</div>'
      // ── 支持与许可 ──
      + '<div style="padding:10px 12px;background:var(--bg2);border-left:3px solid var(--cyan);border-radius:6px;margin-bottom:12px">'
      +   '<div style="font-weight:600;font-size:12px">🛠 支持与许可 · Support &amp; License</div>'
      +   '<div style="font-size:11px;color:var(--text2);margin-top:5px;line-height:1.9">'
      +     '官网 Website: <a href="https://www.fonriv.com" target="_blank" rel="noopener" style="color:var(--cyan)">www.fonriv.com</a>'
      +     ' &nbsp;·&nbsp; 微信 WeChat: <b style="user-select:all">lxrmyc</b><br>'
      +     '源码 Source: <a href="https://github.com/lxrmyc/fonriv/" target="_blank" rel="noopener" style="color:var(--cyan)">github.com/lxrmyc/fonriv</a><br>'
      // v1.0.0 · i18n: 整句保持单文本节点(原来被 <b> 切碎, 英文模式会残留半句中文)
      +     '本软件以 GNU AGPL-3.0 开源发布 · 可自由使用、修改与再分发；'
      +     '以网络服务形式提供修改版时, 须按同许可证向用户提供对应源码。'
      +   '</div>'
      +   '<div style="margin-top:8px">'
      +     '<button class="btn btn-sm" onclick="openLicenseText()">📄 查看许可协议全文</button>'
      +   '</div>'
      + '</div>';

    // ── 社区版内置功能 (按分组) ──
    var keys = Object.keys(FEATURE_DESC);
    if (keys.length){
      html += '<div style="font-size:11px;color:var(--text3);margin:0 0 6px">社区版内置功能</div>';
      var seen = {};
      var featItem = function(k){
        seen[k] = true;
        return '<div><span style="color:var(--green)">✓</span> ' + esc(FEATURE_DESC[k]) + '</div>';
      };
      FEATURE_GROUPS.forEach(function(grp){
        var items = grp[1].filter(function(k){ return Object.prototype.hasOwnProperty.call(FEATURE_DESC, k); });
        if (!items.length) return;
        html += '<div style="border:1px solid var(--border);border-radius:6px;padding:6px 10px;margin-bottom:6px">'
          + '<div style="font-size:11px;font-weight:600;color:var(--text2);margin-bottom:3px">' + esc(grp[0]) + '</div>'
          + '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:4px 12px;font-size:12px">'
          + items.map(featItem).join('')
          + '</div></div>';
      });
      var restKeys = keys.filter(function(k){ return !seen[k]; });
      if (restKeys.length){
        html += '<div style="border:1px dashed var(--border);border-radius:6px;padding:6px 10px;margin-bottom:12px">'
          + '<div style="font-size:11px;font-weight:600;color:var(--text3);margin-bottom:3px">❔ 其他</div>'
          + '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:4px 12px;font-size:12px">'
          + restKeys.map(featItem).join('')
          + '</div></div>';
      } else {
        html += '<div style="margin-bottom:12px"></div>';
      }
    }

    host.innerHTML = html;
  }

  async function load(){
    var host = document.getElementById('licensePanelBody');
    try {
      var r = await rpc('license_get', {});
      if (r.status === 'ok' && r.license){
        STATE.lic = r.license;
        STATE.lic.limits = r.limits || r.license.limits || {};
        _render();
      } else if (host){
        host.innerHTML = '<div style="color:var(--red);font-size:12px;padding:8px">加载失败: ' + esc(r.msg || '未知错误') + '</div>';
      }
    } catch(e){
      if (host) host.innerHTML = '<div style="color:var(--red);font-size:12px;padding:8px">加载失败: ' + esc(String(e)) + '</div>';
    }
  }

  g.LicensePanel = { load: load };
})(window);
