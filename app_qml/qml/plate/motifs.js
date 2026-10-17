.pragma library
// 纹样系统：神圣象征 × 飞鸟 × 精密几何。
// 全部是程序绘制的矢量组件（项目零位图素材），供 HeroPlate / MotifPlate 等 Canvas 直接调用。
// .pragma library：整个 App 共用一份（屏幕补偿系数 PX、显眼度 VIS 都是模块级状态，
// 必须让所有图版看到同一个值；这里只读 Math 与 canvas 上下文，不碰任何 QML 组件）。
//
// 总则（对应《纹样设计规范》，改代码前先读这一节）：
//   ① 一切图形都是"细线描边 + 极薄半透明填充"，重点靠轮廓、比例、留白建立，禁止发光/厚描边。
//   ② 描边宽度由尺寸推导：lw(base) 夹在 [0.70, 1.9]，刻度线一律 ≤ 0.9。
//   ③ 透明度分三层：主体 0.55-0.72 / 辅助 0.28-0.42 / 刻度与注记 0.14-0.26。
//   ④ 几何只从圆心、等分角、黄金比推导；允许"手绘抖动"（wob），不允许随机摆放。
//   ⑤ 动画入口统一是 opts.t（0..1 的相位或进度，缺省 1），几何本身不读时间。
//   ⑥ 鸟是有机主体，坐标线与弧形轨迹只是引导线：引导线永远画在鸟下面，且更淡。
//
// 颜色：蓝白基调，象牙白/珍珠白、冰蓝/淡青蓝、低饱和银灰、少量香槟金、深海军蓝对比。

var C = {
    ivory: "#f5f2ea",       // 象牙白
    pearl: "#eef2f4",       // 珍珠白
    ice: "#c3d9e8",         // 冰蓝
    iceDeep: "#8db4d4",     // 深一点的冰蓝
    cyan: "#a9ccd5",        // 淡青蓝
    silver: "#98a2a6",      // 低饱和银灰
    silverSoft: "#bcc4c7",
    gold: "#c1a05e",        // 香槟金（只在极小面积上用）
    goldSoft: "#d9c391",
    navy: "#1e2c4b",        // 深海军蓝
    ink: "#22282b",
    cobalt: "#3a5bc2",
    azure: "#4c92d4",
    paper: "#eff1ef",
    // 参考图那层"雾"：画面不是纯纸白，而是一片偏冷的青灰，亮部（鸟、光池）才浮得起来。
    haze: "#e2eaee",
    hazeDeep: "#d2dee4",
    hazeCool: "#e8f0f3",
    mist: "#f3f7f8"
};

var TAU = Math.PI * 2;
var PHI = (Math.sqrt(5) - 1) / 2;   // 0.618…，黄金比

// ── 基础工具 ───────────────────────────────────────────────────────────

function rng(seed) {
    var s = (seed || 1) % 2147483647;
    if (s <= 0)
        s += 2147483646;
    return function () {
        s = (s * 16807) % 2147483647;
        return (s - 1) / 2147483646;
    };
}

function clamp(v, a, b) {
    return v < a ? a : (v > b ? b : v);
}

function lerp(a, b, t) {
    return a + (b - a) * t;
}

// ★ 屏幕补偿（PX）：版面画布是"设计坐标 × 窗口缩放比"画的，窗口一小，
//   0.7 设计像素的细线只剩 0.4 设备像素 —— 糊成一片灰。模板入口按 opt.scale
//   算出 1/scale（夹在 1..2.4），线宽与透明度都乘它，于是缩到多小都还有笔触。
//   同时 PX 大过 1.45 时关掉最细的一层装饰（颗粒、飘带、小字标注），
//   因为那点尺寸画出来只是噪点，不如留白。
var PX = 1.0;

function fine() {
    return PX < 1.45;
}

// 描边宽度：唯一入口，避免各处随手写 1.5/2/3
function lw(base) {
    return clamp(base * PX, 0.70, 1.9 * PX);
}

// 手绘抖动：让线"活"一点，但幅度与几何无关（不破坏比例）
function wob(r, amp) {
    return (r() - 0.5) * 2 * (amp === undefined ? 0.6 : amp);
}

// 显眼度总开关：所有透明度都从这里过一道。
// 1.0 = 规范基准（偏淡、纸面感强）；用户要求"纹样显眼一点"后调到 1.55 ——
// 淡的那些（0.2 上下）抬到肉眼看得见，本来就重的（0.9+）夹在 1 不再加重。
// 缩小显示时再补一点点（PX 越大补得越多），否则细线在屏幕上直接消失。
var VIS = 1.55;

function alpha(ctx, a) {
    ctx.globalAlpha = clamp(a * VIS * (0.84 + 0.16 * PX), 0, 1);
}

// 极坐标系取点
function pol(cx, cy, rad, ang) {
    return { x: cx + Math.cos(ang) * rad, y: cy + Math.sin(ang) * rad };
}

function strokeArc(ctx, cx, cy, rad, a0, a1, r, amp) {
    ctx.beginPath();
    var n = Math.max(6, Math.round(Math.abs(a1 - a0) / 0.12));
    for (var i = 0; i <= n; i++) {
        var a = lerp(a0, a1, i / n);
        var rr = rad + wob(r, amp === undefined ? 0.7 : amp);
        var p = pol(cx, cy, rr, a);
        if (i === 0)
            ctx.moveTo(p.x, p.y);
        else
            ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
}

function strokeCircle(ctx, cx, cy, rad, r, amp) {
    strokeArc(ctx, cx, cy, rad, 0, TAU, r, amp);
}

function dot(ctx, x, y, rad, color, a) {
    ctx.save();
    ctx.fillStyle = color;
    alpha(ctx, a);
    ctx.beginPath();
    ctx.arc(x, y, rad, 0, TAU);
    ctx.fill();
    ctx.restore();
}

// 细分刻度环：分段的短刻度（圣徽/坐标盘的共同语言）
function tickRing(ctx, cx, cy, rad, count, len, r, color, a, phase) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = lw(0.8);
    alpha(ctx, a);
    for (var i = 0; i < count; i++) {
        var ang = (i / count) * TAU + (phase || 0);
        var l = (i % 3 === 0) ? len : len * 0.55;
        var p0 = pol(cx, cy, rad, ang);
        var p1 = pol(cx, cy, rad + l, ang);
        ctx.beginPath();
        ctx.moveTo(p0.x, p0.y);
        ctx.lineTo(p1.x, p1.y);
        ctx.stroke();
    }
    ctx.restore();
}

// ── 参考图语言：光带 / 柔光 / 小圆徽 / 细测量线 / 虚线弧 ────────────────
// 这一组是照着《明日方舟》「众生行记」那张界面提炼的：极浅的竖向光带做底，
// 主体后面铺一层柔光，功能性的东西一律"小而精"（细轴 + 小标签 + 小圆徽），
// 斜穿画面的虚线弧负责把视线带走。它们都极淡，属于背景层，永远画在主体之前。

// 竖向柔光带：像雾里透下来的几道光，横向做渐隐，纵向不封口
function lightShafts(ctx, w, h, r, opt) {
    var o = opt || {};
    var t = o.t === undefined ? 1 : clamp(o.t, 0, 1);
    var n = o.count === undefined ? 7 : o.count;
    var color = o.color || C.pearl;
    var base = o.alpha === undefined ? 0.30 : o.alpha;
    var i;
    ctx.save();
    for (i = 0; i < n; i++) {
        var x = w * (0.06 + 0.92 * (i + 0.5) / n) + wob(r, w * 0.02);
        var bw = w * lerp(0.018, 0.075, r()) * (o.width || 1);
        var tilt = wob(r, 0.045);
        var g = ctx.createLinearGradient(x - bw, 0, x + bw, 0);
        var a = base * lerp(0.45, 1, r()) * t;
        g.addColorStop(0.0, C.paper);
        g.addColorStop(0.5, color);
        g.addColorStop(1.0, C.paper);
        ctx.save();
        ctx.globalAlpha = clamp(a, 0, 1);
        ctx.fillStyle = g;
        ctx.translate(x, h * 0.5);
        ctx.rotate(tilt);
        ctx.fillRect(-bw, -h * 0.62, bw * 2, h * 1.24);
        ctx.restore();
    }
    // 再补两三根真正的高光细线，光带才有"边"
    ctx.strokeStyle = C.ivory;
    ctx.lineWidth = lw(0.7);
    alpha(ctx, 0.42 * t);
    for (i = 0; i < 3; i++) {
        var lx = w * (0.12 + 0.76 * (i + 0.5) / 3) + wob(r, w * 0.01);
        ctx.beginPath();
        ctx.moveTo(lx + wob(r, 6), -h * 0.05);
        ctx.lineTo(lx + wob(r, 6) + h * wob(r, 0.03), h * 1.05);
        ctx.stroke();
    }
    ctx.restore();
}

// 柔光：主体背后的一团渐隐光（径向渐变，别用阴影模拟）
function softGlow(ctx, cx, cy, rad, color, a) {
    ctx.save();
    var g = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(1, rad));
    g.addColorStop(0.0, color || C.ivory);
    g.addColorStop(0.45, color || C.ivory);
    g.addColorStop(1.0, C.paper);
    ctx.globalAlpha = clamp(a === undefined ? 0.34 : a, 0, 1);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(1, rad), 0, TAU);
    ctx.fill();
    ctx.restore();
}

// 雾底：纹样图版的第一层。参考图的舒适来自"底不是纸白，而是一片冷青灰的雾"——
// 有了这层，白色的鸟、光池、柔光体才有地方浮起来；没有它，再多的白色都是白画白。
// opt: { t, tint, cool, pools }
function backdrop(ctx, w, h, r, opt) {
    var o = opt || {};
    var t = o.t === undefined ? 1 : clamp(o.t, 0, 1);

    ctx.save();
    // ① 斜向的冷色渐变：左下与右上各偏一点青灰，中间回到珍珠白
    var g = ctx.createLinearGradient(0, h, w, 0);
    g.addColorStop(0.00, o.haze || C.hazeDeep);
    g.addColorStop(0.38, o.tint || C.haze);
    g.addColorStop(0.62, C.hazeCool);
    g.addColorStop(1.00, C.haze);
    ctx.globalAlpha = 0.92 * t;
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    // ② 两三个更亮的光池：位置固定成不对称构图，避免"居中一个圆"的廉价感
    var pools = [
        { x: 0.58, y: 0.30, rx: 0.40, ry: 0.34, a: 0.55 },
        { x: 0.16, y: 0.74, rx: 0.30, ry: 0.26, a: 0.34 },
        { x: 0.92, y: 0.86, rx: 0.24, ry: 0.22, a: 0.26 }
    ];
    softMass(ctx, w * pools[0].x, h * pools[0].y, Math.min(w, h) * pools[0].rx, Math.min(w, h) * pools[0].ry, r,
             { color: C.mist, a: pools[0].a * t, core: 0.26 });
    softMass(ctx, w * pools[1].x, h * pools[1].y, Math.min(w, h) * pools[1].rx, Math.min(w, h) * pools[1].ry, r,
             { color: C.mist, a: pools[1].a * t, core: 0.20 });
    softMass(ctx, w * pools[2].x, h * pools[2].y, Math.min(w, h) * pools[2].rx, Math.min(w, h) * pools[2].ry, r,
             { color: C.hazeCool, a: pools[2].a * t, core: 0.16 });
    ctx.restore();
}

// 大块柔光体：参考图"看着舒适"的第一来源是这种没有硬边、没有细节的大面积柔光形
// （云团、圆盘、翼团）。它不是背景色块，而是把画面垫厚的一层空气。
// opt: { color, core（实心半径占比）, ry（纵向压扁）, a, grain（是否加一圈极淡的等值线） }
function softMass(ctx, cx, cy, rx, ry, r, opt) {
    var o = opt || {};
    var color = o.color || C.pearl;
    var a = clamp(o.a === undefined ? 0.5 : o.a, 0, 1);
    var core = clamp(o.core === undefined ? 0.18 : o.core, 0, 0.95);
    var ryy = Math.max(1, ry === undefined ? rx : ry);

    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(1, ryy / Math.max(1, rx));
    var g = ctx.createRadialGradient(0, 0, 0, 0, 0, Math.max(1, rx));
    g.addColorStop(0.0, color);
    g.addColorStop(core, color);
    g.addColorStop(Math.min(0.97, core + 0.42), o.mid || C.pearl);
    g.addColorStop(1.0, C.paper);
    ctx.globalAlpha = a;
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, Math.max(1, rx), 0, TAU);
    ctx.fill();

    // 一圈极淡的等值线：让柔光体有"边界感"但不产生硬轮廓
    if (o.grain) {
        ctx.globalAlpha = a * 0.20;
        ctx.strokeStyle = o.grainColor || C.iceDeep;
        ctx.lineWidth = lw(0.6);
        ctx.beginPath();
        ctx.arc(0, 0, Math.max(1, rx * 0.86), 0, TAU);
        ctx.stroke();
    }
    ctx.restore();

    // 一团柔光体边缘的两三片飘带，模拟参考图里云/雾被风带走的形状
    if (o.wisps) {
        ctx.save();
        ctx.globalAlpha = a * 0.55;
        ctx.strokeStyle = color;
        ctx.lineWidth = lw(1.1);
        ctx.lineCap = "round";
        for (var i = 0; i < o.wisps; i++) {
            var ang = (i / o.wisps) * TAU + (r ? r() : 0.5) * 0.6;
            var rr = rx * (0.62 + 0.30 * (r ? r() : 0.5));
            var x0 = cx + Math.cos(ang) * rr;
            var y0 = cy + Math.sin(ang) * rr * (ryy / Math.max(1, rx));
            var len = rx * (0.18 + 0.22 * (r ? r() : 0.5));
            ctx.beginPath();
            ctx.moveTo(x0, y0);
            ctx.quadraticCurveTo(x0 + Math.cos(ang + 0.9) * len, y0 + Math.sin(ang + 0.9) * len * 0.6,
                                 x0 + Math.cos(ang + 1.7) * len * 1.5, y0 + Math.sin(ang + 1.7) * len * 0.5);
            ctx.stroke();
        }
        ctx.restore();
    }
}

// 细测量轴：一条细线 + 两端刻度 + 一个小写标注（X / Y / A1 / 240 …）
function hairAxis(ctx, x0, y0, x1, y1, r, opt) {
    var o = opt || {};
    var t = o.t === undefined ? 1 : clamp(o.t, 0, 1);
    var color = o.color || C.silverSoft;
    var len = Math.sqrt((x1 - x0) * (x1 - x0) + (y1 - y0) * (y1 - y0));
    var ang = Math.atan2(y1 - y0, x1 - x0);
    ctx.save();
    ctx.translate(x0, y0);
    ctx.rotate(ang);
    ctx.strokeStyle = color;
    ctx.lineWidth = lw(0.7);
    alpha(ctx, 0.52 * t);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(len, 0);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, -4);
    ctx.lineTo(0, 4);
    ctx.moveTo(len, -4);
    ctx.lineTo(len, 4);
    ctx.moveTo(len * 0.5, -3);
    ctx.lineTo(len * 0.5, 3);
    ctx.stroke();
    if (o.ticks) {
        var i;
        for (i = 1; i < o.ticks; i++) {
            var tx = len * i / o.ticks;
            ctx.beginPath();
            ctx.moveTo(tx, -2);
            ctx.lineTo(tx, 2);
            ctx.stroke();
        }
    }
    if (o.label) {
        ctx.fillStyle = color;
        ctx.font = (o.size || 9) + "px " + (o.font || "Consolas, monospace");
        alpha(ctx, 0.66 * t);
        ctx.textAlign = "center";
        ctx.fillText(o.label, len * 0.5, (o.labelBelow ? 13 : -6));
    }
    ctx.restore();
}

// 虚线弧：斜穿画面的那条"绳"，带一枚方向小三角
function dashArc(ctx, cx, cy, rad, a0, a1, r, opt) {
    var o = opt || {};
    var t = o.t === undefined ? 1 : clamp(o.t, 0, 1);
    ctx.save();
    ctx.strokeStyle = o.color || C.iceDeep;
    ctx.lineWidth = lw(o.lw || 0.8);
    if (ctx.setLineDash)
        ctx.setLineDash([o.dash || 7, o.gap || 5]);
    alpha(ctx, (o.alpha === undefined ? 0.46 : o.alpha) * t);
    ctx.beginPath();
    var n = 40, i;
    for (i = 0; i <= n; i++) {
        var a = lerp(a0, a1, i / n) + wob(r, 0.006);
        var px = cx + Math.cos(a) * (rad + wob(r, 2.4));
        var py = cy + Math.sin(a) * (rad + wob(r, 2.4));
        if (i === 0)
            ctx.moveTo(px, py);
        else
            ctx.lineTo(px, py);
    }
    ctx.stroke();
    if (ctx.setLineDash)
        ctx.setLineDash([]);
    if (o.head !== false) {
        var ha = a1;
        var hx = cx + Math.cos(ha) * rad, hy = cy + Math.sin(ha) * rad;
        ctx.fillStyle = o.color || C.iceDeep;
        alpha(ctx, 0.6 * t);
        ctx.beginPath();
        ctx.moveTo(hx, hy);
        ctx.lineTo(hx - Math.cos(ha - 0.22) * 9, hy - Math.sin(ha - 0.22) * 9);
        ctx.lineTo(hx - Math.cos(ha + 0.22) * 9, hy - Math.sin(ha + 0.22) * 9);
        ctx.closePath();
        ctx.fill();
    }
    ctx.restore();
}

// 小圆徽：细方框（或圆框）里一枚刻度环 + 十字线 + 一个分区小标签。
// 参考图里功能入口都是这个样子：小、精、不加粗，靠"细"和"准"区分层级。
function medallion(ctx, cx, cy, rad, r, opt) {
    var o = opt || {};
    var t = o.t === undefined ? 1 : clamp(o.t, 0, 1);
    var color = o.color || C.navy;
    var box = o.box === undefined ? true : o.box;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = lw(0.75);
    alpha(ctx, 0.46 * t);
    if (box) {
        var s = rad * 2.5;
        ctx.beginPath();
        ctx.rect(cx - s / 2, cy - s / 2, s, s);
        ctx.stroke();
    }
    halo(ctx, cx, cy, rad, o.kind === undefined ? 3 : o.kind, r, { t: t, line: o.ring || C.iceDeep });
    ctx.beginPath();
    ctx.moveTo(cx - rad * 1.24, cy);
    ctx.lineTo(cx - rad * 1.02, cy);
    ctx.moveTo(cx + rad * 1.02, cy);
    ctx.lineTo(cx + rad * 1.24, cy);
    ctx.moveTo(cx, cy - rad * 1.24);
    ctx.lineTo(cx, cy - rad * 1.02);
    ctx.moveTo(cx, cy + rad * 1.02);
    ctx.lineTo(cx, cy + rad * 1.24);
    ctx.stroke();
    if (o.glyph) {
        ctx.fillStyle = color;
        ctx.font = (o.size || 11) + "px " + (o.font || "Georgia, serif");
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        alpha(ctx, 0.6 * t);
        ctx.fillText(o.glyph, cx, cy + 0.5);
    }
    if (o.label) {
        ctx.fillStyle = color;
        ctx.font = (o.lsize || 9) + "px Consolas, monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        alpha(ctx, 0.5 * t);
        ctx.fillText(o.label, box ? cx : cx, box ? cy + rad * 1.5 : cy + rad * 1.4);
    }
    ctx.restore();
}

// ══ 子系统一：飞鸟与羽毛 ══════════════════════════════════════════════
//
// 造型系列（A-G）：全部由同一套"脊线 + 双翼 + 尾扇 + 羽片缺口"参数生成，
// 所以不同姿态之间保持相同的羽片语言与轮廓精细度，只是比例/俯仰/透视不同。
// 内部坐标以半展长为 1：头在 +x，尾在 -x，双翼沿 ±y 展开。

// 飞鸟造型规范（《纹样设计规范》第二节）：
//   翼展 : 体长 ≈ 2.8 : 1；翼根弦 = 0.26 倍翼展；外侧初级飞羽分开成 3-4 根"指"；
//   尾羽 0.12-0.18 倍翼展；二面角越大，俯视投影里的翼展越短（举翅 = 变短）。
// 七个形态共用同一套比例与描边，只有姿态参数不同 —— 所以它们看起来是"同一只鸟的七个姿势"。
// A 展翼 | B 滑翔 | C 上升 | D 侧向 | E 转向 | F 远景 | G 独立羽片
var POSES = {
    A: { span: 1.00, dihedral: 0.10, sweep: 0.10, primaries: 4, tail: 0.16, pitch: 0.00 },
    B: { span: 0.94, dihedral: 0.24, sweep: 0.20, primaries: 4, tail: 0.15, pitch: 0.03 },
    C: { span: 0.86, dihedral: 0.42, sweep: 0.14, primaries: 3, tail: 0.18, pitch: -0.12 },
    D: { span: 0.90, dihedral: 0.16, sweep: 0.30, primaries: 4, tail: 0.15, pitch: 0.00 },
    E: { span: 0.82, dihedral: 0.30, sweep: 0.38, primaries: 3, tail: 0.14, pitch: 0.06, asym: 0.26 },
    F: { span: 0.64, dihedral: 0.20, sweep: 0.18, primaries: 0, tail: 0.12, far: true },
    G: { span: 0.46, dihedral: 0.06, sweep: 0.00, primaries: 5, tail: 0.00, single: true }
};

function qp(p0, c, p1, t) {
    var u = 1 - t;
    return { x: u * u * p0.x + 2 * u * t * c.x + t * t * p1.x,
             y: u * u * p0.y + 2 * u * t * c.y + t * t * p1.y };
}

function cp(p0, c1, c2, p1, t) {
    var u = 1 - t, uu = u * u, tt = t * t;
    return { x: uu * u * p0.x + 3 * uu * t * c1.x + 3 * u * tt * c2.x + tt * t * p1.x,
             y: uu * u * p0.y + 3 * uu * t * c1.y + 3 * u * tt * c2.y + tt * t * p1.y };
}

// 采样点接路径：sub=false 从首点起笔（开一条新子路径），sub=true 从当前点续画
function trace(ctx, pts, sub) {
    if (!pts || !pts.length)
        return;
    if (sub)
        ctx.lineTo(pts[0].x, pts[0].y);
    else
        ctx.moveTo(pts[0].x, pts[0].y);
    for (var i = 1; i < pts.length; i++)
        ctx.lineTo(pts[i].x, pts[i].y);
}

// 一片羽毛（形态 G，也是羽翼组件的基本件）：羽轴 + 两侧羽片，根部窄、0.42 处最宽、尖端收成一点。
// 羽片之间靠留空隙区分，不做整块填实。
function feather(ctx, x, y, len, wid, ang, r, opt) {
    opt = opt || {};
    var a = (opt.alpha === undefined ? 0.5 : opt.alpha);
    var line = opt.line || C.silver;
    var w = lw(opt.lw || 0.7);
    var curl = (opt.curl === undefined ? 0.16 : opt.curl);
    var fill = opt.fill || C.pearl;
    var fa = clamp((opt.fillAlpha === undefined ? 0.42 : opt.fillAlpha) * a * 1.8, 0, 0.85);
    var side = (opt.side === undefined ? 1 : opt.side);

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(ang || 0);

    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.bezierCurveTo(len * 0.20, -wid * 1.35 * side, len * 0.62, -wid * 1.18 * side, len, wid * curl * 0.35);
    ctx.bezierCurveTo(len * 0.58, wid * 0.62 * side, len * 0.22, wid * 0.52 * side, 0, 0);
    ctx.closePath();
    ctx.fillStyle = fill;
    alpha(ctx, fa);
    ctx.fill();

    ctx.strokeStyle = line;
    ctx.lineWidth = w;
    ctx.lineJoin = "round";
    alpha(ctx, a);
    ctx.stroke();

    // 羽轴
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(len * 0.48, wid * curl * 0.5, len, wid * curl * 0.35);
    ctx.lineWidth = lw(w * 0.8);
    alpha(ctx, a * 0.72);
    ctx.stroke();

    // 羽枝：3 道短斜线，越靠尖越短
    ctx.lineWidth = lw(w * 0.62);
    alpha(ctx, a * 0.42);
    for (var i = 1; i <= 3; i++) {
        var f = i / 4.2;
        ctx.beginPath();
        ctx.moveTo(len * f, wid * curl * 0.45 * f);
        ctx.lineTo(len * f - len * 0.06, -wid * (1.05 - 0.5 * f) * side);
        ctx.stroke();
    }
    ctx.restore();
}

// 羽片扇：从圆心按 a0→a1 排 count 根羽片，靠内短、靠外长，相邻留空隙（不填实）。
// 参数 t（0..1）控制"逐根显现"：这是纹样系统里所有羽翼类构图的显现方式。
function featherFan(ctx, cx, cy, rad, a0, a1, count, r, opt) {
    opt = opt || {};
    var n = Math.max(1, count);
    var t = clamp(opt.t === undefined ? 1 : opt.t, 0, 1);
    var shown = Math.max(1, Math.round(n * t));
    var len0 = (opt.len0 === undefined ? 0.44 : opt.len0);
    for (var i = 0; i < shown; i++) {
        var f = n === 1 ? 1 : i / (n - 1);
        var a = lerp(a0, a1, f);
        var len = rad * lerp(len0, 1, f) * (1 + wob(r, 0.04));
        var wid = len * (opt.widRatio === undefined ? 0.082 : opt.widRatio);
        feather(ctx, cx, cy, len, wid, a, r, {
            alpha: (opt.lineAlpha === undefined ? 0.44 : opt.lineAlpha) * t,
            fillAlpha: (opt.fillAlpha === undefined ? 0.30 : opt.fillAlpha) * t,
            line: opt.line || C.silver,
            fill: opt.fill || C.pearl,
            curl: (opt.curl === undefined ? 0.14 : opt.curl),
            side: (opt.side === undefined ? 1 : opt.side)
        });
    }
}

// 一只鸟（俯视）。s = 翼展（像素，整只鸟的横向尺寸）；poseKey = A..G；ang = 朝向（0 = 朝右）。
// opt: { line, alpha/lineAlpha, lw, flap(-1..1 振翅), spanScale, fill, cut(默认 true), far,
//        massAlpha/massColor（挖空后填的那层柔光体，缺省近景 0.30 / 远景 0.16），
//        bloomAlpha/bloomColor/bloomW（轮廓外的宽柔光边，缺省近景 0.15 / 远景 0.07，宽 5.5×线宽） }
//
// 材质做法（对应规范第八节）：先按轮廓做一次 destination-out，把这只鸟背后的辅助线挖掉，
// 鸟因此是"留白"而不是压在网格上的墨块；再用 0.5-0.6 透明度的细线勾轮廓，
// 身体与翼面不填墨。远景（F）只留轮廓与尾羽，不画羽片分隔线。
function bird(ctx, cx, cy, s, poseKey, ang, r, opt) {
    var p = POSES[poseKey] || POSES.A;
    opt = opt || {};
    if (s <= 1.5)
        return;
    if (p.single) {
        feather(ctx, cx, cy, s * 1.5, s * 0.15, (ang || 0) - Math.PI * 0.5, r, opt);
        return;
    }

    var far = !!p.far || !!opt.far;
    // 轮廓默认用海军蓝而不是纯墨：参考图里的线是"蓝灰细线"，用 ink 会把鸟压成剪影贴纸
    var line = opt.line || (far ? C.iceDeep : C.navy);
    var a = clamp(opt.lineAlpha === undefined
                  ? (opt.alpha === undefined ? (far ? 0.28 : 0.46) : opt.alpha)
                  : opt.lineAlpha, 0, 1);
    var w = lw(opt.lw || (far ? 0.6 : 0.9));
    // 柔光体与 bloom 的默认值：近景鸟是一块亮片（fill 0.30 + 宽边 0.16），远景只留极淡的光晕
    var massA = (opt.massAlpha === undefined) ? (far ? 0.16 : 0.30) : opt.massAlpha;
    var bloomA = (opt.bloomAlpha === undefined) ? (far ? 0.07 : 0.15) : opt.bloomAlpha;
    var flap = clamp(opt.flap || 0, -1, 1);
    var lift = clamp(p.dihedral + flap * 0.16, 0, 0.62);
    var half = s * 0.5 * (opt.spanScale || 1) * (1 - lift * 0.34);   // 举翅 → 投影翼展变短
    var bl = s * 0.36;              // 体长
    var bw = s * 0.052;             // 体半宽
    var sw = s * p.sweep;           // 后掠
    var tl = s * p.tail;            // 尾羽长
    var asym = p.asym || 0;         // 转向：两侧翼展不等
    // 廉价档：远景鸟与很小的鸟不画"柔光体 + bloom"（这两道是全路径的大面积填充/宽描边，
    // 一只鸟一半以上的开销在它们身上，而小尺寸下根本看不出差别），曲线采样也从 18 降到 10。
    // 用户要"浩浩荡荡"就得几十上百只鸟，这一档是把密度做出来又不掉帧的关键。
    var cheap = far || s <= 30 || !!opt.cheap;
    if (cheap) {
        massA = 0;
        bloomA = 0;
    }
    // bloom 是全路径的宽描边，单价最高；只有近景大鸟才吃得到（那里的"柔光边"才看得出来），
    // 中小尺寸的鸟省掉它 —— 这也是把鸟群做密以后还能保持帧时间的关键之一。
    if (s < 56 && !opt.forceBloom)
        bloomA = 0;
    var N = cheap ? 10 : 18;
    var i, k;

    // 身体：胸尖 → 背线 → 尾基 → 腹线 的透镜形
    var breast = { x: bl * 0.54, y: 0 };
    var tailBase = { x: -bl * 0.46, y: 0 };
    var body = [];
    for (i = 0; i <= N; i++)
        body.push(cp(breast, { x: bl * 0.26, y: -bw * 1.25 }, { x: -bl * 0.14, y: -bw * 1.10 },
                     { x: tailBase.x, y: -bw * 0.34 }, i / N));
    for (i = 1; i <= N; i++)
        body.push(cp({ x: tailBase.x, y: -bw * 0.34 }, { x: -bl * 0.16, y: bw * 1.02 },
                     { x: bl * 0.22, y: bw * 1.30 }, breast, i / N));

    // 头 + 喙
    var head = { x: bl * 0.60, y: -bw * 0.70 };
    var hr = bw * 0.78;
    var beak = [{ x: head.x + hr * 0.55, y: head.y - hr * 0.30 },
                { x: head.x + hr * 2.30, y: head.y + hr * 0.05 },
                { x: head.x + hr * 0.55, y: head.y + hr * 0.42 }];

    // 尾羽：三根，展开 ±15°
    var tail = [{ x: tailBase.x + bw * 0.20, y: -bw * 0.34 }];
    for (k = -1; k <= 1; k++) {
        var ta = Math.PI + k * 0.26;
        tail.push({ x: tailBase.x + Math.cos(ta) * tl, y: Math.sin(ta) * tl * (k === 0 ? 1 : 0.92) });
    }
    tail.push({ x: tailBase.x + bw * 0.20, y: bw * 0.34 });

    // 双翼：前缘向前微鼓、后缘后掠并在靠外的位置切出初级飞羽的"指"
    var wings = [];
    for (var side = -1; side <= 1; side += 2) {
        var sh = half * (side < 0 ? 1 : (1 - asym));
        var rootF = { x: bl * 0.18, y: side * bw * 0.55 };
        var rootB = { x: -bl * 0.12, y: side * bw * 1.05 };
        var tip = { x: -sw, y: side * sh };
        var lead = [];
        var trail = [];
        for (i = 0; i <= N; i++)
            lead.push(qp(rootF, { x: bl * 0.16, y: side * sh * 0.56 }, tip, i / N));
        for (i = 0; i <= N; i++)
            trail.push(cp(tip, { x: -sw - bl * 0.30, y: side * sh * 0.74 },
                          { x: -bl * 0.26, y: side * bw * 1.60 }, rootB, i / N));
        if (p.primaries > 0 && !far) {
            for (k = 0; k < p.primaries; k++) {
                var idx = Math.round(N * (0.16 + 0.60 * (k / Math.max(1, p.primaries - 1))));
                if (idx < 1 || idx >= trail.length - 1)
                    continue;
                trail[idx] = { x: trail[idx].x - bl * 0.03, y: trail[idx].y - side * sh * (0.10 + 0.05 * k) };
            }
        }
        wings.push({ lead: lead, trail: trail });
    }

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate((ang || 0) + (p.pitch || 0) - flap * 0.05);

    // ① 挖空：鸟 = 版面上的留白
    if (opt.cut === undefined || opt.cut) {
        ctx.save();
        ctx.globalCompositeOperation = "destination-out";
        ctx.globalAlpha = 0.94;
        ctx.beginPath();
        trace(ctx, body, false);
        ctx.closePath();
        trace(ctx, tail, false);
        ctx.closePath();
        for (k = 0; k < wings.length; k++) {
            ctx.moveTo(wings[k].lead[0].x, wings[k].lead[0].y);
            for (i = 1; i < wings[k].lead.length; i++)
                ctx.lineTo(wings[k].lead[i].x, wings[k].lead[i].y);
            for (i = wings[k].trail.length - 1; i >= 0; i--)
                ctx.lineTo(wings[k].trail[i].x, wings[k].trail[i].y);
            ctx.closePath();
        }
        ctx.fill();
        ctx.restore();
    }

    // ② 实心柔光（参考图里的大鸟是"亮块"而不是"线框"）：挖空之后填一层半透明冷白，
    //    鸟于是变成画面上的一块柔光体，线条只是它的边。
    if (massA > 0) {
        ctx.save();
        ctx.fillStyle = opt.massColor || C.ivory;
        ctx.beginPath();
        trace(ctx, body, false);
        ctx.closePath();
        trace(ctx, tail, false);
        ctx.closePath();
        for (k = 0; k < wings.length; k++) {
            ctx.moveTo(wings[k].lead[0].x, wings[k].lead[0].y);
            for (i = 1; i < wings[k].lead.length; i++)
                ctx.lineTo(wings[k].lead[i].x, wings[k].lead[i].y);
            for (i = wings[k].trail.length - 1; i >= 0; i--)
                ctx.lineTo(wings[k].trail[i].x, wings[k].trail[i].y);
            ctx.closePath();
        }
        alpha(ctx, massA);
        ctx.fill();
        ctx.restore();
    }

    // ③ bloom：亮形周围先压一道很宽很淡的同色描边，再画细线 —— 这就是"柔光边"，
    //    不用 shadowBlur（那个又慢又糊），纯粹靠两道粗细不同的线叠出来。
    if (bloomA > 0) {
        ctx.save();
        ctx.strokeStyle = opt.bloomColor || C.pearl;
        ctx.lineWidth = w * (opt.bloomW || 5.5);
        ctx.lineJoin = "round";
        alpha(ctx, bloomA);
        ctx.beginPath();
        trace(ctx, body, false);
        ctx.closePath();
        trace(ctx, tail, false);
        ctx.closePath();
        for (k = 0; k < wings.length; k++) {
            ctx.beginPath();
            trace(ctx, wings[k].lead, false);
            for (i = 1; i < wings[k].trail.length; i++)
                ctx.lineTo(wings[k].trail[i].x, wings[k].trail[i].y);
            ctx.closePath();
            ctx.stroke();
        }
        ctx.stroke();
        ctx.restore();
    }

    // ④ 轮廓
    ctx.strokeStyle = line;
    ctx.lineWidth = w;
    ctx.lineJoin = "round";
    alpha(ctx, a);
    ctx.beginPath();
    trace(ctx, body, false);
    ctx.closePath();
    ctx.stroke();
    ctx.beginPath();
    trace(ctx, tail, false);
    ctx.closePath();
    ctx.stroke();
    for (k = 0; k < wings.length; k++) {
        ctx.beginPath();
        trace(ctx, wings[k].lead, false);
        for (i = 1; i < wings[k].trail.length; i++)
            ctx.lineTo(wings[k].trail[i].x, wings[k].trail[i].y);
        ctx.closePath();
        ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(head.x, head.y, hr, 0, TAU);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(beak[0].x, beak[0].y);
    ctx.lineTo(beak[1].x, beak[1].y);
    ctx.lineTo(beak[2].x, beak[2].y);
    ctx.stroke();

    // ③ 羽片分隔线：翼面内 3-4 道，越靠外越短（远景省略）
    if (!far && p.primaries > 0) {
        alpha(ctx, a * 0.62);
        ctx.lineWidth = lw(w * 0.72);
        for (k = 0; k < wings.length; k++) {
            for (i = 0; i < p.primaries; i++) {
                var f2 = 0.34 + 0.58 * (i / Math.max(1, p.primaries - 1));
                var pi = Math.round(f2 * N);
                var qi = Math.round(clamp(f2 - 0.20, 0.05, 1) * N);
                ctx.beginPath();
                ctx.moveTo(wings[k].lead[pi].x, wings[k].lead[pi].y);
                ctx.lineTo(wings[k].trail[qi].x, wings[k].trail[qi].y);
                ctx.stroke();
            }
        }
    }
    // ③.5 翼面平行细纹（参考图里那种"羽面刻线"）：沿翼面 4 道，从后缘往前缘画，
    //      只在 hatch 打开时画 —— 深底大鸟才看得出来，小尺寸只是噪点。
    if (opt.hatch) {
        alpha(ctx, a * 0.38);
        ctx.lineWidth = lw(w * 0.55);
        for (k = 0; k < wings.length; k++) {
            for (var hh = 1; hh <= 4; hh++) {
                var fh = 0.22 + 0.19 * hh;
                var hi = Math.round(fh * N);
                ctx.beginPath();
                ctx.moveTo(wings[k].lead[hi].x, wings[k].lead[hi].y);
                ctx.lineTo(wings[k].trail[hi].x, wings[k].trail[hi].y);
                ctx.stroke();
            }
        }
    }
    ctx.restore();
}

function cls(k) {
    return clamp(0.7 + k * 0.5, 0.55, 1.6);
}

// 鸟群。spec = { path, count, cx, cy, rad, a0, a1, size, sizeJitter, alpha, phase, seed, poses }
// 鸟群。沿有意图的路径铺开：arc 环形 / line 对角（bow 是弓形弧度）/ radial 放射 / converge 向焦点汇聚。
// （注释里若还看到 "scatter"：实现里它与 "arc" 同分支，不是第五种算法。）
// 规范（对应《纹样设计规范》第二节第 2 条）：
//   · 靠 depth 决定姿态、大小与透明度：越远越小越淡，超过 0.76 自动换成远景形态 F；
//   · 同一群里不允许"同姿态 + 同缩放 + 同角度"的机械复制（姿态按下标轮换、大小与朝向带抖动）；
//   · 鸟与鸟之间强制留间距（叠住了就沿路径方向推开重试，最多 6 次），失败就跳过这一只；
//   · 路径只是引导线，永远画在鸟下面。
// 鸟群编队入口。
//
// 用户口径（原话）："鸟多一点，繁杂一点，不要只有一列，要浩浩荡荡的，那种鸟群"。
// 所以这里支持**多股**（streams）：一条主路径上横向错开若干股，每股自己一条弧/一条斜线，
// 外侧的股更小更淡（深度），每股内部还有上下浮动，合起来才是一片"有厚度的鸟潮"，
// 而不是一列排开的糖葫芦。仍然是**有意图的路径**（弧线 / 斜线 / 汇聚），不是随机撒点。
//
// spec 常用字段：
//   path: "arc" | "line" | "radial" | "converge" | "scatter"
//   streams 股数（默认 1）· count 单股鸟数 · lateral 股与股的横向间距
//   size / sizeMin 单只尺寸与最小比例 · alpha 透明度 · depthFall 外侧股变小的程度
//   minGap 防重叠系数（默认 0.38，远景层可以给更小值让它叠起来当"雾"）
// 返回真正画出来的鸟数（防重叠失败的不算）。
// birdless：鸟型由外部描摹鸟群提供时，schematic 鸟一律不画（模板结构照旧）
var BIRDLESS = false;

function flock(ctx, spec) {
    if (BIRDLESS)
        return;
    var s = spec || {};
    var streams = Math.max(1, Math.round(s.streams || 1));
    var placed = [];
    var r = rng(s.seed === undefined ? 7 : s.seed);

    if (streams === 1) {
        flockBand(ctx, s, r, placed);
        return placed.length;
    }

    var total = Math.max(streams, Math.round(s.count || 12));
    for (var k = 0; k < streams; k++) {
        var f = k / (streams - 1);                       // 0..1 股序
        var off = (f - 0.5) * 2;                         // -1..1（两侧对称）
        var band = {};
        for (var key in s)
            band[key] = s[key];
        band.streams = 1;
        // 中间股密、外侧股疏：鸟群不是均匀铺开的色块
        band.count = Math.max(2, Math.round(total * (0.66 + 0.34 * Math.sin(Math.PI * (0.30 + 0.70 * f)))));
        // 外侧股更远：更小、更淡
        var depthK = 1 - Math.abs(off) * (s.depthFall === undefined ? 0.42 : s.depthFall);
        band.size = (s.size || 26) * depthK;
        band.alpha = (s.alpha === undefined ? 0.56 : s.alpha) * (0.52 + 0.48 * depthK);
        band.seed = (s.seed === undefined ? 7 : s.seed) + k * 97;
        band.poseShift = (s.poseShift || 0) + k * 2;

        if (s.path === "line") {
            // 沿路径法向错开（垂直方向才是"股"）
            var dx = s.x1 - s.x0;
            var dy = s.y1 - s.y0;
            var len = Math.max(1, Math.sqrt(dx * dx + dy * dy));
            var nx = -dy / len;
            var ny = dx / len;
            var shift = off * (s.lateral === undefined ? (s.size || 26) * 2.0 : s.lateral);
            band.x0 = s.x0 + nx * shift;
            band.y0 = s.y0 + ny * shift;
            band.x1 = s.x1 + nx * shift;
            band.y1 = s.y1 + ny * shift;
            band.bow = (s.bow || 0) * (1 + off * 0.34);
        } else {
            // 弧形：半径与起止角都错开
            band.rad = (s.rad || 200) * (1 + off * (s.radFan === undefined ? 0.11 : s.radFan));
            band.a0 = (s.a0 === undefined ? Math.PI * 1.05 : s.a0) + off * (s.aFan === undefined ? 0.12 : s.aFan);
            band.a1 = (s.a1 === undefined ? Math.PI * 1.95 : s.a1) + off * (s.aFan === undefined ? 0.12 : s.aFan);
        }
        flockBand(ctx, band, r, placed);
    }
    return placed.length;
}

// 单股：沿一条路径按顺序编排鸟的位置、姿态、大小与透明，并做防重叠。
// r（随机源）与 placed（已放置表）由 flock 传进来，所以多股之间也互不重叠。
function flockBand(ctx, s, r, placed) {
    var count = Math.max(1, s.count || 12);
    var poses = s.poses || ["A", "B", "C", "D", "E"];
    var size = s.size || 26;
    var phase = s.phase || 0;
    var cx = s.cx || 0;
    var cy = s.cy || 0;
    var rad = s.rad || 200;
    var a0 = (s.a0 === undefined ? Math.PI * 1.05 : s.a0);
    var a1 = (s.a1 === undefined ? Math.PI * 1.95 : s.a1);
    var gap = s.minGap === undefined ? 0.38 : s.minGap;
    var drawn = 0;

    for (var i = 0; i < count; i++) {
        var t = count === 1 ? 0 : i / (count - 1);
        var x, y, ang, heading, depth;

        if (s.path === "line") {
            x = lerp(s.x0, s.x1, t);
            y = lerp(s.y0, s.y1, t) + Math.sin(t * Math.PI) * (s.bow || 0);
            heading = Math.atan2((s.y1 - s.y0), (s.x1 - s.x0));
            depth = t;
        } else if (s.path === "radial") {
            ang = lerp(a0, a1, t) + wob(r, 0.02);
            var rr = rad * lerp(0.45, 1.0, t);
            x = cx + Math.cos(ang) * rr;
            y = cy + Math.sin(ang) * rr;
            heading = ang + Math.PI / 2;
            depth = 1 - t;
        } else if (s.path === "converge") {
            ang = lerp(a0, a1, t);
            var rr2 = rad * (1 - t * 0.72);
            x = cx + Math.cos(ang) * rr2;
            y = cy + Math.sin(ang) * rr2;
            heading = ang + Math.PI;
            depth = t;
        } else {
            ang = lerp(a0, a1, t) + phase * 0.35;
            var rr3 = rad * (1 + wob(r, 0.035));
            x = cx + Math.cos(ang) * rr3;
            y = cy + Math.sin(ang) * rr3 * (s.squash === undefined ? 0.72 : s.squash);
            heading = ang + Math.PI / 2 + Math.PI * 0.18;
            depth = 0.5 + 0.5 * Math.sin(t * Math.PI * 1.3);
        }

        // 单股之内的上下浮动：让每股本身也是一条"有厚度的带"，不是一根线
        if (s.wander) {
            x += wob(r, s.wander);
            y += wob(r, s.wander);
        }

        // 留在画面里：超出画布的鸟只会被裁掉，却照样吃一次重绘。
        // 用"镜像折回"而不是硬夹 —— 硬夹会在边框上排出一道鸟墙，折回仍是一团乱中有序的鸟潮。
        // overhang 允许少量溢出（对应规范里"大剪影被画框裁切"的读法），默认 5%。
        if (s.w && s.h) {
            var ov = s.overhang === undefined ? 0.05 : s.overhang;
            var lx = -s.w * ov;
            var rx = s.w * (1 + ov);
            var ty = -s.h * ov;
            var by = s.h * (1 + ov);
            if (x < lx)
                x = lx + (lx - x) * 0.7;
            else if (x > rx)
                x = rx - (x - rx) * 0.7;
            if (y < ty)
                y = ty + (ty - y) * 0.7;
            else if (y > by)
                y = by - (y - by) * 0.7;
        }

        var scale = size * lerp(s.sizeMin === undefined ? 0.62 : s.sizeMin, 1, 1 - depth) * (1 + wob(r, 0.09));
        var pose = (depth > 0.76 && s.farPose !== false) ? "F" : poses[(i + (s.poseShift || 0)) % poses.length];
        var a = (s.alpha === undefined ? 0.56 : s.alpha) * lerp(0.36, 1, depth);
        var flap = (s.flap === undefined ? 0 : s.flap) * Math.sin(phase * TAU + i * 0.7);

        var ok = false;
        for (var tries = 0; tries < 6 && !ok; tries++) {
            ok = true;
            for (var j = 0; j < placed.length; j++) {
                var ddx = placed[j].x - x;
                var ddy = placed[j].y - y;
                if (Math.sqrt(ddx * ddx + ddy * ddy) < (placed[j].s + scale) * gap) {
                    ok = false;
                    break;
                }
            }
            if (!ok) {
                x += wob(r, scale * 1.2);
                y += wob(r, scale * 1.2);
            }
        }
        if (!ok)
            continue;
        placed.push({ x: x, y: y, s: scale });
        drawn++;

        bird(ctx, x, y, scale, pose, heading + wob(r, 0.05), r, {
                 line: s.line || (depth > 0.55 ? C.navy : C.iceDeep),
                 lineAlpha: a * (s.lineAlpha === undefined ? 1 : s.lineAlpha),
                 fill: s.fill || C.paper,
                 cut: s.cut === undefined ? true : s.cut,
                 spanScale: 1 + flap * 0.10,
                 flap: flap
             });
    }
    return drawn;
}

// ══ 子系统二：光环与圣徽 ══════════════════════════════════════════════
//
// 统一口径：半径比例、刻度间距、分段数、描边宽度与透明度都由 `kind` 决定，
// 同一页里出现的所有圣徽共用这一套；微型圣徽靠 haloCore 减细节，缩到 8px 仍认得出中心。
// kind：0 单环 / 1 多层同心 / 2 局部中断 / 3 带刻度 / 4 带径向标记 / 5 与多边形结合 /
//       6 放射光环 / 7 异常断裂（只在异常状态用，不允许整页圣徽都做成破碎效果）。
function halo(ctx, cx, cy, r, kind, rnd, opt) {
    var o = opt || {};
    var t = o.t === undefined ? 1 : clamp(o.t, 0, 1);
    var line = o.line || C.cobalt;
    var base = lw(r * 0.0055 + 0.7);
    ctx.save();

    function ring(rad, a, wid, a0, a1) {
        ctx.strokeStyle = line;
        ctx.lineWidth = lw(wid);
        alpha(ctx, a);
        strokeArc(ctx, cx, cy, rad, a0 === undefined ? 0 : a0, a1 === undefined ? TAU : a1, rnd, rad * 0.004);
    }

    ring(r, 0.62, base, 0, TAU * t);

    if (kind === 1) {
        ring(r * 0.86, 0.34, 0.8, 0, TAU);
        ring(r * 0.72, 0.22, 0.7, 0, TAU);
    } else if (kind === 2) {
        var seg = 6;
        for (var i = 0; i < seg; i++) {
            var a0 = (i / seg) * TAU + 0.06;
            ring(r * 0.88, 0.34, 0.9, a0, a0 + TAU / seg - 0.42);
        }
    } else if (kind === 3) {
        tickRing(ctx, cx, cy, r * 0.97, 48, r * 0.055, rnd, line, 0.22 * t);
        ring(r * 0.86, 0.30, 0.8);
    } else if (kind === 4) {
        var marks = 12;
        for (var m = 0; m < marks; m++) {
            var am = (m / marks) * TAU;
            var p0 = pol(cx, cy, r * 0.90, am);
            var p1 = pol(cx, cy, r * 1.06, am);
            ctx.strokeStyle = line;
            ctx.lineWidth = lw(0.75);
            alpha(ctx, 0.26 * t);
            ctx.beginPath();
            ctx.moveTo(p0.x, p0.y);
            ctx.lineTo(p1.x, p1.y);
            ctx.stroke();
            var pd = pol(cx, cy, r * 1.14, am);
            dot(ctx, pd.x, pd.y, Math.max(1.1, r * 0.012), line, 0.3 * t);
        }
        ring(r * 0.80, 0.24, 0.7);
    } else if (kind === 5) {
        var sides = o.sides || 6;
        ctx.strokeStyle = line;
        ctx.lineWidth = lw(0.85);
        alpha(ctx, 0.30 * t);
        for (var k = 0; k < 2; k++) {
            ctx.beginPath();
            for (var v = 0; v <= sides; v++) {
                var av = (v / sides) * TAU - Math.PI / 2 + (k === 0 ? 0 : Math.PI / sides);
                var pv = pol(cx, cy, r * (k === 0 ? 0.66 : 0.52), av);
                if (v === 0)
                    ctx.moveTo(pv.x, pv.y);
                else
                    ctx.lineTo(pv.x, pv.y);
            }
            ctx.stroke();
        }
    } else if (kind === 6) {
        var rays = o.rays || 32;
        for (var y = 0; y < rays; y++) {
            var ay = (y / rays) * TAU + 0.01;
            var q0 = pol(cx, cy, r * 1.10, ay);
            var q1 = pol(cx, cy, r * (y % 2 === 0 ? 1.34 : 1.22), ay);
            ctx.strokeStyle = line;
            ctx.lineWidth = lw(0.7);
            alpha(ctx, 0.20 * t);
            ctx.beginPath();
            ctx.moveTo(q0.x, q0.y);
            ctx.lineTo(q1.x, q1.y);
            ctx.stroke();
        }
        ring(r * 0.84, 0.26, 0.7);
    } else if (kind === 7) {
        // 异常态：偏心 + 断裂 + 一小段分离的弧 —— 只在"异常/破坏"语义下使用
        ring(r * 0.94, 0.40, base, Math.PI * 0.15, Math.PI * 1.05);
        ring(r * 1.10, 0.22, 0.7, Math.PI * 1.25, Math.PI * 1.72);
        ctx.strokeStyle = C.gold;
        ctx.lineWidth = lw(0.8);
        alpha(ctx, 0.28 * t);
        strokeArc(ctx, cx + r * 0.10, cy - r * 0.06, r * 0.62, Math.PI * 0.9, Math.PI * 1.6, rnd, r * 0.006);
    }
    ctx.restore();
}

// 圣徽的内心：十字轴 + 小圆（保持"清晰的中心"，缩小时仍可识别）
function haloCore(ctx, cx, cy, r, rnd, opt) {
    var o = opt || {};
    var line = o.line || C.cobalt;
    var t = o.t === undefined ? 1 : clamp(o.t, 0, 1);
    ctx.save();
    ctx.strokeStyle = line;
    ctx.lineWidth = lw(0.9);
    alpha(ctx, 0.5 * t);
    ctx.beginPath();
    ctx.moveTo(cx - r * 0.30, cy);
    ctx.lineTo(cx + r * 0.30, cy);
    ctx.moveTo(cx, cy - r * 0.42);
    ctx.lineTo(cx, cy + r * 0.42);
    ctx.stroke();
    ctx.lineWidth = lw(0.7);
    alpha(ctx, 0.34 * t);
    strokeCircle(ctx, cx, cy, r * 0.16, rnd, r * 0.004);
    ctx.restore();
}

// ══ 子系统三：羽翼与放射纹样 ══════════════════════════════════════════
//
// 双翼对称：以 (cx, cy) 为中轴，dir=+1 右翼 / -1 左翼；羽片由短到长、扇形展开、留空隙。
// 拆解形态：wingBand（装饰边框带）、wingArc（半圆弧线）、radialFeathers（放射羽线）。
// 单侧羽翼：一条平滑的"臂" + 沿臂排列的初级飞羽（由短到长、彼此留空隙）+ 根部覆羽。
// dir = +1 向右展 / -1 向左展（镜像）；span = 翼展（像素）。
// opt: { t, count, a0, a1, len0, line, lineAlpha, fillAlpha, fill }
function wing(ctx, cx, cy, span, dir, rnd, opt) {
    opt = opt || {};
    var t = clamp(opt.t === undefined ? 1 : opt.t, 0, 1);
    var n = Math.max(5, opt.count || 12);
    var line = opt.line || C.silver;
    var lineAlpha = (opt.lineAlpha === undefined ? 0.46 : opt.lineAlpha) * t;
    var fillAlpha = (opt.fillAlpha === undefined ? 0.30 : opt.fillAlpha) * t;

    // 翼臂：肩 → 腕 → 翼尖。真实翅膀不是一根直棍：腕部抬高一点，翼尖再往外挑，
    // 这一段曲率就是"这是翅膀"而不是"这是一排草"的关键。
    function arm(u) {
        var x = cx + dir * span * u;
        var y = cy - span * (0.16 * Math.sin(u * Math.PI * 0.9) + 0.05 * u * u);
        return { x: x, y: y + wob(rnd, 0.4) };
    }

    var pts = [];
    for (var i = 0; i <= 18; i++)
        pts.push(arm(i / 18));
    ctx.save();
    ctx.strokeStyle = line;
    ctx.lineWidth = lw(0.75);
    alpha(ctx, lineAlpha * 0.85);
    ctx.beginPath();
    trace(ctx, pts, false);
    ctx.stroke();
    ctx.restore();

    // ① 覆羽（靠近身体的一段，短、密、几乎竖直向上）
    var cov = Math.max(3, Math.round(n * 0.45));
    for (var c = 0; c < cov; c++) {
        var fc = c / Math.max(1, cov - 1);
        var pc = arm(lerp(0.06, 0.52, fc));
        var lenC = span * lerp(0.10, 0.22, fc) * (1 + wob(rnd, 0.05));
        feather(ctx, pc.x, pc.y, lenC, lenC * 0.19, -Math.PI * 0.5 + dir * lerp(-0.20, -0.06, fc), rnd, {
            alpha: lineAlpha * (0.55 + 0.20 * fc),
            fillAlpha: fillAlpha * 0.85,
            line: line,
            fill: opt.fill || C.pearl,
            curl: 0.10,
            side: dir
        });
    }

    // ② 初级飞羽（外半段，由短到长、越靠翼尖越向后掠，片与片之间留空隙）
    for (var k = 0; k < n; k++) {
        var f = k / Math.max(1, n - 1);
        var p = arm(lerp(0.38, 1.0, f));
        var len = span * lerp(opt.len0 === undefined ? 0.30 : opt.len0, 0.62, f) * (1 + wob(rnd, 0.04));
        // 角度从"向上"逐渐转到"向外后方"：这是翼尖后掠的读法
        var ang = -Math.PI * 0.5 + dir * lerp(-0.02, 0.62, f * f);
        feather(ctx, p.x, p.y, len, len * 0.105, ang, rnd, {
            alpha: lineAlpha * (0.62 + 0.38 * f),
            fillAlpha: fillAlpha,
            line: line,
            fill: opt.fill || C.pearl,
            curl: 0.14,
            side: dir
        });
    }

    // ③ 翼尖的一小段前缘高光：让最外端有"收口"
    ctx.save();
    ctx.strokeStyle = opt.tipColor || C.ivory;
    ctx.lineWidth = lw(1.2);
    alpha(ctx, lineAlpha * 0.5);
    ctx.beginPath();
    var tipP = arm(0.94);
    ctx.moveTo(tipP.x, tipP.y);
    ctx.lineTo(tipP.x + dir * span * 0.06, tipP.y - span * 0.05);
    ctx.stroke();
    ctx.restore();
}
function wingBand(ctx, x, y, w, h, rnd, opt) {
    var o = opt || {};
    var t = o.t === undefined ? 1 : clamp(o.t, 0, 1);
    var n = Math.max(2, Math.round((o.count || 9) * t));
    for (var i = 0; i < n; i++) {
        var k = i / Math.max(1, n - 1);
        var len = h * (0.55 + 0.45 * Math.sin(k * Math.PI));
        feather(ctx, x + (i + 0.5) * (w / n), y, len, len * 0.16, -Math.PI / 2 + wob(rnd, 0.03), rnd, {
                    fill: o.fill || C.pearl, fillAlpha: o.fillAlpha === undefined ? 0.30 : o.fillAlpha,
                    line: o.line || C.silver, lineAlpha: o.lineAlpha === undefined ? 0.45 : o.lineAlpha, lw: 0.7
                });
    }
}

// 放射羽线：细、疏、等分角
function radialFeathers(ctx, cx, cy, r0, r1, count, rnd, opt) {
    var o = opt || {};
    var t = o.t === undefined ? 1 : clamp(o.t, 0, 1);
    ctx.save();
    ctx.strokeStyle = o.line || C.iceDeep;
    ctx.lineWidth = lw(0.62);
    for (var i = 0; i < count; i++) {
        var ang = (i / count) * TAU + 0.008;
        var l = lerp(r0, r1, (i % 2 === 0) ? 0.82 : 1.0);
        if ((i / count) > t)
            continue;
        var p0 = pol(cx, cy, r0, ang);
        var p1 = pol(cx, cy, l, ang);
        alpha(ctx, 0.16 + 0.10 * (i % 3 === 0 ? 1 : 0));
        ctx.beginPath();
        ctx.moveTo(p0.x, p0.y);
        ctx.lineTo(p1.x, p1.y);
        ctx.stroke();
    }
    ctx.restore();
}

// 半圆弧线（wingArc）：把一只翼拆成"沿半圆排列的羽片带"，用于边框、转场与拱肩填充。
// 与 wing() 的区别：wing 有臂与初级飞羽的解剖结构；wingArc 只保留"由短到长的羽片沿圆弧
// 依次展开"这一条几何规律，所以它可以直接当装饰线用，不依赖鸟的身体。
// opt: { t, count, len0, len1, wid, line, tick（是否带羽枝）, mirror }
function wingArc(ctx, cx, cy, rad, a0, a1, rnd, opt) {
    var o = opt || {};
    var t = o.t === undefined ? 1 : clamp(o.t, 0, 1);
    var count = o.count || 12;
    var line = o.line || C.iceDeep;
    var len0 = o.len0 === undefined ? 0.16 : o.len0;
    var len1 = o.len1 === undefined ? 0.62 : o.len1;
    var wid = o.wid === undefined ? 0.055 : o.wid;

    ctx.save();
    ctx.strokeStyle = line;
    ctx.lineWidth = lw(0.75);
    ctx.lineCap = "round";

    // 弧线本体：在半圆的外侧留一条极淡的引导弧（羽片挂在它上面）
    alpha(ctx, 0.26);
    strokeArc(ctx, cx, cy, rad, a0, a1, rnd, 0.35);

    for (var i = 0; i < count; i++) {
        var k = count <= 1 ? 0 : i / (count - 1);
        if (k > t)
            continue;
        var ang = lerp(a0, a1, k);
        var side = o.mirror ? -1 : 1;
        var len = rad * lerp(len0, len1, Math.pow(k, 0.85));
        var x = cx + Math.cos(ang) * rad;
        var y = cy + Math.sin(ang) * rad;
        var outward = ang + side * (Math.PI / 2) * 0.0;   // 羽片一律朝弧外
        var tipx = x + Math.cos(outward) * len * 0.94 + Math.cos(ang) * rad * 0.10 * side;
        var tipy = y + Math.sin(outward) * len * 0.94 + Math.sin(ang) * rad * 0.10 * side;
        var w2 = rad * wid * (0.42 + 0.58 * k);

        alpha(ctx, 0.30 + 0.22 * (1 - k));
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.quadraticCurveTo(x + Math.cos(outward + side * 0.55) * len * 0.55 + side * w2,
                             y + Math.sin(outward + side * 0.55) * len * 0.55 - w2 * 0.30,
                             tipx, tipy);
        ctx.quadraticCurveTo(x + Math.cos(outward - side * 0.50) * len * 0.52 - side * w2 * 0.70,
                             y + Math.sin(outward - side * 0.50) * len * 0.52 + w2 * 0.24,
                             x, y);
        ctx.closePath();
        if (o.fill !== false) {
            alpha(ctx, 0.055 + 0.05 * (1 - k));
            ctx.fillStyle = o.fillColor || C.ivory;
            ctx.fill();
        }
        alpha(ctx, 0.34 + 0.22 * (1 - k));
        ctx.stroke();
        if (o.tick) {
            alpha(ctx, 0.20);
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(lerp(x, tipx, 0.55), lerp(y, tipy, 0.55));
            ctx.stroke();
        }
    }
    ctx.restore();
}

// ══ 子系统四：圣堂拱形与玫瑰窗 ════════════════════════════════════════
//
// 真实结构逻辑：尖拱 = 两个圆心落在起拱线上的圆弧交于顶点；嵌套拱层层内缩；
// 玫瑰窗 = 中心轮 + 花瓣（每瓣由两段反向圆弧构成）+ 放射辐条 + 外圈花窗格。
function arch(ctx, cx, baseY, w, h, rnd, opt) {
    var o = opt || {};
    var t = o.t === undefined ? 1 : clamp(o.t, 0, 1);
    var line = o.line || C.iceDeep;
    var rings = o.rings || 1;
    ctx.save();
    for (var k = 0; k < rings; k++) {
        var inset = k * (o.inset === undefined ? Math.min(w, h) * 0.055 : o.inset);
        var ww = w - inset * 2;
        var hh = h - inset;
        var sp = baseY - hh;                     // 起拱线
        var rad = ww * 0.5;
        ctx.strokeStyle = line;
        ctx.lineWidth = lw(k === 0 ? 1.0 : 0.72);
        alpha(ctx, (k === 0 ? 0.42 : 0.24) * t);
        // 两侧柱线
        ctx.beginPath();
        ctx.moveTo(cx - ww / 2, baseY);
        ctx.lineTo(cx - ww / 2, sp);
        ctx.moveTo(cx + ww / 2, baseY);
        ctx.lineTo(cx + ww / 2, sp);
        ctx.stroke();
        // 尖拱：左右各一段圆弧交于顶点
        strokeArc(ctx, cx - ww / 2, sp, rad, 0, -Math.PI * 0.32, rnd, 0.5);
        strokeArc(ctx, cx + ww / 2, sp, rad, Math.PI, Math.PI * 1.32, rnd, 0.5);
        // 拱脚线
        ctx.beginPath();
        ctx.moveTo(cx - ww / 2 - 4, sp);
        ctx.lineTo(cx + ww / 2 + 4, sp);
        ctx.stroke();
    }
    ctx.restore();
}

// 玫瑰窗：petals 个花瓣 + 内轮 + 外圈窗格
function roseWindow(ctx, cx, cy, r, petals, rnd, opt) {
    var o = opt || {};
    var t = o.t === undefined ? 1 : clamp(o.t, 0, 1);
    var line = o.line || C.cobalt;
    var stage = o.stage === undefined ? 3 : o.stage;   // 分层显现：1 轮 2 花瓣 3 外圈
    ctx.save();
    // 外圈 + 内轮
    ctx.strokeStyle = line;
    ctx.lineWidth = lw(1.1);
    alpha(ctx, 0.52 * t);
    strokeCircle(ctx, cx, cy, r, rnd, r * 0.003);
    ctx.lineWidth = lw(0.8);
    alpha(ctx, 0.30 * t);
    strokeCircle(ctx, cx, cy, r * 0.86, rnd, r * 0.003);
    strokeCircle(ctx, cx, cy, r * 0.20, rnd, r * 0.003);

    if (stage >= 2) {
        // 花瓣：每瓣两段反向圆弧 + 中脊
        for (var i = 0; i < petals; i++) {
            var a = (i / petals) * TAU - Math.PI / 2;
            var pr = r * 0.66;
            var pc = pol(cx, cy, r * 0.42, a);
            var tip = pol(cx, cy, r * 0.84, a);
            ctx.strokeStyle = line;
            ctx.lineWidth = lw(0.85);
            alpha(ctx, 0.38 * t);
            ctx.beginPath();
            var pA = pol(pc.x, pc.y, pr * 0.62, a - Math.PI * 0.62);
            var pB = pol(pc.x, pc.y, pr * 0.62, a + Math.PI * 0.62);
            ctx.moveTo(tip.x, tip.y);
            ctx.quadraticCurveTo(pA.x, pA.y, cx + Math.cos(a) * r * 0.30, cy + Math.sin(a) * r * 0.30);
            ctx.quadraticCurveTo(pB.x, pB.y, tip.x, tip.y);
            ctx.stroke();
            ctx.lineWidth = lw(0.6);
            alpha(ctx, 0.22 * t);
            ctx.beginPath();
            ctx.moveTo(cx + Math.cos(a) * r * 0.20, cy + Math.sin(a) * r * 0.20);
            ctx.lineTo(tip.x, tip.y);
            ctx.stroke();
            // 花瓣之间的小尖拱格
            var mid = a + Math.PI / petals;
            var m0 = pol(cx, cy, r * 0.86, mid);
            var m1 = pol(cx, cy, r * 0.98, mid);
            ctx.strokeStyle = o.aux || C.iceDeep;
            ctx.lineWidth = lw(0.6);
            alpha(ctx, 0.20 * t);
            ctx.beginPath();
            ctx.moveTo(m0.x, m0.y);
            ctx.lineTo(m1.x, m1.y);
            ctx.stroke();
        }
    }
    if (stage >= 3) {
        // 外圈窗格：等分弧 + 短径向线
        tickRing(ctx, cx, cy, r * 1.02, petals * 2, r * 0.045, rnd, o.aux || C.iceDeep, 0.20 * t);
    }
    ctx.restore();
}

// 纵向柱线与分割线
function columns(ctx, x0, x1, yTop, yBot, count, rnd, opt) {
    var o = opt || {};
    var t = o.t === undefined ? 1 : clamp(o.t, 0, 1);
    ctx.save();
    ctx.strokeStyle = o.line || C.silverSoft;
    for (var i = 0; i < count; i++) {
        var x = lerp(x0, x1, count === 1 ? 0 : i / (count - 1));
        ctx.lineWidth = lw(i === 0 || i === count - 1 ? 0.85 : 0.6);
        alpha(ctx, (i === 0 || i === count - 1 ? 0.30 : 0.18) * t);
        ctx.beginPath();
        ctx.moveTo(x, yTop);
        ctx.lineTo(x + wob(rnd, 0.8), yBot);
        ctx.stroke();
    }
    ctx.restore();
}

// ══ 子系统五：神圣几何与技术坐标 ══════════════════════════════════════
//
// 技术标记要"轻、细、疏"：只用真实的等分与角度，绝不放假数据/乱码。
function axisNet(ctx, x, y, w, h, rnd, opt) {
    var o = opt || {};
    var t = o.t === undefined ? 1 : clamp(o.t, 0, 1);
    var line = o.line || C.silver;
    var step = o.step || 40;
    ctx.save();
    ctx.strokeStyle = line;
    ctx.lineWidth = lw(0.55);
    alpha(ctx, 0.16 * t);
    for (var gx = 0; gx <= w; gx += step)
        if (gx / Math.max(1, w) <= t) {
            ctx.beginPath();
            ctx.moveTo(x + gx, y);
            ctx.lineTo(x + gx, y + h);
            ctx.stroke();
        }
    for (var gy = 0; gy <= h; gy += step) {
        ctx.beginPath();
        ctx.moveTo(x, y + gy);
        ctx.lineTo(x + w * Math.min(1, t * 1.2), y + gy);
        ctx.stroke();
    }
    // 主坐标轴：稍重 + 端点定位十字
    ctx.lineWidth = lw(0.9);
    alpha(ctx, 0.30 * t);
    ctx.beginPath();
    ctx.moveTo(x, y + h);
    ctx.lineTo(x + w * t, y + h);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x, y + h);
    ctx.lineTo(x, y + h * (1 - t));
    ctx.stroke();
    var ax = x + w * t, ay = y + h;
    ctx.lineWidth = lw(0.7);
    alpha(ctx, 0.34 * t);
    ctx.beginPath();
    ctx.moveTo(ax - 4, ay);
    ctx.lineTo(ax + 4, ay);
    ctx.moveTo(ax, ay - 4);
    ctx.lineTo(ax, ay + 4);
    ctx.stroke();
    ctx.restore();
}

// 角度刻度盘：每 stepDeg 一根刻度，每 90° 长刻度，只在少数位置写真实角度
function angleScale(ctx, cx, cy, rad, stepDeg, rnd, opt) {
    var o = opt || {};
    var t = o.t === undefined ? 1 : clamp(o.t, 0, 1);
    var line = o.line || C.iceDeep;
    var total = Math.round(360 / stepDeg);
    ctx.save();
    ctx.strokeStyle = line;
    for (var i = 0; i <= total * t; i++) {
        var deg = i * stepDeg;
        var ang = (deg / 180) * Math.PI - Math.PI / 2;
        var major = (deg % 90 === 0);
        var len = major ? rad * 0.075 : (deg % 45 === 0 ? rad * 0.05 : rad * 0.03);
        var p0 = pol(cx, cy, rad, ang);
        var p1 = pol(cx, cy, rad + len, ang);
        ctx.lineWidth = lw(major ? 0.85 : 0.6);
        alpha(ctx, (major ? 0.34 : 0.18) * t);
        ctx.beginPath();
        ctx.moveTo(p0.x, p0.y);
        ctx.lineTo(p1.x, p1.y);
        ctx.stroke();
        if (major && o.labels !== false) {
            var pl = pol(cx, cy, rad + len + 9, ang);
            ctx.save();
            ctx.fillStyle = line;
            alpha(ctx, 0.36 * t);
            ctx.font = "9px Consolas, monospace";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(deg + "\u00B0", pl.x, pl.y);
            ctx.restore();
        }
    }
    ctx.restore();
}

// 黄金螺旋：构图辅助工具（对数螺旋，用黄金比控制增长率）
function goldenSpiral(ctx, x, y, s, turns, rnd, opt) {
    var o = opt || {};
    var t = o.t === undefined ? 1 : clamp(o.t, 0, 1);
    ctx.save();
    ctx.strokeStyle = o.line || C.goldSoft;
    ctx.lineWidth = lw(0.62);
    alpha(ctx, 0.22 * t);
    ctx.beginPath();
    var steps = Math.round(120 * turns);
    for (var i = 0; i <= steps * t; i++) {
        var a = (i / 40) * Math.PI;
        var rr = s * Math.pow(PHI + 1, a / (Math.PI / 2)) * 0.06;
        var px = x + Math.cos(a) * rr;
        var py = y + Math.sin(a) * rr;
        if (i === 0)
            ctx.moveTo(px, py);
        else
            ctx.lineTo(px, py);
    }
    ctx.stroke();
    ctx.restore();
}

// 多边形嵌套
function polygonNest(ctx, cx, cy, rad, sides, layers, rnd, opt) {
    var o = opt || {};
    var t = o.t === undefined ? 1 : clamp(o.t, 0, 1);
    ctx.save();
    ctx.strokeStyle = o.line || C.cobalt;
    for (var k = 0; k < layers; k++) {
        var rr = rad * (1 - k * 0.22);
        ctx.lineWidth = lw(k === 0 ? 0.85 : 0.62);
        alpha(ctx, (k === 0 ? 0.30 : 0.18) * t);
        ctx.beginPath();
        for (var v = 0; v <= sides; v++) {
            var ang = (v / sides) * TAU - Math.PI / 2 + k * (Math.PI / sides);
            var p = pol(cx, cy, rr, ang);
            if (v === 0)
                ctx.moveTo(p.x, p.y);
            else
                ctx.lineTo(p.x, p.y);
        }
        ctx.stroke();
    }
    ctx.restore();
}

// 分区编号：真实编号（A1/A2…），用于组织画面而不是凑装饰
function zones(ctx, x, y, w, h, cols, rows, rnd, opt) {
    var o = opt || {};
    var t = o.t === undefined ? 1 : clamp(o.t, 0, 1);
    ctx.save();
    ctx.strokeStyle = o.line || C.silver;
    ctx.lineWidth = lw(0.55);
    alpha(ctx, 0.16 * t);
    for (var c = 1; c < cols; c++) {
        ctx.beginPath();
        ctx.moveTo(x + w * c / cols, y);
        ctx.lineTo(x + w * c / cols, y + h);
        ctx.stroke();
    }
    for (var rw = 1; rw < rows; rw++) {
        ctx.beginPath();
        ctx.moveTo(x, y + h * rw / rows);
        ctx.lineTo(x + w, y + h * rw / rows);
        ctx.stroke();
    }
    ctx.save();
    ctx.fillStyle = o.line || C.silver;
    alpha(ctx, 0.30 * t);
    ctx.font = "8px Consolas, monospace";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    for (var i = 0; i < cols * rows; i++) {
        var cx0 = x + (i % cols) * (w / cols) + 4;
        var cy0 = y + Math.floor(i / cols) * (h / rows) + 4;
        ctx.fillText("A" + (i + 1), cx0, cy0);
    }
    ctx.restore();
    ctx.restore();
}

// ══ 子系统六：铭文、刻印与仪式标记 ════════════════════════════════════
//
// 只用真实字体与真实文本；圆形印记沿圆周排版；宁可少，不留乱码。
function circularText(ctx, cx, cy, rad, text, rnd, opt) {
    var o = opt || {};
    var t = o.t === undefined ? 1 : clamp(o.t, 0, 1);
    ctx.save();
    ctx.fillStyle = o.color || C.cobalt;
    alpha(ctx, (o.alpha === undefined ? 0.42 : o.alpha) * t);
    ctx.font = (o.size || 9) + "px Consolas, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    var chars = text.split("");
    var span = Math.min(TAU * 0.92, chars.length * (o.gap === undefined ? 0.115 : o.gap));
    for (var i = 0; i < chars.length; i++) {
        var a = -Math.PI / 2 + (i / Math.max(1, chars.length - 1) - 0.5) * span;
        if ((i / chars.length) > t)
            break;
        ctx.save();
        ctx.translate(cx + Math.cos(a) * rad, cy + Math.sin(a) * rad);
        ctx.rotate(a + Math.PI / 2);
        ctx.fillText(chars[i], 0, 0);
        ctx.restore();
    }
    ctx.restore();
}

// 印记：外环 + 圆周铭文 + 中心记号
function seal(ctx, cx, cy, rad, text, mark, rnd, opt) {
    var o = opt || {};
    var t = o.t === undefined ? 1 : clamp(o.t, 0, 1);
    ctx.save();
    ctx.strokeStyle = o.color || C.cobalt;
    ctx.lineWidth = lw(0.9);
    alpha(ctx, 0.44 * t);
    strokeCircle(ctx, cx, cy, rad, rnd, rad * 0.006);
    ctx.lineWidth = lw(0.6);
    alpha(ctx, 0.24 * t);
    strokeCircle(ctx, cx, cy, rad * 0.84, rnd, rad * 0.006);
    if (text)
        circularText(ctx, cx, cy, rad * 0.92, text, rnd, { color: o.color, alpha: 0.40, size: o.size || 9, t: t });
    if (mark) {
        ctx.fillStyle = o.color || C.cobalt;
        alpha(ctx, 0.5 * t);
        ctx.font = "600 " + Math.round(rad * 0.42) + "px Georgia, serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(mark, cx, cy + rad * 0.02);
    }
    ctx.restore();
}

// 细分隔线 + 菱形节点（铭文之间的呼吸）
function serifRule(ctx, x, y, w, rnd, opt) {
    var o = opt || {};
    var t = o.t === undefined ? 1 : clamp(o.t, 0, 1);
    ctx.save();
    ctx.strokeStyle = o.color || C.silver;
    ctx.lineWidth = lw(0.6);
    alpha(ctx, (o.alpha === undefined ? 0.34 : o.alpha) * t);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + w * t, y);
    ctx.stroke();
    var mx = x + w * t;
    ctx.beginPath();
    ctx.moveTo(mx - 4, y);
    ctx.lineTo(mx, y - 3.4);
    ctx.lineTo(mx + 4, y);
    ctx.lineTo(mx, y + 3.4);
    ctx.closePath();
    alpha(ctx, 0.40 * t);
    ctx.stroke();
    ctx.restore();
}

// 乐谱式细线记号：五线 + 少量音符/小节线（只在需要"仪式感"的角落用）
function staffNotation(ctx, x, y, w, rnd, opt) {
    var o = opt || {};
    var t = o.t === undefined ? 1 : clamp(o.t, 0, 1);
    ctx.save();
    ctx.strokeStyle = o.color || C.silver;
    ctx.lineWidth = lw(0.5);
    alpha(ctx, 0.20 * t);
    for (var i = 0; i < 5; i++) {
        ctx.beginPath();
        ctx.moveTo(x, y + i * 3.4);
        ctx.lineTo(x + w, y + i * 3.4);
        ctx.stroke();
    }
    var r2 = rng(o.seed || 11);
    ctx.lineWidth = lw(0.7);
    alpha(ctx, 0.42 * t);
    var n = Math.max(1, Math.round((o.notes || 5) * t));
    for (var k = 0; k < n; k++) {
        var nx = x + (k + 0.5) * (w / n);
        var ny = y + (Math.floor(r2() * 5)) * 3.4;
        ctx.beginPath();
        ctx.ellipse(nx, ny, 2.6, 1.9, -0.35, 0, TAU);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(nx + 2.5, ny);
        ctx.lineTo(nx + 2.5, ny - 8);
        ctx.stroke();
    }
    ctx.restore();
}

// 小标题：字距放开的等宽大写（真实文本，不造假字）
function label(ctx, x, y, text, rnd, opt) {
    var o = opt || {};
    var t = o.t === undefined ? 1 : clamp(o.t, 0, 1);
    ctx.save();
    ctx.fillStyle = o.color || C.cobalt;
    alpha(ctx, (o.alpha === undefined ? 0.5 : o.alpha) * t);
    ctx.font = (o.size || 10) + "px Consolas, monospace";
    ctx.textAlign = o.align || "left";
    ctx.textBaseline = "middle";
    var spaced = text.split("").join("\u2009");
    ctx.fillText(t >= 1 ? spaced : spaced.slice(0, Math.ceil(spaced.length * t)), x, y);
    ctx.restore();
}

// ══ 组合模板 A-D ══════════════════════════════════════════════════════
//
// 每个模板只让一个主纹样系统主导，辅助纹样一律更淡；中心轴与流线写死在模板里，
// 页面只负责给尺寸和种子。opts.t 驱动"逐步显现"。

// A：鸟群 + 圣徽 + 留白（主视觉 / 重要标题）
function templateA(ctx, w, h, opt) {
    var o = opt || {};
    var r = rng(o.seed || 21);
    var t = o.t === undefined ? 1 : clamp(o.t, 0, 1);
    // cxRatio/cyRatio 让页面把主纹样挪开文字区（左半留给标题时用 0.62-0.70）
    var cx = w * (o.cxRatio === undefined ? 0.62 : o.cxRatio);
    var cy = h * (o.cyRatio === undefined ? 0.44 : o.cyRatio);
    var rad = Math.min(w, h) * (o.radScale === undefined ? 0.27 : o.radScale);

    // 辅助：极淡的坐标网与一条黄金螺线（先画，永远在鸟下面）
    // 再铺参考图那层"雾里的光"：竖向柔光带 + 主体背后一团柔光，整个画面先亮起来
    backdrop(ctx, w, h, r, { t: t });
    lightShafts(ctx, w, h, r, { t: t * 0.9, count: 7, alpha: 0.34 });
    softGlow(ctx, cx, cy, Math.min(w, h) * 0.62, C.ivory, 0.40 * t);
    // 三团"空气"：一大两小、都压在画面的空白处。参考图的舒适感主要来自这些没有细节、
    // 没有硬边的大块柔光，它们不参与叙事，只负责把画面垫厚、把线条压软。
    softMass(ctx, w * 0.60, h * 0.34, Math.min(w, h) * 0.66, Math.min(w, h) * 0.54, r,
             { color: C.pearl, a: 0.55 * t, core: 0.20, grain: true, wisps: 3 });
    softMass(ctx, w * 0.96, h * 0.62, Math.min(w, h) * 0.34, Math.min(w, h) * 0.30, r,
             { color: C.ice, a: 0.30 * t, core: 0.14, wisps: 2 });
    softMass(ctx, w * 0.16, h * 0.20, Math.min(w, h) * 0.26, Math.min(w, h) * 0.22, r,
             { color: C.pearl, a: 0.26 * t, core: 0.12 });
    axisNet(ctx, w * 0.06, h * 0.10, w * 0.86, h * 0.80, r, { step: Math.max(44, w * 0.062), t: t * 0.55, line: C.silverSoft });
    goldenSpiral(ctx, w * 0.30, h * 0.86, Math.min(w, h) * 0.22, 1.6, r, { t: t * 0.5 });
    angleScale(ctx, cx, cy, rad * 1.34, 15, r, { t: t * 0.85, line: C.iceDeep, labels: false });
    dashArc(ctx, cx, cy, rad * 2.10, Math.PI * 0.18, Math.PI * 0.86, r, { t: t * 0.9, dash: 8, gap: 6 });

    // 主：圣徽（带刻度 + 径向标记的复合环；中心再收一层同心环，缩到很小也认得出中心）
    halo(ctx, cx, cy, rad, 3, r, { t: t, line: C.cobalt });
    halo(ctx, cx, cy, rad * 1.16, 4, r, { t: t * 0.9, line: C.iceDeep });
    halo(ctx, cx, cy, rad * 0.46, 1, r, { t: t * 0.95, line: C.cobalt });
    halo(ctx, cx, cy, rad * 0.98, 6, r, { t: t * 0.9, line: C.ivory });     // 环里那层放射光
    haloCore(ctx, cx, cy, rad, r, { t: t });

    // 主：两只"贴边的大鸟"——参考图里最抓眼的其实是这种被画面边裁掉一半的大剪影，
    // 它们负责撑住画面四角，尺寸远大于航线上的鸟，但因为是留白（挖空）所以不抢文字。
    bird(ctx, w * 1.02, h * 0.06, Math.min(w, h) * 0.62, "A", Math.PI * 0.86, r,
         { alpha: 0.30, lw: 0.8, flap: o.flap || 0, massAlpha: 0.42, bloomAlpha: 0.20, bloomW: 7 });
    bird(ctx, w * 0.04, h * 1.02, Math.min(w, h) * 0.52, "C", -Math.PI * 0.12, r,
         { alpha: 0.26, lw: 0.8, flap: (o.flap || 0) * 0.6, massAlpha: 0.36, bloomAlpha: 0.18, bloomW: 7 });

    // 主：浩浩荡荡的一潮鸟（用户口径："鸟多一点，繁杂一点，不要只有一列"）。
    //   ① 对角主线：三股并行，从画面左下穿到右上，外侧股更小更淡 → 读得出"往哪儿飞"又有厚度；
    //      鸟是主体，穿环时靠 destination-out 在环上留下干净的剪影；
    //   ② 贴着圣徽外环的两股：绕环飞行，起"环绕"作用；
    //   ③ 远景一片：极小、极淡、允许重叠（minGap 调小），当作鸟潮的"雾"，密度靠它撑起来。
    // 尺寸按"整只鸟的翼展"给：主角群 0.170×min(w,h)，环上 0.125，远景 0.072，靠 depth 再缩放。
    flock(ctx, { path: "line", w: w, h: h, x0: w * 0.28, y0: h * 0.99, x1: w * 1.08, y1: h * 0.02, bow: -h * 0.09,
                 streams: 3, count: 14, lateral: Math.min(w, h) * 0.30, depthFall: 0.46, wander: 10,
                 size: Math.min(w, h) * 0.170, sizeMin: 0.44, seed: (o.seed || 21) + 3,
                 alpha: 0.82, poses: ["A", "B", "C", "D", "E"], phase: o.phase || 0, flap: o.flap || 0 });
    flock(ctx, { path: "arc", w: w, h: h, cx: cx, cy: cy, rad: rad * 1.62, streams: 2, count: 9,
                 lateral: Math.min(w, h) * 0.16, depthFall: 0.38, wander: 7,
                 size: Math.min(w, h) * 0.125,
                 a0: Math.PI * 0.88, a1: Math.PI * 1.88, seed: (o.seed || 21) + 9, alpha: 0.68,
                 sizeMin: 0.48, poses: ["B", "D", "E"], phase: (o.phase || 0) + 0.3 });
    // 远景鸟潮：贴右上角那一片，密度上来了，但靠 alpha 与尺寸退到后面
    flock(ctx, { path: "line", w: w, h: h, x0: w * 0.48, y0: h * 0.38, x1: w * 1.04, y1: -h * 0.02, bow: h * 0.05,
                 streams: 3, count: 11, lateral: Math.min(w, h) * 0.13, depthFall: 0.34, wander: 5,
                 minGap: 0.22, size: Math.min(w, h) * 0.072, sizeMin: 0.58, seed: (o.seed || 21) + 17,
                 alpha: 0.46, poses: ["F", "F", "B"], farPose: true, phase: (o.phase || 0) + 0.6 });

    // 辅助：右下小圆徽（带分区标签）+ 左下一条细测量轴 + 一枚小印记与细规线
    medallion(ctx, w * 0.80, h * 0.74, Math.min(w, h) * 0.046, r,
              { t: t, label: "A1", glyph: o.mark || "S", color: C.navy });
    hairAxis(ctx, w * 0.06, h * 0.86, w * 0.36, h * 0.86, r, { t: t, label: "X", ticks: 4, color: C.silverSoft });
    hairAxis(ctx, w * 0.06, h * 0.86, w * 0.06, h * 0.60, r, { t: t, label: "Y", color: C.silverSoft });
    seal(ctx, w * 0.90, h * 0.86, Math.min(w, h) * 0.050, o.sealText || "STRONGHOLD LINK", o.mark || "S", r,
         { t: t, color: C.navy, size: 8 });
    serifRule(ctx, w * 0.06, h * 0.92, w * 0.30, r, { t: t });
}

// B：羽翼 + 圣堂拱框（角色 / 核心内容）
function templateB(ctx, w, h, opt) {
    var o = opt || {};
    var o = opt || {};
    var r = rng(o.seed || 33);
    var t = o.t === undefined ? 1 : clamp(o.t, 0, 1);
    var cx = w * (o.cxRatio === undefined ? 0.5 : o.cxRatio);
    var baseY = h * (o.cyRatio === undefined ? 0.90 : o.cyRatio);
    var aw = Math.min(w * 0.62, h * 0.72) * (o.archScale === undefined ? 1 : o.archScale);
    var ah = h * 0.80;

    backdrop(ctx, w, h, r, { t: t });
    lightShafts(ctx, w, h, r, { t: t * 0.85, count: 6, alpha: 0.30 });
    softGlow(ctx, cx, baseY - ah * 0.42, Math.min(w, h) * 0.56, C.ivory, 0.36 * t);
    // 拱门里那团"透进来的光"：拱洞内部一块柔光体（参考图里圣所那种从里往外亮的感觉）
    softMass(ctx, cx, baseY - ah * 0.46, aw * 0.52, ah * 0.40, r,
             { color: C.ivory, a: 0.62 * t, core: 0.24, grain: true, wisps: 2 });
    softMass(ctx, w * 0.14, h * 0.30, Math.min(w, h) * 0.30, Math.min(w, h) * 0.26, r,
             { color: C.pearl, a: 0.30 * t, core: 0.14 });
    axisNet(ctx, w * 0.08, h * 0.08, w * 0.84, h * 0.84, r, { step: Math.max(46, w * 0.070), t: t * 0.45, line: C.silverSoft });
    columns(ctx, w * 0.10, w * 0.90, h * 0.12, h * 0.94, 7, r, { t: t * 0.9 });

    // 主：多重嵌套尖拱
    arch(ctx, cx, baseY, aw, ah, r, { rings: 3, t: t, line: C.cobalt });
    arch(ctx, cx, baseY, aw * 0.66, ah * 0.72, r, { rings: 2, t: t * 0.95, line: C.iceDeep });

    // 主：玫瑰窗嵌在拱头里（分层显现：先外圈、再花瓣、最后窗格），拱=框、窗=心
    roseWindow(ctx, cx, baseY - ah * 0.60, aw * 0.17, 10, r,
               { t: t, stage: 3, line: C.navy, aux: C.iceDeep });

    // 主：双翼（对称）—— 分列拱框两侧、各自向外展开，羽片由内向外由短到长、彼此留空隙。
    // 摆在拱的肩线上（而不是压在拱心），两侧翼尖不越过画面中线，中间留给龛位与光环。
    var span = Math.min(w * 0.34, h * 0.44);
    var wingY = baseY - ah * 0.52;
    var wingX = cx + aw * 0.72;
    wing(ctx, cx - (wingX - cx), wingY, span, -1, r, { t: t, count: 16, a0: -0.46, a1: 0.54,
                                                       len0: 0.26, fillAlpha: 0.26, lineAlpha: 0.42 });
    wing(ctx, wingX, wingY, span, 1, r, { t: t, count: 16, a0: -0.54, a1: 0.46,
                                          len0: 0.26, fillAlpha: 0.26, lineAlpha: 0.42 });
    // 辅助：两股远景鸟从拱洞里穿过（"鸟群可以穿越拱形空间"），只留剪影，不抢双翼
    flock(ctx, { path: "line", w: w, h: h, x0: cx - aw * 0.40, y0: baseY - ah * 0.44, x1: cx + aw * 0.36, y1: baseY - ah * 0.76,
                 bow: -ah * 0.07, streams: 2, count: 14, lateral: Math.min(w, h) * 0.075, depthFall: 0.32,
                 wander: 5, minGap: 0.24, size: Math.min(w, h) * 0.068, sizeMin: 0.62,
                 seed: (o.seed || 33) + 21, alpha: 0.42, poses: ["B", "D", "F"], farPose: true });

    // 主：龛位（拱内的小框架）+ 中轴光带
    var nx = cx, ny = baseY - ah * 0.30, nw = aw * 0.22, nh = ah * 0.30;
    ctx.save();
    ctx.strokeStyle = C.cobalt;
    ctx.lineWidth = lw(0.9);
    alpha(ctx, 0.40 * t);
    ctx.beginPath();
    ctx.rect(nx - nw / 2, ny - nh, nw, nh);
    ctx.stroke();
    ctx.restore();
    halo(ctx, nx, ny - nh - nw * 0.42, nw * 0.42, 1, r, { t: t, line: C.cobalt });

    // 辅助：底部层台 + 少量羽片带
    ctx.save();
    ctx.strokeStyle = C.iceDeep;
    alpha(ctx, 0.26 * t);
    ctx.lineWidth = lw(0.7);
    for (var s = 0; s < 3; s++) {
        var sw = aw * (0.78 + s * 0.14);
        ctx.beginPath();
        ctx.moveTo(cx - sw / 2, baseY + 6 + s * 7);
        ctx.lineTo(cx + sw / 2, baseY + 6 + s * 7);
        ctx.stroke();
    }
    ctx.restore();
    wingBand(ctx, w * 0.58, h * 0.12, w * 0.30, h * 0.055, r, { count: 8, t: t, fillAlpha: 0.22, lineAlpha: 0.34 });
    label(ctx, w * 0.12, h * 0.94, o.label || "SANCTUM", r, { t: t, size: 10, alpha: 0.46 });
}

// C：鸟群 + 坐标轴 + 几何轨迹（科技展示 / 动态转场）
function templateC(ctx, w, h, opt) {
    var o = opt || {};
    var r = rng(o.seed || 47);
    var t = o.t === undefined ? 1 : clamp(o.t, 0, 1);

    backdrop(ctx, w, h, r, { t: t, haze: C.hazeDeep });
    axisNet(ctx, w * 0.05, h * 0.12, w * 0.90, h * 0.76, r, { step: Math.max(40, w * 0.058), t: t * 0.5, line: C.silverSoft });
    var gx = w * (o.cxRatio === undefined ? 0.30 : o.cxRatio);
    var gy = h * (o.cyRatio === undefined ? 0.62 : o.cyRatio);
    polygonNest(ctx, gx, gy, Math.min(w, h) * 0.20, 6, 3, r, { t: t * 0.9 });
    angleScale(ctx, gx, gy, Math.min(w, h) * 0.26, 30, r, { t: t * 0.9, labels: true });
    zones(ctx, w * 0.58, h * 0.16, w * 0.36, h * 0.30, 3, 2, r, { t: t * 0.8 });

    // 主：一条几何轨迹（抛物线/弧），鸟沿它飞行
    var x0 = w * 0.06, x1 = w * 0.96, yTop = h * 0.30, yBot = h * 0.78;
    ctx.save();
    ctx.strokeStyle = C.iceDeep;
    ctx.lineWidth = lw(0.7);
    alpha(ctx, 0.30 * t);
    ctx.beginPath();
    for (var i = 0; i <= 40; i++) {
        var k = (i / 40) * t;
        var px = lerp(x0, x1, k);
        var py = lerp(yBot, yTop, k) - Math.sin(k * Math.PI) * h * 0.16;
        if (i === 0)
            ctx.moveTo(px, py);
        else
            ctx.lineTo(px, py);
    }
    ctx.stroke();
    ctx.restore();
    // 三股并行沿轨迹飞行（同一口径：多股 + 外侧更小更淡 + 股内上下浮动），
    // 后面再压一层远景小鸟潮把密度撑起来
    flock(ctx, { path: "line", w: w, h: h, x0: x0, y0: yBot, x1: x1, y1: yTop, bow: -h * 0.16,
                 streams: 3, count: 15, lateral: Math.min(w, h) * 0.17, depthFall: 0.42, wander: 8,
                 size: Math.min(w, h) * 0.115, sizeMin: 0.46, seed: (o.seed || 47) + 5, alpha: 0.70,
                 poses: ["A", "C", "D", "E"], phase: o.phase || 0, flap: o.flap || 0 });
    flock(ctx, { path: "line", w: w, h: h, x0: x0 + w * 0.08, y0: yBot - h * 0.10, x1: x1, y1: yTop + h * 0.06,
                 bow: -h * 0.20, streams: 2, count: 16, lateral: Math.min(w, h) * 0.10, depthFall: 0.30,
                 wander: 4, minGap: 0.22, size: Math.min(w, h) * 0.062, sizeMin: 0.56,
                 seed: (o.seed || 47) + 23, alpha: 0.42, poses: ["F", "F", "B"], farPose: true,
                 phase: (o.phase || 0) + 0.5 });
    halo(ctx, gx, gy, Math.min(w, h) * 0.20, 6, r, { t: t, line: C.cobalt });
    goldenSpiral(ctx, w * 0.76, h * 0.80, Math.min(w, h) * 0.18, 1.4, r, { t: t * 0.7 });
    staffNotation(ctx, w * 0.60, h * 0.90, w * 0.30, r, { t: t * 0.8 });
    label(ctx, w * 0.06, h * 0.90, o.label || "TRAJECTORY", r, { t: t, size: 10 });
}

// D：玫瑰窗 + 放射几何 + 少量铭文（沉浸背景 / 仪式画面）
function templateD(ctx, w, h, opt) {
    var o = opt || {};
    var r = rng(o.seed || 59);
    var t = o.t === undefined ? 1 : clamp(o.t, 0, 1);
    var cx = w * (o.cxRatio === undefined ? 0.5 : o.cxRatio);
    var cy = h * (o.cyRatio === undefined ? 0.48 : o.cyRatio);
    var rad = Math.min(w, h) * (o.radScale === undefined ? 0.30 : o.radScale);

    backdrop(ctx, w, h, r, { t: t, haze: C.hazeDeep });
    radialFeathers(ctx, cx, cy, rad * 1.15, rad * 2.30, 48, r, { t: t * 0.9 });
    polygonNest(ctx, cx, cy, rad * 1.42, 8, 2, r, { t: t * 0.8 });
    angleScale(ctx, cx, cy, rad * 1.30, 45, r, { t: t * 0.85, labels: false });

    // 主：玫瑰窗（分层显现：轮 → 花瓣 → 外圈窗格）
    var stage = t < 0.34 ? 1 : (t < 0.72 ? 2 : 3);
    roseWindow(ctx, cx, cy, rad, 12, r, { t: t, stage: stage, line: C.cobalt, aux: C.iceDeep });

    // 辅助：两侧的半圆弧羽带（wingArc 的拆解形态——只有"羽片由短到长沿弧展开"这一条规律，
    // 所以能直接当装饰线用，不依赖鸟的身体）
    wingArc(ctx, cx, cy, rad * 1.72, Math.PI * 1.10, Math.PI * 1.44, r,
            { t: t * 0.9, count: 11, len0: 0.10, len1: 0.30, wid: 0.030, line: C.iceDeep, tick: true });
    wingArc(ctx, cx, cy, rad * 1.72, Math.PI * 0.10, Math.PI * 0.44, r,
            { t: t * 0.9, count: 11, len0: 0.30, len1: 0.10, wid: 0.030, line: C.iceDeep, tick: true, mirror: true });

    // 主：圣徽压在玫瑰窗中心（保持一个明确中心）
    halo(ctx, cx, cy, rad * 0.34, 1, r, { t: t, line: C.navy });
    haloCore(ctx, cx, cy, rad * 0.34, r, { t: t, line: C.navy });

    // 辅助：铭文与印记（少量、真实文本）
    if (t > 0.6) {
        circularText(ctx, cx, cy, rad * 1.06, o.ring || "ORDO \u00B7 LUX \u00B7 VERITAS \u00B7 ", r,
                     { t: (t - 0.6) / 0.4, color: C.navy, alpha: 0.34, size: 9 });
        label(ctx, cx - rad * 0.9, cy + rad * 1.32, o.label || "ROSE WINDOW", r, { t: (t - 0.6) / 0.4, size: 10, alpha: 0.4 });
        serifRule(ctx, cx - rad * 0.9, cy + rad * 1.44, rad * 1.8, r, { t: (t - 0.6) / 0.4 });
    }
}

// 模板入口：页面只认这四个名字
// opt.scale = 版面画布在屏幕上的实际缩放比（MotifPlate 传进来），用来做屏幕补偿
function template(ctx, name, w, h, opt) {
    var o = opt || {};
    BIRDLESS = !!o.birdless;
    PX = clamp(1 / (o.scale > 0 ? o.scale : 1), 1, 2.4);
    if (name === "A")
        templateA(ctx, w, h, opt);
    else if (name === "B")
        templateB(ctx, w, h, opt);
    else if (name === "C")
        templateC(ctx, w, h, opt);
    else if (name === "D")
        templateD(ctx, w, h, opt);
    else if (name === "E")
        templateE(ctx, w, h, opt);
}

// 参考图画笔数据：由 tools/trace-lines.py 从用户给的那张截图直接矢量化（72 个多边形 / 2516 点），
// 坐标是相对整幅画面（1024x442 归一化后）的 0..1。画法见 tracedArt()。
// 参考图画笔数据：由 tools/trace-lines.py 从用户给的那张截图直接矢量化，rebuilt with eps=1.8 / minArea=70。
// 点数是**成本**：这条 path 的段数直接决定 Qt 侧的光栅缓存（量化到 54 个多边形 / 1271 个点）。
var E_ART = [  [0.0,0.0,0.999,0.0,0.4893,0.0023,0.5049,0.0362,0.5107,0.0611,0.5156,0.1086,0.5156,0.1765,0.5,0.3213,0.4893,0.3846,0.4746,0.448,0.4854,0.3959,0.4766,0.3869,0.4619,0.3869,0.4492,0.4005,0.4502,0.3869,0.459,0.3914,0.4609,0.3846,0.4795,0.3891,0.4883,0.3846,0.5039,0.2919,0.5146,0.1923,0.5156,0.1176,0.5098,0.0588,0.5049,0.0385,0.4873,0.0045,0.4385,0.0023,0.4268,0.0113,0.3887,0.0543,0.335,0.1493,0.3242,0.276,0.3125,0.3552,0.3281,0.3937,0.3447,0.4072,0.373,0.2308,0.3457,0.405,0.3584,0.4186,0.3545,0.414,0.3525,0.4186,0.3574,0.4367,0.334,0.3959,0.3262,0.405,0.3252,0.4186,0.3281,0.3937,0.3145,0.3597,0.3047,0.3484,0.3125,0.3462,0.3232,0.2783,0.3311,0.2014,0.3311,0.1584,0.3115,0.2014,0.3125,0.2104,0.3086,0.2081,0.291,0.2511,0.2939,0.2534,0.293,0.2738,0.2822,0.3348,0.2861,0.3552,0.2803,0.3733,0.2803,0.3846,0.2764,0.3869,0.2852,0.3507,0.2793,0.3462,0.2842,0.3303,0.2881,0.3032,0.2861,0.2964,0.293,0.2692,0.291,0.267,0.292,0.2557,0.2852,0.2557,0.2725,0.2873,0.2588,0.3303,0.2559,0.3552,0.249,0.3756,0.2588,0.3281,0.2764,0.276,0.2773,0.2557,0.2744,0.233,0.2793,0.233,0.2773,0.2421,0.2773,0.267,0.2793,0.2692,0.333,0.1516,0.3281,0.0656,0.3184,0.0294,0.3047,0.0045,0.2559,0.0023,0.2178,0.0385,0.1924,0.0769,0.2188,0.0362,0.251,0.0068,0.251,0.0023,0.124,0.0023,0.1357,0.0271,0.1445,0.0588,0.1494,0.095,0.1514,0.1493,0.1904,0.0792,0.1504,0.1538,0.1455,0.224,0.1455,0.233,0.1504,0.2353,0.1494,0.2534,0.1455,0.2783,0.1455,0.3009,0.1396,0.3258,0.1445,0.3032,0.1455,0.2828,0.1436,0.2783,0.1484,0.2557,0.1484,0.2376,0.1377,0.2421,0.1211,0.2919,0.1143,0.3258,0.1289,0.2647,0.1396,0.2353,0.1445,0.233,0.1494,0.1787,0.1484,0.1606,0.126,0.2059,0.0957,0.2851,0.0996,0.3213,0.1045,0.3394,0.1045,0.3552,0.1074,0.3575,0.1045,0.3665,0.1045,0.3416,0.0957,0.3077,0.0967,0.2964,0.084,0.2692,0.0947,0.2851,0.1221,0.2104,0.1484,0.1561,0.1484,0.0905,0.1387,0.0385,0.1309,0.0181,0.1182,0.0023,0.001,0.0],
  [0.8916,0.0792,0.8906,0.3462,0.9111,0.3688,0.8896,0.3462,0.8857,0.3484,0.8779,0.3665,0.876,0.3959,0.8447,0.3507,0.8418,0.3597,0.8301,0.3688,0.834,0.3575,0.8252,0.2647,0.7998,0.2308,0.7686,0.2149,0.7402,0.2172,0.709,0.2421,0.6875,0.2738,0.667,0.3213,0.6592,0.3484,0.667,0.319,0.6875,0.2715,0.7061,0.2443,0.7295,0.2217,0.7588,0.2127,0.7744,0.2149,0.8018,0.2308,0.8223,0.2557,0.8232,0.2421,0.8174,0.1833,0.8252,0.2602,0.8477,0.3077,0.8438,0.2104,0.8496,0.3122,0.8633,0.3575,0.8672,0.3824,0.875,0.3937,0.8789,0.3575,0.8857,0.3462,0.8857,0.2036,0.8857,0.3371,0.8887,0.3462,0.8906,0.3281,0.8916,0.0814],
  [0.9316,0.1063,0.917,0.3597,0.917,0.3733,0.9248,0.3824,0.9141,0.371,0.9189,0.3416,0.9316,0.1086],
  [0.3906,0.1176,0.3916,0.1765,0.3896,0.1335,0.3828,0.1652,0.3906,0.1199],
  [0.9766,0.1357,0.9541,0.3326,0.9688,0.3846,0.9775,0.4005,0.9766,0.4095,0.9834,0.4457,0.9863,0.4502,0.9941,0.4434,0.999,0.4253,0.9971,0.4367,0.999,0.4412,0.9629,0.4638,0.9404,0.4344,0.9355,0.4344,0.9414,0.4299,0.9424,0.414,0.9316,0.4005,0.9346,0.4005,0.9346,0.3937,0.9443,0.414,0.9453,0.4095,0.9482,0.4412,0.9639,0.4638,0.9834,0.4502,0.9785,0.4163,0.9756,0.414,0.9766,0.4005,0.9668,0.3824,0.957,0.3439,0.9541,0.3371,0.9434,0.3348,0.9453,0.362,0.9424,0.3416,0.9424,0.3326,0.9521,0.3326,0.9541,0.3258,0.9766,0.138],
  [0.3994,0.1855,0.4102,0.224,0.4238,0.2466,0.4277,0.2692,0.4238,0.2624,0.4238,0.2489,0.4102,0.2262,0.3984,0.1878],
  [0.4658,0.1878,0.4766,0.1878,0.4766,0.2036,0.4727,0.2262,0.4727,0.2511,0.4668,0.2783,0.4697,0.2941,0.4648,0.3235,0.4688,0.2873,0.4639,0.2851,0.4717,0.2534,0.4707,0.2308,0.4756,0.2081,0.4746,0.19,0.4678,0.1946,0.4658,0.19,0.4521,0.2353,0.4463,0.2443,0.4355,0.3145,0.4277,0.2783,0.4307,0.2828,0.4336,0.3077,0.4365,0.3054,0.4453,0.2466,0.4648,0.19],
  [0.2021,0.2421,0.2158,0.2466,0.2266,0.2896,0.2373,0.3077,0.2441,0.3597,0.249,0.362,0.2432,0.3665,0.2383,0.3258,0.2354,0.3235,0.2363,0.31,0.2256,0.2896,0.2168,0.2534,0.21,0.2443,0.2021,0.2466,0.207,0.2851,0.2051,0.3032,0.208,0.3529,0.2061,0.3529,0.208,0.3507,0.2041,0.2986,0.2061,0.2783,0.2012,0.2443],
  [0.0674,0.2715,0.0791,0.2738,0.0693,0.3258,0.0723,0.3507,0.0684,0.3439,0.0645,0.3597,0.0615,0.3575,0.0684,0.3326,0.0693,0.31,0.0762,0.2896,0.0762,0.276,0.0693,0.2738,0.0508,0.3235,0.0664,0.2738],
  [0.1426,0.3394,0.1357,0.3756,0.1221,0.4072,0.1299,0.4072,0.1514,0.3891,0.1533,0.4005,0.1611,0.4072,0.1807,0.3756,0.1855,0.3484,0.1914,0.3484,0.1836,0.3552,0.1816,0.3688,0.1855,0.3756,0.1504,0.4163,0.1543,0.405,0.1455,0.405,0.1484,0.405,0.1514,0.3914,0.1279,0.4095,0.1152,0.4072,0.1328,0.3824,0.1426,0.3416],
  [0.46,0.3394,0.4502,0.3643,0.4512,0.3688,0.4814,0.3529,0.4814,0.362,0.4873,0.3733,0.4834,0.371,0.4785,0.3778,0.4844,0.3665,0.4775,0.3665,0.4814,0.3597,0.4805,0.3552,0.4668,0.3665,0.4434,0.3688,0.4492,0.3643,0.459,0.3416],
  [0.583,0.3733,0.6211,0.3824,0.6494,0.3778,0.6475,0.3891,0.6504,0.3891,0.6533,0.3778,0.6514,0.3869,0.6533,0.4027,0.6504,0.3891,0.6406,0.3891,0.6357,0.3824,0.584,0.3733],
  [0.2832,0.3891,0.2881,0.3982,0.2939,0.3982,0.2959,0.3891,0.2959,0.4027,0.2891,0.3982,0.2725,0.414,0.2568,0.414,0.2637,0.405,0.2637,0.414,0.2832,0.4072,0.2871,0.3982,0.2832,0.3914],
  [0.2168,0.3914,0.2188,0.4005,0.2119,0.4186,0.2148,0.4253,0.2109,0.4253,0.2109,0.4118,0.2061,0.4095,0.2012,0.4186,0.2021,0.4253,0.2168,0.4389,0.1895,0.414,0.1836,0.4186,0.1982,0.4412,0.209,0.4434,0.2129,0.4706,0.2168,0.4774,0.2588,0.4774,0.2598,0.5113,0.2568,0.5158,0.249,0.509,0.2402,0.5136,0.2334,0.4887,0.2314,0.5113,0.2109,0.5158,0.2129,0.5113,0.21,0.509,0.2002,0.5498,0.1748,0.5498,0.1982,0.5498,0.207,0.5204,0.2061,0.5113,0.1836,0.5136,0.1738,0.5,0.1777,0.4977,0.1738,0.4932,0.1777,0.4751,0.168,0.4706,0.1777,0.4706,0.1826,0.4525,0.1855,0.4548,0.1895,0.4434,0.1885,0.4299,0.1797,0.4208,0.1846,0.414,0.2002,0.4208,0.2041,0.4095,0.2119,0.4095,0.2178,0.3937],
  [0.916,0.3914,0.9287,0.3982,0.918,0.3937,0.915,0.4005,0.916,0.4163,0.9209,0.4208,0.9297,0.4163,0.9336,0.4299,0.9277,0.4186,0.9219,0.4299,0.8936,0.4231,0.9043,0.4027,0.915,0.3937],
  [0.8203,0.4005,0.8252,0.4118,0.8545,0.4005,0.8555,0.4095,0.8486,0.4186,0.8477,0.4299,0.8545,0.4344,0.8613,0.4593,0.8721,0.4729,0.8906,0.4706,0.8975,0.448,0.9053,0.4525,0.9102,0.4389,0.9219,0.4412,0.9297,0.4525,0.9346,0.4502,0.9141,0.4434,0.9316,0.4661,0.9316,0.4796,0.9375,0.4842,0.9473,0.5113,0.9551,0.5204,0.9609,0.5204,0.9746,0.4955,0.9688,0.491,0.9727,0.4683,0.9854,0.4706,0.999,0.4638,0.9971,0.4683,0.999,0.4729,0.9736,0.4683,0.9697,0.4864,0.9756,0.491,0.9756,0.4977,0.9658,0.5113,0.9482,0.5543,0.9414,0.5747,0.9424,0.5837,0.9258,0.629,0.9316,0.6312,0.9316,0.6403,0.9365,0.6357,0.9355,0.6471,0.9492,0.6335,0.9414,0.6584,0.9434,0.6629,0.9414,0.6719,0.9277,0.7172,0.9287,0.724,0.9326,0.7195,0.9326,0.7285,0.9375,0.724,0.9375,0.7353,0.9492,0.7217,0.958,0.7014,0.9717,0.6923,0.9766,0.6742,0.9824,0.6674,0.9824,0.6561,0.9873,0.6561,0.9932,0.6312,0.9883,0.6561,0.9717,0.6946,0.959,0.7036,0.9492,0.724,0.9375,0.7376,0.9268,0.7195,0.9453,0.6448,0.9346,0.6471,0.9287,0.6335,0.9189,0.6312,0.915,0.6448,0.916,0.6538,0.8916,0.8529,0.915,0.6516,0.9033,0.6516,0.8994,0.6584,0.8916,0.8054,0.8994,0.6584,0.8887,0.6538,0.9102,0.6538,0.918,0.629,0.9238,0.6335,0.9316,0.6109,0.8711,0.595,0.8682,0.6086,0.8721,0.6131,0.8672,0.6063,0.8613,0.6109,0.8408,0.5995,0.8066,0.595,0.8018,0.6267,0.7998,0.6742,0.7949,0.6584,0.7949,0.629,0.7959,0.6561,0.7988,0.6652,0.8008,0.6629,0.8057,0.5701,0.8096,0.5724,0.8047,0.5566,0.8057,0.5407,0.8184,0.5362,0.8057,0.5452,0.8047,0.5543,0.8096,0.5679,0.8066,0.5769,0.8076,0.5928,0.8564,0.6041,0.8535,0.5588,0.8574,0.6018,0.8613,0.6063,0.8662,0.5792,0.8643,0.5407,0.8672,0.5724,0.8711,0.5588,0.874,0.5249,0.875,0.4751,0.8604,0.4593,0.8633,0.5317,0.8584,0.457,0.8525,0.4344,0.8467,0.4321,0.8525,0.405,0.8398,0.4118,0.8486,0.509,0.8389,0.4118,0.8242,0.4118,0.8193,0.4027],
  [0.0664,0.405,0.0742,0.405,0.0781,0.414,0.082,0.4344,0.0801,0.448,0.084,0.4412,0.085,0.448,0.0879,0.4457,0.083,0.4525,0.085,0.457,0.0781,0.448,0.0791,0.4344,0.0762,0.4412,0.0664,0.4367,0.0518,0.4412,0.0654,0.4434,0.043,0.4434,0.04,0.4525,0.042,0.4593,0.0645,0.4593,0.0674,0.4525,0.0645,0.4593,0.0391,0.4615,0.043,0.4389,0.0713,0.4367,0.0742,0.4186,0.0684,0.4163,0.0742,0.4072,0.0674,0.4072],
  [0.4609,0.4208,0.4697,0.4208,0.4668,0.4299,0.4697,0.4367,0.4619,0.4457,0.459,0.4389,0.4385,0.4367,0.4492,0.4367,0.46,0.4231],
  [0.1338,0.4231,0.1221,0.4344,0.1172,0.4548,0.1084,0.457,0.1143,0.4661,0.1201,0.4638,0.1318,0.4412,0.1455,0.4321,0.1475,0.4276,0.1416,0.4231,0.1592,0.4299,0.1436,0.4321,0.1338,0.4412,0.1191,0.4683,0.1152,0.4683,0.1045,0.5,0.0928,0.4638,0.1045,0.491,0.1123,0.4683,0.1064,0.4615,0.0996,0.4683,0.1055,0.4593,0.0957,0.4548,0.1152,0.4548,0.1191,0.448,0.1211,0.4253,0.1328,0.4253],
  [0.3604,0.4231,0.3799,0.4502,0.3848,0.448,0.3877,0.4299,0.3848,0.4502,0.3721,0.4615,0.375,0.4683,0.3779,0.4638,0.3809,0.4774,0.3779,0.4683,0.3721,0.4706,0.3711,0.4774,0.3652,0.4638,0.3682,0.4661,0.3779,0.4502,0.3613,0.4253],
  [0.2988,0.4253,0.3057,0.4344,0.3076,0.4389,0.3057,0.4412,0.2871,0.4321,0.2715,0.4344,0.2822,0.4299,0.2998,0.4367,0.2979,0.4276],
  [0.3223,0.4276,0.3057,0.4819,0.2949,0.5475,0.292,0.5475,0.293,0.5339,0.29,0.5271,0.29,0.5181,0.293,0.5158,0.2871,0.5136,0.2861,0.5,0.292,0.5068,0.2959,0.5362,0.3066,0.4774,0.3018,0.4638,0.3086,0.4729,0.3164,0.4457,0.3154,0.4344,0.3213,0.4299],
  [0.8066,0.4321,0.8096,0.4321,0.8076,0.4457,0.8115,0.4412,0.8135,0.4548,0.8057,0.4615,0.7988,0.4502,0.8008,0.4412,0.8018,0.4502,0.8057,0.4344],
  [0.2949,0.4434,0.291,0.4502,0.2822,0.4502,0.2744,0.4683,0.2822,0.4774,0.29,0.4548,0.2998,0.4593,0.2891,0.457,0.2881,0.4706,0.2783,0.4796,0.2656,0.448,0.2725,0.4661,0.2803,0.448,0.2939,0.4457],
  [0.7041,0.4434,0.7061,0.457,0.7197,0.4887,0.7373,0.4706,0.7354,0.4796,0.7412,0.4955,0.7344,0.4774,0.7305,0.4842,0.7432,0.5068,0.748,0.5068,0.7559,0.4774,0.7578,0.4842,0.7646,0.4661,0.749,0.509,0.7363,0.509,0.7324,0.5158,0.7393,0.5452,0.7461,0.5249,0.7402,0.5498,0.7383,0.5543,0.7354,0.5317,0.7314,0.5249,0.7314,0.5136,0.7275,0.509,0.7275,0.4977,0.7168,0.4864,0.7031,0.4457],
  [0.4521,0.4525,0.4629,0.4548,0.4658,0.4638,0.458,0.4548,0.4561,0.4593,0.4658,0.4774,0.4697,0.4729,0.4678,0.4661,0.4736,0.4661,0.4688,0.4751,0.4707,0.4819,0.5205,0.4796,0.5283,0.4615,0.5361,0.4615,0.5361,0.4796,0.54,0.4751,0.542,0.4796,0.5508,0.4751,0.5518,0.4796,0.5869,0.4796,0.5879,0.4751,0.5898,0.4796,0.627,0.4796,0.6328,0.4638,0.6309,0.4751,0.6143,0.5023,0.6191,0.5068,0.6191,0.5136,0.623,0.5136,0.623,0.5204,0.6328,0.5181,0.6445,0.5045,0.6592,0.5068,0.6641,0.4887,0.6709,0.4819,0.6602,0.5068,0.6455,0.5113,0.6504,0.5724,0.665,0.6357,0.6836,0.6833,0.7012,0.7127,0.7256,0.7376,0.749,0.7489,0.7578,0.7466,0.7461,0.724,0.7432,0.7104,0.7451,0.6652,0.7275,0.6629,0.7041,0.6244,0.707,0.6018,0.7109,0.5995,0.7119,0.5905,0.7002,0.5158,0.6914,0.5045,0.6982,0.4977,0.6963,0.4864,0.6924,0.4977,0.6943,0.4842,0.6914,0.4819,0.6953,0.4796,0.6982,0.4819,0.7012,0.5249,0.7061,0.543,0.7129,0.5973,0.7061,0.6086,0.7051,0.6222,0.7119,0.6267,0.7168,0.6471,0.7275,0.6629,0.748,0.6629,0.7549,0.6403,0.7646,0.638,0.7656,0.6312,0.7666,0.6425,0.7744,0.6448,0.7793,0.6538,0.7871,0.6403,0.792,0.6403,0.7871,0.6403,0.7754,0.6719,0.7764,0.681,0.7666,0.7127,0.7686,0.7217,0.7559,0.776,0.7568,0.7828,0.7607,0.7805,0.7617,0.7896,0.7656,0.7828,0.7666,0.7941,0.7822,0.767,0.7852,0.7534,0.7881,0.7557,0.7979,0.7443,0.8037,0.7217,0.8096,0.7149,0.8086,0.7014,0.8135,0.7036,0.8154,0.69,0.8203,0.6833,0.8203,0.6674,0.8232,0.6606,0.8203,0.6538,0.8223,0.6516,0.8262,0.6719,0.8281,0.7353,0.8262,0.7081,0.8232,0.7059,0.8027,0.7308,0.7988,0.7443,0.7861,0.7557,0.7744,0.7851,0.7676,0.7941,0.7607,0.7896,0.7559,0.7828,0.7598,0.7511,0.7393,0.7466,0.7178,0.733,0.6826,0.6833,0.6582,0.6131,0.6484,0.5611,0.6445,0.5113,0.6221,0.5204,0.6143,0.5068,0.623,0.4864,0.6221,0.4819,0.5889,0.4819,0.5879,0.4864,0.5859,0.4819,0.5352,0.4819,0.5215,0.5452,0.5264,0.552,0.5254,0.5611,0.5127,0.5928,0.502,0.6063,0.5098,0.6086,0.5322,0.595,0.5381,0.6199,0.5352,0.6267,0.5381,0.6312,0.5332,0.6312,0.5352,0.6222,0.5293,0.6176,0.5322,0.6086,0.5273,0.6063,0.5312,0.595,0.5127,0.6086,0.4961,0.6063,0.5117,0.5928,0.5264,0.5566,0.5195,0.5475,0.5361,0.4661,0.5283,0.4638,0.5156,0.491,0.5068,0.5136,0.4961,0.5611,0.4844,0.586,0.4756,0.5317,0.4727,0.5271,0.4736,0.5204,0.4541,0.4932,0.4658,0.5068,0.4697,0.5045,0.4863,0.5294,0.4756,0.5204,0.4736,0.5249,0.4824,0.5769,0.4854,0.5814,0.4961,0.5588,0.5078,0.509,0.5186,0.4842,0.4688,0.4819,0.4658,0.4887,0.4668,0.5,0.459,0.4887,0.4658,0.4887,0.4668,0.4819,0.4512,0.4548],
  [0.7832,0.4638,0.7812,0.491,0.7852,0.5113,0.7793,0.5068,0.7764,0.5136,0.7822,0.4661],
  [0.4033,0.4796,0.4102,0.4864,0.4248,0.4842,0.4102,0.491,0.4023,0.5023,0.3955,0.4932,0.3857,0.509,0.3877,0.5,0.3936,0.4955,0.3936,0.4887,0.3965,0.491,0.4023,0.4819],
  [0.0752,0.4819,0.0742,0.491,0.0771,0.4955,0.0703,0.5045,0.0674,0.5023,0.0674,0.4887,0.0654,0.4955,0.0176,0.4955,0.0654,0.4955,0.0674,0.4887,0.0625,0.4842,0.0742,0.4842],
  [0.1406,0.4977,0.1367,0.5181,0.1465,0.5475,0.1562,0.543,0.1562,0.552,0.1611,0.5633,0.1592,0.5611,0.1553,0.5769,0.1592,0.5724,0.1641,0.5792,0.165,0.5995,0.1709,0.6244,0.1572,0.5814,0.1504,0.5747,0.1533,0.5769,0.1562,0.5679,0.1543,0.5611,0.1523,0.5701,0.1553,0.5566,0.1484,0.5566,0.1533,0.5543,0.1543,0.5452,0.1445,0.552,0.1465,0.5498,0.1445,0.5407,0.1348,0.5204,0.125,0.5498,0.1201,0.5498,0.126,0.5452,0.1396,0.5],
  [0.8105,0.5181,0.8271,0.5204,0.8291,0.5294,0.8252,0.5339,0.8291,0.5407,0.832,0.5317,0.833,0.543,0.8311,0.5385,0.8301,0.543,0.833,0.5498,0.8281,0.543,0.8232,0.5475,0.8262,0.5407,0.8232,0.5294,0.8115,0.5181],
  [0.2568,0.5226,0.2676,0.5882,0.2607,0.5498,0.2578,0.5588,0.2588,0.5679,0.249,0.6018,0.251,0.6041,0.249,0.6199,0.2471,0.6244,0.25,0.6131,0.248,0.6063,0.2441,0.6222,0.2451,0.6131,0.2422,0.6109,0.2471,0.6063,0.2529,0.5882,0.2539,0.5724,0.2588,0.5656,0.2578,0.5566,0.2607,0.5452,0.2588,0.5407,0.2549,0.5452,0.2568,0.5249],
  [0.082,0.5271,0.083,0.5407,0.0781,0.543,0.0752,0.5588,0.0879,0.5905,0.0781,0.5656,0.0723,0.5656,0.082,0.5294],
  [0.4102,0.5271,0.4238,0.5362,0.4219,0.5407,0.4258,0.5588,0.4316,0.5633,0.4268,0.5633,0.4229,0.5452,0.415,0.5294,0.4092,0.5294,0.4014,0.5543,0.3955,0.5566,0.3994,0.5566,0.4092,0.5294],
  [0.999,0.5271,0.999,0.5452,0.9707,0.5407,0.9668,0.5588,0.9727,0.5633,0.9736,0.5701,0.9521,0.6222,0.9609,0.5928,0.9727,0.5701,0.9717,0.5633,0.9658,0.5633,0.9688,0.543,0.9746,0.5362,0.9824,0.543,0.9961,0.543,0.998,0.5294],
  [0.0576,0.5339,0.0645,0.5339,0.0684,0.543,0.0742,0.5385,0.0635,0.5543,0.0684,0.5588,0.0635,0.5633,0.0596,0.5792,0.0547,0.5769,0.0566,0.5633,0.0527,0.5769,0.0469,0.5769,0.0488,0.5633,0.0449,0.5792,0.043,0.5769,0.0459,0.5656,0.043,0.5656,0.0508,0.5633,0.0508,0.5566,0.0527,0.5633,0.0547,0.5566,0.0566,0.5633,0.0586,0.5566,0.0615,0.5633,0.0645,0.5588,0.0615,0.552,0.0654,0.552,0.0674,0.5385,0.0566,0.5362],
  [0.3584,0.5385,0.375,0.5475,0.3604,0.5385,0.3496,0.5633,0.3457,0.552,0.3496,0.5475,0.3516,0.5498,0.3467,0.552,0.3516,0.5588,0.3574,0.5407],
  [0.1797,0.5543,0.207,0.5656,0.1963,0.5701,0.1875,0.6199,0.1865,0.6131,0.1963,0.5656,0.1807,0.5543],
  [0.79,0.5566,0.793,0.5588,0.7949,0.6244,0.792,0.6131,0.7939,0.5995,0.792,0.5973,0.7891,0.6109,0.793,0.5905,0.792,0.5611,0.7891,0.5588],
  [0.124,0.5747,0.1348,0.5769,0.126,0.5814,0.1191,0.6018,0.1006,0.6063,0.1201,0.5995,0.125,0.5769],
  [0.3164,0.5814,0.3184,0.5814,0.3164,0.586,0.3184,0.5995,0.335,0.5928,0.3154,0.6041,0.3164,0.5973,0.3115,0.595,0.3076,0.6041,0.3037,0.5995,0.3096,0.5973,0.3154,0.5837],
  [0.4326,0.5837,0.4346,0.586,0.4316,0.5905,0.4355,0.5995,0.4307,0.6131,0.4268,0.6833,0.4209,0.6629,0.4277,0.6742,0.4316,0.586],
  [0.417,0.6018,0.4209,0.6584,0.4199,0.6493,0.416,0.6584,0.3896,0.733,0.3906,0.8733,0.3994,0.8914,0.3965,0.9118,0.3857,0.9163,0.3809,0.9027,0.3828,0.8824,0.3896,0.8733,0.3887,0.7376,0.3584,0.81,0.3301,0.8665,0.3545,0.8167,0.3896,0.7285,0.3896,0.6086,0.4004,0.6109,0.416,0.6041],
  [0.3818,0.6063,0.3779,0.6244,0.3662,0.6357,0.3477,0.6674,0.334,0.6538,0.3408,0.6176,0.334,0.6493,0.3359,0.6538,0.3398,0.6493,0.3408,0.6606,0.3447,0.6538,0.3467,0.6674,0.3623,0.6448,0.3652,0.6312,0.3789,0.6222,0.3818,0.6086],
  [0.2578,0.6109,0.2646,0.6131,0.2725,0.638,0.2832,0.6516,0.3047,0.6516,0.3076,0.6335,0.3125,0.6244,0.3086,0.6357,0.3018,0.69,0.3037,0.7172,0.2988,0.7308,0.2998,0.8235,0.292,0.8122,0.2881,0.7851,0.2812,0.8145,0.2793,0.8462,0.2744,0.8484,0.2773,0.7896,0.2773,0.6946,0.2754,0.6878,0.2686,0.7217,0.252,0.7624,0.2393,0.7738,0.2285,0.8009,0.2197,0.81,0.209,0.7986,0.208,0.7919,0.2217,0.7398,0.2207,0.7285,0.2393,0.6584,0.2402,0.6652,0.2441,0.6606,0.2451,0.6697,0.25,0.6652,0.251,0.6765,0.2686,0.6471,0.2695,0.6312,0.2637,0.6131,0.2588,0.6131],
  [0.8574,0.6222,0.8604,0.6222,0.8643,0.6584,0.8604,0.6267,0.8574,0.6244,0.8447,0.6719,0.8467,0.6516,0.8447,0.6425,0.8506,0.638,0.8496,0.629,0.8525,0.6403,0.8574,0.6244],
  [0.5117,0.6244,0.5156,0.6244,0.5098,0.6312,0.502,0.6335,0.4951,0.6561,0.4824,0.6584,0.4746,0.6584,0.4648,0.6471,0.459,0.6312,0.4648,0.6471,0.4805,0.6584,0.4951,0.6561,0.501,0.629,0.5098,0.6312,0.5107,0.6267],
  [0.3301,0.6312,0.3252,0.7059,0.3232,0.7081,0.3193,0.6968,0.3193,0.6765,0.3203,0.6968,0.3252,0.6991,0.3262,0.6471,0.3291,0.6335],
  [0.1826,0.6403,0.167,0.7534,0.1816,0.6425],
  [0.8867,0.6652,0.8867,0.8258,0.8857,0.6833,0.8877,0.6765,0.8857,0.6674],
  [0.0449,0.6742,0.0371,0.6968,0.0381,0.7014,0.0967,0.7014,0.0986,0.7081,0.0918,0.7014,0.0342,0.7014,0.0439,0.6765],
  [0.8711,0.7353,0.8789,0.8145,0.8809,0.8145,0.8809,0.8009,0.8779,0.7511,0.8818,0.8507,0.8848,0.8756,0.8887,0.8756,0.8857,0.8914,0.877,0.7919,0.873,0.7851,0.875,0.7715,0.8711,0.7376],
  [0.1562,0.8484,0.1299,0.9005,0.1006,0.9434,0.1318,0.8959,0.1553,0.8507],
  [0.1611,0.8529,0.1631,0.905,0.1689,0.9434,0.1826,0.9796,0.1934,0.9932,0.2344,0.9932,0.2598,0.9729,0.29,0.9344,0.3281,0.8688,0.2939,0.9299,0.2402,0.9932,0.999,0.9932,0.999,0.9977,0.0,0.9977,0.0,0.9932,0.1895,0.9932,0.1729,0.9593,0.167,0.9367,0.1611,0.8869,0.1611,0.8552]
];

// 参考图笔画渲染：把 E_ART 里那些多边形拼成**一条** path、一次 fill。
// 单条 path + 单次 fill 是关键 —— 逐块 fill 在 QML Canvas 上会把一次重绘拖到十几毫秒。
function tracedArt(ctx, x, y, w, h, opt) {
    var o = opt || {};
    var t = o.t === undefined ? 1 : clamp(o.t, 0, 1);
    var color = o.color || "#eef1f2";
    var a = (o.alpha === undefined ? 0.9 : o.alpha) * t;
    ctx.save();
    ctx.fillStyle = color;
    alpha(ctx, a);
    ctx.beginPath();
    for (var p = 0; p < E_ART.length; p++) {
        var poly = E_ART[p];
        ctx.moveTo(x + poly[0] * w, y + poly[1] * h);
        for (var i = 2; i + 1 < poly.length; i += 2)
            ctx.lineTo(x + poly[i] * w, y + poly[i + 1] * h);
        ctx.closePath();
    }
    if (o.fill !== false)
        ctx.fill();
    // 缩小显示时笔画会被摊薄（1024 宽的笔画放到 700 宽只剩约 1.4px），
    // 所以同一条 path 再描一遍，用线宽把笔画补回来（lw() 里已经含屏幕补偿 PX）。
    // fill:false 时只描边 —— "把鸟的轮廓描清晰"就是靠这一路叠出来的。
    if (o.stroke !== false) {
        ctx.strokeStyle = color;
        ctx.lineWidth = lw(o.lineWidth === undefined ? 0.7 : o.lineWidth);
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        ctx.stroke();
    }
    ctx.restore();
}

// ══ 模板 E：深底「羽兽墙」（照用户给的参考图）══════════════════════════
//
// 参考图读数（用 PIL 量的，不是猜的）：2560×1106（2.31:1 宽幅）、背景是冷灰（亮度均值 158，
// 主色集中在 #a0a0a0 / #90a0a0），鸟是**浅色细线**（亮线均值 RGB 195,200,204 ≈ #c3c8cc），
// 左缘压着一块饱和深蓝 #1040a0（占画面 4.5%），背后有大圆弧、点阵与角落小字。
// 与 A–D 的"淡纸面"是两种明暗调，所以 E 自己铺底，不依赖外层纸色。
//
// 构图：三排大鸟（翼展 0.34–0.46×h，互相重叠成一片"墙"）从左下往右上压过去，
// 前排最亮最实，后排变小变淡；再压一层极淡的远景小鸟潮，把密度撑满整幅。
function templateE(ctx, w, h, opt) {
    var o = opt || {};
    var r = rng(o.seed || 71);
    var t = o.t === undefined ? 1 : clamp(o.t, 0, 1);
    var mn = Math.min(w, h);
    var r0 = w * 0.62;
    var STROKE = "#c9cfd1";
    var BODY = "#dde2e3";

    // ① 底：白（用户要求"底色改成白色"）—— 只在底部给一点点冷调，免得像复印纸
    ctx.save();
    var g = ctx.createLinearGradient(0, 0, w * 0.4, h);
    g.addColorStop(0, "#ffffff");
    g.addColorStop(0.62, "#fdfefe");
    g.addColorStop(1, "#f4f8f9");
    ctx.globalAlpha = 1;
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();

    // ② 背后的点阵（参考图里那层细点网格）—— 别按"每个像素级点都画一遍"来，
    //    1400 个 arc+fill 单这一项就能吃掉一次重绘的一半时间；按整幅宽给 24 列就够读了。
    ctx.save();
    ctx.fillStyle = "#a9b6bd";
    alpha(ctx, 0.42);
    var step = Math.max(20, w / 24);
    for (var gy = step * 0.5; gy < h; gy += step) {
        for (var gx = step * 0.5; gx < w; gx += step) {
            ctx.beginPath();
            ctx.arc(gx, gy, Math.max(0.7, mn * 0.0024), 0, TAU);
            ctx.fill();
        }
    }
    ctx.restore();

    // ③ 大圆弧 + 放射细线（构图骨架，压在鸟后面）
    ctx.save();
    ctx.strokeStyle = "#9fb0b9";
    ctx.lineWidth = lw(1.1);
    alpha(ctx, 0.42);
    strokeArc(ctx, w * 0.62, h * 0.52, r0, Math.PI * 0.86, Math.PI * 1.92, r, mn * 0.003);
    strokeArc(ctx, w * 0.62, h * 0.52, r0 * 0.72, Math.PI * 1.02, Math.PI * 1.94, r, mn * 0.003);
    alpha(ctx, 0.3);
    ctx.lineWidth = lw(0.8);
    for (var k = 0; k < 9; k++) {
        var a0 = -Math.PI * 0.44 + k * 0.10;
        var p0 = pol(w * 0.86, h * 0.30, mn * 0.10, a0);
        var p1 = pol(w * 0.86, h * 0.30, mn * 0.62, a0);
        ctx.beginPath();
        ctx.moveTo(p0.x, p0.y);
        ctx.lineTo(p1.x, p1.y);
        ctx.stroke();
    }
    ctx.restore();

    // ④ 左缘深蓝块：宽幅画面里它负责"压住左边"，让右半的鸟群有地方飞出去
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#1040a0";
    ctx.fillRect(0, 0, w * 0.085, h);
    ctx.fillStyle = "#0d3585";
    ctx.fillRect(0, h * 0.30, w * 0.085, h * 0.05);
    ctx.fillRect(0, h * 0.70, w * 0.085, h * 0.04);
    ctx.restore();

    // ④.5 环状花纹：沿用一开始那套圣徽环（多层同心 + 刻度 + 中心核），压在鸟下面只透出环线。
    //      参考图里鸟群背后正是一组大圆环，用户这次也要求"加上一开始的环状花纹"。
    var hcx = w * 0.56;
    var hcy = h * 0.46;
    var hrad = mn * 0.44;
    halo(ctx, hcx, hcy, hrad, 3, r, { t: t, line: C.cobalt });
    halo(ctx, hcx, hcy, hrad * 0.62, 1, r, { t: t, line: C.azure });
    haloCore(ctx, hcx, hcy, hrad * 0.18, r, { t: t, line: C.navy });
    dashArc(ctx, hcx, hcy, hrad * 1.10, Math.PI * 0.15, Math.PI * 0.62, r,
            { t: t, color: C.iceDeep, alpha: 0.5 });
    dashArc(ctx, hcx, hcy, hrad * 1.10, Math.PI * 1.10, Math.PI * 1.55, r,
            { t: t, color: C.iceDeep, alpha: 0.5 });

    // ⑤ 参考图笔画：直接铺那张图矢量化出来的鸟（72 个多边形，一次 fill）。
    //    参考图是 2.32:1 的横幅，这里按铺满宽度、纵向居中放，超出的部分由画布裁掉 ——
    //    形态与参考图逐笔画一致，不是重画的相似款。
    //
    //    用户先要求"把轮廓描清晰"，随后要求"轮廓弄细一点"，所以现在是细线三重叠加：
    //      ① 外扩软边（宽 1.8、α0.12）—— 只用来压住白底、免得太飘；
    //      ② 中调过渡（宽 1.0、α0.35）—— 抗锯齿过渡，别让细线起毛；
    //      ③ 清晰轮廓（宽 0.45、α0.92、#2b3c55）—— 真正画出来的那道线，比上一版细一半。
    //    笔画形状一点没动；E 是静态模板（hasMotion=false），这几道只在显现时付一次代价。
    var artH = w / 2.32;
    var artX = -w * 0.01;
    var artY = (h - artH) * 0.5;
    var artW = w * 1.02;
    var artHH = artH * 1.02;
    tracedArt(ctx, artX, artY, artW, artHH,
              { t: 1, color: "#7c8fa8", alpha: 0.12, lineWidth: 1.8, fill: false });
    tracedArt(ctx, artX, artY, artW, artHH,
              { t: 1, color: "#4a5f7d", alpha: 0.35, lineWidth: 1.0, fill: false });
    tracedArt(ctx, artX, artY, artW, artHH,
              { t: 1, color: "#2b3c55", alpha: 0.92, lineWidth: 0.45 });

    // ⑥ 角落小注（真实文字，不是乱码）：右下两行极小的等宽标注
    ctx.save();
    ctx.fillStyle = "#c2c9cb";
    ctx.font = "600 " + Math.max(7, Math.round(mn * 0.020)) + "px \"" + "Consolas" + "\", monospace";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.globalAlpha = 0.62 * t;
    ctx.fillText("AVIARY  /  FLIGHT VECTOR", w * 0.60, h * 0.80);
    ctx.fillText((o.label || "MIGRATION") + "  ·  " + (o.mark || "S"), w * 0.60, h * 0.80 + mn * 0.035);
    ctx.restore();
}
