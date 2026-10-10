/* v4.72.0 · 快捷键配置卡片 (系统设置页)
 * 依赖 window.Hotkeys (get/set/reset/actions) + toast
 */
(function(g){
  'use strict';

  function $(id){ return document.getElementById(id); }
  function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g,function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }

  var _recording = null;   // 正在录制的动作 key

  var HK_HOSTS = ['hotkeyBody', 'hotkeyBodySettings'];   // v5.86.2 · 双宿主
  function render(){ return renderAll(); }   // 兼容旧调用名

  function renderAll(){

    HK_HOSTS.forEach(function(hid){ var h2 = $(hid); if (h2) _renderInto(h2); });

  }

  function _renderInto(host){
    if (!host) return;
    if (!g.Hotkeys){ host.innerHTML = '<div style="color:var(--red);font-size:12px">✗ hotkeys.js 未加载</div>'; return; }
    var cur = g.Hotkeys.get();
    var actions = g.Hotkeys.actions;
    var html =
      '<div style="font-size:11px;color:var(--text3);margin-bottom:8px;line-height:1.7">'+
        '点「录制」后按下想要的组合键即可绑定（Esc 取消录制）。冲突时会提示。'+
        '带修饰键的组合（Ctrl / Alt / Shift）在输入框内也会生效；单键仅在非输入状态生效。'+
      '</div>'+
      '<table style="width:100%;border-collapse:collapse;font-size:12px">'+
      '<tr style="color:var(--text3);font-size:11px;border-bottom:1px solid var(--border)">'+
        '<td style="padding:5px 8px">功能</td>'+
        '<td style="padding:5px 8px">当前快捷键</td>'+
        '<td style="padding:5px 8px;width:150px">操作</td></tr>'+
      Object.keys(actions).map(function(k){
        var a = actions[k];
        var rec = (_recording === k);
        return '<tr style="border-bottom:1px dashed var(--border)">'+
          '<td style="padding:6px 8px;color:var(--text)">'+esc(a.label)+'</td>'+
          '<td style="padding:6px 8px">'+
            '<span class="hk-combo" data-k="'+esc(k)+'" style="font-family:monospace;font-size:11px;'+
            'padding:2px 8px;border-radius:5px;border:1px solid '+(rec?'var(--green)':'var(--border)')+';'+
            'background:'+(rec?'var(--green-bg)':'var(--bg)')+';color:'+(rec?'var(--green)':'var(--cyan)')+'">'+
            (rec ? '⏺ 请按组合键…' : esc(cur[k] || '(未设置)'))+'</span></td>'+
          '<td style="padding:6px 8px;white-space:nowrap">'+
            '<button class="btn btn-sm hk-rec" data-k="'+esc(k)+'" style="font-size:10px;padding:1px 7px">'+
              (rec ? '✕ 取消' : '⏺ 录制')+'</button> '+
            '<button class="btn btn-sm hk-clr" data-k="'+esc(k)+'" style="font-size:10px;padding:1px 7px">清除</button>'+
          '</td></tr>';
      }).join('')+
      '</table>'+
      '<div style="display:flex;gap:8px;margin-top:10px">'+
        '<button class="btn btn-sm" id="hkReset">↺ 恢复默认</button>'+
        '<span id="hkMsg" style="font-size:11px;color:var(--text3);align-self:center"></span>'+
      '</div>';

    host.innerHTML = html;

    host.querySelectorAll('.hk-rec').forEach(function(b){
      b.onclick = function(){
        var k = b.getAttribute('data-k');
        _recording = (_recording === k) ? null : k;
        render();
        if (_recording) _bindRecorder();
      };
    });
    host.querySelectorAll('.hk-clr').forEach(function(b){
      b.onclick = function(){
        var k = b.getAttribute('data-k');
        var m = g.Hotkeys.get(); m[k] = '';
        g.Hotkeys.set(m);
        _msg('已清除「' + g.Hotkeys.actions[k].label + '」的快捷键');
        render();
      };
    });
    var rs = $('hkReset');
    if (rs) rs.onclick = function(){
      g.Hotkeys.reset();
      _recording = null;
      _msg('✓ 已恢复默认快捷键');
      render();
    };
  }

  function _msg(t){
    var el = $('hkMsg');
    if (el) el.textContent = t;
  }

  var _recHandler = null;
  function _bindRecorder(){
    if (_recHandler) document.removeEventListener('keydown', _recHandler, true);
    _recHandler = function(ev){
      if (!_recording) return;
      // Esc = 取消录制 (不写入)
      if (ev.key === 'Escape'){
        ev.preventDefault(); ev.stopPropagation();
        _recording = null;
        document.removeEventListener('keydown', _recHandler, true);
        _recHandler = null;
        render();
        return;
      }
      var combo = g.Hotkeys.comboOf(ev);
      if (!combo) return;   // 仅按修饰键 → 继续等
      ev.preventDefault(); ev.stopPropagation();
      var m = g.Hotkeys.get();
      // 冲突检测
      var dup = null;
      Object.keys(m).forEach(function(k2){
        if (k2 !== _recording && g.Hotkeys.normalize(m[k2]) === g.Hotkeys.normalize(combo)) dup = k2;
      });
      if (dup){
        if (!g.confirm || !g.confirm('「' + combo + '」已被「' + g.Hotkeys.actions[dup].label +
                                     '」占用。\\n要覆盖吗？(原快捷键将被清除)')){
          return;
        }
        m[dup] = '';
      }
      m[_recording] = combo;
      g.Hotkeys.set(m);
      var label = g.Hotkeys.actions[_recording].label;
      _recording = null;
      document.removeEventListener('keydown', _recHandler, true);
      _recHandler = null;
      render();
      _msg('✓ 已绑定「' + label + '」= ' + combo);
    };
    document.addEventListener('keydown', _recHandler, true);
  }

  g.HotkeyPanel = { render: render };
})(window);
