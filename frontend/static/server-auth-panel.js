/*
 * <server-auth-panel> · v2.7.1
 * 统一 SSH 连接认证面板 Web Component
 *
 * 属性:
 *   prefix           - 面板前缀（如 lvm/zfs/rbd/pbs），生成 <prefix>Host / <prefix>Pass 等 id
 *   title            - 标题文本（如 "连接 LVM 服务器"）
 *   default-host     - 主机 placeholder
 *   default-port     - 端口默认值 (默认 22)
 *   default-user     - 用户名默认值 (默认 root)
 *   test-fn          - 测试连接按钮 onclick 函数名 (如 "testLvm")
 *   save-fn          - 保存配置按钮 onclick（默认 "save<Prefix>Config();saveCurrentConfig()"）
 *   scan-fn          - 可选扫描按钮 onclick 函数名 (如 "scanLvmDisks")
 *   scan-label       - 扫描按钮文字
 *   extras           - 可选：额外字段 JSON (name/label/placeholder/default)，如 pool
 *
 * 生成的关键 id（与旧 HTML 完全一致，向后兼容旧 JS）：
 *   <prefix>Host, <prefix>Port, <prefix>User,
 *   <prefix>AuthType (onchange -> update<Prefix>AuthUI()),
 *   <prefix>AuthField, <prefix>Pass, <prefix>Passphrase,
 *   <prefix>ConnBadge (span), <prefix>ConnResult (span, display:none 兼容旧代码)
 */
(function(){
  function cap(s){ return s ? s[0].toUpperCase() + s.slice(1) : s; }

  class ServerAuthPanel extends HTMLElement {
    connectedCallback(){
      if(this._rendered) return;
      this._rendered = true;
      const prefix   = this.getAttribute('prefix') || '';
      const Pref     = cap(prefix);
      const title    = this.getAttribute('title') || (prefix.toUpperCase() + ' 服务器');
      const dHost    = this.getAttribute('default-host') || '';
      const dPort    = this.getAttribute('default-port') || '22';
      const dUser    = this.getAttribute('default-user') || 'root';
      const testFn   = this.getAttribute('test-fn')  || ('test' + Pref);
      const saveFn   = this.getAttribute('save-fn')  || ('save' + Pref + 'Config();saveCurrentConfig()');
      const scanFn   = this.getAttribute('scan-fn')  || '';
      const scanLbl  = this.getAttribute('scan-label') || '🔍 扫描';
      let extras = [];
      try {
        const raw = this.getAttribute('extras');
        if(raw) extras = JSON.parse(raw);
      } catch(e){ console.warn('server-auth-panel bad extras:', e); }

      const extraHtml = extras.length
        ? '<div class="form-row" style="grid-template-columns:repeat(' + Math.min(extras.length,2) + ',1fr);gap:8px">'
          + extras.map(x =>
              '<div class="field"><label>' + (x.required ? '<span class="required-star">*</span>' : '') + x.label + '</label>'
              + '<input type="text" id="' + prefix + cap(x.name) + '" value="' + (x.default || '') + '" placeholder="' + (x.placeholder || '') + '"></div>'
            ).join('')
          + '</div>'
        : '';

      const scanBtn = scanFn
        ? '<button class="btn btn-sm btn-primary" onclick="' + scanFn + '()">' + scanLbl + '</button>'
        : '';

      this.innerHTML =
        '<div class="card">'
        + '<h3 style="display:flex;align-items:center;gap:8px">' + title
        + '  <span id="' + prefix + 'ConnBadge" class="conn-badge conn-idle" style="margin-left:auto">未连接</span>'
        + '</h3>'
        + '<div class="form-row host-port">'
        +   '<div class="field"><label><span class="required-star">*</span>主机</label>'
        +     '<input type="text" id="' + prefix + 'Host" placeholder="' + dHost + '"></div>'
        +   '<div class="field"><label><span class="required-star">*</span>SSH 端口</label>'
        +     '<input type="text" id="' + prefix + 'Port" value="' + dPort + '"></div>'
        + '</div>'
        + '<div class="form-row user-auth">'
        +   '<div class="field"><label><span class="required-star">*</span>SSH 用户名</label>'
        +     '<input type="text" id="' + prefix + 'User" value="' + dUser + '"></div>'
        +   '<div class="field"><label><span class="required-star">*</span>认证方式</label>'
        +     '<select id="' + prefix + 'AuthType" onchange="if(typeof update' + Pref + 'AuthUI===\'function\')update' + Pref + 'AuthUI()">'
        +       '<option value="pass" selected>密码</option>'
        +       '<option value="key">SSH 密钥</option>'
        +     '</select></div>'
        + '</div>'
        + '<div class="auth-row">'
        +   '<div class="field" id="' + prefix + 'AuthField">'
        +     '<label><span class="required-star">*</span>登录密码</label>'
        +     '<input type="password" id="' + prefix + 'Pass" placeholder="请输入SSH登录密码" autocomplete="new-password">'
        +   '</div>'
        + '</div>'
        + '<div style="margin:-4px 0 8px 4px">'
        +   '<label style="font-size:11px;color:var(--text3);cursor:pointer;display:inline-flex;align-items:center;gap:5px">'
        +     '<input type="checkbox" id="' + prefix + 'Remember" style="margin:0"> '
        +     '<span>💾 记住密码（Fernet 加密后保存到本地数据库，方便定时任务自动运行）</span>'
        +   '</label>'
        + '</div>'
        + extraHtml
        + '<div class="flex-row">'
        +   '<button class="btn btn-sm" onclick="' + testFn + '()">🔗 测试连接</button>'
        +   '<button class="btn btn-sm save-config-btn" onclick="' + saveFn + '">💾 保存配置</button>'
        +   '<button class="btn btn-sm" onclick="loadConfigToPanel()">📂 载入</button>'
        +   scanBtn
        +   '<span class="ml-auto" id="' + prefix + 'ConnResult" style="display:none"></span>'
        + '</div>'
        + '</div>';
    }
  }
  customElements.define('server-auth-panel', ServerAuthPanel);
})();
