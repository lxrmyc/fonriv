/* v4.71.0 · 备份中心聚合页 (方案 C)
 * 把分散的备份入口收进一个卡片九宫格，点击卡片跳到对应功能页
 * 依赖: window.switchTab / window.licenseFeatEnabled (未授权卡片自动隐藏)
 */
(function(g){
  'use strict';

  function $(id){ return document.getElementById(id); }
  function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g,function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }

  // 分组 → 卡片 (key 必须与 panel id / switchTab key 一致)
  var GROUPS = [
    { title: '🖥 Proxmox / PVE', color: 'var(--orange)', items: [
      { key:'proxmox',        icon:'🖥', title:'PVE 节点连接',   desc:'连接 Proxmox 节点 · 扫描 VM/CT 与存储池', feat:'pve' },
      { key:'vzdump',         icon:'📦', title:'vzdump 打包',    desc:'虚拟机/LXC 打包下载 · Pre/Post 一致性钩子', feat:'vzdump' },
      { key:'pbs',            icon:'🗄', title:'PBS 备份',       desc:'Proxmox Backup Server 仓库与快照', feat:'pbs' },
      { key:'auto_backup',    icon:'🔧', title:'PVE 一键备份',   desc:'批量扫描并备份全部虚拟机', feat:'pve' },
    ]},
    { title: '💽 存储卷', color: 'var(--purple)', items: [
      { key:'disk_image',     icon:'💽', title:'磁盘镜像备份', desc:'整盘/分区逐字节镜像 + 分区表/LVM 元数据 + sha256 清单 + 恢复向导', feat:'disk' },
      { key:'platform_backup', icon:'🐧', title:'通用一键备份',  desc:'Debian/Ubuntu/CentOS/OMV/群晖 等 Linux 主机', feat:'pve' },
      { key:'lvm',            icon:'💽', title:'LVM',           desc:'LVM 卷扫描、快照与导出', feat:'lvm' },
      { key:'zfs',            icon:'🗄', title:'ZFS',           desc:'ZFS 数据集、快照与 send/receive', feat:'zfs' },
      { key:'rbd',            icon:'🌐', title:'Ceph RBD',      desc:'Ceph 块设备快照与导出', feat:'rbd' },
      { key:'restic',         icon:'🗄', title:'restic 去重备份', desc:'块级去重 + AES-256 加密 + 多版本快照 + 防勒索', feat:'restic' },
    ]},
    { title: '📦 应用与容器', color: 'var(--cyan)', items: [
      { key:'dbbackup',   icon:'🗄', title:'数据库备份',   desc:'MySQL/MariaDB · PostgreSQL 不停机热备', feat:'dbbackup' },
      { key:'k8s_backup', icon:'📦', title:'K8s / 容器备份', desc:'etcd 快照 · Docker 容器与卷 · K8s PV', feat:'k8s_backup' },
    ]},
  ];

  var EXTRA = [
    { key:'remotes',        icon:'☁️', title:'远端存储',   desc:'S3/OSS/COS/Seafile 异地容灾归档', feat:'cloud' },
    { key:'schedules',      icon:'⏰', title:'定时计划',   desc:'所有备份任务统一调度与查看', feat:'schedule' },
    { key:'stats_overview', icon:'📈', title:'智能分析',   desc:'备份异常检测(3σ) 与最优执行时段', feat:null, goto:'settings' },
  ];

  function _ok(feat){
    if (!feat) return true;
    try {
      if (typeof g.licenseFeatEnabled === 'function') return g.licenseFeatEnabled(feat);
    } catch(e){}
    return true;
  }

  function _card(it){
    return '<div class="bkc-card" data-key="'+esc(it.key)+'" '+
      'style="cursor:pointer;background:var(--bg2);border:1px solid var(--border);border-radius:10px;'+
      'padding:12px 14px;display:flex;gap:10px;align-items:flex-start;transition:all .15s">'+
        '<span style="font-size:22px;line-height:1.1">'+it.icon+'</span>'+
        '<div style="min-width:0">'+
          '<div style="font-size:13px;font-weight:600;color:var(--text)">'+esc(it.title)+'</div>'+
          '<div style="font-size:11px;color:var(--text3);line-height:1.6;margin-top:2px">'+esc(it.desc)+'</div>'+
        '</div>'+
      '</div>';
  }

  function render(){
    var host = $('bkcBody');
    if (!host) return;
    var html = '';
    html += '<div style="font-size:11px;color:var(--text3);margin-bottom:12px;line-height:1.8">'+
      '全部备份能力集中在此：按类型分组的卡片入口，点卡片直达对应功能页。原页面功能与权限保持不变。'+
      '</div>';
    GROUPS.forEach(function(grp){
      var items = grp.items.filter(function(it){ return _ok(it.feat); });
      if (!items.length) return;
      html += '<div style="margin-bottom:16px">'+
        '<div style="font-size:12px;font-weight:600;color:'+grp.color+';margin-bottom:8px;'+
        'display:flex;align-items:center;gap:6px">'+esc(grp.title)+
        '<span style="color:var(--text3);font-size:10px;font-weight:400">'+items.length+' 项</span></div>'+
        '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px">'+
        items.map(_card).join('')+'</div></div>';
    });
    html += '<div style="margin-bottom:6px">'+
      '<div style="font-size:12px;font-weight:600;color:var(--text2);margin-bottom:8px">🔧 通用入口</div>'+
      '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px">'+
      EXTRA.filter(function(it){ return _ok(it.feat); }).map(_card).join('')+'</div></div>';
    host.innerHTML = html;
    host.querySelectorAll('.bkc-card').forEach(function(el){
      el.onmouseenter = function(){
        el.style.borderColor = 'var(--cyan)';
        el.style.transform = 'translateY(-1px)';
        el.style.boxShadow = '0 4px 14px rgba(0,0,0,.18)';
      };
      el.onmouseleave = function(){
        el.style.borderColor = 'var(--border)';
        el.style.transform = '';
        el.style.boxShadow = '';
      };
      el.onclick = function(){
        var key = el.getAttribute('data-key');
        var it = null;
        GROUPS.concat([{ items: EXTRA }]).forEach(function(grp){
          grp.items.forEach(function(x){ if (x.key === key) it = x; });
        });
        var target = (it && it.goto) ? it.goto : key;
        if (typeof g.switchTab === 'function') g.switchTab(target);
        // v5.98.18 · 卡片可直接定位到本页内的功能段(如「磁盘镜像备份」在备份总览页下方)
        if (it && it.anchor){
          setTimeout(function(){
            var sec = document.getElementById(it.anchor);
            if (!sec) return;
            var body = sec.querySelector('.section-body');
            if (body && body.style.display === 'none' && typeof g.toggleSection === 'function'){
              var hd = sec.querySelector('.section-header');
              if (hd) g.toggleSection(hd);
            }
            sec.scrollIntoView({ behavior:'smooth', block:'start' });
          }, 260);
        }
      };
    });
  }

  g.BackupCenter = { render: render, groups: GROUPS };
})(window);
