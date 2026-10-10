/* Fonriv 社区版 · 功能表 (真源 scripts/features.json 的社区档子集; 修改请两边同步) */
(function(){
  window.RP_FEATURES = {core:{label:"核心 (登录/浏览/基础传输)"},rsync:{label:"文件传输 (rsync/上传下载)"},share:{label:"网络共享 (SMB/NFS 挂载)"},schedule:{label:"定时调度"},audit:{label:"审计"},dashboard:{label:"数据总览"},terminal:{label:"终端 (SSH)"},pve:{label:"PVE 节点连接 + 一键备份"},vzdump:{label:"vzdump 打包"},docker:{label:"Docker 容器管理 (SSH 远端)"},rdp:{label:"RDP 远程桌面 (guacd 网关)"},connhub:{label:"连接中心 (服务器档案/会话复用/凭据保险库/分组)"}};
  window.RP_FEATURE_GROUPS = [["📁 基础 / 传输",['core','rsync','schedule']],["🔌 连接中心",['connhub']],["🌐 共享 / 远端存储",['share']],["🖥 终端",['terminal']],["🖥 Proxmox 备份",['pve','vzdump']],["📦 容器",['docker']],["📊 总览 / 审计",['audit','dashboard']],["🖥 远程桌面",['rdp']]];
  window.RP_FEATURE_EDITIONS = {community: ['core','rsync','share','schedule','audit','dashboard','terminal','pve','vzdump','docker','rdp','connhub']};
})();
