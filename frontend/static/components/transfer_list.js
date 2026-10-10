/*
 * transfer_list.js  ·  Fonriv v4.30.0
 * 可复用传输列表组件 · 每个宿主面板一份独立列表
 *
 * 用法:
 *   var tl = TransferList.mount(hostEl, {
 *     panelId: 'transfer',
 *     storageKey: 'transferList.transfer',   // localStorage key
 *     title: '📋 传输列表',
 *     dstHint: '本地目录 / 远端目录',
 *     defaultDst: '/backups/',
 *     onSubmit: function(items){ ... },      // 点击 ▶ 执行
 *     onChange: function(items){ ... },       // 每次列表变动
 *   });
 *
 * 公开 API:
 *   TransferList.get(panelId)               → items[]
 *   TransferList.add(panelId, items)         → 追加
 *   TransferList.clear(panelId)              → 清空
 *   TransferList.instance(panelId)           → 实例（含 render/refresh 等）
 *
 * items 元素结构:
 *   { id:'uuid', src:'/mnt/x/a.log', dst:'/backups/', type:'file|dir|partition', size:12345, note:'' }
 */
(function(){
  'use strict';

  var _instances = {};  // panelId -> instance

  function _uuid(){
    return 'tl_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2,8);
  }
  function _esc(s){
    return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
    });
  }
  function _fmtBytes(n){
    if (n == null || isNaN(n)) return '—';
    n = Number(n);
    if (n < 1024) return n + ' B';
    if (n < 1024*1024) return (n/1024).toFixed(1) + ' KB';
    if (n < 1024*1024*1024) return (n/1024/1024).toFixed(1) + ' MB';
    if (n < 1024*1024*1024*1024) return (n/1024/1024/1024).toFixed(2) + ' GB';
    return (n/1024/1024/1024/1024).toFixed(2) + ' TB';
  }
  function _load(key){
    if (!key) return [];
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return [];
      var arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch(e){ return []; }
  }
  function _save(key, items){
    if (!key) return;
    try { localStorage.setItem(key, JSON.stringify(items || [])); } catch(e){}
  }

  function _toast(msg, level){
    if (window.toast) window.toast(msg, level || 'info');
    else console.log('[TransferList]', msg);
  }

  // 单个实例工厂
  function _create(hostEl, opts){
    opts = opts || {};
    var self = {
      panelId: opts.panelId || 'default',
      storageKey: opts.storageKey || null,
      title: opts.title || '📋 传输列表',
      dstHint: opts.dstHint || '目标路径',
      defaultDst: opts.defaultDst || '',
      onSubmit: opts.onSubmit || null,
      onChange: opts.onChange || null,
      threeColumn: !!opts.threeColumn,  // v4.38.22 · 三列布局（mini 文件浏览器 + 列表）
      items: [],
      host: hostEl,
      wrap: null,
    };
    self.items = _load(self.storageKey);

    function _fire(){
      _save(self.storageKey, self.items);
      if (typeof self.onChange === 'function') {
        try { self.onChange(self.items.slice()); } catch(e){}
      }
      render();
    }

    // ---- 增删 ----
    function addItems(list){
      if (!list) return;
      if (!Array.isArray(list)) list = [list];
      var added = 0;
      for (var i=0;i<list.length;i++){
        var it = list[i];
        if (!it || !it.src) continue;
        // 去重（src+dst 一致视作重复）
        var dup = false;
        for (var j=0;j<self.items.length;j++){
          if (self.items[j].src === it.src && (self.items[j].dst||'') === (it.dst||'')){
            dup = true; break;
          }
        }
        if (dup) continue;
        self.items.push({
          id: it.id || _uuid(),
          src: String(it.src),
          dst: it.dst != null ? String(it.dst) : self.defaultDst,
          type: it.type || _guessType(it.src),
          size: it.size != null ? Number(it.size) : null,
          note: it.note || '',
        });
        added++;
      }
      _fire();
      return added;
    }
    function _guessType(p){
      if (!p) return 'file';
      if (/[/\\]$/.test(p)) return 'dir';
      // 若是 /dev/sd? 类块设备 → partition
      if (/^\/dev\//.test(p)) return 'partition';
      return 'file';
    }
    function removeById(id){
      self.items = self.items.filter(function(x){ return x.id !== id; });
      _fire();
    }
    async function removeSelected(){
      var chk = _selectedIds();
      if (!chk.length){ _toast('未选中任何行','warn'); return; }
      if (!(await rpConfirm({ title:'删除选中项', danger:true, okText:'删除', body:'删除选中的 ' + chk.length + ' 项？' }))) return;
      self.items = self.items.filter(function(x){ return chk.indexOf(x.id) === -1; });
      _fire();
    }
    async function clearAll(){
      if (!self.items.length) return;
      if (!(await rpConfirm({ title:'清空全部', danger:true, okText:'清空', body:'清空全部 ' + self.items.length + ' 项？' }))) return;
      self.items = [];
      _fire();
    }
    function moveUp(){
      var chk = _selectedIds();
      if (!chk.length) return;
      for (var i=1;i<self.items.length;i++){
        if (chk.indexOf(self.items[i].id) !== -1
            && chk.indexOf(self.items[i-1].id) === -1){
          var tmp = self.items[i-1]; self.items[i-1] = self.items[i]; self.items[i] = tmp;
        }
      }
      _fire();
    }
    function moveDown(){
      var chk = _selectedIds();
      if (!chk.length) return;
      for (var i=self.items.length-2;i>=0;i--){
        if (chk.indexOf(self.items[i].id) !== -1
            && chk.indexOf(self.items[i+1].id) === -1){
          var tmp = self.items[i+1]; self.items[i+1] = self.items[i]; self.items[i] = tmp;
        }
      }
      _fire();
    }
    function _selectedIds(){
      var boxes = self.wrap ? self.wrap.querySelectorAll('.tl-chk:checked') : [];
      var out = [];
      for (var i=0;i<boxes.length;i++){ out.push(boxes[i].getAttribute('data-id')); }
      return out;
    }

    // ---- 手动添加 ----
    function _addManual(){
      var srcEl = self.wrap.querySelector('.tl-add-src');
      var dstEl = self.wrap.querySelector('.tl-add-dst');
      var src = (srcEl && srcEl.value || '').trim();
      var dst = (dstEl && dstEl.value || '').trim() || self.defaultDst;
      if (!src){ _toast('请填源路径','warn'); if (srcEl) srcEl.focus(); return; }
      // 支持多行粘贴 · 每行一条
      var lines = src.split(/\r?\n/).map(function(s){ return s.trim(); }).filter(Boolean);
      var arr = lines.map(function(ln){ return { src:ln, dst:dst }; });
      var n = addItems(arr);
      if (n > 0){
        _toast('已添加 ' + n + ' 项','ok');
        if (srcEl) srcEl.value = '';
      }
    }

    // ---- 执行 ----
    function _submit(){
      if (!self.items.length){ _toast('列表为空','warn'); return; }
      if (typeof self.onSubmit === 'function') {
        try { self.onSubmit(self.items.slice()); }
        catch(e){ console.error('[TransferList] onSubmit', e); _toast('执行失败: ' + e.message,'err'); }
      } else {
        _toast('该面板未定义 onSubmit','warn');
      }
    }

    // ---- 编辑 dst ----
    async function _editDst(id){
      var it = null;
      for (var i=0;i<self.items.length;i++){
        if (self.items[i].id === id){ it = self.items[i]; break; }
      }
      if (!it) return;
      var v = await rpPrompt({ title:'目标路径 (dst)', defaultName: it.dst || '' });
      if (v == null) return;
      it.dst = v;
      _fire();
    }
    async function _editSrc(id){
      var it = null;
      for (var i=0;i<self.items.length;i++){
        if (self.items[i].id === id){ it = self.items[i]; break; }
      }
      if (!it) return;
      var v = await rpPrompt({ title:'源路径 (src)', defaultName: it.src || '' });
      if (v == null) return;
      it.src = String(v).trim();
      _fire();
    }

    // ---- 拖拽排序 ----
    var _dragId = null;
    function _onDragStart(e){
      var row = e.target.closest && e.target.closest('.tl-row');
      if (!row) return;
      _dragId = row.getAttribute('data-id');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', _dragId); } catch(_){}
      row.style.opacity = '0.4';
    }
    function _onDragEnd(e){
      var row = e.target.closest && e.target.closest('.tl-row');
      if (row) row.style.opacity = '';
      _dragId = null;
    }
    function _onDragOver(e){ e.preventDefault(); }
    function _onDrop(e){
      e.preventDefault();
      var row = e.target.closest && e.target.closest('.tl-row');
      if (!row || !_dragId) return;
      var toId = row.getAttribute('data-id');
      if (toId === _dragId) return;
      var fromIdx = -1, toIdx = -1;
      for (var i=0;i<self.items.length;i++){
        if (self.items[i].id === _dragId) fromIdx = i;
        if (self.items[i].id === toId) toIdx = i;
      }
      if (fromIdx < 0 || toIdx < 0) return;
      var item = self.items.splice(fromIdx, 1)[0];
      self.items.splice(toIdx, 0, item);
      _fire();
    }

    // v4.38.22 · 三列布局：初始化本地/远端 mini 浏览器
    function _initThreeColumnPanes(){
      if (!window.FileBrowser || typeof window.FileBrowser.createPane !== 'function'){
        console.warn('[TransferList] FileBrowser not available · 3col panes disabled');
        return;
      }
      var leftHost = self.wrap.querySelector('.tl-3col-left');
      var rightHost = self.wrap.querySelector('.tl-3col-right');
      if (!leftHost || !rightHost) return;

      // 左：本地浏览（与 tri_pane 一致）
      var localPane = window.FileBrowser.createPane({
        side: 'local',
        title: '📁 本地',
        showSelectMode: true,
        onAdd: function(p){
          // 默认 dst 用 defaultDst（可手动改）
          addItem({ id: _uuid(), src: p, dst: self.defaultDst, type: 'file' });
        },
        onAddMany: function(paths){
          // 批量加（selectMode 勾选）
          for (var i=0;i<paths.length;i++){
            addItem({ id: _uuid(), src: paths[i], dst: self.defaultDst, type: 'file' });
          }
        },
      });
      leftHost.appendChild(localPane.pane || localPane);
      // v4.38.22 · 不自动 load，避免与上方面板 WS 冲突；等用户点击"刷新"或上方面板连接后通过 __setEntries 同步
      // try { localPane.load && localPane.load('/'); } catch(e){ console.warn('[TransferList] localPane load', e); }

      // 右：远端浏览（与 tri_pane 一致）
      var remotePane = window.FileBrowser.createPane({
        side: 'remote',
        title: '🌐 远端',
        onTargetSelect: function(p){
          // 单击设目标 (v4.38.22 rev · 单击=进入+设目标)
          self.defaultDst = p;
          var dstInput = self.wrap.querySelector('.tl-add-dst');
          if (dstInput) dstInput.value = p;
        },
        onAdd: function(p){
          // 远端文件 = 源，加到列表（拉取方向：远端→本地）
          addItem({ id: _uuid(), src: p, dst: self.defaultDst, type: 'file' });
        },
        onCwdChange: function(cwd){
          // 远端 cwd 变化时，把 defaultDst 同步到 cwd
          // 仅在用户没设过自定义目标时同步
          if (self.defaultDst && (self.defaultDst === '/' || self.defaultDst === '')){
            self.defaultDst = cwd + '/';
            var dstInput = self.wrap.querySelector('.tl-add-dst');
            if (dstInput) dstInput.value = self.defaultDst;
          }
        },
      });
      rightHost.appendChild(remotePane.pane || remotePane);
      // v4.38.22 · 远端不自动 load，避免与上方面板 WS 冲突；上方面板连接后通过 __setEntries 同步
      // try { remotePane.load && remotePane.load('/'); } catch(e){ console.warn('[TransferList] remotePane load', e); }

      // 拖拽列宽（同 tri_pane）
      _initThreeColumnGrips();
    }

    function _initThreeColumnGrips(){
      var grid = self.wrap.querySelector('.tl-3col-grid');
      if (!grid) return;
      var grips = self.wrap.querySelectorAll('.tl-3col-grip');
      var _widths = (function(){
        try { var v = localStorage.getItem('tl_3col_widths_v1'); if (v) return JSON.parse(v); } catch(_){}
        return { left: 1, mid: 1.2, right: 1 };
      })();
      grid.style.gridTemplateColumns = '1fr 0px 1.2fr 0px 1fr';  // v6.16.12 · 取消左右拖拽条(固定自适应)
      for (var i=0;i<grips.length;i++){
        (function(grip){
          grip.innerHTML = '<div style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:2px;height:30px;background:var(--border);border-radius:1px"></div>';
          grip.addEventListener('mouseenter', function(){ grip.firstElementChild.style.background = 'var(--cyan)'; });
          grip.addEventListener('mouseleave', function(){ grip.firstElementChild.style.background = 'var(--border)'; });
          var _drag = null;
          grip.addEventListener('mousedown', function(downEv){
            downEv.preventDefault();
            var rect = grid.getBoundingClientRect();
            var startX = downEv.clientX;
            var cols = grid.style.gridTemplateColumns.match(/[\d.]+fr/g);
            if (!cols || cols.length < 3) return;
            var leftFr = parseFloat(cols[0]) || _widths.left;
            var midFr = parseFloat(cols[2]) || _widths.mid;
            var rightFr = parseFloat(cols[4]) || _widths.right;
            var total = leftFr + midFr + rightFr;
            var colIdx = grip.getAttribute('data-col') === 'left' ? 0 : 2;
            _drag = { rect: rect, startX: startX, leftFr: leftFr, midFr: midFr, rightFr: rightFr, total: total, colIdx: colIdx };
          });
          document.addEventListener('mousemove', function(mmEv){
            if (!_drag) return;
            var dx = mmEv.clientX - _drag.startX;
            var containerW = _drag.rect.width;
            var dFr = (dx / containerW) * _drag.total;
            if (_drag.colIdx === 0){
              var newL = Math.max(0.4, Math.min(_drag.total - 1, _drag.leftFr + dFr));
              var delta = newL - _drag.leftFr;
              _drag.leftFr = newL; _drag.midFr -= delta;
              grid.style.gridTemplateColumns = _drag.leftFr.toFixed(2) + 'fr 6px ' + _drag.midFr.toFixed(2) + 'fr 6px ' + _drag.rightFr.toFixed(2) + 'fr';
            } else {
              var newM = Math.max(0.4, Math.min(_drag.total - 1, _drag.midFr + dFr));
              var delta2 = newM - _drag.midFr;
              _drag.midFr = newM; _drag.rightFr -= delta2;
              grid.style.gridTemplateColumns = _drag.leftFr.toFixed(2) + 'fr 6px ' + _drag.midFr.toFixed(2) + 'fr 6px ' + _drag.rightFr.toFixed(2) + 'fr';
            }
          });
          document.addEventListener('mouseup', function(){
            if (!_drag) return;
            try { localStorage.setItem('tl_3col_widths_v1', JSON.stringify({ left: _drag.leftFr, mid: _drag.midFr, right: _drag.rightFr })); } catch(_){}
            _drag = null;
          });
        })(grips[i]);
      }
    }

    // ---- 渲染 ----
    function render(){
      if (!self.wrap) return;
      var body = self.wrap.querySelector('.tl-body');
      var totalBytes = 0;
      var haveSize = false;
      self.items.forEach(function(x){
        if (x.size != null && !isNaN(x.size)){ totalBytes += Number(x.size); haveSize = true; }
      });
      var stat = self.wrap.querySelector('.tl-stat');
      if (stat){
        stat.textContent = '(' + self.items.length + ' 项'
          + (haveSize ? ' · ' + _fmtBytes(totalBytes) : '')
          + ')';
      }
      if (!body) return;
      if (!self.items.length){
        body.innerHTML = '<div class="tl-empty" style="padding:20px;text-align:center;color:var(--text3);font-size:12px">📭 传输列表为空 · 从磁盘管理浏览或下方手动添加</div>';
        return;
      }
      var html = '';
      for (var i=0;i<self.items.length;i++){
        var it = self.items[i];
        var typeIcon = it.type === 'dir' ? '📂' : (it.type === 'partition' ? '💽' : '📄');
        html += '<div class="tl-row" draggable="true" data-id="'+_esc(it.id)+'" '
          + 'style="display:flex;align-items:center;gap:6px;padding:5px 6px;border-bottom:1px solid var(--border);font-size:12px;cursor:grab">'
          + '<input type="checkbox" class="tl-chk" data-id="'+_esc(it.id)+'" style="margin:0">'
          + '<span style="color:var(--text3);width:16px;flex-shrink:0" title="'+_esc(it.type||'')+'">'+typeIcon+'</span>'
          + '<span class="tl-src" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer" '
          +     'title="双击编辑 · '+_esc(it.src)+'" ondblclick="TransferList._editSrc(\''+_esc(self.panelId)+'\',\''+_esc(it.id)+'\')">'+_esc(it.src)+'</span>'
          + '<span style="color:var(--text3);flex-shrink:0">→</span>'
          + '<span class="tl-dst" style="min-width:120px;max-width:250px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--cyan);cursor:pointer" '
          +     'title="双击编辑 · '+_esc(it.dst||'')+'" ondblclick="TransferList._editDst(\''+_esc(self.panelId)+'\',\''+_esc(it.id)+'\')">'+_esc(it.dst||'(默认)')+'</span>'
          + '<span style="color:var(--text3);flex-shrink:0;font-size:11px;min-width:60px;text-align:right">'+_esc(_fmtBytes(it.size))+'</span>'
          + '<button class="btn btn-sm" style="padding:2px 6px;font-size:11px" title="删除本行" '
          +     'onclick="TransferList._del(\''+_esc(self.panelId)+'\',\''+_esc(it.id)+'\')">✕</button>'
          + '</div>';
      }
      body.innerHTML = html;
      // 绑定拖拽
      body.querySelectorAll('.tl-row').forEach(function(r){
        r.addEventListener('dragstart', _onDragStart);
        r.addEventListener('dragend', _onDragEnd);
        r.addEventListener('dragover', _onDragOver);
        r.addEventListener('drop', _onDrop);
      });
    }

    function _selectAll(v){
      if (!self.wrap) return;
      var boxes = self.wrap.querySelectorAll('.tl-chk');
      for (var i=0;i<boxes.length;i++){ boxes[i].checked = !!v; }
    }

    function _build(){
      var w = self.threeColumn ? _buildThreeColumn() : _buildSingleColumn();
      return w;
    }

    // v4.38.22 · 三列布局：左=本地浏览 中=传输项列表 右=远端浏览
    // 复用 FileBrowser.createPane（与上方 tri_pane 一致）
    function _buildThreeColumn(){
      var w = document.createElement('div');
      w.className = 'section tl-widget tl-3col';
      w.setAttribute('data-panel-id', self.panelId);
      w.style.margin = '12px 0';
      w.innerHTML =
        '<div class="section-header" onclick="toggleSection(this)">'
        + '<span>📋</span><span class="section-title">'+_esc(self.title)+'</span>'
        + '<span class="tl-stat" style="color:var(--text3);font-size:11px;margin-left:8px">(0 项)</span>'
        + '<span class="section-arrow">▼</span></div>'
        + '<div class="section-body">'
        // 工具栏（保持原样）
        +   '<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:8px">'
        +     '<button class="btn btn-sm" onclick="TransferList._selAll(\''+_esc(self.panelId)+'\', true)">全选</button>'
        +     '<button class="btn btn-sm" onclick="TransferList._selAll(\''+_esc(self.panelId)+'\', false)">全不选</button>'
        +     '<button class="btn btn-sm" onclick="TransferList._up(\''+_esc(self.panelId)+'\')">↑ 上移</button>'
        +     '<button class="btn btn-sm" onclick="TransferList._down(\''+_esc(self.panelId)+'\')">↓ 下移</button>'
        +     '<button class="btn btn-sm" onclick="TransferList._delSel(\''+_esc(self.panelId)+'\')">🗑 删除选中</button>'
        +     '<button class="btn btn-sm" onclick="TransferList._clear(\''+_esc(self.panelId)+'\')" style="color:var(--red)">✕ 清空</button>'
        +     '<span style="flex:1"></span>'
        +     '<button class="btn btn-sm btn-primary" onclick="TransferList._submit(\''+_esc(self.panelId)+'\')">▶ 开始传输</button>'
        +   '</div>'
        // 三列 grid
        +   '<div class="tl-3col-grid" style="display:grid;grid-template-columns:1fr 0px 1.2fr 0px 1fr;gap:0;margin:0 0 8px;min-height:360px;max-height:50vh;height:50vh;overflow:hidden;align-items:stretch">'
        // 左：本地 mini 浏览器
        +     '<div class="tl-3col-left" style="display:flex;flex-direction:column;border:1px solid var(--border);border-radius:8px;background:var(--bg2);overflow:hidden;min-width:0;margin-right:3px"></div>'
        // grip
        +     '<div class="tl-3col-grip" data-col="left" style="width:0;display:none"></div>'  // v6.16.12 · 取消左右拖拽条
        // 中：列表
        +     '<div class="tl-3col-mid" style="display:flex;flex-direction:column;border:1px solid var(--border);border-radius:8px;background:var(--bg2);overflow:hidden;min-width:0;margin:0 3px">'
        +       '<div class="tl-body" style="flex:1 1 0;min-height:0;height:0;overflow:auto"></div>'
        +     '</div>'
        // grip
        +     '<div class="tl-3col-grip" data-col="right" style="width:0;display:none"></div>'  // v6.16.12 · 取消左右拖拽条
        // 右：远端 mini 浏览器
        +     '<div class="tl-3col-right" style="display:flex;flex-direction:column;border:1px solid var(--border);border-radius:8px;background:var(--bg2);overflow:hidden;min-width:0;margin-left:3px"></div>'
        +   '</div>'
        // 手动添加行
        +   '<div style="margin-top:4px;display:flex;gap:6px;flex-wrap:wrap;align-items:center;font-size:11px;color:var(--text3)">'
        +     '<span>➕ 手动添加：</span>'
        +     '<input class="input tl-add-src" placeholder="源路径 (每行一条也 OK)" style="flex:1;min-width:180px;font-size:11px;padding:3px 6px">'
        +     '<span>→</span>'
        +     '<input class="input tl-add-dst" placeholder="'+_esc(self.dstHint)+'" value="'+_esc(self.defaultDst)+'" style="min-width:140px;font-size:11px;padding:3px 6px">'
        +     '<button class="btn btn-sm" onclick="TransferList._addManual(\''+_esc(self.panelId)+'\')">➕ 添加</button>'
        +   '</div>'
        + '</div>';
      return w;
    }

    // v4.38.22 · 单列（原版）布局
    function _buildSingleColumn(){
      var w = document.createElement('div');
      w.className = 'section tl-widget';
      w.setAttribute('data-panel-id', self.panelId);
      w.style.margin = '12px 0';
      w.innerHTML =
        '<div class="section-header" onclick="toggleSection(this)">'
        + '<span>📋</span><span class="section-title">'+_esc(self.title)+'</span>'
        + '<span class="tl-stat" style="color:var(--text3);font-size:11px;margin-left:8px">(0 项)</span>'
        + '<span class="section-arrow">▼</span></div>'
        + '<div class="section-body">'
        +   '<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:8px">'
        +     '<button class="btn btn-sm" onclick="TransferList._selAll(\''+_esc(self.panelId)+'\', true)">全选</button>'
        +     '<button class="btn btn-sm" onclick="TransferList._selAll(\''+_esc(self.panelId)+'\', false)">全不选</button>'
        +     '<button class="btn btn-sm" onclick="TransferList._up(\''+_esc(self.panelId)+'\')">↑ 上移</button>'
        +     '<button class="btn btn-sm" onclick="TransferList._down(\''+_esc(self.panelId)+'\')">↓ 下移</button>'
        +     '<button class="btn btn-sm" onclick="TransferList._delSel(\''+_esc(self.panelId)+'\')">🗑 删除选中</button>'
        +     '<button class="btn btn-sm" onclick="TransferList._clear(\''+_esc(self.panelId)+'\')" style="color:var(--red)">✕ 清空</button>'
        +     '<span style="flex:1"></span>'
        +     '<button class="btn btn-sm btn-primary" onclick="TransferList._submit(\''+_esc(self.panelId)+'\')">▶ 开始传输</button>'
        +   '</div>'
        +   '<div class="tl-body" style="max-height:50vh;min-height:200px;overflow:auto;border:1px solid var(--border);border-radius:6px;background:var(--bg2)"></div>'
        +   '<div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap;align-items:center;font-size:11px;color:var(--text3)">'
        +     '<span>➕ 手动添加：</span>'
        +     '<input class="input tl-add-src" placeholder="源路径 (每行一条也 OK)" style="flex:1;min-width:180px;font-size:11px;padding:3px 6px">'
        +     '<span>→</span>'
        +     '<input class="input tl-add-dst" placeholder="'+_esc(self.dstHint)+'" value="'+_esc(self.defaultDst)+'" style="min-width:140px;font-size:11px;padding:3px 6px">'
        +     '<button class="btn btn-sm" onclick="TransferList._addManual(\''+_esc(self.panelId)+'\')">➕ 添加</button>'
        +   '</div>'
        + '</div>';
      return w;
    }

    self.wrap = _build();
    self.host.appendChild(self.wrap);
    // v4.38.22 · 三列布局：初始化本地/远端 mini 浏览器
    if (self.threeColumn){
      _initThreeColumnPanes();
    }
    render();

    // 挂到实例池
    var api = {
      panelId: self.panelId,
      wrap: self.wrap,
      get: function(){ return self.items.slice(); },
      addItems: addItems,
      removeById: removeById,
      removeSelected: removeSelected,
      clearAll: clearAll,
      moveUp: moveUp,
      moveDown: moveDown,
      render: render,
      selectAll: _selectAll,
      submit: _submit,
      addManual: _addManual,
      editDst: _editDst,
      editSrc: _editSrc,
    };
    _instances[self.panelId] = api;
    return api;
  }

  // ---- 静态入口（挂到 window.TransferList）----
  var TL = {
    __version: 'v4.30.0',
    mount: function(hostEl, opts){
      if (!hostEl){ console.warn('[TransferList] host is null'); return null; }
      // 已存在则不重复挂载
      var pid = (opts && opts.panelId) || 'default';
      if (_instances[pid] && document.body.contains(_instances[pid].wrap)){
        return _instances[pid];
      }
      // 清理旧实例（可能宿主 DOM 已被替换）
      if (_instances[pid]) delete _instances[pid];
      return _create(hostEl, opts);
    },
    instance: function(panelId){ return _instances[panelId] || null; },
    get: function(panelId){
      var inst = _instances[panelId];
      return inst ? inst.get() : [];
    },
    add: function(panelId, items){
      var inst = _instances[panelId];
      if (!inst) return 0;
      return inst.addItems(items);
    },
    clear: function(panelId){
      var inst = _instances[panelId];
      if (inst) inst.clearAll();
    },
    // inline onclick 代理
    _selAll: function(pid, v){ var i=_instances[pid]; if (i) i.selectAll(v); },
    _up: function(pid){ var i=_instances[pid]; if (i) i.moveUp(); },
    _down: function(pid){ var i=_instances[pid]; if (i) i.moveDown(); },
    _delSel: function(pid){ var i=_instances[pid]; if (i) i.removeSelected(); },
    _clear: function(pid){ var i=_instances[pid]; if (i) i.clearAll(); },
    _submit: function(pid){ var i=_instances[pid]; if (i) i.submit(); },
    _addManual: function(pid){ var i=_instances[pid]; if (i) i.addManual(); },
    _del: function(pid, id){ var i=_instances[pid]; if (i) i.removeById(id); },
    _editDst: function(pid, id){ var i=_instances[pid]; if (i) i.editDst(id); },
    _editSrc: function(pid, id){ var i=_instances[pid]; if (i) i.editSrc(id); },
  };
  window.TransferList = TL;

  // ==== v4.30.0 · autoInject 到 3 个宿主面板 · v4.37.0 调整注入点 ====
  // v4.38.24 · transfer 页面已精简：删除 transfer 面板的"传输列表-rsync"（由独立 panel-disk_manager 的 TransferList 承担）
  // v4.38.24 · 同时删除 flow_mini_transfer 注入（与 transfer_list 配合，已经废弃）
  var AUTO_INJECT = [
    // v4.38.24 · 跨模块共享 TransferList · 嵌在 platform_backup 的 pbExtraPaths 下方
    //   原有 platform_backup 实例保留 panelId 不变（disk_manager 加入传输弹窗认这个 id）
    //   注入点从 panel 末尾改为 pbExtraPathsWrap 之后 · onSubmit 同步到 textarea
    { panelSel:'#panel-platform_backup',  panelId:'platform_backup',
      title:'📋 跨模块传输列表 · 额外源目录/文件',
      dstHint:'（备份到目标位置栏配置）',
      defaultDst:'',
      insertAfter: '#pbExtraPathsWrap',
      onSubmit: function(items){
        // v4.37.0 · 同步到 pbExtraPaths textarea（每行一条）· 保留原 setExtraPaths 调用
        var ta = document.getElementById('pbExtraPaths');
        if (ta){
          ta.value = items.map(function(x){ return x.src; }).join('\n');
          try{ ta.dispatchEvent(new Event('input',{bubbles:true})); }catch(_){}
        }
        if (window.PlatformBackup && typeof window.PlatformBackup.setExtraPaths === 'function'){
          window.PlatformBackup.setExtraPaths(items.map(function(x){ return x.src; }));
          if (window.toast) toast('已同步到额外路径 + extra_paths','ok');
        } else {
          if (window.toast) toast('已同步到额外路径 textarea','ok');
        }
      }
    }
  ];

  function _tryInject(){
    for (var i=0;i<AUTO_INJECT.length;i++){
      var cfg = AUTO_INJECT[i];
      console.log('[TransferList] try inject', cfg.panelId, 'sel=', cfg.panelSel);
      // 已挂过跳过
      if (_instances[cfg.panelId]
          && document.body.contains(_instances[cfg.panelId].wrap)){
        console.log('[TransferList] skip (already mounted):', cfg.panelId);
        continue;
      }
      var host = document.querySelector(cfg.panelSel);
      if (!host){ console.log('[TransferList] host NOT found:', cfg.panelSel); continue; }
      console.log('[TransferList] host found:', cfg.panelSel);
      // insertBefore 支持
      if (cfg.insertBefore){
        var anchor = host.querySelector(cfg.insertBefore);
        if (anchor){
          var wrapWrap = document.createElement('div');
          // v4.38.12 · 必须用 anchor.parentNode.insertBefore，否则当 anchor 是 host
          // 的孙节点时（如 #transferParamsSection 在 #panel-transfer 的内层 padding
          // div 里）host.insertBefore(wrap, anchor) 会抛 NotFoundError，导致整个
          // _tryInject 循环中断，TransferList 永远挂不上去。
          anchor.parentNode.insertBefore(wrapWrap, anchor);
          TL.mount(wrapWrap, {
            panelId: cfg.panelId,
            storageKey: 'transferList.' + cfg.panelId,
            title: cfg.title,
            dstHint: cfg.dstHint,
            defaultDst: cfg.defaultDst,
            onSubmit: cfg.onSubmit,
          });
          console.log('[TransferList] MOUNTED (insertBefore):', cfg.panelId);
          continue;
        }
      }
      // v4.37.0 · insertAfter 支持（插在锚点元素之后）
      if (cfg.insertAfter){
        var anchorAfter = host.querySelector(cfg.insertAfter);
        if (anchorAfter){
          var wrapWrapAfter = document.createElement('div');
          anchorAfter.parentNode.insertBefore(wrapWrapAfter, anchorAfter.nextSibling);
          TL.mount(wrapWrapAfter, {
            panelId: cfg.panelId,
            storageKey: 'transferList.' + cfg.panelId,
            title: cfg.title,
            dstHint: cfg.dstHint,
            defaultDst: cfg.defaultDst,
            onSubmit: cfg.onSubmit,
            threeColumn: !!cfg.threeColumn,  // v4.38.22 · 透传三列标记
          });
          continue;
        }
        // v4.38.20 · 锚点未注入（DiskManager 还在等加载）→ 跳过本次挂载
        if (cfg.skipIfAnchorMissing){
          console.log('[TransferList] anchor not found, skip mount:', cfg.panelId, 'waiting for', cfg.insertAfter);
          continue;
        }
      }
      TL.mount(host, {
        panelId: cfg.panelId,
        storageKey: 'transferList.' + cfg.panelId,
        title: cfg.title,
        dstHint: cfg.dstHint,
        defaultDst: cfg.defaultDst,
        onSubmit: cfg.onSubmit,
        threeColumn: !!cfg.threeColumn,  // v4.38.22 · 透传三列标记
      });
    }
  }

  function _kick(){
    console.log('[TransferList] _kick() running, readyState=', document.readyState);
    _tryInject();
    // 部分面板容器由 flow_mini autoInject 后生成 · 延迟再试一次
    setTimeout(_tryInject, 400);
    setTimeout(_tryInject, 1500);
    // v4.38.12 · 3 秒后在 console 汇报注入结果（不再弹 DOM 横幅，避免干扰 UI）
    setTimeout(function(){
      var t = _instances['transfer'];
      var msg = t ? ('OK mounted, items=' + (t.get? t.get().length : '?'))
                  : 'NOT mounted · check #panel-transfer/#transferParamsSection';
      console.log('[TransferList] diag:', msg);
    }, 3000);
  }

  if (document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', _kick);
  } else {
    _kick();
  }

  // v4.38.23 · 同步工具检测 + 新三列传输 + 操作日志（与 TransferList 三列共存）
  function _mountV43823Extras(){
    if (!window.TransferTri || !window.ToolChecker || !window.TransferLog) return;
    var tcHost = document.getElementById('toolCheckTransfer');
    var triHost = document.getElementById('transferTri');
    var logHost = document.getElementById('transferLogTransfer');
    if (!tcHost || !triHost || !logHost) return;
    // 已挂跳过
    if (window._v43823Mounted) return;
    window._v43823Mounted = true;
    // 1) 操作日志
    var log = window.TransferLog.create(logHost, { scope: 'transfer' });
    // 2) 工具检测
    var tc = window.ToolChecker.create(tcHost, {
      scope: 'transfer',
      onLog: function(text, level){ log.log(text, level); },
    });
    // 3) 新三列传输
    var srvList = (window.SrvPool && window.SrvPool.getSrvList) ? window.SrvPool.getSrvList() : [];
    var tri = window.TransferTri.create(triHost, {
      scope: 'transfer',
      title: '📂 文件传输',
      srvList: srvList,
      direction: 'up',
      onLog: function(text, level){ log.log(text, level); },
    });
    // 拉取 srv 列表
    // v5.50.0 修: 原调 remote_list 并读 d.servers (该字段不存在) → 列表恒空; 改统一数据源 SP.serverRows()
    if (window.SP && window.SP.serverRows){
      window.SP.serverRows().then(function(msg){
        var arr = (msg && msg.configs) || [];
        if (!arr.length) return;
        if (window.SrvPool) window.SrvPool.setSrvList(arr);
        tri.setSrvList(arr);
        log.log('✓ 已加载 ' + arr.length + ' 台服务器 (server_profiles)', 'ok');
      }).catch(function(){});
    }
    // 4) 工具检测失败时阻止传输
    // （TransferTri 内部已开始传输时不阻断，但日志会显示）
  }
  // 启动后挂载
  if (document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', function(){
      setTimeout(_mountV43823Extras, 1000);
    });
  } else {
    setTimeout(_mountV43823Extras, 1000);
  }
  // 每次切到 transfer 面板也尝试挂（覆盖初次时序竞争）
  document.addEventListener('click', function(ev){
    var btn = ev.target && (ev.target.closest && ev.target.closest('.tab, .sub-tab'));
    if (!btn) return;
    setTimeout(_mountV43823Extras, 200);
  });
})();
