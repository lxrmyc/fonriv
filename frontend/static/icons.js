/* v6.3.15 · 视觉统一 ②: 零依赖内联 SVG 图标集(替代 emoji 图标)
 *
 * 为什么: emoji 在不同主题/字体/平台上**大小、基线、配色都不一致**, 深色主题下发灰发暗,
 *   且无法跟随 `currentColor` 变色 —— 同一个"🔄 刷新"在四套主题下观感四样。
 *
 * 做法(遵守"零外部前端库"纪律): 内联 `<symbol>` 精灵表 + `rpIcon(name)` 一行注入。
 *   · 描边式(1.8px, round)统一观感, `fill:none; stroke:currentColor` → 自动跟随主题文字色;
 *   · 尺寸走 `1em`(继承字号), 基线 `-.15em` 对齐文字;
 *   · 未知名**不静默产坏 HTML**: 返回空串并画一个中性圆点占位(见实现注释)。
 *
 * 用法:  `rpIcon('refresh')` → 可直接拼进 innerHTML;  按钮里常用
 *        `<button class="btn btn-sm">` + rpIcon('refresh') + ' 刷新' + `</button>`
 */
(function (g) {
  'use strict';

  /* 图标集: 单字母 k = 图标名, d = path 数据(24x24 视图) */
  var ICONS = {
    refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v6h-6',
    search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
    close: 'M6 6l12 12M18 6L6 18',
    plus: 'M12 5v14M5 12h14',
    minus: 'M5 12h14',
    trash: 'M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13M10 11v6M14 11v6',
    edit: 'M4 20h4l10-10-4-4L4 16v4zM14 6l4 4',
    save: 'M5 4h11l3 3v13H5zM8 4v6h8V4M8 14h8',
    download: 'M12 4v11M7 11l5 5 5-5M5 20h14',
    upload: 'M12 20V9M7 13l5-5 5 5M5 4h14',
    copy: 'M9 9h10v11H9zM5 4h10v3M5 4v11h3',
    play: 'M7 5l12 7-12 7z',
    stop: 'M6 6h12v12H6z',
    retry: 'M4 12a8 8 0 1 1 2.3 5.6M4 19v-5h5',
    warn: 'M12 4l9 16H3zM12 10v5M12 18h.01',
    ok: 'M5 13l4 4L19 7',
    info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5M12 8h.01',
    box: 'M3 8l9-5 9 5v8l-9 5-9-5zM3 8l9 5 9-5M12 13v8',
    clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l4 2',
    disk: 'M4 6h16v5H4zM6 9h.01M4 13h16v5H4zM6 16h.01',
    net: 'M12 3v7M5 21a7 7 0 0 1 14 0M9 17h6',
    user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM5 21a7 7 0 0 1 14 0',
    lock: 'M6 11h12v9H6zM9 11V8a3 3 0 0 1 6 0v3M12 15v2',
    chevron: 'M6 9l6 6 6-6',
    external: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
    task: 'M4 6h16M4 12h10M4 18h7M18 15l2 2 3-3',
    chart: 'M4 20V9M10 20V4M16 20v-7M22 20H2'
  };

  var SPRITE = 'rpIconSprite';

  function ensureSprite() {
    if (document.getElementById(SPRITE)) return true;
    var host = document.body || document.documentElement;
    if (!host) return false;
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.id = SPRITE;
    svg.setAttribute('aria-hidden', 'true');
    svg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
    var html = '';
    for (var k in ICONS) {
      html += '<symbol id="rp-i-' + k + '" viewBox="0 0 24 24">' + '<path d="' + ICONS[k] + '"/></symbol>';
    }
    svg.innerHTML = html;
    host.appendChild(svg);
    return true;
  }

  /* name 未知名 → 返回中性圆点(不产坏标签, 也不假装有图标) */
  function rpIcon(name, cls) {
    ensureSprite();
    var n = ICONS[name] ? name : null;
    if (!n) return '<svg class="rp-ic rp-ic-na' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/></svg>';
    return '<svg class="rp-ic' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" aria-hidden="true">'
         + '<use href="#rp-i-' + n + '"></use></svg>';
  }

  function rpSpin(cls) { return rpIcon('refresh', 'rp-ic-spin' + (cls ? ' ' + cls : '')); }

  g.rpIcon = rpIcon;
  g.rpSpin = rpSpin;
  g.RP_ICONS = Object.keys(ICONS);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureSprite);
  } else {
    ensureSprite();
  }
})(window);
