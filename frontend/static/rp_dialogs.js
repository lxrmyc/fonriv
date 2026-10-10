/* v6.3.28 · 主题化模态基建(独立文件)
 * ---------------------------------------------------------------
 * 为什么独立出来: 原先 _showC2Modal / configPromptModal / rpConfirm / rpPrompt /
 *   rpForm 都长在 app.js 里, 而 app.js 只有主界面(index.html)加载 —— 于是
 *   guac.html / novnc.html 这两个**独立控制台页**用不了它们, 只能继续用原生
 *   confirm/prompt(两页共 5 处), 与「前端只允许一份弹窗实现」相冲突。
 *   抽成独立文件后三个页面共用同一份, 全站(JS + HTML)原生弹窗才能真正归零。
 *
 * 依赖: 无。不引用 app.js/app_utils.js 的任何函数(独立页没加载它们), 也不依赖
 *   项目 CSS 变量 —— 所有 var(--x) 都带 fallback, 并按 rp_theme 选深/浅色,
 *   因此在没有主题样式表的页面上也能正常显示。
 *
 * 对外 API(全部挂 window, 兼容既有 7 个调用方):
 *   window._showC2Modal(opts)          主题化二次确认(回调式, 历史 API)
 *   window.configPromptModal(opts, cb) 主题化单值输入(回调式, 历史 API)
 *   window.rpConfirm(opts) -> Promise<true|false>
 *   window.rpPrompt(opts)  -> Promise<string|null>   (提交值 / 空输入 '' / 取消 null)
 *   window.rpForm(opts)    -> Promise<{key:value}|null>
 *
 * 约定:
 *   - 原生 confirm/prompt 是**同步返回值**语义, 无法异步主题化 → 新代码一律用
 *     rpConfirm / rpPrompt / rpForm, 不要再写原生弹窗(棘轮守栏:
 *     tests/test_v6314_copy_hygiene.py)。
 *   - ESC/Enter 一律挂**捕获阶段**: hotkeys.js 的全局快捷键处理器也在 document
 *     捕获阶段, 命中全屏类快捷键时会 stopPropagation(), 冒泡阶段的监听器收不到
 *     事件(实测症状: ESC 关不掉二次确认弹窗)。
 */
(function(g) {
  'use strict';

  // ── 主题取值: 有项目 CSS 变量就用, 没有(fallback)则按 rp_theme 走内置配色 ──
  var THEME_STYLE_ID = 'rpDialogTheme';
  function _isLight() {
    try {
      var t = localStorage.getItem('rp_theme') || 'dark';
      if (t === 'auto') t = (g.matchMedia && g.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
      return t === 'light';
    } catch (e) { return false; }
  }
  var _LIGHT = _isLight();
  // 独立页没有主题样式表 → 这些 fallback 才是实际生效值; 主界面有变量时优先用变量
  var T = {
    bg:    _LIGHT ? '#ffffff' : '#111827',
    bg2:   _LIGHT ? '#f8fafc' : '#1f2937',
    bg3:   _LIGHT ? '#eef2f7' : '#111827',
    text:  _LIGHT ? '#0f172a' : '#e5e7eb',
    text2: _LIGHT ? '#475569' : '#9ca3af',
    text3: _LIGHT ? '#64748b' : '#6b7280',
    border:_LIGHT ? '#cbd5e1' : '#374151',
    red:   _LIGHT ? '#dc2626' : '#ef4444',
    blue:  _LIGHT ? '#2563eb' : '#3b82f6',
    green: _LIGHT ? '#059669' : '#10b981'
  };
  var C = {
    bg:    'var(--bg, '    + T.bg    + ')',
    bg2:   'var(--bg2, '   + T.bg2   + ')',
    bg3:   'var(--bg3, '   + T.bg3   + ')',
    text:  'var(--text, '  + T.text  + ')',
    text2: 'var(--text2, ' + T.text2 + ')',
    text3: 'var(--text3, ' + T.text3 + ')',
    border:'var(--border, '+ T.border+ ')',
    red:   'var(--red, '   + T.red   + ')',
    blue:  'var(--blue, '  + T.blue  + ')',
    green: 'var(--green, ' + T.green + ')'
  };
  // 独立页没有 .btn 样式表 → 按钮自带基础样式(主界面里这些内联值也够看)
  var BTN = 'border-radius:5px;cursor:pointer;font-size:13px;font-family:inherit';

  function _rpEsc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // 一次性注入动画 CSS
  function _injectCss() {
    if (document.getElementById('c2Css')) return;
    var s = document.createElement('style');
    s.id = 'c2Css';
    s.textContent = '@keyframes c2fadein{from{opacity:0}to{opacity:1}}'
                  + '@keyframes c2scalein{from{transform:scale(0.95);opacity:0}to{transform:scale(1);opacity:1}}';
    document.head.appendChild(s);
  }

  // ── v4.38.24 · C2 样式二次确认弹窗 ──
  // opts: {title, body, danger, onOk(text, password), onCancel(), okText, cancelText, needPassword}
  g._showC2Modal = function(opts) {
    opts = opts || {};
    var old = document.getElementById('c2Modal');
    if (old) old.remove();
    var m = document.createElement('div');
    m.id = 'c2Modal';
    m.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.55);z-index:100000;'
                    + 'display:flex;align-items:center;justify-content:center;animation:c2fadein .15s ease';
    var danger = opts.danger ? C.red : C.blue;
    var okText = opts.okText || '确定';
    var cancelText = opts.cancelText || '取消';
    m.innerHTML =
      '<div style="background:' + C.bg2 + ';border:1px solid ' + C.border + ';border-radius:10px;padding:18px 22px;max-width:480px;width:90%;box-shadow:0 12px 40px rgba(0,0,0,0.45);animation:c2scalein .15s ease">' +
        '<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">' +
          '<span style="font-size:18px">' + (opts.danger ? '⚠️' : '🔧') + '</span>' +
          '<span style="font-size:15px;font-weight:600;color:' + C.text + '">' + (opts.title || '确认') + '</span>' +
        '</div>' +
        '<div style="background:' + C.bg + ';border:1px solid ' + C.border + ';border-radius:6px;padding:10px 12px;font-size:12px;color:' + C.text2 + ';white-space:pre-wrap;line-height:1.6;margin-bottom:12px">' + (opts.body || '') + '</div>' +
        (opts.needPassword
          ? '<input type="password" id="c2Pwd" placeholder="请输入密码" style="width:100%;box-sizing:border-box;padding:6px 10px;border:1px solid ' + C.border + ';border-radius:4px;background:' + C.bg + ';color:' + C.text + ';font-size:12px;margin-bottom:12px">'
          : '') +
        '<div style="display:flex;gap:8px;justify-content:flex-end">' +
          '<button id="c2Cancel" class="btn" style="background:' + C.bg + ';color:' + C.text + ';border:1px solid ' + C.border + ';padding:5px 14px;' + BTN + '">' + cancelText + '</button>' +
          '<button id="c2Ok" class="btn" style="background:' + danger + ';color:#fff;border:0;padding:5px 14px;font-weight:600;' + BTN + '">' + okText + '</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(m);
    function _close() { m.remove(); document.removeEventListener('keydown', _key, true); }
    function _ok() {
      var pwd = opts.needPassword ? (document.getElementById('c2Pwd') || {}).value || '' : '';
      _close();
      try { opts.onOk && opts.onOk('', pwd); } catch (e) { console.warn('[C2] onOk err', e); }
    }
    function _cancel() {
      _close();
      try { opts.onCancel && opts.onCancel(); } catch (e) {}
    }
    function _key(e) { if (e.key === 'Escape') _cancel(); else if (e.key === 'Enter') _ok(); }
    document.getElementById('c2Ok').onclick = _ok;
    document.getElementById('c2Cancel').onclick = _cancel;
    m.onclick = function(e) { if (e.target === m) _cancel(); };
    // v6.3.25 · FIX: ESC/Enter 必须走**捕获阶段**——hotkeys.js 的全局快捷键处理器也在
    //   document 捕获阶段, 命中全屏类快捷键时会 stopPropagation(), 冒泡阶段的监听器
    //   收不到事件 → 表现为「ESC 关不掉二次确认弹窗」(原生 confirm 自带 ESC, 迁移后暴露)。
    document.addEventListener('keydown', _key, true);
    if (opts.needPassword) {
      var inp = document.getElementById('c2Pwd');
      if (inp) setTimeout(function() { inp.focus(); }, 50);
    } else {
      setTimeout(function() { var b = document.getElementById('c2Ok'); if (b) b.focus(); }, 50);
    }
    _injectCss();
  };

  // ── v2.9.5 · 自定义配置名 prompt(原生 prompt 在部分浏览器/嵌入场景被阻断) ──
  function configPromptModal(opts, cb) {
    opts = opts || {};
    var bg = document.createElement('div');
    bg.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:99999;display:flex;align-items:center;justify-content:center;font-family:inherit';
    bg.innerHTML =
      '<div style="background:' + C.bg2 + ';color:' + C.text + ';border:1px solid ' + C.border + ';border-radius:8px;padding:20px 22px;min-width:380px;max-width:90vw;box-shadow:0 20px 60px rgba(0,0,0,.5);box-sizing:border-box">' +
      '  <div style="font-size:15px;font-weight:600;margin-bottom:10px">' + (opts.title || '输入配置名称') + '</div>' +
      (opts.hint ? '  <div style="font-size:12px;color:' + C.text3 + ';line-height:1.6;margin-bottom:10px">' + opts.hint + '</div>' : '') +
      '  <input type="text" id="_cfgPromptInput" style="width:100%;padding:9px 10px;background:' + C.bg3 + ';color:' + C.text + ';border:1px solid ' + C.border + ';border-radius:5px;font-size:14px;box-sizing:border-box" value="' + String(opts.defaultName || '').replace(/"/g,'&quot;') + '">' +
      '  <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px">' +
      '    <button class="btn btn-sm" id="_cfgPromptCancel" style="background:' + C.bg3 + ';color:' + C.text2 + ';border:1px solid ' + C.border + ';padding:5px 12px;' + BTN + '">取消</button>' +
      '    <button class="btn btn-sm btn-primary" id="_cfgPromptOk" style="background:' + C.green + ';color:#fff;border:0;padding:5px 12px;' + BTN + '">' + (opts.okText || '确定') + '</button>' +
      '  </div>' +
      '</div>';
    document.body.appendChild(bg);
    var input = bg.querySelector('#_cfgPromptInput');
    var ok = bg.querySelector('#_cfgPromptOk');
    var cancel = bg.querySelector('#_cfgPromptCancel');
    function close() { if (bg.parentNode) bg.parentNode.removeChild(bg); }
    // v6.3.25: 提交传 trim 后的字符串(空串也传 ''), 只有取消/ESC/点遮罩才传 null
    //   —— 与原生 prompt 语义一致(空输入 → '', 取消 → null), rpPrompt 依赖此约定
    function submit() { var v = (input.value || '').trim(); close(); cb(v); }
    ok.onclick = submit;
    cancel.onclick = function() { close(); cb(null); };
    bg.onclick = function(e) { if (e.target === bg) { close(); cb(null); } };
    input.onkeydown = function(e) {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); cb(null); }
    };
    setTimeout(function() { input.focus(); input.select(); }, 30);
  }
  g.configPromptModal = configPromptModal;

  // ── v6.3.25 · 主题化模态的 Promise 语义封装 (替代原生 confirm / prompt) ──
  //   原生 confirm()/prompt() 是**同步返回值**语义, 无法异步主题化, 只能逐处改写。
  //   这两个封装与原生一一对应, 调用方用 await / .then 承接即可:
  //     rpConfirm(opts) -> Promise<true|false>      (确定 / 取消·ESC·点遮罩)
  //     rpPrompt(opts)  -> Promise<string|null>     (提交值, 空输入为 '' / 取消为 null)
  //   模态基建缺失时回落原生实现 —— 宁可弹原生, 也不能静默丢弃确认 (同 alert 接管策略)。
  function rpConfirm(opts) {
    if (typeof opts === 'string') opts = { body: opts };
    opts = opts || {};
    return new Promise(function(resolve) {
      if (typeof g._showC2Modal !== 'function') {
        resolve(!!g.confirm(opts.body || ''));   // 兜底: 基建缺失时保留原生确认
        return;
      }
      g._showC2Modal(Object.assign({}, opts, {
        onOk:     function() { resolve(true);  },
        onCancel: function() { resolve(false); }
      }));
    });
  }
  function rpPrompt(opts) {
    if (typeof opts === 'string') opts = { title: opts };
    opts = opts || {};
    return new Promise(function(resolve) {
      if (typeof g.configPromptModal !== 'function') {
        resolve(g.prompt(opts.title || '', opts.defaultName || ''));   // 兜底
        return;
      }
      g.configPromptModal(opts, function(v) { resolve(v == null ? null : v); });
    });
  }
  g.rpConfirm = rpConfirm;
  g.rpPrompt  = rpPrompt;

  // ── v6.3.26 · rpForm: 多字段表单模态 (替代「连续 prompt 问三次」) ──
  //   原生 prompt 一次只能问一个字段, 于是建用户/改密码这种流程变成连弹三次,
  //   中途取消还只算「取消当前这一问」, 状态零散。rpForm 一次收齐, 语义:
  //     rpForm(opts) -> Promise<{key:value,...}|null>   (null = 取消/ESC/点遮罩)
  //   opts: { title, hint, okText, cancelText, danger, fields:[...], validate(values)->String|null }
  //   field: { key, label, type:'text'|'password'|'select', value, placeholder, options:[{v,label}],
  //            required, minLen, hint, trim }
  //   校验不通过 → 就地红字提示并留在模态里(不关窗、不丢已填内容)。
  function rpForm(opts) {
    opts = opts || {};
    var fields = opts.fields || [];
    return new Promise(function(resolve) {
      var old = document.getElementById('rpFormModal');
      if (old) old.remove();
      var inpCss = 'width:100%;padding:7px 10px;border:1px solid ' + C.border + ';border-radius:5px;'
                 + 'background:' + C.bg + ';color:' + C.text + ';font-size:13px;box-sizing:border-box';
      var body = fields.map(function(f, i) {
        var id = 'rpFormF' + i;
        var ctl;
        if (f.type === 'select') {
          ctl = '<select id="' + id + '" style="' + inpCss + '">' +
            (f.options || []).map(function(o) {
              return '<option value="' + _rpEsc(String(o.v)) + '"' +
                     (String(o.v) === String(f.value) ? ' selected' : '') + '>' +
                     _rpEsc(String(o.label)) + '</option>';
            }).join('') + '</select>';
        } else {
          ctl = '<input id="' + id + '" type="' + (f.type === 'password' ? 'password' : 'text') + '"' +
                ' value="' + _rpEsc(String(f.value == null ? '' : f.value)) + '"' +
                ' placeholder="' + _rpEsc(String(f.placeholder || '')) + '"' +
                ' autocomplete="off" style="' + inpCss + '">';
        }
        return '<div style="margin-bottom:10px">' +
          '<div style="font-size:12px;color:' + C.text2 + ';margin-bottom:4px">' + _rpEsc(String(f.label || '')) +
          (f.required ? ' <span style="color:' + C.red + '">*</span>' : '') +
          (f.hint ? ' <span style="font-size:11px;color:' + C.text3 + '">' + _rpEsc(String(f.hint)) + '</span>' : '') +
          '</div>' + ctl + '</div>';
      }).join('');
      var danger = opts.danger ? C.red : C.blue;
      var m = document.createElement('div');
      m.id = 'rpFormModal';
      m.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.55);z-index:100000;'
                      + 'display:flex;align-items:center;justify-content:center';
      m.innerHTML =
        '<div style="background:' + C.bg2 + ';border:1px solid ' + C.border + ';border-radius:10px;padding:18px 22px;'
        + 'max-width:460px;width:92%;box-shadow:0 12px 40px rgba(0,0,0,0.45);box-sizing:border-box">' +
          '<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">' +
            '<span style="font-size:18px">' + (opts.danger ? '⚠️' : '📝') + '</span>' +
            '<span style="font-size:15px;font-weight:600;color:' + C.text + '">' + _rpEsc(String(opts.title || '填写')) + '</span>' +
          '</div>' +
          (opts.hint ? '<div style="font-size:12px;color:' + C.text3 + ';line-height:1.6;margin-bottom:10px">'
                       + _rpEsc(String(opts.hint)) + '</div>' : '') +
          body +
          '<div id="rpFormErr" style="display:none;font-size:12px;color:' + C.red + ';'
          + 'background:' + C.bg + ';border:1px solid ' + C.red + ';border-radius:5px;padding:6px 9px;margin-bottom:10px"></div>' +
          '<div style="display:flex;gap:8px;justify-content:flex-end">' +
            '<button id="rpFormCancel" class="btn" style="background:' + C.bg + ';color:' + C.text + ';'
            + 'border:1px solid ' + C.border + ';padding:5px 14px;' + BTN + '">' + _rpEsc(String(opts.cancelText || '取消')) + '</button>' +
            '<button id="rpFormOk" class="btn" style="background:' + danger + ';color:#fff;border:0;'
            + 'padding:5px 14px;font-weight:600;' + BTN + '">' + _rpEsc(String(opts.okText || '确定')) + '</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(m);
      function _err(msg) {
        var e = document.getElementById('rpFormErr');
        if (e) { e.textContent = msg; e.style.display = 'block'; }
      }
      function _close() { m.remove(); document.removeEventListener('keydown', _key, true); }
      function _cancel() { _close(); resolve(null); }
      function _submit() {
        var vals = {};
        for (var i = 0; i < fields.length; i++) {
          var f = fields[i], el = document.getElementById('rpFormF' + i);
          var raw = el ? String(el.value == null ? '' : el.value) : '';
          var v = (f.type === 'password' || f.type === 'select' || f.trim === false) ? raw : raw.trim();
          if (f.required && !v) {
            _err('「' + (f.label || f.key) + '」不能为空');
            if (el && el.focus) el.focus();
            return;
          }
          if (f.minLen && v.length < f.minLen) {
            _err('「' + (f.label || f.key) + '」至少 ' + f.minLen + ' 位');
            if (el && el.focus) el.focus();
            return;
          }
          vals[f.key] = v;
        }
        if (typeof opts.validate === 'function') {
          var bad = opts.validate(vals);
          if (bad) { _err(bad); return; }
        }
        _close();
        resolve(vals);
      }
      // 同 rpConfirm: 捕获阶段监听, 避免被 hotkeys.js 的全局快捷键处理器吞掉
      function _key(e) { if (e.key === 'Escape') _cancel(); else if (e.key === 'Enter') _submit(); }
      document.getElementById('rpFormOk').onclick = _submit;
      document.getElementById('rpFormCancel').onclick = _cancel;
      m.onclick = function(e) { if (e.target === m) _cancel(); };
      document.addEventListener('keydown', _key, true);
      setTimeout(function() { var f0 = document.getElementById('rpFormF0'); if (f0 && f0.focus) f0.focus(); }, 50);
    });
  }
  g.rpForm = rpForm;
})(window);
