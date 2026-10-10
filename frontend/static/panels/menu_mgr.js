/* v4.77.0 · 菜单管理 (主菜单排序 + 显示/隐藏 + 恢复默认)
 * 排序持久化 localStorage(rp_menu_order) / 隐藏 rp_menu_hidden
 * app.js 的 applyPermissions 渲染主菜单时读取并应用顺序
 */
(function(g){
  'use strict';

  function $id(id){ return document.getElementById(id); }
  function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g,function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }

  var ORDER_KEY = 'rp_menu_order';
  var HIDDEN_KEY = 'rp_menu_hidden';

  function getOrder(){ try { return JSON.parse(localStorage.getItem(ORDER_KEY) || '[]'); } catch(e){ return []; } }
  function setHidden(h){ try { localStorage.setItem(HIDDEN_KEY, JSON.stringify(h)); } catch(e){} }
  function getHidden(){ try { return JSON.parse(localStorage.getItem(HIDDEN_KEY) || '[]'); } catch(e){ return []; } }

  function saveOrder(list){ try { localStorage.setItem(ORDER_KEY, JSON.stringify(list)); } catch(e){} }

  // 读取当前主菜单 (从 DOM)
  function readMenus(){
    return Array.from(document.querySelectorAll('.main-tabs .tab[data-group]')).map(function(b){
      return { key: b.dataset.group, label: b.textContent.trim().replace(/▾\s*$/,''), visible: b.style.display !== 'none' };
    });
  }

  function render(){
    var host = $id('menuMgrBody');
    if (!host) return;
    var menus = readMenus();
    var order = getOrder();
    // 按保存顺序排列
    var sorted = [];
    order.forEach(function(k){
      var it = menus.find(function(m){ return m.key === k; });
      if (it) sorted.push(it);
    });
    menus.forEach(function(m){ if (!order.includes(m.key)) sorted.push(m); });
    var hidden = getHidden();
    var html = '<div style="font-size:11px;color:var(--text3);margin-bottom:8px;line-height:1.7">'+
      '拖动或用 ↑↓ 调整主菜单顺序, ☑ 控制显示/隐藏 (隐藏 ≠ 禁用, 仅不显示入口)。<br>'+
      '修改后点「保存并应用」→ 页面刷新后生效。'+
      '</div>'+
      '<table style="width:100%;border-collapse:collapse;font-size:12px">'+
      '<tr style="color:var(--text3);font-size:11px;border-bottom:1px solid var(--border)">'+
      '<td style="padding:4px 6px">顺序</td><td style="padding:4px 6px">菜单</td>'+
      '<td style="padding:4px 6px;text-align:center">显示</td><td style="padding:4px 6px">操作</td></tr>';
    sorted.forEach(function(m, i){
      var isHidden = hidden.includes(m.key);
      html += '<tr style="border-bottom:1px dashed var(--border)" data-key="'+esc(m.key)+'">'+
        '<td style="padding:4px 6px;color:var(--text3);text-align:center">'+(i+1)+'</td>'+
        '<td style="padding:4px 6px;color:var(--text)">'+esc(m.label)+'</td>'+
        '<td style="padding:4px 6px;text-align:center">'+
          '<input type="checkbox" class="mm-vis" data-k="'+esc(m.key)+'"'+(isHidden?'':' checked')+' style="width:14px;height:14px;cursor:pointer"></td>'+
        '<td style="padding:4px 6px;white-space:nowrap">'+
          '<button class="btn btn-sm mm-up" data-k="'+esc(m.key)+'" style="font-size:10px;padding:1px 5px">▲</button> '+
          '<button class="btn btn-sm mm-down" data-k="'+esc(m.key)+'" style="font-size:10px;padding:1px 5px">▼</button>'+
        '</td></tr>';
    });
    html += '</table>'+
      '<div style="display:flex;gap:8px;margin-top:10px">'+
      '<button class="btn btn-sm btn-primary" id="mmSave">💾 保存并应用</button>'+
      '<button class="btn btn-sm" id="mmReset">↺ 恢复默认</button>'+
      '<span id="mmMsg" style="font-size:11px;color:var(--text3);align-self:center"></span></div>';
    host.innerHTML = html;

    host.querySelectorAll('.mm-up').forEach(function(b){
      b.onclick = function(){ _move(b.getAttribute('data-k'), -1); render(); };
    });
    host.querySelectorAll('.mm-down').forEach(function(b){
      b.onclick = function(){ _move(b.getAttribute('data-k'), 1); render(); };
    });
    host.querySelectorAll('.mm-vis').forEach(function(cb){
      cb.onchange = function(){
        var k = cb.getAttribute('data-k');
        var h = getHidden();
        if (!cb.checked && !h.includes(k)) h.push(k);
        if (cb.checked) h = h.filter(function(x){ return x !== k; });
        setHidden(h);
      };
    });
    var save = $id('mmSave');
    if (save) save.onclick = function(){
      // 顺序已在每次移动时更新, hidden 也已写入
      _msg('✓ 已保存, 刷新页面生效');
      setTimeout(function(){ location.reload(); }, 800);
    };
    var reset = $id('mmReset');
    if (reset) reset.onclick = function(){
      saveOrder([]); setHidden([]); _msg('✓ 已恢复默认'); render();
    };
  }

  function _msg(t){ var el = $id('mmMsg'); if (el) el.textContent = t; }

  function _move(key, dir){
    var order = getOrder();
    var menus = readMenus();
    var allKeys = menus.map(function(m){ return m.key; });
    // 基于当前 DOM 实际顺序构建
    var domOrder = Array.from(document.querySelectorAll('.main-tabs .tab[data-group]')).map(function(b){ return b.dataset.group; });
    // 如果 order 为空或与 DOM 长度不同, 初始化为 DOM 顺序
    if (order.length !== allKeys.length) order = domOrder.slice();
    var idx = order.indexOf(key);
    var target = idx + dir;
    if (idx < 0 || target < 0 || target >= order.length) return;
    order.splice(idx, 1);
    order.splice(target, 0, key);
    saveOrder(order);
  }

  // 供 app.js applyPermissions 后调用: 按保存顺序重排 DOM
  function applyOrder(){
    var order = getOrder();
    var hidden = getHidden();
    if (!order.length && !hidden.length) return;
    var bar = document.querySelector('.main-tabs');
    if (!bar) return;
    var btns = {};
    Array.from(bar.querySelectorAll('.tab[data-group]')).forEach(function(b){ btns[b.dataset.group] = b; });
    // 排序
    var lastRef = null;
    order.forEach(function(k){
      var b = btns[k];
      if (!b) return;
      if (lastRef) bar.insertBefore(b, lastRef.nextSibling);
      lastRef = b;
    });
    // 隐藏
    hidden.forEach(function(k){
      var b = btns[k];
      if (b) b.style.display = 'none';
    });
  }

  g.MenuMgr = { render: render, applyOrder: applyOrder };
})(window);
