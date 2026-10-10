/*
 * downloads.js · v2.8.0
 * 本地下载页面独立模块（从 app.js 抽出 · 保持全局作用域）
 *
 * 从 app.js 移出 300 行；两文件都用 <script> 标签串行加载 → 全局符号共享
 * 拆分动机：
 *   1) 便于按功能维护（app.js 从 6400 行降到 ~6100 行）
 *   2) 作为后续 v2.8.x JS 模块化的示范：其它 panel 也可类似抽出
 */

// ==================== 本地下载模块 ====================
var _dlCurrentPath = '';

function _dlToken(){
  try { return localStorage.getItem('auth_token') || ''; } catch(e){ return ''; }
}
function _dlWithToken(url){
  var t = _dlToken();
  if(!t) return url;
  return url + (url.indexOf('?')>=0?'&':'?') + 'token=' + encodeURIComponent(t);
}
function _dlFetch(url){
  var t = _dlToken();
  var opts = t ? { headers: { 'X-Auth-Token': t } } : {};
  return fetch(url, opts);
}

// 通用：一键把服务器上文件/目录下载到"本地电脑"（浏览器）
// path: 后端可访问的绝对路径（必须在 ALLOWED_ROOTS 白名单内）
// opts: { batch:true 打包为 tar；name:'xxx' tar 文件名（不含后缀）}
function downloadToLocalPC(path, opts){
  opts = opts || {};
  if(!path){ if(window.toastErr)toastErr('路径为空'); else alert('路径为空'); return; }
  var url;
  if(opts.batch || (typeof path === 'string' && path.indexOf('\n') >= 0)){
    var name = opts.name || 'fonriv_bundle';
    url = '/api/download-batch?paths=' + encodeURIComponent(path) + '&name=' + encodeURIComponent(name);
  } else {
    url = '/api/download?path=' + encodeURIComponent(path);
  }
  url = _dlWithToken(url);
  // 用隐形 <a download> 触发浏览器下载对话框
  var a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(function(){ document.body.removeChild(a); }, 100);
  if(window.toast) toast('📥 已开始下载到本地电脑：' + (path.split('/').pop() || path));
}

function dlFmtSize(n){
  if(!n) return '0 B';
  var u = ['B','KB','MB','GB','TB']; var i = 0;
  while(n >= 1024 && i < u.length-1){ n /= 1024; i++; }
  return n.toFixed(n<10&&i>0?2:1) + ' ' + u[i];
}
function dlFmtTime(ts){
  if(!ts) return '';
  var d = new Date(ts*1000);
  var p = function(x){return String(x).padStart(2,'0');};
  return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+' '+p(d.getHours())+':'+p(d.getMinutes());
}
function dlEscape(s){ return String(s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }

function dlInit(){
  // 未登录 → 提示先登录，不发请求
  if(!_dlToken()){
    var list = document.getElementById('dlFileList');
    var box  = document.getElementById('dlRootBtns');
    if(box)  box.innerHTML  = '';
    if(list) list.innerHTML = '<div style="padding:20px;color:var(--red);text-align:center">请先登录（右上角）后才能浏览和下载本地文件</div>';
    return;
  }
  _dlFetch('/api/roots').then(function(r){
    if(r.status===401){
      throw new Error('登录已过期，请重新登录');
    }
    return r.json();
  }).then(function(data){
    var box = document.getElementById('dlRootBtns');
    if(!box) return;
    box.innerHTML = '';
    (data.roots||[]).forEach(function(r){
      var b = document.createElement('button');
      b.className = 'btn';
      b.style.fontSize = '12px';
      /* v1.0.0 · i18n: 路径与 [不存在] 分开成两个文本节点, 否则"路径+后缀"整串无法命中词典 */
      b.textContent = r.path + (r.exists?' ('+r.entries+')':'');
      if (!r.exists){ var _mk = document.createElement('span'); _mk.textContent = ' [不存在]'; b.appendChild(_mk); }
      b.disabled = !r.exists;
      b.onclick = function(){ dlBrowse(r.path); };
      box.appendChild(b);
    });
    // 默认加载第一个存在的根
    var first = (data.roots||[]).find(function(r){return r.exists;});
    if(first && !_dlCurrentPath) dlBrowse(first.path);
  }).catch(function(e){ console.error('dlInit', e); });
}

function dlBrowse(path){
  if(!path) return;
  _dlFetch('/api/browse?path=' + encodeURIComponent(path)).then(function(r){
    if(!r.ok) return r.json().then(function(j){throw new Error(j.detail||('HTTP '+r.status));});
    return r.json();
  }).then(function(data){
    _dlCurrentPath = data.path;
    window._dlItems = data.items || [];
    var inp = document.getElementById('dlPathInput'); if(inp) inp.value = data.path;
    // v2.7.2: 面包屑按段渲染
    var bc = document.getElementById('dlBreadcrumb');
    if(bc){
      var parts = data.path.split('/').filter(Boolean);
      var acc = '';
      var links = ['<a href="#" onclick="dlBrowse(\'/\');return false;" style="color:var(--cyan);text-decoration:none">🏠 /</a>'];
      parts.forEach(function(seg){
        acc += '/' + seg;
        var esc = acc.replace(/'/g, "\\'").replace(/"/g, '&quot;');
        links.push('<span style="color:var(--text3)">›</span>'
          + '<a href="#" onclick="dlBrowse(\''+esc+'\');return false;" style="color:var(--cyan);text-decoration:none">'+dlEscape(seg)+'</a>');
      });
      bc.innerHTML = links.join(' ')
        + ' &nbsp;&nbsp;<button class="btn btn-sm" style="font-size:11px" onclick="dlBatchDownload()">📦 下载选中(打包)</button>'
        + ' <button class="btn btn-sm" style="font-size:11px" onclick="dlToggleAll()">☑ 全选/清除</button>';
    }
    dlRenderList();
  }).catch(function(e){
    var list = document.getElementById('dlFileList');
    if(list) list.innerHTML = '<div style="padding:20px;color:var(--red)">加载失败: ' + dlEscape(e.message) + '</div>';
  });
}

// v2.7.2: 从 window._dlItems 渲染（应用当前 filter + sort）
function dlRenderList(){
  var list = document.getElementById('dlFileList');
  if(!list) return;
  var items = (window._dlItems || []).slice();
  // 过滤
  var kwEl = document.getElementById('dlFilter');
  var kw = (kwEl && kwEl.value || '').toLowerCase().trim();
  if(kw){
    items = items.filter(function(it){ return it.name.toLowerCase().indexOf(kw) >= 0; });
  }
  // 排序
  var sortEl = document.getElementById('dlSort');
  var sort = (sortEl && sortEl.value) || 'mtime-desc';
  items.sort(function(a, b){
    if(a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;   // 目录优先
    switch(sort){
      case 'name':      return a.name.localeCompare(b.name);
      case 'name-desc': return b.name.localeCompare(a.name);
      case 'size':      return (a.size||0) - (b.size||0);
      case 'size-desc': return (b.size||0) - (a.size||0);
      case 'mtime':     return (a.mtime||0) - (b.mtime||0);
      case 'mtime-desc':return (b.mtime||0) - (a.mtime||0);
    }
    return 0;
  });
  // stats
  var stats = document.getElementById('dlStats');
  var dirs = items.filter(function(x){return x.is_dir;}).length;
  var files = items.length - dirs;
  var totalSize = items.reduce(function(s,x){return s+(x.is_file===false||x.is_dir?0:(x.size||0));}, 0);
  if(stats){
    var total = (window._dlItems||[]).length;
    stats.textContent = '共 '+items.length+' 项（目录 '+dirs+' · 文件 '+files+' · '+dlFmtSize(totalSize)+'）'
      + (items.length !== total ? ' · 过滤自 '+total : '');
  }
  if(!items.length){
    list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text2)">'+(kw?'无匹配项':'目录为空')+'</div>';
    return;
  }
  list.innerHTML = items.map(function(it){
    var icon = it.is_dir ? '📁' : dlIconFor(it.name);
    var pathEsc = dlEscape(it.path);
    var jsPath = it.path.replace(/\\/g,'\\\\').replace(/'/g,"\\'");
    var action = it.is_dir
      ? '<button class="btn btn-sm" style="font-size:11px" onclick="dlBrowse(\''+jsPath+'\')">进入</button>'
      : '<a class="btn btn-sm" style="font-size:11px;text-decoration:none" href="'+_dlWithToken('/api/download?path='+encodeURIComponent(it.path))+'" download="'+dlEscape(it.name)+'">💾 下载</a>';
    return '<div class="dl-row" data-path="'+pathEsc+'" style="display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid var(--border);font-size:12px">'
      + '<input type="checkbox" class="dl-check" style="margin:0">'
      + '<span style="width:22px">'+icon+'</span>'
      + '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+pathEsc+'">'+dlEscape(it.name)+'</span>'
      + '<span style="width:100px;text-align:right;color:var(--text2)">'+(it.is_dir?'—':dlFmtSize(it.size))+'</span>'
      + '<span style="width:140px;text-align:right;color:var(--text3)">'+dlFmtTime(it.mtime)+'</span>'
      + '<span style="width:80px;text-align:right">'+action+'</span>'
      + '</div>';
  }).join('');
}

function dlApplyFilter(){ dlRenderList(); }
function dlApplySort(){ dlRenderList(); }

// v2.7.2: 文件图标启发（按扩展名）
function dlIconFor(name){
  var n = name.toLowerCase();
  if(/\.(iso|img)$/.test(n)) return '💿';
  if(/\.(vma|vma\.zst|vma\.lzo|vma\.gz)$/.test(n)) return '📦';
  if(/\.(tar|tar\.gz|tgz|tar\.zst|tar\.bz2)$/.test(n)) return '📦';
  if(/\.(qcow2|raw|vmdk|vhd|vhdx)$/.test(n)) return '💾';
  if(/\.(zip|7z|rar)$/.test(n)) return '🗜';
  if(/\.(log|txt|conf|cfg|yaml|yml|json|xml)$/.test(n)) return '📄';
  if(/\.(sh|py|js|go)$/.test(n)) return '📜';
  if(/\.(png|jpg|jpeg|gif|webp|svg)$/.test(n)) return '🖼';
  return '📄';
}

// v2.7.2: 上传本地文件到当前目录
function dlOpenUpload(){
  if(!_dlCurrentPath){ toastWarn('请先浏览到某个目录'); return; }
  document.getElementById('dlUploadTarget').textContent = _dlCurrentPath;
  var box = document.getElementById('dlUploadBox');
  if(box) box.style.display = 'block';
  var fi = document.getElementById('dlUploadFile');
  if(fi) fi.value = '';
  document.getElementById('dlUploadStatus').textContent = '';
}
function dlCloseUpload(){
  var box = document.getElementById('dlUploadBox');
  if(box) box.style.display = 'none';
}
function dlDoUpload(){
  var fi = document.getElementById('dlUploadFile');
  var st = document.getElementById('dlUploadStatus');
  if(!fi || !fi.files || !fi.files.length){ if(st) st.textContent = '请先选文件'; return; }
  if(!_dlCurrentPath){ if(st) st.textContent = '当前目录未知'; return; }
  var files = Array.from(fi.files);
  var done = 0, total = files.length;
  st.textContent = '开始上传 '+total+' 个文件到 '+_dlCurrentPath+'...';
  addLog('开始上传 '+total+' 个文件 → '+_dlCurrentPath, 'info');
  function next(){
    if(done >= total){
      st.textContent = '✅ 全部完成 · '+done+' 个文件';
      addLog('上传完成 · '+done+' 个文件', 'success');
      if(typeof toastOk === 'function') toastOk('上传完成 · '+done+' 个文件');
      dlRefresh();
      return;
    }
    var f = files[done];
    var fd = new FormData();
    fd.append('file', f);
    fd.append('dest_dir', _dlCurrentPath);
    var url = _dlWithToken('/api/upload');
    fetch(url, { method: 'POST', body: fd })
      .then(function(r){ return r.json().then(function(j){ return { ok: r.ok, j: j }; }); })
      .then(function(res){
        if(!res.ok){
          addLog('❌ '+f.name+' 上传失败: '+(res.j.detail||res.j.msg||''), 'error');
        } else {
          addLog('✅ '+f.name+' 上传成功 → '+res.j.path+' ('+dlFmtSize(res.j.size)+')', 'success');
        }
        done++;
        st.textContent = '进度: '+done+' / '+total+' · '+f.name;
        next();
      })
      .catch(function(e){
        addLog('❌ '+f.name+' 上传异常: '+e.message, 'error');
        done++;
        next();
      });
  }
  next();
}

function dlToggleAll(){
  var boxes = document.querySelectorAll('#dlFileList .dl-check');
  var anyUnchecked = Array.prototype.some.call(boxes, function(b){return !b.checked;});
  boxes.forEach(function(b){ b.checked = anyUnchecked; });
}

function dlBatchDownload(){
  var checked = document.querySelectorAll('#dlFileList .dl-row .dl-check:checked');
  if(!checked.length){ alert('请勾选要下载的文件/目录'); return; }
  var paths = [];
  checked.forEach(function(cb){
    var row = cb.closest('.dl-row');
    if(row) paths.push(row.getAttribute('data-path'));
  });
  if(!paths.length) return;
  var name = 'bundle_' + new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
  var url = '/api/download-batch?paths=' + encodeURIComponent(paths.join('\n')) + '&name=' + encodeURIComponent(name);
  window.location.href = _dlWithToken(url);
}

function dlGoUp(){
  if(!_dlCurrentPath) return;
  var parts = _dlCurrentPath.split('/').filter(Boolean);
  if(!parts.length) return;
  parts.pop();
  var parent = '/' + parts.join('/');
  dlBrowse(parent);
}
function dlRefresh(){ if(_dlCurrentPath) dlBrowse(_dlCurrentPath); }

// 便捷函数：从其他面板一键跳转并下载
function dlOpenPath(path){
  if(typeof switchTab === 'function') switchTab('downloads');
  setTimeout(function(){ dlBrowse(path); }, 100);
}

// 在 switchTab 切到 downloads 时初始化
// v2.8.0: 由于 downloads.js 是 sync 加载而 app.js 是 defer 加载，
// 此时 switchTab 尚未定义。改到 DOMContentLoaded 时再包裹一次。
document.addEventListener('DOMContentLoaded', function(){
  var origSwitch = window.switchTab;
  if(typeof origSwitch !== 'function'){
    console.warn('[downloads] switchTab not defined at DOMContentLoaded');
    return;
  }
  window.switchTab = function(t){
    origSwitch(t);
    if(t === 'downloads'){
      var btn = document.getElementById('dlRootBtns');
      if(btn && !btn.childElementCount) dlInit();
    }
  };
});
