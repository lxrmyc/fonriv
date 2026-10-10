/*
 * frontend/static/panels/users.js · v4.44.1
 *
 * app.js 拆分战役 · 第 2 块砖（用户管理面板）
 * ----------------------------------------------------------------------
 * 抽出 app.js 214-543 行的 12 个用户管理函数 + PAGE_DISPLAY 常量。
 * 顺便修 v3.4.1 前 changeUserPassword 被定义两次的历史 bug（442 & 481）。
 *
 * v4.44.1 · 精细化权限分配:
 *   - PAGE_DISPLAY 覆盖全部一级/二级页面模块 (与 backend db/users.py ALL_PAGES 同步)
 *   - 权限对话框按功能分组 (文件传输/磁盘/共享/终端/备份/存储/系统...) 一键勾组
 *
 * 加载时机：panels/toast.js 之后 · app.js 之前
 *   → users.js 里定义的函数先挂 window，app.js 里的旧定义 __被 v3.4.1 删除__
 *   → 所有 HTML onclick / 其他文件调用都通过 window.xxx 访问，兼容
 *
 * 依赖（来自 app.js 全局 · users.js 使用时假设已存在）：
 *   window.currentUser         · 会话对象
 *   window.send                · WebSocket 发送
 *   window.addLog              · 日志追加
 *   window.switchTab           · 切 tab
 *   window.toastOk / toastErr  · panels/toast.js 提供
 */
(function(){
  if (typeof window === 'undefined') return;
  if (window.__usersModuleLoaded) return;
  window.__usersModuleLoaded = 'v4.44.1';

  // v4.44.1: 页面 key → 显示名映射（覆盖全部一级/二级模块; 与 backend ALL_PAGES 同步）
  /* v5.28.4 · 用户管理表格布局: 操作列不换行 · 列宽固定 · 按钮紧凑 */
  if (!document.getElementById('usersTableStyle')){
    var st = document.createElement('style');
    st.id = 'usersTableStyle';
    st.textContent = [
      '#userTableBody td { white-space: nowrap; vertical-align: middle; padding: 6px 8px; }',
      /* v1.0.0 · FIX(用户反馈: 操作列与左侧各列、行分隔线全对不齐): 此前把最后一个 td 直接设成
         display:flex —— flex 化的 td 会脱离表格行的行高与垂直对齐, 整行看上去错位。
         改为 td 保持表格语义, 按钮放进内层 inline-flex 包装(.um-acts)。 */
      '#userTableBody td:last-child { min-width: 340px; white-space: normal; }',
      '#userTableBody .um-acts { display: inline-flex; flex-wrap: wrap; gap: 4px; align-items: center; vertical-align: middle; }',
      '#userTableBody td:last-child .btn { padding: 2px 6px; font-size: 11px; margin: 0; }',
      '#userTableBody tr td:first-child { width: 40px; text-align: center; }',
      '#userTableBody td:nth-child(2) { min-width: 140px; }',
      '#userTableBody td:nth-child(5) { font-size: 11px; }',
    ].join('\n');
    document.head.appendChild(st);
  }

  var PAGE_DISPLAY = {
    conn_center: '🔌 连接中心',
    // 文件传输组
    transfer:'📂 文件传输', disk_manager:'💽 远端磁盘管理', shares:'🌐 网络共享',
    share_lan:'🖥 局域网文件分享', share_http:'🌐 HTTP 链接分享', share_access:'🔐 SMB 账号与权限',   // v6.5.0 · 批6(与 ALL_PAGES 同步)
    // 终端
    terminal:'🖥 终端',
    // Proxmox 备份组
    proxmox:'🖥 PVE 节点连接', vzdump:'📦 vzdump 打包', pbs:'📦 PBS 备份', auto_backup:'🔧 PVE 一键备份',
    // 存储卷备份组
    backup_center:'🗄 备份总览',
    vdisk_cloud:'💠 多云虚拟存储池',
    platform_backup:'🐧 通用一键备份', lvm:'💽 LVM', zfs:'🗄 ZFS', rbd:'🌐 Ceph RBD',
    // 其他
    remotedesk:'🖥 远程桌面(旧)',
    rdp_console:'🖥 RDP 控制台', vnc_direct:'🖥 VNC 直链', pve_console:'🦠 PVE 虚拟控制台', truenas:'🗄 TrueNAS 控制面板',
    remotes:'☁️ 远端存储', flows:'🔗 跨模块流程', dashboard:'📊 数据总览',
    fonrvfs:'🗂 多云文件管理', cloudpool:'🧩 存储池',   // v6.11.0 · 批11(与 ALL_PAGES/NAV_TREE 同步)
    docker:'📦 容器管理', dbbackup:'🗄 数据库备份', ai_assistant:'🤖 AI 助手', k8s_backup:'📦 K8s/容器备份',
    // 任务与日志组
    schedules:'⏰ 定时计划', jobs:'⏱ 任务队列', log:'📋 传输日志',
    // 系统组
    conn_center: '🔌 连接中心',
    personalize: '🎨 个性化',
    settings:'⚙ 系统设置', license:'🔓 授权与许可', users:'👥 用户管理', downloads:'💾 本地下载',
  };
  function pageDisplayName(key){ return PAGE_DISPLAY[key] || key; }

  // v4.44.1: 权限对话框分组 (display 用)
  // v4.45.0: 各页面挂 license 功能键 (feat) — 与 app.js NAV_TREE / backend
  //   ACTION_FEATURE_MAP 同源; feat=null = 不挂 license 闸 (所有版本可用)
  /* v5.28.4 · 权限对话框动态生成: 从 NAV_TREE 读取, 新增页面自动出现
     无需手动维护 PAGE_GROUPS/PAGE_DISPLAY — 页面键/标签/feat 全部从 NAV_TREE 派生 */
  function _buildGroupsFromNav(){
    var groups = [];
    try {
      (window.NAV_TREE || []).forEach(function(g){
        if (!g.children || !g.children.length){
          groups.push({ label: g.label || g.key, pages: [g.key],
            feats: (function(){ var o={}; o[g.key]=g.feat||null; return o; })() });
          return;
        }
        var pages = g.children.map(function(c){ return c.key; });
        var feats = {};
        g.children.forEach(function(c){ feats[c.key] = c.feat || null; });
        groups.push({ label: g.label || g.key, pages: pages, feats: feats });
      });
    } catch(e) { console.warn('[users] _buildGroupsFromNav', e); }
    return groups;
  }
  /* v5.28.4 · PAGE_GROUPS 从 NAV_TREE 动态生成 (替代旧硬编码) */
  var PAGE_GROUPS = null;
  function getPageGroups(){
    if (!PAGE_GROUPS) PAGE_GROUPS = _buildGroupsFromNav();
    return PAGE_GROUPS;
  }
  var PAGE_GROUPS = null;   // 懒加载: 首次打开权限对话框时从 NAV_TREE 生成
  function getPageGroups(){
    if (!PAGE_GROUPS) PAGE_GROUPS = _buildGroupsFromNav();
    return PAGE_GROUPS;
  }

  function updateUserSidebar(){
    var currentUser = window.currentUser;
    if(!currentUser) return;
    var sb = document.getElementById('userSidebar');
    var disp = document.getElementById('currentUserDisplay');
    var ulink = document.getElementById('userManagerLink');
    if(!sb || !disp) return;
    sb.style.display = 'block';
    disp.textContent = currentUser.username + (currentUser.role === 'admin' ? ' (管理员)' : '');
    if(ulink){
      ulink.style.display = currentUser.role === 'admin' ? 'flex' : 'none';
    }
  }

  function openUserManager(){
    if(typeof switchTab === 'function') switchTab('users');
    loadUserList();
  }

  function loadUserList(){
    var tb = document.getElementById('userTableBody');
    if(tb) tb.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text3);padding:20px">加载中...</td></tr>';
    send({action:'db_user_list'}, function(msg){
      console.log('[loadUserList] response:', msg);
      if(msg && msg.status === 'ok') {
        renderUserList(msg.users);
      } else {
        if(tb) tb.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--red);padding:20px">加载失败：'+(msg && msg.msg || '未知错误')+'</td></tr>';
        addLog('用户列表加载失败: '+(msg && msg.msg || ''), 'error');
      }
    });
  }

  function renderUserList(users){
    var tb = document.getElementById('userTableBody');
    if(!tb) return;
    tb.innerHTML = '';
    console.log('[renderUserList] received users:', users);
    var _cu = (window.currentUser && typeof window.currentUser === 'object') ? window.currentUser : { user_id: -1, role: 'user' };
    if(!Array.isArray(users) || users.length === 0){
      tb.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text3);padding:20px">暂无用户数据</td></tr>';
      return;
    }
    users.forEach(function(u){
      var tr = document.createElement('tr');
      var roleClass = u.role === 'admin' ? 'role-admin' : 'role-user';
      var roleText = u.role === 'admin' ? '管理员' : '用户';
      var isSelf = (Number(u.id) === Number(_cu.user_id));
      var isAdmin = (u.role === 'admin');
      var actions = '<span class="um-acts">';
      actions += '<button class="btn btn-sm" onclick="changeUserPassword('+u.id+',\''+u.username.replace(/'/g,"\\'")+'\')">🔑 改密码</button> ';
      if(!isAdmin){
        actions += '<button class="btn btn-sm btn-primary" onclick="openPermsDialog('+u.id+',\''+u.username.replace(/'/g,"\\'")+'\')">🔐 权限</button> ';
      }
      if(!isSelf){
        actions += '<button class="btn btn-sm" onclick="editUser('+u.id+')">编辑</button> ';
        if(isAdmin && u.id !== 1){
          actions += '<button class="btn btn-sm" onclick="toggleUserRole('+u.id+',\''+u.username.replace(/'/g,"\\'")+'\',\'user\')">设为普通用户</button> ';
        } else if(!isAdmin){
          actions += '<button class="btn btn-sm" onclick="toggleUserRole('+u.id+',\''+u.username.replace(/'/g,"\\'")+'\',\'admin\')">设为管理员</button> ';
        }
        actions += '<button class="btn btn-sm btn-danger" onclick="deleteUser('+u.id+')">删除</button>';
      } else {
        actions += '<span style="color:var(--text3);font-size:11px;margin-left:6px">(当前登录)</span>';
      }
      actions += '</span>';
      var permCell = isAdmin
        ? '<span class="chip chip-green" style="font-size:10px">全部（管理员）</span>'
        : '<span id="permCell-'+u.id+'" style="font-size:11px;color:var(--text3)">加载中...</span>';
      var lastLoginCell = u.last_login
        ? '<span style="color:var(--text2);font-size:11px">'+u.last_login+'</span>'
        : '<span style="color:var(--text3);font-size:11px">从未</span>';
      tr.innerHTML =
        '<td>'+u.id+'</td>' +
        '<td>'+u.username
          + (isSelf?' <span class="chip chip-blue" style="font-size:10px">你</span>':'')
          + '<div style="font-size:10px;color:var(--text3);margin-top:2px">最近登录: '+lastLoginCell+'</div>'
        + '</td>' +
        '<td><span class="role-badge '+roleClass+'">'+roleText+'</span></td>' +
        '<td>'+permCell+'</td>' +
        '<td>'+(u.created_at||'')+'</td>' +
        '<td>'+actions+'</td>';
      tb.appendChild(tr);
      if(!isAdmin){
        send({action:'db_user_perms_get', user_id:u.id}, function(m){
          if(m && m.status === 'ok'){
            var cell = document.getElementById('permCell-'+u.id);
            if(cell){
              var perms = m.permissions || [];
              if(perms.length === 0){
                cell.innerHTML = '<span style="color:var(--red)">无</span>';
              } else if(perms.length >= (m.all_pages||[]).length){
                cell.innerHTML = '<span class="chip chip-green" style="font-size:10px">全部</span>';
              } else {
                cell.textContent = perms.length + ' 项: ' + perms.map(pageDisplayName).join(', ');
                cell.title = perms.join(', ');
              }
            }
          }
        });
      }
    });
  }

  function openPermsDialog(userId, username){
    send({action:'db_user_perms_get', user_id:userId}, function(m){
      if(!m || m.status !== 'ok'){
        alert('读取权限失败: '+(m && m.msg || ''));
        return;
      }
      var current = new Set(m.permissions || []);
      var all = m.all_pages || Object.keys(PAGE_DISPLAY);
      // v4.45.0 · license 联动: 只显示已授权激活的功能对应的页面 (未激活的整个条目不渲染)
      //   判定同 app.js licenseFeatEnabled: 无白名单=edition 层级全放行; 有白名单按名单
      var _licFeat = (typeof window !== 'undefined' && window.__licFeat) || null;
      function _featOK(feat){ return !_licFeat || !feat || _licFeat.indexOf(feat) !== -1; }
      var _licHidden = [];
      getPageGroups().forEach(function(g){
        Object.keys(g.feats || {}).forEach(function(p){
          var feat = g.feats[p];
          if (feat && !_featOK(feat)){ _licHidden.push(p); }
        });
      });
      if (_licHidden.length){
        all = all.filter(function(p){ return _licHidden.indexOf(p) < 0; });
      }
      var backdrop = document.createElement('div');
      backdrop.className = 'modal-backdrop';
      backdrop.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:9999;display:flex;align-items:center;justify-content:center';
      var box = document.createElement('div');
      box.style.cssText = 'background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:20px 24px;width:min(640px,92vw);max-height:84vh;overflow:auto;box-shadow:0 10px 40px rgba(0,0,0,0.4)';
      // v4.44.1: 分组渲染 + 组全选
      var chkHtml = getPageGroups().map(function(g, gi){
        var rows = g.pages.filter(function(p){ return all.indexOf(p) >= 0; });
        if(rows.length === 0) return '';
        var items = rows.map(function(p){
          var checked = current.has(p) ? 'checked' : '';
          return '<label style="display:flex;align-items:center;gap:6px;padding:3px 8px;border-radius:6px;cursor:pointer;background:var(--bg3)">'
            + '<input type="checkbox" value="'+p+'" '+checked+' class="perm-cb" data-group="'+gi+'">'
            + '<span>'+pageDisplayName(p)+'</span>'
            + '<span style="margin-left:auto;font-size:10px;color:var(--text3);font-family:monospace">'+p+'</span>'
            + '</label>';
        }).join('');
        return '<div style="grid-column:1/-1;display:flex;align-items:center;gap:8px;margin-top:6px">'
          + '<b style="font-size:12px;color:var(--cyan)">'+g.label+'</b>'
          + '<button type="button" class="btn btn-sm" style="padding:0 8px;font-size:10px" onclick="window.__permToggleGroup('+gi+',true)">全选</button>'
          + '<button type="button" class="btn btn-sm" style="padding:0 8px;font-size:10px" onclick="window.__permToggleGroup('+gi+',false)">清除</button>'
          + '</div>'
          + '<div style="display:contents">'+items+'</div>';
      }).join('');
      box.innerHTML =
        '<h3 style="margin:0 0 6px 0">🔐 分配权限 · <span style="color:var(--cyan)">'+username+'</span></h3>'
        + '<div style="font-size:12px;color:var(--text2);margin-bottom:10px">勾选该用户可访问的模块（一级/二级页面精细分配）。后端同步拦截无权限请求，前端隐藏对应 Tab。'
        + (_licHidden.length ? '<span style="color:var(--orange)"> · 已按当前授权过滤 '+_licHidden.length+' 个未激活功能页面</span>' : '')
        + '</div>'
        + '<div style="display:flex;gap:8px;margin-bottom:10px">'
        + '<button class="btn btn-sm" onclick="document.querySelectorAll(\'.perm-cb\').forEach(function(c){c.checked=true})">全选</button>'
        + '<button class="btn btn-sm" onclick="document.querySelectorAll(\'.perm-cb\').forEach(function(c){c.checked=false})">全不选</button>'
        + '<button class="btn btn-sm" onclick="window.__permDefaults()">默认（基础三项）</button>'
        + '</div>'
        + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:4px">'+chkHtml+'</div>'
        + '<div style="margin-top:16px;display:flex;justify-content:flex-end;gap:8px">'
        + '<button class="btn btn-sm" id="permCancelBtn">取消</button>'
        + '<button class="btn btn-primary" id="permSaveBtn">💾 保存</button>'
        + '</div>';
      backdrop.appendChild(box);
      document.body.appendChild(backdrop);
      var close = function(){
        document.body.removeChild(backdrop);
        window.__permToggleGroup = null;
        window.__permDefaults = null;
      };
      // 分组全选/清除 + 默认三项 (挂 window 供对话框内 onclick 调用)
      window.__permToggleGroup = function(gi, val){
        box.querySelectorAll('.perm-cb[data-group="'+gi+'"]').forEach(function(c){ c.checked = val; });
      };
      window.__permDefaults = function(){
        box.querySelectorAll('.perm-cb').forEach(function(c){
          c.checked = ['transfer','downloads','log'].indexOf(c.value) >= 0;
        });
      };
      box.querySelector('#permCancelBtn').onclick = close;
      backdrop.onclick = function(e){ if(e.target === backdrop) close(); };
      box.querySelector('#permSaveBtn').onclick = function(){
        var pages = Array.from(box.querySelectorAll('.perm-cb:checked')).map(function(c){ return c.value; });
        send({action:'db_user_perms_set', user_id:userId, pages:pages}, function(r){
          if(r && r.status === 'ok'){
            if(typeof toastOk === 'function') toastOk('权限已保存 · '+pages.length+' 项');
            addLog('用户 '+username+' 权限已更新: '+pages.length+' 项','success');
            close();
            loadUserList();
          } else {
            alert('保存失败: '+(r && r.msg || '未知'));
          }
        });
      };
    });
  }

  async function openAddUser(){
    var fv = await rpForm({
      title:'新建用户', okText:'创建',
      fields:[
        { key:'username', label:'用户名', required:true },
        { key:'password', label:'密码', type:'password', required:true, minLen:4, hint:'至少 4 位' },
        { key:'role', label:'角色', type:'select', value:'user',
          options:[ {v:'admin', label:'管理员'}, {v:'user', label:'普通用户'} ] },
      ],
    });
    if(!fv) return;
    var name = fv.username;
    send({action:'db_user_create', username:name, password:fv.password, role:fv.role}, function(msg){
      if(msg.status === 'ok'){
        addLog('用户 '+name+' 创建成功','success');
        if(typeof toastOk === 'function') toastOk('用户 '+name+' 创建成功');
        loadUserList();
      } else {
        addLog('创建用户失败: '+msg.msg,'error');
        alert('创建失败: '+(msg.msg || '未知错误'));
      }
    });
  }

  async function editUser(uid){
    var fv = await rpForm({
      title:'编辑用户', okText:'保存',
      fields:[
        { key:'username', label:'用户名', required:true },
        { key:'role', label:'角色', type:'select', value:'user',
          options:[ {v:'admin', label:'管理员'}, {v:'user', label:'普通用户'} ] },
      ],
    });
    if(!fv) return;
    send({action:'db_user_update', user_id:uid, username:fv.username, role:fv.role}, function(msg){
      if(msg.status === 'ok'){
        addLog('用户信息已更新','success');
        loadUserList();
      } else {
        addLog('更新失败: '+msg.msg,'error');
      }
    });
  }

  async function toggleUserRole(uid, username, newRole){
    var label = newRole === 'admin' ? '管理员' : '普通用户';
    if(!(await rpConfirm({ title:'变更用户角色', okText:'变更', body:'确定将用户 "'+username+'" 的角色变更为「'+label+'」？' }))) return;
    send({action:'db_user_update', user_id:uid, role:newRole}, function(msg){
      if(msg.status === 'ok'){
        addLog('用户 '+username+' 角色已变更为 '+label,'success');
        if(typeof toastOk === 'function') toastOk('角色已变更为 '+label);
        loadUserList();
      } else {
        addLog('角色变更失败: '+msg.msg,'error');
        if(typeof toastErr === 'function') toastErr('角色变更失败: '+msg.msg);
      }
    });
  }

  // 管理员改任意用户密码
  // 自己：走 db_change_password（要求旧密验证）
  // 他人：走 db_user_update（管理员权限直接重置）
  // v3.4.1 修复：v3.4.1 前 app.js 里此函数定义了两次（442 & 481 行）· 第二个覆盖第一个 · 现只保留一份
  async function changeUserPassword(uid, username){
    var isSelf = (window.currentUser && uid === window.currentUser.user_id);
    if(isSelf){
      var fv = await rpForm({
        title:'修改密码（'+username+'）', hint:'需要先验证当前密码', okText:'修改',
        fields:[
          { key:'old_password', label:'当前密码', type:'password', required:true },
          { key:'new_password', label:'新密码', type:'password', required:true, minLen:4, hint:'至少 4 位' },
          { key:'confirm_password', label:'确认新密码', type:'password', required:true },
        ],
        validate:function(v){ return v.new_password !== v.confirm_password ? '两次密码不一致' : null; },
      });
      if(!fv) return;
      send({action:'db_change_password', old_password:fv.old_password, new_password:fv.new_password}, function(msg){
        if(msg.status === 'ok'){
          addLog('密码已修改','success');
          if(typeof toastOk === 'function') toastOk('密码已修改');
        } else {
          addLog('修改失败: '+msg.msg,'error');
          alert('修改失败: '+(msg.msg || '未知错误'));
        }
      });
    } else {
      if(!(await rpConfirm({ title:'重置用户密码', danger:true, okText:'继续',
        body:'确定重置用户 "'+username+'" 的密码？\n(管理员权限，无需输入旧密码)' }))) return;
      var fv2 = await rpForm({
        title:'重置密码（'+username+'）', danger:true, okText:'重置',
        hint:'管理员权限，无需输入旧密码',
        fields:[
          { key:'new_password', label:'新密码', type:'password', required:true, minLen:4, hint:'至少 4 位' },
          { key:'confirm_password', label:'确认新密码', type:'password', required:true },
        ],
        validate:function(v){ return v.new_password !== v.confirm_password ? '两次密码不一致' : null; },
      });
      if(!fv2) return;
      send({action:'db_user_update', user_id:uid, password:fv2.new_password}, function(msg){
        if(msg.status === 'ok'){
          addLog('用户 '+username+' 密码已重置','success');
          if(typeof toastOk === 'function') toastOk('用户 '+username+' 密码已重置');
        } else {
          addLog('重置失败: '+msg.msg,'error');
          alert('重置失败: '+(msg.msg || '未知错误'));
        }
      });
    }
  }

  async function deleteUser(uid){
    if(!(await rpConfirm({ title:'删除用户', danger:true, okText:'删除', body:'确定删除此用户？' }))) return;
    send({action:'db_user_delete', user_id:uid}, function(msg){
      if(msg.status === 'ok'){
        addLog('用户已删除','success');
        loadUserList();
      } else {
        addLog('删除失败: '+msg.msg,'error');
      }
    });
  }

  async function openChangePassword(){
    var fv = await rpForm({
      title:'修改密码', okText:'修改',
      fields:[
        { key:'old_password', label:'旧密码', type:'password', required:true },
        { key:'new_password', label:'新密码', type:'password', required:true },
        { key:'confirm_password', label:'确认新密码', type:'password', required:true },
      ],
      validate:function(v){ return v.new_password !== v.confirm_password ? '两次密码不一致' : null; },
    });
    if(!fv) return;
    send({action:'db_change_password', old_password:fv.old_password, new_password:fv.new_password}, function(msg){
      if(msg.status === 'ok'){
        addLog('密码修改成功','success');
      } else {
        addLog('修改密码失败: '+msg.msg,'error');
      }
    });
  }

  // 全局挂载（HTML onclick / 其他文件通过 window.xxx 调）
  window.PAGE_DISPLAY = PAGE_DISPLAY;
  window.pageDisplayName = pageDisplayName;
  window.updateUserSidebar = updateUserSidebar;
  window.openUserManager = openUserManager;
  window.loadUserList = loadUserList;
  window.renderUserList = renderUserList;
  window.openPermsDialog = openPermsDialog;
  window.openAddUser = openAddUser;
  window.editUser = editUser;
  window.toggleUserRole = toggleUserRole;
  window.changeUserPassword = changeUserPassword;
  window.deleteUser = deleteUser;
  window.openChangePassword = openChangePassword;
})();

  // v5.22.3 · FIX: 进入用户面板时列表不加载 — 旧入口 openUserManager 已无触发点,
  //   面板激活时自动刷新 (与 job_registry 同款 MutationObserver 懒加载)
  document.addEventListener('DOMContentLoaded', function(){
    var panel = document.getElementById('panel-users');
    if (panel && 'MutationObserver' in window){
      new MutationObserver(function(){
        if (panel.classList.contains('active')){
          var tb = document.getElementById('userTableBody');
          if (tb && !tb.innerHTML.trim()) loadUserList();
        }
      }).observe(panel, { attributes: true, attributeFilter: ['class'] });
    }
  });
