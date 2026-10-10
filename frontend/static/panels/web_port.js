/* v4.43.0 · WEB 服务端口管理（系统设置 · 仅 admin 可见/可改）
 * WS: web_port_get {saved_port, current_port, pending}
 *     web_port_set {port} -> {status, port, old_port, env_synced, msg}
 */
(function () {
  "use strict";

  function msg(text, isErr) {
    var el = document.getElementById("webPortMsg");
    if (!el) return;
    el.textContent = text || "";
    el.style.color = isErr ? "var(--red)" : "var(--text2)";
  }

  function status(text) {
    var el = document.getElementById("webPortStatus");
    if (el) el.textContent = text || "";
  }

  function isAdmin() {
    try {
      var u = window.currentUser || {};
      return u.role === "admin" || u.id === 1;
    } catch (e) { return false; }
  }

  function load() {
    var sec = document.getElementById("webPortSection");
    if (sec) sec.style.display = isAdmin() ? "" : "none";
    if (!isAdmin()) return;
    status("加载中…");
    window.send("web_port_get", {}, function (r) {
      if (!r || r.status !== "ok") {
        status("读取失败");
        msg((r && (r.msg || r.error)) || "读取端口信息失败", true);
        return;
      }
      var input = document.getElementById("webPortInput");
      if (input && !input.value) input.value = r.saved_port || r.current_port || 8000;
      var txt = "当前监听 " + r.current_port;
      if (r.saved_port && r.saved_port !== r.current_port) {
        txt += " · 已保存待生效 " + r.saved_port + "（重启服务后生效）";
      } else if (r.saved_port) {
        txt += " · 配置 " + r.saved_port;
      } else {
        txt += " · 未自定义（默认）";
      }
      status(txt);
      msg("");
    });
  }

  function save() {
    var input = document.getElementById("webPortInput");
    var port = parseInt((input && input.value) || "", 10);
    if (!port || port < 1 || port > 65535) {
      msg("端口必须是 1-65535 之间的数字", true);
      return;
    }
    msg("保存中…");
    window.send("web_port_set", { port: port }, function (r) {
      if (!r || r.status !== "ok") {
        msg((r && (r.msg || r.error)) || "保存失败", true);
        return;
      }
      msg("✓ " + (r.msg || ("端口已保存: " + r.old_port + " -> " + r.port + " · 重启服务后生效")));
      load();
    });
  }

  // 暴露全局（index.html onclick 直引）
  window.WebPort = { load: load, save: save };

  // app.js defer 加载后 hook switchTab：切到 settings 时自动拉取
  function hookSwitchTab() {
    var orig = window.switchTab;
    if (typeof orig !== "function") return;
    window.switchTab = function (t) {
      var out = orig.apply(this, arguments);
      if (t === "settings") setTimeout(load, 50);
      return out;
    };
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      // app.js 是 defer，等它先定义 switchTab
      setTimeout(hookSwitchTab, 200);
    });
  } else {
    setTimeout(hookSwitchTab, 200);
  }
})();
