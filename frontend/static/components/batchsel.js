/* v5.69.0 · F5 **批量与键盘操作** —— 选区推进的纯函数（可被 node 直接测）。
 *
 * 为什么要单独拆一个纯函数模块：键盘导航/范围选择"看起来简单，实测最容易错"（Home/End 边界、
 * Shift 扩展的锚点、网格视图的上下行步进）。把它抽成不依赖 DOM 的纯函数，就能用 node 断言穷举，
 * 而不是靠肉眼在浏览器里点。
 *
 * 约定：items 是当前**可见**项数组（每个含 name）；sel 是 {name: item} 的选区对象；
 * 所有函数**不修改入参**，返回新对象（避免"改了一半"的中间态）。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.BatchSel = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  function names(items) { return (items || []).map(function (x) { return x.name; }); }

  function indexOfName(items, name) {
    var arr = items || [];
    for (var i = 0; i < arr.length; i++) { if (arr[i].name === name) return i; }
    return -1;
  }

  function pick(items, a, b) {
    var out = {};
    for (var i = a; i <= b; i++) { if (items[i]) out[items[i].name] = items[i]; }
    return out;
  }

  /** 移动游标：delta>0 向下。opts.step 为网格视图的一行步进；extend=true 时保留锚点做范围选择。 */
  function move(items, curName, delta, opts) {
    var arr = items || [], o = opts || {};
    var step = Math.max(1, o.step || 1);
    var n = arr.length;
    if (!n) return { name: '', sel: {}, index: -1 };
    var i0 = indexOfName(arr, curName);
    if (i0 < 0) i0 = delta < 0 ? n : -1;                    // 未选中时: 向下→从第一项开始, 向上→从最后一项开始
    var sub = delta < 0 ? -step : step;
    var idx = i0 + sub * (Math.abs(delta) > 1 && step === 1 ? Math.abs(delta) : 1);
    if (idx < 0) idx = 0;
    if (idx > n - 1) idx = n - 1;
    var it = arr[idx];
    var sel;
    if (o.extend && typeof o.anchor === 'number' && o.anchor >= 0) {
      var a = Math.min(o.anchor, idx), b = Math.max(o.anchor, idx);
      sel = pick(arr, a, b);
    } else {
      sel = {}; if (it) sel[it.name] = it;
    }
    return { name: it ? it.name : '', sel: sel, index: idx, anchor: (o.extend && o.anchor >= 0) ? o.anchor : idx };
  }

  /** 首/尾/翻页：'home' | 'end' | 'pageup' | 'pagedown'（返回与 move 同构的结果）。 */
  function jump(items, kind, opts) {
    var arr = items || [], o = opts || {};
    if (!arr.length) return { name: '', sel: {}, index: -1 };
    var page = Math.max(1, o.page || 10);
    var i = indexOfName(arr, o.cur);
    if (i < 0) i = 0;
    var idx = kind === 'home' ? 0 : kind === 'end' ? arr.length - 1
      : kind === 'pageup' ? Math.max(0, i - page) : Math.min(arr.length - 1, i + page);
    var it = arr[idx], sel = {};
    if (it) sel[it.name] = it;
    return { name: it ? it.name : '', sel: sel, index: idx, anchor: idx, page: page };
  }

  /** 范围选择（Shift+点击/Shift+方向键共用）：锚点由调用方给，越界自动夹紧。 */
  function rangeSel(items, anchorName, name) {
    var arr = items || [];
    var a = indexOfName(arr, anchorName), b = indexOfName(arr, name);
    if (a < 0) a = b;
    if (b < 0) return {};
    return pick(arr, Math.min(a, b), Math.max(a, b));
  }

  function toggle(items, name, sel) {
    var out = {};
    Object.keys(sel || {}).forEach(function (k) { out[k] = sel[k]; });
    var it = (items || []).filter(function (x) { return x.name === name; })[0];
    if (!it) return out;
    if (out[name]) { delete out[name]; } else { out[name] = it; }
    return out;
  }

  function all(items) { return pick(items || [], 0, (items || []).length - 1); }
  function clear() { return {}; }

  /** 选区合计（条数/字节/是否含目录）—— 批量条摘要与"跨目录删除需确认"都用它。 */
  function summarize(sel) {
    var ks = Object.keys(sel || {}), bytes = 0, dirs = 0, files = 0;
    ks.forEach(function (k) {
      var it = sel[k] || {};
      bytes += (it.size || 0);
      if (it.is_dir) { dirs++; } else { files++; }
    });
    return { count: ks.length, bytes: bytes, dirs: dirs, files: files, names: ks };
  }

  /** 拒绝把目录粘进自身（否则会无限自我嵌套）。返回 '' 表示可以粘。 */
  function pasteConflict(srcStorage, srcDir, dstStorage, dstDir) {
    if (srcStorage !== dstStorage) return '';
    var a = String(srcDir || '/').replace(/\/+$/, '') || '/';
    var b = String(dstDir || '/').replace(/\/+$/, '') || '/';
    if (a === b) return '源目录与目标目录相同';
    if (b === a || b.indexOf(a + '/') === 0) return '不能把目录粘到它自己的子目录里';
    return '';
  }

  /** 矩形框选: rows=[{name, rect:{x,y,w,h}}(视口坐标)], box 同构。返回命中的 name 列表。
   *  判定: 两矩形**相交**即可(与桌面文件管理器一致), 不是"完全包含"。纯函数, node 可测。 */
  function boxSelect(rows, box) {
    var out = [];
    if (!box) return out;
    var bx2 = box.x + box.w, by2 = box.y + box.h;
    (rows || []).forEach(function (r) {
      var t = r && r.rect;
      if (!t || !t.w || !t.h || !r.name) return;              // 未渲染/零尺寸的行跳过(getBoundingClientRect 为 0 表示不可见)
      var rx2 = t.x + t.w, ry2 = t.y + t.h;
      var hit = !(rx2 < box.x || t.x > bx2 || ry2 < box.y || t.y > by2);
      if (hit) out.push(r.name);
    });
    return out;
  }

  /** 框选落定时把结果并入既有选区(additive=Ctrl/Shift 时为追加)。 */
  function merge(sel, names, items, additive) {
    var out = {};
    if (additive) { Object.keys(sel || {}).forEach(function (k) { out[k] = sel[k]; }); }
    (names || []).forEach(function (n) {
      var it = (items || []).filter(function (x) { return x.name === n; })[0];
      if (it) out[n] = it;
    });
    return out;
  }

  return { names: names, indexOfName: indexOfName, move: move, jump: jump, rangeSel: rangeSel,
           toggle: toggle, all: all, clear: clear, summarize: summarize,
           pasteConflict: pasteConflict, pick: pick, boxSelect: boxSelect, merge: merge };
});
