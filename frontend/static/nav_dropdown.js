/* v4.15.29 · 主菜单下拉：把带 ▾ 的主 tab 拆成 [文字 | ▾] 两个可点区。
 *
 * 需求：
 *   - 点文字 → 走原 switchGroup（打开首个子项/上次记忆项）
 *   - 点 ▾   → 弹出二级菜单下拉，用户直接选具体子项
 *   - 无 children 的 tab（如文件传输/远端存储/仪表盘）保持原样，无 ▾
 *
 * 依赖：
 *   window.NAV_TREE（app.js 已导出）
 *   window.switchGroup / window.switchTab
 */
(function(){
  // ---- 找到某 group 的 children（跟 switchGroup 权限过滤一致）----
  function visibleChildren(group){
    if (!group || !group.children) return null;
    // v5.85.0 · 改用 app.js 的**单一真源**(含功能键隐藏 + 社区内置表 + 用户权限);
    //   此前这里只过滤用户权限 → 下拉里会列出别的版本才有的菜单(用户实测)
    var fn = window.navChildVisible;
    if (typeof fn === 'function') return group.children.filter(fn);
    var isAdmin = (window.currentUser && window.currentUser.role === 'admin');
    var perms = (window.currentUser && Array.isArray(window.currentUser.permissions))
                ? window.currentUser.permissions : null;
    return group.children.filter(function(c){
      return isAdmin || !perms || perms.indexOf(c.key) >= 0;
    });
  }

  // ---- 关闭当前打开的下拉 ----
  function closeMenu(){
    var m = document.getElementById('navDropdownMenu');
    if (m) m.remove();
    document.removeEventListener('mousedown', _outsideHandler, true);
    document.removeEventListener('keydown', _escHandler, true);
  }
  function _outsideHandler(ev){
    var m = document.getElementById('navDropdownMenu');
    if (!m) return;
    if (m.contains(ev.target)) return;
    // 点到 caret 本身别关（否则会立刻重开）
    if (ev.target && ev.target.classList && ev.target.classList.contains('tab-caret')) return;
    closeMenu();
  }
  function _escHandler(ev){
    if (ev.key === 'Escape') closeMenu();
  }

  // ---- 打开下拉 ----
  function openMenu(anchorBtn, group){
    closeMenu();
    var kids = visibleChildren(group);
    if (!kids || !kids.length){
      if (window.toast) toast('该分组内无可访问项', 'warn', 1800);
      return;
    }
    var rect = anchorBtn.getBoundingClientRect();
    var m = document.createElement('div');
    m.id = 'navDropdownMenu';
    m.className = 'nav-dropdown-menu';
    m.style.top = (rect.bottom + 2) + 'px';
    m.style.left = rect.left + 'px';
    m.style.minWidth = Math.max(rect.width, 180) + 'px';
    m.innerHTML = kids.map(function(c){
      return '<div class="nav-dropdown-item" data-key="' + c.key + '">' + c.label + '</div>';
    }).join('');
    document.body.appendChild(m);
    // 委托点击
    m.addEventListener('click', function(ev){
      var el = ev.target;
      while (el && el !== m && !(el.classList && el.classList.contains('nav-dropdown-item'))){
        el = el.parentNode;
      }
      if (!el || el === m) return;
      var key = el.dataset && el.dataset.key;
      closeMenu();
      if (key && typeof window.switchTab === 'function') window.switchTab(key);
    });
    // 稍后再挂 outside，避免捕捉到本次触发的点击
    setTimeout(function(){
      document.addEventListener('mousedown', _outsideHandler, true);
      document.addEventListener('keydown', _escHandler, true);
    }, 0);
  }

  // ---- 改造一个主 tab 按钮 ----
  function rebuildTab(btn){
    var groupKey = btn.dataset && btn.dataset.group;
    if (!groupKey) return;
    var group = (window.NAV_TREE || []).find(function(g){ return g.key === groupKey; });
    if (!group) return;
    // 剥掉 label 末尾的 ▾/▼（如果 index.html 里手工写了）
    var raw = btn.textContent || '';
    var label = raw.replace(/[\s\u00A0]*[▾▼][\s\u00A0]*$/, '').trim();
    var hasChildren = !!(group.children && group.children.length);
    // 清空并重建为分离 span
    btn.innerHTML = '';
    var lab = document.createElement('span');
    lab.className = 'tab-label';
    lab.textContent = label;
    btn.appendChild(lab);
    if (hasChildren){
      var caret = document.createElement('span');
      caret.className = 'tab-caret';
      caret.textContent = '▾';
      caret.title = '展开二级菜单';
      btn.appendChild(caret);
      btn.classList.add('has-caret');
    }
    // 剥掉原 inline onclick，改事件委托（点文字 → switchGroup；点 caret → 弹下拉）
    btn.onclick = null;
    btn.addEventListener('click', function(ev){
      var t = ev.target;
      if (hasChildren && t && t.classList && t.classList.contains('tab-caret')){
        ev.stopPropagation();
        openMenu(btn, group);
      } else {
        // 点文字（或整按钮空白处）→ 走原 switchGroup
        if (typeof window.switchGroup === 'function') window.switchGroup(groupKey);
      }
    });
  }

  function init(){
    if (!Array.isArray(window.NAV_TREE)){
      // NAV_TREE 尚未定义，稍后重试
      return setTimeout(init, 100);
    }
    var btns = document.querySelectorAll('.main-tabs .tab[data-group]');
    btns.forEach(rebuildTab);
  }

  if (document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', init);
  } else {
    // 也可能 app.js 还没跑到 NAV_TREE，用小延迟兜底
    setTimeout(init, 0);
  }

  // 暴露调试
  window.NavDropdown = { init: init, close: closeMenu, open: openMenu };
})();
