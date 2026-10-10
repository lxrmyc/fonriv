/* v6.3.15 · 视觉统一 ①: 统一的 canvas 图表底座(零依赖)
 *
 * 背景: 全站 canvas 图表各自手写"清屏 / 边距 / 网格 / 刻度 / 轴标签",
 *   于是同一页里两张图的网格色、刻度间距、标签位置都不一样(看起来像两个人画的)。
 *   本项目不引图表库(零外部前端库纪律), 所以抽一层**极小**的公共底座:
 *   只管**坐标框/网格/刻度/标签**这几件最该统一的事, 具体图形(柱/线)仍由各面板自己画。
 *
 * 取色一律走 CSS 变量(随主题变): `--chart-grid` / `--chart-text` / `--chart-1..4`。
 */
(function (g) {
  'use strict';

  function cssVar(name, dflt) {
    try {
      var v = getComputedStyle(document.documentElement).getPropertyValue(name);
      v = (v || '').trim();
      return v || dflt;
    } catch (e) { return dflt; }
  }

  var STATS = { clear: 0, axes: 0 };

  /* 统一 Pal: 图表配色只从这里取, 不再散落硬编码 */
  function pal() {
    return {
      c1: cssVar('--chart-1', '#5b8def'),
      c2: cssVar('--chart-2', '#35c07f'),
      c3: cssVar('--chart-3', '#f0a03c'),
      c4: cssVar('--chart-4', '#3fc4d4'),
      grid: cssVar('--chart-grid', 'rgba(128,128,128,.25)'),
      text: cssVar('--chart-text', '#8a8f98'),
      font: '11px system-ui, -apple-system, "Noto Sans CJK SC", sans-serif'
    };
  }

  /* 统一清屏: 处理 devicePixelRatio, 返回 {ctx, w, h}(CSS 像素尺寸) */
  function clear(cvs) {
    if (!cvs || !cvs.getContext) return null;
    var dpr = g.devicePixelRatio || 1;
    var w = Math.max(1, Math.round(cvs.clientWidth || cvs.width / dpr || 0));
    var h = Math.max(1, Math.round(cvs.clientHeight || cvs.height / dpr || 0));
    if (cvs.width !== Math.round(w * dpr) || cvs.height !== Math.round(h * dpr)) {
      cvs.width = Math.round(w * dpr); cvs.height = Math.round(h * dpr);
    }
    var ctx = cvs.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    STATS.clear++;
    return { ctx: ctx, w: w, h: h };
  }

  /* 统一坐标框 + 横向网格 + Y 刻度 + X 标签
   * opts: {pad:{l,r,t,b}, yMax, yTicks, xLabels:[], labelEvery, formatY(v)}
   * 返回绘图区 {x0,y0,x1,y1,w,h} 供调用方画图形。 */
  function axes(ctx, w, h, opts) {
    opts = opts || {};
    var p = opts.pad || { l: 34, r: 8, t: 10, b: 18 };
    var P = pal();
    var x0 = p.l, y0 = p.t, x1 = w - p.r, y1 = h - p.b;
    var yMax = opts.yMax > 0 ? opts.yMax : 1;
    var ticks = Math.max(2, opts.yTicks || 4);

    ctx.save();
    ctx.font = P.font;
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 1;

    for (var i = 0; i <= ticks; i++) {
      var v = yMax * i / ticks;
      var y = Math.round(y1 - (y1 - y0) * i / ticks) + 0.5;
      ctx.strokeStyle = P.grid;
      ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
      ctx.fillStyle = P.text;
      var lab = opts.formatY ? opts.formatY(v) : String(Math.round(v));
      ctx.textAlign = 'right';
      ctx.fillText(lab, x0 - 4, y);
    }

    var xs = opts.xLabels || [];
    if (xs.length) {
      var every = Math.max(1, opts.labelEvery || Math.ceil(xs.length / Math.max(2, Math.floor((x1 - x0) / 46))));
      ctx.fillStyle = P.text;
      ctx.textAlign = 'center';
      for (var j = 0; j < xs.length; j += every) {
        var cx = x0 + (x1 - x0) * (xs.length === 1 ? 0.5 : (j + 0.5) / xs.length);
        if (cx - 16 < x0 - 30 || cx + 16 > x1 + 30) continue;
        ctx.fillText(String(xs[j]), cx, y1 + 9);
      }
    }
    ctx.restore();
    STATS.axes++;
    return { x0: x0, y0: y0, x1: x1, y1: y1, w: x1 - x0, h: y1 - y0 };
  }

  g.rpChart = { pal: pal, clear: clear, axes: axes, stats: STATS, _cssVar: cssVar };
})(window);
